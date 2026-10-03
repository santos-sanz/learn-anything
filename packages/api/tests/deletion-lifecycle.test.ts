import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv, TEST_ISSUER } from "./helpers/authEnv.js";

/**
 * S24 privacy lifecycle: the project cascade removes every scoped row —
 * documents, chunks, embeddings, messages, progress events, citations, turns,
 * telemetry, agent tokens, provider-job remnants and blobs — leaving no
 * orphan in any S04/S08/S09/S12/S13/S14/S20/S24 table; account deletion
 * additionally drains owner-level rows and the Convex Auth identity in strict
 * child-before-parent order; and a failed deletion is visible as `failed`,
 * retriable and idempotent end to end. Synthetic rows only.
 */
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
};

const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });
const makeTest = () => convexTest({ schema, modules });
type TestInstance = ReturnType<typeof makeTest>;
const owner = (t: TestInstance, subject: string) => t.withIdentity(identity(subject));

/** Every table a project- or account-scoped deletion must drain. */
const SCOPED_TABLES = [
  "documents",
  "privateFiles",
  "chunkEmbeddings",
  "documentChunks",
  "ingestionJobs",
  "citations",
  "messages",
  "tutorTurns",
  "practisedTopics",
  "learningSessions",
  "learningGoals",
  "progressEvents",
  "telemetryEvents",
  "agentConnectionTokens",
] as const;

type ScopeSnapshot = Record<(typeof SCOPED_TABLES)[number], number> & {
  projects: number;
  deletionRequests: number;
  rateLimitBuckets: number;
};

async function scopeSnapshot(t: TestInstance, ownerId: string): Promise<ScopeSnapshot> {
  return (await t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of SCOPED_TABLES) {
      out[table] = (await ctx.db.query(table).withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId)).take(500)).length;
    }
    out.projects = (await ctx.db.query("projects").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).take(500)).length;
    out.deletionRequests = (await ctx.db.query("deletionRequests").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).take(100)).length;
    out.rateLimitBuckets = (
      await ctx.db.query("rateLimitBuckets").withIndex("by_owner_bucket", (q) => q.eq("ownerId", ownerId)).take(100)
    ).length;
    return out as ScopeSnapshot;
  })) as ScopeSnapshot;
}

async function authSnapshot(t: TestInstance, userId: Id<"users">) {
  return t.run(async (ctx) => ({
    users: (await ctx.db.query("users").take(100)).filter((row) => row._id === userId).length,
    authSessions: (await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(100)).length,
    authAccounts: (await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(100)).length,
    authRefreshTokens: (await ctx.db.query("authRefreshTokens").take(500)).length,
    authVerifiers: (await ctx.db.query("authVerifiers").take(500)).length,
    authVerificationCodes: (await ctx.db.query("authVerificationCodes").take(500)).length,
    authRateLimits: (await ctx.db.query("authRateLimits").take(100)).length,
  }));
}

/**
 * Seeds one row in every scoped table for (owner, project) plus a real stored
 * blob, so the cascade test covers every table the story names.
 */
