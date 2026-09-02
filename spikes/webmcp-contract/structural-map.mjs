// @ts-check

/**
 * Browser-independent whole-paper structural mapping.
 *
 * This module never decides what a paper's "main ideas" are. It turns trusted
 * PDF page metadata, resolved outline entries, and conservative heading
 * locators into one non-overlapping leaf coverage layer. When structure is
 * missing, deterministic page groups keep every navigable page visible.
 */

export const STRUCTURAL_MAP_VERSION = 1;
export const STRUCTURAL_MAP_CLAIM_BOUNDARY =
  "This map covers document structure and page ranges. It does not claim that headings, page groups, or their order are the paper's verified main ideas.";
export const DEFAULT_MAX_FALLBACK_PAGES = 10;

const TEXT_CAPABILITIES = new Set([
  "exact_candidate",
  "weak_text",
  "no_text",
  "visual_only",
  "failed",
]);

/** @typedef {"pdf_outline" | "heading_heuristic" | "page_fallback"} StructuralBasis */
/** @typedef {"document_declared" | "system_inferred" | "coverage_fallback"} StructuralConfidence */
/** @typedef {"structural" | "limited" | "failed"} StructuralMappingState */
/** @typedef {{
 *   pageIndex: number,
 *   pageLabel: string,
 *   pageViewBox: readonly number[],
 *   pageRotation: number,
 *   textCapability: string,
 * }} StructuralPageInput */
/** @typedef {{ title: string, pageIndex: number, depth?: number, order?: number }} OutlineEntryInput */
/** @typedef {{ label: string, pageIndex: number, lineIndex?: number }} HeadingInput */

/** @param {unknown} value @param {number} [maximum] */
function cleanText(value, maximum = 160) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

/** @param {unknown} value */
function stableToken(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(-7);
}

/** @param {readonly number[] | null | undefined} value */
function assertPageViewBox(value) {
  const viewBox = Array.from(value || [], Number);
  if (
    viewBox.length !== 4
    || viewBox.some((entry) => !Number.isFinite(entry))
    || viewBox[2] <= viewBox[0]
    || viewBox[3] <= viewBox[1]
  ) {
    throw new TypeError("Structural pages require a finite increasing PDF page view box.");
  }
  return Object.freeze(viewBox);
}

/** @param {readonly StructuralPageInput[]} inputPages */
function normalizePages(inputPages) {
  if (!Array.isArray(inputPages) || inputPages.length === 0) {
    throw new TypeError("A structural map requires at least one trusted PDF page.");
  }
  return Object.freeze(inputPages.map((page, expectedPageIndex) => {
    if (!page || typeof page !== "object" || Number(page.pageIndex) !== expectedPageIndex) {
      throw new TypeError("Structural pages must be a complete zero-based sequence.");
    }
    const pageLabel = cleanText(page.pageLabel, 32);
    if (!pageLabel) throw new TypeError("Structural pages require a bounded page label.");
    const pageRotation = Number(page.pageRotation ?? 0);
    if (![0, 90, 180, 270].includes(pageRotation)) {
      throw new TypeError("Structural pages require a supported PDF rotation.");
    }
    const textCapability = String(page.textCapability || "visual_only");
    if (!TEXT_CAPABILITIES.has(textCapability)) {
      throw new TypeError("Structural pages contain an unsupported text capability.");
    }
    return Object.freeze({
      pageIndex: expectedPageIndex,
      pageLabel,
      pageViewBox: assertPageViewBox(page.pageViewBox),
      pageRotation,
      textCapability,
    });
  }));
}

/** @param {string} label */
function headingLooksStructural(label) {
  if (!label || label.length > 120) return false;
  if (/^(?:page\s*)?[ivxlcdm\d]{1,8}$/iu.test(label)) return false;
  if (/^(?:https?:\/\/|doi:|arxiv:)/iu.test(label)) return false;
  if (/^[\p{P}\p{S}\d\s]+$/u.test(label)) return false;
  return /\p{L}/u.test(label);
}

/**
 * A large font or title-shaped line is not enough to name a structural range.
 * Be stricter than the semantic candidate extractor: references, author and
 * affiliation lines, equation fragments, and flowing prose get page coverage
 * without being promoted to a heading. An actual PDF outline is unaffected.
 * @param {string} label
 */
