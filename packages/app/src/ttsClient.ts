/** Typed failures the player can show next to the still-visible transcript. */
export type TtsFailureCode =
  | "unsupported-voice"
  | "unsupported-language"
  | "not-configured"
  | "unauthenticated"
  | "not-found"
  | "provider-policy"
  | "invalid-request"
  | "too-large"
  | "rate-limited"
  | "timeout"
  | "provider-unavailable"
  | "network"
  | "unknown";

export type TtsSuccess = { ok: true; audio: Blob; contentType: string };
export type TtsFailure = {
  ok: false;
  code: TtsFailureCode;
  message: string;
  retryAfterMs: number | null;
  supportedVoices: string[] | null;
  supportedLanguages: string[] | null;
};
export type TtsResult = TtsSuccess | TtsFailure;

export type TtsRequest = {
  siteUrl: string;
  token: string | null;
  projectId: string;
  turnId: string;
  language: string;
  voice?: string | null;
  signal?: AbortSignal;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

export function buildTtsUrl(
  siteUrl: string,
  params: { projectId: string; turnId: string; language: string; voice?: string | null },
): string {
  const query = new URLSearchParams({ projectId: params.projectId, turnId: params.turnId, language: params.language });
  if (params.voice !== undefined && params.voice !== null && params.voice !== "") query.set("voice", params.voice);
  return `${siteUrl.replace(/\/+$/, "")}/tts/synthesize?${query.toString()}`;
}

/** Fixed, actionable copy per typed failure; the transcript stays visible beside it. */
export function ttsFailureMessage(code: TtsFailureCode, retryAfterMs: number | null = null): string {
  switch (code) {
    case "unsupported-voice":
      return "This voice is not configured on the server. Pick one of the available voices and try again.";
    case "unsupported-language":
      return "This language has no configured speech voice. Not every transcription language can be spoken — pick an available language and try again.";
    case "not-configured":
      return "Speech synthesis is not configured on this server. Set the server-side provider key, then retry.";
    case "unauthenticated":
      return "Your session has expired. Sign in again, then retry playback.";
    case "not-found":
      return "This response is no longer available for audio playback.";
    case "provider-policy":
      return "Speech synthesis is only enabled for the deployer in this self-hosted build.";
    case "invalid-request":
      return "The audio request was rejected. Retry playback.";
    case "too-large":
      return "This response is longer than the provider's speech limit, so it cannot be spoken in one request.";
    case "rate-limited": {
      const seconds = retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000);
      return seconds === null
        ? "Speech synthesis is rate limited. Wait a moment, then retry."
        : `Speech synthesis is rate limited. Retry in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
    }
    case "timeout":
      return "Speech synthesis timed out. Check your connection and retry.";
    case "provider-unavailable":
      return "The speech service did not respond in time. Retry shortly.";
    case "network":
      return "The audio could not be fetched. Check your connection and retry.";
    case "unknown":
      return "Audio playback failed. Retry.";
  }
}

function stringsFromBody(body: unknown, key: "supportedVoices" | "supportedLanguages"): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value;
}

function failure(code: TtsFailureCode, retryAfterMs: number | null = null, supported: { voices?: string[] | null; languages?: string[] | null } = {}): TtsFailure {
  return {
    ok: false,
    code,
    message: ttsFailureMessage(code, retryAfterMs),
    retryAfterMs,
    supportedVoices: supported.voices ?? null,
    supportedLanguages: supported.languages ?? null,
  };
}

/** Pure status/body mapping so every observable failure keeps fixed copy and the typed codes the route sends. */
export function mapTtsResponse(status: number, body: unknown): TtsResult {
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  const retryAfterMs =
    typeof body === "object" && body !== null && typeof (body as { retryAfterMs?: unknown }).retryAfterMs === "number"
      ? (body as { retryAfterMs: number }).retryAfterMs
      : null;
  const supported = {
    voices: stringsFromBody(body, "supportedVoices"),
    languages: stringsFromBody(body, "supportedLanguages"),
  };
  switch (status) {
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
    case 422:
      if (code === "UNSUPPORTED_VOICE") return failure("unsupported-voice", null, supported);
      if (code === "UNSUPPORTED_LANGUAGE" || code === "VOICE_LANGUAGE_MISMATCH") return failure("unsupported-language", null, supported);
      return failure("invalid-request");
    case 429:
      return failure("rate-limited", retryAfterMs);
    case 499:
      return failure("network");
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
 * Fetches synthesized MP3 bytes for one stored tutor response through the
 * authenticated Convex HTTP route. The bytes live only in the returned blob:
 * they are never written to storage, never logged and never turned into a
 * bearer URL. A missing token resolves to a typed failure without any request.
 */
export async function requestTtsAudio(request: TtsRequest): Promise<TtsResult> {
  if (request.token === null || request.token === "") return failure("unauthenticated");
  const fetchImpl = request.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(buildTtsUrl(request.siteUrl, request), {
      method: "POST",
      headers: { authorization: `Bearer ${request.token}` },
      signal: request.signal,
    });
  } catch {
    return failure("network");
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return mapTtsResponse(response.status, body);
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("audio/")) return failure("unknown");
  let audio: Blob;
  try {
    audio = await response.blob();
  } catch {
    return failure("network");
  }
  if (audio.size === 0) return failure("unknown");
  return { ok: true, audio, contentType };
}
