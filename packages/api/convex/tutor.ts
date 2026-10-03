import {
  MAX_LEARNER_TEXT_CHARS,
  NanClient,
  TUTOR_CONTEXT_CHARS,
  TUTOR_MAX_ANSWER_CHARS,
  TUTOR_TOP_K,
  buildLanguagePracticeSystemPrompt,
  buildRouteTranslationPrompt,
  buildTutorSystemPrompt,
  buildTutorUserMessage,
  composeTutorAnswer,
  detectTranslationRoute,
  extractCitationMarkers,
  practisedTopicFor,
  runTutorTurn,
  TutorTurnError,
  tutorFailureFor,
  type TutorEvidence,
  type TutorEvidenceMode,
  type TutorHistoryEntry,
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
import { languagePracticeConfigValidator } from "./languagePractice";
import { requireOwnedProject, requireUserId } from "./projects";
import { MAX_TURN_ID_CHARS } from "./stt";

/**
 * S14 grounded tutor orchestration: one session/turn pipeline that runs
 * scoped S13 retrieval, builds an injection-resistant prompt around the S21
 * project goal/mode, executes the turn through the S11 NaN adapter, and
 * commits learner + tutor messages with their citation references in one
 * transactional write.
 *
 * ## Order of operations (test-locked)
 *
 * 1. authentication (`UNAUTHENTICATED` without an identity),
 * 2. project ownership (`NOT_FOUND` for a foreign or deleted project, before
 *    any turn row, retrieval or provider call),
 * 3. argument validation (turn id, learner text, session key),
 * 4. session resolution and `beginTurn` - the idempotency/cancellation
 *    linearization point for this `turnId`,
 * 5. provider client resolution (`TURN_NOT_CONFIGURED` when no key exists;
 *    no other provider is ever constructed),
 * 6. query embedding + S13 retrieval (project-scoped filter and recheck) -
 *    skipped for an S19 translation-routed turn, which instead
 *    `recordRetrieval`s an empty, explicitly-reasoned evidence set,
 *  7. `recordRetrieval` - freezes the retrieved chunk ids for this attempt,
 *  8. prompt build (system = goal/track/evidence mode only, plus the S19
 *    language-practice section for a configured language-practice project or
 *    the S18 translation task for a routed translation request; everything
 *    untrusted lives in the JSON user envelope),
 *  9. streamed completion with bounded, typed retries under the caller's
 *    abort signal, while a cancellation watcher polls the turn row,
 *  10. `commitTurn` - validates every citation against the frozen retrieval
 *    set and the live owned chunk/document, then writes both messages and
 *    their citations together, or nothing at all; a configured
 *    language-practice tutor turn then records its practised topic
 *    (idempotent per turn) through the S19 history mutation.
 *
 * ## Idempotency
 *
 * A retried request with the same `turnId` observes the existing row:
 * `completed` replays the stored result without touching a provider,
 * `cancelled`/`failed`/`in-progress` surface as their own typed codes, and a
 * stale attempt whose lease was taken over fails `TURN_ATTEMPT_LOST` instead
 * of writing a second message set. Message idempotency keys derive from the
 * `turnId`, so one turn can never produce duplicate rows.
 *
 * ## Cancellation semantics
 *
 * `cancelTurn` flips a `running` turn to `cancelled` and is a no-op for a
 * finished turn (`already-cancelled` / `already-completed` / `failed`). The
 * action observes cancellation in three places: a watcher that aborts the
 * in-flight provider request every `TURN_CANCEL_POLL_MS` (default 1 s),
 * `recordRetrieval`, and `commitTurn`. Because the learner and tutor
 * messages are written in one transaction only while the row is `running`,
 * a cancelled turn leaves zero messages and zero citations - never a partial
 * transcript.
 *
 * ## Scope
 *
 * No external action tools, no autonomous agent, and no provider other than
 * NaN (`embeddings` for the query vector, `chat-streaming` for the answer,
 * optional `rerank` inside S13). S19 adds only the language-practice mode
 * hook described above (prompt selection, S18 translation routing and
 * practised-topic recording); concept-learning (S20) and the chat UI are
 * deliberately out of scope.
 */

/** Bounded transcript reads; one page is at most this many messages. */
export const TRANSCRIPT_LIMIT_DEFAULT = 100;
export const TRANSCRIPT_LIMIT_MAX = 200;
/** One tutor message may store at most this many citations (the S13 top-k maximum). */
export const MAX_CITATIONS_PER_MESSAGE = 50;
/** Lease on a `running` turn; an expired lease may be taken over by a retry. */
export const TURN_LEASE_MS = 60_000;
/** Default session when the client does not name one. */
export const DEFAULT_SESSION_KEY = "default";
/** Conversation history folded into the user envelope, bounded by count and characters. */
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 2_000;
const MAX_HISTORY_ENTRY_CHARS = 600;

type TurnStatus = "running" | "completed" | "cancelled" | "failed";
/** S19 adds `translation`: an explicit translation request answered by the S18 task. */
type AnswerBasis = "document-backed" | "general-explanation" | "translation";

const modeValidator = v.union(v.literal("language-practice"), v.literal("concept-learning"));
const evidenceValidator = v.object({
  status: v.union(v.literal("ok"), v.literal("insufficient-evidence")),
  reason: v.union(v.null(), v.string()),
});
const answerBasisValidator = v.union(
  v.literal("document-backed"),
  v.literal("general-explanation"),
  v.literal("translation"),
);
const answerKindValidator = v.union(v.literal("tutor"), v.literal("translation"));

const storedCitationValidator = v.object({
  rank: v.number(),
  retrievalRank: v.number(),
  documentId: v.id("documents"),
  chunkId: v.id("documentChunks"),
  seq: v.number(),
  contentHash: v.string(),
  page: v.union(v.null(), v.number()),
  heading: v.union(v.null(), v.string()),
});

type StoredCitation = {
  rank: number;
  retrievalRank: number;
  documentId: Id<"documents">;
  chunkId: Id<"documentChunks">;
  seq: number;
  contentHash: string;
  page: number | null;
  heading: string | null;
};

const turnResultValidator = v.object({
  turnId: v.string(),
  sessionId: v.id("learningSessions"),
  status: v.literal("completed"),
  answerBasis: answerBasisValidator,
  text: v.string(),
  citations: v.array(storedCitationValidator),
  evidence: evidenceValidator,
  unresolvedMarkers: v.number(),
  providerAttempts: v.number(),
  replayed: v.boolean(),
});

type TurnResult = {
  turnId: string;
  sessionId: Id<"learningSessions">;
  status: "completed";
  answerBasis: AnswerBasis;
  text: string;
  citations: StoredCitation[];
  evidence: { status: "ok" | "insufficient-evidence"; reason: string | null };
  unresolvedMarkers: number;
  providerAttempts: number;
  replayed: boolean;
};

const beginResultValidator = v.union(
  v.object({ state: v.literal("started"), attemptToken: v.string(), attempts: v.number() }),
  v.object({ state: v.literal("in-progress") }),
  v.object({ state: v.literal("completed") }),
  v.object({ state: v.literal("cancelled") }),
  v.object({ state: v.literal("failed"), failureCode: v.union(v.null(), v.string()) }),
);

type BeginResult =
  | { state: "started"; attemptToken: string; attempts: number }
  | { state: "in-progress" }
  | { state: "completed" }
  | { state: "cancelled" }
  | { state: "failed"; failureCode: string | null };

/** Bounded, validated deployment configuration; malformed values fall back, never propagate. */
function configuredNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

/** How often an in-flight action re-checks the turn row for cancellation. */
export function tutorCancelPollMs(): number {
  return configuredNumber("TURN_CANCEL_POLL_MS", 1_000, 20, 10_000);
}

/** Base delay for provider retries when NaN sends no Retry-After. */
export function tutorRetryBaseMs(): number {
  return configuredNumber("TUTOR_RETRY_BASE_MS", 250, 0, 5_000);
}

export function tutorMaxAttempts(): number {
  return configuredNumber("TUTOR_MAX_ATTEMPTS", 3, 1, 5);
}

function tutorTimeoutMs(): number {
  return configuredNumber("TUTOR_TIMEOUT_MS", 15_000, 100, 120_000);
}

/**
 * Server-side NaN client for one turn (query embedding + chat). Returns
 * `null` when the deployment has no key so the turn fails visibly with
 * `TURN_NOT_CONFIGURED`. The S11 single-user policy gate still applies: a
 * personal key never serves a learner who is not the deployer, and no other
 * provider is ever constructed on this path.
 */
function tutorClient(ownerId: string): NanClient | null {
  const apiKey = (process.env.NAN_API_KEY ?? "").trim();
  if (apiKey === "") return null;
  const deployerId = (process.env.NAN_DEPLOYER_ID ?? "").trim();
  return new NanClient({
    apiKey,
    deployment: { mode: "single-user-self-hosted", learnerId: ownerId, deployerId: deployerId === "" ? undefined : deployerId },
    quotaControls: { timeoutMs: tutorTimeoutMs() },
  });
}

type TurnRow = Doc<"tutorTurns">;

async function loadTurn(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  projectId: Id<"projects">,
  turnId: string,
): Promise<TurnRow | null> {
  return await ctx.db
    .query("tutorTurns")
    .withIndex("by_owner_project_turn", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId).eq("turnId", turnId))
    .unique();
}

