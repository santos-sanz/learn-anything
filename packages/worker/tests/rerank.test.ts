import { expect, test } from "vitest";

import {
  NanAdapterError,
  resolveRerankOrder,
  rerankFallbackReasonFor,
  type NanRerankResult,
} from "../src/index.js";

const documents = ["alpha", "bravo", "charlie", "delta"];
const provider =
  (results: NanRerankResult[]) =>
  async (): Promise<NanRerankResult[]> =>
    results;

test("applies provider relevance order with a deterministic tie-break on the original index", async () => {
  const outcome = await resolveRerankOrder("q", documents, provider([
    { index: 2, relevanceScore: 0.4 },
    { index: 0, relevanceScore: 0.9 },
    { index: 1, relevanceScore: 0.4 },
    { index: 3, relevanceScore: 0.1 },
  ]));
  expect(outcome).toEqual({ applied: true, order: [0, 1, 2, 3], scores: [0.9, 0.4, 0.4, 0.1] });

  // The same provider payload always reproduces the same order.
  const again = await resolveRerankOrder("q", documents, provider([
    { index: 2, relevanceScore: 0.4 },
    { index: 0, relevanceScore: 0.9 },
    { index: 1, relevanceScore: 0.4 },
    { index: 3, relevanceScore: 0.1 },
  ]));
  expect(again).toEqual(outcome);
});

test("candidates the provider did not return keep their original position at the end", async () => {
  const outcome = await resolveRerankOrder("q", documents, provider([
    { index: 3, relevanceScore: 0.8 },
    { index: 1, relevanceScore: 0.2 },
  ]));
  expect(outcome).toEqual({ applied: true, order: [3, 1, 0, 2], scores: [0.8, 0.2, null, null] });
});

test("a deployment without a key falls back without contacting anything", async () => {
  const outcome = await resolveRerankOrder("q", documents, null);
  expect(outcome).toEqual({ applied: false, reason: "not-configured" });
});

test("a single candidate never calls the provider", async () => {
  let called = false;
  const outcome = await resolveRerankOrder("q", ["only"], async () => {
    called = true;
    return [{ index: 0, relevanceScore: 1 }];
  });
  expect(outcome).toEqual({ applied: false, reason: "single-candidate" });
  expect(called).toBe(false);
});

test("the documented 24,000-character input quota is checked before the provider call", async () => {
  let called = false;
  const bulky = ["x".repeat(9_000), "y".repeat(9_000), "z".repeat(9_000)];
  const outcome = await resolveRerankOrder("q".repeat(2_000), bulky, async () => {
    called = true;
    return [];
  });
  expect(outcome).toEqual({ applied: false, reason: "input-too-large" });
  expect(called).toBe(false);

  // Exactly at the budget still reaches the provider.
  const within = ["x".repeat(9_000), "y".repeat(9_000), "z".repeat(4_000)];
  const ok = await resolveRerankOrder("q".repeat(2_000), within, provider([{ index: 0, relevanceScore: 1 }]));
  expect(ok.applied).toBe(true);
});

test("typed adapter errors map to visible fallback reasons instead of a provider switch", async () => {
  expect(rerankFallbackReasonFor("NAN_POLICY_BLOCKED")).toBe("policy-blocked");
  expect(rerankFallbackReasonFor("NAN_RATE_LIMITED")).toBe("rate-limited");
  expect(rerankFallbackReasonFor("NAN_TIMEOUT")).toBe("timeout");
  expect(rerankFallbackReasonFor("NAN_CANCELLED")).toBe("cancelled");
  expect(rerankFallbackReasonFor("NAN_UNSUPPORTED_MODEL")).toBe("unsupported");
  expect(rerankFallbackReasonFor("NAN_MALFORMED_RESPONSE")).toBe("malformed-response");
  expect(rerankFallbackReasonFor("NAN_INPUT_TOO_LARGE")).toBe("input-too-large");
  expect(rerankFallbackReasonFor("NAN_PROVIDER_ERROR")).toBe("provider-error");

  for (const code of ["NAN_RATE_LIMITED", "NAN_TIMEOUT", "NAN_POLICY_BLOCKED"] as const) {
    const outcome = await resolveRerankOrder("q", documents, async () => {
      throw new NanAdapterError(code, "synthetic failure");
    });
    expect(outcome.applied).toBe(false);
    expect(outcome).toEqual({ applied: false, reason: rerankFallbackReasonFor(code) });
  }

  const transport = await resolveRerankOrder("q", documents, async () => {
    throw new Error("network down");
  });
  expect(transport).toEqual({ applied: false, reason: "provider-error" });
});

test("malformed provider payloads fall back instead of injecting candidates", async () => {
  const payloads: NanRerankResult[][] = [
    [],
    [{ index: 4, relevanceScore: 1 }],
    [{ index: -1, relevanceScore: 1 }],
    [{ index: 1.5, relevanceScore: 1 }],
    [{ index: 1, relevanceScore: 1 }, { index: 1, relevanceScore: 0.5 }],
    [{ index: 1, relevanceScore: Number.NaN }],
    [{ index: 1, relevanceScore: Number.POSITIVE_INFINITY }],
  ];
  for (const payload of payloads) {
    const outcome = await resolveRerankOrder("q", documents, provider(payload));
    expect(outcome).toEqual({ applied: false, reason: "malformed-response" });
  }
});

test("fixed inputs always produce the identical order and scores", async () => {
  const payload = [
    { index: 3, relevanceScore: 0.7 },
    { index: 0, relevanceScore: 0.7 },
    { index: 2, relevanceScore: 0.05 },
  ];
  const runs = await Promise.all(
    Array.from({ length: 5 }, () => resolveRerankOrder("stable query", documents, provider(payload))),
  );
  for (const run of runs) expect(run).toEqual(runs[0]);
  expect(runs[0]).toEqual({ applied: true, order: [0, 3, 2, 1], scores: [0.7, 0.7, 0.05, null] });
});
