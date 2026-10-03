import {
  OBJECTIVE_MAX_CHARS,
  TUTOR_CONTEXT_CHARS,
  TUTOR_TOP_K,
  buildConceptSystemPrompt,
  buildTutorUserMessage,
  extractCitationMarkers,
  questionFirstSatisfied,
  resolveActivityOutcome,
  runTutorTurn,
  TutorTurnError,
  tutorFailureFor,
  type ActivityOutcome,
  type ConceptActivity,
  type TutorEvidence,
  type TutorEvidenceMode,
} from "@learn-anything/worker";
import { ConvexError, v } from "convex/values";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./projects";
import {
  evidenceValidator,
  requireLearnerText,
  requireTurnId,
  resolveSessionKey,
  safeFailTurn,
  storedCitationValidator,
  tutorCancelPollMs,
  tutorClient,
  tutorMaxAttempts,
  tutorRetryBaseMs,
  TURN_LEASE_MS,
  type AnswerBasis,
} from "./tutor";

/**
 * S20 concept-learning mode: objective/difficulty selection, the explain /
 * socratic / teach-back / short-quiz activities, and progress events with
 * reversible user feedback on the S04 `progressEvents` schema.
 *
 * ## Order of operations (test-locked)
 *
 * 1. authentication (`UNAUTHENTICATED` without an identity),
 * 2. argument validation (turn id, learner text, activity literal),
 * 3. project ownership + selection (`NOT_FOUND` for a foreign or deleted
 *    project, `CONCEPT_SELECTION_REQUIRED` before any turn row, retrieval or
 *    provider call when objective/difficulty are not selected yet),
 * 4. session resolution and `beginTurn` — the S14 idempotency/cancellation
 *    linearization point, reused unchanged (the S14 orchestrator itself is not
 *    rewritten; `tutor.ts` only exports the primitives this action composes),
 * 5. provider client resolution (`TURN_NOT_CONFIGURED` when no key exists;
 *    the S11 single-user policy gate applies, no other provider is constructed),
 * 6. query embedding + S13 retrieval (project-scoped filter and recheck),
 * 7. `recordRetrieval` — freezes the retrieved chunk ids for this attempt,
 * 8. prompt build (system = goal/objective/difficulty/activity/evidence mode
 *    only; learner text, history and passages travel in the S14 JSON envelope),
 * 9. streamed completion through the S11 `streamTutor` with bounded retries,
 * 10. the question-first guard: an asking activity whose reply neither asks a
 *     question nor carries a checked verdict fails the turn visibly
 *     (`ACTIVITY_NOT_QUESTION_FIRST`) instead of storing a lecture-only reply,
 * 11. `commitTurn` — the S14 write path validates every citation against the
 *     frozen retrieval set and the live owned chunk/document, then writes both
 *     messages and their citations together, or nothing at all,
 * 12. `recordActivityEvent` — one `activity-completed` progress event keyed by
 *     the turn's idempotency key, with the selection snapshot, the explicit
 *     outcome (`correct`/`partially-correct`/`wrong`/`uncertain` from the
 *     stored `Verdict:` line, never an invented grade), the evidence status
 *     and the verified chunk references the feedback links to.
 *
 * ## Feedback and honesty contracts
 *
 * `recordFeedback` attaches one active `helpful`/`not-helpful` event to an
 * `activity-completed` event; `retractFeedback` undoes it (marks the row with
 * `retractedAt`) **and** records the reversal as a `feedback-retracted` event,
 * so the undo is durable and the row can be rated again afterwards. Wrong,
 * partial and uncertain answers are recorded as explicit outcomes and never
 * rewritten as document facts: without evidence the stored feedback carries
 * the S14 `NO_EVIDENCE_STATEMENT` prefix composed server-side, fabricated
 * markers never become citations, and nothing here guarantees a learning
 * outcome or invents authoritative advice.
 *
 * ## Scope
 *
 * No language practice (S19), no chat UI, no external action tools, and no
 * provider other than NaN. Selection, activities and progress events are
 * concept-mode surfaces; the S14 `runTurn` path is untouched.
 */

/** Bounded progress-event reads; one page is at most this many events. */
export const PROGRESS_EVENT_LIMIT_DEFAULT = 50;
export const PROGRESS_EVENT_LIMIT_MAX = 200;
/** One activity event references at most the S14 citation maximum of chunks. */
const MAX_EVENT_REFERENCES = 50;

