import { describe, expect, test, vi } from "vitest";

import type { ConversationBackend } from "../src/data/conversation.js";
import {
  RESTORE_POLL_MS,
  createConversationController,
  type ConversationController,
} from "../src/conversationController.js";
import type { ResponsePlayerEnvironment } from "../src/playerController.js";
import {
  ANSWER,
  PROJECT,
  QUESTION,
  captureHarness,
  fakePlayback,
  historyMessage,
  memoryBackend,
  playbackHarness,
  type FakePlayback,
} from "./helpers/voiceConversation.js";

/**
 * S17 orchestration tests: the composed machine (S15 capture + S14 port +
 * S16 player) is driven through its stages with deterministic fakes, then
 * poked with the exact races the acceptance criteria name — late answers,
 * late audio, cancellation, idempotent retries and server restore.
 */

function harness(options: { conversation?: ConversationBackend | null; scheduleMaxMs?: number; playback?: ResponsePlayerEnvironment } = {}) {
  const capture = captureHarness(options.scheduleMaxMs === undefined ? {} : { scheduleMaxMs: options.scheduleMaxMs });
  const playback =
    options.playback === undefined
      ? playbackHarness()
      : { env: options.playback, playbacks: [] as FakePlayback[], fetchCount: 0, hold: (): void => undefined, release: (): void => undefined };
  const controller = createConversationController({
    env: {
      capture: capture.env,
      conversation: options.conversation === undefined ? null : options.conversation,
      playback: playback.env,
    },
    projectId: PROJECT,
  });
  controller.setAction("transcribe");
  return { controller, capture, playback };
}

/** Record one turn and wait until the transcript handed off to generation. */
async function recordTurn(controller: ConversationController): Promise<void> {
  await controller.start();
  controller.stopRecording();
  await vi.waitFor(() => {
    const stage = controller.getSnapshot().stage;
    expect(["generating", "speaking", "ready", "error"]).toContain(stage);
  });
}

async function finishSpeech(controller: ConversationController, playback: ReturnType<typeof playbackHarness>): Promise<void> {
  await vi.waitFor(() => expect(playback.playbacks.length).toBeGreaterThan(0));
  playback.playbacks[playback.playbacks.length - 1].ended();
  await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("ready"));
}

describe("two spoken turns run end to end without duplicate turns", () => {
  test("turn 1 and turn 2 each transcribe, generate, speak and settle on ready", async () => {
    const store = memoryBackend();
    const { controller, playback } = harness({ conversation: store.backend });

    await recordTurn(controller);
    expect(controller.getSnapshot().stage).toBe("speaking");
    expect(controller.getSnapshot().response?.text).toBe(ANSWER);
    await finishSpeech(controller, playback);
    expect(controller.getSnapshot().stage).toBe("ready");

    await recordTurn(controller);
    expect(controller.getSnapshot().stage).toBe("speaking");
    await finishSpeech(controller, playback);

    // Server truth: two distinct turns, exactly two message pairs, no dupes.
    expect(store.turnIds).toHaveLength(2);
    expect(new Set(store.turnIds).size).toBe(2);
    expect(store.messages).toHaveLength(4);
    expect(store.messages.filter((message) => message.role === "learner")).toHaveLength(2);
    expect(store.messages.filter((message) => message.role === "tutor")).toHaveLength(2);
    expect([...store.turns.keys()]).toEqual(store.turnIds);

    // Idempotent replay of turn 1 (what a duplicated request would become):
    // the stored result comes back and no message set is written twice.
    const replay = await store.backend.runTurn({ projectId: PROJECT, turnId: store.turnIds[0], text: QUESTION });
    expect(replay.ok && replay.replayed).toBe(true);
    expect(store.messages).toHaveLength(4);
    expect(store.runCalls).toHaveLength(3);

    controller.dispose();
  });

  test("the capture-only mode stops at the transcript and never calls the tutor", async () => {
    const store = memoryBackend();
    const { controller } = harness({ conversation: null });

    await controller.start();
    controller.stopRecording();
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("ready"));
    expect(controller.getSnapshot().transcript?.text).toBe(QUESTION);
    expect(store.runCalls).toHaveLength(0);
    expect(controller.getSnapshot().history.status).toBe("loading");

    controller.dispose();
  });
});

