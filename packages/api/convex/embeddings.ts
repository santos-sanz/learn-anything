import {
  NAN_EMBEDDING_DIMENSIONS,
  NAN_EMBEDDING_MAX_BATCH,
  NanClient,
  defaultNanQuotaControls,
  nanModels,
} from "@learn-anything/worker";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./projects";

/**
 * S12 project-scoped Convex vector search for qwen3-embedding.
 *
 * The full 4096-dimensional vector is stored as `v.array(v.float64())` — no
 * truncation, no provider substitution — and indexed with owner/project
 * filterFields, so retrieval itself is tenant-filtered before a single hit
 * comes back. `searchProjectVectors` then re-fetches every hit and rechecks
 * owner, project, chunk and content-version before anything is returned as
 * context (the S05 filter-and-recheck contract). Search is an action because
 * `ctx.vectorSearch` only exists on the action context.
 *
 * Billing note (Convex Free): each search is charged the FULL vector index
 * size in query-GB regardless of filters or how many results come back, so
 * owner/project filters protect scope, not per-tenant billing isolation.
 */

/** The only embedding model this deployment writes; NaN publishes it at 4096 dims. */
export const EMBEDDING_MODEL = nanModels.embedding;
export const EMBEDDING_DIMENSIONS = NAN_EMBEDDING_DIMENSIONS;

export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 50;

/**
 * The tenant conjunction stored on every row and used as the pre-retrieval
 * vector filter. Convex vector filters expose `q.eq`/`q.or` but no AND, so a
 * single equality over `ownerId:projectId` is what binds both fields in one
 * expression (see the schema comment on `chunkEmbeddings.scopeKey`).
 */
export const scopeKeyFor = (ownerId: string, projectId: Id<"projects">): string => `${ownerId}:${projectId}`;

const MODEL_VERSION_MAX = 128;

/** One surviving hit after the ownership/chunk/document recheck. */
type SearchHit = {
  chunkId: Id<"documentChunks">;
  documentId: Id<"documents">;
  seq: number;
  score: number;
  text: string;
  locator: { blockIndex: number; page: number | null; heading: string | null };
};

/**
 * Server-side NaN client for the ingestion embedding stage. Returns `null`
 * when the deployment has no key so the caller can fail the job visibly with
 * EMBEDDING_NOT_CONFIGURED instead of degrading to unsearchable documents.
 * The S11 single-user gate still applies: `learnerId` is the job's owner and
 * `NAN_DEPLOYER_ID` is the deployer, so a non-deployer's content is rejected
 * by `assertNanProviderPolicy` with NAN_POLICY_BLOCKED.
 */
export function embeddingClient(ownerId: string): NanClient | null {
  const apiKey = (process.env.NAN_API_KEY ?? "").trim();
  if (apiKey === "") return null;
  const deployerId = (process.env.NAN_DEPLOYER_ID ?? "").trim();
  return new NanClient({
    apiKey,
    deployment: {
      mode: "single-user-self-hosted",
      learnerId: ownerId,
      deployerId: deployerId === "" ? undefined : deployerId,
    },
  });
}

/**
 * Groups items into adapter-sized batches: NaN documents at most 32 inputs
 * per request and the adapter's shared input budget is 24,000 characters for
 * the joined request, so a batch never exceeds either. Batches are contiguous
 * slices in input order. A single chunk is always under the budget (the S10
 * chunk cap is 8,000 characters), so no chunk is ever split or dropped.
 */
export function embeddingBatches<T>(items: readonly T[], textOf: (item: T) => string): T[][] {
  const maxChars = defaultNanQuotaControls.maxInputCharacters;
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const text = textOf(item);
    if (current.length > 0 && (current.length + 1 > NAN_EMBEDDING_MAX_BATCH || chars + 1 + text.length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    chars += (current.length === 0 ? 0 : 1) + text.length;
    current.push(item);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Rejects a vector that is not exactly one finite 4096-wide row of floats. */
function assertEmbeddingVector(vector: number[], chunkId: Id<"documentChunks"> | null): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new ConvexError({
      code: "EMBEDDING_DIMENSION_MISMATCH",
      expected: EMBEDDING_DIMENSIONS,
      actual: vector.length,
      ...(chunkId === null ? {} : { chunkId }),
    });
  }
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) {
      throw new ConvexError({ code: "EMBEDDING_MALFORMED", at: index, ...(chunkId === null ? {} : { chunkId }) });
    }
  }
}

const searchResult = v.object({
  chunkId: v.id("documentChunks"),
  documentId: v.id("documents"),
  seq: v.number(),
  score: v.number(),
  text: v.string(),
  locator: v.object({
    blockIndex: v.number(),
    page: v.union(v.null(), v.number()),
    heading: v.union(v.null(), v.string()),
  }),
});

