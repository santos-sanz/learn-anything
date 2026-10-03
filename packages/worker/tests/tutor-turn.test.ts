import { afterEach, beforeEach, expect, test } from "vitest";

import {
  NanAdapterError,
  NanClient,
  buildTutorSystemPrompt,
  buildTutorUserMessage,
  runTutorTurn,
  tutorFailureFor,
} from "../src/index.js";

/**
 * S14 turn execution tests. Every provider interaction is a synthetic
 * in-process `fetch`/stream: no network, no key, no paid quota anywhere in
 * this file.
 */

const NAN_BASE = "https://api.nan.builders/v1";
const deployment = { mode: "single-user-self-hosted" as const, learnerId: "learner-a", deployerId: "learner-a" };
const prompt = {
  system: buildTutorSystemPrompt({ goal: "Learn biology", mode: "concept-learning", evidenceMode: "document-backed" }),
  user: buildTutorUserMessage({ learnerText: "How do plants make food?", evidence: [] }),
};

/** Deterministic async generator over fixed chunks (optionally throwing first). */
async function* chunks(values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

function failingStream(error: unknown): AsyncGenerator<string> {
  return (async function* () {
    if (error !== undefined) throw error;
    yield "unreachable";
  })();
}

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls = [];
  // Any unexpected fetch is a live-call violation for these offline tests.
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error(`offline tutor test attempted a network call: ${String(input)}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a completed stream returns the answer after exactly one attempt", async () => {
  const outcome = await runTutorTurn({ streamTutor: () => chunks(["Photosynthesis ", "uses ", "light [1]."]) }, prompt);
  expect(outcome).toEqual({ text: "Photosynthesis uses light [1].", attempts: 1 });
  expect(fetchCalls).toEqual([]);
});

test("a rate-limited provider call is retried with the provider's Retry-After and then succeeds", async () => {
  const delays: number[] = [];
  let attempt = 0;
  const outcome = await runTutorTurn(
    {
      streamTutor: () => {
        attempt += 1;
        return attempt === 1
          ? failingStream(new NanAdapterError("NAN_RATE_LIMITED", "slow down", 7))
          : chunks(["Recovered [1]."]);
      },
    },
    prompt,
    { retryBaseMs: 0, sleep: async (ms) => void delays.push(ms) },
  );
  expect(outcome).toEqual({ text: "Recovered [1].", attempts: 2 });
  expect(delays).toEqual([7]);
});

test("policy blocks, unsupported capabilities and oversized input fail immediately without a retry", async () => {
  for (const code of ["NAN_POLICY_BLOCKED", "NAN_UNSUPPORTED_MODEL", "NAN_INPUT_TOO_LARGE", "NAN_MALFORMED_RESPONSE"] as const) {
    let calls = 0;
    await expect(
      runTutorTurn(
        {
          streamTutor: () => {
            calls += 1;
            return failingStream(new NanAdapterError(code, "blocked"));
          },
        },
        prompt,
        { retryBaseMs: 0, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: tutorFailureFor(new NanAdapterError(code, "blocked")).code });
    expect(calls).toBe(1);
  }
});

test("the attempt budget is bounded and reports the real provider limit", async () => {
  let calls = 0;
  await expect(
    runTutorTurn(
      {
        streamTutor: () => {
          calls += 1;
          return failingStream(new NanAdapterError("NAN_RATE_LIMITED", "slow down"));
        },
      },
      prompt,
      { maxAttempts: 3, retryBaseMs: 0, sleep: async () => {} },
    ),
  ).rejects.toMatchObject({ code: "TURN_RATE_LIMITED" });
  expect(calls).toBe(3);
});

test("cancellation before the provider call never reaches the provider", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(
    runTutorTurn(
      {
        streamTutor: () => {
          calls += 1;
          return chunks(["never"]);
        },
      },
      prompt,
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "TURN_CANCELLED" });
  expect(calls).toBe(0);
});

test("cancellation during the stream stops the answer and is not retried", async () => {
  const controller = new AbortController();
  let calls = 0;
  const outcome = runTutorTurn(
    {
      streamTutor: () =>
        (async function* () {
          calls += 1;
          yield "partial";
          controller.abort();
          yield "never written";
        })(),
    },
    prompt,
    { signal: controller.signal, sleep: async () => {} },
  );
  await expect(outcome).rejects.toMatchObject({ code: "TURN_CANCELLED" });
  expect(calls).toBe(1);
});

test("an answer above the bounded buffer fails instead of being stored truncated", async () => {
  await expect(
    runTutorTurn({ streamTutor: () => chunks(["x".repeat(60), "y".repeat(60)]) }, prompt, { maxAnswerChars: 100 }),
  ).rejects.toMatchObject({ code: "TURN_ANSWER_TOO_LONG" });
});

test("an empty provider answer is a malformed response, not an empty message", async () => {
  await expect(runTutorTurn({ streamTutor: () => chunks(["   ", "\n"]) }, prompt)).rejects.toMatchObject({
    code: "TURN_PROVIDER_MALFORMED",
  });
});

test("the turn uses only the injected client - no hidden fetch, no substitute provider", async () => {
  const outcome = await runTutorTurn({ streamTutor: () => chunks(["only the given client"]) }, prompt);
  expect(outcome.text).toBe("only the given client");
  expect(fetchCalls).toEqual([]);
});

/**
 * Adapter-level check: `streamTutor` consumes an SSE body the way the turn
 * expects, and a 429 surfaces as the typed retryable failure.
 */
function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const pieces = text.match(/.{1,12}/gs) ?? [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

test("runTutorTurn drives the real NaN adapter over a mocked SSE stream", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new NanClient({
    apiKey: "synthetic-test-key",
    deployment,
    fetch: (async (input: string, init?: RequestInit) => {
      calls.push({ url: input, body: JSON.parse(String(init?.body)) });
      if (calls.length === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return sseResponse("Grounded in your documents [1].");
    }) as typeof globalThis.fetch,
    quotaControls: { timeoutMs: 1_000 },
  });

  const outcome = await runTutorTurn(client, prompt, { retryBaseMs: 0, sleep: async () => {} });
  expect(outcome).toEqual({ text: "Grounded in your documents [1].", attempts: 2 });
  expect(calls).toHaveLength(2);
  expect(calls[0].url.startsWith(NAN_BASE)).toBe(true);
  expect(calls.every((call) => call.url.startsWith(NAN_BASE))).toBe(true);
  expect((calls[0].body as { stream?: boolean }).stream).toBe(true);
  expect((calls[0].body as { messages: Array<{ role: string }> }).messages.map((message) => message.role)).toEqual([
    "system",
    "user",
  ]);
  // Nothing outside NaN was ever contacted.
  expect(fetchCalls).toEqual([]);
});
