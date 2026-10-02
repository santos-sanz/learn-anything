import { httpRouter } from "convex/server";

import { auth } from "./auth";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { requireUserId } from "./projects";
import { transcribeTurnRoute } from "./stt";

const http = httpRouter();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
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
    return new Response(blob, { status: 200, headers: { "content-type": file.contentType, "cache-control": "private, no-store" } });
  } catch {
    return jsonResponse({ code: "NOT_FOUND" }, 404);
  }
}) });

/** S15 speech-to-text: authenticated, project-scoped, request-scoped audio bytes. */
http.route({ path: "/stt/transcribe", method: "POST", handler: transcribeTurnRoute });

auth.addHttpRoutes(http);

export default http;
