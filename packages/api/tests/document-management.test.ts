import { readFileSync } from "node:fs";

import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv } from "./helpers/authEnv.js";
import { installEmbeddingProvider } from "./helpers/embeddingProvider.js";

// Deployment variables are synthetic for offline tests; no value is a secret.
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/documents.ts": () => import("../convex/documents.js"),
  "../convex/embeddings.ts": () => import("../convex/embeddings.js"),
  "../convex/files.ts": () => import("../convex/files.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/ingestion.ts": () => import("../convex/ingestion.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
};

// The ingestion cycle embeds through the S12 provider path: the key/deployer
// are synthetic and fetch is stubbed so no test can reach the network.
let restoreEmbeddingProvider: () => void;
beforeEach(() => {
  restoreEmbeddingProvider = installEmbeddingProvider("a");
});
afterEach(() => {
  restoreEmbeddingProvider();
});

const makeTest = () => convexTest({ schema, modules });
type TestInstance = ReturnType<typeof makeTest>;
type TestUser = ReturnType<TestInstance["withIdentity"]>;

const identity = (subject: string) => ({ subject, issuer: "https://test.example" });

const fixture = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const uploadPath = (projectId: string, filename: string, idempotencyKey: string): string =>
  `/private-uploads?projectId=${encodeURIComponent(projectId)}&filename=${encodeURIComponent(filename)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`;

const post = (body: BodyInit, contentType?: string): RequestInit => ({
  method: "POST",
  body,
  ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
});

type UploadBody = { documentId: string; privateFileId: string; jobId: string; filename: string; status: string; idempotent: boolean };

async function upload(user: TestUser, projectId: string, filename: string, key: string, expected: number = 201): Promise<UploadBody> {
  const contentType = filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".md") ? "text/markdown" : "text/plain";
  const response = await user.fetch(uploadPath(projectId, filename, key), post(fixture(filename), contentType));
  expect(response.status).toBe(expected);
  return (await response.json()) as UploadBody;
}

/** Uploads a document and drives one real ingestion cycle so it lands `ready`. */
async function seedReadyDocument(t: TestInstance, user: TestUser, projectId: string, filename: string, key: string): Promise<UploadBody> {
  const uploaded = await upload(user, projectId, filename, key);
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "succeeded" }]);
  return uploaded;
}

async function countRows(t: TestInstance, table: "documents" | "privateFiles" | "ingestionJobs" | "documentChunks" | "chunkEmbeddings"): Promise<number> {
  const rows = await t.run(async (ctx) => ctx.db.query(table).collect());
  return rows.length;
}

async function storedBlobCount(t: TestInstance): Promise<number> {
  const rows = await t.run(async (ctx) => ctx.db.system.query("_storage" as never).collect() as Promise<Record<string, unknown>[]>);
  return rows.length;
}


/** Drives the bounded delete loop the UI runs; fails loudly if it never ends. */
async function deleteDocumentFully(user: TestUser, projectId: string, documentId: string, limit = 100): Promise<number> {
  let calls = 0;
  for (; calls < 50; calls += 1) {
    const result = await user.mutation(api.documents.deleteDocumentBatch, { projectId: projectId as never, documentId: documentId as never, limit });
    if (result.completed) return calls + 1;
  }
  throw new Error("document deletion did not complete within the batch cap");
}

test("the document list joins every document with its real job state across the upload-to-ready flow", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });

  const uploaded = await upload(a, projectId, "lesson.md", "mgmt-key-000001");
  const pending = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(pending).toHaveLength(1);
  expect(pending[0].document).toMatchObject({ filename: "lesson.md", status: "pending", failureCode: null });
  expect(pending[0].job).toMatchObject({ _id: uploaded.jobId, status: "queued", attempts: 0, failureCode: null, chunkCount: null });
  expect(pending[0].job?.maxAttempts).toBeGreaterThanOrEqual(1);

  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.outcomes[0].outcome).toBe("succeeded");

  const ready = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(ready).toHaveLength(1);
  expect(ready[0].document).toMatchObject({ status: "ready", failureCode: null });
  expect(ready[0].job).toMatchObject({ status: "succeeded", attempts: 1 });
  expect(ready[0].job?.chunkCount).toBeGreaterThan(0);

  // A retry-scheduled job surfaces its real backoff fields, not a fake state:
  // while attempts remain the document stays `pending` (only terminal states
  // settle it), which is exactly what a transient failure looks like.
  await t.run(async (ctx) => {
    const job = await ctx.db.get(uploaded.jobId as never);
    const document = await ctx.db.get(uploaded.documentId as never);
    if (job !== null) await ctx.db.patch(job._id, { status: "queued", attempts: 2, failureCode: "PARSE_FAILED", nextAttemptAt: 1_760_000_000_000 });
    if (document !== null) await ctx.db.patch(document._id, { status: "pending", failureCode: null });
  });
  const backingOff = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(backingOff[0].document).toMatchObject({ status: "pending", failureCode: null });
  expect(backingOff[0].job).toMatchObject({ status: "queued", attempts: 2, failureCode: "PARSE_FAILED", nextAttemptAt: 1_760_000_000_000 });
});

