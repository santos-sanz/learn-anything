import { ParserError } from "./errors.js";
import type { ParseLimits } from "./types.js";
import { DEFAULT_PARSE_LIMITS } from "./types.js";

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Merges caller limits over the defaults; a malformed value falls back. */
export function resolveLimits(partial?: Partial<ParseLimits>): ParseLimits {
  return {
    maxInputBytes: Math.floor(positive(partial?.maxInputBytes, DEFAULT_PARSE_LIMITS.maxInputBytes)),
    maxOutputChars: Math.floor(positive(partial?.maxOutputChars, DEFAULT_PARSE_LIMITS.maxOutputChars)),
    maxBlocks: Math.floor(positive(partial?.maxBlocks, DEFAULT_PARSE_LIMITS.maxBlocks)),
    maxDurationMs: Math.floor(positive(partial?.maxDurationMs, DEFAULT_PARSE_LIMITS.maxDurationMs)),
  };
}

/**
 * Time and memory accounting checked incrementally while extracting, so a
 * hostile or oversized input stops at the limit instead of allocating first
 * and validating later.
 */
export interface ExtractionBudget {
  readonly limits: ParseLimits;
  readonly chars: number;
  readonly blocks: number;
  checkTime(): void;
  addText(text: string): void;
  addBlock(): void;
}

export function createBudget(limits: ParseLimits): ExtractionBudget {
  const startedAt = Date.now();
  let chars = 0;
  let blocks = 0;
  return {
    limits,
    get chars() {
      return chars;
    },
    get blocks() {
      return blocks;
    },
    checkTime() {
      if (Date.now() - startedAt >= limits.maxDurationMs) throw new ParserError("PARSE_TIMEOUT");
    },
    addText(text: string) {
      chars += text.length;
      if (chars > limits.maxOutputChars) throw new ParserError("OUTPUT_TOO_LARGE");
    },
    addBlock() {
      blocks += 1;
      if (blocks > limits.maxBlocks) throw new ParserError("OUTPUT_TOO_LARGE");
    },
  };
}
