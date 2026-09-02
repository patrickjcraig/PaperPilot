import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_FALLBACK_PAGES,
  STRUCTURAL_MAP_CLAIM_BOUNDARY,
  createWholePaperStructuralMap,
} from "./structural-map.mjs";

const DOCUMENT_SHA256 = "a".repeat(64);

function pageFixture(pageCount, capabilities = {}) {
  return Array.from({ length: pageCount }, (_, pageIndex) => ({
    pageIndex,
    pageLabel: String(pageIndex + 1),
    pageViewBox: pageIndex % 2 ? [0, 0, 595, 842] : [0, 0, 612, 792],
    pageRotation: [0, 90, 180, 270][pageIndex % 4],
    textCapability: capabilities[pageIndex] || "exact_candidate",
  }));
}

function coveredPageIndexes(map) {
  return map.nodes.flatMap((node) => (
    Array.from({ length: node.endPageIndex - node.startPageIndex + 1 }, (_, offset) => node.startPageIndex + offset)
  ));
}

test("prefers resolved PDF outline ranges and labels them as document structure, never main ideas", () => {
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(8),
    outlineEntries: [
      { title: "  Abstract  ", pageIndex: 0, depth: 0, order: 0 },
      { title: "2   Methods", pageIndex: 2, depth: 0, order: 1 },
      { title: "3 Results", pageIndex: 5, depth: 0, order: 2 },
    ],
    heuristicHeadings: [{ label: "Ignored inferred heading", pageIndex: 1 }],
  });

  assert.equal(map.status, "structural_ready");
  assert.equal(map.authority, "document_structure");
  assert.equal(map.claimBoundary, STRUCTURAL_MAP_CLAIM_BOUNDARY);
  assert.equal(map.sourceStats.selectedBasis, "pdf_outline");
  assert.deepEqual(map.nodes.map(({ label, startPageIndex, endPageIndex, basis, confidence }) => ({
    label,
    startPageIndex,
    endPageIndex,
    basis,
    confidence,
  })), [
    { label: "Abstract", startPageIndex: 0, endPageIndex: 1, basis: "pdf_outline", confidence: "document_declared" },
    { label: "2 Methods", startPageIndex: 2, endPageIndex: 4, basis: "pdf_outline", confidence: "document_declared" },
    { label: "3 Results", startPageIndex: 5, endPageIndex: 7, basis: "pdf_outline", confidence: "document_declared" },
  ]);
  assert.ok(map.nodes.every(({ summary }) => /Document structure only/iu.test(summary)));
  assert.ok(map.nodes.every(({ summary }) => !/verified main idea/iu.test(summary)));
  assert.deepEqual(coveredPageIndexes(map), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(coveredPageIndexes(map)).size, 8);
});

test("uses one conservative inferred heading boundary per page when the PDF has no outline", () => {
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(7),
    heuristicHeadings: [
      { label: "Abstract", pageIndex: 0, lineIndex: 2 },
      { label: "Running header", pageIndex: 0, lineIndex: 8 },
      { label: "1 Introduction", pageIndex: 1, lineIndex: 1 },
      { label: "2 Methods", pageIndex: 3, lineIndex: 1 },
      { label: "3 Results", pageIndex: 5, lineIndex: 1 },
    ],
  });

  assert.equal(map.sourceStats.selectedBasis, "heading_heuristic");
  assert.deepEqual(map.nodes.map(({ label, startPageIndex, endPageIndex }) => ({ label, startPageIndex, endPageIndex })), [
    { label: "Abstract", startPageIndex: 0, endPageIndex: 0 },
    { label: "1 Introduction", startPageIndex: 1, endPageIndex: 2 },
    { label: "2 Methods", startPageIndex: 3, endPageIndex: 4 },
    { label: "3 Results", startPageIndex: 5, endPageIndex: 6 },
  ]);
  assert.ok(map.nodes.every(({ confidence }) => confidence === "system_inferred"));
  assert.ok(map.nodes.every(({ summary }) => /provisional document structure/iu.test(summary)));
});

