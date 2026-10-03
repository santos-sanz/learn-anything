import type { ParserErrorCode } from "./types.js";

/**
 * The only error type the fixed parsers raise. `code` is a stable value that
 * the runner maps to `unsupported` or to the bounded retry/dead-letter path;
 * message text is diagnostic only and is never stored.
 */
export class ParserError extends Error {
  readonly code: ParserErrorCode;

  constructor(code: ParserErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ParserError";
    this.code = code;
  }
}

export function isParserError(error: unknown): error is ParserError {
  if (error instanceof ParserError) return true;
  // Duck typing survives a second bundle copy of the class.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ParserError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

export function parserErrorCode(error: unknown): ParserErrorCode | null {
  if (!isParserError(error)) return null;
  const code = (error as ParserError).code;
  return typeof code === "string" ? (code as ParserErrorCode) : null;
}
