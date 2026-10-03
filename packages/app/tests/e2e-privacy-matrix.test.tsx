// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { convexTest } from "convex-test";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, expect, test } from "vitest";

import { api, internal } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { installAuthTestEnv } from "../../api/tests/helpers/authEnv.js";
import { syntheticEmbeddingVector } from "../../api/tests/helpers/embeddingProvider.js";
import { Root } from "../src/Root.js";
import { SpokenConversation } from "../src/SpokenConversation.js";
import { requestTtsAudio } from "../src/ttsClient.js";
import { serializeRoute } from "../src/router.js";
import { ensureSubtleCrypto } from "./jsdomCrypto.js";
import {
  allRows,
  countRows,
  dynamicClient,
  releaseBackends,
  releaseVoicePorts,
  uploadFixture,
  type Id,
  type TestInstance,
} from "./helpers/releaseHarness.js";
import { installVoiceProviderMock, QUESTION } from "./helpers/voiceConversation.js";

/**
 * S26 acceptance criterion 3: the two-user privacy matrix. Learner B attempts
 * every access surface against learner A's data and must fail on each one:
 *
 *   UI | Convex functions | HTTP file actions | HTTP STT/TTS actions |
 *   vector search/retrieval | agent connection state | caches/telemetry | audio
 *
 * One shared deployment seeds A's world once (project, ingested document,
 * completed grounded turn, agent connection token) with synthetic fixtures
 * and the offline NaN mock; every row below is one named test, so CI reports
 * the matrix per surface and attempt.
 */

installAuthTestEnv();
ensureSubtleCrypto();

const modules = {
  "../../api/convex/_generated/api.ts": () => import("../../api/convex/_generated/api.js"),
  "../../api/convex/agentSessions.ts": () => import("../../api/convex/agentSessions.js"),
  "../../api/convex/auth.ts": () => import("../../api/convex/auth.js"),
  "../../api/convex/concept.ts": () => import("../../api/convex/concept.js"),
  "../../api/convex/documents.ts": () => import("../../api/convex/documents.js"),
  "../../api/convex/embeddings.ts": () => import("../../api/convex/embeddings.js"),
  "../../api/convex/files.ts": () => import("../../api/convex/files.js"),
  "../../api/convex/http.ts": () => import("../../api/convex/http.js"),
  "../../api/convex/ingestion.ts": () => import("../../api/convex/ingestion.js"),
  "../../api/convex/languagePractice.ts": () => import("../../api/convex/languagePractice.js"),
  "../../api/convex/observability.ts": () => import("../../api/convex/observability.js"),
  "../../api/convex/projects.ts": () => import("../../api/convex/projects.js"),
  "../../api/convex/redirects.ts": () => import("../../api/convex/redirects.js"),
  "../../api/convex/retrieval.ts": () => import("../../api/convex/retrieval.js"),
  "../../api/convex/sources.ts": () => import("../../api/convex/sources.js"),
  "../../api/convex/stt.ts": () => import("../../api/convex/stt.js"),
  "../../api/convex/translation.ts": () => import("../../api/convex/translation.js"),
  "../../api/convex/tutor.ts": () => import("../../api/convex/tutor.js"),
  "../../api/convex/tts.ts": () => import("../../api/convex/tts.js"),
};

const A_SUBJECT = "learner-a|session-1";
const B_SUBJECT = "learner-b|session-1";
const identityOf = (subject: string) => ({ subject, issuer: "https://test.example" });

type Seed = {
  t: TestInstance;
  a: TestInstance;
  b: TestInstance;
  projectId: Id<"projects">;
  documentId: Id<"documents">;
  fileId: Id<"privateFiles">;
  chunkId: Id<"documentChunks">;
  contentHash: string;
  turnId: string;
  token: string;
  tokenId: Id<"agentConnectionTokens">;
};

let provider: ReturnType<typeof installVoiceProviderMock>;
let seeded: Seed;

