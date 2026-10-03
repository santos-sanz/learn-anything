import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ConversationBackend } from "../src/data/conversation.js";
import { createConversationController } from "../src/conversationController.js";
import { RELEASE_LATENCY_BUDGET_MS, percentile, type LatencyStage } from "../src/latency.js";
import type { ResponsePlayerEnvironment } from "../src/playerController.js";
import type { TurnEnvironment } from "../src/turnController.js";
import {
  PROJECT,
  QUESTION,
  captureHarness,
  fakePlayback,
  memoryBackend,
  type FakePlayback,
} from "./helpers/voiceConversation.js";

/**
 * S17 latency budget on the documented synthetic sample
 * (`docs/spoken-conversation.md`, "Latency method and release budget"):
 *
 * 40 turns through the real conversation machine, one deterministic seeded
 * (mulberry32, seed 20261003) delay per stage drawn from fixed envelopes
 * (permission 0–50 ms, transcribe 150–900 ms, generate 400–3000 ms, speak
 * 120–1500 ms, learner speaking 800–2000 ms), driven by a fake clock so the
 * recorded stage boundaries are exactly the injected sample. The measured
 * p50/p95 must equal the sample's own percentiles (the recorder measures the
 * documented boundaries, nothing else) and must sit inside the release budget
 * the sample defined. Providers are mocked; no live call is made.
 */

const SAMPLE_SIZE = 40;
const SEED = 20_261_003;

const SAMPLE_ENVELOPES = {
  permission: [0, 50],
  listening: [800, 2_000],
  transcribe: [150, 900],
  generate: [400, 3_000],
  speak: [120, 1_500],
} as const satisfies Record<string, readonly [number, number]>;

/** Deterministic PRNG so the documented sample is byte-for-byte reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Sample = Record<keyof typeof SAMPLE_ENVELOPES, number>;

function buildSample(): Sample[] {
  const random = mulberry32(SEED);
  const draw = (range: readonly [number, number]): number => Math.round(range[0] + random() * (range[1] - range[0]));
  return Array.from({ length: SAMPLE_SIZE }, () => ({
    permission: draw(SAMPLE_ENVELOPES.permission),
    listening: draw(SAMPLE_ENVELOPES.listening),
    transcribe: draw(SAMPLE_ENVELOPES.transcribe),
    generate: draw(SAMPLE_ENVELOPES.generate),
    speak: draw(SAMPLE_ENVELOPES.speak),
  }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function latencyHarness() {
  const delays: Sample = { permission: 0, listening: 0, transcribe: 0, generate: 0, speak: 0 };
  const store = memoryBackend();
  const base = captureHarness().env;
  const capture: TurnEnvironment = {
    ...base,
    startMicrophone: async (mimeType, subscription) => {
      await sleep(delays.permission);
      return base.startMicrophone(mimeType, subscription);
    },
    transcribe: async ({ turnId }) => {
      await sleep(delays.transcribe);
      return { ok: true, text: QUESTION, detectedLanguage: "en", durationMs: 1.5, turnId };
    },
  };
  const backend: ConversationBackend = {
    ...store.backend,
    async runTurn(input) {
      await sleep(delays.generate);
      return store.backend.runTurn(input);
    },
  };
  const playbacks: FakePlayback[] = [];
  const playback: ResponsePlayerEnvironment = {
    async fetchAudio() {
      await sleep(delays.speak);
      return { ok: true, audio: new Blob([new Uint8Array([0x49, 0x44, 0x33])]), contentType: "audio/mpeg" };
    },
    async createPlayback() {
      const playback = fakePlayback();
      playbacks.push(playback);
      return playback;
    },
  };
  const controller = createConversationController({ env: { capture, conversation: backend, playback }, projectId: PROJECT });
  controller.setAction("transcribe");
  return { controller, delays, playbacks };
}

const originalFakeTimers = vi.isFakeTimers();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  if (!originalFakeTimers) vi.useRealTimers();
});

describe("the documented synthetic latency sample", () => {
  test("records exact p50/p95 per stage and stays inside the release budget", async () => {
    const sample = buildSample();
    const { controller, delays, playbacks } = latencyHarness();

    for (const turn of sample) {
      Object.assign(delays, turn);
      // Advance exactly the permission window so the recording opens (ticks
      // at 250 ms stay outside this window and cannot auto-stop the turn).
      const starting = controller.start();
      await vi.advanceTimersByTimeAsync(turn.permission);
      await starting;
      // The learner speaks for the sampled duration, then stops.
      await vi.advanceTimersByTimeAsync(turn.listening);
      controller.stopRecording();
      // Drains transcribe → generate → TTS fetch → playback start.
      await vi.runAllTimersAsync();
      expect(controller.getSnapshot().stage).toBe("speaking");
      const playback = playbacks[playbacks.length - 1];
      expect(playback).toBeDefined();
      playback.ended();
      await vi.runAllTimersAsync();
      expect(controller.getSnapshot().stage).toBe("ready");
    }

    const summary = controller.latency.summary();
    expect(summary.samples).toBe(SAMPLE_SIZE);

    const expected: Record<LatencyStage, number[]> = {
      permission: sample.map((turn) => turn.permission),
      transcribe: sample.map((turn) => turn.transcribe),
      generate: sample.map((turn) => turn.generate),
      speak: sample.map((turn) => turn.speak),
      // stop → playback started = transcribe + generate + speak on this sample.
      endToEnd: sample.map((turn) => turn.transcribe + turn.generate + turn.speak),
    };

    for (const stage of Object.keys(expected) as LatencyStage[]) {
      const measured = summary.stages[stage];
      expect(measured, `${stage} should have samples`).not.toBeNull();
      expect(measured, `${stage} p50`).toEqual({ p50: percentile(expected[stage], 50), p95: percentile(expected[stage], 95) });
      expect(measured!.p95, `${stage} p95 must stay within the release budget`).toBeLessThanOrEqual(RELEASE_LATENCY_BUDGET_MS[stage]);
    }

    // Learner speaking time is recorded but never budgeted.
    const samples = controller.latency.samples;
    expect(samples.every((entry) => entry.listeningMs !== null && entry.listeningMs >= SAMPLE_ENVELOPES.listening[0])).toBe(true);
    expect(samples.every((entry) => entry.turnMs !== null && (entry.turnMs ?? 0) >= (entry.listeningMs ?? 0))).toBe(true);

    controller.dispose();
  }, 60_000);

  test("the release budget and sample definition are the documented ones", () => {
    expect(SAMPLE_SIZE).toBe(40);
    expect(SEED).toBe(20_261_003);
    expect(SAMPLE_ENVELOPES).toEqual({
      permission: [0, 50],
      listening: [800, 2_000],
      transcribe: [150, 900],
      generate: [400, 3_000],
      speak: [120, 1_500],
    });
    expect(RELEASE_LATENCY_BUDGET_MS).toEqual({
      permission: 150,
      transcribe: 1_500,
      generate: 4_000,
      speak: 2_000,
      endToEnd: 7_000,
    });
  });

  test("percentiles use the nearest rank", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });
});
