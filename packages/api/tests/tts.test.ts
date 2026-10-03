import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv, TEST_ISSUER } from "./helpers/authEnv.js";

installAuthTestEnv();

// Synthetic offline credentials only; never a real provider key.
process.env.NAN_API_KEY = "synthetic-test-key";
process.env.NAN_DEPLOYER_ID = "owner-a";

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/files.ts": () => import("../convex/files.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
  "../convex/stt.ts": () => import("../convex/stt.js"),
  "../convex/tts.ts": () => import("../convex/tts.js"),
  "../convex/tutor.ts": () => import("../convex/tutor.js"),
};
const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });

type ProviderCall = { url: string; init?: RequestInit };
let providerCalls: ProviderCall[] = [];
let provider: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00]);

beforeEach(() => {
  providerCalls = [];
  provider = async () => new Response(MP3_BYTES, { status: 200, headers: { "content-type": "audio/mpeg" } });
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    providerCalls.push({ url, init });
    return provider(url, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TTS_TIMEOUT_MS;
  process.env.NAN_API_KEY = "synthetic-test-key";
});

const TUTOR_ANSWER = "Sunlight becomes chemical energy [1]. Chlorophyll absorbs it.";

type SeedOptions = {
  ownerId: string;
  projectId: string;
  turnId?: string;
  status?: "running" | "completed" | "cancelled" | "failed";
  content?: string | null;
  sessionId?: string;
};

/** Seeds the S14 rows directly: no provider call is involved in seeding. */
async function seedTutorTurn(t: ReturnType<typeof convexTest>, options: SeedOptions): Promise<{ turnId: string; sessionId: string }> {
  const turnId = options.turnId ?? "turn-1";
  const sessionId = options.sessionId ?? (await t.run(async (ctx) => ctx.db.insert("learningSessions", {
    ownerId: options.ownerId,
    projectId: options.projectId as Id<"projects">,
    sessionKey: `session-${turnId}`,
    createdAt: Date.now(),
    endedAt: null,
  }))) as string;
  await t.run(async (ctx) => {
    await ctx.db.insert("tutorTurns", {
      ownerId: options.ownerId,
      projectId: options.projectId as Id<"projects">,
      sessionId: sessionId as Id<"learningSessions">,
      turnId,
      status: options.status ?? "completed",
      attempts: 1,
      learnerText: "What is photosynthesis?",
      retrievedChunkIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (options.content !== null) {
      await ctx.db.insert("messages", {
        ownerId: options.ownerId,
        projectId: options.projectId as Id<"projects">,
        sessionId: sessionId as Id<"learningSessions">,
        turnId,
        idempotencyKey: `${turnId}:tutor`,
        role: "tutor",
        content: options.content ?? TUTOR_ANSWER,
        createdAt: Date.now(),
      });
    }
  });
  return { turnId, sessionId };
}

const synthPath = (projectId: string, query = "") => `/tts/synthesize?projectId=${projectId}&turnId=turn-1${query}`;

test("an authenticated owner gets their stored tutor response as MP3 with no stored bytes", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });

  const response = await a.fetch(synthPath(projectId), { method: "POST" });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/mpeg");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3_BYTES);
  expect(providerCalls).toHaveLength(1);
  expect(providerCalls[0].url).toBe("https://api.nan.builders/v1/audio/speech");
  const body = JSON.parse(String(providerCalls[0].init?.body)) as Record<string, unknown>;
  expect(body).toEqual({ model: "kokoro", input: "Sunlight becomes chemical energy. Chlorophyll absorbs it.", voice: "af_heart", response_format: "mp3", speed: 1 });
  // Bytes are never committed: no private file rows, no storage writes, no extra messages.
  const state = await t.run(async (ctx) => ({
    privateFiles: await ctx.db.query("privateFiles").collect(),
    documents: await ctx.db.query("documents").collect(),
    messages: await ctx.db.query("messages").collect(),
  }));
  expect(state.privateFiles).toHaveLength(0);
  expect(state.documents).toHaveLength(0);
  expect(state.messages).toHaveLength(1);
});