const activityValidator = v.union(v.literal("explain"), v.literal("socratic"), v.literal("teach-back"), v.literal("quiz"));
const difficultyValidator = v.union(v.literal("beginner"), v.literal("intermediate"), v.literal("advanced"));
const outcomeValidator = v.union(
  v.literal("completed"),
  v.literal("correct"),
  v.literal("partially-correct"),
  v.literal("wrong"),
  v.literal("uncertain"),
);
const feedbackValueValidator = v.union(v.literal("helpful"), v.literal("not-helpful"));
const evidenceStatusValidator = v.union(v.literal("ok"), v.literal("insufficient-evidence"));
/**
 * The concept surface reports only the two bases a concept reply can have.
 * The shared tutor `answerBasisValidator` is wider (S19 added `translation`),
 * which `conceptAnswerBasis` below narrows before anything is written.
 */
const conceptAnswerBasisValidator = v.union(v.literal("document-backed"), v.literal("general-explanation"));
const referenceValidator = v.object({
  chunkId: v.id("documentChunks"),
  documentId: v.id("documents"),
  seq: v.number(),
  page: v.union(v.null(), v.number()),
  heading: v.union(v.null(), v.string()),
});

type Reference = {
  chunkId: Id<"documentChunks">;
  documentId: Id<"documents">;
  seq: number;
  page: number | null;
  heading: string | null;
};

const activityResultValidator = v.object({
  turnId: v.string(),
  sessionId: v.id("learningSessions"),
  status: v.literal("completed"),
  activity: activityValidator,
  outcome: outcomeValidator,
  answerBasis: conceptAnswerBasisValidator,
  text: v.string(),
  citations: v.array(storedCitationValidator),
  evidence: evidenceValidator,
  unresolvedMarkers: v.number(),
  providerAttempts: v.number(),
  replayed: v.boolean(),
  progressEventId: v.id("progressEvents"),
});

type ActivityResult = {
  turnId: string;
  sessionId: Id<"learningSessions">;
  status: "completed";
  activity: ConceptActivity;
  outcome: ActivityOutcome;
  answerBasis: ConceptAnswerBasis;
  text: string;
  citations: Array<{
    rank: number;
    retrievalRank: number;
    documentId: Id<"documents">;
    chunkId: Id<"documentChunks">;
    seq: number;
    contentHash: string;
    page: number | null;
    heading: string | null;
  }>;
  evidence: { status: "ok" | "insufficient-evidence"; reason: string | null };
  unresolvedMarkers: number;
  providerAttempts: number;
  replayed: boolean;
  progressEventId: Id<"progressEvents">;
};

const progressEventValidator = v.object({
  _id: v.id("progressEvents"),
  eventType: v.string(),
  createdAt: v.number(),
  turnId: v.union(v.null(), v.string()),
  activity: v.union(v.null(), activityValidator),
  objective: v.union(v.null(), v.string()),
  difficulty: v.union(v.null(), difficultyValidator),
  outcome: v.union(v.null(), outcomeValidator),
  evidence: v.union(v.null(), evidenceStatusValidator),
  targetEventId: v.union(v.null(), v.id("progressEvents")),
  feedbackValue: v.union(v.null(), feedbackValueValidator),
  retractedAt: v.union(v.null(), v.number()),
  references: v.array(referenceValidator),
});

/** Non-enumerating typed code raised by this module's write path. */
function conceptError(code: string): ConvexError<{ code: string }> {
  return new ConvexError({ code });
}

/** The two grounding bases a concept activity result may report. */
type ConceptAnswerBasis = "document-backed" | "general-explanation";

/**
 * Narrows the shared tutor `AnswerBasis` to the concept result surface.
 *
 * S19 widened `AnswerBasis` with `translation` for language-practice turns.
 * `runActivity` never writes that basis itself — its `commitTurn` call passes
 * no `answerKind`, so the orchestrator resolves `document-backed` or
 * `general-explanation` from the retrieved evidence — but the shared turn
 * store can hold an S19 translation turn under a replayed `turnId` (or hand
 * one back from `commitTurn`'s completed-turn fast path). The concept result
 * has no member for it, so such a turn is rejected with a typed
 * `TURN_NOT_ACTIVITY` instead of being relabelled as a concept basis or cast
 * away: no activity event is recorded for a turn this action did not run.
 */
