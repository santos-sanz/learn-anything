// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { ProjectsProvider } from "../src/data/ProjectsProvider.js";
import type { ProjectsBackend } from "../src/data/projects.js";
import { ProjectDetail } from "../src/screens/ProjectDetail.js";
import { fixtureBackend, project } from "./fixtures.js";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

function renderDetail(backend: ProjectsBackend, id: string) {
  return render(
    <ProjectsProvider backend={backend}>
      <ProjectDetail id={id} />
    </ProjectsProvider>,
  );
}

test("the detail view loads one project and prefills the edit form", async () => {
  const { backend } = fixtureBackend([project({ id: "p1", name: "Spanish conversation", goal: "Chat about weekends", mode: "language-practice" })]);
  renderDetail(backend, "p1");

  expect(screen.getByRole("status").textContent).toContain("Loading project…");
  expect(await screen.findByRole("heading", { level: 1, name: "Spanish conversation" })).toBeTruthy();
  expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Spanish conversation");
  expect((screen.getByLabelText("Learning goal") as HTMLTextAreaElement).value).toBe("Chat about weekends");
  expect((screen.getByLabelText("Language practice") as HTMLInputElement).checked).toBe(true);
  expect(screen.getAllByText("Language practice").length).toBeGreaterThanOrEqual(2);
});

test("saving edits name and goal with confirmation of success", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Old name", goal: "Old goal" })]);
  const user = userEvent.setup();
  renderDetail(backend, "p1");
  await screen.findByRole("heading", { level: 1, name: "Old name" });

  const nameInput = screen.getByLabelText("Project name");
  await user.clear(nameInput);
  await user.type(nameInput, "New name");
  const goalInput = screen.getByLabelText("Learning goal");
  await user.clear(goalInput);
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(state.updated).toHaveLength(1));
  expect(state.updated[0]).toEqual({ id: "p1", patch: { name: "New name", goal: "" } });
  expect(await screen.findByRole("heading", { level: 1, name: "New name" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Changes saved.");
  expect(screen.queryByText("Old goal")).toBeNull();
});

test("saving without a name is blocked with an announced error and no backend call", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Keep me" })]);
  const user = userEvent.setup();
  renderDetail(backend, "p1");
  await screen.findByRole("heading", { level: 1, name: "Keep me" });

  await user.clear(screen.getByLabelText("Project name"));
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  expect(screen.getByRole("alert").textContent).toContain("Enter a project name.");
  expect(document.activeElement).toBe(screen.getByLabelText("Project name"));
  expect(state.updated).toEqual([]);
});

test("a failed save surfaces a safe retryable message without losing edits", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Fragile" })]);
  state.failUpdate = new Error("secret backend detail");
  const user = userEvent.setup();
  renderDetail(backend, "p1");
  await screen.findByRole("heading", { level: 1, name: "Fragile" });

  const nameInput = screen.getByLabelText("Project name");
  await user.clear(nameInput);
  await user.type(nameInput, "Fragile v2");
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Check your connection and try again");
  expect(alert.textContent).not.toContain("secret backend detail");
  expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Fragile v2");

  state.failUpdate = null;
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(state.updated).toHaveLength(1));
  expect(screen.getByRole("status").textContent).toContain("Changes saved.");
});

test("a missing or foreign project shows a non-enumerating message with a way back", async () => {
  const { backend } = fixtureBackend();
  renderDetail(backend, "does-not-exist");

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("doesn’t exist or isn’t yours");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  const back = within(alert).getByRole("link", { name: "Back to your projects" });
  expect(back.getAttribute("href")).toBe("#/projects");
});

test("a load failure keeps a retry that recovers without a reload", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Flaky load" })]);
  state.failGet = true;
  const user = userEvent.setup();
  renderDetail(backend, "p1");

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn’t load this project.");
  state.failGet = false;
  await user.click(within(alert).getByRole("button", { name: "Try again" }));

  expect(await screen.findByRole("heading", { level: 1, name: "Flaky load" })).toBeTruthy();
});

test("deleting from the detail view requires confirmation and returns to the dashboard", async () => {
  const { backend, state } = fixtureBackend([project({ id: "p1", name: "Deletable" })]);
  const user = userEvent.setup();
  renderDetail(backend, "p1");
  await screen.findByRole("heading", { level: 1, name: "Deletable" });

  await user.click(screen.getByRole("button", { name: "Delete this project" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("heading", { name: "Delete “Deletable”?" })).toBeTruthy();

  await user.click(within(dialog).getByRole("button", { name: "Keep project" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(state.removed).toEqual([]);

  await user.click(screen.getByRole("button", { name: "Delete this project" }));
  const reopened = await screen.findByRole("alertdialog");
  await user.click(within(reopened).getByRole("button", { name: "Delete project" }));

  await waitFor(() => expect(state.removed).toEqual(["p1"]));
  expect(window.location.hash).toBe("#/projects");
});
