import assert from "node:assert/strict";
import test from "node:test";
import { MultiDirectedGraph } from "graphology";

import {
  WORKSPACE_PATCH_LIMITS,
  WorkspacePatchError,
  applyWorkspacePatch,
  createWorkspacePatch,
  invertWorkspacePatch,
  validateWorkspacePatch,
} from "./workspace-patch.mjs";
import { createSpikeState } from "./contracts.mjs";
import { createSpatialAnchor, createSpatialRendererRecipe } from "./spatial-anchor.mjs";

const PAPER = Object.freeze({ paperRef: "paper:patch-fixture", documentSha256: "a".repeat(64), pageCount: 3 });
const NOW = "2026-09-01T12:00:00.000Z";
const LATER = "2026-09-01T12:01:00.000Z";
const DISPLAY_FIELDS = ["x", "y", "size", "color", "hidden", "selected", "hovered", "hover", "highlighted", "dragged", "dragging", "forceLabel", "zIndex", "labelColor", "borderColor", "borderSize", "type", "layout", "layoutOrder", "annotationOrder", "camera", "animation", "fixed", "fx", "fy", "vx", "vy"];

function anchor(key = "anchor:text:one", overrides = {}) {
  return {
    anchorId: key, paperRef: PAPER.paperRef, documentSha256: PAPER.documentSha256,
    pageIndex: 0, pageLabel: "1", sourceKind: "exact_text", authority: "exact_document_text",
    normalizedBounds: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    exactText: "An exact source sentence.", exactTextSha256: "b".repeat(64),
    pageViewBox: [0, 0, 612, 792], pageRotation: 0,
    anchorDigest: "c".repeat(64), createdAt: NOW, createdBy: "human", ...overrides,
  };
}

