import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";

// Keep the test runner independent from Vite's import.meta.glob typings.
const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/migrations.ts": () => import("../convex/migrations.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
};

test("a clean synthetic reset is compatible after bootstrap", async () => {
  const t = convexTest({ schema, modules });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: null });
  await t.mutation(internal.migrations.bootstrapSchemaV2, {});
  expect(await t.mutation(internal.migrations.bootstrapSchemaV2, {})).toEqual({ completed: true, cursor: null, schemaVersion: 2 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 2 });
});

test("the migration retry resumes without duplicate technical state", async () => {
  const t = convexTest({ schema, modules });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV2, {})).toEqual({ completed: false, cursor: "write-schema-metadata", schemaVersion: 2 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV2, {})).toEqual({ completed: true, cursor: null, schemaVersion: 2 });
  const state = await t.run(async (ctx) => ({ metadata: await ctx.db.query("schemaMetadata").collect(), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.metadata).toHaveLength(1);
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0]).toMatchObject({ status: "completed", attempts: 2 });
});

test("a newer deployed schema is rejected instead of being downgraded", async () => {
  const t = convexTest({ schema, modules });
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", {
      migration: "bootstrap-schema-v2",
      targetSchemaVersion: 2,
      status: "running",
      cursor: "write-schema-metadata",
      attempts: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("schemaMetadata", {
      key: "primary",
      schemaVersion: 3,
      functionVersion: 3,
      updatedAt: 1,
    });
  });

  await expect(t.mutation(internal.migrations.bootstrapSchemaV2, {})).rejects.toThrow(
    "Deployment schema is newer than this migration.",
  );
});
