import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { applyRateLimit, rateLimitRequests, rateLimitWindowMs } from "../convex/observability.js";
import { installAuthTestEnv, TEST_ISSUER } from "./helpers/authEnv.js";

/**
 * S24 tenant-aware throttling: pure fixed-window arithmetic, the bounded
 * internal consumer (driven with an explicit `now` so every threshold is
 * exact), and the observable route contract — a 429 that carries both
 * `Retry-After` and `retryAfterMs`, with the next attempt permitted exactly
 * when the window rolls. Synthetic identity and a mocked provider only.
 */
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/files.ts": () => import("../convex/files.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/observability.ts": () => import("../convex/observability.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
  "../convex/stt.ts": () => import("../convex/stt.js"),
};

const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });
const makeTest = () => convexTest({ schema, modules });
type TestInstanceLocal = ReturnType<typeof makeTest>;

const originalFetch = globalThis.fetch;
let providerCalls = 0;

beforeEach(() => {
  providerCalls = 0;
  process.env.NAN_API_KEY = "synthetic-test-key";
  process.env.NAN_DEPLOYER_ID = "owner-a";
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (!url.startsWith("https://api.nan.builders/v1")) throw new Error(`unexpected provider call: ${url}`);
    providerCalls += 1;
    return Response.json({ text: "synthetic transcript", language: "en", duration: 1 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NAN_API_KEY;
  delete process.env.NAN_DEPLOYER_ID;
  delete process.env.RATE_LIMIT_REQUESTS;
  delete process.env.RATE_LIMIT_WINDOW_SECONDS;
});

const AUDIO = new Uint8Array([1, 2, 3, 4]);
const sttPath = (projectId: string) => `/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`;
const postStt = (t: TestInstanceLocal, projectId: string, subject = "owner-a|s1", extra: Record<string, string> = {}) =>
  t.withIdentity(identity(subject)).fetch(sttPath(projectId), {
    method: "POST",
    headers: { "content-type": "audio/webm", ...extra },
    body: AUDIO,
  });

async function seedProject(t: TestInstanceLocal, subject = "owner-a|s1", name = "Voice"): Promise<string> {
  const projectId = await t.withIdentity(identity(subject)).mutation(api.projects.createProject, { name });
  return projectId as string;
}

/* ------------------------------------------------------------------ *
 * Pure window arithmetic
 * ------------------------------------------------------------------ */

test("the fixed window admits exactly `limit` requests then denies with the precise wait", () => {
  const windowMs = 60_000;
  const start = 1_000_000;
  const first = applyRateLimit({ windowStart: start, count: 0 }, 3, windowMs, start);
  expect(first).toEqual({ allowed: true, state: { windowStart: start, count: 1 }, retryAfterMs: 0 });
  const second = applyRateLimit(first.state, 3, windowMs, start + 10);
  const third = applyRateLimit(second.state, 3, windowMs, start + 20);
  expect(third.allowed).toBe(true);
  const fourth = applyRateLimit(third.state, 3, windowMs, start + 30);
  expect(fourth.allowed).toBe(false);
  expect(fourth.retryAfterMs).toBe(windowMs - 30);
  expect(fourth.state).toEqual(third.state);
});

test("the next attempt succeeds exactly at the window boundary, not before", () => {
  const windowMs = 1_000;
  const start = 5_000;
  const denied = applyRateLimit({ windowStart: start, count: 99 }, 1, windowMs, start + 400);
  expect(denied.allowed).toBe(false);
  expect(denied.retryAfterMs).toBe(600);
  expect(applyRateLimit(denied.state, 1, windowMs, start + 999).allowed).toBe(false);
  const rolled = applyRateLimit(denied.state, 1, windowMs, start + 1_000);
  expect(rolled.allowed).toBe(true);
  expect(rolled.state).toEqual({ windowStart: start + 1_000, count: 1 });
});

test("limits are configurable with bounded fallbacks", () => {
  delete process.env.RATE_LIMIT_REQUESTS;
  delete process.env.RATE_LIMIT_WINDOW_SECONDS;
  expect(rateLimitRequests()).toBe(60);
  expect(rateLimitWindowMs()).toBe(60_000);
  process.env.RATE_LIMIT_REQUESTS = "5";
  process.env.RATE_LIMIT_WINDOW_SECONDS = "2";
  expect(rateLimitRequests()).toBe(5);
  expect(rateLimitWindowMs()).toBe(2_000);
  process.env.RATE_LIMIT_REQUESTS = "0";
  process.env.RATE_LIMIT_WINDOW_SECONDS = "junk";
  expect(rateLimitRequests()).toBe(1);
  expect(rateLimitWindowMs()).toBe(60_000);
  process.env.RATE_LIMIT_REQUESTS = "99999999";
  process.env.RATE_LIMIT_WINDOW_SECONDS = "99999999";
  expect(rateLimitRequests()).toBe(10_000);
  expect(rateLimitWindowMs()).toBe(3_600_000);
});

/* ------------------------------------------------------------------ *
 * Internal consumer with an explicit clock
 * ------------------------------------------------------------------ */

test("consumeRequest counts per learner and route, and denies with the exact retry budget", async () => {
  const t = makeTest();
  const consume = (now: number) =>
    t.mutation(internal.observability.consumeRequest, {
      ownerId: "owner-a",
      bucket: "stt-transcribe",
      projectId: "",
      limit: 2,
      windowMs: 10_000,
      now,
    });

  expect(await consume(1_000)).toEqual({ allowed: true, retryAfterMs: 0, projectId: null });
  expect(await consume(1_500)).toEqual({ allowed: true, retryAfterMs: 0, projectId: null });
  const denied = await consume(1_600);
  expect(denied.allowed).toBe(false);
  expect(denied.retryAfterMs).toBe(9_400); // window opens at 1_000 and rolls at 11_000
  const rolled = await consume(11_000);
  expect(rolled.allowed).toBe(true);

  const state = await t.run(async (ctx) => ctx.db.query("rateLimitBuckets").collect());
  expect(state).toHaveLength(1);
  expect(state[0]).toMatchObject({ ownerId: "owner-a", bucket: "stt-transcribe", count: 1, windowStart: 11_000 });
});

test("buckets are isolated per learner and per route", async () => {
  const t = makeTest();
  const consume = (ownerId: string, bucket: string) =>
    t.mutation(internal.observability.consumeRequest, {
      ownerId,
      bucket,
      projectId: "",
      limit: 2,
      windowMs: 10_000,
      now: 1_000,
    });
  await consume("owner-a", "stt-transcribe");
  await consume("owner-a", "stt-transcribe");
  expect((await consume("owner-b", "stt-transcribe")).allowed).toBe(true);
  expect((await consume("owner-a", "tts-synthesize")).allowed).toBe(true);
});

test("a foreign or malformed projectId never resolves to a scope", async () => {
  const t = makeTest();
  const projectId = await seedProject(t);
  const foreign = await t.mutation(internal.observability.consumeRequest, {
    ownerId: "owner-b",
    projectId,
    bucket: "stt-transcribe",
    limit: 5,
    windowMs: 1_000,
    now: 1,
  });
  expect(foreign.projectId).toBeNull();
  const malformed = await t.mutation(internal.observability.consumeRequest, {
    ownerId: "owner-a",
    projectId: "not-an-id",
    bucket: "stt-transcribe",
    limit: 5,
    windowMs: 1_000,
    now: 1,
  });
  expect(malformed.projectId).toBeNull();
  const owned = await t.mutation(internal.observability.consumeRequest, {
    ownerId: "owner-a",
    projectId,
    bucket: "stt-transcribe",
    limit: 5,
    windowMs: 1_000,
    now: 1,
  });
  expect(owned.projectId).toBe(projectId);
});

/* ------------------------------------------------------------------ *
 * Observable route contract
 * ------------------------------------------------------------------ */

test("the route answers 429 with Retry-After and retryAfterMs once the learner's window is spent", async () => {
  process.env.RATE_LIMIT_REQUESTS = "2";
  const t = makeTest();
  const projectId = await seedProject(t);

  const first = await postStt(t, projectId);
  expect(first.status).toBe(200);
  const second = await postStt(t, projectId);
  expect(second.status).toBe(200);
  expect(providerCalls).toBe(2);

  const denied = await postStt(t, projectId, "owner-a|s1", { origin: "https://app.example.test" });
  expect(denied.status).toBe(429);
  const body = (await denied.json()) as { code: string; retryAfterMs: number };
  expect(body.code).toBe("RATE_LIMITED");
  expect(body.retryAfterMs).toBeGreaterThan(0);
  const headerSeconds = Number(denied.headers.get("retry-after"));
  expect(Number.isFinite(headerSeconds)).toBe(true);
  expect(headerSeconds).toBeGreaterThanOrEqual(1);
  expect(headerSeconds).toBe(Math.ceil(body.retryAfterMs / 1000));
  // The browser must be able to read the denial cross-origin.
  expect(denied.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
  expect(denied.headers.get("x-trace-id")).toMatch(/^[a-f0-9]{32}$/);
  // No provider work happens for a throttled request.
  expect(providerCalls).toBe(2);

  const buckets = await t.run(async (ctx) => ctx.db.query("rateLimitBuckets").collect());
  expect(buckets).toHaveLength(1);
  expect(buckets[0].count).toBe(2); // denied attempts never extend the count
});

test("a provider 429 propagates the Retry-After header alongside retryAfterMs", async () => {
  const t = makeTest();
  const projectId = await seedProject(t);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3" },
    })) as typeof globalThis.fetch;

  const response = await postStt(t, projectId);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("3");
  expect(await response.json()).toEqual({ code: "STT_RATE_LIMITED", retryAfterMs: 3000 });
});

test("anonymous requests are rejected without consuming anyone's bucket", async () => {
  const t = makeTest();
  const projectId = await seedProject(t);

  const response = await t.fetch(sttPath(projectId), {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: AUDIO,
  });
  expect(response.status).toBe(401);
  const buckets = await t.run(async (ctx) => ctx.db.query("rateLimitBuckets").collect());
  expect(buckets).toHaveLength(0);
});

test("a second learner's project stays denied by the handler even with a fresh bucket", async () => {
  const t = makeTest();
  const projectId = await seedProject(t, "owner-a|s1");

  const response = await postStt(t, projectId, "owner-b|s2");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "NOT_FOUND" });
  expect(providerCalls).toBe(0);
});
