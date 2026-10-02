import {
  MAX_AUDIO_BYTES,
  MAX_RECORDING_MS,
  RECORDING_TICK_MS,
  chooseRecorderMimeType,
  classifyCaptureFailure,
  isSilentPeak,
  type TurnLanguage,
} from "./audioCapture.js";
import type { TranscribeResult } from "./transcribeClient.js";
import {
  canStartTurn,
  failureMessage,
  initialTurnState,
  reduceTurn,
  type TurnEvent,
  type TurnState,
} from "./turnState.js";

export interface CaptureSubscription {
  onAudio: (blob: Blob) => void;
  onError: (errorName: string | undefined) => void;
}

export interface CaptureRecording {
  stop: () => void;
  stopTracks: () => void;
}

export interface TurnEnvironment {
  hasCaptureSupport: () => boolean;
  isTypeSupported: (mimeType: string) => boolean;
  startMicrophone: (mimeType: string, subscription: CaptureSubscription) => Promise<CaptureRecording>;
  readPeakLevel: (audio: Blob) => Promise<number>;
  transcribe: (input: { audio: Blob; projectId: string; language: TurnLanguage; turnId: string; signal: AbortSignal }) => Promise<TranscribeResult>;
  newTurnId: () => string;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule: (handle: unknown) => void;
  /** Explicit hook proving where recorded bytes are dropped: nothing is retained. */
  discardAudio: (audio: Blob) => void;
}

export type TurnControllerOptions = { env: TurnEnvironment; projectId: string };

/**
 * Drives one microphone turn from permission request to editable
 * transcription. All browser/provider access goes through the injected
 * environment so every capture state — denial, missing device, unsupported
 * codec, silence, limits, abort — is observable and testable.
 */
export class TurnController {
  private state: TurnState = initialTurnState();
  private language: TurnLanguage = "en";
  private readonly listeners = new Set<() => void>();
  private recording: CaptureRecording | null = null;
  private tickHandle: unknown = null;
  private recordingStartedAt = 0;
  private audio: Blob | null = null;
  private inFlightAbort: AbortController | null = null;

  public constructor(private readonly options: TurnControllerOptions) {}

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getSnapshot = (): TurnState => this.state;

  public readonly getLanguage = (): TurnLanguage => this.language;

  public readonly setLanguage = (language: TurnLanguage): void => {
    this.language = language;
  };

  public readonly start = async (): Promise<void> => {
    if (!canStartTurn(this.state)) return;
    this.dispatch({ type: "START" });
    const { env } = this.options;
    if (!env.hasCaptureSupport()) {
      this.dispatch({ type: "BLOCKED", reason: "no-microphone" });
      return;
    }
    const mimeType = chooseRecorderMimeType(env.isTypeSupported);
    if (mimeType === null) {
      this.dispatch({ type: "BLOCKED", reason: "unsupported-codec" });
      return;
    }
    let active: CaptureRecording;
    try {
      active = await env.startMicrophone(mimeType, {
        onAudio: (blob) => void this.handleAudio(blob),
        onError: (errorName) => this.dispatch({ type: "BLOCKED", reason: classifyCaptureFailure(errorName) }),
      });
    } catch (error) {
      this.dispatch({ type: "BLOCKED", reason: classifyCaptureFailure((error as { name?: string } | null)?.name) });
      return;
    }
    if (this.state.phase !== "requesting-permission") {
      // Cancelled while permission was pending: release the device immediately.
      active.stop();
      active.stopTracks();
      return;
    }
    this.recording = active;
    this.recordingStartedAt = env.now();
    this.dispatch({ type: "MICROPHONE_READY" });
    this.scheduleTick();
  };

  /** User stop or the 60 s limit: hand the audio to the analysis step. */
  public readonly stopRecording = (): void => {
    if (this.state.phase !== "recording") return;
    this.cancelTick();
    this.dispatch({ type: "STOP" });
    const active = this.recording;
    this.recording = null;
    active?.stop();
    active?.stopTracks();
  };

