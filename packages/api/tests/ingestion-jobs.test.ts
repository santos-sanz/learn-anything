import { readFileSync, readdirSync } from "node:fs";

import { contentVersionKeyFor, sha256Hex } from "@learn-anything/worker";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv } from "./helpers/authEnv.js";

// Deployment variables are synthetic for offline tests; no value is a secret.
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/documents.ts": () => import("../convex/documents.js"),
  "../convex/files.ts": () => import("../convex/files.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/ingestion.ts": () => import("../convex/ingestion.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
};

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

type UploadBody = { documentId: string; jobId: string; status: string };

const uploadBody = async (response: Response): Promise<UploadBody> => (await response.json()) as UploadBody;

async function uploadFixture(user: TestUser, projectId: string, filename: string, key: string): Promise<UploadBody> {
  const contentType = filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".md") ? "text/markdown" : "text/plain";
  const response = await user.fetch(uploadPath(projectId, filename, key), post(fixture(filename), contentType));
  expect(response.status).toBe(201);
  return uploadBody(response);
}

type JobRow = {
  _id: string;
  status: string;
  attempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  nextAttemptAt?: number;
  failureCode?: string;
  contentVersionKey?: string;
  chunkCount?: number;
};

async function jobRow(t: TestInstance, jobId: string): Promise<JobRow> {
  const row = await t.run(async (ctx) => ctx.db.get(jobId as never));
  expect(row).not.toBeNull();
  return row as JobRow;
}

async function chunkRows(t: TestInstance, documentId: string): Promise<Record<string, unknown>[]> {
  return await t.run(async (ctx) =>
    ctx.db
      .query("documentChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId as never))
      .collect(),
  );
}

test("a queued PDF job runs in the action, lands chunk rows and surfaces ready status", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await uploadFixture(a, projectId, "text-page.pdf", "run-key-0000001");

  const pending = await a.query(api.documents.getDocument, { projectId, documentId: uploaded.documentId as never });
  expect(pending.status).toBe("pending");

  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.processed).toBe(1);
  expect(cycle.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "succeeded" }]);

  const job = await jobRow(t, uploaded.jobId);
  expect(job).toMatchObject({ status: "succeeded", attempts: 1, chunkCount: 2 });
  expect(job.leaseOwner).toBeUndefined();
  expect(job.leaseExpiresAt).toBeUndefined();
  expect(job.contentVersionKey).toMatch(/^[0-9a-f]{64}:v2$/);

  const ready = await a.query(api.documents.getDocument, { projectId, documentId: uploaded.documentId as never });
  expect(ready.status).toBe("ready");
  expect(ready.failureCode).toBeNull();

  const chunks = await chunkRows(t, uploaded.documentId);
  expect(chunks).toHaveLength(2);
  expect(chunks.map((chunk) => chunk.text)).toEqual([
    "Synthetic ingestion lesson page one.",
    "Synthetic ingestion lesson page two.",
  ]);
  expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);
  expect(chunks.map((chunk) => (chunk.locator as { page: number }).page)).toEqual([1, 2]);
  expect(chunks.every((chunk) => chunk.contentVersionKey === job.contentVersionKey)).toBe(true);
  expect(chunks.map((chunk) => chunk.chunkKey)).toEqual([
    `${job.contentVersionKey}#0`,
    `${job.contentVersionKey}#1`,
  ]);

  const listed = await a.query(api.ingestion.listIngestionJobs, { projectId });
  expect(listed).toHaveLength(1);
  expect(Object.keys(listed[0]).sort()).toEqual([
    "_id",
    "attempts",
    "chunkCount",
    "createdAt",
    "documentId",
    "failureCode",
    "maxAttempts",
    "nextAttemptAt",
    "status",
    "updatedAt",
  ]);
  expect(listed[0]).toMatchObject({ status: "succeeded", attempts: 1, maxAttempts: 5, chunkCount: 2, failureCode: null });
  // Status metadata never leaks stored bytes or extracted content.
  expect(JSON.stringify(listed)).not.toContain("Synthetic ingestion lesson");
  expect(JSON.stringify(listed)).not.toMatch(/storageId|leaseOwner|getUrl/);

  const idle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(idle.processed).toBe(0);
});