beforeAll(async () => {
  process.env.NAN_API_KEY = "synthetic-test-key";
  process.env.NAN_DEPLOYER_ID = "learner-a";
  process.env.TUTOR_RETRY_BASE_MS = "0";
  provider = installVoiceProviderMock();

  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identityOf(A_SUBJECT));
  const b = t.withIdentity(identityOf(B_SUBJECT));

  // A's world: project + ingested document + one completed grounded turn.
  const projectId = await a.mutation(api.projects.createProject, {
    name: "A private notes",
    goal: "Pass the driving theory test",
    mode: "concept-learning",
  });
  const uploaded = await uploadFixture(t, A_SUBJECT, projectId, "lesson.md", "matrix-seed-0001");
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-matrix" });
  expect(cycle.outcomes[0]?.outcome).toBe("succeeded");
  const chunks = await allRows<{ _id: string; contentHash: string }>(t, "documentChunks");
  expect(chunks.length).toBeGreaterThan(0);
  const turn = (await a.action(api.tutor.runTurn, { projectId, turnId: "matrix-turn-1", text: QUESTION })) as { status: string };
  expect(turn.status).toBe("completed");
  const issued = (await a.mutation(api.agentSessions.issueConnectionToken, { projectId })) as { token: string; tokenId: string };

  seeded = {
    t,
    a,
    b,
    projectId,
    documentId: uploaded.documentId as Id<"documents">,
    fileId: uploaded.privateFileId as Id<"privateFiles">,
    chunkId: chunks[0]._id as Id<"documentChunks">,
    contentHash: chunks[0].contentHash,
    turnId: "matrix-turn-1",
    token: issued.token,
    tokenId: issued.tokenId as Id<"agentConnectionTokens">,
  };
});

afterAll(() => {
  provider.restore();
  delete process.env.NAN_API_KEY;
  delete process.env.NAN_DEPLOYER_ID;
  delete process.env.TUTOR_RETRY_BASE_MS;
  cleanup();
});

/* ------------------------------------------------------------------ *
 * Surface: Convex functions (queries, mutations, actions)
 * ------------------------------------------------------------------ */

type FunctionRow = { attempt: string; run: (s: Seed) => Promise<unknown>; expected: string };

