import { expect, test } from "vitest";

import { NanClient, NAN_BASE_URL, redactNanHeaders, redactNanSecret } from "../src/index.js";

const deployment = { mode: "single-user-self-hosted" as const, learnerId: "owner", deployerId: "owner" };
const client = (fetch: typeof globalThis.fetch, timeoutMs = 100) => new NanClient({ apiKey: "synthetic-server-token", fetch, deployment, quotaControls: { timeoutMs } });

test("routes all documented standard stages to the fixed NaN API base URL", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/embeddings")) return Response.json({ data: [{ embedding: Array.from({ length: 4096 }, () => 0) }] });
    if (url.endsWith("/rerank")) return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
    if (url.endsWith("/audio/speech")) return new Response(new Uint8Array([1]));
    if (url.includes("transcriptions")) return Response.json({ text: "hello", language: "en", duration: 1 });
    if (url.includes("translations")) return Response.json({ text: "hello" });
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  const nan = client(fetch);
  await nan.tutor([{ role: "user", content: "teach" }]);
  await nan.translateText("hola", "es", "en");
  await nan.embeddings(["doc"]);
  await nan.rerank("q", ["d"]);
  await nan.transcribe({ bytes: new Uint8Array([1]), filename: "x.mp3", mimeType: "audio/mpeg" }, "en");
  await nan.translateAudioToEnglish({ bytes: new Uint8Array([1]), filename: "x.mp3", mimeType: "audio/mpeg" });
  await nan.speech("hello");
  expect(calls).toHaveLength(7);
  expect(calls.every((call) => call.url.startsWith(NAN_BASE_URL))).toBe(true);
  expect(calls.find((call) => call.url.endsWith("/rerank"))?.url).toBe(`${NAN_BASE_URL}/rerank`);
});

test("converts 429 Retry-After to a typed bounded-retry error", async () => {
  await expect(client(async () => new Response("slow", { status: 429, headers: { "Retry-After": "3" } })).tutor([{ role: "user", content: "x" }]))
    .rejects.toMatchObject({ code: "NAN_RATE_LIMITED", retryAfterMs: 3000 });
});

test("surfaces rejected configured models without a provider fallback", async () => {
  await expect(client(async () => new Response("unknown model", { status: 400 })).tutor([{ role: "user", content: "x" }]))
    .rejects.toMatchObject({ code: "NAN_UNSUPPORTED_MODEL" });
});

test("rejects malformed payloads", async () => {
  await expect(client(async () => Response.json({ choices: [] })).tutor([{ role: "user", content: "x" }]))
    .rejects.toMatchObject({ code: "NAN_MALFORMED_RESPONSE" });
  await expect(client(async () => Response.json({ data: [{ embedding: [1] }] })).embeddings(["x"]))
    .rejects.toMatchObject({ code: "NAN_MALFORMED_RESPONSE" });
});

test("turn cancellation is a typed error", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(client(async (_url, init) => { throw init?.signal?.reason; }).tutor([{ role: "user", content: "x" }], { signal: controller.signal }))
    .rejects.toMatchObject({ code: "NAN_CANCELLED" });
});

test("timeout is a typed error", async () => {
  await expect(client(async () => new Promise(() => undefined), 1).tutor([{ role: "user", content: "x" }]))
    .rejects.toMatchObject({ code: "NAN_TIMEOUT" });
});

test("policy rejects hosted multiuser and redacts diagnostic secrets", async () => {
  const restricted = new NanClient({ apiKey: "synthetic-server-token", deployment: { mode: "hosted-multiuser", learnerId: "learner" }, fetch: async () => Response.json({}) });
  await expect(restricted.tutor([{ role: "user", content: "x" }])).rejects.toMatchObject({ code: "NAN_POLICY_BLOCKED" });
  expect(redactNanSecret("failure nan_synthetic")).not.toContain("nan_synthetic");
  expect(redactNanHeaders({ Authorization: "Bearer nan_synthetic" }).Authorization).toBe("Bearer [REDACTED_NAN_KEY]");
});
