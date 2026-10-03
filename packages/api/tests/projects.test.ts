import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { expectTypedCode } from "./helpers/typedError.js";

const modules = { "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"), "../convex/projects.ts": () => import("../convex/projects.js"), "../convex/files.ts": () => import("../convex/files.js") };
const identity = (subject: string) => ({ subject, issuer: "https://test.example" });

test("every public S05 function denies an anonymous caller", async () => {
  const t = convexTest({ schema, modules });
  const project = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null }));
  const session = await t.run(async (ctx) => ctx.db.insert("learningSessions", { ownerId: "a", projectId: project, sessionKey: "s", createdAt: 1, endedAt: null }));
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["fixture"]))) as never;
  const fileId = await t.run(async (ctx) => ctx.db.insert("privateFiles", { ownerId: "a", projectId: project, storageId, contentType: "text/plain", createdAt: 1 }));
  const calls = [t.mutation(api.projects.createProject, { name: "A" }), t.query(api.projects.listProjects, {}), t.query(api.projects.getProject, { projectId: project }), t.mutation(api.projects.updateProject, { projectId: project, name: "stolen" }), t.mutation(api.projects.createGoal, { projectId: project, title: "g" }), t.mutation(api.projects.createSession, { projectId: project, sessionKey: "s" }), t.mutation(api.projects.createMessage, { projectId: project, sessionId: session, turnId: "t", idempotencyKey: "k", role: "learner", content: "x" }), t.mutation(api.projects.recordProgress, { projectId: project, eventType: "done" }), t.query(api.projects.listProjectRecords, { projectId: project }), t.mutation(api.projects.requestProjectDeletion, { projectId: project }), t.mutation(api.projects.deleteProjectBatch, { projectId: project, limit: 1 }), t.mutation(api.files.registerPrivateFile, { projectId: project, storageId, contentType: "text/plain" }), t.query(api.files.getPrivateFile, { projectId: project, fileId })];
  for (const call of calls) await expectTypedCode(call, "UNAUTHENTICATED");
});

test("two-user matrix rejects foreign records and preserves server timestamps/dedupe", async () => {
  const t = convexTest({ schema, modules }); const a = t.withIdentity(identity("a")); const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" }); const projectB = await b.mutation(api.projects.createProject, { name: "B" }); const sessionA = await a.mutation(api.projects.createSession, { projectId: projectA, sessionKey: "session" });
  const foreign = [b.query(api.projects.listProjectRecords, { projectId: projectA }), b.query(api.projects.getProject, { projectId: projectA }), b.mutation(api.projects.updateProject, { projectId: projectA, name: "stolen" }), b.mutation(api.projects.createGoal, { projectId: projectA, title: "steal" }), b.mutation(api.projects.createSession, { projectId: projectA, sessionKey: "steal" }), b.mutation(api.projects.createMessage, { projectId: projectB, sessionId: sessionA, turnId: "t", idempotencyKey: "k", role: "learner", content: "steal" }), b.mutation(api.projects.recordProgress, { projectId: projectA, eventType: "steal" }), b.mutation(api.projects.requestProjectDeletion, { projectId: projectA }), b.mutation(api.projects.deleteProjectBatch, { projectId: projectA, limit: 1 })];
  for (const call of foreign) await expect(call).rejects.toThrow("NOT_FOUND");
  const input = { projectId: projectA, sessionId: sessionA, turnId: "t", idempotencyKey: "retry", role: "learner" as const, content: "hello" }; const first = await a.mutation(api.projects.createMessage, input); expect(await a.mutation(api.projects.createMessage, input)).toBe(first);
  const messages = await t.run(async (ctx) => ctx.db.query("messages").collect()); expect(messages).toHaveLength(1); expect(messages[0].createdAt).toEqual(expect.any(Number));
});

