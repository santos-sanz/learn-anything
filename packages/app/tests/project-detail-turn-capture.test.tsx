// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { ProjectsProvider } from "../src/data/ProjectsProvider.js";
import { ProjectDetail } from "../src/screens/ProjectDetail.js";
import { fixtureBackend, project } from "./fixtures.js";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

test("the project detail screen hosts the microphone turn for that project", async () => {
  const { backend } = fixtureBackend([project({ id: "p1", name: "Spanish conversation" })]);

  render(
    <ProjectsProvider backend={backend}>
      <ProjectDetail id="p1" />
    </ProjectsProvider>,
  );

  expect(await screen.findByRole("heading", { level: 1, name: "Spanish conversation" })).toBeTruthy();
  expect(await screen.findByRole("region", { name: "Microphone turn" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 3, name: "Microphone turn" })).toBeTruthy();
  expect(screen.getByText(/Turns are limited to 60 seconds/)).toBeTruthy();
});

test("the turn asks for an explicit action before anything can be recorded", async () => {
  const user = userEvent.setup();
  const { backend } = fixtureBackend([project({ id: "p1", name: "Spanish conversation" })]);

  render(
    <ProjectsProvider backend={backend}>
      <ProjectDetail id="p1" />
    </ProjectsProvider>,
  );

  const panel = await screen.findByRole("region", { name: "Microphone turn" });
  const radios = within(panel).getAllByRole("radio");
  expect(radios).toHaveLength(3);
  expect(screen.getByRole("radio", { name: /Transcribe speech/ })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Translate audio/ })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Translate text/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Record a turn" })).toBeNull();

  await user.click(screen.getByRole("radio", { name: /Transcribe speech/ }));
  expect(screen.getByRole("button", { name: "Record a turn" })).toBeTruthy();
  expect(screen.getByLabelText("Input language")).toBeTruthy();
});
