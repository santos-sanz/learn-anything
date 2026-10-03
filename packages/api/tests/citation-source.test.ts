import { readFileSync } from "node:fs";

import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv } from "./helpers/authEnv.js";
import { installEmbeddingProvider } from "./helpers/embeddingProvider.js";
import { termVector } from "./helpers/textVectors.js";

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
  "../convex/retrieval.ts": () => import("../convex/retrieval.js"),
  "../convex/sources.ts": () => import("../convex/sources.js"),
};

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

type UploadBody = { documentId: string; privateFileId: string; jobId: string; filename: string };

async function seedReadyDocument(t: TestInstance, user: TestUser, projectId: string, filename: string, key: string): Promise<UploadBody> {
  const contentType = filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".md") ? "text/markdown" : "text/plain";
  const response = await user.fetch(uploadPath(projectId, filename, key), post(fixture(filename), contentType));
  expect(response.status).toBe(201);
  const uploaded = (await response.json()) as UploadBody;
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.outcomes).toEqual([{ jobId: uploaded.jobId, outcome: "succeeded" }]);
  return uploaded;
}

type ChunkRow = { _id: string; seq: number; text: string; contentHash: string; locator: { page: number | null; heading: string | null } };

async function chunkRows(t: TestInstance, documentId: string): Promise<ChunkRow[]> {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("documentChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId as never))
      .collect(),
  );
  return (rows as unknown as ChunkRow[]).sort((left, right) => left.seq - right.seq);
}

async function deleteDocumentFully(user: TestUser, projectId: string, documentId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await user.mutation(api.documents.deleteDocumentBatch, { projectId: projectId as never, documentId: documentId as never, limit: 100 });
    if (result.completed) return;
  }
  throw new Error("document deletion did not complete within the batch cap");
}

type SourceFocus = { chunkId: string; seq: number; page: number | null; heading: string | null; contentHash: string; text: string };
type SourceResult =
  | { status: "ok"; document: Record<string, unknown>; focus: SourceFocus; before: unknown[]; after: unknown[] }
  | { status: "unavailable"; reason: string; document: Record<string, unknown>; source: Record<string, unknown> };

test("the owner opens a cited chunk at its exact page or heading with bounded neighbours", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await seedReadyDocument(t, a, projectId, "three-page-lesson.pdf", "src-key-000001");
  const chunks = await chunkRows(t, uploaded.documentId);
  expect(chunks.length).toBeGreaterThan(1);

  const cited = chunks[chunks.length - 1];
  const result = (await a.query(api.sources.getCitationSource, {
    projectId,
    documentId: uploaded.documentId as never,
    chunkId: cited._id as never,
    contentHash: cited.contentHash,
  })) as SourceResult;
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("unreachable");
  expect(result.document).toMatchObject({ filename: "three-page-lesson.pdf", contentType: "application/pdf" });
  expect(result.focus).toMatchObject({ seq: cited.seq, page: cited.locator.page, heading: cited.locator.heading, contentHash: cited.contentHash, text: cited.text });
  expect(typeof result.focus.page).toBe("number");
  expect(result.before.length).toBeGreaterThan(0);
  expect(result.before.length).toBeLessThanOrEqual(3);
  expect(result.after.length).toBeLessThanOrEqual(3);

  // Opening the document without a citation anchor starts at the first chunk.
  const overview = (await a.query(api.sources.getCitationSource, { projectId, documentId: uploaded.documentId as never })) as SourceResult;
  expect(overview.status).toBe("ok");
  if (overview.status !== "ok") throw new Error("unreachable");
  expect(overview.focus.seq).toBe(0);
  expect(overview.before).toEqual([]);
  expect(overview.after.length).toBeGreaterThan(0);
});

test("markdown heading locators travel with the citation source", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await seedReadyDocument(t, a, projectId, "nested-headings.md", "src-key-000002");
  const chunks = await chunkRows(t, uploaded.documentId);
  const withHeading = chunks.find((chunk) => chunk.locator.heading !== null);
  expect(withHeading).toBeDefined();
  if (withHeading === undefined) throw new Error("unreachable");

  const result = (await a.query(api.sources.getCitationSource, {
    projectId,
    documentId: uploaded.documentId as never,
    chunkId: withHeading._id as never,
  })) as SourceResult;
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("unreachable");
  expect(result.focus).toMatchObject({ heading: withHeading.locator.heading, text: withHeading.text });
  expect(typeof result.focus.heading).toBe("string");
});

