import type { ConversationBackend, RunTurnResult } from "./data/conversation.js";
import { runTurnFailure } from "./data/conversation.js";
import type { SpeechOptions } from "./data/tutor.js";
import type { TutorTurnStatus } from "./data/tutor.js";
import {
  initialConversationState,
  reduceConversation,
  type ConversationEvent,
  type ConversationState,
  type ConversationTranscript,
} from "./conversationState.js";
import { LatencyRecorder } from "./latency.js";
import { ResponsePlayerController, type ResponsePlayerEnvironment } from "./playerController.js";
import { TurnController, type TurnEnvironment } from "./turnController.js";
import type { TurnAction, TurnState } from "./turnState.js";

/**
 * S17 conversation orchestrator: one explicit machine driving
 * listening → transcribing → generating → speaking → ready over the S15
 * capture controller, the S14 turn port and the S16 player controller.
 *
 * Composition rules that the tests lock down:
 *
 * - **One turn id, end to end.** The id minted for transcription is the same
 *   id sent to `runTurn` and to TTS, so S14 idempotency covers the whole
 *   turn. A retry after a dropped connection reuses it (replay, never
 *   double-send); a retry after a typed terminal failure mints a fresh id
 *   (the terminal attempt wrote no messages).
 * - **A monotonic generation token plus the reducer's `turnId` check reject
 *   every late result.** Stopping speech, cancelling or starting a new turn
 *   bumps the token *and* disposes the player before the new capture cycle,
 *   so old audio or an old tutor answer can never play over a new turn.
 * - **Nothing durable lives in the browser.** Transcripts, citations and turn
 *   status are restored from the authorized server reads on mount, so a page
 *   or app reconnect keeps them.
 *
 * Continuous VAD/full duplex is out of scope: there is exactly one capture
 * cycle per turn and it only opens from a resting state.
 */

export type ConversationEnvironment = {
  capture: TurnEnvironment;
  /** S14/S16 port. `null` renders the capture-only S15 flow (no tutor turn). */
  conversation: ConversationBackend | null;
  /** S16 playback. `null` keeps the answer text-only (no speaking stage work). */
  playback: ResponsePlayerEnvironment | null;
};

export type ConversationControllerOptions = {
  env: ConversationEnvironment;
  projectId: string;
};

/** Cadence and bound for restoring a turn that is still running on the server. */
export const RESTORE_POLL_MS = 1_000;
export const RESTORE_POLL_ATTEMPTS = 60;

const LANGUAGE_LABEL_FALLBACK = "en";

export class ConversationController {
  private state: ConversationState = initialConversationState();
  private readonly listeners = new Set<() => void>();
  private readonly turn: TurnController;
  private readonly latencyRecorder = new LatencyRecorder();
  private player: ResponsePlayerController | null = null;
  private action: TurnAction | null = null;
  private generationToken = 0;
  private restoreToken = 0;
  private disposed = false;
  private prevCapturePhase: TurnState["phase"];

