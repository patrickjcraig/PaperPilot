import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MultiDirectedGraph } from "graphology";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { createSpikeState, createToolSuite } from "./contracts.mjs";
import { analyzePaperPages } from "./paper-analysis.mjs";
import { validateSpatialAnchor } from "./spatial-anchor.mjs";
import { createWholePaperStructuralMap } from "./structural-map.mjs";
import { SYNTHETIC_PDF_FIXTURE_NAMES, createSyntheticPdfFixture } from "./test-support/synthetic-pdf-fixtures.mjs";

// Only module/asset resolution changes for Node. The actual PDF.js parser and
// the production outline/text helpers run unchanged; no PDF API is mocked.
const pdfjsModuleUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsRoot = path.resolve(path.dirname(fileURLToPath(pdfjsModuleUrl)), "../..");
const assetPaths = {
  worker: import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  standardFonts: `${path.join(pdfjsRoot, "standard_fonts").replaceAll("\\", "/")}/`,
  cmaps: `${path.join(pdfjsRoot, "cmaps").replaceAll("\\", "/")}/`,
  wasm: `${path.join(pdfjsRoot, "wasm").replaceAll("\\", "/")}/`,
};
const viewerSource = await readFile(new URL("./pdf-viewer.mjs", import.meta.url), "utf8");
const nodeViewerSource = viewerSource
  .replace('from "../vendor/pdfjs/pdf.min.mjs";', `from ${JSON.stringify(pdfjsModuleUrl)};`)
  .replace(/const PDFJS_ASSET_URLS = Object\.freeze\(\{[\s\S]*?\}\);/u, `const PDFJS_ASSET_URLS = Object.freeze(${JSON.stringify(assetPaths)});`);
assert.notEqual(nodeViewerSource, viewerSource, "Node integration must resolve the real pinned PDF.js package.");
const { buildPdfPageTextRecord, resolvePdfOutline } = await import(`data:text/javascript;base64,${Buffer.from(nodeViewerSource).toString("base64")}`);

async function parseFixture(name) {
  const fixture = createSyntheticPdfFixture(name);
  const loadingTask = getDocument({
    data: fixture.bytes.slice(),
    standardFontDataUrl: assetPaths.standardFonts,
    cMapUrl: assetPaths.cmaps,
    cMapPacked: true,
    wasmUrl: assetPaths.wasm,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  try {
    const document = await loadingTask.promise;
    assert.equal(document.numPages, fixture.pageCount);
    const outline = await resolvePdfOutline(document);
    const pages = [];
    const operators = [];
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex + 1);
      const text = await page.getTextContent();
      pages.push(buildPdfPageTextRecord({
        pageIndex,
        pageLabel: String(pageIndex + 1),
        textItems: text.items,
        viewport: page.getViewport({ scale: 1 }),
        pageViewBox: page.view,
        pageRotation: page.rotate,
      }));
      operators.push((await page.getOperatorList()).fnArray);
    }
    const analysis = analyzePaperPages(pages);
    const map = createWholePaperStructuralMap({
      documentSha256: fixture.sha256,
      pages,
      outlineEntries: outline.entries,
      heuristicHeadings: analysis.headings,
    });
    return { fixture, outline, pages, operators, analysis, map };
  } finally {
    await loadingTask.destroy();
  }
}

function assertLeafCoverage(map) {
  const assignments = new Map();
  for (const node of map.nodes) {
    assert.ok(node.startPageIndex >= 0 && node.endPageIndex < map.pageCount);
    assert.ok(node.startPageIndex <= node.endPageIndex);
    for (let pageIndex = node.startPageIndex; pageIndex <= node.endPageIndex; pageIndex += 1) {
      assert.equal(assignments.has(pageIndex), false, `Page ${pageIndex + 1} cannot have two leaf assignments.`);
      assignments.set(pageIndex, node.key);
    }
  }
  for (const entry of map.coverage) {
    assert.equal(entry.structuralNodeKey, assignments.get(entry.pageIndex) || null);
    if (entry.mappingState === "failed") assert.equal(assignments.has(entry.pageIndex), false);
    else assert.equal(assignments.has(entry.pageIndex), true);
  }
  assert.equal(assignments.size, map.counts.navigablePages);
  assert.equal(map.counts.structuralPages + map.counts.limitedPages + map.counts.failedPages, map.pageCount);
}