function node(overrides = {}) {
  return {
    kind: "concept", label: "Exact-source concept", summary: "Reader-authored explanation.",
    authority: "reader_authored", sourceAnchorIds: ["anchor:text:one"], structuralCoverage: [],
    origin: "reader", status: "active", entityRevision: 1, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function edge(overrides = {}) {
  return {
    kind: "appears_in", claim: "The selection occurs in this paper.",
    authority: "reader_authored", sourceAnchorIds: ["anchor:text:one"],
    origin: "reader", status: "active", entityRevision: 1, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function annotation(key = "annotation:one", overrides = {}) {
  return {
    annotationId: key, paperRef: PAPER.paperRef, anchorId: "anchor:text:one", kind: "highlight",
    label: "My question", body: "Explain this idea.", graphNodeKeys: ["node:one"], graphEdgeKeys: ["edge:one"],
    authority: "reader", status: "active", entityRevision: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function fixture() {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  graph.replaceAttributes({ title: "Renderer-only graph container", camera: { ratio: 1.2 } });
  const page = anchor("anchor:page:1", {
    sourceKind: "whole_page", authority: "client_rendered_pdf", normalizedBounds: [{ x: 0, y: 0, width: 1, height: 1 }],
  });
  delete page.exactText; delete page.exactTextSha256;
  graph.addNode("node:paper", node({ kind: "paper", label: "Patch fixture paper", authority: "document_structure", sourceAnchorIds: [], origin: "system",
    structuralCoverage: [{ startPageIndex: 0, endPageIndex: 2, primaryAnchorId: "anchor:page:1" }], structuralBasis: "paper_root", structuralConfidence: "document_declared", x: 1, y: 2 }));
  graph.addNode("node:one", node({ x: 10, y: 20, color: "#fff", layout: { viewport: [2, 3] } }));
  graph.addDirectedEdgeWithKey("edge:one", "node:one", "node:paper", edge({ color: "#aaa", size: 1.5 }));
  return { anchors: new Map([[page.anchorId, page], ["anchor:text:one", anchor()]]), graph,
    annotations: new Map([["annotation:one", annotation()]]), paper: { ...PAPER } };
}

function clone(state) {
  const graph = state.graph.nullCopy();
  graph.replaceAttributes(structuredClone(state.graph.getAttributes()));
  for (const key of state.graph.nodes()) graph.addNode(key, structuredClone(state.graph.getNodeAttributes(key)));
  for (const key of state.graph.edges()) graph.addDirectedEdgeWithKey(key, state.graph.source(key), state.graph.target(key), structuredClone(state.graph.getEdgeAttributes(key)));
  return { anchors: structuredClone(state.anchors), graph, annotations: structuredClone(state.annotations), ...(state.paper ? { paper: structuredClone(state.paper) } : {}) };
}

function snapshot(state) {
  return {
    anchors: [...state.anchors].sort(([a], [b]) => a.localeCompare(b)),
    nodes: state.graph.nodes().sort().map((key) => [key, state.graph.getNodeAttributes(key)]),
    edges: state.graph.edges().sort().map((key) => [key, state.graph.source(key), state.graph.target(key), state.graph.getEdgeAttributes(key)]),
    annotations: [...state.annotations].sort(([a], [b]) => a.localeCompare(b)),
    graphAttributes: state.graph.getAttributes(),
  };
}

function canonicalSnapshot(state) {
  const result = structuredClone(snapshot(state));
  for (const [, attributes] of result.nodes) for (const field of DISPLAY_FIELDS) delete attributes[field];
  for (const [, , , attributes] of result.edges) for (const field of DISPLAY_FIELDS) delete attributes[field];
  delete result.graphAttributes;
  return result;
}

function changedNode(state, key = "node:one", change = { label: "A revised explanation", entityRevision: 2, updatedAt: LATER }) {
  const after = clone(state);
  after.graph.mergeNodeAttributes(key, change);
  return after;
}

function record(state, op, key) {
  if (op === "put_node") return { key, ...Object.fromEntries(Object.entries(state.graph.getNodeAttributes(key)).filter(([field]) => !DISPLAY_FIELDS.includes(field))) };
  if (op === "put_edge") return { key, sourceKey: state.graph.source(key), targetKey: state.graph.target(key),
    ...Object.fromEntries(Object.entries(state.graph.getEdgeAttributes(key)).filter(([field]) => !DISPLAY_FIELDS.includes(field))) };
  return structuredClone((op === "put_anchor" ? state.anchors : state.annotations).get(key));
}

function operation(state, op, key, change) {
  const before = record(state, op, key);
  return { op, key, before, after: change === null ? null : { ...before, ...change } };
}

function rejectsWithoutMutation(state, patch, code = "workspace_patch_invalid") {
  const before = structuredClone(snapshot(state));
  assert.throws(() => applyWorkspacePatch(state, patch), (error) => error instanceof WorkspacePatchError && error.code === code);
  assert.deepEqual(snapshot(state), before);
}

test("uses real nonempty Graphology clones and preserves exact lifecycle records through apply/invert/reapply", () => {
  const before = fixture();
  const unchanged = structuredClone(snapshot(before));
  const after = changedNode(before);
  const { forwardPatch, inversePatch } = createWorkspacePatch(before, after);
  assert.equal(forwardPatch.length, 1);
  assert.equal(forwardPatch[0].op, "put_node");
  assert.equal(forwardPatch[0].before.createdAt, NOW);
  assert.equal(forwardPatch[0].after.updatedAt, LATER);
  assert.equal(forwardPatch[0].after.entityRevision, 2);
  const applied = applyWorkspacePatch(before, forwardPatch);
  assert.notEqual(applied.graph, before.graph);
  assert.notEqual(applied.anchors, before.anchors);
  assert.notEqual(applied.annotations, before.annotations);
  assert.deepEqual(snapshot(applied), snapshot(after));
  assert.deepEqual(snapshot(applyWorkspacePatch(applied, inversePatch)), unchanged);
  assert.deepEqual(snapshot(applyWorkspacePatch(applyWorkspacePatch(applied, inversePatch), forwardPatch)), snapshot(after));
  assert.deepEqual(snapshot(before), unchanged);
  assert.deepEqual(invertWorkspacePatch(inversePatch), forwardPatch);
});

test("new reader anchor, node, parallel evidence edges, and annotation are an atomic reversible patch", () => {
  const before = fixture();
  const after = clone(before);
  after.anchors.set("anchor:text:two", anchor("anchor:text:two", { pageIndex: 1, pageLabel: "2", anchorDigest: "d".repeat(64) }));
  after.graph.addNode("node:two", node({ label: "Second source", sourceAnchorIds: ["anchor:text:two"], x: 55, y: 45 }));
  for (const key of ["edge:two", "edge:two:parallel"]) after.graph.addDirectedEdgeWithKey(key, "node:two", "node:one", edge({ sourceAnchorIds: ["anchor:text:two"] }));
  after.annotations.set("annotation:two", annotation("annotation:two", { anchorId: "anchor:text:two", graphNodeKeys: ["node:two"], graphEdgeKeys: ["edge:two", "edge:two:parallel"] }));
  const { forwardPatch, inversePatch } = createWorkspacePatch(before, after);
  assert.deepEqual(forwardPatch.map(({ op }) => op), ["put_anchor", "put_node", "put_edge", "put_edge", "put_annotation"]);
  const applied = applyWorkspacePatch(before, [...forwardPatch].reverse());
  assert.deepEqual(canonicalSnapshot(applied), canonicalSnapshot(after));
  assert.equal(applied.graph.getNodeAttribute("node:two", "x"), undefined, "new renderer coordinates are not transported by history");
  const restored = applyWorkspacePatch(applied, inversePatch);
  assert.deepEqual(snapshot(restored), snapshot(before));
  assert.equal(restored.anchors.has("anchor:text:two"), false, "Undo removes the newly minted anchor too");
  assert.deepEqual(canonicalSnapshot(applyWorkspacePatch(restored, forwardPatch)), canonicalSnapshot(after));
});

test("diffs are insertion-order independent, detached, frozen, and omit every renderer field", () => {
  const before = fixture();
  const after = changedNode(before);
  for (const [index, field] of DISPLAY_FIELDS.entries()) after.graph.setNodeAttribute("node:one", field, { displayValue: index });
  const expected = createWorkspacePatch(before, after);
  const reversed = clone(after);
  const attributes = reversed.graph.getNodeAttributes("node:one");
  reversed.graph.replaceNodeAttributes("node:one", Object.fromEntries(Object.entries(attributes).reverse()));
  reversed.anchors = new Map([...reversed.anchors].reverse());
  assert.deepEqual(createWorkspacePatch(before, reversed), expected);
  assert.equal(Object.isFrozen(expected.forwardPatch), true);
  assert.equal(Object.isFrozen(expected.forwardPatch[0].after.sourceAnchorIds), true);
  for (const field of DISPLAY_FIELDS) assert.equal(Object.hasOwn(expected.forwardPatch[0].after, field), false, field);
  after.graph.getNodeAttributes("node:one").sourceAnchorIds.push("anchor:not-part-of-patch");
  assert.deepEqual(expected.forwardPatch[0].after.sourceAnchorIds, ["anchor:text:one"]);
  const raw = structuredClone(expected.forwardPatch);
  const validated = validateWorkspacePatch(raw);
  raw[0].after.sourceAnchorIds.push("anchor:mutated-after-validation");
  assert.deepEqual(validated[0].after.sourceAnchorIds, ["anchor:text:one"]);
});

test("display-only arrangements are empty semantic patches and current surviving presentation wins on replay", () => {
  const before = fixture();
  const arranged = clone(before);
  arranged.graph.mergeNodeAttributes("node:one", { x: 500, y: -12, hidden: true, highlighted: true });
  arranged.graph.mergeEdgeAttributes("edge:one", { color: "red", size: 6 });
  assert.deepEqual(createWorkspacePatch(before, arranged), { forwardPatch: [], inversePatch: [] });
  const { forwardPatch } = createWorkspacePatch(before, changedNode(before));
  const applied = applyWorkspacePatch(arranged, forwardPatch);
  for (const name of ["x", "y", "hidden", "highlighted"]) assert.equal(applied.graph.getNodeAttribute("node:one", name), arranged.graph.getNodeAttribute("node:one", name));
  assert.equal(applied.graph.getEdgeAttribute("edge:one", "color"), "red");
  assert.equal(applied.graph.getNodeAttribute("node:one", "label"), "A revised explanation");
  assert.deepEqual(snapshot(applyWorkspacePatch(before, [])), snapshot(before));
});

test("applied output has no mutable aliases to original state, patch, or another result", () => {
  const before = fixture();
  const { forwardPatch } = createWorkspacePatch(before, changedNode(before));
  const first = applyWorkspacePatch(before, forwardPatch);
  const second = applyWorkspacePatch(before, forwardPatch);
  const stable = structuredClone(snapshot(before));
  first.graph.getNodeAttributes("node:one").sourceAnchorIds.push("anchor:foreign");
  first.graph.getNodeAttributes("node:one").layout.viewport[0] = 99;
  first.graph.getAttributes().camera.ratio = 90;
  first.graph.getEdgeAttributes("edge:one").sourceAnchorIds.push("anchor:foreign");
  assert.throws(() => { first.anchors.get("anchor:text:one").normalizedBounds[0].x = 0.6; }, TypeError);
  assert.equal(Object.isFrozen(first.anchors.get("anchor:text:one")), true);
  first.annotations.get("annotation:one").graphNodeKeys.length = 0;
  assert.deepEqual(snapshot(before), stable);
  assert.deepEqual(snapshot(second), snapshot(changedNode(before)));
  assert.deepEqual(forwardPatch[0].after.sourceAnchorIds, ["anchor:text:one"]);
});

test("expected-before preconditions include semantic and lifecycle fields but exclude presentation", () => {
  const before = fixture();
  const { forwardPatch } = createWorkspacePatch(before, changedNode(before));
  for (const change of [{ label: "Concurrent change" }, { entityRevision: 7 }, { updatedAt: LATER }, { sourceAnchorIds: ["anchor:page:1"] }]) {
    rejectsWithoutMutation(changedNode(before, "node:one", change), forwardPatch, "workspace_patch_conflict");
  }
  const staleCreation = [{ op: "put_node", key: "node:one", before: null, after: record(before, "put_node", "node:one") }];
  rejectsWithoutMutation(before, staleCreation, "workspace_patch_conflict");
  const forgedBefore = structuredClone(forwardPatch);
  forgedBefore[0].before.label = "A forged expected value";
  rejectsWithoutMutation(before, forgedBefore, "workspace_patch_conflict");
});

test("semantic field tampering cannot hide in presentation-shaped or open record keys", () => {
  const state = fixture();
  const patch = [operation(state, "put_node", "node:one", { label: "Changed" })];
  for (const field of [...DISPLAY_FIELDS, "reviewed", "confidence", "unknownCanonicalField"]) {
    const malformed = structuredClone(patch); malformed[0].after[field] = 1;
    rejectsWithoutMutation(state, malformed);
  }
  const missingSummary = structuredClone(patch); delete missingSummary[0].after.summary;
  rejectsWithoutMutation(state, missingSummary);
});

test("requires exact closed patch envelopes, unique op/key pairs, and matching record identities", () => {
  const state = fixture();
  const entry = operation(state, "put_node", "node:one", { label: "Changed" });
  const invalidPatches = [
    {}, null, [entry, entry], [{ ...entry, unexpected: true }], [{ ...entry, op: "remove_node" }],
    [{ ...entry, op: "__proto__" }], [{ ...entry, key: "not a key" }], [{ ...entry, before: null, after: null }],
    [{ ...entry, after: entry.before }], [{ op: entry.op, key: entry.key, before: entry.before }],
    [{ ...entry, after: { ...entry.after, key: "node:wrong" } }],
    [{ ...entry, after: { ...entry.after, sourceAnchorIds: ["anchor:text:one", "anchor:text:one"] } }],
    [{ ...entry, after: { ...entry.after, entityRevision: 1.5 } }],
    [{ ...entry, after: { ...entry.after, status: "purged" } }],
    [{ ...entry, after: { ...entry.after, origin: "model" } }],
    [{ ...entry, after: { ...entry.after, authority: "scientifically_verified" } }],
  ];
  for (const patch of invalidPatches) rejectsWithoutMutation(state, patch);
});

test("rejects non-JSON objects, hidden fields, cycles, symbols, binary payloads, and accessors without invoking them", () => {
  const state = fixture();
  const fresh = () => [operation(state, "put_node", "node:one", { label: "Changed" })];
  let getterCalls = 0;
  const cases = [];
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), new Uint8Array([1]), () => {}, /re/u]) {
    const patch = fresh(); patch[0].after.summary = value; cases.push(patch);
  }
  const cyclic = fresh(); cyclic[0].after.summary = cyclic; cases.push(cyclic);
  const getter = fresh(); Object.defineProperty(getter[0].after, "summary", { enumerable: true, get() { getterCalls += 1; return "secret"; } }); cases.push(getter);
  const arrayGetter = fresh(); Object.defineProperty(arrayGetter, "0", { enumerable: true, get() { getterCalls += 1; return fresh()[0]; } }); cases.push(arrayGetter);
  const symbol = fresh(); symbol[0].after[Symbol("hidden")] = true; cases.push(symbol);
  const arraySymbol = fresh(); arraySymbol[Symbol("hidden")] = true; cases.push(arraySymbol);
  const nonenumerable = fresh(); Object.defineProperty(nonenumerable[0].after, "hiddenData", { value: "secret" }); cases.push(nonenumerable);
  const arrayHidden = fresh(); Object.defineProperty(arrayHidden, "hiddenData", { value: "secret" }); cases.push(arrayHidden);
  const sparse = fresh(); sparse.length = 2; cases.push(sparse);
  const inherited = fresh(); Object.setPrototypeOf(inherited[0].after, { injected: "value" }); cases.push(inherited);
  const polluted = fresh(); Object.defineProperty(polluted[0].after, "__proto__", { enumerable: true, value: { unsafe: true } }); cases.push(polluted);
  for (const field of ["pdfBytes", "pdfData", "rawFile", "arrayBuffer", "dataUrl", "objectUrl", "constructor", "prototype"]) {
    const patch = fresh(); patch[0].after[field] = "not allowed"; cases.push(patch);
  }
  for (const patch of cases) rejectsWithoutMutation(state, patch);
  assert.equal(getterCalls, 0);
});

test("rejects record and payload resource overruns before touching live collections", () => {
  const state = fixture();
  const entry = operation(state, "put_node", "node:one", { label: "Changed" });
  rejectsWithoutMutation(state, Array.from({ length: WORKSPACE_PATCH_LIMITS.operations + 1 }, () => entry));
  const oversizedText = structuredClone(entry); oversizedText.after.summary = "x".repeat(65537);
  rejectsWithoutMutation(state, [oversizedText]);
  const tooManyFields = structuredClone(entry);
  for (let index = 0; index < 260; index += 1) tooManyFields.after[`field${index}`] = index;
  rejectsWithoutMutation(state, [tooManyFields]);
  let nested = {}; for (let index = 0; index < 34; index += 1) nested = { next: nested };
  rejectsWithoutMutation(state, [{ ...entry, after: { ...entry.after, summary: nested } }]);
  const oversizedPayload = Array.from({ length: 2500 }, (_, index) => ({ ...entry, key: `node:new:${index}`, before: null,
    after: { ...entry.after, key: `node:new:${index}`, summary: "x".repeat(1000), label: "x".repeat(240) } }));
  // The wire budget is enforced independently of valid individual records.
  oversizedPayload.forEach((item) => { item.after.createdAt = "x".repeat(64); item.after.updatedAt = "x".repeat(64); item.after.optionalCanonicalConceptKey = `concept:${"a".repeat(115)}`; });
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedPayload)) > WORKSPACE_PATCH_LIMITS.bytes);
  rejectsWithoutMutation(state, oversizedPayload);
});

