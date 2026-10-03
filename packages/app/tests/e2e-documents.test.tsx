// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { convexTest } from "convex-test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { installAuthTestEnv } from "../../api/tests/helpers/authEnv.js";
import { installEmbeddingProvider, syntheticEmbeddingVector } from "../../api/tests/helpers/embeddingProvider.js";
import { makeConvexDocumentsBackend, type DocumentsBackend } from "../src/data/documents.js";
import { makeConvexProjectsBackend, type ProjectsBackend } from "../src/data/projects.js";
import { Root, type AuthSession } from "../src/Root.js";
import { serializeRoute } from "../src/router.js";
import { asConvexClient } from "./fixtures.js";

/**
 * S22 end-to-end: the real screens drive the real authorized Convex functions
 * in-process (convex-test) — upload through the authenticated S08 HTTP action,
 * ingestion through the S09 runner with an offline embeddings stub, citation
 * resolution through the S13 action and the S22 source query. No deployment,
 * credentials or network are involved.
 */

// Must run before any convex/ module is imported (JWT material is synthetic).
installAuthTestEnv();

const modules = {
  "../../api/convex/_generated/api.ts": () => import("../../api/convex/_generated/api.js"),
  "../../api/convex/agentSessions.ts": () => import("../../api/convex/agentSessions.js"),
  "../../api/convex/auth.ts": () => import("../../api/convex/auth.js"),
  "../../api/convex/documents.ts": () => import("../../api/convex/documents.js"),
  "../../api/convex/embeddings.ts": () => import("../../api/convex/embeddings.js"),
  "../../api/convex/files.ts": () => import("../../api/convex/files.js"),
  "../../api/convex/http.ts": () => import("../../api/convex/http.js"),
  "../../api/convex/ingestion.ts": () => import("../../api/convex/ingestion.js"),
  "../../api/convex/projects.ts": () => import("../../api/convex/projects.js"),
  "../../api/convex/redirects.ts": () => import("../../api/convex/redirects.js"),
  "../../api/convex/retrieval.ts": () => import("../../api/convex/retrieval.js"),
  "../../api/convex/sources.ts": () => import("../../api/convex/sources.js"),
};

let restoreEmbeddingProvider: () => void;
beforeEach(() => {
  restoreEmbeddingProvider = installEmbeddingProvider("learner-a");
  window.location.hash = "";
});
afterEach(() => {
  restoreEmbeddingProvider();
  cleanup();
});

const makeTest = () => convexTest({ schema, modules });
type TestInstance = ReturnType<typeof makeTest>;

const identity = (subject: string) => ({ subject, issuer: "https://test.example" });

// jsdom rewrites import.meta.url, so fixtures resolve from the repo root that
// runs the suite instead of the module URL.
const fixture = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(join(process.cwd(), "packages/api/tests/fixtures", name)));

const uploadPath = (projectId: string, filename: string, idempotencyKey: string): string =>
  `/private-uploads?projectId=${encodeURIComponent(projectId)}&filename=${encodeURIComponent(filename)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`;

const post = (body: BodyInit, contentType?: string): RequestInit => ({
  method: "POST",
  body,
  ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
});

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return { isLoading: false, isAuthenticated: true, signIn: async () => undefined, signOut: async () => undefined, ...overrides };
}

type Backends = { projects: ProjectsBackend; documents: DocumentsBackend };

function backendsFor(t: TestInstance, subject?: string): Backends {
  const client = subject === undefined ? t : t.withIdentity(identity(subject));
  return {
    projects: makeConvexProjectsBackend(asConvexClient(client)),
    documents: makeConvexDocumentsBackend(asConvexClient(client), {
      getToken: () => "synthetic-test-token",
      // convex-test's fetch only accepts root-relative paths.
      siteUrl: "",
      fetchImpl: (input, init) => (subject === undefined ? t : t.withIdentity(identity(subject))).fetch(input, init),
    }),
  };
}

type UploadBody = { documentId: string; privateFileId: string; jobId: string };

/** Uploads one fixture through the real HTTP action (no ingestion yet). */
async function uploadFixture(t: TestInstance, subject: string, projectId: string, filename: string, key: string): Promise<UploadBody> {
  const contentType = filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".md") ? "text/markdown" : "text/plain";
  const response = await t.withIdentity(identity(subject)).fetch(uploadPath(projectId, filename, key), post(fixture(filename), contentType));
  expect(response.status).toBe(201);
  return (await response.json()) as UploadBody;
}

type ChunkRow = { _id: string; seq: number; text: string; contentHash: string; locator: { page: number | null; heading: string | null } };