test("a real S13 citation resolves to its source; after deletion the same reference is explicitly unavailable", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await seedReadyDocument(t, a, projectId, "lesson.md", "src-key-000003");
  const chunks = await chunkRows(t, uploaded.documentId);

  // Retrieve real citations through the S13 action with a synthetic query
  // vector (no provider call), exactly as the tutor will.
  const retrieval = await a.action(api.retrieval.retrieveProjectContext, {
    projectId,
    query: chunks[0].text.slice(0, 120),
    vector: termVector(chunks[0].text),
    topK: 4,
  });
  expect(retrieval.status).toBe("ok");
  if (retrieval.status !== "ok") throw new Error("no citations");
  const citation = retrieval.citations[0];

  const opened = (await a.query(api.sources.getCitationSource, {
    projectId,
    documentId: citation.documentId,
    chunkId: citation.chunkId,
    contentHash: citation.contentHash,
  })) as SourceResult;
  expect(opened.status).toBe("ok");
  if (opened.status !== "ok") throw new Error("unreachable");
  expect(opened.focus).toMatchObject({ page: citation.page, heading: citation.heading, contentHash: citation.contentHash, seq: citation.seq });
  const citedRow = chunks.find((chunk) => chunk.seq === citation.seq);
  expect(citedRow).toBeDefined();
  if (citedRow === undefined) throw new Error("unreachable");
  expect(opened.focus.text).toBe(citedRow.text);

  // Delete the document: the very same citation reference must now report the
  // explicit unavailable state (S13's document-deleted reason), with no crash
  // and no text, instead of a broken result.
  await deleteDocumentFully(a, projectId, uploaded.documentId);
  const stale = (await a.query(api.sources.getCitationSource, {
    projectId,
    documentId: citation.documentId,
    chunkId: citation.chunkId,
    contentHash: citation.contentHash,
  })) as SourceResult;
  expect(stale.status).toBe("unavailable");
  if (stale.status !== "unavailable") throw new Error("unreachable");
  expect(stale.reason).toBe("document-deleted");
  expect(stale.document).toMatchObject({ filename: "lesson.md" });
  expect(JSON.stringify(stale)).not.toContain(chunks[0].text.slice(0, 32));

  // And retrieval no longer offers the deleted source at all.
  const again = await a.action(api.retrieval.retrieveProjectContext, {
    projectId,
    query: chunks[0].text.slice(0, 120),
    vector: termVector(chunks[0].text),
    topK: 4,
  });
  expect(again.status).toBe("insufficient-evidence");
});

test("anonymous, cross-project and cross-user source requests are all denied server-side", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const projectB = await b.mutation(api.projects.createProject, { name: "B" });
  const uploaded = await seedReadyDocument(t, a, projectA, "lesson.md", "deny-key-000002");
  const chunks = await chunkRows(t, uploaded.documentId);

  await expect(
    t.query(api.sources.getCitationSource, { projectId: projectA, documentId: uploaded.documentId as never, chunkId: chunks[0]._id as never }),
  ).rejects.toThrow("UNAUTHENTICATED");

  // Cross-project: the project itself is not owned by the caller.
  await expect(b.query(api.sources.getCitationSource, { projectId: projectA, documentId: uploaded.documentId as never })).rejects.toThrow("NOT_FOUND");

  // Cross-user: the caller's own project cannot unlock a foreign document.
  await expect(
    b.query(api.sources.getCitationSource, { projectId: projectB, documentId: uploaded.documentId as never, chunkId: chunks[0]._id as never }),
  ).rejects.toThrow("NOT_FOUND");

  // A foreign id and an unknown id answer identically: denied NOT_FOUND with
  // no metadata, so ownership probing cannot enumerate anyone's documents.
  const discarded = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["ghost"], { type: "text/plain" }));
    const id = await ctx.db.insert("documents", {
      ownerId: "a",
      projectId: projectA as never,
      privateFileId: uploaded.privateFileId as never,
      storageId,
      filename: "ghost.txt",
      extension: "txt",
      contentType: "text/plain",
      sizeBytes: 1,
      status: "pending",
      failureCode: null,
      idempotencyKey: "ghost-key-000001",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.delete(id);
    return id;
  });
  await expect(b.query(api.sources.getCitationSource, { projectId: projectB, documentId: discarded })).rejects.toThrow("NOT_FOUND");
  await expect(b.query(api.sources.getCitationSource, { projectId: projectB, documentId: uploaded.documentId as never })).rejects.toThrow("NOT_FOUND");
});