/** Non-enumerating typed code raised by the write path. */
function turnError(code: string): ConvexError<{ code: string }> {
  return new ConvexError({ code });
}

function requireTurnId(value: string): string {
  const turnId = value.trim();
  let control = false;
  for (let index = 0; index < turnId.length; index += 1) {
    if (turnId.charCodeAt(index) < 32) control = true;
  }
  if (turnId === "" || turnId.length > MAX_TURN_ID_CHARS || control) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return turnId;
}

function requireLearnerText(value: string): string {
  const text = value.trim();
  if (text === "") throw new ConvexError({ code: "INVALID_ARGUMENT" });
  if (text.length > MAX_LEARNER_TEXT_CHARS) {
    throw new ConvexError({ code: "TEXT_TOO_LARGE", maxChars: MAX_LEARNER_TEXT_CHARS });
  }
  return text;
}

function resolveSessionKey(value: string | undefined): string {
  if (value === undefined) return DEFAULT_SESSION_KEY;
  const sessionKey = value.trim();
  if (sessionKey === "" || sessionKey.length > MAX_TURN_ID_CHARS) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return sessionKey;
}

/** Attempt guard token: not a secret (internal functions only), just a race check. */
function attemptToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/* ------------------------------------------------------------------ *
 * Internal write/read helpers (server-caller contract, S04-style)
 * ------------------------------------------------------------------ */