/** Matches raw multi-line chunk text against testing-library's collapsed text. */
const textMatcher = (raw: string) => (content: string) => content === raw.replace(/\s+/g, " ").trim();

async function chunkRows(t: TestInstance, documentId: string): Promise<ChunkRow[]> {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("documentChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId as never))
      .collect(),
  );
  return (rows as unknown as ChunkRow[]).sort((left, right) => left.seq - right.seq);
}

async function countTable(t: TestInstance, table: "documents" | "privateFiles" | "ingestionJobs" | "documentChunks" | "chunkEmbeddings"): Promise<number> {
  const rows = await t.run(async (ctx) => ctx.db.query(table).collect());
  return rows.length;
}

async function storedBlobCount(t: TestInstance): Promise<number> {
  const rows = await t.run(async (ctx) => ctx.db.system.query("_storage" as never).collect() as Promise<unknown[]>);
  return rows.length;
}

test("upload flows to ready through the UI, then the source and a real citation open at the right page", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("learner-a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Citation project" });
  const { projects, documents } = backendsFor(t, "learner-a");
  window.location.hash = serializeRoute({ name: "documents", projectId });
  const user = userEvent.setup();
  render(<Root session={session()} backend={projects} documents={documents} />);

  await screen.findByRole("heading", { name: "No documents yet" });

  await user.upload(
    screen.getByLabelText("Add a document"),
    new File([fixture("three-page-lesson.pdf")], "three-page-lesson.pdf", { type: "application/pdf" }),
  );
  await user.click(screen.getByRole("button", { name: "Upload" }));

  // Server truth right after upload: queued, never an optimistic "Ready".
  try {
    await screen.findByText(/uploaded — waiting to process/, {}, { timeout: 3000 });
  } catch {
    throw new Error(`upload did not succeed; screen says: ${document.body.textContent ?? ""}`);
  }
  expect(screen.getByText("Waiting to process")).toBeTruthy();
  expect(screen.queryByText(/^Ready/)).toBeNull();
  expect(screen.queryByRole("link", { name: /^Open source/ })).toBeNull();

  // The real S09 runner processes the upload against the offline embeddings stub.
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.outcomes[0]?.outcome).toBe("succeeded");

  // The screen's poll picks up the joined job state from the server.
  await screen.findByText(/^Ready · \d+ sections?$/, {}, { timeout: 5_000 });

  const listed = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(listed).toHaveLength(1);
  const documentId = listed[0].document._id;
  const rows = await chunkRows(t, documentId);
  expect(rows.length).toBeGreaterThan(0);

  // "Open source" lands on the real extracted text at the real locator.
  await user.click(screen.getByRole("link", { name: "Open source of three-page-lesson.pdf" }));
  await screen.findByRole("heading", { level: 1, name: "three-page-lesson.pdf" });
  expect(screen.getByText(textMatcher(rows[0].text))).toBeTruthy();
  expect(screen.getByText(`Page ${rows[0].locator.page}`)).toBeTruthy();

  // A real S13 citation (offline synthetic query vector) opens the exact
  // cited passage with the cited badge: document, page and text all match.
  const retrieval = await a.action(api.retrieval.retrieveProjectContext, {
    projectId,
    query: rows[0].text.slice(0, 80),
    vector: syntheticEmbeddingVector(1),
    topK: 4,
  });
  expect(retrieval.status).toBe("ok");
  if (retrieval.status !== "ok") throw new Error("expected citations");
  const citation = retrieval.citations[0];
  const citedRow = rows.find((row) => row.seq === citation.seq);
  expect(citedRow).toBeDefined();
  if (citedRow === undefined) throw new Error("expected cited row");

  window.location.hash = serializeRoute({
    name: "source",
    projectId,
    documentId: citation.documentId,
    chunkId: citation.chunkId,
    contentHash: citation.contentHash,
  });
  // Wait for the citation-anchored remount first: the overview can show the
  // same first-chunk text without the cited badge.
  expect(await screen.findByText("Cited source", {}, { timeout: 3_000 })).toBeTruthy();
  expect(screen.getByText(textMatcher(citedRow.text))).toBeTruthy();
  if (citation.page !== null) expect(screen.getByText(`Page ${citation.page}`)).toBeTruthy();
  if (citation.heading !== null) expect(screen.getByText(citation.heading)).toBeTruthy();
});