function heuristicHeadingLooksStructural(label) {
  if (!headingLooksStructural(label)) return false;
  if (/[.!?,;]$/u.test(label) || /[=<>\[\]{}√∑∫∂⁄]/u.test(label)) return false;
  if (label.includes(",")) return false;
  if (/\b(?:https?|www|doi|arxiv)\b/iu.test(label)) return false;
  if (/\b(?:universit(?:y|ies)|institutes?|departments?|laborator(?:y|ies)|commissions?)\b/iu.test(label)) return false;

  const numbered = /^(?:(?:\d{1,2}(?:\.\d{1,2}){0,3}|[IVXLCDM]{1,8})[.)]?\s+|appendix\s+[A-Z\d][.:]?\s+)(.+)$/iu.exec(label);
  const title = numbered ? numbered[1] : label;
  if (/\p{L},\d|\b\p{Lu}\.\s+\p{Lu}|^\d+\p{L}/u.test(title)) return false;
  const words = title.match(/\p{L}[\p{L}\p{M}'’\-]*/gu) || [];
  if (words.length === 0 || words.length > 12 || words.join("").length < 3) return false;
  if (/(?:\s|^)(?:and|or|the|a|an|of|in|for|to|with|from|than)$/iu.test(title)) return false;
  if (!/^\p{Lu}/u.test(title)) return false;
  if (numbered) return true;
  if (/^(?:abstract|introduction|background|methods?|methodology|results?|findings|discussion|conclusions?|summary|limitations|references|bibliography|acknowledg(?:e)?ments|appendix|appendices|supplementary material)$/iu.test(title)) return true;

  const minorWords = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "via", "with", "without"]);
  const significant = words.filter((word) => !minorWords.has(word.toLocaleLowerCase("en-US")));
  return significant.length >= 2 && significant.every((word) => /^\p{Lu}/u.test(word));
}

/**
 * Resolve one deterministic boundary per starting page. PDF outline entries
 * win wholesale when at least one resolves; inferred headings are only the
 * second-choice source rather than being mixed into author-declared structure.
 */
/**
 * @param {number} pageCount
 * @param {readonly OutlineEntryInput[]} outlineEntries
 * @param {readonly HeadingInput[]} heuristicHeadings
 */
function structuralBoundaries(pageCount, outlineEntries, heuristicHeadings) {
  const normalizedOutline = (Array.isArray(outlineEntries) ? outlineEntries : [])
    .map((entry, index) => ({
      label: cleanText(entry?.title, 120),
      pageIndex: Number(entry?.pageIndex),
      depth: Number.isInteger(entry?.depth) && Number(entry.depth) >= 0 ? Number(entry.depth) : 0,
      order: Number.isInteger(entry?.order) && Number(entry.order) >= 0 ? Number(entry.order) : index,
    }))
    .filter((entry) => Number.isInteger(entry.pageIndex) && entry.pageIndex >= 0 && entry.pageIndex < pageCount && headingLooksStructural(entry.label))
    .sort((left, right) => left.pageIndex - right.pageIndex || left.depth - right.depth || left.order - right.order || left.label.localeCompare(right.label));

  const normalizedHeadings = (Array.isArray(heuristicHeadings) ? heuristicHeadings : [])
    .map((entry, index) => ({
      label: cleanText(entry?.label, 120),
      pageIndex: Number(entry?.pageIndex),
      depth: 0,
      order: Number.isInteger(entry?.lineIndex) ? Number(entry.lineIndex) : index,
    }))
    .filter((entry) => Number.isInteger(entry.pageIndex) && entry.pageIndex >= 0 && entry.pageIndex < pageCount && heuristicHeadingLooksStructural(entry.label))
    .sort((left, right) => left.pageIndex - right.pageIndex || left.order - right.order || left.label.localeCompare(right.label));

  const source = normalizedOutline.length > 0 ? normalizedOutline : normalizedHeadings;
  const basis = normalizedOutline.length > 0 ? "pdf_outline" : normalizedHeadings.length > 0 ? "heading_heuristic" : null;
  const byPage = new Map();
  for (const entry of source) {
    if (!byPage.has(entry.pageIndex)) byPage.set(entry.pageIndex, entry);
  }
  return {
    basis,
    entries: [...byPage.values()].sort((left, right) => left.pageIndex - right.pageIndex),
    outlineResolved: normalizedOutline.length,
    headingsConsidered: normalizedHeadings.length,
  };
}

/** @param {number} startPageIndex @param {number} endPageIndex */
function pageRangeLabel(startPageIndex, endPageIndex) {
  return startPageIndex === endPageIndex
    ? `Page ${startPageIndex + 1}`
    : `Pages ${startPageIndex + 1}–${endPageIndex + 1}`;
}

/** @param {number} startPageIndex @param {number} endPageIndex @param {number} maximum */
function splitFallbackRange(startPageIndex, endPageIndex, maximum) {
  const ranges = [];
  for (let start = startPageIndex; start <= endPageIndex; start += maximum) {
    ranges.push({ startPageIndex: start, endPageIndex: Math.min(endPageIndex, start + maximum - 1) });
  }
  return ranges;
}