/**
 * Ownership gate for the action: runs before any retrieval so a foreign or
 * deleted project is a non-enumerating NOT_FOUND without touching the index.
 */
export const authorizeSearchScope = internalQuery({
  args: { ownerId: v.string(), projectId: v.id("projects") },
  returns: v.object({ ownerId: v.string(), projectId: v.id("projects") }),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.ownerId, args.projectId);
    return { ownerId: args.ownerId, projectId: args.projectId };
  },
});

/**
 * Storage half of the embedding call path: commits one batch of provider
 * vectors for the CURRENT content version of one document. Everything is
 * validated before a single row is written:
 *
 * - scope: the job and document must match the claimed owner/project and the
 *   job must still be running under the same content version;
 * - model: rows carry the configured model id, and a different model is an
 *   EMBEDDING_MODEL_MISMATCH (no silent provider substitution);
 * - dimension: every vector is exactly 4096 finite floats, otherwise
 *   EMBEDDING_DIMENSION_MISMATCH / EMBEDDING_MALFORMED — vectors are stored
 *   whole or not at all, never truncated to fit;
 * - chunk: each target chunk must exist inside this document at this content
 *   version, so a stale or foreign chunk id is a non-enumerating NOT_FOUND.
 *
 * Upserts are keyed by chunkId, so a retried job re-commits identical rows
 * instead of duplicating them. Old-version rows are swept by the bounded
 * `sweepStaleEmbeddings` loop right after `commitChunks`; `recheckSearchHits`
 * still drops any stale row that survives an interrupted run.
 */
export const commitEmbeddings = internalMutation({
  args: {
    jobId: v.id("ingestionJobs"),
    documentId: v.id("documents"),
    ownerId: v.string(),
    projectId: v.id("projects"),
    contentVersionKey: v.string(),
    model: v.string(),
    modelVersion: v.string(),
    vectors: v.array(v.object({ chunkId: v.id("documentChunks"), vector: v.array(v.float64()) })),
  },
  returns: v.object({ stored: v.number() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.ownerId !== args.ownerId || job.projectId !== args.projectId || job.documentId !== args.documentId) {
      throw new ConvexError({ code: "NOT_FOUND" });
    }
    if (job.status !== "running") throw new ConvexError({ code: "JOB_NOT_RUNNING" });
    if (job.contentVersionKey !== undefined && job.contentVersionKey !== args.contentVersionKey) {
      throw new ConvexError({ code: "CONTENT_VERSION_CONFLICT" });
    }
    const document = await ctx.db.get(args.documentId);
    if (document === null || document.ownerId !== args.ownerId || document.projectId !== args.projectId) {
      throw new ConvexError({ code: "NOT_FOUND" });
    }
    if (args.model !== EMBEDDING_MODEL) throw new ConvexError({ code: "EMBEDDING_MODEL_MISMATCH", expected: EMBEDDING_MODEL, actual: args.model });
    if (args.modelVersion.trim() === "" || args.modelVersion.length > MODEL_VERSION_MAX) throw new ConvexError({ code: "INVALID_ARGUMENT" });

    for (const entry of args.vectors) assertEmbeddingVector(entry.vector, entry.chunkId);
    const chunks = new Map<Id<"documentChunks">, Doc<"documentChunks">>();
    for (const entry of args.vectors) {
      const chunk = await ctx.db.get(entry.chunkId);
      if (
        chunk === null ||
        chunk.ownerId !== args.ownerId ||
        chunk.projectId !== args.projectId ||
        chunk.documentId !== args.documentId ||
        chunk.contentVersionKey !== args.contentVersionKey
      ) {
        throw new ConvexError({ code: "NOT_FOUND" });
      }
      chunks.set(entry.chunkId, chunk);
    }

    const now = Date.now();
    for (const entry of args.vectors) {
      const chunk = chunks.get(entry.chunkId);
      if (chunk === undefined) throw new ConvexError({ code: "NOT_FOUND" });
      const row = {
        embedding: entry.vector,
        model: args.model,
        modelVersion: args.modelVersion,
        dimensions: EMBEDDING_DIMENSIONS,
        embeddedAt: now,
      };
      const existing = await ctx.db.query("chunkEmbeddings").withIndex("by_chunk", (q) => q.eq("chunkId", entry.chunkId)).unique();
      if (existing !== null) {
        await ctx.db.patch(existing._id, row);
      } else {
        await ctx.db.insert("chunkEmbeddings", {
          ownerId: args.ownerId,
          projectId: args.projectId,
          scopeKey: scopeKeyFor(args.ownerId, args.projectId),
          documentId: args.documentId,
          chunkId: entry.chunkId,
          contentVersionKey: args.contentVersionKey,
          seq: chunk.seq,
          ...row,
        });
      }
    }
    return { stored: args.vectors.length };
  },
});