test("the document status list is owner-scoped: anonymous, foreign project and other users are denied", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const projectB = await b.mutation(api.projects.createProject, { name: "B" });
  await upload(a, projectA, "notes.txt", "iso-key-000001");

  await expect(t.query(api.documents.listDocumentStatuses, { projectId: projectA })).rejects.toThrow("UNAUTHENTICATED");
  await expect(b.query(api.documents.listDocumentStatuses, { projectId: projectA })).rejects.toThrow("NOT_FOUND");
  expect(await b.query(api.documents.listDocumentStatuses, { projectId: projectB })).toEqual([]);

  const own = await a.query(api.documents.listDocumentStatuses, { projectId: projectA });
  expect(own.map((entry) => entry.document.filename)).toEqual(["notes.txt"]);
});

test("a legacy pre-S22 document row without a tombstone field still lists, with or without its job", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId: "a", name: "Legacy", createdAt: 1, deletedAt: null });
    const storageId = await ctx.storage.store(new Blob(["legacy"], { type: "text/plain" }));
    const privateFileId = await ctx.db.insert("privateFiles", { ownerId: "a", projectId, storageId, contentType: "text/plain", createdAt: 1 });
    const documentId = await ctx.db.insert("documents", {
      ownerId: "a",
      projectId,
      privateFileId,
      storageId,
      filename: "legacy.txt",
      extension: "txt",
      contentType: "text/plain",
      sizeBytes: 6,
      status: "pending",
      failureCode: null,
      idempotencyKey: "legacy-key-000001",
      createdAt: 1,
      updatedAt: 1,
    });
    return { projectId, documentId };
  });

  const rows = await a.query(api.documents.listDocumentStatuses, { projectId: ids.projectId });
  expect(rows).toHaveLength(1);
  expect(rows[0].document).toMatchObject({ filename: "legacy.txt", status: "pending" });
  expect(rows[0].job).toBeNull();
});

test("retrying a dead-lettered job re-arms it once and never duplicates the job", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await upload(a, projectId, "notes.txt", "retry-key-00001");
  await t.run(async (ctx) => {
    const job = await ctx.db.get(uploaded.jobId as never);
    const document = await ctx.db.get(uploaded.documentId as never);
    if (job !== null) await ctx.db.patch(job._id, { status: "failed", attempts: 5, failureCode: "PARSE_FAILED", updatedAt: Date.now() });
    if (document !== null) await ctx.db.patch(document._id, { status: "failed", failureCode: "PARSE_FAILED", updatedAt: Date.now() });
  });

  const first = await a.mutation(api.documents.retryDocument, { projectId, documentId: uploaded.documentId as never });
  expect(first.retried).toBe(true);
  expect(first.job).toMatchObject({ status: "queued", attempts: 0, failureCode: null, nextAttemptAt: expect.any(Number) });
  expect(await countRows(t, "ingestionJobs")).toBe(1);

  // A second click (or a replayed request) is a no-op: same job, no duplicates.
  const second = await a.mutation(api.documents.retryDocument, { projectId, documentId: uploaded.documentId as never });
  expect(second.retried).toBe(false);
  expect(second.job).toMatchObject({ status: "queued", attempts: 0 });
  expect(await countRows(t, "ingestionJobs")).toBe(1);

  const listed = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(listed[0].document).toMatchObject({ status: "pending", failureCode: null });

  // The re-armed budget actually runs the job to completion.
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "succeeded" }]);
  const ready = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(ready[0].document.status).toBe("ready");
});

