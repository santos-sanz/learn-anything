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

test("routes serialize for links and navigation", () => {
  expect(serializeRoute({ name: "dashboard" })).toBe("#/projects");
  expect(serializeRoute({ name: "new-project" })).toBe("#/projects/new");
  expect(serializeRoute({ name: "project", id: "p1" })).toBe("#/projects/p1");
  expect(parseRoute(serializeRoute({ name: "project", id: "a b" }))).toEqual({ name: "project", id: "a b" });
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
