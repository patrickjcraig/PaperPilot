// @ts-check

/**
 * Browser-independent canonical spatial anchors for PaperPilot.
 *
 * Trusted page code supplies normalized top-left geometry. This module binds it
 * to one PDF identity, derives canonical PDF CropBox coordinates, and mints a
 * deterministic digest. WebMCP adapters may consume these records but must not
 * accept their page-owned geometry from a model.
 */

export const SPATIAL_ANCHOR_SCHEMA_VERSION = 1;
export const SPATIAL_RENDERER_RECIPE_SCHEMA_VERSION = 1;
export const SPATIAL_GEOMETRY_VERSION = 1;
export const NORMALIZED_COORDINATE_SPACE = "viewport-top-left";
export const PDF_COORDINATE_SPACE = "pdf-crop-box";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const RENDERER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const ROTATIONS = /** @type {const} */ ([0, 90, 180, 270]);
const SOURCE_KINDS = /** @type {const} */ ([
  "exact_text",
  "visual_region",
  "whole_page",
  "whole_figure",
  "equation",
]);
const GEOMETRY_KINDS = /** @type {const} */ ([
  "text",
  "point",
  "rectangle",
  "quadrilateral",
]);
const MAX_GEOMETRY_PARTS = 32;
const MAX_EXACT_TEXT_SCALARS = 1_200;
const MAX_EXACT_TEXT_BYTES = 8 * 1024;
const MAX_ABSOLUTE_PDF_COORDINATE = 1_000_000_000;
const ROUNDING_PRECISION = 12;
const NORMALIZED_EPSILON = 1e-9;

/** @typedef {0 | 90 | 180 | 270} PdfRotation */
/** @typedef {"exact_text" | "visual_region" | "whole_page" | "whole_figure" | "equation"} SpatialSourceKind */
/** @typedef {"text" | "point" | "rectangle" | "quadrilateral"} SpatialGeometryKind */
/** @typedef {{ x: number, y: number }} SpatialPoint */
/** @typedef {{ x: number, y: number, width: number, height: number }} NormalizedRect */
/** @typedef {readonly [number, number, number, number]} PdfViewBox */
/** @typedef {readonly [SpatialPoint, SpatialPoint, SpatialPoint, SpatialPoint]} SpatialQuad */
/** @typedef {{
 *   schemaVersion: 1,
 *   renderer: "pdfjs",
 *   rendererVersion: string,
 *   geometryVersion: 1,
 *   normalizedCoordinateSpace: "viewport-top-left",
 *   pdfCoordinateSpace: "pdf-crop-box",
 *   pageViewBox: PdfViewBox,
 *   pageRotation: PdfRotation,
 * }} SpatialRendererRecipe */
/** @typedef {{
 *   schemaVersion: 1,
 *   anchorId: string,
 *   paperRef: string,
 *   documentSha256: string,
 *   documentRevision: 1,
 *   pageIndex: number,
 *   pageLabel: string,
 *   pageViewBox: PdfViewBox,
 *   rotation: PdfRotation,
 *   coordinateSpace: "pdf-crop-box",
 *   normalizedCoordinateSpace: "viewport-top-left",
 *   rendererRecipe: SpatialRendererRecipe,
 *   rendererRecipeDigest: string,
 *   sourceKind: SpatialSourceKind,
 *   geometryKind: SpatialGeometryKind,
 *   normalizedBounds?: readonly NormalizedRect[],
 *   normalizedPoints?: readonly SpatialPoint[],
 *   normalizedQuads?: readonly SpatialQuad[],
 *   pdfPoints?: readonly SpatialPoint[],
 *   pdfQuads?: readonly SpatialQuad[],
 *   quote?: { exact: string, prefix: string, suffix: string, sha256: string, utf8Bytes: number },
 *   textItemRefs: readonly string[],
 *   regionDigest?: string,
 *   authority: "exact_document_text" | "client_rendered_pdf",
 *   createdBy: "human" | "system",
 *   createdAt: string,
 *   anchorDigest: string,
 * }} SpatialAnchor */
/** @typedef {{
 *   paperRef?: string,
 *   documentSha256?: string,
 *   pageIndex?: number,
 *   rendererRecipe?: SpatialRendererRecipe,
 *   rendererRecipeDigest?: string,
 * }} SpatialAnchorContext */

export class SpatialAnchorError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SpatialAnchorError";
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new SpatialAnchorError(code, message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function assertPlainObject(value, code, label) {
  if (!isPlainObject(value)) fail(code, `${label} must be a plain object.`);
  return value;
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} allowed
 * @param {readonly string[]} required
 * @param {string} code
 * @param {string} label
 */
function assertClosedObject(value, allowed, required, code, label) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) fail(code, `${label} contains unknown fields: ${unknown.sort().join(", ")}.`);
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) fail(code, `${label} is missing required fields: ${missing.join(", ")}.`);
}