test("keeps multi-column duplicate heading candidates deterministic without producing overlapping leaves", () => {
  const inputs = {
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(5),
    heuristicHeadings: [
      { label: "2 Methods", pageIndex: 2, lineIndex: 8 },
      { label: "2.1 Dataset", pageIndex: 2, lineIndex: 19 },
      { label: "Abstract", pageIndex: 0, lineIndex: 3 },
      { label: "3 Results", pageIndex: 4, lineIndex: 4 },
    ],
  };
  const first = createWholePaperStructuralMap(inputs);
  const second = createWholePaperStructuralMap({
    ...inputs,
    heuristicHeadings: [...inputs.heuristicHeadings].reverse(),
  });

  assert.deepEqual(first, second);
  assert.equal(first.nodes.find(({ startPageIndex }) => startPageIndex === 2).label, "2 Methods");
  assert.deepEqual(coveredPageIndexes(first), [0, 1, 2, 3, 4]);
});

test("does not promote author lists, affiliations, equation fragments, or prose into inferred structure", () => {
  const noisyLabels = [
    "X. Guo,70 A. Gupta,14 M. K. Gupta,95 K. E. Gushwa,1",
    "C. M. Reed,37 T. Regimbau,53 L. Rei,47 S. Reid,50",
    "14Inter-University Centre for Astronomy and Astrophysics, Pune 411007, India",
    "77Korea Institute of Science and Technology Information, Daejeon 305-806, Korea",
    "M 1⁄4",
    "the SNR of the event and the consistency of the data",
    "0.99 [44]. To model systems with total mass larger than",
    "Science Centre of Poland, the European Commission, the",
    "These results show that the method is effective.",
    "A Sentence Continuing With the",
    "Universities Physics Alliance, the Hungarian Scientific",
    "São Paulo SP 01140-070, Brazil",
  ];
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(noisyLabels.length),
    heuristicHeadings: noisyLabels.map((label, pageIndex) => ({ label, pageIndex, lineIndex: 0 })),
  });
  assert.equal(map.sourceStats.selectedBasis, "page_fallback");
  assert.equal(map.sourceStats.heuristicHeadingsConsidered, 0);
  assert.deepEqual(map.nodes.map(({ label }) => label), ["Pages 1–10", "Pages 11–12"]);
  assert.equal(map.counts.navigablePages, noisyLabels.length);
});

test("keeps clear numbered, Roman, appendix, and title-case headings after conservative filtering", () => {
  const labels = ["Abstract", "II. OBSERVATION", "3.2 Scaled Dot-Product Attention", "Position-wise Feed-Forward Networks", "Appendix A. Additional experiments"];
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(labels.length),
    heuristicHeadings: labels.map((label, pageIndex) => ({ label, pageIndex, lineIndex: 2 })),
  });
  assert.deepEqual(map.nodes.map(({ label }) => label), labels);
  assert.ok(map.nodes.every(({ basis }) => basis === "heading_heuristic"));
  assert.deepEqual(coveredPageIndexes(map), [0, 1, 2, 3, 4]);
});

test("the conservative text filter does not override actual PDF outline labels", () => {
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(2),
    outlineEntries: [{ title: "Department of Physics", pageIndex: 0 }],
    heuristicHeadings: [{ label: "2 Methods", pageIndex: 1 }],
  });
  assert.equal(map.sourceStats.selectedBasis, "pdf_outline");
  assert.equal(map.nodes[0].label, "Department of Physics");
  assert.equal(map.nodes[0].confidence, "document_declared");
});

test("marks figure-rich and weak-text pages limited while keeping them navigably covered", () => {
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(6, {
      1: "visual_only",
      2: "no_text",
      4: "weak_text",
    }),
    outlineEntries: [
      { title: "Figure overview", pageIndex: 0 },
      { title: "Evaluation", pageIndex: 3 },
    ],
  });

  assert.equal(map.status, "structural_ready");
  assert.deepEqual(map.counts, { structuralPages: 3, limitedPages: 3, failedPages: 0, navigablePages: 6 });
  assert.deepEqual(map.coverage.map(({ mappingState }) => mappingState), [
    "structural", "limited", "limited", "structural", "limited", "structural",
  ]);
  assert.ok(map.coverage.every(({ structuralNodeKey }) => typeof structuralNodeKey === "string"));
  assert.ok(map.nodes.every(({ primaryPageViewBox }) => primaryPageViewBox.length === 4));
});

