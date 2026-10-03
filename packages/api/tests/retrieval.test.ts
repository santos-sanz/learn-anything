import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import { scopeKeyFor } from "../convex/embeddings.js";
import schema from "../convex/schema.js";
import { goldCorpus, goldQuestions } from "./fixtures/retrieval-gold.js";
import { installAuthTestEnv } from "./helpers/authEnv.js";
import { termVector } from "./helpers/textVectors.js";

// Deployment variables are synthetic for offline tests; no value is a secret.
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/embeddings.ts": () => import("../convex/embeddings.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
  "../convex/retrieval.ts": () => import("../convex/retrieval.js"),
};

const makeTest = () => convexTest({ schema, modules });
type TestInstance = ReturnType<typeof makeTest>;

const identity = (subject: string) => ({ subject, issuer: "https://test.example" });

const VERSION_KEY = "seed:v1";
const originalFetch = globalThis.fetch;

/** Recorded NaN `/rerank` calls; any other provider URL fails the test loudly. */
type RerankCall = { url: string; query: string; documents: string[] };
let providerCalls: RerankCall[] = [];
let providerResponder: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

beforeEach(() => {
  providerCalls = [];
  providerResponder = null;
  process.env.NAN_API_KEY = "synthetic-test-key";
  process.env.NAN_DEPLOYER_ID = "learner-a";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/rerank")) throw new Error(`offline retrieval test attempted an unexpected provider call: ${url}`);
    const body = JSON.parse(String(init?.body)) as { query?: string; documents?: string[] };
    providerCalls.push({ url, query: body.query ?? "", documents: body.documents ?? [] });
    if (providerResponder === null) throw new Error("retrieval test hit /rerank without an installed responder");
    return providerResponder(url, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NAN_API_KEY;
  delete process.env.NAN_DEPLOYER_ID;
  delete process.env.RETRIEVAL_MIN_SCORE;
});

type RerankInfo = { requested: boolean; applied: boolean; reason: string | null };
type MissingSource = {
  documentId: string;
  chunkId: string;
  seq: number;
  reason: string;
  contentHash: string | null;
  page: number | null;
  heading: string | null;
};
type Citation = {
  rank: number;
  documentId: string;
  chunkId: string;
  seq: number;
  contentHash: string;
  page: number | null;
  heading: string | null;
  score: number;
  relevanceScore: number | null;
  inContext: boolean;
};
type Diagnostics = { candidates: number; minScore: number; bestScore: number | null };
type OkResult = {
  status: "ok";
  citations: Citation[];
  missingSources: MissingSource[];
  context: {
    segments: Array<{ documentId: string; chunkId: string; chars: number; estimatedTokens: number; text: string }>;
    chars: number;
    estimatedTokens: number;
  };
  rerank: RerankInfo;
  diagnostics: Diagnostics;
};
type InsufficientResult = {
  status: "insufficient-evidence";
  reason: string;
  missingSources: MissingSource[];
  rerank: RerankInfo;
  diagnostics: Diagnostics;
};
type RetrievalOutcome = OkResult | InsufficientResult;

const ok = (result: RetrievalOutcome): OkResult => {
  expect(result.status).toBe("ok");
  return result as OkResult;
};

const insufficient = (result: RetrievalOutcome, reason: string): InsufficientResult => {
  expect(result.status).toBe("insufficient-evidence");
  expect((result as InsufficientResult).reason).toBe(reason);
  return result as InsufficientResult;
};

type ChunkSeed = { text: string; page?: number | null; heading?: string | null; vector?: number[] };
type DocumentSeed = { filename: string; chunks: ChunkSeed[] };
type SeededProject = {
  ownerId: string;
  projectId: string;
  documents: Array<{ documentId: string; chunkIds: string[] }>;
};

/**
 * Seeds one owned project with documents, running jobs and chunk rows, then
 * stores the vectors through the production `commitEmbeddings` mutation (so
 * S12 storage validation runs too). Vectors default to the deterministic
 * synthetic `termVector` of the chunk text.
 */
async function seedProject(t: TestInstance, ownerId: string, name: string, documents: DocumentSeed[]): Promise<SeededProject> {
  const projectId = (await t.run(async (ctx) =>
    ctx.db.insert("projects", { ownerId, name, createdAt: Date.now(), deletedAt: null }),
  )) as string;
  const seeded: Array<{ documentId: string; chunkIds: string[] }> = [];
  for (let docIndex = 0; docIndex < documents.length; docIndex += 1) {
    const seed = documents[docIndex];
    const ids = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob([seed.filename], { type: "text/plain" }));
      const privateFileId = await ctx.db.insert("privateFiles", {
        ownerId,
        projectId: projectId as never,
        storageId,
        contentType: "text/plain",
        createdAt: Date.now(),
      });
      const documentId = await ctx.db.insert("documents", {
        ownerId,
        projectId: projectId as never,
        privateFileId,
        storageId,
        filename: seed.filename,
        extension: "md",
        contentType: "text/markdown",
        sizeBytes: seed.filename.length,
        status: "ready",
        failureCode: null,
        idempotencyKey: `seed-${ownerId}-${projectId}-${docIndex}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const jobId = await ctx.db.insert("ingestionJobs", {
        ownerId,
        projectId: projectId as never,
        documentId,
        status: "running",
        attempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        contentVersionKey: VERSION_KEY,
      });
      const chunkIds: string[] = [];
      for (let seq = 0; seq < seed.chunks.length; seq += 1) {
        const chunk = seed.chunks[seq];
        chunkIds.push(
          (await ctx.db.insert("documentChunks", {
            ownerId,
            projectId: projectId as never,
            documentId,
            contentVersionKey: VERSION_KEY,
            seq,
            chunkKey: `${VERSION_KEY}#${seq}`,
            text: chunk.text,
            contentHash: `hash-${docIndex}-${seq}`,
            locator: { blockIndex: seq, page: chunk.page ?? null, heading: chunk.heading ?? null },
            createdAt: Date.now(),
          })) as string,
        );
      }
      return { documentId: documentId as string, jobId, chunkIds };
    });
    if (seed.chunks.length > 0) {
      await t.mutation(internal.embeddings.commitEmbeddings, {
        jobId: ids.jobId as never,
        documentId: ids.documentId as never,
        ownerId,
        projectId: projectId as never,
        contentVersionKey: VERSION_KEY,
        model: "qwen3-embedding",
        modelVersion: "qwen3-embedding",
        vectors: seed.chunks.map((chunk, seq) => ({
          chunkId: ids.chunkIds[seq] as never,
          vector: chunk.vector ?? termVector(chunk.text),
        })),
      });
    }
    seeded.push(ids);
  }
  return { ownerId, projectId, documents: seeded };
}

