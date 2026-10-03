import {
  MAX_TRANSLATION_SOURCE_CHARS,
  NanClient,
  TRANSLATION_LANGUAGES,
  isTranslationLanguage,
} from "../../worker/src/nan/index";
import { maxAudioDurationMs, maxAudioDurationSeconds, parseAudioDurationMs } from "./audioLimits";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { corsHeaders, readCorsAllowlist } from "./cors";
import { retryAfterHeader } from "./observability";
import { requireUserId } from "./projects";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  MAX_AUDIO_BYTES,
  MAX_TURN_ID_CHARS,
  SUPPORTED_AUDIO_TYPES,
  classifyAuthorizeFailure,
  fileExtensionFor,
  mapProviderFailure,
  type ProviderFailureScope,
} from "./stt";

/**
 * S18 explicit translation routes. Nothing here translates implicitly:
 *
 * - `POST /translation/audio` only ever targets English. Whisper's translation
 *   endpoint documents an English-only output, so any other requested target is
 *   rejected with `AUDIO_TRANSLATION_UNSUPPORTED` *before* any provider work —
 *   the caller is told to use the text route instead of receiving silent
 *   English.
 * - `POST /translation/text` takes an explicit `source`/`target` pair for the
 *   LLM task and rejects a pair outside the supported set with
 *   `UNSUPPORTED_LANGUAGE_PAIR`, again without contacting the provider.
 *
 * Both routes reuse the S15 authorization path: identity comes only from
 * `ctx.auth`, project ownership is re-checked internally, and audio bytes stay
 * request-scoped (never stored).
 */
const audioFailureScope: ProviderFailureScope = { prefix: "TRANSLATION", inputTooLargeCode: "AUDIO_TOO_LARGE" };
const textFailureScope: ProviderFailureScope = { prefix: "TRANSLATION", inputTooLargeCode: "TEXT_TOO_LARGE" };

/** Documented Whisper limit: audio translation outputs English only. */
export const AUDIO_TRANSLATION_TARGETS = ["en"] as const;

/** Optional per-route override; falls back to the S11 15 s default. */
function configuredTimeoutMs(envName: string): number {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROVIDER_TIMEOUT_MS;
}

function providerClient(ownerId: string, timeoutMs: number): NanClient | null {
  const apiKey = (process.env.NAN_API_KEY ?? "").trim();
  if (apiKey === "") return null;
  const deployerId = (process.env.NAN_DEPLOYER_ID ?? "").trim();
  return new NanClient({
    apiKey,
    deployment: { mode: "single-user-self-hosted", learnerId: ownerId, deployerId: deployerId === "" ? undefined : deployerId },
    quotaControls: { timeoutMs },
  });
}

function failureBody(failure: ReturnType<typeof mapProviderFailure>): Record<string, unknown> {
  const body: Record<string, unknown> = { code: failure.code };
  if (failure.retryAfterMs !== undefined) body.retryAfterMs = failure.retryAfterMs;
  if (failure.upstreamStatus !== undefined) body.upstreamStatus = failure.upstreamStatus;
  return body;
}

/**
 * POST /translation/audio?projectId=&turnId=&target=en with raw audio bytes.
 * The recorded audio is translated to English by Whisper's `/audio/translations`
 * endpoint; it is never stored and never sent anywhere else.
 */
