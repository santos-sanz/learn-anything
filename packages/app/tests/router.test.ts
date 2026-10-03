// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";

import { navigate, parseRoute, serializeRoute, useHashRoute } from "../src/router.js";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

test("hash routes parse to the S21 screens", () => {
  expect(parseRoute("")).toEqual({ name: "dashboard" });
  expect(parseRoute("#/")).toEqual({ name: "dashboard" });
  expect(parseRoute("#/projects")).toEqual({ name: "dashboard" });
  expect(parseRoute("#/projects/new")).toEqual({ name: "new-project" });
  expect(parseRoute("#/projects/abc123")).toEqual({ name: "project", id: "abc123" });
  expect(parseRoute("#/projects/a%20b")).toEqual({ name: "project", id: "a b" });
  expect(parseRoute("#/unknown")).toEqual({ name: "dashboard" });
  expect(parseRoute("#/projects/new/extra")).toEqual({ name: "dashboard" });
});

test("S22 document and source routes parse anchors and freshness hashes", () => {
  expect(parseRoute("#/projects/abc123/documents")).toEqual({ name: "documents", projectId: "abc123" });
  expect(parseRoute("#/projects/abc123/sources/doc1")).toEqual({
    name: "source",
    projectId: "abc123",
    documentId: "doc1",
    chunkId: undefined,
    contentHash: undefined,
  });
  expect(parseRoute("#/projects/abc123/sources/doc1/chunk2")).toEqual({
    name: "source",
    projectId: "abc123",
    documentId: "doc1",
    chunkId: "chunk2",
    contentHash: undefined,
  });
  expect(parseRoute("#/projects/abc123/sources/doc1/chunk2?hash=abc-123")).toEqual({
    name: "source",
    projectId: "abc123",
    documentId: "doc1",
    chunkId: "chunk2",
    contentHash: "abc-123",
  });
  expect(parseRoute("#/projects/abc123/sources/doc1?hash=abc-123")).toEqual({
    name: "source",
    projectId: "abc123",
    documentId: "doc1",
    chunkId: undefined,
    contentHash: "abc-123",
  });
  // A stray extension or a nested project path never reaches the viewer.
  expect(parseRoute("#/projects/abc123/sources")).toEqual({ name: "dashboard" });
  expect(parseRoute("#/projects/abc123/documents/extra")).toEqual({ name: "dashboard" });
});

test("routes serialize for links and navigation", () => {
  expect(serializeRoute({ name: "dashboard" })).toBe("#/projects");
  expect(serializeRoute({ name: "new-project" })).toBe("#/projects/new");
  expect(serializeRoute({ name: "project", id: "p1" })).toBe("#/projects/p1");
  expect(parseRoute(serializeRoute({ name: "project", id: "a b" }))).toEqual({ name: "project", id: "a b" });
  expect(serializeRoute({ name: "documents", projectId: "p1" })).toBe("#/projects/p1/documents");
  expect(serializeRoute({ name: "source", projectId: "p1", documentId: "d1" })).toBe("#/projects/p1/sources/d1");
  expect(serializeRoute({ name: "source", projectId: "p1", documentId: "d1", chunkId: "c1", contentHash: "h 1" })).toBe("#/projects/p1/sources/d1/c1?hash=h%201");
  expect(parseRoute(serializeRoute({ name: "documents", projectId: "a b" }))).toEqual({ name: "documents", projectId: "a b" });
  expect(parseRoute(serializeRoute({ name: "source", projectId: "a b", documentId: "d 1", chunkId: "c 1", contentHash: "h/1" }))).toEqual({
    name: "source",
    projectId: "a b",
    documentId: "d 1",
    chunkId: "c 1",
    contentHash: "h/1",
  });
});

test("the hook follows hash changes so navigation re-renders the shell", async () => {
  const flushHashChange = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const { result } = renderHook(() => useHashRoute());
  expect(result.current).toEqual({ name: "dashboard" });

  act(() => {
    navigate({ name: "new-project" });
  });
  await flushHashChange();
  expect(result.current).toEqual({ name: "new-project" });
  expect(window.location.hash).toBe("#/projects/new");

  act(() => {
    navigate({ name: "project", id: "p9" });
  });
  await flushHashChange();
  expect(result.current).toEqual({ name: "project", id: "p9" });
});
