import { describe, expect, test } from "vitest";

import {
  CONVERSATION_STAGES,
  conversationActions,
  conversationFailureMessage,
  conversationMessage,
  conversationStageStates,
  generatingFailureMessage,
  initialConversationState,
  reduceConversation,
  type ConversationEvent,
  type ConversationState,
} from "../src/conversationState.js";

const transcript = (turnId: string, text = "what is photosynthesis") => ({
  turnId,
  text,
  detectedLanguage: "en" as const,
  durationMs: 1.2,
});

function apply(state: ConversationState, ...events: ConversationEvent[]): ConversationState {
  return events.reduce(reduceConversation, state);
}

/** Walks the happy path up to the requested stage; the machine's spine. */
function toStage(stage: ConversationState["stage"], turnId = "turn-1"): ConversationState {
  let state = apply(initialConversationState(), { type: "CAPTURE_LISTENING" });
  if (stage === "listening") return state;
  state = apply(state, { type: "CAPTURE_TRANSCRIBING" });
  if (stage === "transcribing") return state;
  state = apply(state, { type: "CAPTURE_TRANSCRIPT", transcript: transcript(turnId) });
  if (stage === "ready") return state;
  state = apply(state, { type: "GENERATING", turnId, text: transcript(turnId).text });
  if (stage === "generating") return state;
  state = apply(state, { type: "GENERATED", turnId, text: "Plants turn light into chemical energy [1]." });
  if (stage === "speaking") return state;
  return apply(state, { type: "PLAYER_ENDED" });
}

describe("the stage machine walks listening → transcribing → generating → speaking → ready", () => {
  test("every stage transition lands in order with the turn's data", () => {
    const listening = toStage("listening");
    expect(listening.stage).toBe("listening");
    expect(listening.turnId).toBeNull();

    const transcribing = apply(listening, { type: "CAPTURE_TRANSCRIBING" });
    expect(transcribing.stage).toBe("transcribing");

    const ready = apply(transcribing, { type: "CAPTURE_TRANSCRIPT", transcript: transcript("turn-1") });
    expect(ready.stage).toBe("ready");
    expect(ready.turnId).toBe("turn-1");
    expect(ready.transcript?.text).toBe("what is photosynthesis");

    const generating = apply(ready, { type: "GENERATING", turnId: "turn-1", text: "what is photosynthesis" });
    expect(generating.stage).toBe("generating");

    const speaking = apply(generating, { type: "GENERATED", turnId: "turn-1", text: "answer" });
    expect(speaking.stage).toBe("speaking");
    expect(speaking.response).toEqual({ turnId: "turn-1", text: "answer" });

    const done = apply(speaking, { type: "PLAYER_ENDED" });
    expect(done.stage).toBe("ready");
    // The finished turn's transcript and answer stay visible after `ready`.
    expect(done.transcript?.turnId).toBe("turn-1");
    expect(done.response?.text).toBe("answer");
  });

  test("the five labels are exactly the S17 contract", () => {
    expect(CONVERSATION_STAGES).toEqual(["listening", "transcribing", "generating", "speaking", "ready"]);
  });

  test("starting a new turn clears the previous turn's visible results and history survives", () => {
    const state = apply(toStage("speaking"), { type: "HISTORY_READY", messages: [{ turnId: "turn-0", role: "tutor", content: "old", createdAt: 1, citations: [] }], droppedCitations: 0 }, { type: "CAPTURE_LISTENING" });
    expect(state.stage).toBe("listening");
    expect(state.turnId).toBeNull();
    expect(state.transcript).toBeNull();
    expect(state.response).toBeNull();
    // Acceptance: transcripts/citations stay available while listening.
    expect(state.history).toEqual({ status: "ready", messages: [{ turnId: "turn-0", role: "tutor", content: "old", createdAt: 1, citations: [] }], droppedCitations: 0 });
  });
});

