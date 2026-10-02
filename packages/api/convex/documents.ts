import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./projects";

/** Product upload cap (README/ADR-0002), below the 20 MiB Convex HTTP ceiling. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_UPLOAD_BYTES = MAX_UPLOAD_BYTES;

const FILENAME_MAX_LENGTH = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};

function contentTypeForExtension(extension: string): string | null {
  return EXTENSION_CONTENT_TYPES[extension] ?? null;
}

/**
 * Reads the configurable deployment limit. A missing, malformed or non-positive
 * value falls back to the product cap, and no configuration can raise the cap
 * above `MAX_UPLOAD_BYTES`.
 */
export function configuredUploadLimit(): number {
  const raw = process.env.MAX_UPLOAD_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_UPLOAD_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_UPLOAD_BYTES;
  return Math.min(parsed, MAX_UPLOAD_BYTES);
}

export function isProjectIdParam(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

export function isIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

/** Control bytes, path separators and traversal never reach saved files. */
function hasForbiddenFilenameCharacter(filename: string): boolean {
  for (let index = 0; index < filename.length; index += 1) {
    const code = filename.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return filename.includes("/") || filename.includes("\\") || filename.includes("..");
}

/** Rejects path separators, control characters and missing/unknown extensions. */
export function validateUploadFilename(filename: string): { ok: true; extension: string } | { ok: false; code: "INVALID_FILENAME" | "UNSUPPORTED_MEDIA_TYPE" } {
  if (filename.length === 0 || filename.length > FILENAME_MAX_LENGTH) return { ok: false, code: "INVALID_FILENAME" };
  if (filename.trim() !== filename) return { ok: false, code: "INVALID_FILENAME" };
  if (hasForbiddenFilenameCharacter(filename)) return { ok: false, code: "INVALID_FILENAME" };
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return { ok: false, code: "INVALID_FILENAME" };
  const extension = filename.slice(dot + 1).toLowerCase();
  if (contentTypeForExtension(extension) === null) return { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" };
  return { ok: true, extension };
}

/** The declared media type must exactly match the extension's allowed type. */
export function validateUploadMediaType(extension: string, header: string): { ok: true; contentType: string } | { ok: false; code: "UNSUPPORTED_MEDIA_TYPE" } {
  const contentType = header.split(";")[0].trim().toLowerCase();
  const expected = contentTypeForExtension(extension);
  if (expected === null || contentType.length === 0 || contentType !== expected) return { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" };
  return { ok: true, contentType: expected };
}

function decodeLatin1(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

/** Content sniffing before saving: magic bytes, NUL bytes and UTF-8 validity. */
export function sniffDocumentContent(bytes: Uint8Array): "pdf" | "text" | "binary" {
  if (decodeLatin1(bytes.subarray(0, Math.min(bytes.length, 1024))).includes("%PDF-")) return "pdf";
  if (bytes.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "binary";
  }
  return "text";
}

/** PDFs must carry a header and an end marker; text must decode as UTF-8. */
export function validateUploadContent(extension: string, bytes: Uint8Array): { ok: true } | { ok: false; code: "UNSUPPORTED_CONTENT" } {
  const sniffed = sniffDocumentContent(bytes);
  if (extension === "pdf") {
    const tail = decodeLatin1(bytes.subarray(Math.max(0, bytes.length - 1024)));
    if (sniffed !== "pdf" || !tail.includes("%%EOF")) return { ok: false, code: "UNSUPPORTED_CONTENT" };
    return { ok: true };
  }
  if (sniffed !== "text") return { ok: false, code: "UNSUPPORTED_CONTENT" };
  return { ok: true };
}

type BlobStorage = {
  store: (blob: Blob) => Promise<Id<"_storage">>;
  delete: (storageId: Id<"_storage">) => Promise<void>;
};

/** Quota exhaustion surfaces as its own code; anything else is an upload failure. */
export function storageFailureCode(error: unknown): "QUOTA_EXCEEDED" | "UPLOAD_FAILED" {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|exceed/i.test(message) ? "QUOTA_EXCEEDED" : "UPLOAD_FAILED";
}

/**
 * Stores bytes and deletes them again unless the commit keeps them, so a
 * rejected or duplicate upload never leaves an orphan blob behind. `keep` is
 * false when the transactional commit resolved to an already committed row.
 */
export async function storeWithRollback<T>(storage: BlobStorage, blob: Blob, commit: (storageId: Id<"_storage">) => Promise<{ keep: boolean; result: T }>): Promise<T> {
  let storageId: Id<"_storage">;
  try {
    storageId = await storage.store(blob);
  } catch (error) {
    throw new ConvexError({ code: storageFailureCode(error) });
  }
  let outcome: { keep: boolean; result: T };
  try {
    outcome = await commit(storageId);
  } catch (error) {
    try {
      await storage.delete(storageId);
    } catch {
      // A failed cleanup must not mask the commit failure that caused it.
    }
    throw error;
  }
  if (!outcome.keep) {
    try {
      await storage.delete(storageId);
    } catch {
      // The replay result is still returned; cleanup failures stay invisible to the caller.
    }
  }
  return outcome.result;
}

const documentStatus = v.union(v.literal("pending"), v.literal("ready"), v.literal("failed"));

/**
 * The only document shape a client sees: status metadata without stored bytes,
 * storage ids or any bearer URL.
 */
const documentStatusResult = v.object({
  _id: v.id("documents"),
  privateFileId: v.id("privateFiles"),
  filename: v.string(),
  extension: v.string(),
  contentType: v.string(),
  sizeBytes: v.number(),
  status: documentStatus,
  failureCode: v.union(v.null(), v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function toDocumentStatus(document: Doc<"documents">) {
  return {
    _id: document._id,
    privateFileId: document.privateFileId,
    filename: document.filename,
    extension: document.extension,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
    status: document.status,
    failureCode: document.failureCode,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/** Lists one owner's document status rows for a project they own. */
export const listDocuments = query({
  args: { projectId: v.id("projects") },
  returns: v.array(documentStatusResult),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const documents = await ctx.db.query("documents").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId)).order("desc").collect();
    return documents.map(toDocumentStatus);
  },
});

/** Returns one document's status; foreign or unknown ids are non-enumerating NOT_FOUND. */
export const getDocument = query({
  args: { projectId: v.id("projects"), documentId: v.id("documents") },
  returns: documentStatusResult,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const document = await ctx.db.get(args.documentId);
    if (document === null || document.ownerId !== ownerId || document.projectId !== args.projectId) throw new ConvexError({ code: "NOT_FOUND" });
    return toDocumentStatus(document);
  },
});

/** The upload action's ownership pre-check; it runs before any byte is saved. */
export const assertUploadTarget = internalQuery({
  args: { ownerId: v.string(), projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.ownerId, args.projectId);
    return null;
  },
});

async function findOrCreateJob(ctx: MutationCtx, ownerId: string, projectId: Id<"projects">, documentId: Id<"documents">, now: number): Promise<Id<"ingestionJobs">> {
  const existing = await ctx.db.query("ingestionJobs").withIndex("by_document", (q) => q.eq("documentId", documentId)).unique();
  if (existing !== null) return existing._id;
  return ctx.db.insert("ingestionJobs", { ownerId, projectId, documentId, status: "queued", attempts: 0, createdAt: now, updatedAt: now });
}

/**
 * Transactional upload commit: ownership is re-checked, the idempotency key
 * resolves to the already committed document (replay), and otherwise the
 * storage id, document row and exactly one ingestion job are written together.
 */
export const commitDocumentUpload = internalMutation({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    filename: v.string(),
    extension: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    idempotencyKey: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.object({
    documentId: v.id("documents"),
    privateFileId: v.id("privateFiles"),
    jobId: v.id("ingestionJobs"),
    status: documentStatus,
    filename: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    duplicate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    await requireOwnedProject(ctx, args.ownerId, args.projectId);
    const existing = await ctx.db.query("documents").withIndex("by_owner_project_idempotency", (q) => q.eq("ownerId", args.ownerId).eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing !== null) {
      return {
        documentId: existing._id,
        privateFileId: existing.privateFileId,
        jobId: await findOrCreateJob(ctx, args.ownerId, args.projectId, existing._id, now),
        status: existing.status,
        filename: existing.filename,
        contentType: existing.contentType,
        sizeBytes: existing.sizeBytes,
        duplicate: true,
      };
    }
    const privateFileId = await ctx.db.insert("privateFiles", { ownerId: args.ownerId, projectId: args.projectId, storageId: args.storageId, contentType: args.contentType, createdAt: now });
    const documentId = await ctx.db.insert("documents", {
      ownerId: args.ownerId,
      projectId: args.projectId,
      privateFileId,
      storageId: args.storageId,
      filename: args.filename,
      extension: args.extension,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      status: "pending",
      failureCode: null,
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
    return {
      documentId,
      privateFileId,
      jobId: await findOrCreateJob(ctx, args.ownerId, args.projectId, documentId, now),
      status: "pending" as const,
      filename: args.filename,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      duplicate: false,
    };
  },
});
