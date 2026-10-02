import {
  contentVersionKeyFor,
  defaultProcessStep,
  isUnsupportedParserCode,
  parseDocument,
  parserErrorCode,
} from "@learn-anything/worker";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, query, type ActionCtx, type MutationCtx } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./projects";

/**
 * S09 ingestion job runner. Jobs are claimed through an explicit lease
 * (owner + expiry), so concurrent cycles never process the same job twice: the
 * claim patch is the linearization point and Convex serializes conflicting
 * transactions. An interrupted worker leaves its lease to expire; the next
 * claim sweeps the expired lease back to `queued` (ready) immediately, or to
 * the `failed` dead letter once the attempt budget is spent. Data writes are
 * idempotent by content version, so even a stale worker that finishes late
 * converges on the same chunk rows; only job-state transitions are guarded by
 * lease ownership.
 *
 * No HTTP route runs any of this: `/private-uploads` only queues, the cron in
 * `crons.ts` drives `runIngestionCycle`, and everything long-running happens
 * inside the Convex action (ADR-0002's resumable action stages).
 */

const MAX_ATTEMPTS_DEFAULT = 5;
const BACKOFF_BASE_DEFAULT_MS = 30_000;
const LEASE_DEFAULT_MS = 120_000;
const PARSE_TIMEOUT_DEFAULT_MS = 10_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const CLAIM_SCAN_LIMIT = 25;
const LEASE_SWEEP_LIMIT = 10;
const CYCLE_MAX_JOBS_DEFAULT = 5;
const CYCLE_MAX_JOBS_LIMIT = 10;
const MAX_CHUNKS = 2_000;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const jobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("unsupported"),
);

function configuredInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

export function configuredMaxAttempts(): number {
  return configuredInteger("INGESTION_MAX_ATTEMPTS", MAX_ATTEMPTS_DEFAULT, 1, 10);
}

export function configuredBackoffBaseMs(): number {
  return configuredInteger("INGESTION_BACKOFF_BASE_MS", BACKOFF_BASE_DEFAULT_MS, 1_000, 3_600_000);
}

export function configuredLeaseMs(): number {
  return configuredInteger("INGESTION_LEASE_MS", LEASE_DEFAULT_MS, 5_000, 900_000);
}

export function configuredParseTimeoutMs(): number {
  return configuredInteger("INGESTION_PARSE_TIMEOUT_MS", PARSE_TIMEOUT_DEFAULT_MS, 100, 300_000);
}

/** Deterministic exponential backoff: base * 2^(attempts-1), capped. */
export function backoffDelayMs(attempts: number, baseMs: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(baseMs * 2 ** exponent, BACKOFF_MAX_MS);
}

const KNOWN_ERROR_CODES = [
  "LEASE_LOST",
  "JOB_NOT_RUNNING",
  "CONTENT_VERSION_CONFLICT",
  "CHUNK_CONFLICT",
  "CHUNKS_TOO_LARGE",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
] as const;

/** Recovers a typed `{ code }` from a rejected internal function call. */
function functionErrorCode(error: unknown): string | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const quoted = /"code"\s*:\s*"([A-Z][A-Z0-9_]*)"/.exec(message);
  if (quoted !== null) return quoted[1];
  for (const code of KNOWN_ERROR_CODES) if (message.includes(code)) return code;
  return null;
}

function requireRunningLease(job: Doc<"ingestionJobs">, workerId: string): void {
  if (job.status !== "running") throw new ConvexError({ code: "JOB_NOT_RUNNING" });
  if (job.leaseOwner !== workerId) throw new ConvexError({ code: "LEASE_LOST" });
}

/**
 * Applies a terminal job state to the job and to the S08 document status
 * surface: `succeeded` -> ready, `failed`/`unsupported` -> failed with the
 * specific code. The lease is always released.
 */
