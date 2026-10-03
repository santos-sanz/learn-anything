import { resolveRerankOrder, type RerankFallbackReason } from "@learn-anything/worker";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalQuery, type ActionCtx } from "./_generated/server";
import { assertQueryVector, embeddingClient, scopeKeyFor, SEARCH_LIMIT_MAX } from "./embeddings";
import { requireUserId } from "./projects";

/**
 * S13 scoped retrieval: bounded, citable context for exactly one owned
 * project, with an optional deterministic NaN rerank step.
 *
 * ## Filter-vs-recheck contract (what the platform does vs what we enforce)
 *
 * What the platform filters: `ctx.vectorSearch` runs with a single `q.eq` on
 * the server-derived `scopeKey = "ownerId:projectId"` — the only expression
 * that binds owner AND project in one predicate, because Convex vector filter
 * expressions expose `q.eq`/`q.or` and no AND combinator. The candidate rows
 * the index can return are therefore already constrained to this tenant pair
 * before a single hit comes back; `ownerId`/`projectId` stay declared
 * `filterFields` so the conjunction remains expressible field by field.
 *
 * What we enforce on top (authoritative, per hit, in `classifyRetrievalHits`):
 * every surviving row is re-fetched and must still belong to the
 * authenticated owner AND the requested project, its chunk and document must
 * still exist in that same scope, the chunk must still match the row's
 * document and content version, and the document must still be `ready`. A row
 * that fails any ownership check is dropped without appearing anywhere in the
 * result — a citation is never built from a row the filter did not constrain
 * and the recheck did not confirm. Sources that pass ownership but have
 * vanished (deleted chunk/document, superseded content version, not-ready
 * document) are reported explicitly as `missingSources` instead of being
 * silently dropped or hallucinated.
 *
 * ## Determinism
 *
 * Fixed inputs give fixed outputs: candidates are re-sorted by score
 * (descending, ties by chunk id ascending), the optional rerank reorders the
 * top-k pool through the pure `resolveRerankOrder` decision over the S11
 * adapter (fallback = original similarity order with a typed reason), and the
 * context budget packs whole chunks greedily in that order. No timestamps,
 * randomness or provider-substituted ordering enter the result.
 *
 * ## Insufficient evidence
 *
 * An empty corpus, a candidate set that loses every source, a best score at
 * or below `minScore`, or a budget too small for even the top chunk return a
 * typed `insufficient-evidence` result instead of a plausible-sounding empty
 * context.
 *
 * Retrieval itself never needs a provider: the caller supplies the 4096-wide
 * query vector (the S12 embedding contract) and rerank is optional with a
 * documented fallback. Each call bills one vector search — the full index
 * size in query-GB regardless of filters or result count (Convex Free quota).
 */

/** Default/maximum number of citations returned (before the char/token budget trims context). */
export const RETRIEVAL_TOP_K_DEFAULT = 8;
export const RETRIEVAL_TOP_K_MAX = 50;
/** Candidates fetched per requested citation: overfetch so rechecks and budget skips cannot empty the selection. */
export const CANDIDATE_OVERFETCH = 4;
/** Context budget defaults; the hard maximum stays below NaN's 24,000-character input quota. */
export const CONTEXT_CHARS_DEFAULT = 6_000;
export const CONTEXT_CHARS_MAX = 24_000;
/** Deterministic token estimate used by the budget: one token per four characters, rounded up per chunk. */
export const CHARS_PER_TOKEN = 4;
/** A candidate must score strictly above this to count as evidence (override per call or with RETRIEVAL_MIN_SCORE). */
export const MIN_SCORE_DEFAULT = 0;
export const QUERY_MAX_CHARS = 4_000;

type MissingReason = "chunk-deleted" | "document-deleted" | "document-not-ready" | "content-version-mismatch";
type InsufficientReason = "EMPTY_CORPUS" | "NO_CANDIDATES" | "LOW_CONFIDENCE" | "CONTEXT_BUDGET_EXHAUSTED";
type RerankReason = "not-requested" | "not-attempted" | RerankFallbackReason;

type AvailableHit = {
  chunkId: Id<"documentChunks">;
  documentId: Id<"documents">;
  seq: number;
  score: number;
  contentHash: string;
  page: number | null;
  heading: string | null;
  text: string;
};