async function hydrateAndCheckAnchors(parsed, map = parsed.map) {
  const { fixture, pages } = parsed;
  const paperRef = `paper:sha256:${fixture.sha256}`;
  let sequence = 0;
  const state = await createSpikeState(MultiDirectedGraph, {
    paper: {
      paperRef,
      filename: fixture.filename,
      title: fixture.title,
      documentSha256: fixture.sha256,
      pageCount: fixture.pageCount,
      pageViewBox: pages[0].pageViewBox,
      pageRotation: pages[0].pageRotation,
    },
    textAnchor: null,
    structuralMap: map,
    now: () => "2026-09-01T12:00:00.000Z",
    id: (prefix) => `${prefix}:synthetic-${String(++sequence).padStart(6, "0")}`,
  });
  assert.equal(state.graph.getNodeAttribute("node:paper", "kind"), "paper");
  assert.equal(state.graph.order, map.nodes.length + 1);
  assert.equal(state.graph.size, map.nodes.length);
  for (const leaf of state.structuralMap.nodes) {
    const attributes = state.graph.getNodeAttributes(leaf.key);
    assert.equal(attributes.kind, "section");
    assert.equal(attributes.authority, "document_structure");
    assert.equal(attributes.origin, "automatic_map");
    const anchor = state.anchors.get(leaf.anchorId);
    const validated = await validateSpatialAnchor(anchor, {
      paperRef,
      documentSha256: fixture.sha256,
      pageIndex: leaf.startPageIndex,
    });
    assert.equal(validated.sourceKind, "whole_page");
    assert.equal(validated.geometryKind, "rectangle");
    assert.equal(validated.authority, "client_rendered_pdf");
    assert.equal(validated.createdBy, "system");
    assert.deepEqual(validated.normalizedBounds, [{ x: 0, y: 0, width: 1, height: 1 }]);
    assert.deepEqual(validated.pageViewBox, pages[leaf.startPageIndex].pageViewBox);
    assert.equal(validated.rotation, pages[leaf.startPageIndex].pageRotation);
    assert.equal(validated.rendererRecipe.pageRotation, pages[leaf.startPageIndex].pageRotation);
    assert.equal(Object.hasOwn(validated, "quote"), false);
    assert.equal(state.graph.getEdgeAttribute(leaf.edgeKey, "authority"), "document_structure");
  }
  const tools = new Map(createToolSuite(state).map((tool) => [tool.name, tool]));
  const graph = await tools.get("paperpilot.read_graph").execute({ mode: "overview", limit: 100 });
  assert.equal(graph.status, "ready");
  assert.equal(graph.coverage.status, map.status);
  assert.equal(graph.coverage.semanticPages, 0, "Structure must not be counted as semantic understanding.");
  assert.equal(graph.coverage.structuralPages, map.counts.structuralPages);
  assert.equal(graph.coverage.limitedPages, map.counts.limitedPages);
  assert.equal(graph.coverage.failedPages, map.counts.failedPages);
  assert.equal(graph.coverage.indexedPages, map.pageCount);
  assert.equal(graph.truncated, false);
  assert.equal(JSON.stringify(graph).includes('"x"'), false);
  for (const node of graph.nodes.filter(({ kind }) => kind === "section")) {
    assert.ok(["pdf_outline", "heading_heuristic", "page_fallback"].includes(node.structuralBasis));
    assert.ok(["document_declared", "system_inferred", "coverage_fallback"].includes(node.structuralConfidence));
  }
  if (state.structuralMap.nodes.length) {
    const leaf = state.structuralMap.nodes.at(-1);
    const focused = await tools.get("paperpilot.focus_source").execute({ targetType: "section", targetId: leaf.key });
    assert.equal(focused.status, "focused");
    assert.equal(focused.anchorId, leaf.anchorId);
    assert.deepEqual(focused.coveredPageRange, { startPageIndex: leaf.startPageIndex, endPageIndex: leaf.endPageIndex });
    const focus = await tools.get("paperpilot.read_focus").execute({});
    assert.equal(focus.focus.sourceKind, "whole_page");
    assert.ok(focus.graph.relatedNodeKeys.includes(leaf.key));
  }
  return state;
}

test("original synthetic PDF bytes are deterministic, bounded, and independent of local research files", () => {
  const digests = new Set();
  for (const name of SYNTHETIC_PDF_FIXTURE_NAMES) {
    const first = createSyntheticPdfFixture(name);
    const second = createSyntheticPdfFixture(name);
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.sha256, second.sha256);
    assert.ok(first.byteLength < 50_000);
    assert.equal(Buffer.from(first.bytes.subarray(0, 8)).toString("ascii"), "%PDF-1.7");
    assert.match(first.sha256, /^[a-f0-9]{64}$/u);
    digests.add(first.sha256);
  }
  assert.equal(digests.size, SYNTHETIC_PDF_FIXTURE_NAMES.length);
});

test("real PDF.js outline parsing creates stable structural ranges and canonical rotated CropBox anchors", async () => {
  const first = await parseFixture("outline-rich");
  const second = await parseFixture("outline-rich");
  assert.equal(first.outline.status, "resolved");
  assert.equal(first.outline.resolvedCount, 5);
  assert.ok(first.outline.entries.some(({ depth }) => depth === 1));
  assert.deepEqual(first.outline.entries.map(({ title, pageIndex }) => ({ title, pageIndex })), [
    { title: "Abstract", pageIndex: 0 },
    { title: "Methods", pageIndex: 2 },
    { title: "Acquisition", pageIndex: 2 },
    { title: "Analysis", pageIndex: 3 },
    { title: "Findings", pageIndex: 5 },
  ]);
  assert.equal(first.map.sourceStats.selectedBasis, "pdf_outline");
  assert.equal(first.map.status, "structural_ready");
  assert.ok(first.map.nodes.every(({ basis, confidence }) => basis === "pdf_outline" && confidence === "document_declared"));
  assert.deepEqual(first.pages[2].pageViewBox, [20, 30, 592, 762]);
  assert.equal(first.pages[2].pageRotation, 90);
  assertLeafCoverage(first.map);
  assert.deepEqual(first.map, second.map);
  const firstState = await hydrateAndCheckAnchors(first);
  const secondState = await hydrateAndCheckAnchors(second);
  assert.equal(firstState.graphDigest, secondState.graphDigest);
  assert.equal(firstState.workspaceDigest, secondState.workspaceDigest);
});