function conceptAnswerBasis(basis: AnswerBasis): ConceptAnswerBasis {
  switch (basis) {
    case "document-backed":
    case "general-explanation":
      return basis;
    case "translation":
      throw conceptError("TURN_NOT_ACTIVITY");
  }
}

type TurnFailure = { code: string; retryAfterMs?: number };

/** Recovers a typed `{ code }` from an error raised by another Convex function. */
function convexErrorCode(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown };
    if (typeof data?.code === "string") return data.code;
  }
  return null;
}

/** Maps any provider/adapter failure to an observable turn code; Convex errors keep their own. */
function turnFailureCode(error: unknown): TurnFailure {
  const typed = convexErrorCode(error);
  if (typed !== null) return { code: typed };
  if (error instanceof TutorTurnError) {
    return { code: error.code, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) };
  }
  const failure = tutorFailureFor(error);
  return { code: failure.code, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
}

/**
 * How many of the newest feedback rows are examined for one target. Documented
 * bound: `recordFeedback` refuses to insert while an active row exists, so at
 * most one active row exists per target and it is always the newest
 * `feedback-given` row — the window only has to be non-empty to find it.
 */
const FEEDBACK_SCAN_LIMIT = 50;

/**
 * The active (not yet retracted) feedback row for one activity target, or
 * `null`.
 *
 * The scan is deterministic: every candidate shares the same
 * `by_owner_project_target` key (`ownerId`, `projectId`, `targetEventId`), so
 * Convex breaks the tie by `_id`; `.order("desc")` therefore walks the window
 * newest-first (`_id` descending, matching insertion order), and the bound
 * above documents exactly how many rows that window covers. A `feedback-retracted`
 * event never appears here — it points at the feedback row it reverses, not at
 * the activity target — so every row in the window is a `feedback-given` row.
 */
async function activeFeedbackEvent(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  projectId: Id<"projects">,
  targetEventId: Id<"progressEvents">,
): Promise<Doc<"progressEvents"> | null> {
  const rows = await ctx.db
    .query("progressEvents")
    .withIndex("by_owner_project_target", (q) =>
      q.eq("ownerId", ownerId).eq("projectId", projectId).eq("targetEventId", targetEventId),
    )
    .order("desc")
    .take(FEEDBACK_SCAN_LIMIT);
  return (
    rows.find((row) => row.eventType === "feedback-given" && row.retractedAt === undefined) ?? null
  );
}

/**
 * Re-checks one stored reference against the live owned chunk and its ready
 * document — the same rendering-side rule the S14 transcript applies to
 * citations, so a progress event never displays a reference that no longer
 * resolves to an owned source.
 */
async function referenceResolves(
  ctx: QueryCtx,
  ownerId: string,
  projectId: Id<"projects">,
  reference: Reference,
): Promise<boolean> {
  const chunk = await ctx.db.get(reference.chunkId);
  if (
    chunk === null ||
    chunk.ownerId !== ownerId ||
    chunk.projectId !== projectId ||
    chunk.documentId !== reference.documentId
  ) {
    return false;
  }
  const document = await ctx.db.get(chunk.documentId);
  return (
    document !== null &&
    document.ownerId === ownerId &&
    document.projectId === projectId &&
    document.status === "ready"
  );
}

/* ------------------------------------------------------------------ *
 * Selection: objective and difficulty
 * ------------------------------------------------------------------ */

/** Owner-only read of the concept-learning selection; unset rows read as `null`. */
export const getSelection = query({
  args: { projectId: v.id("projects") },
  returns: v.object({ objective: v.union(v.null(), v.string()), difficulty: v.union(v.null(), difficultyValidator) }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const project = await requireOwnedProject(ctx, ownerId, args.projectId);
    return { objective: project.objective ?? null, difficulty: project.difficulty ?? null };
  },
});

/**
 * Stores the learner's objective and difficulty for concept activities. The
 * objective is trimmed free text capped at `OBJECTIVE_MAX_CHARS`; identity
 * comes only from `ctx.auth` and there is no clear path yet (documented
 * limit, mirroring the S21 `mode` selection).
 */
