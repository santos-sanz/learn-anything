import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
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
    const result = await t.mutation(internal.migrations.bootstrapSchemaV9, {});
    if (result.completed) return result;
  }
  throw new Error("migration did not complete within the bounded step budget");
};

test("a clean synthetic reset is compatible after bootstrap", async () => {
  const t = makeTest();
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: null });
  await t.mutation(internal.migrations.bootstrapSchemaV9, {});
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: true, cursor: null, schemaVersion: 9 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 9 });
});

test("the migration retry resumes without duplicate technical state", async () => {
  const t = makeTest();
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: false, cursor: "", schemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: true, cursor: null, schemaVersion: 9 });
  const state = await t.run(async (ctx) => ({ metadata: await ctx.db.query("schemaMetadata").collect(), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.metadata).toHaveLength(1);
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0]).toMatchObject({ status: "completed", attempts: 2 });
});

test("a newer deployed schema is rejected instead of being downgraded", async () => {
  const t = makeTest();
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", {
      migration: "bootstrap-schema-v9",
      targetSchemaVersion: 9,
      status: "running",
      cursor: "",
      attempts: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("schemaMetadata", {
      key: "primary",
      schemaVersion: 10,
      functionVersion: 10,
      updatedAt: 1,
    });
  });

  await expect(t.mutation(internal.migrations.bootstrapSchemaV9, {})).rejects.toThrow(
    "Deployment schema is newer than this migration.",
  );
});

test("a schema version 4 (S08 documents) deployment upgrades in place; optional goal/mode read as unset", async () => {
  const t = makeTest();
  const a = t.withIdentity({ subject: "a", issuer: "https://test.example" });
  const legacy = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "Legacy", createdAt: 1, deletedAt: null }));
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v4", targetSchemaVersion: 4, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 4, functionVersion: 4, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 4, expectedSchemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: false, cursor: "", schemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: true, cursor: null, schemaVersion: 9 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 9, expectedFunctionVersion: 9 });
  await expect(a.query(api.projects.getProject, { projectId: legacy })).resolves.toMatchObject({ name: "Legacy", createdAt: 1 });
  const raw = await t.run(async (ctx) => ctx.db.get(legacy));
  expect(raw).toMatchObject({ ownerId: "a", name: "Legacy" });
  expect(raw).not.toHaveProperty("goal");
  expect(raw).not.toHaveProperty("mode");
  const state = await t.run(async (ctx) => ({ runs: await ctx.db.query("migrationRuns").collect(), documents: await ctx.db.query("documents").collect() }));
  expect(state.runs).toHaveLength(2);
  expect(state.documents).toHaveLength(0);
});

test("a schema version 5 (S21) deployment adopts the current marker", async () => {
  const t = makeTest();
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v5", targetSchemaVersion: 5, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 5, functionVersion: 5, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 5, expectedSchemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: false, cursor: "", schemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: true, cursor: null, schemaVersion: 9 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 9, expectedFunctionVersion: 9 });
  const state = await t.run(async (ctx) => ({ runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.runs).toHaveLength(2);
});

test("a schema version 7 (S13) deployment adopts the S22 marker without a backfill", async () => {
  const t = makeTest();
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v7", targetSchemaVersion: 7, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 7, functionVersion: 7, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 7, expectedSchemaVersion: 9, expectedFunctionVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: false, cursor: "", schemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: true, cursor: null, schemaVersion: 9 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 9, expectedFunctionVersion: 9 });
  const state = await t.run(async (ctx) => ({ runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.runs).toHaveLength(2);
});


test("a schema version 8 (S14) deployment adopts the S22 marker; its documents read as live without a backfill", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId: "a", name: "Legacy", createdAt: 1, deletedAt: null });
    const storageId = await ctx.storage.store(new Blob(["legacy"], { type: "text/markdown" }));
    const privateFileId = await ctx.db.insert("privateFiles", { ownerId: "a", projectId, storageId, contentType: "text/markdown", createdAt: 1 });
    const documentId = await ctx.db.insert("documents", {
      ownerId: "a",
      projectId,
      privateFileId,
      storageId,
      filename: "legacy.md",
      extension: "md",
      contentType: "text/markdown",
      sizeBytes: 6,
      status: "ready",
      failureCode: null,
      idempotencyKey: "legacy-key-000008",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v8", targetSchemaVersion: 8, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 8, functionVersion: 8, updatedAt: 1 });
    return { documentId };
  });

  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 8, expectedSchemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: false, cursor: "", schemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: true, cursor: null, schemaVersion: 9 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 9, expectedFunctionVersion: 9 });

  // The optional S22 tombstone field is absent on pre-S22 rows, so they stay
  // valid and read as live documents; no backfill is required.
  const raw = await t.run(async (ctx) => ctx.db.get(ids.documentId));
  expect(raw).toMatchObject({ filename: "legacy.md", status: "ready" });
  expect(raw).not.toHaveProperty("deletedAt");
  const runs = await t.run(async (ctx) => ctx.db.query("migrationRuns").collect());
  expect(runs.filter((run) => run.migration === "bootstrap-schema-v9")).toHaveLength(1);
});

