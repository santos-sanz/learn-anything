import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Technical-only state. Business tables are introduced by S04. */
export default defineSchema({
  schemaMetadata: defineTable({
    key: v.literal("primary"),
    schemaVersion: v.number(),
    functionVersion: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  migrationRuns: defineTable({
    migration: v.string(),
    targetSchemaVersion: v.number(),
    status: v.union(v.literal("running"), v.literal("completed")),
    cursor: v.union(v.null(), v.string()),
    attempts: v.number(),
    updatedAt: v.number(),
  }).index("by_migration", ["migration"]),
});
