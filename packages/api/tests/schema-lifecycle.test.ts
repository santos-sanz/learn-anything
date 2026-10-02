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
  await t.mutation(internal.migrations.bootstrapSchemaV3, {});
  expect(await t.mutation(internal.migrations.bootstrapSchemaV3, {})).toEqual({ completed: true, cursor: null, schemaVersion: 3 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 3 });
});

test("the migration retry resumes without duplicate technical state", async () => {
  const t = convexTest({ schema, modules });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV3, {})).toEqual({ completed: false, cursor: "write-schema-metadata", schemaVersion: 3 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV3, {})).toEqual({ completed: true, cursor: null, schemaVersion: 3 });
  const state = await t.run(async (ctx) => ({ metadata: await ctx.db.query("schemaMetadata").collect(), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.metadata).toHaveLength(1);
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0]).toMatchObject({ status: "completed", attempts: 2 });
});

test("a newer deployed schema is rejected instead of being downgraded", async () => {
  const t = convexTest({ schema, modules });
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", {
      migration: "bootstrap-schema-v3",
      targetSchemaVersion: 3,
      status: "running",
      cursor: "write-schema-metadata",
      attempts: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("schemaMetadata", {
      key: "primary",
      schemaVersion: 4,
      functionVersion: 4,
      updatedAt: 1,
    });
  });

  await expect(t.mutation(internal.migrations.bootstrapSchemaV3, {})).rejects.toThrow(
    "Deployment schema is newer than this migration.",
  );
});

test("a schema version 2 deployment upgrades in place without data loss", async () => {
  const t = convexTest({ schema, modules });
  const project = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null }));
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v2", targetSchemaVersion: 2, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 2, functionVersion: 2, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 2, expectedSchemaVersion: 3 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV3, {})).toEqual({ completed: false, cursor: "write-schema-metadata", schemaVersion: 3 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV3, {})).toEqual({ completed: true, cursor: null, schemaVersion: 3 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 3, expectedFunctionVersion: 3 });
  const state = await t.run(async (ctx) => ({ projects: await ctx.db.get(project), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.projects).toMatchObject({ ownerId: "a", name: "A" });
  expect(state.runs).toHaveLength(2);
});
