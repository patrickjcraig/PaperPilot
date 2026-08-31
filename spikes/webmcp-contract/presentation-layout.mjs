/**
 * Presentation-only ordering and layout helpers for the PaperPilot spike.
 *
 * The values returned here are view preferences. They must stay outside the
 * canonical annotation, source-anchor, graph, evidence, and semantic-digest
 * records. In particular, these helpers operate on explicit IDs and copied
 * coordinates; they never accept or mutate a source anchor.
 */

const EXPLICIT_KEY_PATTERN = /^[a-z][a-z0-9:_-]{2,127}$/u;

export const DEFAULT_GRAPH_BOUNDS = Object.freeze({
  minX: -10_000,
  maxX: 10_000,
  minY: -10_000,
  maxY: 10_000,
});

export const DEFAULT_GRAPH_NUDGE = 0.25;

const DIRECTION_DELTAS = Object.freeze({
  up: Object.freeze({ x: 0, y: -1 }),
  ArrowUp: Object.freeze({ x: 0, y: -1 }),
  right: Object.freeze({ x: 1, y: 0 }),
  ArrowRight: Object.freeze({ x: 1, y: 0 }),
  down: Object.freeze({ x: 0, y: 1 }),
  ArrowDown: Object.freeze({ x: 0, y: 1 }),
  left: Object.freeze({ x: -1, y: 0 }),
  ArrowLeft: Object.freeze({ x: -1, y: 0 }),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExplicitKey(value) {
  return typeof value === "string" && EXPLICIT_KEY_PATTERN.test(value);
}

function copiedExplicitKeys(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const keys = [];
  for (const candidate of value) {
    if (!isExplicitKey(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    keys.push(candidate);
  }
  return keys;
}

function currentKeySet(value) {
  if (value === undefined) return null;
  if (typeof value === "string" || value === null || typeof value?.[Symbol.iterator] !== "function") {
    return undefined;
  }
  const keys = new Set();
  for (const candidate of value) {
    if (isExplicitKey(candidate)) keys.add(candidate);
  }
  return keys;
}

function freezeArray(value) {
  return Object.freeze([...value]);
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function withoutNegativeZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

function normalizeBounds(bounds) {
  if (!isRecord(bounds)) return DEFAULT_GRAPH_BOUNDS;
  const { minX, maxX, minY, maxY } = bounds;
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY) ||
    minX >= maxX ||
    minY >= maxY
  ) {
    return DEFAULT_GRAPH_BOUNDS;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Reconciles a saved view order with the IDs that currently exist.
 *
 * Surviving IDs retain the saved order. Newly observed IDs are appended in
 * lexical key order so Map/Graphology insertion order never becomes identity.
 * Stale, duplicate, malformed, and foreign IDs are ignored.
 */
export function reconcileAnnotationOrder(order, currentIds) {
  const current = copiedExplicitKeys(currentIds);
  const currentSet = new Set(current);
  const reconciled = [];
  const included = new Set();

  for (const key of copiedExplicitKeys(order)) {
    if (!currentSet.has(key) || included.has(key)) continue;
    included.add(key);
    reconciled.push(key);
  }

  const missing = current.filter((key) => !included.has(key)).sort((left, right) => left.localeCompare(right));
  return freezeArray([...reconciled, ...missing]);
}

/**
 * Moves one annotation before or after another annotation in view state.
 * Unknown IDs, self-targeting moves, and invalid placements are safe no-ops.
 */
export function moveAnnotation(order, id, targetId, placement) {
  const normalized = reconcileAnnotationOrder(order, order);
  if (
    !isExplicitKey(id) ||
    !isExplicitKey(targetId) ||
    id === targetId ||
    (placement !== "before" && placement !== "after") ||
    !normalized.includes(id) ||
    !normalized.includes(targetId)
  ) {
    return normalized;
  }

  const moved = normalized.filter((key) => key !== id);
  const targetIndex = moved.indexOf(targetId);
  moved.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, id);
  return freezeArray(moved);
}

export function moveAnnotationBefore(order, id, targetId) {
  return moveAnnotation(order, id, targetId, "before");
}

export function moveAnnotationAfter(order, id, targetId) {
  return moveAnnotation(order, id, targetId, "after");
}

/**
 * Copies and bounds a graph view position. Non-finite components fail closed
 * to the layout origin rather than entering Sigma or a serialized preference.
 */
export function clampGraphPosition(position, bounds = DEFAULT_GRAPH_BOUNDS) {
  const safeBounds = normalizeBounds(bounds);
  const x = Math.min(safeBounds.maxX, Math.max(safeBounds.minX, finiteOrZero(position?.x)));
  const y = Math.min(safeBounds.maxY, Math.max(safeBounds.minY, finiteOrZero(position?.y)));
  return Object.freeze({ x: withoutNegativeZero(x), y: withoutNegativeZero(y) });
}

/**
 * Keyboard-equivalent graph movement. Arrow-key names and plain directions
 * share exactly the same path as pointer layout updates: copy, nudge, clamp.
 * Invalid directions or explicit step values are safe no-ops.
 */
export function nudgeGraphPosition(position, direction, options = {}) {
  const bounds = isRecord(options) && options.bounds !== undefined
    ? normalizeBounds(options.bounds)
    : DEFAULT_GRAPH_BOUNDS;
  const current = clampGraphPosition(position, bounds);
  const delta = DIRECTION_DELTAS[direction];
  if (!delta) return current;

  const suppliedStep = isRecord(options) && Object.hasOwn(options, "step");
  const step = suppliedStep ? options.step : DEFAULT_GRAPH_NUDGE;
  if (!Number.isFinite(step) || step <= 0) return current;

  return clampGraphPosition({
    x: current.x + delta.x * step,
    y: current.y + delta.y * step,
  }, bounds);
}

/**
 * Resolves one stable node key linked by an annotation.
 *
 * When currentNodeKeys is supplied, stale/tombstoned/foreign keys are ignored.
 * Lexical selection deliberately avoids treating array or graph insertion order
 * as semantic identity. Malformed annotations/current-key collections yield
 * null and never mutate the annotation.
 */
export function resolvePrimaryGraphNodeKey(annotation, currentNodeKeys) {
  if (!isRecord(annotation) || !Array.isArray(annotation.graphNodeKeys)) return null;
  const current = currentKeySet(currentNodeKeys);
  if (current === undefined) return null;

  const candidates = copiedExplicitKeys(annotation.graphNodeKeys)
    .filter((key) => current === null || current.has(key))
    .sort((left, right) => left.localeCompare(right));
  return candidates[0] ?? null;
}