test("retry is a no-op for queued, running and succeeded jobs", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await seedReadyDocument(t, a, projectId, "lesson.md", "noop-key-000001");

  const succeeded = await a.mutation(api.documents.retryDocument, { projectId, documentId: uploaded.documentId as never });
  expect(succeeded.retried).toBe(false);
  expect(succeeded.job).toMatchObject({ status: "succeeded" });

  await t.run(async (ctx) => {
    const job = await ctx.db.get(uploaded.jobId as never);
    if (job !== null) await ctx.db.patch(job._id, { status: "running", attempts: 1, leaseOwner: "worker-x", leaseExpiresAt: Date.now() + 60_000 });
  });
  const running = await a.mutation(api.documents.retryDocument, { projectId, documentId: uploaded.documentId as never });
  expect(running.retried).toBe(false);
  expect(running.job).toMatchObject({ status: "running", attempts: 1 });
  expect(await countRows(t, "ingestionJobs")).toBe(1);

  await t.run(async (ctx) => {
    const job = await ctx.db.get(uploaded.jobId as never);
    if (job !== null) await ctx.db.patch(job._id, { status: "queued", attempts: 1, leaseOwner: undefined, leaseExpiresAt: undefined });
  });
  const queued = await a.mutation(api.documents.retryDocument, { projectId, documentId: uploaded.documentId as never });
  expect(queued.retried).toBe(false);
  expect(queued.job).toMatchObject({ status: "queued" });
  expect(await countRows(t, "ingestionJobs")).toBe(1);
});

test("an unsupported document is terminally rejected instead of silently retried", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await upload(a, projectId, "notes.txt", "unsup-key-00001");
  await t.run(async (ctx) => {
    const job = await ctx.db.get(uploaded.jobId as never);
    const document = await ctx.db.get(uploaded.documentId as never);
    if (job !== null) await ctx.db.patch(job._id, { status: "unsupported", attempts: 1, failureCode: "ENCRYPTED_PDF" });
    if (document !== null) await ctx.db.patch(document._id, { status: "failed", failureCode: "ENCRYPTED_PDF" });
  });

  await expect(a.mutation(api.documents.retryDocument, { projectId, documentId: uploaded.documentId as never })).rejects.toThrow("RETRY_NOT_ALLOWED");
  expect(await countRows(t, "ingestionJobs")).toBe(1);
  const listed = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(listed[0].job).toMatchObject({ status: "unsupported", failureCode: "ENCRYPTED_PDF" });
});

test("retry enforces authentication and ownership with non-enumerating errors", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const projectB = await b.mutation(api.projects.createProject, { name: "B" });
  const uploaded = await upload(a, projectA, "notes.txt", "deny-key-000001");

  await expect(t.mutation(api.documents.retryDocument, { projectId: projectA, documentId: uploaded.documentId as never })).rejects.toThrow("UNAUTHENTICATED");
  await expect(b.mutation(api.documents.retryDocument, { projectId: projectA, documentId: uploaded.documentId as never })).rejects.toThrow("NOT_FOUND");
  await expect(b.mutation(api.documents.retryDocument, { projectId: projectB, documentId: uploaded.documentId as never })).rejects.toThrow("NOT_FOUND");
  // A retry after deletion must not resurrect the tombstoned document.
  await deleteDocumentFully(a, projectA, uploaded.documentId);
  await expect(a.mutation(api.documents.retryDocument, { projectId: projectA, documentId: uploaded.documentId as never })).rejects.toThrow("NOT_FOUND");
  expect(await countRows(t, "ingestionJobs")).toBe(0);
});

test("document deletion purges jobs, chunks, embeddings, file rows and bytes, then leaves only the tombstone", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await seedReadyDocument(t, a, projectId, "three-page-lesson.pdf", "del-key-000001");

  expect(await countRows(t, "documentChunks")).toBeGreaterThan(0);
  expect(await countRows(t, "chunkEmbeddings")).toBeGreaterThan(0);
  expect(await countRows(t, "ingestionJobs")).toBe(1);
  expect(await countRows(t, "privateFiles")).toBe(1);
  expect(await storedBlobCount(t)).toBe(1);

  // The bounded loop (small batch) must finish; every step is resumable.
  const calls = await deleteDocumentFully(a, projectId, uploaded.documentId, 2);
  expect(calls).toBeGreaterThanOrEqual(1);

  expect(await countRows(t, "documentChunks")).toBe(0);
  expect(await countRows(t, "chunkEmbeddings")).toBe(0);
  expect(await countRows(t, "ingestionJobs")).toBe(0);
  expect(await countRows(t, "privateFiles")).toBe(0);
  expect(await storedBlobCount(t)).toBe(0);

  const documents = await t.run(async (ctx) => ctx.db.query("documents").collect());
  expect(documents).toHaveLength(1);
  expect(documents[0]).toMatchObject({ filename: "three-page-lesson.pdf", status: "pending" });
  expect(typeof documents[0].deletedAt).toBe("number");

  // The tombstone is invisible to every read surface.
  expect(await a.query(api.documents.listDocumentStatuses, { projectId })).toEqual([]);
  expect(await a.query(api.documents.listDocuments, { projectId })).toEqual([]);
  await expect(a.query(api.documents.getDocument, { projectId, documentId: uploaded.documentId as never })).rejects.toThrow("NOT_FOUND");

  // Re-running the cleanup after completion is an idempotent no-op.
  const again = await a.mutation(api.documents.deleteDocumentBatch, { projectId, documentId: uploaded.documentId as never, limit: 100 });
  expect(again).toEqual({ completed: true, deleted: 0 });
  expect(await countRows(t, "documents")).toBe(1);
});