test("existing source anchors cannot be rewritten, even with a new digest or changed geometry", () => {
  const state = fixture();
  for (const change of [{ pageIndex: 1 }, { anchorDigest: "d".repeat(64) }, { normalizedBounds: [{ x: 0.5, y: 0.5, width: 0.2, height: 0.1 }] },
    { exactText: "A plausible but different quote", exactTextSha256: "e".repeat(64), anchorDigest: "f".repeat(64) }]) {
    rejectsWithoutMutation(state, [operation(state, "put_anchor", "anchor:text:one", change)]);
    const next = clone(state); Object.assign(next.anchors.get("anchor:text:one"), change);
    assert.throws(() => createWorkspacePatch(state, next), { code: "workspace_patch_invalid" });
  }
});

test("generated structural nodes, edges, primary anchors and authority are immutable", () => {
  const state = fixture();
  state.graph.addNode("node:section", node({ kind: "section", authority: "document_structure", origin: "system", sourceAnchorIds: [],
    structuralCoverage: [{ startPageIndex: 0, endPageIndex: 2, primaryAnchorId: "anchor:page:1" }] }));
  state.graph.addDirectedEdgeWithKey("edge:structure", "node:paper", "node:section", edge({ authority: "document_structure", origin: "system", sourceAnchorIds: ["anchor:page:1"] }));
  for (const patch of [
    [operation(state, "put_node", "node:paper", { label: "Rewritten title" })],
    [operation(state, "put_node", "node:section", { authority: "paper_grounded", sourceAnchorIds: ["anchor:text:one"] })],
    [operation(state, "put_edge", "edge:structure", { claim: "Injected claim" })],
    [operation(state, "put_anchor", "anchor:page:1", null)],
    [operation(state, "put_node", "node:one", { authority: "document_structure" })],
    [operation(state, "put_node", "node:one", { kind: "section" })],
    [operation(state, "put_node", "node:one", { structuralCoverage: [{ startPageIndex: 0, endPageIndex: 0, primaryAnchorId: "anchor:page:1" }] })],
    [operation(state, "put_edge", "edge:one", { authority: "document_structure" })],
    [{ op: "put_node", key: "node:new-structure", before: null, after: { key: "node:new-structure", ...node({ kind: "section", authority: "document_structure" }) } }],
  ]) rejectsWithoutMutation(state, patch);
  const next = changedNode(state);
  assert.equal(createWorkspacePatch(state, next).forwardPatch.length, 1, "semantic refinements next to structure remain allowed");
});

