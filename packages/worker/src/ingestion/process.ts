import { sha256Hex } from "./hash.js";
import type { ChunkDraft, ProcessInput, ProcessStep } from "./types.js";

/**
 * The single pluggable process step of the ingestion runner.
 *
 * Contract (S09 seam, S10 implementation target):
 *
 * - Input: the extracted `ParsedDocument` (blocks with locators) and the
 *   `contentVersionKey` = `sha256(bytes):v<INGESTION_CONTRACT_VERSION>` of the
 *   immutable uploaded bytes.
 * - Output: zero or more `ChunkDraft`s. The runner rejects an empty result as
 *   NO_EXTRACTABLE_TEXT; every draft's `seq` must be its zero-based position
 *   and its `chunkKey` must be `${contentVersionKey}#${seq}`. The runner
 *   derives and validates those keys server-side, so a step that emits a
 *   different key is rejected instead of silently duplicating rows.
 * - Determinism: the same `(document, contentVersionKey)` must always produce
 *   drafts with identical `chunkKey`, `text` and `contentHash`. The commit is
 *   an upsert-by-key: replayed runs keep the existing rows (same `_id`s), a
 *   changed text under the same key fails with CHUNK_CONFLICT, and only a new
 *   contract version writes a new generation.
 * - Scope: this step transforms extraction blocks into chunks. It must never
 *   read the database, call a provider, or embed content (S12/S13 own
 *   embeddings and retrieval). Document text stays data, never instruction.
 *
 * S10 replaces this function with source-aware chunking (size/overlap,
 * heading/page propagation, empty-chunk rules) by passing a different
 * `ProcessStep`; S09's runner, lease/retry logic and commit protocol do not
 * change.
 */
export const defaultProcessStep: ProcessStep = ({ document, contentVersionKey }: ProcessInput): ChunkDraft[] => {
  const drafts: ChunkDraft[] = [];
  let seq = 0;
  for (const block of document.blocks) {
    const text = block.text.trim();
    if (text.length === 0) continue;
    drafts.push({
      contentVersionKey,
      seq,
      chunkKey: `${contentVersionKey}#${seq}`,
      text,
      contentHash: sha256Hex(text),
      locator: { ...block.locator, blockIndex: seq },
    });
    seq += 1;
  }
  return drafts;
};
