import type {
  ConversationBackend,
  ConversationTranscriptPage,
  ConversationTurn,
  RunTurnFailure,
  RunTurnInput,
} from "../../src/data/conversation.js";
import type { SpeechOptions, TutorResponseSummary, TutorTurnSummary } from "../../src/data/tutor.js";
import type { PlayerPlayback, ResponsePlayerEnvironment } from "../../src/playerController.js";
import type { CaptureRecording, CaptureSubscription, TurnEnvironment } from "../../src/turnController.js";
import type { TranscribeResult } from "../../src/transcribeClient.js";

/**
 * Shared synthetic fixtures for the S17 conversation tests: an in-memory S14
 * (one terminal row per turn id, message idempotency), a scripted microphone
 * and a fake player. No live provider, no network, no secrets.
 */

export const QUESTION = "what is photosynthesis";
export const ANSWER = "Plants turn light into chemical energy [1].";
export const PROJECT = "project-1";

export type HistoryMessage = ConversationTranscriptPage["messages"][number];

export function historyMessage(overrides: Partial<HistoryMessage> & Pick<HistoryMessage, "turnId" | "role" | "content">): HistoryMessage {
  return { createdAt: 1_760_000_000_000, citations: [], ...overrides };
}

/** In-memory S14: one row per turn id, terminal rows, message idempotency. */
export function memoryBackend() {
  type Row = { status: "running" | "completed" | "cancelled" | "failed"; text: string; failureCode: string };
  type LatestRow = { turnId: string; status: TutorTurnSummary["status"]; createdAt: number };
  const turns = new Map<string, Row>();
  const messages: HistoryMessage[] = [];
  const runCalls: RunTurnInput[] = [];
  const cancelCalls: string[] = [];
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let failNext: RunTurnFailure | null = null;
  /** Simulates a completed turn whose response never reached the client. */
  let loseResponse = false;
  let latestTurnQueue: Array<LatestRow | null> = [];
  let latestTurnFallback: LatestRow | null = null;
  let transcriptImpl: (() => Promise<ConversationTranscriptPage>) | null = null;

  const backend: ConversationBackend = {
    async runTurn(input) {
      runCalls.push({ ...input });
      const existing = turns.get(input.turnId);
      if (existing !== undefined) {
        if (existing.status === "completed") return { ok: true, turnId: input.turnId, text: existing.text, replayed: true };
        if (existing.status === "running") return { ok: false, code: "TURN_IN_PROGRESS", retryAfterMs: null, ambiguous: true };
        if (existing.status === "cancelled") return { ok: false, code: "TURN_CANCELLED", retryAfterMs: null, ambiguous: false };
        return { ok: false, code: existing.failureCode, retryAfterMs: null, ambiguous: false };
      }
      const row: Row = { status: "running", text: ANSWER, failureCode: "TURN_FAILED" };
      turns.set(input.turnId, row);
      if (gate !== null) await gate;
      if (failNext !== null) {
        const failure = failNext;
        failNext = null;
        row.status = "failed";
        row.failureCode = failure.code;
        return failure;
      }
      if (row.status === "cancelled") return { ok: false, code: "TURN_CANCELLED", retryAfterMs: null, ambiguous: false };
      row.status = "completed";
      messages.push(historyMessage({ turnId: input.turnId, role: "learner", content: input.text }));
      messages.push(historyMessage({ turnId: input.turnId, role: "tutor", content: ANSWER }));
      if (loseResponse) {
        loseResponse = false;
        throw new Error("connection dropped after the turn committed");
      }
      return { ok: true, turnId: input.turnId, text: ANSWER, replayed: false };
    },
    async latestResponse(): Promise<TutorResponseSummary | null> {
      return null;
    },
    async latestTurn(): Promise<TutorTurnSummary | null> {
      const next = latestTurnQueue.shift();
      return next === undefined ? latestTurnFallback : next;
    },
    async getTurn(_projectId: string, turnId: string): Promise<ConversationTurn | null> {
      const row = turns.get(turnId);
      if (row === undefined) return null;
      return { turnId, status: row.status, failureCode: row.status === "failed" ? row.failureCode : null };
    },
    async speechOptions(): Promise<SpeechOptions> {
      return {
        model: "kokoro",
        format: "mp3",
        languages: ["en", "es"],
        voices: [
          { id: "af_heart", language: "en", label: "English" },
          { id: "ef_dora", language: "es", label: "Spanish" },
        ],
        maxTextChars: 20_000,
      };
    },
    async cancelTurn(_projectId: string, turnId: string): Promise<void> {
      cancelCalls.push(turnId);
      const row = turns.get(turnId);
      if (row !== undefined && row.status === "running") row.status = "cancelled";
    },
    async transcript(): Promise<ConversationTranscriptPage> {
      if (transcriptImpl !== null) return transcriptImpl();
      return { messages: [...messages], droppedCitations: 0 };
    },
  };

  return {
    backend,
    turns,
    messages,
    runCalls,
    cancelCalls,
    get turnIds(): string[] {
      return runCalls.map((call) => call.turnId);
    },
    /** Every later `runTurn` waits here until `release()`. */
    hold(): void {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    release(): void {
      const resolve = releaseGate;
      releaseGate = null;
      gate = null;
      resolve?.();
    },
    failNextWith(failure: RunTurnFailure): void {
      failNext = failure;
    },
    loseNextResponse(): void {
      loseResponse = true;
    },
    queueLatestTurn(rows: Array<LatestRow | null>, fallback: LatestRow | null = null): void {
      latestTurnQueue = [...rows];
      latestTurnFallback = fallback;
    },
    setLatestTurnFallback(row: LatestRow | null): void {
      latestTurnFallback = row;
    },
    breakTranscripts(): void {
      transcriptImpl = async () => {
        throw new Error("offline");
      };
    },
    fixTranscripts(): void {
      transcriptImpl = null;
    },
  };
}

export type FakePlayback = PlayerPlayback & { ended: () => void; disposed: () => boolean };

export function fakePlayback(): FakePlayback {
  let disposed = false;
  const playback: FakePlayback = {
    async play() {
      // resolves: the player reaches `playing`
    },
    pause() {
      // pauses
    },
    dispose() {
      disposed = true;
    },
    ended() {
      playback.onEnded?.();
    },
    disposed: () => disposed,
    onEnded: null,
    onError: null,
  };
  return playback;
}

export function playbackHarness() {
  const playbacks: FakePlayback[] = [];
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let fetchCount = 0;
  const env: ResponsePlayerEnvironment = {
    async fetchAudio() {
      fetchCount += 1;
      if (gate !== null) await gate;
      return { ok: true, audio: new Blob([new Uint8Array([0x49, 0x44, 0x33])]), contentType: "audio/mpeg" };
    },
    async createPlayback() {
      const playback = fakePlayback();
      playbacks.push(playback);
      return playback;
    },
  };
  return {
    env,
    playbacks,
    get fetchCount(): number {
      return fetchCount;
    },
    hold(): void {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    release(): void {
      const resolve = releaseGate;
      releaseGate = null;
      gate = null;
      resolve?.();
    },
  };
}

export function captureHarness(options: { scheduleMaxMs?: number } = {}) {
  let subscription: CaptureSubscription | null = null;
  let transcribe: (input: { turnId: string }) => Promise<TranscribeResult> = async ({ turnId }) => ({
    ok: true,
    text: QUESTION,
    detectedLanguage: "en",
    durationMs: 1.5,
    turnId,
  });
  let turnCounter = 0;
  const env: TurnEnvironment = {
    hasCaptureSupport: () => true,
    isTypeSupported: () => true,
    startMicrophone: async (mimeType, sub) => {
      subscription = sub;
      const recording: CaptureRecording = {
        stop: () => {
          sub.onAudio(new Blob([new Uint8Array([0x01, 0x02])], { type: mimeType }));
        },
        stopTracks: () => {
          subscription = null;
        },
      };
      return recording;
    },
    readPeakLevel: async () => 1,
    transcribe: ({ turnId }) => transcribe({ turnId }),
    translateAudio: async () => ({ ok: false, code: "unsupported-codec", message: "unsupported", retryAfterMs: null }),
    newTurnId: () => `turn-${(turnCounter += 1)}`,
    now: () => Date.now(),
    schedule: (callback, delayMs) => setTimeout(callback, options.scheduleMaxMs === undefined ? delayMs : Math.min(delayMs, options.scheduleMaxMs)),
    cancelSchedule: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    discardAudio: () => undefined,
  };
  return {
    env,
    hasDevice: () => subscription !== null,
    setTranscribe(impl: (input: { turnId: string }) => Promise<TranscribeResult>): void {
      transcribe = impl;
    },
  };
}
