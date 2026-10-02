import { AgentError, agentErrorFromUnknown } from "./errors.js";

/**
 * Workers Free / Durable Objects Free quota handling.
 *
 * On the Workers Free plan, exceeding a free-tier limit makes further
 * operations of that type fail with a platform error (Cloudflare Durable
 * Objects pricing, checked 2026-10-02: "If you exceed any one of the free
 * tier limits, further operations of that type will fail with an error").
 * This module recognises those failures and converts them into a single
 * visible, safe client error. There is no retry-with-upgrade, no paid-plan
 * fallback and no provider substitution anywhere in this path.
 */
export const FREE_PLAN_QUOTA_MESSAGE =
  "Cloudflare Workers Free plan quota reached for the agent runtime; the operation was refused. This deployment never upgrades to a paid plan automatically; retry after the daily limit resets at 00:00 UTC or reduce usage.";

const QUOTA_PATTERNS = [
  /quota/i,
  /storage limit/i,
  /over the limit/i,
  /free[- ]tier/i,
  /exceeded (cpu|memory|resource|storage)/i,
  /error (1027|1102)/i,
  /row (reads|writes) (limit|exceeded)/i,
  /too many requests per day/i,
];

export function isPlatformQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "QuotaExceededError" || name === "ExceededByKernel" || name === "ExceededMemory") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return QUOTA_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Maps a storage/platform failure onto a visible agent error. Quota failures
 * become `AGENT_QUOTA_EXCEEDED` (HTTP 507); anything else stays an internal
 * error so real bugs remain visible instead of being mislabelled as quota.
 */
export function agentErrorForStorageFailure(error: unknown): AgentError {
  if (isPlatformQuotaError(error)) {
    return new AgentError("AGENT_QUOTA_EXCEEDED", FREE_PLAN_QUOTA_MESSAGE, 507);
  }
  return agentErrorFromUnknown(error);
}
