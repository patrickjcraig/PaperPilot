import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const modulePath = new URL("./pdf-viewer.mjs", import.meta.url);
const moduleSource = await readFile(modulePath, "utf8");
const nodeLoadableSource = moduleSource
  .replace(
    /import \{[\s\S]*?\} from "\.\.\/vendor\/pdfjs\/pdf\.min\.mjs";/u,
    `const GlobalWorkerOptions = {};
   class RenderingCancelledException extends Error {}
   class TextLayer {}
   const getDocument = () => { throw new Error("PDF.js is not used by pure helper tests"); };
   const pdfjsVersion = "test-stub";`,
  )
  .replace(
    /const PDFJS_ASSET_URLS = Object\.freeze\(\{[\s\S]*?\}\);/u,
    `const PDFJS_ASSET_URLS = Object.freeze({
      worker: "https://paperpilot.invalid/vendor/pdfjs/pdf.worker.min.mjs",
      standardFonts: "https://paperpilot.invalid/vendor/pdfjs/standard_fonts/",
      cmaps: "https://paperpilot.invalid/vendor/pdfjs/cmaps/",
      wasm: "https://paperpilot.invalid/vendor/pdfjs/wasm/",
    });`,
  );
assert.notEqual(nodeLoadableSource, moduleSource, "the PDF.js browser import should be replaced for pure tests");
const viewerModule = await import(`data:text/javascript;base64,${Buffer.from(nodeLoadableSource).toString("base64")}`);

test("pinned document facts identify the exact local arXiv v7 bytes", () => {
  assert.equal(viewerModule.ATTENTION_PDF.filename, "attention-is-all-you-need-1706.03762v7.pdf");
  assert.equal(viewerModule.ATTENTION_PDF.byteLength, 2_215_244);
  assert.equal(viewerModule.ATTENTION_PDF.pageCount, 15);
  assert.equal(
    viewerModule.ATTENTION_PDF.sha256,
    "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697",
  );
});

test("user-selected PDF bytes get a local digest identity without upload or fixture assumptions", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nminimal test bytes\n%%EOF");
  const source = await viewerModule.preparePdfDocumentSource({
    pdfFile: {
      name: "my_first-paper.PDF",
      size: bytes.byteLength,
      type: "application/pdf",
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    },
    title: "  A Reader's First Paper  ",
  });

  assert.equal(source.filename, "my_first-paper.PDF");
  assert.equal(source.title, "A Reader's First Paper");
  assert.equal(source.byteLength, bytes.byteLength);
  assert.match(source.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(source.paperRef, `paper:sha256:${source.sha256}`);
  assert.equal(source.expectedPageCount, null);
  assert.equal(source.identityMethod, "client_computed_sha256");
  assert.equal(source.sourceUrl, null);
});

test("browser-local PDF preparation rejects a declared oversize file before reading bytes", async () => {
  let read = false;
  await assert.rejects(
    viewerModule.preparePdfDocumentSource({
      pdfFile: {
        name: "too-large.pdf",
        size: 101,
        async arrayBuffer() { read = true; return new ArrayBuffer(0); },
      },
      maxPdfBytes: 100,
    }),
    (error) => error.code === "PDF_TOO_LARGE",
  );
  assert.equal(read, false);
});

test("browser-local PDF preparation fails closed on non-PDF bytes and digest mismatch", async () => {
  await assert.rejects(
    viewerModule.preparePdfDocumentSource({ pdfBytes: new TextEncoder().encode("not a PDF") }),
    (error) => error.code === "PDF_SIGNATURE_MISMATCH",
  );
  await assert.rejects(
    viewerModule.preparePdfDocumentSource({
      pdfBytes: new TextEncoder().encode("%PDF-1.7\nvalid signature"),
      expectedSha256: "0".repeat(64),
    }),
    (error) => error.code === "PDF_SHA256_MISMATCH",
  );
});

test("normalized character mapping resolves the exact source across PDF.js spans", () => {
  const first = { data: "We propose a new simple network architecture, the Transformer," };
  const second = { data: "based solely on attention mechanisms, dispensing with recurrence and convolutions" };
  const third = { data: "entirely." };
  const mapping = viewerModule.buildNormalizedCharacterMap([first, second, third]);
  const match = viewerModule.findUniqueNormalizedMatch(
    mapping.text,
    viewerModule.ATTENTION_SOURCE_ANCHOR.exactText,
  );

  assert.equal(mapping.text, viewerModule.ATTENTION_SOURCE_ANCHOR.exactText);
  assert.equal(match.start, 0);
  assert.equal(match.end, mapping.text.length);
  assert.equal(mapping.positions[match.start].node, first);
  assert.equal(mapping.positions[match.end - 1].node, third);
  assert.equal(mapping.positions[match.end - 1].endOffset, third.data.length);
});

