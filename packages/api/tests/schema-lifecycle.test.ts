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

const makeTest = () => convexTest({ schema, modules });
type TestInstance = ReturnType<typeof makeTest>;

const runToCompletion = async (t: TestInstance): Promise<{ completed: boolean; cursor: string | null; schemaVersion: number }> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await t.mutation(internal.migrations.bootstrapSchemaV5, {});
    if (result.completed) return result;
  }
  throw new Error("migration did not complete within the bounded step budget");
};

test("a clean synthetic reset is compatible after bootstrap", async () => {
  const t = makeTest();
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: null });
  await t.mutation(internal.migrations.bootstrapSchemaV5, {});
  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toEqual({ completed: true, cursor: null, schemaVersion: 5 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 5 });
});

test("the migration retry resumes without duplicate technical state", async () => {
  const t = makeTest();
  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toEqual({ completed: false, cursor: "", schemaVersion: 5 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toEqual({ completed: true, cursor: null, schemaVersion: 5 });
  const state = await t.run(async (ctx) => ({ metadata: await ctx.db.query("schemaMetadata").collect(), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.metadata).toHaveLength(1);
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0]).toMatchObject({ status: "completed", attempts: 2 });
});

test("a newer deployed schema is rejected instead of being downgraded", async () => {
  const t = makeTest();
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", {
      migration: "bootstrap-schema-v5",
      targetSchemaVersion: 5,
      status: "running",
      cursor: "",
      attempts: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("schemaMetadata", {
      key: "primary",
      schemaVersion: 6,
      functionVersion: 6,
      updatedAt: 1,
    });
  });

  await expect(t.mutation(internal.migrations.bootstrapSchemaV5, {})).rejects.toThrow(
    "Deployment schema is newer than this migration.",
  );
});

test("a schema version 2 deployment upgrades in place without data loss", async () => {
  const t = makeTest();
  const project = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null }));
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v2", targetSchemaVersion: 2, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 2, functionVersion: 2, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 2, expectedSchemaVersion: 5 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toEqual({ completed: false, cursor: "", schemaVersion: 5 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toEqual({ completed: true, cursor: null, schemaVersion: 5 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 5, expectedFunctionVersion: 5 });
  const state = await t.run(async (ctx) => ({ projects: await ctx.db.get(project), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.projects).toMatchObject({ ownerId: "a", name: "A" });
  expect(state.runs).toHaveLength(2);
});

test("a schema version 3 deployment adopts the S09 marker without a backfill", async () => {
  const t = makeTest();
  const project = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null }));
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v3", targetSchemaVersion: 3, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 3, functionVersion: 3, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 3, expectedSchemaVersion: 5 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toEqual({ completed: false, cursor: "", schemaVersion: 5 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toEqual({ completed: true, cursor: null, schemaVersion: 5 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 5, expectedFunctionVersion: 5 });
  const state = await t.run(async (ctx) => ({
    project: await ctx.db.get(project),
    runs: await ctx.db.query("migrationRuns").collect(),
    documents: await ctx.db.query("documents").collect(),
  }));
  expect(state.project).toMatchObject({ ownerId: "a", name: "A" });
  expect(state.documents).toHaveLength(0);
  expect(state.runs).toHaveLength(2);
});

test("a schema version 4 deployment backfills S09 fields on existing jobs", async () => {
  const t = makeTest();
  const now = 1_700_000_000_000;
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null });
    const storageId = await ctx.storage.store(new Blob(["synthetic"], { type: "text/plain" }));
    const privateFileId = await ctx.db.insert("privateFiles", { ownerId: "a", projectId, storageId, contentType: "text/plain", createdAt: now });
    const documentId = await ctx.db.insert("documents", {
      ownerId: "a",
      projectId,
      privateFileId,
      storageId,
      filename: "legacy.txt",
      extension: "txt",
      contentType: "text/plain",
      sizeBytes: 9,
      status: "pending",
      failureCode: null,
      idempotencyKey: "legacy-key-000001",
      createdAt: now,
      updatedAt: now,
    });
    // An S08-era job row: no optional S09 lease/retry fields exist yet.
    const jobId = await ctx.db.insert("ingestionJobs", {
      ownerId: "a",
      projectId,
      documentId,
      status: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v4", targetSchemaVersion: 4, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 4, functionVersion: 4, updatedAt: 1 });
    return { projectId, jobId };
  });

  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 4, expectedSchemaVersion: 5 });

  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toEqual({ completed: false, cursor: "", schemaVersion: 5 });
  const batched = await t.mutation(internal.migrations.bootstrapSchemaV5, {});
  expect(batched).toMatchObject({ completed: false, schemaVersion: 5 });

  // An interrupted backfill that replays its batch must be idempotent.
  const run = await t.run(async (ctx) => ctx.db.query("migrationRuns").withIndex("by_migration", (q) => q.eq("migration", "bootstrap-schema-v5")).unique());
  expect(run).not.toBeNull();
  await t.run(async (ctx) => {
    if (run !== null) await ctx.db.patch(run._id, { cursor: "" });
  });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV5, {})).toMatchObject({ completed: false, schemaVersion: 5 });

  await runToCompletion(t);
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 5, expectedFunctionVersion: 5 });
  const state = await t.run(async (ctx) => ({
    job: await ctx.db.get(ids.jobId),
    runs: await ctx.db.query("migrationRuns").collect(),
    metadata: await ctx.db.query("schemaMetadata").withIndex("by_key", (q) => q.eq("key", "primary")).unique(),
  }));
  expect(state.job).toMatchObject({ status: "queued", attempts: 0, nextAttemptAt: now });
  expect(state.job?.maxAttempts).toBeUndefined();
  expect(state.metadata).toMatchObject({ schemaVersion: 5, functionVersion: 5 });
  const versionFiveRuns = state.runs.filter((entry) => entry.migration === "bootstrap-schema-v5");
  expect(versionFiveRuns).toHaveLength(1);
  expect(versionFiveRuns[0].attempts).toBeGreaterThan(2);
});
