import { readFileSync, readdirSync } from "node:fs";

import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
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

type UploadBody = {
  documentId: string;
  privateFileId: string;
  jobId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  idempotent: boolean;
};

const uploadBody = async (response: Response): Promise<UploadBody> => (await response.json()) as UploadBody;
const errorCode = async (response: Response): Promise<string> => ((await response.json()) as { code: string }).code;

/** Observed storage rows: one row exists while its blob is reachable. */
async function storedBlobCount(t: TestInstance | TestUser): Promise<number> {
  const rows = await t.run(async (ctx) => ctx.db.system.query("_storage" as never).collect() as Promise<Record<string, unknown>[]>);
  return rows.length;
}

async function countRows(t: TestInstance | TestUser, table: "documents" | "privateFiles" | "ingestionJobs"): Promise<number> {
  const rows = await t.run(async (ctx) => ctx.db.query(table).collect());
  return rows.length;
}

test("an owner uploads a private document, queues one job and downloads the bytes", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const bytes = fixture("lesson.md");

  const response = await a.fetch(uploadPath(projectId, "lesson.md", "lesson-key-000001"), post(bytes, "text/markdown"));
  expect(response.status).toBe(201);
  const body = await uploadBody(response);
  expect(body).toMatchObject({
    filename: "lesson.md",
    contentType: "text/markdown",
    sizeBytes: bytes.byteLength,
    status: "pending",
    idempotent: false,
  });
  // The response carries status metadata only: no storage id and no bearer URL.
  expect(Object.keys(body).sort()).toEqual(["contentType", "documentId", "filename", "idempotent", "jobId", "privateFileId", "sizeBytes", "status"]);

  expect(await storedBlobCount(t)).toBe(1);
  expect(await countRows(t, "documents")).toBe(1);
  expect(await countRows(t, "privateFiles")).toBe(1);
  expect(await countRows(t, "ingestionJobs")).toBe(1);

  const download = await a.fetch(`/private-files/${body.privateFileId}`);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("text/markdown");
  expect(download.headers.get("cache-control")).toBe("private, no-store");
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
});

test("an anonymous caller is rejected on every upload, download and status request", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const bytes = fixture("notes.txt");
  const path = uploadPath(projectId, "notes.txt", "anon-key-000001");

  const anonymousUpload = await t.fetch(path, post(bytes, "text/plain"));
  expect(anonymousUpload.status).toBe(401);
  expect(await errorCode(anonymousUpload)).toBe("UNAUTHENTICATED");
  expect(await storedBlobCount(t)).toBe(0);
  expect(await countRows(t, "documents")).toBe(0);
  await expect(t.query(api.documents.listDocuments, { projectId })).rejects.toThrow("UNAUTHENTICATED");

  const owned = await a.fetch(path, post(bytes, "text/plain"));
  expect(owned.status).toBe(201);
  const { documentId, privateFileId } = await uploadBody(owned);

  await expect(t.query(api.documents.getDocument, { projectId, documentId: documentId as never })).rejects.toThrow("UNAUTHENTICATED");
  await expect(t.query(api.documents.listDocuments, { projectId })).rejects.toThrow("UNAUTHENTICATED");

  // The same URL answers 401 without identity, 200 with it, then 401 again.
  expect((await t.fetch(`/private-files/${privateFileId}`)).status).toBe(401);
  expect((await a.fetch(`/private-files/${privateFileId}`)).status).toBe(200);
  expect((await t.fetch(`/private-files/${privateFileId}`)).status).toBe(401);
});

test("a second learner cannot upload into or read another learner's project", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const projectB = await b.mutation(api.projects.createProject, { name: "B" });
  const bytes = fixture("lesson.md");

  const foreignUpload = await b.fetch(uploadPath(projectA, "steal.md", "steal-key-000001"), post(bytes, "text/markdown"));
  expect(foreignUpload.status).toBe(404);
  expect(await errorCode(foreignUpload)).toBe("NOT_FOUND");
  expect(await storedBlobCount(t)).toBe(0);
  expect(await countRows(t, "documents")).toBe(0);

  const owned = await a.fetch(uploadPath(projectA, "lesson.md", "owner-key-000001"), post(bytes, "text/markdown"));
  expect(owned.status).toBe(201);
  const { documentId, privateFileId } = await uploadBody(owned);

  expect((await b.fetch(`/private-files/${privateFileId}`)).status).toBe(404);
  expect((await a.fetch(`/private-files/${privateFileId}`)).status).toBe(200);
  await expect(b.query(api.documents.listDocuments, { projectId: projectA })).rejects.toThrow("NOT_FOUND");
  await expect(b.query(api.documents.getDocument, { projectId: projectA, documentId: documentId as never })).rejects.toThrow("NOT_FOUND");
  await expect(a.query(api.documents.listDocuments, { projectId: projectA })).resolves.toHaveLength(1);
  await expect(b.query(api.documents.listDocuments, { projectId: projectB })).resolves.toEqual([]);
  expect(await storedBlobCount(t)).toBe(1);
});

