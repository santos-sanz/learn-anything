/**
 * Version of the extraction/chunk contract. It is part of every idempotency
 * key, so a contract change writes a new chunk generation instead of
 * colliding with rows produced by the previous one.
 *
 * v2 is S10's source-aware chunking (windowed size/overlap, heading paths,
 * region-stable locators): re-running a document that S09 chunked one block
 * per row produces `sha256:v2` keys, and the commit replaces the old v1
 * generation instead of failing CHUNK_CONFLICT on it.
 */
export const INGESTION_CONTRACT_VERSION = "2";

/**
 * Source-aware chunking configuration (S10), in characters of chunk text.
 * `size` is the upper bound of one chunk; `overlap` is how many trailing
 * characters of a chunk are repeated at the start of the next chunk inside
 * the same source region. Overlap is always smaller than size.
 */
export interface ChunkConfig {
  /** Maximum characters per chunk. */
  size: number;
  /** Repeated trailing characters carried into the next chunk (size > overlap >= 0). */
  overlap: number;
}

/**
 * Documented defaults: 1000 characters keeps a chunk far below embedding
 * token limits and retrieval context budgets (S12/S13), and a 100 character
 * (10%) overlap preserves continuity across window boundaries. Tests measure
 * against these values instead of assuming them implicitly.
 */
export const DEFAULT_CHUNK_CONFIG: Readonly<ChunkConfig> = Object.freeze({
  size: 1000,
  overlap: 100,
});

/** Inclusive bounds a configured chunk size must fall within; smaller values fall back to the default, larger values clamp. */
export const CHUNK_SIZE_MIN = 64;
export const CHUNK_SIZE_MAX = 8_000;

/**
 * Hard cap on chunks per document, shared with the Convex commit so the
 * process step fails visibly (OUTPUT_TOO_LARGE, a terminal unsupported code)
 * instead of producing rows the commit would refuse.
 */
export const MAX_DOCUMENT_CHUNKS = 2_000;

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
 * Where a block (and the chunk built from it) came from. S10's source-aware
 * chunking propagates these hints onto every chunk; S09's parsers fill what
 * they already know (page number, heading, extraction order).
 */
export interface BlockLocator {
  /**
   * Zero-based extraction order of the block a chunk starts in. Chunks cut
   * from the same block share it; `chunkKey` (content version + seq), never
   * `blockIndex`, is the row identity.
   */
  blockIndex: number;
  /** One-based PDF page number, or null when the source has no pages. */
  page: number | null;
  /**
   * Nearest Markdown heading above the block as a full path joined with
   * ` > ` (e.g. `Chapter one > Section alpha`), or null for PDFs, plain
   * text and blocks before the first heading. It is stored and cited as
   * data, never interpreted as instruction.
   */
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
  /**
   * Optional S10 chunking override; omitted fields fall back to
   * `DEFAULT_CHUNK_CONFIG` through `resolveChunkConfig`, which also validates
   * and clamps malformed values.
   */
  chunking?: Partial<ChunkConfig>;
}

/**
 * One output row of the pluggable process step. `chunkKey` is derived from
 * `contentVersionKey` and `seq`, which is what makes replayed runs converge on
 * the same rows instead of appending duplicates. The field set is fixed:
 * document content appears only as `text` (and as locator metadata values),
 * never as an instruction, and no derived field can inject a new one.
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