describe("every stage and error is visible with retry/cancel at the right points", () => {
  test("capture failures name their stage and retry by recording again", () => {
    const blocked = apply(
      apply(initialConversationState(), { type: "CAPTURE_LISTENING" }),
      { type: "CAPTURE_FAILED", stage: "listening", code: "permission-denied", retryAfterMs: null },
    );
    expect(blocked.stage).toBe("error");
    expect(blocked.failedStage).toBe("listening");
    expect(blocked.failure?.retry).toBe("record");
    expect(blocked.failure?.message).toContain("permission was denied");
    // The S15 panel renders its own Try again for capture stages.
    expect(conversationActions(blocked)).toEqual([]);

    const transcribeFailure = apply(
      apply(apply(initialConversationState(), { type: "CAPTURE_LISTENING" }), { type: "CAPTURE_TRANSCRIBING" }),
      { type: "CAPTURE_FAILED", stage: "transcribing", code: "rate-limited", retryAfterMs: 30_000 },
    );
    expect(transcribeFailure.failedStage).toBe("transcribing");
    expect(transcribeFailure.failure?.message).toContain("30 seconds");
  });

  test("a generating failure offers Retry (idempotent) plus a way out", () => {
    const state = apply(toStage("generating"), {
      type: "GENERATION_FAILED",
      turnId: "turn-1",
      code: "TURN_TIMEOUT",
      retryAfterMs: null,
      ambiguous: false,
    });
    expect(state.stage).toBe("error");
    expect(state.failedStage).toBe("generating");
    expect(state.failure?.retry).toBe("regenerate");
    expect(state.failure?.ambiguous).toBe(false);
    expect(state.failure?.message).toContain("starts a new turn");
    expect(conversationActions(state).map((action) => action.kind)).toEqual(["retry", "discard"]);
  });

  test("a dropped-connection failure is marked ambiguous so the retry reuses the turn id", () => {
    const state = apply(toStage("generating"), {
      type: "GENERATION_FAILED",
      turnId: "turn-1",
      code: "network",
      retryAfterMs: null,
      ambiguous: true,
    });
    expect(state.failure?.ambiguous).toBe(true);
    expect(state.failure?.message).toContain("same turn id");
    expect(conversationActions(state).map((action) => action.kind)).toEqual(["retry", "discard"]);
  });

  test("a speech failure keeps the transcript and offers Replay + Discard", () => {
    const state = apply(toStage("speaking"), { type: "PLAYER_FAILED", code: "rate-limited", retryAfterMs: null });
    expect(state.stage).toBe("error");
    expect(state.failedStage).toBe("speaking");
    expect(state.failure?.retry).toBe("replay");
    expect(state.response).not.toBeNull();
    expect(conversationActions(state).map((action) => action.kind)).toEqual(["retry", "discard"]);
  });

  test("in-flight stages expose exactly their cancel/new-turn controls", () => {
    expect(conversationActions(toStage("generating")).map((action) => action.kind)).toEqual(["cancel-turn", "new-turn"]);
    expect(conversationActions(toStage("speaking")).map((action) => action.kind)).toEqual(["stop", "new-turn"]);
    expect(conversationActions(toStage("ready"))).toEqual([]);
    expect(conversationActions(toStage("listening"))).toEqual([]);
    expect(conversationActions(toStage("transcribing"))).toEqual([]);
  });

  test("the status line reports role=alert for failures and role=status otherwise", () => {
    expect(conversationMessage(toStage("generating")).role).toBe("status");
    const failed = apply(toStage("generating"), { type: "GENERATION_FAILED", turnId: "turn-1", code: "TURN_NOT_CONFIGURED", retryAfterMs: null, ambiguous: false });
    expect(conversationMessage(failed)).toEqual({ role: "alert", text: generatingFailureMessage("TURN_NOT_CONFIGURED", null) });
    expect(conversationMessage(failed).text).toContain("provider key");
  });

  test("the tracker marks earlier steps done, the failed step failed and later steps waiting", () => {
    const steps = conversationStageStates(apply(toStage("generating"), { type: "GENERATION_FAILED", turnId: "turn-1", code: "TURN_FAILED", retryAfterMs: null, ambiguous: false }));
    expect(steps).toEqual([
      { stage: "listening", state: "done" },
      { stage: "transcribing", state: "done" },
      { stage: "generating", state: "error" },
      { stage: "speaking", state: "waiting" },
      { stage: "ready", state: "waiting" },
    ]);

    const happy = conversationStageStates(toStage("speaking"));
    expect(happy.map((step) => step.state)).toEqual(["done", "done", "done", "current", "waiting"]);
    const resting = conversationStageStates(initialConversationState());
    expect(resting.map((step) => step.state)).toEqual(["waiting", "waiting", "waiting", "waiting", "current"]);
    const afterTurn = conversationStageStates(toStage("ready"));
    expect(afterTurn.map((step) => step.state)).toEqual(["done", "done", "done", "done", "current"]);
  });

  test("conversationFailureMessage covers the typed S14 codes the port can return", () => {
    expect(conversationFailureMessage("generating", "TURN_IN_PROGRESS", null)).toContain("will not run twice");
    expect(conversationFailureMessage("generating", "TURN_RATE_LIMITED", 5_000)).toContain("5 seconds");
    expect(conversationFailureMessage("speaking", "playback", null)).toContain("Retry");
    expect(conversationFailureMessage("speaking", "not-configured", null)).toContain("not configured");
    expect(conversationFailureMessage("listening", "no-microphone", null)).toContain("No microphone");
  });
});

