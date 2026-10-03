/**
 * Version of the S09 extraction/chunk contract. It is part of every
 * idempotency key, so a contract change writes a new chunk generation instead
 * of colliding with rows produced by the previous one.
 */
export const INGESTION_CONTRACT_VERSION = "1";

/**
 * Parser failures are data, never free-form messages. `UNSUPPORTED_PARSER_CODES`
 * are deterministic for a given input: retrying wastes attempts, so those jobs
 * go straight to the explicit `unsupported` state. The remaining codes are
 * treated as retryable until the attempt budget reaches its dead letter.
 */
export type ParserErrorCode =
  | "UNSUPPORTED_MEDIA_TYPE"
  | "MALFORMED_INPUT"
  | "ENCRYPTED_PDF"
  | "IMAGE_ONLY_PDF"
  | "NO_EXTRACTABLE_TEXT"
  | "PDF_FILTER_UNSUPPORTED"
  | "INPUT_TOO_LARGE"
  | "OUTPUT_TOO_LARGE"
  | "PARSE_TIMEOUT"
  | "PARSE_FAILED";

export const UNSUPPORTED_PARSER_CODES: readonly ParserErrorCode[] = [
  "UNSUPPORTED_MEDIA_TYPE",
  "MALFORMED_INPUT",
  "ENCRYPTED_PDF",
  "IMAGE_ONLY_PDF",
  "NO_EXTRACTABLE_TEXT",
  "PDF_FILTER_UNSUPPORTED",
  "INPUT_TOO_LARGE",
  "OUTPUT_TOO_LARGE",
];

export function isUnsupportedParserCode(code: ParserErrorCode): boolean {
  return UNSUPPORTED_PARSER_CODES.includes(code);
}

/** Hard limits the runner passes in; every extraction checks them while it walks. */
export interface ParseLimits {
  /** Refuse input bytes above this size before any parsing work starts. */
  maxInputBytes: number;
  /** Refuse extraction once the produced text exceeds this many characters. */
  maxOutputChars: number;
  /** Refuse extraction once the produced block count exceeds this bound. */
  maxBlocks: number;
  /** Refuse to keep extracting once the elapsed wall time reaches this bound. */
  maxDurationMs: number;
}

/**
 * Conservative defaults for the <=10 MiB upload cap. The runner may pass a
 * smaller duration; nothing may raise the input cap above the product upload
 * cap without changing the upload path itself.
 */
export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxInputBytes: 10 * 1024 * 1024,
  maxOutputChars: 4_000_000,
  maxBlocks: 2_000,
  maxDurationMs: 10_000,
};

/**
 * Where a block came from. S10's source-aware chunking consumes these hints;
 * S09 only fills what the fixed parsers already know (page number, heading,
 * extraction order).
 */
export interface BlockLocator {
  /** Zero-based extraction order within the document. */
  blockIndex: number;
  /** One-based PDF page number, or null when the source has no pages. */
  page: number | null;
  /** Nearest Markdown heading above the block, or null. */
  heading: string | null;
}

export interface ExtractedBlock {
  text: string;
  locator: BlockLocator;
}

export type SupportedMediaType = "application/pdf" | "text/markdown" | "text/plain";

export interface ParsedDocument {
  mediaType: SupportedMediaType;
  blocks: ExtractedBlock[];
  /** PDF page count, or null for text sources. */
  pageCount: number | null;
}

export interface ParseInput {
  bytes: Uint8Array;
  /** Media type declared by the validated upload; never a filename guess. */
  contentType: string;
  limits?: Partial<ParseLimits>;
}

export interface ProcessInput {
  document: ParsedDocument;
  contentVersionKey: string;
}

/**
 * One output row of the pluggable process step. `chunkKey` is derived from
 * `contentVersionKey` and `seq`, which is what makes replayed runs converge on
 * the same rows instead of appending duplicates.
 */
export interface ChunkDraft {
  contentVersionKey: string;
  seq: number;
  chunkKey: string;
  text: string;
  contentHash: string;
  locator: BlockLocator;
}

export type ProcessStep = (input: ProcessInput) => ChunkDraft[];
