import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { BOOTSTRAP_MIGRATION, FUNCTION_VERSION, SCHEMA_VERSION } from "./version";

const migrationResult = v.object({
  completed: v.boolean(),
  cursor: v.union(v.null(), v.string()),
  schemaVersion: v.number(),
});

/** Verifies that a deployment can run this function release before a backfill. */
export const checkCompatibility = internalQuery({
  args: {},
  returns: v.object({
    compatible: v.boolean(),
    foundSchemaVersion: v.union(v.null(), v.number()),
    expectedSchemaVersion: v.number(),
    expectedFunctionVersion: v.number(),
  }),
  handler: async (ctx) => {
    const metadata = await ctx.db.query("schemaMetadata").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
    return {
      compatible: metadata !== null && metadata.schemaVersion === SCHEMA_VERSION && metadata.functionVersion === FUNCTION_VERSION,
      foundSchemaVersion: metadata?.schemaVersion ?? null,
      expectedSchemaVersion: SCHEMA_VERSION,
      expectedFunctionVersion: FUNCTION_VERSION,
    };
  },
});

const BACKFILL_BATCH = 100;

/**
 * S22 resumable marker migration for schema/function version 9: the optional
 * `documents.deletedAt` deletion tombstone and the `documentChunks`
 * `by_document_seq` index (both additive; S14's version 8 added the
 * `tutorTurns`/`citations` tables this supersedes). No column backfill exists,
 * so the migration is the marker write that adopts any older deployment in
 * place — the same replace-the-marker step S12 took for version 7, which it
 * supersedes while keeping that migration's idempotent `nextAttemptAt`
 * backfill so a pre-v6 deployment is not skipped. Each call performs one
 * bounded batch (indexed by `documentId`) that backfills `nextAttemptAt` on
 * S08-era rows so they enter `by_status_next`, then records the cursor; a retry
 * resumes after the last processed document and the final call writes the
 * version marker. Patches are idempotent, so an interrupted batch that replays
 * changes nothing twice. `maxAttempts` stays optional and is resolved at read
 * time, so no backfill depends on deployment configuration.
 */
export const bootstrapSchemaV9 = internalMutation({
  args: {},
  returns: migrationResult,
  handler: async (ctx) => {
    const existing = await ctx.db.query("migrationRuns").withIndex("by_migration", (q) => q.eq("migration", BOOTSTRAP_MIGRATION)).unique();
    const now = Date.now();
    if (existing?.status === "completed") return { completed: true, cursor: null, schemaVersion: SCHEMA_VERSION };
    if (existing === null) {
      await ctx.db.insert("migrationRuns", { migration: BOOTSTRAP_MIGRATION, targetSchemaVersion: SCHEMA_VERSION, status: "running", cursor: "", attempts: 1, updatedAt: now });
      return { completed: false, cursor: "", schemaVersion: SCHEMA_VERSION };
    }
    if (existing.targetSchemaVersion !== SCHEMA_VERSION) {
      throw new ConvexError("Unsupported migration state; stop and investigate.");
    }
    const cursor = existing.cursor ?? "";
    const batch = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_document", (q) => q.gt("documentId", cursor as Id<"documents">))
      .take(BACKFILL_BATCH);
    if (batch.length > 0) {
      for (const job of batch) {
        if (job.nextAttemptAt === undefined) await ctx.db.patch(job._id, { nextAttemptAt: job.createdAt });
      }
      const nextCursor = batch[batch.length - 1].documentId;
      await ctx.db.patch(existing._id, { cursor: nextCursor, attempts: existing.attempts + 1, updatedAt: Date.now() });
      return { completed: false, cursor: nextCursor, schemaVersion: SCHEMA_VERSION };
    }
    const metadata = await ctx.db.query("schemaMetadata").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
    if (metadata !== null && metadata.schemaVersion > SCHEMA_VERSION) throw new ConvexError("Deployment schema is newer than this migration.");
    if (metadata === null) {
      await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: SCHEMA_VERSION, functionVersion: FUNCTION_VERSION, updatedAt: now });
    } else {
      await ctx.db.patch(metadata._id, { schemaVersion: SCHEMA_VERSION, functionVersion: FUNCTION_VERSION, updatedAt: now });
    }
    await ctx.db.patch(existing._id, { status: "completed", cursor: null, attempts: existing.attempts + 1, updatedAt: Date.now() });
    return { completed: true, cursor: null, schemaVersion: SCHEMA_VERSION };
  },
});
