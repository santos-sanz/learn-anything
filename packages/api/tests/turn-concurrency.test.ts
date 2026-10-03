import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import schema from "../convex/schema.js";
import { maxConcurrentTurns } from "../convex/tutor.js";
import { installAuthTestEnv, TEST_ISSUER } from "./helpers/authEnv.js";
import { termVector } from "./helpers/textVectors.js";

/**
 * S24 per-learner concurrent-turn cap: one learner may only hold
 * `MAX_CONCURRENT_TURNS` live running turns at a time, across every project.
 * Expired leases never count (a stale row cannot lock its owner out), the
 * same-turnId `in-progress` idempotency answer is unchanged, and a denied
 * start never reaches the provider. Synthetic fixtures and a mocked provider.
 */
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/embeddings.ts": () => import("../convex/embeddings.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
  "../convex/retrieval.ts": () => import("../convex/retrieval.js"),
  "../convex/stt.ts": () => import("../convex/stt.js"),
  "../convex/tutor.ts": () => import("../convex/tutor.js"),
};

const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });
const makeTest = () => convexTest({ schema, modules });
type TestInstance = ReturnType<typeof makeTest>;
const owner = (t: TestInstance, subject = "learner-a|s1") => t.withIdentity(identity(subject));

const originalFetch = globalThis.fetch;
let providerCalls: string[] = [];

beforeEach(() => {
  providerCalls = [];
  process.env.NAN_API_KEY = "synthetic-test-key";
  process.env.NAN_DEPLOYER_ID = "learner-a";
  process.env.TUTOR_RETRY_BASE_MS = "0";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    providerCalls.push(url);
    if (url.endsWith("/embeddings")) {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ model: "qwen3-embedding", data: (body.input ?? []).map((text) => ({ embedding: termVector(text) })) });
    }
    if (url.endsWith("/chat/completions")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "A grounded answer." } }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    throw new Error(`unexpected provider call: ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NAN_API_KEY;
  delete process.env.NAN_DEPLOYER_ID;
  delete process.env.TUTOR_RETRY_BASE_MS;
  delete process.env.MAX_CONCURRENT_TURNS;
});

async function seed(t: TestInstance): Promise<{ projectId: Id<"projects">; sessionId: Id<"learningSessions"> }> {
  const a = owner(t);
  const projectId = await a.mutation(api.projects.createProject, { name: "Concurrency" });
  const sessionId = await a.mutation(api.projects.createSession, { projectId, sessionKey: "s" });
  return { projectId, sessionId };
}

function begin(t: TestInstance, projectId: Id<"projects">, sessionId: Id<"learningSessions">, turnId: string) {
  return t.mutation(internal.tutor.beginTurn, {
    ownerId: "learner-a",
    projectId,
    sessionId,
    turnId,
    learnerText: "hello",
    leaseMs: 60_000,
  });
}

test("the concurrent-turn cap rejects a third live turn before any provider work", async () => {
  process.env.MAX_CONCURRENT_TURNS = "2";
  const t = makeTest();
  const { projectId, sessionId } = await seed(t);

  expect(await begin(t, projectId, sessionId, "turn-1")).toMatchObject({ state: "started" });
  expect(await begin(t, projectId, sessionId, "turn-2")).toMatchObject({ state: "started" });
  expect(await begin(t, projectId, sessionId, "turn-3")).toEqual({ state: "rate-limited" });

  await expect(
    owner(t).action(api.tutor.runTurn, { projectId, turnId: "turn-3", text: "third question" }),
  ).rejects.toThrow("TURN_CONCURRENCY_LIMIT");
  expect(providerCalls).toHaveLength(0);
});

test("the same turnId still answers in-progress while the cap is reached", async () => {
  process.env.MAX_CONCURRENT_TURNS = "2";
  const t = makeTest();
  const { projectId, sessionId } = await seed(t);
  await begin(t, projectId, sessionId, "turn-1");
  await begin(t, projectId, sessionId, "turn-2");

  // Idempotency first: a duplicate of a running turn is not a new turn.
  expect(await begin(t, projectId, sessionId, "turn-2")).toEqual({ state: "in-progress" });
});

test("an expired lease frees its slot instead of locking the learner out forever", async () => {
  process.env.MAX_CONCURRENT_TURNS = "2";
  const t = makeTest();
  const { projectId, sessionId } = await seed(t);
  const first = await begin(t, projectId, sessionId, "turn-1");
  await begin(t, projectId, sessionId, "turn-2");
  expect(await begin(t, projectId, sessionId, "turn-3")).toEqual({ state: "rate-limited" });

  // Simulate a crashed attempt: the lease is gone, so the slot is free.
  expect(first.state).toBe("started");
  if (first.state !== "started") throw new Error("unreachable");
  await t.run(async (ctx) => {
    const turn = await ctx.db
      .query("tutorTurns")
      .withIndex("by_owner_project_turn", (q) => q.eq("ownerId", "learner-a").eq("projectId", projectId).eq("turnId", "turn-1"))
      .unique();
    if (turn === null) throw new Error("missing turn");
    await ctx.db.patch(turn._id, { leaseExpiresAt: Date.now() - 1_000 });
  });

  expect(await begin(t, projectId, sessionId, "turn-3")).toMatchObject({ state: "started" });
});

test("a turn under the cap runs to completion and still records its telemetry", async () => {
  process.env.MAX_CONCURRENT_TURNS = "1";
  const t = makeTest();
  const { projectId } = await seed(t);

  const result = await owner(t).action(api.tutor.runTurn, { projectId, turnId: "turn-a", text: "first question" });
  expect(result.status).toBe("completed");
  const second = await owner(t).action(api.tutor.runTurn, { projectId, turnId: "turn-b", text: "second question" });
  expect(second.status).toBe("completed");

  const rows = await t.run(async (ctx) => ctx.db.query("telemetryEvents").collect());
  expect(rows.filter((row) => row.event === "tutor-turn" && row.status === "ok")).toHaveLength(2);
});

test("the cap is configurable with bounded fallbacks", () => {
  delete process.env.MAX_CONCURRENT_TURNS;
  expect(maxConcurrentTurns()).toBe(3);
  process.env.MAX_CONCURRENT_TURNS = "5";
  expect(maxConcurrentTurns()).toBe(5);
  process.env.MAX_CONCURRENT_TURNS = "0";
  expect(maxConcurrentTurns()).toBe(1);
  process.env.MAX_CONCURRENT_TURNS = "999";
  expect(maxConcurrentTurns()).toBe(10);
  process.env.MAX_CONCURRENT_TURNS = "junk";
  expect(maxConcurrentTurns()).toBe(3);
});