describe("late results from an older turn are rejected", () => {
  test("an answer for a cleared turn cannot move a newer turn", () => {
    const listening = apply(toStage("generating"), { type: "CAPTURE_LISTENING" });
    const late = apply(listening, { type: "GENERATED", turnId: "turn-1", text: "stale answer" });
    expect(late).toBe(listening);
    const lateFailure = apply(listening, { type: "GENERATION_FAILED", turnId: "turn-1", code: "network", retryAfterMs: null, ambiguous: true });
    expect(lateFailure).toBe(listening);
  });

  test("an answer for a different turn id is ignored even mid-flight", () => {
    const generating = toStage("generating", "turn-2");
    expect(apply(generating, { type: "GENERATED", turnId: "turn-1", text: "stale" })).toBe(generating);
    expect(apply(generating, { type: "GENERATION_FAILED", turnId: "turn-1", code: "network", retryAfterMs: null, ambiguous: true })).toBe(generating);
  });

  test("a fresh turn id is only accepted from the generating error state", () => {
    const generating = toStage("generating", "turn-1");
    const retryIdRejected = apply(generating, { type: "GENERATING", turnId: "turn-2", text: "q" });
    expect(retryIdRejected).toBe(generating);

    const failed = apply(generating, { type: "GENERATION_FAILED", turnId: "turn-1", code: "TURN_TIMEOUT", retryAfterMs: null, ambiguous: false });
    const freshRetry = apply(failed, { type: "GENERATING", turnId: "turn-2", text: "q" });
    expect(freshRetry.stage).toBe("generating");
    expect(freshRetry.turnId).toBe("turn-2");
    expect(freshRetry.failure).toBeNull();
  });

  test("capture events cannot yank an in-flight generation back", () => {
    const generating = toStage("generating");
    expect(apply(generating, { type: "CAPTURE_TRANSCRIBING" })).toBe(generating);
    expect(apply(generating, { type: "CAPTURE_TRANSCRIPT", transcript: transcript("turn-9") })).toBe(generating);
    expect(apply(generating, { type: "CAPTURE_FAILED", stage: "transcribing", code: "timeout", retryAfterMs: null })).toBe(generating);
  });

  test("stopping speech keeps the answer; discarding it clears both turn data", () => {
    const stopped = apply(toStage("speaking"), { type: "PLAYER_STOPPED" });
    expect(stopped.stage).toBe("ready");
    expect(stopped.response).not.toBeNull();

    const cancelled = apply(toStage("speaking"), { type: "PLAYER_CANCELLED" });
    expect(cancelled.stage).toBe("ready");
    expect(cancelled.response).toBeNull();

    const discarded = apply(toStage("speaking"), { type: "DISCARDED" });
    expect(discarded.stage).toBe("ready");
    expect(discarded.response).toBeNull();
    expect(discarded.transcript).not.toBeNull();
  });

  test("events that change nothing return the same reference (no re-render)", () => {
    const speaking = toStage("speaking");
    expect(reduceConversation(speaking, { type: "PLAYER_ACTIVE" })).toBe(speaking);
    expect(reduceConversation(speaking, { type: "CAPTURE_TRANSCRIBING" })).toBe(speaking);
    const historyLoaded = apply(initialConversationState(), { type: "HISTORY_READY", messages: [], droppedCitations: 0 });
    if (historyLoaded.history.status !== "ready") throw new Error("history should be ready");
    expect(reduceConversation(historyLoaded, { type: "HISTORY_READY", messages: historyLoaded.history.messages, droppedCitations: 0 })).toBe(historyLoaded);
  });
});

describe("restore events rebuild the machine from server state", () => {
  test("a running turn restores into generating with polling, then settles", () => {
    const restored = apply(initialConversationState(), { type: "RESTORED_TURN", turnId: "turn-7", polling: true });
    expect(restored.stage).toBe("generating");
    expect(restored.restorePolling).toBe(true);

    const completed = apply(restored, { type: "GENERATED", turnId: "turn-7", text: "answer" });
    expect(completed.stage).toBe("speaking");
    expect(completed.restorePolling).toBe(false);
  });

  test("a completed turn restores its answer into ready without replaying a stage", () => {
    const adopted = apply(initialConversationState(), { type: "RESTORED_TURN", turnId: "turn-7", polling: false });
    expect(adopted.stage).toBe("generating");
    const state = apply(adopted, { type: "RESTORED_RESPONSE", turnId: "turn-7", text: "answer" });
    expect(state.stage).toBe("ready");
    expect(state.response).toEqual({ turnId: "turn-7", text: "answer" });
  });

  test("a cancelled turn restores a visible notice and no answer", () => {
    const state = apply(initialConversationState(), { type: "CANCELLED", notice: "The previous turn was cancelled before an answer was written." });
    expect(state.stage).toBe("ready");
    expect(state.notice).toContain("cancelled");
    expect(conversationMessage(state).text).toContain("cancelled");
  });

  test("history failures expose an alert-free retry state", () => {
    const failed = apply(initialConversationState(), { type: "HISTORY_ERROR" });
    expect(failed.history.status).toBe("error");
    const retried = apply(failed, { type: "HISTORY_LOADING" });
    expect(retried.history.status).toBe("loading");
  });
});
