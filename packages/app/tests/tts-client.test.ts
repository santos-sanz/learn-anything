import { expect, test } from "vitest";

import { buildTtsUrl, mapTtsResponse, requestTtsAudio, ttsFailureMessage } from "../src/ttsClient.js";

const audioBytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3, 4]);

function audioResponse(bytes: Uint8Array<ArrayBuffer> = audioBytes, contentType = "audio/mpeg"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
}

test("the request URL carries the exact project, turn, language and voice", () => {
  expect(buildTtsUrl("https://test-convex.example/", { projectId: "p1", turnId: "turn-1", language: "en" })).toBe(
    "https://test-convex.example/tts/synthesize?projectId=p1&turnId=turn-1&language=en",
  );
  expect(buildTtsUrl("https://test-convex.example", { projectId: "p1", turnId: "turn-1", language: "es", voice: "ef_dora" })).toBe(
    "https://test-convex.example/tts/synthesize?projectId=p1&turnId=turn-1&language=es&voice=ef_dora",
  );
});

test("every typed route status maps to fixed failure copy", () => {
  expect(mapTtsResponse(401, { code: "UNAUTHENTICATED" })).toMatchObject({ ok: false, code: "unauthenticated" });
  expect(mapTtsResponse(404, { code: "NOT_FOUND" })).toMatchObject({ ok: false, code: "not-found" });
  expect(mapTtsResponse(503, { code: "TTS_NOT_CONFIGURED" })).toMatchObject({ ok: false, code: "not-configured" });
  expect(mapTtsResponse(504, { code: "TTS_TIMEOUT" })).toMatchObject({ ok: false, code: "timeout" });
  expect(mapTtsResponse(502, { code: "TTS_PROVIDER_UNAVAILABLE", upstreamStatus: 524 })).toMatchObject({ ok: false, code: "provider-unavailable" });
  expect(mapTtsResponse(429, { code: "TTS_RATE_LIMITED", retryAfterMs: 3000 })).toMatchObject({ ok: false, code: "rate-limited", retryAfterMs: 3000 });
  expect(mapTtsResponse(413, { code: "TEXT_TOO_LARGE" })).toMatchObject({ ok: false, code: "too-large" });
  expect(mapTtsResponse(400, { code: "INVALID_ARGUMENT" })).toMatchObject({ ok: false, code: "invalid-request" });
});

test("an unsupported voice keeps its configured lists for the UI", () => {
  const result = mapTtsResponse(422, {
    code: "UNSUPPORTED_VOICE",
    supportedVoices: ["af_heart", "ef_dora"],
    supportedLanguages: ["en", "es"],
  });
  expect(result).toMatchObject({
    ok: false,
    code: "unsupported-voice",
    supportedVoices: ["af_heart", "ef_dora"],
    supportedLanguages: ["en", "es"],
  });
  expect(mapTtsResponse(422, { code: "UNSUPPORTED_LANGUAGE" })).toMatchObject({ code: "unsupported-language" });
  expect(mapTtsResponse(422, { code: "VOICE_LANGUAGE_MISMATCH" })).toMatchObject({ code: "unsupported-language" });
  expect(ttsFailureMessage("unsupported-language")).toContain("no configured speech voice");
});

test("a missing token never reaches the network", async () => {
  let called = false;
  const result = await requestTtsAudio({
    siteUrl: "https://test-convex.example",
    token: null,
    projectId: "p1",
    turnId: "turn-1",
    language: "en",
    fetchImpl: async () => {
      called = true;
      return audioResponse();
    },
  });
  expect(result).toMatchObject({ ok: false, code: "unauthenticated" });
  expect(called).toBe(false);
});

test("a successful response resolves to audio bytes and a dropped connection stays typed", async () => {
  const ok = await requestTtsAudio({
    siteUrl: "https://test-convex.example",
    token: "synthetic-token",
    projectId: "p1",
    turnId: "turn-1",
    language: "en",
    fetchImpl: async () => audioResponse(),
  });
  expect(ok.ok).toBe(true);
  if (!ok.ok) throw new Error("expected audio");
  expect(ok.contentType).toBe("audio/mpeg");
  expect(new Uint8Array(await ok.audio.arrayBuffer())).toEqual(audioBytes);

  const dropped = await requestTtsAudio({
    siteUrl: "https://test-convex.example",
    token: "synthetic-token",
    projectId: "p1",
    turnId: "turn-1",
    language: "en",
    fetchImpl: async () => {
      throw new Error("connection reset");
    },
  });
  expect(dropped).toMatchObject({ ok: false, code: "network" });

  const wrongType = await requestTtsAudio({
    siteUrl: "https://test-convex.example",
    token: "synthetic-token",
    projectId: "p1",
    turnId: "turn-1",
    language: "en",
    fetchImpl: async () => Response.json({ code: "NOT_FOUND" }),
  });
  expect(wrongType).toMatchObject({ ok: false, code: "unknown" });
});