type RankedHit = AvailableHit & { relevanceScore: number | null };

type MissingSource = {
  documentId: Id<"documents">;
  chunkId: Id<"documentChunks">;
  seq: number;
  reason: MissingReason;
  contentHash: string | null;
  page: number | null;
  heading: string | null;
};

type Citation = {
  rank: number;
  documentId: Id<"documents">;
  chunkId: Id<"documentChunks">;
  seq: number;
  contentHash: string;
  page: number | null;
  heading: string | null;
  score: number;
  relevanceScore: number | null;
  inContext: boolean;
};

type ContextSegment = {
  documentId: Id<"documents">;
  chunkId: Id<"documentChunks">;
  chars: number;
  estimatedTokens: number;
  text: string;
};

type RerankInfo = { requested: boolean; applied: boolean; reason: RerankReason | null };
type Diagnostics = { candidates: number; minScore: number; bestScore: number | null };

type InsufficientEvidenceResult = {
  status: "insufficient-evidence";
  reason: InsufficientReason;
  missingSources: MissingSource[];
  rerank: RerankInfo;
  diagnostics: Diagnostics;
};

type OkRetrievalResult = {
  status: "ok";
  citations: Citation[];
  missingSources: MissingSource[];
  context: { segments: ContextSegment[]; chars: number; estimatedTokens: number };
  rerank: RerankInfo;
  diagnostics: Diagnostics;
};

type RetrievalResult = InsufficientEvidenceResult | OkRetrievalResult;

const missingReason = v.union(
  v.literal("chunk-deleted"),
  v.literal("document-deleted"),
  v.literal("document-not-ready"),
  v.literal("content-version-mismatch"),
);

const missingSourceValidator = v.object({
  documentId: v.id("documents"),
  chunkId: v.id("documentChunks"),
  seq: v.number(),
  reason: missingReason,
  contentHash: v.union(v.null(), v.string()),
  page: v.union(v.null(), v.number()),
  heading: v.union(v.null(), v.string()),
});

const rerankReasonValidator = v.union(
  v.literal("not-requested"),
  v.literal("not-attempted"),
  v.literal("not-configured"),
  v.literal("single-candidate"),
  v.literal("input-too-large"),
  v.literal("policy-blocked"),
  v.literal("rate-limited"),
  v.literal("timeout"),
  v.literal("cancelled"),
  v.literal("unsupported"),
  v.literal("malformed-response"),
  v.literal("provider-error"),
);

const rerankValidator = v.object({
  requested: v.boolean(),
  applied: v.boolean(),
  reason: v.union(v.null(), rerankReasonValidator),
});

const diagnosticsValidator = v.object({
  candidates: v.number(),
  minScore: v.number(),
  bestScore: v.union(v.null(), v.number()),
});

const availableValidator = v.object({
  chunkId: v.id("documentChunks"),
  documentId: v.id("documents"),
  seq: v.number(),
  score: v.number(),
  contentHash: v.string(),
  page: v.union(v.null(), v.number()),
  heading: v.union(v.null(), v.string()),
  text: v.string(),
});

const retrievalResultValidator = v.union(
  v.object({
    status: v.literal("insufficient-evidence"),
    reason: v.union(
      v.literal("EMPTY_CORPUS"),
      v.literal("NO_CANDIDATES"),
      v.literal("LOW_CONFIDENCE"),
      v.literal("CONTEXT_BUDGET_EXHAUSTED"),
    ),
    missingSources: v.array(missingSourceValidator),
    rerank: rerankValidator,
    diagnostics: diagnosticsValidator,
  }),
  v.object({
    status: v.literal("ok"),
    citations: v.array(
      v.object({
        rank: v.number(),
        documentId: v.id("documents"),
        chunkId: v.id("documentChunks"),
        seq: v.number(),
        contentHash: v.string(),
        page: v.union(v.null(), v.number()),
        heading: v.union(v.null(), v.string()),
        score: v.number(),
        relevanceScore: v.union(v.null(), v.number()),
        inContext: v.boolean(),
      }),
    ),
    missingSources: v.array(missingSourceValidator),
    context: v.object({
      segments: v.array(
        v.object({
          documentId: v.id("documents"),
          chunkId: v.id("documentChunks"),
          chars: v.number(),
          estimatedTokens: v.number(),
          text: v.string(),
        }),
      ),
      chars: v.number(),
      estimatedTokens: v.number(),
    }),
    rerank: rerankValidator,
    diagnostics: diagnosticsValidator,
  }),
);

