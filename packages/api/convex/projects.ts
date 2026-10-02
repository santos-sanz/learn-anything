import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
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

export const requestProjectDeletion = mutation({ args: { projectId: v.id("projects") }, returns: v.null(), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); await requireOwnedProject(ctx, ownerId, args.projectId); await ctx.db.patch(args.projectId, { deletedAt: timestamp() }); return null;
} });

/** Bounded, retry-safe deletion; it never accepts an owner identifier from a client. */
export const deleteProjectBatch = mutation({ args: { projectId: v.id("projects"), limit: v.number() }, returns: v.object({ completed: v.boolean(), deleted: v.number() }), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); const project = await ctx.db.get(args.projectId);
  if (project === null || project.ownerId !== ownerId || project.deletedAt === null) throw new ConvexError({ code: "NOT_FOUND" });
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  let deleted = 0;
  for (const table of ["messages", "learningSessions", "learningGoals", "progressEvents"] as const) {
    const records = await ctx.db.query(table).withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).take(args.limit - deleted);
    for (const record of records) { await ctx.db.delete(record._id); deleted += 1; }
    if (deleted === args.limit) break;
  }
  const remaining = await Promise.all((["messages", "learningSessions", "learningGoals", "progressEvents"] as const).map((table) => ctx.db.query(table).withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).take(1)));
  if (remaining.some((records) => records.length > 0)) return { completed: false, deleted };
  await ctx.db.delete(args.projectId); return { completed: true, deleted };
} });
