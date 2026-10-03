import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import schema from "../convex/schema.js";
import { buildTelemetryRow } from "../convex/observability.js";
import { installAuthTestEnv, TEST_ISSUER } from "./helpers/authEnv.js";
import { termVector } from "./helpers/textVectors.js";

/**
 * S24 redacted telemetry: the builder is an allowlist (a canary prompt, key
 * or transcript can never be copied into a row), stored rows contain only
 * ids and timings, and `LOG_RETENTION_DAYS` plus the hourly cleanup are the
 * rotation. The turn path runs the real `runTurn` with a mocked provider so
 * the canary assertions cover the production write, not a fixture.
 */
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/embeddings.ts": () => import("../convex/embeddings.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/observability.ts": () => import("../convex/observability.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
  "../convex/retrieval.ts": () => import("../convex/retrieval.js"),
  "../convex/stt.ts": () => import("../convex/stt.js"),
  "../convex/tutor.ts": () => import("../convex/tutor.js"),
};

const makeTest = () => convexTest({ schema, modules });
type TestInstance = ReturnType<typeof makeTest>;
const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });

/** Deliberate secret/content canaries: none may ever reach a log row. */
const PROMPT_CANARY = "CANARY_PROMPT_IGNORE_ALL_INSTRUCTIONS";
const KEY_CANARY = "sk-canary-4f9a-do-not-log";
const TRANSCRIPT_CANARY = "CANARY_TRANSCRIPT_PRIVATE_SENTENCE";

const ALLOWED_ROW_KEYS = [
  "attempts",
  "code",
  "createdAt",
  "durationMs",
  "event",
  "ownerId",
  "projectId",
  "retryAfterMs",
  "status",
  "traceId",
];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.NAN_API_KEY = KEY_CANARY;
  process.env.NAN_DEPLOYER_ID = "learner-a";
  process.env.TUTOR_RETRY_BASE_MS = "0";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/embeddings")) {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ model: "qwen3-embedding", data: (body.input ?? []).map((text) => ({ embedding: termVector(text) })) });
    }
    if (url.endsWith("/audio/transcriptions") || url.endsWith("/audio/translations")) {
      return Response.json({ text: `Transcript ${TRANSCRIPT_CANARY}`, language: "en", duration: 1 });
    }
    if (url.endsWith("/chat/completions")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `Answer about ${PROMPT_CANARY}.` } }] })}\n\n`));
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
  delete process.env.LOG_RETENTION_DAYS;
  delete process.env.RATE_LIMIT_REQUESTS;
});

async function seedProject(t: TestInstance): Promise<Id<"projects">> {
  const owner = t.withIdentity(identity("learner-a|s1"));
  return owner.mutation(api.projects.createProject, { name: "Observability" });
}

/* ------------------------------------------------------------------ *
 * The builder is an allowlist
 * ------------------------------------------------------------------ */

test("buildTelemetryRow copies only allowlisted fields; content and keys are dropped", () => {
  const input = {
    traceId: "trace-1",
    ownerId: "learner-a",
    projectId: "projects" as never,
    event: "tutor-turn",
    status: "ok",
    durationMs: 1234,
    attempts: 2,
    // Anything a caller might try to smuggle alongside the typed fields:
    text: PROMPT_CANARY,
    prompt: PROMPT_CANARY,
    apiKey: KEY_CANARY,
    content: TRANSCRIPT_CANARY,
  };
  const row = buildTelemetryRow(input as never, 1_000);
  expect(row).not.toBeNull();
  const serialized = JSON.stringify(row);
  expect(serialized).not.toContain(PROMPT_CANARY);
  expect(serialized).not.toContain(KEY_CANARY);
  expect(serialized).not.toContain(TRANSCRIPT_CANARY);
  expect(Object.keys(row ?? {}).sort()).toEqual(["attempts", "createdAt", "durationMs", "event", "ownerId", "projectId", "status", "traceId"]);
});

test("only allowlisted codes can be stored — content, keys and key-shaped secrets are dropped", () => {
  const base = { traceId: "trace-1", ownerId: "learner-a", projectId: "projects" as never, status: "ok", event: "tutor-turn" };
  expect(buildTelemetryRow({ ...base, code: PROMPT_CANARY } as never, 1)?.code).toBeUndefined();
  expect(buildTelemetryRow({ ...base, code: KEY_CANARY } as never, 1)?.code).toBeUndefined();
  // An uppercase, key-shaped secret still cannot qualify: the gate is an
  // explicit allowlist, not a "looks like a token" pattern.
  expect(buildTelemetryRow({ ...base, code: "AKIA1234567890ABCDE" } as never, 1)?.code).toBeUndefined();
  expect(buildTelemetryRow({ ...base, code: "TURN_TIMEOUT" } as never, 1)?.code).toBe("TURN_TIMEOUT");
  expect(buildTelemetryRow({ ...base, event: "arbitrary-event" } as never, 1)).toBeNull();
  expect(buildTelemetryRow({ ...base, status: "free-text" } as never, 1)).toBeNull();
  expect(buildTelemetryRow({ ...base, traceId: "has spaces" } as never, 1)).toBeNull();
  expect(buildTelemetryRow({ ...base, durationMs: Number.NaN } as never, 1)?.durationMs).toBeUndefined();
});

/* ------------------------------------------------------------------ *
 * Stored rows: ids and timings only
 * ------------------------------------------------------------------ */

test("a transcription writes one telemetry row of ids and timings, never the transcript", async () => {
  const t = makeTest();
  const projectId = await seedProject(t);
  const owner = t.withIdentity(identity("learner-a|s1"));

  const response = await owner.fetch(`/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  expect(response.status).toBe(200);
  const traceId = response.headers.get("x-trace-id");
  expect(traceId).toMatch(/^[a-f0-9]{32}$/);

  const rows = await t.run(async (ctx) => ctx.db.query("telemetryEvents").collect());
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(Object.keys(row).every((key) => [...ALLOWED_ROW_KEYS, "_creationTime", "_id"].includes(key))).toBe(true);
  expect(row.traceId).toBe(traceId);
  expect(row.event).toBe("stt-transcribe");
  expect(row.status).toBe("ok");
  expect(typeof row.durationMs).toBe("number");
  expect(row.ownerId).toBe("learner-a");
  expect(row.projectId).toBe(projectId);
  const serialized = JSON.stringify(rows);
  expect(serialized).not.toContain(KEY_CANARY);
  expect(serialized).not.toContain(TRANSCRIPT_CANARY);
  expect(serialized).not.toContain(PROMPT_CANARY);
});

