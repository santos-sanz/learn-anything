import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { expect, test } from "vitest";

import {
  DEFAULT_PARSE_LIMITS,
  INGESTION_CONTRACT_VERSION,
  ParserError,
  UNSUPPORTED_PARSER_CODES,
  contentVersionKeyFor,
  isUnsupportedParserCode,
  parseDocument,
  parserErrorCode,
  resolveLimits,
  sha256Hex,
  sourceAwareProcessStep,
} from "../src/ingestion/index.js";

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../api/tests/fixtures/${name}`, import.meta.url)));

const pdf = (bytes: Uint8Array) => parseDocument({ bytes, contentType: "application/pdf" });

const expectParserError = async (run: () => Promise<unknown>, code: string): Promise<void> => {
  try {
    await run();
  } catch (error) {
    expect(parserErrorCode(error)).toBe(code);
    expect(error).toBeInstanceOf(ParserError);
    return;
  }
  throw new Error(`expected ParserError ${code}`);
};

test("sha256 matches published vectors for empty, short and padded input", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
});

test("plain text becomes blank-line paragraph blocks", async () => {
  const parsed = await parseDocument({ bytes: fixture("notes.txt"), contentType: "text/plain" });
  expect(parsed.mediaType).toBe("text/plain");
  expect(parsed.pageCount).toBeNull();
  expect(parsed.blocks).toHaveLength(1);
  expect(parsed.blocks[0].text).toContain("Synthetic plain text fixture");
  expect(parsed.blocks[0].locator).toEqual({ blockIndex: 0, page: null, heading: null });
});

test("markdown becomes heading and paragraph blocks with heading hints", async () => {
  const parsed = await parseDocument({ bytes: fixture("lesson.md"), contentType: "text/markdown" });
  expect(parsed.blocks.map((block) => block.text)).toEqual([
    "Lesson one",
    "Synthetic markdown fixture for the S08 upload tests.",
    "- alpha\n- beta",
  ]);
  expect(parsed.blocks.every((block) => block.locator.heading === "Lesson one")).toBe(true);
  expect(parsed.blocks.map((block) => block.locator.blockIndex)).toEqual([0, 1, 2]);
});

test("a two-page PDF extracts one text block per page with page locators", async () => {
  const parsed = await pdf(fixture("text-page.pdf"));
  expect(parsed.mediaType).toBe("application/pdf");
  expect(parsed.pageCount).toBe(2);
  expect(parsed.blocks).toHaveLength(2);
  expect(parsed.blocks[0].text).toBe("Synthetic ingestion lesson page one.");
  expect(parsed.blocks[1].text).toBe("Synthetic ingestion lesson page two.");
  expect(parsed.blocks[0].locator).toEqual({ blockIndex: 0, page: 1, heading: null });
  expect(parsed.blocks[1].locator).toEqual({ blockIndex: 1, page: 2, heading: null });
});

test("an encrypted PDF is an explicit unsupported error, never extracted", async () => {
  await expectParserError(() => pdf(fixture("encrypted.pdf")), "ENCRYPTED_PDF");
  expect(isUnsupportedParserCode("ENCRYPTED_PDF" as never)).toBe(true);
});

test("an image-only scanned PDF is an explicit unsupported error", async () => {
  await expectParserError(() => pdf(fixture("image-only.pdf")), "IMAGE_ONLY_PDF");
});

test("a PDF without text pages and without images reports no extractable text", async () => {
  await expectParserError(() => pdf(fixture("outline.pdf")), "NO_EXTRACTABLE_TEXT");
});

test("structurally broken PDFs are malformed input, not partial success", async () => {
  await expectParserError(() => pdf(fixture("mislabelled.pdf")), "MALFORMED_INPUT");
  await expectParserError(() => pdf(fixture("truncated.pdf")), "MALFORMED_INPUT");
});

test("deflate content streams are decoded with a bounded output cap", async () => {
  const raw = "BT /F1 12 Tf 72 720 Td (Deflated synthetic lesson text.) Tj ET\n";
  const compressed = deflateSync(Buffer.from(raw, "latin1"));
  const pdfBytes = Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n" +
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n" +
        `4 0 obj << /Length ${compressed.length} /Filter /FlateDecode >> stream\n`,
      "latin1",
    ),
    compressed,
    Buffer.from("\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
  const parsed = await pdf(new Uint8Array(pdfBytes));
  expect(parsed.blocks).toHaveLength(1);
  expect(parsed.blocks[0].text).toBe("Deflated synthetic lesson text.");
});

test("an unsupported media type never reaches a parser", async () => {
  await expectParserError(
    () => parseDocument({ bytes: new TextEncoder().encode("<html><body>hi</body></html>"), contentType: "text/html" }),
    "UNSUPPORTED_MEDIA_TYPE",
  );
});

test("the time safeguard stops extraction deterministically", async () => {
  await expectParserError(
    () => parseDocument({ bytes: fixture("lesson.md"), contentType: "text/markdown", limits: { maxDurationMs: 0 } }),
    "PARSE_TIMEOUT",
  );
});

test("the memory safeguards cap input bytes, output characters and block count", async () => {
  await expectParserError(
    () => parseDocument({ bytes: fixture("lesson.md"), contentType: "text/markdown", limits: { maxInputBytes: 8 } }),
    "INPUT_TOO_LARGE",
  );
  await expectParserError(
    () => parseDocument({ bytes: fixture("lesson.md"), contentType: "text/markdown", limits: { maxOutputChars: 4 } }),
    "OUTPUT_TOO_LARGE",
  );
  await expectParserError(
    () => parseDocument({ bytes: fixture("lesson.md"), contentType: "text/markdown", limits: { maxBlocks: 1 } }),
    "OUTPUT_TOO_LARGE",
  );
  await expectParserError(
    () => parseDocument({ bytes: fixture("text-page.pdf"), contentType: "application/pdf", limits: { maxBlocks: 1 } }),
    "OUTPUT_TOO_LARGE",
  );
});

test("malformed limit configuration falls back to the defaults", () => {
  expect(resolveLimits({ maxBlocks: -1, maxOutputChars: Number.NaN })).toEqual(DEFAULT_PARSE_LIMITS);
  expect(resolveLimits({ maxBlocks: 3 })).toMatchObject({ maxBlocks: 3 });
});

test("document content is data: code-looking text is extracted verbatim, never run", async () => {
  const hostile = "# Title\n\n```\neval('boom'); process.exit(1);\n```\n\n<script>alert(1)</script>\n";
  const parsed = await parseDocument({ bytes: new TextEncoder().encode(hostile), contentType: "text/markdown" });
  const text = parsed.blocks.map((block) => block.text).join("\n");
  expect(text).toContain("eval('boom'); process.exit(1);");
  expect(text).toContain("<script>alert(1)</script>");
});

test("the process step merges one region into one deterministic chunk across runs", async () => {
  const bytes = fixture("lesson.md");
  const document = await parseDocument({ bytes, contentType: "text/markdown" });
  const key = contentVersionKeyFor(bytes);
  const first = sourceAwareProcessStep({ document, contentVersionKey: key });
  const second = sourceAwareProcessStep({ document, contentVersionKey: key });
  expect(first).toEqual(second);
  // Every block shares the `Lesson one` heading path, so the default window
  // holds the whole lesson as a single chunk with that locator.
  expect(first).toHaveLength(1);
  expect(first[0].text).toBe(document.blocks.map((block) => block.text).join("\n\n"));
  expect(first[0].chunkKey).toBe(`${key}#0`);
  expect(first[0].seq).toBe(0);
  expect(first[0].contentHash).toBe(sha256Hex(first[0].text));
  expect(first[0].contentVersionKey).toBe(key);
  expect(first[0].locator).toEqual({ blockIndex: 0, page: null, heading: "Lesson one" });
});

