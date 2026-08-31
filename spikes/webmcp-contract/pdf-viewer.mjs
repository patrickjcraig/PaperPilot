import {
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  getDocument,
  version as pdfjsVersion,
} from "/vendor/pdfjs/pdf.min.mjs";

GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DEFAULT_ZOOM_STEP = 0.15;
const DEFAULT_MIN_ZOOM = 0.45;
const DEFAULT_MAX_ZOOM = 3;
const MAX_DEVICE_PIXEL_RATIO = 2;
const DEFAULT_PAGE_GAP = 24;
const DEFAULT_RENDER_RADIUS = 2;
const DEFAULT_MAX_SELECTION_CHARACTERS = 4_000;

export const ATTENTION_PDF = Object.freeze({
  title: "Attention Is All You Need",
  arxivId: "1706.03762",
  arxivVersion: "v7",
  sourceUrl: "https://arxiv.org/pdf/1706.03762v7",
  localUrl: "/assets/papers/attention-is-all-you-need-1706.03762v7.pdf",
  filename: "attention-is-all-you-need-1706.03762v7.pdf",
  byteLength: 2_215_244,
  sha256: "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697",
  pageCount: 15,
});

export const ATTENTION_SOURCE_ANCHOR = Object.freeze({
  anchorId: "anchor:text:attention",
  pageIndex: 0,
  pageNumber: 1,
  pageLabel: "1",
  sourceKind: "exact_text",
  exactText:
    "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
  exactTextSha256: "ed7631200a18f20fc81a069dbaec1e4780737fd416877c9496ab815a38eb1fd7",
});

export const DEFAULT_PDF_VIEWER_IDS = Object.freeze({
  viewer: "pdf-viewer",
  surface: "pdf-page-surface",
  canvas: "pdf-canvas",
  textLayer: "pdf-text-layer",
  annotationOverlay: "pdf-annotation-overlay",
  previousPage: "pdf-previous-page",
  nextPage: "pdf-next-page",
  pageNumber: "pdf-page-number",
  pageCount: "pdf-page-count",
  zoomOut: "pdf-zoom-out",
  zoomIn: "pdf-zoom-in",
  fitWidth: "pdf-fit-width",
  zoomLabel: "pdf-zoom-label",
  status: "pdf-status",
});

export class PaperPdfError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PaperPdfError";
    this.code = code;
  }
}

class StalePdfRenderError extends Error {
  constructor() {
    super("A newer PDF render superseded this render.");
    this.name = "StalePdfRenderError";
  }
}

function rounded(value, precision = 6) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Clamp page-like input while keeping invalid input on a known-good fallback. */
export function clampPdfPageNumber(value, pageCount, fallback = 1) {
  const totalPages = Math.max(1, asPositiveInteger(pageCount, 1));
  const safeFallback = clamp(asPositiveInteger(fallback, 1), 1, totalPages);
  return clamp(asPositiveInteger(value, safeFallback), 1, totalPages);
}

/**
 * Select the page under a reader-oriented line 35% down the scrollport. When
 * that line falls in a page gap, choose the page with the greatest overlap.
 */
