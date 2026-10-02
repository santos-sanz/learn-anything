import { readFileSync } from "node:fs";

import { ConvexError } from "convex/values";
import { expect, test } from "vitest";

import type { Id } from "../convex/_generated/dataModel";
import {
  configuredUploadLimit,
  isIdempotencyKey,
  isProjectIdParam,
  MAX_UPLOAD_BYTES,
  sniffDocumentContent,
  storageFailureCode,
  storeWithRollback,
  validateUploadContent,
  validateUploadFilename,
  validateUploadMediaType,
} from "../convex/documents.js";

const fixture = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const storageId = (n: number): Id<"_storage"> => `test-storage-${n}` as Id<"_storage">;

const fakeStorage = () => {
  const stored: Id<"_storage">[] = [];
  const deleted: Id<"_storage">[] = [];
  return {
    stored,
    deleted,
    storage: {
      store: async () => {
        const id = storageId(stored.length + 1);
        stored.push(id);
        return id;
      },
      delete: async (id: Id<"_storage">) => {
        deleted.push(id);
      },
    },
  };
};

test("the upload limit is configurable and never above the 10 MiB product cap", () => {
  const previous = process.env.MAX_UPLOAD_BYTES;
  try {
    delete process.env.MAX_UPLOAD_BYTES;
    expect(configuredUploadLimit()).toBe(10 * 1024 * 1024);
    process.env.MAX_UPLOAD_BYTES = "65536";
    expect(configuredUploadLimit()).toBe(65536);
    process.env.MAX_UPLOAD_BYTES = "999999999";
    expect(configuredUploadLimit()).toBe(MAX_UPLOAD_BYTES);
    process.env.MAX_UPLOAD_BYTES = "not-a-number";
    expect(configuredUploadLimit()).toBe(10 * 1024 * 1024);
    process.env.MAX_UPLOAD_BYTES = "0";
    expect(configuredUploadLimit()).toBe(10 * 1024 * 1024);
    process.env.MAX_UPLOAD_BYTES = "   ";
    expect(configuredUploadLimit()).toBe(10 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThan(20 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.MAX_UPLOAD_BYTES;
    else process.env.MAX_UPLOAD_BYTES = previous;
  }
});

test("filename validation rejects traversal, control bytes and unknown types", () => {
  expect(validateUploadFilename("lesson.md")).toEqual({ ok: true, extension: "md" });
  expect(validateUploadFilename("NOTES.MD")).toEqual({ ok: true, extension: "md" });
  expect(validateUploadFilename("notes.markdown")).toEqual({ ok: true, extension: "markdown" });
  expect(validateUploadFilename("outline.pdf")).toEqual({ ok: true, extension: "pdf" });
  expect(validateUploadFilename("notes.txt")).toEqual({ ok: true, extension: "txt" });
  expect(validateUploadFilename("../escape.md")).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename("a\\b.md")).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename(".md")).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename("notes")).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename("notes.")).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename(" notes.md")).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename("notes.md ")).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename(`bad${String.fromCharCode(0)}name.md`)).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename("n".repeat(201))).toEqual({ ok: false, code: "INVALID_FILENAME" });
  expect(validateUploadFilename("run.exe")).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
});