describe("turnId idempotency holds across retries", () => {
  test("an ambiguous failure retries with the SAME turn id and replays the stored answer", async () => {
    const store = memoryBackend();
    const { controller, playback } = harness({ conversation: store.backend });

    // The turn commits server-side but the response is lost on the wire.
    store.loseNextResponse();
    await recordTurn(controller);
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("error"));
    expect(controller.getSnapshot().failure).toMatchObject({ stage: "generating", code: "network", ambiguous: true });
    expect(store.turnIds).toHaveLength(1);

    controller.retry();
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("speaking"));

    // Same id twice: the second call replayed instead of creating a second turn.
    expect(store.turnIds[1]).toBe(store.turnIds[0]);
    expect(store.runCalls).toHaveLength(2);
    expect(store.messages).toHaveLength(2); // one learner + one tutor, never four
    await finishSpeech(controller, playback);
    controller.dispose();
  });

  test("a typed terminal failure retries with a FRESH turn id because nothing was written", async () => {
    const store = memoryBackend();
    const { controller, playback } = harness({ conversation: store.backend });

    store.failNextWith({ ok: false, code: "TURN_TIMEOUT", retryAfterMs: null, ambiguous: false });
    await recordTurn(controller);
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("error"));
    expect(controller.getSnapshot().failure?.ambiguous).toBe(false);

    controller.retry();
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("speaking"));

    expect(store.turnIds).toHaveLength(2);
    expect(store.turnIds[1]).not.toBe(store.turnIds[0]);
    expect(store.messages).toHaveLength(2); // the failed attempt wrote nothing
    await finishSpeech(controller, playback);
    controller.dispose();
  });
});

describe("race and cancellation guards", () => {
  test("cancelling a generating turn cancels server-side and drops the late answer", async () => {
    const store = memoryBackend();
    const { controller } = harness({ conversation: store.backend });
    store.hold();

    await recordTurn(controller);
    expect(controller.getSnapshot().stage).toBe("generating");
    const turnId = controller.getSnapshot().turnId;
    expect(turnId).not.toBeNull();

    controller.cancel();
    expect(controller.getSnapshot().stage).toBe("ready");
    expect(controller.getSnapshot().response).toBeNull();
    expect(store.cancelCalls).toEqual([turnId]);

    store.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The cancelled turn never wrote messages and the late answer is dropped.
    expect(controller.getSnapshot().stage).toBe("ready");
    expect(controller.getSnapshot().response).toBeNull();
    expect(store.messages).toHaveLength(0);
    controller.dispose();
  });

  test("a late answer after a NEW turn started is rejected (no old result over the new turn)", async () => {
    const store = memoryBackend();
    const { controller, playback } = harness({ conversation: store.backend });
    store.hold();

    await recordTurn(controller);
    expect(controller.getSnapshot().stage).toBe("generating");

    // Learner starts turn 2 while turn 1's answer is still in flight.
    await controller.start();
    expect(controller.getSnapshot().stage).toBe("listening");
    expect(store.cancelCalls).toHaveLength(1);

    store.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Turn 1's answer landed late: it must not play over turn 2.
    expect(controller.getSnapshot().stage).toBe("listening");
    expect(controller.getSnapshot().response).toBeNull();
    expect(playback.playbacks).toHaveLength(0);

    // Turn 2 completes on its own id.
    controller.stopRecording();
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("speaking"));
    expect(store.turnIds).toHaveLength(2);
    expect(store.turnIds[1]).not.toBe(store.turnIds[0]);
    expect(playback.playbacks).toHaveLength(1);
    controller.dispose();
  });

  test("late audio for the previous turn is dropped when a new turn starts", async () => {
    const store = memoryBackend();
    const { controller, playback } = harness({ conversation: store.backend });
    playback.hold();

    await recordTurn(controller);
    // Stage is speaking while the audio request is still in flight.
    expect(controller.getSnapshot().stage).toBe("speaking");
    expect(playback.fetchCount).toBe(1);

    await controller.start();
    expect(controller.getSnapshot().stage).toBe("listening");

    playback.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The bytes that arrived afterwards never reached an audio element.
    expect(playback.playbacks).toHaveLength(0);
    expect(controller.getSnapshot().stage).toBe("listening");
    controller.dispose();
  });

  test("stopping speech keeps the answer and returns to ready", async () => {
    const store = memoryBackend();
    const { controller, playback } = harness({ conversation: store.backend });

    await recordTurn(controller);
    expect(controller.getSnapshot().stage).toBe("speaking");
    controller.stopSpeaking();
    expect(controller.getSnapshot().stage).toBe("ready");
    expect(controller.getSnapshot().response?.text).toBe(ANSWER);
    expect(playback.playbacks[0].disposed()).toBe(true);
    controller.dispose();
  });

  test("discarding a speech failure clears the turn and leaves ready", async () => {
    const store = memoryBackend();
    const { controller } = harness({
      conversation: store.backend,
      playback: {
        fetchAudio: async () => ({ ok: false, code: "timeout", message: "", retryAfterMs: null, supportedVoices: null, supportedLanguages: null }),
        createPlayback: async () => fakePlayback(),
      },
    });

    await recordTurn(controller);
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("error"));
    expect(controller.getSnapshot().failedStage).toBe("speaking");
    controller.discard();
    expect(controller.getSnapshot().stage).toBe("ready");
    expect(controller.getSnapshot().response).toBeNull();
    controller.dispose();
  });
});