async function settleJob(
  ctx: MutationCtx,
  job: Doc<"ingestionJobs">,
  status: "succeeded" | "failed" | "unsupported",
  failureCode: string | null,
  extra: Partial<Doc<"ingestionJobs">> = {},
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(job._id, {
    status,
    failureCode: failureCode ?? undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
    ...extra,
  });
  const document = await ctx.db.get(job.documentId);
  if (document !== null && document.ownerId === job.ownerId && document.projectId === job.projectId) {
    await ctx.db.patch(document._id, {
      status: status === "succeeded" ? "ready" : "failed",
      failureCode,
      updatedAt: now,
    });
  }
}

type Claim = {
  jobId: Id<"ingestionJobs">;
  documentId: Id<"documents">;
  ownerId: string;
  projectId: Id<"projects">;
  attempt: number;
  maxAttempts: number;
  leaseExpiresAt: number;
};

/**
 * Atomically takes the next eligible job for `workerId`. Expired leases are
 * swept first: back to `queued` (ready, eligible now) while attempts remain,
 * otherwise to the `failed` dead letter with `LEASE_EXPIRED`. Rows written by
 * S08 without `nextAttemptAt` are still claimable through `by_status` until the
 * v5 backfill runs.
 */
export const claimNextJob = internalMutation({
  args: { workerId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      jobId: v.id("ingestionJobs"),
      documentId: v.id("documents"),
      ownerId: v.string(),
      projectId: v.id("projects"),
      attempt: v.number(),
      maxAttempts: v.number(),
      leaseExpiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    if (!WORKER_ID_PATTERN.test(args.workerId)) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const now = Date.now();
    const defaultMaxAttempts = configuredMaxAttempts();

    const running = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(LEASE_SWEEP_LIMIT);
    for (const job of running) {
      const leaseExpiresAt = job.leaseExpiresAt;
      if (leaseExpiresAt === undefined || leaseExpiresAt > now) continue;
      const maxAttempts = job.maxAttempts ?? defaultMaxAttempts;
      if (job.attempts >= maxAttempts) {
        await settleJob(ctx, job, "failed", job.failureCode ?? "LEASE_EXPIRED");
      } else {
        await ctx.db.patch(job._id, {
          status: "queued",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: now,
          updatedAt: now,
        });
      }
    }

    const eligible = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_status_next", (q) => q.eq("status", "queued").lte("nextAttemptAt", now))
      .take(CLAIM_SCAN_LIMIT);
    let candidate: Doc<"ingestionJobs"> | undefined = eligible[0];
    if (candidate === undefined) {
      const queued = await ctx.db
        .query("ingestionJobs")
        .withIndex("by_status", (q) => q.eq("status", "queued"))
        .take(CLAIM_SCAN_LIMIT);
      candidate = queued.find((job) => job.nextAttemptAt === undefined);
    }
    if (candidate === undefined) return null;

    const maxAttempts = candidate.maxAttempts ?? defaultMaxAttempts;
    if (candidate.attempts >= maxAttempts) {
      await settleJob(ctx, candidate, "failed", candidate.failureCode ?? "MAX_ATTEMPTS_EXCEEDED");
      return null;
    }
    const leaseExpiresAt = now + configuredLeaseMs();
    const attempt = candidate.attempts + 1;
    await ctx.db.patch(candidate._id, {
      status: "running",
      attempts: attempt,
      leaseOwner: args.workerId,
      leaseExpiresAt,
      updatedAt: now,
    });
    return { jobId: candidate._id, documentId: candidate.documentId, ownerId: candidate.ownerId, projectId: candidate.projectId, attempt, maxAttempts, leaseExpiresAt };
  },
});

/** Read model for the action: job scope plus the document's storage handle. */
export const getJobContext = internalQuery({
  args: { jobId: v.id("ingestionJobs") },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      projectId: v.id("projects"),
      storageId: v.id("_storage"),
      contentType: v.string(),
      extension: v.string(),
      filename: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;
    const document = await ctx.db.get(job.documentId);
    if (document === null || document.ownerId !== job.ownerId || document.projectId !== job.projectId) return null;
    return {
      ownerId: job.ownerId,
      projectId: job.projectId,
      storageId: document.storageId,
      contentType: document.contentType,
      extension: document.extension,
      filename: document.filename,
    };
  },
});

