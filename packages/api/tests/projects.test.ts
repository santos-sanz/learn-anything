import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/migrations.ts": () => import("../convex/migrations.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
};

test("owner/project indexes return only the owned project sessions", async () => {
  const t = convexTest({ schema, modules });
  const projectA = await t.mutation(internal.projects.createProject, { actorUserId: "user-a", name: "A" });
  const projectB = await t.mutation(internal.projects.createProject, { actorUserId: "user-b", name: "B" });
  await t.mutation(internal.projects.createSession, { actorUserId: "user-a", projectId: projectA, sessionKey: "a-1" });
  await t.mutation(internal.projects.createSession, { actorUserId: "user-b", projectId: projectB, sessionKey: "b-1" });
  await expect(t.query(internal.projects.listProjectSessions, { actorUserId: "user-a", projectId: projectA })).resolves.toEqual([{ _id: expect.any(String), sessionKey: "a-1" }]);
  await expect(t.query(internal.projects.listProjectSessions, { actorUserId: "user-a", projectId: projectB })).rejects.toThrow("Project not found or not owned by caller.");
});

test("cross-owner project and session references are rejected", async () => {
  const t = convexTest({ schema, modules });
  const projectA = await t.mutation(internal.projects.createProject, { actorUserId: "user-a", name: "A" });
  const projectB = await t.mutation(internal.projects.createProject, { actorUserId: "user-b", name: "B" });
  const sessionA = await t.mutation(internal.projects.createSession, { actorUserId: "user-a", projectId: projectA, sessionKey: "a-1" });
  await expect(t.mutation(internal.projects.createGoal, { actorUserId: "user-b", projectId: projectA, title: "steal" })).rejects.toThrow("Project not found or not owned by caller.");
  await expect(t.mutation(internal.projects.createMessage, { actorUserId: "user-a", projectId: projectA, sessionId: sessionA, turnId: "turn-1", idempotencyKey: "retry-1", role: "learner", content: "hi" })).resolves.toEqual(expect.any(String));
  await expect(t.mutation(internal.projects.createMessage, { actorUserId: "user-b", projectId: projectB, sessionId: sessionA, turnId: "turn-1", idempotencyKey: "retry-2", role: "learner", content: "steal" })).rejects.toThrow("Session not found in caller project.");
});

test("message retry deduplicates by the owner/project idempotency key", async () => {
  const t = convexTest({ schema, modules });
  const project = await t.mutation(internal.projects.createProject, { actorUserId: "user-a", name: "A" });
  const session = await t.mutation(internal.projects.createSession, { actorUserId: "user-a", projectId: project, sessionKey: "s-1" });
  const input = { actorUserId: "user-a", projectId: project, sessionId: session, turnId: "stable-turn", idempotencyKey: "network-retry", role: "learner" as const, content: "hello" };
  const first = await t.mutation(internal.projects.createMessage, input);
  expect(await t.mutation(internal.projects.createMessage, input)).toBe(first);
  const messages = await t.run(async (ctx) => ctx.db.query("messages").collect());
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ turnId: "stable-turn", createdAt: expect.any(Number) });
});

test("invalid validator input and project deletion cascade are enforced", async () => {
  const t = convexTest({ schema, modules });
  await expect(t.mutation(internal.projects.createProject, { actorUserId: 42, name: "bad" } as never)).rejects.toThrow();
  const project = await t.mutation(internal.projects.createProject, { actorUserId: "user-a", name: "A" });
  const session = await t.mutation(internal.projects.createSession, { actorUserId: "user-a", projectId: project, sessionKey: "s-1" });
  await t.mutation(internal.projects.createGoal, { actorUserId: "user-a", projectId: project, title: "goal" });
  await t.mutation(internal.projects.createMessage, { actorUserId: "user-a", projectId: project, sessionId: session, turnId: "turn-1", idempotencyKey: "key-1", role: "learner", content: "hi" });
  await t.mutation(internal.projects.recordProgress, { actorUserId: "user-a", projectId: project, eventType: "completed" });
  await t.mutation(internal.projects.requestProjectDeletion, { actorUserId: "user-a", projectId: project });
  expect(await t.mutation(internal.projects.deleteProjectBatch, { actorUserId: "user-a", projectId: project, limit: 100 })).toMatchObject({ completed: true, deleted: 4 });
  const state = await t.run(async (ctx) => Promise.all([ctx.db.get(project), ctx.db.query("learningGoals").collect(), ctx.db.query("learningSessions").collect(), ctx.db.query("messages").collect(), ctx.db.query("progressEvents").collect()]));
  expect(state).toEqual([null, [], [], [], []]);
});
