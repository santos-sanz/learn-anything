import type { ExtractedBlock } from "../types.js";
import type { ExtractionBudget } from "../safeguards.js";

const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/;

interface HeadingLevel {
  level: number;
  text: string;
}

/** `Chapter one > Section alpha`: the full path to the current heading. */
function headingPath(stack: readonly HeadingLevel[]): string {
  return stack.map((heading) => heading.text).join(" > ");
}

/**
 * Markdown extraction (S09 parsers, S10 heading paths): headings and
 * blank-line paragraphs become blocks with a heading hint. The hint is the
 * full path from the outermost heading to the nearest one above the block
 * (`# A` / `## A1` -> `A > A1`), so S10 chunk locators keep the nesting a
 * later citation can show; a level that rises again pops deeper levels off
 * the stack. Fenced code is data like any other text: it is copied verbatim
 * into a block and never interpreted or executed.
 */
export function markdownBlocks(text: string, budget: ExtractionBudget): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  const stack: HeadingLevel[] = [];
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
      const level = (line.trimStart().match(/^#+/) ?? ["#"])[0].length;
      const title = match[1].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: title });
      heading = headingPath(stack);
      budget.checkTime();
      budget.addText(title);
      budget.addBlock();
      blocks.push({ text: title, locator: { blockIndex: blocks.length, page: null, heading } });
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}