/**
 * Idempotent chunk commit keyed by (`documentId`, `chunkKey`) where `chunkKey`
 * = `${contentVersionKey}#${seq}`. A replayed run finds identical rows and
 * writes nothing (same `_id`s survive); a same-key row with different content
 * fails with CHUNK_CONFLICT instead of duplicating; rows from an older
 * contract version are replaced. Deliberately not lease-guarded: the content
 * hash of immutable bytes makes concurrent stale commits converge on the same
 * rows, while job-state transitions stay lease-guarded.
 */
export const commitChunks = internalMutation({
  args: {
    jobId: v.id("ingestionJobs"),
    documentId: v.id("documents"),
    ownerId: v.string(),
    projectId: v.id("projects"),
    contentVersionKey: v.string(),
    chunks: v.array(
      v.object({
        seq: v.number(),
        text: v.string(),
        contentHash: v.string(),
        locator: v.object({
          blockIndex: v.number(),
          page: v.union(v.null(), v.number()),
          heading: v.union(v.null(), v.string()),
        }),
      }),
    ),
  },
  returns: v.object({ chunkCount: v.number(), fresh: v.number() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.ownerId !== args.ownerId || job.projectId !== args.projectId || job.documentId !== args.documentId) {
      throw new ConvexError({ code: "NOT_FOUND" });
    }
    if (job.status !== "running") throw new ConvexError({ code: "JOB_NOT_RUNNING" });
    if (job.contentVersionKey !== undefined && job.contentVersionKey !== args.contentVersionKey) {
      throw new ConvexError({ code: "CONTENT_VERSION_CONFLICT" });
    }
    if (args.chunks.length > MAX_CHUNKS) throw new ConvexError({ code: "CHUNKS_TOO_LARGE" });
    for (let index = 0; index < args.chunks.length; index += 1) {
      if (args.chunks[index].seq !== index) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    }
    const document = await ctx.db.get(job.documentId);
    if (document === null || document.ownerId !== job.ownerId || document.projectId !== job.projectId) {
      throw new ConvexError({ code: "NOT_FOUND" });
    }

    const existing = await ctx.db
      .query("documentChunks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .take(MAX_CHUNKS + 1);
    if (existing.length > MAX_CHUNKS) throw new ConvexError({ code: "CHUNKS_TOO_LARGE" });

    const now = Date.now();
    const byKey = new Map(existing.map((chunk) => [chunk.chunkKey, chunk]));
    let fresh = 0;
    for (const chunk of args.chunks) {
      const chunkKey = `${args.contentVersionKey}#${chunk.seq}`;
      const found = byKey.get(chunkKey);
      if (found !== undefined) {
        const identical =
          found.text === chunk.text &&
          found.contentHash === chunk.contentHash &&
          found.locator.blockIndex === chunk.locator.blockIndex &&
          found.locator.page === chunk.locator.page &&
          found.locator.heading === chunk.locator.heading;
        if (!identical) throw new ConvexError({ code: "CHUNK_CONFLICT" });
        continue;
      }
      await ctx.db.insert("documentChunks", {
        ownerId: args.ownerId,
        projectId: args.projectId,
        documentId: args.documentId,
        contentVersionKey: args.contentVersionKey,
        seq: chunk.seq,
        chunkKey,
        text: chunk.text,
        contentHash: chunk.contentHash,
        locator: chunk.locator,
        createdAt: now,
      });
      fresh += 1;
    }
    for (const chunk of existing) {
      if (chunk.contentVersionKey !== args.contentVersionKey) await ctx.db.delete(chunk._id);
    }
    if (job.contentVersionKey === undefined) await ctx.db.patch(job._id, { contentVersionKey: args.contentVersionKey });
    return { chunkCount: args.chunks.length, fresh };
  },
});

/** Lease-guarded success: job succeeded and document ready. */
export const completeJob = internalMutation({
  args: {
    jobId: v.id("ingestionJobs"),
    workerId: v.string(),
    contentVersionKey: v.string(),
    chunkCount: v.number(),
  },
  returns: v.object({ status: v.literal("succeeded"), chunkCount: v.number() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) throw new ConvexError({ code: "NOT_FOUND" });
    requireRunningLease(job, args.workerId);
    if (job.contentVersionKey !== undefined && job.contentVersionKey !== args.contentVersionKey) {
      throw new ConvexError({ code: "CONTENT_VERSION_CONFLICT" });
    }
    await settleJob(ctx, job, "succeeded", null, {
      contentVersionKey: args.contentVersionKey,
      chunkCount: args.chunkCount,
    });
    return { status: "succeeded" as const, chunkCount: args.chunkCount };
  },
});

/**
 * Lease-guarded retryable failure: bounded exponential backoff back to
 * `queued`, or the `failed` dead letter when the attempt budget is exhausted.
 * Only the stable code is stored; error messages are never persisted.
 */
export const recordFailure = internalMutation({
  args: { jobId: v.id("ingestionJobs"), workerId: v.string(), failureCode: v.string() },
  returns: v.object({
    state: v.union(v.literal("queued"), v.literal("failed")),
    attempts: v.number(),
    nextAttemptAt: v.union(v.null(), v.number()),
  }),
  handler: async (ctx, args) => {
    if (!FAILURE_CODE_PATTERN.test(args.failureCode)) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const job = await ctx.db.get(args.jobId);
    if (job === null) throw new ConvexError({ code: "NOT_FOUND" });
    requireRunningLease(job, args.workerId);
    const now = Date.now();
    if (job.attempts >= (job.maxAttempts ?? configuredMaxAttempts())) {
      await settleJob(ctx, job, "failed", args.failureCode);
      return { state: "failed" as const, attempts: job.attempts, nextAttemptAt: null };
    }
    const nextAttemptAt = now + backoffDelayMs(job.attempts, configuredBackoffBaseMs());
    await ctx.db.patch(job._id, {
      status: "queued",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt,
      failureCode: args.failureCode,
      updatedAt: now,
    });
    return { state: "queued" as const, attempts: job.attempts, nextAttemptAt };
  },
});

/**
 * Lease-guarded terminal unsupported state for deterministic input problems
 * (encrypted PDF, image-only scan, unsupported media, oversized input).
 * It is never retried: the same input would fail the same way.
 */
export const markUnsupported = internalMutation({
  args: { jobId: v.id("ingestionJobs"), workerId: v.string(), failureCode: v.string() },
  returns: v.object({ state: v.literal("unsupported"), attempts: v.number() }),
  handler: async (ctx, args) => {
    if (!FAILURE_CODE_PATTERN.test(args.failureCode)) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const job = await ctx.db.get(args.jobId);
    if (job === null) throw new ConvexError({ code: "NOT_FOUND" });
    requireRunningLease(job, args.workerId);
    await settleJob(ctx, job, "unsupported", args.failureCode);
    return { state: "unsupported" as const, attempts: job.attempts };
  },
});

const jobStatusResult = v.object({
  _id: v.id("ingestionJobs"),
  documentId: v.id("documents"),
  status: jobStatus,
  attempts: v.number(),
  maxAttempts: v.number(),
  failureCode: v.union(v.null(), v.string()),
  nextAttemptAt: v.union(v.null(), v.number()),
  chunkCount: v.union(v.null(), v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

/** The client-facing job status surface: metadata only, never content. */
export const listIngestionJobs = query({
  args: { projectId: v.id("projects") },
  returns: v.array(jobStatusResult),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const jobs = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId))
      .order("desc")
      .collect();
    const defaultMaxAttempts = configuredMaxAttempts();
    return jobs.map((job) => ({
      _id: job._id,
      documentId: job.documentId,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts ?? defaultMaxAttempts,
      failureCode: job.failureCode ?? null,
      nextAttemptAt: job.nextAttemptAt ?? null,
      chunkCount: job.chunkCount ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));
  },
});

async function executeClaim(ctx: ActionCtx, claim: Claim, workerId: string): Promise<string> {
  try {
    const context = await ctx.runQuery(internal.ingestion.getJobContext, { jobId: claim.jobId });
    if (context === null) return "missing";
    const blob = await ctx.storage.get(context.storageId);
    if (blob === null) return recordFailureOutcome(ctx, claim, workerId, "STORAGE_MISSING");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parsed = await parseDocument({
      bytes,
      contentType: context.contentType,
      limits: { maxDurationMs: configuredParseTimeoutMs() },
    });
    const contentVersionKey = contentVersionKeyFor(bytes);
    const chunks = defaultProcessStep({ document: parsed, contentVersionKey });
    if (chunks.length === 0) return markUnsupportedOutcome(ctx, claim, workerId, "NO_EXTRACTABLE_TEXT");
    await ctx.runMutation(internal.ingestion.commitChunks, {
      jobId: claim.jobId,
      documentId: claim.documentId,
      ownerId: claim.ownerId,
      projectId: claim.projectId,
      contentVersionKey,
      chunks: chunks.map((chunk) => ({
        seq: chunk.seq,
        text: chunk.text,
        contentHash: chunk.contentHash,
        locator: chunk.locator,
      })),
    });
    await ctx.runMutation(internal.ingestion.completeJob, {
      jobId: claim.jobId,
      workerId,
      contentVersionKey,
      chunkCount: chunks.length,
    });
    return "succeeded";
  } catch (error) {
    const code = parserErrorCode(error);
    if (code !== null && isUnsupportedParserCode(code)) return markUnsupportedOutcome(ctx, claim, workerId, code);
    const failureCode = code ?? functionErrorCode(error) ?? "PARSE_FAILED";
    return recordFailureOutcome(ctx, claim, workerId, failureCode);
  }
}

async function recordFailureOutcome(ctx: ActionCtx, claim: Claim, workerId: string, failureCode: string): Promise<string> {
  const code = FAILURE_CODE_PATTERN.test(failureCode) ? failureCode : "PARSE_FAILED";
  try {
    const result = await ctx.runMutation(internal.ingestion.recordFailure, { jobId: claim.jobId, workerId, failureCode: code });
    return result.state === "failed" ? "dead_letter" : "retry_scheduled";
  } catch (error) {
    return staleOutcome(error);
  }
}

async function markUnsupportedOutcome(ctx: ActionCtx, claim: Claim, workerId: string, failureCode: string): Promise<string> {
  try {
    await ctx.runMutation(internal.ingestion.markUnsupported, { jobId: claim.jobId, workerId, failureCode });
    return "unsupported";
  } catch (error) {
    return staleOutcome(error);
  }
}

function staleOutcome(error: unknown): string {
  const code = functionErrorCode(error);
  if (code === "LEASE_LOST" || code === "JOB_NOT_RUNNING") return "stale";
  return "error";
}

/**
 * One bounded runner cycle: claim up to `maxJobs` eligible jobs and execute
 * the parse/process/commit stages for each inside this action. A crash leaves
 * the lease to expire; nothing here runs inside an HTTP request.
 */
export const runIngestionCycle = internalAction({
  args: {
    workerId: v.optional(v.string()),
    maxJobs: v.optional(v.number()),
  },
  returns: v.object({
    workerId: v.string(),
    processed: v.number(),
    outcomes: v.array(v.object({ jobId: v.id("ingestionJobs"), outcome: v.string() })),
  }),
  handler: async (ctx, args) => {
    const workerId = args.workerId ?? `ingestion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!WORKER_ID_PATTERN.test(workerId)) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const requested = args.maxJobs ?? CYCLE_MAX_JOBS_DEFAULT;
    const maxJobs = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), CYCLE_MAX_JOBS_LIMIT) : CYCLE_MAX_JOBS_DEFAULT;
    const outcomes: { jobId: Id<"ingestionJobs">; outcome: string }[] = [];
    for (let index = 0; index < maxJobs; index += 1) {
      const claim = await ctx.runMutation(internal.ingestion.claimNextJob, { workerId });
      if (claim === null) break;
      outcomes.push({ jobId: claim.jobId, outcome: await executeClaim(ctx, claim, workerId) });
    }
    return { workerId, processed: outcomes.length, outcomes };
  },
});