async function seedFullProject(t: TestInstance, ownerId: string, name: string): Promise<{ projectId: Id<"projects">; storageId: Id<"_storage"> }> {
  return (await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", { ownerId, name, createdAt: now, deletedAt: null });
    const sessionId = await ctx.db.insert("learningSessions", { ownerId, projectId, sessionKey: `s-${name}`, createdAt: now, endedAt: null });
    await ctx.db.insert("learningGoals", { ownerId, projectId, title: "goal", createdAt: now });
    const messageId = await ctx.db.insert("messages", {
      ownerId,
      projectId,
      sessionId,
      turnId: "t-1",
      idempotencyKey: `${name}:learner`,
      role: "learner",
      content: "hello",
      createdAt: now,
    });
    await ctx.db.insert("progressEvents", { ownerId, projectId, eventType: "done", createdAt: now });
    const storageId = await ctx.storage.store(new Blob(["private bytes"]));
    const fileId = await ctx.db.insert("privateFiles", { ownerId, projectId, storageId, contentType: "application/pdf", createdAt: now });
    const documentId = await ctx.db.insert("documents", {
      ownerId,
      projectId,
      privateFileId: fileId,
      storageId,
      filename: "notes.pdf",
      extension: "pdf",
      contentType: "application/pdf",
      sizeBytes: 13,
      status: "ready",
      failureCode: null,
      idempotencyKey: `doc-${name}`,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("ingestionJobs", { ownerId, projectId, documentId, status: "succeeded", attempts: 1, createdAt: now, updatedAt: now });
    const chunkId = await ctx.db.insert("documentChunks", {
      ownerId,
      projectId,
      documentId,
      contentVersionKey: "seed:v1",
      seq: 0,
      chunkKey: "seed#0",
      text: "chunk text",
      contentHash: "hash",
      locator: { blockIndex: 0, page: 1, heading: null },
      createdAt: now,
    });
    await ctx.db.insert("chunkEmbeddings", {
      ownerId,
      projectId,
      scopeKey: `${ownerId}:${projectId}`,
      documentId,
      chunkId,
      contentVersionKey: "seed:v1",
      seq: 0,
      model: "qwen3-embedding",
      modelVersion: "1",
      dimensions: 4096,
      embedding: new Array<number>(4096).fill(0),
      embeddedAt: now,
    });
    await ctx.db.insert("tutorTurns", {
      ownerId,
      projectId,
      sessionId,
      turnId: "t-1",
      status: "completed",
      attempts: 1,
      learnerText: "hello",
      retrievedChunkIds: [chunkId],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("citations", {
      ownerId,
      projectId,
      messageId,
      turnId: "t-1",
      rank: 1,
      retrievalRank: 1,
      documentId,
      chunkId,
      seq: 0,
      contentHash: "hash",
      page: 1,
      heading: null,
    });
    await ctx.db.insert("practisedTopics", {
      ownerId,
      projectId,
      sessionId,
      turnId: "t-1",
      topic: "topic",
      level: "beginner",
      targetLanguage: "en",
      createdAt: now,
    });
    await ctx.db.insert("agentConnectionTokens", {
      ownerId,
      projectId,
      tokenHash: "hash",
      issuedAt: now,
      expiresAt: now + 300_000,
      revokedAt: null,
      lastVerifiedAt: null,
      verifyCount: 0,
    });
    await ctx.db.insert("telemetryEvents", { traceId: "trace-1", ownerId, projectId, event: "stt-transcribe", status: "ok", createdAt: now });
    return { projectId, storageId };
  })) as { projectId: Id<"projects">; storageId: Id<"_storage"> };
}

async function runProjectDeletion(t: TestInstance, subject: string, projectId: Id<"projects">, limit = 5): Promise<number> {
  const a = owner(t, subject);
  await a.mutation(api.projects.requestProjectDeletion, { projectId });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const batch = await a.mutation(api.projects.deleteProjectBatch, { projectId, limit });
    if (batch.completed) return attempt + 1;
  }
  throw new Error("project deletion did not finish within the batch cap");
}

async function runAccountDeletion(t: TestInstance, subject: string, limit = 10): Promise<number> {
  const a = owner(t, subject);
  await a.mutation(api.projects.requestAccountDeletion, {});
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const batch = await a.mutation(api.projects.runAccountDeletionBatch, { limit });
    if (batch.completed) return attempt + 1;
  }
  throw new Error("account deletion did not finish within the batch cap");
}

/* ------------------------------------------------------------------ *
 * Project cascade
 * ------------------------------------------------------------------ */

test("project deletion removes every scoped table, the blob and its ledger row, and orphans nothing", async () => {
  const t = makeTest();
  const { projectId, storageId } = await seedFullProject(t, "learner-a", "cascade");
  // A second learner's rows must never be touched.
  const other = await seedFullProject(t, "learner-b", "bystander");
  // Owner-scoped throttle state is not project data and survives a project delete.
  await t.run(async (ctx) => {
    await ctx.db.insert("rateLimitBuckets", { ownerId: "learner-a", bucket: "stt-transcribe", windowStart: Date.now(), count: 1, updatedAt: Date.now() });
  });

  const batches = await runProjectDeletion(t, "learner-a|s1", projectId, 4);

  expect(batches).toBeGreaterThan(1); // the bounded loop really was exercised
  const after = await scopeSnapshot(t, "learner-a");
  for (const table of SCOPED_TABLES) expect(after[table]).toBe(0);
  expect(after.projects).toBe(0);
  expect(after.deletionRequests).toBe(0); // the ledger row closes with the project
  expect(after.rateLimitBuckets).toBe(1);

  const blob = await t.run(async (ctx) => {
    const stored = await ctx.storage.get(storageId as never);
    return stored === null ? "gone" : "present";
  });
  expect(blob).toBe("gone");

  const bystander = await scopeSnapshot(t, "learner-b");
  expect(bystander.projects).toBe(1);
  expect(bystander.messages).toBe(1);
  expect(bystander.documents).toBe(1);
  expect(bystander.chunkEmbeddings).toBe(1);
  expect(await t.run(async (ctx) => ((await ctx.storage.get(other.storageId as never)) === null ? "gone" : "present"))).toBe("present");
});

