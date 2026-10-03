import type { PublicHttpAction } from "convex/server";
import { ConvexError, v } from "convex/values";

import { corsHeaders, readCorsAllowlist } from "./cors";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUserId } from "./projects";

/**
 * S24 bounded observability: tenant-aware request throttling, redacted
 * telemetry and the retention/rotation hooks, all on one boundary.
 *
 * Redaction is a construction guarantee, not a filter: telemetry rows are
 * built from an allowlisted field set whose free strings are gated by fixed
 * patterns (`buildTelemetryRow`), and the table validator fixes the columns,
 * so a prompt, transcript, document byte or credential has no field it could
 * enter through. `LOG_RETENTION_DAYS` bounds every row's life and the hourly
 * `cleanupTelemetry` cron is the rotation step. Rate limiting is a
 * protection, not an authorization check: identity and project ownership are
 * always re-derived inside the wrapped handler, and a limiter storage failure
 * fails open so a counter blip can never take a route down or bypass a
 * permission check.
 */

/* ------------------------------------------------------------------ *
 * Configuration (bounded, validated; malformed values fall back)
 * ------------------------------------------------------------------ */

export const DEFAULT_RATE_LIMIT_REQUESTS = 60;
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DEFAULT_LOG_RETENTION_DAYS = 30;

export function rateLimitRequests(): number {
  const raw = Number(process.env.RATE_LIMIT_REQUESTS);
  if (!Number.isFinite(raw)) return DEFAULT_RATE_LIMIT_REQUESTS;
  return Math.min(Math.max(Math.trunc(raw), 1), 10_000);
}

export function rateLimitWindowMs(): number {
  const raw = Number(process.env.RATE_LIMIT_WINDOW_SECONDS);
  if (!Number.isFinite(raw)) return DEFAULT_RATE_LIMIT_WINDOW_SECONDS * 1000;
  return Math.min(Math.max(Math.trunc(raw), 1), 3_600) * 1000;
}

export function logRetentionMs(): number {
  const raw = Number(process.env.LOG_RETENTION_DAYS);
  if (!Number.isFinite(raw)) return DEFAULT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const days = Math.min(Math.max(Math.trunc(raw), 1), 365);
  return days * 24 * 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ *
 * Redaction contract
 * ------------------------------------------------------------------ */

/** Every telemetry event name; anything else can never become a row. */
export const TELEMETRY_EVENTS = [
  "stt-transcribe",
  "translation-audio",
  "translation-text",
  "tts-synthesize",
  "private-upload",
  "tutor-turn",
] as const;
export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number];

export const TELEMETRY_STATUSES = ["ok", "denied", "rejected", "rate-limited", "cancelled", "error"] as const;
export type TelemetryStatus = (typeof TELEMETRY_STATUSES)[number];

/** Ids: no whitespace, bounded, punctuation that only identifiers use. */
const TRACE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const OWNER_ID_PATTERN = /^[A-Za-z0-9:_.|-]{1,160}$/;

/**
 * The complete set of failure codes telemetry may store — an explicit
 * allowlist, not a shape test, so a key-shaped secret (`AKIA…`, `SK_…`) can
 * never qualify by looking like a token. A code outside the set is dropped
 * from the row (the row itself is kept): adding a new failure code to
 * telemetry is a deliberate, reviewed change.
 */
