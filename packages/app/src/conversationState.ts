import type { SpeechOptions } from "./data/tutor.js";
import type { PlayerState } from "./playerState.js";
import { blockedMessage, failureMessage, type TurnFailureCode, type TurnState } from "./turnState.js";
import { ttsFailureMessage, type TtsFailureCode } from "./ttsClient.js";

/**
 * S17 spoken conversation state machine.
 *
 * The v0.1 conversation is single-turn push-to-talk: `listening` →
 * `transcribing` → `generating` (retrieving + generating) → `speaking` →
 * `ready`, with one `error` state that names the stage that failed. Continuous
 * VAD, full duplex and realtime provider speech APIs are out of scope, and the
 * machine never pretends otherwise: there is no `interrupted`, no `barge-in`
 * and no second listening cycle that can open while a stage is in flight —
 * starting a new turn always cancels the current one first.
 *
 * Every transition is explicit and test-locked in `conversation-state.test.ts`:
 * events from another turn (`turnId` mismatch) or another stage are ignored,
 * so a late transcript, a late tutor answer or late audio can never move a
 * newer turn backwards.
 */

/** The five visible pipeline stages, in flow order. */
export type ConversationStage = "ready" | "listening" | "transcribing" | "generating" | "speaking";
/** Stages that own an error state; `ready` never fails. */
export type ConversationFailureStage = "listening" | "transcribing" | "generating" | "speaking";

export type ConversationTranscript = {
  turnId: string;
  text: string;
  detectedLanguage: "en" | "es";
  durationMs: number | null;
};

export type ConversationResponse = { turnId: string; text: string };

/** What the stage's Retry action re-runs: see `retryPolicy`. */
export type ConversationRetry = "record" | "regenerate" | "replay";

export type ConversationFailure = {
  stage: ConversationFailureStage;
  code: string;
  retryAfterMs: number | null;
  retry: ConversationRetry;
  message: string;
  /**
   * `true` when the server may have started (or finished) the tutor turn even
   * though the answer never arrived — a dropped connection. Retrying such a
   * failure must reuse the same `turnId`, so S14 idempotency replays the
   * stored result instead of double-sending. A `false` value means the server
   * answered with a typed failure (that turn is terminal with zero messages)
   * or the stage never reached the server, so the retry starts a fresh turn id.
   */
  ambiguous: boolean;
};

/** One entry of the bounded conversation history the server owns. */
export type ConversationHistoryMessage = {
  turnId: string;
  role: "learner" | "tutor";
  content: string;
  createdAt: number;
  citations: Array<{
    rank: number;
    documentId: string;
    chunkId: string;
    seq: number;
    contentHash: string;
    page: number | null;
    heading: string | null;
  }>;
};

export type ConversationHistoryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; messages: ConversationHistoryMessage[]; droppedCitations: number };

export type ConversationState = {
  stage: ConversationStage | "error";
  /** The stage that failed; only set while `stage === "error"`. */
  failedStage: ConversationFailureStage | null;
  /** Live S15 capture detail (permission, recording clock, transcript editing). */
  capture: TurnState;
  /** Live S16 player detail for the current response; `null` before one exists. */
  player: PlayerState | null;
  /** Id of the turn currently in flight or last completed in this machine. */
  turnId: string | null;
  transcript: ConversationTranscript | null;
  response: ConversationResponse | null;
  failure: ConversationFailure | null;
  /** Transient status line ("Turn cancelled.", "Restored from the server…"). */
  notice: string | null;
  history: ConversationHistoryState;
  /** Restored turn still generating on the server after a reconnect. */
  restorePolling: boolean;
  /** S16 speech catalog (server-configured) and the learner's chosen language. */
  speech: { options: SpeechOptions | null; language: string } | null;
};

