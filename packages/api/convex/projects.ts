import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";

const ownerId = v.string();
const timestamp = () => Date.now();

/** S05 replaces this internal caller contract with ctx.auth-derived identity. */
type ReadContext = MutationCtx | QueryCtx;

async function requireOwnedProject(ctx: ReadContext, actorUserId: string, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (project === null || project.ownerId !== actorUserId || project.deletedAt !== null) {
    throw new ConvexError("Project not found or not owned by caller.");
  }
  return project;
}

async function requireOwnedSession(ctx: ReadContext, actorUserId: string, projectId: Id<"projects">, sessionId: Id<"learningSessions">) {
  const session = await ctx.db.get(sessionId);
  if (session === null || session.ownerId !== actorUserId || session.projectId !== projectId) {
    throw new ConvexError("Session not found in caller project.");
  }
  return session;
}

export const createProject = internalMutation({
  args: { actorUserId: ownerId, name: v.string() },
  returns: v.id("projects"),
  handler: async (ctx, args) => ctx.db.insert("projects", { ownerId: args.actorUserId, name: args.name, createdAt: timestamp(), deletedAt: null }),
});

export const createGoal = internalMutation({
  args: { actorUserId: ownerId, projectId: v.id("projects"), title: v.string() },
  returns: v.id("learningGoals"),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.actorUserId, args.projectId);
    return ctx.db.insert("learningGoals", { ownerId: args.actorUserId, projectId: args.projectId, title: args.title, createdAt: timestamp() });
  },
});

export const createSession = internalMutation({
  args: { actorUserId: ownerId, projectId: v.id("projects"), sessionKey: v.string() },
  returns: v.id("learningSessions"),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.actorUserId, args.projectId);
    const existing = await ctx.db.query("learningSessions").withIndex("by_owner_project_session_key", (q) => q.eq("ownerId", args.actorUserId).eq("projectId", args.projectId).eq("sessionKey", args.sessionKey)).unique();
    if (existing !== null) return existing._id;
    return ctx.db.insert("learningSessions", { ownerId: args.actorUserId, projectId: args.projectId, sessionKey: args.sessionKey, createdAt: timestamp(), endedAt: null });
  },
});

export const createMessage = internalMutation({
  args: {
    actorUserId: ownerId,
    projectId: v.id("projects"),
    sessionId: v.id("learningSessions"),
    turnId: v.string(),
    idempotencyKey: v.string(),
    role: v.union(v.literal("learner"), v.literal("tutor")),
    content: v.string(),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.actorUserId, args.projectId);
    await requireOwnedSession(ctx, args.actorUserId, args.projectId, args.sessionId);
    const existing = await ctx.db.query("messages").withIndex("by_owner_project_idempotency", (q) => q.eq("ownerId", args.actorUserId).eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing !== null) return existing._id;
    return ctx.db.insert("messages", {
      ownerId: args.actorUserId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      idempotencyKey: args.idempotencyKey,
      role: args.role,
      content: args.content,
      createdAt: timestamp(),
    });
  },
});

export const recordProgress = internalMutation({
  args: { actorUserId: ownerId, projectId: v.id("projects"), eventType: v.string() },
  returns: v.id("progressEvents"),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.actorUserId, args.projectId);
    return ctx.db.insert("progressEvents", { ownerId: args.actorUserId, projectId: args.projectId, eventType: args.eventType, createdAt: timestamp() });
  },
});

export const listProjectSessions = internalQuery({
  args: { actorUserId: ownerId, projectId: v.id("projects") },
  returns: v.array(v.object({ _id: v.id("learningSessions"), sessionKey: v.string() })),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.actorUserId, args.projectId);
    const sessions = await ctx.db.query("learningSessions").withIndex("by_owner_project", (q) => q.eq("ownerId", args.actorUserId).eq("projectId", args.projectId)).collect();
    return sessions.map((session) => ({ _id: session._id, sessionKey: session.sessionKey }));
  },
});

/** Soft-delete first. S05 will expose only auth-derived owner identity. */
export const requestProjectDeletion = internalMutation({
  args: { actorUserId: ownerId, projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.actorUserId, args.projectId);
    await ctx.db.patch(args.projectId, { deletedAt: timestamp() });
    return null;
  },
});

/** Bounded hard-delete step; invoke repeatedly until it reports completed. */
export const deleteProjectBatch = internalMutation({
  args: { actorUserId: ownerId, projectId: v.id("projects"), limit: v.number() },
  returns: v.object({ completed: v.boolean(), deleted: v.number() }),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null || project.ownerId !== args.actorUserId || project.deletedAt === null) throw new ConvexError("Project deletion is not authorized or requested.");
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) throw new ConvexError("Deletion limit must be between 1 and 100.");
    let deleted = 0;
    for (const table of ["messages", "learningSessions", "learningGoals", "progressEvents"] as const) {
      if (deleted === args.limit) break;
      const records = await ctx.db.query(table).withIndex("by_owner_project", (q) => q.eq("ownerId", args.actorUserId).eq("projectId", args.projectId)).take(args.limit - deleted);
      for (const record of records) { await ctx.db.delete(record._id); deleted += 1; }
    }
    const remaining = await Promise.all([
      ctx.db.query("messages").withIndex("by_owner_project", (q) => q.eq("ownerId", args.actorUserId).eq("projectId", args.projectId)).take(1),
      ctx.db.query("learningSessions").withIndex("by_owner_project", (q) => q.eq("ownerId", args.actorUserId).eq("projectId", args.projectId)).take(1),
      ctx.db.query("learningGoals").withIndex("by_owner_project", (q) => q.eq("ownerId", args.actorUserId).eq("projectId", args.projectId)).take(1),
      ctx.db.query("progressEvents").withIndex("by_owner_project", (q) => q.eq("ownerId", args.actorUserId).eq("projectId", args.projectId)).take(1),
    ]);
    if (remaining.some((records) => records.length > 0)) return { completed: false, deleted };
    await ctx.db.delete(args.projectId);
    return { completed: true, deleted };
  },
});