async function retrieve(t: TestInstance, subject: string | null, args: Record<string, unknown>): Promise<RetrievalOutcome> {
  const caller = subject === null ? t : t.withIdentity(identity(subject));
  return (await caller.action(api.retrieval.retrieveProjectContext, args as never)) as RetrievalOutcome;
}

/** Sparse unit-like vector: explicit (index, value) pairs over a zero row. */
function vec(terms: Array<[number, number]>, dimensions = 4096): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const [index, value] of terms) vector[index] = value;
  return vector;
}

const embeddingRows = (t: TestInstance, ownerId: string, projectId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query("chunkEmbeddings")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId as never))
      .collect(),
  );

/** Four chunks with strictly decreasing similarity to `vec([[0, 1]])`: 1, ~0.707, ~0.447, ~0.316. */
const fourRankedChunks = (): ChunkSeed[] => [
  { text: "Alpha chunk about photosynthesis and sunlight.", vector: vec([[0, 1]]) },
  { text: "Beta chunk about photosynthesis and sunlight.", vector: vec([[0, 1], [1, 1]]) },
  { text: "Gamma chunk about photosynthesis and sunlight.", vector: vec([[0, 1], [2, 1]]) },
  { text: "Delta chunk about photosynthesis and sunlight.", vector: vec([[0, 1], [3, 1]]) },
];

test("returns stable citation identifiers with page, heading path and content hash", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Biology", [
    {
      filename: "notes.md",
      chunks: [
        { text: "Photosynthesis converts sunlight into chemical energy stored in glucose.", heading: "Biology > Plants" },
        { text: "Mitochondria release energy from glucose during cellular respiration.", heading: "Biology > Cells" },
        { text: "The Peace of Westphalia treaty ended the Thirty Years War in 1648.", page: 7 },
      ],
    },
  ]);

  const result = ok(
    await retrieve(t, "learner-a", {
      projectId: project.projectId,
      query: "How does photosynthesis convert sunlight into chemical energy?",
      vector: termVector("How does photosynthesis convert sunlight into chemical energy?"),
    }),
  );

  expect(result.citations.map((citation) => citation.chunkId)).toEqual(project.documents[0].chunkIds);
  const [first, second, third] = result.citations;
  expect(first.rank).toBe(1);
  expect(first.documentId).toBe(project.documents[0].documentId);
  expect(first.contentHash).toBe("hash-0-0");
  expect(first.heading).toBe("Biology > Plants");
  expect(first.page).toBeNull();
  expect(first.inContext).toBe(true);
  expect(first.relevanceScore).toBeNull();
  expect(second.heading).toBe("Biology > Cells");
  expect(third.page).toBe(7);
  expect(third.heading).toBeNull();
  expect(result.context.segments.map((segment) => segment.chunkId)).toEqual(project.documents[0].chunkIds);
  expect(result.context.segments[0].text).toBe("Photosynthesis converts sunlight into chemical energy stored in glucose.");
  expect(result.context.chars).toBeLessThanOrEqual(6000);
  expect(result.context.estimatedTokens).toBe(
    result.context.segments.reduce((total, segment) => total + segment.estimatedTokens, 0),
  );
  expect(result.missingSources).toEqual([]);
  expect(result.rerank).toEqual({ requested: false, applied: false, reason: "not-requested" });
  expect(result.diagnostics.minScore).toBe(0);
  expect(result.diagnostics.bestScore).toBeGreaterThan(0);
  expect(result.diagnostics.candidates).toBe(3);
});

