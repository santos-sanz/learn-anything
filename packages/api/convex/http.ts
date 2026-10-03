import { httpRouter } from "convex/server";

import { auth } from "./auth";
import { corsPreflightRoute } from "./cors";
import {
  configuredUploadLimit,
  isIdempotencyKey,
  isProjectIdParam,
  storeWithRollback,
  validateUploadContent,
  validateUploadFilename,
  validateUploadMediaType,
} from "./documents";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { requireUserId } from "./projects";
import { transcribeTurnRoute } from "./stt";
import { translateAudioRoute, translateTextRoute } from "./translation";
import { synthesizeSpeechRoute } from "./tts";

const http = httpRouter();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

/** Recovers a typed `{ code }` from a rejected Convex function call. */
function rejectionCode(error: unknown): string | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const known = ["UNAUTHENTICATED", "NOT_FOUND", "QUOTA_EXCEEDED", "UPLOAD_FAILED", "INVALID_ARGUMENT"];
  for (const code of known) if (message.includes(code)) return code;
  return null;
}

/**
 * Maps a rejected connection token to its typed code. Nested Convex errors are
 * re-wrapped by the runtime, so the code is recovered from the error itself or
 * from its message.
 */
function connectionTokenErrorCode(error: unknown): string | null {
  const sources: string[] = [];
  const data = (error as { data?: unknown } | null)?.data;
  if (data !== undefined && data !== null) {
    try {
      sources.push(JSON.stringify(data));
    } catch {
      sources.push(String(data));
    }
  }
  sources.push(error instanceof Error ? error.message : String(error));
  for (const source of sources) {
    const match = /CONNECTION_TOKEN_[A-Z_]+/.exec(source);
    if (match !== null) return match[0];
  }
  return null;
}

/**
 * S07 agent handshake transport (hosting itself is S07): the caller presents a
 * scoped connection token, never a user id or an email address.
 * `reconnect` revalidates by rotating the token, so the presented one is
 * revoked and a replay of it is rejected afterwards.
 */
const agentConnectionTokenAction = (rotate: boolean) =>
  httpAction(async (ctx, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ code: "INVALID_BODY" }, 400);
    }
    const token = typeof body === "object" && body !== null ? (body as { token?: unknown }).token : undefined;
    if (typeof token !== "string" || token.length === 0) return jsonResponse({ code: "INVALID_BODY" }, 400);
    try {
      const result = await ctx.runMutation(internal.agentSessions.verifyConnectionToken, { token, rotate });
      return jsonResponse({ ok: true, ...result }, 200);
    } catch (error) {
      const code = connectionTokenErrorCode(error);
      if (code === null) return jsonResponse({ code: "INTERNAL_ERROR" }, 500);
      return jsonResponse({ code }, code === "CONNECTION_TOKEN_SCOPE" ? 403 : 401);
    }
  });

http.route({ path: "/agent/connection-tokens/verify", method: "POST", handler: agentConnectionTokenAction(false) });
http.route({ path: "/agent/connection-tokens/reconnect", method: "POST", handler: agentConnectionTokenAction(true) });

/**
 * S08 authenticated upload action. Identity, project ownership, filename,
 * size, media type and content are all validated before any byte is saved,
 * and `storeWithRollback` deletes the blob unless the transactional commit
 * keeps it. The response is status metadata only: never file bytes and never
 * a `storage.getUrl` bearer link.
 */
