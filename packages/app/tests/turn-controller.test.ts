import { expect, test } from "vitest";

import { MAX_AUDIO_BYTES, MAX_RECORDING_MS, MAX_RECORDING_SECONDS, RECORDING_TICK_MS } from "../src/audioCapture.js";
import type { TranscribeResult } from "../src/transcribeClient.js";
import type { AudioTranslationResult } from "../src/translationClient.js";
import { TurnController, type CaptureSubscription, type CaptureRecording, type TurnEnvironment } from "../src/turnController.js";
import type { TurnState } from "../src/turnState.js";

type Scheduled = { id: number; at: number; callback: () => void };

type TranscribeInput = Parameters<TurnEnvironment["transcribe"]>[0];
type TranslateAudioInput = Parameters<TurnEnvironment["translateAudio"]>[0];

function createHarness(options: Partial<TurnEnvironment> = {}) {
  let now = 0;
  let nextHandle = 1;
  const scheduled: Scheduled[] = [];
  let subscription: CaptureSubscription | null = null;
  const spies = {
    startedMimes: [] as string[],
    recorderStops: 0,
    stopTrackCalls: 0,
    discarded: [] as Blob[],
    transcribeInputs: [] as TranscribeInput[],
    translateAudioInputs: [] as TranslateAudioInput[],
    states: [] as TurnState[],
  };
  const recording: CaptureRecording = {
    stop: () => {
      spies.recorderStops += 1;
      subscription?.onAudio(harness.audio);
    },
    stopTracks: () => {
      spies.stopTrackCalls += 1;
    },
  };
  const customTranscribe =
    options.transcribe ??
    (async (input: TranscribeInput): Promise<TranscribeResult> => ({
      ok: true,
      text: "hello turn",
      detectedLanguage: "es",
      durationMs: 1.5,
      turnId: input.turnId,
    }));
  const customTranslateAudio =
    options.translateAudio ??
    (async (input: TranslateAudioInput): Promise<AudioTranslationResult> => ({
      ok: true,
      text: "hello turn translated",
      turnId: input.turnId,
    }));
  const env: TurnEnvironment = {
    hasCaptureSupport: options.hasCaptureSupport ?? (() => true),
    isTypeSupported: options.isTypeSupported ?? ((type) => type.startsWith("audio/webm")),
    startMicrophone:
      options.startMicrophone ??
      (async (mimeType, sub) => {
        spies.startedMimes.push(mimeType);
        subscription = sub;
        return recording;
      }),
    readPeakLevel: options.readPeakLevel ?? (async () => 0.5),
    transcribe: (input) => {
      spies.transcribeInputs.push(input);
      return customTranscribe(input);
    },
    translateAudio: (input) => {
      spies.translateAudioInputs.push(input);
      return customTranslateAudio(input);
    },
    newTurnId: options.newTurnId ?? (() => `turn-${spies.transcribeInputs.length + 1}`),
    now: options.now ?? (() => now),
    schedule:
      options.schedule ??
      ((callback, delayMs) => {
        const handle = { id: nextHandle, at: now + delayMs, callback };
        nextHandle += 1;
        scheduled.push(handle);
        return handle.id;
      }),
    cancelSchedule:
      options.cancelSchedule ??
      ((handle) => {
        const index = scheduled.findIndex((entry) => entry.id === handle);
        if (index >= 0) scheduled.splice(index, 1);
      }),
    discardAudio: (audio) => spies.discarded.push(audio),
  };
  const controller = new TurnController({ env, projectId: "proj-1" });
  // The panel never records before the learner picks an action; the harness
  // picks transcription so the capture tests stay focused on capture.
  controller.setAction("transcribe");
  controller.subscribe(() => spies.states.push(controller.getSnapshot()));

  const harness = {
    controller,
    spies,
    audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
    flushUntil(targetMs: number) {
      for (;;) {
        const due = scheduled.filter((entry) => entry.at <= targetMs).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        scheduled.splice(scheduled.indexOf(due), 1);
        now = Math.max(now, due.at);
        due.callback();
      }
      now = Math.max(now, targetMs);
    },
    fireRecorderError(name: string) {
      subscription?.onError(name);
    },
    lateAudio(blob: Blob) {
      subscription?.onAudio(blob);
    },
  };
  return harness;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("permission denial, no microphone and unsupported codec stop before any recording", async () => {
  const denied = createHarness({
    startMicrophone: async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    },
  });
  await denied.controller.start();
  expect(denied.controller.getSnapshot()).toEqual({ phase: "blocked", reason: "permission-denied" });

  const absent = createHarness({ hasCaptureSupport: () => false });
  await absent.controller.start();
  expect(absent.controller.getSnapshot()).toEqual({ phase: "blocked", reason: "no-microphone" });
  expect(absent.spies.startedMimes).toHaveLength(0);

  const codec = createHarness({ isTypeSupported: () => false });
  await codec.controller.start();
  expect(codec.controller.getSnapshot()).toEqual({ phase: "blocked", reason: "unsupported-codec" });
  expect(codec.spies.startedMimes).toHaveLength(0);

  const deviceLost = createHarness();
  await deviceLost.controller.start();
  expect(deviceLost.controller.getSnapshot().phase).toBe("recording");
  deviceLost.fireRecorderError("NotFoundError");
  expect(deviceLost.controller.getSnapshot()).toEqual({ phase: "blocked", reason: "no-microphone" });
});

