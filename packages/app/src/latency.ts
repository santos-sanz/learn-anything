/**
 * S17 stage-latency recording. The conversation controller marks stage
 * boundaries for every turn; `LatencyRecorder` keeps a bounded window and
 * reports p50/p95 per stage plus end-to-end, which is what the release budget
 * gates (see `docs/spoken-conversation.md` for the sample, method and numbers).
 *
 * Measurements are client-side pipeline timings taken around the (mocked in
 * CI) provider calls. No live provider request is ever made to record them.
 */

export type TurnLatency = {
  turnId: string | null;
  /** `start()` press → microphone ready. */
  permissionMs: number | null;
  /** Microphone ready → stop pressed (learner speaking time; recorded, not budgeted). */
  listeningMs: number | null;
  /** Stop pressed → transcript visible (analysis + STT round trip). */
  transcribeMs: number | null;
  /** Transcript → committed tutor answer (retrieval + generation). */
  generateMs: number | null;
  /** Committed answer → playback started (TTS fetch + audio element). */
  speakMs: number | null;
  /** Stop pressed → playback started: the system-controlled end-to-end path. */
  endToEndMs: number | null;
  /** `start()` press → playback finished: includes learner speaking time. */
  turnMs: number | null;
};

export type LatencyStage = "permission" | "transcribe" | "generate" | "speak" | "endToEnd";

export type LatencySummary = {
  samples: number;
  stages: Record<LatencyStage, { p50: number; p95: number } | null>;
};

/**
 * Release budget derived from the documented synthetic sample
 * (`docs/spoken-conversation.md`): measured p95 rounded up with headroom, in
 * milliseconds, for the system-controlled stages only (`permission`,
 * `transcribe`, `generate`, `speak`, `endToEnd` = stop → speaking start).
 * `listeningMs` and `turnMs` are dominated by how long the learner speaks and
 * are recorded for visibility, never budgeted.
 */
export const RELEASE_LATENCY_BUDGET_MS: Record<LatencyStage, number> = {
  permission: 150,
  transcribe: 1_500,
  generate: 4_000,
  speak: 2_000,
  endToEnd: 7_000,
};

/** Nearest-rank percentile over a sample; `p` in (0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Marks stage boundaries for one in-flight turn and keeps the completed
 * samples. Every mark is a no-op outside a turn (restored turns record no
 * client-side pipeline latency), and each stage only ever records once, so
 * repeated events (retries, player toggles) cannot corrupt the window.
 */
export class LatencyRecorder {
  private readonly window: TurnLatency[] = [];
  private current: TurnLatency | null = null;
  private startedAt: number | null = null;
  private micReadyAt: number | null = null;
  private stoppedAt: number | null = null;
  private transcriptAt: number | null = null;
  private generatedAt: number | null = null;

  /** Bounded history: the budget and tests only need a recent window. */
  public constructor(private readonly maxSamples = 200) {}

  public begin(now: number): void {
    this.current = {
      turnId: null,
      permissionMs: null,
      listeningMs: null,
      transcribeMs: null,
      generateMs: null,
      speakMs: null,
      endToEndMs: null,
      turnMs: null,
    };
    this.startedAt = now;
    this.micReadyAt = null;
    this.stoppedAt = null;
    this.transcriptAt = null;
    this.generatedAt = null;
  }

  public markPermissionReady(now: number): void {
    if (this.current === null || this.startedAt === null || this.current.permissionMs !== null) return;
    this.current.permissionMs = Math.max(0, now - this.startedAt);
    this.micReadyAt = now;
  }

  public markStopped(now: number): void {
    if (this.current === null || this.current.listeningMs !== null) return;
    this.current.listeningMs = this.micReadyAt === null ? null : Math.max(0, now - this.micReadyAt);
    this.stoppedAt = now;
  }

  public markTranscript(now: number, turnId: string): void {
    if (this.current === null || this.current.transcribeMs !== null) return;
    this.current.turnId = turnId;
    this.current.transcribeMs = this.stoppedAt === null ? null : Math.max(0, now - this.stoppedAt);
    this.transcriptAt = now;
  }

  public markGenerated(now: number): void {
    if (this.current === null || this.current.generateMs !== null) return;
    this.current.generateMs = this.transcriptAt === null ? null : Math.max(0, now - this.transcriptAt);
    this.generatedAt = now;
  }

  public markSpeaking(now: number): void {
    if (this.current === null || this.current.speakMs !== null) return;
    this.current.speakMs = this.generatedAt === null ? null : Math.max(0, now - this.generatedAt);
    this.current.endToEndMs = this.stoppedAt === null ? null : Math.max(0, now - this.stoppedAt);
  }

  public markFinished(now: number): void {
    if (this.current === null) return;
    this.current.turnMs = this.startedAt === null ? null : Math.max(0, now - this.startedAt);
    this.window.push(this.current);
    while (this.window.length > this.maxSamples) this.window.shift();
    this.clearCurrent();
  }

  /** Abandon the in-flight record (cancelled or failed turn). */
  public abandon(): void {
    this.clearCurrent();
  }

  public get samples(): readonly TurnLatency[] {
    return this.window;
  }

  public get pending(): TurnLatency | null {
    return this.current;
  }

  public summary(): LatencySummary {
    const pick: Record<LatencyStage, (turn: TurnLatency) => number | null> = {
      permission: (turn) => turn.permissionMs,
      transcribe: (turn) => turn.transcribeMs,
      generate: (turn) => turn.generateMs,
      speak: (turn) => turn.speakMs,
      endToEnd: (turn) => turn.endToEndMs,
    };
    const stages = {} as LatencySummary["stages"];
    for (const stage of Object.keys(pick) as LatencyStage[]) {
      const values = this.window.map(pick[stage]).filter((value): value is number => value !== null);
      stages[stage] = values.length === 0 ? null : { p50: percentile(values, 50), p95: percentile(values, 95) };
    }
    return { samples: this.window.length, stages };
  }

  private clearCurrent(): void {
    this.current = null;
    this.startedAt = null;
    this.micReadyAt = null;
    this.stoppedAt = null;
    this.transcriptAt = null;
    this.generatedAt = null;
  }
}
