// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";

import { ProjectForm } from "../src/components/ProjectForm.js";
import { toDraft, toPatch, validateProjectForm } from "../src/view.js";
import type { ProjectFormValues } from "../src/view.js";

afterEach(cleanup);

test("every control is programmatically labelled and grouped", () => {
  render(<ProjectForm submitLabel="Create project" busy={false} error={null} requireMode onSubmit={() => undefined} onCancel={() => undefined} />);
  expect(screen.getByRole("group", { name: "Project details" })).toBeTruthy();
  expect(screen.getByLabelText("Project name")).toBeTruthy();
  expect(screen.getByLabelText("Learning goal")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Learning mode" })).toBeTruthy();
  expect(screen.getByLabelText("Language practice")).toBeTruthy();
  expect(screen.getByLabelText("Concept learning")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create project" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
});

test("empty required fields block submission, announce errors and focus the first invalid input", async () => {
  const user = userEvent.setup();
  let submitted: ProjectFormValues | null = null;
  render(<ProjectForm submitLabel="Create project" busy={false} error={null} requireMode onSubmit={(values) => {
    submitted = values;
  }} />);

  await user.click(screen.getByRole("button", { name: "Create project" }));

  expect(submitted).toBeNull();
  expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual(["Enter a project name.", "Choose a learning mode."]);
  expect(document.activeElement).toBe(screen.getByLabelText("Project name"));
});

test("a valid submission sends trimmed values with the selected mode", async () => {
  const user = userEvent.setup();
  let submitted: ProjectFormValues | null = null;
  render(<ProjectForm submitLabel="Create project" busy={false} error={null} requireMode onSubmit={(values) => {
    submitted = values;
  }} />);

  await user.type(screen.getByLabelText("Project name"), "  Spanish verbs  ");
  await user.type(screen.getByLabelText(/^Learning goal/), " master the subjunctive ");
  await user.click(screen.getByLabelText("Language practice"));
  await user.click(screen.getByRole("button", { name: "Create project" }));

  expect(submitted).toEqual({ name: "  Spanish verbs  ", goal: " master the subjunctive ", mode: "language-practice" });
  expect(toDraft(submitted!)).toEqual({ name: "Spanish verbs", goal: "master the subjunctive", mode: "language-practice" });
});

test("the busy state disables editing and announces progress on the submit button", () => {
  render(<ProjectForm submitLabel="Save changes" busy error={null} requireMode={false} onSubmit={() => undefined} onCancel={() => undefined} />);
  expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Project name") as HTMLInputElement).disabled).toBe(true);
});

test("a server error is announced while the typed values stay intact", async () => {
  const user = userEvent.setup();
  render(<ProjectForm submitLabel="Save changes" busy={false} error={"That didn’t go through. Check your connection and try again."} requireMode={false} onSubmit={() => undefined} />);
  expect(screen.getByRole("alert").textContent).toContain("That didn’t go through.");
  await user.type(screen.getByLabelText("Project name"), "kept");
  expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("kept");
});

test("validation, draft and patch helpers implement the S21 field rules", () => {
  expect(validateProjectForm({ name: " ", goal: "", mode: null }, { requireMode: true })).toEqual({ name: "Enter a project name.", mode: "Choose a learning mode." });
  expect(validateProjectForm({ name: "ok", goal: "x".repeat(501), mode: null }, { requireMode: false })).toEqual({ goal: "Use 500 characters or fewer." });
  expect(toPatch({ name: " n ", goal: "", mode: "concept-learning" })).toEqual({ name: "n", goal: "", mode: "concept-learning" });
  expect(toPatch({ name: "n", goal: "", mode: null })).toEqual({ name: "n", goal: "" });
  expect(toDraft({ name: "n", goal: "   ", mode: null })).toEqual({ name: "n" });
});
