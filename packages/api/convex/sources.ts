import { ConvexError, v, type Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./projects";

/**
 * S22 citation source viewer: resolve one citation reference (document +
 * chunk, optionally the cited content hash) to readable source text, with
 * ACCESS CHECKED ON EVERY REQUEST. The contract deliberately mirrors the S13
 * retrieval classification so a citation means the same thing wherever it is
 * opened:
 *
 * - anonymous → typed `UNAUTHENTICATED`;
 * - a project the caller does not own (cross-project) → non-enumerating
 *   `NOT_FOUND`;
 * - a document id that is foreign or unknown → the same non-enumerating
 *   `NOT_FOUND` (S05/S08 convention: never reveal whether someone else's id
 *   exists), so the only documents that resolve are rows the caller owns;
 * - an owned but deleted document → `unavailable` with reason
 *   `document-deleted` (the deletion tombstone is what makes this
 *   distinguishable from a denied id, without exposing any content);
 * - an owned document whose chunk is gone (or not part of this document),
 *   is still processing/failed, or no longer matches the cited content hash
 *   → `unavailable` with the matching S13 reason (`chunk-deleted`,
 *   `document-not-ready`, `content-version-mismatch`) and locator metadata
 *   where it is still known — exactly S13's missing-source shape, never a
 *   broken result and never foreign text;
 * - otherwise → `ok` with the document's metadata, the focused chunk's text
 *   and locator (page / heading path), plus its bounded neighbours so the
 *   viewer can show context and move through the source.
 *
 * The response never carries storage ids, bearer URLs or file bytes: source
 * text comes from the caller's own `documentChunks` rows, and the original
 * bytes stay behind the authenticated `/private-files/:fileId` action.
 * Retrieval needs no provider here, and every read is scoped by the
 * `by_document_seq` index — there is no corpus-wide or cross-project path.
 */

/** Chunks shown before and after a cited chunk. */
export const NEIGHBOURS_AROUND = 3;
/** Chunks shown after the first chunk when a document is opened without a citation anchor. */
export const OVERVIEW_AHEAD = 5;

const unavailableReason = v.union(
  v.literal("document-deleted"),
  v.literal("chunk-deleted"),
  v.literal("document-not-ready"),
  v.literal("content-version-mismatch"),
);

const documentMeta = v.object({
  filename: v.string(),
  extension: v.string(),
  contentType: v.string(),
  sizeBytes: v.number(),
});

const focusChunk = v.object({
  chunkId: v.id("documentChunks"),
  seq: v.number(),
  page: v.union(v.null(), v.number()),
  heading: v.union(v.null(), v.string()),
  contentHash: v.string(),
  text: v.string(),
});

const contextChunk = v.object({
  chunkId: v.id("documentChunks"),
  seq: v.number(),
  page: v.union(v.null(), v.number()),
  heading: v.union(v.null(), v.string()),
  text: v.string(),
});

const sourceShape = v.object({ chunkId: v.union(v.null(), v.id("documentChunks")), seq: v.union(v.null(), v.number()), page: v.union(v.null(), v.number()), heading: v.union(v.null(), v.string()), contentHash: v.union(v.null(), v.string()) });

const citationSourceResult = v.union(
  v.object({
    status: v.literal("ok"),
    document: documentMeta,
    focus: focusChunk,
    before: v.array(contextChunk),
    after: v.array(contextChunk),
  }),
  v.object({
    status: v.literal("unavailable"),
    reason: unavailableReason,
    document: documentMeta,
    source: sourceShape,
  }),
);

type CitationSourceResult = Infer<typeof citationSourceResult>;

function documentMetaOf(document: Doc<"documents">) {
  return { filename: document.filename, extension: document.extension, contentType: document.contentType, sizeBytes: document.sizeBytes };
}

function toContext(chunk: Doc<"documentChunks">) {
  return { chunkId: chunk._id, seq: chunk.seq, page: chunk.locator.page, heading: chunk.locator.heading, text: chunk.text };
}

async function neighbourChunks(ctx: QueryCtx, documentId: Id<"documents">, seq: number): Promise<{ before: ReturnType<typeof toContext>[]; after: ReturnType<typeof toContext>[] }> {
  const rowsBefore = await ctx.db
    .query("documentChunks")
    .withIndex("by_document_seq", (q) => q.eq("documentId", documentId).lt("seq", seq))
    .order("desc")
    .take(NEIGHBOURS_AROUND);
  const rowsAfter = await ctx.db
    .query("documentChunks")
    .withIndex("by_document_seq", (q) => q.eq("documentId", documentId).gt("seq", seq))
    .order("asc")
    .take(NEIGHBOURS_AROUND);
  return { before: rowsBefore.reverse().map(toContext), after: rowsAfter.map(toContext) };
}

/**
 * Public citation source query. Order is deliberate: authentication, project
 * ownership, document ownership (non-enumerating for foreign/unknown ids),
 * tombstone, chunk resolution, cited-hash freshness, then readiness — so a
 * denied request can never be told apart from an id that does not exist, and
 * an owned deleted source always lands on the explicit unavailable state.
 */
export const getCitationSource = query({
  args: {
    projectId: v.id("projects"),
    documentId: v.id("documents"),
    chunkId: v.optional(v.id("documentChunks")),
    contentHash: v.optional(v.string()),
  },
  returns: citationSourceResult,
  handler: async (ctx, args): Promise<CitationSourceResult> => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const document = await ctx.db.get(args.documentId);
    if (document === null || document.ownerId !== ownerId || document.projectId !== args.projectId) throw new ConvexError({ code: "NOT_FOUND" });
    const meta = documentMetaOf(document);

    if (document.deletedAt !== undefined) {
      return { status: "unavailable", reason: "document-deleted", document: meta, source: { chunkId: null, seq: null, page: null, heading: null, contentHash: null } };
    }

    let focusId: Id<"documentChunks">;
    if (args.chunkId === undefined) {
      const first = await ctx.db.query("documentChunks").withIndex("by_document_seq", (q) => q.eq("documentId", args.documentId)).order("asc").first();
      if (first === null) return { status: "unavailable", reason: "chunk-deleted", document: meta, source: { chunkId: null, seq: null, page: null, heading: null, contentHash: null } };
      focusId = first._id;
    } else {
      focusId = args.chunkId;
    }

    const chunk = await ctx.db.get(focusId);
    if (chunk === null || chunk.ownerId !== ownerId || chunk.projectId !== args.projectId || chunk.documentId !== args.documentId) {
      // Unknown and foreign chunk ids answer identically: no content, no
      // locator, just the explicit unavailable state for this document.
      return { status: "unavailable", reason: "chunk-deleted", document: meta, source: { chunkId: args.chunkId ?? null, seq: null, page: null, heading: null, contentHash: null } };
    }
    const knownSource = { chunkId: chunk._id, seq: chunk.seq, page: chunk.locator.page, heading: chunk.locator.heading, contentHash: chunk.contentHash };

    if (args.contentHash !== undefined && args.contentHash !== chunk.contentHash) {
      return { status: "unavailable", reason: "content-version-mismatch", document: meta, source: knownSource };
    }
    if (document.status !== "ready") {
      return { status: "unavailable", reason: "document-not-ready", document: meta, source: knownSource };
    }

    // Overview (no citation anchor): start at the first chunk and read forward
    // so "open source" shows the top of the document rather than an arbitrary
    // middle. A cited chunk gets its bounded neighbours on both sides instead.
    if (args.chunkId === undefined) {
      const after = await ctx.db.query("documentChunks").withIndex("by_document_seq", (q) => q.eq("documentId", args.documentId).gt("seq", chunk.seq)).order("asc").take(OVERVIEW_AHEAD);
      return {
        status: "ok",
        document: meta,
        focus: { chunkId: chunk._id, seq: chunk.seq, page: chunk.locator.page, heading: chunk.locator.heading, contentHash: chunk.contentHash, text: chunk.text },
        before: [],
        after: after.map(toContext),
      };
    }

    const neighbours = await neighbourChunks(ctx, args.documentId, chunk.seq);
    return {
      status: "ok",
      document: meta,
      focus: { chunkId: chunk._id, seq: chunk.seq, page: chunk.locator.page, heading: chunk.locator.heading, contentHash: chunk.contentHash, text: chunk.text },
      before: neighbours.before,
      after: neighbours.after,
    };
  },
});