const functionRows: FunctionRow[] = [
  { attempt: "projects.getProject(A) as B", run: (s) => s.b.query(api.projects.getProject, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "projects.updateProject(A) as B", run: (s) => s.b.mutation(api.projects.updateProject, { projectId: s.projectId, name: "stolen", goal: "" }), expected: "NOT_FOUND" },
  { attempt: "projects.requestProjectDeletion(A) as B", run: (s) => s.b.mutation(api.projects.requestProjectDeletion, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "documents.listDocuments(A) as B", run: (s) => s.b.query(api.documents.listDocuments, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "documents.getDocument(A) as B", run: (s) => s.b.query(api.documents.getDocument, { projectId: s.projectId, documentId: s.documentId as never }), expected: "NOT_FOUND" },
  { attempt: "documents.listDocumentStatuses(A) as B", run: (s) => s.b.query(api.documents.listDocumentStatuses, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "documents.retryDocument(A) as B", run: (s) => s.b.mutation(api.documents.retryDocument, { projectId: s.projectId, documentId: s.documentId as never }), expected: "NOT_FOUND" },
  { attempt: "documents.deleteDocumentBatch(A) as B", run: (s) => s.b.mutation(api.documents.deleteDocumentBatch, { projectId: s.projectId, documentId: s.documentId as never, limit: 10 }), expected: "NOT_FOUND" },
  { attempt: "files.getPrivateFile(A's file) as B", run: (s) => s.b.query(api.files.getPrivateFile, { projectId: s.projectId, fileId: s.fileId as never }), expected: "NOT_FOUND" },
  { attempt: "sources.getCitationSource(A) as B", run: (s) => s.b.query(api.sources.getCitationSource, { projectId: s.projectId, documentId: s.documentId as never, chunkId: s.chunkId as never, contentHash: s.contentHash }), expected: "NOT_FOUND" },
  { attempt: "tutor.getTranscript(A) as B", run: (s) => s.b.query(api.tutor.getTranscript, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "tutor.getTurn(A) as B", run: (s) => s.b.query(api.tutor.getTurn, { projectId: s.projectId, turnId: s.turnId }), expected: "NOT_FOUND" },
  { attempt: "tutor.latestTurn(A) as B", run: (s) => s.b.query(api.tutor.latestTurn, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "tutor.cancelTurn(A) as B", run: (s) => s.b.mutation(api.tutor.cancelTurn, { projectId: s.projectId, turnId: s.turnId }), expected: "NOT_FOUND" },
  { attempt: "tutor.runTurn(A) as B", run: (s) => s.b.action(api.tutor.runTurn, { projectId: s.projectId, turnId: "b-foreign-turn", text: "steal the answer" }), expected: "NOT_FOUND" },
  { attempt: "ingestion.listIngestionJobs(A) as B", run: (s) => s.b.query(api.ingestion.listIngestionJobs, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "agentSessions.issueConnectionToken(A) as B", run: (s) => s.b.mutation(api.agentSessions.issueConnectionToken, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "agentSessions.revokeConnectionToken(A's token) as B", run: (s) => s.b.mutation(api.agentSessions.revokeConnectionToken, { tokenId: s.tokenId as never }), expected: "NOT_FOUND" },
  { attempt: "agentSessions.revalidateConnectionToken(A's token) as B", run: (s) => s.b.mutation(api.agentSessions.revalidateConnectionToken, { token: s.token, rotate: false }), expected: "CONNECTION_TOKEN_SCOPE" },
  { attempt: "concept.getSelection(A) as B", run: (s) => s.b.query(api.concept.getSelection, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "concept.listProgressEvents(A) as B", run: (s) => s.b.query(api.concept.listProgressEvents, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "concept.selectObjectiveAndDifficulty(A) as B", run: (s) => s.b.mutation(api.concept.selectObjectiveAndDifficulty, { projectId: s.projectId, objective: "stolen objective", difficulty: "beginner" }), expected: "NOT_FOUND" },
  { attempt: "concept.runActivity(A) as B", run: (s) => s.b.action(api.concept.runActivity, { projectId: s.projectId, turnId: "b-foreign-activity", activity: "explain", text: "steal the answer" }), expected: "NOT_FOUND" },
  { attempt: "languagePractice.getLanguagePracticeConfig(A) as B", run: (s) => s.b.query(api.languagePractice.getLanguagePracticeConfig, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "languagePractice.listPractisedTopics(A) as B", run: (s) => s.b.query(api.languagePractice.listPractisedTopics, { projectId: s.projectId }), expected: "NOT_FOUND" },
  { attempt: "languagePractice.updateLanguagePracticeConfig(A) as B", run: (s) => s.b.mutation(api.languagePractice.updateLanguagePracticeConfig, { projectId: s.projectId, config: null }), expected: "NOT_FOUND" },
  { attempt: "projects.getProject(A) as anonymous", run: (s) => s.t.query(api.projects.getProject, { projectId: s.projectId }), expected: "UNAUTHENTICATED" },
  { attempt: "tutor.getTranscript(A) as anonymous", run: (s) => s.t.query(api.tutor.getTranscript, { projectId: s.projectId }), expected: "UNAUTHENTICATED" },
];

test.each(functionRows)("convex surface: $attempt is denied with $expected", async (row) => {
  const s = seeded;
  const providerBefore = { ...provider.counts };
  const turnsBefore = await countRows(s.t, "tutorTurns");
  const messagesBefore = await countRows(s.t, "messages");
  const citationsBefore = await countRows(s.t, "citations");

  await expect(row.run(s)).rejects.toThrow(row.expected);

  // C15's contract, asserted on every row: a denial is complete — no provider
  // round trip (0 mocked-fetch calls) and no row written.
  expect(provider.counts).toEqual(providerBefore);
  expect(await countRows(s.t, "tutorTurns")).toBe(turnsBefore);
  expect(await countRows(s.t, "messages")).toBe(messagesBefore);
  expect(await countRows(s.t, "citations")).toBe(citationsBefore);
});

/* ------------------------------------------------------------------ *
 * Surface: vector search and retrieval
 * ------------------------------------------------------------------ */

test("vector surface: B cannot search A's vectors, retrieve A's context, or pass a forged scope key", async () => {
  const s = seeded;
  const vector = syntheticEmbeddingVector(1);
  await expect(
    s.b.action(api.embeddings.searchProjectVectors, { projectId: s.projectId, vector, limit: 5 }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    s.b.action(api.retrieval.retrieveProjectContext, { projectId: s.projectId, query: QUESTION, vector, topK: 5 }),
  ).rejects.toThrow("NOT_FOUND");
  // A client-supplied scope key is not an argument this action accepts, so
  // it can never widen retrieval (the server derives the scope itself).
  await expect(
    s.b.action(api.retrieval.retrieveProjectContext, { projectId: s.projectId, query: QUESTION, vector, topK: 5, scopeKey: `learner-a:${s.projectId}` } as never),
  ).rejects.toThrow(/Unexpected field|INVALID_ARGUMENT/);
  // A's own retrieval still works (the denial is not vacuous).
  const own = await s.a.action(api.retrieval.retrieveProjectContext, { projectId: s.projectId, query: QUESTION, vector, topK: 5 });
  expect(own.status).toBe("ok");
});

/* ------------------------------------------------------------------ *
 * Surface: HTTP file actions (upload + private download)
 * ------------------------------------------------------------------ */

test("file surface: B cannot upload into A's project or read A's private bytes; anonymous gets 401", async () => {
  const s = seeded;
  const blobsBefore = await countRows(s.t, "privateFiles");

  const uploadPath = `/private-uploads?projectId=${encodeURIComponent(s.projectId)}&filename=stolen.md&idempotencyKey=matrix-b-0001`;
  const upload = await s.b.fetch(uploadPath, {
    method: "POST",
    body: new Uint8Array([104, 105]) as unknown as BodyInit,
    headers: { "content-type": "text/markdown" },
  });
  expect(upload.status).toBe(404);
  expect(await countRows(s.t, "privateFiles")).toBe(blobsBefore);

  const download = await s.b.fetch(`/private-files/${s.fileId}`, { method: "GET" });
  expect(download.status).toBe(404);

  const anonymous = await s.t.fetch(`/private-files/${s.fileId}`, { method: "GET" });
  expect(anonymous.status).toBe(401);
});

/* ------------------------------------------------------------------ *
 * Surface: HTTP STT and TTS actions
 * ------------------------------------------------------------------ */

test("speech-HTTP surface: B cannot transcribe against A's project or fetch A's audio; anonymous gets 401", async () => {
  const s = seeded;
  const sttPath = `/stt/transcribe?projectId=${encodeURIComponent(s.projectId)}&language=en&turnId=matrix-turn-1`;
  const stt = await s.b.fetch(sttPath, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([1, 2, 3, 4]) });
  expect(stt.status).toBe(404);
  expect(await stt.json()).toEqual({ code: "NOT_FOUND" });

  const synthPath = `/tts/synthesize?projectId=${encodeURIComponent(s.projectId)}&turnId=${encodeURIComponent(s.turnId)}`;
  const tts = await s.b.fetch(synthPath, { method: "POST" });
  expect(tts.status).toBe(404);

  const anonymousStt = await s.t.fetch(sttPath, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([1, 2, 3, 4]) });
  expect(anonymousStt.status).toBe(401);
  const anonymousTts = await s.t.fetch(synthPath, { method: "POST" });
  expect(anonymousTts.status).toBe(401);

  // No provider round trip happened for any denied attempt.
  expect(provider.counts.transcriptions).toBe(0);
  expect(provider.counts.speech).toBe(0);
});

/* ------------------------------------------------------------------ *
 * Surface: UI
 * ------------------------------------------------------------------ */

test("UI surface: B sees none of A's project, documents, transcript or citations in the real screens", async () => {
  const s = seeded;
  const clientB = dynamicClient(s.t);
  clientB.subject.current = B_SUBJECT;
  const { projects, documents } = releaseBackends(clientB);
  const session = { isLoading: false, isAuthenticated: true, signIn: async () => undefined, signOut: async () => undefined };

  // Dashboard: A's project never appears in B's list.
  window.location.hash = "#/projects";
  render(<Root session={session} backend={projects} documents={documents} />);
  await screen.findByRole("heading", { name: "Create your first project" });
  expect(screen.queryByText("A private notes")).toBeNull();
  expect(screen.queryByText("Pass the driving theory test")).toBeNull();
  cleanup();

  // Project detail: A's project is non-enumerating to B.
  window.location.hash = serializeRoute({ name: "project", id: s.projectId });
  render(<Root session={session} backend={projects} documents={documents} />);
  expect(await screen.findByText(/doesn’t exist or isn’t yours/)).toBeTruthy();
  expect(screen.queryByText("A private notes")).toBeNull();
  cleanup();

  // Documents: B's list load is denied; no filename or section leaks.
  window.location.hash = serializeRoute({ name: "documents", projectId: s.projectId });
  render(<Root session={session} backend={projects} documents={documents} />);
  expect(await screen.findByText(/Couldn’t load your documents/)).toBeTruthy();
  expect(screen.queryByText("lesson.md")).toBeNull();
  cleanup();

  // Conversation: B bound to A's project gets a typed history error and
  // never sees the transcript or the answer.
  const portsB = releaseVoicePorts(clientB);
  render(<SpokenConversation projectId={s.projectId} conversation={portsB.backend} capture={portsB.capture} playback={portsB.playback} />);
  expect(await screen.findByText(/conversation history could not be loaded/i)).toBeTruthy();
  expect(screen.queryByText(QUESTION)).toBeNull();
  expect(screen.queryByText((content) => content.includes("Plants turn light into chemical energy"))).toBeNull();
  expect(screen.queryAllByRole("link", { name: /^1\. / })).toHaveLength(0);
  cleanup();
}, 30_000);

/* ------------------------------------------------------------------ *
 * Surface: agent connection state
 * ------------------------------------------------------------------ */

test("agent surface: B cannot issue, revoke or revalidate A's connection state, and revoke-all spares A's token", async () => {
  const s = seeded;
  await expect(s.b.mutation(api.agentSessions.issueConnectionToken, { projectId: s.projectId })).rejects.toThrow("NOT_FOUND");
  await expect(s.b.mutation(api.agentSessions.revokeConnectionToken, { tokenId: s.tokenId as never })).rejects.toThrow("NOT_FOUND");
  await expect(s.b.mutation(api.agentSessions.revalidateConnectionToken, { token: s.token, rotate: false })).rejects.toThrow("CONNECTION_TOKEN_SCOPE");

  // B revoking everything only touches B's own rows: A's token still verifies.
  await s.b.mutation(api.agentSessions.revokeAllConnectionTokens, {});
  const verify = await s.t.fetch("/agent/connection-tokens/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: s.token }) });
  expect(verify.status).toBe(200);
  expect(((await verify.json()) as { ownerId: string }).ownerId).toBe("learner-a");

  // The handshake itself never accepts a forged token (token = credential;
  // hash-stored, TTL-bound, scope-checked when bound to a caller identity).
  const forged = await s.t.fetch("/agent/connection-tokens/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "0".repeat(64) }) });
  expect(forged.status).toBe(401);
  expect(((await forged.json()) as { code: string }).code).toBe("CONNECTION_TOKEN_INVALID");
}, 30_000);

/* ------------------------------------------------------------------ *
 * Surface: caches and telemetry
 * ------------------------------------------------------------------ */

type RateLimitBucketRow = { ownerId: string; bucket: string; windowStart: number; count: number; updatedAt: number };

test("cache/telemetry surface: denials write nothing for B, telemetry stays redacted and owner-scoped", async () => {
  const s = seeded;
  // Bucket snapshot taken before B's denials below: A's own authenticated
  // upload during seeding consumed her bucket, so "never A's bucket" has a
  // non-vacuous row to protect.
  const bucketsBefore = await allRows<RateLimitBucketRow>(s.t, "rateLimitBuckets");
  expect(bucketsBefore.filter((row) => row.ownerId === "learner-a").length).toBeGreaterThan(0);
  // B's denied attempts across surfaces (one per family) must not create
  // telemetry, must not spend A's rate-limit bucket, and must not create any
  // row keyed to A's project.
  const stt = await s.b.fetch(`/stt/transcribe?projectId=${encodeURIComponent(s.projectId)}&language=en&turnId=matrix-turn-1`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  expect(stt.status).toBe(404);
  await expect(s.b.query(api.tutor.getTranscript, { projectId: s.projectId })).rejects.toThrow("NOT_FOUND");

  const telemetry = await allRows<{ ownerId: string; projectId?: string; event?: string }>(s.t, "telemetryEvents");
  expect(telemetry.length).toBeGreaterThan(0); // A's own turn recorded rows
  expect(telemetry.filter((row) => row.ownerId === "learner-b")).toHaveLength(0);
  expect(telemetry.filter((row) => row.projectId === s.projectId).every((row) => row.ownerId === "learner-a")).toBe(true);

  // Redaction: no transcript or answer text ever reaches telemetry.
  const serialized = JSON.stringify(telemetry);
  expect(serialized).not.toContain(QUESTION);
  expect(serialized).not.toContain("Plants turn light");

  // Rate-limit buckets are owner-scoped (T4): every row is keyed to the learner
  // who consumed it and carries no project content, so B's denials are charged
  // only to B's own bucket — never A's, whose rows are byte-identical before and
  // after (B never got, and never spent, A's bucket).
  const buckets = await allRows<RateLimitBucketRow>(s.t, "rateLimitBuckets");
  expect(buckets.length).toBeGreaterThan(0);
  expect(buckets.every((row) => row.ownerId === "learner-a" || row.ownerId === "learner-b")).toBe(true);
  expect(buckets.every((row) => !("projectId" in row))).toBe(true);
  expect(buckets.filter((row) => row.ownerId === "learner-b").length).toBeGreaterThan(0);
  expect(buckets.filter((row) => row.ownerId === "learner-a")).toEqual(
    bucketsBefore.filter((row) => row.ownerId === "learner-a"),
  );

  // There is no public read surface for telemetry at all: the observability
  // module exports only internal functions and constants (source scan, the
  // same style as the no-getUrl scan in document-uploads.test.ts).
  const source = readFileSync(join(process.cwd(), "packages/api/convex/observability.ts"), "utf8");
  const publicFunctions = [...source.matchAll(/export const (\w+) = (query|mutation|action)\(/g)].map((match) => match[1]);
  expect(publicFunctions).toEqual([]);
  expect([...source.matchAll(/export const (\w+) = internal/g)].length).toBeGreaterThan(0);
}, 30_000);

/* ------------------------------------------------------------------ *
 * Surface: audio bytes
 * ------------------------------------------------------------------ */

test("audio surface: A can fetch her own tutor audio; B's identical request gets 404 and no provider bytes", async () => {
  const s = seeded;
  const synthPath = `/tts/synthesize?projectId=${encodeURIComponent(s.projectId)}&turnId=${encodeURIComponent(s.turnId)}`;

  const own = await s.a.fetch(synthPath, { method: "POST" });
  expect(own.status).toBe(200);
  expect(own.headers.get("content-type")).toBe("audio/mpeg");
  expect(own.headers.get("cache-control")).toBe("private, no-store");
  expect(own.headers.get("x-content-type-options")).toBe("nosniff");
  const bytes = new Uint8Array(await own.arrayBuffer());
  expect(bytes.length).toBeGreaterThan(0);
  expect(provider.counts.speech).toBe(1);

  const foreign = await s.b.fetch(synthPath, { method: "POST" });
  expect(foreign.status).toBe(404);
  expect(provider.counts.speech).toBe(1); // no synthesis happened for B

  // Client-level: the player's typed result for B is not-found, never bytes.
  const clientB = dynamicClient(s.t);
  clientB.subject.current = B_SUBJECT;
  const result = await requestTtsAudio({
    siteUrl: "",
    token: "synthetic-test-token",
    projectId: s.projectId,
    turnId: s.turnId,
    language: "en",
    voice: "af_heart",
    fetchImpl: (input, init) => clientB.fetch(input, init),
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a typed failure");
  expect(result.code).toBe("not-found");
}, 30_000);