test("node removal requires explicit incident edges and annotation-link changes, independent of operation order", () => {
  const state = fixture();
  const removeNode = operation(state, "put_node", "node:one", null);
  const removeEdge = operation(state, "put_edge", "edge:one", null);
  const removeAnnotation = operation(state, "put_annotation", "annotation:one", null);
  const removeAnchor = operation(state, "put_anchor", "anchor:text:one", null);
  rejectsWithoutMutation(state, [removeNode]);
  rejectsWithoutMutation(state, [removeNode, removeEdge]);
  rejectsWithoutMutation(state, [removeAnchor]);
  const forwardPatch = [removeNode, removeAnchor, removeAnnotation, removeEdge];
  const applied = applyWorkspacePatch(state, forwardPatch);
  assert.deepEqual(applied.graph.nodes(), ["node:paper"]);
  assert.equal(applied.graph.size, 0);
  assert.equal(applied.annotations.size, 0);
  assert.equal(applied.anchors.size, 1);
  assert.deepEqual(canonicalSnapshot(applyWorkspacePatch(applied, invertWorkspacePatch(forwardPatch))), canonicalSnapshot(state));
});

test("tombstone cascade keeps source and audit links, restores exact IDs, and rejects omitted active edges", () => {
  const state = fixture();
  state.graph.addDirectedEdgeWithKey("edge:parallel", "node:one", "node:paper", edge());
  const nodePatch = operation(state, "put_node", "node:one", { status: "tombstoned", entityRevision: 2, updatedAt: LATER });
  const edges = ["edge:one", "edge:parallel"].map((key) => operation(state, "put_edge", key, { status: "tombstoned", entityRevision: 2, updatedAt: LATER }));
  rejectsWithoutMutation(state, [nodePatch]);
  rejectsWithoutMutation(state, [nodePatch, edges[0]]);
  const patch = [nodePatch, ...edges];
  const tombstoned = applyWorkspacePatch(state, patch);
  assert.deepEqual([...tombstoned.anchors], [...state.anchors]);
  assert.deepEqual([...tombstoned.annotations], [...state.annotations], "active annotation audit links may point at tombstones");
  assert.equal(tombstoned.graph.getNodeAttribute("node:one", "status"), "tombstoned");
  assert.deepEqual(snapshot(applyWorkspacePatch(tombstoned, invertWorkspacePatch(patch))), snapshot(state));
});