export const TELEMETRY_CODES = new Set<string>([
  // shared route and argument outcomes
  "CANCELLED",
  "CONCEPT_SELECTION_REQUIRED",
  "ACTIVITY_NOT_QUESTION_FIRST",
  "DELETION_FAILED",
  "EMPTY_FILE",
  "FORBIDDEN",
  "INTERNAL_ERROR",
  "INVALID_ARGUMENT",
  "INVALID_BODY",
  "INVALID_FILENAME",
  "NOT_AUTHORIZED",
  "NOT_FOUND",
  "PROVIDER_POLICY_BLOCKED",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "RETRY_NOT_ALLOWED",
  "SILENCE",
  "TEXT_TOO_LARGE",
  "UNAUTHENTICATED",
  "UNSUPPORTED_CODEC",
  "UNSUPPORTED_CONTENT",
  "UNSUPPORTED_LANGUAGE_PAIR",
  "UNSUPPORTED_MEDIA_TYPE",
  "UPLOAD_FAILED",
  // upload/audio size and duration caps
  "AUDIO_TOO_LARGE",
  "AUDIO_TOO_LONG",
  "AUDIO_TRANSLATION_UNSUPPORTED",
  "FILE_TOO_LARGE",
  // per-route provider outcomes (STT / TRANSLATION / TTS)
  "STT_NOT_CONFIGURED",
  "STT_RATE_LIMITED",
  "STT_TIMEOUT",
  "STT_PROVIDER_ERROR",
  "STT_PROVIDER_UNAVAILABLE",
  "STT_BAD_PROVIDER_RESPONSE",
  "STT_PROVIDER_REJECTED",
  "TRANSLATION_NOT_CONFIGURED",
  "TRANSLATION_RATE_LIMITED",
  "TRANSLATION_TIMEOUT",
  "TRANSLATION_PROVIDER_ERROR",
  "TRANSLATION_PROVIDER_UNAVAILABLE",
  "TRANSLATION_BAD_PROVIDER_RESPONSE",
  "TRANSLATION_PROVIDER_REJECTED",
  "TTS_NOT_CONFIGURED",
  "TTS_RATE_LIMITED",
  "TTS_TIMEOUT",
  "TTS_PROVIDER_ERROR",
  "TTS_PROVIDER_UNAVAILABLE",
  "TTS_BAD_PROVIDER_RESPONSE",
  "TTS_PROVIDER_REJECTED",
  // tutor/concept turn outcomes recorded by `failTurn` and `commitTurn`
  "TURN_ANSWER_TOO_LONG",
  "TURN_ATTEMPT_LOST",
  "TURN_CANCELLED",
  "TURN_CONCURRENCY_LIMIT",
  "TURN_FAILED",
  "TURN_INCOMPLETE",
  "TURN_IN_PROGRESS",
  "TURN_INPUT_TOO_LARGE",
  "TURN_NOT_ACTIVITY",
  "TURN_NOT_CONFIGURED",
  "TURN_POLICY_BLOCKED",
  "TURN_PROVIDER_ERROR",
  "TURN_PROVIDER_MALFORMED",
  "TURN_PROVIDER_UNSUPPORTED",
  "TURN_RATE_LIMITED",
  "TURN_RETRIES_EXHAUSTED",
  "TURN_TIMEOUT",
  "CITATION_INVALID",
  "CITATION_NOT_RETRIEVED",
]);

const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 100;

export type TelemetryInput = {
  traceId: string;
  ownerId: string;
  projectId: Id<"projects">;
  event: string;
  status: string;
  durationMs?: number;
  code?: string;
  retryAfterMs?: number;
  attempts?: number;
};

export type TelemetryRow = {
  traceId: string;
  ownerId: string;
  projectId: Id<"projects">;
  event: TelemetryEvent;
  status: TelemetryStatus;
  durationMs?: number;
  code?: string;
  retryAfterMs?: number;
  attempts?: number;
  createdAt: number;
};