test("real outline-free PDF text falls back to complete deterministic 10-page groups", async () => {
  const parsed = await parseFixture("outline-free");
  assert.equal(parsed.outline.status, "absent");
  assert.deepEqual(parsed.analysis.headings, []);
  assert.equal(parsed.map.sourceStats.selectedBasis, "page_fallback");
  assert.deepEqual(parsed.map.nodes.map(({ startPageIndex, endPageIndex }) => [startPageIndex, endPageIndex]), [[0, 9], [10, 19], [20, 22]]);
  assert.ok(parsed.map.nodes.every(({ startPageIndex, endPageIndex }) => endPageIndex - startPageIndex + 1 <= 10));
  assertLeafCoverage(parsed.map);
  await hydrateAndCheckAnchors(parsed);
});

test("real two-column text and vector figures yield provisional structure without semantic claims", async () => {
  const parsed = await parseFixture("multicolumn-figures");
  assert.equal(parsed.outline.status, "absent");
  assert.ok(parsed.pages[0].text.includes("Column 1 contains sample"));
  assert.ok(parsed.pages[0].text.includes("Column 2 contains sample"));
  assert.ok(parsed.operators[1].includes(OPS.constructPath), "The parsed figure page must contain actual vector graphics.");
  assert.ok(parsed.analysis.headings.some(({ label }) => label === "2 Measurements"));
  assert.ok(parsed.analysis.headings.some(({ label }) => label === "RESULTS"));
  assert.equal(parsed.map.sourceStats.selectedBasis, "heading_heuristic");
  assert.ok(parsed.map.nodes.some(({ label }) => label === "2 Measurements"));
  assert.ok(parsed.map.nodes.some(({ label }) => label === "RESULTS"));
  assert.ok(parsed.map.nodes.every(({ basis, confidence }) => basis === "heading_heuristic" && confidence === "system_inferred"));
  assert.ok(parsed.map.nodes.every(({ summary }) => summary.includes("provisional document structure")));
  assertLeafCoverage(parsed.map);
  await hydrateAndCheckAnchors(parsed);
});

test("real blank, image-only scan-like, and vector-only pages stay limited with valid whole-page navigation", async () => {
  const parsed = await parseFixture("limited-text");
  assert.deepEqual(parsed.pages.map(({ textCapability }) => textCapability), ["exact_candidate", "visual_only", "visual_only", "visual_only"]);
  assert.equal(parsed.pages[1].text, "");
  assert.equal(parsed.pages[2].text, "");
  assert.ok(parsed.operators[2].includes(OPS.paintImageXObject), "The scan-like page must parse a real image XObject, not hidden text.");
  assert.ok(parsed.operators[3].includes(OPS.constructPath));
  assert.equal(parsed.map.status, "structural_ready");
  assert.deepEqual(parsed.map.counts, { structuralPages: 1, limitedPages: 3, failedPages: 0, navigablePages: 4 });
  assertLeafCoverage(parsed.map);
  await hydrateAndCheckAnchors(parsed);
});

test("controlled page-index failures after real PDF parsing remain explicit and cannot claim ready coverage", async () => {
  const parsed = await parseFixture("multicolumn-figures");
  const markFailed = (page) => ({ ...page, textCapability: "failed", text: "", lines: [] });
  const partialPages = parsed.pages.map((page) => page.pageIndex === 3 ? markFailed(page) : page);
  const partialMap = createWholePaperStructuralMap({
    documentSha256: parsed.fixture.sha256,
    pages: partialPages,
    heuristicHeadings: analyzePaperPages(partialPages).headings,
  });
  assert.equal(partialMap.status, "structural_partial");
  assert.equal(partialMap.counts.failedPages, 1);
  assert.equal(partialMap.coverage[3].mappingState, "failed");
  assert.equal(partialMap.coverage[3].structuralNodeKey, null);
  assertLeafCoverage(partialMap);
  await hydrateAndCheckAnchors(parsed, partialMap);

  const failedMap = createWholePaperStructuralMap({
    documentSha256: parsed.fixture.sha256,
    pages: parsed.pages.map(markFailed),
  });
  assert.equal(failedMap.status, "failed");
  assert.deepEqual(failedMap.counts, { structuralPages: 0, limitedPages: 0, failedPages: 6, navigablePages: 0 });
  assert.deepEqual(failedMap.nodes, []);
  assertLeafCoverage(failedMap);
  await hydrateAndCheckAnchors(parsed, failedMap);
});