test("active edges require live endpoints and endpoint identity cannot be rewritten", () => {
  const state = fixture();
  for (const change of [{ sourceKey: "node:missing" }, { targetKey: "node:one" }, { sourceKey: "node:paper", targetKey: "node:one" }]) {
    rejectsWithoutMutation(state, [operation(state, "put_edge", "edge:one", change)]);
  }
  rejectsWithoutMutation(state, [{ op: "put_edge", key: "edge:missing", before: null, after: { key: "edge:missing", sourceKey: "node:one", targetKey: "node:missing", ...edge() } }]);
  const tombstoned = clone(state);
  tombstoned.graph.setNodeAttribute("node:one", "status", "tombstoned");
  tombstoned.graph.setEdgeAttribute("edge:one", "status", "tombstoned");
  rejectsWithoutMutation(tombstoned, [{ op: "put_edge", key: "edge:resurrected", before: null, after: { key: "edge:resurrected", sourceKey: "node:one", targetKey: "node:paper", ...edge() } }]);
});

test("grounding, same-paper identity, known source IDs, and annotation links are required", () => {
  const state = fixture();
  for (const change of [{ sourceAnchorIds: [] }, { sourceAnchorIds: ["anchor:missing"] }, { paperRef: "paper:foreign" }]) {
    rejectsWithoutMutation(state, [operation(state, "put_node", "node:one", change)]);
    rejectsWithoutMutation(state, [operation(state, "put_edge", "edge:one", change)]);
  }
  for (const change of [{ anchorId: "anchor:page:1" }, { graphNodeKeys: ["node:missing"] }, { graphEdgeKeys: ["edge:missing"] }, { paperRef: "paper:foreign" }]) {
    rejectsWithoutMutation(state, [operation(state, "put_annotation", "annotation:one", change)]);
  }
  for (const change of [{ paperRef: "paper:foreign" }, { documentSha256: "f".repeat(64) }, { pageIndex: PAPER.pageCount },
    { normalizedBounds: [{ x: 0.9, y: 0, width: 0.3, height: 0.1 }] }, { normalizedBounds: [{ x: 0, y: 0, width: 0, height: 0.1 }] },
    { normalizedBounds: [{ x: 0, y: 0, width: 1, height: 1, unsafe: 1 }] }, { sourceKind: "whole_page", authority: "exact_document_text" }]) {
    rejectsWithoutMutation(state, [{ op: "put_anchor", key: "anchor:new", before: null, after: anchor("anchor:new", change) }]);
  }
});

