import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MAX_RECORDING_MS } from "../src/audioCapture.js";
import { TurnCapturePanel, type TurnCapturePanelProps } from "../src/TurnCapturePanel.js";
import { initialTextTranslationState, type TextTranslationState } from "../src/translationState.js";
import type { TurnState } from "../src/turnState.js";

function render(state: TurnState, overrides: Partial<TurnCapturePanelProps> = {}): string {
  const props: TurnCapturePanelProps = {
    state,
    action: "transcribe",
    onActionChange: () => undefined,
    language: "en",
    onLanguageChange: () => undefined,
    target: "en",
    onTargetChange: () => undefined,
    onStart: () => undefined,
    onStop: () => undefined,
    onCancel: () => undefined,
    onEditTranscript: () => undefined,
    textTranslation: initialTextTranslationState(),
    onEditSourceText: () => undefined,
    onSourceLanguageChange: () => undefined,
    onTranslateText: () => undefined,
    onClearTranslation: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(<TurnCapturePanel {...props} />);
}

function doneTranslation(original: string, translation: string): TextTranslationState {
  return {
    ...initialTextTranslationState(),
    phase: "done",
    original,
    source: "es",
    result: { target: "en", translation, unchanged: false },
  };
}

test("the idle panel offers recording with the language select and limits", () => {
  const html = render({ phase: "idle" });
  expect(html).toContain("Record a turn");
  expect(html).toContain('id="turn-language"');
  expect(html).toContain('<option value="en" selected="">English</option>');
  expect(html).toContain('<option value="es">Spanish</option>');
  expect(html).toContain("never translates");
  expect(html).toContain("up to 60 seconds");
});

test("the recording panel shows the clock against the limit with stop and cancel", () => {
  const html = render({ phase: "recording", elapsedMs: 7_400, limitMs: MAX_RECORDING_MS });
  expect(html).toContain('role="status"');
  expect(html).toContain("Recording 00:07 of 01:00");
  expect(html).toContain("Stop and transcribe");
  expect(html).toContain("Cancel turn");
});

test("blocked capture states announce the actionable fix", () => {
  const permission = render({ phase: "blocked", reason: "permission-denied" });
  expect(permission).toContain('role="alert"');
  expect(permission).toContain("Microphone permission was denied");
  expect(permission).toContain("browser settings");
  expect(permission).toContain("Try again");

  const noMicrophone = render({ phase: "blocked", reason: "no-microphone" });
  expect(noMicrophone).toContain("No microphone is available");
  expect(noMicrophone).toContain('role="alert"');

  const codec = render({ phase: "blocked", reason: "unsupported-codec" });
  expect(codec).toContain("cannot record a supported compressed audio format");
});

test("silence and provider failures render distinct visible errors", () => {
  const silence = render({ phase: "silence" });
  expect(silence).toContain('role="alert"');
  expect(silence).toContain("No speech was detected");
  expect(silence).toContain("Record again");

  const timeout = render({ phase: "failed", code: "timeout", retryAfterMs: null });
  expect(timeout).toContain("Transcription timed out");

  const rateLimited = render({ phase: "failed", code: "rate-limited", retryAfterMs: 3_000 });
  expect(rateLimited).toContain("rate limited");
  expect(rateLimited).toContain("3 seconds");

  const unavailable = render({ phase: "failed", code: "provider-unavailable", retryAfterMs: null });
  expect(unavailable).toContain("did not respond");
  expect(unavailable).not.toContain("524"); // internals stay out of the UI copy
});

test("the transcript is an editable field with the detected language", () => {
  const html = render({
    phase: "transcript",
    kind: "transcription",
    text: "hola mundo",
    detectedLanguage: "es",
    durationMs: 1.5,
    turnId: "turn-1",
  });
  expect(html).toContain('id="turn-transcript"');
  expect(html).toContain("hola mundo");
  expect(html).toContain("Detected language: Spanish");
  expect(html).toContain("provider duration 1.5 s");
  expect(html).toContain("Record another turn");
});

test("in-flight stages expose cancel and the aborted stage says the audio was discarded", () => {
  const transcribing = render({ phase: "transcribing" });
  expect(transcribing).toContain("Transcribing your turn");
  expect(transcribing).toContain("Cancel");

  const analysing = render({ phase: "analysing" });
  expect(analysing).toContain("Checking the recording");

  const requesting = render({ phase: "requesting-permission" });
  expect(requesting).toContain("Requesting microphone permission");

  const aborted = render({ phase: "aborted" });
  expect(aborted).toContain("pending request was stopped");
  expect(aborted).toContain("recording was discarded");
  expect(aborted).toContain("Record again");
});

test("the three actions are distinct, labelled and none is chosen implicitly", () => {
  const html = render({ phase: "idle" }, { action: null });
  expect(html).toContain('name="turn-action" value="transcribe"');
  expect(html).toContain('name="turn-action" value="translate-audio"');
  expect(html).toContain('name="turn-action" value="translate-text"');
  expect(html).toContain("Transcribe speech");
  expect(html).toContain("Translate audio");
  expect(html).toContain("Translate text");
  expect(html).not.toContain("checked"); // no implicit default action
  expect(html).toContain("Choose what this turn should do");
  expect(html).not.toContain("Record a turn"); // recording is impossible before choosing
  expect(html).toContain("audio translation only outputs English");
});

test("each action renders only its own controls", () => {
  const transcribe = render({ phase: "idle" }, { action: "transcribe" });
  expect(transcribe).toContain("Record a turn");
  expect(transcribe).toContain("never translates");
  expect(transcribe).toContain('id="turn-language"');
  expect(transcribe).not.toContain('id="audio-target-language"');
  expect(transcribe).not.toContain('id="text-source"');

  const audio = render({ phase: "idle" }, { action: "translate-audio" });
  expect(audio).toContain("Record audio to translate to English");
  expect(audio).toContain('id="audio-target-language"');
  expect(audio).not.toContain('id="turn-language"');
  expect(audio).not.toContain('id="text-source"');

  const text = render({ phase: "idle" }, { action: "translate-text" });
  expect(text).toContain('aria-label="Text translation"');
  expect(text).toContain('id="text-source"');
  expect(text).toContain('id="text-target-language"');
  expect(text).not.toContain(">Record a turn<");
});

test("audio translation to a non-English target falls back to text translation instead of silent English", () => {
  const blocked = render({ phase: "idle" }, { action: "translate-audio", target: "es" });
  expect(blocked).toContain('role="alert"');
  expect(blocked).toContain("Audio translation to Spanish is not supported");
  expect(blocked).toContain("only produces English");
  expect(blocked).toContain("We can translate the text instead");
  expect(blocked).toContain("Translate the text instead"); // the actionable fallback
  expect(blocked).not.toContain("Record audio to translate"); // nothing is recorded for an unsupported target

  const supported = render({ phase: "idle" }, { action: "translate-audio", target: "en" });
  expect(supported).not.toContain('role="alert"');
  expect(supported).toContain("Record audio to translate to English");
});

test("a finished translation keeps the original text next to it, never in place of it", () => {
  const html = render({ phase: "idle" }, { action: "translate-text", textTranslation: doneTranslation("hola mundo", "hello world") });
  expect(html).toContain('aria-label="Text translation"');
  expect(html).toContain("Original text (Spanish)");
  expect(html).toContain("Translation (English)");
  expect(html).toContain("hello world");
  expect(html).toContain("Clear translation");
  const source = /id="text-source"[^>]*>([^<]*)</.exec(html);
  expect(source?.[1]).toBe("hola mundo"); // the original field still holds the source text
  expect(html).not.toContain("value=\"hello world\"");
});

test("text translation failures and disabled states explain the next step", () => {
  const failed: TextTranslationState = {
    ...initialTextTranslationState(),
    phase: "failed",
    original: "hola",
    source: "es",
    code: "unsupported-language-pair",
    retryAfterMs: null,
  };
  const failureHtml = render({ phase: "idle" }, { action: "translate-text", textTranslation: failed });
  expect(failureHtml).toContain('role="alert"');
  expect(failureHtml).toContain("That language pair is not supported");

  const emptyHtml = render({ phase: "idle" }, { action: "translate-text" });
  expect(emptyHtml).toContain("disabled");
  expect(emptyHtml).toContain("Enter or record some text to translate");
});

test("an audio translation result is labelled as English output, not as a transcript", () => {
  const html = render(
    { phase: "transcript", kind: "audio-translation", text: "hello world", detectedLanguage: "en", durationMs: null, turnId: "turn-1" },
    { action: "translate-audio" },
  );
  expect(html).toContain("Audio translation to English (editable)");
  expect(html).toContain("outputs English only");
  expect(html).not.toContain("Detected language");
});
