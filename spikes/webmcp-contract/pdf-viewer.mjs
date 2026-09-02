import {
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  getDocument,
  version as pdfjsVersion,
} from "../vendor/pdfjs/pdf.min.mjs";

const PDFJS_ASSET_URLS = Object.freeze({
  worker: new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href,
  standardFonts: new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).href,
  cmaps: new URL("../vendor/pdfjs/cmaps/", import.meta.url).href,
  wasm: new URL("../vendor/pdfjs/wasm/", import.meta.url).href,
});

GlobalWorkerOptions.workerSrc = PDFJS_ASSET_URLS.worker;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DEFAULT_ZOOM_STEP = 0.15;
const DEFAULT_MIN_ZOOM = 0.25;
const DEFAULT_MAX_ZOOM = 3;
const MAX_DEVICE_PIXEL_RATIO = 2;
const DEFAULT_PAGE_GAP = 24;
const DEFAULT_RENDER_RADIUS = 2;
const DEFAULT_MAX_SELECTION_CHARACTERS = 4_000;
const DEFAULT_MAX_PDF_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PDF_PAGES = 300;

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

/** Fit a PDF page to the scrollport's actual content box. */
export function calculatePdfFitWidthScale({
  clientWidth,
  pageWidth,
  horizontalPadding = 0,
  minZoom = DEFAULT_MIN_ZOOM,
  maxZoom = DEFAULT_MAX_ZOOM,
} = {}) {
  const width = Number(clientWidth);
  const sourceWidth = Number(pageWidth);
  const padding = Number(horizontalPadding);
  const minimum = Number(minZoom);
  const maximum = Number(maxZoom);
  if (
    !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(sourceWidth)
    || sourceWidth <= 0
    || !Number.isFinite(padding)
    || padding < 0
    || !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || minimum <= 0
    || maximum < minimum
  ) {
    throw new PaperPdfError("PDF_FIT_WIDTH_INVALID", "Fit-width geometry requires positive finite dimensions and zoom bounds.");
  }
  return clamp(Math.max(1, width - padding) / sourceWidth, minimum, maximum);
}

function resolveViewerHorizontalPadding(viewer, fallback = 24) {
  try {
    const style = globalThis.getComputedStyle?.(viewer);
    const left = Number.parseFloat(style?.paddingLeft ?? "");
    const right = Number.parseFloat(style?.paddingRight ?? "");
    if (Number.isFinite(left) && left >= 0 && Number.isFinite(right) && right >= 0) return left + right;
  } catch {
    // Non-browser tests and detached surfaces use the conservative fallback.
  }
  return fallback;
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

export function assertPdfPageCountWithinLimit(pageCount, maxPdfPages = DEFAULT_MAX_PDF_PAGES) {
  const count = Number(pageCount);
  const maximum = Number(maxPdfPages);
  if (!Number.isInteger(count) || count < 1) {
    throw new PaperPdfError("PDF_PAGE_COUNT_INVALID", "PDF.js returned an invalid page count.");
  }
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new PaperPdfError("PDF_PAGE_LIMIT_INVALID", "maxPdfPages must be a positive integer.");
  }
  if (count > maximum) {
    throw new PaperPdfError(
      "PDF_PAGE_LIMIT_EXCEEDED",
      `The selected PDF has ${count} pages; the browser-local limit is ${maximum}.`,
    );
  }
  return count;
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

/**
 * Navigation is explicit: presenting a callback marker must not change the
 * reader's active page, mounted neighborhood, scroll position, or keyboard
 * focus. The small target/showPage seam also makes that invariant testable.
 */
export async function focusPdfAnchorTarget({ target, pageNumber, showPage }, {
  behavior = "smooth",
  block = "center",
  scrollIntoView = true,
  moveKeyboardFocus = true,
} = {}) {
  if (scrollIntoView) {
    await showPage(pageNumber, { behavior: "auto", block: "nearest" });
    if (moveKeyboardFocus) target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior, block, inline: "nearest" });
  } else if (moveKeyboardFocus) {
    target.focus({ preventScroll: true });
  }
  return target;
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

function uploadedPdfTitle(filename, explicitTitle) {
  const normalizedTitle = String(explicitTitle || "").replace(/\s+/gu, " ").trim();
  if (normalizedTitle) return normalizedTitle.slice(0, 240);
  const withoutExtension = String(filename || "").replace(/\.pdf$/iu, "");
  const fromFilename = withoutExtension.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  return (fromFilename || "Uploaded scientific paper").slice(0, 240);
}

function uploadedPdfFilename(value) {
  const leaf = String(value || "uploaded-paper.pdf").split(/[\\/]/u).at(-1).trim();
  const normalized = (leaf || "uploaded-paper.pdf").replace(/[\u0000-\u001f\u007f]/gu, "");
  return (normalized.toLowerCase().endsWith(".pdf") ? normalized : `${normalized}.pdf`).slice(0, 255);
}

async function bytesFromPdfInput(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value && typeof value.arrayBuffer === "function") {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new PaperPdfError(
    "PDF_INPUT_INVALID",
    "A PDF File, Blob, ArrayBuffer, or Uint8Array is required for a browser-local document.",
  );
}

/**
 * Read a caller-supplied PDF into a browser-local, digest-addressed source.
 * This helper never uploads or stores the bytes. The returned SHA-256 is an
 * identity computed over the bytes the user selected, not a scientific-truth
 * or publisher-integrity claim.
 */
export async function preparePdfDocumentSource(options = {}) {
  const descriptor = options.documentSource || {};
  const input = descriptor.bytes ?? descriptor.file ?? options.pdfBytes ?? options.pdfFile;
  if (input === undefined || input === null) return null;

  const declaredSize = Number(descriptor.byteLength ?? input?.size);
  const maxBytes = Number.isInteger(options.maxPdfBytes) && options.maxPdfBytes > 0
    ? options.maxPdfBytes
    : DEFAULT_MAX_PDF_BYTES;
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new PaperPdfError(
      "PDF_TOO_LARGE",
      `The selected PDF declares ${declaredSize} bytes; the browser-local limit is ${maxBytes}.`,
    );
  }

  const bytes = await bytesFromPdfInput(input);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new PaperPdfError(
      bytes.byteLength === 0 ? "PDF_EMPTY" : "PDF_TOO_LARGE",
      bytes.byteLength === 0
        ? "The selected PDF is empty."
        : `The selected PDF has ${bytes.byteLength} bytes; the browser-local limit is ${maxBytes}.`,
    );
  }
  if (!isPdfSignature(bytes)) {
    throw new PaperPdfError("PDF_SIGNATURE_MISMATCH", "The selected file does not begin with a PDF signature.");
  }

  const sha256 = await sha256Hex(bytes);
  const expectedSha256 = descriptor.expectedSha256 ?? options.expectedSha256;
  if (expectedSha256 !== undefined && String(expectedSha256).toLowerCase() !== sha256) {
    throw new PaperPdfError(
      "PDF_SHA256_MISMATCH",
      `The selected PDF SHA-256 is ${sha256}; expected ${String(expectedSha256).toLowerCase()}.`,
    );
  }
  const expectedByteLength = descriptor.expectedByteLength ?? options.expectedByteLength;
  if (expectedByteLength !== undefined && Number(expectedByteLength) !== bytes.byteLength) {
    throw new PaperPdfError(
      "PDF_BYTE_LENGTH_MISMATCH",
      `The selected PDF has ${bytes.byteLength} bytes; expected ${Number(expectedByteLength)}.`,
    );
  }

  const filename = uploadedPdfFilename(descriptor.filename ?? options.filename ?? input?.name);
  const contentType = String(descriptor.contentType ?? options.contentType ?? input?.type ?? "application/pdf")
    .trim()
    .slice(0, 120) || "application/pdf";
  const expectedPageCount = descriptor.expectedPageCount ?? options.expectedPageCount;
  if (expectedPageCount !== undefined && (!Number.isInteger(Number(expectedPageCount)) || Number(expectedPageCount) < 1)) {
    throw new PaperPdfError("PDF_PAGE_COUNT_INVALID", "expectedPageCount must be a positive integer when supplied.");
  }

  return Object.freeze({
    bytes,
    filename,
    title: uploadedPdfTitle(filename, descriptor.title ?? options.title),
    contentType,
    sourceUrl: descriptor.sourceUrl ?? options.sourceUrl ?? null,
    sha256,
    byteLength: bytes.byteLength,
    paperRef: `paper:sha256:${sha256}`,
    expectedPageCount: expectedPageCount === undefined ? null : Number(expectedPageCount),
    identityMethod: expectedSha256 === undefined ? "client_computed_sha256" : "expected_sha256_verified",
  });
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