test("a chunk the caller does not own answers identically to a missing one, with no foreign text", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const projectB = await b.mutation(api.projects.createProject, { name: "B" });
  const foreign = await seedReadyDocument(t, a, projectA, "lesson.md", "chunk-key-00001");
  const foreignChunks = await chunkRows(t, foreign.documentId);

  // B's own (pending, chunk-less) document plus A's chunk id.
  const uploadB = await b.fetch(uploadPath(projectB, "notes.txt", "chunk-key-00002"), post(fixture("notes.txt"), "text/plain"));
  expect(uploadB.status).toBe(201);
  const own = (await uploadB.json()) as UploadBody;

  const withForeignChunk = (await b.query(api.sources.getCitationSource, {
    projectId: projectB,
    documentId: own.documentId as never,
    chunkId: foreignChunks[0]._id as never,
  })) as SourceResult;
  const discarded = await t.run(async (ctx) => {
    const id = await ctx.db.insert("documentChunks", {
      ownerId: "b",
      projectId: projectB as never,
      documentId: own.documentId as never,
      contentVersionKey: "ghost:v1",
      seq: 99,
      chunkKey: "ghost:v1#99",
      text: "ghost",
      contentHash: "ghost",
      locator: { blockIndex: 0, page: null, heading: null },
      createdAt: 1,
    });
    await ctx.db.delete(id);
    return id;
  });
  const withMissingChunk = (await b.query(api.sources.getCitationSource, {
    projectId: projectB,
    documentId: own.documentId as never,
    chunkId: discarded,
  })) as SourceResult;

  expect(withForeignChunk.status).toBe("unavailable");
  expect(withForeignChunk.status === "unavailable" && withForeignChunk.reason).toBe("chunk-deleted");
  // Identical answers apart from the id the caller itself supplied: a foreign
  // chunk id reveals nothing a missing one does not.
  const withoutEcho = (result: SourceResult): unknown => {
    if (result.status !== "unavailable") return result;
    const source = { ...(result.source as Record<string, unknown>) };
    delete source.chunkId;
    return { ...result, source };
  };
  expect(withoutEcho(withForeignChunk)).toEqual(withoutEcho(withMissingChunk));
  expect(JSON.stringify(withForeignChunk)).not.toContain(foreignChunks[0].text.slice(0, 32));
});

test("missing chunks, not-ready documents and stale citations each report their own unavailable reason", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await seedReadyDocument(t, a, projectId, "three-page-lesson.pdf", "miss-key-000001");
  const chunks = await chunkRows(t, uploaded.documentId);
  expect(chunks.length).toBeGreaterThan(1);

  // Matching content hash resolves; a stale one does not (and never leaks text).
  const fresh = (await a.query(api.sources.getCitationSource, {
    projectId,
    documentId: uploaded.documentId as never,
    chunkId: chunks[1]._id as never,
    contentHash: chunks[1].contentHash,
  })) as SourceResult;
  expect(fresh.status).toBe("ok");
  const stale = (await a.query(api.sources.getCitationSource, {
    projectId,
    documentId: uploaded.documentId as never,
    chunkId: chunks[1]._id as never,
    contentHash: "0".repeat(64),
  })) as SourceResult;
  expect(stale.status).toBe("unavailable");
  if (stale.status !== "unavailable") throw new Error("unreachable");
  expect(stale.reason).toBe("content-version-mismatch");
  expect(stale.source).toMatchObject({ seq: chunks[1].seq, page: chunks[1].locator.page, heading: chunks[1].locator.heading });
  expect(JSON.stringify(stale)).not.toContain(chunks[1].text.slice(0, 32));

  // A vanished chunk (re-processing replaced the rows) reports chunk-deleted.
  await t.run(async (ctx) => ctx.db.delete(chunks[1]._id as never));
  const gone = (await a.query(api.sources.getCitationSource, {
    projectId,
    documentId: uploaded.documentId as never,
    chunkId: chunks[1]._id as never,
  })) as SourceResult;
  expect(gone.status).toBe("unavailable");
  if (gone.status !== "unavailable") throw new Error("unreachable");
  expect(gone.reason).toBe("chunk-deleted");
  expect(gone.source).toMatchObject({ chunkId: chunks[1]._id, seq: null, page: null, heading: null, contentHash: null });

  // Not-ready documents keep their chunks but never hand out their text.
  await t.run(async (ctx) => {
    const document = await ctx.db.get(uploaded.documentId as never);
    if (document !== null) await ctx.db.patch(document._id, { status: "pending", failureCode: null });
  });
  const pending = (await a.query(api.sources.getCitationSource, {
    projectId,
    documentId: uploaded.documentId as never,
    chunkId: chunks[0]._id as never,
  })) as SourceResult;
  expect(pending.status).toBe("unavailable");
  if (pending.status !== "unavailable") throw new Error("unreachable");
  expect(pending.reason).toBe("document-not-ready");
  expect(pending.source).toMatchObject({ seq: chunks[0].seq, page: chunks[0].locator.page, heading: chunks[0].locator.heading });
  expect(JSON.stringify(pending)).not.toContain(chunks[0].text.slice(0, 24));
});

test("the source response never carries storage ids, private file ids or bearer URLs", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await seedReadyDocument(t, a, projectId, "lesson.md", "safe-key-000001");
  const chunks = await chunkRows(t, uploaded.documentId);

  const ok = await a.query(api.sources.getCitationSource, { projectId, documentId: uploaded.documentId as never, chunkId: chunks[0]._id as never });
  const serialized = JSON.stringify(ok);
  for (const needle of ["storage", "_storage", "storageId", "privateFileId", "http", "getUrl"]) {
    expect(serialized.includes(needle), `source response must not contain ${needle}`).toBe(false);
  }
  expect(serialized).not.toContain(uploaded.privateFileId);
});