/** @param {number} value @returns {number} */
function rounded(value) {
  const factor = 10 ** ROUNDING_PRECISION;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {string} label
 * @param {{ min?: number, max?: number, integer?: boolean }} [limits]
 * @returns {number}
 */
function finiteNumber(value, code, label, limits = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code, `${label} must be finite.`);
  if (limits.integer && !Number.isSafeInteger(value)) fail(code, `${label} must be a safe integer.`);
  if (limits.min !== undefined && value < limits.min) fail(code, `${label} is below its minimum.`);
  if (limits.max !== undefined && value > limits.max) fail(code, `${label} exceeds its maximum.`);
  return rounded(value);
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {string} label
 * @param {{ max?: number, pattern?: RegExp, trim?: boolean }} [options]
 * @returns {string}
 */
function boundedString(value, code, label, options = {}) {
  if (typeof value !== "string") fail(code, `${label} must be a string.`);
  const result = options.trim === false ? value : value.trim();
  if (result.length === 0 || result.length > (options.max ?? 256)) fail(code, `${label} has an invalid length.`);
  if (options.pattern && !options.pattern.test(result)) fail(code, `${label} has an invalid format.`);
  return result;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {string} label
 * @returns {string}
 */
function digest(value, code, label) {
  return boundedString(value, code, label, { max: 64, pattern: SHA256_PATTERN });
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {PdfRotation}
 */
function pageRotation(value, code) {
  if (!ROTATIONS.includes(/** @type {PdfRotation} */ (value))) {
    fail(code, "Page rotation must be one of 0, 90, 180, or 270 degrees.");
  }
  return /** @type {PdfRotation} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} [code]
 * @returns {PdfViewBox}
 */
function canonicalPageViewBox(value, code = "SPATIAL_PAGE_INVALID") {
  if (!Array.isArray(value) || value.length !== 4) fail(code, "pageViewBox must contain four PDF coordinates.");
  const coordinates = value.map((coordinate, index) => finiteNumber(
    coordinate,
    code,
    `pageViewBox[${index}]`,
    { min: -MAX_ABSOLUTE_PDF_COORDINATE, max: MAX_ABSOLUTE_PDF_COORDINATE },
  ));
  if (coordinates[2] <= coordinates[0] || coordinates[3] <= coordinates[1]) {
    fail(code, "pageViewBox must have positive width and height.");
  }
  return Object.freeze(/** @type {[number, number, number, number]} */ (coordinates));
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {string} label
 * @returns {SpatialPoint}
 */
function canonicalNormalizedPoint(value, code, label) {
  const point = assertPlainObject(value, code, label);
  assertClosedObject(point, ["x", "y"], ["x", "y"], code, label);
  const x = finiteNumber(point.x, code, `${label}.x`, { min: 0, max: 1 });
  const y = finiteNumber(point.y, code, `${label}.y`, { min: 0, max: 1 });
  return Object.freeze({ x, y });
}

/**
 * @param {unknown} value
 * @param {PdfViewBox} viewBox
 * @param {string} code
 * @param {string} label
 * @returns {SpatialPoint}
 */
function canonicalPdfPoint(value, viewBox, code, label) {
  const point = assertPlainObject(value, code, label);
  assertClosedObject(point, ["x", "y"], ["x", "y"], code, label);
  const x = finiteNumber(point.x, code, `${label}.x`, {
    min: viewBox[0],
    max: viewBox[2],
  });
  const y = finiteNumber(point.y, code, `${label}.y`, {
    min: viewBox[1],
    max: viewBox[3],
  });
  return Object.freeze({ x, y });
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {string} label
 * @returns {NormalizedRect}
 */
function canonicalNormalizedRect(value, code, label) {
  const rectangle = assertPlainObject(value, code, label);
  assertClosedObject(rectangle, ["x", "y", "width", "height"], ["x", "y", "width", "height"], code, label);
  const x = finiteNumber(rectangle.x, code, `${label}.x`, { min: 0, max: 1 });
  const y = finiteNumber(rectangle.y, code, `${label}.y`, { min: 0, max: 1 });
  const width = finiteNumber(rectangle.width, code, `${label}.width`, { min: 0, max: 1 });
  const height = finiteNumber(rectangle.height, code, `${label}.height`, { min: 0, max: 1 });
  if (width <= 0 || height <= 0) fail(code, `${label} must have positive area.`);
  if (x + width > 1 + NORMALIZED_EPSILON || y + height > 1 + NORMALIZED_EPSILON) {
    fail(code, `${label} extends outside the normalized page.`);
  }
  return Object.freeze({ x, y, width, height });
}

/** @param {readonly SpatialPoint[]} points @returns {number} */
function polygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += (current.x * next.y) - (next.x * current.y);
  }
  return Math.abs(twiceArea) / 2;
}

/**
 * @param {SpatialPoint} a
 * @param {SpatialPoint} b
 * @param {SpatialPoint} c
 * @returns {number}
 */
function turn(a, b, c) {
  return ((b.x - a.x) * (c.y - b.y)) - ((b.y - a.y) * (c.x - b.x));
}

/**
 * Require four ordered, distinct vertices forming a simple convex region.
 * This rejects collinear, repeated, concave, and bow-tie quads before digesting.
 *
 * @param {readonly SpatialPoint[]} points
 * @param {string} code
 * @param {string} label
 */
function assertNonDegenerateQuad(points, code, label) {
  const unique = new Set(points.map((point) => `${point.x}:${point.y}`));
  if (unique.size !== 4 || polygonArea(points) <= NORMALIZED_EPSILON ** 2) {
    fail(code, `${label} is degenerate.`);
  }
  const turns = points.map((point, index) => turn(
    point,
    points[(index + 1) % points.length],
    points[(index + 2) % points.length],
  ));
  if (turns.some((value) => Math.abs(value) <= NORMALIZED_EPSILON ** 2)) {
    fail(code, `${label} contains a collinear edge.`);
  }
  const sign = Math.sign(turns[0]);
  if (turns.some((value) => Math.sign(value) !== sign)) {
    fail(code, `${label} must be an ordered convex quadrilateral.`);
  }
}

/**
 * @param {unknown} value
 * @param {(item: unknown, index: number) => SpatialPoint} pointFactory
 * @param {string} code
 * @param {string} label
 * @returns {SpatialQuad}
 */
function canonicalQuad(value, pointFactory, code, label) {
  if (!Array.isArray(value) || value.length !== 4) fail(code, `${label} must contain exactly four points.`);
  const points = value.map((point, index) => pointFactory(point, index));
  assertNonDegenerateQuad(points, code, label);
  return Object.freeze(/** @type {[SpatialPoint, SpatialPoint, SpatialPoint, SpatialPoint]} */ (points));
}

/**
 * @param {unknown} value
 * @param {number} minimum
 * @param {number} maximum
 * @param {string} code
 * @param {string} label
 * @returns {unknown[]}
 */
function boundedArray(value, minimum, maximum, code, label) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(code, `${label} must contain ${minimum} to ${maximum} items.`);
  }
  return value;
}

/** @param {unknown} value @returns {unknown} */
function cloneJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("SPATIAL_DIGEST_INVALID", "Digest material contains a non-finite number.");
    return rounded(value);
  }
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isPlainObject(value)) fail("SPATIAL_DIGEST_INVALID", "Digest material must be plain JSON data.");
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) fail("SPATIAL_DIGEST_INVALID", `Digest material contains undefined at ${key}.`);
    result[key] = cloneJsonValue(child);
  }
  return result;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Deterministic JSON with lexicographically sorted object keys.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalSpatialJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("SPATIAL_DIGEST_INVALID", "Canonical JSON cannot contain a non-finite number.");
    return JSON.stringify(rounded(value));
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSpatialJson).join(",")}]`;
  if (!isPlainObject(value)) fail("SPATIAL_DIGEST_INVALID", "Canonical JSON accepts only plain JSON objects.");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSpatialJson(value[key])}`).join(",")}}`;
}

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function sha256SpatialText(value) {
  if (typeof value !== "string") fail("SPATIAL_DIGEST_INVALID", "SHA-256 input must be text.");
  if (!globalThis.crypto?.subtle) fail("SPATIAL_DIGEST_UNAVAILABLE", "Web Crypto SHA-256 is unavailable.");
  const result = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {unknown} input
 * @returns {SpatialRendererRecipe}
 */
export function createSpatialRendererRecipe(input) {
  const value = assertPlainObject(input, "SPATIAL_RENDERER_RECIPE_INVALID", "rendererRecipe");
  assertClosedObject(
    value,
    ["rendererVersion", "pageViewBox", "pageRotation"],
    ["rendererVersion", "pageViewBox", "pageRotation"],
    "SPATIAL_RENDERER_RECIPE_INVALID",
    "rendererRecipe input",
  );
  /** @type {SpatialRendererRecipe} */
  const recipe = {
    schemaVersion: 1,
    renderer: "pdfjs",
    rendererVersion: boundedString(
      value.rendererVersion,
      "SPATIAL_RENDERER_RECIPE_INVALID",
      "rendererRecipe.rendererVersion",
      { max: 64, pattern: RENDERER_VERSION_PATTERN },
    ),
    geometryVersion: 1,
    normalizedCoordinateSpace: "viewport-top-left",
    pdfCoordinateSpace: "pdf-crop-box",
    pageViewBox: canonicalPageViewBox(value.pageViewBox, "SPATIAL_RENDERER_RECIPE_INVALID"),
    pageRotation: pageRotation(value.pageRotation, "SPATIAL_RENDERER_RECIPE_INVALID"),
  };
  return deepFreeze(recipe);
}

/**
 * @param {unknown} input
 * @returns {SpatialRendererRecipe}
 */
export function validateSpatialRendererRecipe(input) {
  const value = assertPlainObject(input, "SPATIAL_RENDERER_RECIPE_INVALID", "rendererRecipe");
  const keys = [
    "schemaVersion",
    "renderer",
    "rendererVersion",
    "geometryVersion",
    "normalizedCoordinateSpace",
    "pdfCoordinateSpace",
    "pageViewBox",
    "pageRotation",
  ];
  assertClosedObject(value, keys, keys, "SPATIAL_RENDERER_RECIPE_INVALID", "rendererRecipe");
  if (
    value.schemaVersion !== SPATIAL_RENDERER_RECIPE_SCHEMA_VERSION
    || value.renderer !== "pdfjs"
    || value.geometryVersion !== SPATIAL_GEOMETRY_VERSION
    || value.normalizedCoordinateSpace !== NORMALIZED_COORDINATE_SPACE
    || value.pdfCoordinateSpace !== PDF_COORDINATE_SPACE
  ) {
    fail("SPATIAL_RENDERER_RECIPE_INVALID", "The renderer recipe contract is unsupported.");
  }
  /** @type {SpatialRendererRecipe} */
  const recipe = {
    schemaVersion: 1,
    renderer: "pdfjs",
    rendererVersion: boundedString(
      value.rendererVersion,
      "SPATIAL_RENDERER_RECIPE_INVALID",
      "rendererRecipe.rendererVersion",
      { max: 64, pattern: RENDERER_VERSION_PATTERN },
    ),
    geometryVersion: 1,
    normalizedCoordinateSpace: "viewport-top-left",
    pdfCoordinateSpace: "pdf-crop-box",
    pageViewBox: canonicalPageViewBox(value.pageViewBox, "SPATIAL_RENDERER_RECIPE_INVALID"),
    pageRotation: pageRotation(value.pageRotation, "SPATIAL_RENDERER_RECIPE_INVALID"),
  };
  return deepFreeze(recipe);
}

/** @param {unknown} recipe @returns {Promise<string>} */
export async function computeSpatialRendererRecipeDigest(recipe) {
  return sha256SpatialText(canonicalSpatialJson(validateSpatialRendererRecipe(recipe)));
}

/**
 * Convert one normalized viewport point (origin at rendered top-left) into
 * canonical PDF CropBox coordinates (origin at PDF bottom-left).
 *
 * @param {unknown} point
 * @param {unknown} pageViewBox
 * @param {unknown} rotation
 * @returns {SpatialPoint}
 */
export function normalizedTopLeftPointToPdfPoint(point, pageViewBox, rotation) {
  const normalized = canonicalNormalizedPoint(point, "SPATIAL_GEOMETRY_INVALID", "normalizedPoint");
  const viewBox = canonicalPageViewBox(pageViewBox, "SPATIAL_GEOMETRY_INVALID");
  const resolvedRotation = pageRotation(rotation, "SPATIAL_GEOMETRY_INVALID");
  const [xMin, yMin, xMax, yMax] = viewBox;
  const width = xMax - xMin;
  const height = yMax - yMin;
  let x;
  let y;
  if (resolvedRotation === 0) {
    x = xMin + (normalized.x * width);
    y = yMax - (normalized.y * height);
  } else if (resolvedRotation === 90) {
    x = xMin + (normalized.y * width);
    y = yMin + (normalized.x * height);
  } else if (resolvedRotation === 180) {
    x = xMax - (normalized.x * width);
    y = yMin + (normalized.y * height);
  } else {
    x = xMax - (normalized.y * width);
    y = yMax - (normalized.x * height);
  }
  return Object.freeze({ x: rounded(x), y: rounded(y) });
}

/**
 * Convert one canonical PDF CropBox point into normalized rendered coordinates
 * with an origin at the rotated page's top-left.
 *
 * @param {unknown} point
 * @param {unknown} pageViewBox
 * @param {unknown} rotation
 * @returns {SpatialPoint}
 */
export function pdfPointToNormalizedTopLeftPoint(point, pageViewBox, rotation) {
  const viewBox = canonicalPageViewBox(pageViewBox, "SPATIAL_GEOMETRY_INVALID");
  const pdfPoint = canonicalPdfPoint(point, viewBox, "SPATIAL_GEOMETRY_INVALID", "pdfPoint");
  const resolvedRotation = pageRotation(rotation, "SPATIAL_GEOMETRY_INVALID");
  const [xMin, yMin, xMax, yMax] = viewBox;
  const width = xMax - xMin;
  const height = yMax - yMin;
  let x;
  let y;
  if (resolvedRotation === 0) {
    x = (pdfPoint.x - xMin) / width;
    y = (yMax - pdfPoint.y) / height;
  } else if (resolvedRotation === 90) {
    x = (pdfPoint.y - yMin) / height;
    y = (pdfPoint.x - xMin) / width;
  } else if (resolvedRotation === 180) {
    x = (xMax - pdfPoint.x) / width;
    y = (pdfPoint.y - yMin) / height;
  } else {
    x = (yMax - pdfPoint.y) / height;
    y = (xMax - pdfPoint.x) / width;
  }
  return canonicalNormalizedPoint({ x: rounded(x), y: rounded(y) }, "SPATIAL_GEOMETRY_INVALID", "normalizedPoint");
}

/**
 * @param {unknown} rectangle
 * @param {unknown} pageViewBox
 * @param {unknown} rotation
 * @returns {SpatialQuad}
 */
export function normalizedRectToPdfQuad(rectangle, pageViewBox, rotation) {
  const rect = canonicalNormalizedRect(rectangle, "SPATIAL_GEOMETRY_INVALID", "normalizedRectangle");
  const normalizedQuad = /** @type {SpatialQuad} */ (Object.freeze([
    Object.freeze({ x: rect.x, y: rect.y }),
    Object.freeze({ x: rounded(rect.x + rect.width), y: rect.y }),
    Object.freeze({ x: rounded(rect.x + rect.width), y: rounded(rect.y + rect.height) }),
    Object.freeze({ x: rect.x, y: rounded(rect.y + rect.height) }),
  ]));
  return normalizedQuadToPdfQuad(normalizedQuad, pageViewBox, rotation);
}

/**
 * @param {unknown} quad
 * @param {unknown} pageViewBox
 * @param {unknown} rotation
 * @returns {SpatialQuad}
 */
export function normalizedQuadToPdfQuad(quad, pageViewBox, rotation) {
  const normalized = canonicalQuad(
    quad,
    (point, index) => canonicalNormalizedPoint(point, "SPATIAL_GEOMETRY_INVALID", `normalizedQuad[${index}]`),
    "SPATIAL_GEOMETRY_INVALID",
    "normalizedQuad",
  );
  const points = normalized.map((point) => normalizedTopLeftPointToPdfPoint(point, pageViewBox, rotation));
  return Object.freeze(/** @type {[SpatialPoint, SpatialPoint, SpatialPoint, SpatialPoint]} */ (points));
}

/**
 * @param {unknown} quad
 * @param {unknown} pageViewBox
 * @param {unknown} rotation
 * @returns {SpatialQuad}
 */
export function pdfQuadToNormalizedQuad(quad, pageViewBox, rotation) {
  const viewBox = canonicalPageViewBox(pageViewBox, "SPATIAL_GEOMETRY_INVALID");
  const pdfQuad = canonicalQuad(
    quad,
    (point, index) => canonicalPdfPoint(point, viewBox, "SPATIAL_GEOMETRY_INVALID", `pdfQuad[${index}]`),
    "SPATIAL_GEOMETRY_INVALID",
    "pdfQuad",
  );
  const points = pdfQuad.map((point) => pdfPointToNormalizedTopLeftPoint(point, viewBox, rotation));
  const normalized = canonicalQuad(
    points,
    (point, index) => canonicalNormalizedPoint(point, "SPATIAL_GEOMETRY_INVALID", `normalizedQuad[${index}]`),
    "SPATIAL_GEOMETRY_INVALID",
    "normalizedQuad",
  );
  return normalized;
}

/**
 * Return the normalized top-left bounding rectangle of a canonical PDF quad.
 * Rectangular quads round-trip exactly; arbitrary quads retain their vertices
 * through pdfQuadToNormalizedQuad and use this only as a display bound.
 *
 * @param {unknown} quad
 * @param {unknown} pageViewBox
 * @param {unknown} rotation
 * @returns {NormalizedRect}
 */
export function pdfQuadToNormalizedRect(quad, pageViewBox, rotation) {
  const normalized = pdfQuadToNormalizedQuad(quad, pageViewBox, rotation);
  const xValues = normalized.map((point) => point.x);
  const yValues = normalized.map((point) => point.y);
  const x = Math.min(...xValues);
  const y = Math.min(...yValues);
  return canonicalNormalizedRect({
    x,
    y,
    width: rounded(Math.max(...xValues) - x),
    height: rounded(Math.max(...yValues) - y),
  }, "SPATIAL_GEOMETRY_INVALID", "normalizedRectangle");
}

/**
 * @param {SpatialPoint} left
 * @param {SpatialPoint} right
 * @param {number} tolerance
 * @returns {boolean}
 */
function pointsEqual(left, right, tolerance) {
  return Math.abs(left.x - right.x) <= tolerance && Math.abs(left.y - right.y) <= tolerance;
}

/**
 * @param {readonly SpatialQuad[]} actual
 * @param {readonly SpatialQuad[]} expected
 * @param {PdfViewBox} viewBox
 * @param {string} code
 */
function assertPdfQuadsMatch(actual, expected, viewBox, code) {
  if (actual.length !== expected.length) fail(code, "PDF and normalized quad counts differ.");
  const tolerance = Math.max(viewBox[2] - viewBox[0], viewBox[3] - viewBox[1]) * 1e-9 + 1e-9;
  for (let quadIndex = 0; quadIndex < actual.length; quadIndex += 1) {
    for (let pointIndex = 0; pointIndex < 4; pointIndex += 1) {
      if (!pointsEqual(actual[quadIndex][pointIndex], expected[quadIndex][pointIndex], tolerance)) {
        fail(code, `PDF quad ${quadIndex} is inconsistent with normalized page geometry.`);
      }
    }
  }
}

/**
 * @param {unknown} sourceKind
 * @returns {SpatialSourceKind}
 */
function canonicalSourceKind(sourceKind) {
  if (!SOURCE_KINDS.includes(/** @type {SpatialSourceKind} */ (sourceKind))) {
    fail("SPATIAL_ANCHOR_INVALID", "sourceKind is unsupported.");
  }
  return /** @type {SpatialSourceKind} */ (sourceKind);
}

/**
 * @param {unknown} geometryKind
 * @returns {SpatialGeometryKind}
 */
function canonicalGeometryKind(geometryKind) {
  if (!GEOMETRY_KINDS.includes(/** @type {SpatialGeometryKind} */ (geometryKind))) {
    fail("SPATIAL_ANCHOR_INVALID", "geometryKind is unsupported.");
  }
  return /** @type {SpatialGeometryKind} */ (geometryKind);
}

/**
 * @param {unknown} text
 * @returns {string}
 */
function canonicalExactText(text) {
  const exactText = boundedString(text, "SPATIAL_EXACT_TEXT_INVALID", "exactText", {
    max: MAX_EXACT_TEXT_BYTES,
    trim: false,
  });
  if ([...exactText].length > MAX_EXACT_TEXT_SCALARS || new TextEncoder().encode(exactText).byteLength > MAX_EXACT_TEXT_BYTES) {
    fail("SPATIAL_EXACT_TEXT_INVALID", "exactText exceeds the 1,200-scalar or 8-KiB limit.");
  }
  return exactText;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function quoteContext(value, label) {
  if (typeof value !== "string" || [...value].length > 500 || new TextEncoder().encode(value).byteLength > 2_048) {
    fail("SPATIAL_EXACT_TEXT_INVALID", `${label} must be a bounded string.`);
  }
  return value;
}

/**
 * @param {unknown} input
 * @param {boolean} canonicalInput
 * @returns {Promise<{ exact: string, prefix: string, suffix: string, sha256: string, utf8Bytes: number }>}
 */
async function canonicalQuote(input, canonicalInput) {
  const quote = assertPlainObject(input, "SPATIAL_EXACT_TEXT_INVALID", "quote");
  const inputKeys = canonicalInput
    ? ["exact", "prefix", "suffix", "sha256", "utf8Bytes"]
    : ["exact", "prefix", "suffix", "sha256"];
  const required = canonicalInput
    ? ["exact", "prefix", "suffix", "sha256", "utf8Bytes"]
    : ["exact"];
  assertClosedObject(quote, inputKeys, required, "SPATIAL_EXACT_TEXT_INVALID", "quote");
  const exact = canonicalExactText(quote.exact);
  const prefix = quoteContext(quote.prefix ?? "", "quote.prefix");
  const suffix = quoteContext(quote.suffix ?? "", "quote.suffix");
  const sha256 = await sha256SpatialText(exact);
  if (quote.sha256 !== undefined && digest(quote.sha256, "SPATIAL_EXACT_TEXT_INVALID", "quote.sha256") !== sha256) {
    fail("SPATIAL_EXACT_TEXT_HASH_MISMATCH", "quote.sha256 does not match quote.exact.");
  }
  const utf8Bytes = new TextEncoder().encode(exact).byteLength;
  if (canonicalInput && quote.utf8Bytes !== utf8Bytes) {
    fail("SPATIAL_EXACT_TEXT_INVALID", "quote.utf8Bytes does not match quote.exact.");
  }
  return deepFreeze({ exact, prefix, suffix, sha256, utf8Bytes });
}

/**
 * @param {unknown} value
 * @returns {readonly string[]}
 */
function canonicalTextItemRefs(value) {
  const refs = boundedArray(value, 0, 256, "SPATIAL_ANCHOR_INVALID", "textItemRefs")
    .map((item, index) => boundedString(
      item,
      "SPATIAL_ANCHOR_INVALID",
      `textItemRefs[${index}]`,
      { max: 128, pattern: ID_PATTERN },
    ));
  if (new Set(refs).size !== refs.length) fail("SPATIAL_ANCHOR_INVALID", "textItemRefs must be unique.");
  return Object.freeze(refs);
}

/** @param {unknown} value @returns {"human" | "system"} */
function canonicalCreator(value) {
  if (value !== "human" && value !== "system") fail("SPATIAL_ANCHOR_INVALID", "createdBy must be human or system.");
  return value;
}

/** @param {unknown} value @returns {string} */
function canonicalTimestamp(value) {
  const timestamp = boundedString(value, "SPATIAL_ANCHOR_INVALID", "createdAt", { max: 64 });
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    fail("SPATIAL_ANCHOR_INVALID", "createdAt must be a canonical UTC ISO timestamp.");
  }
  return timestamp;
}

/**
 * @param {SpatialSourceKind} sourceKind
 * @param {SpatialGeometryKind} geometryKind
 * @param {boolean} hasQuote
 */
function validateSourceGeometryPair(sourceKind, geometryKind, hasQuote) {
  if (sourceKind === "exact_text" && (geometryKind !== "text" || !hasQuote)) {
    fail("SPATIAL_ANCHOR_INVALID", "Exact-text anchors require text geometry and a quote.");
  }
  if ((sourceKind === "visual_region" || sourceKind === "whole_figure") && geometryKind === "text") {
    fail("SPATIAL_ANCHOR_INVALID", `${sourceKind} cannot claim text geometry.`);
  }
  if (sourceKind === "whole_page" && geometryKind !== "rectangle") {
    fail("SPATIAL_ANCHOR_INVALID", "Whole-page anchors require rectangle geometry.");
  }
  if (sourceKind !== "exact_text" && sourceKind !== "equation" && hasQuote) {
    fail("SPATIAL_ANCHOR_INVALID", `${sourceKind} cannot claim exact document text.`);
  }
  if (sourceKind === "equation" && geometryKind === "point") {
    fail("SPATIAL_ANCHOR_INVALID", "Equation anchors require an area, quadrilateral, or text geometry.");
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {SpatialGeometryKind} geometryKind
 * @param {PdfViewBox} viewBox
 * @param {PdfRotation} rotation
 * @param {boolean} canonicalInput
 * @returns {Record<string, unknown>}
 */
function canonicalGeometry(value, geometryKind, viewBox, rotation, canonicalInput) {
  const code = "SPATIAL_GEOMETRY_INVALID";
  if (geometryKind === "point") {
    const normalizedPoints = boundedArray(value.normalizedPoints, 1, 1, code, "normalizedPoints")
      .map((point, index) => canonicalNormalizedPoint(point, code, `normalizedPoints[${index}]`));
    const expectedPdfPoints = normalizedPoints.map((point) => normalizedTopLeftPointToPdfPoint(point, viewBox, rotation));
    if (canonicalInput) {
      const pdfPoints = boundedArray(value.pdfPoints, 1, 1, code, "pdfPoints")
        .map((point, index) => canonicalPdfPoint(point, viewBox, code, `pdfPoints[${index}]`));
      const tolerance = Math.max(viewBox[2] - viewBox[0], viewBox[3] - viewBox[1]) * 1e-9 + 1e-9;
      if (!pointsEqual(pdfPoints[0], expectedPdfPoints[0], tolerance)) {
        fail(code, "PDF point is inconsistent with normalized page geometry.");
      }
      return {
        normalizedPoints: Object.freeze(normalizedPoints),
        pdfPoints: Object.freeze(pdfPoints),
      };
    }
    return {
      normalizedPoints: Object.freeze(normalizedPoints),
      pdfPoints: Object.freeze(expectedPdfPoints),
    };
  }

  if (geometryKind === "text" || geometryKind === "rectangle") {
    const minimum = 1;
    const maximum = geometryKind === "rectangle" ? 1 : MAX_GEOMETRY_PARTS;
    const normalizedBounds = boundedArray(value.normalizedBounds, minimum, maximum, code, "normalizedBounds")
      .map((rectangle, index) => canonicalNormalizedRect(rectangle, code, `normalizedBounds[${index}]`));
    const expectedPdfQuads = normalizedBounds.map((rectangle) => normalizedRectToPdfQuad(rectangle, viewBox, rotation));
    if (canonicalInput) {
      const rawPdfQuads = boundedArray(value.pdfQuads, minimum, maximum, code, "pdfQuads");
      const pdfQuads = rawPdfQuads.map((quad, quadIndex) => canonicalQuad(
        quad,
        (point, pointIndex) => canonicalPdfPoint(point, viewBox, code, `pdfQuads[${quadIndex}][${pointIndex}]`),
        code,
        `pdfQuads[${quadIndex}]`,
      ));
      assertPdfQuadsMatch(pdfQuads, expectedPdfQuads, viewBox, code);
      return {
        normalizedBounds: Object.freeze(normalizedBounds),
        pdfQuads: Object.freeze(pdfQuads),
      };
    }
    return {
      normalizedBounds: Object.freeze(normalizedBounds),
      pdfQuads: Object.freeze(expectedPdfQuads),
    };
  }

  const normalizedQuads = boundedArray(value.normalizedQuads, 1, MAX_GEOMETRY_PARTS, code, "normalizedQuads")
    .map((quad, quadIndex) => canonicalQuad(
      quad,
      (point, pointIndex) => canonicalNormalizedPoint(point, code, `normalizedQuads[${quadIndex}][${pointIndex}]`),
      code,
      `normalizedQuads[${quadIndex}]`,
    ));
  const expectedPdfQuads = normalizedQuads.map((quad) => normalizedQuadToPdfQuad(quad, viewBox, rotation));
  if (canonicalInput) {
    const rawPdfQuads = boundedArray(value.pdfQuads, 1, MAX_GEOMETRY_PARTS, code, "pdfQuads");
    const pdfQuads = rawPdfQuads.map((quad, quadIndex) => canonicalQuad(
      quad,
      (point, pointIndex) => canonicalPdfPoint(point, viewBox, code, `pdfQuads[${quadIndex}][${pointIndex}]`),
      code,
      `pdfQuads[${quadIndex}]`,
    ));
    assertPdfQuadsMatch(pdfQuads, expectedPdfQuads, viewBox, code);
    return {
      normalizedQuads: Object.freeze(normalizedQuads),
      pdfQuads: Object.freeze(pdfQuads),
    };
  }
  return {
    normalizedQuads: Object.freeze(normalizedQuads),
    pdfQuads: Object.freeze(expectedPdfQuads),
  };
}

/**
 * @param {SpatialGeometryKind} geometryKind
 * @returns {{ normalized: string, pdf: string }}
 */
function geometryFieldNames(geometryKind) {
  if (geometryKind === "point") return { normalized: "normalizedPoints", pdf: "pdfPoints" };
  if (geometryKind === "text" || geometryKind === "rectangle") {
    return { normalized: "normalizedBounds", pdf: "pdfQuads" };
  }
  return { normalized: "normalizedQuads", pdf: "pdfQuads" };
}

/**
 * Return the exact, immutable material covered by anchorDigest.
 *
 * @param {unknown} anchor
 * @returns {Readonly<Record<string, unknown>>}
 */
export function spatialAnchorDigestMaterial(anchor) {
  const value = assertPlainObject(anchor, "SPATIAL_DIGEST_INVALID", "anchor");
  const material = /** @type {Record<string, unknown>} */ (cloneJsonValue(value));
  delete material.anchorDigest;
  return deepFreeze(material);
}

/** @param {unknown} anchor @returns {Promise<string>} */
export async function computeSpatialAnchorDigest(anchor) {
  return sha256SpatialText(canonicalSpatialJson(spatialAnchorDigestMaterial(anchor)));
}

/**
 * Mint a canonical spatial anchor from trusted normalized page geometry.
 * PDF coordinates, recipe digest, text digest, and anchor digest are derived.
 *
 * @param {unknown} input
 * @returns {Promise<SpatialAnchor>}
 */
export async function createSpatialAnchor(input) {
  const value = assertPlainObject(input, "SPATIAL_ANCHOR_INVALID", "anchor input");
  const sourceKind = canonicalSourceKind(value.sourceKind);
  const geometryKind = canonicalGeometryKind(value.geometryKind);
  const hasQuote = value.quote !== undefined;
  validateSourceGeometryPair(sourceKind, geometryKind, hasQuote);
  const geometryFields = geometryFieldNames(geometryKind);
  const allowed = [
    "anchorId",
    "paperRef",
    "documentSha256",
    "pageIndex",
    "pageLabel",
    "pageViewBox",
    "rotation",
    "rendererRecipe",
    "sourceKind",
    "geometryKind",
    geometryFields.normalized,
    "quote",
    "textItemRefs",
    "createdBy",
    "createdAt",
  ];
  const required = [
    "anchorId",
    "paperRef",
    "documentSha256",
    "pageIndex",
    "pageLabel",
    "pageViewBox",
    "rotation",
    "rendererRecipe",
    "sourceKind",
    "geometryKind",
    geometryFields.normalized,
    "textItemRefs",
    "createdBy",
    "createdAt",
  ];
  assertClosedObject(value, allowed, required, "SPATIAL_ANCHOR_INVALID", "anchor input");

  const viewBox = canonicalPageViewBox(value.pageViewBox);
  const rotation = pageRotation(value.rotation, "SPATIAL_PAGE_INVALID");
  const recipe = validateSpatialRendererRecipe(value.rendererRecipe);
  if (canonicalSpatialJson(recipe.pageViewBox) !== canonicalSpatialJson(viewBox) || recipe.pageRotation !== rotation) {
    fail("SPATIAL_RENDERER_RECIPE_STALE", "The renderer recipe does not match the anchor page geometry.");
  }
  const rendererRecipeDigest = await computeSpatialRendererRecipeDigest(recipe);
  const geometry = canonicalGeometry(value, geometryKind, viewBox, rotation, false);
  if (
    sourceKind === "whole_page"
    && canonicalSpatialJson(geometry.normalizedBounds) !== canonicalSpatialJson([{ x: 0, y: 0, width: 1, height: 1 }])
  ) {
    fail("SPATIAL_GEOMETRY_INVALID", "Whole-page anchors must cover the complete normalized page.");
  }
  const quote = hasQuote ? await canonicalQuote(value.quote, false) : null;
  const authority = quote ? "exact_document_text" : "client_rendered_pdf";

  /** @type {Record<string, unknown>} */
  const anchor = {
    schemaVersion: SPATIAL_ANCHOR_SCHEMA_VERSION,
    anchorId: boundedString(value.anchorId, "SPATIAL_ANCHOR_INVALID", "anchorId", { max: 128, pattern: ID_PATTERN }),
    paperRef: boundedString(value.paperRef, "SPATIAL_ANCHOR_INVALID", "paperRef", { max: 128, pattern: ID_PATTERN }),
    documentSha256: digest(value.documentSha256, "SPATIAL_ANCHOR_INVALID", "documentSha256"),
    documentRevision: 1,
    pageIndex: finiteNumber(value.pageIndex, "SPATIAL_PAGE_INVALID", "pageIndex", {
      integer: true,
      min: 0,
      max: 100_000,
    }),
    pageLabel: boundedString(value.pageLabel, "SPATIAL_PAGE_INVALID", "pageLabel", { max: 64 }),
    pageViewBox: viewBox,
    rotation,
    coordinateSpace: PDF_COORDINATE_SPACE,
    normalizedCoordinateSpace: NORMALIZED_COORDINATE_SPACE,
    rendererRecipe: recipe,
    rendererRecipeDigest,
    sourceKind,
    geometryKind,
    ...geometry,
    textItemRefs: canonicalTextItemRefs(value.textItemRefs),
    authority,
    createdBy: canonicalCreator(value.createdBy),
    createdAt: canonicalTimestamp(value.createdAt),
  };

  if (quote) anchor.quote = quote;
  if (authority === "client_rendered_pdf") {
    anchor.regionDigest = await sha256SpatialText(canonicalSpatialJson({
      documentSha256: anchor.documentSha256,
      pageIndex: anchor.pageIndex,
      pageViewBox: anchor.pageViewBox,
      rotation: anchor.rotation,
      rendererRecipeDigest,
      sourceKind,
      geometryKind,
      geometry,
    }));
  }

  anchor.anchorDigest = await computeSpatialAnchorDigest(anchor);
  return /** @type {SpatialAnchor} */ (deepFreeze(anchor));
}

/**
 * Validate a persisted or callback-returned canonical anchor and optionally
 * bind it to the active paper, document, page, and renderer recipe.
 *
 * @param {unknown} input
 * @param {SpatialAnchorContext} [expected]
 * @returns {Promise<SpatialAnchor>}
 */
export async function validateSpatialAnchor(input, expected = {}) {
  const value = assertPlainObject(input, "SPATIAL_ANCHOR_INVALID", "anchor");
  const sourceKind = canonicalSourceKind(value.sourceKind);
  const geometryKind = canonicalGeometryKind(value.geometryKind);
  const hasQuote = value.quote !== undefined;
  validateSourceGeometryPair(sourceKind, geometryKind, hasQuote);
  const geometryFields = geometryFieldNames(geometryKind);
  const common = [
    "schemaVersion",
    "anchorId",
    "paperRef",
    "documentSha256",
    "documentRevision",
    "pageIndex",
    "pageLabel",
    "pageViewBox",
    "rotation",
    "coordinateSpace",
    "normalizedCoordinateSpace",
    "rendererRecipe",
    "rendererRecipeDigest",
    "sourceKind",
    "geometryKind",
    geometryFields.normalized,
    geometryFields.pdf,
    "textItemRefs",
    "authority",
    "createdBy",
    "createdAt",
    "anchorDigest",
  ];
  const allowed = [
    ...common,
    ...(hasQuote ? ["quote"] : []),
    ...(value.regionDigest !== undefined ? ["regionDigest"] : []),
  ];
  assertClosedObject(value, allowed, common, "SPATIAL_ANCHOR_INVALID", "anchor");
  if (
    value.schemaVersion !== SPATIAL_ANCHOR_SCHEMA_VERSION
    || value.documentRevision !== 1
    || value.coordinateSpace !== PDF_COORDINATE_SPACE
    || value.normalizedCoordinateSpace !== NORMALIZED_COORDINATE_SPACE
  ) {
    fail("SPATIAL_ANCHOR_INVALID", "The spatial anchor contract is unsupported.");
  }

  const viewBox = canonicalPageViewBox(value.pageViewBox);
  const rotation = pageRotation(value.rotation, "SPATIAL_PAGE_INVALID");
  const recipe = validateSpatialRendererRecipe(value.rendererRecipe);
  if (canonicalSpatialJson(recipe.pageViewBox) !== canonicalSpatialJson(viewBox) || recipe.pageRotation !== rotation) {
    fail("SPATIAL_RENDERER_RECIPE_STALE", "The anchor renderer recipe no longer matches its page geometry.");
  }
  const actualRecipeDigest = await computeSpatialRendererRecipeDigest(recipe);
  const claimedRecipeDigest = digest(
    value.rendererRecipeDigest,
    "SPATIAL_RENDERER_RECIPE_INVALID",
    "rendererRecipeDigest",
  );
  if (actualRecipeDigest !== claimedRecipeDigest) {
    fail("SPATIAL_RENDERER_RECIPE_STALE", "The anchor renderer recipe digest is stale or changed.");
  }
  const geometry = canonicalGeometry(value, geometryKind, viewBox, rotation, true);
  if (
    sourceKind === "whole_page"
    && canonicalSpatialJson(geometry.normalizedBounds) !== canonicalSpatialJson([{ x: 0, y: 0, width: 1, height: 1 }])
  ) {
    fail("SPATIAL_GEOMETRY_INVALID", "Whole-page anchors must cover the complete normalized page.");
  }
  const quote = hasQuote ? await canonicalQuote(value.quote, true) : null;
  const expectedAuthority = quote ? "exact_document_text" : "client_rendered_pdf";
  if (value.authority !== expectedAuthority) {
    fail("SPATIAL_ANCHOR_INVALID", "Anchor authority is inconsistent with its source evidence.");
  }

  /** @type {Record<string, unknown>} */
  const anchor = {
    schemaVersion: SPATIAL_ANCHOR_SCHEMA_VERSION,
    anchorId: boundedString(value.anchorId, "SPATIAL_ANCHOR_INVALID", "anchorId", { max: 128, pattern: ID_PATTERN }),
    paperRef: boundedString(value.paperRef, "SPATIAL_ANCHOR_INVALID", "paperRef", { max: 128, pattern: ID_PATTERN }),
    documentSha256: digest(value.documentSha256, "SPATIAL_ANCHOR_INVALID", "documentSha256"),
    documentRevision: 1,
    pageIndex: finiteNumber(value.pageIndex, "SPATIAL_PAGE_INVALID", "pageIndex", {
      integer: true,
      min: 0,
      max: 100_000,
    }),
    pageLabel: boundedString(value.pageLabel, "SPATIAL_PAGE_INVALID", "pageLabel", { max: 64 }),
    pageViewBox: viewBox,
    rotation,
    coordinateSpace: PDF_COORDINATE_SPACE,
    normalizedCoordinateSpace: NORMALIZED_COORDINATE_SPACE,
    rendererRecipe: recipe,
    rendererRecipeDigest: claimedRecipeDigest,
    sourceKind,
    geometryKind,
    ...geometry,
    textItemRefs: canonicalTextItemRefs(value.textItemRefs),
    authority: expectedAuthority,
    createdBy: canonicalCreator(value.createdBy),
    createdAt: canonicalTimestamp(value.createdAt),
  };

  if (quote) anchor.quote = quote;
  if (value.regionDigest !== undefined) {
    const claimedRegionDigest = digest(value.regionDigest, "SPATIAL_ANCHOR_INVALID", "regionDigest");
    if (expectedAuthority !== "client_rendered_pdf") {
      fail("SPATIAL_ANCHOR_INVALID", "Exact-document anchors cannot claim a rendered-region digest.");
    }
    const expectedRegionDigest = await sha256SpatialText(canonicalSpatialJson({
      documentSha256: anchor.documentSha256,
      pageIndex: anchor.pageIndex,
      pageViewBox: anchor.pageViewBox,
      rotation: anchor.rotation,
      rendererRecipeDigest: anchor.rendererRecipeDigest,
      sourceKind,
      geometryKind,
      geometry,
    }));
    if (claimedRegionDigest !== expectedRegionDigest) {
      fail("SPATIAL_REGION_DIGEST_MISMATCH", "regionDigest does not match the rendered page geometry.");
    }
    anchor.regionDigest = claimedRegionDigest;
  }

  const claimedAnchorDigest = digest(value.anchorDigest, "SPATIAL_ANCHOR_INVALID", "anchorDigest");
  anchor.anchorDigest = claimedAnchorDigest;
  if (await computeSpatialAnchorDigest(anchor) !== claimedAnchorDigest) {
    fail("SPATIAL_ANCHOR_DIGEST_MISMATCH", "anchorDigest does not match the canonical spatial anchor.");
  }

  const context = assertPlainObject(expected, "SPATIAL_CONTEXT_INVALID", "expected anchor context");
  assertClosedObject(
    context,
    ["paperRef", "documentSha256", "pageIndex", "rendererRecipe", "rendererRecipeDigest"],
    [],
    "SPATIAL_CONTEXT_INVALID",
    "expected anchor context",
  );
  if (context.paperRef !== undefined && context.paperRef !== anchor.paperRef) {
    fail("SPATIAL_FOREIGN_PAPER", "The spatial anchor belongs to another paper.");
  }
  if (context.documentSha256 !== undefined && context.documentSha256 !== anchor.documentSha256) {
    fail("SPATIAL_FOREIGN_DOCUMENT", "The spatial anchor belongs to different PDF bytes.");
  }
  if (context.pageIndex !== undefined && context.pageIndex !== anchor.pageIndex) {
    fail("SPATIAL_FOREIGN_PAGE", "The spatial anchor belongs to another page.");
  }
  let expectedRecipeDigest;
  if (context.rendererRecipe !== undefined) {
    expectedRecipeDigest = await computeSpatialRendererRecipeDigest(context.rendererRecipe);
  }
  if (context.rendererRecipeDigest !== undefined) {
    const provided = digest(
      context.rendererRecipeDigest,
      "SPATIAL_CONTEXT_INVALID",
      "expected.rendererRecipeDigest",
    );
    if (expectedRecipeDigest !== undefined && expectedRecipeDigest !== provided) {
      fail("SPATIAL_CONTEXT_INVALID", "The expected renderer recipe and digest disagree.");
    }
    expectedRecipeDigest = provided;
  }
  if (expectedRecipeDigest !== undefined && expectedRecipeDigest !== anchor.rendererRecipeDigest) {
    fail("SPATIAL_RENDERER_RECIPE_STALE", "The spatial anchor was minted for a stale renderer recipe.");
  }

  return /** @type {SpatialAnchor} */ (deepFreeze(anchor));
}
