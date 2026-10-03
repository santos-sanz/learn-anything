import { ParserError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import type { BlockLocator, ChunkConfig, ChunkDraft, ProcessInput, ProcessStep } from "./types.js";
import { CHUNK_SIZE_MAX, CHUNK_SIZE_MIN, DEFAULT_CHUNK_CONFIG, MAX_DOCUMENT_CHUNKS } from "./types.js";

/**
 * Merges a partial chunk configuration over `DEFAULT_CHUNK_CONFIG` and
 * validates it instead of trusting it:
 *
 * - `size` must be an integer in `[CHUNK_SIZE_MIN, CHUNK_SIZE_MAX]`; a value
 *   below the minimum (or a NaN/fractional one) falls back to the default,
 *   a value above the maximum clamps down to it.
 * - `overlap` must be a non-negative integer; otherwise the default applies,
 *   and any overlap that would reach `size` clamps to `size - 1`.
 *
 * The result therefore always satisfies `size >= CHUNK_SIZE_MIN` and
 * `0 <= overlap < size`, which is what keeps the window step positive and
 * the measured overlap well defined for every run.
 */
export function resolveChunkConfig(partial?: Partial<ChunkConfig>): ChunkConfig {
  const rawSize = partial?.size;
  let size = DEFAULT_CHUNK_CONFIG.size;
  if (typeof rawSize === "number" && Number.isInteger(rawSize)) {
    if (rawSize > CHUNK_SIZE_MAX) size = CHUNK_SIZE_MAX;
    else if (rawSize >= CHUNK_SIZE_MIN) size = rawSize;
  }
  const rawOverlap = partial?.overlap;
  let overlap = DEFAULT_CHUNK_CONFIG.overlap;
  if (typeof rawOverlap === "number" && Number.isInteger(rawOverlap) && rawOverlap >= 0) overlap = rawOverlap;
  if (overlap > size - 1) overlap = size - 1;
  return { size, overlap };
}

/**
 * Separator between two source blocks inside one region. Blocks are trimmed
 * by the parsers, so a region text starts and ends with non-whitespace and
 * every window boundary lands on measured character offsets.
 */
const BLOCK_SEPARATOR = "\n\n";

interface LocatedBlock {
  text: string;
  locator: BlockLocator;
}

/**
 * S10 source-aware chunking: the process step implementation for the S09
 * `ProcessStep` seam.
 *
 * Contract (S09 seam, S10 implementation):
 *
 * - Input: the extracted `ParsedDocument` (blocks with locators), the
 *   `contentVersionKey` = `sha256(bytes):v<INGESTION_CONTRACT_VERSION>` of the
 *   immutable uploaded bytes, and an optional `chunking` configuration.
 * - Output: zero or more `ChunkDraft`s. Every draft's `seq` is its zero-based
 *   position and its `chunkKey` is `${contentVersionKey}#${seq}`; the runner
 *   derives and validates those keys server-side. Zero drafts are returned for
 *   empty input: skipping empty text never creates a row.
 * - Structure: consecutive blocks that share the same source region
 *   (`page` for PDFs, `heading` path for Markdown/text) are joined and windowed
 *   with `size` characters per chunk and `overlap` characters carried into the
 *   next chunk. Windows never cross a region boundary, so a chunk's locator is
 *   exactly the region it starts in: the page for PDFs, the nearest heading
 *   path for Markdown, plus the index of the block the chunk starts in.
 * - Determinism: the same `(document, contentVersionKey, chunking)` input
 *   always produces drafts with identical order, `chunkKey`, `text`,
 *   `contentHash` and locator. A replayed run converges on the same rows; a
 *   contract or configuration change is a different generation, never a silent
 *   reorder of the current one.
 * - Measured bounds: every chunk is at most `size` characters, consecutive
 *   chunks in a region share exactly `min(overlap, chunk length)` trailing/
 *   leading characters, and whitespace-only windows are dropped instead of
 *   emitted. Producing more than `MAX_DOCUMENT_CHUNKS` chunks fails with the
 *   terminal `OUTPUT_TOO_LARGE` code instead of writing an uncommittable set.
 * - Scope: this step transforms extraction blocks into chunks. It never reads
 *   the database, calls a provider, or embeds content (S12/S13 own embeddings
 *   and retrieval). Document text stays data, never instruction: the draft
 *   field set is fixed and document content only ever fills `text` and the
 *   locator metadata values.
 */
export const sourceAwareProcessStep: ProcessStep = ({ document, contentVersionKey, chunking }: ProcessInput): ChunkDraft[] => {
  const config = resolveChunkConfig(chunking);
  const step = config.size - config.overlap;
  const drafts: ChunkDraft[] = [];

  const blocks: LocatedBlock[] = [];
  for (const block of document.blocks) {
    const text = block.text.trim();
    if (text.length === 0) continue;
    blocks.push({ text, locator: block.locator });
  }

  const windowRegion = (region: LocatedBlock[]): void => {
    if (region.length === 0) return;
    let text = "";
    const marks: { start: number; locator: BlockLocator }[] = [];
    for (const block of region) {
      if (text.length > 0) text += BLOCK_SEPARATOR;
      marks.push({ start: text.length, locator: block.locator });
      text += block.text;
    }
    for (let start = 0; start < text.length; start += step) {
      const slice = text.slice(start, Math.min(start + config.size, text.length));
      if (slice.trim().length === 0) continue;
      let mark = marks[0];
      for (const candidate of marks) {
        if (candidate.start > start) break;
        mark = candidate;
      }
      if (drafts.length >= MAX_DOCUMENT_CHUNKS) {
        throw new ParserError("OUTPUT_TOO_LARGE", "document yields more chunks than the per-document cap");
      }
      drafts.push({
        contentVersionKey,
        seq: drafts.length,
        chunkKey: `${contentVersionKey}#${drafts.length}`,
        text: slice,
        contentHash: sha256Hex(slice),
        locator: { ...mark.locator },
      });
    }
  };

  let region: LocatedBlock[] = [];
  for (const block of blocks) {
    const previous = region[region.length - 1];
    const sameRegion =
      previous !== undefined &&
      previous.locator.page === block.locator.page &&
      previous.locator.heading === block.locator.heading;
    if (previous !== undefined && !sameRegion) {
      windowRegion(region);
      region = [];
    }
    region.push(block);
  }
  windowRegion(region);

  return drafts;
};
