import { ConvexError, v } from "convex/values";

import { internalQuery, mutation, query } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./projects";

/** Minimal S05 ownership record only; S08 owns document metadata and ingestion. */
export const registerPrivateFile = mutation({
  args: { projectId: v.id("projects"), storageId: v.id("_storage"), contentType: v.string() },
  returns: v.id("privateFiles"),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    return ctx.db.insert("privateFiles", { ...args, ownerId, createdAt: Date.now() });
  },
});

/** The client-facing lookup used by UI; it never returns a bearer storage URL. */
export const getPrivateFile = query({
  args: { projectId: v.id("projects"), fileId: v.id("privateFiles") },
  returns: v.object({ storageId: v.id("_storage"), contentType: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const file = await ctx.db.get(args.fileId);
    if (file === null || file.ownerId !== ownerId || file.projectId !== args.projectId) throw new ConvexError({ code: "NOT_FOUND" });
    return { storageId: file.storageId, contentType: file.contentType };
  },
});

/** HTTP actions call this after deriving identity; do not expose it to clients. */
export const authorizePrivateFileDownload = internalQuery({
  args: { ownerId: v.string(), fileId: v.id("privateFiles") },
  returns: v.object({ storageId: v.id("_storage"), contentType: v.string() }),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (file === null || file.ownerId !== args.ownerId) throw new ConvexError({ code: "NOT_FOUND" });
    await requireOwnedProject(ctx, args.ownerId, file.projectId);
    return { storageId: file.storageId, contentType: file.contentType };
  },
});
