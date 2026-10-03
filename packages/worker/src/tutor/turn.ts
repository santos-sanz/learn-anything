import { NanAdapterError, type NanFetchOptions, type NanMessage } from "../nan/types.js";

/**
 * S14 turn execution around the S11 NaN chat adapter.
 *
 * - The answer is consumed through the adapter's `streamTutor` (provider
 *   streaming) into a bounded buffer: text above `maxAnswerChars` stops the
 *   turn immediately instead of being stored truncated, and the caller's
 *   `AbortSignal` is threaded into the request so cancellation aborts the
 *   in-flight provider call.
 * - Retries are bounded and typed. Only demonstrably transient failures
 *   (rate limit, timeout, transport/provider error) are retried, with the
 *   provider's `Retry-After` honoured when present and an exponential
 *   fallback otherwise. Policy blocks, unsupported capabilities, oversized
 *   input, malformed responses and cancellation fail immediately — visible,
 *   never silently routed to another provider.
 * - The only client used is the one handed in: this module never constructs a
 *   provider client and never falls back to a different one.
 */

export type TutorFailureCode =
  | "TURN_NOT_CONFIGURED"
  | "TURN_TIMEOUT"
  | "TURN_RATE_LIMITED"
  | "TURN_CANCELLED"
  | "TURN_POLICY_BLOCKED"
  | "TURN_INPUT_TOO_LARGE"
  | "TURN_PROVIDER_UNSUPPORTED"
  | "TURN_PROVIDER_MALFORMED"
  | "TURN_PROVIDER_ERROR"
  | "TURN_ANSWER_TOO_LONG"
  | "TURN_RETRIES_EXHAUSTED";

export class TutorTurnError extends Error {
  public constructor(
    public readonly code: TutorFailureCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TutorTurnError";
  }
}

/** The subset of the S11 client a turn needs; tests substitute a fake. */
export interface TutorStreamSource {
  streamTutor(messages: NanMessage[], options?: NanFetchOptions): AsyncGenerator<string>;
}

export interface TutorPrompt {
  readonly system: string;
  readonly user: string;
}