/**
 * Per-hit classification half of the S13 contract (runs as a query so every
 * row is re-fetched under the authenticated scope):
 *
 * - ownership failure (embedding row, chunk or document not owned by this
 *   owner/project, or chunk/document ids that disagree with each other) →
 *   dropped: it is a scope violation, never a citation and never a "missing"
 *   report, because even its identifiers must not leak;
 * - ownership holds but the source is unusable (chunk deleted, document
 *   deleted, document not `ready`, or the row's content version no longer
 *   matches the chunk) → reported as a `missingSources` entry with the
 *   identifiers that are still known and no text;
 * - otherwise → available, with the stable citation metadata (ids, seq,
 *   content hash, page, heading path) and the chunk text for the context
 *   budget.
 */
export const classifyRetrievalHits = internalQuery({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    hits: v.array(v.object({ embeddingId: v.id("chunkEmbeddings"), score: v.number() })),
  },
  returns: v.object({ available: v.array(availableValidator), missing: v.array(missingSourceValidator) }),
  handler: async (ctx, args): Promise<{ available: AvailableHit[]; missing: MissingSource[] }> => {
    const available: AvailableHit[] = [];
    const missing: MissingSource[] = [];
    for (const hit of args.hits) {
      const row = await ctx.db.get(hit.embeddingId);
      if (row === null) continue;
      if (row.ownerId !== args.ownerId || row.projectId !== args.projectId) continue;
      const chunk = await ctx.db.get(row.chunkId);
      if (chunk === null) {
        missing.push({
          documentId: row.documentId,
          chunkId: row.chunkId,
          seq: row.seq,
          reason: "chunk-deleted",
          contentHash: null,
          page: null,
          heading: null,
        });
        continue;
      }
      if (chunk.ownerId !== args.ownerId || chunk.projectId !== args.projectId || chunk.documentId !== row.documentId) continue;
      if (chunk.contentVersionKey !== row.contentVersionKey) {
        missing.push({
          documentId: row.documentId,
          chunkId: row.chunkId,
          seq: row.seq,
          reason: "content-version-mismatch",
          contentHash: chunk.contentHash,
          page: chunk.locator.page,
          heading: chunk.locator.heading,
        });
        continue;
      }
      const document = await ctx.db.get(row.documentId);
      if (document === null) {
        missing.push({
          documentId: row.documentId,
          chunkId: row.chunkId,
          seq: row.seq,
          reason: "document-deleted",
          contentHash: chunk.contentHash,
          page: chunk.locator.page,
          heading: chunk.locator.heading,
        });
        continue;
      }
      if (document.ownerId !== args.ownerId || document.projectId !== args.projectId) continue;
      if (document.status !== "ready") {
        missing.push({
          documentId: row.documentId,
          chunkId: row.chunkId,
          seq: row.seq,
          reason: "document-not-ready",
          contentHash: chunk.contentHash,
          page: chunk.locator.page,
          heading: chunk.locator.heading,
        });
        continue;
      }
      available.push({
        chunkId: chunk._id,
        documentId: document._id,
        seq: chunk.seq,
        score: hit.score,
        contentHash: chunk.contentHash,
        page: chunk.locator.page,
        heading: chunk.locator.heading,
        text: chunk.text,
      });
    }
    return { available, missing };
  },
});

/**
 * Public retrieval action. Order is deliberate and test-locked:
 * 1. authentication (UNAUTHENTICATED without an identity),
 * 2. project ownership (NOT_FOUND for a foreign or deleted project — before
 *    any retrieval),
 * 3. argument validation (query width/top-k/budget/minScore),
 * 4. retrieval with the tenant conjunction applied as an index-level filter,
 * 5. per-hit ownership recheck and source classification,
 * 6. explicit insufficient-evidence decisions,
 * 7. the optional deterministic rerank step,
 * 8. top-k selection and greedy context-budget packing.
 *
 * The caller supplies the embedded query vector (`vector`, 4096 finite
 * floats) because retrieval itself must work without a live provider; NaN is
 * only contacted for the optional rerank step, and every way that step can
 * fail or be unavailable falls back to the original similarity order with a
 * visible reason — never another provider, never randomness.
 */
