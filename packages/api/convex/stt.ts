import { ConvexError, v } from "convex/values";

import { NanAdapterError, NanClient } from "../../worker/src/nan/index";
import { internal } from "./_generated/api";
import { httpAction, internalQuery } from "./_generated/server";
import { corsHeaders, readCorsAllowlist } from "./cors";
import { requireOwnedProject, requireUserId } from "./projects";

/**
 * S15 authenticated STT path. Audio bytes live only inside this request: they
 * are never written to Convex storage or any table, so raw microphone audio is
 * discarded by default the moment the transcription attempt finishes and an
 * aborted request leaves no stored bytes behind. Accepted input is a directly
 * supported compressed container; if a format ever needs conversion, that
 * transcoding belongs in this server runtime only — never in the browser and
 * never in CI.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // below Convex's 20 MiB HTTP-action ceiling and NaN's 25 MiB provider cap
export const SUPPORTED_AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4"]);
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000; // matches the S11 NaN quota default
export const MAX_TURN_ID_CHARS = 128;
type SpokenLanguage = "en" | "es"; // the S11 adapter's typed language set; S18 owns explicit translation

/**
 * Maps a failure of the ownership check to an honest status: identity and
 * authorization problems keep their `401`/`403`, a malformed id stays a `400`,
 * and anything else — a transient query failure — is a server fault reported
 * as `5xx` instead of being masked as a client error.
 */
export function classifyAuthorizeFailure(error: unknown): { status: number; code: string } {
  const code = typedErrorCode(error);
  if (code === "UNAUTHENTICATED" || code === "UNAUTHORIZED") return { status: 401, code: "UNAUTHENTICATED" };
  if (code === "FORBIDDEN" || code === "NOT_AUTHORIZED") return { status: 403, code: "FORBIDDEN" };
  if (code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (code === "INVALID_ARGUMENT" || isValidatorError(error)) return { status: 400, code: "INVALID_ARGUMENT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

/** Recovers a typed `{ code }` from an error raised by another Convex function. */
function typedErrorCode(error: unknown): string | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /"code"\s*:\s*"([A-Z_]+)"/.exec(message)?.[1] ?? null;
}

/** Argument validation failures are the caller's fault, so they stay `400`. */
function isValidatorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Validator error") || message.includes("Invalid Convex function arguments");
}

/**
 * HTTP actions call this after deriving identity from `ctx.auth`; it verifies
 * both ownerId and projectId and returns false instead of leaking whether a
 * foreign id exists.
 */
export const authorizeSttProject = internalQuery({
  args: { ownerId: v.string(), projectId: v.id("projects") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    try {
      await requireOwnedProject(ctx, args.ownerId, args.projectId);
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: unknown }).code === "NOT_FOUND") return false;
      throw error;
    }
    return true;
  },
});

type ProviderFailure = { status: number; code: string; retryAfterMs?: number; upstreamStatus?: number };

/**
 * Scopes the observable failure codes to the route that raised them, so an STT
 * failure and a translation failure never collapse into the same client code.
 * Identity, policy, cancellation and argument problems keep their shared names.
 */
export type ProviderFailureScope = {
  readonly prefix: "STT" | "TRANSLATION";
  readonly inputTooLargeCode: string;
};

export const sttFailureScope: ProviderFailureScope = { prefix: "STT", inputTooLargeCode: "AUDIO_TOO_LARGE" };

/** Maps the S11 adapter's typed errors to observable HTTP statuses; 524 stays visible as an upstream gateway failure. */
export function mapProviderFailure(error: unknown, scope: ProviderFailureScope = sttFailureScope): ProviderFailure {
  const { prefix } = scope;
  if (!(error instanceof NanAdapterError)) return { status: 502, code: `${prefix}_PROVIDER_ERROR` };
  switch (error.code) {
    case "NAN_TIMEOUT":
      return { status: 504, code: `${prefix}_TIMEOUT` };
    case "NAN_RATE_LIMITED":
      return { status: 429, code: `${prefix}_RATE_LIMITED`, retryAfterMs: error.retryAfterMs };
    case "NAN_CANCELLED":
      return { status: 499, code: "CANCELLED" };
    case "NAN_POLICY_BLOCKED":
      return { status: 403, code: "PROVIDER_POLICY_BLOCKED" };
    case "NAN_INPUT_TOO_LARGE":
      return { status: 413, code: scope.inputTooLargeCode };
    case "NAN_UNSUPPORTED_MODEL":
    case "NAN_UNSUPPORTED_CAPABILITY":
      return { status: 502, code: `${prefix}_PROVIDER_REJECTED` };
    case "NAN_MALFORMED_RESPONSE":
      return { status: 502, code: `${prefix}_BAD_PROVIDER_RESPONSE` };
    case "NAN_PROVIDER_ERROR": {
      const upstream = /HTTP (\d{3})/.exec(error.message)?.[1];
      if (upstream === "524") return { status: 502, code: `${prefix}_PROVIDER_UNAVAILABLE`, upstreamStatus: 524 };
      return upstream === undefined
        ? { status: 502, code: `${prefix}_PROVIDER_ERROR` }
        : { status: 502, code: `${prefix}_PROVIDER_ERROR`, upstreamStatus: Number(upstream) };
    }
    default:
      return { status: 502, code: `${prefix}_PROVIDER_ERROR` };
  }
}