test("an interrupted deletion is visible as failed, then a retry resumes it to completion", async () => {
  const t = makeTest();
  const { projectId, storageId } = await seedFullProject(t, "learner-a", "flaky");
  const a = owner(t, "learner-a|s1");

  await a.mutation(api.projects.requestProjectDeletion, { projectId });
  const first = await a.mutation(api.projects.deleteProjectBatch, { projectId, limit: 3 });
  expect(first.completed).toBe(false);

  // Mid-run state is visible: deleting, not silently half-done.
  const during = await a.query(api.projects.getDeletionStatus, {});
  expect(during.account).toBeNull();
  expect(during.projects).toHaveLength(1);
  expect(during.projects[0]).toMatchObject({ projectId, status: "deleting" });

  // The client observed a rejected batch and reports it with a fixed code.
  await a.mutation(api.projects.reportDeletionFailure, { scope: "project", projectId, code: "BATCH_REJECTED" });
  const failed = await a.query(api.projects.getDeletionStatus, {});
  expect(failed.projects[0]).toMatchObject({ projectId, status: "failed", failureCode: "BATCH_REJECTED" });

  // Only the owner may report, and only for an active request.
  await expect(
    owner(t, "learner-b|s2").mutation(api.projects.reportDeletionFailure, { scope: "project", projectId, code: "NOPE" }),
  ).rejects.toThrow("NOT_FOUND");

  // The retry resumes from the records that are still there.
  await runProjectDeletion(t, "learner-a|s1", projectId, 4);
  const done = await a.query(api.projects.getDeletionStatus, {});
  expect(done).toEqual({ account: null, projects: [] });

  const after = await scopeSnapshot(t, "learner-a");
  for (const table of SCOPED_TABLES) expect(after[table]).toBe(0);
  expect(after.projects).toBe(0);
  expect(await t.run(async (ctx) => ((await ctx.storage.get(storageId as never)) === null ? "gone" : "present"))).toBe("gone");

  // A completed deletion cannot be downgraded, and unknown codes are sanitised.
  await expect(
    a.mutation(api.projects.reportDeletionFailure, { scope: "project", projectId, code: "LATE" }),
  ).rejects.toThrow("NOT_FOUND");
});

test("failure codes are fixed tokens, never a free-text message", async () => {
  const t = makeTest();
  const { projectId } = await seedFullProject(t, "learner-a", "codes");
  const a = owner(t, "learner-a|s1");
  await a.mutation(api.projects.requestProjectDeletion, { projectId });
  await a.mutation(api.projects.reportDeletionFailure, { scope: "project", projectId, code: "a message with spaces and CANARY" });
  const status = await a.query(api.projects.getDeletionStatus, {});
  expect(status.projects[0].failureCode).toBe("DELETION_FAILED");
  expect(JSON.stringify(status)).not.toContain("CANARY");
});

/* ------------------------------------------------------------------ *
 * Account cascade
 * ------------------------------------------------------------------ */

async function seedIdentityWithRows(t: TestInstance): Promise<{ subject: string; userId: Id<"users">; email: string }> {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const email = "owner@example.test";
    const userId = await ctx.db.insert("users", { email });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: now + 60_000 });
    const accountId = await ctx.db.insert("authAccounts", { userId, provider: "credential", providerAccountId: email });
    await ctx.db.insert("authRefreshTokens", { sessionId, expirationTime: now + 60_000 });
    await ctx.db.insert("authVerifiers", { sessionId, signature: "sig" });
    await ctx.db.insert("authVerificationCodes", { accountId, provider: "credential", code: "123456", expirationTime: now + 60_000 });
    await ctx.db.insert("authRateLimits", { identifier: email, lastAttemptTime: now, attemptsLeft: 5 });
    return { userId, email };
  });
  return { subject: `${seeded.userId}|session-1`, userId: seeded.userId, email: seeded.email };
}