export const retrieveProjectContext = action({
  args: {
    projectId: v.id("projects"),
    query: v.string(),
    vector: v.array(v.float64()),
    topK: v.optional(v.number()),
    rerank: v.optional(v.boolean()),
    minScore: v.optional(v.number()),
    maxContextChars: v.optional(v.number()),
    maxContextTokens: v.optional(v.number()),
  },
  returns: retrievalResultValidator,
  handler: async (ctx: ActionCtx, args): Promise<RetrievalResult> => {
    const ownerId = await requireUserId(ctx);
    await ctx.runQuery(internal.embeddings.authorizeSearchScope, { ownerId, projectId: args.projectId });
    assertQueryVector(args.vector);
    const query = resolveQuery(args.query);
    const topK = resolveTopK(args.topK);
    const minScore = resolveMinScore(args.minScore);
    const budget = resolveContextBudget(args.maxContextChars, args.maxContextTokens);
    const rerankRequested = args.rerank ?? false;
    const notAttempted: RerankInfo = {
      requested: rerankRequested,
      applied: false,
      reason: rerankRequested ? "not-attempted" : "not-requested",
    };

    const candidateLimit = Math.min(Math.max(topK * CANDIDATE_OVERFETCH, 1), SEARCH_LIMIT_MAX);
    const hits = await ctx.vectorSearch("chunkEmbeddings", "by_embedding", {
      vector: args.vector,
      limit: candidateLimit,
      filter: (q) => q.eq("scopeKey", scopeKeyFor(ownerId, args.projectId)),
    });
    if (hits.length === 0) {
      return {
        status: "insufficient-evidence",
        reason: "EMPTY_CORPUS",
        missingSources: [],
        rerank: notAttempted,
        diagnostics: { candidates: 0, minScore, bestScore: null },
      };
    }

    const classified = await ctx.runQuery(internal.retrieval.classifyRetrievalHits, {
      ownerId,
      projectId: args.projectId,
      hits: hits.map((hit) => ({ embeddingId: hit._id, score: hit._score })),
    });
    const missingSources = [...classified.missing].sort(byChunkId);
    if (classified.available.length === 0) {
      return {
        status: "insufficient-evidence",
        reason: "NO_CANDIDATES",
        missingSources,
        rerank: notAttempted,
        diagnostics: { candidates: hits.length, minScore, bestScore: null },
      };
    }

    const ordered: RankedHit[] = classified.available
      .map((hit) => ({ ...hit, relevanceScore: null }))
      .sort(byScoreThenChunkId);
    const bestScore = ordered[0].score;
    if (bestScore <= minScore) {
      return {
        status: "insufficient-evidence",
        reason: "LOW_CONFIDENCE",
        missingSources,
        rerank: notAttempted,
        diagnostics: { candidates: hits.length, minScore, bestScore },
      };
    }

    // The rerank pool is exactly the top-k candidates in similarity order:
    // candidates ranked below top-k are never citable, so rerank reorders the
    // citation set rather than promoting out-of-scope rows into it. If the
    // joined pool exceeds NaN's documented 24,000-character input quota the
    // step falls back visibly with `input-too-large` instead of silently
    // dropping documents from the request.
    const selected: RankedHit[] = ordered.slice(0, topK);
    let rerank: RerankInfo = notAttempted;
    if (rerankRequested) {
      // The shared S11 single-user-gated NaN client (same construction as the
      // S12 embedding stage): `null` when the deployment has no key, which the
      // adapter turns into the visible `not-configured` fallback.
      const client = embeddingClient(ownerId);
      const outcome = await resolveRerankOrder(
        query,
        selected.map((hit) => hit.text),
        client === null ? null : (rerankQuery, documents) => client.rerank(rerankQuery, documents),
      );
      if (outcome.applied) {
        const reranked = outcome.order.map((index, position) => ({ ...selected[index], relevanceScore: outcome.scores[position] }));
        selected.splice(0, selected.length, ...reranked);
        rerank = { requested: true, applied: true, reason: null };
      } else {
        rerank = { requested: true, applied: false, reason: outcome.reason };
      }
    }

    const citations: Citation[] = [];
    const segments: ContextSegment[] = [];
    let chars = 0;
    let estimatedTokens = 0;
    for (let index = 0; index < selected.length; index += 1) {
      const hit = selected[index];
      const segmentChars = hit.text.length;
      const segmentTokens = Math.ceil(segmentChars / CHARS_PER_TOKEN);
      const inContext = chars + segmentChars <= budget.chars && estimatedTokens + segmentTokens <= budget.tokens;
      citations.push({
        rank: index + 1,
        documentId: hit.documentId,
        chunkId: hit.chunkId,
        seq: hit.seq,
        contentHash: hit.contentHash,
        page: hit.page,
        heading: hit.heading,
        score: hit.score,
        relevanceScore: hit.relevanceScore,
        inContext,
      });
      if (inContext) {
        segments.push({
          documentId: hit.documentId,
          chunkId: hit.chunkId,
          chars: segmentChars,
          estimatedTokens: segmentTokens,
          text: hit.text,
        });
        chars += segmentChars;
        estimatedTokens += segmentTokens;
      }
    }

    if (segments.length === 0) {
      return {
        status: "insufficient-evidence",
        reason: "CONTEXT_BUDGET_EXHAUSTED",
        missingSources,
        rerank,
        diagnostics: { candidates: hits.length, minScore, bestScore },
      };
    }

    return {
      status: "ok",
      citations,
      missingSources,
      context: { segments, chars, estimatedTokens },
      rerank,
      diagnostics: { candidates: hits.length, minScore, bestScore },
    };
  },
});