test("a completed tutor turn logs ids and timings only — the learner text and key never appear", async () => {
  const t = makeTest();
  const projectId = await seedProject(t);
  const owner = t.withIdentity(identity("learner-a|s1"));

  const result = await owner.action(api.tutor.runTurn, {
    projectId,
    turnId: "turn-observable",
    text: `Explain this while leaking ${TRANSCRIPT_CANARY} and ${PROMPT_CANARY}`,
  });
  expect(result.status).toBe("completed");

  const rows = await t.run(async (ctx) => ctx.db.query("telemetryEvents").collect());
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.event).toBe("tutor-turn");
  expect(row.status).toBe("ok");
  expect(row.traceId).toBe("turn-observable");
  expect(row.attempts).toBe(1);
  expect(typeof row.durationMs).toBe("number");
  expect(Object.keys(row).every((key) => [...ALLOWED_ROW_KEYS, "_creationTime", "_id"].includes(key))).toBe(true);

  const serialized = JSON.stringify(rows);
  expect(serialized).not.toContain(TRANSCRIPT_CANARY);
  expect(serialized).not.toContain(PROMPT_CANARY);
  expect(serialized).not.toContain(KEY_CANARY);
  // The full conversation, by contrast, lives in the transcript it belongs to.
  const messages = await t.run(async (ctx) => ctx.db.query("messages").collect());
  expect(messages.length).toBeGreaterThan(0);
  expect(JSON.stringify(messages)).toContain(TRANSCRIPT_CANARY);
});

