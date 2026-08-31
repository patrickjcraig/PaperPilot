import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GRAPH_BOUNDS,
  DEFAULT_GRAPH_NUDGE,
  clampGraphPosition,
  moveAnnotation,
  moveAnnotationAfter,
  moveAnnotationBefore,
  nudgeGraphPosition,
  reconcileAnnotationOrder,
  resolvePrimaryGraphNodeKey,
} from "./presentation-layout.mjs";

test("annotation order keeps saved survivors and appends new explicit keys deterministically", () => {
  const saved = ["annotation:beta", "annotation:stale", "annotation:alpha", "annotation:beta"];
  const current = ["annotation:zeta", "annotation:alpha", "annotation:beta", "annotation:gamma"];
  const result = reconcileAnnotationOrder(saved, current);

  assert.deepEqual(result, [
    "annotation:beta",
    "annotation:alpha",
    "annotation:gamma",
    "annotation:zeta",
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(saved, ["annotation:beta", "annotation:stale", "annotation:alpha", "annotation:beta"]);
  assert.deepEqual(current, ["annotation:zeta", "annotation:alpha", "annotation:beta", "annotation:gamma"]);
});

test("annotation reconciliation fails safely for malformed and unknown IDs", () => {
  assert.deepEqual(
    reconcileAnnotationOrder(["annotation:known", " BAD ", 42], ["annotation:known", "x", null]),
    ["annotation:known"],
  );
  assert.deepEqual(reconcileAnnotationOrder(null, null), []);
  assert.equal(Object.isFrozen(reconcileAnnotationOrder(null, null)), true);
});

test("pointer-style before/after movement is immutable and keyboard reusable", () => {
  const order = ["annotation:one", "annotation:two", "annotation:three"];

  assert.deepEqual(
    moveAnnotation(order, "annotation:three", "annotation:one", "before"),
    ["annotation:three", "annotation:one", "annotation:two"],
  );
  assert.deepEqual(
    moveAnnotationBefore(order, "annotation:three", "annotation:two"),
    ["annotation:one", "annotation:three", "annotation:two"],
  );
  const after = moveAnnotationAfter(order, "annotation:one", "annotation:three");
  assert.deepEqual(after, ["annotation:two", "annotation:three", "annotation:one"]);
  assert.equal(Object.isFrozen(after), true);
  assert.deepEqual(order, ["annotation:one", "annotation:two", "annotation:three"]);
});

test("unknown annotation move targets and placements are frozen no-ops", () => {
  const order = ["annotation:one", "annotation:two"];
  for (const result of [
    moveAnnotation(order, "annotation:missing", "annotation:two", "before"),
    moveAnnotation(order, "annotation:one", "annotation:missing", "after"),
    moveAnnotation(order, "annotation:one", "annotation:two", "sideways"),
    moveAnnotation(order, "annotation:one", "annotation:one", "before"),
  ]) {
    assert.deepEqual(result, order);
    assert.notEqual(result, order);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("graph positions are copied, finite, bounded, and frozen", () => {
  const source = { x: 12.5, y: -7.25 };
  const copied = clampGraphPosition(source);
  source.x = 99;
  assert.deepEqual(copied, { x: 12.5, y: -7.25 });
  assert.equal(Object.isFrozen(copied), true);

  assert.deepEqual(
    clampGraphPosition({ x: Number.POSITIVE_INFINITY, y: Number.NaN }),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    clampGraphPosition({ x: 9, y: -9 }, { minX: -2, maxX: 3, minY: -4, maxY: 5 }),
    { x: 3, y: -4 },
  );
  assert.deepEqual(
    clampGraphPosition({ x: 99_999, y: -99_999 }, { minX: 2, maxX: 2, minY: 1, maxY: 3 }),
    { x: DEFAULT_GRAPH_BOUNDS.maxX, y: DEFAULT_GRAPH_BOUNDS.minY },
  );
});

test("arrow keys and named directions use the same bounded nudge path", () => {
  const bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  assert.equal(DEFAULT_GRAPH_NUDGE, 0.25);
  assert.deepEqual(nudgeGraphPosition({ x: 0, y: 0 }, "up", { bounds }), { x: 0, y: -0.25 });
  assert.deepEqual(nudgeGraphPosition({ x: 0, y: 0 }, "ArrowUp", { bounds }), { x: 0, y: -0.25 });
  assert.deepEqual(nudgeGraphPosition({ x: 0, y: 0 }, "right", { bounds, step: 0.5 }), { x: 0.5, y: 0 });
  assert.deepEqual(nudgeGraphPosition({ x: 0, y: 0 }, "ArrowDown", { bounds, step: 0.5 }), { x: 0, y: 0.5 });
  assert.deepEqual(nudgeGraphPosition({ x: -0.8, y: 0 }, "left", { bounds, step: 0.5 }), { x: -1, y: 0 });
});

test("invalid directions and nudge steps fail as immutable no-ops", () => {
  const source = { x: 0.5, y: -0.5 };
  for (const result of [
    nudgeGraphPosition(source, "diagonal"),
    nudgeGraphPosition(source, null),
    nudgeGraphPosition(source, "left", { step: 0 }),
    nudgeGraphPosition(source, "left", { step: Number.NaN }),
  ]) {
    assert.deepEqual(result, source);
    assert.notEqual(result, source);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("primary graph node resolution uses stable current keys, never insertion order", () => {
  const annotation = {
    annotationId: "annotation:reader:0001",
    anchorId: "anchor:reader:0001",
    graphNodeKeys: ["node:zeta", "node:alpha", "node:stale"],
  };
  const before = structuredClone(annotation);

  assert.equal(
    resolvePrimaryGraphNodeKey(annotation, new Set(["node:zeta", "node:alpha"])),
    "node:alpha",
  );
  assert.equal(resolvePrimaryGraphNodeKey(annotation, ["node:zeta"]), "node:zeta");
  assert.equal(resolvePrimaryGraphNodeKey(annotation), "node:alpha");
  assert.deepEqual(annotation, before);
});

test("primary graph node resolution fails safely when links are stale or malformed", () => {
  assert.equal(resolvePrimaryGraphNodeKey({ graphNodeKeys: ["node:stale"] }, []), null);
  assert.equal(resolvePrimaryGraphNodeKey({ graphNodeKeys: ["bad key", 7] }, ["node:valid"]), null);
  assert.equal(resolvePrimaryGraphNodeKey({}, ["node:valid"]), null);
  assert.equal(resolvePrimaryGraphNodeKey(null, ["node:valid"]), null);
  assert.equal(resolvePrimaryGraphNodeKey({ graphNodeKeys: ["node:valid"] }, "node:valid"), null);
});