/** @param {string} label @param {number} startPageIndex @param {number} endPageIndex @param {number} partNumber @param {number} partCount */
function semanticSegmentLabel(label, startPageIndex, endPageIndex, partNumber, partCount) {
  if (partCount <= 1) return label;
  return `${label} · ${pageRangeLabel(startPageIndex, endPageIndex)} · part ${partNumber}`;
}

/**
 * Split structural ranges around explicitly failed pages. Navigable runs keep
 * their structural basis; failed pages stay explicit in the coverage ledger
 * and are never silently counted as mapped.
 */
/**
 * @param {readonly StructuralPageInput[]} pages
 * @param {{ startPageIndex: number, endPageIndex: number }} range
 */
function navigableRuns(pages, range) {
  const runs = [];
  let start = null;
  for (let pageIndex = range.startPageIndex; pageIndex <= range.endPageIndex; pageIndex += 1) {
    if (pages[pageIndex].textCapability === "failed") {
      if (start !== null) runs.push({ startPageIndex: start, endPageIndex: pageIndex - 1 });
      start = null;
    } else if (start === null) {
      start = pageIndex;
    }
  }
  if (start !== null) runs.push({ startPageIndex: start, endPageIndex: range.endPageIndex });
  return runs;
}

/** @param {StructuralBasis} basis @returns {StructuralConfidence} */
function confidenceForBasis(basis) {
  if (basis === "pdf_outline") return "document_declared";
  if (basis === "heading_heuristic") return "system_inferred";
  return "coverage_fallback";
}

/** @param {StructuralBasis} basis @param {number} startPageIndex @param {number} endPageIndex @param {boolean} limited */
function summaryForNode(basis, startPageIndex, endPageIndex, limited) {
  const range = pageRangeLabel(startPageIndex, endPageIndex);
  const limitation = limited ? " Some pages have limited or no extractable text." : "";
  if (basis === "pdf_outline") {
    return `PDF outline structure covering ${range}. Document structure only; this is not an importance or main-idea judgment.${limitation}`;
  }
  if (basis === "heading_heuristic") {
    return `System-inferred heading range covering ${range}. Treat the label as provisional document structure, not author-confirmed semantic truth.${limitation}`;
  }
  return `Deterministic page-coverage fallback for ${range}. No heading or outline claim is made.${limitation}`;
}

/** @param {string} documentSha256 @param {StructuralBasis} basis @param {number} startPageIndex @param {number} endPageIndex @param {string} label */
function nodeIdentity(documentSha256, basis, startPageIndex, endPageIndex, label) {
  const digestToken = documentSha256.slice(0, 12);
  return `node:structure:${digestToken}:${basis}:p${startPageIndex + 1}-${endPageIndex + 1}:${stableToken(label.toLocaleLowerCase("en-US"))}`;
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(/** @type {object} */ (value))) deepFreeze(child);
  return /** @type {T} */ (Object.freeze(value));
}

/**
 * @param {{
 *   documentSha256: string,
 *   pages: readonly StructuralPageInput[],
 *   outlineEntries?: readonly OutlineEntryInput[],
 *   heuristicHeadings?: readonly HeadingInput[],
 *   maxFallbackPages?: number,
 * }} input
 */