test("mentor background nodes and edges may be ungrounded without silently upgrading their authority", () => {
  const before = fixture();
  const after = clone(before);
  after.graph.addNode("node:background", node({ authority: "mentor_background", origin: "agent", sourceAnchorIds: [], label: "Vector basics" }));
  after.graph.addDirectedEdgeWithKey("edge:background", "node:background", "node:one", edge({ kind: "depends_on", authority: "mentor_background", origin: "agent", sourceAnchorIds: [] }));
  const { forwardPatch, inversePatch } = createWorkspacePatch(before, after);
  const applied = applyWorkspacePatch(before, forwardPatch);
  assert.equal(applied.graph.getNodeAttribute("node:background", "authority"), "mentor_background");
  assert.deepEqual(applied.graph.getEdgeAttribute("edge:background", "sourceAnchorIds"), []);
  assert.deepEqual(snapshot(applyWorkspacePatch(applied, inversePatch)), snapshot(before));
  rejectsWithoutMutation(applied, [operation(applied, "put_node", "node:background", { authority: "paper_grounded" })]);
});

test("infers absent optional paper metadata but rejects divergent explicit paper identity/page counts", () => {
  const before = fixture(); const after = changedNode(before);
  delete before.paper; delete after.paper;
  assert.equal(createWorkspacePatch(before, after).forwardPatch.length, 1);
  const empty = { graph: new MultiDirectedGraph({ allowSelfLoops: false }), anchors: new Map(), annotations: new Map(), paper: { ...PAPER } };
  const background = clone(empty); background.graph.addNode("node:background", node({ authority: "mentor_background", sourceAnchorIds: [] }));
  assert.equal(createWorkspacePatch(empty, background).forwardPatch.length, 1);
  for (const change of [{ paperRef: "paper:foreign" }, { documentSha256: "f".repeat(64) }, { pageCount: 4 }]) {
    const left = fixture(), right = changedNode(left); Object.assign(right.paper, change);
    assert.throws(() => createWorkspacePatch(left, right), { code: "workspace_patch_invalid" });
  }
});

