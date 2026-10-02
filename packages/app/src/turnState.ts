import {
  MAX_RECORDING_MS,
  MAX_RECORDING_SECONDS,
  type CaptureBlockReason,
  type TurnLanguage,
} from "./audioCapture.js";

export type TurnFailureCode =
  | "silence"
  | "timeout"
  | "rate-limited"
  | "provider-unavailable"
  | "not-configured"
  | "too-large"
  | "unsupported-codec"
  | "unauthenticated"
  | "not-found"
  | "provider-policy"
  | "invalid-request"
  | "network"
  | "unknown";

export type TurnState =
  | { phase: "idle" }
  | { phase: "requesting-permission" }
  | { phase: "recording"; elapsedMs: number; limitMs: number }
  | { phase: "analysing" }
  | { phase: "transcribing" }
  | { phase: "transcript"; text: string; detectedLanguage: TurnLanguage; durationMs: number | null; turnId: string }
  | { phase: "blocked"; reason: CaptureBlockReason }
  | { phase: "silence" }
  | { phase: "failed"; code: TurnFailureCode; retryAfterMs: number | null }
  | { phase: "aborted" };

export type TurnEvent =
  | { type: "START" }
  | { type: "MICROPHONE_READY" }
  | { type: "BLOCKED"; reason: CaptureBlockReason }
  | { type: "TICK"; elapsedMs: number }
  | { type: "STOP" }
  | { type: "LOCAL_SILENCE" }
  | { type: "AUDIO_TOO_LARGE" }
  | { type: "AUDIO_READY" }
  | { type: "TRANSCRIBED"; text: string; detectedLanguage: TurnLanguage; durationMs: number | null; turnId: string }
  | { type: "TRANSCRIBE_FAILED"; code: TurnFailureCode; retryAfterMs: number | null }
  | { type: "ABORT" }
  | { type: "EDIT_TRANSCRIPT"; text: string }
  | { type: "RESET" };

const STARTABLE_PHASES: readonly TurnState["phase"][] = ["idle", "blocked", "silence", "failed", "aborted", "transcript"];
const INTERRUPTIBLE_PHASES: readonly TurnState["phase"][] = ["requesting-permission", "recording", "analysing", "transcribing"];

export function initialTurnState(): TurnState {
  return { phase: "idle" };
}

export function canStartTurn(state: TurnState): boolean {
  return STARTABLE_PHASES.includes(state.phase);
}

export function reduceTurn(state: TurnState, event: TurnEvent): TurnState {
  switch (event.type) {
    case "START":
      return canStartTurn(state) ? { phase: "requesting-permission" } : state;
    case "MICROPHONE_READY":
      return state.phase === "requesting-permission" ? { phase: "recording", elapsedMs: 0, limitMs: MAX_RECORDING_MS } : state;
    case "BLOCKED":
      return state.phase === "requesting-permission" || state.phase === "recording"
        ? { phase: "blocked", reason: event.reason }
        : state;
    case "TICK":
      return state.phase === "recording"
        ? { ...state, elapsedMs: Math.min(Math.max(0, event.elapsedMs), state.limitMs) }
        : state;
    case "STOP":
      return state.phase === "recording" ? { phase: "analysing" } : state;
    case "LOCAL_SILENCE":
      return state.phase === "analysing" ? { phase: "silence" } : state;
    case "AUDIO_TOO_LARGE":
      return state.phase === "analysing" ? { phase: "failed", code: "too-large", retryAfterMs: null } : state;
    case "AUDIO_READY":
      return state.phase === "analysing" ? { phase: "transcribing" } : state;
    case "TRANSCRIBED":
      return state.phase === "transcribing"
        ? {
            phase: "transcript",
            text: event.text,
            detectedLanguage: event.detectedLanguage,
            durationMs: event.durationMs,
            turnId: event.turnId,
          }
        : state;
    case "TRANSCRIBE_FAILED":
      if (state.phase !== "transcribing") return state;
      return event.code === "silence"
        ? { phase: "silence" }
        : { phase: "failed", code: event.code, retryAfterMs: event.retryAfterMs };
    case "ABORT":
      return INTERRUPTIBLE_PHASES.includes(state.phase) ? { phase: "aborted" } : state;
    case "EDIT_TRANSCRIPT":
      return state.phase === "transcript" ? { ...state, text: event.text } : state;
    case "RESET":
      return initialTurnState();
    default:
      return state;
  }
}

export function blockedMessage(reason: CaptureBlockReason): string {
  switch (reason) {
    case "permission-denied":
      return "Microphone permission was denied. Allow microphone access for this site in your browser settings, then try again.";
    case "no-microphone":
      return "No microphone is available. Connect or enable a microphone, then try again.";
    case "unsupported-codec":
      return "This browser cannot record a supported compressed audio format. Try an up-to-date browser with microphone support.";
  }
}

export function failureMessage(code: TurnFailureCode, retryAfterMs: number | null): string {
  switch (code) {
    case "too-large":
      return "The recording is larger than the turn limit. Record a shorter turn and try again.";
    case "unsupported-codec":
      return "The recording format is not supported. Try an up-to-date browser with microphone support.";
    case "unauthenticated":
      return "Your session has expired. Sign in again, then retry the turn.";
    case "not-found":
      return "This project is no longer available. Choose another project and retry.";
    case "provider-policy":
      return "Speech transcription is only enabled for the deployer in this self-hosted build.";
    case "not-configured":
      return "Speech transcription is not configured on this server. Set the server-side provider key, then retry.";
    case "invalid-request":
      return "The transcription request was rejected. Try recording the turn again.";
    case "timeout":
      return "Transcription timed out. Check your connection and try again.";
    case "rate-limited": {
      const seconds = retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000);
      return seconds === null
        ? "The transcription service is rate limited. Wait a moment, then try again."
        : `The transcription service is rate limited. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
    }
    case "provider-unavailable":
      return "The transcription service did not respond in time. Try again shortly.";
    case "network":
      return "The turn could not be sent. Check your connection and try again.";
    case "silence":
      return "No speech was detected in the recording. Check your microphone and record again.";
    case "unknown":
      return "Transcription failed. Try again.";
  }
}

export const IDLE_HINT = `Record a turn of up to ${MAX_RECORDING_SECONDS} seconds. Raw audio is discarded after transcription.`;
export const ABORTED_MESSAGE = "Turn cancelled. The pending request was stopped and the recording was discarded.";