describe("reconnect restores state from the server", () => {
  test("a completed turn and its transcripts come back on a fresh machine", async () => {
    const store = memoryBackend();
    store.queueLatestTurn([{ turnId: "turn-7", status: "completed", createdAt: 1 }]);
    store.messages.push(historyMessage({ turnId: "turn-7", role: "learner", content: QUESTION }));
    store.messages.push(
      historyMessage({
        turnId: "turn-7",
        role: "tutor",
        content: ANSWER,
        citations: [
          { rank: 1, documentId: "doc-1", chunkId: "chunk-1", seq: 0, contentHash: "hash-1", page: 1, heading: null },
        ],
      }),
    );

    const { controller } = harness({ conversation: store.backend });
    await controller.restore();

    expect(controller.getSnapshot().stage).toBe("ready");
    expect(controller.getSnapshot().response?.turnId).toBe("turn-7");
    const snapshot = controller.getSnapshot();
    expect(snapshot.history.status).toBe("ready");
    if (snapshot.history.status !== "ready") throw new Error("history should be ready");
    expect(snapshot.history.messages).toHaveLength(2);
    expect(snapshot.history.messages[1].citations).toHaveLength(1);
    expect(controller.getSnapshot().speech?.options?.model).toBe("kokoro");
    controller.dispose();
  });

  test("a still-running turn restores into generating, polls and then speaks", async () => {
    const store = memoryBackend();
    // The turn keeps reporting `running` until the test flips it, so the
    // restored stage is observable before the answer arrives.
    store.queueLatestTurn([{ turnId: "turn-8", status: "running", createdAt: 1 }], { turnId: "turn-8", status: "running", createdAt: 1 });
    store.messages.push(historyMessage({ turnId: "turn-8", role: "learner", content: QUESTION }));
    store.messages.push(historyMessage({ turnId: "turn-8", role: "tutor", content: ANSWER }));

    const { controller } = harness({ conversation: store.backend, scheduleMaxMs: 5 });
    void controller.restore();
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("generating"));
    expect(controller.getSnapshot().restorePolling).toBe(true);

    store.setLatestTurnFallback({ turnId: "turn-8", status: "completed", createdAt: 1 });
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("speaking"), { timeout: 3_000 });
    expect(controller.getSnapshot().response?.text).toBe(ANSWER);
    expect(controller.getSnapshot().restorePolling).toBe(false);
    controller.dispose();
  });

  test("a failed turn restores its typed failure with a retry available", async () => {
    const store = memoryBackend();
    store.turns.set("turn-9", { status: "failed", text: "", failureCode: "TURN_NOT_CONFIGURED" });
    store.queueLatestTurn([{ turnId: "turn-9", status: "failed", createdAt: 1 }]);

    const { controller } = harness({ conversation: store.backend });
    await controller.restore();

    expect(controller.getSnapshot().stage).toBe("error");
    expect(controller.getSnapshot().failure).toMatchObject({ stage: "generating", code: "TURN_NOT_CONFIGURED" });
    controller.dispose();
  });

  test("history load failures surface and recover without losing the stage", async () => {
    const store = memoryBackend();
    store.breakTranscripts();
    const { controller } = harness({ conversation: store.backend });
    await controller.restore();
    await vi.waitFor(() => expect(controller.getSnapshot().history.status).toBe("error"));

    store.fixTranscripts();
    controller.retryHistory();
    await vi.waitFor(() => expect(controller.getSnapshot().history.status).toBe("ready"));
    controller.dispose();
  });

  test("starting a new turn stops the restore poll from touching it", async () => {
    const store = memoryBackend();
    store.queueLatestTurn([{ turnId: "turn-10", status: "running", createdAt: 1 }], { turnId: "turn-10", status: "running", createdAt: 1 });
    const { controller } = harness({ conversation: store.backend, scheduleMaxMs: 1 });
    void controller.restore();
    await vi.waitFor(() => expect(controller.getSnapshot().stage).toBe("generating"));

    await controller.start();
    expect(controller.getSnapshot().stage).toBe("listening");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.getSnapshot().stage).toBe("listening");
    controller.dispose();
  });
});

describe("stage latency is recorded on the machine's own boundaries", () => {
  test("a completed turn records permission, transcribe, generate, speak and end-to-end", async () => {
    const store = memoryBackend();
    const { controller, playback } = harness({ conversation: store.backend });

    await recordTurn(controller);
    await finishSpeech(controller, playback);

    const summary = controller.latency.summary();
    expect(summary.samples).toBe(1);
    expect(summary.stages.permission).not.toBeNull();
    expect(summary.stages.transcribe).not.toBeNull();
    expect(summary.stages.generate).not.toBeNull();
    expect(summary.stages.speak).not.toBeNull();
    expect(summary.stages.endToEnd).not.toBeNull();
    expect(summary.stages.endToEnd!.p50).toBeGreaterThanOrEqual(0);
    controller.dispose();
  });
});

// The controller's poll cadence is part of the documented contract.
test("the restore poll cadence stays within the documented bounds", () => {
  expect(RESTORE_POLL_MS).toBe(1_000);
});