test("a schema version 3 deployment adopts the current marker without a backfill", async () => {
  const t = makeTest();
  const project = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null }));
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v3", targetSchemaVersion: 3, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 3, functionVersion: 3, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 3, expectedSchemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: false, cursor: "", schemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: true, cursor: null, schemaVersion: 9 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 9, expectedFunctionVersion: 9 });
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

  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 4, expectedSchemaVersion: 9 });

  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: false, cursor: "", schemaVersion: 9 });
  const batched = await t.mutation(internal.migrations.bootstrapSchemaV9, {});
  expect(batched).toMatchObject({ completed: false, schemaVersion: 9 });

  // An interrupted backfill that replays its batch must be idempotent.
  const run = await t.run(async (ctx) => ctx.db.query("migrationRuns").withIndex("by_migration", (q) => q.eq("migration", "bootstrap-schema-v9")).unique());
  expect(run).not.toBeNull();
  await t.run(async (ctx) => {
    if (run !== null) await ctx.db.patch(run._id, { cursor: "" });
  });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toMatchObject({ completed: false, schemaVersion: 9 });

  await runToCompletion(t);
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 9, expectedFunctionVersion: 9 });
  const state = await t.run(async (ctx) => ({
    job: await ctx.db.get(ids.jobId),
    runs: await ctx.db.query("migrationRuns").collect(),
    metadata: await ctx.db.query("schemaMetadata").withIndex("by_key", (q) => q.eq("key", "primary")).unique(),
  }));
  expect(state.job).toMatchObject({ status: "queued", attempts: 0, nextAttemptAt: now });
  expect(state.job?.maxAttempts).toBeUndefined();
  expect(state.metadata).toMatchObject({ schemaVersion: 9, functionVersion: 9 });
  const versionNineRuns = state.runs.filter((entry) => entry.migration === "bootstrap-schema-v9");
  expect(versionNineRuns).toHaveLength(1);
  expect(versionNineRuns[0].attempts).toBeGreaterThan(2);
});

test("a schema version 2 deployment upgrades in place without data loss", async () => {
  const t = makeTest();
  const project = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null }));
  await t.run(async (ctx) => {
    await ctx.db.insert("migrationRuns", { migration: "bootstrap-schema-v2", targetSchemaVersion: 2, status: "completed", cursor: null, attempts: 1, updatedAt: 1 });
    await ctx.db.insert("schemaMetadata", { key: "primary", schemaVersion: 2, functionVersion: 2, updatedAt: 1 });
  });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: false, foundSchemaVersion: 2, expectedSchemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: false, cursor: "", schemaVersion: 9 });
  expect(await t.mutation(internal.migrations.bootstrapSchemaV9, {})).toEqual({ completed: true, cursor: null, schemaVersion: 9 });
  expect(await t.query(internal.migrations.checkCompatibility, {})).toMatchObject({ compatible: true, foundSchemaVersion: 9, expectedFunctionVersion: 9 });
  const state = await t.run(async (ctx) => ({ projects: await ctx.db.get(project), runs: await ctx.db.query("migrationRuns").collect() }));
  expect(state.projects).toMatchObject({ ownerId: "a", name: "A" });
  expect(state.runs).toHaveLength(2);
});
