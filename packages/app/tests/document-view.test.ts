import { ConvexError } from "convex/values";
import { expect, test } from "vitest";

import { documentItem } from "./documentFixtures.js";
import {
  documentStatusView,
  failureDetail,
  formatBytes,
  mapDocumentError,
  sourceLocatorLabel,
  unavailableCopy,
} from "../src/documentView.js";

test("the status view derives every badge from the real joined job state", () => {
  expect(
    documentStatusView(
      documentItem({ id: "d1", filename: "a.md", job: { id: "j", status: "running", attempts: 1, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: null, updatedAt: 0 } }),
    ),
  ).toMatchObject({ label: "Processing… (attempt 1 of 5)", tone: "progress", processing: true, canRetry: false });

  expect(
    documentStatusView(
      documentItem({ id: "d2", filename: "b.md", job: { id: "j", status: "queued", attempts: 0, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: null, updatedAt: 0 } }),
    ),
  ).toMatchObject({ label: "Waiting to process", tone: "neutral", processing: true, canRetry: false });

  // A transient failure is still `queued` with backoff: the badge says so and
  // keeps polling, without offering a pointless manual retry.
  const backingOff = documentStatusView(
    documentItem({
      id: "d3",
      filename: "c.md",
      job: { id: "j", status: "queued", attempts: 2, maxAttempts: 5, failureCode: "PARSE_FAILED", nextAttemptAt: 123, chunkCount: null, updatedAt: 0 },
    }),
  );
  expect(backingOff).toMatchObject({ label: "Retrying… (attempt 2 of 5)", tone: "progress", processing: true, canRetry: false });
  expect(backingOff.detail).toContain("Retry, or delete it");

  expect(
    documentStatusView(
      documentItem({ id: "d4", filename: "d.md", status: "ready", job: { id: "j", status: "succeeded", attempts: 1, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: 6, updatedAt: 0 } }),
    ),
  ).toMatchObject({ label: "Ready · 6 sections", tone: "success", processing: false, canRetry: false });

  const dead = documentStatusView(
    documentItem({
      id: "d5",
      filename: "e.md",
      status: "failed",
      job: { id: "j", status: "failed", attempts: 5, maxAttempts: 5, failureCode: "PARSE_FAILED", nextAttemptAt: null, chunkCount: null, updatedAt: 0 },
    }),
  );
  expect(dead).toMatchObject({ tone: "danger", processing: false, canRetry: true });
  expect(dead.label).toContain("PARSE_FAILED");

  const unsupported = documentStatusView(
    documentItem({
      id: "d6",
      filename: "f.pdf",
      status: "failed",
      job: { id: "j", status: "unsupported", attempts: 1, maxAttempts: 5, failureCode: "ENCRYPTED_PDF", nextAttemptAt: null, chunkCount: null, updatedAt: 0 },
    }),
  );
  expect(unsupported).toMatchObject({ tone: "danger", processing: false, canRetry: false });
  expect(unsupported.label).toContain("Unsupported file");
  expect(unsupported.detail).toBeTruthy();
});

test("a document without a job row falls back to its own status", () => {
  expect(documentStatusView(documentItem({ id: "d1", filename: "a.md", job: null }))).toMatchObject({ label: "Waiting to process", processing: true, canRetry: false });
  expect(documentStatusView(documentItem({ id: "d2", filename: "b.md", status: "ready", job: null }))).toMatchObject({ label: "Ready", tone: "success", processing: false });
  expect(documentStatusView(documentItem({ id: "d3", filename: "c.md", status: "failed", job: null }))).toMatchObject({ label: "Processing failed", tone: "danger", canRetry: true });
});

test("file sizes and locators render as fixed human labels", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2.0 KB");
  expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  expect(sourceLocatorLabel({ seq: 4, page: null, heading: "Practice routine" })).toBe("Practice routine");
  expect(sourceLocatorLabel({ seq: 4, page: 3, heading: null })).toBe("Page 3");
  expect(sourceLocatorLabel({ seq: 4, page: null, heading: "  " })).toBe("Section 5");
  expect(sourceLocatorLabel({ seq: 0, page: 1, heading: null })).toBe("Page 1");
});

test("every document error code maps to one actionable sentence", () => {
  const withCode = (code: string) => new ConvexError({ code });
  expect(mapDocumentError(withCode("UNAUTHENTICATED"), "list")).toContain("Sign in again");
  expect(mapDocumentError(withCode("FILE_TOO_LARGE"), "upload")).toContain("10 MB");
  expect(mapDocumentError(withCode("UNSUPPORTED_MEDIA_TYPE"), "upload")).toContain("PDF, Markdown or plain text");
  expect(mapDocumentError(withCode("QUOTA_EXCEEDED"), "upload")).toContain("out of storage");
  expect(mapDocumentError(withCode("NETWORK"), "upload")).toContain("offline");
  expect(mapDocumentError(withCode("RETRY_NOT_ALLOWED"), "retry")).toContain("Delete it");
  expect(mapDocumentError(withCode("DELETION_INCOMPLETE"), "delete")).toContain("finish the cleanup");
  expect(mapDocumentError(withCode("NOT_FOUND"), "delete")).toBe("That document is no longer available.");
  expect(mapDocumentError(withCode("NOT_FOUND"), "list")).toContain("project");
  expect(mapDocumentError(new Error("boom"), "list")).toBe("Couldn’t load your documents.");
  expect(mapDocumentError(new Error("boom"), "upload")).toBe("The upload didn’t go through. Try again.");
});

test("each missing-source reason has distinct, explicit copy", () => {
  const reasons = ["document-deleted", "chunk-deleted", "document-not-ready", "content-version-mismatch"] as const;
  const copy = reasons.map((reason) => unavailableCopy(reason));
  for (const line of copy) expect(line.length).toBeGreaterThan(10);
  expect(new Set(copy).size).toBe(reasons.length);
  expect(copy[0]).toContain("deleted");
});

test("failure codes surface a known first line or the raw code", () => {
  expect(failureDetail(null)).toBeNull();
  expect(failureDetail("EMBEDDING_NOT_CONFIGURED")).toContain("Embeddings aren’t configured");
  expect(failureDetail("SOME_NEW_CODE")).toContain("SOME_NEW_CODE");
});
