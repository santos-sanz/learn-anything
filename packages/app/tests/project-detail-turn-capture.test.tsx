// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
  expect(screen.getByRole("button", { name: "Record a turn" })).toBeTruthy();
  expect(screen.getByLabelText("Input language")).toBeTruthy();
  expect(screen.getByText(/Turns are limited to 60 seconds/)).toBeTruthy();
});