/** Ownership gate for the turn path: identity is server-derived, scope re-checked. */
export const authorizeTurnScope = internalQuery({
  args: { ownerId: v.string(), projectId: v.id("projects") },
  returns: v.object({
    goal: v.union(v.null(), v.string()),
    mode: v.union(v.null(), modeValidator),
    languagePractice: v.union(v.null(), languagePracticeConfigValidator),
  }),
  handler: async (ctx, args) => {
    const project = await requireOwnedProject(ctx, args.ownerId, args.projectId);
    return { goal: project.goal ?? null, mode: project.mode ?? null, languagePractice: project.languagePractice ?? null };
  },
});

/** Idempotent session resolution: one (owner, project, sessionKey) maps to one row. */
export const ensureSession = internalMutation({
  args: { ownerId: v.string(), projectId: v.id("projects"), sessionKey: v.string() },
  returns: v.id("learningSessions"),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.ownerId, args.projectId);
    const existing = await ctx.db
      .query("learningSessions")
      .withIndex("by_owner_project_session_key", (q) =>
        q.eq("ownerId", args.ownerId).eq("projectId", args.projectId).eq("sessionKey", args.sessionKey),
      )
      .unique();
    if (existing !== null) return existing._id;
    return await ctx.db.insert("learningSessions", {
      ownerId: args.ownerId,
      projectId: args.projectId,
      sessionKey: args.sessionKey,
      createdAt: Date.now(),
      endedAt: null,
    });
  },
});

/**
 * The idempotency linearization point. Exactly one `running` row may exist
 * per (owner, project, turnId); every later request observes it instead of
 * starting a second attempt. An expired lease (a crashed attempt) is taken
 * over with a fresh token so an interrupted turn is resumable, while a live
 * lease reports `in-progress` and never duplicates work.
 */
export const beginTurn = internalMutation({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    sessionId: v.id("learningSessions"),
    turnId: v.string(),
    learnerText: v.string(),
    leaseMs: v.number(),
  },
  returns: beginResultValidator,
  handler: async (ctx, args): Promise<BeginResult> => {
    await requireOwnedProject(ctx, args.ownerId, args.projectId);
    const session = await ctx.db.get(args.sessionId);
    if (session === null || session.ownerId !== args.ownerId || session.projectId !== args.projectId) {
      throw turnError("NOT_FOUND");
    }
    const now = Date.now();
    const existing = await loadTurn(ctx, args.ownerId, args.projectId, args.turnId);
    if (existing === null) {
      const token = attemptToken();
      await ctx.db.insert("tutorTurns", {
        ownerId: args.ownerId,
        projectId: args.projectId,
        sessionId: args.sessionId,
        turnId: args.turnId,
        status: "running",
        attempts: 1,
        attemptToken: token,
        leaseExpiresAt: now + args.leaseMs,
        learnerText: args.learnerText,
        retrievedChunkIds: [],
        createdAt: now,
        updatedAt: now,
      });
      return { state: "started", attemptToken: token, attempts: 1 };
    }
    if (existing.status === "completed") return { state: "completed" };
    if (existing.status === "cancelled") return { state: "cancelled" };
    if (existing.status === "failed") return { state: "failed", failureCode: existing.failureCode ?? null };
    if ((existing.leaseExpiresAt ?? 0) > now) return { state: "in-progress" };
    const token = attemptToken();
    await ctx.db.patch(existing._id, {
      attempts: existing.attempts + 1,
      attemptToken: token,
      leaseExpiresAt: now + args.leaseMs,
      updatedAt: now,
    });
    return { state: "started", attemptToken: token, attempts: existing.attempts + 1 };
  },
});

/**
 * Freezes what retrieval actually returned for this attempt. Every recorded
 * chunk and its document are re-checked against the authenticated owner and
 * project here, and again at commit, so the citation membership test can
 * never be satisfied by a foreign or fabricated id.
 */
