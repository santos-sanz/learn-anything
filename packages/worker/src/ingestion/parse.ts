import { ParserError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { parsePdf } from "./parsers/pdf.js";
import { markdownBlocks } from "./parsers/markdown.js";
import { decodeUtf8, plainTextBlocks } from "./parsers/text.js";
import { createBudget, resolveLimits } from "./safeguards.js";
import type { ParseInput, ParsedDocument, SupportedMediaType } from "./types.js";
import { INGESTION_CONTRACT_VERSION } from "./types.js";

function mediaTypeFor(contentType: string): SupportedMediaType {
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (mediaType === "application/pdf") return "application/pdf";
  if (mediaType === "text/markdown" || mediaType === "text/x-markdown") return "text/markdown";
  if (mediaType === "text/plain") return "text/plain";
  throw new ParserError("UNSUPPORTED_MEDIA_TYPE", `unsupported media type: ${mediaType}`);
}

/**
 * The fixed S09 parser entry point. Only the three media types above are ever
 * dispatched: there is no interpreter, no plugin lookup from document content
 * and no path that executes bytes from a file. Time and memory limits are
 * enforced inside each parser while it extracts.
 */
export async function parseDocument(input: ParseInput): Promise<ParsedDocument> {
  const limits = resolveLimits(input.limits);
  if (input.bytes.byteLength > limits.maxInputBytes) {
    throw new ParserError("INPUT_TOO_LARGE", "input exceeds the parser byte cap");
  }
  const mediaType = mediaTypeFor(input.contentType);
  const budget = createBudget(limits);
  budget.checkTime();
  if (mediaType === "application/pdf") {
    const { blocks, pageCount } = await parsePdf(input.bytes, budget);
    return { mediaType, blocks, pageCount };
  }
  const text = decodeUtf8(input.bytes);
  const blocks = mediaType === "text/markdown" ? markdownBlocks(text, budget) : plainTextBlocks(text, budget);
  if (blocks.length === 0) throw new ParserError("NO_EXTRACTABLE_TEXT", "document produced no extractable text");
  return { mediaType, blocks, pageCount: null };
}

/**
 * The idempotency key for a document's content generation: content hash plus
 * contract/schema version. Every chunk row a run writes carries this key, so
 * a retried run converges on the same rows instead of appending duplicates.
 */
export function contentVersionKeyFor(bytes: Uint8Array | string): string {
  return `${sha256Hex(bytes)}:v${INGESTION_CONTRACT_VERSION}`;
}