test("a claimed job is exclusive, an expired lease returns to ready, and a stale worker cannot settle it", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await uploadFixture(a, projectId, "notes.txt", "lease-key-000001");

  const first = await t.mutation(internal.ingestion.claimNextJob, { workerId: "worker-a" });
  expect(first).toMatchObject({ attempt: 1, maxAttempts: 5 });
  expect(first?.leaseExpiresAt).toBeGreaterThan(Date.now());

  // Concurrent worker sees a valid lease and claims nothing: no double-processing.
  const blocked = await t.mutation(internal.ingestion.claimNextJob, { workerId: "worker-b" });
  expect(blocked).toBeNull();

  // While worker-a holds the lease, worker-b cannot settle the job.
  await expect(
    t.mutation(internal.ingestion.completeJob, {
      jobId: uploaded.jobId as never,
      workerId: "worker-b",
      contentVersionKey: "sha256:0000:v1",
      chunkCount: 1,
    }),
  ).rejects.toThrow("LEASE_LOST");

  // worker-a commits chunks and then dies mid-job: the lease is never released.
  const bytes = fixture("notes.txt");
  const contentVersionKey = contentVersionKeyFor(bytes);
  const text = new TextDecoder().decode(bytes).trim();
  await t.mutation(internal.ingestion.commitChunks, {
    jobId: uploaded.jobId as never,
    documentId: uploaded.documentId as never,
    ownerId: "a",
    projectId,
    contentVersionKey,
    chunks: [{ seq: 0, text, contentHash: sha256Hex(text), locator: { blockIndex: 0, page: null, heading: null } }],
  });
  expect(await chunkRows(t, uploaded.documentId)).toHaveLength(1);

  // Simulated crash: worker-a never finishes, its lease expires.
  await t.run(async (ctx) => ctx.db.patch(uploaded.jobId as never, { leaseExpiresAt: Date.now() - 1 }));
  const running = await jobRow(t, uploaded.jobId);
  expect(running.status).toBe("running");

  // The next cycle sweeps the expired lease back to ready, reclaims and finishes.
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-b" });
  expect(cycle.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "succeeded" }]);
  const resumed = await jobRow(t, uploaded.jobId);
  expect(resumed).toMatchObject({ status: "succeeded", attempts: 2 });
  expect(resumed.leaseOwner).toBeUndefined();
  expect(resumed.leaseExpiresAt).toBeUndefined();

  // The interrupted worker-a waking up late is rejected, not recorded as success.
  await expect(
    t.mutation(internal.ingestion.completeJob, {
      jobId: uploaded.jobId as never,
      workerId: "worker-a",
      contentVersionKey: resumed.contentVersionKey ?? "sha256:0000:v1",
      chunkCount: 1,
    }),
  ).rejects.toThrow("JOB_NOT_RUNNING");

  // Resume after the partial commit produced the same single chunk row, not a duplicate.
  expect(await chunkRows(t, uploaded.documentId)).toHaveLength(1);
  const ready = await a.query(api.documents.getDocument, { projectId, documentId: uploaded.documentId as never });
  expect(ready.status).toBe("ready");
  expect(await t.mutation(internal.ingestion.claimNextJob, { workerId: "worker-c" })).toBeNull();
});

test("retryable failures back off into a bounded dead letter visible on the status surface", async () => {
  const previous = process.env.INGESTION_MAX_ATTEMPTS;
  process.env.INGESTION_MAX_ATTEMPTS = "2";
  try {
    const t = makeTest();
    const a = t.withIdentity(identity("a"));
    const projectId = await a.mutation(api.projects.createProject, { name: "A" });
    const uploaded = await uploadFixture(a, projectId, "notes.txt", "fail-key-000001");

    // Deleting the stored blob makes every attempt fail with STORAGE_MISSING.
    await t.run(async (ctx) => {
      const document = await ctx.db.get(uploaded.documentId as never);
      if (document !== null) await ctx.storage.delete((document as { storageId: string }).storageId as never);
    });

    const first = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
    expect(first.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "retry_scheduled" }]);
    const backingOff = await jobRow(t, uploaded.jobId);
    expect(backingOff).toMatchObject({ status: "queued", attempts: 1, failureCode: "STORAGE_MISSING" });
    expect(backingOff.nextAttemptAt).toBeGreaterThan(Date.now());

    // Inside the backoff window nothing is claimable.
    expect(await t.mutation(internal.ingestion.claimNextJob, { workerId: "worker-a" })).toBeNull();

    // After the backoff window the second and final attempt dead-letters.
    await t.run(async (ctx) => ctx.db.patch(uploaded.jobId as never, { nextAttemptAt: Date.now() - 1 }));
    const second = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-b" });
    expect(second.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "dead_letter" }]);

    const dead = await jobRow(t, uploaded.jobId);
    expect(dead).toMatchObject({ status: "failed", attempts: 2, failureCode: "STORAGE_MISSING" });
    expect(await t.mutation(internal.ingestion.claimNextJob, { workerId: "worker-c" })).toBeNull();

    const failed = await a.query(api.documents.getDocument, { projectId, documentId: uploaded.documentId as never });
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("STORAGE_MISSING");
    const listed = await a.query(api.ingestion.listIngestionJobs, { projectId });
    expect(listed[0]).toMatchObject({ status: "failed", attempts: 2, maxAttempts: 2, failureCode: "STORAGE_MISSING" });
  } finally {
    if (previous === undefined) delete process.env.INGESTION_MAX_ATTEMPTS;
    else process.env.INGESTION_MAX_ATTEMPTS = previous;
  }
});