test("two-user isolation: anonymous, foreign and crafted-scope requests never see another learner's retrieval", async () => {
  const t = makeTest();
  const a = await seedProject(t, "learner-a", "A", [
    {
      filename: "a.md",
      chunks: [
        { text: "Alpha secret chunk about photosynthesis.", vector: vec([[0, 1]]) },
        { text: "Beta secret chunk about photosynthesis.", vector: vec([[0, 1], [1, 1]]) },
      ],
    },
  ]);
  const b = await seedProject(t, "learner-b", "B", [
    {
      filename: "b.md",
      chunks: [
        { text: "Gamma secret chunk about photosynthesis.", vector: vec([[0, 1]]) },
        { text: "Delta secret chunk about photosynthesis.", vector: vec([[0, 1], [1, 1]]) },
      ],
    },
  ]);
  const query = { query: "photosynthesis", vector: vec([[0, 1]]), topK: 8 };

  await expect(retrieve(t, null, { projectId: a.projectId, ...query })).rejects.toThrow("UNAUTHENTICATED");
  await expect(retrieve(t, "learner-b", { projectId: a.projectId, ...query })).rejects.toThrow("NOT_FOUND");

  // Crafted scope arguments are not part of the contract: identity and scope
  // are derived server-side, so a request carrying them is rejected outright.
  await expect(
    retrieve(t, "learner-b", {
      projectId: b.projectId,
      ...query,
      ownerId: "learner-a",
      scopeKey: scopeKeyFor("learner-a", a.projectId as never),
    }),
  ).rejects.toThrow(/Unexpected field/);

  // Forged rows: B's first row re-scoped into A's filter (victim scopeKey) and
  // A's own first row with a foreign ownerId are dropped by the ownership
  // recheck — they appear neither as citations nor as reported missing sources.
  const bRows = await embeddingRows(t, "learner-b", b.projectId);
  await t.run(async (ctx) => ctx.db.patch(bRows[0]._id, { scopeKey: scopeKeyFor("learner-a", a.projectId as never) }));
  const aRows = await embeddingRows(t, "learner-a", a.projectId);
  await t.run(async (ctx) => ctx.db.patch(aRows[0]._id, { ownerId: "intruder" }));

  const fromA = await retrieve(t, "learner-a", { projectId: a.projectId, ...query });
  expect(fromA.status).toBe("ok");
  expect(fromA.missingSources).toEqual([]);
  const reportedIds = [...(fromA.status === "ok" ? fromA.citations : []), ...fromA.missingSources].map((entry) => entry.chunkId);
  expect(reportedIds).toEqual([a.documents[0].chunkIds[1]]);
  expect(reportedIds).not.toContain(aRows[0].chunkId);
  expect(reportedIds).not.toContain(bRows[0].chunkId);

  // The forged row is unreachable from B's own project as well: its scopeKey
  // no longer matches B's filter, and nothing in A's result reports it.
  const fromB = await retrieve(t, "learner-b", { projectId: b.projectId, ...query });
  expect(fromB.status).toBe("ok");
  expect(fromB.missingSources).toEqual([]);
  expect((fromB.status === "ok" ? fromB.citations : []).map((citation) => citation.chunkId)).toEqual([
    b.documents[0].chunkIds[1],
  ]);

  // A soft-deleted project is unreachable for its own owner too.
  await t.withIdentity(identity("learner-a")).mutation(api.projects.requestProjectDeletion, { projectId: a.projectId as never });
  await expect(retrieve(t, "learner-a", { projectId: a.projectId, ...query })).rejects.toThrow("NOT_FOUND");
});

