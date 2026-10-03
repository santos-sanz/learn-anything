import type { TurnAction } from "./turnState.js";

/**
 * S18 explicit translation. Every translation is an action the learner picks,
 * never a side effect of recording or of the project's language: the target is
 * chosen, the original text stays on screen next to the translation, and an
 * unsupported combination answers with actionable copy instead of silently
 * falling back to English.
 */
export type TranslationLanguage = "en" | "es";
export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = ["en", "es"];

export const LANGUAGE_NAMES: Record<TranslationLanguage, string> = {
  en: "English",
  es: "Spanish",
};

export function languageName(language: TranslationLanguage): string {
  return LANGUAGE_NAMES[language];
}

export function isTranslationLanguage(value: string): value is TranslationLanguage {
  return (TRANSLATION_LANGUAGES as readonly string[]).includes(value);
}

/** Whisper's documented limit: the audio translation endpoint outputs English only. */
export const AUDIO_TRANSLATION_TARGET: TranslationLanguage = "en";

export interface TurnActionOption {
  readonly value: TurnAction;
  readonly label: string;
  readonly help: string;
}

/** The three actions stay visibly distinct and none of them is the default. */
export const TURN_ACTION_OPTIONS: readonly TurnActionOption[] = [
  {
    value: "transcribe",
    label: "Transcribe speech",
    help: "Keeps the spoken language. Transcription never translates.",
  },
  {
    value: "translate-audio",
    label: "Translate audio",
    help: "Translates what you say. Whisper's audio translation only outputs English.",
  },
  {
    value: "translate-text",
    label: "Translate text",
    help: "Translates text you already have into the target language with the LLM.",
  },
];

export function audioTranslationSupport(target: TranslationLanguage): { supported: boolean; message: string | null } {
  if (target === AUDIO_TRANSLATION_TARGET) return { supported: true, message: null };
  return {
    supported: false,
    message: `Audio translation to ${languageName(target)} is not supported. Whisper's audio translation only produces English. We can translate the text instead: choose “Translate text”, transcribe the turn and translate the transcript.`,
  };
}

export type TextTranslationFailureCode =
  | "unsupported-language-pair"
  | "text-too-large"
  | "unauthenticated"
  | "not-found"
  | "provider-policy"
  | "not-configured"
  | "invalid-request"
  | "timeout"
  | "rate-limited"
  | "provider-unavailable"
  | "network"
  | "unknown";

export interface TextTranslationResult {
  readonly target: TranslationLanguage;
  readonly translation: string;
  readonly unchanged: boolean;
}

export interface TextTranslationState {
  readonly phase: "idle" | "pending" | "done" | "failed";
  /** The learner's own text. It is never replaced by a translation. */
  readonly original: string;
  readonly source: TranslationLanguage;
  readonly sourceTurnId: string | null;
  readonly result: TextTranslationResult | null;
  readonly code: TextTranslationFailureCode | null;
  readonly retryAfterMs: number | null;
}

export type TextTranslationEvent =
  | { type: "SET_SOURCE"; source: TranslationLanguage }
  | { type: "EDIT_ORIGINAL"; text: string }
  | { type: "SEED_ORIGINAL"; text: string; source: TranslationLanguage; turnId: string }
  | { type: "REQUEST" }
  | { type: "SUCCEEDED"; target: TranslationLanguage; translation: string; unchanged: boolean }
  | { type: "FAILED"; code: TextTranslationFailureCode; retryAfterMs: number | null }
  | { type: "CLEAR_RESULT" }
  | { type: "RESET" };

export function initialTextTranslationState(): TextTranslationState {
  return {
    phase: "idle",
    original: "",
    source: "en",
    sourceTurnId: null,
    result: null,
    code: null,
    retryAfterMs: null,
  };
}

/** A finished translation never overwrites the original; it only sits beside it. */
export function reduceTextTranslation(state: TextTranslationState, event: TextTranslationEvent): TextTranslationState {
  switch (event.type) {
    case "SET_SOURCE":
      return { ...state, source: event.source };
    case "EDIT_ORIGINAL":
      return { ...state, original: event.text, result: null, phase: state.phase === "pending" ? state.phase : "idle", code: null };
    case "SEED_ORIGINAL":
      // One recording seeds the field once, so a late event cannot overwrite
      // text the learner has already edited or a result they are reading.
      if (event.turnId === state.sourceTurnId) return state;
      if (state.phase === "pending") return state;
      return { ...state, original: event.text, source: event.source, sourceTurnId: event.turnId, result: null, code: null, phase: "idle" };
    case "REQUEST":
      if (state.phase === "pending") return state;
      return { ...state, phase: "pending", code: null, retryAfterMs: null };
    case "SUCCEEDED":
      if (state.phase !== "pending") return state;
      return { ...state, phase: "done", result: { target: event.target, translation: event.translation, unchanged: event.unchanged } };
    case "FAILED":
      if (state.phase !== "pending") return state;
      return { ...state, phase: "failed", code: event.code, retryAfterMs: event.retryAfterMs, result: null };
    case "CLEAR_RESULT":
      return { ...state, phase: "idle", result: null, code: null, retryAfterMs: null };
    case "RESET":
      return initialTextTranslationState();
    default:
      return state;
  }
}

/** Mirrors the server-side source text limit so the UI can explain it up front. */
export const MAX_TRANSLATION_TEXT_CHARS = 20_000;

/** The translate button stays disabled with a visible reason, never a silent no-op. */
export function textTranslationBlockedReason(state: TextTranslationState, target: TranslationLanguage): string | null {
  if (state.phase === "pending") return "A translation is already running.";
  if (state.original.trim() === "") return "Enter or record some text to translate.";
  if (state.original.length > MAX_TRANSLATION_TEXT_CHARS) return `The text is longer than the ${MAX_TRANSLATION_TEXT_CHARS.toLocaleString("en-US")} character limit. Shorten it first.`;
  if (state.source === target) return `Source and target are both ${languageName(target)}; choose a different target language.`;
  return null;
}

export function textTranslationFailureMessage(code: TextTranslationFailureCode, retryAfterMs: number | null): string {
  switch (code) {
    case "unsupported-language-pair":
      return "That language pair is not supported. Choose English or Spanish as the source and target language.";
    case "text-too-large":
      return `The text is too long to translate. Shorten it to at most ${MAX_TRANSLATION_TEXT_CHARS.toLocaleString("en-US")} characters and try again.`;
    case "unauthenticated":
      return "Your session has expired. Sign in again, then retry the translation.";
    case "not-found":
      return "This project is no longer available. Choose another project and retry.";
    case "provider-policy":
      return "Text translation is only enabled for the deployer in this self-hosted build.";
    case "not-configured":
      return "Text translation is not configured on this server. Set the server-side provider key, then retry.";
    case "invalid-request":
      return "The translation request was rejected. Check the text and languages, then try again.";
    case "timeout":
      return "Text translation timed out. Check your connection and try again.";
    case "rate-limited": {
      const seconds = retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000);
      return seconds === null
        ? "Text translation is rate limited. Wait a moment, then try again."
        : `Text translation is rate limited. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
    }
    case "provider-unavailable":
      return "The translation service did not respond in time. Try again shortly.";
    case "network":
      return "The text could not be sent. Check your connection and try again.";
    case "unknown":
      return "Text translation failed. Try again.";
  }
}
