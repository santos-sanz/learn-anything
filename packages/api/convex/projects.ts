import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";

type ReadContext = MutationCtx | QueryCtx;
/** Any context that carries Convex Auth identity: queries, mutations and HTTP actions. */
type AuthContext = Pick<ActionCtx, "auth">;
const timestamp = () => Date.now();

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

export const createProject = mutation({ args: { name: v.string() }, returns: v.id("projects"), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx);
  return ctx.db.insert("projects", { ownerId, name: args.name, createdAt: timestamp(), deletedAt: null });
} });

export const listProjects = query({ args: {}, returns: v.array(v.object({ _id: v.id("projects"), name: v.string() })), handler: async (ctx) => {
  const ownerId = await requireUserId(ctx);
  const projects = await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect();
  return projects.filter((project) => project.deletedAt === null).map(({ _id, name }) => ({ _id, name }));
} });

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

/** An already missing blob must never block the bounded, retry-safe delete loop. */
async function deleteStoredBlob(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // The referencing row is removed either way; a retry finds it gone.
  }
}

/** Bounded, retry-safe deletion; it never accepts an owner identifier from a client. */
export const deleteProjectBatch = mutation({ args: { projectId: v.id("projects"), limit: v.number() }, returns: v.object({ completed: v.boolean(), deleted: v.number() }), handler: async (ctx, args) => {
  const ownerId = await requireUserId(ctx); const project = await ctx.db.get(args.projectId);
  if (project === null || project.ownerId !== ownerId || project.deletedAt === null) throw new ConvexError({ code: "NOT_FOUND" });
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  let deleted = 0;
  // S08: a document takes its storage blob and its privateFiles row with it.
  const documents = await ctx.db.query("documents").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).take(args.limit - deleted);
  for (const document of documents) {
    await deleteStoredBlob(ctx, document.storageId);
    const file = await ctx.db.get(document.privateFileId);
    if (file !== null && file.ownerId === ownerId && file.projectId === args.projectId) await ctx.db.delete(document.privateFileId);
    await ctx.db.delete(document._id); deleted += 1;
  }
  const files = await ctx.db.query("privateFiles").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).take(args.limit - deleted);
  for (const file of files) { await deleteStoredBlob(ctx, file.storageId); await ctx.db.delete(file._id); deleted += 1; }
  for (const table of ["ingestionJobs", "messages", "learningSessions", "learningGoals", "progressEvents"] as const) {
    if (deleted >= args.limit) break;
    const records = await ctx.db.query(table).withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).take(args.limit - deleted);
    for (const record of records) { await ctx.db.delete(record._id); deleted += 1; }
  }
  const remaining = await Promise.all((["documents", "privateFiles", "ingestionJobs", "messages", "learningSessions", "learningGoals", "progressEvents"] as const).map((table) => ctx.db.query(table).withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).take(1)));
  if (remaining.some((records) => records.length > 0)) return { completed: false, deleted };
  await ctx.db.delete(args.projectId); return { completed: true, deleted };
} });