test("encrypted and image-only PDFs end in the explicit unsupported state and are never retried", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const encrypted = await uploadFixture(a, projectId, "encrypted.pdf", "enc-key-0000001");
  const scanned = await uploadFixture(a, projectId, "image-only.pdf", "img-key-0000001");

  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.processed).toBe(2);
  expect(cycle.outcomes.map((outcome) => outcome.outcome)).toEqual(["unsupported", "unsupported"]);

  const encryptedJob = await jobRow(t, encrypted.jobId);
  expect(encryptedJob).toMatchObject({ status: "unsupported", attempts: 1, failureCode: "ENCRYPTED_PDF" });
  const scannedJob = await jobRow(t, scanned.jobId);
  expect(scannedJob).toMatchObject({ status: "unsupported", attempts: 1, failureCode: "IMAGE_ONLY_PDF" });

  const encryptedDocument = await a.query(api.documents.getDocument, { projectId, documentId: encrypted.documentId as never });
  expect(encryptedDocument).toMatchObject({ status: "failed", failureCode: "ENCRYPTED_PDF" });
  const scannedDocument = await a.query(api.documents.getDocument, { projectId, documentId: scanned.documentId as never });
  expect(scannedDocument).toMatchObject({ status: "failed", failureCode: "IMAGE_ONLY_PDF" });

  // Unsupported jobs never re-enter the queue and never write chunks.
  expect(await t.mutation(internal.ingestion.claimNextJob, { workerId: "worker-b" })).toBeNull();
  const idle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-b" });
  expect(idle.processed).toBe(0);
  expect(await chunkRows(t, encrypted.documentId)).toHaveLength(0);
  expect(await chunkRows(t, scanned.documentId)).toHaveLength(0);
});

test("running the same job twice yields byte-identical chunk rows", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await uploadFixture(a, projectId, "text-page.pdf", "idem-key-000001");

  const first = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(first.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "succeeded" }]);
  const rowsAfterFirst = await chunkRows(t, uploaded.documentId);
  expect(rowsAfterFirst).toHaveLength(2);

  // Requeue the finished job as a retry of the same content: a different
  // worker re-runs parse, process and commit against the same document.
  await t.run(async (ctx) =>
    ctx.db.patch(uploaded.jobId as never, {
      status: "queued",
      attempts: 0,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: 0,
      updatedAt: Date.now(),
    }),
  );
  const second = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-b" });
  expect(second.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "succeeded" }]);

  const rowsAfterSecond = await chunkRows(t, uploaded.documentId);
  expect(rowsAfterSecond).toEqual(rowsAfterFirst);
  expect(rowsAfterSecond.map((row) => row._id)).toEqual(rowsAfterFirst.map((row) => row._id));
  expect(await a.query(api.ingestion.listIngestionJobs, { projectId })).toMatchObject([{ status: "succeeded", chunkCount: 2 }]);
});

