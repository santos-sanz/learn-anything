// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { DocumentsBackend } from "../src/data/documents.js";
import { DocumentsScreen } from "../src/screens/DocumentsScreen.js";
import { documentItem, fixtureDocumentsBackend } from "./documentFixtures.js";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

function renderScreen(backend: DocumentsBackend, refreshMs = 0) {
  return render(<DocumentsScreen projectId="p1" backend={backend} refreshMs={refreshMs} />);
}

const text = (node: Element | null | undefined): string => node?.textContent ?? "";

const allStates = () => [
  documentItem({
    id: "doc-ready",
    filename: "ready-notes.md",
    status: "ready",
    job: { id: "j1", status: "succeeded", attempts: 1, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: 6, updatedAt: 0 },
  }),
  documentItem({
    id: "doc-running",
    filename: "ingesting.pdf",
    job: { id: "j2", status: "running", attempts: 1, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: null, updatedAt: 0 },
  }),
  documentItem({
    id: "doc-retry",
    filename: "backoff.txt",
    job: { id: "j3", status: "queued", attempts: 2, maxAttempts: 5, failureCode: "PARSE_FAILED", nextAttemptAt: 123, chunkCount: null, updatedAt: 0 },
  }),
  documentItem({
    id: "doc-failed",
    filename: "failed.pdf",
    status: "failed",
    failureCode: "PARSE_FAILED",
    job: { id: "j4", status: "failed", attempts: 5, maxAttempts: 5, failureCode: "PARSE_FAILED", nextAttemptAt: null, chunkCount: null, updatedAt: 0 },
  }),
  documentItem({
    id: "doc-unsupported",
    filename: "scan.pdf",
    status: "failed",
    failureCode: "ENCRYPTED_PDF",
    job: { id: "j5", status: "unsupported", attempts: 1, maxAttempts: 5, failureCode: "ENCRYPTED_PDF", nextAttemptAt: null, chunkCount: null, updatedAt: 0 },
  }),
];

test("the loading state announces itself while the first load is pending", () => {
  const { backend, state } = fixtureDocumentsBackend();
  state.listMode = "pending";
  renderScreen(backend);
  expect(text(screen.getByRole("status"))).toContain("Loading documents…");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the error state is actionable and a retry recovers the list", async () => {
  const { backend, state } = fixtureDocumentsBackend([documentItem({ id: "d1", filename: "recovered.md" })]);
  state.listMode = "error";
  const user = userEvent.setup();
  renderScreen(backend);

  const alert = await screen.findByRole("alert");
  expect(text(alert)).toContain("Couldn’t load your documents.");
  state.listMode = "ok";
  await user.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("heading", { name: "recovered.md" })).toBeTruthy();
});

test("the empty state explains what to upload", async () => {
  const { backend } = fixtureDocumentsBackend();
  renderScreen(backend);
  expect(await screen.findByRole("heading", { name: "No documents yet" })).toBeTruthy();
  expect(screen.getByLabelText("Add a document")).toBeTruthy();
});