test("a full turn records, transcribes, edits and discards the raw audio", async () => {
  const harness = createHarness();
  await harness.controller.start();
  expect(harness.controller.getSnapshot()).toEqual({ phase: "recording", elapsedMs: 0, limitMs: MAX_RECORDING_MS });

  harness.controller.stopRecording();
  await waitUntil(() => harness.controller.getSnapshot().phase === "transcript", "transcript");
  const state = harness.controller.getSnapshot();
  expect(state).toMatchObject({ phase: "transcript", text: "hello turn", detectedLanguage: "es" });
  expect(harness.spies.transcribeInputs).toHaveLength(1);
  expect(harness.spies.transcribeInputs[0]).toMatchObject({ projectId: "proj-1", language: "en" });
  expect(harness.spies.transcribeInputs[0].signal.aborted).toBe(false);
  expect(harness.spies.discarded).toEqual([harness.audio]); // raw audio is discarded once processing ends

  harness.controller.editTranscript("hello turn (edited)");
  expect(harness.controller.getSnapshot()).toMatchObject({ text: "hello turn (edited)" });
});

test("silence is caught locally before any provider request", async () => {
  const harness = createHarness({ readPeakLevel: async () => 0 });
  await harness.controller.start();
  harness.controller.stopRecording();
  await waitUntil(() => harness.controller.getSnapshot().phase === "silence", "silence state");
  expect(harness.spies.transcribeInputs).toHaveLength(0);
  expect(harness.spies.discarded).toEqual([harness.audio]);
});

test("a provider silence answer and a rate limit surface as their own states", async () => {
  const silence = createHarness({
    transcribe: async () => ({ ok: false, code: "silence", message: "No speech was detected.", retryAfterMs: null }),
  });
  await silence.controller.start();
  silence.controller.stopRecording();
  await waitUntil(() => silence.controller.getSnapshot().phase === "silence", "provider silence");
  expect(silence.spies.discarded).toEqual([silence.audio]);

  const limited = createHarness({
    transcribe: async () => ({ ok: false, code: "rate-limited", message: "Try again in 3 seconds.", retryAfterMs: 3_000 }),
  });
  await limited.controller.start();
  limited.controller.stopRecording();
  await waitUntil(() => limited.controller.getSnapshot().phase === "failed", "rate limit state");
  expect(limited.controller.getSnapshot()).toEqual({ phase: "failed", code: "rate-limited", retryAfterMs: 3_000 });
  expect(limited.spies.discarded).toEqual([limited.audio]);

  const timeout = createHarness({
    transcribe: async () => ({ ok: false, code: "timeout", message: "Transcription timed out.", retryAfterMs: null }),
  });
  await timeout.controller.start();
  timeout.controller.stopRecording();
  await waitUntil(() => timeout.controller.getSnapshot().phase === "failed", "timeout state");
  expect(timeout.controller.getSnapshot()).toMatchObject({ code: "timeout" });

  const unavailable = createHarness({
    transcribe: async () => ({ ok: false, code: "provider-unavailable", message: "Gateway 524.", retryAfterMs: null }),
  });
  await unavailable.controller.start();
  unavailable.controller.stopRecording();
  await waitUntil(() => unavailable.controller.getSnapshot().phase === "failed", "524 state");
  expect(unavailable.controller.getSnapshot()).toMatchObject({ code: "provider-unavailable" });
});