test("an explicit language selects only its configured voice", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });

  const response = await a.fetch(synthPath(projectId, "&language=es"), { method: "POST" });
  expect(response.status).toBe(200);
  const body = JSON.parse(String(providerCalls[0].init?.body)) as { voice?: unknown };
  expect(body.voice).toBe("ef_dora");
});

test("an anonymous caller is denied the audio before any provider work", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });

  const response = await t.fetch(synthPath(projectId), { method: "POST" });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ code: "UNAUTHENTICATED" });
  expect(providerCalls).toHaveLength(0);
});

test("a second user cannot fetch another learner's tutor audio", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const b = t.withIdentity(identity("owner-b"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "A" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });

  const response = await b.fetch(synthPath(projectId), { method: "POST" });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "NOT_FOUND" });
  expect(providerCalls).toHaveLength(0);
});

test("an unsupported voice or language fails with a typed 422 and the configured list", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });

  const voice = await a.fetch(synthPath(projectId, "&voice=am_michael"), { method: "POST" });
  expect(voice.status).toBe(422);
  expect(await voice.json()).toEqual({ code: "UNSUPPORTED_VOICE", supportedVoices: ["af_heart", "ef_dora"], supportedLanguages: ["en", "es"] });

  const language = await a.fetch(synthPath(projectId, "&language=fr"), { method: "POST" });
  expect(language.status).toBe(422);
  expect(await language.json()).toMatchObject({ code: "UNSUPPORTED_LANGUAGE" });

  const mismatch = await a.fetch(synthPath(projectId, "&language=es&voice=af_heart"), { method: "POST" });
  expect(mismatch.status).toBe(422);
  expect(await mismatch.json()).toMatchObject({ code: "VOICE_LANGUAGE_MISMATCH" });

  expect(providerCalls).toHaveLength(0);
});

test("audio for a cancelled, running or unknown turn is rejected as stale", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  // A cancelled turn keeps the stale tutor message the S14 commit never wrote;
  // the route must still refuse to turn it into audio.
  await seedTutorTurn(t, { ownerId: "owner-a", projectId, turnId: "turn-1", status: "cancelled" });

  const cancelled = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(cancelled.status).toBe(404);
  expect(await cancelled.json()).toEqual({ code: "NOT_FOUND" });

  await t.run(async (ctx) => {
    const row = await ctx.db.query("tutorTurns").first();
    if (row !== null) await ctx.db.patch(row._id, { status: "running" });
  });
  const running = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(running.status).toBe(404);

  const unknown = await a.fetch(synthPath(projectId, "&turnId=turn-404"), { method: "POST" });
  expect(unknown.status).toBe(404);
  expect(providerCalls).toHaveLength(0);
});

test("a completed turn without a stored tutor message is not synthesizable", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId, content: null });

  const response = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(response.status).toBe(404);
  expect(providerCalls).toHaveLength(0);
});

test("provider failures stay typed and visible", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });

  provider = async () =>
    new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3" },
    });
  const limited = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ code: "TTS_RATE_LIMITED", retryAfterMs: 3000 });

  provider = async () => new Response("a moment", { status: 524 });
  const gateway = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(gateway.status).toBe(502);
  expect(await gateway.json()).toEqual({ code: "TTS_PROVIDER_UNAVAILABLE", upstreamStatus: 524 });

  provider = async () => new Response("bad", { status: 500 });
  const broken = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(broken.status).toBe(502);
  expect(await broken.json()).toMatchObject({ code: "TTS_PROVIDER_ERROR", upstreamStatus: 500 });
});

test("a hanging provider request times out with a typed 504", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });
  process.env.TTS_TIMEOUT_MS = "60";
  provider = () => new Promise<Response>(() => undefined);

  const response = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ code: "TTS_TIMEOUT" });
});