test("source matching fails closed when the sentence is missing or duplicated", () => {
  assert.throws(
    () => viewerModule.findUniqueNormalizedMatch("unrelated page text", "exact sentence"),
    (error) => error.code === "PDF_SOURCE_MATCH_COUNT" && /found 0/u.test(error.message),
  );
  assert.throws(
    () => viewerModule.findUniqueNormalizedMatch("exact sentence exact sentence", "exact sentence"),
    (error) => error.code === "PDF_SOURCE_MATCH_COUNT" && /found 2/u.test(error.message),
  );
});

test("client rectangles are normalized to top-left page coordinates", () => {
  const pageRect = { left: 100, top: 200, width: 600, height: 800 };
  const rects = viewerModule.normalizeClientRects([
    { left: 220, top: 600, right: 520, bottom: 620, width: 300, height: 20 },
  ], pageRect);
  assert.deepEqual(rects, [{ x: 0.2, y: 0.5, width: 0.5, height: 0.025 }]);
});

test("PDF page view boxes are copied, validated, and frozen for provenance", () => {
  const source = [0, 0, 612, 792];
  const viewBox = viewerModule.freezePdfPageViewBox(source);
  source[2] = 1;
  assert.deepEqual(viewBox, [0, 0, 612, 792]);
  assert.equal(Object.isFrozen(viewBox), true);
  assert.throws(
    () => viewerModule.freezePdfPageViewBox([0, 0, 0, 792]),
    (error) => error.code === "PDF_PAGE_VIEWBOX_INVALID",
  );
});

test("PDF.js 6 viewport transforms produce normalized text-item geometry without legacy rectangle helpers", () => {
  const record = viewerModule.buildPdfPageTextRecord({
    pageIndex: 0,
    textItems: [{
      str: "Grounded passage",
      transform: [1, 0, 0, 1, 10, 20],
      width: 80,
      height: 10,
      hasEOL: true,
      dir: "ltr",
    }],
    pageViewBox: [0, 0, 100, 200],
    pageRotation: 0,
    viewport: {
      width: 100,
      height: 200,
      transform: [1, 0, 0, -1, 0, 200],
    },
  });

  assert.deepEqual(record.lines[0].segments[0].normalizedBounds, {
    x: 0.1,
    y: 0.85,
    width: 0.8,
    height: 0.05,
  });
  const geometry = viewerModule.resolvePdfTextRangeGeometry(record, {
    startOffset: 0,
    endOffset: "Grounded".length,
    exactText: "Grounded",
  });
  assert.equal(geometry.geometryCoverage, 1);
  assert.equal(geometry.normalizedBounds.length, 1);
});

test("PDF.js text items become an immutable page index with line provenance", () => {
  const viewport = {
    width: 100,
    height: 200,
    rotation: 0,
    viewBox: [0, 0, 100, 200],
    convertToViewportRectangle([x1, y1, x2, y2]) {
      return [x1, 200 - y1, x2, 200 - y2];
    },
  };
  const record = viewerModule.buildPdfPageTextRecord({
    pageIndex: 2,
    pageLabel: "3",
    viewport,
    textItems: [
      { str: "A critical", width: 25, height: 10, transform: [10, 0, 0, 10, 10, 170], hasEOL: false },
      { str: "idea", width: 12, height: 10, transform: [10, 0, 0, 10, 38, 170], hasEOL: true },
      { str: "has page provenance.", width: 45, height: 10, transform: [10, 0, 0, 10, 10, 150], hasEOL: true },
    ],
  });

  assert.equal(record.pageIndex, 2);
  assert.equal(record.pageLabel, "3");
  assert.equal(record.textCapability, "exact_candidate");
  assert.equal(record.text, "A critical idea\nhas page provenance.");
  assert.equal(record.lines.length, 2);
  assert.equal(record.lines[0].lineId, "page:3:line:1");
  assert.equal(record.lines[0].startOffset, 0);
  assert.equal(record.lines[0].endOffset, "A critical idea".length);
  assert.equal(record.lines[1].startOffset, "A critical idea\n".length);
  assert.equal(record.lines[0].segments.length, 2);
  assert.deepEqual(
    record.lines[0].segments.map(({ startOffset, endOffset, sourceItemIndex }) => ({ startOffset, endOffset, sourceItemIndex })),
    [
      { startOffset: 0, endOffset: 10, sourceItemIndex: 0 },
      { startOffset: 11, endOffset: 15, sourceItemIndex: 1 },
    ],
  );
  assert.deepEqual(record.lines[0].normalizedBounds, [
    { x: 0.1, y: 0.1, width: 0.25, height: 0.05 },
    { x: 0.38, y: 0.1, width: 0.12, height: 0.05 },
  ]);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.lines), true);
  assert.equal(Object.isFrozen(record.lines[0]), true);
  assert.equal(Object.isFrozen(record.lines[0].segments), true);
  assert.equal(Object.isFrozen(record.lines[0].segments[0]), true);

  const clipped = viewerModule.resolvePdfTextRangeGeometry(record, {
    startOffset: 2,
    endOffset: 10,
    exactText: "critical",
  });
  assert.equal(clipped.matchMethod, "issued_offsets");
  assert.deepEqual(clipped.normalizedBounds, [
    { x: 0.15, y: 0.1, width: 0.2, height: 0.05 },
  ]);

  const acrossLineBreak = viewerModule.resolvePdfTextRangeGeometry(record, {
    startOffset: 0,
    endOffset: 1,
    exactText: "idea has page provenance.",
  });
  assert.equal(acrossLineBreak.matchMethod, "unique_normalized_exact_text");
  assert.equal(acrossLineBreak.startOffset, 11);
  assert.equal(acrossLineBreak.normalizedBounds.length, 2);
});