test("the configured size limit rejects oversize bodies before anything is saved", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const previous = process.env.MAX_UPLOAD_BYTES;
  process.env.MAX_UPLOAD_BYTES = "64";
  try {
    // Declared length over the limit is rejected before the body is read.
    const declared = await a.fetch(uploadPath(projectId, "big.txt", "large-key-000001"), post(new Uint8Array(65), "text/plain"));
    expect(declared.status).toBe(413);
    expect(await errorCode(declared)).toBe("FILE_TOO_LARGE");

    // A chunked body without a declared length is still measured and rejected.
    const chunked = await a.fetch(
      uploadPath(projectId, "big.txt", "large-key-000002"),
      {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(65));
            controller.close();
          },
        }),
        headers: { "content-type": "text/plain" },
        duplex: "half",
      } as RequestInit,
    );
    expect(chunked.status).toBe(413);
    expect(await errorCode(chunked)).toBe("FILE_TOO_LARGE");

    expect(await storedBlobCount(t)).toBe(0);
    expect(await countRows(t, "documents")).toBe(0);

    const small = await a.fetch(uploadPath(projectId, "tiny.txt", "small-key-000001"), post("ok", "text/plain"));
    expect(small.status).toBe(201);
    expect(await storedBlobCount(t)).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.MAX_UPLOAD_BYTES;
    else process.env.MAX_UPLOAD_BYTES = previous;
  }
});

test("unknown extensions and mismatched media types are rejected before saving", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });

  const executable = await a.fetch(uploadPath(projectId, "run.exe", "exe-key-00000001"), post("MZ synthetic bytes", "application/octet-stream"));
  expect(executable.status).toBe(415);
  expect(await errorCode(executable)).toBe("UNSUPPORTED_MEDIA_TYPE");

  const mismatched = await a.fetch(uploadPath(projectId, "notes.txt", "mime-key-0000001"), post(fixture("notes.txt"), "application/pdf"));
  expect(mismatched.status).toBe(415);
  expect(await errorCode(mismatched)).toBe("UNSUPPORTED_MEDIA_TYPE");

  const missing = await a.fetch(uploadPath(projectId, "notes.txt", "mime-key-0000002"), post(fixture("notes.txt")));
  expect(missing.status).toBe(415);
  expect(await errorCode(missing)).toBe("UNSUPPORTED_MEDIA_TYPE");

  expect(await storedBlobCount(t)).toBe(0);
  expect(await countRows(t, "documents")).toBe(0);
  expect(await countRows(t, "privateFiles")).toBe(0);
  expect(await countRows(t, "ingestionJobs")).toBe(0);
});

test("content that does not match its extension is rejected before saving", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });

  const mislabelled = await a.fetch(uploadPath(projectId, "mislabelled.pdf", "fake-key-0000001"), post(fixture("mislabelled.pdf"), "application/pdf"));
  expect(mislabelled.status).toBe(400);
  expect(await errorCode(mislabelled)).toBe("UNSUPPORTED_CONTENT");

  const truncated = await a.fetch(uploadPath(projectId, "truncated.pdf", "cut-key-00000001"), post(fixture("truncated.pdf"), "application/pdf"));
  expect(truncated.status).toBe(400);
  expect(await errorCode(truncated)).toBe("UNSUPPORTED_CONTENT");

  const withNul = await a.fetch(uploadPath(projectId, "nul.txt", "nul-key-00000001"), post(new Uint8Array([0x48, 0x00, 0x49]), "text/plain"));
  expect(withNul.status).toBe(400);
  expect(await errorCode(withNul)).toBe("UNSUPPORTED_CONTENT");

  const invalidUtf8 = await a.fetch(uploadPath(projectId, "bad.txt", "utf-key-00000001"), post(new Uint8Array([0xff, 0xfe, 0xfd]), "text/plain"));
  expect(invalidUtf8.status).toBe(400);
  expect(await errorCode(invalidUtf8)).toBe("UNSUPPORTED_CONTENT");

  expect(await storedBlobCount(t)).toBe(0);
  expect(await countRows(t, "documents")).toBe(0);
});

test("filenames and request parameters are validated before the body is read", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const bytes = fixture("lesson.md");

  const traversal = await a.fetch(uploadPath(projectId, "../escape.md", "name-key-00000001"), post(bytes, "text/markdown"));
  expect(traversal.status).toBe(400);
  expect(await errorCode(traversal)).toBe("INVALID_FILENAME");

  const withoutExtension = await a.fetch(uploadPath(projectId, "notes", "name-key-00000002"), post(bytes, "text/markdown"));
  expect(withoutExtension.status).toBe(400);
  expect(await errorCode(withoutExtension)).toBe("INVALID_FILENAME");

  const badKey = await a.fetch(uploadPath(projectId, "lesson.md", "short"), post(bytes, "text/markdown"));
  expect(badKey.status).toBe(400);
  expect(await errorCode(badKey)).toBe("INVALID_ARGUMENT");

  const badProject = await a.fetch(uploadPath("not a project id", "lesson.md", "name-key-00000003"), post(bytes, "text/markdown"));
  expect(badProject.status).toBe(400);
  expect(await errorCode(badProject)).toBe("INVALID_ARGUMENT");

  const empty = await a.fetch(uploadPath(projectId, "lesson.md", "name-key-00000004"), post(new Uint8Array(0), "text/markdown"));
  expect(empty.status).toBe(400);
  expect(await errorCode(empty)).toBe("EMPTY_FILE");

  expect(await storedBlobCount(t)).toBe(0);
  expect(await countRows(t, "documents")).toBe(0);
});