  /** Cancels pending work at any stage and discards every held audio byte. */
  public readonly cancel = (): void => {
    this.cancelTick();
    const active = this.recording;
    this.recording = null;
    active?.stopTracks();
    active?.stop();
    this.inFlightAbort?.abort();
    this.inFlightAbort = null;
    if (this.audio !== null) {
      this.options.env.discardAudio(this.audio);
      this.audio = null;
    }
    this.dispatch({ type: "ABORT" });
  };

  public readonly editTranscript = (text: string): void => {
    this.dispatch({ type: "EDIT_TRANSCRIPT", text });
  };

  public readonly reset = (): void => {
    this.cancelTick();
    this.dispatch({ type: "RESET" });
  };

  private dispatch(event: TurnEvent): void {
    const next = reduceTurn(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /**
   * The next wake-up is clamped to the limit itself, so tick granularity can
   * never push the stop past the configured 60 s budget: the recorder stops on
   * the first tick at or beyond the limit, never later than it by one tick.
   */
  private scheduleTick(delayMs: number = RECORDING_TICK_MS): void {
    this.tickHandle = this.options.env.schedule(() => {
      this.tickHandle = null;
      if (this.state.phase !== "recording") return;
      const elapsedMs = this.options.env.now() - this.recordingStartedAt;
      this.dispatch({ type: "TICK", elapsedMs });
      if (elapsedMs >= MAX_RECORDING_MS) this.stopRecording();
      else this.scheduleTick(Math.min(RECORDING_TICK_MS, MAX_RECORDING_MS - elapsedMs));
    }, delayMs);
  }

  private cancelTick(): void {
    if (this.tickHandle !== null) {
      this.options.env.cancelSchedule(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private async handleAudio(blob: Blob): Promise<void> {
    if (this.state.phase !== "analysing") {
      this.options.env.discardAudio(blob);
      return;
    }
    this.audio = blob;
    if (blob.size > MAX_AUDIO_BYTES) {
      this.audio = null;
      this.options.env.discardAudio(blob);
      this.dispatch({ type: "AUDIO_TOO_LARGE" });
      return;
    }
    let peak: number | null = null;
    try {
      peak = await this.options.env.readPeakLevel(blob);
    } catch {
      peak = null; // undecodable audio still goes to the server, which owns the definitive silence answer
    }
    if (this.state.phase !== "analysing") {
      this.audio = null;
      this.options.env.discardAudio(blob);
      return;
    }
    if (peak !== null && isSilentPeak(peak)) {
      this.audio = null;
      this.options.env.discardAudio(blob);
      this.dispatch({ type: "LOCAL_SILENCE" });
      return;
    }
    await this.transcribeNow();
  }

  private async transcribeNow(): Promise<void> {
    const audio = this.audio;
    if (audio === null || this.state.phase !== "analysing") return;
    this.dispatch({ type: "AUDIO_READY" });
    const abort = new AbortController();
    this.inFlightAbort = abort;
    const turnId = this.options.env.newTurnId();
    let result: TranscribeResult;
    try {
      result = await this.options.env.transcribe({
        audio,
        projectId: this.options.projectId,
        language: this.language,
        turnId,
        signal: abort.signal,
      });
    } catch {
      result = { ok: false, code: "network", message: failureMessage("network", null), retryAfterMs: null };
    }
    this.inFlightAbort = null;
    if (abort.signal.aborted || this.getSnapshot().phase !== "transcribing") return; // cancel() already moved state and freed bytes
    this.audio = null;
    this.options.env.discardAudio(audio); // raw audio is discarded by default once processing ends, success or failure
    if (result.ok) {
      this.dispatch({
        type: "TRANSCRIBED",
        text: result.text,
        detectedLanguage: result.detectedLanguage,
        durationMs: result.durationMs,
        turnId: result.turnId,
      });
    } else {
      this.dispatch({ type: "TRANSCRIBE_FAILED", code: result.code, retryAfterMs: result.retryAfterMs });
    }
  }
}

export function createTurnController(options: TurnControllerOptions): TurnController {
  return new TurnController(options);
}