test("recording stops automatically at the configured 60 second limit", async () => {
  const harness = createHarness();
  await harness.controller.start();
  harness.flushUntil(MAX_RECORDING_MS + RECORDING_TICK_MS);
  await waitUntil(() => harness.controller.getSnapshot().phase === "transcript", "transcript after limit");
  expect(harness.spies.recorderStops).toBe(1);
  expect(harness.spies.stopTrackCalls).toBe(1);
  expect(MAX_RECORDING_SECONDS).toBeLessThanOrEqual(60);
  const recordedStates = harness.spies.states.filter((state) => state.phase === "recording");
  expect(recordedStates.length).toBeGreaterThan(1);
  expect(recordedStates.every((state) => state.phase === "recording" && state.elapsedMs <= MAX_RECORDING_MS)).toBe(true);
  expect(recordedStates.at(-1)).toMatchObject({ elapsedMs: MAX_RECORDING_MS });
});

test("a late tick cannot push the auto-stop past the configured 60 second limit", async () => {
  let clock = 0;
  let handle = 0;
  let firstWake = true;
  let stoppedAt: number | null = null;
  const pending: { at: number; handle: number; run: () => void }[] = [];
  const harness = createHarness({
    now: () => clock,
    schedule: (callback, delayMs) => {
      handle += 1;
      // The first wake-up runs 100 ms late, which shifts every later tick by
      // the same amount: an unclamped 250 ms granularity would then stop at
      // 60100 ms instead of at the limit.
      const lateness = firstWake ? 100 : 0;
      firstWake = false;
      pending.push({ at: clock + delayMs + lateness, handle, run: callback });
      return handle;
    },
    cancelSchedule: (scheduled) => {
      const index = pending.findIndex((entry) => entry.handle === (scheduled as number));
      if (index >= 0) pending.splice(index, 1);
    },
    transcribe: async () => {
      stoppedAt = clock;
      return { ok: true, text: "hello turn", detectedLanguage: "es", durationMs: 1.5, turnId: "turn-1" };
    },
  });

  await harness.controller.start();
  for (;;) {
    pending.sort((a, b) => a.at - b.at);
    const due = pending[0];
    if (due === undefined || due.at > MAX_RECORDING_MS + RECORDING_TICK_MS) break;
    pending.shift();
    clock = Math.max(clock, due.at);
    due.run();
  }
  await waitUntil(() => stoppedAt !== null, "stop at the limit");

  expect(stoppedAt).not.toBeNull();
  expect(stoppedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(MAX_RECORDING_MS);
  expect(harness.spies.recorderStops).toBe(1);
  expect(harness.controller.getSnapshot().phase).toBe("transcript");
});

test("abort during transcription cancels the pending request and frees the audio", async () => {
  const harness = createHarness({
    transcribe: (input) =>
      new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  await harness.controller.start();
  harness.controller.stopRecording();
  await waitUntil(() => harness.controller.getSnapshot().phase === "transcribing", "transcribing");
  harness.controller.cancel();
  await waitUntil(() => harness.spies.transcribeInputs.length === 1, "provider call");
  expect(harness.spies.transcribeInputs[0].signal.aborted).toBe(true);
  await waitUntil(() => harness.spies.discarded.length === 1, "audio discard");
  expect(harness.spies.discarded[0]).toBe(harness.audio);
  expect(harness.controller.getSnapshot()).toEqual({ phase: "aborted" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(harness.controller.getSnapshot()).toEqual({ phase: "aborted" }); // late provider rejection cannot resurrect the turn
});

test("abort while recording stops the device and discards late audio", async () => {
  const harness = createHarness();
  await harness.controller.start();
  harness.controller.cancel();
  expect(harness.controller.getSnapshot()).toEqual({ phase: "aborted" });
  expect(harness.spies.stopTrackCalls).toBe(1);
  expect(harness.spies.discarded).toEqual([harness.audio]);
  harness.lateAudio(new Blob([new Uint8Array([7])], { type: "audio/webm" }));
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(harness.spies.discarded).toHaveLength(2); // late bytes from the stopped recorder are dropped too
  expect(harness.controller.getSnapshot()).toEqual({ phase: "aborted" });
});

test("abort while permission is pending releases the device when it arrives", async () => {
  const gate: { release?: (recording: CaptureRecording) => void } = {};
  let stopTracksOnRelease = 0;
  const harness = createHarness({
    startMicrophone: () =>
      new Promise((resolve) => {
        gate.release = resolve;
      }),
  });
  const starting = harness.controller.start();
  await new Promise((resolve) => setTimeout(resolve, 1));
  harness.controller.cancel();
  expect(harness.controller.getSnapshot()).toEqual({ phase: "aborted" });
  gate.release?.({ stop: () => undefined, stopTracks: () => (stopTracksOnRelease += 1) });
  await starting;
  expect(stopTracksOnRelease).toBe(1);
  expect(harness.controller.getSnapshot()).toEqual({ phase: "aborted" });
});

test("oversize audio is rejected client-side without a provider request", async () => {
  const harness = createHarness();
  harness.audio = new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: "audio/webm" });
  await harness.controller.start();
  harness.controller.stopRecording();
  await waitUntil(() => harness.controller.getSnapshot().phase === "failed", "too-large state");
  expect(harness.controller.getSnapshot()).toEqual({ phase: "failed", code: "too-large", retryAfterMs: null });
  expect(harness.spies.transcribeInputs).toHaveLength(0);
  expect(harness.spies.discarded).toHaveLength(1);
});

test("recording never starts before the learner picks an action", async () => {
  const harness = createHarness();
  harness.controller.setAction(null);
  await harness.controller.start();
  expect(harness.controller.getSnapshot()).toEqual({ phase: "idle" });
  expect(harness.spies.startedMimes).toHaveLength(0);
  expect(harness.spies.transcribeInputs).toHaveLength(0);
  expect(harness.spies.translateAudioInputs).toHaveLength(0);
});

test("the transcription action uses only the transcription path", async () => {
  const harness = createHarness();
  await harness.controller.start();
  harness.controller.stopRecording();
  await waitUntil(() => harness.controller.getSnapshot().phase === "transcript", "transcript");
  expect(harness.spies.transcribeInputs).toHaveLength(1);
  expect(harness.spies.translateAudioInputs).toHaveLength(0);
  expect(harness.controller.getSnapshot()).toMatchObject({ kind: "transcription" });
});

test("the audio translation action calls the English translation path and labels the result", async () => {
  const harness = createHarness();
  harness.controller.setAction("translate-audio");
  harness.controller.setTarget("en");
  await harness.controller.start();
  harness.controller.stopRecording();
  await waitUntil(() => harness.controller.getSnapshot().phase === "transcript", "audio translation");
  expect(harness.spies.transcribeInputs).toHaveLength(0);
  expect(harness.spies.translateAudioInputs).toHaveLength(1);
  expect(harness.spies.translateAudioInputs[0]).toMatchObject({ projectId: "proj-1", target: "en" });
  expect(harness.controller.getSnapshot()).toEqual({
    phase: "transcript",
    kind: "audio-translation",
    text: "hello turn translated",
    detectedLanguage: "en",
    durationMs: null,
    turnId: "turn-1",
  });
  expect(harness.spies.discarded).toEqual([harness.audio]);
});

test("audio translation to a non-English target never records and never reaches a provider", async () => {
  const harness = createHarness();
  harness.controller.setAction("translate-audio");
  harness.controller.setTarget("es");
  await harness.controller.start();
  expect(harness.controller.getSnapshot()).toEqual({ phase: "idle" });
  expect(harness.spies.startedMimes).toHaveLength(0);
  expect(harness.spies.translateAudioInputs).toHaveLength(0);
  expect(harness.spies.transcribeInputs).toHaveLength(0);
});

test("an unsupported audio translation answer surfaces as its own visible failure", async () => {
  const harness = createHarness({
    translateAudio: async () => ({
      ok: false,
      code: "unsupported-audio-target",
      message: "Audio translation to Spanish is not supported.",
      retryAfterMs: null,
    }),
  });
  harness.controller.setAction("translate-audio");
  harness.controller.setTarget("es");
  await harness.controller.start();
  expect(harness.controller.getSnapshot()).toEqual({ phase: "idle" });
  expect(harness.spies.translateAudioInputs).toHaveLength(0);
});