const boundedNumber = (value: number | undefined, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.trunc(value) : undefined;

/**
 * Builds a telemetry row from allowlisted inputs only. Unknown events,
 * statuses or identifier shapes drop the whole row; an out-of-range or
 * non-token `code`/timing drops just that field. Nothing else a caller could
 * attach is ever copied — that is what makes the canary assertions true by
 * construction.
 */
export function buildTelemetryRow(input: TelemetryInput, now: number = Date.now()): TelemetryRow | null {
  if (!(TELEMETRY_EVENTS as readonly string[]).includes(input.event)) return null;
  if (!(TELEMETRY_STATUSES as readonly string[]).includes(input.status)) return null;
  if (!TRACE_ID_PATTERN.test(input.traceId)) return null;
  if (!OWNER_ID_PATTERN.test(input.ownerId)) return null;
  const row: TelemetryRow = {
    traceId: input.traceId,
    ownerId: input.ownerId,
    projectId: input.projectId,
    event: input.event as TelemetryEvent,
    status: input.status as TelemetryStatus,
    createdAt: now,
  };
  const durationMs = boundedNumber(input.durationMs, MAX_DURATION_MS);
  if (durationMs !== undefined) row.durationMs = durationMs;
  if (typeof input.code === "string" && TELEMETRY_CODES.has(input.code)) row.code = input.code;
  const retryAfterMs = boundedNumber(input.retryAfterMs, MAX_RETRY_AFTER_MS);
  if (retryAfterMs !== undefined) row.retryAfterMs = retryAfterMs;
  const attempts = boundedNumber(input.attempts, MAX_ATTEMPTS);
  if (attempts !== undefined) row.attempts = attempts;
  return row;
}

/* ------------------------------------------------------------------ *
 * Rate limiting (fixed window per learner and route)
 * ------------------------------------------------------------------ */

export type RateLimitState = { windowStart: number; count: number };
export type RateLimitOutcome = { allowed: boolean; state: RateLimitState; retryAfterMs: number };

/**
 * Pure fixed-window decision: the request that crosses the limit is denied
 * with the exact time until the window rolls, so both the `Retry-After`
 * header and the next-attempt timing are testable arithmetic instead of a
 * sleep.
 */
export function applyRateLimit(state: RateLimitState, limit: number, windowMs: number, now: number): RateLimitOutcome {
  if (now >= state.windowStart + windowMs) {
    return { allowed: true, state: { windowStart: now, count: 1 }, retryAfterMs: 0 };
  }
  const count = state.count + 1;
  if (count <= limit) return { allowed: true, state: { windowStart: state.windowStart, count }, retryAfterMs: 0 };
  return { allowed: false, state, retryAfterMs: Math.max(1, state.windowStart + windowMs - now) };
}

const bucketPattern = /^[a-z0-9-]{1,32}$/;

/**
 * Consumes one request from the learner's bucket and resolves the request's
 * project scope. Internal (server-caller) contract: `ownerId` comes from the
 * wrapper's `ctx.auth` derivation, never from the client, and `now` is an
 * optional override so tests can drive the window deterministically.
 */
export const consumeRequest = internalMutation({
  args: {
    ownerId: v.string(),
    bucket: v.string(),
    projectId: v.string(),
    limit: v.number(),
    windowMs: v.number(),
    now: v.optional(v.number()),
  },
  returns: v.object({
    allowed: v.boolean(),
    retryAfterMs: v.number(),
    projectId: v.union(v.null(), v.id("projects")),
  }),
  handler: async (ctx, args) => {
    if (!bucketPattern.test(args.bucket)) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const now = args.now ?? Date.now();

    let projectId: Id<"projects"> | null = null;
    const normalized = ctx.db.normalizeId("projects", args.projectId);
    if (normalized !== null) {
      const project = await ctx.db.get(normalized);
      if (project !== null && project.ownerId === args.ownerId && project.deletedAt === null) projectId = normalized;
    }

    const rows = await ctx.db
      .query("rateLimitBuckets")
      .withIndex("by_owner_bucket", (q) => q.eq("ownerId", args.ownerId).eq("bucket", args.bucket))
      .take(10);
    let active: { _id: Id<"rateLimitBuckets">; windowStart: number; count: number } | null = null;
    for (const row of rows) {
      if (active === null || row.windowStart > active.windowStart) {
        if (active !== null) await ctx.db.delete(active._id);
        active = row;
      } else {
        await ctx.db.delete(row._id);
      }
    }

    const previous: RateLimitState = active === null ? { windowStart: now, count: 0 } : { windowStart: active.windowStart, count: active.count };
    const outcome = applyRateLimit(previous, args.limit, args.windowMs, now);
    if (active === null) {
      await ctx.db.insert("rateLimitBuckets", {
        ownerId: args.ownerId,
        bucket: args.bucket,
        windowStart: outcome.state.windowStart,
        count: outcome.state.count,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(active._id, {
        windowStart: outcome.state.windowStart,
        count: outcome.state.count,
        updatedAt: now,
      });
    }
    return { allowed: outcome.allowed, retryAfterMs: outcome.retryAfterMs, projectId };
  },
});

/* ------------------------------------------------------------------ *
 * Telemetry storage and retention
 * ------------------------------------------------------------------ */

/** Re-verifies the (owner, project) pair before a row may exist. */
async function ownedProject(ctx: MutationCtx, ownerId: string, projectId: Id<"projects">): Promise<boolean> {
  const project = await ctx.db.get(projectId);
  return project !== null && project.ownerId === ownerId && project.deletedAt === null;
}

export const recordRouteEvent = internalMutation({
  args: {
    traceId: v.string(),
    ownerId: v.string(),
    projectId: v.id("projects"),
    event: v.string(),
    status: v.string(),
    durationMs: v.optional(v.number()),
    code: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
    attempts: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await ownedProject(ctx, args.ownerId, args.projectId))) return null;
    const row = buildTelemetryRow(args);
    if (row !== null) await ctx.db.insert("telemetryEvents", row);
    return null;
  },
});

/** Inserts an already-built row (turn telemetry lives in the turn's own transaction). */
export async function insertTelemetryRow(ctx: MutationCtx, input: TelemetryInput): Promise<void> {
  const row = buildTelemetryRow(input);
  if (row !== null) await ctx.db.insert("telemetryEvents", row);
}

export const TELEMETRY_CLEANUP_BATCH = 100;

/**
 * Retention rotation: deletes the oldest expired rows in one bounded batch,
 * so a full table drains over scheduled runs instead of one unbounded
 * mutation. Hourly from `crons.ts`; `LOG_RETENTION_DAYS` sets the cutoff.
 */
export const cleanupTelemetry = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - logRetentionMs();
    const rows = await ctx.db
      .query("telemetryEvents")
      .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
      .take(TELEMETRY_CLEANUP_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length, hasMore: rows.length === TELEMETRY_CLEANUP_BATCH };
  },
});

/* ------------------------------------------------------------------ *
 * HTTP route wrapper
 * ------------------------------------------------------------------ */

