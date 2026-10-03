import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";

type ReadContext = MutationCtx | QueryCtx;
/** Any context that carries Convex Auth identity: queries, mutations and HTTP actions. */
type AuthContext = Pick<ActionCtx, "auth">;
const timestamp = () => Date.now();

const PROJECT_NAME_MAX = 100;
const GOAL_MAX = 500;

/** Learner-facing tracks selected during S21 onboarding; S19/S20 own the tutor behaviour. */
const modeValidator = v.union(v.literal("language-practice"), v.literal("concept-learning"));
type ProjectMode = "language-practice" | "concept-learning";
type ProjectSummary = { _id: Id<"projects">; name: string; goal?: string; mode?: ProjectMode; createdAt: number };

const projectSummary = (project: { _id: Id<"projects">; name: string; goal?: string; mode?: ProjectMode; createdAt: number }): ProjectSummary =>
  ({ _id: project._id, name: project.name, goal: project.goal, mode: project.mode, createdAt: project.createdAt });

function requireName(value: string): string {
  const name = value.trim();
  if (name === "" || name.length > PROJECT_NAME_MAX) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return name;
}

/** Trims the goal; an empty string clears the stored selection. */
function sanitizeGoal(value: string): string | undefined {
  const goal = value.trim();
  if (goal.length > GOAL_MAX) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return goal === "" ? undefined : goal;
}

/**
 * Authentication failures are typed so callers never infer ownership. Identity
 * comes from `ctx.auth`: Convex Auth subjects are `userId|sessionId`, and the
 * session is stripped so a stable user id (never an email address or a
 * client-supplied value) becomes `ownerId`.
 */
export async function requireUserId(ctx: AuthContext): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError({ code: "UNAUTHENTICATED" });
  return userId;
}

export async function requireOwnedProject(ctx: ReadContext, ownerId: string, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (project === null || project.ownerId !== ownerId || project.deletedAt !== null) throw new ConvexError({ code: "NOT_FOUND" });
  return project;
}

async function requireOwnedSession(ctx: ReadContext, ownerId: string, projectId: Id<"projects">, sessionId: Id<"learningSessions">) {
  const session = await ctx.db.get(sessionId);
  if (session === null || session.ownerId !== ownerId || session.projectId !== projectId) throw new ConvexError({ code: "NOT_FOUND" });
  return session;
}

const summaryValidator = v.object({ _id: v.id("projects"), name: v.string(), goal: v.optional(v.string()), mode: v.optional(modeValidator), createdAt: v.number() });

export const createProject = mutation({ args: { name: v.string(), goal: v.optional(v.string()), mode: v.optional(modeValidator) }, returns: v.id("projects"), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx);
  const name = requireName(args.name);
  const goal = args.goal === undefined ? undefined : sanitizeGoal(args.goal);
  return ctx.db.insert("projects", { ownerId, name, ...(goal === undefined ? {} : { goal }), ...(args.mode === undefined ? {} : { mode: args.mode }), createdAt: timestamp(), deletedAt: null });
} });

export const listProjects = query({ args: {}, returns: v.array(summaryValidator), handler: async (ctx) => {
  const ownerId = await requireUserId(ctx);
  const projects = await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect();
  return projects.filter((project) => project.deletedAt === null).map(projectSummary);
} });

/** Owner-only single-project read; foreign, deleted and anonymous requests are non-enumerating. */
export const getProject = query({ args: { projectId: v.id("projects") }, returns: summaryValidator, handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx);
  return projectSummary(await requireOwnedProject(ctx, ownerId, args.projectId));
} });

/**
 * Renames a project and/or updates its goal/mode selection. At least one field
 * is required; an empty `goal` clears the selection. Ownership is re-derived
 * from `ctx.auth`, never accepted as an argument.
 */
export const updateProject = mutation({
  args: { projectId: v.id("projects"), name: v.optional(v.string()), goal: v.optional(v.string()), mode: v.optional(modeValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    if (args.name === undefined && args.goal === undefined && args.mode === undefined) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const patch: { name?: string; goal?: string | undefined; mode?: ProjectMode } = {};
    if (args.name !== undefined) patch.name = requireName(args.name);
    if (args.goal !== undefined) patch.goal = sanitizeGoal(args.goal);
    if (args.mode !== undefined) patch.mode = args.mode;
    await ctx.db.patch(args.projectId, patch);
    return null;
  },
});

export const createGoal = mutation({ args: { projectId: v.id("projects"), title: v.string() }, returns: v.id("learningGoals"), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); await requireOwnedProject(ctx, ownerId, args.projectId);
  return ctx.db.insert("learningGoals", { ownerId, projectId: args.projectId, title: args.title, createdAt: timestamp() });
} });

