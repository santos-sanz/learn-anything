/**
 * S24 client-side Retry-After contract. A `429` may carry the wait in the
 * standard `Retry-After` header (seconds) and/or the route's `retryAfterMs`
 * body field; the client honours whichever is larger, never retries before
 * that moment, and gives up instead of waiting longer than
 * `MAX_AUTO_RETRY_MS`. Without any declared wait, the bounded exponential
 * fallback applies. Every delay is bounded so a retry loop can never run
 * unbounded, and the abort signal stops both the wait and the next attempt.
 */

/** Longest wait the browser will sit through automatically on a 429. */
export const MAX_AUTO_RETRY_MS = 15_000;
/** Fallback base when a 429 declares no wait at all. */
export const RETRY_BASE_MS = 250;

/**
 * Parses the standard `Retry-After` header (delta-seconds) into milliseconds.
 * HTTP-date forms and malformed values resolve to null — never a guess.
 */
export function parseRetryAfterHeader(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000;
}

/**
 * Delay before attempt `attempt + 1`: the declared `Retry-After` when there
 * is one (exactly as the server asked), otherwise bounded exponential backoff.
 */
export function retryAfterDelayMs(
  retryAfterMs: number | null,
  attempt: number,
  options: { baseMs?: number; capMs?: number } = {},
): number {
  const baseMs = options.baseMs ?? RETRY_BASE_MS;
  const capMs = options.capMs ?? MAX_AUTO_RETRY_MS;
  if (retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.trunc(retryAfterMs), capMs);
  }
  const exponent = Math.max(0, Math.trunc(attempt) - 1);
  return Math.min(baseMs * 2 ** exponent, capMs);
}

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: "attempts-exhausted" | "wait-too-long" | "not-retryable" };

/**
 * One bounded retry decision for a failure. A declared wait longer than the
 * auto-retry cap is never truncated (that would violate `Retry-After`); the
 * caller surfaces the wait to the learner instead.
 */
export function nextRetryDecision(options: {
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
  retryAfterMs: number | null;
  capMs?: number;
}): RetryDecision {
  if (!options.retryable) return { retry: false, reason: "not-retryable" };
  if (options.attempt >= options.maxAttempts) return { retry: false, reason: "attempts-exhausted" };
  const capMs = options.capMs ?? MAX_AUTO_RETRY_MS;
  if (options.retryAfterMs !== null && options.retryAfterMs > capMs) {
    return { retry: false, reason: "wait-too-long" };
  }
  return { retry: true, delayMs: retryAfterDelayMs(options.retryAfterMs, options.attempt, { capMs }) };
}

/** Abortable sleep: resolves on the timer, rejects as aborted when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
