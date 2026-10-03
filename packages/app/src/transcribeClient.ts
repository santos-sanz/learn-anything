import { MAX_AUDIO_BYTES, type TurnLanguage } from "./audioCapture.js";
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
};

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
 */
export async function requestTranscription(request: TranscribeRequest): Promise<TranscribeResult> {
  if (request.token === null || request.token === "") return failure("unauthenticated");
  if (request.audio.size > MAX_AUDIO_BYTES) return failure("too-large");
  const fetchImpl = request.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(buildTranscribeUrl(request.siteUrl, request), {
      method: "POST",
      headers: { authorization: `Bearer ${request.token}`, "content-type": request.audio.type || "application/octet-stream" },
      body: request.audio,
      signal: request.signal,
    });
  } catch {
    return failure("network");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return mapTranscribeResponse(response.status, body);
}
