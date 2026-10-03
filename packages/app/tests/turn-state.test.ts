import { expect, test } from "vitest";

import { MAX_RECORDING_MS } from "../src/audioCapture.js";
import {
  blockedMessage,
  canStartTurn,
  failureMessage,
  initialTurnState,
  reduceTurn,
  type TurnState,
} from "../src/turnState.js";

const recording: TurnState = { phase: "recording", elapsedMs: 0, limitMs: MAX_RECORDING_MS };
const transcribing: TurnState = { phase: "transcribing" };

test("permission denial, missing microphone and unsupported codecs are distinct actionable states", () => {
  let state = reduceTurn(initialTurnState(), { type: "START" });
  expect(state).toEqual({ phase: "requesting-permission" });
  state = reduceTurn(state, { type: "BLOCKED", reason: "permission-denied" });
  expect(state).toEqual({ phase: "blocked", reason: "permission-denied" });
  expect(blockedMessage("permission-denied")).toMatch(/permission/i);
  expect(blockedMessage("permission-denied")).toMatch(/browser settings/i);

  state = reduceTurn(reduceTurn(initialTurnState(), { type: "START" }), { type: "BLOCKED", reason: "no-microphone" });
  expect(state).toEqual({ phase: "blocked", reason: "no-microphone" });
  expect(blockedMessage("no-microphone")).toMatch(/microphone/i);

  state = reduceTurn(reduceTurn(initialTurnState(), { type: "START" }), { type: "BLOCKED", reason: "unsupported-codec" });
  expect(state).toEqual({ phase: "blocked", reason: "unsupported-codec" });
  expect(blockedMessage("unsupported-codec")).toMatch(/format/i);

  for (const reason of ["permission-denied", "no-microphone", "unsupported-codec"] as const) {
    expect(canStartTurn({ phase: "blocked", reason })).toBe(true);
    expect(reduceTurn({ phase: "blocked", reason }, { type: "START" })).toEqual({ phase: "requesting-permission" });
  }
});

test("the recording clock ticks up and clamps at the 60 second limit", () => {
  let state: TurnState = reduceTurn(initialTurnState(), { type: "START" });
  state = reduceTurn(state, { type: "MICROPHONE_READY" });
  expect(state).toEqual({ phase: "recording", elapsedMs: 0, limitMs: MAX_RECORDING_MS });
  state = reduceTurn(state, { type: "TICK", elapsedMs: 2_000 });
  expect(state).toMatchObject({ elapsedMs: 2_000 });
  state = reduceTurn(state, { type: "TICK", elapsedMs: 61_000 });
  expect(state).toMatchObject({ elapsedMs: MAX_RECORDING_MS });
});

test("a captured turn moves through analysis to an editable transcript", () => {
  let state: TurnState = reduceTurn(recording, { type: "STOP" });
  expect(state).toEqual({ phase: "analysing" });
  state = reduceTurn(state, { type: "AUDIO_READY" });
  expect(state).toEqual({ phase: "transcribing" });
  state = reduceTurn(state, {
    type: "TRANSCRIBED",
    text: "hola mundo",
    detectedLanguage: "es",
    durationMs: 1.5,
    turnId: "turn-1",
  });
  expect(state).toEqual({
    phase: "transcript",
    kind: "transcription",
    text: "hola mundo",
    detectedLanguage: "es",
    durationMs: 1.5,
    turnId: "turn-1",
  });
  const edited = reduceTurn(state, { type: "EDIT_TRANSCRIPT", text: "hola mundo (edited)" });
  expect(edited).toMatchObject({ phase: "transcript", text: "hola mundo (edited)" });
});

test("silence and every provider failure map to their own visible states", () => {
  expect(reduceTurn({ phase: "analysing" }, { type: "LOCAL_SILENCE" })).toEqual({ phase: "silence" });
  expect(reduceTurn(transcribing, { type: "TRANSCRIBE_FAILED", code: "silence", retryAfterMs: null })).toEqual({
    phase: "silence",
  });
  expect(reduceTurn(transcribing, { type: "TRANSCRIBE_FAILED", code: "timeout", retryAfterMs: null })).toEqual({
    phase: "failed",
    code: "timeout",
    retryAfterMs: null,
  });
  expect(reduceTurn(transcribing, { type: "TRANSCRIBE_FAILED", code: "rate-limited", retryAfterMs: 3_000 })).toEqual({
    phase: "failed",
    code: "rate-limited",
    retryAfterMs: 3_000,
  });
  expect(failureMessage("timeout", null)).toMatch(/timed out/i);
  expect(failureMessage("rate-limited", 3_000)).toMatch(/3 seconds/);
  expect(failureMessage("provider-unavailable", null)).toMatch(/service/i);
  expect(failureMessage("too-large", null)).toMatch(/shorter/i);
  for (const code of ["silence", "timeout", "rate-limited", "provider-unavailable", "not-configured", "too-large", "unsupported-codec", "unsupported-audio-target", "unauthenticated", "not-found", "provider-policy", "invalid-request", "network", "unknown"] as const) {
    expect(failureMessage(code, null).length).toBeGreaterThan(10);
  }
  expect(failureMessage("unsupported-audio-target", null)).toMatch(/only produces English/);
  expect(failureMessage("unsupported-audio-target", null)).toMatch(/translate the text instead/i);
});

test("an audio translation result is labelled as a translation, never as a transcript", () => {
  const state = reduceTurn(transcribing, { type: "AUDIO_TRANSLATED", text: "hello world", turnId: "turn-9" });
  expect(state).toEqual({
    phase: "transcript",
    kind: "audio-translation",
    text: "hello world",
    detectedLanguage: "en",
    durationMs: null,
    turnId: "turn-9",
  });
  // It only applies to the in-flight provider stage.
  expect(reduceTurn(recording, { type: "AUDIO_TRANSLATED", text: "late", turnId: "turn-9" })).toBe(recording);
  const idle = initialTurnState();
  expect(reduceTurn(idle, { type: "AUDIO_TRANSLATED", text: "late", turnId: "turn-9" })).toBe(idle);
});

test("abort cancels every in-flight stage and only those stages", () => {
  for (const state of [
    { phase: "requesting-permission" } as TurnState,
    recording,
    { phase: "analysing" } as TurnState,
    transcribing,
  ]) {
    expect(reduceTurn(state, { type: "ABORT" })).toEqual({ phase: "aborted" });
  }
  expect(reduceTurn({ phase: "transcript", kind: "transcription", text: "t", detectedLanguage: "en", durationMs: null, turnId: "x" }, { type: "ABORT" })).toMatchObject({ phase: "transcript" });
  expect(reduceTurn(recording, { type: "RESET" })).toEqual({ phase: "idle" });
});

test("events from another stage never corrupt the current state", () => {
  const idle = initialTurnState();
  expect(reduceTurn(idle, { type: "MICROPHONE_READY" })).toBe(idle);
  expect(reduceTurn(transcribing, { type: "TICK", elapsedMs: 5 })).toBe(transcribing);
  expect(reduceTurn(recording, { type: "AUDIO_READY" })).toBe(recording);
  expect(reduceTurn(recording, { type: "START" })).toBe(recording);
});