test("the declared media type must match the extension exactly", () => {
  expect(validateUploadMediaType("md", "text/markdown")).toEqual({ ok: true, contentType: "text/markdown" });
  expect(validateUploadMediaType("md", "text/markdown; charset=UTF-8")).toEqual({ ok: true, contentType: "text/markdown" });
  expect(validateUploadMediaType("txt", "text/plain")).toEqual({ ok: true, contentType: "text/plain" });
  expect(validateUploadMediaType("pdf", "application/pdf")).toEqual({ ok: true, contentType: "application/pdf" });
  expect(validateUploadMediaType("txt", "text/markdown")).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
  expect(validateUploadMediaType("pdf", "text/plain")).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
  expect(validateUploadMediaType("md", "")).toEqual({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
});

test("content sniffing separates pdf, text and binary payloads", () => {
  expect(sniffDocumentContent(fixture("outline.pdf"))).toBe("pdf");
  expect(sniffDocumentContent(fixture("lesson.md"))).toBe("text");
  expect(sniffDocumentContent(fixture("notes.txt"))).toBe("text");
  expect(sniffDocumentContent(new Uint8Array([0x01, 0x00]))).toBe("binary");
  expect(sniffDocumentContent(new Uint8Array([0xc3, 0x28]))).toBe("binary");
});

test("content validation accepts synthetic fixtures and rejects mislabeled bytes", () => {
  expect(validateUploadContent("pdf", fixture("outline.pdf"))).toEqual({ ok: true });
  expect(validateUploadContent("md", fixture("lesson.md"))).toEqual({ ok: true });
  expect(validateUploadContent("txt", fixture("notes.txt"))).toEqual({ ok: true });
  expect(validateUploadContent("md", new TextEncoder().encode("unicode: \u00e9\u00e8\u4e2d"))).toEqual({ ok: true });
  expect(validateUploadContent("pdf", fixture("truncated.pdf"))).toEqual({ ok: false, code: "UNSUPPORTED_CONTENT" });
  expect(validateUploadContent("pdf", fixture("mislabelled.pdf"))).toEqual({ ok: false, code: "UNSUPPORTED_CONTENT" });
  expect(validateUploadContent("txt", new Uint8Array([0x48, 0x00, 0x49]))).toEqual({ ok: false, code: "UNSUPPORTED_CONTENT" });
  expect(validateUploadContent("txt", new Uint8Array([0xff, 0xfe]))).toEqual({ ok: false, code: "UNSUPPORTED_CONTENT" });
});

test("project id and idempotency key parameters are strictly shaped", () => {
  expect(isProjectIdParam("k57abc123")).toBe(true);
  expect(isProjectIdParam("not a project id")).toBe(false);
  expect(isProjectIdParam("")).toBe(false);
  expect(isProjectIdParam("../../etc/passwd")).toBe(false);
  expect(isIdempotencyKey("abcdefgh")).toBe(true);
  expect(isIdempotencyKey("upload:2026-10-02.v1")).toBe(true);
  expect(isIdempotencyKey("short")).toBe(false);
  expect(isIdempotencyKey("with spaces key")).toBe(false);
});

test("storage failures surface as quota or upload failure codes", () => {
  expect(storageFailureCode(new Error("File storage quota exceeded"))).toBe("QUOTA_EXCEEDED");
  expect(storageFailureCode(new Error("storage quota"))).toBe("QUOTA_EXCEEDED");
  expect(storageFailureCode(new Error("connection reset"))).toBe("UPLOAD_FAILED");
  expect(storageFailureCode("quota exceed")).toBe("QUOTA_EXCEEDED");
});

test("an uncommitted stored blob is deleted again by the rollback helper", async () => {
  const { storage, stored, deleted } = fakeStorage();
  await expect(
    storeWithRollback(storage, new Blob(["x"]), async () => {
      throw new ConvexError({ code: "NOT_FOUND" });
    }),
  ).rejects.toThrow("NOT_FOUND");
  expect(stored).toHaveLength(1);
  expect(deleted).toEqual(stored);
});

test("a committed stored blob is kept exactly once", async () => {
  const { storage, stored, deleted } = fakeStorage();
  const kept = await storeWithRollback(storage, new Blob(["x"]), async (id) => ({ keep: true, result: { id } }));
  expect(kept).toEqual({ id: "test-storage-1" });
  expect(stored).toEqual(["test-storage-1"]);
  expect(deleted).toHaveLength(0);
});

test("a commit that resolves to an existing row deletes its fresh blob", async () => {
  const { storage, stored, deleted } = fakeStorage();
  const replayed = await storeWithRollback(storage, new Blob(["x"]), async (id) => ({ keep: false, result: { id, duplicate: true } }));
  expect(replayed).toEqual({ id: "test-storage-1", duplicate: true });
  expect(stored).toHaveLength(1);
  expect(deleted).toEqual(stored);
});

test("a quota failure during storage never reaches the commit", async () => {
  const failing = {
    store: async () => {
      throw new Error("File storage quota exceeded");
    },
    delete: async () => {
      throw new Error("delete must not be called");
    },
  };
  let committed = false;
  await expect(
    storeWithRollback(failing, new Blob(["x"]), async () => {
      committed = true;
      return { keep: true, result: "unused" };
    }),
  ).rejects.toThrow("QUOTA_EXCEEDED");
  expect(committed).toBe(false);
});
