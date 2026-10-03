import {
  canStartPlayback,
  initialPlayerState,
  reducePlayer,
  type PlayerEvent,
  type PlayerState,
} from "./playerState.js";
import type { TtsResult } from "./ttsClient.js";

/** Browser audio element wrapper; the tests inject a deterministic fake. */
export interface PlayerPlayback {
  play(): Promise<void>;
  pause(): void;
  dispose(): void;
  onEnded: (() => void) | null;
  onError: (() => void) | null;
}

export type PlayerAudioRequest = {
  projectId: string;
  turnId: string;
  language: string;
  voice: string | null;
  signal: AbortSignal;
};

export interface ResponsePlayerEnvironment {
  fetchAudio(request: PlayerAudioRequest): Promise<TtsResult>;
  createPlayback(audio: Blob): Promise<PlayerPlayback>;
}

export type ResponsePlayerOptions = {
  env: ResponsePlayerEnvironment;
  projectId: string;
  turnId: string;
  language: string;
  voice?: string | null;
};

/** Safari/Chrome reject a blocked `play()` with `NotAllowedError`; anything else is a playback fault. */
function isPermissionError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NotAllowedError";
}

/**
 * Drives one tutor response's audio: fetch through the authenticated route,
 * play/pause/stop, autoplay-blocked handling and cancellation.
 *
 * A monotonically increasing generation token is the staleness guard: every
 * `cancel()` (the S14 turn-cancellation hook), `stop()` that aborts an
 * in-flight fetch, and language change bumps it, and any continuation that
 * observes an old generation is dropped — bytes that arrive after a
 * cancellation are never handed to the audio element and never rewritten into
 * the state, so a late response cannot play or corrupt anything.
 */
export class ResponsePlayerController {
  private state: PlayerState = initialPlayerState();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private attempt: AbortController | null = null;
  private playback: PlayerPlayback | null = null;
  private cache: { language: string; voice: string | null; audio: Blob } | null = null;
  private language: string;
  private voice: string | null;

  public constructor(private readonly options: ResponsePlayerOptions) {
    this.language = options.language;
    this.voice = options.voice ?? null;
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getSnapshot = (): PlayerState => this.state;

  /** Attempt without a guaranteed user gesture (a new response arrived). */
  public readonly autoStart = async (): Promise<void> => {
    if (this.state.phase !== "idle") return;
    await this.start();
  };

  /** Playback from an explicit user gesture: Play audio / Retry buttons. */
  public readonly play = async (): Promise<void> => {
    await this.start();
  };

  public readonly retry = async (): Promise<void> => {
    await this.start();
  };

  public readonly pause = (): void => {
    if (this.state.phase !== "playing" || this.playback === null) return;
    this.playback.pause();
    this.dispatch({ type: "PAUSED" });
  };

  public readonly resume = async (): Promise<void> => {
    if (this.state.phase !== "paused" || this.playback === null) return;
    await this.attemptPlay(this.playback, this.generation);
  };

  /**
   * Stop playback. Stopping while the audio is still loading also aborts that
   * request, so bytes that arrive afterwards are discarded by the generation
   * guard instead of starting to play on their own.
   */
  public readonly stop = (): void => {
    if (this.state.phase === "loading") {
      this.generation += 1;
      this.abortAttempt();
    }
    this.disposePlayback();
    this.dispatch({ type: "STOP" });
  };

  /**
   * The S14 cancellation hook: stops playback now, aborts in-flight synthesis
   * and invalidates any audio still on its way, so a response that arrives
   * after the cancel is dropped rather than played.
   */
  public readonly cancel = (): void => {
    this.generation += 1;
    this.abortAttempt();
    this.disposePlayback();
    this.cache = null;
    this.dispatch({ type: "CANCEL" });
  };

  /** Switching language/voice discards the cached bytes and any in-flight request. */
  public readonly setLanguage = (language: string, voice: string | null): void => {
    if (language === this.language && voice === this.voice) return;
    this.language = language;
    this.voice = voice;
    this.generation += 1;
    this.abortAttempt();
    this.disposePlayback();
    this.cache = null;
    this.dispatch({ type: "RESET" });
  };

  /** Unmount: release the audio element without touching visible state. */
  public readonly dispose = (): void => {
    this.generation += 1;
    this.abortAttempt();
    this.disposePlayback();
    this.listeners.clear();
  };

  private async start(): Promise<void> {
    if (this.state.phase === "loading" || this.state.phase === "playing") return;
    if (this.state.phase === "paused" && this.playback !== null) {
      await this.attemptPlay(this.playback, this.generation);
      return;
    }
    if (!canStartPlayback(this.state)) return;

    const generation = ++this.generation;
    this.abortAttempt();
    const abort = new AbortController();
    this.attempt = abort;
    this.dispatch({ type: "REQUEST" });

    let stage: "fetch" | "playback" = "fetch";
    try {
      let audio = this.cache !== null && this.cache.language === this.language && this.cache.voice === this.voice ? this.cache.audio : null;
      if (audio === null) {
        const result = await this.options.env.fetchAudio({
          projectId: this.options.projectId,
          turnId: this.options.turnId,
          language: this.language,
          voice: this.voice,
          signal: abort.signal,
        });
        if (generation !== this.generation) return; // cancelled or superseded: drop the bytes
        if (!result.ok) {
          this.dispatch({ type: "FAILED", code: result.code, retryAfterMs: result.retryAfterMs });
          return;
        }
        audio = result.audio;
        this.cache = { language: this.language, voice: this.voice, audio };
      }
      stage = "playback";
      const playback = await this.options.env.createPlayback(audio);
      if (generation !== this.generation) {
        playback.dispose();
        return;
      }
      this.playback = playback;
      this.attach(playback, generation);
      await this.attemptPlay(playback, generation);
    } catch {
      if (generation !== this.generation) return;
      this.dispatch({ type: "FAILED", code: stage === "fetch" ? "network" : "playback", retryAfterMs: null });
    }
  }

  private async attemptPlay(playback: PlayerPlayback, generation: number): Promise<void> {
    try {
      await playback.play();
    } catch (error) {
      if (generation !== this.generation) return;
      if (isPermissionError(error)) {
        this.dispatch({ type: "AUTOPLAY_BLOCKED" });
        return;
      }
      this.dispatch({ type: "FAILED", code: "playback", retryAfterMs: null });
      return;
    }
    if (generation !== this.generation) {
      playback.dispose();
      return;
    }
    this.dispatch({ type: "PLAYING" });
  }

  private attach(playback: PlayerPlayback, generation: number): void {
    playback.onEnded = () => {
      if (generation !== this.generation) return;
      this.dispatch({ type: "ENDED" });
    };
    playback.onError = () => {
      if (generation !== this.generation) return;
      this.dispatch({ type: "FAILED", code: "playback", retryAfterMs: null });
    };
  }

  private abortAttempt(): void {
    this.attempt?.abort();
    this.attempt = null;
  }

  private disposePlayback(): void {
    const playback = this.playback;
    this.playback = null;
    if (playback !== null) {
      playback.onEnded = null;
      playback.onError = null;
      playback.dispose();
    }
  }

  private dispatch(event: PlayerEvent): void {
    const next = reducePlayer(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