test("private-file authorization denies anonymous and foreign access while allowing its owner", async () => {
  const t = convexTest({ schema, modules }); const a = t.withIdentity(identity("a")); const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" }); const projectB = await b.mutation(api.projects.createProject, { name: "B" });
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["fixture"]))) as never;
  const file = await t.run(async (ctx) => ctx.db.insert("privateFiles", { ownerId: "a", projectId: projectA, storageId, contentType: "text/plain", createdAt: 1 }));
  await expect(a.query(api.files.getPrivateFile, { projectId: projectA, fileId: file })).resolves.toEqual({ storageId, contentType: "text/plain" });
  await expect(b.query(api.files.getPrivateFile, { projectId: projectB, fileId: file })).rejects.toThrow("NOT_FOUND");
  await expect(t.query(api.files.getPrivateFile, { projectId: projectA, fileId: file })).rejects.toThrow("UNAUTHENTICATED");
});

test("owner CRUD lifecycle: create with goal/mode, edit, clear goal, and two-phase delete", async () => {
  const t = convexTest({ schema, modules }); const a = t.withIdentity(identity("a")); const b = t.withIdentity(identity("b"));
  const projectId = await a.mutation(api.projects.createProject, { name: "  Spanish  ", goal: "  hold a five-minute chat  ", mode: "language-practice" });
  await expect(a.query(api.projects.getProject, { projectId })).resolves.toMatchObject({ name: "Spanish", goal: "hold a five-minute chat", mode: "language-practice", createdAt: expect.any(Number) });

  await a.mutation(api.projects.updateProject, { projectId, name: "Spanish verbs", mode: "concept-learning" });
  await expect(a.query(api.projects.getProject, { projectId })).resolves.toMatchObject({ name: "Spanish verbs", mode: "concept-learning" });
  await a.mutation(api.projects.updateProject, { projectId, goal: "" });
  const cleared = await a.query(api.projects.getProject, { projectId });
  expect(cleared.goal).toBeUndefined();
  expect(cleared.mode).toBe("concept-learning");
  await expect(a.query(api.projects.listProjects, {})).resolves.toHaveLength(1);
  await expect(b.query(api.projects.listProjects, {})).resolves.toEqual([]);

  const session = await a.mutation(api.projects.createSession, { projectId, sessionKey: "s" });
  await a.mutation(api.projects.createGoal, { projectId, title: "g" });
  await a.mutation(api.projects.createMessage, { projectId, sessionId: session, turnId: "t", idempotencyKey: "k", role: "learner", content: "x" });
  await a.mutation(api.projects.recordProgress, { projectId, eventType: "done" });

  await a.mutation(api.projects.requestProjectDeletion, { projectId });
  await expect(a.query(api.projects.getProject, { projectId })).rejects.toThrow("NOT_FOUND");
  await expect(a.query(api.projects.listProjects, {})).resolves.toEqual([]);
  const firstBatch = await a.mutation(api.projects.deleteProjectBatch, { projectId, limit: 2 });
  expect(firstBatch).toMatchObject({ completed: false, deleted: 2 });
  const retry = await a.mutation(api.projects.deleteProjectBatch, { projectId, limit: 2 });
  expect(retry).toMatchObject({ completed: true, deleted: 2 });
  await expect(a.mutation(api.projects.deleteProjectBatch, { projectId, limit: 2 })).rejects.toThrow("NOT_FOUND");
  const leftovers = await t.run(async (ctx) => ({ projects: await ctx.db.get(projectId), goals: await ctx.db.query("learningGoals").collect(), sessions: await ctx.db.query("learningSessions").collect(), messages: await ctx.db.query("messages").collect(), events: await ctx.db.query("progressEvents").collect() }));
  expect(leftovers).toEqual({ projects: null, goals: [], sessions: [], messages: [], events: [] });
});

test("goal/mode selection accepts exactly the two S21 learner tracks", async () => {
  const t = convexTest({ schema, modules }); const a = t.withIdentity(identity("a"));
  const language = await a.mutation(api.projects.createProject, { name: "Language", mode: "language-practice" });
  const concept = await a.mutation(api.projects.createProject, { name: "Concept", mode: "concept-learning" });
  await expect(a.query(api.projects.getProject, { projectId: language })).resolves.toMatchObject({ mode: "language-practice" });
  await expect(a.query(api.projects.getProject, { projectId: concept })).resolves.toMatchObject({ mode: "concept-learning" });
  await expect(a.mutation(api.projects.createProject, { name: "Invalid", mode: "quiz" as never })).rejects.toThrow();
  await expect(a.mutation(api.projects.updateProject, { projectId: language, mode: "tutor" as never })).rejects.toThrow();
});