export const createSession = mutation({ args: { projectId: v.id("projects"), sessionKey: v.string() }, returns: v.id("learningSessions"), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); await requireOwnedProject(ctx, ownerId, args.projectId);
  const existing = await ctx.db.query("learningSessions").withIndex("by_owner_project_session_key", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId).eq("sessionKey", args.sessionKey)).unique();
  if (existing !== null) return existing._id;
  return ctx.db.insert("learningSessions", { ownerId, projectId: args.projectId, sessionKey: args.sessionKey, createdAt: timestamp(), endedAt: null });
} });

export const createMessage = mutation({ args: { projectId: v.id("projects"), sessionId: v.id("learningSessions"), turnId: v.string(), idempotencyKey: v.string(), role: v.union(v.literal("learner"), v.literal("tutor")), content: v.string() }, returns: v.id("messages"), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); await requireOwnedProject(ctx, ownerId, args.projectId); await requireOwnedSession(ctx, ownerId, args.projectId, args.sessionId);
  const existing = await ctx.db.query("messages").withIndex("by_owner_project_idempotency", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey)).unique();
  if (existing !== null) return existing._id;
  return ctx.db.insert("messages", { ownerId, projectId: args.projectId, sessionId: args.sessionId, turnId: args.turnId, idempotencyKey: args.idempotencyKey, role: args.role, content: args.content, createdAt: timestamp() });
} });

export const recordProgress = mutation({ args: { projectId: v.id("projects"), eventType: v.string() }, returns: v.id("progressEvents"), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); await requireOwnedProject(ctx, ownerId, args.projectId);
  return ctx.db.insert("progressEvents", { ownerId, projectId: args.projectId, eventType: args.eventType, createdAt: timestamp() });
} });

export const listProjectRecords = query({ args: { projectId: v.id("projects") }, returns: v.object({ goals: v.array(v.object({ _id: v.id("learningGoals"), title: v.string() })), sessions: v.array(v.object({ _id: v.id("learningSessions"), sessionKey: v.string() })), messages: v.array(v.object({ _id: v.id("messages"), content: v.string() })), progressEvents: v.array(v.object({ _id: v.id("progressEvents"), eventType: v.string() })) }), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); await requireOwnedProject(ctx, ownerId, args.projectId);
  const [goals, sessions, messages, progressEvents] = await Promise.all([
    ctx.db.query("learningGoals").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).collect(),
    ctx.db.query("learningSessions").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).collect(),
    ctx.db.query("messages").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).collect(),
    ctx.db.query("progressEvents").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).collect(),
  ]);
  return { goals: goals.map(({ _id, title }) => ({ _id, title })), sessions: sessions.map(({ _id, sessionKey }) => ({ _id, sessionKey })), messages: messages.map(({ _id, content }) => ({ _id, content })), progressEvents: progressEvents.map(({ _id, eventType }) => ({ _id, eventType })) };
} });

/**
 * Idempotent entry point of the S04 two-phase protocol: an owner may re-run it
 * after an interrupted cleanup and it resumes instead of failing NOT_FOUND, so
 * a retry can always finish the bounded `deleteProjectBatch` loop. Only the
 * soft-delete step is repeated; a project whose row is already hard-deleted
 * completes the invariant that a project row outlives none of its children.
 * Reads and writes through `requireOwnedProject` still reject soft-deleted
 * rows, and identity/ownership come only from `ctx.auth`.
 */
export const requestProjectDeletion = mutation({ args: { projectId: v.id("projects") }, returns: v.null(), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx);
  const project = await ctx.db.get(args.projectId);
  if (project === null || project.ownerId !== ownerId) throw new ConvexError({ code: "NOT_FOUND" });
  const now = timestamp();
  if (project.deletedAt === null) await ctx.db.patch(args.projectId, { deletedAt: now });
  // S24: open (or re-arm) the visible ledger row before any batch runs, so an
  // interrupted cleanup always has a pending/failed state to resume from.
  const active = await findActiveDeletionRequest(ctx, ownerId, "project", args.projectId);
  if (active === null) {
    await ctx.db.insert("deletionRequests", {
      ownerId,
      scope: "project",
      projectId: args.projectId,
      status: "pending",
      failureCode: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  } else if (active.status !== "pending") {
    await ctx.db.patch(active._id, { status: "pending", failureCode: null, updatedAt: now });
  }
  return null;
} });

