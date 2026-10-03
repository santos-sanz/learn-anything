import { ConvexError } from "convex/values";
import { afterEach, expect, test, vi } from "vitest";

import { mapDocumentError } from "../src/documentView.js";
import { nextRetryDecision, parseRetryAfterHeader, retryAfterDelayMs, MAX_AUTO_RETRY_MS } from "../src/retryPolicy.js";
import { requestTranscription, buildTranscribeUrl } from "../src/transcribeClient.js";
import { generatingFailureMessage } from "../src/conversationState.js";

/**
 * S24 client Retry-After contract: a 429 with `Retry-After` is honoured to
 * the millisecond (the next attempt never fires early), the loop is bounded,
 * a long wait is surfaced instead of silently truncated, and an abort stops
 * the wait. No network: every fetch and sleep is injected.
 */

const baseRequest = (overrides: Partial<Parameters<typeof requestTranscription>[0]> = {}) => ({
  siteUrl: "https://test-convex.example",
  token: "token",
  projectId: "project-1",
  language: "en" as const,
  turnId: "turn-1",
  audio: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }),
  ...overrides,
});

const rateLimited = (headers: Record<string, string>, retryAfterMs?: number) =>
  new Response(JSON.stringify({ code: "STT_RATE_LIMITED", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });

const ok = () =>
  new Response(JSON.stringify({ turnId: "turn-1", text: "hello", language: "en", duration: 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.useRealTimers();
});

test("Retry-After is parsed as delta-seconds and rejected when malformed", () => {
  expect(parseRetryAfterHeader("2")).toBe(2000);
  expect(parseRetryAfterHeader(" 45 ")).toBe(45_000);
  expect(parseRetryAfterHeader("0")).toBe(0);
  expect(parseRetryAfterHeader("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  expect(parseRetryAfterHeader("soon")).toBeNull();
  expect(parseRetryAfterHeader(null)).toBeNull();
});

test("the delay is the declared wait, otherwise bounded backoff", () => {
  expect(retryAfterDelayMs(3_000, 1)).toBe(3_000);
  expect(retryAfterDelayMs(null, 1)).toBe(250);
  expect(retryAfterDelayMs(null, 2)).toBe(500);
  expect(retryAfterDelayMs(null, 9)).toBe(MAX_AUTO_RETRY_MS); // capped
  expect(retryAfterDelayMs(10 * 60_000, 1)).toBe(MAX_AUTO_RETRY_MS); // capped, but see the decision below
});

test("the retry decision never truncates a declared wait and stays bounded", () => {
  expect(nextRetryDecision({ retryable: true, attempt: 1, maxAttempts: 2, retryAfterMs: 1_500 })).toEqual({
    retry: true,
    delayMs: 1_500,
  });
  expect(nextRetryDecision({ retryable: true, attempt: 2, maxAttempts: 2, retryAfterMs: 1_500 })).toEqual({
    retry: false,
    reason: "attempts-exhausted",
  });
  expect(nextRetryDecision({ retryable: true, attempt: 1, maxAttempts: 3, retryAfterMs: 60_000 })).toEqual({
    retry: false,
    reason: "wait-too-long",
  });
  expect(nextRetryDecision({ retryable: false, attempt: 1, maxAttempts: 3, retryAfterMs: 100 })).toEqual({
    retry: false,
    reason: "not-retryable",
  });
});

test("a 429 with Retry-After waits the header duration before the next attempt", async () => {
  const delays: number[] = [];
  const attempts: number[] = [];
  let clock = 0;
  const fetchImpl = vi.fn(async () => {
    attempts.push(clock);
    return attempts.length === 1
      ? rateLimited({ "retry-after": "2" }, 2_000)
      : ok();
  });

  const result = await requestTranscription(
    baseRequest({
      fetchImpl: fetchImpl as never,
      sleepImpl: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
    }),
  );

  expect(result.ok).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  // The second attempt fires only after the server's declared wait.
  expect(delays).toEqual([2_000]);
  expect(attempts[1]).toBeGreaterThanOrEqual(2_000);
});

test("the larger of the header and body wait wins", async () => {
  const delays: number[] = [];
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? rateLimited({ "retry-after": "3" }, 500) : ok();
  });

  const result = await requestTranscription(
    baseRequest({ fetchImpl: fetchImpl as never, sleepImpl: async (ms) => { delays.push(ms); } }),
  );
  expect(result.ok).toBe(true);
  expect(delays).toEqual([3_000]);
});

test("the retry loop is bounded: repeated 429s surface the wait instead of looping", async () => {
  const fetchImpl = vi.fn(async () => rateLimited({ "retry-after": "1" }, 1_000));
  const result = await requestTranscription(
    baseRequest({ fetchImpl: fetchImpl as never, sleepImpl: async () => undefined }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe("rate-limited");
  expect(result.retryAfterMs).toBe(1_000);
  expect(fetchImpl).toHaveBeenCalledTimes(2); // DEFAULT_TRANSCRIBE_MAX_ATTEMPTS
});

test("a wait beyond the auto-retry cap is never truncated and never retried", async () => {
  const sleep = vi.fn(async () => undefined);
  const fetchImpl = vi.fn(async () => rateLimited({ "retry-after": "120" }, 120_000));

  const result = await requestTranscription(baseRequest({ fetchImpl: fetchImpl as never, sleepImpl: sleep }));

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.retryAfterMs).toBe(120_000); // the full declared wait, not 15 s
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("an abort while waiting for the Retry-After window stops the loop", async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn(async () => rateLimited({ "retry-after": "1" }, 1_000));
  const sleepImpl = vi.fn(async (_ms: number, signal?: AbortSignal) => {
    controller.abort();
    if (signal?.aborted === true) throw new Error("aborted");
  });

  const result = await requestTranscription(
    baseRequest({ fetchImpl: fetchImpl as never, sleepImpl, signal: controller.signal }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe("network");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("non-rate-limit failures are never auto-retried", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "SILENCE" }), { status: 422 }));
  const sleep = vi.fn(async () => undefined);
  const result = await requestTranscription(baseRequest({ fetchImpl: fetchImpl as never, sleepImpl: sleep }));
  expect(result.ok).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("a missing token or an oversize recording fails before any request", async () => {
  const fetchImpl = vi.fn(async () => ok());
  const anonymous = await requestTranscription(baseRequest({ token: null, fetchImpl: fetchImpl as never }));
  expect(anonymous.ok).toBe(false);
  const huge = await requestTranscription(
    baseRequest({ audio: new Blob([new Uint8Array(9 * 1024 * 1024)]), fetchImpl: fetchImpl as never }),
  );
  expect(huge.ok).toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("the transcribe URL contract is unchanged", () => {
  expect(buildTranscribeUrl("https://test-convex.example/", { projectId: "p", language: "es", turnId: "t" })).toBe(
    "https://test-convex.example/stt/transcribe?projectId=p&language=es&turnId=t",
  );
});

test("new limit codes map to fixed, telemetry-safe copy", () => {
  expect(generatingFailureMessage("TURN_CONCURRENCY_LIMIT", null)).toContain("Too many of your turns are still running");
  expect(mapDocumentError(new ConvexError({ code: "RATE_LIMITED" }), "upload")).toBe(
    "Too many requests right now. Wait a moment, then try again.",
  );
  // No backend message is ever interpolated.
  const hostile = new Error("server detail with sk-canary-secret");
  expect(mapDocumentError(hostile, "upload")).not.toContain("sk-canary-secret");
});