export interface RunTutorTurnOptions {
  readonly signal?: AbortSignal;
  /** Total provider attempts including the first; bounded to [1, 5]. */
  readonly maxAttempts?: number;
  /** Base for the exponential fallback delay when the provider sends no Retry-After. */
  readonly retryBaseMs?: number;
  /** Hard ceiling for any single delay, including a provider Retry-After. */
  readonly maxRetryDelayMs?: number;
  readonly maxAnswerChars?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface TutorTurnOutcome {
  readonly text: string;
  readonly attempts: number;
}

export const TUTOR_MAX_ANSWER_CHARS = 16_000;
export const TUTOR_MAX_ATTEMPTS = 3;
export const TUTOR_RETRY_BASE_MS = 250;
export const TUTOR_MAX_RETRY_DELAY_MS = 5_000;

type TutorFailure = { readonly code: TutorFailureCode; readonly retryable: boolean; readonly retryAfterMs?: number };

/** Maps the S11 adapter's typed errors to observable turn failures. */
export function tutorFailureFor(error: unknown): TutorFailure {
  if (error instanceof TutorTurnError) return { code: error.code, retryable: false, retryAfterMs: error.retryAfterMs };
  if (!(error instanceof NanAdapterError)) return { code: "TURN_PROVIDER_ERROR", retryable: false };
  switch (error.code) {
    case "NAN_TIMEOUT":
      return { code: "TURN_TIMEOUT", retryable: true };
    case "NAN_RATE_LIMITED":
      return { code: "TURN_RATE_LIMITED", retryable: true, retryAfterMs: error.retryAfterMs };
    case "NAN_CANCELLED":
      return { code: "TURN_CANCELLED", retryable: false };
    case "NAN_POLICY_BLOCKED":
      return { code: "TURN_POLICY_BLOCKED", retryable: false };
    case "NAN_INPUT_TOO_LARGE":
      return { code: "TURN_INPUT_TOO_LARGE", retryable: false };
    case "NAN_UNSUPPORTED_MODEL":
    case "NAN_UNSUPPORTED_CAPABILITY":
      return { code: "TURN_PROVIDER_UNSUPPORTED", retryable: false };
    case "NAN_MALFORMED_RESPONSE":
      return { code: "TURN_PROVIDER_MALFORMED", retryable: false };
    case "NAN_PROVIDER_ERROR":
      return { code: "TURN_PROVIDER_ERROR", retryable: true };
    default:
      return { code: "TURN_PROVIDER_ERROR", retryable: false };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resolveAttempts(maxAttempts: number | undefined): number {
  if (maxAttempts === undefined) return TUTOR_MAX_ATTEMPTS;
  if (!Number.isFinite(maxAttempts)) return TUTOR_MAX_ATTEMPTS;
  return Math.trunc(clamp(maxAttempts, 1, 5));
}

function retryDelayMs(failure: TutorFailure, attempt: number, options: RunTutorTurnOptions): number {
  const ceiling = options.maxRetryDelayMs ?? TUTOR_MAX_RETRY_DELAY_MS;
  const base = options.retryBaseMs ?? TUTOR_RETRY_BASE_MS;
  const fallback = base * 2 ** (attempt - 1);
  const wanted = failure.retryAfterMs ?? fallback;
  if (!Number.isFinite(wanted) || wanted < 0) return 0;
  return Math.min(wanted, Math.max(ceiling, 0));
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Consumes one provider stream into a bounded buffer, stopping on abort or overflow. */
async function consumeAnswer(
  stream: AsyncGenerator<string>,
  maxAnswerChars: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (signal?.aborted) throw new TutorTurnError("TURN_CANCELLED", "Turn cancelled while streaming the answer.");
    text += chunk;
    if (text.length > maxAnswerChars) {
      throw new TutorTurnError("TURN_ANSWER_TOO_LONG", `Tutor answer exceeded ${maxAnswerChars} characters.`);
    }
  }
  if (signal?.aborted) throw new TutorTurnError("TURN_CANCELLED", "Turn cancelled while streaming the answer.");
  return text;
}

/**
 * Runs one tutor completion with bounded, typed retries.
 *
 * The prompt is sent as exactly two messages (`system`, then the JSON `user`
 * envelope); the caller has already built both, so a retry replays byte-identical
 * input and the eventual commit stays single-shot under the turn's idempotency
 * key. Throws `TutorTurnError` with the last observable failure code when the
 * attempt budget is spent, so the caller reports the real limit instead of a
 * generic error.
 */
export async function runTutorTurn(
  source: TutorStreamSource,
  prompt: TutorPrompt,
  options: RunTutorTurnOptions = {},
): Promise<TutorTurnOutcome> {
  const messages: NanMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  const maxAttempts = resolveAttempts(options.maxAttempts);
  const maxAnswerChars = options.maxAnswerChars ?? TUTOR_MAX_ANSWER_CHARS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new TutorTurnError("TURN_CANCELLED", "Turn cancelled before the provider call.");
    try {
      const text = await consumeAnswer(source.streamTutor(messages, { ...(options.signal === undefined ? {} : { signal: options.signal }) }), maxAnswerChars, options.signal);
      if (text.trim() === "") throw new TutorTurnError("TURN_PROVIDER_MALFORMED", "NaN returned an empty tutor answer.");
      return { text, attempts: attempt };
    } catch (error) {
      const failure = tutorFailureFor(error);
      const terminal = !failure.retryable || attempt >= maxAttempts;
      if (terminal) {
        if (failure.retryable) {
          throw new TutorTurnError(failure.code, `Tutor provider failure persisted after ${attempt} attempt(s).`, failure.retryAfterMs);
        }
        if (error instanceof TutorTurnError) throw error;
        throw new TutorTurnError(failure.code, error instanceof Error ? error.message : "Tutor provider failure.", failure.retryAfterMs);
      }
      await sleep(retryDelayMs(failure, attempt, options));
    }
  }
  /* istanbul ignore next -- the loop always returns or throws. */
  throw new TutorTurnError("TURN_RETRIES_EXHAUSTED", "Tutor attempt budget exhausted.");
}