test("account deletion drains content, owner-level rows and the auth identity, sparing other learners", async () => {
  const t = makeTest();
  const { subject, userId, email } = await seedIdentityWithRows(t);
  const first = await seedFullProject(t, userId, "alpha");
  const second = await seedFullProject(t, userId, "beta");
  await t.run(async (ctx) => {
    await ctx.db.insert("rateLimitBuckets", { ownerId: userId, bucket: "stt-transcribe", windowStart: Date.now(), count: 3, updatedAt: Date.now() });
  });
  const bystander = await seedFullProject(t, "learner-b", "bystander");

  const batches = await runAccountDeletion(t, subject, 6);
  expect(batches).toBeGreaterThan(1);

  const after = await scopeSnapshot(t, userId);
  for (const table of SCOPED_TABLES) expect(after[table]).toBe(0);
  expect(after.projects).toBe(0);
  expect(after.deletionRequests).toBe(0);
  expect(after.rateLimitBuckets).toBe(0);

  const auth = await authSnapshot(t, userId);
  expect(auth).toEqual({
    users: 0,
    authSessions: 0,
    authAccounts: 0,
    authRefreshTokens: 0,
    authVerifiers: 0,
    authVerificationCodes: 0,
    authRateLimits: 0,
  });
  expect(await t.run(async (ctx) => ((await ctx.storage.get(first.storageId as never)) === null ? "gone" : "present"))).toBe("gone");
  expect(await t.run(async (ctx) => ((await ctx.storage.get(second.storageId as never)) === null ? "gone" : "present"))).toBe("gone");
  expect(JSON.stringify(await t.run(async (ctx) => ctx.db.query("authRateLimits").collect()))).not.toContain(email);

  const status = await owner(t, subject).query(api.projects.getDeletionStatus, {});
  expect(status).toEqual({ account: null, projects: [] });

  // Idempotent close: a repeat batch reports completion without new work.
  expect(await owner(t, subject).mutation(api.projects.runAccountDeletionBatch, { limit: 6 })).toEqual({ completed: true, deleted: 0 });

  // The other learner's rows are untouched.
  const others = await scopeSnapshot(t, "learner-b");
  expect(others.projects).toBe(1);
  expect(others.documents).toBe(1);
  expect(others.messages).toBe(1);
  expect(await t.run(async (ctx) => ((await ctx.storage.get(bystander.storageId as never)) === null ? "gone" : "present"))).toBe("present");
});

test("a failed account deletion is visible, retriable and never leaks a message", async () => {
  const t = makeTest();
  const { subject, userId } = await seedIdentityWithRows(t);
  await seedFullProject(t, userId, "alpha");
  const a = owner(t, subject);

  await a.mutation(api.projects.requestAccountDeletion, {});
  const first = await a.mutation(api.projects.runAccountDeletionBatch, { limit: 3 });
  expect(first.completed).toBe(false);

  await a.mutation(api.projects.reportDeletionFailure, { scope: "account", code: "IDENTITY_TEARDOWN" });
  const status = await a.query(api.projects.getDeletionStatus, {});
  expect(status.account).toMatchObject({ status: "failed", failureCode: "IDENTITY_TEARDOWN" });
  expect(status.projects).toHaveLength(0);

  await runAccountDeletion(t, subject, 8);
  expect(await a.query(api.projects.getDeletionStatus, {})).toEqual({ account: null, projects: [] });
  const after = await scopeSnapshot(t, userId);
  for (const table of SCOPED_TABLES) expect(after[table]).toBe(0);
  expect((await authSnapshot(t, userId)).users).toBe(0);

  // Requesting again after a completed teardown finds no residue to delete.
  await expect(a.mutation(api.projects.runAccountDeletionBatch, { limit: 6 })).resolves.toEqual({ completed: true, deleted: 0 });
});