test("a pending document with no chunks is deleted in one bounded call", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await upload(a, projectId, "notes.txt", "pend-key-000001");

  const result = await a.mutation(api.documents.deleteDocumentBatch, { projectId, documentId: uploaded.documentId as never, limit: 100 });
  expect(result.completed).toBe(true);
  expect(await countRows(t, "documents")).toBe(1);
  expect(await countRows(t, "privateFiles")).toBe(0);
  expect(await storedBlobCount(t)).toBe(0);
});

test("deletion survives an interrupted cleanup: a capped loop resumes to completion", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await seedReadyDocument(t, a, projectId, "three-page-lesson.pdf", "int-key-000001");
  const chunksBefore = await countRows(t, "documentChunks");
  expect(chunksBefore).toBeGreaterThan(0);

  // One deliberately tiny batch: phase one lands, content is not finished.
  const first = await a.mutation(api.documents.deleteDocumentBatch, { projectId, documentId: uploaded.documentId as never, limit: 1 });
  expect(first.completed).toBe(false);
  const listed = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(listed).toEqual([]);
  expect(await countRows(t, "documents")).toBe(1);

  await deleteDocumentFully(a, projectId, uploaded.documentId, 1);
  expect(await countRows(t, "documentChunks")).toBe(0);
  expect(await countRows(t, "chunkEmbeddings")).toBe(0);
  expect(await countRows(t, "ingestionJobs")).toBe(0);
  expect(await storedBlobCount(t)).toBe(0);
});

test("another user cannot delete or observe a foreign document, and anonymous deletion is rejected", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const projectB = await b.mutation(api.projects.createProject, { name: "B" });
  const uploaded = await seedReadyDocument(t, a, projectA, "lesson.md", "guard-key-00001");

  await expect(t.mutation(api.documents.deleteDocumentBatch, { projectId: projectA, documentId: uploaded.documentId as never, limit: 10 })).rejects.toThrow("UNAUTHENTICATED");
  await expect(b.mutation(api.documents.deleteDocumentBatch, { projectId: projectA, documentId: uploaded.documentId as never, limit: 10 })).rejects.toThrow("NOT_FOUND");
  await expect(b.mutation(api.documents.deleteDocumentBatch, { projectId: projectB, documentId: uploaded.documentId as never, limit: 10 })).rejects.toThrow("NOT_FOUND");
  await expect(a.mutation(api.documents.deleteDocumentBatch, { projectId: projectA, documentId: uploaded.documentId as never, limit: 0 })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(a.mutation(api.documents.deleteDocumentBatch, { projectId: projectA, documentId: uploaded.documentId as never, limit: 101 })).rejects.toThrow("INVALID_ARGUMENT");

  // Nothing moved: owner still sees a ready document with its rows intact.
  const own = await a.query(api.documents.listDocumentStatuses, { projectId: projectA });
  expect(own).toHaveLength(1);
  expect(own[0].document.status).toBe("ready");
  expect(await countRows(t, "documentChunks")).toBeGreaterThan(0);
  expect(await storedBlobCount(t)).toBe(1);
});

test("the storage blob deleted with the document cannot be replayed through the upload idempotency key", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await upload(a, projectId, "notes.txt", "reuse-key-00001");
  await deleteDocumentFully(a, projectId, uploaded.documentId);

  // The same key after a delete commits a fresh live document instead of
  // resurrecting the tombstone; the tombstone keeps its retired row.
  const replay = await upload(a, projectId, "notes.txt", "reuse-key-00001");
  expect(replay.idempotent).toBe(false);
  expect(replay.documentId).not.toBe(uploaded.documentId);
  const listed = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(listed).toHaveLength(1);
  expect(listed[0].document._id).toBe(replay.documentId);
  expect(await countRows(t, "documents")).toBe(2);

  // A plain replay without a delete in between still resolves to the live row
  // and answers 200 (idempotent) instead of creating anything.
  const duplicate = await upload(a, projectId, "notes.txt", "reuse-key-00001", 200);
  expect(duplicate.idempotent).toBe(true);
  expect(duplicate.documentId).toBe(replay.documentId);
  expect(await countRows(t, "documents")).toBe(2);
});