test("aborting the request cancels the pending provider call", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });
  let notifyProviderStarted: () => void = () => undefined;
  const providerStarted = new Promise<void>((resolve) => {
    notifyProviderStarted = resolve;
  });
  provider = (_url, init) => {
    notifyProviderStarted();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };

  const controller = new AbortController();
  const pending = a.fetch(synthPath(projectId), { method: "POST", signal: controller.signal });
  await providerStarted;
  controller.abort();

  const response = await pending;
  expect(response.status).toBe(499);
  expect(await response.json()).toEqual({ code: "CANCELLED" });
});

test("a missing server-side key fails visibly without contacting the provider", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId });
  process.env.NAN_API_KEY = "";

  const response = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "TTS_NOT_CONFIGURED" });
  expect(providerCalls).toHaveLength(0);
});

test("the personal key never serves another learner's own project", async () => {
  const t = convexTest({ schema, modules });
  const b = t.withIdentity(identity("owner-b"));
  const projectId = (await b.mutation(api.projects.createProject, { name: "B" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-b", projectId });

  const response = await b.fetch(synthPath(projectId), { method: "POST" });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: "PROVIDER_POLICY_BLOCKED" });
  expect(providerCalls).toHaveLength(0);
});

test("oversize speech text is refused before the provider is called", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId, content: "x".repeat(20_001) });

  const response = await a.fetch(synthPath(projectId), { method: "POST" });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ code: "TEXT_TOO_LARGE", maxChars: 20_000 });
  expect(providerCalls).toHaveLength(0);
});

test("malformed route parameters are rejected as invalid arguments", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;

  const noProject = await a.fetch("/tts/synthesize?projectId=&turnId=turn-1", { method: "POST" });
  expect(noProject.status).toBe(400);

  const noTurn = await a.fetch(`/tts/synthesize?projectId=${projectId}`, { method: "POST" });
  expect(noTurn.status).toBe(400);

  const brokenProject = await a.fetch("/tts/synthesize?projectId=not-a-project-id&turnId=turn-1", { method: "POST" });
  expect(brokenProject.status).toBe(400);
  expect(await brokenProject.json()).toEqual({ code: "INVALID_ARGUMENT" });
  expect(providerCalls).toHaveLength(0);
});

test("the configured voice catalog is readable by a signed-in learner only", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));

  const options = await a.query(api.tts.speechOptions, {});
  expect(options).toEqual({
    model: "kokoro",
    format: "mp3",
    languages: ["en", "es"],
    voices: [
      { id: "af_heart", language: "en", label: "English (af_heart)" },
      { id: "ef_dora", language: "es", label: "Spanish (ef_dora)" },
    ],
    maxTextChars: 20_000,
  });
  await expect(t.query(api.tts.speechOptions, {})).rejects.toThrow("UNAUTHENTICATED");
  expect(providerCalls).toHaveLength(0);
});

test("the browser preflight for the audio route is answered without authentication", async () => {
  const t = convexTest({ schema, modules });
  const response = await t.fetch("/tts/synthesize", {
    method: "OPTIONS",
    headers: { Origin: "https://app.example.test", "Access-Control-Request-Method": "POST" },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
  expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  expect(providerCalls).toHaveLength(0);
});

test("the latest-turn cancellation anchor is owner-scoped and non-enumerating", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a"));
  const b = t.withIdentity(identity("owner-b"));
  const projectId = (await a.mutation(api.projects.createProject, { name: "Voice" })) as string;
  await seedTutorTurn(t, { ownerId: "owner-a", projectId, turnId: "turn-1", status: "completed" });
  await seedTutorTurn(t, { ownerId: "owner-a", projectId, turnId: "turn-2", status: "running" });

  const latest = await a.query(api.tutor.latestTurn, { projectId: projectId as Id<"projects"> });
  expect(latest).toMatchObject({ turnId: "turn-2", status: "running" });

  await expect(t.query(api.tutor.latestTurn, { projectId: projectId as Id<"projects"> })).rejects.toThrow("UNAUTHENTICATED");
  await expect(b.query(api.tutor.latestTurn, { projectId: projectId as Id<"projects"> })).rejects.toThrow("NOT_FOUND");
  expect(providerCalls).toHaveLength(0);
});