test("enforces final workspace entity limits on multi-record creation", () => {
  const state = fixture();
  const create = (key) => ({ op: "put_node", key, before: null, after: { key, ...node({ authority: "mentor_background", sourceAnchorIds: [] }) } });
  const legal = Array.from({ length: WORKSPACE_PATCH_LIMITS.nodes - state.graph.order }, (_, index) => create(`node:bulk:${index}`));
  const result = applyWorkspacePatch(state, legal);
  assert.equal(result.graph.order, WORKSPACE_PATCH_LIMITS.nodes);
  rejectsWithoutMutation(state, [...legal, create("node:overflow")]);
  const edges = Array.from({ length: WORKSPACE_PATCH_LIMITS.edges }, (_, index) => ({ op: "put_edge", key: `edge:bulk:${index}`, before: null,
    after: { key: `edge:bulk:${index}`, sourceKey: "node:one", targetKey: "node:paper", ...edge() } }));
  rejectsWithoutMutation(state, edges);
});

test("actual issued contract fixture records remain compatible with canonical patch round trips", async () => {
  const before = await createSpikeState(MultiDirectedGraph, { now: () => NOW });
  const after = clone(before);
  after.graph.mergeNodeAttributes("node:concept:attention", { label: "An independently refined idea", entityRevision: 2, updatedAt: LATER });
  const { forwardPatch, inversePatch } = createWorkspacePatch(before, after);
  const applied = applyWorkspacePatch(before, forwardPatch);
  assert.deepEqual(canonicalSnapshot(applied), canonicalSnapshot(after));
  assert.deepEqual(snapshot(applyWorkspacePatch(applied, inversePatch)), snapshot(before));
});