/** Candidates first by similarity score (descending), then by stable chunk id so equal scores cannot reorder. */
function byScoreThenChunkId(left: RankedHit, right: RankedHit): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0;
}

function byChunkId(left: MissingSource, right: MissingSource): number {
  return left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0;
}

function resolveQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed === "" || query.length > QUERY_MAX_CHARS) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return trimmed;
}

function resolveTopK(topK: number | undefined): number {
  if (topK === undefined) return RETRIEVAL_TOP_K_DEFAULT;
  if (!Number.isInteger(topK) || topK < 1 || topK > RETRIEVAL_TOP_K_MAX) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return topK;
}

/**
 * The confidence gate. Explicit values must be finite; an unset value reads
 * the `RETRIEVAL_MIN_SCORE` deployment variable (malformed values fall back
 * to the default, never trusted) so operators can calibrate the threshold to
 * the platform's measured score scale without a code change.
 */
function resolveMinScore(minScore: number | undefined): number {
  if (minScore !== undefined) {
    if (!Number.isFinite(minScore)) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    return minScore;
  }
  const configured = (process.env.RETRIEVAL_MIN_SCORE ?? "").trim();
  if (configured !== "") {
    const parsed = Number(configured);
    if (Number.isFinite(parsed)) return parsed;
  }
  return MIN_SCORE_DEFAULT;
}

function resolveContextBudget(chars: number | undefined, tokens: number | undefined): { chars: number; tokens: number } {
  const resolvedChars = chars ?? CONTEXT_CHARS_DEFAULT;
  if (!Number.isInteger(resolvedChars) || resolvedChars < 1 || resolvedChars > CONTEXT_CHARS_MAX) {
    throw new ConvexError({ code: "INVALID_ARGUMENT" });
  }
  const resolvedTokens = tokens ?? Math.ceil(resolvedChars / CHARS_PER_TOKEN);
  const maxTokens = Math.ceil(CONTEXT_CHARS_MAX / CHARS_PER_TOKEN);
  if (!Number.isInteger(resolvedTokens) || resolvedTokens < 1 || resolvedTokens > maxTokens) {
    throw new ConvexError({ code: "INVALID_ARGUMENT" });
  }
  return { chars: resolvedChars, tokens: resolvedTokens };
}