  public constructor(private readonly options: ConversationControllerOptions) {
    this.turn = new TurnController({ env: options.env.capture, projectId: options.projectId });
    this.prevCapturePhase = this.turn.getSnapshot().phase;
    this.turn.subscribe(this.onCaptureChanged);
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getSnapshot = (): ConversationState => this.state;

  /** Live S15 capture detail (recording clock, editable transcript). */
  public readonly getCapture = (): TurnState => this.turn.getSnapshot();

  /** Bounded per-stage latency window feeding the release budget. */
  public get latency(): LatencyRecorder {
    return this.latencyRecorder;
  }

  public readonly setAction = (action: TurnAction | null): void => {
    this.action = action;
    this.turn.setAction(action);
  };

  public readonly setLanguage = (language: Parameters<TurnController["setLanguage"]>[0]): void => {
    this.turn.setLanguage(language);
  };

  public readonly setTarget = (target: Parameters<TurnController["setTarget"]>[0]): void => {
    this.turn.setTarget(target);
  };

  /** Learner picked another speech language for the player. */
  public readonly setSpeechLanguage = (language: string): void => {
    const options = this.state.speech?.options ?? null;
    this.dispatch({ type: "SET_SPEECH", options, language });
    this.player?.setLanguage(language, this.voiceFor(language));
  };

  /** Recording pressed. Any in-flight stage is cancelled by the capture edge itself. */
  public readonly start = async (): Promise<void> => {
    await this.turn.start();
  };

  public readonly stopRecording = (): void => {
    this.turn.stopRecording();
  };

  public readonly editTranscript = (text: string): void => {
    this.turn.editTranscript(text);
    this.dispatch({ type: "EDIT_TRANSCRIPT", text });
  };

  /** Stage-aware Cancel: the capture panel's cancel and the conversation bar's. */
  public readonly cancel = (): void => {
    switch (this.state.stage) {
      case "listening":
      case "transcribing":
        this.turn.cancel();
        return;
      case "generating":
        this.cancelGeneration("Turn cancelled. No answer was written for this turn.");
        return;
      case "speaking":
        this.stopSpeaking();
        return;
      case "error":
        this.discard();
        return;
      default:
        return;
    }
  };

  /** Cancels the in-flight tutor turn: token bump + S14 `cancelTurn`. */
  public readonly cancelTurn = (): void => {
    if (this.state.stage === "generating") {
      this.cancelGeneration("Turn cancelled. No answer was written for this turn.");
    }
  };

  /** Stop audio but keep the answer (the S16 Stop path). */
  public readonly stopSpeaking = (): void => {
    if (this.player !== null) {
      this.player.stop();
      return;
    }
    this.dispatch({ type: "PLAYER_STOPPED" });
  };

  /** Player controls for the current response (S16 surface inside S17). */
  public readonly play = (): void => {
    void this.player?.play();
  };

  public readonly pause = (): void => {
    this.player?.pause();
  };

  public readonly resume = (): void => {
    void this.player?.resume();
  };

  /** Stage-aware Retry; the turn-id reuse rule lives in `retryPolicy`. */
  public readonly retry = (): void => {
    const failure = this.state.failure;
    if (this.state.stage !== "error" || failure === null) return;
    if (failure.retry === "record") {
      void this.start();
      return;
    }
    if (failure.retry === "replay") {
      if (this.player !== null) void this.player.retry();
      else this.dispatch({ type: "PLAYER_ACTIVE" });
      return;
    }
    // regenerate: ambiguous → same id (S14 replays); terminal → fresh id.
    const transcript = this.state.transcript;
    if (transcript === null) {
      void this.start();
      return;
    }
    const turnId = failure.ambiguous ? transcript.turnId : this.options.env.capture.newTurnId();
    void this.runGeneration(transcript.text, turnId);
  };

  /** Drop a failed/finished response and return to the resting state. */
  public readonly discard = (): void => {
    if (this.player !== null) {
      this.player.cancel();
      if (this.state.stage === "error") this.dispatch({ type: "DISCARDED" });
      return;
    }
    this.dispatch({ type: "DISCARDED" });
  };

  public readonly retryHistory = (): void => {
    this.dispatch({ type: "HISTORY_LOADING" });
    void this.reloadHistory();
  };

  /** Reconnect/first-load restore: transcripts, speech catalog, newest turn. */
  public readonly restore = async (): Promise<void> => {
    const backend = this.options.env.conversation;
    if (backend === null) return;
    // A StrictMode/dev remount reuses this instance after `dispose()`; the
    // restore hook is what re-arms it (every async continuation still guards
    // on the tokens `dispose()` bumped).
    this.disposed = false;
    const token = ++this.restoreToken;
    void this.reloadHistory();

    let options: SpeechOptions | null = null;
    try {
      options = await backend.speechOptions();
    } catch {
      options = null;
    }
    if (this.isStaleRestore(token)) return;
    this.dispatch({
      type: "SET_SPEECH",
      options,
      language: this.state.speech?.language ?? options?.languages[0] ?? LANGUAGE_LABEL_FALLBACK,
    });

    let latest: { turnId: string; status: TutorTurnStatus; createdAt: number } | null = null;
    try {
      latest = await backend.latestTurn(this.options.projectId);
    } catch {
      return;
    }
    if (this.isStaleRestore(token) || latest === null) return;

    if (latest.status === "running") {
      this.dispatch({ type: "RESTORED_TURN", turnId: latest.turnId, polling: true });
      await this.pollUntilTerminal(latest.turnId, token);
      return;
    }

    const text = await this.fetchTutorText(latest.turnId);
    if (this.isStaleRestore(token)) return;
    if (latest.status === "completed" && text !== null) {
      this.dispatch({ type: "RESTORED_TURN", turnId: latest.turnId, polling: false });
      this.dispatch({ type: "RESTORED_RESPONSE", turnId: latest.turnId, text });
      this.attachPlayer(latest.turnId, text, false);
      return;
    }
    if (latest.status === "failed") {
      this.dispatch({ type: "RESTORED_TURN", turnId: latest.turnId, polling: false });
      let code = "TURN_FAILED";
      try {
        code = (await backend.getTurn(this.options.projectId, latest.turnId))?.failureCode ?? "TURN_FAILED";
      } catch {
        code = "TURN_FAILED";
      }
      if (this.isStaleRestore(token)) return;
      this.dispatch({ type: "GENERATION_FAILED", turnId: latest.turnId, code, retryAfterMs: null, ambiguous: false });
      return;
    }
    if (latest.status === "cancelled") {
      this.dispatch({ type: "CANCELLED", notice: "The previous turn was cancelled before an answer was written." });
    }
  };

  public readonly dispose = (): void => {
    this.disposed = true;
    this.generationToken += 1;
    this.restoreToken += 1;
    this.disposePlayer();
    // Release the microphone/transport if a capture cycle was in flight.
    this.turn.cancel();
    this.listeners.clear();
  };

  /* ---------------------------------------------------------------- *
   * Capture edges (S15 state machine → conversation stages)
   * ---------------------------------------------------------------- */

  private readonly onCaptureChanged = (): void => {
    const capture = this.turn.getSnapshot();
    const previous = this.prevCapturePhase;
    if (previous === capture.phase) {
      this.dispatch({ type: "SET_CAPTURE", capture });
      return;
    }
    this.prevCapturePhase = capture.phase;
    this.dispatch({ type: "SET_CAPTURE", capture });
    this.handleCaptureEdge(previous, capture);
  };

  private handleCaptureEdge(previous: TurnState["phase"], capture: TurnState): void {
    switch (capture.phase) {
      case "requesting-permission":
      case "recording": {
        const entering = previous !== "requesting-permission" && previous !== "recording";
        if (entering) {
          // A new capture cycle always supersedes the current turn: drop the
          // old player (stops any audio immediately), invalidate in-flight
          // results, and cancel the server turn if one is running.
          this.beginNewTurn();
          this.dispatch({ type: "CAPTURE_LISTENING" });
          this.latencyRecorder.begin(this.now());
        }
        if (capture.phase === "recording") {
          this.latencyRecorder.markPermissionReady(this.now());
        }
        return;
      }
      case "analysing": {
        this.latencyRecorder.markStopped(this.now());
        this.dispatch({ type: "CAPTURE_TRANSCRIBING" });
        return;
      }
      case "transcribing":
        this.dispatch({ type: "CAPTURE_TRANSCRIBING" });
        return;
      case "transcript": {
        if (previous !== "transcribing") {
          // A leftover transcript edge (state replay) is not a new turn.
          return;
        }
        const transcript: ConversationTranscript = {
          turnId: capture.turnId,
          text: capture.text,
          detectedLanguage: capture.detectedLanguage,
          durationMs: capture.durationMs,
        };
        this.latencyRecorder.markTranscript(this.now(), transcript.turnId);
        this.dispatch({ type: "CAPTURE_TRANSCRIPT", transcript });
        if (this.action === "transcribe" && this.options.env.conversation !== null) {
          void this.runGeneration(transcript.text, transcript.turnId);
        }
        return;
      }
      case "blocked":
        this.dispatch({ type: "CAPTURE_FAILED", stage: "listening", code: capture.reason, retryAfterMs: null });
        this.latencyRecorder.abandon();
        return;
      case "silence":
        this.dispatch({ type: "CAPTURE_FAILED", stage: "transcribing", code: "silence", retryAfterMs: null });
        this.latencyRecorder.abandon();
        return;
      case "failed":
        this.dispatch({ type: "CAPTURE_FAILED", stage: "transcribing", code: capture.code, retryAfterMs: capture.retryAfterMs });
        this.latencyRecorder.abandon();
        return;
      case "aborted":
        this.dispatch({ type: "CAPTURE_CANCELLED" });
        this.latencyRecorder.abandon();
        return;
      default:
        return;
    }
  }

  /** Token bump + server cancel + player teardown for the superseded turn. */
  private beginNewTurn(): void {
    this.generationToken += 1;
    this.restoreToken += 1;
    const wasGenerating = this.state.stage === "generating" || this.state.restorePolling;
    const turnId = this.state.turnId;
    this.disposePlayer();
    this.latencyRecorder.abandon();
    if (wasGenerating && turnId !== null) {
      const backend = this.options.env.conversation;
      if (backend !== null) void backend.cancelTurn(this.options.projectId, turnId).catch(() => undefined);
      void this.reloadHistory();
    }
  }

  /* ---------------------------------------------------------------- *
   * Generation (S14 runTurn) with turn-id idempotency
   * ---------------------------------------------------------------- */

  private async runGeneration(text: string, turnId: string): Promise<void> {
    const backend = this.options.env.conversation;
    if (backend === null) return;
    const token = ++this.generationToken;
    this.dispatch({ type: "GENERATING", turnId, text });
    let result: RunTurnResult;
    try {
      result = await backend.runTurn({ projectId: this.options.projectId, turnId, text });
    } catch (error) {
      result = runTurnFailure(error);
    }
    if (token !== this.generationToken || this.disposed) return; // superseded: drop the result
    if (!result.ok) {
      this.dispatch({ type: "GENERATION_FAILED", turnId, code: result.code, retryAfterMs: result.retryAfterMs, ambiguous: result.ambiguous });
      void this.reloadHistory();
      return;
    }
    this.latencyRecorder.markGenerated(this.now());
    this.dispatch({ type: "GENERATED", turnId, text: result.text });
    if (this.options.env.playback === null) {
      this.dispatch({ type: "PLAYER_ENDED" });
      void this.reloadHistory();
      return;
    }
    this.attachPlayer(turnId, result.text, true);
    void this.reloadHistory();
  }

  private cancelGeneration(notice: string): void {
    this.generationToken += 1;
    this.restoreToken += 1;
    const turnId = this.state.turnId;
    this.disposePlayer();
    this.latencyRecorder.abandon();
    this.dispatch({ type: "CANCELLED", notice });
    if (turnId !== null) {
      const backend = this.options.env.conversation;
      if (backend !== null) void backend.cancelTurn(this.options.projectId, turnId).catch(() => undefined);
    }
    void this.reloadHistory();
  }

  /* ---------------------------------------------------------------- *
   * Playback (S16 player) mapped into the speaking stage
   * ---------------------------------------------------------------- */

  private attachPlayer(turnId: string, text: string, autoStart: boolean): void {
    const playback = this.options.env.playback;
    if (playback === null) return;
    this.disposePlayer();
    const language = this.state.speech?.language ?? LANGUAGE_LABEL_FALLBACK;
    const player = new ResponsePlayerController({
      env: playback,
      projectId: this.options.projectId,
      turnId,
      language,
      voice: this.voiceFor(language),
    });
    player.subscribe(this.onPlayerChanged);
    this.player = player;
    this.dispatch({ type: "SET_PLAYER", player: player.getSnapshot() });
    if (autoStart) void player.autoStart();
  }

  private readonly onPlayerChanged = (): void => {
    const player = this.player;
    if (player === null) return;
    const snapshot = player.getSnapshot();
    this.dispatch({ type: "SET_PLAYER", player: snapshot });
    switch (snapshot.phase) {
      case "loading":
      case "playing":
      case "paused":
      case "autoplay-blocked":
        this.latencyRecorder.markSpeaking(this.now());
        this.dispatch({ type: "PLAYER_ACTIVE" });
        return;
      case "failed": {
        const failure = snapshot.failure;
        this.dispatch({
          type: "PLAYER_FAILED",
          code: failure?.code ?? "unknown",
          retryAfterMs: failure?.retryAfterMs ?? null,
        });
        return;
      }
      case "ended":
        this.latencyRecorder.markFinished(this.now());
        this.dispatch({ type: "PLAYER_ENDED" });
        return;
      case "idle":
        this.dispatch({ type: "PLAYER_STOPPED" });
        return;
      case "cancelled":
        this.dispatch({ type: "PLAYER_CANCELLED" });
        return;
      default:
        return;
    }
  };

  private disposePlayer(): void {
    const player = this.player;
    if (player === null) return;
    player.dispose();
    this.player = null;
    this.dispatch({ type: "SET_PLAYER", player: null });
  }

  /* ---------------------------------------------------------------- *
   * Server restore (reconnect) and history
   * ---------------------------------------------------------------- */

  private isStaleRestore(token: number): boolean {
    return this.disposed || token !== this.restoreToken;
  }

  private async reloadHistory(): Promise<void> {
    const backend = this.options.env.conversation;
    if (backend === null) return;
    try {
      const page = await backend.transcript(this.options.projectId);
      if (this.disposed) return;
      this.dispatch({ type: "HISTORY_READY", messages: page.messages, droppedCitations: page.droppedCitations });
    } catch {
      if (this.disposed) return;
      if (this.state.history.status !== "ready") this.dispatch({ type: "HISTORY_ERROR" });
    }
  }

  private async fetchTutorText(turnId: string): Promise<string | null> {
    const backend = this.options.env.conversation;
    if (backend === null) return null;
    try {
      const page = await backend.transcript(this.options.projectId);
      if (this.disposed) return null;
      for (let index = page.messages.length - 1; index >= 0; index -= 1) {
        const message = page.messages[index];
        if (message.role === "tutor" && message.turnId === turnId) {
          this.dispatch({ type: "HISTORY_READY", messages: page.messages, droppedCitations: page.droppedCitations });
          return message.content;
        }
      }
      this.dispatch({ type: "HISTORY_READY", messages: page.messages, droppedCitations: page.droppedCitations });
      return null;
    } catch {
      return null;
    }
  }

  private isPolling(turnId: string, token: number): boolean {
    return !this.disposed && token === this.restoreToken && this.state.stage === "generating" && this.state.turnId === turnId && this.state.restorePolling;
  }

  private schedule(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.options.env.capture.schedule(() => resolve(), delayMs);
    });
  }

  /** Watches a turn that is still running server-side until it settles. */
  private async pollUntilTerminal(turnId: string, token: number): Promise<void> {
    const backend = this.options.env.conversation;
    if (backend === null) return;
    for (let attempt = 0; attempt < RESTORE_POLL_ATTEMPTS; attempt += 1) {
      await this.schedule(RESTORE_POLL_MS);
      if (!this.isPolling(turnId, token)) return;
      let latest: { turnId: string; status: TutorTurnStatus } | null = null;
      try {
        latest = await backend.latestTurn(this.options.projectId);
      } catch {
        latest = null;
      }
      if (!this.isPolling(turnId, token)) return;
      if (latest === null || latest.turnId !== turnId) {
        this.dispatch({ type: "GENERATION_FAILED", turnId, code: "network", retryAfterMs: null, ambiguous: true });
        return;
      }
      if (latest.status === "running") continue;
      if (latest.status === "completed") {
        const text = await this.fetchTutorText(turnId);
        if (!this.isPolling(turnId, token)) return;
        if (text === null) {
          this.dispatch({ type: "GENERATION_FAILED", turnId, code: "network", retryAfterMs: null, ambiguous: true });
          return;
        }
        this.dispatch({ type: "GENERATED", turnId, text });
        this.attachPlayer(turnId, text, true);
        void this.reloadHistory();
        return;
      }
      if (latest.status === "failed") {
        let code = "TURN_FAILED";
        try {
          code = (await backend.getTurn(this.options.projectId, turnId))?.failureCode ?? "TURN_FAILED";
        } catch {
          code = "TURN_FAILED";
        }
        if (!this.isPolling(turnId, token)) return;
        this.dispatch({ type: "GENERATION_FAILED", turnId, code, retryAfterMs: null, ambiguous: false });
        return;
      }
      this.dispatch({ type: "CANCELLED", notice: "The turn was cancelled before an answer arrived." });
      return;
    }
    this.dispatch({ type: "GENERATION_FAILED", turnId, code: "TURN_IN_PROGRESS", retryAfterMs: null, ambiguous: true });
  }

  /* ---------------------------------------------------------------- */

  private voiceFor(language: string): string | null {
    const options = this.state.speech?.options ?? null;
    return options?.voices.find((voice) => voice.language === language)?.id ?? null;
  }

  private now(): number {
    return this.options.env.capture.now();
  }

  private dispatch(event: ConversationEvent): void {
    const next = reduceConversation(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export function createConversationController(options: ConversationControllerOptions): ConversationController {
  return new ConversationController(options);
}