export type ConversationEvent =
  | { type: "CAPTURE_LISTENING" }
  | { type: "CAPTURE_TRANSCRIBING" }
  | { type: "CAPTURE_TRANSCRIPT"; transcript: ConversationTranscript }
  | { type: "CAPTURE_FAILED"; stage: ConversationFailureStage; code: string; retryAfterMs: number | null }
  | { type: "CAPTURE_CANCELLED" }
  | { type: "GENERATING"; turnId: string; text: string }
  | { type: "GENERATED"; turnId: string; text: string }
  | { type: "GENERATION_FAILED"; turnId: string; code: string; retryAfterMs: number | null; ambiguous: boolean }
  | { type: "PLAYER_ACTIVE" }
  | { type: "PLAYER_FAILED"; code: string; retryAfterMs: number | null }
  | { type: "PLAYER_ENDED" }
  | { type: "PLAYER_STOPPED" }
  | { type: "PLAYER_CANCELLED" }
  | { type: "DISCARDED" }
  | { type: "CANCELLED"; notice: string | null }
  | { type: "NEW_TURN" }
  | { type: "RESTORED_TURN"; turnId: string; polling: boolean }
  | { type: "RESTORED_RESPONSE"; turnId: string; text: string }
  | { type: "HISTORY_LOADING" }
  | { type: "HISTORY_READY"; messages: ConversationHistoryMessage[]; droppedCitations: number }
  | { type: "HISTORY_ERROR" }
  | { type: "EDIT_TRANSCRIPT"; text: string }
  | { type: "SET_SPEECH"; options: SpeechOptions | null; language: string }
  | { type: "SET_CAPTURE"; capture: TurnState }
  | { type: "SET_PLAYER"; player: PlayerState | null };

export function initialConversationState(): ConversationState {
  return {
    stage: "ready",
    failedStage: null,
    capture: { phase: "idle" },
    player: null,
    turnId: null,
    transcript: null,
    response: null,
    failure: null,
    notice: null,
    history: { status: "loading" },
    restorePolling: false,
    speech: null,
  };
}

/**
 * A result only applies when it belongs to the machine's current turn. A
 * newer turn clears `turnId` first, so an answer or failure that arrives
 * late — after the learner stopped speech and started a new turn — can never
 * move the newer turn backwards.
 */
function turnMismatch(state: ConversationState, turnId: string): boolean {
  return state.turnId !== turnId;
}

function errorState(
  state: ConversationState,
  failure: ConversationFailure,
): ConversationState {
  if (state.stage === "error" && state.failure !== null && state.failure.code === failure.code && state.failure.stage === failure.stage) {
    return state;
  }
  return { ...state, stage: "error", failedStage: failure.stage, failure, notice: null, restorePolling: false };
}

/**
 * Retry contract per failed stage — the single place that decides whether a
 * retry may reuse the current `turnId`:
 *
 * - `listening` / `transcribing`: the audio is discarded with the attempt, so
 *   a retry records a new turn (no server turn ever started).
 * - `generating`: an ambiguous failure (connection dropped after the request
 *   may have started) reuses the `turnId` — S14 `beginTurn` replays a
 *   completed turn and reports the live one, so a retry can never double-send.
 *   A typed server failure is terminal with zero messages, so a fresh id
 *   starts the next attempt.
 * - `speaking`: TTS reads the already-committed answer, so a retry replays the
 *   same `turnId` (idempotent by construction).
 */
export function retryPolicy(failure: ConversationFailure): ConversationRetry {
  return failure.retry;
}

/** The action bar copy for a failure, keyed by the failed stage's code. */
export function conversationFailureMessage(stage: ConversationFailureStage, code: string, retryAfterMs: number | null): string {
  switch (stage) {
    case "listening":
      return blockedMessage(code as Parameters<typeof blockedMessage>[0]);
    case "transcribing":
      return failureMessage(code as TurnFailureCode, retryAfterMs);
    case "generating":
      return generatingFailureMessage(code, retryAfterMs);
    case "speaking":
      return code === "playback" ? "Audio playback failed in the browser. Retry." : ttsFailureMessage(code as TtsFailureCode, retryAfterMs);
  }
}

