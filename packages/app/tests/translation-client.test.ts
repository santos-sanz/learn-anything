import { expect, test } from "vitest";

import {
  buildAudioTranslationUrl,
  buildTextTranslationUrl,
  mapAudioTranslationResponse,
  mapTextTranslationResponse,
  requestAudioTranslation,
  requestTextTranslation,
} from "../src/translationClient.js";
import { audioTranslationSupport, textTranslationFailureMessage } from "../src/translationState.js";

const SITE = "https://test-convex.example/";
const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });

test("audio translation URLs are explicit about the requested target", () => {
  expect(buildAudioTranslationUrl(SITE, { projectId: "p1", turnId: "t1", target: "en" })).toBe(
    "https://test-convex.example/translation/audio?projectId=p1&turnId=t1&target=en",
  );
  expect(buildTextTranslationUrl(SITE, { projectId: "p 1" })).toBe(
    "https://test-convex.example/translation/text?projectId=p%201",
  );
});

test("an audio translation answer is only trusted when it reports English", () => {
  expect(mapAudioTranslationResponse(200, { text: "hello", turnId: "t1", language: "en", target: "en" })).toEqual({
    ok: true,
    text: "hello",
    turnId: "t1",
  });
  // A non-English answer is never accepted as an English translation.
  expect(mapAudioTranslationResponse(200, { text: "hola", turnId: "t1", language: "es", target: "en" })).toMatchObject({
    ok: false,
    code: "unknown",
  });
  expect(mapAudioTranslationResponse(200, { text: "hello", turnId: "t1", language: "es" })).toMatchObject({ ok: false });
});

test("every unsupported audio combination maps to the actionable fallback code", () => {
  const unsupported = mapAudioTranslationResponse(422, {
    code: "AUDIO_TRANSLATION_UNSUPPORTED",
    supportedTargets: ["en"],
    fallback: "text-translation",
  });
  expect(unsupported).toMatchObject({ ok: false, code: "unsupported-audio-target" });
  if (unsupported.ok) throw new Error("expected a failure");
  expect(unsupported.message).toMatch(/only produces English/);
  expect(unsupported.message).toMatch(/translate the text instead/i);

  expect(audioTranslationSupport("es")).toEqual({
    supported: false,
    message: expect.stringContaining("Audio translation to Spanish is not supported"),
  });
  expect(audioTranslationSupport("en")).toEqual({ supported: true, message: null });
});

test("audio translation failures map status codes to fixed, actionable copy", () => {
  expect(mapAudioTranslationResponse(422, { code: "SILENCE" })).toMatchObject({ ok: false, code: "silence" });
  expect(mapAudioTranslationResponse(400, {})).toMatchObject({ code: "invalid-request" });
  expect(mapAudioTranslationResponse(401, {})).toMatchObject({ code: "unauthenticated" });
  expect(mapAudioTranslationResponse(403, {})).toMatchObject({ code: "provider-policy" });
  expect(mapAudioTranslationResponse(404, {})).toMatchObject({ code: "not-found" });
  expect(mapAudioTranslationResponse(413, {})).toMatchObject({ code: "too-large" });
  expect(mapAudioTranslationResponse(415, {})).toMatchObject({ code: "unsupported-codec" });
  expect(mapAudioTranslationResponse(429, { retryAfterMs: 3000 })).toMatchObject({ code: "rate-limited", retryAfterMs: 3000 });
  expect(mapAudioTranslationResponse(502, {})).toMatchObject({ code: "provider-unavailable" });
  expect(mapAudioTranslationResponse(503, {})).toMatchObject({ code: "not-configured" });
  expect(mapAudioTranslationResponse(504, {})).toMatchObject({ code: "timeout" });
  expect(mapAudioTranslationResponse(599, {})).toMatchObject({ code: "unknown" });
});

test("audio translation never sends a request without a session or for oversize audio", async () => {
  const seen: string[] = [];
  const fetchImpl = async (input: string) => {
    seen.push(input);
    return Response.json({});
  };

  const anonymous = await requestAudioTranslation({
    siteUrl: SITE,
    token: null,
    projectId: "p1",
    turnId: "t1",
    target: "en",
    audio,
    fetchImpl,
  });
  expect(anonymous).toMatchObject({ ok: false, code: "unauthenticated" });

  const huge = await requestAudioTranslation({
    siteUrl: SITE,
    token: "token",
    projectId: "p1",
    turnId: "t1",
    target: "en",
    audio: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], { type: "audio/webm" }),
    fetchImpl,
  });
  expect(huge).toMatchObject({ ok: false, code: "too-large" });
  expect(seen).toEqual([]);
});

