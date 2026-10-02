// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { ProjectsProvider } from "../src/data/ProjectsProvider.js";
import type { ProjectsBackend } from "../src/data/projects.js";
import { Dashboard } from "../src/screens/Dashboard.js";
import { fixtureBackend, project } from "./fixtures.js";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

function renderDashboard(backend: ProjectsBackend) {
  return render(
    <ProjectsProvider backend={backend}>
      <Dashboard />
    </ProjectsProvider>,
  );
}

const text = (node: Element | null | undefined): string => node?.textContent ?? "";

test("the loading state announces itself while the first load is pending", async () => {
  const { backend, state } = fixtureBackend();
  state.listMode = "pending";
  renderDashboard(backend);
  expect(screen.getByRole("status")).toBeTruthy();
  expect(text(screen.getByRole("status"))).toContain("Loading your projects…");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the error state is actionable: retry recovers and then lists projects", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Recoverable" })]);
  state.listMode = "error";
  const user = userEvent.setup();
  renderDashboard(backend);

  const alert = await screen.findByRole("alert");
  expect(text(alert)).toContain("Couldn’t load your projects.");
  state.listMode = "ok";
  await user.click(within(alert).getByRole("button", { name: "Try again" }));

  expect(await screen.findByRole("heading", { name: "Recoverable" })).toBeTruthy();
  expect(state.listCalls).toBeGreaterThanOrEqual(2);
});

test("the empty state gives a clear next step into onboarding", async () => {
  const { backend } = fixtureBackend();
  renderDashboard(backend);
  expect(await screen.findByRole("heading", { name: "Create your first project" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Start your first project" }).getAttribute("href")).toBe("#/projects/new");
  expect(screen.getByRole("link", { name: "New project" }).getAttribute("href")).toBe("#/projects/new");
});

test("projects render with goal, mode and per-card labelled actions", async () => {
  const { backend } = fixtureBackend([
    project({ id: "p1", name: "Spanish conversation", goal: "Chat about my weekend", mode: "language-practice" }),
    project({ id: "p2", name: "Linear algebra", mode: "concept-learning" }),
  ]);
  renderDashboard(backend);

  expect(await screen.findByRole("heading", { name: "Spanish conversation" })).toBeTruthy();
  expect(screen.getByText("Chat about my weekend")).toBeTruthy();
  expect(screen.getByText("Language practice")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Linear algebra" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Spanish conversation" }).getAttribute("href")).toBe("#/projects/p1");
  expect(screen.getByRole("button", { name: "Delete Spanish conversation" })).toBeTruthy();
});

test("delete requires explicit confirmation; cancel is safe and confirm removes", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Doomed project" })]);
  const user = userEvent.setup();
  renderDashboard(backend);
  await screen.findByRole("heading", { name: "Doomed project" });

  await user.click(screen.getByRole("button", { name: "Delete Doomed project" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(text(within(dialog).getByRole("heading", { name: "Delete “Doomed project”?" }))).toContain("Delete “Doomed project”?");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(text(within(dialog).getByText(/can’t be undone/))).toContain("can’t be undone");
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep project" }));

  await user.click(within(dialog).getByRole("button", { name: "Keep project" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(state.removed).toEqual([]);
  expect(screen.getByRole("heading", { name: "Doomed project" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Delete Doomed project" }));
  const reopened = await screen.findByRole("alertdialog");
  await user.click(within(reopened).getByRole("button", { name: "Delete project" }));

  await waitFor(() => expect(state.removed).toEqual(["p1"]));
  expect(await screen.findByRole("heading", { name: "Create your first project" })).toBeTruthy();
});

test("Escape fires the dialog cancel event and closes without deleting", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Escapable project" })]);
  const user = userEvent.setup();
  renderDashboard(backend);
  await screen.findByRole("heading", { name: "Escapable project" });

  await user.click(screen.getByRole("button", { name: "Delete Escapable project" }));
  const dialog = await screen.findByRole("alertdialog");
  dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true }));

  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(state.removed).toEqual([]);
});

test("a delete that fails before any state change stays in the dialog with an announced, retryable error", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Stuck project" })]);
  state.failRemove = new Error("fixture remove failed");
  const user = userEvent.setup();
  renderDashboard(backend);
  await screen.findByRole("heading", { name: "Stuck project" });

  await user.click(screen.getByRole("button", { name: "Delete Stuck project" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete project" }));

  const error = await within(dialog).findByRole("alert");
  expect(text(error)).toContain("That didn’t go through.");
  expect(screen.getByRole("heading", { name: "Stuck project" })).toBeTruthy();
  expect(state.softDeleted).toEqual([]);

  state.failRemove = null;
  await user.click(within(dialog).getByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(state.removed).toEqual(["p1"]));
});

test("a delete that fails after the soft-delete keeps the project visible and the retry finishes it", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Half-deleted project" })]);
  state.failRemoveMidDelete = new Error("connection dropped mid-cleanup");
  const user = userEvent.setup();
  renderDashboard(backend);
  await screen.findByRole("heading", { name: "Half-deleted project" });

  await user.click(screen.getByRole("button", { name: "Delete Half-deleted project" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete project" }));

  // The failure lands after the soft-delete, so the rows are stranded server-side:
  // the dialog must keep an announced, actionable error instead of hiding the card.
  const error = await within(dialog).findByRole("alert");
  expect(text(error)).toContain("That didn’t go through.");
  expect(text(error)).toContain("try again");
  expect(state.softDeleted).toEqual(["p1"]);
  expect(state.removed).toEqual([]);
  expect(screen.getByRole("heading", { name: "Half-deleted project" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Delete project" })).toBeTruthy();

  // The retry resumes the same cleanup: it completes once, with no orphan left behind.
  state.failRemoveMidDelete = null;
  await user.click(within(dialog).getByRole("button", { name: "Delete project" }));
  await waitFor(() => expect(state.removed).toEqual(["p1"]));
  expect(state.softDeleted).toEqual([]);
  expect(await screen.findByRole("heading", { name: "Create your first project" })).toBeTruthy();
});

test("every dashboard control is reachable with Tab in reading order", async () => {
  const { backend } = fixtureBackend([project({ id: "p1", name: "Keyboard project" })]);
  const user = userEvent.setup();
  renderDashboard(backend);
  await screen.findByRole("heading", { name: "Keyboard project" });

  const reached: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    await user.tab();
    const active = document.activeElement as HTMLElement | null;
    reached.push(active === null ? "" : (active.getAttribute("aria-label") ?? active.textContent ?? active.id));
  }
  expect(reached.some((label) => label.includes("New project"))).toBe(true);
  expect(reached.some((label) => label.includes("Open Keyboard project"))).toBe(true);
  expect(reached.some((label) => label.includes("Delete Keyboard project"))).toBe(true);
});
