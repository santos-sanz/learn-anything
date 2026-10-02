import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { classifyAuthorizeFailure } from "../convex/stt.js";
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
};
const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });

type ProviderCall = { url: string; init?: RequestInit };
let providerCalls: ProviderCall[] = [];
let provider: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  providerCalls = [];
  provider = async () => Response.json({ text: "synthetic transcript", language: "en", duration: 1 });
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    providerCalls.push({ url, init });
    return provider(url, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.STT_TIMEOUT_MS;
  process.env.NAN_API_KEY = "synthetic-test-key";
});

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4]);
const turnPath = (projectId: string, extra = "") =>
  `/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1${extra}`;

test("an authenticated deployer turn transcribes through Whisper only and keeps no stored audio", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });
  provider = async () => Response.json({ text: "hola", language: "es", duration: 1.25 });

  const response = await a.fetch(turnPath(projectId), {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: AUDIO_BYTES,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ turnId: "turn-1", text: "hola", language: "es", duration: 1.25 });
  expect(providerCalls).toHaveLength(1);
  expect(providerCalls[0].url).toBe("https://api.nan.builders/v1/audio/transcriptions");
  expect(providerCalls.some((call) => call.url.includes("/audio/translations"))).toBe(false);
  const form = providerCalls[0].init?.body as FormData;
  expect(form.get("model")).toBe("whisper");
  expect(form.get("language")).toBe("en");
  expect((form.get("file") as Blob).type).toBe("audio/webm");
  const state = await t.run(async (ctx) => ({
    audioFiles: await ctx.db.query("privateFiles").collect(),
    messages: await ctx.db.query("messages").collect(),
  }));
  expect(state.audioFiles).toHaveLength(0);
  expect(state.messages).toHaveLength(0);
});

test("an anonymous caller is denied before any provider work", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const response = await t.fetch(turnPath(projectId), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ code: "UNAUTHENTICATED" });
  expect(providerCalls).toHaveLength(0);
});

test("a second user cannot transcribe against another learner's project", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const b = t.withIdentity(identity("owner-b|session-2"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });

  const response = await b.fetch(turnPath(projectA), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "NOT_FOUND" });
  expect(providerCalls).toHaveLength(0);
});

test("the deployer's personal key never serves another learner's own project", async () => {
  const t = convexTest({ schema, modules });
  const b = t.withIdentity(identity("owner-b|session-2"));
  const projectB = await b.mutation(api.projects.createProject, { name: "B" });

  const response = await b.fetch(turnPath(projectB), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: "PROVIDER_POLICY_BLOCKED" });
  expect(providerCalls).toHaveLength(0);
});

test("a provider 429 surfaces the typed Retry-After budget", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });
  provider = async () =>
    new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3" },
    });

  const response = await a.fetch(turnPath(projectId), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ code: "STT_RATE_LIMITED", retryAfterMs: 3000 });
});

test("a provider 524 stays visible as an upstream gateway failure", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });
  provider = async () => new Response("a moment", { status: 524 });

  const response = await a.fetch(turnPath(projectId), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ code: "STT_PROVIDER_UNAVAILABLE", upstreamStatus: 524 });
});

test("a hanging provider request times out with a typed 504", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });
  process.env.STT_TIMEOUT_MS = "60";
  provider = () => new Promise<Response>(() => undefined);

  const response = await a.fetch(turnPath(projectId), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ code: "STT_TIMEOUT" });
});

test("aborting the request cancels the pending provider call", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });
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
  const pending = a.fetch(turnPath(projectId), {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: AUDIO_BYTES,
    signal: controller.signal,
  });
  await providerStarted;
  controller.abort();

  const response = await pending;
  expect(response.status).toBe(499);
  expect(await response.json()).toEqual({ code: "CANCELLED" });
  const state = await t.run(async (ctx) => ctx.db.query("privateFiles").collect());
  expect(state).toHaveLength(0);
});

test("silence reaches the client as an actionable 422 instead of an empty transcript", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });
  provider = async () => Response.json({ text: "   ", language: "en", duration: 1 });

  const response = await a.fetch(turnPath(projectId), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ code: "SILENCE" });
});

test("oversize and unsupported audio are rejected before the provider is called", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const oversized = await a.fetch(turnPath(projectId), {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: new Uint8Array(8 * 1024 * 1024 + 1),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ code: "AUDIO_TOO_LARGE" });

  const wav = await a.fetch(turnPath(projectId), {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: AUDIO_BYTES,
  });
  expect(wav.status).toBe(415);
  expect(await wav.json()).toEqual({ code: "UNSUPPORTED_CODEC" });
  expect(providerCalls).toHaveLength(0);
});

test("malformed turn parameters are rejected as invalid arguments", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const wrongLanguage = await a.fetch(turnPath(projectId).replace("language=en", "language=fr"), {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: AUDIO_BYTES,
  });
  expect(wrongLanguage.status).toBe(400);

  const brokenProject = await a.fetch(turnPath("not-a-project-id"), {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: AUDIO_BYTES,
  });
  expect(brokenProject.status).toBe(400);
  expect(await brokenProject.json()).toEqual({ code: "INVALID_ARGUMENT" });

  const emptyAudio = await a.fetch(turnPath(projectId), {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: new Uint8Array(0),
  });
  expect(emptyAudio.status).toBe(400);
  expect(providerCalls).toHaveLength(0);
});

test("a missing server-side key fails visibly without contacting the provider", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });
  process.env.NAN_API_KEY = "";

  const response = await a.fetch(turnPath(projectId), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "STT_NOT_CONFIGURED" });
  expect(providerCalls).toHaveLength(0);
});

test("an unexpected failure of the ownership check is a 5xx, never a client error", async () => {
  // The stt module is deliberately absent from the module map, so resolving the
  // internal ownership query fails the way any transient server-side fault
  // would — before a single byte could reach the provider.
  const modulesWithBrokenOwnershipCheck: Record<string, () => Promise<unknown>> = { ...modules };
  delete modulesWithBrokenOwnershipCheck["../convex/stt.ts"];
  const t = convexTest({ schema, modules: modulesWithBrokenOwnershipCheck });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const response = await a.fetch(turnPath(projectId), { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO_BYTES });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ code: "INTERNAL_ERROR" });
  expect(providerCalls).toHaveLength(0);
});

test("ownership-check failures keep their own statuses instead of collapsing to 400", () => {
  expect(classifyAuthorizeFailure(new ConvexError({ code: "UNAUTHENTICATED" }))).toEqual({ status: 401, code: "UNAUTHENTICATED" });
  expect(classifyAuthorizeFailure(new ConvexError({ code: "FORBIDDEN" }))).toEqual({ status: 403, code: "FORBIDDEN" });
  expect(classifyAuthorizeFailure(new ConvexError({ code: "NOT_FOUND" }))).toEqual({ status: 404, code: "NOT_FOUND" });
  expect(classifyAuthorizeFailure(new Error('Validator error: Expected ID for table "projects", got `nope`'))).toEqual({ status: 400, code: "INVALID_ARGUMENT" });
  expect(classifyAuthorizeFailure(new Error("database is unreachable"))).toEqual({ status: 500, code: "INTERNAL_ERROR" });
  expect(classifyAuthorizeFailure(new Error('Could not find module for: "stt"'))).toEqual({ status: 500, code: "INTERNAL_ERROR" });
});
