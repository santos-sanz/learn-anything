import { defaultNanQuotaControls, NanAdapterError } from "./types.js";

/**
 * S13 deterministic rerank ordering around the S11 NaN `/rerank` adapter.
 *
 * The decision is a pure function of (query, documents, provider outcome):
 * the provider's scores reorder candidates by relevance (descending, ties by
 * original index), unreturned candidates keep their original position at the
 * end, and every failure — missing key, provider limit, policy block,
 * malformed payload, transport error — falls back to the caller's original
 * order with a typed reason. Nothing randomises, retries or substitutes
 * another provider, so fixed inputs always produce the same output and the
 * fallback (original similarity order) is a documented behaviour rather than
 * a silent degradation.
 */

/** One candidate document as sent to NaN's `/rerank` endpoint. */
export type NanRerankResult = { index: number; relevanceScore: number };

/** Why a rerank request did not reorder anything; always visible to callers. */
export type RerankFallbackReason =
  | "not-configured"
  | "single-candidate"
  | "input-too-large"
  | "policy-blocked"
  | "rate-limited"
  | "timeout"
  | "cancelled"
  | "unsupported"
  | "malformed-response"
  | "provider-error";

export type RerankOutcome =
  | { applied: true; order: number[]; scores: Array<number | null> }
  | { applied: false; reason: RerankFallbackReason };

/** Maps a typed S11 adapter error to its visible rerank fallback reason. */
export function rerankFallbackReasonFor(code: NanAdapterError["code"]): RerankFallbackReason {
  switch (code) {
    case "NAN_POLICY_BLOCKED":
      return "policy-blocked";
    case "NAN_RATE_LIMITED":
      return "rate-limited";
    case "NAN_TIMEOUT":
      return "timeout";
    case "NAN_CANCELLED":
      return "cancelled";
    case "NAN_UNSUPPORTED_MODEL":
    case "NAN_UNSUPPORTED_CAPABILITY":
      return "unsupported";
    case "NAN_MALFORMED_RESPONSE":
      return "malformed-response";
    case "NAN_INPUT_TOO_LARGE":
      return "input-too-large";
    default:
      return "provider-error";
  }
}

/**
 * Orders `documents` for `query`.
 *
 * `callProvider` is the S11 adapter's `rerank` method, or `null` when the
 * deployment has no provider key: retrieval itself never needs the provider,
 * so a missing key yields the deterministic fallback order with reason
 * `not-configured`. The joined input is checked against the adapter's
 * documented 24,000-character quota BEFORE the call, so a provider limit is a
 * visible `input-too-large` fallback that costs no request.
 *
 * Indices returned by the provider must be integers inside the candidate
 * range and unique; scores must be finite. Anything else (including an empty
 * result set) is `malformed-response` and falls back — a misbehaving provider
 * can never inject an out-of-range or duplicated candidate.
 *
 * Final order: relevance score descending, ties by original index ascending,
 * then any candidate the provider did not return in original order. The same
 * inputs always produce the same `order`/`scores`.
 */
export async function resolveRerankOrder(
  query: string,
  documents: readonly string[],
  callProvider: ((query: string, documents: string[]) => Promise<NanRerankResult[]>) | null,
): Promise<RerankOutcome> {
  if (callProvider === null) return { applied: false, reason: "not-configured" };
  if (documents.length <= 1) return { applied: false, reason: "single-candidate" };
  if (query.length + documents.join("").length > defaultNanQuotaControls.maxInputCharacters) {
    return { applied: false, reason: "input-too-large" };
  }

  let results: NanRerankResult[];
  try {
    results = await callProvider(query, [...documents]);
  } catch (error) {
    if (error instanceof NanAdapterError) return { applied: false, reason: rerankFallbackReasonFor(error.code) };
    return { applied: false, reason: "provider-error" };
  }

  if (!Array.isArray(results) || results.length === 0) return { applied: false, reason: "malformed-response" };
  const seen = new Set<number>();
  for (const result of results) {
    if (result === null || typeof result !== "object") return { applied: false, reason: "malformed-response" };
    if (!Number.isInteger(result.index) || result.index < 0 || result.index >= documents.length) {
      return { applied: false, reason: "malformed-response" };
    }
    if (typeof result.relevanceScore !== "number" || !Number.isFinite(result.relevanceScore)) {
      return { applied: false, reason: "malformed-response" };
    }
    if (seen.has(result.index)) return { applied: false, reason: "malformed-response" };
    seen.add(result.index);
  }

  const ranked = [...results].sort((left, right) => right.relevanceScore - left.relevanceScore || left.index - right.index);
  const order = ranked.map((result) => result.index);
  const scores: Array<number | null> = ranked.map((result) => result.relevanceScore);
  for (let index = 0; index < documents.length; index += 1) {
    if (!seen.has(index)) {
      order.push(index);
      scores.push(null);
    }
  }
  return { applied: true, order, scores };
}