function configuredProviderTimeoutMs(): number {
  const raw = Number(process.env.STT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROVIDER_TIMEOUT_MS;
}

export function fileExtensionFor(contentType: string): string {
  if (contentType === "audio/ogg") return "ogg";
  if (contentType === "audio/mp4") return "m4a";
  return "webm";
}

/**
 * POST /stt/transcribe?projectId=&language=&turnId= with raw audio bytes in the
 * body. The browser authenticates with its Convex Auth access token
 * (`Authorization: Bearer`); identity and project ownership are re-derived
 * server-side on every request. The page origin is cross-origin to
 * `.convex.site`, so every response — success, denial and failure alike —
 * carries the CORS headers from `cors.ts`.
 */
export const transcribeTurnRoute = httpAction(async (ctx, request) => {
  const cors = corsHeaders(request.headers.get("Origin"), readCorsAllowlist());
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json", "cache-control": "private, no-store" } });

  let ownerId: string;
  try {
    ownerId = await requireUserId(ctx);
  } catch {
    return json({ code: "UNAUTHENTICATED" }, 401);
  }

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const language = url.searchParams.get("language") ?? "";
  const turnId = url.searchParams.get("turnId") ?? "";
  if (projectId === "" || (language !== "en" && language !== "es") || turnId.length > MAX_TURN_ID_CHARS) {
    return json({ code: "INVALID_ARGUMENT" }, 400);
  }

  let authorized: boolean;
  try {
    authorized = await ctx.runQuery(internal.stt.authorizeSttProject, { ownerId, projectId: projectId as never });
  } catch (error) {
    const failure = classifyAuthorizeFailure(error);
    return json({ code: failure.code }, failure.status);
  }
  if (!authorized) return json({ code: "NOT_FOUND" }, 404);

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!SUPPORTED_AUDIO_TYPES.has(contentType)) return json({ code: "UNSUPPORTED_CODEC" }, 415);

  const declaredLength = request.headers.get("content-length");
  const declaredBytes = declaredLength === null ? Number.NaN : Number(declaredLength);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_AUDIO_BYTES) return json({ code: "AUDIO_TOO_LARGE" }, 413);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return json({ code: "INVALID_ARGUMENT" }, 400);
  if (bytes.byteLength > MAX_AUDIO_BYTES) return json({ code: "AUDIO_TOO_LARGE" }, 413);

  const apiKey = (process.env.NAN_API_KEY ?? "").trim();
  if (apiKey === "") return json({ code: "STT_NOT_CONFIGURED" }, 503);
  const deployerId = (process.env.NAN_DEPLOYER_ID ?? "").trim();

  const client = new NanClient({
    apiKey,
    deployment: { mode: "single-user-self-hosted", learnerId: ownerId, deployerId: deployerId === "" ? undefined : deployerId },
    quotaControls: { timeoutMs: configuredProviderTimeoutMs() },
  });

  try {
    const result = await client.transcribe(
      { bytes, filename: `turn.${fileExtensionFor(contentType)}`, mimeType: contentType },
      language as SpokenLanguage,
      { signal: request.signal },
    );
    if (result.text.trim() === "") return json({ code: "SILENCE" }, 422);
    return json({ turnId, text: result.text, language: result.language, duration: result.duration ?? null }, 200);
  } catch (error) {
    const failure = mapProviderFailure(error);
    const body: Record<string, unknown> = { code: failure.code };
    if (failure.retryAfterMs !== undefined) body.retryAfterMs = failure.retryAfterMs;
    if (failure.upstreamStatus !== undefined) body.upstreamStatus = failure.upstreamStatus;
    return json(body, failure.status);
  }
});
