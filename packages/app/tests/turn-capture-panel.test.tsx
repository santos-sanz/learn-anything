import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MAX_RECORDING_MS } from "../src/audioCapture.js";
import { TurnCapturePanel, type TurnCapturePanelProps } from "../src/TurnCapturePanel.js";
import type { TurnState } from "../src/turnState.js";

function render(state: TurnState, overrides: Partial<TurnCapturePanelProps> = {}): string {
  const props: TurnCapturePanelProps = {
    state,
    language: "en",
    onLanguageChange: () => undefined,
    onStart: () => undefined,
    onStop: () => undefined,
    onCancel: () => undefined,
    onEditTranscript: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(<TurnCapturePanel {...props} />);
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