/** An already missing blob must never block the bounded, retry-safe delete loop. */
async function deleteStoredBlob(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // The referencing row is removed either way; a retry finds it gone.
  }
}

/**
 * S24 deletion ledger: every child row a project or account deletion removes.
 * `documents` and `privateFiles` are handled separately first (they carry
 * storage blobs); the rest are flat owner/project sweeps.
 */
const CHILD_CONTENT_TABLES = [
  "chunkEmbeddings",
  "documentChunks",
  "ingestionJobs",
  "citations",
  "messages",
  "tutorTurns",
  "practisedTopics",
  "learningSessions",
  "learningGoals",
  "progressEvents",
  "telemetryEvents",
  "agentConnectionTokens",
] as const;

const PROJECT_CONTENT_TABLES = ["documents", "privateFiles", ...CHILD_CONTENT_TABLES] as const;

/** Deletes one document's blob, its storage-registry row and the document. */
async function deleteDocumentRow(
  ctx: MutationCtx,
  ownerId: string,
  document: { _id: Id<"documents">; privateFileId: Id<"privateFiles">; storageId: Id<"_storage"> },
  projectId: Id<"projects"> | null,
): Promise<void> {
  await deleteStoredBlob(ctx, document.storageId);
  const file = await ctx.db.get(document.privateFileId);
  if (file !== null && file.ownerId === ownerId && (projectId === null || file.projectId === projectId)) {
    await ctx.db.delete(document.privateFileId);
  }
  await ctx.db.delete(document._id);
}

async function deleteDocumentsBatch(ctx: MutationCtx, ownerId: string, projectId: Id<"projects"> | null, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const query = ctx.db.query("documents");
  const documents =
    projectId === null
      ? await query.withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId)).take(limit)
      : await query.withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(limit);
  for (const document of documents) await deleteDocumentRow(ctx, ownerId, document, projectId);
  return documents.length;
}

async function deleteFilesBatch(ctx: MutationCtx, ownerId: string, projectId: Id<"projects"> | null, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const query = ctx.db.query("privateFiles");
  const files =
    projectId === null
      ? await query.withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId)).take(limit)
      : await query.withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(limit);
  for (const file of files) {
    await deleteStoredBlob(ctx, file.storageId);
    await ctx.db.delete(file._id);
  }
  return files.length;
}

async function deleteChildrenBatch(ctx: MutationCtx, ownerId: string, projectId: Id<"projects"> | null, limit: number): Promise<number> {
  let deleted = 0;
  for (const table of CHILD_CONTENT_TABLES) {
    if (deleted >= limit) break;
    const query = ctx.db.query(table);
    const records =
      projectId === null
        ? await query.withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId)).take(limit - deleted)
        : await query.withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(limit - deleted);
    for (const record of records) {
      await ctx.db.delete(record._id);
      deleted += 1;
    }
  }
  return deleted;
}

async function contentRemains(ctx: MutationCtx, ownerId: string, projectId: Id<"projects"> | null): Promise<boolean> {
  for (const table of PROJECT_CONTENT_TABLES) {
    const query = ctx.db.query(table);
    const rows =
      projectId === null
        ? await query.withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId)).take(1)
        : await query.withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(1);
    if (rows.length > 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * S24 deletion ledger: visible pending/failed state and status reads
 * ------------------------------------------------------------------ */

const deletionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("deleting"),
  v.literal("failed"),
  v.literal("completed"),
);

/** Failure codes are fixed uppercase tokens; anything else becomes the generic code. */
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DELETION_STATUS_TAKE = 50;

export function sanitizeDeletionFailureCode(code: string): string {
  return FAILURE_CODE_PATTERN.test(code) ? code : "DELETION_FAILED";
}

/** Newest active (non-completed) ledger row for one scope; owner-checked. */
async function findActiveDeletionRequest(
  ctx: ReadContext,
  ownerId: string,
  scope: "project" | "account",
  projectId?: Id<"projects">,
): Promise<Doc<"deletionRequests"> | null> {
  if (scope === "project" && projectId !== undefined) {
    const rows = await ctx.db.query("deletionRequests").withIndex("by_project", (q) => q.eq("projectId", projectId)).take(10);
    const candidates = rows.filter((row) => row.ownerId === ownerId && row.scope === "project" && row.status !== "completed");
    candidates.sort((left, right) => right.createdAt - left.createdAt);
    return candidates[0] ?? null;
  }
  const rows = await ctx.db
    .query("deletionRequests")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .order("desc")
    .take(DELETION_STATUS_TAKE);
  return rows.find((row) => row.scope === scope && row.status !== "completed") ?? null;
}

