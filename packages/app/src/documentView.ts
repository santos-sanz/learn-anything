import { dataErrorCode, DELETION_INCOMPLETE } from "./errors.js";
import type { DocumentItem, DocumentJob } from "./data/documents.js";

/**
 * S22 presentation rules for the document list: every label is derived from
 * the server's document row plus its real S09 job state (never from an
 * optimistic client flag), so what the screen shows is what the backend knows.
 * Pure and dependency-free so component tests can assert the mapping directly.
 */

export type StatusTone = "neutral" | "progress" | "success" | "danger";

export type DocumentStatusView = {
  label: string;
  tone: StatusTone;
  detail: string | null;
  /** True while ingestion may still change this row (drives auto-refresh). */
  processing: boolean;
  /** True only for the dead-lettered state a human can meaningfully retry. */
  canRetry: boolean;
};

/** Human first line for the job failure codes the runner can produce. */
const FAILURE_COPY: Record<string, string> = {
  EMBEDDING_NOT_CONFIGURED: "Embeddings aren’t configured on this deployment yet, so the file can’t be indexed.",
  NAN_POLICY_BLOCKED: "The configured provider rejected this request. Check the deployment’s provider policy.",
  QUOTA_EXCEEDED: "The deployment ran out of storage. Free some space and try again.",
  STORAGE_MISSING: "The stored file disappeared before it could be processed.",
  PARSE_FAILED: "We couldn’t read this file. Retry, or delete it and upload a fixed copy.",
  NO_EXTRACTABLE_TEXT: "This file has no extractable text.",
  EMBEDDING_DIMENSION_MISMATCH: "The stored vectors don’t match the configured embedding model.",
};

export function failureDetail(failureCode: string | null): string | null {
  if (failureCode === null || failureCode === "") return null;
  return FAILURE_COPY[failureCode] ?? `Processing stopped with code ${failureCode}.`;
}

function jobView(job: DocumentJob, documentStatus: DocumentItem["status"]): DocumentStatusView {
  switch (job.status) {
    case "running":
      return {
        label: `Processing… (attempt ${job.attempts} of ${job.maxAttempts})`,
        tone: "progress",
        detail: null,
        processing: true,
        canRetry: false,
      };
    case "queued":
      if (job.attempts > 0) {
        return {
          label: `Retrying… (attempt ${job.attempts} of ${job.maxAttempts})`,
          tone: "progress",
          detail: failureDetail(job.failureCode),
          processing: true,
          canRetry: false,
        };
      }
      return { label: "Waiting to process", tone: "neutral", detail: null, processing: true, canRetry: false };
    case "succeeded":
      return {
        label: job.chunkCount === null ? "Ready" : `Ready · ${job.chunkCount} ${job.chunkCount === 1 ? "section" : "sections"}`,
        tone: "success",
        detail: null,
        processing: false,
        canRetry: false,
      };
    case "failed":
      return {
        label: job.failureCode === null ? "Processing failed" : `Processing failed · ${job.failureCode}`,
        tone: "danger",
        detail: failureDetail(job.failureCode),
        processing: false,
        canRetry: true,
      };
    case "unsupported":
      return {
        label: job.failureCode === null ? "Unsupported file" : `Unsupported file · ${job.failureCode}`,
        tone: "danger",
        detail: "This input can’t be processed (for example an encrypted or scanned PDF). Delete it and upload a text-based file.",
        processing: false,
        canRetry: false,
      };
    default:
      return fallbackByDocument(documentStatus);
  }
}

/** Only used when a document has no job row at all (legacy or mid-cleanup). */
function fallbackByDocument(documentStatus: DocumentItem["status"]): DocumentStatusView {
  switch (documentStatus) {
    case "ready":
      return { label: "Ready", tone: "success", detail: null, processing: false, canRetry: false };
    case "failed":
      return { label: "Processing failed", tone: "danger", detail: null, processing: false, canRetry: true };
    default:
      return { label: "Waiting to process", tone: "neutral", detail: null, processing: true, canRetry: false };
  }
}

/** The status the list renders for one document: the joined job wins. */
export function documentStatusView(item: DocumentItem): DocumentStatusView {
  return item.job === null ? fallbackByDocument(item.status) : jobView(item.job, item.status);
}

/**
 * One-line locator for a chunk: the nearest heading, else the PDF page, else
 * its position in the document. Used for the viewer badge and neighbour links.
 */
export function sourceLocatorLabel(chunk: { seq: number; page: number | null; heading: string | null }): string {
  if (chunk.heading !== null && chunk.heading.trim() !== "") return chunk.heading;
  if (chunk.page !== null) return `Page ${chunk.page}`;
  return `Section ${chunk.seq + 1}`;
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatUploadedAt(createdAt: number): string {
  return DATE_FORMAT.format(new Date(createdAt));
}

/**
 * Fixed, safe copy for every way an upload, retry or delete can fail. Raw
 * backend messages would leak internals and help nobody, so each typed code
 * maps to one actionable sentence.
 */
export function mapDocumentError(error: unknown, context: "list" | "upload" | "retry" | "delete"): string {
  const code = dataErrorCode(error);
  switch (code) {
    case "UNAUTHENTICATED":
      return "Your session has ended. Sign in again to continue.";
    case "NOT_FOUND":
      return context === "delete" ? "That document is no longer available." : "That project doesn’t exist or isn’t yours.";
    case "FILE_TOO_LARGE":
      return "That file is too large. The limit is 10 MB.";
    case "EMPTY_FILE":
      return "That file is empty.";
    case "UNSUPPORTED_MEDIA_TYPE":
      return "That file type isn’t supported. Upload a PDF, Markdown or plain text file.";
    case "QUOTA_EXCEEDED":
      return "The deployment is out of storage. Delete a document or try again later.";
    case "UPLOAD_FAILED":
      return "The upload didn’t go through. Check your connection and try again.";
    case "RETRY_NOT_ALLOWED":
      return "This file can’t be retried because it isn’t supported. Delete it and upload a different file.";
    case "NETWORK":
      return "You appear to be offline. Check your connection and try again.";
    case DELETION_INCOMPLETE:
      return "Deleting is taking longer than expected. Try again to finish the cleanup.";
    case "INVALID_ARGUMENT":
      return "Check the file and try again.";
    default:
      if (context === "list") return "Couldn’t load your documents.";
      if (context === "upload") return "The upload didn’t go through. Try again.";
      if (context === "retry") return "The retry didn’t go through. Try again.";
      return "That didn’t go through. Check your connection and try again.";
  }
}

/** Short, fixed copy for each S13 missing-source reason shown by the viewer. */
export function unavailableCopy(reason: SourceUnavailableReason): string {
  switch (reason) {
    case "document-deleted":
      return "The document was deleted, so this source can no longer be opened.";
    case "chunk-deleted":
      return "This part of the document is no longer available. It was deleted or replaced by a newer version.";
    case "document-not-ready":
      return "The document is still processing or failed, so its source can’t be shown yet.";
    case "content-version-mismatch":
      return "The document changed after this citation was made, so the cited passage no longer matches.";
    default:
      return "This source is no longer available.";
  }
}

export type SourceUnavailableReason = "document-deleted" | "chunk-deleted" | "document-not-ready" | "content-version-mismatch";