export function createWholePaperStructuralMap({
  documentSha256,
  pages: inputPages,
  outlineEntries = [],
  heuristicHeadings = [],
  maxFallbackPages = DEFAULT_MAX_FALLBACK_PAGES,
}) {
  if (!/^[0-9a-f]{64}$/u.test(String(documentSha256))) {
    throw new TypeError("A structural map requires the active PDF SHA-256 identity.");
  }
  if (!Number.isInteger(maxFallbackPages) || maxFallbackPages < 1 || maxFallbackPages > 10) {
    throw new TypeError("Fallback structural ranges must contain between one and ten pages.");
  }
  const pages = normalizePages(inputPages);
  const boundarySource = structuralBoundaries(pages.length, outlineEntries, heuristicHeadings);
  const preliminaryRanges = [];
  if (boundarySource.basis) {
    const firstBoundary = boundarySource.entries[0];
    if (firstBoundary.pageIndex > 0) {
      preliminaryRanges.push(...splitFallbackRange(0, firstBoundary.pageIndex - 1, maxFallbackPages).map((range) => ({
        ...range,
        label: pageRangeLabel(range.startPageIndex, range.endPageIndex),
        basis: /** @type {StructuralBasis} */ ("page_fallback"),
      })));
    }
    for (let index = 0; index < boundarySource.entries.length; index += 1) {
      const boundary = boundarySource.entries[index];
      const next = boundarySource.entries[index + 1];
      preliminaryRanges.push({
        startPageIndex: boundary.pageIndex,
        endPageIndex: (next?.pageIndex ?? pages.length) - 1,
        label: boundary.label,
        basis: /** @type {StructuralBasis} */ (boundarySource.basis),
      });
    }
  } else {
    preliminaryRanges.push(...splitFallbackRange(0, pages.length - 1, maxFallbackPages).map((range) => ({
      ...range,
      label: pageRangeLabel(range.startPageIndex, range.endPageIndex),
      basis: /** @type {StructuralBasis} */ ("page_fallback"),
    })));
  }

  const nodes = [];
  for (const range of preliminaryRanges) {
    const runs = navigableRuns(pages, range);
    const pieces = runs.flatMap((run) => (
      range.basis === "page_fallback"
        ? splitFallbackRange(run.startPageIndex, run.endPageIndex, maxFallbackPages)
        : [run]
    ));
    for (const [pieceIndex, piece] of pieces.entries()) {
        const primaryPage = pages[piece.startPageIndex];
        const limited = pages
          .slice(piece.startPageIndex, piece.endPageIndex + 1)
          .some((page) => page.textCapability !== "exact_candidate");
        const partNumber = pieceIndex + 1;
        const partCount = pieces.length;
        const label = range.basis === "page_fallback"
          ? pageRangeLabel(piece.startPageIndex, piece.endPageIndex)
          : semanticSegmentLabel(range.label, piece.startPageIndex, piece.endPageIndex, partNumber, partCount);
        const basis = /** @type {StructuralBasis} */ (range.basis);
        nodes.push({
          key: nodeIdentity(String(documentSha256), basis, piece.startPageIndex, piece.endPageIndex, label),
          label,
          summary: summaryForNode(basis, piece.startPageIndex, piece.endPageIndex, limited),
          basis,
          confidence: /** @type {StructuralConfidence} */ (confidenceForBasis(basis)),
          startPageIndex: piece.startPageIndex,
          endPageIndex: piece.endPageIndex,
          primaryPageIndex: piece.startPageIndex,
          primaryPageLabel: primaryPage.pageLabel,
          primaryPageViewBox: [...primaryPage.pageViewBox],
          primaryPageRotation: primaryPage.pageRotation,
          limited,
        });
    }
  }
  nodes.sort((left, right) => left.startPageIndex - right.startPageIndex || left.endPageIndex - right.endPageIndex || left.key.localeCompare(right.key));

  const nodeByPage = new Map();
  for (const node of nodes) {
    for (let pageIndex = node.startPageIndex; pageIndex <= node.endPageIndex; pageIndex += 1) {
      if (nodeByPage.has(pageIndex)) throw new Error("Structural leaf ranges overlap.");
      nodeByPage.set(pageIndex, node.key);
    }
  }
  const coverage = pages.map((page) => {
    const structuralNodeKey = nodeByPage.get(page.pageIndex) || null;
    /** @type {StructuralMappingState} */
    const mappingState = page.textCapability === "failed"
      ? "failed"
      : page.textCapability === "exact_candidate"
        ? "structural"
        : "limited";
    if (mappingState !== "failed" && !structuralNodeKey) {
      throw new Error(`Structural coverage is missing page ${page.pageIndex + 1}.`);
    }
    return {
      pageIndex: page.pageIndex,
      pageLabel: page.pageLabel,
      textCapability: page.textCapability,
      mappingState,
      structuralNodeKey,
    };
  });

  const structuralPages = coverage.filter((entry) => entry.mappingState === "structural").length;
  const limitedPages = coverage.filter((entry) => entry.mappingState === "limited").length;
  const failedPages = coverage.filter((entry) => entry.mappingState === "failed").length;
  const navigablePages = structuralPages + limitedPages;
  const status = failedPages === 0 && navigablePages === pages.length
    ? "structural_ready"
    : navigablePages > 0
      ? "structural_partial"
      : "failed";

  return deepFreeze({
    schemaVersion: STRUCTURAL_MAP_VERSION,
    status,
    authority: "document_structure",
    claimBoundary: STRUCTURAL_MAP_CLAIM_BOUNDARY,
    pageCount: pages.length,
    sourceStats: {
      resolvedOutlineEntries: boundarySource.outlineResolved,
      heuristicHeadingsConsidered: boundarySource.headingsConsidered,
      selectedBasis: boundarySource.basis || "page_fallback",
    },
    counts: { structuralPages, limitedPages, failedPages, navigablePages },
    coverage,
    nodes,
  });
}