export const selectObjectiveAndDifficulty = mutation({
  args: { projectId: v.id("projects"), objective: v.string(), difficulty: difficultyValidator },
  returns: v.object({ objective: v.string(), difficulty: difficultyValidator }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const objective = args.objective.trim();
    if (objective === "") throw new ConvexError({ code: "INVALID_ARGUMENT" });
    if (objective.length > OBJECTIVE_MAX_CHARS) {
      throw new ConvexError({ code: "OBJECTIVE_TOO_LONG", maxChars: OBJECTIVE_MAX_CHARS });
    }
    await ctx.db.patch(args.projectId, { objective, difficulty: args.difficulty });
    return { objective, difficulty: args.difficulty };
  },
});

/** Ownership gate for the activity path: identity is server-derived, selection re-checked. */
export const authorizeConceptScope = internalQuery({
  args: { ownerId: v.string(), projectId: v.id("projects") },
  returns: v.object({
    goal: v.union(v.null(), v.string()),
    objective: v.union(v.null(), v.string()),
    difficulty: v.union(v.null(), difficultyValidator),
  }),
  handler: async (ctx, args) => {
    const project = await requireOwnedProject(ctx, args.ownerId, args.projectId);
    return { goal: project.goal ?? null, objective: project.objective ?? null, difficulty: project.difficulty ?? null };
  },
});

/* ------------------------------------------------------------------ *
 * Progress events and reversible feedback
 * ------------------------------------------------------------------ */

const activityEventResult = v.object({ eventId: v.id("progressEvents"), replayed: v.boolean() });

/**
 * The single write of an `activity-completed` progress event, called by
 * `runActivity` with the server-caller `ownerId` contract (S04-style; not a
 * public path). Idempotent per `(ownerId, projectId, idempotencyKey)`, so a
 * replayed turn can never produce a second event, and every reference is
 * re-checked against the live owned chunk and ready document before it is
 * stored.
 */
export const recordActivityEvent = internalMutation({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    turnId: v.string(),
    activity: activityValidator,
    objective: v.string(),
    difficulty: difficultyValidator,
    outcome: outcomeValidator,
    evidence: evidenceValidator,
    references: v.array(referenceValidator),
    idempotencyKey: v.string(),
  },
  returns: activityEventResult,
  handler: async (ctx, args): Promise<{ eventId: Id<"progressEvents">; replayed: boolean }> => {
    await requireOwnedProject(ctx, args.ownerId, args.projectId);
    if (args.references.length > MAX_EVENT_REFERENCES) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const turn = await ctx.db
      .query("tutorTurns")
      .withIndex("by_owner_project_turn", (q) =>
        q.eq("ownerId", args.ownerId).eq("projectId", args.projectId).eq("turnId", args.turnId),
      )
      .unique();
    if (turn === null) throw conceptError("NOT_FOUND");
    const existing = await ctx.db
      .query("progressEvents")
      .withIndex("by_owner_project_idempotency", (q) =>
        q.eq("ownerId", args.ownerId).eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) return { eventId: existing._id, replayed: true };
    for (const reference of args.references) {
      if (!(await referenceResolves(ctx, args.ownerId, args.projectId, reference))) throw conceptError("NOT_FOUND");
    }
    const eventId = await ctx.db.insert("progressEvents", {
      ownerId: args.ownerId,
      projectId: args.projectId,
      eventType: "activity-completed",
      createdAt: Date.now(),
      idempotencyKey: args.idempotencyKey,
      activity: args.activity,
      objective: args.objective,
      difficulty: args.difficulty,
      outcome: args.outcome,
      evidence: args.evidence.status === "ok" ? "ok" : "insufficient-evidence",
      turnId: args.turnId,
      references: args.references,
    });
    return { eventId, replayed: false };
  },
});

/**
 * Owner-only progress-event page, newest first. `references` are re-validated
 * against the live owned chunk/document on read; anything that no longer
 * resolves is dropped and counted in `droppedReferences`, leaving the stored
 * row untouched. Feedback rows are events too: `targetEventId`,
 * `feedbackValue` and `retractedAt` describe the reversible feedback state, so
 * a retraction and its recorded reversal are both visible in the same list.
 */
