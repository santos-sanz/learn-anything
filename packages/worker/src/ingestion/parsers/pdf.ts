import { isParserError, ParserError } from "../errors.js";
import type { ExtractedBlock } from "../types.js";
import type { ExtractionBudget } from "../safeguards.js";

/**
 * Deliberately small, dependency-free PDF text extraction for the fixed S09
 * pipeline. It understands only what the synthetic fixtures and ordinary
 * simple PDFs need: top-level objects, page objects, uncompressed or deflate
 * content streams, and the Tj/TJ/'/" text operators. It never executes
 * JavaScript, embedded files or any content from the document.
 *
 * Anything it cannot read safely becomes an explicit unsupported code
 * (ENCRYPTED_PDF, IMAGE_ONLY_PDF, PDF_FILTER_UNSUPPORTED, ...) instead of a
 * partial or silent success.
 */

interface PdfObject {
  dict: string;
  stream: string | null;
}

const HEADER_SEARCH_BYTES = 1024;
const TAIL_SEARCH_BYTES = 4096;

function decodeLatin1(bytes: Uint8Array): string {
  let text = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const end = Math.min(offset + chunk, bytes.length);
    let piece = "";
    for (let index = offset; index < end; index += 1) piece += String.fromCharCode(bytes[index]);
    text += piece;
  }
  return text;
}

/** True when `needle` occurs outside literal/hex strings and stream bodies. */
function findOutsideLiterals(source: string, needle: string): boolean {
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "(") {
      index = skipLiteralString(source, index).next;
      continue;
    }
    if (source.startsWith("<<", index)) {
      // Dictionary interiors stay scanned: the trailer dictionary carries /Encrypt.
      index += 2;
      continue;
    }
    if (source.startsWith(">>", index)) {
      index += 2;
      continue;
    }
    if (char === "<" && source[index + 1] !== "<") {
      const close = source.indexOf(">", index + 1);
      index = close === -1 ? source.length : close + 1;
      continue;
    }
    const before = index === 0 ? "" : source[index - 1];
    if (
      source.startsWith("stream", index) &&
      /[\r\n]/.test(source[index + 6] ?? "") &&
      !/[A-Za-z]/.test(before)
    ) {
      const end = source.indexOf("endstream", index + 6);
      index = end === -1 ? source.length : end + "endstream".length;
      continue;
    }
    if (char === needle[0] && source.startsWith(needle, index)) {
      const after = source[index + needle.length] ?? "";
      if (after === "" || /[\s/[\]<>()[\]{}%]/.test(after)) return true;
    }
    index += 1;
  }
  return false;
}

function skipLiteralString(source: string, start: number): { value: string; next: number } {
  let depth = 0;
  let index = start;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1] ?? "";
      if (next === "n") value += "\n";
      else if (next === "r") value += "\r";
      else if (next === "t") value += "\t";
      else if (next === "b") value += "\b";
      else if (next === "f") value += "\f";
      else if (next >= "0" && next <= "7") {
        let octal = "";
        let cursor = index + 1;
        while (cursor < source.length && octal.length < 3 && source[cursor] >= "0" && source[cursor] <= "7") {
          octal += source[cursor];
          cursor += 1;
        }
        value += String.fromCharCode(parseInt(octal, 8));
        index = cursor;
        continue;
      } else if (next === "\r" && source[index + 2] === "\n") {
        index += 3;
        continue;
      } else value += next;
      index += 2;
      continue;
    }
    if (char === "(") {
      depth += 1;
      if (depth > 1) value += "(";
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { value, next: index + 1 };
      value += ")";
    } else value += char;
    index += 1;
  }
  return { value, next: source.length };
}

function decodePdfText(bytes: string): string {
  if (bytes.length >= 2 && bytes.charCodeAt(0) === 0xfe && bytes.charCodeAt(1) === 0xff) {
    let text = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode(((bytes.charCodeAt(index) << 8) | bytes.charCodeAt(index + 1)) & 0xffff);
    }
    return text;
  }
  return bytes;
}

