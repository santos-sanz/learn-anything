import { ConvexError, v } from "convex/values";

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

/**
 * A small resumable migration template. First call records progress; a retry
 * completes the same run without duplicating state. Real backfills use bounded
 * indexed batches in place of this cursor stage.
 */
export const bootstrapSchemaV3 = internalMutation({
  args: {},
  returns: migrationResult,
  handler: async (ctx) => {
    const existing = await ctx.db.query("migrationRuns").withIndex("by_migration", (q) => q.eq("migration", BOOTSTRAP_MIGRATION)).unique();
    const now = Date.now();
    if (existing?.status === "completed") return { completed: true, cursor: null, schemaVersion: SCHEMA_VERSION };
    if (existing === null) {
      await ctx.db.insert("migrationRuns", { migration: BOOTSTRAP_MIGRATION, targetSchemaVersion: SCHEMA_VERSION, status: "running", cursor: "write-schema-metadata", attempts: 1, updatedAt: now });
      return { completed: false, cursor: "write-schema-metadata", schemaVersion: SCHEMA_VERSION };
    }
    if (existing.targetSchemaVersion !== SCHEMA_VERSION || existing.cursor !== "write-schema-metadata") {
      throw new ConvexError("Unsupported migration state; stop and investigate.");
    }
    const metadata = await ctx.db.query("schemaMetadata").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
    if (metadata !== null && metadata.schemaVersion > SCHEMA_VERSION) throw new ConvexError("Deployment schema is newer than this migration.");
    if (metadata === null) {
      await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: SCHEMA_VERSION, functionVersion: FUNCTION_VERSION, updatedAt: now });
    } else {
      await ctx.db.patch(metadata._id, { schemaVersion: SCHEMA_VERSION, functionVersion: FUNCTION_VERSION, updatedAt: now });
    }
    await ctx.db.patch(existing._id, { status: "completed", cursor: null, attempts: existing.attempts + 1, updatedAt: now });
    return { completed: true, cursor: null, schemaVersion: SCHEMA_VERSION };
  },
});