test("two-project isolation: one project's chunks are never reachable from a sibling project", async () => {
  const t = makeTest();
  const shared: ChunkSeed[] = [
    { text: "Photosynthesis converts sunlight into chemical energy stored in glucose.", vector: vec([[0, 1]]) },
    { text: "The Peace of Westphalia treaty ended the Thirty Years War.", vector: vec([[0, 1], [1, 1]]) },
  ];
  const one = await seedProject(t, "learner-a", "One", [{ filename: "notes.md", chunks: shared }]);
  const two = await seedProject(t, "learner-a", "Two", [{ filename: "notes.md", chunks: shared }]);
  const query = { query: "photosynthesis", vector: vec([[0, 1]]), topK: 8 };

  const fromTwo = ok(await retrieve(t, "learner-a", { projectId: two.projectId, ...query }));
  expect(fromTwo.citations).toHaveLength(2);
  expect(fromTwo.citations.every((citation) => citation.documentId === two.documents[0].documentId)).toBe(true);
  expect(fromTwo.citations.some((citation) => one.documents[0].chunkIds.includes(citation.chunkId))).toBe(false);

  const fromOne = ok(await retrieve(t, "learner-a", { projectId: one.projectId, ...query }));
  expect(fromOne.citations.every((citation) => citation.documentId === one.documents[0].documentId)).toBe(true);
  expect(fromOne.citations.some((citation) => two.documents[0].chunkIds.includes(citation.chunkId))).toBe(false);

  // Forging project One's row into project Two's filter scope (victim
  // scopeKey) cannot widen Two's retrieval: the authoritative projectId
  // recheck drops it, and it is not reported as a missing source either.
  const oneRows = await embeddingRows(t, "learner-a", one.projectId);
  await t.run(async (ctx) =>
    ctx.db.patch(oneRows[0]._id, { scopeKey: scopeKeyFor("learner-a", two.projectId as never) }),
  );
  const fromTwoAgain = ok(await retrieve(t, "learner-a", { projectId: two.projectId, ...query }));
  expect(fromTwoAgain.citations.map((citation) => citation.chunkId)).not.toContain(oneRows[0].chunkId);
  expect(fromTwoAgain.missingSources).toEqual([]);
  expect(fromTwoAgain.citations).toHaveLength(2);

  // After the forgery, Project One's own search simply misses that row (the
  // filter no longer matches); its sibling row still retrieves normally.
  const fromOneAgain = ok(await retrieve(t, "learner-a", { projectId: one.projectId, ...query }));
  expect(fromOneAgain.citations.map((citation) => citation.chunkId)).toEqual([one.documents[0].chunkIds[1]]);
});

test("gold-question fixtures rank the gold chunk first, ahead of the distractors", async () => {
  const t = makeTest();
  const chunkIds = new Map<string, string>();
  const projectIds = new Map<string, string>();

  for (const project of goldCorpus) {
    const seeded = await seedProject(
      t,
      "learner-a",
      project.name,
      project.documents.map((document) => ({ filename: document.filename, chunks: document.chunks.map((text) => ({ text })) })),
    );
    projectIds.set(project.name, seeded.projectId);
    for (let docIndex = 0; docIndex < project.documents.length; docIndex += 1) {
      project.documents[docIndex].chunks.forEach((text, seq) => {
        chunkIds.set(`${project.name}/${project.documents[docIndex].filename}/${text}`, seeded.documents[docIndex].chunkIds[seq]);
      });
    }
  }

  for (const gold of goldQuestions) {
    const fixtureChunks = goldCorpus
      .find((project) => project.name === gold.project)
      ?.documents.reduce((total, document) => total + document.chunks.length, 0);
    const result = ok(
      await retrieve(t, "learner-a", {
        projectId: projectIds.get(gold.project),
        query: gold.question,
        vector: termVector(gold.question),
        topK: 3,
      }),
    );
    // The corpus must outgrow top-k, otherwise "found in top-k" would hold
    // for any ranking. All fixture chunks are seeded, so the candidate count
    // mirrors the fixture; a shrink back to top-k-sized corpora fails here.
    expect(fixtureChunks, `fixture corpus for ${gold.project} must exist`).toBeGreaterThan(3);
    expect(result.diagnostics.candidates, `all ${gold.project} chunks must be candidates`).toBe(fixtureChunks);
    const expected = chunkIds.get(`${gold.project}/${gold.document}/${gold.chunk}`);
    expect(expected, `fixture map must contain ${gold.id}`).toBeDefined();
    const citation = result.citations.find((entry) => entry.chunkId === expected);
    expect(citation, `gold chunk for ${gold.id} must be retrieved within top-k`).toBeDefined();
    // Discriminating contract: the gold chunk must beat every distractor and
    // rank exactly first. With a corpus larger than top-k, any relevance
    // regression that demotes the gold chunk below a distractor — or pushes it
    // out of the slice entirely — fails this assertion instead of hiding
    // inside a top-k that covers the whole corpus.
    expect(citation?.rank, `gold chunk for ${gold.id} must rank 1 ahead of the distractors`).toBe(1);
  }
});

test("an empty corpus returns an explicit insufficient-evidence result without any provider call", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Empty", []);

  const result = insufficient(
    await retrieve(t, "learner-a", { projectId: project.projectId, query: "anything", vector: vec([[0, 1]]) }),
    "EMPTY_CORPUS",
  );
  expect(result.missingSources).toEqual([]);
  expect(result.diagnostics).toEqual({ candidates: 0, minScore: 0, bestScore: null });

  const withRerank = insufficient(
    await retrieve(t, "learner-a", { projectId: project.projectId, query: "anything", vector: vec([[0, 1]]), rerank: true }),
    "EMPTY_CORPUS",
  );
  expect(withRerank.rerank).toEqual({ requested: true, applied: false, reason: "not-attempted" });
  expect(providerCalls).toHaveLength(0);
});