export const recordRetrieval = internalMutation({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    turnId: v.string(),
    attemptToken: v.string(),
    retrievedChunkIds: v.array(v.id("documentChunks")),
    evidence: evidenceValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await loadTurn(ctx, args.ownerId, args.projectId, args.turnId);
    if (turn === null) throw turnError("NOT_FOUND");
    if (turn.status === "cancelled") throw turnError("TURN_CANCELLED");
    if (turn.status !== "running" || turn.attemptToken !== args.attemptToken) throw turnError("TURN_ATTEMPT_LOST");
    if (args.retrievedChunkIds.length > MAX_CITATIONS_PER_MESSAGE) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    for (const chunkId of args.retrievedChunkIds) {
      const chunk = await ctx.db.get(chunkId);
      if (chunk === null || chunk.ownerId !== args.ownerId || chunk.projectId !== args.projectId) throw turnError("NOT_FOUND");
      const document = await ctx.db.get(chunk.documentId);
      if (document === null || document.ownerId !== args.ownerId || document.projectId !== args.projectId) throw turnError("NOT_FOUND");
    }
    await ctx.db.patch(turn._id, { retrievedChunkIds: args.retrievedChunkIds, evidence: args.evidence, updatedAt: Date.now() });
    return null;
  },
});

/** Cancellation/status probe used by the action's watcher. */
export const getTurnStatus = internalQuery({
  args: { ownerId: v.string(), projectId: v.id("projects"), turnId: v.string() },
  returns: v.union(
    v.null(),
    v.union(v.literal("running"), v.literal("completed"), v.literal("cancelled"), v.literal("failed")),
  ),
  handler: async (ctx, args): Promise<TurnStatus | null> => {
    const turn = await loadTurn(ctx, args.ownerId, args.projectId, args.turnId);
    return turn === null ? null : turn.status;
  },
});

/**
 * Records a terminal provider/argument failure. A turn that is already
 * `cancelled`, `completed`, or owned by a newer attempt is left untouched,
 * so a late failure can never overwrite a cancellation or a success.
 */
