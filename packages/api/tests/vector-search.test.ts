import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import { embeddingBatches, scopeKeyFor } from "../convex/embeddings.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv } from "./helpers/authEnv.js";

// Deployment variables are synthetic for offline tests; no value is a secret.
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/embeddings.ts": () => import("../convex/embeddings.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
};

const makeTest = () => convexTest({ schema, modules });
type TestInstance = ReturnType<typeof makeTest>;

const identity = (subject: string) => ({ subject, issuer: "https://test.example" });

const DIMENSIONS = 4096;
const VERSION_KEY = "seed:v1";

type Tenant = { ownerId: string; projectId: string; documentId: string; jobId: string; chunkIds: string[] };

/** Sparse unit-like vector: explicit (index, value) pairs over a zero row. */
function vec(terms: Array<[number, number]>, dimensions = DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const [index, value] of terms) vector[index] = value;
  return vector;
}

/**
 * Seeds one tenant with a project, document, running job and one chunk per
 * vector through raw rows, then commits the vectors through the production
 * `commitEmbeddings` mutation (so storage validation is exercised too).
 */
async function seedTenant(t: TestInstance, ownerId: string, vectors: number[][], name = "Project"): Promise<Tenant> {
  const tenant = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId, name, createdAt: Date.now(), deletedAt: null });
    const storageId = await ctx.storage.store(new Blob(["seed"], { type: "text/plain" }));
    const privateFileId = await ctx.db.insert("privateFiles", {
      ownerId,
      projectId,
      storageId,
      contentType: "text/plain",
      createdAt: Date.now(),
    });
    const documentId = await ctx.db.insert("documents", {
      ownerId,
      projectId,
      privateFileId,
      storageId,
      filename: "seed.txt",
      extension: "txt",
      contentType: "text/plain",
      sizeBytes: 4,
      status: "ready",
      failureCode: null,
      idempotencyKey: `seed-${ownerId}-${projectId}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const jobId = await ctx.db.insert("ingestionJobs", {
      ownerId,
      projectId,
      documentId,
      status: "running",
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contentVersionKey: VERSION_KEY,
    });
    const chunkIds: string[] = [];
    for (let seq = 0; seq < vectors.length; seq += 1) {
      const chunkId = await ctx.db.insert("documentChunks", {
        ownerId,
        projectId,
        documentId,
        contentVersionKey: VERSION_KEY,
        seq,
        chunkKey: `${VERSION_KEY}#${seq}`,
        text: `seed chunk ${seq}`,
        contentHash: `seed-${seq}`,
        locator: { blockIndex: seq, page: null, heading: null },
        createdAt: Date.now(),
      });
      chunkIds.push(chunkId);
    }
    return { ownerId, projectId, documentId, jobId, chunkIds };
  });
  if (vectors.length > 0) {
    await t.mutation(internal.embeddings.commitEmbeddings, {
      jobId: tenant.jobId as never,
      documentId: tenant.documentId as never,
      ownerId,
      projectId: tenant.projectId as never,
      contentVersionKey: VERSION_KEY,
      model: "qwen3-embedding",
      modelVersion: "qwen3-embedding",
      vectors: vectors.map((vector, seq) => ({ chunkId: tenant.chunkIds[seq] as never, vector })),
    });
  }
  return tenant;
}

const search = async (
  t: TestInstance,
  subject: string | null,
  projectId: string,
  vector: number[],
  limit?: number,
): Promise<{ chunkId: string; documentId: string; seq: number; score: number; text: string }[]> => {
  const caller = subject === null ? t : t.withIdentity(identity(subject));
  return (await caller.action(api.embeddings.searchProjectVectors, {
    projectId: projectId as never,
    vector,
    ...(limit === undefined ? {} : { limit }),
  })) as { chunkId: string; documentId: string; seq: number; score: number; text: string }[];
};