test("low-confidence matches return an explicit insufficient-evidence result", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Weak", [
    { filename: "w.md", chunks: [{ text: "Unrelated text about gardening and soil.", vector: vec([[0, 1]]) }] },
  ]);
  const base = { projectId: project.projectId, query: "photosynthesis" };

  // Default threshold: a query orthogonal to every candidate scores 0 and is
  // not evidence.
  const orthogonal = insufficient(await retrieve(t, "learner-a", { ...base, vector: vec([[5, 0]]) }), "LOW_CONFIDENCE");
  expect(orthogonal.diagnostics.bestScore).toBeCloseTo(0, 10);
  expect(orthogonal.diagnostics.minScore).toBe(0);

  // Explicit threshold above the real similarity (1/sqrt(2) ~ 0.707).
  const raised = insufficient(
    await retrieve(t, "learner-a", { ...base, vector: vec([[0, 1], [1, 1]]), minScore: 0.95 }),
    "LOW_CONFIDENCE",
  );
  expect(raised.diagnostics.bestScore).toBeCloseTo(1 / Math.SQRT2, 5);
  expect(raised.diagnostics.minScore).toBe(0.95);

  // Control: the same inputs pass a threshold they clear.
  const accepted = ok(await retrieve(t, "learner-a", { ...base, vector: vec([[0, 1], [1, 1]]), minScore: 0.5 }));
  expect(accepted.citations).toHaveLength(1);

  // Deployment-level override without a code change; malformed values are ignored.
  process.env.RETRIEVAL_MIN_SCORE = "0.99";
  const configured = insufficient(await retrieve(t, "learner-a", { ...base, vector: vec([[0, 1], [1, 1]]) }), "LOW_CONFIDENCE");
  expect(configured.diagnostics.minScore).toBe(0.99);
  process.env.RETRIEVAL_MIN_SCORE = "not-a-number";
  const fallback = ok(await retrieve(t, "learner-a", { ...base, vector: vec([[0, 1], [1, 1]]) }));
  expect(fallback.diagnostics.minScore).toBe(0);
});

test("a deleted chunk is reported as a missing source, not dropped or hallucinated", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Docs", [
    { filename: "d.md", chunks: [{ text: "Alpha chunk.", vector: vec([[0, 1]]) }, { text: "Beta chunk.", vector: vec([[0, 1], [1, 1]]) }] },
  ]);
  const deleted = project.documents[0].chunkIds[1];
  await t.run(async (ctx) => ctx.db.delete(deleted as never));

  const result = ok(
    await retrieve(t, "learner-a", { projectId: project.projectId, query: "alpha", vector: vec([[0, 1]]) }),
  );
  expect(result.citations.map((citation) => citation.chunkId)).toEqual([project.documents[0].chunkIds[0]]);
  expect(result.missingSources).toEqual([
    {
      documentId: project.documents[0].documentId,
      chunkId: deleted,
      seq: 1,
      reason: "chunk-deleted",
      contentHash: null,
      page: null,
      heading: null,
    },
  ]);
});

test("a deleted or not-ready document is reported as a missing source", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Docs", [
    {
      filename: "gone.md",
      chunks: [
        { text: "Alpha chunk about photosynthesis.", page: 3, heading: "Plants", vector: vec([[0, 1]]) },
        { text: "Beta chunk about photosynthesis.", vector: vec([[0, 1], [1, 1]]) },
      ],
    },
    { filename: "kept.md", chunks: [{ text: "Gamma chunk about photosynthesis.", vector: vec([[0, 1]]) }] },
  ]);
  const [gone, kept] = project.documents;

  // A pending (not yet ready) document is not citable; its chunks are
  // reported as missing sources rather than silently skipped.
  await t.run(async (ctx) => ctx.db.patch(gone.documentId as never, { status: "pending" }));
  const pending = ok(await retrieve(t, "learner-a", { projectId: project.projectId, query: "photosynthesis", vector: vec([[0, 1]]) }));
  expect(pending.citations.map((citation) => citation.chunkId)).toEqual(kept.chunkIds);
  expect(pending.missingSources.map((source) => source.reason)).toEqual(["document-not-ready", "document-not-ready"]);
  expect(pending.missingSources[0]).toMatchObject({
    documentId: gone.documentId,
    chunkId: gone.chunkIds[0],
    contentHash: "hash-0-0",
    page: 3,
    heading: "Plants",
  });

  // Deleting the document reports the same chunks as deleted sources, with
  // the identifiers that are still known and no text.
  await t.run(async (ctx) => ctx.db.delete(gone.documentId as never));
  const afterDelete = ok(await retrieve(t, "learner-a", { projectId: project.projectId, query: "photosynthesis", vector: vec([[0, 1]]) }));
  expect(afterDelete.citations.map((citation) => citation.chunkId)).toEqual(kept.chunkIds);
  expect(afterDelete.missingSources).toEqual([
    {
      documentId: gone.documentId,
      chunkId: gone.chunkIds[0],
      seq: 0,
      reason: "document-deleted",
      contentHash: "hash-0-0",
      page: 3,
      heading: "Plants",
    },
    {
      documentId: gone.documentId,
      chunkId: gone.chunkIds[1],
      seq: 1,
      reason: "document-deleted",
      contentHash: "hash-0-1",
      page: null,
      heading: null,
    },
  ]);
  expect(afterDelete.context.segments.map((segment) => segment.chunkId)).toEqual(kept.chunkIds);
});