export function selectActivePageNumber(
  pageMetrics,
  { scrollTop = 0, viewportHeight = 0, fallbackPage = 1 } = {},
) {
  const metrics = pageMetrics
    .map((metric) => {
      const pageNumber = asPositiveInteger(metric.pageNumber, 0);
      const top = Number(metric.top);
      const height = Number(metric.height ?? (Number(metric.bottom) - top));
      if (!pageNumber || !Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return null;
      return { pageNumber, top, height, bottom: top + height };
    })
    .filter(Boolean)
    .sort((left, right) => left.pageNumber - right.pageNumber);
  if (metrics.length === 0) return asPositiveInteger(fallbackPage, 1);

  const safeScrollTop = Math.max(0, Number.isFinite(Number(scrollTop)) ? Number(scrollTop) : 0);
  const safeViewportHeight = Math.max(1, Number.isFinite(Number(viewportHeight)) ? Number(viewportHeight) : 1);
  const viewportBottom = safeScrollTop + safeViewportHeight;
  const readingLine = safeScrollTop + (safeViewportHeight * 0.35);
  const underReadingLine = metrics.find((metric) => readingLine >= metric.top && readingLine < metric.bottom);
  if (underReadingLine) return underReadingLine.pageNumber;

  let best = null;
  for (const metric of metrics) {
    const overlap = Math.max(0, Math.min(metric.bottom, viewportBottom) - Math.max(metric.top, safeScrollTop));
    const distance = Math.abs(((metric.top + metric.bottom) / 2) - readingLine);
    if (!best || overlap > best.overlap || (overlap === best.overlap && distance < best.distance)) {
      best = { pageNumber: metric.pageNumber, overlap, distance };
    }
  }
  return best?.pageNumber || clampPdfPageNumber(fallbackPage, metrics.at(-1).pageNumber);
}

/** Compute a deterministic scrollTop for page navigation without window scrolling. */
export function calculatePageScrollTop({
  pageTop,
  pageHeight,
  scrollTop = 0,
  viewportHeight,
  block = "start",
  margin = 12,
}) {
  const top = Math.max(0, Number(pageTop) || 0);
  const height = Math.max(1, Number(pageHeight) || 1);
  const current = Math.max(0, Number(scrollTop) || 0);
  const viewport = Math.max(1, Number(viewportHeight) || 1);
  const inset = Math.max(0, Number(margin) || 0);
  const pageBottom = top + height;
  const viewportBottom = current + viewport;

  if (block === "nearest") {
    if (top >= current + inset && pageBottom <= viewportBottom - inset) return current;
    if (top < current + inset) return Math.max(0, top - inset);
    return Math.max(0, pageBottom - viewport + inset);
  }
  if (block === "center") return Math.max(0, top - ((viewport - height) / 2));
  if (block === "end") return Math.max(0, pageBottom - viewport + inset);
  return Math.max(0, top - inset);
}

/** Keep a small rendered neighborhood while page shells preserve full scroll geometry. */
export function pageNumbersForRenderWindow(activePage, pageCount, radius = DEFAULT_RENDER_RADIUS) {
  const totalPages = Math.max(1, asPositiveInteger(pageCount, 1));
  const active = clampPdfPageNumber(activePage, totalPages);
  const safeRadius = Math.max(0, Number.isInteger(radius) ? radius : DEFAULT_RENDER_RADIUS);
  const pages = new Set([ATTENTION_SOURCE_ANCHOR.pageNumber]);
  for (let pageNumber = active - safeRadius; pageNumber <= active + safeRadius; pageNumber += 1) {
    if (pageNumber >= 1 && pageNumber <= totalPages) pages.add(pageNumber);
  }
  return [...pages].sort((left, right) => left - right);
}

function resolveElement(value, defaultId, { required = false } = {}) {
  const element = typeof value === "string"
    ? document.querySelector(value)
    : value || document.getElementById(defaultId);
  if (required && !element) {
    throw new PaperPdfError(
      "PDF_VIEWER_ELEMENT_MISSING",
      `The real-PDF viewer requires an element for ${defaultId}.`,
    );
  }
  return element || null;
}

function getOrCreateLayer(value, defaultId, parent, className, tagName = "div") {
  const existing = resolveElement(value, defaultId);
  if (existing) return existing;
  const element = document.createElement(tagName);
  element.id = defaultId;
  element.className = className;
  parent.append(element);
  return element;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new PaperPdfError(
      "PDF_INTEGRITY_UNAVAILABLE",
      "Web Crypto is required to verify the local paper before rendering it.",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function isPdfSignature(bytes) {
  if (bytes.byteLength < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/**
 * Build normalized text and a reversible character map for ordered PDF.js spans.
 * `chunks` may use actual DOM Text nodes or small test doubles with a `data` field.
 * The returned record for each normalized character retains its source node offsets.
 */
export function buildNormalizedCharacterMap(chunks) {
  const normalizedCharacters = [];
  const positions = [];
  let pendingWhitespace = null;

  const rememberWhitespace = (node, offset) => {
    pendingWhitespace ||= { node, startOffset: offset, endOffset: offset };
  };

  const emitPendingWhitespace = () => {
    if (!pendingWhitespace || normalizedCharacters.length === 0) {
      pendingWhitespace = null;
      return;
    }
    if (normalizedCharacters.at(-1) !== " ") {
      normalizedCharacters.push(" ");
      positions.push(pendingWhitespace);
    }
    pendingWhitespace = null;
  };

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const node = chunk.node || chunk;
    const text = String(chunk.text ?? node.data ?? node.textContent ?? "");

    // PDF.js uses one text div per item and does not add a DOM separator between
    // adjacent items. Treat that boundary as collapsible whitespace. This is what
    // lets a sentence remain searchable when it wraps to the next PDF text item.
    if (chunkIndex > 0) rememberWhitespace(node, 0);

    for (let offset = 0; offset < text.length;) {
      const character = String.fromCodePoint(text.codePointAt(offset));
      const nextOffset = offset + character.length;
      if (/\s/u.test(character)) {
        rememberWhitespace(node, offset);
        if (pendingWhitespace) pendingWhitespace.endOffset = nextOffset;
        offset = nextOffset;
        continue;
      }

      emitPendingWhitespace();
      const normalized = character.normalize("NFKC");
      for (const normalizedCharacter of normalized) {
        normalizedCharacters.push(normalizedCharacter);
        positions.push({ node, startOffset: offset, endOffset: nextOffset });
      }
      offset = nextOffset;
    }
  }

  return {
    text: normalizedCharacters.join(""),
    positions,
  };
}

export function normalizePdfText(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

export function findUniqueNormalizedMatch(haystack, exactText) {
  const needle = normalizePdfText(exactText);
  const matches = [];
  let searchFrom = 0;
  while (searchFrom <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) break;
    matches.push(index);
    searchFrom = index + Math.max(needle.length, 1);
  }
  if (matches.length !== 1) {
    throw new PaperPdfError(
      "PDF_SOURCE_MATCH_COUNT",
      `Expected one exact source match on page 1; found ${matches.length}.`,
    );
  }
  return Object.freeze({ start: matches[0], end: matches[0] + needle.length, exactText: needle });
}

function collectPdfTextNodes(textDivs) {
  const chunks = [];
  for (const textDiv of textDivs) {
    const walker = document.createTreeWalker(textDiv, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data) chunks.push({ node, text: node.data });
    }
  }
  return chunks;
}

function uniqueVisibleClientRects(range) {
  const seen = new Set();
  const rects = [];
  for (const rect of range.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const key = [rect.left, rect.top, rect.width, rect.height]
      .map((value) => rounded(value, 2))
      .join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    rects.push(rect);
  }
  return rects;
}

export function mergeClientRectsByLine(rects) {
  const sorted = [...rects]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((left, right) => left.top - right.top || left.left - right.left);
  const lines = [];
  for (const rect of sorted) {
    const centerY = (rect.top + rect.bottom) / 2;
    const line = lines.find((candidate) => (
      Math.abs(centerY - candidate.centerY) <= Math.max(rect.height, candidate.height) * 0.45
    ));
    if (!line) {
      lines.push({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        centerY,
      });
      continue;
    }
    line.left = Math.min(line.left, rect.left);
    line.top = Math.min(line.top, rect.top);
    line.right = Math.max(line.right, rect.right);
    line.bottom = Math.max(line.bottom, rect.bottom);
    line.width = line.right - line.left;
    line.height = line.bottom - line.top;
    line.centerY = (line.top + line.bottom) / 2;
  }
  return lines.map((line) => {
    const mergedLine = { ...line };
    delete mergedLine.centerY;
    return mergedLine;
  });
}

export function normalizeClientRects(rects, pageRect) {
  if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) {
    throw new PaperPdfError("PDF_SOURCE_GEOMETRY_EMPTY", "The rendered PDF page has no measurable geometry.");
  }
  return rects.map((rect) => {
    const left = clamp(rect.left - pageRect.left, 0, pageRect.width);
    const top = clamp(rect.top - pageRect.top, 0, pageRect.height);
    const right = clamp(rect.right - pageRect.left, 0, pageRect.width);
    const bottom = clamp(rect.bottom - pageRect.top, 0, pageRect.height);
    return Object.freeze({
      x: rounded(left / pageRect.width),
      y: rounded(top / pageRect.height),
      width: rounded(Math.max(0, right - left) / pageRect.width),
      height: rounded(Math.max(0, bottom - top) / pageRect.height),
    });
  }).filter((rect) => rect.width > 0 && rect.height > 0);
}

export function freezePdfPageViewBox(viewBox) {
  const values = Array.from(viewBox || [], (value) => Number(value));
  if (
    values.length !== 4
    || values.some((value) => !Number.isFinite(value))
    || values[2] <= values[0]
    || values[3] <= values[1]
  ) {
    throw new PaperPdfError(
      "PDF_PAGE_VIEWBOX_INVALID",
      "The PDF page view box must contain four finite increasing coordinates.",
    );
  }
  return Object.freeze(values);
}

function unionNormalizedRects(rects) {
  if (rects.length === 0) {
    throw new PaperPdfError("PDF_SOURCE_GEOMETRY_EMPTY", "The exact source match produced no visible rectangles.");
  }
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return Object.freeze({
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
  });
}

function pdfQuadsFromClientRects(rects, pageRect, viewport) {
  return rects.map((rect) => {
    const left = clamp(rect.left - pageRect.left, 0, pageRect.width);
    const top = clamp(rect.top - pageRect.top, 0, pageRect.height);
    const right = clamp(rect.right - pageRect.left, 0, pageRect.width);
    const bottom = clamp(rect.bottom - pageRect.top, 0, pageRect.height);
    const points = [
      viewport.convertToPdfPoint(left, top),
      viewport.convertToPdfPoint(right, top),
      viewport.convertToPdfPoint(right, bottom),
      viewport.convertToPdfPoint(left, bottom),
    ].flatMap(([x, y]) => [rounded(x, 3), rounded(y, 3)]);
    return Object.freeze({ points: Object.freeze(points) });
  });
}

function setElementPercentBounds(element, bounds) {
  element.style.left = `${bounds.x * 100}%`;
  element.style.top = `${bounds.y * 100}%`;
  element.style.width = `${bounds.width * 100}%`;
  element.style.height = `${bounds.height * 100}%`;
}

function paintSourceHighlights({ annotationOverlay, anchorTarget, rects, bounds, viewport }) {
  let highlightSvg = annotationOverlay.querySelector("[data-paperpilot-source-highlights]");
  if (!highlightSvg) {
    highlightSvg = document.createElementNS(SVG_NAMESPACE, "svg");
    highlightSvg.dataset.paperpilotSourceHighlights = "true";
    highlightSvg.classList.add("pdf-source-highlights");
    highlightSvg.setAttribute("aria-hidden", "true");
    annotationOverlay.prepend(highlightSvg);
  }
  highlightSvg.replaceChildren();
  highlightSvg.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
  highlightSvg.setAttribute("preserveAspectRatio", "none");
  highlightSvg.setAttribute("width", "100%");
  highlightSvg.setAttribute("height", "100%");
  highlightSvg.style.position = "absolute";
  highlightSvg.style.inset = "0";

  for (const rect of rects) {
    const highlight = document.createElementNS(SVG_NAMESPACE, "rect");
    highlight.classList.add("pdf-source-highlight");
    highlight.setAttribute("x", String(rect.x * viewport.width));
    highlight.setAttribute("y", String(rect.y * viewport.height));
    highlight.setAttribute("width", String(rect.width * viewport.width));
    highlight.setAttribute("height", String(rect.height * viewport.height));
    highlight.setAttribute("fill", "rgba(250, 204, 21, 0.28)");
    highlight.setAttribute("stroke", "rgba(217, 119, 6, 0.88)");
    highlight.setAttribute("stroke-width", "1.25");
    highlight.setAttribute("vector-effect", "non-scaling-stroke");
    highlightSvg.append(highlight);
  }

  setElementPercentBounds(anchorTarget, bounds);
  anchorTarget.hidden = false;
  anchorTarget.dataset.pageNumber = "1";
  anchorTarget.dataset.anchorId = ATTENTION_SOURCE_ANCHOR.anchorId;
}

function createSourceAnchorTarget(annotationOverlay) {
  let anchorTarget = annotationOverlay.querySelector("#text-source") || document.getElementById("text-source");
  if (anchorTarget && anchorTarget.parentElement !== annotationOverlay) annotationOverlay.append(anchorTarget);
  if (!anchorTarget) {
    anchorTarget = document.createElement("div");
    anchorTarget.id = "text-source";
    annotationOverlay.append(anchorTarget);
  }
  anchorTarget.classList.add("pdf-source-anchor", "active");
  anchorTarget.tabIndex = -1;
  anchorTarget.hidden = true;
  anchorTarget.style.position = "absolute";
  anchorTarget.setAttribute(
    "aria-label",
    `Exact source on page 1: ${ATTENTION_SOURCE_ANCHOR.exactText}`,
  );

  let annotationContent = anchorTarget.querySelector("#source-annotation-overlay");
  if (!annotationContent) {
    annotationContent = document.createElement("div");
    annotationContent.id = "source-annotation-overlay";
    annotationContent.className = "source-annotation-overlay";
    annotationContent.setAttribute("role", "list");
    annotationContent.setAttribute("aria-label", "Visible annotations on this exact source");
    anchorTarget.append(annotationContent);
  }
  return anchorTarget;
}

function isExpectedCancellation(error) {
  return error instanceof StalePdfRenderError
    || error instanceof RenderingCancelledException
    || error?.name === "RenderingCancelledException"
    || error?.name === "AbortException";
}

/**
 * Initialize the exact-paper PDF.js surface as a continuous vertical document.
 * All page shells participate in scroll layout. Page 1 and a small window around
 * the active page retain their canvas/text layers; distant pages are lightweight
 * placeholders with stable dimensions and page-owned annotation overlays.
 *
 * @param {object} options
 * @returns {Promise<object>} continuous viewer, navigation, selection, anchor,
 *   zoom, and lifecycle APIs.
 */
export async function initializePaperPdfViewer(options = {}) {
  const viewer = resolveElement(options.viewer, DEFAULT_PDF_VIEWER_IDS.viewer, { required: true });
  const initialSurface = getOrCreateLayer(
    options.surface,
    DEFAULT_PDF_VIEWER_IDS.surface,
    viewer,
    "pdf-page-surface",
    "section",
  );
  const initialCanvas = getOrCreateLayer(
    options.canvas,
    DEFAULT_PDF_VIEWER_IDS.canvas,
    initialSurface,
    "pdf-canvas",
    "canvas",
  );
  const initialTextLayer = getOrCreateLayer(
    options.textLayer,
    DEFAULT_PDF_VIEWER_IDS.textLayer,
    initialSurface,
    "textLayer pdf-text-layer",
  );
  const initialAnnotationOverlay = getOrCreateLayer(
    options.annotationOverlay,
    DEFAULT_PDF_VIEWER_IDS.annotationOverlay,
    initialSurface,
    "pdf-annotation-overlay",
  );
  const pageStackEndReference = initialSurface.nextSibling;
  const controls = {
    previousPage: resolveElement(options.previousPage, DEFAULT_PDF_VIEWER_IDS.previousPage),
    nextPage: resolveElement(options.nextPage, DEFAULT_PDF_VIEWER_IDS.nextPage),
    pageNumber: resolveElement(options.pageNumber, DEFAULT_PDF_VIEWER_IDS.pageNumber),
    pageCount: resolveElement(options.pageCount, DEFAULT_PDF_VIEWER_IDS.pageCount),
    zoomOut: resolveElement(options.zoomOut, DEFAULT_PDF_VIEWER_IDS.zoomOut),
    zoomIn: resolveElement(options.zoomIn, DEFAULT_PDF_VIEWER_IDS.zoomIn),
    fitWidth: resolveElement(options.fitWidth, DEFAULT_PDF_VIEWER_IDS.fitWidth),
    zoomLabel: resolveElement(options.zoomLabel, DEFAULT_PDF_VIEWER_IDS.zoomLabel),
    status: resolveElement(options.status, DEFAULT_PDF_VIEWER_IDS.status),
  };

  const abortController = new AbortController();
  const cleanupCallbacks = [];
  const pageRecords = new Map();
  const anchorOverlays = new Map();
  const anchorTarget = createSourceAnchorTarget(initialAnnotationOverlay);
  anchorOverlays.set(ATTENTION_SOURCE_ANCHOR.anchorId, {
    anchorId: ATTENTION_SOURCE_ANCHOR.anchorId,
    pageNumber: ATTENTION_SOURCE_ANCHOR.pageNumber,
    target: anchorTarget,
    svg: null,
    builtIn: true,
  });

  const state = {
    destroyed: false,
    failed: false,
    ready: false,
    pdfDocument: null,
    loadingTask: null,
    documentFacts: null,
    currentPage: asPositiveInteger(options.initialPage, 1),
    zoomMode: options.initialZoom ?? "fit-width",
    scale: 1,
    zoomGeneration: 0,
    anchorGeometry: null,
    pendingSelectionAnchorId: null,
    renderPromise: Promise.resolve(null),
    resizeFrame: null,
    scrollFrame: null,
  };
  const minZoom = Number.isFinite(options.minZoom) ? options.minZoom : DEFAULT_MIN_ZOOM;
  const maxZoom = Number.isFinite(options.maxZoom) ? options.maxZoom : DEFAULT_MAX_ZOOM;
  const zoomStep = Number.isFinite(options.zoomStep) ? options.zoomStep : DEFAULT_ZOOM_STEP;
  const horizontalPadding = Number.isFinite(options.horizontalPadding) ? options.horizontalPadding : 24;
  const pageGap = Number.isFinite(options.pageGap) ? Math.max(0, options.pageGap) : DEFAULT_PAGE_GAP;
  const renderRadius = Number.isInteger(options.renderRadius)
    ? Math.max(0, options.renderRadius)
    : DEFAULT_RENDER_RADIUS;
  const maxSelectionCharacters = Number.isInteger(options.maxSelectionCharacters)
    ? Math.max(1, options.maxSelectionCharacters)
    : DEFAULT_MAX_SELECTION_CHARACTERS;

  const emitStatus = (kind, message, details = {}) => {
    viewer.dataset.pdfState = kind;
    if (controls.status) controls.status.textContent = message;
    options.onStatus?.({ kind, message, ...details });
  };

  const fail = (error) => {
    const wrapped = error instanceof PaperPdfError
      ? error
      : new PaperPdfError("PDF_VIEWER_FAILED", error?.message || "The exact paper could not be rendered.", { cause: error });
    const alreadyFailed = state.failed;
    state.failed = true;
    viewer.dataset.pdfState = "error";
    viewer.setAttribute("aria-busy", "false");
    anchorTarget.hidden = true;
    emitStatus("error", wrapped.message, { code: wrapped.code });
    if (!alreadyFailed) options.onError?.(wrapped);
    return wrapped;
  };

  const listen = (element, eventName, listener, listenerOptions) => {
    if (!element) return;
    element.addEventListener(eventName, listener, listenerOptions);
    cleanupCallbacks.push(() => element.removeEventListener(eventName, listener, listenerOptions));
  };

  const safelyHandle = (action) => {
    Promise.resolve().then(action).catch((error) => {
      if (!isExpectedCancellation(error) && !state.failed) fail(error);
    });
  };

  const configurePageElements = ({ pageNumber, surface, canvas, textLayerElement, annotationOverlay }) => {
    surface.classList.add("pdf-page-surface");
    surface.dataset.pageNumber = String(pageNumber);
    surface.dataset.renderState = "placeholder";
    surface.tabIndex = -1;
    surface.style.position = "relative";
    surface.style.marginInline = "auto";
    surface.style.marginBlockEnd = pageNumber === ATTENTION_PDF.pageCount ? "0" : `${pageGap}px`;
    surface.style.flex = "0 0 auto";
    surface.setAttribute("aria-label", `PDF page ${pageNumber} of ${ATTENTION_PDF.pageCount}`);

    canvas.classList.add("pdf-canvas");
    canvas.style.display = "block";
    canvas.setAttribute("aria-hidden", "true");
    textLayerElement.classList.add("textLayer", "pdf-text-layer");
    textLayerElement.style.position = "absolute";
    textLayerElement.style.inset = "0";
    annotationOverlay.classList.add("pdf-annotation-overlay");
    annotationOverlay.style.position = "absolute";
    annotationOverlay.style.inset = "0";
    annotationOverlay.style.pointerEvents = "none";
    annotationOverlay.style.zIndex = "4";
    annotationOverlay.setAttribute("aria-hidden", "true");
  };

  const createPageRecord = (pageNumber, pdfPage) => {
    let surface;
    let canvas;
    let textLayerElement;
    let annotationOverlay;
    if (pageNumber === 1) {
      surface = initialSurface;
      canvas = initialCanvas;
      textLayerElement = initialTextLayer;
      annotationOverlay = initialAnnotationOverlay;
    } else {
      surface = document.createElement("section");
      surface.id = `${DEFAULT_PDF_VIEWER_IDS.surface}-${pageNumber}`;
      canvas = document.createElement("canvas");
      canvas.id = `${DEFAULT_PDF_VIEWER_IDS.canvas}-${pageNumber}`;
      textLayerElement = document.createElement("div");
      textLayerElement.id = `${DEFAULT_PDF_VIEWER_IDS.textLayer}-${pageNumber}`;
      annotationOverlay = document.createElement("div");
      annotationOverlay.id = `${DEFAULT_PDF_VIEWER_IDS.annotationOverlay}-${pageNumber}`;
      surface.append(canvas, textLayerElement, annotationOverlay);
      if (pageStackEndReference?.parentNode === viewer) viewer.insertBefore(surface, pageStackEndReference);
      else viewer.append(surface);
    }
    configurePageElements({ pageNumber, surface, canvas, textLayerElement, annotationOverlay });
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const record = {
      pageNumber,
      pageIndex: pageNumber - 1,
      pdfPage,
      baseViewport,
      surface,
      canvas,
      textLayerElement,
      annotationOverlay,
      renderTask: null,
      textLayer: null,
      viewport: null,
      renderedScale: null,
      requestedScale: null,
      generation: 0,
      renderPromise: null,
    };
    pageRecords.set(pageNumber, record);
    return record;
  };

  const applyPageDimensions = (record, scale = state.scale) => {
    const viewport = record.pdfPage.getViewport({ scale });
    record.surface.style.setProperty("--scale-factor", String(viewport.scale));
    record.surface.style.setProperty("--user-unit", "1");
    record.surface.style.setProperty("--total-scale-factor", "calc(var(--scale-factor) * var(--user-unit))");
    record.surface.style.setProperty("--scale-round-x", "1px");
    record.surface.style.setProperty("--scale-round-y", "1px");
    record.surface.style.width = `${viewport.width}px`;
    record.surface.style.height = `${viewport.height}px`;
    record.canvas.style.width = `${viewport.width}px`;
    record.canvas.style.height = `${viewport.height}px`;
    return viewport;
  };

  const updatePageLabels = () => {
    const pageCount = state.pdfDocument?.numPages || ATTENTION_PDF.pageCount;
    for (const record of pageRecords.values()) {
      record.surface.setAttribute("aria-label", `PDF page ${record.pageNumber} of ${pageCount}`);
    }
  };

  const updateControls = () => {
    const pageCount = state.pdfDocument?.numPages || ATTENTION_PDF.pageCount;
    if (controls.pageNumber) {
      if ("value" in controls.pageNumber) controls.pageNumber.value = String(state.currentPage);
      else controls.pageNumber.textContent = String(state.currentPage);
      if ("min" in controls.pageNumber) controls.pageNumber.min = "1";
      if ("max" in controls.pageNumber) controls.pageNumber.max = String(pageCount);
      controls.pageNumber.setAttribute("aria-label", `Current PDF page, ${state.currentPage} of ${pageCount}`);
    }
    if (controls.pageCount) controls.pageCount.textContent = String(pageCount);
    if (controls.previousPage) controls.previousPage.disabled = state.currentPage <= 1;
    if (controls.nextPage) controls.nextPage.disabled = state.currentPage >= pageCount;
    if (controls.zoomOut) controls.zoomOut.disabled = state.scale <= minZoom + 0.001;
    if (controls.zoomIn) controls.zoomIn.disabled = state.scale >= maxZoom - 0.001;
    if (controls.zoomLabel) controls.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  };

  const emitReadyStatus = () => {
    if (!state.ready || state.failed || state.destroyed) return;
    emitStatus(
      "ready",
      `Exact PDF verified · continuous page ${state.currentPage} of ${state.pdfDocument.numPages} · ${Math.round(state.scale * 100)}%`,
      { pageNumber: state.currentPage, scale: state.scale, mode: state.zoomMode },
    );
  };

  const notifyPageChange = ({ force = false, previousPage = null } = {}) => {
    updateControls();
    if (force || previousPage !== state.currentPage) {
      options.onPageChange?.({ pageNumber: state.currentPage, pageCount: state.pdfDocument.numPages });
      // The existing host callback writes to the original page-1 node. Restore
      // page-owned labels after the callback so the continuous stack stays true.
      updatePageLabels();
    }
    emitReadyStatus();
  };

  const setActivePage = (pageNumber, { force = false } = {}) => {
    const nextPage = clampPdfPageNumber(pageNumber, state.pdfDocument.numPages, state.currentPage);
    const previousPage = state.currentPage;
    state.currentPage = nextPage;
    notifyPageChange({ force, previousPage });
    return nextPage;
  };

  const calculateFitWidthScale = (pageNumber = state.currentPage) => {
    const record = pageRecords.get(clampPdfPageNumber(pageNumber, state.pdfDocument.numPages));
    const availableWidth = Math.max(1, viewer.clientWidth - horizontalPadding);
    return clamp(availableWidth / record.baseViewport.width, minZoom, maxZoom);
  };

  const resolveSourceAnchor = (record, textLayer, viewport) => {
    const chunks = collectPdfTextNodes(textLayer.textDivs);
    const characterMap = buildNormalizedCharacterMap(chunks);
    const match = findUniqueNormalizedMatch(characterMap.text, ATTENTION_SOURCE_ANCHOR.exactText);
    const startPosition = characterMap.positions[match.start];
    const endPosition = characterMap.positions[match.end - 1];
    if (!startPosition || !endPosition) {
      throw new PaperPdfError("PDF_SOURCE_MAP_FAILED", "The exact source match could not be mapped back to page text.");
    }

    const range = document.createRange();
    range.setStart(startPosition.node, startPosition.startOffset);
    range.setEnd(endPosition.node, endPosition.endOffset);
    const clientRects = mergeClientRectsByLine(uniqueVisibleClientRects(range));
    const pageRect = record.surface.getBoundingClientRect();
    const rects = normalizeClientRects(clientRects, pageRect);
    const bounds = unionNormalizedRects(rects);
    const pdfQuads = pdfQuadsFromClientRects(clientRects, pageRect, viewport);
    range.detach?.();

    const anchorGeometry = Object.freeze({
      ...ATTENTION_SOURCE_ANCHOR,
      documentSha256: ATTENTION_PDF.sha256,
      coordinateSpace: "normalized_page_top_left",
      bounds,
      rects: Object.freeze(rects),
      pdfQuads: Object.freeze(pdfQuads),
      pageViewBox: freezePdfPageViewBox(viewport.viewBox),
      pageRotation: viewport.rotation,
      viewport: Object.freeze({
        width: rounded(viewport.width, 3),
        height: rounded(viewport.height, 3),
        scale: rounded(viewport.scale, 6),
        rotation: viewport.rotation,
        viewBox: freezePdfPageViewBox(viewport.viewBox),
      }),
      resolvedFrom: "pdfjs_text_layer_dom_range",
    });
    paintSourceHighlights({
      annotationOverlay: record.annotationOverlay,
      anchorTarget,
      rects,
      bounds,
      viewport,
    });
    state.anchorGeometry = anchorGeometry;
    options.onAnchorResolved?.(anchorGeometry, anchorTarget);
    return anchorGeometry;
  };

  const assertLivePageRender = (record, generation, zoomGeneration, scale) => {
    if (
      state.destroyed
      || state.failed
      || record.generation !== generation
      || state.zoomGeneration !== zoomGeneration
      || Math.abs(state.scale - scale) > 0.000001
    ) {
      throw new StalePdfRenderError();
    }
  };

  const renderPage = (record, { announce = false, force = false } = {}) => {
    if (state.destroyed || state.failed || !state.pdfDocument) return Promise.resolve(null);
    const scale = state.scale;
    if (!force && record.renderedScale !== null && Math.abs(record.renderedScale - scale) < 0.000001) {
      return Promise.resolve({ pageNumber: record.pageNumber, viewport: record.viewport, anchor: state.anchorGeometry });
    }
    if (!force && record.renderPromise && Math.abs(record.requestedScale - scale) < 0.000001) {
      return record.renderPromise;
    }

    const previousPromise = record.renderPromise;
    record.generation += 1;
    const generation = record.generation;
    const zoomGeneration = state.zoomGeneration;
    record.requestedScale = scale;
    record.renderTask?.cancel?.();
    record.textLayer?.cancel?.();
    record.renderTask = null;
    record.textLayer = null;
    record.surface.dataset.renderState = "rendering";
    if (record.pageNumber === ATTENTION_SOURCE_ANCHOR.pageNumber) anchorTarget.hidden = true;
    if (announce) {
      viewer.setAttribute("aria-busy", "true");
      emitStatus("rendering", `Rendering continuous page ${record.pageNumber} of ${state.pdfDocument.numPages}…`);
    }

    const promise = (async () => {
      if (previousPromise) {
        try {
          await previousPromise;
        } catch (error) {
          if (!isExpectedCancellation(error)) throw error;
        }
      }
      assertLivePageRender(record, generation, zoomGeneration, scale);
      const viewport = applyPageDimensions(record, scale);
      const devicePixelRatio = clamp(globalThis.devicePixelRatio || 1, 1, MAX_DEVICE_PIXEL_RATIO);
      record.canvas.width = Math.max(1, Math.ceil(viewport.width * devicePixelRatio));
      record.canvas.height = Math.max(1, Math.ceil(viewport.height * devicePixelRatio));
      record.canvas.setAttribute("aria-label", `Rendered page ${record.pageNumber} of ${state.pdfDocument.numPages}`);
      record.textLayerElement.replaceChildren();

      const canvasContext = record.canvas.getContext("2d", { alpha: false });
      if (!canvasContext) {
        throw new PaperPdfError("PDF_CANVAS_UNAVAILABLE", "The browser could not create the PDF canvas context.");
      }
      record.renderTask = record.pdfPage.render({
        canvasContext,
        viewport,
        transform: devicePixelRatio === 1
          ? undefined
          : [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
      });
      await record.renderTask.promise;
      assertLivePageRender(record, generation, zoomGeneration, scale);

      const textContent = await record.pdfPage.getTextContent({ includeMarkedContent: true });
      assertLivePageRender(record, generation, zoomGeneration, scale);
      record.textLayer = new TextLayer({
        textContentSource: textContent,
        container: record.textLayerElement,
        viewport,
      });
      await record.textLayer.render();
      assertLivePageRender(record, generation, zoomGeneration, scale);

      let anchor = state.anchorGeometry;
      if (record.pageNumber === ATTENTION_SOURCE_ANCHOR.pageNumber) {
        anchor = resolveSourceAnchor(record, record.textLayer, viewport);
      }
      record.viewport = viewport;
      record.renderedScale = scale;
      record.surface.dataset.renderState = "ready";
      return { pageNumber: record.pageNumber, viewport, anchor };
    })().catch((error) => {
      if (isExpectedCancellation(error)) return null;
      throw fail(error);
    }).finally(() => {
      if (record.generation === generation) {
        record.renderTask = null;
        record.renderPromise = null;
        if (announce) viewer.setAttribute("aria-busy", "false");
      }
    });
    record.renderPromise = promise;
    return promise;
  };

  const evictPage = (record) => {
    if (
      record.pageNumber === ATTENTION_SOURCE_ANCHOR.pageNumber
      || (record.renderedScale === null && !record.renderPromise && record.canvas.width <= 1)
    ) return;
    record.generation += 1;
    const generation = record.generation;
    const priorPromise = record.renderPromise;
    record.renderTask?.cancel?.();
    record.textLayer?.cancel?.();
    record.renderTask = null;
    record.textLayer = null;
    record.renderPromise = null;
    record.requestedScale = null;
    record.renderedScale = null;
    record.viewport = null;
    record.surface.dataset.renderState = "placeholder";
    Promise.resolve(priorPromise).catch((error) => {
      if (!isExpectedCancellation(error)) throw error;
    }).finally(() => {
      if (record.generation !== generation || record.renderedScale !== null) return;
      record.textLayerElement.replaceChildren();
      record.canvas.width = 1;
      record.canvas.height = 1;
    }).catch((error) => {
      if (!state.failed) fail(error);
    });
  };

  const renderActiveWindow = ({ force = false } = {}) => {
    if (!state.pdfDocument || state.destroyed || state.failed) return Promise.resolve([]);
    const wantedPages = new Set(pageNumbersForRenderWindow(
      state.currentPage,
      state.pdfDocument.numPages,
      renderRadius,
    ));
    for (const record of pageRecords.values()) {
      if (!wantedPages.has(record.pageNumber)) evictPage(record);
    }
    const tasks = [...wantedPages].map((pageNumber) => renderPage(pageRecords.get(pageNumber), { force }));
    return Promise.all(tasks);
  };

  const pageMetrics = () => [...pageRecords.values()].map((record) => ({
    pageNumber: record.pageNumber,
    top: record.surface.offsetTop,
    height: record.surface.offsetHeight,
  }));

  const updateActivePageFromScroll = () => {
    state.scrollFrame = null;
    if (state.destroyed || state.failed || !state.ready) return;
    const nextPage = selectActivePageNumber(pageMetrics(), {
      scrollTop: viewer.scrollTop,
      viewportHeight: viewer.clientHeight,
      fallbackPage: state.currentPage,
    });
    if (nextPage !== state.currentPage) setActivePage(nextPage);
    safelyHandle(renderActiveWindow);
  };

  const scrollToPageRecord = (record, { behavior = "auto", block = "start" } = {}) => {
    const top = calculatePageScrollTop({
      pageTop: record.surface.offsetTop,
      pageHeight: record.surface.offsetHeight,
      scrollTop: viewer.scrollTop,
      viewportHeight: viewer.clientHeight,
      block,
    });
    if (typeof viewer.scrollTo === "function") viewer.scrollTo({ top, left: viewer.scrollLeft, behavior });
    else viewer.scrollTop = top;
    return top;
  };

  const showPage = async (pageNumber, { behavior = "auto", block = "start" } = {}) => {
    if (!state.pdfDocument || state.destroyed || state.failed) return null;
    const nextPage = setActivePage(pageNumber);
    const record = pageRecords.get(nextPage);
    scrollToPageRecord(record, { behavior, block });
    const targetPromise = renderPage(record, { announce: true });
    state.renderPromise = targetPromise;
    safelyHandle(renderActiveWindow);
    const result = await targetPromise;
    viewer.setAttribute("aria-busy", "false");
    emitReadyStatus();
    return result;
  };

  const preserveReadingPosition = (applyDimensions) => {
    const record = pageRecords.get(state.currentPage);
    const oldHeight = Math.max(1, record.surface.offsetHeight);
    const readingLineOffset = viewer.clientHeight * 0.35;
    const oldReadingLine = viewer.scrollTop + readingLineOffset;
    const pageRatio = clamp((oldReadingLine - record.surface.offsetTop) / oldHeight, 0, 1);
    applyDimensions();
    viewer.scrollTop = Math.max(
      0,
      record.surface.offsetTop + (record.surface.offsetHeight * pageRatio) - readingLineOffset,
    );
  };

  const setZoom = async (nextZoom) => {
    if (!state.pdfDocument || state.destroyed || state.failed) return null;
    let nextScale;
    if (nextZoom === "fit-width") {
      state.zoomMode = "fit-width";
      nextScale = calculateFitWidthScale();
    } else {
      const numericZoom = Number(nextZoom);
      if (!Number.isFinite(numericZoom) || numericZoom <= 0) {
        throw new PaperPdfError("PDF_ZOOM_INVALID", "PDF zoom must be a positive number or fit-width.");
      }
      state.zoomMode = "custom";
      nextScale = clamp(numericZoom, minZoom, maxZoom);
    }
    if (Math.abs(nextScale - state.scale) < 0.000001) {
      updateControls();
      return renderPage(pageRecords.get(state.currentPage));
    }

    state.zoomGeneration += 1;
    for (const record of pageRecords.values()) {
      record.generation += 1;
      record.renderTask?.cancel?.();
      record.textLayer?.cancel?.();
      record.renderedScale = null;
    }
    state.scale = nextScale;
    preserveReadingPosition(() => {
      for (const record of pageRecords.values()) applyPageDimensions(record, state.scale);
    });
    updateControls();
    options.onZoomChange?.({ scale: state.scale, mode: state.zoomMode });
    const tasks = renderActiveWindow({ force: true });
    state.renderPromise = pageRecords.get(state.currentPage).renderPromise || Promise.resolve(null);
    await tasks;
    viewer.setAttribute("aria-busy", "false");
    emitReadyStatus();
    return { pageNumber: state.currentPage, scale: state.scale, anchor: state.anchorGeometry };
  };

  const fitWidth = () => setZoom("fit-width");

  const normalizeOverlayRects = (normalizedBounds, normalizedRects) => {
    const candidates = Array.isArray(normalizedRects) && normalizedRects.length > 0
      ? normalizedRects
      : Array.isArray(normalizedBounds)
        ? normalizedBounds
        : [normalizedBounds];
    if (candidates.length === 0 || candidates.some((candidate) => !candidate || typeof candidate !== "object")) {
      throw new PaperPdfError("PDF_ANCHOR_GEOMETRY_INVALID", "An anchor overlay requires normalized page rectangles.");
    }
    return candidates.map((candidate) => {
      const rect = {
        x: Number(candidate.x),
        y: Number(candidate.y),
        width: Number(candidate.width),
        height: Number(candidate.height),
      };
      if (
        Object.values(rect).some((value) => !Number.isFinite(value))
        || rect.x < 0
        || rect.y < 0
        || rect.width <= 0
        || rect.height <= 0
        || rect.x + rect.width > 1.000001
        || rect.y + rect.height > 1.000001
      ) {
        throw new PaperPdfError(
          "PDF_ANCHOR_GEOMETRY_INVALID",
          "Anchor rectangles must be nonempty normalized page coordinates inside [0, 1].",
        );
      }
      return Object.freeze({
        x: rounded(rect.x),
        y: rounded(rect.y),
        width: rounded(rect.width),
        height: rounded(rect.height),
      });
    });
  };

  const resolveStrictPageNumber = ({ pageIndex, pageNumber }) => {
    const resolved = Number.isInteger(pageIndex) ? pageIndex + 1 : Number(pageNumber);
    if (!Number.isInteger(resolved) || resolved < 1 || resolved > state.pdfDocument.numPages) {
      throw new PaperPdfError("PDF_ANCHOR_PAGE_INVALID", "The anchor page is outside the verified PDF.");
    }
    return resolved;
  };

  const stableDomToken = (value) => {
    let hash = 0x811c9dc5;
    for (const character of String(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  const upsertAnchorOverlay = ({
    anchorId,
    pageIndex,
    pageNumber,
    normalizedBounds,
    normalizedRects,
    className = "",
    ariaLabel = "Reader-selected source in the PDF",
  }) => {
    if (!state.pdfDocument || state.destroyed || state.failed) {
      throw new PaperPdfError("PDF_VIEWER_UNAVAILABLE", "The verified PDF viewer is not available.");
    }
    if (typeof anchorId !== "string" || anchorId.length === 0 || anchorId.length > 256) {
      throw new PaperPdfError("PDF_ANCHOR_ID_INVALID", "A nonempty anchor id of at most 256 characters is required.");
    }
    const targetPage = resolveStrictPageNumber({ pageIndex, pageNumber });
    const rects = normalizeOverlayRects(normalizedBounds, normalizedRects);
    const bounds = unionNormalizedRects(rects);
    const classTokens = String(className).split(/\s+/u).filter(Boolean);
    if (classTokens.some((token) => !/^[A-Za-z0-9_-]+$/u.test(token))) {
      throw new PaperPdfError("PDF_ANCHOR_CLASS_INVALID", "Anchor overlay classes may contain only safe CSS class tokens.");
    }
    const record = pageRecords.get(targetPage);
    const pendingSelection = state.pendingSelectionAnchorId
      ? anchorOverlays.get(state.pendingSelectionAnchorId)
      : null;
    const replacesPendingSelection = Boolean(
      pendingSelection
      && pendingSelection.anchorId !== anchorId
      && pendingSelection.pageNumber === targetPage
      && JSON.stringify(pendingSelection.rects) === JSON.stringify(rects),
    );
    if (replacesPendingSelection) {
      pendingSelection.svg?.remove();
      pendingSelection.target?.remove();
      anchorOverlays.delete(pendingSelection.anchorId);
      state.pendingSelectionAnchorId = null;
    }
    const prior = anchorOverlays.get(anchorId);
    if (prior?.builtIn && anchorId === ATTENTION_SOURCE_ANCHOR.anchorId) return prior.target;
    if (prior && prior.pageNumber !== targetPage) {
      prior.svg?.remove();
      prior.target?.remove();
      anchorOverlays.delete(anchorId);
    }

    const current = anchorOverlays.get(anchorId);
    const target = current?.target || document.createElement("div");
    target.id ||= `pdf-anchor-${stableDomToken(anchorId)}`;
    target.className = "pdf-selection-anchor";
    target.classList.add(...classTokens);
    target.dataset.anchorId = anchorId;
    target.dataset.pageNumber = String(targetPage);
    target.tabIndex = -1;
    target.hidden = false;
    target.style.position = "absolute";
    target.style.pointerEvents = "none";
    target.style.border = "2px solid rgba(82, 70, 184, 0.82)";
    target.style.boxShadow = "0 0 0 4px rgba(100, 86, 214, 0.12)";
    target.style.zIndex = "2";
    target.setAttribute("aria-label", ariaLabel);
    setElementPercentBounds(target, bounds);
    if (target.parentElement !== record.annotationOverlay) record.annotationOverlay.append(target);

    const svg = current?.svg || document.createElementNS(SVG_NAMESPACE, "svg");
    svg.dataset.paperpilotAnchorOverlay = anchorId;
    svg.classList.add("pdf-captured-anchor-highlights");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.replaceChildren();
    for (const rect of rects) {
      const shape = document.createElementNS(SVG_NAMESPACE, "rect");
      shape.setAttribute("x", String(rect.x * 100));
      shape.setAttribute("y", String(rect.y * 100));
      shape.setAttribute("width", String(rect.width * 100));
      shape.setAttribute("height", String(rect.height * 100));
      shape.setAttribute("fill", "rgba(100, 86, 214, 0.2)");
      shape.setAttribute("stroke", "rgba(82, 70, 184, 0.86)");
      shape.setAttribute("stroke-width", "0.18");
      shape.setAttribute("vector-effect", "non-scaling-stroke");
      svg.append(shape);
    }
    if (svg.parentElement !== record.annotationOverlay) record.annotationOverlay.prepend(svg);
    anchorOverlays.set(anchorId, {
      anchorId,
      pageNumber: targetPage,
      target,
      svg,
      builtIn: false,
      rects: Object.freeze(rects),
      bounds,
    });
    return target;
  };

  const pageRecordForNode = (node) => {
    if (!node?.isConnected) return null;
    const element = node.nodeType === 1 ? node : node.parentElement;
    const surface = element?.closest?.(".pdf-page-surface");
    if (!surface) return null;
    return [...pageRecords.values()].find((record) => record.surface === surface) || null;
  };

  const captureSelection = async ({
    selection = globalThis.getSelection?.(),
    maxCharacters = maxSelectionCharacters,
    clearSelection = false,
  } = {}) => {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      throw new PaperPdfError("PDF_SELECTION_EMPTY", "Select a nonempty passage inside one rendered PDF page.");
    }
    const range = selection.getRangeAt(0).cloneRange();
    const startRecord = pageRecordForNode(range.startContainer);
    const endRecord = pageRecordForNode(range.endContainer);
    if (!startRecord || !endRecord) {
      range.detach?.();
      throw new PaperPdfError("PDF_SELECTION_DETACHED", "The selection is not attached to a mounted PDF text layer.");
    }
    if (startRecord !== endRecord) {
      range.detach?.();
      throw new PaperPdfError("PDF_SELECTION_CROSS_PAGE", "Select text from one PDF page at a time.");
    }
    const record = startRecord;
    if (
      record.renderedScale === null
      || !record.viewport
      || !record.textLayerElement.contains(range.startContainer)
      || !record.textLayerElement.contains(range.endContainer)
      || !record.textLayerElement.contains(range.commonAncestorContainer)
    ) {
      range.detach?.();
      throw new PaperPdfError("PDF_SELECTION_DETACHED", "The selection must be wholly inside one mounted PDF text layer.");
    }
    const exactText = normalizePdfText(range.toString());
    const safeMaximum = Math.max(1, asPositiveInteger(maxCharacters, maxSelectionCharacters));
    if (!exactText) {
      range.detach?.();
      throw new PaperPdfError("PDF_SELECTION_EMPTY", "The PDF selection contains no readable text.");
    }
    if (exactText.length > safeMaximum) {
      range.detach?.();
      throw new PaperPdfError(
        "PDF_SELECTION_TOO_LARGE",
        `The selection has ${exactText.length} characters; the limit is ${safeMaximum}.`,
      );
    }
    const clientRects = mergeClientRectsByLine(uniqueVisibleClientRects(range));
    const pageRect = record.surface.getBoundingClientRect();
    const rects = normalizeClientRects(clientRects, pageRect);
    const bounds = unionNormalizedRects(rects);
    const pdfQuads = pdfQuadsFromClientRects(clientRects, pageRect, record.viewport);
    const capturedGeneration = record.generation;
    range.detach?.();

    const encodedText = new TextEncoder().encode(exactText);
    const exactTextSha256 = await sha256Hex(encodedText);
    const anchorPayload = JSON.stringify({
      documentSha256: ATTENTION_PDF.sha256,
      pageNumber: record.pageNumber,
      exactText,
      rects,
    });
    const anchorDigest = await sha256Hex(new TextEncoder().encode(anchorPayload));
    if (
      state.destroyed
      || state.failed
      || !record.surface.isConnected
      || record.generation !== capturedGeneration
      || record.renderedScale === null
    ) {
      throw new PaperPdfError("PDF_SELECTION_STALE", "The PDF changed before the selection could be frozen.");
    }
    const anchorId = `anchor:selection:${record.pageNumber}:${anchorDigest.slice(0, 24)}`;
    if (state.pendingSelectionAnchorId && state.pendingSelectionAnchorId !== anchorId) {
      const priorPending = anchorOverlays.get(state.pendingSelectionAnchorId);
      priorPending?.svg?.remove();
      priorPending?.target?.remove();
      anchorOverlays.delete(state.pendingSelectionAnchorId);
    }
    const target = upsertAnchorOverlay({
      anchorId,
      pageNumber: record.pageNumber,
      normalizedRects: rects,
      className: "pdf-human-selection-anchor",
      ariaLabel: `Selected PDF source on page ${record.pageNumber}: ${exactText}`,
    });
    state.pendingSelectionAnchorId = anchorId;
    if (clearSelection) selection.removeAllRanges();
    const pageViewBox = freezePdfPageViewBox(record.viewport.viewBox || record.baseViewport.viewBox);
    return Object.freeze({
      anchorId,
      pageIndex: record.pageIndex,
      pageNumber: record.pageNumber,
      pageLabel: String(record.pageNumber),
      sourceKind: "user_text_selection",
      exactText,
      exactTextSha256,
      documentSha256: ATTENTION_PDF.sha256,
      coordinateSpace: "normalized_page_top_left",
      normalizedBounds: Object.freeze(rects),
      bounds,
      rects: Object.freeze(rects),
      pdfQuads: Object.freeze(pdfQuads),
      pageViewBox,
      pageRotation: record.viewport.rotation,
      viewport: Object.freeze({
        width: rounded(record.viewport.width, 3),
        height: rounded(record.viewport.height, 3),
        scale: rounded(record.viewport.scale, 6),
        rotation: record.viewport.rotation,
        viewBox: pageViewBox,
      }),
      resolvedFrom: "pdfjs_text_layer_user_range",
      pageSurface: record.surface,
      target,
    });
  };

  const getAnchorTarget = (anchorId = ATTENTION_SOURCE_ANCHOR.anchorId) => (
    anchorOverlays.get(anchorId)?.target || null
  );

  const removeAnchorOverlay = (anchorId) => {
    const overlay = anchorOverlays.get(anchorId);
    if (!overlay) return false;
    if (overlay.builtIn) {
      throw new PaperPdfError(
        "PDF_ANCHOR_IMMUTABLE",
        "The verified document source anchor cannot be removed from the viewer.",
      );
    }
    overlay.svg?.remove();
    overlay.target?.remove();
    anchorOverlays.delete(anchorId);
    if (state.pendingSelectionAnchorId === anchorId) state.pendingSelectionAnchorId = null;
    return true;
  };

  const focusAnchor = async (
    anchorIdOrOptions = ATTENTION_SOURCE_ANCHOR.anchorId,
    maybeOptions = {},
  ) => {
    const anchorId = typeof anchorIdOrOptions === "string"
      ? anchorIdOrOptions
      : ATTENTION_SOURCE_ANCHOR.anchorId;
    const focusOptions = typeof anchorIdOrOptions === "string" ? maybeOptions : anchorIdOrOptions;
    const { behavior = "smooth", block = "center", scrollIntoView = true } = focusOptions || {};
    const overlay = anchorOverlays.get(anchorId);
    if (!overlay?.target?.isConnected) {
      throw new PaperPdfError("PDF_SOURCE_UNAVAILABLE", `The PDF anchor ${anchorId} is not materialized.`);
    }
    if (scrollIntoView) {
      await showPage(overlay.pageNumber, { behavior: "auto", block: "nearest" });
      overlay.target.focus({ preventScroll: true });
      overlay.target.scrollIntoView({ behavior, block, inline: "nearest" });
    } else {
      setActivePage(overlay.pageNumber);
      state.renderPromise = renderPage(pageRecords.get(overlay.pageNumber));
      safelyHandle(renderActiveWindow);
      await state.renderPromise;
    }
    return overlay.target;
  };

  const focus = async (focusOptions = {}) => {
    await focusAnchor(ATTENTION_SOURCE_ANCHOR.anchorId, focusOptions);
    if (!state.anchorGeometry || anchorTarget.hidden) {
      throw new PaperPdfError("PDF_SOURCE_UNAVAILABLE", "The exact source anchor is not available on page 1.");
    }
    return state.anchorGeometry;
  };

  const destroy = async () => {
    if (state.destroyed) return;
    state.destroyed = true;
    state.zoomGeneration += 1;
    abortController.abort();
    if (state.resizeFrame !== null) cancelAnimationFrame(state.resizeFrame);
    if (state.scrollFrame !== null) cancelAnimationFrame(state.scrollFrame);
    for (const record of pageRecords.values()) {
      record.generation += 1;
      record.renderTask?.cancel?.();
      record.textLayer?.cancel?.();
    }
    for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
    try {
      await state.loadingTask?.destroy?.();
    } catch {
      // PDF.js can reject a cancelled loading task; the viewer is already closed.
    }
    for (const record of pageRecords.values()) {
      if (record.pageNumber !== 1) record.surface.remove();
    }
    viewer.dataset.pdfState = "destroyed";
    viewer.setAttribute("aria-busy", "false");
  };

  listen(controls.previousPage, "click", () => safelyHandle(() => showPage(state.currentPage - 1)));
  listen(controls.nextPage, "click", () => safelyHandle(() => showPage(state.currentPage + 1)));
  listen(controls.pageNumber, "change", (event) => {
    const pageNumber = event.currentTarget.value;
    safelyHandle(() => showPage(pageNumber));
  });
  listen(controls.pageNumber, "keydown", (event) => {
    if (event.key !== "Enter") return;
    const pageNumber = event.currentTarget.value;
    safelyHandle(() => showPage(pageNumber));
  });
  listen(controls.zoomOut, "click", () => safelyHandle(() => setZoom(state.scale - zoomStep)));
  listen(controls.zoomIn, "click", () => safelyHandle(() => setZoom(state.scale + zoomStep)));
  listen(controls.fitWidth, "click", () => safelyHandle(fitWidth));
  listen(viewer, "scroll", () => {
    if (state.scrollFrame !== null) return;
    state.scrollFrame = requestAnimationFrame(updateActivePageFromScroll);
  }, { passive: true });

  viewer.setAttribute("aria-busy", "true");
  emitStatus("verifying", "Verifying the exact 15-page arXiv PDF…");
  try {
    const response = await fetch(ATTENTION_PDF.localUrl, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/pdf" },
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new PaperPdfError(
        "PDF_FETCH_FAILED",
        `The exact paper is unavailable (${response.status}). Fetch the pinned local PDF before launching the spike.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdfSignature(bytes)) {
      throw new PaperPdfError("PDF_SIGNATURE_MISMATCH", "The local paper asset is not a PDF document.");
    }
    if (bytes.byteLength !== ATTENTION_PDF.byteLength) {
      throw new PaperPdfError(
        "PDF_BYTE_LENGTH_MISMATCH",
        `The local paper has ${bytes.byteLength} bytes; expected ${ATTENTION_PDF.byteLength}.`,
      );
    }
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== ATTENTION_PDF.sha256) {
      throw new PaperPdfError(
        "PDF_SHA256_MISMATCH",
        `The local paper SHA-256 is ${sha256}; expected ${ATTENTION_PDF.sha256}.`,
      );
    }

    state.loadingTask = getDocument({
      data: bytes,
      isEvalSupported: false,
      useWorkerFetch: false,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
      cMapUrl: "/vendor/pdfjs/cmaps/",
      cMapPacked: true,
      wasmUrl: "/vendor/pdfjs/wasm/",
    });
    state.pdfDocument = await state.loadingTask.promise;
    if (state.pdfDocument.numPages !== ATTENTION_PDF.pageCount) {
      throw new PaperPdfError(
        "PDF_PAGE_COUNT_MISMATCH",
        `The local paper has ${state.pdfDocument.numPages} pages; expected ${ATTENTION_PDF.pageCount}.`,
      );
    }
    state.currentPage = clampPdfPageNumber(state.currentPage, state.pdfDocument.numPages);
    const pages = await Promise.all(
      Array.from({ length: state.pdfDocument.numPages }, (_, index) => state.pdfDocument.getPage(index + 1)),
    );
    for (const [index, pdfPage] of pages.entries()) createPageRecord(index + 1, pdfPage);
    if (state.zoomMode === "fit-width") state.scale = calculateFitWidthScale(state.currentPage);
    else {
      const requestedZoom = Number(state.zoomMode);
      state.scale = Number.isFinite(requestedZoom) ? clamp(requestedZoom, minZoom, maxZoom) : 1;
      state.zoomMode = "custom";
    }
    for (const record of pageRecords.values()) applyPageDimensions(record, state.scale);
    state.documentFacts = Object.freeze({
      ...ATTENTION_PDF,
      contentType: response.headers.get("content-type") || "application/pdf",
      pdfjsVersion,
      integrityVerified: true,
      layoutMode: "continuous_virtualized",
    });

    await renderPage(pageRecords.get(ATTENTION_SOURCE_ANCHOR.pageNumber), { announce: true });
    if (!state.anchorGeometry) {
      throw new PaperPdfError(
        "PDF_SOURCE_UNAVAILABLE",
        "The exact page-1 sentence did not resolve before the viewer became ready.",
      );
    }
    if (state.currentPage !== ATTENTION_SOURCE_ANCHOR.pageNumber) {
      await renderPage(pageRecords.get(state.currentPage), { announce: true });
      scrollToPageRecord(pageRecords.get(state.currentPage), { behavior: "auto", block: "start" });
    }
    state.ready = true;
    updateControls();
    notifyPageChange({ force: true });
    options.onZoomChange?.({ scale: state.scale, mode: state.zoomMode });
    viewer.setAttribute("aria-busy", "false");
    emitReadyStatus();
    safelyHandle(renderActiveWindow);

    if (globalThis.ResizeObserver) {
      const resizeObserver = new ResizeObserver(() => {
        if (state.destroyed || state.failed || state.zoomMode !== "fit-width" || !state.pdfDocument) return;
        if (state.resizeFrame !== null) cancelAnimationFrame(state.resizeFrame);
        state.resizeFrame = requestAnimationFrame(() => {
          state.resizeFrame = null;
          safelyHandle(() => setZoom("fit-width"));
        });
      });
      resizeObserver.observe(viewer);
      cleanupCallbacks.push(() => resizeObserver.disconnect());
    }
  } catch (error) {
    if (state.destroyed && error?.name === "AbortError") throw error;
    if (state.failed && error instanceof PaperPdfError) throw error;
    throw fail(error);
  }

  const api = {
    documentFacts: state.documentFacts,
    get exactTextAnchor() {
      return state.anchorGeometry;
    },
    get currentPage() {
      return state.currentPage;
    },
    get scale() {
      return state.scale;
    },
    getAnchorTarget,
    getPageSurface(pageNumber) {
      return pageRecords.get(clampPdfPageNumber(pageNumber, state.pdfDocument.numPages, state.currentPage))?.surface || null;
    },
    getPageAnnotationOverlay(pageNumber) {
      return pageRecords.get(clampPdfPageNumber(pageNumber, state.pdfDocument.numPages, state.currentPage))?.annotationOverlay || null;
    },
    captureSelection,
    createAnchorFromSelection: captureSelection,
    upsertAnchorOverlay,
    removeAnchorOverlay,
    focus,
    focusAnchor,
    showPage,
    setZoom,
    fitWidth,
    destroy,
  };
  options.onReady?.(api);
  return Object.freeze(api);
}