test("labeled focus targets live outside the aria-hidden PDF paint overlay", () => {
  assert.match(moduleSource, /record\.surface\.append\(target\)/u);
  assert.match(moduleSource, /annotationOverlay\.setAttribute\("aria-hidden", "true"\)/u);
  assert.doesNotMatch(moduleSource, /record\.annotationOverlay\.append\(target\)/u);
});

test("a textless PDF page remains an honest visual-only index entry", () => {
  const record = viewerModule.buildPdfPageTextRecord({
    pageIndex: 0,
    textItems: [],
    pageViewBox: [0, 0, 612, 792],
    pageRotation: 0,
    viewport: {
      width: 612,
      height: 792,
      rotation: 0,
      viewBox: [0, 0, 612, 792],
      convertToViewportRectangle(value) { return value; },
    },
  });
  assert.equal(record.textCapability, "visual_only");
  assert.equal(record.text, "");
  assert.deepEqual(record.lines, []);
});

test("overlapping PDF.js span rectangles merge into one visual line", () => {
  const lines = viewerModule.mergeClientRectsByLine([
    { left: 140, top: 456.8, right: 468, bottom: 466.8, width: 328, height: 10 },
    { left: 140, top: 456.1, right: 468, bottom: 466.1, width: 328, height: 10 },
    { left: 140, top: 467.7, right: 177, bottom: 477.7, width: 37, height: 10 },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].left, 140);
  assert.equal(lines[0].right, 468);
  assert.ok(lines[0].height > 10);
});

test("page navigation clamps valid input and preserves the fallback for invalid input", () => {
  assert.equal(viewerModule.clampPdfPageNumber("7", 15, 1), 7);
  assert.equal(viewerModule.clampPdfPageNumber(99, 15, 1), 15);
  assert.equal(viewerModule.clampPdfPageNumber(0, 15, 6), 6);
  assert.equal(viewerModule.clampPdfPageNumber("not-a-page", 15, 6), 6);
});

test("page-count guard rejects oversized PDFs before continuous surfaces are created", () => {
  assert.equal(viewerModule.assertPdfPageCountWithinLimit(300), 300);
  assert.throws(
    () => viewerModule.assertPdfPageCountWithinLimit(301),
    (error) => error.code === "PDF_PAGE_LIMIT_EXCEEDED" && /301 pages/u.test(error.message),
  );
  assert.throws(
    () => viewerModule.assertPdfPageCountWithinLimit(10, 0),
    (error) => error.code === "PDF_PAGE_LIMIT_INVALID",
  );
});

test("continuous scroll selects the page under the reader-oriented viewport line", () => {
  const pages = [
    { pageNumber: 1, top: 0, height: 800 },
    { pageNumber: 2, top: 824, height: 800 },
    { pageNumber: 3, top: 1648, height: 800 },
  ];
  assert.equal(viewerModule.selectActivePageNumber(pages, {
    scrollTop: 300,
    viewportHeight: 600,
  }), 1);
  assert.equal(viewerModule.selectActivePageNumber(pages, {
    scrollTop: 700,
    viewportHeight: 600,
  }), 2);
  assert.equal(viewerModule.selectActivePageNumber(pages, {
    scrollTop: 1_520,
    viewportHeight: 500,
  }), 3);
});

test("page scroll targets honor start, center, and nearest behavior", () => {
  const base = {
    pageTop: 1_000,
    pageHeight: 800,
    scrollTop: 900,
    viewportHeight: 1_000,
    margin: 12,
  };
  assert.equal(viewerModule.calculatePageScrollTop({ ...base, block: "start" }), 988);
  assert.equal(viewerModule.calculatePageScrollTop({ ...base, block: "center" }), 900);
  assert.equal(viewerModule.calculatePageScrollTop({ ...base, block: "nearest" }), 900);
  assert.equal(viewerModule.calculatePageScrollTop({
    ...base,
    pageTop: 2_100,
    block: "nearest",
  }), 1_912);
});

test("virtual render windows pin provenance page 1 and bound work around the active page", () => {
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(1, 15, 2), [1, 2, 3]);
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(8, 15, 2), [1, 6, 7, 8, 9, 10]);
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(15, 15, 2), [1, 13, 14, 15]);
});
