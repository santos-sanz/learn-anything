import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";

const modules = { "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"), "../convex/projects.ts": () => import("../convex/projects.js"), "../convex/files.ts": () => import("../convex/files.js") };
const identity = (subject: string) => ({ subject, issuer: "https://test.example" });

test("every public S05 function denies an anonymous caller", async () => {
  const t = convexTest({ schema, modules });
  const project = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId: "a", name: "A", createdAt: 1, deletedAt: null }));
  const session = await t.run(async (ctx) => ctx.db.insert("learningSessions", { ownerId: "a", projectId: project, sessionKey: "s", createdAt: 1, endedAt: null }));
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["fixture"]))) as never;
  const fileId = await t.run(async (ctx) => ctx.db.insert("privateFiles", { ownerId: "a", projectId: project, storageId, contentType: "text/plain", createdAt: 1 }));
  const calls = [t.mutation(api.projects.createProject, { name: "A" }), t.query(api.projects.listProjects, {}), t.mutation(api.projects.createGoal, { projectId: project, title: "g" }), t.mutation(api.projects.createSession, { projectId: project, sessionKey: "s" }), t.mutation(api.projects.createMessage, { projectId: project, sessionId: session, turnId: "t", idempotencyKey: "k", role: "learner", content: "x" }), t.mutation(api.projects.recordProgress, { projectId: project, eventType: "done" }), t.query(api.projects.listProjectRecords, { projectId: project }), t.mutation(api.projects.requestProjectDeletion, { projectId: project }), t.mutation(api.projects.deleteProjectBatch, { projectId: project, limit: 1 }), t.mutation(api.files.registerPrivateFile, { projectId: project, storageId, contentType: "text/plain" }), t.query(api.files.getPrivateFile, { projectId: project, fileId })];
  for (const call of calls) await expect(call).rejects.toThrow("UNAUTHENTICATED");
});

test("two-user matrix rejects foreign records and preserves server timestamps/dedupe", async () => {
  const t = convexTest({ schema, modules }); const a = t.withIdentity(identity("a")); const b = t.withIdentity(identity("b"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" }); const projectB = await b.mutation(api.projects.createProject, { name: "B" }); const sessionA = await a.mutation(api.projects.createSession, { projectId: projectA, sessionKey: "session" });
  const foreign = [b.query(api.projects.listProjectRecords, { projectId: projectA }), b.mutation(api.projects.createGoal, { projectId: projectA, title: "steal" }), b.mutation(api.projects.createSession, { projectId: projectA, sessionKey: "steal" }), b.mutation(api.projects.createMessage, { projectId: projectB, sessionId: sessionA, turnId: "t", idempotencyKey: "k", role: "learner", content: "steal" }), b.mutation(api.projects.recordProgress, { projectId: projectA, eventType: "steal" }), b.mutation(api.projects.requestProjectDeletion, { projectId: projectA }), b.mutation(api.projects.deleteProjectBatch, { projectId: projectA, limit: 1 })];
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
