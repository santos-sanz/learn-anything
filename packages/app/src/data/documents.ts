import { api } from "@learn-anything/api/convex/_generated/api";
import type { Id } from "@learn-anything/api/convex/_generated/dataModel";
import { ConvexError } from "convex/values";
import type { ConvexReactClient } from "convex/react";

import { dataErrorCode, DELETION_INCOMPLETE } from "../errors.js";
import { requestDocumentUpload, type UploadBody } from "../uploadClient.js";

/**
 * S22 data port for document management and the citation source viewer. The
 * production implementation routes every read and mutation through the
 * authorized Convex functions (S05 owner/project checks on each call) and the
 * upload through the authenticated S08 HTTP action; tests inject a
 * deterministic fixture instead.
 */

export type DocumentJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "unsupported";
  attempts: number;
  maxAttempts: number;
  failureCode: string | null;
  nextAttemptAt: number | null;
  chunkCount: number | null;
  updatedAt: number;
};

export type DocumentItem = {
  id: string;
  filename: string;
  extension: string;
  contentType: string;
  sizeBytes: number;
  status: "pending" | "ready" | "failed";
  failureCode: string | null;
  createdAt: number;
  updatedAt: number;
  job: DocumentJob | null;
};

export type UploadResult = { documentId: string; jobId: string; filename: string; idempotent: boolean };

export type SourceChunk = { chunkId: string; seq: number; page: number | null; heading: string | null; text: string; contentHash?: string };

export type SourceView =
  | {
      status: "ok";
      document: { filename: string; extension: string; contentType: string; sizeBytes: number };
      focus: SourceChunk;
      before: SourceChunk[];
      after: SourceChunk[];
    }
  | {
      status: "unavailable";
      reason: SourceUnavailableReason;
      document: { filename: string; extension: string; contentType: string; sizeBytes: number };
      source: { chunkId: string | null; seq: number | null; page: number | null; heading: string | null; contentHash: string | null };
    };

export type SourceUnavailableReason = "document-deleted" | "chunk-deleted" | "document-not-ready" | "content-version-mismatch";

export type SourceReference = { projectId: string; documentId: string; chunkId?: string | undefined; contentHash?: string | undefined };

export type DocumentsBackend = {
  list(projectId: string): Promise<DocumentItem[]>;
  upload(input: { projectId: string; filename: string; bytes: Blob; idempotencyKey: string }): Promise<UploadResult>;
  retry(projectId: string, documentId: string): Promise<{ retried: boolean }>;
  /** Drives the bounded server-side cleanup to completion (resumable). */
  remove(projectId: string, documentId: string): Promise<void>;
  source(reference: SourceReference): Promise<SourceView>;
};

type ConvexClient = Pick<ConvexReactClient, "query" | "mutation">;

export type DocumentsBackendOptions = {
  /** Convex Auth token for the S08 upload action; queries carry identity themselves. */
  getToken: () => string | null;
  siteUrl: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

const asProjectId = (id: string) => id as Id<"projects">;
const asDocumentId = (id: string) => id as Id<"documents">;

/** Bounded so a stuck cleanup fails visibly instead of looping forever. */
const DELETE_BATCH_LIMIT = 100;
const DELETE_MAX_BATCHES = 50;

type StatusEntry = {
  document: { _id: string; filename: string; extension: string; contentType: string; sizeBytes: number; status: DocumentItem["status"]; failureCode: string | null; createdAt: number; updatedAt: number };
  job: { _id: string; status: DocumentJob["status"]; attempts: number; maxAttempts: number; failureCode: string | null; nextAttemptAt: number | null; chunkCount: number | null; updatedAt: number } | null;
};

const toItem = (entry: StatusEntry): DocumentItem => ({
  id: entry.document._id,
  filename: entry.document.filename,
  extension: entry.document.extension,
  contentType: entry.document.contentType,
  sizeBytes: entry.document.sizeBytes,
  status: entry.document.status,
  failureCode: entry.document.failureCode,
  createdAt: entry.document.createdAt,
  updatedAt: entry.document.updatedAt,
  job: entry.job === null ? null : { id: entry.job._id, status: entry.job.status, attempts: entry.job.attempts, maxAttempts: entry.job.maxAttempts, failureCode: entry.job.failureCode, nextAttemptAt: entry.job.nextAttemptAt, chunkCount: entry.job.chunkCount, updatedAt: entry.job.updatedAt },
});


/**
 * The production port: identity and ownership are re-derived server-side on
 * every call, the list shows only the caller's live documents, and deletion
 * drives the same bounded, resumable batch loop the S04 project deletion uses.
 */
export function makeConvexDocumentsBackend(client: ConvexClient, options: DocumentsBackendOptions): DocumentsBackend {
  return {
    async list(projectId) {
      const entries = await client.query(api.documents.listDocumentStatuses, { projectId: asProjectId(projectId) });
      return (entries as unknown as StatusEntry[]).map(toItem);
    },
    async upload(input) {
      const body: UploadBody = await requestDocumentUpload({
        siteUrl: options.siteUrl,
        token: options.getToken(),
        projectId: input.projectId,
        filename: input.filename,
        idempotencyKey: input.idempotencyKey,
        bytes: input.bytes,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      return { documentId: body.documentId, jobId: body.jobId, filename: body.filename, idempotent: body.idempotent };
    },
    async retry(projectId, documentId) {
      const result = await client.mutation(api.documents.retryDocument, { projectId: asProjectId(projectId), documentId: asDocumentId(documentId) });
      return { retried: result.retried };
    },
    async remove(projectId, documentId) {
      for (let attempt = 0; attempt < DELETE_MAX_BATCHES; attempt += 1) {
        let batch: { completed: boolean; deleted: number };
        try {
          batch = await client.mutation(api.documents.deleteDocumentBatch, { projectId: asProjectId(projectId), documentId: asDocumentId(documentId), limit: DELETE_BATCH_LIMIT });
        } catch (caught) {
          // NOT_FOUND means the document row is already gone: cleanup finished.
          if (dataErrorCode(caught) === "NOT_FOUND") return;
          throw caught;
        }
        if (batch.completed) return;
      }
      throw new Error(`${DELETION_INCOMPLETE}: document deletion did not finish within the batch cap; retry to resume.`);
    },
    async source(reference) {
      const args = {
        projectId: asProjectId(reference.projectId),
        documentId: asDocumentId(reference.documentId),
        ...(reference.chunkId === undefined ? {} : { chunkId: reference.chunkId as Id<"documentChunks"> }),
        ...(reference.contentHash === undefined ? {} : { contentHash: reference.contentHash }),
      };
      return (await client.query(api.sources.getCitationSource, args)) as SourceView;
    },
  };
}

/** Re-exported so screens can throw the same typed errors as the port. */
export { ConvexError };
