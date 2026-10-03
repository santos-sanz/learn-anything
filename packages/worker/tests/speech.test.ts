import { expect, test } from "vitest";

import {
  KOKORO_VOICES,
  MAX_SPEECH_TEXT_CHARS,
  NanClient,
  NanAdapterError,
  NAN_BASE_URL,
  TTS_LANGUAGES,
  assertSpeechTextSize,
  nanVoices,
  resolveSpeechVoice,
  speechCatalog,
  speechTextFromTutorAnswer,
  voiceForLanguage,
} from "../src/index.js";

const deployment = { mode: "single-user-self-hosted" as const, learnerId: "owner", deployerId: "owner" };

test("the visible speech catalog is the provider configuration, nothing else", () => {
  const catalog = speechCatalog();
  expect(catalog.model).toBe("kokoro");
  expect(catalog.format).toBe("mp3");
  expect(catalog.maxTextChars).toBe(MAX_SPEECH_TEXT_CHARS);
  expect([...catalog.languages]).toEqual(["en", "es"]);
  expect(catalog.voices.map((voice) => voice.id)).toEqual([nanVoices.english, nanVoices.spanish]);
  expect(catalog.voices.map((voice) => voice.language)).toEqual(["en", "es"]);
  // Every configured voice speaks its own language and nothing outside the
  // typed set can appear in the catalog.
  expect(KOKORO_VOICES.every((voice) => TTS_LANGUAGES.includes(voice.language))).toBe(true);
  expect(KOKORO_VOICES.map((voice) => voice.id)).not.toContain("am_michael");
});

test("absent parameters resolve to explicit configuration defaults", () => {
  expect(resolveSpeechVoice({})).toEqual({ ok: true, voice: nanVoices.english, language: "en" });
  // An empty query parameter is "not requested", never an unsupported value.
  expect(resolveSpeechVoice({ language: "", voice: "" })).toEqual({ ok: true, voice: nanVoices.english, language: "en" });
  expect(resolveSpeechVoice({ language: "es" })).toEqual({ ok: true, voice: nanVoices.spanish, language: "es" });
  // A configured voice also fixes its language when no language was named.
  expect(resolveSpeechVoice({ voice: nanVoices.spanish })).toEqual({ ok: true, voice: nanVoices.spanish, language: "es" });
  expect(voiceForLanguage("en")).toBe(nanVoices.english);
});

test("an unsupported voice or language is a typed refusal, never a silent fallback", () => {
  const voice = resolveSpeechVoice({ voice: "am_michael" });
  expect(voice.ok).toBe(false);
  if (voice.ok) throw new Error("expected a refusal");
  expect(voice.code).toBe("UNSUPPORTED_VOICE");
  expect(voice.supportedVoices).toEqual([nanVoices.english, nanVoices.spanish]);
  expect(voice.supportedLanguages).toEqual(["en", "es"]);

  const language = resolveSpeechVoice({ language: "fr" });
  expect(language.ok).toBe(false);
  if (language.ok) throw new Error("expected a refusal");
  expect(language.code).toBe("UNSUPPORTED_LANGUAGE");

  // Not every STT language has a TTS voice: only the configured pair is offered.
  expect(voiceForLanguage("es")).not.toBeNull();
  expect((TTS_LANGUAGES as readonly string[]).includes("fr")).toBe(false);
});

test("a voice that does not speak the requested language is refused", () => {
  const mismatch = resolveSpeechVoice({ language: "es", voice: nanVoices.english });
  expect(mismatch).toMatchObject({ ok: false, code: "VOICE_LANGUAGE_MISMATCH" });
});

test("spoken text drops citation markers while the transcript stays complete", () => {
  const stored = "Sunlight becomes chemical energy [1].\nChlorophyll [2] absorbs it.";
  expect(speechTextFromTutorAnswer(stored)).toBe("Sunlight becomes chemical energy. Chlorophyll absorbs it.");
  expect(speechTextFromTutorAnswer("   \n  ")).toBe("");
  expect(() => assertSpeechTextSize("x".repeat(MAX_SPEECH_TEXT_CHARS))).not.toThrow();
  let caught: unknown;
  try {
    assertSpeechTextSize("x".repeat(MAX_SPEECH_TEXT_CHARS + 1));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NanAdapterError);
  expect((caught as NanAdapterError).code).toBe("NAN_INPUT_TOO_LARGE");
});

test("speech sends Kokoro with a configured voice and no provider substitution", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const client = new NanClient({ apiKey: "synthetic-server-token", fetch, deployment });
  const audio = await client.speech("hello", nanVoices.spanish);
  expect(audio).toEqual(new Uint8Array([1, 2, 3]));
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`${NAN_BASE_URL}/audio/speech`);
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    model: "kokoro",
    input: "hello",
    voice: nanVoices.spanish,
    response_format: "mp3",
    speed: 1,
  });
});

test("an unconfigured voice or empty provider answer is a typed adapter error", async () => {
  const client = new NanClient({ apiKey: "synthetic-server-token", fetch: async () => new Response(new Uint8Array([1])), deployment });
  await expect(client.speech("hello", "zz_unknown" as never)).rejects.toMatchObject({ code: "NAN_UNSUPPORTED_CAPABILITY" });

  const empty = new NanClient({ apiKey: "synthetic-server-token", fetch: async () => new Response(new Uint8Array(0)), deployment });
  await expect(empty.speech("hello")).rejects.toMatchObject({ code: "NAN_MALFORMED_RESPONSE" });

  const oversized = new NanClient({
    apiKey: "synthetic-server-token",
    fetch: async () => {
      throw new Error("must not be called");
    },
    deployment,
    quotaControls: { maxInputCharacters: 4 },
  });
  await expect(oversized.speech("12345")).rejects.toBeInstanceOf(NanAdapterError);
});