/** S14 typed turn codes reach the browser verbatim; each keeps actionable copy. */
export function generatingFailureMessage(code: string, retryAfterMs: number | null): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Your session has expired. Sign in again, then retry the turn.";
    case "NOT_FOUND":
      return "This project is no longer available. Choose another project and retry.";
    case "INVALID_ARGUMENT":
    case "TEXT_TOO_LARGE":
      return "The tutor could not accept this text. Shorten your message and retry.";
    case "TURN_NOT_CONFIGURED":
      return "The tutor is not configured on this server. Set the server-side provider key, then retry.";
    case "TURN_POLICY_BLOCKED":
      return "The tutor is only enabled for the deployer in this self-hosted build.";
    case "TURN_TIMEOUT":
      return "The tutor timed out. Retry the same turn — no duplicate answer can be created.";
    case "TURN_RATE_LIMITED": {
      const seconds = retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000);
      return seconds === null
        ? "The tutor is rate limited. Wait a moment, then retry."
        : `The tutor is rate limited. Retry in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
    }
    case "TURN_PROVIDER_ERROR":
    case "TURN_PROVIDER_MALFORMED":
    case "TURN_PROVIDER_UNSUPPORTED":
      return "The tutor service failed to answer. Retry the same turn.";
    case "TURN_ANSWER_TOO_LONG":
      return "The tutor answer exceeded the length limit. Ask a narrower question and record again.";
    case "TURN_INPUT_TOO_LARGE":
      return "Your message is longer than the tutor accepts. Shorten it and retry.";
    case "TURN_IN_PROGRESS":
      return "This turn is still running on the server. Retry to pick up its result — it will not run twice.";
    case "TURN_ATTEMPT_LOST":
      return "Another attempt took over this turn. Retry to pick up its result.";
    case "TURN_CANCELLED":
      return "This turn was cancelled before an answer was written. Record again to start a new turn.";
    case "TURN_FAILED":
      return "The tutor could not answer. Retry to start a new attempt.";
    case "network":
      return "The tutor request did not complete. Retry — the same turn id prevents a duplicate answer.";
    case "unknown":
      return "The tutor could not answer. Retry.";
    default:
      return `The tutor could not answer (${code}). Retry.`;
  }
}

/**
 * Pure transition function. Unknown or impossible events return the same
 * state reference, so a rejected event never re-renders the view and a stale
 * result from an older turn can never corrupt the current one.
 */
export function reduceConversation(state: ConversationState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case "SET_CAPTURE": {
      if (state.capture === event.capture) return state;
      return { ...state, capture: event.capture };
    }
    case "SET_PLAYER": {
      if (state.player === event.player) return state;
      return { ...state, player: event.player };
    }
    case "HISTORY_LOADING":
      return state.history.status === "loading" ? state : { ...state, history: { status: "loading" } };
    case "HISTORY_READY": {
      if (state.history.status === "ready" && state.history.messages === event.messages && state.history.droppedCitations === event.droppedCitations) {
        return state;
      }
      return {
        ...state,
        history: { status: "ready", messages: event.messages, droppedCitations: event.droppedCitations },
      };
    }
    case "HISTORY_ERROR":
      return state.history.status === "error" ? state : { ...state, history: { status: "error" } };
    case "EDIT_TRANSCRIPT":
      if (state.transcript === null || state.transcript.text === event.text) return state;
      return { ...state, transcript: { ...state.transcript, text: event.text } };
    case "SET_SPEECH":
      if (state.speech !== null && state.speech.options === event.options && state.speech.language === event.language) return state;
      return { ...state, speech: { options: event.options, language: event.language } };

    // A new capture cycle opens from any stage (starting a new turn cancels
    // the current one first) and clears the previous turn's visible results.
    case "NEW_TURN":
    case "CAPTURE_LISTENING":
      return {
        ...state,
        stage: "listening",
        failedStage: null,
        failure: null,
        notice: null,
        turnId: null,
        transcript: null,
        response: null,
        player: null,
        restorePolling: false,
      };
    case "CAPTURE_TRANSCRIBING":
      if (state.stage === "generating" || state.stage === "speaking") return state;
      if (state.stage === "transcribing" && state.failure === null && state.notice === null) return state;
      return { ...state, stage: "transcribing", failedStage: null, failure: null, notice: null };
    case "CAPTURE_TRANSCRIPT":
      if (state.stage === "generating" || state.stage === "speaking") return state;
      return {
        ...state,
        stage: "ready",
        failedStage: null,
        failure: null,
        notice: null,
        turnId: event.transcript.turnId,
        transcript: event.transcript,
        player: null,
        restorePolling: false,
      };
    case "CAPTURE_FAILED":
      if (state.stage === "generating" || state.stage === "speaking") return state;
      return errorState(state, {
        stage: event.stage,
        code: event.code,
        retryAfterMs: event.retryAfterMs,
        retry: "record",
        message: conversationFailureMessage(event.stage, event.code, event.retryAfterMs),
        ambiguous: false,
      });
    case "CAPTURE_CANCELLED":
      if (state.stage === "listening" || state.stage === "transcribing") {
        return { ...state, stage: "ready", failedStage: null, failure: null, notice: "Turn cancelled. The recording was discarded.", restorePolling: false };
      }
      return state;

    case "GENERATING": {
      // Same-id continuation (first attempt or ambiguous retry) is accepted
      // while that turn is current; a *fresh* id is only accepted from the
      // generating error state, where the terminal attempt wrote no messages.
      const resuming = turnMismatch(state, event.turnId);
      const retryingFailed = state.stage === "error" && state.failedStage === "generating";
      if (resuming && !retryingFailed) return state;
      return {
        ...state,
        stage: "generating",
        failedStage: null,
        failure: null,
        notice: null,
        turnId: event.turnId,
        response: null,
        player: null,
        restorePolling: false,
      };
    }
    case "GENERATED": {
      if (turnMismatch(state, event.turnId)) return state;
      if (state.stage !== "generating") return state;
      return {
        ...state,
        stage: "speaking",
        failedStage: null,
        failure: null,
        notice: null,
        turnId: event.turnId,
        response: { turnId: event.turnId, text: event.text },
        restorePolling: false,
      };
    }
    case "GENERATION_FAILED": {
      if (turnMismatch(state, event.turnId)) return state;
      if (state.stage !== "generating") return state;
      return errorState(state, {
        stage: "generating",
        code: event.code,
        retryAfterMs: event.retryAfterMs,
        retry: "regenerate",
        message: generatingFailureMessage(event.code, event.retryAfterMs),
        ambiguous: event.ambiguous,
      });
    }

    case "PLAYER_ACTIVE":
      if (state.stage === "generating" || state.stage === "listening" || state.stage === "transcribing") return state;
      if (state.response === null) return state;
      if (state.stage === "speaking" && state.failure === null && state.notice === null) return state;
      return { ...state, stage: "speaking", failedStage: null, failure: null, notice: null };
    case "PLAYER_FAILED":
      if (state.stage !== "speaking" && !(state.stage === "error" && state.failedStage === "speaking")) return state;
      return errorState(state, {
        stage: "speaking",
        code: event.code,
        retryAfterMs: event.retryAfterMs,
        retry: "replay",
        message: conversationFailureMessage("speaking", event.code, event.retryAfterMs),
        ambiguous: false,
      });
    case "PLAYER_ENDED":
      if (state.stage !== "speaking") return state;
      return { ...state, stage: "ready", failedStage: null, failure: null, notice: null };
    case "PLAYER_STOPPED":
      if (state.stage !== "speaking") return state;
      return { ...state, stage: "ready", failedStage: null, failure: null, notice: null };
    case "PLAYER_CANCELLED":
      if (state.stage === "speaking" || (state.stage === "error" && state.failedStage === "speaking")) {
        return { ...state, stage: "ready", failedStage: null, failure: null, response: null, player: null, notice: "Speech stopped. Any audio still arriving is discarded." };
      }
      return state;
    case "DISCARDED":
      return {
        ...state,
        stage: "ready",
        failedStage: null,
        failure: null,
        response: null,
        player: null,
        notice: null,
        restorePolling: false,
      };

    case "CANCELLED":
      if (state.stage === "ready" && state.notice === event.notice) return state;
      return {
        ...state,
        stage: "ready",
        failedStage: null,
        failure: null,
        response: null,
        player: null,
        notice: event.notice,
        restorePolling: false,
      };

    case "RESTORED_TURN":
      if (state.stage !== "ready" && state.stage !== "error") return state;
      return {
        ...state,
        stage: "generating",
        failedStage: null,
        failure: null,
        notice: null,
        turnId: event.turnId,
        response: null,
        player: null,
        restorePolling: event.polling,
      };
    case "RESTORED_RESPONSE": {
      // Only a result for the *adopted* restore turn may settle here, and a
      // live capture cycle (its own turn id) is never interrupted by it.
      if (turnMismatch(state, event.turnId)) return state;
      if (state.stage === "listening" || state.stage === "transcribing") return state;
      return {
        ...state,
        stage: "ready",
        failedStage: null,
        failure: null,
        notice: null,
        turnId: event.turnId,
        response: { turnId: event.turnId, text: event.text },
        player: null,
        restorePolling: false,
      };
    }

    default:
      return state;
  }
}

/** Ordered stage labels the tracker renders; the machine never skips one silently. */
export const CONVERSATION_STAGES: readonly ConversationStage[] = ["listening", "transcribing", "generating", "speaking", "ready"];

export type ConversationStageState = "done" | "current" | "error" | "waiting";

/**
 * Per-step tracker state. A failed conversation marks the failed stage
 * `error`, later stages `waiting`, and earlier stages `done`; `ready` is the
 * current step only when nothing failed.
 */
export function conversationStageStates(state: ConversationState): Array<{ stage: ConversationStage; state: ConversationStageState }> {
  const activeStage: ConversationStage = state.stage === "error" ? (state.failedStage ?? "listening") : state.stage;
  const activeIndex = CONVERSATION_STAGES.indexOf(activeStage);
  const failed = state.stage === "error";
  // A completed or in-flight turn proves the earlier stages ran; before the
  // first turn nothing has run yet, so those steps wait.
  const settled = state.turnId !== null || state.response !== null;
  return CONVERSATION_STAGES.map((stage, index) => {
    let step: ConversationStageState;
    if (failed) {
      if (index < activeIndex) step = "done";
      else if (index === activeIndex) step = "error";
      else step = "waiting";
    } else if (activeStage !== "ready") {
      if (index < activeIndex) step = "done";
      else if (index === activeIndex) step = "current";
      else step = "waiting";
    } else {
      step = index < activeIndex ? (settled ? "done" : "waiting") : index === activeIndex ? "current" : "waiting";
    }
    return { stage, state: step };
  });
}

/** One visible status line per state; `alert` for failures, `status` otherwise. */
export function conversationMessage(state: ConversationState): { role: "status" | "alert"; text: string } {
  if (state.stage === "error" && state.failure !== null) {
    return { role: "alert", text: state.failure.message };
  }
  switch (state.stage) {
    case "listening": {
      if (state.capture.phase === "requesting-permission") return { role: "status", text: "Listening: waiting for microphone permission…" };
      return { role: "status", text: "Listening: recording your turn. Stop when you are finished speaking." };
    }
    case "transcribing":
      return { role: "status", text: "Transcribing your turn with speech-to-text…" };
    case "generating":
      return state.restorePolling
        ? { role: "status", text: "Retrieving sources and generating the answer — this turn is still running on the server after a reconnect." }
        : { role: "status", text: "Retrieving sources and generating the tutor's answer…" };
    case "speaking":
      if (state.player !== null && state.player.phase === "loading") return { role: "status", text: "Speaking: synthesising the response audio…" };
      if (state.player !== null && state.player.phase === "autoplay-blocked") {
        return { role: "status", text: "Speaking: your browser blocked automatic playback — use Play audio below." };
      }
      return { role: "status", text: "Speaking: playing the tutor's answer." };
    case "ready":
      if (state.notice !== null) return { role: "status", text: state.notice };
      if (state.response !== null) return { role: "status", text: "Ready. The answer was spoken; the transcript and citations stay below." };
      return { role: "status", text: "Ready. Record a turn to speak with your tutor." };
    default:
      return { role: "status", text: "Ready." };
  }
}

/** Buttons the conversation action bar offers for the current state. */
export type ConversationAction =
  | { kind: "cancel-turn"; label: "Cancel turn" }
  | { kind: "retry"; label: "Retry" }
  | { kind: "discard"; label: "Discard response" }
  | { kind: "stop"; label: "Stop speaking" }
  | { kind: "new-turn"; label: "New turn" }
  | { kind: "retry-history"; label: "Try again" };

/**
 * Retry and cancel at the right points: capture stages keep the S15 panel's
 * own cancel/retry (the conversation bar stays out of the way), generating
 * gets Cancel + Retry + Discard, speaking gets Stop/New turn, and failures
 * always pair Retry with a way out (Discard).
 */
export function conversationActions(state: ConversationState): ConversationAction[] {
  if (state.stage === "error" && state.failure !== null) {
    switch (state.failure.stage) {
      case "generating":
        return [{ kind: "retry", label: "Retry" }, { kind: "discard", label: "Discard response" }];
      case "speaking":
        return [{ kind: "retry", label: "Retry" }, { kind: "discard", label: "Discard response" }];
      default:
        // The S15 capture panel already renders "Try again" for these.
        return [];
    }
  }
  switch (state.stage) {
    case "generating":
      return [{ kind: "cancel-turn", label: "Cancel turn" }, { kind: "new-turn", label: "New turn" }];
    case "speaking":
      return [{ kind: "stop", label: "Stop speaking" }, { kind: "new-turn", label: "New turn" }];
    default:
      return [];
  }
}