/**
 * Convert one client point into the viewer's scale-independent, top-left
 * normalized page coordinate space. The returned point is always clamped to
 * the visible page, which keeps pointer capture stable when the pointer leaves
 * a page while dragging.
 */
export function normalizeClientPoint(point, pageRect) {
  if (
    !point
    || !pageRect
    || !Number.isFinite(Number(point.clientX))
    || !Number.isFinite(Number(point.clientY))
    || !Number.isFinite(Number(pageRect.left))
    || !Number.isFinite(Number(pageRect.top))
    || !Number.isFinite(Number(pageRect.width))
    || !Number.isFinite(Number(pageRect.height))
    || Number(pageRect.width) <= 0
    || Number(pageRect.height) <= 0
  ) {
    throw new PaperPdfError("PDF_REGION_POINT_INVALID", "The region point could not be mapped to this PDF page.");
  }
  return Object.freeze({
    x: rounded(clamp((Number(point.clientX) - Number(pageRect.left)) / Number(pageRect.width), 0, 1)),
    y: rounded(clamp((Number(point.clientY) - Number(pageRect.top)) / Number(pageRect.height), 0, 1)),
  });
}

/** Build a bounded normalized rectangle from two drag points. */
export function normalizeDraggedRegion(start, end, minimumSize = 0.015) {
  if (!start || !end) {
    throw new PaperPdfError("PDF_REGION_GEOMETRY_INVALID", "A region requires a start and end point.");
  }
  const minimum = clamp(Number(minimumSize) || 0.015, 0.002, 0.25);
  const left = clamp(Math.min(Number(start.x), Number(end.x)), 0, 1);
  const top = clamp(Math.min(Number(start.y), Number(end.y)), 0, 1);
  const rawWidth = Math.abs(Number(end.x) - Number(start.x));
  const rawHeight = Math.abs(Number(end.y) - Number(start.y));
  const width = Math.min(Math.max(rawWidth, minimum), 1 - left);
  const height = Math.min(Math.max(rawHeight, minimum), 1 - top);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new PaperPdfError("PDF_REGION_GEOMETRY_INVALID", "The selected PDF region has invalid geometry.");
  }
  return Object.freeze({
    x: rounded(left),
    y: rounded(top),
    width: rounded(width),
    height: rounded(height),
  });
}

/**
 * Keyboard-equivalent region editing. Arrow keys move the rectangle; holding
 * Shift resizes its trailing edge. Alt selects a smaller step.
 */
export function adjustNormalizedRegion(rect, key, { shiftKey = false, altKey = false } = {}) {
  const current = normalizeDraggedRegion(
    { x: Number(rect?.x), y: Number(rect?.y) },
    { x: Number(rect?.x) + Number(rect?.width), y: Number(rect?.y) + Number(rect?.height) },
    0.002,
  );
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return current;
  const step = altKey ? 0.005 : 0.015;
  let { x, y, width, height } = current;
  if (shiftKey) {
    if (key === "ArrowLeft") width = Math.max(0.015, width - step);
    if (key === "ArrowRight") width = Math.min(1 - x, width + step);
    if (key === "ArrowUp") height = Math.max(0.015, height - step);
    if (key === "ArrowDown") height = Math.min(1 - y, height + step);
  } else {
    if (key === "ArrowLeft") x = Math.max(0, x - step);
    if (key === "ArrowRight") x = Math.min(1 - width, x + step);
    if (key === "ArrowUp") y = Math.max(0, y - step);
    if (key === "ArrowDown") y = Math.min(1 - height, y + step);
  }
  return Object.freeze({ x: rounded(x), y: rounded(y), width: rounded(width), height: rounded(height) });
}