export const listProgressEvents = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  returns: v.object({ events: v.array(progressEventValidator), droppedReferences: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const limit = args.limit ?? PROGRESS_EVENT_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > PROGRESS_EVENT_LIMIT_MAX) {
      throw new ConvexError({ code: "INVALID_ARGUMENT" });
    }
    const rows = await ctx.db
      .query("progressEvents")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId))
      .order("desc")
      .take(limit);
    let droppedReferences = 0;
    const events = [];
    for (const row of rows) {
      const kept: Reference[] = [];
      for (const reference of row.references ?? []) {
        if (await referenceResolves(ctx, ownerId, args.projectId, reference)) kept.push(reference);
        else droppedReferences += 1;
      }
      events.push({
        _id: row._id,
        eventType: row.eventType,
        createdAt: row.createdAt,
        turnId: row.turnId ?? null,
        activity: row.activity ?? null,
        objective: row.objective ?? null,
        difficulty: row.difficulty ?? null,
        outcome: row.outcome ?? null,
        evidence: row.evidence ?? null,
        targetEventId: row.targetEventId ?? null,
        feedbackValue: row.feedbackValue ?? null,
        retractedAt: row.retractedAt ?? null,
        references: kept,
      });
    }
    return { events, droppedReferences };
  },
});

/**
 * Records the learner's feedback on one `activity-completed` event. Exactly
 * one active feedback exists per target: a repeated call reports the existing
 * event instead of writing a second one, and after a retraction a new feedback
 * event can be recorded again. A target that is missing, foreign or not an
 * S20 activity event is a non-enumerating `NOT_FOUND`.
 */