test("a superseded content version is reported as a missing source", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Docs", [
    { filename: "d.md", chunks: [{ text: "Alpha chunk.", vector: vec([[0, 1]]) }, { text: "Beta chunk.", vector: vec([[0, 1], [1, 1]]) }] },
  ]);
  const rows = await embeddingRows(t, "learner-a", project.projectId);
  const stale = rows.find((row) => row.chunkId === project.documents[0].chunkIds[1]);
  expect(stale).toBeDefined();
  if (stale === undefined) throw new Error("expected a stale row");
  await t.run(async (ctx) => ctx.db.patch(stale._id, { contentVersionKey: "superseded:v0" }));

  const result = ok(await retrieve(t, "learner-a", { projectId: project.projectId, query: "alpha", vector: vec([[0, 1]]) }));
  expect(result.citations.map((citation) => citation.chunkId)).toEqual([project.documents[0].chunkIds[0]]);
  expect(result.missingSources).toEqual([
    {
      documentId: project.documents[0].documentId,
      chunkId: project.documents[0].chunkIds[1],
      seq: 1,
      reason: "content-version-mismatch",
      contentHash: "hash-0-1",
      page: null,
      heading: null,
    },
  ]);
});

test("when every source has vanished the result is explicit insufficient evidence that still reports them", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Gone", [
    { filename: "d.md", chunks: [{ text: "Alpha chunk.", vector: vec([[0, 1]]) }] },
  ]);
  await t.run(async (ctx) => ctx.db.delete(project.documents[0].chunkIds[0] as never));

  const result = insufficient(
    await retrieve(t, "learner-a", { projectId: project.projectId, query: "alpha", vector: vec([[0, 1]]) }),
    "NO_CANDIDATES",
  );
  expect(result.diagnostics).toMatchObject({ candidates: 1, bestScore: null });
  expect(result.missingSources).toHaveLength(1);
  expect(result.missingSources[0].reason).toBe("chunk-deleted");
});

test("a row whose ownership failed the recheck is dropped without leaking its identifiers", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Tampered", [
    { filename: "d.md", chunks: [{ text: "Alpha chunk.", vector: vec([[0, 1]]) }] },
  ]);
  const rows = await embeddingRows(t, "learner-a", project.projectId);
  await t.run(async (ctx) => ctx.db.patch(rows[0]._id, { ownerId: "intruder" }));

  // The scopeKey still matches the filter, so the index returns the row and
  // only the authoritative recheck can drop it: nothing about the foreign
  // row — ids included — appears in the explicit insufficient-evidence result.
  const result = insufficient(
    await retrieve(t, "learner-a", { projectId: project.projectId, query: "alpha", vector: vec([[0, 1]]) }),
    "NO_CANDIDATES",
  );
  expect(result.missingSources).toEqual([]);
  expect(result.diagnostics).toMatchObject({ candidates: 1, bestScore: null });
  expect(JSON.stringify(result)).not.toContain(rows[0].chunkId);
});

test("same input twice returns identical ordering, ids and context", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Determinism", [{ filename: "d.md", chunks: fourRankedChunks() }]);
  const base = { projectId: project.projectId, query: "photosynthesis", vector: vec([[0, 1]]), topK: 4 };

  const first = await retrieve(t, "learner-a", base);
  const second = await retrieve(t, "learner-a", base);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  expect(ok(first).citations.map((citation) => citation.chunkId)).toEqual(project.documents[0].chunkIds);

  // Budget-constrained runs are deterministic too.
  const budgeted = { ...base, maxContextChars: 1_200 };
  const budgetFirst = await retrieve(t, "learner-a", budgeted);
  const budgetSecond = await retrieve(t, "learner-a", budgeted);
  expect(JSON.stringify(budgetSecond)).toBe(JSON.stringify(budgetFirst));

  // And so is a deterministic rerank fallback (provider not configured).
  delete process.env.NAN_API_KEY;
  const rerankArgs = { ...base, rerank: true };
  const rerankFirst = await retrieve(t, "learner-a", rerankArgs);
  const rerankSecond = await retrieve(t, "learner-a", rerankArgs);
  expect(JSON.stringify(rerankSecond)).toBe(JSON.stringify(rerankFirst));
  expect(ok(rerankFirst).rerank).toEqual({ requested: true, applied: false, reason: "not-configured" });
});