test("a failing turn records the typed failure code with timings, never a message", async () => {
  const t = makeTest();
  const projectId = await seedProject(t);
  const owner = t.withIdentity(identity("learner-a|s1"));
  delete process.env.NAN_API_KEY;

  await expect(
    owner.action(api.tutor.runTurn, { projectId, turnId: "turn-fails", text: "hello" }),
  ).rejects.toThrow(/TURN_NOT_CONFIGURED/);

  const rows = await t.run(async (ctx) => ctx.db.query("telemetryEvents").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ event: "tutor-turn", status: "error", code: "TURN_NOT_CONFIGURED", traceId: "turn-fails" });
  expect(JSON.stringify(rows)).not.toContain(KEY_CANARY);
});

test("a rate-limited request records a rate-limited row with the wait, no content", async () => {
  process.env.RATE_LIMIT_REQUESTS = "1";
  const t = makeTest();
  const projectId = await seedProject(t);
  const owner = t.withIdentity(identity("learner-a|s1"));
  const request = () =>
    owner.fetch(`/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`, {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
  expect((await request()).status).toBe(200);
  const denied = await request();
  expect(denied.status).toBe(429);

  const rows = await t.run(async (ctx) => ctx.db.query("telemetryEvents").collect());
  expect(rows).toHaveLength(2);
  const limited = rows.find((row) => row.status === "rate-limited");
  expect(limited).toMatchObject({ event: "stt-transcribe", code: "RATE_LIMITED" });
  expect(limited?.retryAfterMs).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain(KEY_CANARY);
  delete process.env.RATE_LIMIT_REQUESTS;
});

/* ------------------------------------------------------------------ *
 * Retention and rotation
 * ------------------------------------------------------------------ */

test("the cleanup cron deletes only rows older than LOG_RETENTION_DAYS", async () => {
  const t = makeTest();
  const projectId = await t.withIdentity(identity("learner-a|s1")).mutation(api.projects.createProject, { name: "Logs" });
  const now = Date.now();
  await t.run(async (ctx) => {
    const insert = (createdAt: number) =>
      ctx.db.insert("telemetryEvents", {
        traceId: `trace-${createdAt}`,
        ownerId: "learner-a",
        projectId,
        event: "stt-transcribe",
        status: "ok",
        createdAt,
      });
    await insert(now - 40 * 24 * 60 * 60 * 1000); // far beyond the default 30 days
    await insert(now - 2 * 60 * 60 * 1000); // two hours old: still inside
  });

  const first = await t.mutation(internal.observability.cleanupTelemetry, {});
  expect(first).toEqual({ deleted: 1, hasMore: false });
  const remaining = await t.run(async (ctx) => ctx.db.query("telemetryEvents").collect());
  expect(remaining).toHaveLength(1);
  expect(remaining[0].createdAt).toBeGreaterThan(now - 3 * 60 * 60 * 1000);

  // The retention window is configurable, with bounded fallbacks.
  process.env.LOG_RETENTION_DAYS = "0"; // clamps to one day, never to "keep nothing"
  await t.run(async (ctx) => {
    await ctx.db.insert("telemetryEvents", {
      traceId: "trace-stale",
      ownerId: "learner-a",
      projectId,
      event: "stt-transcribe",
      status: "ok",
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
    });
  });
  const second = await t.mutation(internal.observability.cleanupTelemetry, {});
  expect(second.deleted).toBe(1);
  const after = await t.run(async (ctx) => ctx.db.query("telemetryEvents").collect());
  expect(after).toHaveLength(1); // the two-hour-old row is still inside the window
  expect(after[0].traceId).not.toBe("trace-stale");
});

test("cleanup is bounded: an oversized backlog drains across batches", async () => {
  const t = makeTest();
  const projectId = await t.withIdentity(identity("learner-a|s1")).mutation(api.projects.createProject, { name: "Logs" });
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  await t.run(async (ctx) => {
    for (let index = 0; index < 150; index += 1) {
      await ctx.db.insert("telemetryEvents", {
        traceId: `trace-${index}`,
        ownerId: "learner-a",
        projectId,
        event: "stt-transcribe",
        status: "ok",
        createdAt: old + index,
      });
    }
  });
  const first = await t.mutation(internal.observability.cleanupTelemetry, {});
  expect(first).toEqual({ deleted: 100, hasMore: true });
  const second = await t.mutation(internal.observability.cleanupTelemetry, {});
  expect(second).toEqual({ deleted: 50, hasMore: false });
  expect(await t.run(async (ctx) => ctx.db.query("telemetryEvents").collect())).toHaveLength(0);
});