test("stores full-width 4096-dimensional vectors and returns the nearest chunk first", async () => {
  const t = makeTest();
  const tenant = await seedTenant(t, "learner-a", [vec([[1, 1]]), vec([[0, 1], [1, 1]]), vec([[0, 1]])]);

  const results = await search(t, "learner-a", tenant.projectId, vec([[0, 1]]), 3);
  expect(results).toHaveLength(3);
  expect(results.map((hit) => hit.seq)).toEqual([2, 1, 0]);
  expect(results[0].score).toBeCloseTo(1, 5);
  expect(results[1].score).toBeCloseTo(1 / Math.SQRT2, 5);
  expect(results[0].text).toBe("seed chunk 2");
  expect(results[0].documentId).toBe(tenant.documentId);

  const rows = await t.run(async (ctx) => ctx.db.query("chunkEmbeddings").withIndex("by_owner_project", (q) => q.eq("ownerId", "learner-a").eq("projectId", tenant.projectId as never)).collect());
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.embedding.length).toBe(DIMENSIONS);
    expect(row.dimensions).toBe(4096);
    expect(row.model).toBe("qwen3-embedding");
    expect(row.modelVersion).toBe("qwen3-embedding");
    expect(row.scopeKey).toBe(scopeKeyFor("learner-a", tenant.projectId as never));
  }
});

test("search is denied without identity and for a foreign project before any retrieval", async () => {
  const t = makeTest();
  const tenant = await seedTenant(t, "learner-a", [vec([[0, 1]])]);

  await expect(search(t, null, tenant.projectId, vec([[0, 1]]))).rejects.toThrow("UNAUTHENTICATED");
  await expect(search(t, "learner-b", tenant.projectId, vec([[0, 1]]))).rejects.toThrow("NOT_FOUND");

  // A soft-deleted project is unreachable for its own owner too.
  await t.withIdentity(identity("learner-a")).mutation(api.projects.requestProjectDeletion, { projectId: tenant.projectId as never });
  await expect(search(t, "learner-a", tenant.projectId, vec([[0, 1]]))).rejects.toThrow("NOT_FOUND");
});

test("another tenant's vectors are never returned, even with identical content", async () => {
  const t = makeTest();
  const shared = [vec([[0, 1]]), vec([[0, 1], [1, 1]])];
  const a = await seedTenant(t, "learner-a", shared, "A");
  const b = await seedTenant(t, "learner-b", shared, "B");
  const aOther = await seedTenant(t, "learner-a", shared, "A2");

  const fromA = await search(t, "learner-a", a.projectId, vec([[0, 1]]), 8);
  expect(fromA).toHaveLength(2);
  expect(fromA.every((hit) => hit.documentId === a.documentId)).toBe(true);
  expect(fromA.some((hit) => b.chunkIds.includes(hit.chunkId) || aOther.chunkIds.includes(hit.chunkId))).toBe(false);

  const fromB = await search(t, "learner-b", b.projectId, vec([[0, 1]]), 8);
  expect(fromB).toHaveLength(2);
  expect(fromB.every((hit) => hit.documentId === b.documentId)).toBe(true);
});

test("dimension, model and foreign-chunk mismatches are rejected before any row is written", async () => {
  const t = makeTest();
  const tenant = await seedTenant(t, "learner-a", [vec([[0, 1]])]);
  const other = await seedTenant(t, "learner-b", [vec([[0, 1]])]);

  const commit = (args: Record<string, unknown>) =>
    t.mutation(internal.embeddings.commitEmbeddings, {
      jobId: tenant.jobId as never,
      documentId: tenant.documentId as never,
      ownerId: "learner-a",
      projectId: tenant.projectId as never,
      contentVersionKey: VERSION_KEY,
      model: "qwen3-embedding",
      modelVersion: "qwen3-embedding",
      vectors: [{ chunkId: tenant.chunkIds[0] as never, vector: vec([[0, 1]]) }],
      ...args,
    } as never);

  await expect(commit({ vectors: [{ chunkId: tenant.chunkIds[0] as never, vector: vec([[0, 1]], 2048) }] })).rejects.toThrow(
    "EMBEDDING_DIMENSION_MISMATCH",
  );
  await expect(commit({ vectors: [{ chunkId: tenant.chunkIds[0] as never, vector: vec([[0, 1]], 4095) }] })).rejects.toThrow(
    "EMBEDDING_DIMENSION_MISMATCH",
  );
  await expect(commit({ model: "other-embedding-model" })).rejects.toThrow("EMBEDDING_MODEL_MISMATCH");
  await expect(
    commit({ vectors: [{ chunkId: other.chunkIds[0] as never, vector: vec([[0, 1]]) }] }),
  ).rejects.toThrow("NOT_FOUND");

  // Only the original seed row exists for this document; every rejected
  // commit wrote nothing.
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("chunkEmbeddings")
      .withIndex("by_document", (q) => q.eq("documentId", tenant.documentId as never))
      .collect(),
  );
  expect(rows).toHaveLength(1);
});