test("a retried upload replays one document and one job without an orphan blob", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const bytes = fixture("outline.pdf");
  const path = uploadPath(projectId, "outline.pdf", "retry-key-000001");

  const first = await a.fetch(path, post(bytes, "application/pdf"));
  expect(first.status).toBe(201);
  const firstBody = await uploadBody(first);
  expect(firstBody.idempotent).toBe(false);
  expect(await storedBlobCount(t)).toBe(1);

  // The retry stores a fresh blob, then the transactional commit recognizes the
  // idempotency key and the action deletes the uncommitted blob again.
  const retry = await a.fetch(path, post(bytes, "application/pdf"));
  expect(retry.status).toBe(200);
  const replayed = await uploadBody(retry);
  expect(replayed.idempotent).toBe(true);
  expect(replayed.documentId).toBe(firstBody.documentId);
  expect(replayed.jobId).toBe(firstBody.jobId);

  expect(await storedBlobCount(t)).toBe(1);
  expect(await countRows(t, "documents")).toBe(1);
  expect(await countRows(t, "privateFiles")).toBe(1);
  expect(await countRows(t, "ingestionJobs")).toBe(1);
});

test("project deletion removes documents, jobs, registry rows and their blobs", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const uploaded = await a.fetch(uploadPath(projectId, "notes.txt", "delete-key-000001"), post(fixture("notes.txt"), "text/plain"));
  expect(uploaded.status).toBe(201);
  expect(await storedBlobCount(t)).toBe(1);

  await a.mutation(api.projects.requestProjectDeletion, { projectId });
  const batch = await a.mutation(api.projects.deleteProjectBatch, { projectId, limit: 10 });
  expect(batch.completed).toBe(true);
  expect(await countRows(t, "documents")).toBe(0);
  expect(await countRows(t, "privateFiles")).toBe(0);
  expect(await countRows(t, "ingestionJobs")).toBe(0);
  expect(await storedBlobCount(t)).toBe(0);
  expect(await t.run(async (ctx) => ctx.db.get(projectId))).toBeNull();
});

test("pending, failed and ready states surface without content leakage", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A" });
  const bytes = fixture("notes.txt");

  const uploaded = await a.fetch(uploadPath(projectId, "notes.txt", "state-key-000001"), post(bytes, "text/plain"));
  const { documentId } = await uploadBody(uploaded);

  const pending = await a.query(api.documents.getDocument, { projectId, documentId: documentId as never });
  expect(pending.status).toBe("pending");
  expect(pending.failureCode).toBeNull();
  expect(Object.keys(pending).sort()).toEqual(["_id", "contentType", "createdAt", "extension", "failureCode", "filename", "privateFileId", "sizeBytes", "status", "updatedAt"]);
  expect(JSON.stringify(pending)).not.toContain("Synthetic");

  await t.run(async (ctx) => ctx.db.patch(documentId as never, { status: "failed", failureCode: "PARSER_UNSUPPORTED", updatedAt: Date.now() }));
  const failed = await a.query(api.documents.getDocument, { projectId, documentId: documentId as never });
  expect(failed.status).toBe("failed");
  expect(failed.failureCode).toBe("PARSER_UNSUPPORTED");
  expect(JSON.stringify(failed)).not.toContain("Synthetic");

  await t.run(async (ctx) => ctx.db.patch(documentId as never, { status: "ready", failureCode: null, updatedAt: Date.now() }));
  const listed = await a.query(api.documents.listDocuments, { projectId });
  expect(listed).toHaveLength(1);
  expect(listed[0].status).toBe("ready");
  expect(JSON.stringify(listed)).not.toContain("Synthetic");
  expect(JSON.stringify(listed)).not.toMatch(/storageId|getUrl/);
});

test("no convex module ever exposes a storage.getUrl bearer link", () => {
  const directory = new URL("../convex/", import.meta.url);
  const sources = readdirSync(directory).filter((name) => name.endsWith(".ts"));
  expect(sources).toContain("documents.ts");
  expect(sources).toContain("http.ts");
  for (const name of sources) {
    const source = readFileSync(new URL(name, directory), "utf8");
    expect(source, name).not.toMatch(/getUrl\s*\(/);
  }
});