function readHexString(source: string, start: number): { value: string; next: number } {
  const close = source.indexOf(">", start + 1);
  const end = close === -1 ? source.length : close;
  const digits = source.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, "");
  let bytes = "";
  for (let index = 0; index + 1 < digits.length; index += 2) bytes += String.fromCharCode(parseInt(digits.slice(index, index + 2), 16));
  if (digits.length % 2 === 1) bytes += String.fromCharCode(parseInt(digits.slice(-1) + "0", 16));
  return { value: decodePdfText(bytes), next: end + 1 };
}

interface ContentScan {
  /** Non-empty text runs produced by Tj/TJ/'/" operators, in order. */
  runs: string[];
  /** Whether the page drew an external object (image or form) with `Do`. */
  drewObject: boolean;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\0" || char === "\f" || char === "\b" || char === "\v";
}

/** Text operator scan: strings are data, dictionaries and inline images are skipped. */
function scanContentStream(content: string): ContentScan {
  const runs: string[] = [];
  let pending: string[] = [];
  let quoteMode = false;
  let dictDepth = 0;
  let drewObject = false;
  let index = 0;

  const flush = (): void => {
    const text = pending.map((part) => part.trim()).filter((part) => part.length > 0).join(" ");
    pending = [];
    quoteMode = false;
    if (text.length > 0) runs.push(text);
  };

  while (index < content.length) {
    const char = content[index];
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }
    if (char === "%") {
      const newline = content.indexOf("\n", index);
      index = newline === -1 ? content.length : newline + 1;
      continue;
    }
    if (content.startsWith("<<", index)) {
      dictDepth += 1;
      index += 2;
      continue;
    }
    if (content.startsWith(">>", index)) {
      dictDepth = Math.max(0, dictDepth - 1);
      index += 2;
      continue;
    }
    if (char === "(") {
      const read = skipLiteralString(content, index);
      index = read.next;
      if (dictDepth === 0) {
        if (quoteMode) {
          runs.push(read.value.trim());
          quoteMode = false;
        } else pending.push(read.value);
      }
      continue;
    }
    if (char === "<") {
      const read = readHexString(content, index);
      index = read.next;
      if (dictDepth === 0) {
        if (quoteMode) {
          runs.push(read.value.trim());
          quoteMode = false;
        } else pending.push(read.value);
      }
      continue;
    }
    if (char === "[") {
      if (dictDepth === 0) pending = [];
      index += 1;
      continue;
    }
    if (char === "]") {
      index += 1;
      continue;
    }
    if (char === "/" ) {
      let end = index + 1;
      while (end < content.length && !isWhitespace(content[end]) && !"/[]()<>%".includes(content[end])) end += 1;
      index = end;
      continue;
    }
    if (char >= "0" && char <= "9" || char === "-" || char === "+" || char === ".") {
      let end = index + 1;
      while (end < content.length && /[0-9.+-]/.test(content[end])) end += 1;
      index = end;
      continue;
    }
    let end = index;
    while (end < content.length && /[A-Za-z*'"]/.test(content[end])) end += 1;
    if (end === index) {
      index += 1;
      continue;
    }
    const keyword = content.slice(index, end);
    index = end;
    if (keyword === "Tj" || keyword === "TJ") flush();
    else if (keyword === "'" || keyword === '"') {
      quoteMode = true;
      if (keyword === "'") pending = [];
    } else if (keyword === "Do") drewObject = true;
    else if (keyword === "ID") {
      const inline = /\sEI[\s\r\n]/.exec(content.slice(index));
      index = inline === null ? content.length : index + inline.index + inline[0].length;
    } else if (keyword !== "BT" && keyword !== "ET") flush();
  }
  flush();
  return { runs, drewObject };
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

async function inflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new ParserError("PDF_FILTER_UNSUPPORTED", "deflate streams are not available in this runtime");
  }
  let parts: Uint8Array[];
  try {
    const reader = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ParserError("OUTPUT_TOO_LARGE", "decompressed stream exceeds the output cap");
      parts.push(value);
    }
  } catch (error) {
    if (isParserError(error)) throw error;
    throw new ParserError("PDF_FILTER_UNSUPPORTED", "deflate stream could not be decoded");
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function contentOf(object: PdfObject | undefined, maxBytes: number): Promise<string> {
  if (object === undefined || object.stream === null) return "";
  const raw = object.stream;
  if (/\/Filter/.test(object.dict)) {
    if (!/\/FlateDecode/.test(object.dict)) throw new ParserError("PDF_FILTER_UNSUPPORTED", "unsupported content stream filter");
    const bytes = await inflate(latin1Bytes(raw), maxBytes);
    return decodeLatin1(bytes);
  }
  return raw;
}

function contentsRefs(dict: string): number[] {
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(dict);
  if (array !== null) {
    const refs: number[] = [];
    for (const match of array[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(match[1]));
    return refs;
  }
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict);
  return single === null ? [] : [Number(single[1])];
}

export async function parsePdf(bytes: Uint8Array, budget: ExtractionBudget): Promise<{ blocks: ExtractedBlock[]; pageCount: number }> {
  const headerAt = decodeLatin1(bytes.subarray(0, Math.min(bytes.length, HEADER_SEARCH_BYTES))).indexOf("%PDF-");
  if (headerAt === -1) throw new ParserError("MALFORMED_INPUT", "missing PDF header");
  const tail = decodeLatin1(bytes.subarray(Math.max(0, bytes.length - TAIL_SEARCH_BYTES)));
  if (!tail.includes("%%EOF")) throw new ParserError("MALFORMED_INPUT", "missing PDF end marker");

  const source = decodeLatin1(bytes);
  // Checked before any structural parse so an encrypted body is never decoded.
  if (findOutsideLiterals(source, "/Encrypt")) throw new ParserError("ENCRYPTED_PDF", "encrypted PDFs are not supported");

  const objects = new Map<number, PdfObject>();
  const pages: { position: number; dict: string }[] = [];
  for (const match of source.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) {
    const start = match.index + match[0].length;
    const endObject = source.indexOf("endobj", start);
    const region = source.slice(start, endObject === -1 ? source.length : endObject);
    const streamAt = /stream[\r\n]/.exec(region);
    let stream: string | null = null;
    let dict = region;
    if (streamAt !== null) {
      dict = region.slice(0, streamAt.index);
      const from = streamAt.index + streamAt[0].length;
      const endStream = region.indexOf("endstream", from);
      const payload = endStream === -1 ? region.slice(from) : region.slice(from, endStream);
      // The PDF spec excludes one end-of-line before `endstream` from the data.
      stream = payload.replace(/\r?\n$/, "");
    }
    const id = Number(match[1]);
    objects.set(id, { dict, stream });
    if (/\/Type\s*\/Page(?![A-Za-z])/.test(dict)) pages.push({ position: match.index, dict });
  }
  pages.sort((left, right) => left.position - right.position);

  const hasImageObject = [...objects.values()].some((object) => /\/Subtype\s*\/Image/.test(object.dict));
  if (pages.length === 0) {
    if (hasImageObject) throw new ParserError("IMAGE_ONLY_PDF", "PDF contains images but no readable pages");
    if (source.includes("/ObjStm")) throw new ParserError("PDF_FILTER_UNSUPPORTED", "compressed object streams are not supported");
    throw new ParserError("MALFORMED_INPUT", "PDF contains no page objects");
  }

  const blocks: ExtractedBlock[] = [];
  let sawText = false;
  let pageNumber = 0;
  for (const page of pages) {
    pageNumber += 1;
    budget.checkTime();
    let content = "";
    for (const ref of contentsRefs(page.dict)) content += await contentOf(objects.get(ref), budget.limits.maxOutputChars);
    const scan = scanContentStream(content);
    const text = scan.runs.join(" ");
    if (text.length > 0) {
      sawText = true;
      budget.addText(text);
      budget.addBlock();
      blocks.push({ text, locator: { blockIndex: blocks.length, page: pageNumber, heading: null } });
      continue;
    }
    // A page with no text but drawn objects is scanned/image-only content.
    if (scan.drewObject) throw new ParserError("IMAGE_ONLY_PDF", `page ${pageNumber} has no extractable text`);
  }

  if (!sawText) {
    if (hasImageObject) throw new ParserError("IMAGE_ONLY_PDF", "PDF contains no extractable text");
    throw new ParserError("NO_EXTRACTABLE_TEXT", "PDF contains no extractable text");
  }
  return { blocks, pageCount: pages.length };
}