test("the context budget bounds both characters and estimated tokens deterministically", async () => {
  const t = makeTest();
  const pad = (seed: string, length: number) => seed.padEnd(length, ".");
  const project = await seedProject(t, "learner-a", "Budget", [
    {
      filename: "d.md",
      chunks: [
        { text: pad("Alpha chunk.", 500), vector: vec([[0, 1]]) },
        { text: pad("Beta chunk.", 500), vector: vec([[0, 1], [1, 1]]) },
        { text: pad("Gamma chunk.", 500), vector: vec([[0, 1], [2, 1]]) },
        { text: pad("Delta chunk.", 500), vector: vec([[0, 1], [3, 1]]) },
      ],
    },
  ]);
  const base = { projectId: project.projectId, query: "photosynthesis", vector: vec([[0, 1]]), topK: 4 };

  const byChars = ok(await retrieve(t, "learner-a", { ...base, maxContextChars: 1_200 }));
  expect(byChars.context.chars).toBe(1_000);
  expect(byChars.context.chars).toBeLessThanOrEqual(1_200);
  expect(byChars.context.estimatedTokens).toBe(250);
  expect(byChars.context.segments).toHaveLength(2);
  expect(byChars.citations.map((citation) => citation.inContext)).toEqual([true, true, false, false]);
  expect(byChars.citations.map((citation) => citation.rank)).toEqual([1, 2, 3, 4]);
  // Budget-omitted candidates stay citable (ids and rank) without text.
  expect(byChars.citations[2].chunkId).toBe(project.documents[0].chunkIds[2]);

  const byTokens = ok(await retrieve(t, "learner-a", { ...base, maxContextTokens: 130 }));
  expect(byTokens.context.estimatedTokens).toBe(125);
  expect(byTokens.context.segments).toHaveLength(1);
  expect(byTokens.context.chars).toBe(500);
  expect(byTokens.citations.map((citation) => citation.inContext)).toEqual([true, false, false, false]);

  const exhausted = insufficient(
    await retrieve(t, "learner-a", { ...base, maxContextChars: 10 }),
    "CONTEXT_BUDGET_EXHAUSTED",
  );
  expect(exhausted.missingSources).toEqual([]);
  expect(exhausted.diagnostics.bestScore).toBeCloseTo(1, 5);
  expect(exhausted.rerank).toEqual({ requested: false, applied: false, reason: "not-requested" });
});

test("the optional rerank step reorders candidates through the mocked NaN endpoint", async () => {
  providerResponder = async () =>
    Response.json({
      results: [
        { index: 2, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
        { index: 0, relevance_score: 0.1 },
      ],
    });
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Rerank", [{ filename: "d.md", chunks: fourRankedChunks() }]);
  const args = {
    projectId: project.projectId,
    query: "Which chunk talks about the sun?",
    vector: vec([[0, 1]]),
    topK: 4,
    rerank: true,
  };

  const result = ok(await retrieve(t, "learner-a", args));
  expect(result.rerank).toEqual({ requested: true, applied: true, reason: null });
  expect(result.citations.map((citation) => citation.chunkId)).toEqual([
    project.documents[0].chunkIds[2],
    project.documents[0].chunkIds[1],
    project.documents[0].chunkIds[0],
    project.documents[0].chunkIds[3],
  ]);
  expect(result.citations.map((citation) => citation.relevanceScore)).toEqual([0.9, 0.5, 0.1, null]);
  expect(result.citations.map((citation) => citation.rank)).toEqual([1, 2, 3, 4]);
  expect(providerCalls).toHaveLength(1);
  expect(providerCalls[0].query).toBe(args.query);
  expect(providerCalls[0].documents).toHaveLength(4);

  // Determinism: the same mocked provider payload reproduces the same order.
  const again = ok(await retrieve(t, "learner-a", args));
  expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  expect(providerCalls).toHaveLength(2);
});

test("rerank failures and provider limits fall back to similarity order with a visible reason", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Fallback", [{ filename: "d.md", chunks: fourRankedChunks() }]);
  const similarityOrder = project.documents[0].chunkIds;
  const base = { projectId: project.projectId, query: "photosynthesis", vector: vec([[0, 1]]), topK: 4, rerank: true };
  const expectFallback = async (reason: string, expectedCalls: number) => {
    const result = ok(await retrieve(t, "learner-a", base));
    expect(result.rerank).toEqual({ requested: true, applied: false, reason });
    expect(result.citations.map((citation) => citation.chunkId)).toEqual(similarityOrder);
    expect(result.citations.every((citation) => citation.relevanceScore === null)).toBe(true);
    expect(providerCalls).toHaveLength(expectedCalls);
  };

  // 1. No provider key: retrieval itself never needs one.
  delete process.env.NAN_API_KEY;
  await expectFallback("not-configured", 0);
  process.env.NAN_API_KEY = "synthetic-test-key";

  // 2. Transport failure.
  providerResponder = async () => {
    throw new TypeError("network down");
  };
  await expectFallback("provider-error", 1);

  // 3. Rate limit with Retry-After stays visible, no silent retry.
  providerResponder = async () => new Response("slow", { status: 429, headers: { "Retry-After": "7" } });
  await expectFallback("rate-limited", 2);

  // 4. Malformed provider payloads.
  providerResponder = async () => Response.json({ results: "not-an-array" });
  await expectFallback("malformed-response", 3);
  providerResponder = async () => Response.json({ results: [{ index: 99, relevance_score: 1 }] });
  await expectFallback("malformed-response", 4);

  // 5. A personal key may not serve a learner who is not the deployer.
  const other = await seedProject(t, "learner-b", "Other", [
    { filename: "o.md", chunks: [{ text: "Alpha chunk.", vector: vec([[0, 1]]) }, { text: "Beta chunk.", vector: vec([[0, 1], [1, 1]]) }] },
  ]);
  const policy = ok(
    await retrieve(t, "learner-b", {
      projectId: other.projectId,
      query: "photosynthesis",
      vector: vec([[0, 1]]),
      topK: 4,
      rerank: true,
    }),
  );
  expect(policy.rerank).toEqual({ requested: true, applied: false, reason: "policy-blocked" });
  expect(providerCalls).toHaveLength(4);

  // 6. The documented 24,000-character input quota is visible and costs no request.
  const bulky = await seedProject(t, "learner-a", "Bulky", [
    {
      filename: "big.md",
      chunks: [
        { text: "x".repeat(8_000), vector: vec([[0, 1]]) },
        { text: "y".repeat(8_000), vector: vec([[0, 1], [1, 1]]) },
        { text: "z".repeat(8_000), vector: vec([[0, 1], [2, 1]]) },
      ],
    },
  ]);
  const tooLarge = ok(
    await retrieve(t, "learner-a", {
      projectId: bulky.projectId,
      query: "q".repeat(4_000),
      vector: vec([[0, 1]]),
      topK: 4,
      rerank: true,
      maxContextChars: 24_000,
    }),
  );
  expect(tooLarge.rerank).toEqual({ requested: true, applied: false, reason: "input-too-large" });
  expect(tooLarge.citations.map((citation) => citation.chunkId)).toEqual(bulky.documents[0].chunkIds);
  expect(providerCalls).toHaveLength(4);

  // 7. A single candidate never costs a provider request.
  const single = await seedProject(t, "learner-a", "Single", [
    { filename: "s.md", chunks: [{ text: "Alpha chunk.", vector: vec([[0, 1]]) }] },
  ]);
  const one = ok(
    await retrieve(t, "learner-a", {
      projectId: single.projectId,
      query: "photosynthesis",
      vector: vec([[0, 1]]),
      topK: 4,
      rerank: true,
    }),
  );
  expect(one.rerank).toEqual({ requested: true, applied: false, reason: "single-candidate" });
  expect(providerCalls).toHaveLength(4);
});

