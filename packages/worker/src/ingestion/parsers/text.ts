import { ParserError } from "../errors.js";
import type { ExtractedBlock } from "../types.js";
import type { ExtractionBudget } from "../safeguards.js";

/**
 * Strict UTF-8 decode; a non-UTF-8 body is malformed input, never a silent
 * replacement-character "success".
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ParserError("MALFORMED_INPUT", "text is not valid UTF-8");
  }
}

/** Splits on blank lines into paragraph blocks, preserving internal line breaks. */
export function plainTextBlocks(text: string, budget: ExtractionBudget): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const paragraph = current.join("\n").trim();
    current = [];
    if (paragraph.length === 0) return;
    budget.checkTime();
    budget.addText(paragraph);
    budget.addBlock();
    blocks.push({ text: paragraph, locator: { blockIndex: blocks.length, page: null, heading: null } });
  };
  for (const line of lines) {
    if (line.trim().length === 0) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}