/**
 * Owner-only visibility of the privacy lifecycle: the account request plus
 * every project request that is still pending, deleting or failed. Completed
 * rows are removed when a deletion finishes, so an empty result means nothing
 * is in flight. Anonymous callers are non-enumerating `UNAUTHENTICATED`.
 */
export const getDeletionStatus = query({
  args: {},
  returns: v.object({
    account: v.union(
      v.null(),
      v.object({
        status: deletionStatusValidator,
        failureCode: v.union(v.null(), v.string()),
        attempts: v.number(),
        updatedAt: v.number(),
      }),
    ),
    projects: v.array(
      v.object({
        projectId: v.id("projects"),
        status: deletionStatusValidator,
        failureCode: v.union(v.null(), v.string()),
        updatedAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const rows = await ctx.db.query("deletionRequests").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).order("desc").take(DELETION_STATUS_TAKE);
    const active = rows.filter((row) => row.status !== "completed");
    const account = active.find((row) => row.scope === "account") ?? null;
    const seen = new Set<string>();
    const projects: Array<{ projectId: Id<"projects">; status: "pending" | "deleting" | "failed" | "completed"; failureCode: string | null; updatedAt: number }> = [];
    for (const row of active) {
      if (row.scope !== "project" || row.projectId === undefined) continue;
      if (seen.has(row.projectId)) continue;
      seen.add(row.projectId);
      projects.push({ projectId: row.projectId, status: row.status, failureCode: row.failureCode, updatedAt: row.updatedAt });
    }
    return {
      account:
        account === null
          ? null
          : { status: account.status, failureCode: account.failureCode, attempts: account.attempts, updatedAt: account.updatedAt },
      projects,
    };
  },
});

/**
 * Records a client-observed deletion failure (a rejected batch, an exhausted
 * retry budget or a transport error) as a visible `failed` state. Only the
 * owner may report, only for their own active request, and a completed
 * deletion is never downgraded — a fixed code is stored, never a message.
 */
export const reportDeletionFailure = mutation({
  args: {
    scope: v.union(v.literal("project"), v.literal("account")),
    projectId: v.optional(v.id("projects")),
    code: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const now = timestamp();
    const failureCode = sanitizeDeletionFailureCode(args.code ?? "DELETION_FAILED");
    if (args.scope === "project") {
      if (args.projectId === undefined) throw new ConvexError({ code: "INVALID_ARGUMENT" });
      const active = await findActiveDeletionRequest(ctx, ownerId, "project", args.projectId);
      if (active === null) throw new ConvexError({ code: "NOT_FOUND" });
      await ctx.db.patch(active._id, { status: "failed", failureCode, updatedAt: now });
      return null;
    }
    const active = await findActiveDeletionRequest(ctx, ownerId, "account");
    if (active === null) throw new ConvexError({ code: "NOT_FOUND" });
    await ctx.db.patch(active._id, { status: "failed", failureCode, updatedAt: now });
    return null;
  },
});

/** Bounded, retry-safe deletion; it never accepts an owner identifier from a client. */
export const deleteProjectBatch = mutation({ args: { projectId: v.id("projects"), limit: v.number() }, returns: v.object({ completed: v.boolean(), deleted: v.number() }), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); const project = await ctx.db.get(args.projectId);
  if (project === null || project.ownerId !== ownerId || project.deletedAt === null) throw new ConvexError({ code: "NOT_FOUND" });
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  const now = timestamp();
  const active = await findActiveDeletionRequest(ctx, ownerId, "project", args.projectId);
  let ledgerId: Id<"deletionRequests">;
  if (active === null) {
    ledgerId = await ctx.db.insert("deletionRequests", {
      ownerId,
      scope: "project",
      projectId: args.projectId,
      status: "deleting",
      failureCode: null,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    ledgerId = active._id;
    await ctx.db.patch(ledgerId, { status: "deleting", failureCode: null, attempts: active.attempts + 1, updatedAt: now });
  }
  let deleted = 0;
  const budget = () => args.limit - deleted;
  // S08: a document takes its storage blob and its privateFiles row with it.
  // S09: chunks follow the document they belong to inside the same budget.
  deleted += await deleteDocumentsBatch(ctx, ownerId, args.projectId, budget());
  deleted += await deleteFilesBatch(ctx, ownerId, args.projectId, budget());
  // S12/S13/S14/S19/S20/S24: embeddings, chunks, jobs, citations, messages,
  // turns, practice history, sessions, goals, progress, telemetry and agent
  // tokens all carry ownerId + projectId, so they fall to the same sweep.
  deleted += await deleteChildrenBatch(ctx, ownerId, args.projectId, budget());
  if (await contentRemains(ctx, ownerId, args.projectId)) return { completed: false, deleted };
  // Close the ledger before the root row goes, so a finished deletion leaves
  // no reference to a project that no longer exists.
  await ctx.db.delete(ledgerId);
  await ctx.db.delete(args.projectId); return { completed: true, deleted };
} });

/* ------------------------------------------------------------------ *
 * S24 account deletion: content first, identity last, resumable throughout
 * ------------------------------------------------------------------ */

/** True while any owner-scoped row still exists (content, buckets or identity). */
async function accountResidue(ctx: MutationCtx, ownerId: string): Promise<boolean> {
  if ((await contentRemains(ctx, ownerId, null))) return true;
  if ((await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).take(1)).length > 0) return true;
  if ((await ctx.db.query("rateLimitBuckets").withIndex("by_owner_bucket", (q) => q.eq("ownerId", ownerId)).take(1)).length > 0) return true;
  return await identityRemains(ctx, ownerId);
}

/** True while the auth identity (user row or its sessions/accounts) exists. */
async function identityRemains(ctx: MutationCtx, ownerId: string): Promise<boolean> {
  const userId = ctx.db.normalizeId("users", ownerId);
  if (userId === null) return false;
  if ((await ctx.db.get(userId)) !== null) return true;
  if ((await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(1)).length > 0) return true;
  if ((await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(1)).length > 0) return true;
  return false;
}

/**
 * Deletes the owner's S24 buckets, sign-in rate-limit rows and, in strict
 * child-before-parent order, verification codes, accounts, refresh tokens,
 * verifiers and sessions — the `users` row goes only when every child is
 * already gone. Bounded by `cap` row deletions and safe to resume.
 */
async function ownerIdentityStage(ctx: MutationCtx, ownerId: string, cap: number): Promise<number> {
  let deleted = 0;
  const buckets = await ctx.db.query("rateLimitBuckets").withIndex("by_owner_bucket", (q) => q.eq("ownerId", ownerId)).take(cap - deleted);
  for (const bucket of buckets) {
    await ctx.db.delete(bucket._id);
    deleted += 1;
  }
  const userId = ctx.db.normalizeId("users", ownerId);
  if (userId === null) return deleted;
  const user = await ctx.db.get(userId);
  if (user !== null) {
    for (const identifier of [user.email, user.phone]) {
      if (typeof identifier !== "string" || identifier === "") continue;
      const limits = await ctx.db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", identifier)).take(cap - deleted);
      for (const limit of limits) {
        await ctx.db.delete(limit._id);
        deleted += 1;
      }
    }
    const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(cap - deleted);
    for (const account of accounts) {
      const codes = await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", account._id)).take(cap - deleted);
      for (const code of codes) {
        await ctx.db.delete(code._id);
        deleted += 1;
      }
      if (deleted >= cap) return deleted;
      await ctx.db.delete(account._id);
      deleted += 1;
    }
    const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(cap - deleted);
    for (const session of sessions) {
      const tokens = await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", session._id)).take(cap - deleted);
      for (const token of tokens) {
        await ctx.db.delete(token._id);
        deleted += 1;
      }
      const verifiers = await ctx.db.query("authVerifiers").withIndex("sessionId", (q) => q.eq("sessionId", session._id)).take(cap - deleted);
      for (const verifier of verifiers) {
        await ctx.db.delete(verifier._id);
        deleted += 1;
      }
      if (deleted >= cap) return deleted;
      await ctx.db.delete(session._id);
      deleted += 1;
    }
    if (deleted < cap) {
      const accountsLeft = (await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(1)).length > 0;
      const sessionsLeft = (await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(1)).length > 0;
      let limitsLeft = false;
      for (const identifier of [user.email, user.phone]) {
        if (typeof identifier !== "string" || identifier === "") continue;
        if ((await ctx.db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", identifier)).take(1)).length > 0) limitsLeft = true;
      }
      if (!accountsLeft && !sessionsLeft && !limitsLeft) {
        await ctx.db.delete(userId);
        deleted += 1;
      }
    }
  }
  return deleted;
}

/**
 * Account deletion entry point: opens (or re-arms) the account ledger row and
 * soft-deletes up to 100 live projects. Re-running after a failure resumes
 * instead of failing `NOT_FOUND`; the bounded `runAccountDeletionBatch` loop
 * does the rest. Identity is removed last, only after every content row is
 * gone, and a still-valid access token (≤1 h) can act on the deleted id until
 * it expires — a documented residual window of the pinned S06 token TTL.
 */
export const requestAccountDeletion = mutation({ args: {}, returns: v.null(), handler: async (ctx) => {
  const ownerId = await requireUserId(ctx);
  const now = timestamp();
  const active = await findActiveDeletionRequest(ctx, ownerId, "account");
  if (active === null) {
    await ctx.db.insert("deletionRequests", {
      ownerId,
      scope: "account",
      status: "pending",
      failureCode: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
  } else if (active.status !== "pending") {
    await ctx.db.patch(active._id, { status: "pending", failureCode: null, updatedAt: now });
  }
  const live = await ctx.db.query("projects").withIndex("by_owner_deleted", (q) => q.eq("ownerId", ownerId).eq("deletedAt", null)).take(100);
  for (const project of live) await ctx.db.patch(project._id, { deletedAt: now });
  return null;
} });

/**
 * One bounded account-deletion batch. Order is strict: soft-delete live
 * projects first (so content of a project that has not entered deletion is
 * never touched), then documents with their blobs, storage-registry rows,
 * every child content table, then the project rows themselves, and only when
 * nothing else remains the owner's identity. A completed request closes its
 * ledger row; a repeat call after completion reports `completed` with no work.
 */
export const runAccountDeletionBatch = mutation({
  args: { limit: v.number() },
  returns: v.object({ completed: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args): Promise<{ completed: boolean; deleted: number }> => {
    const ownerId = await requireUserId(ctx);
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const active = await findActiveDeletionRequest(ctx, ownerId, "account");
    if (active === null) {
      if (await accountResidue(ctx, ownerId)) throw new ConvexError({ code: "NOT_FOUND" });
      return { completed: true, deleted: 0 };
    }
    const now = timestamp();
    await ctx.db.patch(active._id, { status: "deleting", failureCode: null, attempts: active.attempts + 1, updatedAt: now });
    let deleted = 0;
    const budget = () => args.limit - deleted;

    const live = await ctx.db.query("projects").withIndex("by_owner_deleted", (q) => q.eq("ownerId", ownerId).eq("deletedAt", null)).take(budget());
    for (const project of live) {
      await ctx.db.patch(project._id, { deletedAt: now });
      deleted += 1;
    }
    const moreLive = (await ctx.db.query("projects").withIndex("by_owner_deleted", (q) => q.eq("ownerId", ownerId).eq("deletedAt", null)).take(1)).length > 0;
    if (moreLive) return { completed: false, deleted };

    deleted += await deleteDocumentsBatch(ctx, ownerId, null, budget());
    deleted += await deleteFilesBatch(ctx, ownerId, null, budget());
    deleted += await deleteChildrenBatch(ctx, ownerId, null, budget());

    if (!(await contentRemains(ctx, ownerId, null))) {
      if (budget() > 0) {
        const projects = await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).take(budget());
        for (const project of projects) {
          // A project-scoped ledger row must not outlive its project.
          const ledgers = await ctx.db.query("deletionRequests").withIndex("by_project", (q) => q.eq("projectId", project._id)).take(5);
          for (const ledger of ledgers) await ctx.db.delete(ledger._id);
          await ctx.db.delete(project._id);
          deleted += 1;
        }
      }
      const projectsLeft = (await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).take(1)).length > 0;
      if (!projectsLeft) deleted += await ownerIdentityStage(ctx, ownerId, budget());
    }

    const complete =
      !(await contentRemains(ctx, ownerId, null)) &&
      (await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).take(1)).length === 0 &&
      !(await accountResidueBucketsOrIdentity(ctx, ownerId));
    if (complete) await ctx.db.delete(active._id);
    return { completed: complete, deleted };
  },
});

/** Completion probe for the account batch: buckets and identity must be gone too. */
async function accountResidueBucketsOrIdentity(ctx: MutationCtx, ownerId: string): Promise<boolean> {
  if ((await ctx.db.query("rateLimitBuckets").withIndex("by_owner_bucket", (q) => q.eq("ownerId", ownerId)).take(1)).length > 0) return true;
  return await identityRemains(ctx, ownerId);
}
