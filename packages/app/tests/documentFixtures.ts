import type { DocumentItem, DocumentsBackend, SourceView } from "../src/data/documents.js";

/**
 * Deterministic in-memory documents backend for component tests. Every call
 * is recorded, and each operation can be switched to fail so the screens'
 * error handling is observable without a server.
 */

export type DocumentsFixtureState = {
  items: DocumentItem[];
  listMode: "ok" | "error" | "pending";
  failList: Error | null;
  listCalls: number;
  uploads: { filename: string; idempotencyKey: string }[];
  failUpload: Error | null;
  retried: string[];
  failRetry: Error | null;
  removed: string[];
  failRemove: Error | null;
  source: SourceView;
  failSource: Error | null;
  sourceCalls: { documentId: string; chunkId?: string | undefined; contentHash?: string | undefined }[];
};

const baseTime = 1_760_000_000_000;

export function documentItem(overrides: Partial<DocumentItem> & { id: string; filename: string }): DocumentItem {
  return {
    extension: "md",
    contentType: "text/markdown",
    sizeBytes: 4096,
    status: "pending",
    failureCode: null,
    createdAt: baseTime,
    updatedAt: baseTime,
    job: {
      id: `${overrides.id}-job`,
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
      failureCode: null,
      nextAttemptAt: null,
      chunkCount: null,
      updatedAt: baseTime,
    },
    ...overrides,
  };
}

export const readySource: SourceView = {
  status: "ok",
  document: { filename: "lesson.md", extension: "md", contentType: "text/markdown", sizeBytes: 83 },
  focus: { chunkId: "chunk-2", seq: 1, page: 2, heading: null, contentHash: "hash-2", text: "The focused cited passage." },
  before: [{ chunkId: "chunk-1", seq: 0, page: 1, heading: null, text: "Earlier context." }],
  after: [{ chunkId: "chunk-3", seq: 2, page: 3, heading: "Next heading", text: "Later context." }],
};

export function fixtureDocumentsBackend(seed: DocumentItem[] = []): { backend: DocumentsBackend; state: DocumentsFixtureState } {
  const state: DocumentsFixtureState = {
    items: [...seed],
    listMode: "ok",
    failList: null,
    listCalls: 0,
    uploads: [],
    failUpload: null,
    retried: [],
    failRetry: null,
    removed: [],
    failRemove: null,
    source: readySource,
    failSource: null,
    sourceCalls: [],
  };

  const backend: DocumentsBackend = {
    async list() {
      state.listCalls += 1;
      if (state.listMode === "pending") return new Promise<DocumentItem[]>(() => undefined);
      if (state.listMode === "error") throw state.failList ?? new Error("fixture list failed");
      return state.items.map((item) => ({ ...item, job: item.job === null ? null : { ...item.job } }));
    },
    async upload(input) {
      // The attempt is recorded first so a failing upload is still observable.
      state.uploads.push({ filename: input.filename, idempotencyKey: input.idempotencyKey });
      if (state.failUpload !== null) throw state.failUpload;
      return { documentId: `uploaded-${state.uploads.length}`, jobId: `uploaded-job-${state.uploads.length}`, filename: input.filename, idempotent: false };
    },
    async retry(_projectId, documentId) {
      if (state.failRetry !== null) throw state.failRetry;
      state.retried.push(documentId);
      const item = state.items.find((entry) => entry.id === documentId);
      if (item !== undefined && item.job !== null) {
        item.job = { ...item.job, status: "queued", attempts: 0, failureCode: null, nextAttemptAt: baseTime };
        item.status = "pending";
        item.failureCode = null;
      }
      return { retried: true };
    },
    async remove(_projectId, documentId) {
      if (state.failRemove !== null) throw state.failRemove;
      state.removed.push(documentId);
      state.items = state.items.filter((item) => item.id !== documentId);
    },
    async source(reference) {
      state.sourceCalls.push({ documentId: reference.documentId, chunkId: reference.chunkId, contentHash: reference.contentHash });
      if (state.failSource !== null) throw state.failSource;
      return state.source;
    },
  };

  return { backend, state };
}
