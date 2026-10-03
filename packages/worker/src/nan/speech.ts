import { NanAdapterError, nanModels, nanVoices, type NanVoice } from "./types.js";

/**
 * S16 Kokoro speech configuration. Voice and language availability come from
 * this provider configuration only: the S11 adapter's configured Kokoro voices
 * (`af_heart` English / `ef_dora` Spanish) with the language each one speaks.
 * Nothing here may invent a voice, substitute another provider, or claim that
 * a Whisper STT language has a TTS voice — only the entries below are
 * synthesizable, and any other request fails with a typed code instead of
 * silently falling back to a default voice.
 */
export const TTS_LANGUAGES = ["en", "es"] as const;
export type TtsLanguage = (typeof TTS_LANGUAGES)[number];

export interface ConfiguredSpeechVoice {
  readonly id: NanVoice;
  readonly language: TtsLanguage;
  readonly label: string;
}

/** The configured/allowed voice list, derived from the S11 `nanVoices` defaults. */
export const KOKORO_VOICES: readonly ConfiguredSpeechVoice[] = [
  { id: nanVoices.english, language: "en", label: "English (af_heart)" },
  { id: nanVoices.spanish, language: "es", label: "Spanish (ef_dora)" },
];

/**
 * Product limit for one synthesis request. The S11 input budget is 24,000
 * characters; 20,000 keeps headroom so text that passes this gate can never
 * fail later as `NAN_INPUT_TOO_LARGE`.
 */
export const MAX_SPEECH_TEXT_CHARS = 20_000;

/** NaN's speech endpoint answers MP3 bytes for the configured Kokoro model. */
export const SPEECH_OUTPUT_FORMAT = "mp3" as const;

export interface SpeechCatalogVoice {
  readonly id: string;
  readonly language: TtsLanguage;
  readonly label: string;
}

export interface SpeechCatalog {
  readonly model: string;
  readonly format: typeof SPEECH_OUTPUT_FORMAT;
  readonly languages: readonly TtsLanguage[];
  readonly voices: readonly SpeechCatalogVoice[];
  readonly maxTextChars: number;
}

/** The visible provider contract: model, format, allowed voices/languages and the text cap. */
export function speechCatalog(): SpeechCatalog {
  return {
    model: nanModels.speech,
    format: SPEECH_OUTPUT_FORMAT,
    languages: TTS_LANGUAGES,
    voices: KOKORO_VOICES.map((voice) => ({ id: voice.id, language: voice.language, label: voice.label })),
    maxTextChars: MAX_SPEECH_TEXT_CHARS,
  };
}

export function isTtsLanguage(value: string): value is TtsLanguage {
  return (TTS_LANGUAGES as readonly string[]).includes(value);
}

/** The configured voice for a language; `null` means this build has no voice for it. */
export function voiceForLanguage(language: TtsLanguage): NanVoice | null {
  return KOKORO_VOICES.find((voice) => voice.language === language)?.id ?? null;
}

export type SpeechVoiceRequest = {
  readonly language?: string | null | undefined;
  readonly voice?: string | null | undefined;
};

export type SpeechVoiceResolution =
  | { readonly ok: true; readonly voice: NanVoice; readonly language: TtsLanguage }
  | {
      readonly ok: false;
      readonly code: "UNSUPPORTED_VOICE" | "UNSUPPORTED_LANGUAGE" | "VOICE_LANGUAGE_MISMATCH";
      readonly supportedVoices: string[];
      readonly supportedLanguages: TtsLanguage[];
    };

function unsupported(
  code: "UNSUPPORTED_VOICE" | "UNSUPPORTED_LANGUAGE" | "VOICE_LANGUAGE_MISMATCH",
): Extract<SpeechVoiceResolution, { ok: false }> {
  return {
    ok: false,
    code,
    supportedVoices: KOKORO_VOICES.map((voice) => voice.id),
    supportedLanguages: [...TTS_LANGUAGES],
  };
}

/**
 * Resolves a requested voice/language pair against the provider configuration.
 *
 * - An absent language defaults to the configured English voice; an absent
 *   voice is derived from the requested language. Those are explicit defaults
 *   from this configuration, not fallbacks for a rejected value.
 * - An unknown voice or language, or a voice that does not speak the
 *   requested language, is a typed refusal: the caller is told what is
 *   configured instead of receiving audio in some other voice.
 */
export function resolveSpeechVoice(request: SpeechVoiceRequest): SpeechVoiceResolution {
  // An empty query parameter means "not requested", exactly like an absent one.
  const rawLanguage = request.language == null || request.language === "" ? null : request.language;
  const rawVoice = request.voice == null || request.voice === "" ? null : request.voice;
  if (rawLanguage !== null && !isTtsLanguage(rawLanguage)) return unsupported("UNSUPPORTED_LANGUAGE");
  if (rawVoice !== null && !KOKORO_VOICES.some((voice) => voice.id === rawVoice)) return unsupported("UNSUPPORTED_VOICE");
  if (rawVoice !== null) {
    const configured = KOKORO_VOICES.find((voice) => voice.id === rawVoice);
    if (configured === undefined) return unsupported("UNSUPPORTED_VOICE");
    if (rawLanguage !== null && configured.language !== rawLanguage) return unsupported("VOICE_LANGUAGE_MISMATCH");
    return { ok: true, voice: configured.id, language: configured.language };
  }
  const language: TtsLanguage = rawLanguage ?? "en";
  const voice = voiceForLanguage(language);
  if (voice === null) return unsupported("UNSUPPORTED_LANGUAGE");
  return { ok: true, voice, language };
}

/**
 * Spoken form of a stored tutor answer: citation markers such as `[2]` are
 * reference annotations for the visible transcript, not words, so they are
 * removed before synthesis while the displayed text stays complete.
 */
export function speechTextFromTutorAnswer(content: string): string {
  return content
    .replace(/\[\d{1,4}\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/** Guards the synthesis size before any provider request is built. */
export function assertSpeechTextSize(text: string): void {
  if (text.length > MAX_SPEECH_TEXT_CHARS) {
    throw new NanAdapterError("NAN_INPUT_TOO_LARGE", "Speech text exceeds the configured Kokoro limit.");
  }
}