export const failTurn = internalMutation({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    turnId: v.string(),
    attemptToken: v.string(),
    failureCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const turn = await loadTurn(ctx, args.ownerId, args.projectId, args.turnId);
    if (turn === null) return null;
    if (turn.status !== "running" || turn.attemptToken !== args.attemptToken) return null;
    await ctx.db.patch(turn._id, {
      status: "failed",
      failureCode: args.failureCode,
      endedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

async function loadStoredResult(
  ctx: QueryCtx,
  ownerId: string,
  projectId: Id<"projects">,
  turn: TurnRow,
  replayed: boolean,
): Promise<TurnResult> {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_owner_project_turn", (q) =>
      q.eq("ownerId", ownerId).eq("projectId", projectId).eq("turnId", turn.turnId),
    )
    .collect();
  messages.sort((left, right) =>
    left.createdAt - right.createdAt || (left._id < right._id ? -1 : left._id > right._id ? 1 : 0),
  );
  const tutorMessage = messages.find((message) => message.role === "tutor");
  if (tutorMessage === undefined) throw turnError("TURN_INCOMPLETE");
  const citationRows = await ctx.db
    .query("citations")
    .withIndex("by_owner_project_turn", (q) =>
      q.eq("ownerId", ownerId).eq("projectId", projectId).eq("turnId", turn.turnId),
    )
    .collect();
  citationRows.sort((left, right) => left.rank - right.rank);
  const evidenceMode: TutorEvidenceMode = turn.evidence?.status === "ok" ? "document-backed" : "no-evidence";
  return {
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    status: "completed",
    answerBasis: turn.answerBasis ?? (evidenceMode === "document-backed" ? "document-backed" : "general-explanation"),
    text: tutorMessage.content,
    citations: citationRows.map((row) => ({
      rank: row.rank,
      retrievalRank: row.retrievalRank,
      documentId: row.documentId,
      chunkId: row.chunkId,
      seq: row.seq,
      contentHash: row.contentHash,
      page: row.page,
      heading: row.heading,
    })),
    evidence: turn.evidence ?? { status: "insufficient-evidence", reason: null },
    unresolvedMarkers: turn.unresolvedMarkers ?? 0,
    providerAttempts: turn.providerAttempts ?? 0,
    replayed,
  };
}

/** Replay path for a retried request whose turn already completed. */
export const readTurnResult = internalQuery({
  args: { ownerId: v.string(), projectId: v.id("projects"), turnId: v.string() },
  returns: v.union(v.null(), turnResultValidator),
  handler: async (ctx, args): Promise<TurnResult | null> => {
    const turn = await loadTurn(ctx, args.ownerId, args.projectId, args.turnId);
    if (turn === null || turn.status !== "completed") return null;
    return await loadStoredResult(ctx, args.ownerId, args.projectId, turn, true);
  },
});

/**
 * The single write of a finished turn.
 *
 * Citations are validated **before** anything is inserted:
 * - a `chunkId` outside the turn's frozen `retrievedChunkIds` is
 *   `CITATION_NOT_RETRIEVED`: invented and foreign ids fail here, including
 *   a chunk this owner owns but retrieval never returned for this turn;
 * - a chunk or document that no longer exists, is no longer owned by this
 *   owner/project, or whose document is not `ready` is also
 *   `CITATION_NOT_RETRIEVED` (the evidence is gone, so it must not render);
 * - duplicates or an oversized set are `CITATION_INVALID`;
 * - `documentId`/`seq`/`contentHash`/`page`/`heading` are copied from the
 *   verified chunk row, never taken from the caller.
 *
 * Learner message, tutor message and every citation row are inserted in the
 * same mutation, so a cancelled or failed turn can never leave a partial
 * transcript, and a completed turn replayed by a later commit returns the
 * stored result instead of writing twice.
 */
export const commitTurn = internalMutation({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    turnId: v.string(),
    attemptToken: v.string(),
    answer: v.string(),
    citations: v.array(v.object({ chunkId: v.id("documentChunks") })),
    providerAttempts: v.number(),
    unresolvedMarkers: v.number(),
    answerKind: v.optional(answerKindValidator),
  },
  returns: turnResultValidator,
  handler: async (ctx, args): Promise<TurnResult> => {
    const turn = await loadTurn(ctx, args.ownerId, args.projectId, args.turnId);
    if (turn === null) throw turnError("NOT_FOUND");
    if (turn.status === "completed") return await loadStoredResult(ctx, args.ownerId, args.projectId, turn, true);
    if (turn.status === "cancelled") throw turnError("TURN_CANCELLED");
    if (turn.status !== "running" || turn.attemptToken !== args.attemptToken) throw turnError("TURN_ATTEMPT_LOST");

    const answer = args.answer.trim();
    if (answer === "" || answer.length > TUTOR_MAX_ANSWER_CHARS) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    if (args.citations.length > MAX_CITATIONS_PER_MESSAGE) throw turnError("CITATION_INVALID");
    if (!Number.isInteger(args.providerAttempts) || args.providerAttempts < 1) {
      throw new ConvexError({ code: "INVALID_ARGUMENT" });
    }

    const retrievalRank = new Map<string, number>();
    turn.retrievedChunkIds.forEach((chunkId, index) => retrievalRank.set(chunkId, index + 1));

    const seen = new Set<string>();
    const verified: Array<Omit<StoredCitation, "rank">> = [];
    for (const entry of args.citations) {
      if (seen.has(entry.chunkId)) throw turnError("CITATION_INVALID");
      seen.add(entry.chunkId);
      const rank = retrievalRank.get(entry.chunkId);
      if (rank === undefined) throw turnError("CITATION_NOT_RETRIEVED");
      const chunk = await ctx.db.get(entry.chunkId);
      if (chunk === null || chunk.ownerId !== args.ownerId || chunk.projectId !== args.projectId) {
        throw turnError("CITATION_NOT_RETRIEVED");
      }
      const document = await ctx.db.get(chunk.documentId);
      if (
        document === null ||
        document.ownerId !== args.ownerId ||
        document.projectId !== args.projectId ||
        document.status !== "ready"
      ) {
        throw turnError("CITATION_NOT_RETRIEVED");
      }
      verified.push({
        retrievalRank: rank,
        documentId: document._id,
        chunkId: chunk._id,
        seq: chunk.seq,
        contentHash: chunk.contentHash,
        page: chunk.locator.page,
        heading: chunk.locator.heading,
      });
    }

    const evidenceMode: TutorEvidenceMode = turn.evidence?.status === "ok" ? "document-backed" : "no-evidence";
    // S19: a routed translation turn is stored verbatim (no no-evidence
    // prefix - the answer is a translation, not a document claim) and is
    // marked `translation` so it is never presented as a grounded answer.
    const answerKind = args.answerKind ?? "tutor";
    const answerBasis: AnswerBasis =
      answerKind === "translation" ? "translation" : evidenceMode === "document-backed" ? "document-backed" : "general-explanation";
    const storedAnswer = answerKind === "translation" ? answer : composeTutorAnswer(answer, evidenceMode);
    const now = Date.now();
    await ctx.db.insert("messages", {
      ownerId: args.ownerId,
      projectId: args.projectId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      idempotencyKey: `${turn.turnId}:learner`,
      role: "learner",
      content: turn.learnerText,
      createdAt: now,
    });
    const tutorMessageId = await ctx.db.insert("messages", {
      ownerId: args.ownerId,
      projectId: args.projectId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      idempotencyKey: `${turn.turnId}:tutor`,
      role: "tutor",
      content: storedAnswer,
      createdAt: now,
    });
    for (let index = 0; index < verified.length; index += 1) {
      const citation = verified[index];
      await ctx.db.insert("citations", {
        ownerId: args.ownerId,
        projectId: args.projectId,
        messageId: tutorMessageId,
        turnId: turn.turnId,
        rank: index + 1,
        retrievalRank: citation.retrievalRank,
        documentId: citation.documentId,
        chunkId: citation.chunkId,
        seq: citation.seq,
        contentHash: citation.contentHash,
        page: citation.page,
        heading: citation.heading,
      });
    }
    await ctx.db.patch(turn._id, {
      status: "completed",
      answerBasis,
      providerAttempts: args.providerAttempts,
      unresolvedMarkers: args.unresolvedMarkers,
      endedAt: now,
      updatedAt: now,
    });
    const stored = await loadTurn(ctx, args.ownerId, args.projectId, turn.turnId);
    if (stored === null) throw turnError("TURN_INCOMPLETE");
    return await loadStoredResult(ctx, args.ownerId, args.projectId, stored, false);
  },
});

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

/**
 * Cancels an in-flight turn. Idempotent by design: cancelling twice reports
 * `already-cancelled`, and a finished turn is never rewritten -
 * `already-completed` / `failed` tell the client nothing is running.
 */
export const cancelTurn = mutation({
  args: { projectId: v.id("projects"), turnId: v.string() },
  returns: v.object({
    status: v.union(
      v.literal("cancelled"),
      v.literal("already-cancelled"),
      v.literal("already-completed"),
      v.literal("failed"),
    ),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const turnId = requireTurnId(args.turnId);
    const turn = await loadTurn(ctx, ownerId, args.projectId, turnId);
    if (turn === null) throw turnError("NOT_FOUND");
    const now = Date.now();
    if (turn.status === "running") {
      await ctx.db.patch(turn._id, { status: "cancelled", endedAt: now, updatedAt: now });
      return { status: "cancelled" as const };
    }
    if (turn.status === "cancelled") return { status: "already-cancelled" as const };
    if (turn.status === "completed") return { status: "already-completed" as const };
    return { status: "failed" as const };
  },
});

/** Owner-only turn state: status, evidence and failure code, never another project's row. */
export const getTurn = query({
  args: { projectId: v.id("projects"), turnId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      turnId: v.string(),
      status: v.union(v.literal("running"), v.literal("completed"), v.literal("cancelled"), v.literal("failed")),
      attempts: v.number(),
      failureCode: v.union(v.null(), v.string()),
      evidence: v.union(v.null(), evidenceValidator),
      answerBasis: v.union(v.null(), answerBasisValidator),
      createdAt: v.number(),
      updatedAt: v.number(),
      endedAt: v.union(v.null(), v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const turn = await loadTurn(ctx, ownerId, args.projectId, requireTurnId(args.turnId));
    if (turn === null) return null;
    return {
      turnId: turn.turnId,
      status: turn.status,
      attempts: turn.attempts,
      failureCode: turn.failureCode ?? null,
      evidence: turn.evidence ?? null,
      answerBasis: turn.answerBasis ?? null,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      endedAt: turn.endedAt ?? null,
    };
  },
});

/**
 * The newest tutor turn of a project, as the S16 player's cancellation
 * anchor: the response section shows an in-flight turn with its Cancel turn
 * action, and cancelling stops playback before the mutation lands. Owner-only
 * like every other read here.
 */
export const latestTurn = query({
  args: { projectId: v.id("projects") },
  returns: v.union(
    v.null(),
    v.object({
      turnId: v.string(),
      status: v.union(v.literal("running"), v.literal("completed"), v.literal("cancelled"), v.literal("failed")),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const rows = await ctx.db
      .query("tutorTurns")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId))
      .order("desc")
      .take(1);
    const turn = rows[0];
    if (turn === undefined) return null;
    return { turnId: turn.turnId, status: turn.status, createdAt: turn.createdAt };
  },
});

const transcriptMessageValidator = v.object({
  _id: v.id("messages"),
  turnId: v.string(),
  role: v.union(v.literal("learner"), v.literal("tutor")),
  content: v.string(),
  createdAt: v.number(),
  citations: v.array(storedCitationValidator),
});

/**
 * Rendering-side re-validation: every stored citation is re-checked against
 * the live chunk and document before it is shown. A citation whose chunk was
 * deleted, moved out of this owner/project, or whose document is no longer
 * `ready` is dropped (counted in `droppedCitations`) instead of rendered, so
 * the transcript never displays a reference that no longer resolves to an
 * owned source.
 */
export const getTranscript = query({
  args: {
    projectId: v.id("projects"),
    sessionId: v.optional(v.id("learningSessions")),
    limit: v.optional(v.number()),
  },
  returns: v.object({ messages: v.array(transcriptMessageValidator), droppedCitations: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const limit = args.limit ?? TRANSCRIPT_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > TRANSCRIPT_LIMIT_MAX) {
      throw new ConvexError({ code: "INVALID_ARGUMENT" });
    }
    if (args.sessionId !== undefined) {
      const session = await ctx.db.get(args.sessionId);
      if (session === null || session.ownerId !== ownerId || session.projectId !== args.projectId) {
        throw turnError("NOT_FOUND");
      }
    }
    const requestedSessionId = args.sessionId;
    const page =
      requestedSessionId === undefined
        ? await ctx.db
            .query("messages")
            .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId))
            .order("desc")
            .take(limit)
        : await ctx.db
            .query("messages")
            .withIndex("by_owner_project_session", (q) =>
              q.eq("ownerId", ownerId).eq("projectId", args.projectId).eq("sessionId", requestedSessionId),
            )
            .order("desc")
            .take(limit);
    const messages = [...page].reverse();
    let droppedCitations = 0;
    const rendered: Array<{
      _id: Id<"messages">;
      turnId: string;
      role: "learner" | "tutor";
      content: string;
      createdAt: number;
      citations: StoredCitation[];
    }> = [];
    for (const message of messages) {
      const citationRows = await ctx.db
        .query("citations")
        .withIndex("by_message", (q) => q.eq("messageId", message._id))
        .take(MAX_CITATIONS_PER_MESSAGE + 1);
      const valid: Array<Doc<"citations">> = [];
      for (const row of citationRows.slice(0, MAX_CITATIONS_PER_MESSAGE)) {
        const chunk = await ctx.db.get(row.chunkId);
        const document = chunk === null ? null : await ctx.db.get(chunk.documentId);
        const usable =
          chunk !== null &&
          chunk.ownerId === ownerId &&
          chunk.projectId === args.projectId &&
          document !== null &&
          document.ownerId === ownerId &&
          document.projectId === args.projectId &&
          document.status === "ready";
        if (usable) valid.push(row);
        else droppedCitations += 1;
      }
      if (citationRows.length > MAX_CITATIONS_PER_MESSAGE) {
        droppedCitations += citationRows.length - MAX_CITATIONS_PER_MESSAGE;
      }
      valid.sort((left, right) => left.rank - right.rank);
      rendered.push({
        _id: message._id,
        turnId: message.turnId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        citations: valid.map((row) => ({
          rank: row.rank,
          retrievalRank: row.retrievalRank,
          documentId: row.documentId,
          chunkId: row.chunkId,
          seq: row.seq,
          contentHash: row.contentHash,
          page: row.page,
          heading: row.heading,
        })),
      });
    }
    return { messages: rendered, droppedCitations };
  },
});

/** Recent turns in the session as bounded history entries (newest first, char-capped). */
export const recentHistory = internalQuery({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    sessionId: v.id("learningSessions"),
    turnId: v.string(),
  },
  returns: v.array(v.object({ role: v.union(v.literal("learner"), v.literal("tutor")), content: v.string() })),
  handler: async (ctx, args): Promise<TutorHistoryEntry[]> => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_owner_project_session", (q) =>
        q.eq("ownerId", args.ownerId).eq("projectId", args.projectId).eq("sessionId", args.sessionId),
      )
      .order("desc")
      .take(MAX_HISTORY_MESSAGES * 2);
    const newestFirst = rows.filter((row) => row.turnId !== args.turnId);
    const history: TutorHistoryEntry[] = [];
    let chars = 0;
    for (const row of newestFirst) {
      const content = row.content.slice(0, MAX_HISTORY_ENTRY_CHARS);
      if (chars + content.length > MAX_HISTORY_CHARS && history.length > 0) break;
      chars += content.length;
      history.unshift({ role: row.role, content });
    }
    return history;
  },
});

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

