import type { ExtractedBlock } from "../types.js";
import type { ExtractionBudget } from "../safeguards.js";

const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/;

/**
 * Markdown extraction (S09): headings and blank-line paragraphs become blocks
 * with a heading hint. Fenced code is data like any other text: it is copied
 * verbatim into a block and never interpreted or executed. Size/overlap chunk
 * policy is deliberately absent; S10 replaces the process step that consumes
 * these blocks.
 */
export function markdownBlocks(text: string, budget: ExtractionBudget): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  let heading: string | null = null;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const paragraph = current.join("\n").trim();
    current = [];
    if (paragraph.length === 0) return;
    budget.checkTime();
    budget.addText(paragraph);
    budget.addBlock();
    blocks.push({ text: paragraph, locator: { blockIndex: blocks.length, page: null, heading } });
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    const match = ATX_HEADING.exec(line);
    if (match !== null) {
      flush();
      heading = match[1].trim();
      budget.checkTime();
      budget.addText(heading);
      budget.addBlock();
      blocks.push({ text: heading, locator: { blockIndex: blocks.length, page: null, heading } });
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}