export const recordFeedback = mutation({
  args: { projectId: v.id("projects"), targetEventId: v.id("progressEvents"), value: feedbackValueValidator },
  returns: v.object({
    feedbackEventId: v.id("progressEvents"),
    status: v.union(v.literal("recorded"), v.literal("already-recorded")),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const target = await ctx.db.get(args.targetEventId);
    if (
      target === null ||
      target.ownerId !== ownerId ||
      target.projectId !== args.projectId ||
      target.eventType !== "activity-completed"
    ) {
      throw conceptError("NOT_FOUND");
    }
    const active = await activeFeedbackEvent(ctx, ownerId, args.projectId, args.targetEventId);
    if (active !== null) return { feedbackEventId: active._id, status: "already-recorded" as const };
    const feedbackEventId = await ctx.db.insert("progressEvents", {
      ownerId,
      projectId: args.projectId,
      eventType: "feedback-given",
      createdAt: Date.now(),
      targetEventId: args.targetEventId,
      feedbackValue: args.value,
    });
    return { feedbackEventId, status: "recorded" as const };
  },
});

/**
 * Undoes feedback: the feedback row is marked with `retractedAt`, and the
 * reversal itself is recorded as a `feedback-retracted` event that points back
 * at it, so the undo is durable and auditable. Retracting twice reports
 * `already-retracted` and never writes a second reversal.
 */
export const retractFeedback = mutation({
  args: { projectId: v.id("projects"), feedbackEventId: v.id("progressEvents") },
  returns: v.object({ status: v.union(v.literal("retracted"), v.literal("already-retracted")) }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const row = await ctx.db.get(args.feedbackEventId);
    if (
      row === null ||
      row.ownerId !== ownerId ||
      row.projectId !== args.projectId ||
      row.eventType !== "feedback-given"
    ) {
      throw conceptError("NOT_FOUND");
    }
    if (row.retractedAt !== undefined) return { status: "already-retracted" as const };
    const now = Date.now();
    await ctx.db.patch(row._id, { retractedAt: now });
    await ctx.db.insert("progressEvents", {
      ownerId,
      projectId: args.projectId,
      eventType: "feedback-retracted",
      createdAt: now,
      targetEventId: row._id,
      ...(row.feedbackValue === undefined ? {} : { feedbackValue: row.feedbackValue }),
    });
    return { status: "retracted" as const };
  },
});

/* ------------------------------------------------------------------ *
 * The activity action
 * ------------------------------------------------------------------ */

/**
 * Runs one concept-learning activity turn. Identity and selection are derived
 * first, so a foreign project is a non-enumerating `NOT_FOUND` and an
 * unselected objective/difficulty is a typed `CONCEPT_SELECTION_REQUIRED`
 * before a turn row, a retrieval query or a provider request exists.
 */
export const runActivity = action({
  args: {
    projectId: v.id("projects"),
    turnId: v.string(),
    activity: activityValidator,
    text: v.string(),
    sessionKey: v.optional(v.string()),
    rerank: v.optional(v.boolean()),
  },
  returns: activityResultValidator,
  handler: async (ctx: ActionCtx, args): Promise<ActivityResult> => {
    const ownerId = await requireUserId(ctx);
    const turnId = requireTurnId(args.turnId);
    const text = requireLearnerText(args.text);
    const sessionKey = resolveSessionKey(args.sessionKey);

    const scope = await ctx.runQuery(internal.concept.authorizeConceptScope, {
      ownerId,
      projectId: args.projectId,
    });
    if (scope.objective === null || scope.difficulty === null) {
      const missing: string[] = [];
      if (scope.objective === null) missing.push("objective");
      if (scope.difficulty === null) missing.push("difficulty");
      throw new ConvexError({ code: "CONCEPT_SELECTION_REQUIRED", missing });
    }

    const sessionId = await ctx.runMutation(internal.tutor.ensureSession, {
      ownerId,
      projectId: args.projectId,
      sessionKey,
    });
    const begin = await ctx.runMutation(internal.tutor.beginTurn, {
      ownerId,
      projectId: args.projectId,
      sessionId,
      turnId,
      learnerText: text,
      leaseMs: TURN_LEASE_MS,
    });

    if (begin.state === "completed") {
      const replay = await ctx.runQuery(internal.tutor.readTurnResult, {
        ownerId,
        projectId: args.projectId,
        turnId,
      });
      if (replay === null) throw conceptError("TURN_INCOMPLETE");
      // Narrowed before any write: an S19 translation turn replayed under this
      // turnId has no activity result, so it must not record an event either.
      const answerBasis = conceptAnswerBasis(replay.answerBasis);
      const outcome = resolveActivityOutcome(args.activity, replay.text);
      const progress = await ctx.runMutation(internal.concept.recordActivityEvent, {
        ownerId,
        projectId: args.projectId,
        turnId,
        activity: args.activity,
        objective: scope.objective,
        difficulty: scope.difficulty,
        outcome,
        evidence: replay.evidence,
        references: replay.citations.map((citation) => ({
          chunkId: citation.chunkId,
          documentId: citation.documentId,
          seq: citation.seq,
          page: citation.page,
          heading: citation.heading,
        })),
        idempotencyKey: `${turnId}:activity-completed`,
      });
      return { ...replay, activity: args.activity, outcome, answerBasis, progressEventId: progress.eventId };
    }
    if (begin.state !== "started") {
      const code =
        begin.state === "in-progress"
          ? "TURN_IN_PROGRESS"
          : begin.state === "cancelled"
            ? "TURN_CANCELLED"
            : (begin.failureCode ?? "TURN_FAILED");
      throw conceptError(code);
    }
    const token = begin.attemptToken;

    const client = tutorClient(ownerId);
    if (client === null) {
      await safeFailTurn(ctx, ownerId, args.projectId, turnId, token, "TURN_NOT_CONFIGURED");
      throw conceptError("TURN_NOT_CONFIGURED");
    }

    const cancel = new AbortController();
    let watching = true;
    const sleeper: { wake: (() => void) | null } = { wake: null };
    const watcher = (async () => {
      const interval = tutorCancelPollMs();
      try {
        while (watching) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              sleeper.wake = null;
              resolve();
            }, interval);
            sleeper.wake = () => {
              clearTimeout(timer);
              sleeper.wake = null;
              resolve();
            };
          });
          if (!watching) return;
          const status = await ctx.runQuery(internal.tutor.getTurnStatus, {
            ownerId,
            projectId: args.projectId,
            turnId,
          });
          if (status === null || status === "completed" || status === "failed") return;
          if (status === "cancelled") {
            cancel.abort();
            return;
          }
        }
      } catch {
        // A failed probe stops the watcher; the stage-boundary checks and
        // commitTurn still refuse to write for a cancelled turn.
        return;
      }
    })();

    try {
      const embedded = await client.embeddings([text], { signal: cancel.signal });
      const retrieval = await ctx.runAction(api.retrieval.retrieveProjectContext, {
        projectId: args.projectId,
        query: text,
        vector: embedded.vectors[0],
        topK: TUTOR_TOP_K,
        ...(args.rerank === undefined ? {} : { rerank: args.rerank }),
        maxContextChars: TUTOR_CONTEXT_CHARS,
      });

      const evidenceMode: TutorEvidenceMode = retrieval.status === "ok" ? "document-backed" : "no-evidence";
      const evidenceList: TutorEvidence[] = [];
      if (retrieval.status === "ok") {
        const byChunkId = new Map(retrieval.citations.map((citation) => [citation.chunkId as string, citation]));
        retrieval.context.segments.forEach((segment, index) => {
          const citation = byChunkId.get(segment.chunkId as string);
          evidenceList.push({
            marker: index + 1,
            documentId: segment.documentId as string,
            chunkId: segment.chunkId as string,
            seq: citation?.seq ?? index,
            page: citation?.page ?? null,
            heading: citation?.heading ?? null,
            text: segment.text,
          });
        });
      }

      await ctx.runMutation(internal.tutor.recordRetrieval, {
        ownerId,
        projectId: args.projectId,
        turnId,
        attemptToken: token,
        retrievedChunkIds: evidenceList.map((entry) => entry.chunkId as Id<"documentChunks">),
        evidence: {
          status: retrieval.status === "ok" ? "ok" : "insufficient-evidence",
          reason: retrieval.status === "insufficient-evidence" ? retrieval.reason : null,
        },
      });

      const history = await ctx.runQuery(internal.tutor.recentHistory, {
        ownerId,
        projectId: args.projectId,
        sessionId,
        turnId,
      });

      const system = buildConceptSystemPrompt({
        goal: scope.goal,
        objective: scope.objective,
        difficulty: scope.difficulty,
        activity: args.activity,
        evidenceMode,
      });
      const user = buildTutorUserMessage({ learnerText: text, history, evidence: evidenceList });

      const completion = await runTutorTurn(
        client,
        { system, user },
        { signal: cancel.signal, maxAttempts: tutorMaxAttempts(), retryBaseMs: tutorRetryBaseMs() },
      );

      if (!questionFirstSatisfied(args.activity, completion.text)) {
        throw conceptError("ACTIVITY_NOT_QUESTION_FIRST");
      }

      const markers = extractCitationMarkers(completion.text);
      const resolved = markers.filter((marker) => marker >= 1 && marker <= evidenceList.length);
      const citations = resolved.map((marker) => ({
        chunkId: evidenceList[marker - 1].chunkId as Id<"documentChunks">,
      }));

      watching = false;
      sleeper.wake?.();
      await watcher;

      const committed = await ctx.runMutation(internal.tutor.commitTurn, {
        ownerId,
        projectId: args.projectId,
        turnId,
        attemptToken: token,
        answer: completion.text,
        citations,
        providerAttempts: completion.attempts,
        unresolvedMarkers: markers.length - resolved.length,
      });

      const outcome = resolveActivityOutcome(args.activity, committed.text);
      const progress = await ctx.runMutation(internal.concept.recordActivityEvent, {
        ownerId,
        projectId: args.projectId,
        turnId,
        activity: args.activity,
        objective: scope.objective,
        difficulty: scope.difficulty,
        outcome,
        evidence: committed.evidence,
        references: committed.citations.map((citation) => ({
          chunkId: citation.chunkId,
          documentId: citation.documentId,
          seq: citation.seq,
          page: citation.page,
          heading: citation.heading,
        })),
        idempotencyKey: `${turnId}:activity-completed`,
      });

      return {
        turnId: committed.turnId,
        sessionId: committed.sessionId,
        status: "completed",
        activity: args.activity,
        outcome,
        answerBasis: conceptAnswerBasis(committed.answerBasis),
        text: committed.text,
        citations: committed.citations,
        evidence: committed.evidence,
        unresolvedMarkers: committed.unresolvedMarkers,
        providerAttempts: committed.providerAttempts,
        replayed: committed.replayed,
        progressEventId: progress.eventId,
      };
    } catch (error) {
      const failure = turnFailureCode(error);
      if (failure.code !== "TURN_CANCELLED") {
        await safeFailTurn(ctx, ownerId, args.projectId, turnId, token, failure.code);
      }
      throw new ConvexError(
        failure.retryAfterMs === undefined
          ? { code: failure.code }
          : { code: failure.code, retryAfterMs: failure.retryAfterMs },
      );
    } finally {
      watching = false;
      sleeper.wake?.();
      cancel.abort();
      await watcher;
    }
  },
});
