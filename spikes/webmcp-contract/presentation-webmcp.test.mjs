import assert from "node:assert/strict";
import test from "node:test";

import { MultiDirectedGraph } from "graphology";

import { createSpikeState, createToolSuite } from "./contracts.mjs";

const ANCHOR_ID = "anchor:text:attention";
const MOVED_NODE_KEY = "node:concept:attention";
const PRESENTATION_ONLY_KEYS = new Set([
  "annotationOrder",
  "color",
  "hidden",
  "highlighted",
  "hovered",
  "layout",
  "layoutOrder",
  "order",
  "selected",
  "size",
  "x",
  "y",
]);

function deterministicOptions() {
  let sequence = 0;
  return {
    now: () => "2026-08-31T16:00:00.000Z",
    id: (prefix) => `${prefix}:${String(++sequence).padStart(8, "0")}`,
  };
}

async function createFixture() {
  return createSpikeState(MultiDirectedGraph, deterministicOptions());
}

function toolsFor(state) {
  return new Map(createToolSuite(state).map((tool) => [tool.name, tool]));
}

function captureSemanticBoundary(state) {
  const anchor = state.anchors.get(ANCHOR_ID);
  return {
    workspaceRevision: state.workspaceRevision,
    workspaceDigest: state.workspaceDigest,
    graphDigest: state.graphDigest,
    annotationDigest: state.annotationDigest,
    anchor: structuredClone(anchor),
    anchorDigest: anchor.anchorDigest,
    normalizedBounds: structuredClone(anchor.normalizedBounds),
    pageViewBox: structuredClone(anchor.pageViewBox),
    pageRotation: anchor.pageRotation,
  };
}

function collectObjectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) collectObjectKeys(child, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectObjectKeys(child, keys);
  }
  return keys;
}

function graphCommand(state) {
  return {
    idempotencyKey: "layout-proof-graph-0001",
    baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest,
    baseGraphDigest: state.graphDigest,
    reason: "Add a paper-grounded concept after rearranging the presentation layer.",
    operations: [
      {
        op: "add_node",
        clientRef: "client:layout:concept",
        node: {
          kind: "concept",
          label: "Evidence desk provenance link",
          summary: "A grounded concept created after the reader rearranged the graph view.",
          authority: "paper_grounded",
          sourceAnchorIds: [ANCHOR_ID],
          salience: 0.72,
        },
      },
    ],
  };
}

test("keeps presentation layout outside WebMCP semantics while graph tools remain writable", async () => {
  const layoutState = await createFixture();
  const controlState = await createFixture();
  const layoutTools = toolsFor(layoutState);
  const controlTools = toolsFor(controlState);
  const beforeLayout = captureSemanticBoundary(layoutState);
  const beforeControl = captureSemanticBoundary(controlState);

  assert.deepEqual(beforeLayout, beforeControl, "identical fixtures must begin at the same semantic boundary");

  // The graph canvas owns only view coordinates. Annotation ordering is kept in
  // a separate UI array rather than being attached to contract state or entities.
  layoutState.graph.setNodeAttribute(MOVED_NODE_KEY, "x", 4.25);
  layoutState.graph.setNodeAttribute(MOVED_NODE_KEY, "y", -2.75);
  const externalAnnotationOrder = [...layoutState.annotations.keys()];
  externalAnnotationOrder.reverse();

  assert.equal(Object.hasOwn(layoutState, "annotationOrder"), false);
  assert.deepEqual(externalAnnotationOrder, [...layoutState.annotations.keys()].reverse());
  assert.deepEqual(captureSemanticBoundary(layoutState), beforeLayout);

  const [layoutRead, controlRead] = await Promise.all([
    layoutTools.get("paperpilot.read_graph").execute({ mode: "search", query: "attention" }),
    controlTools.get("paperpilot.read_graph").execute({ mode: "search", query: "attention" }),
  ]);

  assert.equal(layoutRead.status, "ready");
  assert.deepEqual(layoutRead.nodes, controlRead.nodes);
  assert.deepEqual(layoutRead.edges, controlRead.edges);
  assert.equal(layoutRead.workspaceRevision, beforeLayout.workspaceRevision);
  assert.equal(layoutRead.workspaceDigest, beforeLayout.workspaceDigest);
  assert.equal(layoutRead.graphDigest, beforeLayout.graphDigest);
  assert.equal(layoutRead.annotationDigest, beforeLayout.annotationDigest);
  assert.ok(layoutRead.nodes.some(({ key }) => key === MOVED_NODE_KEY));

  const returnedKeys = collectObjectKeys(layoutRead);
  for (const key of PRESENTATION_ONLY_KEYS) {
    assert.equal(returnedKeys.has(key), false, `read_graph must not expose presentation field ${key}`);
  }

  assert.deepEqual(captureSemanticBoundary(layoutState), beforeLayout);

  const [layoutApplied, controlApplied] = await Promise.all([
    layoutTools.get("paperpilot.apply_graph").execute(graphCommand(layoutState)),
    controlTools.get("paperpilot.apply_graph").execute(graphCommand(controlState)),
  ]);

  assert.equal(layoutApplied.status, "applied_reversible");
  assert.equal(controlApplied.status, "applied_reversible");
  assert.equal(layoutApplied.affected.created.length, 1);
  assert.deepEqual(layoutApplied.affected, controlApplied.affected);
  assert.equal(layoutState.workspaceRevision, beforeLayout.workspaceRevision + 1);
  assert.equal(layoutState.workspaceDigest, controlState.workspaceDigest);
  assert.equal(layoutState.graphDigest, controlState.graphDigest);
  assert.equal(layoutState.annotationDigest, controlState.annotationDigest);
  assert.deepEqual(layoutState.anchors.get(ANCHOR_ID), beforeLayout.anchor);
  assert.deepEqual(controlState.anchors.get(ANCHOR_ID), beforeControl.anchor);

  const [layoutSearch, controlSearch] = await Promise.all([
    layoutTools.get("paperpilot.read_graph").execute({ mode: "search", query: "evidence desk provenance" }),
    controlTools.get("paperpilot.read_graph").execute({ mode: "search", query: "evidence desk provenance" }),
  ]);

  assert.equal(layoutSearch.status, "ready");
  assert.deepEqual(layoutSearch.nodes, controlSearch.nodes);
  assert.equal(layoutSearch.nodes.length, 1);
  assert.equal(layoutSearch.nodes[0].key, layoutApplied.affected.created[0]);
  for (const key of PRESENTATION_ONLY_KEYS) {
    assert.equal(collectObjectKeys(layoutSearch).has(key), false, `post-mutation search must not expose presentation field ${key}`);
  }
});