export type RouteObservabilityOptions = {
  /** Allowlisted event name; doubles as the rate-limit bucket. */
  event: TelemetryEvent;
  /** Attach the route's CORS headers to wrapper-generated responses. */
  cors?: boolean;
};

/** The callable shape behind Convex's `PublicHttpAction` marker. */
type RawHttpHandler = (ctx: ActionCtx, request: Request) => Promise<Response>;

export function newTraceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function retryAfterHeader(value: unknown): Record<string, string> {
  const ms = typeof value === "object" && value !== null && typeof (value as { retryAfterMs?: unknown }).retryAfterMs === "number"
    ? (value as { retryAfterMs: number }).retryAfterMs
    : null;
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return {};
  return { "retry-after": String(Math.max(1, Math.ceil(ms / 1000))) };
}

function classifyStatus(status: number): TelemetryStatus {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403 || status === 404) return "denied";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "rejected";
  return "error";
}

/** Reads only the typed `code`/`retryAfterMs` a route already produced. */
async function responseDetails(response: Response): Promise<{ code?: string; retryAfterMs?: number }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  try {
    const body: unknown = await response.clone().json();
    if (typeof body !== "object" || body === null) return {};
    const record = body as { code?: unknown; retryAfterMs?: unknown };
    const out: { code?: string; retryAfterMs?: number } = {};
    if (typeof record.code === "string") out.code = record.code;
    if (typeof record.retryAfterMs === "number") out.retryAfterMs = record.retryAfterMs;
    return out;
  } catch {
    return {};
  }
}

function attachTraceId(response: Response, traceId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-trace-id", traceId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function emitRouteEvent(
  ctx: ActionCtx,
  input: {
    traceId: string;
    ownerId: string;
    projectId: Id<"projects">;
    event: TelemetryEvent;
    status: TelemetryStatus;
    durationMs: number;
    code?: string;
    retryAfterMs?: number;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.observability.recordRouteEvent, input);
  } catch {
    // Telemetry is never allowed to fail or delay a user request.
  }
}

/**
 * Wraps one authenticated HTTP action with the S24 boundary: identity first,
 * then the per-learner rate-limit bucket (429 + `Retry-After` when exhausted),
 * then the handler, then one redacted telemetry row for requests that resolved
 * to a project the caller owns. Anonymous requests, requests whose project is
 * foreign or malformed, and telemetry/limiter storage failures all fall
 * through to the handler's own checks — this wrapper adds protection, never
 * authorization, and never invents a denial the handler would not make.
 */
export function observedRoute(options: RouteObservabilityOptions, handler: PublicHttpAction) {
  // `httpAction` erases the call signature to the `{ isHttp: true }` marker;
  // the value is still the wrapped function at runtime.
  const run = handler as unknown as RawHttpHandler;
  return httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const traceId = newTraceId();
    const cors = options.cors === true ? corsHeaders(request.headers.get("Origin"), readCorsAllowlist()) : {};

    let ownerId: string | null = null;
    try {
      ownerId = await requireUserId(ctx);
    } catch {
      ownerId = null;
    }
    if (ownerId === null) return attachTraceId(await run(ctx, request), traceId);

    const projectIdParam = new URL(request.url).searchParams.get("projectId") ?? "";
    let decision: { allowed: boolean; retryAfterMs: number; projectId: Id<"projects"> | null } | null = null;
    try {
      decision = await ctx.runMutation(internal.observability.consumeRequest, {
        ownerId,
        bucket: options.event,
        projectId: projectIdParam,
        limit: rateLimitRequests(),
        windowMs: rateLimitWindowMs(),
      });
    } catch {
      decision = null; // fail open: throttling must never take a route down
    }

    if (decision !== null && !decision.allowed) {
      const retryAfterMs = decision.retryAfterMs;
      if (decision.projectId !== null) {
        await emitRouteEvent(ctx, {
          traceId,
          ownerId,
          projectId: decision.projectId,
          event: options.event,
          status: "rate-limited",
          durationMs: Date.now() - startedAt,
          code: "RATE_LIMITED",
          retryAfterMs,
        });
      }
      return new Response(JSON.stringify({ code: "RATE_LIMITED", retryAfterMs }), {
        status: 429,
        headers: {
          ...cors,
          "content-type": "application/json",
          "cache-control": "private, no-store",
          "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
          "x-trace-id": traceId,
        },
      });
    }

    const response = await run(ctx, request);
    const scopedProjectId = decision?.projectId ?? null;
    if (scopedProjectId !== null) {
      const details = await responseDetails(response);
      await emitRouteEvent(ctx, {
        traceId,
        ownerId,
        projectId: scopedProjectId,
        event: options.event,
        status: classifyStatus(response.status),
        durationMs: Date.now() - startedAt,
        ...(details.code === undefined ? {} : { code: details.code }),
        ...(details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs }),
      });
    }
    return attachTraceId(response, traceId);
  });
}