test("createProject and updateProject reject empty and whitespace-only names", async () => {
  const t = convexTest({ schema, modules }); const a = t.withIdentity(identity("a"));
  const blank = ["", "   ", " \t\n ", "\u00a0\u00a0"];
  for (const name of blank) await expect(a.mutation(api.projects.createProject, { name })).rejects.toThrow("INVALID_ARGUMENT");
  const projectId = await a.mutation(api.projects.createProject, { name: "Keep me" });
  for (const name of blank) await expect(a.mutation(api.projects.updateProject, { projectId, name })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(a.mutation(api.projects.createProject, { name: "x".repeat(101) })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(a.mutation(api.projects.updateProject, { projectId, name: "y".repeat(101) })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(a.query(api.projects.getProject, { projectId })).resolves.toMatchObject({ name: "Keep me" });
  await expect(a.query(api.projects.listProjects, {})).resolves.toHaveLength(1);
});

test("an interrupted deletion resumes: the soft-delete re-run succeeds and the batches finish with no orphans", async () => {
  const t = convexTest({ schema, modules }); const a = t.withIdentity(identity("a")); const b = t.withIdentity(identity("b"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Resume me", goal: "hold a five-minute chat", mode: "language-practice" });
  const session = await a.mutation(api.projects.createSession, { projectId, sessionKey: "s" });
  await a.mutation(api.projects.createGoal, { projectId, title: "g" });
  await a.mutation(api.projects.createMessage, { projectId, sessionId: session, turnId: "t", idempotencyKey: "k", role: "learner", content: "x" });
  await a.mutation(api.projects.recordProgress, { projectId, eventType: "done" });

  await a.mutation(api.projects.requestProjectDeletion, { projectId });
  // The client dies after one bounded batch: the soft-delete landed, the cleanup did not.
  expect(await a.mutation(api.projects.deleteProjectBatch, { projectId, limit: 1 })).toMatchObject({ completed: false, deleted: 1 });
  await expect(a.query(api.projects.listProjects, {})).resolves.toEqual([]);

  // A retry re-enters through the soft-delete step, which must not fail NOT_FOUND,
  // and idempotency never widens the owner boundary.
  await expect(a.mutation(api.projects.requestProjectDeletion, { projectId })).resolves.toBe(null);
  await expect(b.mutation(api.projects.requestProjectDeletion, { projectId })).rejects.toThrow("NOT_FOUND");
  await expect(t.mutation(api.projects.requestProjectDeletion, { projectId })).rejects.toThrow("UNAUTHENTICATED");

  let completed = false;
  for (let attempt = 0; attempt < 10 && !completed; attempt += 1) completed = (await a.mutation(api.projects.deleteProjectBatch, { projectId, limit: 1 })).completed;
  expect(completed).toBe(true);
  const leftovers = await t.run(async (ctx) => ({ project: await ctx.db.get(projectId), goals: await ctx.db.query("learningGoals").collect(), sessions: await ctx.db.query("learningSessions").collect(), messages: await ctx.db.query("messages").collect(), events: await ctx.db.query("progressEvents").collect() }));
  expect(leftovers).toEqual({ project: null, goals: [], sessions: [], messages: [], events: [] });

  // Once the row is hard-deleted nothing can restart it; the client maps this
  // NOT_FOUND to "already deleted" instead of an error.
  await expect(a.mutation(api.projects.requestProjectDeletion, { projectId })).rejects.toThrow("NOT_FOUND");
  await expect(a.mutation(api.projects.deleteProjectBatch, { projectId, limit: 1 })).rejects.toThrow("NOT_FOUND");
});