test("audio translation sends the chosen target with the session token", async () => {
  let url = "";
  let authorization = "";
  const result = await requestAudioTranslation({
    siteUrl: SITE,
    token: "session-token",
    projectId: "p1",
    turnId: "t1",
    target: "en",
    audio,
    fetchImpl: async (input, init) => {
      url = input;
      authorization = String(new Headers(init?.headers).get("authorization"));
      return Response.json({ text: "hello", turnId: "t1", language: "en", target: "en" });
    },
  });
  expect(result).toEqual({ ok: true, text: "hello", turnId: "t1" });
  expect(url).toContain("target=en");
  expect(authorization).toBe("Bearer session-token");
});

test("text translation sends an explicit source/target pair and keeps the server answer", async () => {
  let body = "";
  const result = await requestTextTranslation({
    siteUrl: SITE,
    token: "session-token",
    projectId: "p1",
    text: "hola mundo",
    source: "es",
    target: "en",
    fetchImpl: async (input, init) => {
      expect(input).toContain("/translation/text?projectId=p1");
      body = String(init?.body);
      return Response.json({ source: "es", target: "en", translation: "hello world", unchanged: false });
    },
  });
  expect(result).toEqual({ ok: true, source: "es", target: "en", translation: "hello world", unchanged: false });
  expect(JSON.parse(body)).toEqual({ text: "hola mundo", source: "es", target: "en" });
});

test("text translation refuses locally what the server would refuse anyway", async () => {
  const seen: string[] = [];
  const fetchImpl = async (input: string) => {
    seen.push(input);
    return Response.json({});
  };

  const anonymous = await requestTextTranslation({
    siteUrl: SITE,
    token: "",
    projectId: "p1",
    text: "hola",
    source: "es",
    target: "en",
    fetchImpl,
  });
  expect(anonymous).toMatchObject({ ok: false, code: "unauthenticated" });

  const oversized = await requestTextTranslation({
    siteUrl: SITE,
    token: "session-token",
    projectId: "p1",
    text: "x".repeat(20_001),
    source: "en",
    target: "es",
    fetchImpl,
  });
  expect(oversized).toMatchObject({ ok: false, code: "text-too-large" });

  const sameLanguage = await requestTextTranslation({
    siteUrl: SITE,
    token: "session-token",
    projectId: "p1",
    text: "hola",
    source: "es",
    target: "es",
    fetchImpl,
  });
  expect(sameLanguage).toEqual({ ok: true, source: "es", target: "es", translation: "hola", unchanged: true });
  expect(seen).toEqual([]);
});

test("text translation failure copy stays fixed and actionable for every code", () => {
  const unsupported = mapTextTranslationResponse(422, { code: "UNSUPPORTED_LANGUAGE_PAIR", supportedLanguages: ["en", "es"] });
  expect(unsupported).toMatchObject({ ok: false, code: "unsupported-language-pair" });
  if (unsupported.ok) throw new Error("expected a failure");
  expect(unsupported.message).toContain("English or Spanish");

  for (const code of [
    "unsupported-language-pair",
    "text-too-large",
    "unauthenticated",
    "not-found",
    "provider-policy",
    "not-configured",
    "invalid-request",
    "timeout",
    "rate-limited",
    "provider-unavailable",
    "network",
    "unknown",
  ] as const) {
    expect(textTranslationFailureMessage(code, null).length).toBeGreaterThan(10);
  }
  expect(textTranslationFailureMessage("rate-limited", 5_000)).toContain("5 seconds");
  expect(mapTextTranslationResponse(200, { source: "en", target: "fr", translation: "x", unchanged: false })).toMatchObject({
    ok: false,
    code: "unknown",
  });
  expect(mapTextTranslationResponse(413, {})).toMatchObject({ code: "text-too-large" });
  expect(mapTextTranslationResponse(503, {})).toMatchObject({ code: "not-configured" });
});
