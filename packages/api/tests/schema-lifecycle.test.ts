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
  await t.mutation(internal.migrations.bootstrapSchemaV4, {});
  expect(await t.mutation(internal.migrations.bootstrapSchemaV4, {})).toEqual({ completed: true, cursor: null, schemaVersion: 4 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 4 });
});

test("the migration retry resumes without duplicate technical state", async () => {
  const t = convexTest({ schema, modules });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV4, {})).toEqual({ completed: false, cursor: "write-schema-metadata", schemaVersion: 4 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV4, {})).toEqual({ completed: true, cursor: null, schemaVersion: 4 });
  const state = await t.run(async (ctx) => ({ metadata: await ctx.db.query("schemaMetadata").collect(), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.metadata).toHaveLength(1);
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0]).toMatchObject({ status: "completed", attempts: 2 });
});

test("a newer deployed schema is rejected instead of being downgraded", async () => {
  const t = convexTest({ schema, modules });
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", {
      migration: "bootstrap-schema-v4",
      targetSchemaVersion: 4,
      status: "running",
      cursor: "write-schema-metadata",
      attempts: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("schemaMetadata", {
      key: "primary",
      schemaVersion: 5,
      functionVersion: 5,
      updatedAt: 1,
    });
  });

  await expect(t.mutation(internal.migrations.bootstrapSchemaV4, {})).rejects.toThrow(
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
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 2, expectedSchemaVersion: 4 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV4, {})).toEqual({ completed: false, cursor: "write-schema-metadata", schemaVersion: 4 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV4, {})).toEqual({ completed: true, cursor: null, schemaVersion: 4 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 4, expectedFunctionVersion: 4 });
  const state = await t.run(async (ctx) => ({ projects: await ctx.db.get(project), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.projects).toMatchObject({ ownerId: "a", name: "A" });
  expect(state.runs).toHaveLength(2);
});

test("a schema version 3 deployment adopts the S08 marker without a backfill", async () => {
  const t = convexTest({ schema, modules });
  const project = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null }));
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v3", targetSchemaVersion: 3, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 3, functionVersion: 3, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 3, expectedSchemaVersion: 4 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV4, {})).toEqual({ completed: false, cursor: "write-schema-metadata", schemaVersion: 4 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV4, {})).toEqual({ completed: true, cursor: null, schemaVersion: 4 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 4, expectedFunctionVersion: 4 });
  const state = await t.run(async (ctx) => ({
    project: await ctx.db.get(project),
    runs: await ctx.db.query("migrationRuns").collect(),
    documents: await ctx.db.query("documents").collect(),
  }));
  expect(state.project).toMatchObject({ ownerId: "a", name: "A" });
  expect(state.documents).toHaveLength(0);
  expect(state.runs).toHaveLength(2);
});