async function safeFailTurn(
  ctx: ActionCtx,
  ownerId: string,
  projectId: Id<"projects">,
  turnId: string,
  token: string,
  failureCode: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.tutor.failTurn, { ownerId, projectId, turnId, attemptToken: token, failureCode });
  } catch {
    // The turn row keeps its own state; failed bookkeeping must never mask
    // the observable failure code.
  }
}

/**
 * The turn action. Identity and ownership are derived first, so a foreign
 * project is a non-enumerating `NOT_FOUND` before a turn row, a retrieval
 * query or a provider request exists.
 */
export const runTurn = action({
  args: {
    projectId: v.id("projects"),
    turnId: v.string(),
    text: v.string(),
    sessionKey: v.optional(v.string()),
    rerank: v.optional(v.boolean()),
    practisedTopic: v.optional(v.string()),
  },
  returns: turnResultValidator,
  handler: async (ctx: ActionCtx, args): Promise<TurnResult> => {
    const ownerId = await requireUserId(ctx);
    const turnId = requireTurnId(args.turnId);
    const text = requireLearnerText(args.text);
    const sessionKey = resolveSessionKey(args.sessionKey);

    const project = await ctx.runQuery(internal.tutor.authorizeTurnScope, { ownerId, projectId: args.projectId });
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
      const replay = await ctx.runQuery(internal.tutor.readTurnResult, { ownerId, projectId: args.projectId, turnId });
      if (replay === null) throw turnError("TURN_INCOMPLETE");
      return replay;
    }
    if (begin.state !== "started") {
      const code =
        begin.state === "in-progress"
          ? "TURN_IN_PROGRESS"
          : begin.state === "cancelled"
            ? "TURN_CANCELLED"
            : (begin.failureCode ?? "TURN_FAILED");
      throw turnError(code);
    }
    const token = begin.attemptToken;

    const client = tutorClient(ownerId);
    if (client === null) {
      await safeFailTurn(ctx, ownerId, args.projectId, turnId, token, "TURN_NOT_CONFIGURED");
      throw turnError("TURN_NOT_CONFIGURED");
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
      // S19 minimal mode hook. A configured language-practice project whose
      // learner text is an explicit translation request is answered by the
      // S18 translation task: retrieval and the tutor prompt are skipped for
      // that turn (a translation cites nothing), and no silent language
      // switch ever happens - anything that is not an explicit request stays
      // a normal language-practice turn in the configured learning language.
      const languageConfig = project.mode === "language-practice" ? project.languagePractice : null;
      const translationRoute = languageConfig === null ? null : detectTranslationRoute(text, languageConfig);

      let evidenceMode: TutorEvidenceMode = "no-evidence";
      const evidenceList: TutorEvidence[] = [];
      let system: string;
      let user: string;
      let answerKind: "tutor" | "translation" = "tutor";

      if (translationRoute !== null) {
        answerKind = "translation";
        await ctx.runMutation(internal.tutor.recordRetrieval, {
          ownerId,
          projectId: args.projectId,
          turnId,
          attemptToken: token,
          retrievedChunkIds: [],
          evidence: { status: "insufficient-evidence", reason: "translation-request" },
        });
        const routePrompt = buildRouteTranslationPrompt(translationRoute);
        system = routePrompt.system;
        user = routePrompt.user;
      } else {
        const embedded = await client.embeddings([text], { signal: cancel.signal });
        const retrieval = await ctx.runAction(api.retrieval.retrieveProjectContext, {
          projectId: args.projectId,
          query: text,
          vector: embedded.vectors[0],
          topK: TUTOR_TOP_K,
          ...(args.rerank === undefined ? {} : { rerank: args.rerank }),
          maxContextChars: TUTOR_CONTEXT_CHARS,
        });

        evidenceMode = retrieval.status === "ok" ? "document-backed" : "no-evidence";
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

        system =
          languageConfig === null
            ? buildTutorSystemPrompt({ goal: project.goal, mode: project.mode, evidenceMode })
            : buildLanguagePracticeSystemPrompt({ goal: project.goal, evidenceMode, languagePractice: languageConfig });
        user = buildTutorUserMessage({ learnerText: text, history, evidence: evidenceList });
      }

      const completion = await runTutorTurn(
        client,
        { system, user },
        { signal: cancel.signal, maxAttempts: tutorMaxAttempts(), retryBaseMs: tutorRetryBaseMs() },
      );

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
        answerKind,
      });

      // S19 practice history: recorded only for a configured language-practice
      // tutor turn (a routed translation is not a practised topic). The write
      // is idempotent per turnId, so a replayed commit never duplicates it;
      // it runs strictly after the committed result and is deliberately
      // non-fatal: a history failure is logged and swallowed so it can never
      // roll back, mask or fail an already-committed turn. Authorization
      // inside `recordPractisedTopic` (owner and session re-check) is
      // unchanged - a rejected write simply records nothing.
      if (languageConfig !== null && translationRoute === null) {
        try {
          await ctx.runMutation(internal.languagePractice.recordPractisedTopic, {
            ownerId,
            projectId: args.projectId,
            sessionId,
            turnId,
            topic: practisedTopicFor(text, args.practisedTopic),
            level: languageConfig.level,
            targetLanguage: languageConfig.targetLanguage,
          });
        } catch (error) {
          console.error("[S19] practised-topic history write failed; returning the committed turn unchanged", error);
        }
      }

      return committed;
    } catch (error) {
      const failure = turnFailureCode(error);
      if (failure.code !== "TURN_CANCELLED") {
        await safeFailTurn(ctx, ownerId, args.projectId, turnId, token, failure.code);
      }
      throw new ConvexError(
        failure.retryAfterMs === undefined ? { code: failure.code } : { code: failure.code, retryAfterMs: failure.retryAfterMs },
      );
    } finally {
      watching = false;
      sleeper.wake?.();
      cancel.abort();
      await watcher;
    }
  },
});