test("retrieval validates top-k, query and budget arguments after authorization", async () => {
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "Args", [
    { filename: "d.md", chunks: [{ text: "Alpha chunk.", vector: vec([[0, 1]]) }] },
  ]);
  const base = { projectId: project.projectId, query: "photosynthesis", vector: vec([[0, 1]]) };
  const owner = t.withIdentity(identity("learner-a"));

  for (const topK of [0, -1, 51, 1.5]) {
    await expect(owner.action(api.retrieval.retrieveProjectContext, { ...base, topK } as never)).rejects.toThrow(
      "INVALID_ARGUMENT",
    );
  }
  for (const query of ["", "   ", "x".repeat(4_001)]) {
    await expect(owner.action(api.retrieval.retrieveProjectContext, { ...base, query } as never)).rejects.toThrow(
      "INVALID_ARGUMENT",
    );
  }
  for (const maxContextChars of [0, -10, 24_001, 2.5]) {
    await expect(
      owner.action(api.retrieval.retrieveProjectContext, { ...base, maxContextChars } as never),
    ).rejects.toThrow("INVALID_ARGUMENT");
  }
  for (const maxContextTokens of [0, 6_001, 3.5]) {
    await expect(
      owner.action(api.retrieval.retrieveProjectContext, { ...base, maxContextTokens } as never),
    ).rejects.toThrow("INVALID_ARGUMENT");
  }
  await expect(owner.action(api.retrieval.retrieveProjectContext, { ...base, minScore: Number.NaN } as never)).rejects.toThrow(
    "INVALID_ARGUMENT",
  );

  // The query vector keeps the S12 width contract.
  await expect(
    owner.action(api.retrieval.retrieveProjectContext, { ...base, vector: vec([[0, 1]], 2048) } as never),
  ).rejects.toThrow("VECTOR_DIMENSION_INVALID");

  // Nothing above reached the index or the provider.
  expect(providerCalls).toHaveLength(0);
});

test("retrieval succeeds with no provider key and makes no network calls", async () => {
  delete process.env.NAN_API_KEY;
  const t = makeTest();
  const project = await seedProject(t, "learner-a", "NoKey", [
    { filename: "d.md", chunks: [{ text: "Alpha chunk about photosynthesis.", vector: vec([[0, 1]]) }] },
  ]);

  const plain = ok(
    await retrieve(t, "learner-a", { projectId: project.projectId, query: "photosynthesis", vector: vec([[0, 1]]) }),
  );
  expect(plain.citations).toHaveLength(1);
  const withRerank = ok(
    await retrieve(t, "learner-a", {
      projectId: project.projectId,
      query: "photosynthesis",
      vector: vec([[0, 1]]),
      rerank: true,
    }),
  );
  expect(withRerank.rerank).toEqual({ requested: true, applied: false, reason: "not-configured" });
  expect(providerCalls).toHaveLength(0);
});
