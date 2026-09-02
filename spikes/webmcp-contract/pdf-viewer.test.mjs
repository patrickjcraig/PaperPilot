import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const modulePath = new URL("./pdf-viewer.mjs", import.meta.url);
const moduleSource = await readFile(modulePath, "utf8");
const nodeLoadableSource = moduleSource
  .replace('from "./pdf-intake.mjs"', `from ${JSON.stringify(new URL("./pdf-intake.mjs", import.meta.url).href)}`)
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

test("pointer regions clamp to a page and keyboard editing stays bounded", () => {
  const pageRect = { left: 100, top: 200, width: 600, height: 800 };
  assert.deepEqual(
    viewerModule.normalizeClientPoint({ clientX: 760, clientY: 120 }, pageRect),
    { x: 1, y: 0 },
  );
  const dragged = viewerModule.normalizeDraggedRegion(
    { x: 0.75, y: 0.8 },
    { x: 0.25, y: 0.3 },
  );
  assert.deepEqual(dragged, { x: 0.25, y: 0.3, width: 0.5, height: 0.5 });

  const moved = viewerModule.adjustNormalizedRegion(dragged, "ArrowRight");
  assert.deepEqual(moved, { x: 0.265, y: 0.3, width: 0.5, height: 0.5 });
  const resized = viewerModule.adjustNormalizedRegion(moved, "ArrowDown", { shiftKey: true });
  assert.deepEqual(resized, { x: 0.265, y: 0.3, width: 0.5, height: 0.515 });
  const ignored = viewerModule.adjustNormalizedRegion(resized, "Enter");
  assert.deepEqual(ignored, resized);
});

