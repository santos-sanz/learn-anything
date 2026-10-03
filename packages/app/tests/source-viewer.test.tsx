// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, test } from "vitest";

import { SourceViewerScreen } from "../src/screens/SourceViewerScreen.js";
import { fixtureDocumentsBackend } from "./documentFixtures.js";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

const text = (node: Element | null | undefined): string => node?.textContent ?? "";

test("loading is announced before the source resolves", () => {
  const fixture = fixtureDocumentsBackend();
  render(<SourceViewerScreen projectId="p1" documentId="doc-1" chunkId="chunk-2" backend={fixture.backend} />);
  expect(screen.getByText("Loading source…")).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 1, name: "lesson.md" })).toBeNull();
});

test("an owned source opens with its locator, cited badge and bounded context", async () => {
  const fixture = fixtureDocumentsBackend();
  render(<SourceViewerScreen projectId="p1" documentId="doc-1" chunkId="chunk-2" contentHash="hash-2" backend={fixture.backend} />);

  expect(await screen.findByRole("heading", { level: 1, name: "lesson.md" })).toBeTruthy();
  expect(screen.getByText("Page 2")).toBeTruthy();
  expect(screen.getByText("Cited source")).toBeTruthy();
  expect(screen.getByText("The focused cited passage.")).toBeTruthy();

  // Neighbours link to their own chunk anchors so the reader can move through.
  expect(screen.getByRole("link", { name: "Page 1" }).getAttribute("href")).toBe("#/projects/p1/sources/doc-1/chunk-1");
  expect(screen.getByRole("link", { name: "Next heading" }).getAttribute("href")).toBe("#/projects/p1/sources/doc-1/chunk-3");
  expect(screen.getByText("Earlier context.")).toBeTruthy();
  expect(screen.getByText("Later context.")).toBeTruthy();

  // The citation anchor and freshness hash were sent to the access-checked query.
  expect(fixture.state.sourceCalls).toEqual([{ documentId: "doc-1", chunkId: "chunk-2", contentHash: "hash-2" }]);
  expect(screen.getByRole("link", { name: "Back to documents" }).getAttribute("href")).toBe("#/projects/p1/documents");
});

test("a fresh document open (no citation anchor) skips the cited badge", async () => {
  const fixture = fixtureDocumentsBackend();
  render(<SourceViewerScreen projectId="p1" documentId="doc-1" backend={fixture.backend} />);
  expect(await screen.findByRole("heading", { level: 1, name: "lesson.md" })).toBeTruthy();
  expect(screen.queryByText("Cited source")).toBeNull();
  expect(fixture.state.sourceCalls[0]).toMatchObject({ documentId: "doc-1", chunkId: undefined, contentHash: undefined });
});

test("a deleted source renders the explicit unavailable state with its reason", async () => {
  const fixture = fixtureDocumentsBackend();
  fixture.state.source = {
    status: "unavailable",
    reason: "document-deleted",
    document: { filename: "lesson.md", extension: "md", contentType: "text/markdown", sizeBytes: 83 },
    source: { chunkId: null, seq: null, page: null, heading: null, contentHash: null },
  };
  render(<SourceViewerScreen projectId="p1" documentId="doc-1" chunkId="chunk-9" contentHash="hash-9" backend={fixture.backend} />);

  await screen.findByRole("heading", { name: "Source unavailable" });
  const panel = screen.getByRole("status");
  expect(text(panel)).toContain("The document was deleted");
  expect(text(panel)).toContain("lesson.md");
  expect(screen.getByRole("link", { name: "Back to documents" }).getAttribute("href")).toBe("#/projects/p1/documents");
  // Never a broken link and never a silent panel: the state is explicit, and
  // there is no source text or neighbour links when the source is gone.
  expect(screen.queryByText("The focused cited passage.")).toBeNull();
  expect(screen.queryByRole("article")).toBeNull();
});

test("each missing-source reason shows its own explicit copy", async () => {
  const reasons = ["document-deleted", "chunk-deleted", "document-not-ready", "content-version-mismatch"] as const;
  const expected = ["The document was deleted", "no longer available", "still processing", "changed after this citation"];
  for (let index = 0; index < reasons.length; index += 1) {
    cleanup();
    const fixture = fixtureDocumentsBackend();
    fixture.state.source = {
      status: "unavailable",
      reason: reasons[index],
      document: { filename: "lesson.md", extension: "md", contentType: "text/markdown", sizeBytes: 83 },
      source: { chunkId: null, seq: null, page: null, heading: null, contentHash: null },
    };
    render(<SourceViewerScreen projectId="p1" documentId="doc-1" backend={fixture.backend} />);
    await screen.findByRole("heading", { name: "Source unavailable" });
    expect(text(screen.getByRole("status"))).toContain(expected[index]);
  }
});

test("a cross-project request is denied server-side and shows an access-denied state", async () => {
  const fixture = fixtureDocumentsBackend();
  fixture.state.failSource = new ConvexError({ code: "NOT_FOUND" });
  render(<SourceViewerScreen projectId="p1" documentId="foreign-doc" backend={fixture.backend} />);

  const panel = await screen.findByRole("alert");
  expect(text(screen.getByRole("heading", { name: "Access denied" }))).toContain("Access denied");
  expect(text(panel)).toContain("You don’t have access to this source.");
  // Denied means denied: no filename, no text, and no retry loop probing ids.
  expect(panel.textContent).not.toContain("lesson.md");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByRole("link", { name: "Back to documents" })).toBeTruthy();
});

test("a transient load failure is announced with an actionable retry", async () => {
  const fixture = fixtureDocumentsBackend();
  fixture.state.failSource = new Error("network down");
  const user = userEvent.setup();
  render(<SourceViewerScreen projectId="p1" documentId="doc-1" backend={fixture.backend} />);

  const panel = await screen.findByRole("alert");
  expect(text(panel)).toContain("Couldn’t load this project.");
  fixture.state.failSource = null;
  await user.click(within(panel).getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("heading", { level: 1, name: "lesson.md" })).toBeTruthy();
});

test("an unauthenticated source request surfaces the session copy", async () => {
  const fixture = fixtureDocumentsBackend();
  fixture.state.failSource = new ConvexError({ code: "UNAUTHENTICATED" });
  render(<SourceViewerScreen projectId="p1" documentId="doc-1" backend={fixture.backend} />);
  const panel = await screen.findByRole("alert");
  expect(text(panel)).toContain("Your session has ended.");
  await waitFor(() => expect(screen.queryByText("The focused cited passage.")).toBeNull());
});

test("a missing backend renders an explicit unavailable state instead of crashing", () => {
  render(<SourceViewerScreen projectId="p1" documentId="doc-1" backend={null} />);
  const alert = screen.getByRole("alert");
  expect(text(alert)).toContain("source viewer isn’t available");
  expect(screen.getByRole("link", { name: "Back to documents" })).toBeTruthy();
});
