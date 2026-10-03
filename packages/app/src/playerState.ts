import { ttsFailureMessage, type TtsFailureCode } from "./ttsClient.js";

/**
 * Pure player state for one tutor response. The transcript is not part of this
 * state on purpose: it is rendered by the view in every phase, so a playback
 * failure, a blocked autoplay or a cancellation can never blank the text.
 */
export type PlayerPhase = "idle" | "loading" | "playing" | "paused" | "autoplay-blocked" | "failed" | "cancelled" | "ended";

/** `playback` is the browser element failing; everything else is a typed route failure. */
export type PlayerFailureCode = TtsFailureCode | "playback";

export type PlayerFailure = { code: PlayerFailureCode; retryAfterMs: number | null };

export type PlayerState = {
  phase: PlayerPhase;
  failure: PlayerFailure | null;
};

export type PlayerEvent =
  | { type: "REQUEST" }
  | { type: "PLAYING" }
  | { type: "PAUSED" }
  | { type: "AUTOPLAY_BLOCKED" }
  | { type: "FAILED"; code: PlayerFailureCode; retryAfterMs: number | null }
  | { type: "ENDED" }
  | { type: "STOP" }
  | { type: "CANCEL" }
  | { type: "RESET" };

export function initialPlayerState(): PlayerState {
  return { phase: "idle", failure: null };
}

/** Phases from which a fresh attempt (play or retry) is allowed to start. */
const STARTABLE: readonly PlayerPhase[] = ["idle", "autoplay-blocked", "failed", "cancelled", "ended", "paused"];

export function canStartPlayback(state: PlayerState): boolean {
  return STARTABLE.includes(state.phase);
}

export function reducePlayer(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (event.type) {
    case "REQUEST":
      return canStartPlayback(state) ? { phase: "loading", failure: null } : state;
    case "PLAYING":
      return state.phase === "loading" || state.phase === "paused" ? { phase: "playing", failure: null } : state;
    case "PAUSED":
      return state.phase === "playing" ? { phase: "paused", failure: null } : state;
    case "AUTOPLAY_BLOCKED":
      return state.phase === "loading" ? { phase: "autoplay-blocked", failure: null } : state;
    case "FAILED":
      // A failure only lands while an attempt is in flight; a cancel or a
      // stop that came first wins, so late errors cannot resurrect the state.
      return state.phase === "loading" ||
        state.phase === "playing" ||
        state.phase === "paused" ||
        state.phase === "autoplay-blocked"
        ? { phase: "failed", failure: { code: event.code, retryAfterMs: event.retryAfterMs } }
        : state;
    case "ENDED":
      return state.phase === "playing" ? { phase: "ended", failure: null } : state;
    case "STOP":
      return state.phase === "loading" ||
        state.phase === "playing" ||
        state.phase === "paused" ||
        state.phase === "autoplay-blocked" ||
        state.phase === "ended"
        ? initialPlayerState()
        : state;
    case "CANCEL":
      return state.phase === "cancelled" ? state : { phase: "cancelled", failure: null };
    case "RESET":
      return initialPlayerState();
    default:
      return state;
  }
}

/** One status line per phase: `alert` for failures, `status` otherwise. */
export function playerMessage(state: PlayerState): { role: "status" | "alert"; text: string } {
  switch (state.phase) {
    case "idle":
      return { role: "status", text: "Ready to play this response." };
    case "loading":
      return { role: "status", text: "Loading audio…" };
    case "playing":
      return { role: "status", text: "Playing." };
    case "paused":
      return { role: "status", text: "Paused." };
    case "autoplay-blocked":
      return {
        role: "alert",
        text: "Automatic playback was blocked by your browser. Use the Play audio button to start — that click is the user gesture the browser requires.",
      };
    case "failed": {
      const failure = state.failure;
      if (failure === null) return { role: "alert", text: "Audio playback failed. Retry." };
      const text =
        failure.code === "playback" ? "Audio playback failed in the browser. Retry." : ttsFailureMessage(failure.code, failure.retryAfterMs);
      return { role: "alert", text };
    }
    case "cancelled":
      return { role: "status", text: "Turn cancelled. Playback stopped and any audio still arriving is discarded." };
    case "ended":
      return { role: "status", text: "Finished." };
  }
}
