import { MAX_AUDIO_BYTES, type TurnLanguage } from "./audioCapture.js";
import { nextRetryDecision, parseRetryAfterHeader, sleep } from "./retryPolicy.js";
import { failureMessage, type TurnFailureCode } from "./turnState.js";

export type TranscribeSuccess = {
  ok: true;
  text: string;
  detectedLanguage: TurnLanguage;
  durationMs: number | null;
  turnId: string;
};
export type TranscribeFailure = { ok: false; code: TurnFailureCode; message: string; retryAfterMs: number | null };
export type TranscribeResult = TranscribeSuccess | TranscribeFailure;

export type TranscribeRequest = {
  siteUrl: string;
  token: string | null;
  projectId: string;
  language: TurnLanguage;
  turnId: string;
  audio: Blob;
  signal?: AbortSignal;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** S24 bounded Retry-After retry; 1 disables the retry loop. */
  maxAttempts?: number;
  /** Injectable wait so tests can assert the next-attempt timing. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** Default attempts for a rate-limited transcription (one bounded retry). */
export const DEFAULT_TRANSCRIBE_MAX_ATTEMPTS = 2;

export function buildTranscribeUrl(siteUrl: string, params: { projectId: string; language: TurnLanguage; turnId: string }): string {
  const query = new URLSearchParams({ projectId: params.projectId, language: params.language, turnId: params.turnId });
  return `${siteUrl.replace(/\/+$/, "")}/stt/transcribe?${query.toString()}`;
}

function failure(code: TurnFailureCode, retryAfterMs: number | null = null): TranscribeFailure {
  return { ok: false, code, message: failureMessage(code, retryAfterMs), retryAfterMs };
}

/** Pure status/body mapping so every observable failure has fixed, actionable copy. */
export function mapTranscribeResponse(status: number, body: unknown): TranscribeResult {
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  const retryAfterMs =
    typeof body === "object" && body !== null && typeof (body as { retryAfterMs?: unknown }).retryAfterMs === "number"
      ? (body as { retryAfterMs: number }).retryAfterMs
      : null;
  switch (status) {
    case 200: {
      const payload = body as { text?: unknown; language?: unknown; duration?: unknown; turnId?: unknown };
      if (
        typeof payload.text !== "string" ||
        (payload.language !== "en" && payload.language !== "es") ||
        typeof payload.turnId !== "string"
      ) {
        return failure("unknown");
      }
      return {
        ok: true,
        text: payload.text,
        detectedLanguage: payload.language,
        durationMs: typeof payload.duration === "number" ? payload.duration : null,
        turnId: payload.turnId,
      };
    }
    case 400:
      return failure("invalid-request");
    case 401:
      return failure("unauthenticated");
    case 403:
      return failure("provider-policy");
    case 404:
      return failure("not-found");
    case 413:
      return failure("too-large");
    case 415:
      return failure("unsupported-codec");
    case 422:
      return code === "SILENCE" ? failure("silence") : failure("invalid-request");
    case 429:
      return failure("rate-limited", retryAfterMs);
    case 503:
      return failure("not-configured");
    case 504:
      return failure("timeout");
    case 502:
      return failure("provider-unavailable");
    default:
      return status >= 500 ? failure("unknown") : failure("invalid-request");
  }
}

/**
 * Sends the recorded turn to the authenticated Convex HTTP action. The audio
 * blob never leaves this request, and a missing token, an oversize file or a
 * dropped connection resolve to typed failures instead of thrown strings.
 *
 * S24: a `429` is retried at most `maxAttempts` times, and never before the
 * server's `Retry-After` (header seconds or `retryAfterMs` body, whichever is
 * larger). A declared wait beyond `MAX_AUTO_RETRY_MS` is never truncated —
 * the failure surfaces with the exact wait instead of retrying early.
 */
export async function requestTranscription(request: TranscribeRequest): Promise<TranscribeResult> {
  if (request.token === null || request.token === "") return failure("unauthenticated");
  if (request.audio.size > MAX_AUDIO_BYTES) return failure("too-large");
  const fetchImpl = request.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const sleepImpl = request.sleepImpl ?? ((ms: number, signal?: AbortSignal) => sleep(ms, signal));
  const maxAttempts = Math.min(Math.max(Math.trunc(request.maxAttempts ?? DEFAULT_TRANSCRIBE_MAX_ATTEMPTS), 1), 5);
  const url = buildTranscribeUrl(request.siteUrl, request);
  const init: RequestInit = {
    method: "POST",
    headers: { authorization: `Bearer ${request.token}`, "content-type": request.audio.type || "application/octet-stream" },
    body: request.audio,
    signal: request.signal,
  };

  let lastRateLimit: TranscribeFailure | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      return failure("network");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const mapped = mapTranscribeResponse(response.status, body);
    if (mapped.ok) return mapped;
    if (mapped.code !== "rate-limited") return mapped;

    const headerMs = parseRetryAfterHeader(response.headers.get("retry-after"));
    const declaredMs =
      headerMs === null
        ? mapped.retryAfterMs
        : mapped.retryAfterMs === null
          ? headerMs
          : Math.max(headerMs, mapped.retryAfterMs);
    const limited = failure("rate-limited", declaredMs);
    const decision = nextRetryDecision({ retryable: true, attempt, maxAttempts, retryAfterMs: declaredMs });
    if (!decision.retry) return limited;
    try {
      await sleepImpl(decision.delayMs, request.signal);
    } catch {
      return failure("network");
    }
    lastRateLimit = limited;
  }
  return lastRateLimit ?? failure("network");
}