test("canonical point, rectangle, text, quadrilateral and exact-equation sources survive detached frozen replay", async () => {
  const state = fixture();
  const pageViewBox = [10, 20, 622, 812];
  const rotation = 90;
  const base = {
    paperRef: PAPER.paperRef, documentSha256: PAPER.documentSha256, pageIndex: 1, pageLabel: "2",
    pageViewBox, rotation, rendererRecipe: createSpatialRendererRecipe({ rendererVersion: "6.3.289", pageViewBox, pageRotation: rotation }),
    textItemRefs: [], createdBy: "human", createdAt: NOW,
  };
  const cases = [
    { sourceKind: "visual_region", geometryKind: "point", normalizedPoints: [{ x: 0.4, y: 0.6 }] },
    { sourceKind: "whole_figure", geometryKind: "rectangle", normalizedBounds: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.3 }] },
    { sourceKind: "exact_text", geometryKind: "text", normalizedBounds: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.03 }], quote: { exact: "A difficult statement.", prefix: "Before", suffix: "After" } },
    { sourceKind: "visual_region", geometryKind: "quadrilateral", normalizedQuads: [[{ x: 0.1, y: 0.1 }, { x: 0.7, y: 0.2 }, { x: 0.8, y: 0.7 }, { x: 0.2, y: 0.8 }]] },
    { sourceKind: "equation", geometryKind: "text", normalizedBounds: [{ x: 0.3, y: 0.2, width: 0.5, height: 0.05 }], quote: { exact: "E = mc²", prefix: "Equation", suffix: "defines energy" } },
  ];
  for (const [index, geometry] of cases.entries()) {
    const key = `anchor:canonical:${index}`;
    const issued = await createSpatialAnchor({ ...base, ...geometry, anchorId: key });
    const rawPatch = [{ op: "put_anchor", key, before: null, after: issued }];
    const applied = applyWorkspacePatch(state, rawPatch);
    const retained = applied.anchors.get(key);
    assert.notEqual(retained, issued);
    assert.deepEqual(retained, issued);
    assert.equal(Object.isFrozen(retained), true);
    assert.equal(Object.isFrozen(retained.rendererRecipe.pageViewBox), true);
    assert.deepEqual(snapshot(applyWorkspacePatch(applied, invertWorkspacePatch(rawPatch))), snapshot(state));
  }
});