test("normalized visual regions translate to rotation-aware PDF-space quadrilaterals", () => {
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  const viewport = {
    width: 100,
    height: 200,
    convertToPdfPoint(x, y) { return [x, 200 - y]; },
  };
  assert.deepEqual(viewerModule.pdfQuadFromNormalizedRegion(rect, viewport), [
    { x: 10, y: 160 },
    { x: 40, y: 160 },
    { x: 40, y: 80 },
    { x: 10, y: 80 },
  ]);
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

test("fit-width scale subtracts the scrollport's complete computed inline padding", () => {
  const scale = viewerModule.calculatePdfFitWidthScale({
    clientWidth: 546,
    pageWidth: 612,
    horizontalPadding: 44,
    minZoom: 0.45,
    maxZoom: 3,
  });
  assert.equal(Number(scale.toFixed(6)), 0.820261);
  assert.throws(
    () => viewerModule.calculatePdfFitWidthScale({ clientWidth: 0, pageWidth: 612 }),
    (error) => error?.code === "PDF_FIT_WIDTH_INVALID",
  );
});

test("rotation metadata and PDF.js affine transforms keep page geometry normalized", () => {
  const cases = [
    {
      rotation: 0,
      width: 100,
      height: 200,
      transform: [1, 0, 0, -1, 0, 200],
      expected: { x: 0.1, y: 0.85, width: 0.3, height: 0.05 },
      expectedFirstHalf: { x: 0.1, y: 0.85, width: 0.15, height: 0.05 },
    },
    {
      rotation: 90,
      width: 200,
      height: 100,
      transform: [0, 1, 1, 0, 0, 0],
      expected: { x: 0.1, y: 0.1, width: 0.05, height: 0.3 },
      expectedFirstHalf: { x: 0.1, y: 0.1, width: 0.05, height: 0.15 },
    },
    {
      rotation: 180,
      width: 100,
      height: 200,
      transform: [-1, 0, 0, 1, 100, 0],
      expected: { x: 0.6, y: 0.1, width: 0.3, height: 0.05 },
      expectedFirstHalf: { x: 0.75, y: 0.1, width: 0.15, height: 0.05 },
    },
    {
      rotation: 270,
      width: 200,
      height: 100,
      transform: [0, -1, -1, 0, 200, 100],
      expected: { x: 0.85, y: 0.6, width: 0.05, height: 0.3 },
      expectedFirstHalf: { x: 0.85, y: 0.75, width: 0.05, height: 0.15 },
    },
  ];

  for (const fixture of cases) {
    const record = viewerModule.buildPdfPageTextRecord({
      pageIndex: 4,
      pageLabel: "5",
      pageViewBox: [0, 0, 100, 200],
      pageRotation: fixture.rotation,
      viewport: {
        width: fixture.width,
        height: fixture.height,
        rotation: fixture.rotation,
        viewBox: [0, 0, 100, 200],
        transform: fixture.transform,
      },
      textItems: [{
        str: "Rotated source",
        transform: [1, 0, 0, 1, 10, 20],
        width: 30,
        height: 10,
        hasEOL: true,
        dir: "ltr",
      }],
    });

    assert.equal(record.pageRotation, fixture.rotation);
    assert.deepEqual(record.pageViewBox, [0, 0, 100, 200]);
    assert.deepEqual(record.lines[0].segments[0].normalizedBounds, fixture.expected);
    const fullRange = viewerModule.resolvePdfTextRangeGeometry(record, {
      startOffset: 0,
      endOffset: "Rotated source".length,
      exactText: "Rotated source",
    });
    assert.deepEqual(fullRange.normalizedBounds, [fixture.expected]);
    assert.equal(fullRange.geometryCoverage, 1);
    const firstHalf = viewerModule.resolvePdfTextRangeGeometry(record, {
      startOffset: 0,
      endOffset: "Rotated".length,
      exactText: "Rotated",
    });
    assert.deepEqual(firstHalf.normalizedBounds, [fixture.expectedFirstHalf]);
  }
});

test("proportional source clipping preserves right-to-left reading order", () => {
  const record = viewerModule.buildPdfPageTextRecord({
    pageIndex: 0,
    pageViewBox: [0, 0, 100, 200],
    pageRotation: 0,
    viewport: {
      width: 100,
      height: 200,
      rotation: 0,
      viewBox: [0, 0, 100, 200],
      transform: [1, 0, 0, -1, 0, 200],
    },
    textItems: [{
      str: "abcdefghij",
      transform: [1, 0, 0, 1, 10, 20],
      width: 30,
      height: 10,
      hasEOL: true,
      dir: "rtl",
    }],
  });
  const firstHalf = viewerModule.resolvePdfTextRangeGeometry(record, {
    startOffset: 0,
    endOffset: 5,
    exactText: "abcde",
  });
  assert.deepEqual(firstHalf.normalizedBounds, [
    { x: 0.25, y: 0.85, width: 0.15, height: 0.05 },
  ]);
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

test("optional page text extraction and layer rendering failures keep successfully rendered pixels without inventing text", async () => {
  for (const failurePhase of ["extraction", "layer"]) {
    const calls = [];
    const result = await viewerModule.renderPdfPageLayers({
      async renderCanvas() { calls.push("canvas"); },
      assertCurrent() { calls.push("current"); },
      async loadTextContent() {
        calls.push("extraction");
        if (failurePhase === "extraction") throw new Error("private extraction details");
        return { items: [{ str: "Actual embedded source" }] };
      },
      async renderTextLayer() { calls.push("layer"); throw new Error("private layer details"); },
    });
    assert.equal(calls[0], "canvas");
    assert.equal(result.textCapability, "visual_only");
    assert.equal(result.textLayer, null);
    assert.equal(result.limitation, failurePhase === "extraction" ? "text_extraction_failed" : "text_layer_failed");
    assert.equal(Object.hasOwn(result, "text"), false);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(Object.isFrozen(result), true);
    assert.match(viewerModule.describePdfTextLimitation(4, result.limitation), /Page 4 is visible/u);
    assert.match(viewerModule.describePdfTextLimitation(4, result.limitation), /Use a page or figure region/u);
  }
});

test("empty or unusable embedded text stays visual-only and never renders a fabricated selectable layer", async () => {
  for (const textContent of [{ items: [] }, { items: [{ str: "  " }, { type: "beginMarkedContent" }] }, { items: {} }, null]) {
    let layerRendered = false;
    const result = await viewerModule.renderPdfPageLayers({
      async renderCanvas() {}, assertCurrent() {},
      async loadTextContent() { return textContent; },
      async renderTextLayer() { layerRendered = true; },
    });
    assert.equal(result.limitation, "no_embedded_text");
    assert.equal(result.textCapability, "visual_only");
    assert.equal(layerRendered, false);
  }
  assert.equal(viewerModule.describePdfTextLimitation(1, null), "");
});

test("canvas failure, required exact-source text failures, and cancellation are never downgraded to optional limitations", async () => {
  for (const failurePhase of ["canvas", "extraction", "layer"]) {
    const failure = new Error(`Required ${failurePhase} failure`);
    await assert.rejects(viewerModule.renderPdfPageLayers({
      requiresExactSource: failurePhase !== "canvas",
      assertCurrent() {},
      async renderCanvas() { if (failurePhase === "canvas") throw failure; },
      async loadTextContent() {
        if (failurePhase === "extraction") throw failure;
        return { items: [{ str: "Actual text" }] };
      },
      async renderTextLayer() { throw failure; },
    }), (error) => error === failure);
  }
  await assert.rejects(viewerModule.renderPdfPageLayers({
    requiresExactSource: true,
    async renderCanvas() {}, assertCurrent() {},
    async loadTextContent() { return { items: [] }; }, async renderTextLayer() {},
  }), (error) => error.code === "PDF_SOURCE_UNAVAILABLE");
  for (const name of ["AbortError", "AbortException", "RenderingCancelledException"]) {
    const cancellation = Object.assign(new Error("cancelled"), { name });
    for (const failurePhase of ["extraction", "layer"]) {
      await assert.rejects(viewerModule.renderPdfPageLayers({
        async renderCanvas() {}, assertCurrent() {},
        async loadTextContent() {
          if (failurePhase === "extraction") throw cancellation;
          return { items: [{ str: "Actual text" }] };
        },
        async renderTextLayer() { throw cancellation; },
      }), (error) => error === cancellation);
    }
  }
});

test("stale page generations escape optional text catches and successful text preserves the actual layer", async () => {
  const stale = new Error("stale generation");
  let current = true;
  await assert.rejects(viewerModule.renderPdfPageLayers({
    async renderCanvas() {},
    assertCurrent() { if (!current) throw stale; },
    async loadTextContent() { current = false; throw new Error("late extraction failure"); },
    async renderTextLayer() { throw new Error("not reached"); },
  }), (error) => error === stale);
  const actualLayer = { textDivs: ["Actual source"] };
  const outcome = await viewerModule.renderPdfPageLayers({
    async renderCanvas() {}, assertCurrent() {},
    async loadTextContent() { return { items: [{ str: "Actual source" }] }; },
    async renderTextLayer() { return actualLayer; },
  });
  assert.equal(outcome.textLayer, actualLayer);
  assert.equal(outcome.textCapability, "exact_candidate");
  assert.equal(outcome.limitation, null);
});

function renderPageHarness(failurePhase, { requiresExactSource = false } = {}) {
  const attributes = () => {
    const values = new Map();
    return {
      values,
      setAttribute: (name, value) => values.set(name, value),
      getAttribute: (name) => values.get(name),
      removeAttribute: (name) => values.delete(name),
    };
  };
  const state = { destroyed: false, failed: false, pdfDocument: { numPages: 2 }, scale: 1, zoomGeneration: 0, anchorGeometry: null };
  const record = {
    pageNumber: 2, generation: 0, renderedScale: null, renderPromise: null, textContentPromise: null,
    surface: { dataset: {}, ...attributes() },
    canvas: { ...attributes(), getContext: () => failurePhase === "context" ? null : {} },
    textLayerElement: { ...attributes(), children: [], replaceChildren() { this.children = []; } },
    textLimitationElement: { id: "page-2-limitation", hidden: true, textContent: "" },
    pdfPage: {
      render() { return { promise: failurePhase === "canvas" ? Promise.reject(new Error("canvas failed")) : Promise.resolve() }; },
      async getTextContent() {
        if (failurePhase === "stale") { state.zoomGeneration += 1; throw new Error("late stale extraction failure"); }
        if (failurePhase === "abort") throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        if (failurePhase === "extraction") throw new Error("extraction failed");
        return { items: failurePhase === "empty" ? [] : [{ str: "Actual source text" }] };
      },
    },
  };
  const failures = [];
  const context = {
    state,
    fixedSourceAnchor: requiresExactSource ? { pageNumber: 2 } : null,
    anchorTarget: { hidden: true },
    viewer: attributes(),
    emitStatus() {},
    applyPageDimensions: () => ({ width: 100, height: 200 }),
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    MAX_DEVICE_PIXEL_RATIO: 2,
    PaperPdfError: viewerModule.PaperPdfError,
    StalePdfRenderError: class extends Error { constructor() { super("stale"); this.name = "StalePdfRenderError"; } },
    isExpectedCancellation: (error) => ["StalePdfRenderError", "AbortError", "RenderingCancelledException", "AbortException"].includes(error.name),
    renderPdfPageLayers: viewerModule.renderPdfPageLayers,
    calculatePdfCanvasAllocation: viewerModule.calculatePdfCanvasAllocation,
    assertPdfTextContentWithinLimits: viewerModule.assertPdfTextContentWithinLimits,
    describePdfTextLimitation: viewerModule.describePdfTextLimitation,
    TextLayer: class {
      async render() {
        record.textLayerElement.children.push("partial real source text");
        if (failurePhase === "layer") throw new Error("layer failed");
      }
      cancel() {}
    },
    resolveSourceAnchor() { throw new Error("required source did not resolve"); },
    fail(error) { state.failed = true; failures.push(error); return error; },
  };
  const start = moduleSource.indexOf("  const assertLivePageRender =");
  const end = moduleSource.indexOf("  const evictPage =", start);
  assert.ok(start >= 0 && end > start);
  const renderPage = runInNewContext(`${moduleSource.slice(start, end)}\nrenderPage;`, context);
  return { renderPage: () => renderPage(record), record, state, failures };
}

test("renderPage keeps weak pages ready, clears partial text, and exposes a page-local accessible limitation", async () => {
  for (const failurePhase of ["extraction", "layer", "empty"]) {
    const fixture = renderPageHarness(failurePhase);
    const result = await fixture.renderPage();
    assert.equal(result.textCapability, "visual_only");
    assert.equal(fixture.state.failed, false);
    assert.deepEqual(fixture.failures, []);
    assert.equal(fixture.record.surface.dataset.renderState, "ready");
    assert.equal(fixture.record.surface.dataset.textLayerState, "unavailable");
    assert.equal(fixture.record.canvas.width, 100);
    assert.equal(fixture.record.canvas.height, 200);
    assert.deepEqual(fixture.record.textLayerElement.children, []);
    assert.equal(fixture.record.textLayerElement.getAttribute("aria-hidden"), "true");
    assert.equal(fixture.record.textLimitationElement.hidden, false);
    assert.match(fixture.record.textLimitationElement.textContent, /Page 2/u);
    assert.equal(fixture.record.surface.getAttribute("aria-describedby"), "page-2-limitation");
    assert.equal(fixture.record.renderedScale, 1);
    assert.equal((await fixture.renderPage()).textCapability, "visual_only");
  }
  assert.match(moduleSource, /textLimitationElement\.setAttribute\("role", "note"\)/u);
  assert.match(moduleSource, /surface\.append\(textLimitationElement\)/u);
});

test("renderPage retains fatal canvas/exact-source failures while stale and aborted work creates no limitation", async () => {
  for (const failurePhase of ["context", "canvas", "extraction", "layer", "empty", "source"]) {
    const fixture = renderPageHarness(failurePhase, { requiresExactSource: !["context", "canvas"].includes(failurePhase) });
    await assert.rejects(fixture.renderPage());
    assert.equal(fixture.state.failed, true);
    assert.equal(fixture.failures.length, 1);
    assert.equal(fixture.record.textLimitationElement.hidden, true);
  }
  for (const failurePhase of ["stale", "abort"]) {
    const fixture = renderPageHarness(failurePhase);
    assert.equal(await fixture.renderPage(), null);
    assert.equal(fixture.state.failed, false);
    assert.equal(fixture.record.textLimitationElement.hidden, true);
    assert.deepEqual(fixture.failures, []);
  }
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

test("passive callback targeting does not navigate, render another page, or move keyboard focus", async () => {
  const calls = [];
  const target = {
    focus(options) { calls.push(["focus", options]); },
    scrollIntoView(options) { calls.push(["scroll", options]); },
  };
  const result = await viewerModule.focusPdfAnchorTarget({
    target,
    pageNumber: 4,
    async showPage(...args) { calls.push(["showPage", ...args]); },
  }, { scrollIntoView: false, moveKeyboardFocus: false });
  assert.equal(result, target);
  assert.deepEqual(calls, []);
});

test("restoring a source awaits the page mount and scrolls without stealing keyboard focus", async () => {
  const calls = [];
  let mounted = false;
  const target = {
    focus(options) { calls.push(["focus", options]); },
    scrollIntoView(options) {
      assert.equal(mounted, true);
      calls.push(["scroll", options]);
    },
  };
  await viewerModule.focusPdfAnchorTarget({
    target,
    pageNumber: 4,
    async showPage(page, options) {
      calls.push(["showPage", page, options]);
      await Promise.resolve();
      mounted = true;
    },
  }, { behavior: "auto", scrollIntoView: true, moveKeyboardFocus: false });
  assert.deepEqual(calls, [
    ["showPage", 4, { behavior: "auto", block: "nearest" }],
    ["scroll", { behavior: "auto", block: "center", inline: "nearest" }],
  ]);
});

test("explicit source navigation preserves focus-before-scroll ordering and fails closed on mount failure", async () => {
  const calls = [];
  const target = {
    focus(options) { calls.push(["focus", options]); },
    scrollIntoView(options) { calls.push(["scroll", options]); },
  };
  await viewerModule.focusPdfAnchorTarget({ target, pageNumber: 2, async showPage() { calls.push(["showPage"]); } });
  assert.deepEqual(calls.map(([action]) => action), ["showPage", "focus", "scroll"]);
  calls.length = 0;
  await assert.rejects(viewerModule.focusPdfAnchorTarget({
    target, pageNumber: 2, async showPage() { throw new Error("page unavailable"); },
  }), /page unavailable/u);
  assert.deepEqual(calls, []);
});

test("page-count guard rejects oversized PDFs before continuous surfaces are created", () => {
  assert.equal(viewerModule.assertPdfPageCountWithinLimit(200), 200);
  assert.throws(
    () => viewerModule.assertPdfPageCountWithinLimit(201),
    (error) => error.code === "PDF_PAGE_LIMIT_EXCEEDED" && /201 pages/u.test(error.message),
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

test("continuous active-page selection rejects malformed shells and resolves page gaps deterministically", () => {
  const pages = [
    { pageNumber: 2, top: 500, height: 400 },
    { pageNumber: 99, top: Number.NaN, height: 400 },
    { pageNumber: 1, top: 0, height: 400 },
    { pageNumber: 3, top: 920, height: 0 },
  ];

  assert.equal(viewerModule.selectActivePageNumber(pages, {
    scrollTop: 350,
    viewportHeight: 200,
  }), 1, "equal overlap in a gap should choose the page nearest the reading line");
  assert.equal(viewerModule.selectActivePageNumber(pages, {
    scrollTop: 400,
    viewportHeight: 200,
  }), 2, "greater viewport overlap should win when the reading line is in a gap");
  assert.equal(viewerModule.selectActivePageNumber(pages, {
    scrollTop: 1_000,
    viewportHeight: 200,
  }), 2, "an off-stack viewport should choose the nearest valid page");
  assert.equal(viewerModule.selectActivePageNumber([], { fallbackPage: 7 }), 7);
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

test("page locator math handles end alignment, tall pages, and both nearest directions", () => {
  assert.equal(viewerModule.calculatePageScrollTop({
    pageTop: 1_000,
    pageHeight: 800,
    scrollTop: 900,
    viewportHeight: 1_000,
    margin: 12,
    block: "end",
  }), 812);
  assert.equal(viewerModule.calculatePageScrollTop({
    pageTop: 1_000,
    pageHeight: 1_200,
    scrollTop: 0,
    viewportHeight: 600,
    block: "center",
  }), 1_300);
  assert.equal(viewerModule.calculatePageScrollTop({
    pageTop: 100,
    pageHeight: 200,
    scrollTop: 900,
    viewportHeight: 500,
    margin: 12,
    block: "nearest",
  }), 88);
  assert.equal(viewerModule.calculatePageScrollTop({
    pageTop: 1_500,
    pageHeight: 200,
    scrollTop: 900,
    viewportHeight: 500,
    margin: 12,
    block: "nearest",
  }), 1_212);
});

test("virtual render windows pin provenance page 1 and bound work around the active page", () => {
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(1, 15, 2), [1, 2, 3]);
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(8, 15, 2), [1, 6, 7, 8, 9, 10]);
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(15, 15, 2), [1, 13, 14, 15]);
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(8, 15, 0), [1, 8]);
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(99, 3, 1), [1, 2, 3]);
  assert.deepEqual(viewerModule.pageNumbersForRenderWindow(0, 5, 1), [1, 2]);
  assert.ok(viewerModule.pageNumbersForRenderWindow(150, 300, 3).length <= 8);
});

test("resolves nested PDF outline entries through public named and explicit destinations", async () => {
  const references = new Map([["page-ref-2", 1], ["page-ref-5", 4]]);
  const result = await viewerModule.resolvePdfOutline({
    numPages: 8,
    async getOutline() {
      return [
        {
          title: "  1   Introduction  ",
          dest: "intro",
          items: [{ title: "1.1 Motivation", dest: [{ ref: "page-ref-2" }] }],
        },
        { title: "2 Methods", dest: [{ ref: "page-ref-5" }] },
      ];
    },
    async getDestination(name) {
      assert.equal(name, "intro");
      return [0];
    },
    async getPageIndex(reference) {
      return references.get(reference.ref);
    },
  });

  assert.equal(result.status, "resolved");
  assert.deepEqual(result.entries, [
    { title: "1 Introduction", pageIndex: 0, depth: 0, order: 0 },
    { title: "1.1 Motivation", pageIndex: 1, depth: 1, order: 1 },
    { title: "2 Methods", pageIndex: 4, depth: 0, order: 2 },
  ]);
  assert.deepEqual({
    itemCount: result.itemCount,
    resolvedCount: result.resolvedCount,
    unresolvedCount: result.unresolvedCount,
  }, { itemCount: 3, resolvedCount: 3, unresolvedCount: 0 });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.entries), true);
});

test("keeps malformed outline destinations partial so structural page fallback remains available", async () => {
  const result = await viewerModule.resolvePdfOutline({
    numPages: 4,
    async getOutline() {
      return [
        { title: "Valid section", dest: [2] },
        { title: "Missing destination", dest: null },
        { title: "Outside this PDF", dest: [99] },
        { title: "Broken named destination", dest: "broken" },
      ];
    },
    async getDestination() { throw new Error("unresolved"); },
    async getPageIndex() { throw new Error("unresolved"); },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.itemCount, 4);
  assert.equal(result.resolvedCount, 1);
  assert.equal(result.unresolvedCount, 3);
  assert.deepEqual(result.entries, [{ title: "Valid section", pageIndex: 2, depth: 0, order: 0 }]);
});

test("reports absent and failed outline reads without touching private PDF.js state", async () => {
  const absent = await viewerModule.resolvePdfOutline({ numPages: 2, async getOutline() { return null; } });
  assert.equal(absent.status, "absent");
  assert.deepEqual(absent.entries, []);

  const failed = await viewerModule.resolvePdfOutline({
    numPages: 2,
    async getOutline() { throw Object.assign(new Error("bad outline"), { name: "OutlineError" }); },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.limitation, "outline_read_failed");
  assert.deepEqual(failed.entries, []);
  assert.equal(moduleSource.includes("._pages"), false);
});

test("release admission ceilings cannot be increased and selections count Unicode scalars", async () => {
  const limits = viewerModule.PDF_RELEASE_LIMITS;
  assert.equal(limits.maxBytes, 25 * 1024 * 1024);
  assert.equal(limits.maxPages, 200);
  assert.throws(() => viewerModule.assertPdfPageCountWithinLimit(201, 1_000), (error) => error.code === "PDF_PAGE_LIMIT_EXCEEDED");
  let read = false;
  await assert.rejects(viewerModule.preparePdfDocumentSource({
    pdfFile: { size: limits.maxBytes + 1, async arrayBuffer() { read = true; return new ArrayBuffer(0); } },
    maxPdfBytes: 1024 * 1024 * 1024,
  }), (error) => error.code === "PDF_TOO_LARGE");
  assert.equal(read, false);
  assert.deepEqual(viewerModule.assertPdfSelectionWithinLimits("😀".repeat(1_200)), { scalarCount: 1_200, utf8Bytes: 4_800 });
  assert.throws(() => viewerModule.assertPdfSelectionWithinLimits("x".repeat(1_201), 4_000), (error) => error.code === "PDF_SELECTION_TOO_LARGE");
});

test("canvas backing stores have bounded area and dimensions without changing CSS geometry", () => {
  const limits = viewerModule.PDF_RELEASE_LIMITS;
  for (const [width, height, dpr] of [[600, 800, 1], [1_836, 2_376, 2], [43_200, 43_200, 3], [1, 43_200, 2], [43_200, 1, 2]]) {
    const allocation = viewerModule.calculatePdfCanvasAllocation({ width, height }, dpr);
    assert.ok(allocation.width * allocation.height <= limits.maxCanvasPixels);
    assert.ok(allocation.width <= limits.maxCanvasDimension && allocation.height <= limits.maxCanvasDimension);
    assert.equal(allocation.scaleX, allocation.width / width);
    assert.equal(allocation.scaleY, allocation.height / height);
    assert.equal(Object.isFrozen(allocation), true);
  }
  assert.equal(viewerModule.calculatePdfCanvasAllocation({ width: 600, height: 800 }).limited, false);
  assert.equal(viewerModule.calculatePdfCanvasAllocation({ width: 43_200, height: 43_200 }).limited, true);
  for (const width of [0, -1, Infinity, NaN, 43_201]) {
    assert.throws(() => viewerModule.calculatePdfCanvasAllocation({ width, height: 800 }), (error) => error.code === "PDF_PAGE_GEOMETRY_LIMIT");
  }
});

test("safe PDF errors never disclose parser content, paths, tokens, or unknown codes", () => {
  const unsafe = "private C:\\private\\secret.pdf https://example.com/?token=secret";
  const cases = [
    [new Error(unsafe), "PDF_VIEWER_FAILED"],
    [Object.assign(new Error(unsafe), { name: "PasswordException" }), "PDF_ENCRYPTED"],
    [Object.assign(new Error(unsafe), { name: "InvalidPDFException" }), "PDF_INVALID"],
    [new viewerModule.PaperPdfError("PDF_TOO_LARGE", unsafe), "PDF_TOO_LARGE"],
    [new viewerModule.PaperPdfError(unsafe, unsafe), "PDF_VIEWER_FAILED"],
  ];
  for (const [error, code] of cases) {
    const safe = viewerModule.safePdfError(error);
    assert.equal(safe.code, code);
    assert.doesNotMatch(safe.message, /private|token|secret|https|C:\\/u);
    assert.equal(safe.cause, undefined);
  }
});

test("PDF byte preparation checks cancellation before reading and after asynchronous file reads", async () => {
  const controller = new AbortController(); controller.abort();
  let read = false;
  await assert.rejects(viewerModule.preparePdfDocumentSource({
    signal: controller.signal,
    pdfFile: { size: 9, async arrayBuffer() { read = true; return new ArrayBuffer(9); } },
  }), (error) => error.code === "PDF_LOAD_ABORTED");
  assert.equal(read, false);
  const second = new AbortController();
  await assert.rejects(viewerModule.preparePdfDocumentSource({
    signal: second.signal,
    pdfFile: { size: 9, async arrayBuffer() { second.abort(); return new TextEncoder().encode("%PDF-1.7").buffer; } },
  }), (error) => error.code === "PDF_LOAD_ABORTED");
});

test("viewer response adapter reuses bounded intake and maps all terminal errors safely", async () => {
  let cancelled = 0;
  const oversized = { ok: true, headers: new Headers({ "content-type": "application/pdf", "content-length": "101" }),
    body: { cancel() { cancelled += 1; }, getReader() { throw new Error("must not read"); } } };
  await assert.rejects(viewerModule.readBoundedPdfResponse(oversized, { maxBytes: 100 }), (error) => error.code === "PDF_TOO_LARGE");
  assert.equal(cancelled, 1);
  const bytes = await viewerModule.readBoundedPdfResponse(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }), { maxBytes: 3 });
  assert.deepEqual([...bytes], [1, 2, 3]);
  const controller = new AbortController();
  const stalled = { ok: true, headers: new Headers({ "content-type": "application/pdf" }),
    body: { getReader() { return { read: () => new Promise(() => {}), cancel() { throw new Error("unsafe cleanup"); }, releaseLock() { throw new Error("unsafe release"); } }; } } };
  const pending = viewerModule.readBoundedPdfResponse(stalled, { maxBytes: 100, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "PDF_LOAD_ABORTED" && !error.message.includes("unsafe"));
});

test("page loading is ordered, bounded to four concurrent worker requests, and aborts between batches", async () => {
  let active = 0, peak = 0;
  const pages = await viewerModule.loadBoundedPdfPageProxies({ numPages: 17, async getPage(pageNumber) {
    active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; return { pageNumber };
  } });
  assert.ok(peak <= 4);
  assert.deepEqual(pages.map((page) => page.pageNumber), Array.from({ length: 17 }, (_, index) => index + 1));
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(viewerModule.loadBoundedPdfPageProxies({ numPages: 20, async getPage(pageNumber) {
    calls += 1; if (pageNumber === 1) controller.abort(); return { pageNumber };
  } }, { signal: controller.signal }), (error) => error.code === "PDF_LOAD_ABORTED");
  assert.equal(calls, 4);
});

test("resource cleanup releases all owned resources before awaiting worker teardown", async () => {
  const calls = [];
  const record = (pageNumber) => ({ pageNumber, generation: 4, canvas: { width: 500, height: 600 },
    renderTask: { cancel() { calls.push(`render:${pageNumber}`); throw new Error("cancelled"); } },
    textLayer: { cancel() { calls.push(`text:${pageNumber}`); } },
    textLayerElement: { replaceChildren() { calls.push(`clear:${pageNumber}`); } },
    annotationOverlay: { replaceChildren() {} }, pdfPage: { cleanup() { calls.push(`page:${pageNumber}`); } },
    surface: { remove() { calls.push(`surface:${pageNumber}`); } }, textContentPromise: Promise.resolve({}),
  });
  const first = record(1), second = record(2);
  const pages = new Map([[1, first], [2, second]]);
  const overlays = new Map([["a", { svg: { remove() { calls.push("svg"); } }, target: { remove() { calls.push("target"); } } }]]);
  let finishWorker;
  const worker = new Promise((resolve) => { finishWorker = resolve; });
  const pending = viewerModule.releasePdfViewerResources({ pageRecords: pages, anchorOverlays: overlays,
    cleanupCallbacks: [() => { throw new Error("one listener failed"); }, () => calls.push("listener")],
    loadingTask: { destroy() { calls.push("worker"); return worker; } },
  });
  assert.equal(pages.size, 0); assert.equal(overlays.size, 0);
  assert.equal(first.canvas.width, 1); assert.equal(second.canvas.height, 1);
  assert.equal(first.textContentPromise, null); assert.equal(first.generation, 5);
  for (const expected of ["listener", "svg", "target", "text:1", "page:2", "surface:2", "worker"]) assert.ok(calls.includes(expected));
  assert.ok(!calls.includes("surface:1"));
  first.canvas.width = 777; // A replacement viewer may now own the reused first canvas.
  finishWorker(); await pending;
  assert.equal(first.canvas.width, 777, "late shutdown must not clear replacement DOM");
});

test("decoded and normalized text limits reject complete streams without inventing clipped text", () => {
  assert.throws(() => viewerModule.assertPdfTextContentWithinLimits({ items: Array.from({ length: 20_001 }, () => ({ str: "x" })) }), (error) => error.code === "PDF_TEXT_LIMIT_EXCEEDED");
  assert.throws(() => viewerModule.assertPdfTextContentWithinLimits({ items: [{ str: "x".repeat(200_001) }] }), (error) => error.code === "PDF_TEXT_LIMIT_EXCEEDED");
  const text = "Literal selected source";
  assert.deepEqual(viewerModule.assertPdfTextContentWithinLimits({ items: [{ str: text }, { type: "beginMarkedContent" }] }), { itemCount: 2, textCharacters: text.length });
  assert.throws(() => viewerModule.buildPdfPageTextRecord({ pageIndex: 0,
    textItems: [{ str: "ﷺ".repeat(20_000), transform: [1, 0, 0, 1, 10, 10], width: 5, height: 10 }],
    viewport: { viewBox: [0, 0, 600, 800], rotation: 0 }, pageViewBox: [0, 0, 600, 800],
  }), (error) => error.code === "PDF_TEXT_LIMIT_EXCEEDED");
});

function textIndexHarness(pageCount, { load, controller = new AbortController() } = {}) {
  const state = { documentFacts: { integrityVerified: true, sha256: "a".repeat(64) }, pdfDocument: { numPages: pageCount },
    destroyed: false, failed: false, documentTextIndex: null, documentTextPromise: null };
  const pageRecords = new Map(Array.from({ length: pageCount }, (_, index) => [index + 1, {
    pageIndex: index, pageNumber: index + 1, baseViewport: { viewBox: [0, 0, 600, 800], rotation: 0 },
  }]));
  let progress = 0, ready = 0;
  const start = moduleSource.indexOf("  const extractDocumentText = async");
  const end = moduleSource.indexOf("  const destroy = async", start);
  assert.ok(start > 0 && end > start);
  const extract = runInNewContext(`${moduleSource.slice(start, end)}\nextractDocumentText;`, {
    state, pageRecords, abortController: controller, PaperPdfError: viewerModule.PaperPdfError,
    PDF_RELEASE_LIMITS: viewerModule.PDF_RELEASE_LIMITS, assertPdfTextContentWithinLimits: viewerModule.assertPdfTextContentWithinLimits,
    freezePdfPageViewBox: viewerModule.freezePdfPageViewBox,
    assertPdfNotAborted(signal) { if (signal?.aborted) throw new viewerModule.PaperPdfError("PDF_LOAD_ABORTED", "Cancelled."); },
    resolvePdfOutline: async () => ({ status: "absent", entries: [] }),
    loadPageTextContent: load || (async () => ({ items: [{ str: "x".repeat(200_000) }] })),
    buildPdfPageTextRecord: ({ pageIndex, textItems }) => ({ pageIndex, text: textItems.map((item) => item.str).join(""), textCapability: "exact_candidate", lines: [] }),
    options: { onTextIndexProgress() { progress += 1; } }, emitReadyStatus() { ready += 1; },
  });
  return { extract, state, pageRecords, controller, observed: () => ({ progress, ready }) };
}

test("whole-document text budgets preserve every visual page and emit no clipped exact source", async () => {
  const harness = textIndexHarness(13);
  const result = await harness.extract();
  assert.equal(result.status, "partial"); assert.equal(result.pages.length, 13);
  assert.equal(result.exactCandidatePages, 10); assert.equal(result.visualOnlyPages, 3);
  assert.equal(result.pages.reduce((sum, page) => sum + page.text.length, 0), 2_000_000);
  for (const page of result.pages.slice(10)) {
    assert.equal(page.textCapability, "visual_only"); assert.equal(page.text, "");
    assert.equal(page.lines.length, 0); assert.equal(page.limitation, "text_resource_limit");
    assert.deepEqual([...page.pageViewBox], [0, 0, 600, 800]);
  }
  assert.equal(harness.pageRecords.size, 13, "text limits must not remove page surfaces or structural page references");
});

test("cancelled extraction cannot publish progress, cache a stale index, or report ready after its await", async () => {
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const content = new Promise((resolve) => { release = resolve; });
  const harness = textIndexHarness(1, { load: () => { entered(); return content; } });
  const pending = harness.extract(); await started; harness.controller.abort();
  release({ items: [{ str: "no stale source" }] });
  await assert.rejects(pending, (error) => error.code === "PDF_LOAD_ABORTED");
  assert.equal(harness.state.documentTextIndex, null);
  assert.deepEqual(harness.observed(), { progress: 0, ready: 0 });
});

test("newer region openings and cancellation invalidate a pending lens before it can focus", async () => {
  const state = { pdfDocument: {}, currentPage: 1, destroyed: false, failed: false, regionSelection: null, regionGeneration: 0 };
  const pages = new Map([1, 2].map((pageNumber) => [pageNumber, { viewport: {}, surface: { classList: { remove() {} } } }]));
  const releases = new Map(); let paints = 0;
  const start = moduleSource.indexOf("  const cancelRegionSelection =");
  const end = moduleSource.indexOf("  const captureRegionSelection =", start);
  const api = runInNewContext(`${moduleSource.slice(start, end)}\n({beginRegionSelection,cancelRegionSelection});`, {
    state, pageRecords: pages, viewer: { dataset: {} }, PaperPdfError: viewerModule.PaperPdfError,
    removeAnchorOverlay: () => true, resolveStrictPageNumber: ({ pageNumber }) => pageNumber,
    normalizeDraggedRegion: viewerModule.normalizeDraggedRegion,
    showPage: (pageNumber) => new Promise((resolve) => releases.set(pageNumber, resolve)),
    paintRegionSelection: () => { paints += 1; return state.regionSelection; },
  });
  const first = api.beginRegionSelection({ pageNumber: 1 });
  const second = api.beginRegionSelection({ pageNumber: 2 });
  releases.get(2)(); await second; releases.get(1)();
  await assert.rejects(first, (error) => error.code === "PDF_REGION_SELECTION_STALE");
  assert.equal(state.regionSelection.pageNumber, 2); assert.equal(paints, 1);
  const cancelled = api.beginRegionSelection({ pageNumber: 1 });
  api.cancelRegionSelection(); releases.get(1)();
  await assert.rejects(cancelled, (error) => error.code === "PDF_REGION_SELECTION_STALE");
  assert.equal(state.regionSelection, null); assert.equal(paints, 1);
});

test("the PDF renderer remains data-only with scripting, XFA, and network-worker fetch disabled", () => {
  assert.match(moduleSource, /isEvalSupported: false/u);
  assert.match(moduleSource, /enableXfa: false/u);
  assert.match(moduleSource, /useWorkerFetch: false/u);
  assert.match(moduleSource, /data: source\.bytes\.slice\(\)/u);
  assert.doesNotMatch(moduleSource, /getJSActions|getOpenAction|getAttachments|PDFScriptingManager|new AnnotationLayer|window\.open|location\.href\s*=/u);
  assert.match(moduleSource, /const wrapped = fail\(error\);\s*await destroy\(\{ preserveError: true \}\);/u);
});

function initializationFailureHarness(documentPromise, { controller = new AbortController() } = {}) {
  const state = { loadingTask: null, pdfDocument: null, destroyed: false, regionSelection: null,
    resizeFrame: null, scrollFrame: null, currentPage: 1, selectionGeneration: 0, regionGeneration: 0, zoomGeneration: 0 };
  let shutdowns = 0, listenerRemovals = 0, pageCreates = 0;
  const viewer = { dataset: {}, setAttribute() {} };
  const destroyStart = moduleSource.indexOf("  const destroy = async");
  const destroyEnd = moduleSource.indexOf("  listen(controls.previousPage", destroyStart);
  const tryStart = moduleSource.indexOf("  try {\n    assertPdfNotAborted(options.signal)");
  const initStart = tryStart >= 0 ? tryStart : moduleSource.indexOf("  try {\r\n    assertPdfNotAborted(options.signal)");
  const initEnd = moduleSource.indexOf("  const api =", initStart);
  assert.ok(destroyStart > 0 && destroyEnd > destroyStart && initStart > destroyEnd && initEnd > initStart);
  const context = {
    state, viewer, options: { signal: controller.signal }, abortController: new AbortController(),
    pageRecords: new Map(), anchorOverlays: new Map(), cleanupCallbacks: [() => { listenerRemovals += 1; }],
    PaperPdfError: viewerModule.PaperPdfError, PDF_ERROR_MESSAGES: { PDF_LOAD_ABORTED: "Cancelled." },
    PDF_RELEASE_LIMITS: viewerModule.PDF_RELEASE_LIMITS, PDFJS_ASSET_URLS: {},
    releasePdfViewerResources: viewerModule.releasePdfViewerResources,
    assertPdfNotAborted(signal) { if (signal?.aborted) throw new viewerModule.PaperPdfError("PDF_LOAD_ABORTED", "Cancelled."); },
    suppliedDocument: { bytes: new Uint8Array([1]), expectedPageCount: null }, maxPdfPages: 200, fixedSourceAnchor: null,
    getDocument: () => ({ promise: documentPromise, async destroy() { shutdowns += 1; } }),
    assertPdfPageCountWithinLimit: viewerModule.assertPdfPageCountWithinLimit,
    clampPdfPageNumber: viewerModule.clampPdfPageNumber, loadBoundedPdfPageProxies: viewerModule.loadBoundedPdfPageProxies,
    createPageRecord() { pageCreates += 1; }, isExpectedCancellation: () => false,
    fail(error) { state.failed = true; viewer.dataset.pdfState = "failed"; return viewerModule.safePdfError(error); },
  };
  const pending = runInNewContext(`(async () => { ${moduleSource.slice(destroyStart, destroyEnd)}\n${moduleSource.slice(initStart, initEnd)} })()`, context);
  return { pending, state, viewer, controller, observed: () => ({ shutdowns, listenerRemovals, pageCreates }) };
}

test("real initialization failure paths destroy workers and listeners before rejecting safely", async () => {
  for (const [document, code] of [
    [Promise.reject(Object.assign(new Error("private /path/token"), { name: "PasswordException" })), "PDF_ENCRYPTED"],
    [Promise.resolve({ numPages: 201 }), "PDF_PAGE_LIMIT_EXCEEDED"],
    [Promise.resolve({ numPages: 1, async getPage() { throw new Error("private page parser details"); } }), "PDF_VIEWER_FAILED"],
  ]) {
    const harness = initializationFailureHarness(document);
    await assert.rejects(harness.pending, (error) => error.code === code && !error.message.includes("private"));
    assert.equal(harness.state.destroyed, true); assert.equal(harness.state.pdfDocument, null);
    assert.equal(harness.state.loadingTask, null); assert.equal(harness.viewer.dataset.pdfState, "failed");
    assert.deepEqual(harness.observed(), { shutdowns: 1, listenerRemovals: 1, pageCreates: 0 });
  }
});

test("external replacement abort destroys an initializing worker and cannot install its late document", async () => {
  let resolveDocument;
  const document = new Promise((resolve) => { resolveDocument = resolve; });
  const harness = initializationFailureHarness(document);
  harness.controller.abort();
  assert.equal(harness.state.destroyed, true); assert.equal(harness.observed().shutdowns, 1);
  resolveDocument({ numPages: 1 });
  await assert.rejects(harness.pending, (error) => error.code === "PDF_LOAD_ABORTED");
  assert.equal(harness.state.pdfDocument, null);
  assert.equal(harness.observed().pageCreates, 0);
});

test("region geometry cannot be frozen across page repaint, moving lens, or replacement during hashing", async () => {
  const start = moduleSource.indexOf("  const captureRegionSelection =");
  const end = moduleSource.indexOf('  listen(viewer, "pointerdown"', start);
  for (const change of ["generation", "bounds", "selection"]) {
    let finishDigest;
    const digest = new Promise((resolve) => { finishDigest = resolve; });
    const state = { documentFacts: { sha256: "a".repeat(64) }, destroyed: false, failed: false,
      regionSelection: { pageNumber: 1, bounds: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } } };
    const record = { generation: 1, surface: { isConnected: true }, viewport: { viewBox: [0, 0, 600, 800], rotation: 0 } };
    const capture = runInNewContext(`${moduleSource.slice(start, end)}\ncaptureRegionSelection;`, {
      state, pageRecords: new Map([[1, record]]), anchorOverlays: new Map(), PaperPdfError: viewerModule.PaperPdfError,
      freezePdfPageViewBox: viewerModule.freezePdfPageViewBox, pdfQuadFromNormalizedRegion: () => [1, 2, 3, 4, 5, 6, 7, 8],
      pdfjsVersion: "test", TextEncoder, sha256Hex: () => digest,
    });
    const pending = capture();
    if (change === "generation") record.generation += 1;
    if (change === "bounds") state.regionSelection.bounds.x = 0.3;
    if (change === "selection") state.regionSelection = { ...state.regionSelection };
    finishDigest("b".repeat(64));
    await assert.rejects(pending, (error) => error.code === "PDF_REGION_SELECTION_STALE");
  }
});