/** Translate one normalized display rectangle to a canonical PDF-space quad. */
export function pdfQuadFromNormalizedRegion(rect, viewport) {
  if (!viewport || typeof viewport.convertToPdfPoint !== "function") {
    throw new PaperPdfError("PDF_REGION_VIEWPORT_INVALID", "The PDF viewport cannot translate region geometry.");
  }
  const normalized = normalizeDraggedRegion(
    { x: Number(rect?.x), y: Number(rect?.y) },
    { x: Number(rect?.x) + Number(rect?.width), y: Number(rect?.y) + Number(rect?.height) },
    0.002,
  );
  const left = normalized.x * Number(viewport.width);
  const top = normalized.y * Number(viewport.height);
  const right = (normalized.x + normalized.width) * Number(viewport.width);
  const bottom = (normalized.y + normalized.height) * Number(viewport.height);
  const points = [
    viewport.convertToPdfPoint(left, top),
    viewport.convertToPdfPoint(right, top),
    viewport.convertToPdfPoint(right, bottom),
    viewport.convertToPdfPoint(left, bottom),
  ].map(([x, y]) => Object.freeze({ x: rounded(x, 3), y: rounded(y, 3) }));
  return Object.freeze(points);
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

function normalizeViewportRectangle(viewport, pdfRectangle) {
  if (
    !viewport
    || !Number.isFinite(Number(viewport.width))
    || !Number.isFinite(Number(viewport.height))
    || Number(viewport.width) <= 0
    || Number(viewport.height) <= 0
  ) {
    return null;
  }
  let convertedPoints;
  if (typeof viewport.convertToViewportRectangle === "function") {
    const converted = viewport.convertToViewportRectangle(pdfRectangle).map(Number);
    convertedPoints = [[converted[0], converted[1]], [converted[2], converted[3]]];
  } else if (Array.isArray(viewport.transform) && viewport.transform.length >= 6) {
    const [a, b, c, d, e, f] = viewport.transform.map(Number);
    if ([a, b, c, d, e, f].some((value) => !Number.isFinite(value))) return null;
    const applyTransform = (x, y) => [a * x + c * y + e, b * x + d * y + f];
    const [x1, y1, x2, y2] = pdfRectangle.map(Number);
    convertedPoints = [
      applyTransform(x1, y1),
      applyTransform(x1, y2),
      applyTransform(x2, y1),
      applyTransform(x2, y2),
    ];
  } else {
    return null;
  }
  if (convertedPoints.flat().some((value) => !Number.isFinite(value))) return null;
  const left = clamp(Math.min(...convertedPoints.map(([x]) => x)), 0, viewport.width);
  const top = clamp(Math.min(...convertedPoints.map(([, y]) => y)), 0, viewport.height);
  const right = clamp(Math.max(...convertedPoints.map(([x]) => x)), 0, viewport.width);
  const bottom = clamp(Math.max(...convertedPoints.map(([, y]) => y)), 0, viewport.height);
  if (right <= left || bottom <= top) return null;
  return Object.freeze({
    x: rounded(left / viewport.width),
    y: rounded(top / viewport.height),
    width: rounded((right - left) / viewport.width),
    height: rounded((bottom - top) / viewport.height),
  });
}

function pdfTextItemNormalizedBounds(item, viewport) {
  if (!item || typeof item !== "object" || !Array.isArray(item.transform)) return null;
  const transform = item.transform.map(Number);
  if (transform.length < 6 || transform.some((value) => !Number.isFinite(value))) return null;
  const width = Number(item.width);
  const declaredHeight = Number(item.height);
  const transformHeight = Math.hypot(transform[2], transform[3]) || Math.hypot(transform[0], transform[1]);
  const height = Number.isFinite(declaredHeight) && declaredHeight > 0 ? declaredHeight : transformHeight;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  const x = transform[4];
  const baselineY = transform[5];
  return normalizeViewportRectangle(viewport, [x, baselineY, x + width, baselineY + height]);
}

function pdfTextItemFlow(item, viewport) {
  if (!item || typeof item !== "object" || !Array.isArray(item.transform)) return null;
  const transform = item.transform.map(Number);
  const width = Number(item.width);
  if (transform.length < 6 || transform.some((value) => !Number.isFinite(value)) || !Number.isFinite(width) || width <= 0) {
    return null;
  }
  const viewportPoint = (x, y) => {
    if (typeof viewport?.convertToViewportPoint === "function") {
      return viewport.convertToViewportPoint(x, y).map(Number);
    }
    if (!Array.isArray(viewport?.transform) || viewport.transform.length < 6) return null;
    const [a, b, c, d, e, f] = viewport.transform.map(Number);
    if ([a, b, c, d, e, f].some((value) => !Number.isFinite(value))) return null;
    return [a * x + c * y + e, b * x + d * y + f];
  };
  const start = viewportPoint(transform[4], transform[5]);
  const end = viewportPoint(transform[4] + width, transform[5]);
  if (!start || !end || [...start, ...end].some((value) => !Number.isFinite(value))) return null;
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const axis = Math.abs(deltaY) > Math.abs(deltaX) ? "vertical" : "horizontal";
  const baselineReversed = axis === "vertical" ? deltaY < 0 : deltaX < 0;
  return Object.freeze({
    axis,
    reversed: item.dir === "rtl" ? !baselineReversed : baselineReversed,
  });
}

function shouldStartNewTextLine(currentLine, itemBounds) {
  if (!currentLine || !itemBounds || currentLine.rects.length === 0) return false;
  const currentBounds = unionNormalizedRects(currentLine.rects);
  const currentCenter = currentBounds.y + (currentBounds.height / 2);
  const itemCenter = itemBounds.y + (itemBounds.height / 2);
  return Math.abs(currentCenter - itemCenter) > Math.max(currentBounds.height, itemBounds.height) * 0.62;
}

function shouldInsertItemSpace(currentLine, itemText, itemBounds) {
  if (!currentLine || currentLine.parts.length === 0) return false;
  const previousText = currentLine.parts.at(-1)?.text || "";
  if (/\s$/u.test(previousText) || /^\s/u.test(itemText)) return false;
  const previousBounds = currentLine.parts.at(-1)?.bounds;
  if (!previousBounds || !itemBounds) return true;
  const gap = itemBounds.x - (previousBounds.x + previousBounds.width);
  return gap > Math.max(0.0015, Math.min(previousBounds.height, itemBounds.height) * 0.12);
}

function normalizedLineParts(parts) {
  let text = "";
  let separatorPending = false;
  const segments = [];
  for (const part of parts) {
    if (part.syntheticSpace) {
      if (text) separatorPending = true;
      continue;
    }
    const normalized = normalizePdfText(part.text);
    if (!normalized) {
      if (/\s/u.test(part.text) && text) separatorPending = true;
      continue;
    }
    if (text && (separatorPending || /^\s/u.test(part.text))) text += " ";
    separatorPending = /\s$/u.test(part.text);
    const startOffset = text.length;
    text += normalized;
    const endOffset = text.length;
    if (part.bounds) {
      segments.push({
        startOffset,
        endOffset,
        normalizedBounds: part.bounds,
        sourceItemIndex: part.sourceItemIndex,
        direction: part.direction === "rtl" ? "rtl" : "ltr",
        textAxis: part.textAxis === "vertical" ? "vertical" : "horizontal",
        flowReversed: typeof part.flowReversed === "boolean"
          ? part.flowReversed
          : part.direction === "rtl",
      });
    }
  }
  return { text, segments };
}

function normalizedTextOffsetMap(value) {
  const characters = [];
  const positions = [];
  let pendingWhitespaceStart = null;
  let pendingWhitespaceEnd = null;
  const flushWhitespace = () => {
    if (characters.length === 0 || pendingWhitespaceStart === null) {
      pendingWhitespaceStart = null;
      pendingWhitespaceEnd = null;
      return;
    }
    characters.push(" ");
    positions.push({ startOffset: pendingWhitespaceStart, endOffset: pendingWhitespaceEnd });
    pendingWhitespaceStart = null;
    pendingWhitespaceEnd = null;
  };
  const source = String(value ?? "");
  for (let offset = 0; offset < source.length;) {
    const character = String.fromCodePoint(source.codePointAt(offset));
    const nextOffset = offset + character.length;
    if (/\s/u.test(character)) {
      if (pendingWhitespaceStart === null) pendingWhitespaceStart = offset;
      pendingWhitespaceEnd = nextOffset;
      offset = nextOffset;
      continue;
    }
    flushWhitespace();
    for (const normalizedCharacter of character.normalize("NFKC")) {
      characters.push(normalizedCharacter);
      positions.push({ startOffset: offset, endOffset: nextOffset });
    }
    offset = nextOffset;
  }
  return { text: characters.join(""), positions };
}

function clippedSegmentRectangle(segment, startOffset, endOffset) {
  const segmentLength = segment.endOffset - segment.startOffset;
  if (segmentLength <= 0) return null;
  const localStart = clamp((startOffset - segment.startOffset) / segmentLength, 0, 1);
  const localEnd = clamp((endOffset - segment.startOffset) / segmentLength, 0, 1);
  if (localEnd <= localStart) return null;
  const bounds = segment.normalizedBounds;
  const reversed = typeof segment.flowReversed === "boolean"
    ? segment.flowReversed
    : segment.direction === "rtl";
  const startFraction = reversed ? 1 - localEnd : localStart;
  if (segment.textAxis === "vertical") {
    return Object.freeze({
      x: bounds.x,
      y: rounded(bounds.y + (bounds.height * startFraction)),
      width: bounds.width,
      height: rounded(bounds.height * (localEnd - localStart)),
    });
  }
  return Object.freeze({
    x: rounded(bounds.x + (bounds.width * startFraction)),
    y: bounds.y,
    width: rounded(bounds.width * (localEnd - localStart)),
    height: bounds.height,
  });
}

/**
 * Project a page-text offset range onto PDF.js item geometry without widening
 * the evidence to entire source lines. When `exactText` is supplied, newline
 * and whitespace normalization are reconciled back to the page's raw offsets.
 */
export function resolvePdfTextRangeGeometry(pageRecord, locator = {}) {
  if (!pageRecord || typeof pageRecord.text !== "string" || !Array.isArray(pageRecord.lines)) return null;
  let startOffset = Number(locator.startOffset);
  let endOffset = Number(locator.endOffset);
  const exactText = normalizePdfText(locator.exactText || "");
  let matchMethod = "issued_offsets";
  const directValid = Number.isInteger(startOffset)
    && Number.isInteger(endOffset)
    && startOffset >= 0
    && endOffset > startOffset
    && endOffset <= pageRecord.text.length
    && (!exactText || normalizePdfText(pageRecord.text.slice(startOffset, endOffset)) === exactText);

  if (!directValid) {
    if (!exactText) return null;
    const normalizedPage = normalizedTextOffsetMap(pageRecord.text);
    const matches = [];
    let cursor = 0;
    while (cursor <= normalizedPage.text.length - exactText.length) {
      const match = normalizedPage.text.indexOf(exactText, cursor);
      if (match < 0) break;
      matches.push(match);
      cursor = match + Math.max(1, exactText.length);
    }
    if (matches.length !== 1) return null;
    const first = normalizedPage.positions[matches[0]];
    const last = normalizedPage.positions[matches[0] + exactText.length - 1];
    if (!first || !last) return null;
    startOffset = first.startOffset;
    endOffset = last.endOffset;
    matchMethod = "unique_normalized_exact_text";
  }

  const rects = [];
  let coveredCharacters = 0;
  for (const line of pageRecord.lines) {
    for (const segment of line.segments || []) {
      const selectedStart = Math.max(startOffset, segment.startOffset);
      const selectedEnd = Math.min(endOffset, segment.endOffset);
      if (selectedEnd <= selectedStart) continue;
      const rect = clippedSegmentRectangle(segment, selectedStart, selectedEnd);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      rects.push(rect);
      coveredCharacters += pageRecord.text.slice(selectedStart, selectedEnd).replace(/\s/gu, "").length;
    }
  }
  if (rects.length === 0) return null;
  const requestedCharacters = pageRecord.text.slice(startOffset, endOffset).replace(/\s/gu, "").length;
  return Object.freeze({
    startOffset,
    endOffset,
    exactText: exactText || normalizePdfText(pageRecord.text.slice(startOffset, endOffset)),
    matchMethod,
    geometryMethod: "pdfjs_item_proportional_text_range",
    geometryCoverage: requestedCharacters > 0 ? rounded(Math.min(1, coveredCharacters / requestedCharacters), 4) : 1,
    normalizedBounds: Object.freeze(rects),
  });
}

/**
 * Convert one PDF.js text-content payload into a bounded, serializable page
 * record. The record is page-owned parsing input: it is never rendered as a
 * transcript and it preserves only line text plus normalized source geometry.
 */
export function buildPdfPageTextRecord({
  pageIndex,
  pageLabel = String(Number(pageIndex) + 1),
  textItems,
  viewport,
  pageViewBox = viewport?.viewBox,
  pageRotation = viewport?.rotation ?? 0,
} = {}) {
  const safePageIndex = Number(pageIndex);
  if (!Number.isInteger(safePageIndex) || safePageIndex < 0) {
    throw new PaperPdfError("PDF_TEXT_INDEX_INVALID", "A nonnegative PDF page index is required.");
  }
  if (!Array.isArray(textItems)) {
    throw new PaperPdfError("PDF_TEXT_INDEX_INVALID", "PDF text items must be an array.");
  }
  const frozenViewBox = freezePdfPageViewBox(pageViewBox);
  const lines = [];
  let currentLine = null;
  let pageTextCursor = 0;

  const flushLine = () => {
    if (!currentLine) return;
    const normalizedLine = normalizedLineParts(currentLine.parts);
    const { text } = normalizedLine;
    if (text) {
      const normalizedBounds = currentLine.rects.length > 0
        ? Object.freeze(currentLine.rects.map((rectangle) => Object.freeze({ ...rectangle })))
        : Object.freeze([{ x: 0, y: 0, width: 1, height: 1 }]);
      const lineStartOffset = pageTextCursor;
      const lineEndOffset = lineStartOffset + text.length;
      const segments = normalizedLine.segments.map((segment) => Object.freeze({
        ...segment,
        startOffset: lineStartOffset + segment.startOffset,
        endOffset: lineStartOffset + segment.endOffset,
      }));
      lines.push(Object.freeze({
        lineIndex: lines.length,
        lineId: `page:${safePageIndex + 1}:line:${lines.length + 1}`,
        text,
        startOffset: lineStartOffset,
        endOffset: lineEndOffset,
        segments: Object.freeze(segments),
        normalizedBounds,
        bounds: currentLine.rects.length > 0
          ? unionNormalizedRects(currentLine.rects)
          : Object.freeze({ x: 0, y: 0, width: 1, height: 1 }),
        sourceItemStart: currentLine.sourceItemStart,
        sourceItemEnd: currentLine.sourceItemEnd,
        fontHeight: rounded(currentLine.fontHeight),
      }));
      pageTextCursor = lineEndOffset + 1;
    }
    currentLine = null;
  };

  for (const [sourceItemIndex, item] of textItems.entries()) {
    if (!item || typeof item !== "object" || typeof item.str !== "string") continue;
    const itemText = item.str.normalize("NFKC");
    const itemBounds = pdfTextItemNormalizedBounds(item, viewport);
    const itemFlow = pdfTextItemFlow(item, viewport);
    if (currentLine && shouldStartNewTextLine(currentLine, itemBounds)) flushLine();
    if (!currentLine) {
      currentLine = {
        parts: [],
        rects: [],
        sourceItemStart: sourceItemIndex,
        sourceItemEnd: sourceItemIndex,
        fontHeight: 0,
      };
    }
    if (itemText) {
      if (shouldInsertItemSpace(currentLine, itemText, itemBounds)) {
        currentLine.parts.push({ text: " ", bounds: null, syntheticSpace: true });
      }
      currentLine.parts.push({
        text: itemText,
        bounds: itemBounds,
        sourceItemIndex,
        direction: item.dir,
        textAxis: itemFlow?.axis,
        flowReversed: itemFlow?.reversed,
        syntheticSpace: false,
      });
    }
    if (itemBounds) currentLine.rects.push(itemBounds);
    currentLine.sourceItemEnd = sourceItemIndex;
    const itemHeight = Number(item.height) || Math.hypot(Number(item.transform?.[2]) || 0, Number(item.transform?.[3]) || 0);
    if (Number.isFinite(itemHeight)) currentLine.fontHeight = Math.max(currentLine.fontHeight, itemHeight);
    if (item.hasEOL === true) flushLine();
  }
  flushLine();

  const text = lines.map((line) => line.text).join("\n");
  return Object.freeze({
    pageIndex: safePageIndex,
    pageLabel: String(pageLabel),
    pageViewBox: frozenViewBox,
    pageRotation: Number(pageRotation) || 0,
    textCapability: text ? "exact_candidate" : "visual_only",
    text,
    lines: Object.freeze(lines),
  });
}

function freezeOutlineResult(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeOutlineResult(child);
  return Object.freeze(value);
}

function boundedOutlineTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Resolve PDF outline destinations with public PDF.js APIs. Outline failures
 * never block reading: callers receive an honest empty/partial result and the
 * structural mapper can fall back to inferred headings or page ranges.
 *
 * @param {{
 *   numPages?: number,
 *   getOutline?: () => Promise<unknown>,
 *   getDestination?: (name: string) => Promise<unknown>,
 *   getPageIndex?: (reference: unknown) => Promise<number>,
 * }} pdfDocument
 */
export async function resolvePdfOutline(pdfDocument) {
  const pageCount = Number(pdfDocument?.numPages);
  if (!Number.isInteger(pageCount) || pageCount < 1 || typeof pdfDocument?.getOutline !== "function") {
    return freezeOutlineResult({
      status: "unavailable",
      itemCount: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      entries: [],
    });
  }

  let outline;
  try {
    outline = await pdfDocument.getOutline();
  } catch (error) {
    return freezeOutlineResult({
      status: "failed",
      itemCount: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      limitation: error?.name || "outline_read_failed",
      entries: [],
    });
  }
  if (!Array.isArray(outline) || outline.length === 0) {
    return freezeOutlineResult({
      status: "absent",
      itemCount: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      entries: [],
    });
  }

  const flat = [];
  const visit = (items, depth) => {
    for (const item of items || []) {
      if (!item || typeof item !== "object" || flat.length >= 512) continue;
      flat.push({ item, depth, order: flat.length });
      if (Array.isArray(item.items) && depth < 12) visit(item.items, depth + 1);
    }
  };
  visit(outline, 0);

  const entries = [];
  let unresolvedCount = 0;
  for (const { item, depth, order } of flat) {
    const title = boundedOutlineTitle(item.title);
    if (!title || item.dest === undefined || item.dest === null) {
      unresolvedCount += 1;
      continue;
    }
    try {
      let destination = item.dest;
      if (typeof destination === "string") {
        if (typeof pdfDocument.getDestination !== "function") throw new Error("Named destination resolution is unavailable.");
        destination = await pdfDocument.getDestination(destination);
      }
      if (!Array.isArray(destination) || destination.length === 0) throw new Error("Outline destination is malformed.");
      const pageReference = destination[0];
      const pageIndex = Number.isInteger(pageReference)
        ? Number(pageReference)
        : typeof pdfDocument.getPageIndex === "function"
          ? Number(await pdfDocument.getPageIndex(pageReference))
          : Number.NaN;
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
        throw new Error("Outline destination is outside the active PDF.");
      }
      entries.push({ title, pageIndex, depth, order });
    } catch {
      unresolvedCount += 1;
    }
  }

  return freezeOutlineResult({
    status: entries.length === 0 ? "failed" : unresolvedCount > 0 ? "partial" : "resolved",
    itemCount: flat.length,
    resolvedCount: entries.length,
    unresolvedCount,
    entries,
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

function paintSourceHighlights({ annotationOverlay, anchorTarget, sourceAnchor, rects, bounds, viewport }) {
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
  anchorTarget.dataset.pageNumber = String(sourceAnchor.pageNumber);
  anchorTarget.dataset.anchorId = sourceAnchor.anchorId;
}

function createSourceAnchorTarget(annotationOverlay, sourceAnchor) {
  const focusParent = annotationOverlay.parentElement || annotationOverlay;
  let anchorTarget = focusParent.querySelector("#text-source") || document.getElementById("text-source");
  if (anchorTarget && anchorTarget.parentElement !== focusParent) focusParent.append(anchorTarget);
  if (!anchorTarget) {
    anchorTarget = document.createElement("div");
    anchorTarget.id = "text-source";
    focusParent.append(anchorTarget);
  }
  anchorTarget.classList.add("pdf-source-anchor", "active");
  anchorTarget.tabIndex = -1;
  anchorTarget.hidden = true;
  anchorTarget.style.position = "absolute";
  anchorTarget.style.zIndex = "5";
  anchorTarget.setAttribute(
    "aria-label",
    `Exact source on page ${sourceAnchor.pageNumber}: ${sourceAnchor.exactText}`,
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
    || error?.name === "AbortException"
    || error?.name === "AbortError";
}

/**
 * Canvas pixels are mandatory; selectable text is an optional enhancement.
 * Narrow catches deliberately exclude canvas and stale-generation failures.
 * No fallback manufactures text or resolves a required exact source.
 */
export async function renderPdfPageLayers({
  renderCanvas,
  loadTextContent,
  renderTextLayer,
  assertCurrent,
  requiresExactSource = false,
}) {
  await renderCanvas();
  assertCurrent();
  const unavailable = (limitation) => Object.freeze({
    textLayer: null,
    textCapability: "visual_only",
    limitation,
  });
  let textContent;
  try {
    textContent = await loadTextContent();
  } catch (error) {
    assertCurrent();
    if (requiresExactSource || isExpectedCancellation(error)) throw error;
    return unavailable("text_extraction_failed");
  }
  assertCurrent();
  if (!Array.isArray(textContent?.items) || !textContent.items.some((item) => typeof item?.str === "string" && item.str.trim().length > 0)) {
    if (requiresExactSource) {
      throw new PaperPdfError("PDF_SOURCE_UNAVAILABLE", "The required exact source has no usable embedded PDF text.");
    }
    return unavailable("no_embedded_text");
  }
  let textLayer;
  try {
    textLayer = await renderTextLayer(textContent);
  } catch (error) {
    assertCurrent();
    if (requiresExactSource || isExpectedCancellation(error)) throw error;
    return unavailable("text_layer_failed");
  }
  assertCurrent();
  return Object.freeze({ textLayer, textCapability: "exact_candidate", limitation: null });
}

export function describePdfTextLimitation(pageNumber, limitation) {
  if (limitation === "text_extraction_failed") {
    return `Page ${pageNumber} is visible, but embedded text could not be extracted. Use a page or figure region.`;
  }
  if (limitation === "text_layer_failed") {
    return `Page ${pageNumber} is visible, but selectable text could not be displayed. Use a page or figure region.`;
  }
  if (limitation === "no_embedded_text") {
    return `Page ${pageNumber} has no usable embedded text. Use a page or figure region.`;
  }
  return "";
}

/**
 * Initialize an identity-addressed PDF.js surface as a continuous vertical document.
 * All page shells participate in scroll layout. Page 1 and a small window around
 * the active page retain their canvas/text layers; distant pages are lightweight
 * placeholders with stable dimensions and page-owned annotation overlays.
 *
 * @param {object} options
 * @returns {Promise<object>} continuous viewer, navigation, selection, anchor,
 *   zoom, and lifecycle APIs.
 */
export async function initializePaperPdfViewer(options = {}) {
  const suppliedDocument = await preparePdfDocumentSource(options);
  const fixedSourceAnchor = options.sourceAnchor === undefined
    ? suppliedDocument
      ? null
      : ATTENTION_SOURCE_ANCHOR
    : options.sourceAnchor;
  if (fixedSourceAnchor !== null && fixedSourceAnchor !== undefined) {
    if (
      typeof fixedSourceAnchor !== "object"
      || typeof fixedSourceAnchor.anchorId !== "string"
      || !Number.isInteger(fixedSourceAnchor.pageNumber)
      || fixedSourceAnchor.pageNumber < 1
      || typeof fixedSourceAnchor.exactText !== "string"
      || fixedSourceAnchor.exactText.trim().length === 0
    ) {
      throw new PaperPdfError(
        "PDF_SOURCE_ANCHOR_INVALID",
        "A fixed source anchor requires an id, positive page number, and nonempty exact text.",
      );
    }
  }
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
  const anchorTarget = fixedSourceAnchor
    ? createSourceAnchorTarget(initialAnnotationOverlay, fixedSourceAnchor)
    : null;
  if (fixedSourceAnchor) {
    anchorOverlays.set(fixedSourceAnchor.anchorId, {
      anchorId: fixedSourceAnchor.anchorId,
      pageNumber: fixedSourceAnchor.pageNumber,
      target: anchorTarget,
      svg: null,
      builtIn: true,
    });
  }

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
    documentTextIndex: null,
    documentTextPromise: null,
    regionSelection: null,
  };
  const minZoom = Number.isFinite(options.minZoom) ? options.minZoom : DEFAULT_MIN_ZOOM;
  const maxZoom = Number.isFinite(options.maxZoom) ? options.maxZoom : DEFAULT_MAX_ZOOM;
  const zoomStep = Number.isFinite(options.zoomStep) ? options.zoomStep : DEFAULT_ZOOM_STEP;
  const horizontalPadding = Number.isFinite(options.horizontalPadding)
    ? Math.max(0, Number(options.horizontalPadding))
    : null;
  const pageGap = Number.isFinite(options.pageGap) ? Math.max(0, options.pageGap) : DEFAULT_PAGE_GAP;
  const renderRadius = Number.isInteger(options.renderRadius)
    ? Math.max(0, options.renderRadius)
    : DEFAULT_RENDER_RADIUS;
  const maxSelectionCharacters = Number.isInteger(options.maxSelectionCharacters)
    ? Math.max(1, options.maxSelectionCharacters)
    : DEFAULT_MAX_SELECTION_CHARACTERS;
  const maxPdfPages = Number.isInteger(options.maxPdfPages) && options.maxPdfPages > 0
    ? options.maxPdfPages
    : DEFAULT_MAX_PDF_PAGES;

  const emitStatus = (kind, message, details = {}) => {
    viewer.dataset.pdfState = kind;
    if (controls.status) controls.status.textContent = message;
    options.onStatus?.({ kind, message, ...details });
  };

  const fail = (error) => {
    const wrapped = error instanceof PaperPdfError
      ? error
      : new PaperPdfError("PDF_VIEWER_FAILED", error?.message || "The selected paper could not be rendered.", { cause: error });
    const alreadyFailed = state.failed;
    state.failed = true;
    viewer.dataset.pdfState = "error";
    viewer.setAttribute("aria-busy", "false");
    if (anchorTarget) anchorTarget.hidden = true;
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
    const pageCount = state.pdfDocument?.numPages || suppliedDocument?.expectedPageCount || ATTENTION_PDF.pageCount;
    surface.style.marginBlockEnd = pageNumber === pageCount ? "0" : `${pageGap}px`;
    surface.style.flex = "0 0 auto";
    surface.setAttribute("aria-label", `PDF page ${pageNumber} of ${pageCount}`);

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
    const textLimitationElement = document.createElement("p");
    textLimitationElement.id = `${DEFAULT_PDF_VIEWER_IDS.surface}-${pageNumber}-text-limitation`;
    textLimitationElement.className = "pdf-page-text-limitation";
    textLimitationElement.setAttribute("role", "note");
    textLimitationElement.hidden = true;
    Object.assign(textLimitationElement.style, {
      position: "absolute", insetInline: "0.5rem", bottom: "0.35rem",
      margin: "0", padding: "0.4rem 0.55rem", zIndex: "6",
      background: "rgba(255, 248, 225, 0.96)", color: "#493817",
      border: "1px solid #b89c59", borderRadius: "0.3rem", fontSize: "0.75rem",
      lineHeight: "1.4", pointerEvents: "none",
    });
    surface.append(textLimitationElement);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const record = {
      pageNumber,
      pageIndex: pageNumber - 1,
      pdfPage,
      baseViewport,
      surface,
      canvas,
      textLayerElement,
      textLimitationElement,
      textCapability: null,
      textLimitation: null,
      annotationOverlay,
      renderTask: null,
      textLayer: null,
      viewport: null,
      renderedScale: null,
      requestedScale: null,
      generation: 0,
      renderPromise: null,
      textContentPromise: null,
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
    const pageCount = state.pdfDocument?.numPages || suppliedDocument?.expectedPageCount || ATTENTION_PDF.pageCount;
    for (const record of pageRecords.values()) {
      record.surface.setAttribute("aria-label", `PDF page ${record.pageNumber} of ${pageCount}`);
    }
  };

  const updateControls = () => {
    const pageCount = state.pdfDocument?.numPages || suppliedDocument?.expectedPageCount || ATTENTION_PDF.pageCount;
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
    const textLimitation = pageRecords.get(state.currentPage)?.textLimitation;
    const limitationMessage = describePdfTextLimitation(state.currentPage, textLimitation);
    emitStatus(
      "ready",
      `PDF identity ready · continuous page ${state.currentPage} of ${state.pdfDocument.numPages} · ${Math.round(state.scale * 100)}%${limitationMessage ? ` · ${limitationMessage}` : ""}`,
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
    return calculatePdfFitWidthScale({
      clientWidth: viewer.clientWidth,
      pageWidth: record.baseViewport.width,
      horizontalPadding: horizontalPadding ?? resolveViewerHorizontalPadding(viewer),
      minZoom,
      maxZoom,
    });
  };

  const resolveSourceAnchor = (record, textLayer, viewport) => {
    if (!fixedSourceAnchor) return null;
    const chunks = collectPdfTextNodes(textLayer.textDivs);
    const characterMap = buildNormalizedCharacterMap(chunks);
    const match = findUniqueNormalizedMatch(characterMap.text, fixedSourceAnchor.exactText);
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
      ...fixedSourceAnchor,
      pageIndex: fixedSourceAnchor.pageIndex ?? fixedSourceAnchor.pageNumber - 1,
      pageLabel: fixedSourceAnchor.pageLabel ?? String(fixedSourceAnchor.pageNumber),
      documentSha256: state.documentFacts.sha256,
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
      sourceAnchor: fixedSourceAnchor,
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

  const loadPageTextContent = (record) => {
    if (record.textContentPromise) return record.textContentPromise;
    record.textContentPromise = record.pdfPage
      .getTextContent({ includeMarkedContent: true })
      .catch((error) => {
        record.textContentPromise = null;
        throw error;
      });
    return record.textContentPromise;
  };

  const updatePageTextAvailability = (record, { textCapability, limitation }) => {
    record.textCapability = textCapability;
    record.textLimitation = limitation;
    record.surface.dataset.textCapability = textCapability;
    record.surface.dataset.textLayerState = limitation ? "unavailable" : "ready";
    const notice = record.textLimitationElement;
    notice.textContent = describePdfTextLimitation(record.pageNumber, limitation);
    notice.hidden = !limitation;
    const descriptions = (record.surface.getAttribute("aria-describedby") || "").split(/\s+/u).filter(Boolean);
    const withoutNotice = descriptions.filter((id) => id !== notice.id);
    if (limitation) withoutNotice.push(notice.id);
    if (withoutNotice.length) record.surface.setAttribute("aria-describedby", withoutNotice.join(" "));
    else record.surface.removeAttribute("aria-describedby");
    if (limitation) record.textLayerElement.setAttribute("aria-hidden", "true");
    else record.textLayerElement.removeAttribute("aria-hidden");
  };

  const renderPage = (record, { announce = false, force = false } = {}) => {
    if (state.destroyed || state.failed || !state.pdfDocument) return Promise.resolve(null);
    const scale = state.scale;
    if (!force && record.renderedScale !== null && Math.abs(record.renderedScale - scale) < 0.000001) {
      return Promise.resolve({ pageNumber: record.pageNumber, viewport: record.viewport, anchor: state.anchorGeometry, textCapability: record.textCapability, limitation: record.textLimitation });
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
    if (fixedSourceAnchor && record.pageNumber === fixedSourceAnchor.pageNumber) anchorTarget.hidden = true;
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
      const textOutcome = await renderPdfPageLayers({
        requiresExactSource: Boolean(fixedSourceAnchor && record.pageNumber === fixedSourceAnchor.pageNumber),
        assertCurrent: () => assertLivePageRender(record, generation, zoomGeneration, scale),
        async renderCanvas() {
          record.renderTask = record.pdfPage.render({
            canvasContext,
            viewport,
            transform: devicePixelRatio === 1
              ? undefined
              : [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
          });
          await record.renderTask.promise;
        },
        loadTextContent: () => loadPageTextContent(record),
        async renderTextLayer(textContent) {
          record.textLayer = new TextLayer({
            textContentSource: textContent,
            container: record.textLayerElement,
            viewport,
          });
          await record.textLayer.render();
          return record.textLayer;
        },
      });
      assertLivePageRender(record, generation, zoomGeneration, scale);
      if (textOutcome.limitation) {
        try { record.textLayer?.cancel?.(); } catch { /* Optional text-layer cleanup must not discard the rendered page. */ }
        record.textLayer = null;
        record.textLayerElement.replaceChildren();
      }
      updatePageTextAvailability(record, textOutcome);

      let anchor = state.anchorGeometry;
      if (fixedSourceAnchor && record.pageNumber === fixedSourceAnchor.pageNumber) {
        anchor = resolveSourceAnchor(record, record.textLayer, viewport);
      }
      record.viewport = viewport;
      record.renderedScale = scale;
      record.surface.dataset.renderState = "ready";
      return { pageNumber: record.pageNumber, viewport, anchor, textCapability: textOutcome.textCapability, limitation: textOutcome.limitation };
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
      (fixedSourceAnchor && record.pageNumber === fixedSourceAnchor.pageNumber)
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
    ariaDescription = "",
    interactive = false,
    visibleLabel = "",
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
    if (prior?.builtIn && anchorId === fixedSourceAnchor?.anchorId) return prior.target;
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
    target.tabIndex = interactive ? 0 : -1;
    target.hidden = false;
    target.style.position = "absolute";
    target.style.pointerEvents = interactive ? "auto" : "none";
    target.style.border = "2px solid rgba(82, 70, 184, 0.82)";
    target.style.boxShadow = "0 0 0 4px rgba(100, 86, 214, 0.12)";
    target.style.zIndex = "2";
    target.setAttribute("aria-label", ariaLabel);
    target.setAttribute("role", interactive ? "region" : "note");
    if (ariaDescription) target.setAttribute("aria-description", ariaDescription);
    else target.removeAttribute("aria-description");
    if (interactive) {
      target.setAttribute("aria-roledescription", "PDF region selector");
      target.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Enter Escape");
    } else {
      target.removeAttribute("aria-roledescription");
      target.removeAttribute("aria-keyshortcuts");
    }
    let label = target.querySelector(":scope > .pdf-region-visible-label");
    if (visibleLabel) {
      if (!label) {
        label = document.createElement("span");
        label.className = "pdf-region-visible-label";
        label.setAttribute("aria-hidden", "true");
        target.prepend(label);
      }
      label.textContent = visibleLabel;
    } else {
      label?.remove();
    }
    setElementPercentBounds(target, bounds);
    // Keep the focusable, labeled target outside the aria-hidden paint layer.
    // Only the SVG rectangles are decorative; assistive technology must be able
    // to perceive the programmatically focused provenance target.
    if (target.parentElement !== record.surface) record.surface.append(target);
    target.style.zIndex = "5";

    const svg = current?.svg || document.createElementNS(SVG_NAMESPACE, "svg");
    svg.dataset.paperpilotAnchorOverlay = anchorId;
    svg.setAttribute("class", "pdf-captured-anchor-highlights");
    svg.classList.add(...classTokens);
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
    const textItemRefs = [...record.textLayerElement.querySelectorAll("span")]
      .flatMap((span, index) => {
        try {
          return range.intersectsNode(span) ? [`page:${record.pageNumber}:text-item:${index}`] : [];
        } catch {
          return [];
        }
      })
      .slice(0, 256);
    const normalizedPageText = normalizePdfText(record.textLayerElement.textContent || "");
    const exactTextOffset = normalizedPageText.indexOf(exactText);
    const uniqueExactTextOffset = exactTextOffset >= 0 && normalizedPageText.indexOf(exactText, exactTextOffset + 1) < 0
      ? exactTextOffset
      : -1;
    const prefix = uniqueExactTextOffset >= 0
      ? normalizedPageText.slice(Math.max(0, uniqueExactTextOffset - 240), uniqueExactTextOffset)
      : "";
    const suffix = uniqueExactTextOffset >= 0
      ? normalizedPageText.slice(uniqueExactTextOffset + exactText.length, uniqueExactTextOffset + exactText.length + 240)
      : "";
    const capturedGeneration = record.generation;
    range.detach?.();

    const encodedText = new TextEncoder().encode(exactText);
    const exactTextSha256 = await sha256Hex(encodedText);
    const anchorPayload = JSON.stringify({
      documentSha256: state.documentFacts.sha256,
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
      prefix,
      suffix,
      documentSha256: state.documentFacts.sha256,
      documentRevision: 1,
      coordinateSpace: "pdf-crop-box",
      normalizedCoordinateSpace: "normalized_page_top_left",
      normalizedBounds: Object.freeze(rects),
      bounds,
      rects: Object.freeze(rects),
      pdfQuads: Object.freeze(pdfQuads),
      textItemRefs: Object.freeze(textItemRefs),
      pageViewBox,
      pageRotation: record.viewport.rotation,
      rendererRecipe: Object.freeze({
        recipeVersion: 1,
        renderer: "pdfjs",
        rendererVersion: pdfjsVersion,
        pageViewBox,
        rotation: record.viewport.rotation,
        pdfCoordinateSpace: "pdf-crop-box",
        displayCoordinateSpace: "normalized_page_top_left",
      }),
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

  const notifyRegionSelection = (selection, phase = "changed") => {
    try {
      selection?.onChange?.(Object.freeze({
        phase,
        pageIndex: selection.pageNumber - 1,
        pageNumber: selection.pageNumber,
        normalizedBounds: Object.freeze([{ ...selection.bounds }]),
        inputMethod: selection.inputMethod,
      }));
    } catch {
      // Presentation callbacks cannot invalidate page-owned region geometry.
    }
  };

  const paintRegionSelection = ({ focus = false, phase = "changed" } = {}) => {
    const selection = state.regionSelection;
    if (!selection) return null;
    for (const record of pageRecords.values()) {
      record.surface.classList.toggle("is-region-selecting", record.pageNumber === selection.pageNumber);
    }
    const target = upsertAnchorOverlay({
      anchorId: selection.anchorId,
      pageNumber: selection.pageNumber,
      normalizedBounds: [selection.bounds],
      className: "pdf-region-selection-draft",
      ariaLabel: `Draft PDF region on page ${selection.pageNumber}`,
      ariaDescription: "Use arrow keys to move this region. Hold Shift with an arrow key to resize it. Press Enter to keep the region or Escape to cancel.",
      interactive: true,
      visibleLabel: `Region · p.${selection.pageNumber}`,
    });
    notifyRegionSelection(selection, phase);
    if (focus) target.focus({ preventScroll: true });
    return target;
  };

  const cancelRegionSelection = ({ notify = true } = {}) => {
    const selection = state.regionSelection;
    if (!selection) return false;
    state.regionSelection = null;
    delete viewer.dataset.regionSelection;
    for (const record of pageRecords.values()) record.surface.classList.remove("is-region-selecting");
    const removed = removeAnchorOverlay(selection.anchorId);
    if (notify) {
      try { selection.onCancel?.(); } catch { /* presentation callback only */ }
    }
    return removed;
  };

  const beginRegionSelection = async ({
    pageNumber = state.currentPage,
    initialBounds = { x: 0.25, y: 0.24, width: 0.5, height: 0.24 },
    onChange,
    onConfirm,
    onCancel,
  } = {}) => {
    if (!state.pdfDocument || state.destroyed || state.failed) {
      throw new PaperPdfError("PDF_VIEWER_UNAVAILABLE", "The verified PDF viewer is not available.");
    }
    if (state.regionSelection) cancelRegionSelection({ notify: false });
    const targetPage = resolveStrictPageNumber({ pageNumber });
    await showPage(targetPage, { behavior: "auto", block: "center" });
    const bounds = normalizeDraggedRegion(
      { x: Number(initialBounds.x), y: Number(initialBounds.y) },
      { x: Number(initialBounds.x) + Number(initialBounds.width), y: Number(initialBounds.y) + Number(initialBounds.height) },
      0.015,
    );
    state.regionSelection = {
      anchorId: "anchor:region:draft",
      pageNumber: targetPage,
      bounds,
      inputMethod: "keyboard",
      pointerId: null,
      dragStart: null,
      onChange,
      onConfirm,
      onCancel,
    };
    viewer.dataset.regionSelection = "active";
    return paintRegionSelection({ focus: true, phase: "started" });
  };

  const captureRegionSelection = async () => {
    const selection = state.regionSelection;
    if (!selection) {
      throw new PaperPdfError("PDF_REGION_SELECTION_EMPTY", "Start a PDF region selection first.");
    }
    const record = pageRecords.get(selection.pageNumber);
    if (!record?.viewport || !record.surface.isConnected) {
      throw new PaperPdfError("PDF_REGION_SELECTION_STALE", "The selected page changed before its region could be frozen.");
    }
    const normalizedBounds = Object.freeze([{ ...selection.bounds }]);
    const pageViewBox = freezePdfPageViewBox(record.viewport.viewBox || record.baseViewport.viewBox);
    const pdfQuads = Object.freeze([pdfQuadFromNormalizedRegion(selection.bounds, record.viewport)]);
    const rendererRecipe = Object.freeze({
      recipeVersion: 1,
      renderer: "pdfjs",
      rendererVersion: pdfjsVersion,
      pageViewBox,
      rotation: record.viewport.rotation,
      pdfCoordinateSpace: "pdf-crop-box",
      displayCoordinateSpace: "normalized_page_top_left",
    });
    const regionPayload = JSON.stringify({
      documentSha256: state.documentFacts.sha256,
      pageNumber: selection.pageNumber,
      rotation: record.viewport.rotation,
      normalizedBounds,
      pdfQuads,
      rendererRecipe,
    });
    const regionDigest = await sha256Hex(new TextEncoder().encode(regionPayload));
    if (state.destroyed || state.failed || state.regionSelection !== selection || !record.surface.isConnected) {
      throw new PaperPdfError("PDF_REGION_SELECTION_STALE", "The selected page changed before its region could be frozen.");
    }
    return Object.freeze({
      anchorId: selection.anchorId,
      pageIndex: selection.pageNumber - 1,
      pageNumber: selection.pageNumber,
      pageLabel: String(selection.pageNumber),
      sourceKind: "user_page_region",
      documentSha256: state.documentFacts.sha256,
      documentRevision: 1,
      coordinateSpace: "pdf-crop-box",
      normalizedCoordinateSpace: "normalized_page_top_left",
      normalizedBounds,
      rects: normalizedBounds,
      pdfQuads,
      textItemRefs: Object.freeze([]),
      pageViewBox,
      pageRotation: record.viewport.rotation,
      rendererRecipe,
      regionDigest,
      resolvedFrom: `pdfjs_${selection.inputMethod}_page_region`,
      pageSurface: record.surface,
      target: anchorOverlays.get(selection.anchorId)?.target || null,
    });
  };

  listen(viewer, "pointerdown", (event) => {
    const selection = state.regionSelection;
    if (!selection || event.button !== 0) return;
    const record = pageRecordForNode(event.target);
    if (!record) return;
    event.preventDefault();
    event.stopPropagation();
    const point = normalizeClientPoint(event, record.surface.getBoundingClientRect());
    const safeStart = Object.freeze({ x: Math.min(point.x, 0.985), y: Math.min(point.y, 0.985) });
    selection.pageNumber = record.pageNumber;
    selection.inputMethod = "pointer";
    selection.pointerId = event.pointerId;
    selection.dragStart = safeStart;
    selection.bounds = normalizeDraggedRegion(safeStart, {
      x: safeStart.x + 0.015,
      y: safeStart.y + 0.015,
    });
    try { viewer.setPointerCapture(event.pointerId); } catch { /* optional pointer capture */ }
    paintRegionSelection({ phase: "drawing" });
  }, { capture: true });

  listen(viewer, "pointermove", (event) => {
    const selection = state.regionSelection;
    if (!selection || selection.pointerId !== event.pointerId || !selection.dragStart) return;
    const record = pageRecords.get(selection.pageNumber);
    if (!record) return;
    event.preventDefault();
    const point = normalizeClientPoint(event, record.surface.getBoundingClientRect());
    selection.bounds = normalizeDraggedRegion(selection.dragStart, point);
    paintRegionSelection({ phase: "drawing" });
  }, { capture: true });

  listen(viewer, "pointerup", (event) => {
    const selection = state.regionSelection;
    if (!selection || selection.pointerId !== event.pointerId || !selection.dragStart) return;
    event.preventDefault();
    const record = pageRecords.get(selection.pageNumber);
    if (record) {
      const point = normalizeClientPoint(event, record.surface.getBoundingClientRect());
      if (Math.abs(point.x - selection.dragStart.x) < 0.01 && Math.abs(point.y - selection.dragStart.y) < 0.01) {
        selection.bounds = Object.freeze({
          x: rounded(clamp(point.x - 0.06, 0, 0.88)),
          y: rounded(clamp(point.y - 0.04, 0, 0.92)),
          width: 0.12,
          height: 0.08,
        });
      } else {
        selection.bounds = normalizeDraggedRegion(selection.dragStart, point);
      }
    }
    selection.pointerId = null;
    selection.dragStart = null;
    try { viewer.releasePointerCapture(event.pointerId); } catch { /* optional pointer capture */ }
    paintRegionSelection({ focus: true, phase: "selected" });
  }, { capture: true });

  listen(viewer, "pointercancel", (event) => {
    const selection = state.regionSelection;
    if (!selection || selection.pointerId !== event.pointerId) return;
    selection.pointerId = null;
    selection.dragStart = null;
    paintRegionSelection({ focus: true, phase: "selected" });
  }, { capture: true });

  listen(viewer, "keydown", (event) => {
    const selection = state.regionSelection;
    if (!selection || event.target?.dataset?.anchorId !== selection.anchorId) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      selection.inputMethod = "keyboard";
      selection.bounds = adjustNormalizedRegion(selection.bounds, event.key, event);
      paintRegionSelection({ focus: true, phase: event.shiftKey ? "resized" : "moved" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      notifyRegionSelection(selection, "confirmed");
      try { selection.onConfirm?.(); } catch { /* presentation callback only */ }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRegionSelection();
    }
  });

  const getAnchorTarget = (anchorId = fixedSourceAnchor?.anchorId) => (
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
    anchorIdOrOptions = fixedSourceAnchor?.anchorId,
    maybeOptions = {},
  ) => {
    const anchorId = typeof anchorIdOrOptions === "string"
      ? anchorIdOrOptions
      : fixedSourceAnchor?.anchorId;
    const focusOptions = typeof anchorIdOrOptions === "string" ? maybeOptions : anchorIdOrOptions;
    const {
      behavior = "smooth",
      block = "center",
      scrollIntoView = true,
      moveKeyboardFocus = true,
    } = focusOptions || {};
    const overlay = anchorOverlays.get(anchorId);
    if (!overlay?.target?.isConnected) {
      throw new PaperPdfError("PDF_SOURCE_UNAVAILABLE", `The PDF anchor ${anchorId} is not materialized.`);
    }
    return focusPdfAnchorTarget({ target: overlay.target, pageNumber: overlay.pageNumber, showPage }, {
      behavior,
      block,
      scrollIntoView,
      moveKeyboardFocus,
    });
  };

  const focus = async (focusOptions = {}) => {
    if (!fixedSourceAnchor) {
      throw new PaperPdfError("PDF_SOURCE_UNAVAILABLE", "This PDF has no fixed source anchor; focus an issued dynamic anchor instead.");
    }
    await focusAnchor(fixedSourceAnchor.anchorId, focusOptions);
    if (!state.anchorGeometry || anchorTarget.hidden) {
      throw new PaperPdfError(
        "PDF_SOURCE_UNAVAILABLE",
        `The exact source anchor is not available on page ${fixedSourceAnchor.pageNumber}.`,
      );
    }
    return state.anchorGeometry;
  };

  const extractDocumentText = async ({ onProgress, signal } = {}) => {
    if (!state.documentFacts?.integrityVerified || !state.pdfDocument || state.destroyed || state.failed) {
      throw new PaperPdfError(
        "PDF_TEXT_INDEX_UNAVAILABLE",
        "The PDF text index is available only after the selected document identity is ready.",
      );
    }
    if (state.documentTextIndex) return state.documentTextIndex;
    if (state.documentTextPromise) return state.documentTextPromise;

    state.documentTextPromise = (async () => {
      const pages = [];
      let exactCandidatePages = 0;
      let visualOnlyPages = 0;
      let failedPages = 0;
      const outline = await resolvePdfOutline(state.pdfDocument);
      const records = [...pageRecords.values()].sort((left, right) => left.pageNumber - right.pageNumber);
      for (const record of records) {
        if (signal?.aborted || abortController.signal.aborted || state.destroyed) {
          throw new PaperPdfError("PDF_TEXT_INDEX_ABORTED", "Whole-paper text indexing was cancelled.");
        }
        let pageRecord;
        try {
          const textContent = await loadPageTextContent(record);
          pageRecord = buildPdfPageTextRecord({
            pageIndex: record.pageIndex,
            pageLabel: String(record.pageNumber),
            textItems: textContent.items,
            viewport: record.baseViewport,
            pageViewBox: record.baseViewport.viewBox,
            pageRotation: record.baseViewport.rotation,
          });
          if (pageRecord.textCapability === "exact_candidate") exactCandidatePages += 1;
          else visualOnlyPages += 1;
        } catch (error) {
          if (signal?.aborted || abortController.signal.aborted || state.destroyed) throw error;
          // The PDF page and its CropBox were already admitted and loaded.
          // Failure to obtain embedded text limits semantic extraction, but it
          // does not make the visible page or whole-page structural source
          // unavailable.
          visualOnlyPages += 1;
          pageRecord = Object.freeze({
            pageIndex: record.pageIndex,
            pageLabel: String(record.pageNumber),
            pageViewBox: freezePdfPageViewBox(record.baseViewport.viewBox),
            pageRotation: record.baseViewport.rotation,
            textCapability: "visual_only",
            text: "",
            lines: Object.freeze([]),
            limitation: error?.name || "text_extraction_failed",
          });
        }
        pages.push(pageRecord);
        const progress = Object.freeze({
          pageIndex: record.pageIndex,
          pageNumber: record.pageNumber,
          pageCount: records.length,
          indexedPages: pages.length,
          textCapability: pageRecord.textCapability,
        });
        onProgress?.(progress);
        options.onTextIndexProgress?.(progress);
      }

      const status = failedPages === records.length
        ? "failed"
        : failedPages > 0 || visualOnlyPages > 0
          ? "partial"
          : "ready";
      const snapshot = Object.freeze({
        schemaVersion: 1,
        documentSha256: state.documentFacts.sha256,
        pageCount: records.length,
        indexedPages: pages.length,
        exactCandidatePages,
        visualOnlyPages,
        failedPages,
        status,
        outline,
        pages: Object.freeze(pages),
      });
      state.documentTextIndex = snapshot;
      emitReadyStatus();
      return snapshot;
    })();

    try {
      return await state.documentTextPromise;
    } catch (error) {
      state.documentTextPromise = null;
      throw error;
    }
  };

  const destroy = async () => {
    if (state.destroyed) return;
    if (state.regionSelection) cancelRegionSelection({ notify: false });
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
  emitStatus(
    "verifying",
    suppliedDocument
      ? "Computing a browser-local identity for the selected PDF…"
      : "Verifying the exact 15-page arXiv PDF…",
  );
  try {
    let source = suppliedDocument;
    if (!source) {
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
      const preparedFixture = await preparePdfDocumentSource({
        pdfBytes: await response.arrayBuffer(),
        filename: ATTENTION_PDF.filename,
        title: ATTENTION_PDF.title,
        contentType: response.headers.get("content-type") || "application/pdf",
        sourceUrl: ATTENTION_PDF.sourceUrl,
        expectedByteLength: ATTENTION_PDF.byteLength,
        expectedSha256: ATTENTION_PDF.sha256,
        expectedPageCount: ATTENTION_PDF.pageCount,
      });
      source = Object.freeze({ ...preparedFixture, paperRef: "paper:arxiv:1706_03762v7" });
    }

    state.loadingTask = getDocument({
      data: source.bytes.slice(),
      isEvalSupported: false,
      useWorkerFetch: false,
      standardFontDataUrl: PDFJS_ASSET_URLS.standardFonts,
      cMapUrl: PDFJS_ASSET_URLS.cmaps,
      cMapPacked: true,
      wasmUrl: PDFJS_ASSET_URLS.wasm,
    });
    state.pdfDocument = await state.loadingTask.promise;
    assertPdfPageCountWithinLimit(state.pdfDocument.numPages, maxPdfPages);
    if (source.expectedPageCount !== null && state.pdfDocument.numPages !== source.expectedPageCount) {
      throw new PaperPdfError(
        "PDF_PAGE_COUNT_MISMATCH",
        `The selected PDF has ${state.pdfDocument.numPages} pages; expected ${source.expectedPageCount}.`,
      );
    }
    if (fixedSourceAnchor && fixedSourceAnchor.pageNumber > state.pdfDocument.numPages) {
      throw new PaperPdfError(
        "PDF_SOURCE_ANCHOR_INVALID",
        `The fixed source anchor targets page ${fixedSourceAnchor.pageNumber}, but the PDF has ${state.pdfDocument.numPages} pages.`,
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
    const firstPage = pageRecords.get(1);
    state.documentFacts = Object.freeze({
      ...(suppliedDocument ? {} : ATTENTION_PDF),
      title: source.title,
      filename: source.filename,
      byteLength: source.byteLength,
      sha256: source.sha256,
      paperRef: source.paperRef,
      pageCount: state.pdfDocument.numPages,
      sourceUrl: source.sourceUrl,
      contentType: source.contentType,
      pdfjsVersion,
      integrityVerified: true,
      identityMethod: source.identityMethod,
      layoutMode: "continuous_virtualized",
      firstPageViewBox: freezePdfPageViewBox(firstPage.baseViewport.viewBox),
      firstPageRotation: firstPage.baseViewport.rotation,
    });

    const firstRenderedPage = fixedSourceAnchor?.pageNumber ?? state.currentPage;
    await renderPage(pageRecords.get(firstRenderedPage), { announce: true });
    if (fixedSourceAnchor && !state.anchorGeometry) {
      throw new PaperPdfError(
        "PDF_SOURCE_UNAVAILABLE",
        `The exact page-${fixedSourceAnchor.pageNumber} sentence did not resolve before the viewer became ready.`,
      );
    }
    if (state.currentPage !== firstRenderedPage) {
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
    getStructuralPageRecords() {
      return Object.freeze([...pageRecords.values()]
        .sort((left, right) => left.pageNumber - right.pageNumber)
        .map((record) => {
          const indexed = state.documentTextIndex?.pages?.[record.pageIndex];
          return Object.freeze({
            pageIndex: record.pageIndex,
            pageLabel: String(record.pageNumber),
            pageViewBox: freezePdfPageViewBox(record.baseViewport.viewBox),
            pageRotation: record.baseViewport.rotation,
            textCapability: indexed?.textCapability || "visual_only",
          });
        }));
    },
    captureSelection,
    createAnchorFromSelection: captureSelection,
    beginRegionSelection,
    captureRegionSelection,
    cancelRegionSelection,
    extractDocumentText,
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