test("the query vector and limit are validated before retrieval", async () => {
  const t = makeTest();
  const tenant = await seedTenant(t, "learner-a", [vec([[0, 1]])]);

  await expect(search(t, "learner-a", tenant.projectId, vec([[0, 1]], 2048))).rejects.toThrow("VECTOR_DIMENSION_INVALID");
  await expect(search(t, "learner-a", tenant.projectId, vec([[0, 1]], 4097))).rejects.toThrow("VECTOR_DIMENSION_INVALID");
  await expect(search(t, "learner-a", tenant.projectId, vec([[0, 1]]), 0)).rejects.toThrow("INVALID_ARGUMENT");
  await expect(search(t, "learner-a", tenant.projectId, vec([[0, 1]]), 51)).rejects.toThrow("INVALID_ARGUMENT");
  await expect(search(t, "learner-a", tenant.projectId, vec([[0, 1]]), 1.5)).rejects.toThrow("INVALID_ARGUMENT");
});

test("the ownership recheck drops tampered, stale and orphaned rows from the results", async () => {
  const t = makeTest();
  const tenant = await seedTenant(t, "learner-a", [vec([[0, 1]]), vec([[0, 1]]), vec([[0, 1]]), vec([[0, 1]])]);
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("chunkEmbeddings")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", "learner-a").eq("projectId", tenant.projectId as never))
      .take(10),
  );
  expect(rows).toHaveLength(4);
  rows.sort((left, right) => left.seq - right.seq);

  // Row 0 keeps a matching scopeKey but a foreign ownerId: the pre-retrieval
  // filter admits it (scopeKey still matches) and only the recheck can drop it.
  await t.run(async (ctx) => ctx.db.patch(rows[0]._id, { ownerId: "intruder" }));
  // Row 1 points at a superseded content version than its chunk row.
  await t.run(async (ctx) => ctx.db.patch(rows[1]._id, { contentVersionKey: "stale:v0" }));
  // Row 2's chunk was deleted, leaving the vector orphaned.
  await t.run(async (ctx) => ctx.db.delete(rows[2].chunkId as never));

  const results = await search(t, "learner-a", tenant.projectId, vec([[0, 1]]), 8);
  expect(results.map((hit) => hit.seq)).toEqual([3]);
});

test("project deletion takes every embedding row with it", async () => {
  const t = makeTest();
  const tenant = await seedTenant(t, "learner-a", [vec([[0, 1]]), vec([[1, 1]])]);
  const owner = t.withIdentity(identity("learner-a"));
  await owner.mutation(api.projects.requestProjectDeletion, { projectId: tenant.projectId as never });

  let completed = false;
  for (let round = 0; round < 10 && !completed; round += 1) {
    const batch = await owner.mutation(api.projects.deleteProjectBatch, { projectId: tenant.projectId as never, limit: 10 });
    completed = batch.completed;
  }
  expect(completed).toBe(true);
  const rows = await t.run(async (ctx) => ctx.db.query("chunkEmbeddings").collect());
  expect(rows).toHaveLength(0);
  const project = await t.run(async (ctx) => ctx.db.get(tenant.projectId as never));
  expect(project).toBeNull();
});

test("embedding batches respect the provider batch, width and character limits", () => {
  // 40 short items split into exactly [32, 8] with order preserved.
  const many = Array.from({ length: 40 }, (_, index) => `item-${index}`);
  const batches = embeddingBatches(many, (item) => item);
  expect(batches.map((batch) => batch.length)).toEqual([32, 8]);
  expect(batches.flat()).toEqual(many);

  // The 24,000-character joined budget flushes before it is exceeded.
  const long = Array.from({ length: 4 }, () => "x".repeat(6000));
  const longBatches = embeddingBatches(long, (item) => item);
  expect(longBatches.map((batch) => batch.length)).toEqual([3, 1]);
  for (const batch of longBatches) {
    const joined = batch.join(" ");
    expect(joined.length).toBeLessThanOrEqual(24_000);
  }

  expect(embeddingBatches([], (item: string) => item)).toEqual([]);
  const exact = Array.from({ length: 32 }, (_, index) => `chunk-${index}`);
  expect(embeddingBatches(exact, (item) => item).map((batch) => batch.length)).toEqual([32]);
});
