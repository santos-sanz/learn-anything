import { expect, test } from "vitest";

import { MAX_AUDIO_BYTES } from "../src/audioCapture.js";
import { buildTranscribeUrl, mapTranscribeResponse, requestTranscription } from "../src/transcribeClient.js";

const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
const base = { siteUrl: "https://test-convex.example", token: "tok-1", projectId: "p1", language: "en" as const, turnId: "turn-1", audio };

test("the request URL targets the authenticated STT route with turn parameters", () => {
  const url = buildTranscribeUrl("https://test-convex.example/", { projectId: "p 1", language: "es", turnId: "turn 1" });
  expect(url).toBe("https://test-convex.example/stt/transcribe?projectId=p+1&language=es&turnId=turn+1");
});

test("a successful transcription keeps the provider's detected language without translating", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await requestTranscription({
    ...base,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ turnId: "turn-1", text: "hola", language: "es", duration: 1.25 });
    },
  });
  expect(result).toEqual({ ok: true, text: "hola", detectedLanguage: "es", durationMs: 1.25, turnId: "turn-1" });
  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call.url).toContain("/stt/transcribe?");
  expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  expect((call.init?.headers as Record<string, string>)["content-type"]).toBe("audio/webm");
  expect(call.init?.body).toBe(audio);
});

test("timeout, 524-adjacent and rate-limit responses map to distinct actionable failures", () => {
  expect(mapTranscribeResponse(504, { code: "STT_TIMEOUT" })).toMatchObject({ ok: false, code: "timeout" });
  expect(mapTranscribeResponse(502, { code: "STT_PROVIDER_UNAVAILABLE", upstreamStatus: 524 })).toMatchObject({
    ok: false,
    code: "provider-unavailable",
  });
  expect(mapTranscribeResponse(429, { code: "STT_RATE_LIMITED", retryAfterMs: 3_000 })).toMatchObject({
    ok: false,
    code: "rate-limited",
    retryAfterMs: 3_000,
    message: expect.stringContaining("3 seconds"),
  });
  expect(mapTranscribeResponse(401, { code: "UNAUTHENTICATED" })).toMatchObject({ ok: false, code: "unauthenticated" });
  expect(mapTranscribeResponse(403, { code: "PROVIDER_POLICY_BLOCKED" })).toMatchObject({ ok: false, code: "provider-policy" });
  expect(mapTranscribeResponse(404, { code: "NOT_FOUND" })).toMatchObject({ ok: false, code: "not-found" });
  expect(mapTranscribeResponse(413, { code: "AUDIO_TOO_LARGE" })).toMatchObject({ ok: false, code: "too-large" });
  expect(mapTranscribeResponse(415, { code: "UNSUPPORTED_CODEC" })).toMatchObject({ ok: false, code: "unsupported-codec" });
  expect(mapTranscribeResponse(422, { code: "SILENCE" })).toMatchObject({ ok: false, code: "silence" });
  expect(mapTranscribeResponse(503, { code: "STT_NOT_CONFIGURED" })).toMatchObject({ ok: false, code: "not-configured" });
  expect(mapTranscribeResponse(500, null)).toMatchObject({ ok: false, code: "unknown" });
  expect(mapTranscribeResponse(400, null)).toMatchObject({ ok: false, code: "invalid-request" });
  for (const result of [
    mapTranscribeResponse(504, null),
    mapTranscribeResponse(429, { retryAfterMs: 1 }),
    mapTranscribeResponse(422, { code: "SILENCE" }),
  ]) {
    if (!result.ok) expect(result.message.length).toBeGreaterThan(10);
  }
});

test("a missing token or an oversize file never reaches the network", async () => {
  const forbidden = async () => {
    throw new Error("fetch must not be called");
  };
  const noToken = await requestTranscription({ ...base, token: null, fetchImpl: forbidden });
  expect(noToken).toMatchObject({ ok: false, code: "unauthenticated" });

  const huge = new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: "audio/webm" });
  const oversize = await requestTranscription({ ...base, audio: huge, fetchImpl: forbidden });
  expect(oversize).toMatchObject({ ok: false, code: "too-large" });
});

test("a dropped connection resolves to a typed network failure", async () => {
  const result = await requestTranscription({
    ...base,
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  expect(result).toMatchObject({ ok: false, code: "network" });
  if (!result.ok) expect(result.message).not.toContain("Failed to fetch");
});