/**
 * The recheck half of the filter-and-recheck contract. A hit only survives
 * if the stored row still belongs to the authenticated owner and project AND
 * its chunk and document still exist in that same scope at the same content
 * version. Rows that fail any check are dropped, never returned as context —
 * this is what makes an orphaned, retargeted or stale vector harmless even
 * if it somehow remained in the index.
 */
export const recheckSearchHits = internalQuery({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    hits: v.array(v.object({ embeddingId: v.id("chunkEmbeddings"), score: v.number() })),
  },
  returns: v.array(searchResult),
  handler: async (ctx, args) => {
    const results: SearchHit[] = [];
    for (const hit of args.hits) {
      const decoded = await decodeHit(ctx, hit, args.ownerId, args.projectId);
      if (decoded !== null) results.push(decoded);
    }
    return results;
  },
});

async function decodeHit(
  ctx: QueryCtx,
  hit: { embeddingId: Id<"chunkEmbeddings">; score: number },
  ownerId: string,
  projectId: Id<"projects">,
): Promise<SearchHit | null> {
  const row: Doc<"chunkEmbeddings"> | null = await ctx.db.get(hit.embeddingId);
  if (row === null || row.ownerId !== ownerId || row.projectId !== projectId) return null;
  const chunk: Doc<"documentChunks"> | null = await ctx.db.get(row.chunkId);
  if (
    chunk === null ||
    chunk.ownerId !== ownerId ||
    chunk.projectId !== projectId ||
    chunk.documentId !== row.documentId ||
    chunk.contentVersionKey !== row.contentVersionKey
  ) {
    return null;
  }
  const document: Doc<"documents"> | null = await ctx.db.get(row.documentId);
  if (document === null || document.ownerId !== ownerId || document.projectId !== projectId) return null;
  return {
    chunkId: row.chunkId,
    documentId: row.documentId,
    seq: row.seq,
    score: hit.score,
    text: chunk.text,
    locator: { blockIndex: chunk.locator.blockIndex, page: chunk.locator.page, heading: chunk.locator.heading },
  };
}

/**
 * Public vector search. Order is deliberate and test-locked:
 * 1. authentication (UNAUTHENTICATED without an identity),
 * 2. project ownership (NOT_FOUND for a foreign or deleted project — before
 *    any retrieval),
 * 3. query-vector validation (wrong width or non-finite values never reach
 *    the index),
 * 4. retrieval with the tenant conjunction applied as an index-level filter,
 * 5. per-hit ownership recheck before any row is returned as context.
 *
 * The pre-retrieval filter is one equality on `scopeKey`, the
 * server-derived `ownerId:projectId` string: Convex vector filter expressions
 * expose only `q.eq` and `q.or` (no AND combinator in the pinned SDK or the
 * published guide), so a single equality over both fields is what makes the
 * filter bind owner AND project before retrieval. `ownerId` and `projectId`
 * remain declared filterFields and are enforced again per hit by
 * `recheckSearchHits`, so a foreign vector is never returned even if it were
 * somehow reachable.
 *
 * Filters and rechecks protect tenant scope only: Convex bills each search
 * the full index size in query-GB regardless of either.
 */
export const searchProjectVectors = action({
  args: {
    projectId: v.id("projects"),
    vector: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  returns: v.array(searchResult),
  handler: async (ctx: ActionCtx, args): Promise<SearchHit[]> => {
    const ownerId = await requireUserId(ctx);
    await ctx.runQuery(internal.embeddings.authorizeSearchScope, { ownerId, projectId: args.projectId });
    assertQueryVector(args.vector);
    const limit = resolveLimit(args.limit);
    const hits = await ctx.vectorSearch("chunkEmbeddings", "by_embedding", {
      vector: args.vector,
      limit,
      filter: (q) => q.eq("scopeKey", scopeKeyFor(ownerId, args.projectId)),
    });
    if (hits.length === 0) return [];
    return await ctx.runQuery(internal.embeddings.recheckSearchHits, {
      ownerId,
      projectId: args.projectId,
      hits: hits.map((hit) => ({ embeddingId: hit._id, score: hit._score })),
    });
  },
});

function assertQueryVector(vector: number[]): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new ConvexError({ code: "VECTOR_DIMENSION_INVALID", expected: EMBEDDING_DIMENSIONS, actual: vector.length });
  }
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) throw new ConvexError({ code: "VECTOR_MALFORMED", at: index });
  }
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return SEARCH_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return limit;
}