export const translateAudioRoute = httpAction(async (ctx, request) => {
  const cors = corsHeaders(request.headers.get("Origin"), readCorsAllowlist());
  const json = (body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "content-type": "application/json", "cache-control": "private, no-store", ...extraHeaders },
    });

  let ownerId: string;
  try {
    ownerId = await requireUserId(ctx);
  } catch {
    return json({ code: "UNAUTHENTICATED" }, 401);
  }

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const turnId = url.searchParams.get("turnId") ?? "";
  const target = url.searchParams.get("target") ?? "";
  if (projectId === "" || turnId.length > MAX_TURN_ID_CHARS) return json({ code: "INVALID_ARGUMENT" }, 400);

  let authorized: boolean;
  try {
    authorized = await ctx.runQuery(internal.stt.authorizeSttProject, { ownerId, projectId: projectId as never });
  } catch (error) {
    const failure = classifyAuthorizeFailure(error);
    return json({ code: failure.code }, failure.status);
  }
  if (!authorized) return json({ code: "NOT_FOUND" }, 404);

  if (!(AUDIO_TRANSLATION_TARGETS as readonly string[]).includes(target)) {
    return json(
      {
        code: "AUDIO_TRANSLATION_UNSUPPORTED",
        supportedTargets: [...AUDIO_TRANSLATION_TARGETS],
        fallback: "text-translation",
        hint: "Whisper's audio translation only produces English. Translate the transcript instead.",
      },
      422,
    );
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!SUPPORTED_AUDIO_TYPES.has(contentType)) return json({ code: "UNSUPPORTED_CODEC" }, 415);

  const declaredLength = request.headers.get("content-length");
  const declaredBytes = declaredLength === null ? Number.NaN : Number(declaredLength);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_AUDIO_BYTES) return json({ code: "AUDIO_TOO_LARGE" }, 413);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return json({ code: "INVALID_ARGUMENT" }, 400);
  if (bytes.byteLength > MAX_AUDIO_BYTES) return json({ code: "AUDIO_TOO_LARGE" }, 413);

  // S24 duration cap: the container's own header is checked before any provider work.
  const declaredDurationMs = parseAudioDurationMs(bytes, contentType);
  if (declaredDurationMs !== null && declaredDurationMs > maxAudioDurationMs()) {
    return json({ code: "AUDIO_TOO_LONG", maxDurationSeconds: maxAudioDurationSeconds() }, 413);
  }

  const client = providerClient(ownerId, configuredTimeoutMs("TRANSLATION_TIMEOUT_MS"));
  if (client === null) return json({ code: "TRANSLATION_NOT_CONFIGURED" }, 503);

  try {
    const result = await client.translateAudioToEnglish(
      { bytes, filename: `turn.${fileExtensionFor(contentType)}`, mimeType: contentType },
      { signal: request.signal },
    );
    if (result.text.trim() === "") return json({ code: "SILENCE" }, 422);
    return json({ turnId, text: result.text, language: "en", target: "en" }, 200);
  } catch (error) {
    const failure = mapProviderFailure(error, audioFailureScope);
    const body = failureBody(failure);
    return json(body, failure.status, failure.status === 429 ? retryAfterHeader(body) : {});
  }
});

/**
 * POST /translation/text?projectId= with `{ text, source, target }`. The text
 * is data for the LLM task; `NanClient.translateText` builds the prompt so the
 * source can never reach the system instruction.
 */
export const translateTextRoute = httpAction(async (ctx, request) => {
  const cors = corsHeaders(request.headers.get("Origin"), readCorsAllowlist());
  const json = (body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "content-type": "application/json", "cache-control": "private, no-store", ...extraHeaders },
    });

  let ownerId: string;
  try {
    ownerId = await requireUserId(ctx);
  } catch {
    return json({ code: "UNAUTHENTICATED" }, 401);
  }

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  if (projectId === "") return json({ code: "INVALID_ARGUMENT" }, 400);

  let authorized: boolean;
  try {
    authorized = await ctx.runQuery(internal.stt.authorizeSttProject, { ownerId, projectId: projectId as never });
  } catch (error) {
    const failure = classifyAuthorizeFailure(error);
    return json({ code: failure.code }, failure.status);
  }
  if (!authorized) return json({ code: "NOT_FOUND" }, 404);

  let body: { text?: unknown; source?: unknown; target?: unknown };
  try {
    body = (await request.json()) as { text?: unknown; source?: unknown; target?: unknown };
  } catch {
    return json({ code: "INVALID_ARGUMENT" }, 400);
  }
  if (typeof body.text !== "string" || body.text.trim() === "") return json({ code: "INVALID_ARGUMENT" }, 400);
  if (typeof body.source !== "string" || typeof body.target !== "string") return json({ code: "INVALID_ARGUMENT" }, 400);
  if (body.text.length > MAX_TRANSLATION_SOURCE_CHARS) return json({ code: "TEXT_TOO_LARGE" }, 413);
  if (!isTranslationLanguage(body.source) || !isTranslationLanguage(body.target)) {
    return json({ code: "UNSUPPORTED_LANGUAGE_PAIR", supportedLanguages: [...TRANSLATION_LANGUAGES] }, 422);
  }

  const source = body.source;
  const target = body.target;
  // Translating a language into itself is an explicit no-op answer, never a
  // hidden provider call: the caller can see that nothing was translated.
  if (source === target) return json({ source, target, translation: body.text, unchanged: true }, 200);

  const client = providerClient(ownerId, configuredTimeoutMs("TRANSLATION_TIMEOUT_MS"));
  if (client === null) return json({ code: "TRANSLATION_NOT_CONFIGURED" }, 503);

  try {
    const translation = await client.translateText(body.text, source, target, { signal: request.signal });
    return json({ source, target, translation, unchanged: false }, 200);
  } catch (error) {
    const failure = mapProviderFailure(error, textFailureScope);
    const body = failureBody(failure);
    return json(body, failure.status, failure.status === 429 ? retryAfterHeader(body) : {});
  }
});
