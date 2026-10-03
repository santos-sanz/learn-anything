// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { CitationLink, citationLabel } from "../src/components/CitationLink.js";
import { Root, type AuthSession } from "../src/Root.js";
import { fixtureDocumentsBackend } from "./documentFixtures.js";
import { fixtureBackend } from "./fixtures.js";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

function session(): AuthSession {
  return { isLoading: false, isAuthenticated: true, signIn: async () => undefined, signOut: async () => undefined };
}

test("citation labels prefer heading, then page, then position", () => {
  expect(citationLabel({ documentId: "d", chunkId: "c", heading: "Practice routine" })).toBe("Practice routine");
  expect(citationLabel({ documentId: "d", chunkId: "c", heading: null, page: 3 })).toBe("Page 3");
  expect(citationLabel({ documentId: "d", chunkId: "c", heading: null, page: null, seq: 4 })).toBe("Section 5");
  expect(citationLabel({ documentId: "d", chunkId: "c" })).toBe("Cited source");
});

test("a citation link carries the chunk anchor and cited hash in its href", () => {
  const withHash = render(
    <CitationLink projectId="p 1" citation={{ documentId: "doc 1", chunkId: "chunk 1", contentHash: "abc 123" }}>
      Cited passage
    </CitationLink>,
  );
  const anchor = screen.getByRole("link", { name: "Cited passage" });
  expect(anchor.getAttribute("href")).toBe("#/projects/p%201/sources/doc%201/chunk%201?hash=abc%20123");
  withHash.unmount();

  render(<CitationLink projectId="p1" citation={{ documentId: "d1", chunkId: "c1" }} label="Page 2" />);
  expect(screen.getByRole("link", { name: "Page 2" }).getAttribute("href")).toBe("#/projects/p1/sources/d1/c1");
});

test("clicking a citation opens the source viewer at the cited passage", async () => {
  const projects = fixtureBackend();
  const documents = fixtureDocumentsBackend();
  const user = userEvent.setup();

  render(
    <>
      <Root session={session()} backend={projects.backend} documents={documents.backend} />
      <ul>
        <li>
          <CitationLink
            projectId="p1"
            citation={{ documentId: "doc-1", chunkId: "chunk-2", contentHash: "hash-2", seq: 1, page: 2, heading: null }}
          />
        </li>
      </ul>
    </>,
  );

  await user.click(screen.getByRole("link", { name: "Page 2" }));
  expect(window.location.hash).toBe("#/projects/p1/sources/doc-1/chunk-2?hash=hash-2");

  // The viewer (driven by the real router) resolves the citation through the
  // access-checked source query.
  expect(await screen.findByRole("heading", { level: 1, name: "lesson.md" })).toBeTruthy();
  expect(screen.getByText("The focused cited passage.")).toBeTruthy();
  expect(screen.getByText("Cited source")).toBeTruthy();
  expect(documents.state.sourceCalls).toEqual([{ documentId: "doc-1", chunkId: "chunk-2", contentHash: "hash-2" }]);
});