test("cross-user and anonymous source requests are denied without leaking content", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("learner-a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "A private project" });
  const uploaded = await uploadFixture(t, "learner-a", projectId, "lesson.md", "e2e-deny-0001");
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.outcomes[0]?.outcome).toBe("succeeded");
  const rows = await chunkRows(t, uploaded.documentId);
  expect(rows.length).toBeGreaterThan(0);
  const sourceArgs = { projectId, documentId: uploaded.documentId, chunkId: rows[0]._id, contentHash: rows[0].contentHash };
  const sourceRoute = serializeRoute({ name: "source", projectId, documentId: uploaded.documentId, chunkId: rows[0]._id, contentHash: rows[0].contentHash });

  // Learner B, signed in, deep-links straight to A's citation.
  window.location.hash = sourceRoute;
  const b = backendsFor(t, "learner-b");
  render(<Root session={session()} backend={b.projects} documents={b.documents} />);
  const denied = await screen.findByRole("alert");
  expect(denied.textContent).toContain("You don’t have access to this source.");
  expect(screen.queryByText(textMatcher(rows[0].text))).toBeNull();
  expect(screen.queryByText("lesson.md")).toBeNull();

  // Server truth behind the panel: cross-project AND cross-document deny.
  await expect(b.documents.source(sourceArgs)).rejects.toThrow("NOT_FOUND");
  const projectB = await t.withIdentity(identity("learner-b")).mutation(api.projects.createProject, { name: "B project" });
  await expect(b.documents.source({ projectId: projectB, documentId: uploaded.documentId })).rejects.toThrow("NOT_FOUND");

  cleanup();
  // Anonymous: the session gate shows sign-in and the server rejects outright.
  window.location.hash = sourceRoute;
  const anonymous = backendsFor(t);
  render(<Root session={session({ isAuthenticated: false })} backend={anonymous.projects} documents={anonymous.documents} />);
  await screen.findByLabelText("Email");
  await expect(anonymous.documents.source(sourceArgs)).rejects.toThrow("UNAUTHENTICATED");
  expect(screen.queryByText(textMatcher(rows[0].text))).toBeNull();
  expect(screen.queryByRole("heading", { level: 1, name: "lesson.md" })).toBeNull();
});

test("document deletion cleans every source row and the citation becomes explicitly unavailable", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("learner-a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Cleanup project" });
  const uploaded = await uploadFixture(t, "learner-a", projectId, "lesson.md", "e2e-clean-0001");
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.outcomes[0]?.outcome).toBe("succeeded");
  const rows = await chunkRows(t, uploaded.documentId);
  const sourceRoute = serializeRoute({
    name: "source",
    projectId,
    documentId: uploaded.documentId,
    chunkId: rows[0]._id,
    contentHash: rows[0].contentHash,
  });

  const { projects, documents } = backendsFor(t, "learner-a");
  const user = userEvent.setup();

  // The citation opens with real content first.
  window.location.hash = sourceRoute;
  render(<Root session={session()} backend={projects} documents={documents} />);
  expect(await screen.findByText(textMatcher(rows[0].text), {}, { timeout: 3000 })).toBeTruthy();
  expect(screen.getByText("Cited source")).toBeTruthy();

  // Delete through the confirmed UI flow.
  window.location.hash = serializeRoute({ name: "documents", projectId });
  await screen.findByRole("heading", { level: 1, name: "Documents" });
  await user.click(await screen.findByRole("button", { name: "Delete lesson.md" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("Citations that point at it will show as unavailable");
  await user.click(dialog.querySelector("button.button-danger") as HTMLButtonElement);
  await screen.findByRole("heading", { name: "No documents yet" });

  // Server-side cleanup: chunks, vectors, jobs, file row and bytes are gone;
  // only the content-free tombstone row remains.
  expect(await countTable(t, "documentChunks")).toBe(0);
  expect(await countTable(t, "chunkEmbeddings")).toBe(0);
  expect(await countTable(t, "ingestionJobs")).toBe(0);
  expect(await countTable(t, "privateFiles")).toBe(0);
  expect(await storedBlobCount(t)).toBe(0);
  const remainingDocuments = (await t.run(async (ctx) => ctx.db.query("documents").collect())) as unknown as { deletedAt?: number }[];
  expect(remainingDocuments).toHaveLength(1);
  expect(typeof remainingDocuments[0].deletedAt).toBe("number");

  // The very same citation now shows the explicit unavailable state: no
  // broken link, no crash, no silent empty panel, no source text.
  window.location.hash = sourceRoute;
  await screen.findByRole("heading", { name: "Source unavailable" });
  const panel = screen.getByRole("status");
  expect(panel.textContent).toContain("The document was deleted");
  expect(panel.textContent).toContain("lesson.md");
  expect(screen.queryByText(textMatcher(rows[0].text))).toBeNull();
  expect(screen.queryByText("Cited source")).toBeNull();
  expect(screen.getByRole("link", { name: "Back to documents" }).getAttribute("href")).toBe(serializeRoute({ name: "documents", projectId }));
});