test("each document renders its real job state with only the valid actions", async () => {
  const { backend } = fixtureDocumentsBackend(allStates());
  renderScreen(backend);

  await screen.findByRole("heading", { name: "ready-notes.md" });
  expect(screen.getByText("Ready · 6 sections")).toBeTruthy();
  expect(screen.getByText("Processing… (attempt 1 of 5)")).toBeTruthy();
  expect(screen.getByText("Retrying… (attempt 2 of 5)")).toBeTruthy();
  expect(screen.getByText(/Processing failed · PARSE_FAILED/)).toBeTruthy();
  expect(screen.getByText(/Unsupported file · ENCRYPTED_PDF/)).toBeTruthy();

  // Only the dead-lettered job offers a manual retry; unsupported never does.
  expect(screen.getByRole("button", { name: "Retry failed.pdf" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry scan.pdf" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry ready-notes.md" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry ingesting.pdf" })).toBeNull();

  // Ready documents link into the viewer; pending ones do not pretend to.
  expect(screen.getByRole("link", { name: "Open source of ready-notes.md" }).getAttribute("href")).toBe("#/projects/p1/sources/doc-ready");
  expect(screen.queryByRole("link", { name: "Open source of ingesting.pdf" })).toBeNull();

  // Every row offers deletion with a labelled control.
  for (const name of ["ready-notes.md", "ingesting.pdf", "backoff.txt", "failed.pdf", "scan.pdf"]) {
    expect(screen.getByRole("button", { name: `Delete ${name}` })).toBeTruthy();
  }
});

test("upload sends the selected file with a stable idempotency key and keeps it on failure", async () => {
  const { backend, state } = fixtureDocumentsBackend();
  const user = userEvent.setup();
  renderScreen(backend);
  await screen.findByRole("heading", { name: "No documents yet" });

  const input = screen.getByLabelText("Add a document") as HTMLInputElement;
  const file = new File(["# hello"], "hello.md", { type: "text/markdown" });
  await user.upload(input, file);
  expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(false);

  // First attempt fails: the typed copy is announced and the key is reused.
  state.failUpload = new ConvexError({ code: "QUOTA_EXCEEDED" });
  await user.click(screen.getByRole("button", { name: "Upload" }));
  const alert = await screen.findByRole("alert");
  expect(text(alert)).toContain("out of storage");
  expect(state.uploads).toHaveLength(1);

  // The backend recovers; the same file retries with the SAME key.
  state.failUpload = null;
  await user.click(screen.getByRole("button", { name: "Upload" }));
  await waitFor(() => expect(state.uploads).toHaveLength(2));
  expect(state.uploads[0].idempotencyKey).toBe(state.uploads[1].idempotencyKey);
  expect(state.uploads[0].filename).toBe("hello.md");
  expect(await screen.findByText(/uploaded — waiting to process/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
});

test("an upload rejected as unsupported shows the media-type copy", async () => {
  const { backend, state } = fixtureDocumentsBackend();
  // setup-level applyAccept:false lets the deliberately wrong file through, so
  // the typed UNSUPPORTED_MEDIA_TYPE path is what the screen must surface.
  const user = userEvent.setup({ applyAccept: false });
  renderScreen(backend);
  await screen.findByRole("heading", { name: "No documents yet" });

  await user.upload(screen.getByLabelText("Add a document"), new File(["MZ"], "run.exe", { type: "application/octet-stream" }));
  state.failUpload = new ConvexError({ code: "UNSUPPORTED_MEDIA_TYPE" });
  await user.click(screen.getByRole("button", { name: "Upload" }));
  const alert = await screen.findByRole("alert");
  expect(text(alert)).toContain("PDF, Markdown or plain text");
});

test("retry re-asks the backend and the badge returns to a real queued state", async () => {
  const { backend, state } = fixtureDocumentsBackend([
    documentItem({
      id: "doc-failed",
      filename: "failed.pdf",
      status: "failed",
      job: { id: "j4", status: "failed", attempts: 5, maxAttempts: 5, failureCode: "PARSE_FAILED", nextAttemptAt: null, chunkCount: null, updatedAt: 0 },
    }),
  ]);
  const user = userEvent.setup();
  renderScreen(backend);
  await screen.findByRole("heading", { name: "failed.pdf" });

  await user.click(screen.getByRole("button", { name: "Retry failed.pdf" }));
  expect(state.retried).toEqual(["doc-failed"]);
  expect(await screen.findByText("Waiting to process")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry failed.pdf" })).toBeNull();
});

test("a failed retry stays on screen with an announced, actionable error", async () => {
  const { backend, state } = fixtureDocumentsBackend([
    documentItem({
      id: "doc-failed",
      filename: "failed.pdf",
      status: "failed",
      job: { id: "j4", status: "failed", attempts: 5, maxAttempts: 5, failureCode: "PARSE_FAILED", nextAttemptAt: null, chunkCount: null, updatedAt: 0 },
    }),
  ]);
  state.failRetry = new ConvexError({ code: "RETRY_NOT_ALLOWED" });
  const user = userEvent.setup();
  renderScreen(backend);
  await screen.findByRole("heading", { name: "failed.pdf" });

  await user.click(screen.getByRole("button", { name: "Retry failed.pdf" }));
  const alert = await screen.findByRole("alert");
  expect(text(alert)).toContain("Delete it and upload a different file");
  expect(screen.getByRole("heading", { name: "failed.pdf" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry failed.pdf" })).toBeTruthy();
});

test("delete requires explicit confirmation with document copy; cancel is safe", async () => {
  const { backend, state } = fixtureDocumentsBackend([documentItem({ id: "d1", filename: "doomed.md" })]);
  const user = userEvent.setup();
  renderScreen(backend);
  await screen.findByRole("heading", { name: "doomed.md" });

  await user.click(screen.getByRole("button", { name: "Delete doomed.md" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(text(within(dialog).getByRole("heading", { name: "Delete “doomed.md”?" }))).toContain("Delete “doomed.md”?");
  expect(text(dialog)).toContain("Citations that point at it will show as unavailable");
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep document" }));

  await user.click(within(dialog).getByRole("button", { name: "Keep document" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(state.removed).toEqual([]);
  expect(screen.getByRole("heading", { name: "doomed.md" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Delete doomed.md" }));
  const reopened = await screen.findByRole("alertdialog");
  await user.click(within(reopened).getByRole("button", { name: "Delete document" }));
  await waitFor(() => expect(state.removed).toEqual(["d1"]));
  expect(await screen.findByRole("heading", { name: "No documents yet" })).toBeTruthy();
});

test("a failed delete keeps the dialog open with announced copy and can resume", async () => {
  const { backend, state } = fixtureDocumentsBackend([documentItem({ id: "d1", filename: "stuck.md" })]);
  state.failRemove = new Error("connection dropped");
  const user = userEvent.setup();
  renderScreen(backend);
  await screen.findByRole("heading", { name: "stuck.md" });

  await user.click(screen.getByRole("button", { name: "Delete stuck.md" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete document" }));
  const error = await within(dialog).findByRole("alert");
  expect(text(error)).toContain("That didn’t go through.");
  expect(screen.getByRole("heading", { name: "stuck.md" })).toBeTruthy();

  state.failRemove = null;
  await user.click(within(dialog).getByRole("button", { name: "Delete document" }));
  await waitFor(() => expect(state.removed).toEqual(["d1"]));
});

test("the list re-polls while a job is live, so the badge follows server truth", async () => {
  const { backend, state } = fixtureDocumentsBackend([
    documentItem({
      id: "doc-live",
      filename: "live.md",
      job: { id: "j", status: "running", attempts: 1, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: null, updatedAt: 0 },
    }),
  ]);
  renderScreen(backend, 10);
  await screen.findByText("Processing… (attempt 1 of 5)");

  // The ingestion cycle finishes server-side; the next poll shows it.
  state.items = [
    documentItem({
      id: "doc-live",
      filename: "live.md",
      status: "ready",
      job: { id: "j", status: "succeeded", attempts: 1, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: 3, updatedAt: 1 },
    }),
  ];
  expect(await screen.findByText("Ready · 3 sections", {}, { timeout: 3000 })).toBeTruthy();
});

test("a missing backend renders an explicit unavailable state instead of crashing", () => {
  render(<DocumentsScreen projectId="p1" backend={null} />);
  const alert = screen.getByRole("alert");
  expect(text(alert)).toContain("Document tools aren’t available");
  expect(screen.getByRole("link", { name: "Back to project" }).getAttribute("href")).toBe("#/projects/p1");
});

test("upload controls are reachable with Tab in reading order", async () => {
  const { backend } = fixtureDocumentsBackend([documentItem({ id: "d1", filename: "tabbed.md" })]);
  const user = userEvent.setup();
  renderScreen(backend);
  await screen.findByRole("heading", { name: "tabbed.md" });

  const reached: string[] = [];
  for (let step = 0; step < 8; step += 1) {
    await user.tab();
    const active = document.activeElement as HTMLElement | null;
    reached.push(active === null ? "" : active.getAttribute("aria-label") || active.textContent || active.id);
  }
  expect(reached.some((label) => label.includes("Back to project"))).toBe(true);
  expect(reached.some((label) => label.includes("document-upload"))).toBe(true);
  expect(reached.some((label) => label.includes("Delete tabbed.md"))).toBe(true);
});
