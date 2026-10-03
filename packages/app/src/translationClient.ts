import { MAX_AUDIO_BYTES } from "./audioCapture.js";
import { failureMessage, type TurnFailureCode } from "./turnState.js";
import {
  MAX_TRANSLATION_TEXT_CHARS,
  textTranslationFailureMessage,
  type TextTranslationFailureCode,
  type TranslationLanguage,
} from "./translationState.js";

/**
 * S18 translation clients. Both are explicit requests: the audio route is only
 * ever asked for English (Whisper's documented output), and the text route
 * always carries the learner's chosen source/target pair. Failure codes are
 * mapped from the response status alone, so an unexpected body never turns
 * into a silent English answer.
 */

export type AudioTranslationSuccess = { ok: true; text: string; turnId: string };
export type AudioTranslationFailure = { ok: false; code: TurnFailureCode; message: string; retryAfterMs: number | null };
export type AudioTranslationResult = AudioTranslationSuccess | AudioTranslationFailure;

export type AudioTranslationRequest = {
  siteUrl: string;
  token: string | null;
  projectId: string;
  turnId: string;
  target: TranslationLanguage;
  audio: Blob;
  signal?: AbortSignal;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

export function buildAudioTranslationUrl(
  siteUrl: string,
  params: { projectId: string; turnId: string; target: TranslationLanguage },
): string {
  const query = new URLSearchParams({ projectId: params.projectId, turnId: params.turnId, target: params.target });
  return `${siteUrl.replace(/\/+$/, "")}/translation/audio?${query.toString()}`;
}

function audioFailure(code: TurnFailureCode, retryAfterMs: number | null = null): AudioTranslationFailure {
  return { ok: false, code, message: failureMessage(code, retryAfterMs), retryAfterMs };
}

/** Pure status/body mapping: the English-only answer is verified, not assumed. */
export function mapAudioTranslationResponse(status: number, body: unknown): AudioTranslationResult {
  const payload = typeof body === "object" && body !== null ? (body as { code?: unknown; retryAfterMs?: unknown }) : {};
  const code = typeof payload.code === "string" ? payload.code : undefined;
  const retryAfterMs = typeof payload.retryAfterMs === "number" ? payload.retryAfterMs : null;
  switch (status) {
    case 200: {
      const result = body as { text?: unknown; turnId?: unknown; language?: unknown; target?: unknown };
      if (typeof result.text !== "string" || typeof result.turnId !== "string" || result.language !== "en" || result.target !== "en") {
        return audioFailure("unknown");
      }
      return { ok: true, text: result.text, turnId: result.turnId };
    }
    case 400:
      return audioFailure("invalid-request");
    case 401:
      return audioFailure("unauthenticated");
    case 403:
      return audioFailure("provider-policy");
    case 404:
      return audioFailure("not-found");
    case 413:
      return audioFailure("too-large");
    case 415:
      return audioFailure("unsupported-codec");
    case 422:
      if (code === "AUDIO_TRANSLATION_UNSUPPORTED") return audioFailure("unsupported-audio-target");
      return code === "SILENCE" ? audioFailure("silence") : audioFailure("invalid-request");
    case 429:
      return audioFailure("rate-limited", retryAfterMs);
    case 502:
      return audioFailure("provider-unavailable");
    case 503:
      return audioFailure("not-configured");
    case 504:
      return audioFailure("timeout");
    default:
      return status >= 500 ? audioFailure("unknown") : audioFailure("invalid-request");
  }
}

export async function requestAudioTranslation(request: AudioTranslationRequest): Promise<AudioTranslationResult> {
  if (request.token === null || request.token === "") return audioFailure("unauthenticated");
  if (request.audio.size > MAX_AUDIO_BYTES) return audioFailure("too-large");
  const fetchImpl = request.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(buildAudioTranslationUrl(request.siteUrl, request), {
      method: "POST",
      headers: { authorization: `Bearer ${request.token}`, "content-type": request.audio.type || "application/octet-stream" },
      body: request.audio,
      signal: request.signal,
    });
  } catch {
    return audioFailure("network");
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return mapAudioTranslationResponse(response.status, parsed);
}

export type TextTranslationSuccess = {
  ok: true;
  source: TranslationLanguage;
  target: TranslationLanguage;
  translation: string;
  unchanged: boolean;
};
export type TextTranslationFailure = {
  ok: false;
  code: TextTranslationFailureCode;
  message: string;
  retryAfterMs: number | null;
};
export type TextTranslationResponse = TextTranslationSuccess | TextTranslationFailure;

export type TextTranslationRequest = {
  siteUrl: string;
  token: string | null;
  projectId: string;
  text: string;
  source: TranslationLanguage;
  target: TranslationLanguage;
  signal?: AbortSignal;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

export function buildTextTranslationUrl(siteUrl: string, params: { projectId: string }): string {
  return `${siteUrl.replace(/\/+$/, "")}/translation/text?projectId=${encodeURIComponent(params.projectId)}`;
}

function textFailure(code: TextTranslationFailureCode, retryAfterMs: number | null = null): TextTranslationFailure {
  return { ok: false, code, message: textTranslationFailureMessage(code, retryAfterMs), retryAfterMs };
}

export function mapTextTranslationResponse(status: number, body: unknown): TextTranslationResponse {
  const payload = typeof body === "object" && body !== null ? (body as { code?: unknown; retryAfterMs?: unknown }) : {};
  const code = typeof payload.code === "string" ? payload.code : undefined;
  const retryAfterMs = typeof payload.retryAfterMs === "number" ? payload.retryAfterMs : null;
  switch (status) {
    case 200: {
      const result = body as { source?: unknown; target?: unknown; translation?: unknown; unchanged?: unknown };
      if (
        (result.source !== "en" && result.source !== "es") ||
        (result.target !== "en" && result.target !== "es") ||
        typeof result.translation !== "string" ||
        typeof result.unchanged !== "boolean"
      ) {
        return textFailure("unknown");
      }
      return { ok: true, source: result.source, target: result.target, translation: result.translation, unchanged: result.unchanged };
    }
    case 400:
      return textFailure("invalid-request");
    case 401:
      return textFailure("unauthenticated");
    case 403:
      return textFailure("provider-policy");
    case 404:
      return textFailure("not-found");
    case 413:
      return textFailure("text-too-large");
    case 422:
      return code === "UNSUPPORTED_LANGUAGE_PAIR" ? textFailure("unsupported-language-pair") : textFailure("invalid-request");
    case 429:
      return textFailure("rate-limited", retryAfterMs);
    case 502:
      return textFailure("provider-unavailable");
    case 503:
      return textFailure("not-configured");
    case 504:
      return textFailure("timeout");
    default:
      return status >= 500 ? textFailure("unknown") : textFailure("invalid-request");
  }
}

/**
 * Sends the text to the authenticated Convex HTTP action. Oversized text and a
 * missing session resolve to typed failures locally, so nothing is sent for a
 * request the server would refuse anyway.
 */
export async function requestTextTranslation(request: TextTranslationRequest): Promise<TextTranslationResponse> {
  if (request.token === null || request.token === "") return textFailure("unauthenticated");
  if (request.text.length > MAX_TRANSLATION_TEXT_CHARS) return textFailure("text-too-large");
  if (request.source === request.target) {
    return { ok: true, source: request.source, target: request.target, translation: request.text, unchanged: true };
  }
  const fetchImpl = request.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(buildTextTranslationUrl(request.siteUrl, request), {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: request.text, source: request.source, target: request.target }),
      signal: request.signal,
    });
  } catch {
    return textFailure("network");
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return mapTextTranslationResponse(response.status, parsed);
}