test("an S08-era job row without S09 fields is still claimable before the backfill runs", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await uploadFixture(a, projectId, "notes.txt", "old-row-0000001");

  await t.run(async (ctx) => ctx.db.patch(uploaded.jobId as never, { nextAttemptAt: undefined, maxAttempts: undefined }));
  const claim = await t.mutation(internal.ingestion.claimNextJob, { workerId: "worker-legacy" });
  expect(claim).toMatchObject({ attempt: 1, documentId: uploaded.documentId });
  const claimed = await jobRow(t, uploaded.jobId);
  expect(claimed).toMatchObject({ status: "running", leaseOwner: "worker-legacy" });
  expect(claimed.leaseExpiresAt).toBeGreaterThan(Date.now());
});

test("job status is authenticated, owner-scoped and non-enumerating", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const projectB = await b.mutation(api.projects.createProject, { name: "B" });
  await uploadFixture(a, projectA, "notes.txt", "iso-key-0000001");

  await expect(t.query(api.ingestion.listIngestionJobs, { projectId: projectA })).rejects.toThrow("UNAUTHENTICATED");
  await expect(b.query(api.ingestion.listIngestionJobs, { projectId: projectA })).rejects.toThrow("NOT_FOUND");
  expect(await b.query(api.ingestion.listIngestionJobs, { projectId: projectB })).toEqual([]);
  const own = await a.query(api.ingestion.listIngestionJobs, { projectId: projectA });
  expect(own).toHaveLength(1);
  expect(own[0].status).toBe("queued");
});

test("the HTTP upload path never imports or references the parser runner", () => {
  const directory = new URL("../convex/", import.meta.url);
  const source = readFileSync(new URL("http.ts", directory), "utf8");
  expect(source).not.toMatch(/parseDocument|runIngestionCycle|contentVersionKeyFor|sourceAwareProcessStep|@learn-anything\/worker/);
  const sources = readdirSync(directory).filter((name) => name.endsWith(".ts"));
  expect(sources).toContain("ingestion.ts");
  expect(sources).toContain("crons.ts");
});

test("runner configuration is validated and clamped instead of trusted", async () => {
  const previous = {
    maxAttempts: process.env.INGESTION_MAX_ATTEMPTS,
    backoff: process.env.INGESTION_BACKOFF_BASE_MS,
    lease: process.env.INGESTION_LEASE_MS,
    timeout: process.env.INGESTION_PARSE_TIMEOUT_MS,
  };
  const { configuredBackoffBaseMs, configuredLeaseMs, configuredMaxAttempts, configuredParseTimeoutMs, backoffDelayMs } = await import(
    "../convex/ingestion.js"
  );
  try {
    expect(configuredMaxAttempts()).toBe(5);
    process.env.INGESTION_MAX_ATTEMPTS = "7";
    expect(configuredMaxAttempts()).toBe(7);
    process.env.INGESTION_MAX_ATTEMPTS = "99";
    expect(configuredMaxAttempts()).toBe(10);
    process.env.INGESTION_MAX_ATTEMPTS = "0";
    expect(configuredMaxAttempts()).toBe(5);
    process.env.INGESTION_MAX_ATTEMPTS = "abc";
    expect(configuredMaxAttempts()).toBe(5);

    process.env.INGESTION_LEASE_MS = "100";
    expect(configuredLeaseMs()).toBe(120_000);
    process.env.INGESTION_LEASE_MS = "60000";
    expect(configuredLeaseMs()).toBe(60_000);

    process.env.INGESTION_BACKOFF_BASE_MS = "500";
    expect(configuredBackoffBaseMs()).toBe(30_000);
    process.env.INGESTION_BACKOFF_BASE_MS = "1000";
    expect(configuredBackoffBaseMs()).toBe(1_000);

    process.env.INGESTION_PARSE_TIMEOUT_MS = "50";
    expect(configuredParseTimeoutMs()).toBe(10_000);
    process.env.INGESTION_PARSE_TIMEOUT_MS = "5000";
    expect(configuredParseTimeoutMs()).toBe(5_000);

    expect(backoffDelayMs(1, 30_000)).toBe(30_000);
    expect(backoffDelayMs(2, 30_000)).toBe(60_000);
    expect(backoffDelayMs(3, 30_000)).toBe(120_000);
    expect(backoffDelayMs(50, 30_000)).toBe(900_000);
  } finally {
    for (const [name, value] of Object.entries({
      INGESTION_MAX_ATTEMPTS: previous.maxAttempts,
      INGESTION_BACKOFF_BASE_MS: previous.backoff,
      INGESTION_LEASE_MS: previous.lease,
      INGESTION_PARSE_TIMEOUT_MS: previous.timeout,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
