import { syntheticEmbeddingVector } from "../../../api/tests/helpers/embeddingProvider.js";
import { makeConvexConversationBackend } from "../../src/data/conversation.js";
import type { ConversationBackend, ConversationTranscriptPage, ConversationTurn, RunTurnFailure, RunTurnInput } from "../../src/data/conversation.js";
import type { SpeechOptions, TutorResponseSummary, TutorTurnSummary } from "../../src/data/tutor.js";
import { browserTurnEnvironment } from "../../src/environments.js";
import type { PlayerPlayback, ResponsePlayerEnvironment } from "../../src/playerController.js";
import { requestTtsAudio } from "../../src/ttsClient.js";
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

/* ------------------------------------------------------------------ *
 * Shared convex-test bindings for the S17 end-to-end suites
 * ------------------------------------------------------------------ */

/** Deterministic offline NaN answers: embeddings, SSE chat, Whisper, Kokoro. */
export function installVoiceProviderMock() {
  const counts = { embeddings: 0, chat: 0, transcriptions: 0, speech: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { input?: unknown }) : null;
    if (url.endsWith("/embeddings")) {
      counts.embeddings += 1;
      const texts = Array.isArray(body?.input) ? body.input : [];
      return Response.json({
        model: "qwen3-embedding",
        data: texts.map((_, index) => ({ embedding: syntheticEmbeddingVector(index + 1) })),
      });
    }
    if (url.endsWith("/chat/completions")) {
      counts.chat += 1;
      const encoder = new TextEncoder();
      const pieces = ANSWER.match(/.{1,16}/gs) ?? [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    if (url.endsWith("/audio/transcriptions")) {
      counts.transcriptions += 1;
      return Response.json({ text: QUESTION, language: "en", duration: 1.5 });
    }
    if (url.endsWith("/audio/speech")) {
      counts.speech += 1;
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    throw new Error(`offline voice test attempted an unexpected provider call: ${url}`);
  }) as typeof globalThis.fetch;
  return {
    counts,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * The S17 ports bound to one authenticated convex-test instance: real STT/TTS
 * HTTP routes (through a fetch adapter that unwraps jsdom Blobs the way a
 * browser request would), the real `runTurn` action, and the scripted
 * microphone/player devices.
 */
export function convexVoicePorts(a: { fetch: (path: string, init?: RequestInit) => Promise<Response> }) {
  const guardedFetch = async (input: string, init?: RequestInit) => {
    const body = init?.body;
    const normalized = body instanceof Blob ? { ...init, body: new Uint8Array(await body.arrayBuffer()) } : init;
    return a.fetch(input, normalized);
  };
  const backend = makeConvexConversationBackend(a as unknown as Parameters<typeof makeConvexConversationBackend>[0]);
  const httpCapture = browserTurnEnvironment({ siteUrl: "", getToken: () => "synthetic-test-token", fetchImpl: guardedFetch });
  const device = captureHarness().env;
  const capture: TurnEnvironment = { ...device, transcribe: httpCapture.transcribe, translateAudio: httpCapture.translateAudio };
  const playbacks: FakePlayback[] = [];
  const playback: ResponsePlayerEnvironment = {
    fetchAudio: ({ projectId, turnId, language, voice, signal }) =>
      requestTtsAudio({ siteUrl: "", token: "synthetic-test-token", projectId, turnId, language, voice, signal, fetchImpl: guardedFetch }),
    createPlayback: async () => {
      const playback = fakePlayback();
      playbacks.push(playback);
      return playback;
    },
  };
  return { backend, capture, playback, playbacks };
}
