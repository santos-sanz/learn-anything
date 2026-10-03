import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import { maxAudioDurationMs, maxAudioDurationSeconds, parseAudioDurationMs, parseMp4DurationMs, parseWebmDurationMs } from "../convex/audioLimits.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv, TEST_ISSUER } from "./helpers/authEnv.js";

/**
 * S24 audio-duration cap: container-declared durations are read before any
 * provider request, an over-long upload answers `413 AUDIO_TOO_LONG` with the
 * configured budget and zero provider calls, and anything the parser does not
 * fully understand resolves to "unknown" (byte cap still applies) instead of
 * a guess or a crash. Synthetic container fixtures only.
 */
installAuthTestEnv();

process.env.NAN_API_KEY = "synthetic-test-key";
process.env.NAN_DEPLOYER_ID = "owner-a";

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
  "../convex/translation.ts": () => import("../convex/translation.js"),
};

const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });
const makeTest = () => convexTest({ schema, modules });

const originalFetch = globalThis.fetch;
let providerCalls: string[] = [];

beforeEach(() => {
  providerCalls = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    providerCalls.push(url);
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "synthetic transcript", language: "en", duration: 1 });
    if (url.endsWith("/audio/translations")) return Response.json({ text: "synthetic translation", language: "en" });
    throw new Error(`unexpected provider call: ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.MAX_AUDIO_DURATION_SECONDS;
});

/* ------------------------------------------------------------------ *
 * Container fixtures (hand-built, no tooling, no real media)
 * ------------------------------------------------------------------ */

function box(type: string, payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Minimal MP4: `ftyp` plus a `moov/mvhd` that declares the duration. */
function mp4WithDuration(seconds: number): Uint8Array<ArrayBuffer> {
  const ftyp = box("ftyp", concat(new Uint8Array([0x69, 0x73, 0x6f, 0x6d]), new Uint8Array(4)));
  const timescale = 600;
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  payload[0] = 0; // version 0
  view.setUint32(12, timescale, false);
  view.setUint32(16, seconds * timescale, false);
  return concat(ftyp, box("moov", box("mvhd", payload)));
}

/** Minimal WebM: EBML header, Segment/Info with TimecodeScale + Duration. */
function webmWithDuration(seconds: number): Uint8Array<ArrayBuffer> {
  const ebmlHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
  const timecodeScale = new Uint8Array([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
  const duration = new Uint8Array(3 + 1 + 8);
  duration[0] = 0x44;
  duration[1] = 0x89;
  duration[2] = 0x88;
  new DataView(duration.buffer).setFloat64(3, seconds * 1000, false); // milliseconds at a 1 ms scale
  const infoContent = concat(timecodeScale, duration); // 18 bytes
  const info = concat(new Uint8Array([0x15, 0x49, 0xa9, 0x66, 0x80 | infoContent.length]), infoContent);
  const segment = concat(new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x80 | info.length]), info);
  return concat(ebmlHeader, segment);
}

/* ------------------------------------------------------------------ *
 * Parsers
 * ------------------------------------------------------------------ */

test("MP4 and WebM durations are read from the container header", () => {
  expect(parseMp4DurationMs(mp4WithDuration(2))).toBe(2000);
  expect(parseMp4DurationMs(mp4WithDuration(600))).toBe(600_000);
  expect(parseWebmDurationMs(webmWithDuration(2))).toBe(2000);
  expect(parseWebmDurationMs(webmWithDuration(90))).toBe(90_000);
  expect(parseAudioDurationMs(mp4WithDuration(5), "audio/mp4")).toBe(5000);
  expect(parseAudioDurationMs(webmWithDuration(5), "audio/webm")).toBe(5000);
});

test("malformed, truncated and duration-less input resolves to unknown, never a guess", () => {
  expect(parseAudioDurationMs(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), "audio/webm")).toBeNull();
  expect(parseAudioDurationMs(new TextEncoder().encode("%PDF-1.7 not media"), "audio/mp4")).toBeNull();
  // Truncated container: the declared size runs past the end of the buffer.
  const truncated = mp4WithDuration(600).subarray(0, 20);
  expect(parseMp4DurationMs(truncated)).toBeNull();
  // OGG has no header duration by design: the byte cap is the bound.
  expect(parseAudioDurationMs(new Uint8Array(64), "audio/ogg")).toBeNull();
  expect(parseAudioDurationMs(mp4WithDuration(600), "application/octet-stream")).toBeNull();
  // A WebM recording without a Segment Duration (live MediaRecorder output).
  const noDuration = concat(
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80]),
    new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x80]),
  );
  expect(parseWebmDurationMs(noDuration)).toBeNull();
});

test("the duration limit is configurable with bounded fallbacks", () => {
  delete process.env.MAX_AUDIO_DURATION_SECONDS;
  expect(maxAudioDurationSeconds()).toBe(60);
  expect(maxAudioDurationMs()).toBe(60_000);
  process.env.MAX_AUDIO_DURATION_SECONDS = "120";
  expect(maxAudioDurationSeconds()).toBe(120);
  process.env.MAX_AUDIO_DURATION_SECONDS = "0";
  expect(maxAudioDurationSeconds()).toBe(5); // clamps up
  process.env.MAX_AUDIO_DURATION_SECONDS = "99999";
  expect(maxAudioDurationSeconds()).toBe(600); // clamps down
  process.env.MAX_AUDIO_DURATION_SECONDS = "junk";
  expect(maxAudioDurationSeconds()).toBe(60);
});

/* ------------------------------------------------------------------ *
 * Route enforcement
 * ------------------------------------------------------------------ */

test("an over-long MP4 is refused with 413 AUDIO_TOO_LONG before any provider request", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("owner-a|s1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const response = await a.fetch(`/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`, {
    method: "POST",
    headers: { "content-type": "audio/mp4" },
    body: mp4WithDuration(600),
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ code: "AUDIO_TOO_LONG", maxDurationSeconds: 60 });
  expect(providerCalls).toHaveLength(0);
});

test("a within-budget MP4 transcribes normally", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("owner-a|s1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const response = await a.fetch(`/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`, {
    method: "POST",
    headers: { "content-type": "audio/mp4" },
    body: mp4WithDuration(5),
  });

  expect(response.status).toBe(200);
  expect(providerCalls).toHaveLength(1);
});

test("the cap is read from MAX_AUDIO_DURATION_SECONDS at request time", async () => {
  process.env.MAX_AUDIO_DURATION_SECONDS = "30";
  const t = makeTest();
  const a = t.withIdentity(identity("owner-a|s1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const over = await a.fetch(`/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: webmWithDuration(45),
  });
  expect(over.status).toBe(413);
  expect(await over.json()).toEqual({ code: "AUDIO_TOO_LONG", maxDurationSeconds: 30 });
  expect(providerCalls).toHaveLength(0);

  const under = await a.fetch(`/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: webmWithDuration(10),
  });
  expect(under.status).toBe(200);
  expect(providerCalls).toHaveLength(1);
});

test("audio translation applies the same pre-provider duration cap", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("owner-a|s1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const response = await a.fetch(`/translation/audio?projectId=${projectId}&turnId=turn-1&target=en`, {
    method: "POST",
    headers: { "content-type": "audio/mp4" },
    body: mp4WithDuration(600),
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ code: "AUDIO_TOO_LONG", maxDurationSeconds: 60 });
  expect(providerCalls).toHaveLength(0);
});

test("a container without a declared duration stays bounded by the byte cap, not rejected as a guess", async () => {
  const t = makeTest();
  const a = t.withIdentity(identity("owner-a|s1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const response = await a.fetch(`/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  });

  expect(response.status).toBe(200);
  expect(providerCalls).toHaveLength(1);
});
