/**
 * Deterministic synthetic text vectors for offline retrieval fixtures.
 *
 * `termVector` hashes every word into the same 4096-dimensional space the S12
 * index declares and L2-normalises the row, so cosine similarity between two
 * texts is driven by shared vocabulary: questions rank the chunks that
 * actually talk about them. It is a fixture, not a production embedder — no
 * provider call ever happens in tests, and the same text always yields the
 * byte-identical vector.
 */

/** FNV-1a over UTF-16 code units; stable across runs and platforms. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function termVector(text: string, dimensions = 4096): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word !== "") vector[fnv1a(word) % dimensions] += 1;
  }
  let squares = 0;
  for (const value of vector) squares += value * value;
  const norm = Math.sqrt(squares);
  if (norm > 0) {
    for (let index = 0; index < dimensions; index += 1) vector[index] /= norm;
  }
  return vector;
}