http.route({ path: "/private-uploads", method: "POST", handler: httpAction(async (ctx, request) => {
  let ownerId: string;
  try {
    ownerId = await requireUserId(ctx);
  } catch {
    return jsonResponse({ code: "UNAUTHENTICATED" }, 401);
  }

  const url = new URL(request.url);
  const projectIdParam = url.searchParams.get("projectId") ?? "";
  const filename = url.searchParams.get("filename") ?? "";
  const idempotencyKey = url.searchParams.get("idempotencyKey") ?? "";
  if (!isProjectIdParam(projectIdParam)) return jsonResponse({ code: "INVALID_ARGUMENT" }, 400);
  if (!isIdempotencyKey(idempotencyKey)) return jsonResponse({ code: "INVALID_ARGUMENT" }, 400);
  const filenameResult = validateUploadFilename(filename);
  if (!filenameResult.ok) return jsonResponse({ code: filenameResult.code }, filenameResult.code === "UNSUPPORTED_MEDIA_TYPE" ? 415 : 400);
  const projectId = projectIdParam as Id<"projects">;

  // Ownership is checked before the body is read, so a foreign project id can
  // never reveal validation detail about a file the caller may not upload.
  try {
    await ctx.runQuery(internal.documents.assertUploadTarget, { ownerId, projectId });
  } catch {
    return jsonResponse({ code: "NOT_FOUND" }, 404);
  }

  const limit = configuredUploadLimit();
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > limit) return jsonResponse({ code: "FILE_TOO_LARGE" }, 413);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return jsonResponse({ code: "INVALID_BODY" }, 400);
  }
  if (bytes.byteLength === 0) return jsonResponse({ code: "EMPTY_FILE" }, 400);
  if (bytes.byteLength > limit) return jsonResponse({ code: "FILE_TOO_LARGE" }, 413);

  const mediaType = validateUploadMediaType(filenameResult.extension, request.headers.get("content-type") ?? "");
  if (!mediaType.ok) return jsonResponse({ code: mediaType.code }, 415);
  const content = validateUploadContent(filenameResult.extension, bytes);
  if (!content.ok) return jsonResponse({ code: content.code }, 400);

  try {
    const committed = await storeWithRollback(
      ctx.storage,
      new Blob([bytes], { type: mediaType.contentType }),
      async (storageId) => {
        const result = await ctx.runMutation(internal.documents.commitDocumentUpload, {
          ownerId,
          projectId,
          filename,
          extension: filenameResult.extension,
          contentType: mediaType.contentType,
          sizeBytes: bytes.byteLength,
          idempotencyKey,
          storageId,
        });
        // A replay keeps the committed row; the blob stored for this retry is an orphan.
        return { keep: !result.duplicate, result };
      },
    );
    return jsonResponse(
      {
        documentId: committed.documentId,
        privateFileId: committed.privateFileId,
        jobId: committed.jobId,
        filename: committed.filename,
        contentType: committed.contentType,
        sizeBytes: committed.sizeBytes,
        status: committed.status,
        idempotent: committed.duplicate,
      },
      committed.duplicate ? 200 : 201,
    );
  } catch (error) {
    const code = rejectionCode(error);
    if (code === "NOT_FOUND") return jsonResponse({ code: "NOT_FOUND" }, 404);
    if (code === "QUOTA_EXCEEDED") return jsonResponse({ code: "QUOTA_EXCEEDED" }, 507);
    if (code === "UPLOAD_FAILED") return jsonResponse({ code: "UPLOAD_FAILED" }, 500);
    return jsonResponse({ code: "INTERNAL_ERROR" }, 500);
  }
}) });

/**
 * Private bytes, including S08 documents, are served only here: identity is
 * re-derived on every request, ownership and project are re-checked, and the
 * response is non-cacheable and not sniffable. `storage.getUrl` is never used
 * because that URL is bearer access.
 */
http.route({ pathPrefix: "/private-files/", method: "GET", handler: httpAction(async (ctx, request) => {
  let ownerId: string;
  try {
    ownerId = await requireUserId(ctx);
  } catch {
    return jsonResponse({ code: "UNAUTHENTICATED" }, 401);
  }
  const fileId = new URL(request.url).pathname.slice("/private-files/".length);
  if (fileId.length === 0) return jsonResponse({ code: "NOT_FOUND" }, 404);
  try {
    const file = await ctx.runQuery(internal.files.authorizePrivateFileDownload, { ownerId, fileId: fileId as never });
    const blob = await ctx.storage.get(file.storageId);
    if (blob === null) return jsonResponse({ code: "NOT_FOUND" }, 404);
    return new Response(blob, { status: 200, headers: { "content-type": file.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return jsonResponse({ code: "NOT_FOUND" }, 404);
  }
}) });

/**
 * S15 speech-to-text: authenticated, project-scoped, request-scoped audio bytes.
 * The page origin is cross-origin to `.convex.site`, so the browser preflights
 * every `Authorization` + `audio/webm` request first: the `OPTIONS` route
 * answers it without any authentication, and the `POST` route adds the
 * allow-origin header through `transcribeTurnRoute` (see `cors.ts`).
 */
http.route({ path: "/stt/transcribe", method: "OPTIONS", handler: corsPreflightRoute });
http.route({ path: "/stt/transcribe", method: "POST", handler: transcribeTurnRoute });

/**
 * S18 explicit translation. Audio translation is English-only by provider
 * design; text translation carries an explicit source/target pair. Both
 * preflight exactly like the S15 route because both send `Authorization`.
 */
http.route({ path: "/translation/audio", method: "OPTIONS", handler: corsPreflightRoute });
http.route({ path: "/translation/audio", method: "POST", handler: translateAudioRoute });
http.route({ path: "/translation/text", method: "OPTIONS", handler: corsPreflightRoute });
http.route({ path: "/translation/text", method: "POST", handler: translateTextRoute });

/**
 * S16 Kokoro speech synthesis. The browser authenticates with its Convex Auth
 * access token; identity and project/turn ownership are re-derived server-side
 * on every request and the synthesized bytes are streamed straight back —
 * never stored, never exposed as a `storage.getUrl` bearer link.
 */
http.route({ path: "/tts/synthesize", method: "OPTIONS", handler: corsPreflightRoute });
http.route({ path: "/tts/synthesize", method: "POST", handler: synthesizeSpeechRoute });

auth.addHttpRoutes(http);

export default http;
