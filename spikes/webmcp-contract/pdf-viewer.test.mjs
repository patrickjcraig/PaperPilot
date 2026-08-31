import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const modulePath = new URL("./pdf-viewer.mjs", import.meta.url);
const moduleSource = await readFile(modulePath, "utf8");
const nodeLoadableSource = moduleSource.replace(
  /import \{[\s\S]*?\} from "\/vendor\/pdfjs\/pdf\.min\.mjs";/u,
  `const GlobalWorkerOptions = {};
   class RenderingCancelledException extends Error {}
   class TextLayer {}
   const getDocument = () => { throw new Error("PDF.js is not used by pure helper tests"); };
   const pdfjsVersion = "test-stub";`,
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
