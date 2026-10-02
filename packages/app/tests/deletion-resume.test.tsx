// @vitest-environment jsdom
import { getFunctionName } from "convex/server";
import { convexTest } from "convex-test";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { makeConvexProjectsBackend } from "../src/data/projects.js";
import { Root, type AuthSession } from "../src/Root.js";
import { asConvexClient } from "./fixtures.js";

/**
 * Resumable deletion, end to end: the real S21 screens drive the real
 * authorized Convex functions in-process (convex-test) and the delete loop is
 * interrupted after the soft-delete landed, which is the failure the review
 * flagged. The retry must finish the cleanup instead of returning NOT_FOUND,
 * and no row may be left orphaned. No deployment, credentials or network.
 */
const modules = {
  "../../api/convex/_generated/api.ts": () => import("../../api/convex/_generated/api.js"),
  "../../api/convex/projects.ts": () => import("../../api/convex/projects.js"),
};

const identity = (subject: string) => ({ subject, issuer: "https://test.example" });

function session(): AuthSession {
  return { isLoading: false, isAuthenticated: true, signIn: async () => undefined, signOut: async () => undefined };
}

async function seedProject(t: ReturnType<typeof convexTest>, name: string) {
  const owner = t.withIdentity(identity("learner-a"));
  const projectId = await owner.mutation(api.projects.createProject, { name, goal: "hold a five-minute chat", mode: "language-practice" });
  const sessionId = await owner.mutation(api.projects.createSession, { projectId, sessionKey: "s" });
  await owner.mutation(api.projects.createGoal, { projectId, title: "g" });
  await owner.mutation(api.projects.createMessage, { projectId, sessionId, turnId: "t", idempotencyKey: "k", role: "learner", content: "hello" });
  await owner.mutation(api.projects.recordProgress, { projectId, eventType: "done" });
  return projectId;
}

async function leftovers(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    projects: await ctx.db.query("projects").collect(),
    goals: await ctx.db.query("learningGoals").collect(),
    sessions: await ctx.db.query("learningSessions").collect(),
    messages: await ctx.db.query("messages").collect(),
    events: await ctx.db.query("progressEvents").collect(),
  }));
}

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
});

test("a mid-deletion failure stays actionable in the dialog and the retry finishes with no orphan", async () => {
  const t = convexTest({ schema, modules });
  const projectId = await seedProject(t, "Flaky cleanup");
  const owner = t.withIdentity(identity("learner-a"));
  const serverQuery = owner.query as unknown as (fn: unknown, args: unknown) => Promise<unknown>;
  const serverMutation = owner.mutation as unknown as (fn: unknown, args: unknown) => Promise<unknown>;

  // Fail the first bounded batch, i.e. after `requestProjectDeletion` soft-deleted the root.
  let batchCalls = 0;
  const flaky = {
    query: (fn: unknown, args: unknown) => serverQuery(fn, args),
    mutation: async (fn: unknown, args: unknown) => {
      if (getFunctionName(fn as never) === "projects:deleteProjectBatch") {
        batchCalls += 1;
        if (batchCalls === 1) throw new Error("connection reset while deleting records");
      }
      return serverMutation(fn, args);
    },
  };

  const user = userEvent.setup();
  render(<Root session={session()} backend={makeConvexProjectsBackend(asConvexClient(flaky))} />);
  await user.click(await screen.findByRole("button", { name: "Delete Flaky cleanup" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete project" }));

  // The interruption happened after the soft-delete: the server already hides the
  // project from the next list load, so the open dialog is the recovery path.
  const error = await within(dialog).findByRole("alert");
  expect(error.textContent).toContain("That didn’t go through.");
  expect(screen.getByRole("heading", { name: "Flaky cleanup" })).toBeTruthy();
  expect(await owner.query(api.projects.listProjects, {})).toEqual([]);
  const stranded = await leftovers(t);
  expect(stranded.projects.map((row) => row._id)).toEqual([projectId]);
  expect(stranded.messages).toHaveLength(1);

  // The retry re-issues the whole flow: without the idempotent soft-delete step
  // this rejects NOT_FOUND and the project would stay orphaned forever.
  await user.click(within(dialog).getByRole("button", { name: "Delete project" }));
  await screen.findByRole("heading", { name: "Create your first project" });
  expect(batchCalls).toBeGreaterThanOrEqual(2);
  expect(await leftovers(t)).toEqual({ projects: [], goals: [], sessions: [], messages: [], events: [] });
});

test("re-running a finished deletion resolves as already deleted instead of failing", async () => {
  const t = convexTest({ schema, modules });
  const projectId = await seedProject(t, "Gone already");
  const backend = makeConvexProjectsBackend(asConvexClient(t.withIdentity(identity("learner-a"))));

  await backend.remove(projectId);
  expect(await leftovers(t)).toEqual({ projects: [], goals: [], sessions: [], messages: [], events: [] });
  await expect(backend.remove(projectId)).resolves.toBeUndefined();
  await expect(backend.remove(projectId)).resolves.toBeUndefined();
  expect(await leftovers(t)).toEqual({ projects: [], goals: [], sessions: [], messages: [], events: [] });
});