test("falls back to deterministic contiguous page groups of at most ten pages", () => {
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(23),
  });

  assert.equal(DEFAULT_MAX_FALLBACK_PAGES, 10);
  assert.equal(map.sourceStats.selectedBasis, "page_fallback");
  assert.deepEqual(map.nodes.map(({ label, startPageIndex, endPageIndex, basis, confidence }) => ({
    label,
    startPageIndex,
    endPageIndex,
    basis,
    confidence,
  })), [
    { label: "Pages 1–10", startPageIndex: 0, endPageIndex: 9, basis: "page_fallback", confidence: "coverage_fallback" },
    { label: "Pages 11–20", startPageIndex: 10, endPageIndex: 19, basis: "page_fallback", confidence: "coverage_fallback" },
    { label: "Pages 21–23", startPageIndex: 20, endPageIndex: 22, basis: "page_fallback", confidence: "coverage_fallback" },
  ]);
  assert.ok(map.nodes.every((node) => node.endPageIndex - node.startPageIndex + 1 <= 10));
  assert.deepEqual(coveredPageIndexes(map), Array.from({ length: 23 }, (_, pageIndex) => pageIndex));
});

test("records failed pages explicitly without hiding them inside navigable leaf coverage", () => {
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(7, { 3: "failed" }),
    outlineEntries: [
      { title: "Introduction", pageIndex: 0 },
      { title: "Methods", pageIndex: 2 },
      { title: "Results", pageIndex: 5 },
    ],
  });

  assert.equal(map.status, "structural_partial");
  assert.deepEqual(map.counts, { structuralPages: 6, limitedPages: 0, failedPages: 1, navigablePages: 6 });
  assert.deepEqual(map.coverage[3], {
    pageIndex: 3,
    pageLabel: "4",
    textCapability: "failed",
    mappingState: "failed",
    structuralNodeKey: null,
  });
  assert.deepEqual(coveredPageIndexes(map), [0, 1, 2, 4, 5, 6]);
  assert.ok(map.nodes.some(({ label }) => /part 1/iu.test(label)));
  assert.ok(map.nodes.some(({ label }) => /part 2/iu.test(label)));
});

test("numbers every surviving outline segment once when several pages fail", () => {
  const map = createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(8, { 2: "failed", 5: "failed" }),
    outlineEntries: [{ title: "Methods", pageIndex: 0 }],
  });

  assert.deepEqual(map.nodes.map(({ label, startPageIndex, endPageIndex }) => ({
    label,
    startPageIndex,
    endPageIndex,
  })), [
    { label: "Methods · Pages 1–2 · part 1", startPageIndex: 0, endPageIndex: 1 },
    { label: "Methods · Pages 4–5 · part 2", startPageIndex: 3, endPageIndex: 4 },
    { label: "Methods · Pages 7–8 · part 3", startPageIndex: 6, endPageIndex: 7 },
  ]);
  assert.deepEqual(coveredPageIndexes(map), [0, 1, 3, 4, 6, 7]);
});

test("uses document-scoped stable IDs and rejects malformed or incomplete page contracts", () => {
  const first = createWholePaperStructuralMap({ documentSha256: DOCUMENT_SHA256, pages: pageFixture(4) });
  const same = createWholePaperStructuralMap({ documentSha256: DOCUMENT_SHA256, pages: pageFixture(4) });
  const other = createWholePaperStructuralMap({ documentSha256: "b".repeat(64), pages: pageFixture(4) });

  assert.deepEqual(first.nodes.map(({ key }) => key), same.nodes.map(({ key }) => key));
  assert.notDeepEqual(first.nodes.map(({ key }) => key), other.nodes.map(({ key }) => key));
  assert.ok(first.nodes.every(({ key }) => /^node:structure:[a-f0-9]{12}:/u.test(key)));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.coverage), true);
  assert.equal(Object.isFrozen(first.nodes[0].primaryPageViewBox), true);

  assert.throws(() => createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: [{ ...pageFixture(1)[0], pageIndex: 1 }],
  }), /complete zero-based sequence/iu);
  assert.throws(() => createWholePaperStructuralMap({
    documentSha256: "not-a-digest",
    pages: pageFixture(1),
  }), /SHA-256/iu);
  assert.throws(() => createWholePaperStructuralMap({
    documentSha256: DOCUMENT_SHA256,
    pages: pageFixture(1),
    maxFallbackPages: 11,
  }), /one and ten pages/iu);
});