test("the content version key combines the content hash with the contract version", async () => {
  const bytes = fixture("text-page.pdf");
  const key = contentVersionKeyFor(bytes);
  expect(key).toBe(`${sha256Hex(bytes)}:v${INGESTION_CONTRACT_VERSION}`);
  expect(contentVersionKeyFor(bytes)).toBe(key);
  expect(contentVersionKeyFor(fixture("encrypted.pdf"))).not.toBe(key);
});

test("ingestion sources contain no evaluator, dynamic code or process spawn", async () => {
  const paths = [
    "../src/ingestion/index.ts",
    "../src/ingestion/parse.ts",
    "../src/ingestion/process.ts",
    "../src/ingestion/hash.ts",
    "../src/ingestion/safeguards.ts",
    "../src/ingestion/errors.ts",
    "../src/ingestion/types.ts",
    "../src/ingestion/parsers/pdf.ts",
    "../src/ingestion/parsers/text.ts",
    "../src/ingestion/parsers/markdown.ts",
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source, path).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|child_process|\bvm\b|Function\s*\(\s*["'`]/);
  }
});

test("every unsupported parser code is terminal and every other code is retryable", () => {
  expect([...UNSUPPORTED_PARSER_CODES].sort()).toEqual(
    [
      "ENCRYPTED_PDF",
      "IMAGE_ONLY_PDF",
      "INPUT_TOO_LARGE",
      "MALFORMED_INPUT",
      "NO_EXTRACTABLE_TEXT",
      "OUTPUT_TOO_LARGE",
      "PDF_FILTER_UNSUPPORTED",
      "UNSUPPORTED_MEDIA_TYPE",
    ].sort(),
  );
  expect(isUnsupportedParserCode("PARSE_TIMEOUT")).toBe(false);
  expect(isUnsupportedParserCode("PARSE_FAILED")).toBe(false);
});
