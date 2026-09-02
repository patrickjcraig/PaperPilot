import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { MultiDirectedGraph } from "graphology";
import ts from "typescript";

import { canonicalJson, createSpikeState, createToolSuite, graphNodeReferencesAnchor, redoLastHumanChange, undoLastHumanChange } from "./contracts.mjs";
import { createGraphLayout, projectGraphView } from "./graph-view-model.mjs";
import { annotationAnchorId } from "./webmcp-observer.mjs";
import {
  clampGraphPosition,
  moveAnnotation,
  nudgeGraphPosition,
  reconcileAnnotationOrder,
  resolvePrimaryGraphNodeKey,
} from "./presentation-layout.mjs";

const appSource = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const parsedApp = ts.createSourceFile("app.mjs", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const appFunctions = new Map(parsedApp.statements
  .filter((node) => ts.isFunctionDeclaration(node) && node.name)
  .map((node) => [node.name.text, node.getText(parsedApp)]));

function appEventCallback(functionName, target, eventName, context) {
  const owner = parsedApp.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === functionName);
  assert.ok(owner, `The app must retain its tested ${functionName} event owner.`);
  const callbacks = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(parsedApp) === `${target}.addEventListener`
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === eventName) {
      assert.ok(ts.isArrowFunction(node.arguments[1]), "The tested app event must keep an explicit callback.");
      callbacks.push(node.arguments[1].getText(parsedApp));
    }
    ts.forEachChild(node, visit);
  };
  visit(owner);
  assert.equal(callbacks.length, 1, `${functionName} must have exactly one ${target} ${eventName} callback.`);
  return vm.runInContext(`"use strict";\n(${callbacks[0]})`, context, { filename: `app.mjs:${functionName}:${eventName}` });
}

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

// Run only the actual presentation function bodies, not application bootstrap or
// a browser. The sinks below stand in for rendering; canonical mutations still
// execute through the production WebMCP contracts and Human Undo/Redo.
function appPresentationHarness(state) {
  const fittedViews = [];
  const context = vm.createContext({
    state,
    graphLayoutPositions: new Map(),
    initialGraphPositions: new Map(),
    selectedGraphNodeKey: null,
    selectedGraphEdgeKey: null,
    graphViewMode: "focus",
    graphView: null,
    graphVisibleNodeKeys: new Set(),
    graphVisibleEdgeKeys: new Set(),
    lastGraphFocusAnchorId: null,
    linkedFocusNodeKeys: new Set(),
    linkedFocusEdgeKeys: new Set(),
    graphNavigationGeneration: 0,
    pendingGraphNavigation: null,
    draggedAnnotationId: null,
    draggedAnnotationNodeKey: null,
    annotationPointerDrag: null,
    sigmaRenderer: null,
    elements: {
      graphLayoutStatus: { textContent: "" },
      graphViewSummary: { textContent: "" },
      graphViewFocus: { setAttribute() {} },
      graphViewAll: { setAttribute() {} },
      graphCanvasShell: { dataset: {} },
    },
    clampGraphPosition,
    createGraphLayout,
    projectGraphView,
    graphNodeReferencesAnchor,
    canonicalJson,
    annotationAnchorId,
    resolvePrimaryGraphNodeKey,
    nudgeGraphPosition,
    renderGraphPosition() {},
    // DOM painting is outside this fixture, but selection still reconciles the
    // real visible projection before an explicit camera-fit request is observed.
    updateGraphSelectionPresentation() { context.reconcileGraphPresentation(); },
    fitGraphView() { fittedViews.push([...context.graphVisibleNodeKeys]); },
    recordActivity() { throw new Error("This fixture must not publish a presentation event."); },
    markSnapshotDirty() { throw new Error("This fixture must not write persistence state."); },
  });
  for (const name of ["activeGraphNodeKeys", "linkedGraphNode", "reconcileGraphPresentation", "setGraphNodePosition", "currentDraggedAnnotationNode", "graphSourceIds", "invalidateGraphNavigation", "isCurrentGraphNavigation", "graphNodeLabel", "selectGraphNode", "synchronizeGraphSourceFocus", "captureAnnotationDragIdentity", "placeDraggedAnnotationNode"]) {
    assert.ok(appFunctions.has(name), `The app must retain its tested ${name} presentation entry point.`);
    vm.runInContext(`"use strict";\n${appFunctions.get(name)}`, context, { filename: `app.mjs:${name}` });
  }
  return {
    context,
    fittedViews,
    reconcile: () => context.reconcileGraphPresentation(),
    move: (nodeKey, position) => context.setGraphNodePosition(nodeKey, position, { announce: false, record: false }),
    draggedNode: () => context.currentDraggedAnnotationNode(),
    sourceIds: (attributes) => [...context.graphSourceIds(attributes)],
    syncSource: () => context.synchronizeGraphSourceFocus(),
  };
}

function appPointerHarness(state) {
  const presentation = appPresentationHarness(state);
  const handlers = new Map();
  const focusedNodes = [];
  const focusedEdges = [];
  let now = 1000;
  let dirtyCount = 0;
  let cameraEnabled = true;
  const camera = { enable() { cameraEnabled = true; }, disable() { cameraEnabled = false; } };
  const renderer = {
    on(name, callback) { handlers.set(name, callback); },
    getBBox() { return { x: [-10, 10], y: [-10, 10] }; },
    setCustomBBox() {},
    getCamera() { return camera; },
    viewportToGraph(position) { return { ...position }; },
    refresh() {},
    scheduleRefresh() {},
  };
  Object.assign(presentation.context, {
    sigmaRenderer: renderer,
    performance: { now: () => now },
    draggedGraphNodeKey: null,
    graphDragStartPosition: null,
    graphDragMoved: false,
    graphClickSuppressedUntil: 0,
    graphViewportBounds: null,
    focusGraphNodeEvidence(nodeKey) { focusedNodes.push(nodeKey); },
    focusGraphEdgeEvidence(edgeKey) { focusedEdges.push(edgeKey); },
    markSnapshotDirty() { dirtyCount += 1; },
  });
  presentation.context.elements.graphCanvasShell.classList = { add() {}, remove() {} };
  for (const name of ["graphNodeLabel", "finishGraphNodeDrag", "bindSigmaInteractions", "nudgeSelectedGraphNode"]) {
    assert.ok(appFunctions.has(name), `The app must retain its tested ${name} pointer entry point.`);
    vm.runInContext(`"use strict";\n${appFunctions.get(name)}`, presentation.context, { filename: `app.mjs:${name}` });
  }
  presentation.context.bindSigmaInteractions(renderer);
  return {
    ...presentation,
    focusedNodes,
    focusedEdges,
    dirtyCount: () => dirtyCount,
    cameraEnabled: () => cameraEnabled,
    advance: (milliseconds) => { now += milliseconds; },
    nudge: (direction) => presentation.context.nudgeSelectedGraphNode(direction),
    emit(name, payload = {}) {
      assert.ok(handlers.has(name), `Sigma ${name} must be handled by the app.`);
      return handlers.get(name)({
        event: { x: 0, y: 0, original: { preventDefault() {} } },
        preventSigmaDefault() {},
        ...payload,
      });
    },
  };
}

async function annotationPointerHarness() {
  const state = await createFixture();
  const tools = toolsFor(state);
  for (const sequence of [1, 2]) {
    const result = await tools.get("paperpilot.apply_annotation").execute(annotationCommand(state, MOVED_NODE_KEY, sequence));
    assert.equal(result.status, "applied_reversible");
  }
  const presentation = appPresentationHarness(state);
  presentation.reconcile();
  const context = presentation.context;
  const ids = [...state.annotations.keys()];
  const traces = [];
  const classes = () => {
    const values = new Set();
    return { values, add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)) };
  };
  let hit = null;
  let renderCount = 0;
  let dirtyCount = 0;
  let preventedCount = 0;
  const rows = new Map(ids.map((id) => {
    let captured = null;
    const row = { dataset: { annotationId: id }, classList: classes(), isConnected: true,
      closest: () => row,
      getBoundingClientRect: () => ({ left: 20, top: context.annotationOrder.indexOf(id) * 100, width: 240, height: 90 }),
    };
    row.handle = { isConnected: true,
      setPointerCapture(pointerId) { captured = pointerId; traces.push("capture"); },
      hasPointerCapture: (pointerId) => captured === pointerId,
      releasePointerCapture(pointerId) { assert.equal(captured, pointerId); captured = null; traces.push("release"); },
      captured: () => captured,
    };
    return [id, row];
  }));
  const graphHit = { closest: () => null };
  context.annotationOrder = Object.freeze([...ids]);
  context.elements.annotationList = {
    contains: (row) => [...rows.values()].includes(row) && row.isConnected,
    querySelectorAll(selector) {
      if (selector === "[data-annotation-id]") return [...rows.values()];
      const wanted = selector.split(", ").map((name) => name.slice(1));
      return [...rows.values()].filter((row) => wanted.some((name) => row.classList.values.has(name)));
    },
  };
  context.elements.annotationLayoutStatus = { textContent: "Existing annotation status" };
  context.elements.graphCanvasShell.classList = classes();
  context.elements.sigmaContainer = { contains: (target) => target === graphHit,
    getBoundingClientRect() { traces.push("bounds"); assert.equal(context.selectedGraphNodeKey, MOVED_NODE_KEY); return { left: 100, top: 200 }; },
  };
  context.document = { elementFromPoint(x, y) { assert.ok(Number.isFinite(x) && Number.isFinite(y)); traces.push("hit-test"); return hit; } };
  context.sigmaRenderer = { viewportToGraph({ x, y }) {
    traces.push("convert"); assert.equal(context.selectedGraphNodeKey, MOVED_NODE_KEY); return { x: x / 100, y: y / 100 };
  }, scheduleRefresh() {} };
  context.moveAnnotation = moveAnnotation;
  context.renderAnnotations = () => { renderCount += 1; };
  context.markSnapshotDirty = () => { dirtyCount += 1; };
  context.finishGraphNodeDrag = () => {};
  const realFit = context.fitGraphView;
  context.fitGraphView = () => { traces.push("fit"); realFit(); };
  for (const name of ["clearAnnotationDropIndicators", "finishAnnotationDrag", "currentAnnotationPointerDrag",
    "beginAnnotationPointerDrag", "annotationPointerDestination", "moveAnnotationPointerDrag",
    "finishAnnotationPointerDrag", "cancelAnnotationPointerDrag", "reorderAnnotation"]) {
    assert.ok(appFunctions.has(name), `The app must retain its tested ${name} pointer helper.`);
    vm.runInContext(`"use strict";\n${appFunctions.get(name)}`, context, { filename: `app.mjs:${name}` });
  }
  const event = (overrides = {}) => ({ pointerId: 17, button: 0, isPrimary: true, clientX: 30, clientY: 20,
    preventDefault() { preventedCount += 1; }, ...overrides });
  return {
    state, context, ids, rows, traces, presentation,
    setHit: (id) => { hit = id === "graph" ? graphHit : rows.get(id) || null; },
    counts: () => ({ render: renderCount, dirty: dirtyCount, prevented: preventedCount }),
    begin(id = ids[0], overrides = {}) {
      context.key = id; context.item = rows.get(id); context.dragHandle = rows.get(id)?.handle;
      context.nodeKey = context.linkedGraphNode(state.annotations.get(id));
      const callback = appEventCallback("renderAnnotations", "dragHandle", "pointerdown", context);
      return callback(event(overrides));
    },
    move: (overrides = {}) => context.moveAnnotationPointerDrag(event(overrides)),
    end: (overrides = {}) => context.finishAnnotationPointerDrag(event(overrides)),
    cancel: (overrides = {}) => context.cancelAnnotationPointerDrag(event(overrides)),
    nativeStart() {
      return appEventCallback("renderAnnotations", "item", "dragstart", context)(event({ target: context.dragHandle }));
    },
    blur: () => appEventCallback("wireHumanControls", "window", "blur", context)(),
    escape: () => appEventCallback("wireHumanControls", "document", "keydown", context)({ key: "Escape" }),
  };
}

function sourceBytes(state) {
  return canonicalJson([...state.anchors].sort(([left], [right]) => left.localeCompare(right)));
}

function arrangementBoundary(state) {
  return {
    ...captureSemanticBoundary(state),
    sources: sourceBytes(state),
    events: structuredClone(state.events),
    annotations: canonicalJson([...state.annotations]),
    entities: [...state.graph.nodes(), ...state.graph.edges()].map((key) => ({
      key,
      revision: state.graph.hasNode(key) ? state.graph.getNodeAttribute(key, "entityRevision") : state.graph.getEdgeAttribute(key, "entityRevision"),
    })),
    historyLength: state.history.length,
    redoLength: state.redoHistory.length,
  };
}

function annotationCommand(state, nodeKey, sequence) {
  return {
    idempotencyKey: `layout-annotation-${String(sequence).padStart(4, "0")}`,
    baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest,
    baseAnnotationDigest: state.annotationDigest,
    reason: "Exercise an issued same-paper source after presentation arrangement.",
    operations: [{
      op: "create_annotation",
      anchorId: ANCHOR_ID,
      expectedAnchorDigest: state.anchors.get(ANCHOR_ID).anchorDigest,
      annotationKind: "note",
      label: `Arranged source note ${sequence}`,
      graphNodeKeys: [nodeKey],
      graphEdgeKeys: [],
    }],
  };
}

async function assertSameGraphFacts(layoutTools, controlTools, input = { mode: "overview", limit: 100 }) {
  const [actual, expected] = await Promise.all([
    layoutTools.get("paperpilot.read_graph").execute(input),
    controlTools.get("paperpilot.read_graph").execute(input),
  ]);
  assert.equal(actual.status, "ready");
  assert.equal(expected.status, "ready");
  const facts = (result) => {
    const value = { ...result };
    delete value.callbackReceiptId;
    return value;
  };
  assert.deepEqual(facts(actual), facts(expected));
  for (const key of PRESENTATION_ONLY_KEYS) assert.equal(collectObjectKeys(actual).has(key), false, `${key} leaked into WebMCP facts`);
  return actual;
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

test("actual app reconciliation preserves surviving positions and card order through graph/annotation replacement and Undo/Redo", async () => {
  const arranged = await createFixture();
  const control = await createFixture();
  const arrangedTools = toolsFor(arranged);
  const controlTools = toolsFor(control);
  for (const sequence of [1, 2]) {
    const [left, right] = await Promise.all([
      arrangedTools.get("paperpilot.apply_annotation").execute(annotationCommand(arranged, MOVED_NODE_KEY, sequence)),
      controlTools.get("paperpilot.apply_annotation").execute(annotationCommand(control, MOVED_NODE_KEY, sequence)),
    ]);
    assert.equal(left.status, "applied_reversible");
    assert.deepEqual(left, right, "Arrangement must not change exact issued IDs or mutation receipts.");
  }
  const presentation = appPresentationHarness(arranged);
  presentation.reconcile();
  const beforeArrange = arrangementBoundary(arranged);
  const preferred = { x: 4.25, y: -2.75 };
  assert.equal(presentation.move(MOVED_NODE_KEY, preferred), true);
  let order = reconcileAnnotationOrder([], [...arranged.annotations.keys()]);
  order = moveAnnotation(order, order.at(-1), order[0], "before");
  const survivorOrder = [...order];
  assert.deepEqual(arrangementBoundary(arranged), beforeArrange);
  assert.equal(Object.hasOwn(arranged, "annotationOrder"), false);
  await assertSameGraphFacts(arrangedTools, controlTools);
  const originalSources = sourceBytes(arranged);
  const beforeGraphDigest = arranged.workspaceDigest;
  let priorGraph = arranged.graph;
  const [graphResult, graphControl] = await Promise.all([
    arrangedTools.get("paperpilot.apply_graph").execute(graphCommand(arranged)),
    controlTools.get("paperpilot.apply_graph").execute(graphCommand(control)),
  ]);
  assert.equal(graphResult.status, "applied_reversible");
  assert.deepEqual(graphResult, graphControl);
  assert.notEqual(arranged.graph, priorGraph);
  presentation.reconcile();
  assert.deepEqual(clampGraphPosition(arranged.graph.getNodeAttributes(MOVED_NODE_KEY)), preferred);
  const createdNodeKey = graphResult.affected.created[0];
  assert.deepEqual(arranged.graph.getNodeAttribute(createdNodeKey, "sourceAnchorIds"), [ANCHOR_ID]);
  const afterGraphDigest = arranged.workspaceDigest;
  await assertSameGraphFacts(arrangedTools, controlTools);

  priorGraph = arranged.graph;
  const [annotationResult, annotationControl] = await Promise.all([
    arrangedTools.get("paperpilot.apply_annotation").execute(annotationCommand(arranged, createdNodeKey, 3)),
    controlTools.get("paperpilot.apply_annotation").execute(annotationCommand(control, createdNodeKey, 3)),
  ]);
  assert.equal(annotationResult.status, "applied_reversible");
  assert.deepEqual(annotationResult, annotationControl);
  assert.notEqual(arranged.graph, priorGraph, "Even annotation transactions replace the canonical graph instance.");
  const addedAnnotationId = annotationResult.affected.created[0];
  const added = arranged.annotations.get(addedAnnotationId);
  assert.equal(added.anchorId, ANCHOR_ID);
  assert.deepEqual(added.graphNodeKeys, [createdNodeKey]);
  presentation.reconcile();
  order = reconcileAnnotationOrder(order, [...arranged.annotations.keys()].reverse());
  assert.deepEqual(order.slice(0, survivorOrder.length), survivorOrder);
  const afterAnnotationDigest = arranged.workspaceDigest;
  await assertSameGraphFacts(arrangedTools, controlTools);

  for (const [action, expectedDigest] of [
    [undoLastHumanChange, afterGraphDigest],
    [undoLastHumanChange, beforeGraphDigest],
    [redoLastHumanChange, afterGraphDigest],
    [redoLastHumanChange, afterAnnotationDigest],
  ]) {
    const orderBefore = [...order];
    priorGraph = arranged.graph;
    const [left, right] = await Promise.all([action(arranged), action(control)]);
    assert.equal(left.digestMatches, true);
    assert.deepEqual(left, right);
    assert.notEqual(arranged.graph, priorGraph);
    const beforeReconcile = arrangementBoundary(arranged);
    presentation.reconcile();
    order = reconcileAnnotationOrder(order, [...arranged.annotations.keys()].reverse());
    assert.deepEqual(order.filter((id) => orderBefore.includes(id)), orderBefore.filter((id) => arranged.annotations.has(id)));
    assert.deepEqual(clampGraphPosition(arranged.graph.getNodeAttributes(MOVED_NODE_KEY)), preferred);
    assert.deepEqual(arrangementBoundary(arranged), beforeReconcile, "Reconciliation must not mutate semantic state, evidence, or source bytes.");
    assert.equal(arranged.workspaceDigest, expectedDigest);
    assert.equal(sourceBytes(arranged), originalSources);
    await assertSameGraphFacts(arrangedTools, controlTools);
  }
  for (const tools of [arrangedTools, controlTools]) {
    const focused = await tools.get("paperpilot.focus_source").execute({ targetType: "node", targetId: createdNodeKey });
    assert.equal(focused.status, "focused");
    assert.equal(focused.anchorId, ANCHOR_ID);
    const read = await tools.get("paperpilot.read_focus").execute({});
    assert.equal(read.focus.anchorDigest, arranged.anchors.get(ANCHOR_ID).anchorDigest);
    assert.ok(read.graph.relatedNodeKeys.includes(createdNodeKey));
  }
});

test("actual app drag resolution ignores external, malformed, removed, and retargeted annotation handles", async () => {
  const state = await createFixture();
  const presentation = appPresentationHarness(state);
  const annotationId = [...state.annotations.keys()][0];
  const original = structuredClone(state.annotations.get(annotationId));
  const before = sourceBytes(state);
  assert.equal(presentation.draggedNode(), null, "External payloads cannot create an internal page-owned drag handle.");
  for (const badId of ["https://example.test/annotation", "annotation:foreign", "bad key", null]) {
    presentation.context.draggedAnnotationId = badId;
    presentation.context.draggedAnnotationNodeKey = MOVED_NODE_KEY;
    assert.equal(presentation.draggedNode(), null);
  }
  presentation.context.draggedAnnotationId = annotationId;
  presentation.context.draggedAnnotationNodeKey = MOVED_NODE_KEY;
  assert.equal(presentation.draggedNode(), MOVED_NODE_KEY);
  for (const changed of [
    { ...original, status: "tombstoned" },
    { ...original, graphNodeKeys: ["node:foreign"] },
    { ...original, graphNodeKeys: ["node:section:introduction"] },
    { ...original, graphNodeKeys: ['{"key":"node:concept:attention"}'] },
  ]) {
    state.annotations.set(annotationId, changed);
    assert.equal(presentation.draggedNode(), null);
  }
  state.annotations.set(annotationId, original);
  state.graph.setNodeAttribute(MOVED_NODE_KEY, "status", "tombstoned");
  assert.equal(presentation.draggedNode(), null);
  const beforeMove = arrangementBoundary(state);
  assert.equal(presentation.move(MOVED_NODE_KEY, { x: 100, y: 100 }), false);
  assert.deepEqual(arrangementBoundary(state), beforeMove);
  assert.equal(sourceBytes(state), before);
});

test("annotation dragstart only captures trusted handles and keeps card targets still until graph drop", async () => {
  const state = await createFixture();
  const presentation = appPresentationHarness(state);
  presentation.reconcile();
  const context = presentation.context;
  const annotationId = [...state.annotations.keys()][0];
  const linkedNodeKey = context.linkedGraphNode(state.annotations.get(annotationId));
  const previousSelection = "node:section:introduction";
  context.selectedGraphNodeKey = previousSelection;
  const originalSelect = context.selectGraphNode;
  const dragHandle = Object.freeze({ name: "page-owned annotation drag handle" });
  const rowGeometry = Object.freeze({ top: 120, left: 20, width: 260, height: 90 });
  const classChanges = [];
  const row = new Proxy(Object.freeze({
    classList: Object.freeze({ add(value) { assert.equal(value, "is-dragging"); classChanges.push(value); } }),
    getBoundingClientRect() { return rowGeometry; },
  }), {
    set() { throw new Error("Dragstart must not alter row geometry or DOM properties."); },
  });
  const status = {};
  Object.defineProperty(status, "textContent", {
    get: () => "Existing annotation status",
    set() { throw new Error("Dragstart must not expand the annotation status or move target cards."); },
  });
  context.elements.annotationLayoutStatus = status;
  Object.assign(context, {
    key: annotationId, nodeKey: linkedNodeKey, item: row, dragHandle,
    selectGraphNode() { throw new Error("Dragstart must not repaint the selected graph detail."); },
    renderAnnotations() { throw new Error("Dragstart must not rebuild or reposition annotation rows."); },
  });
  const start = appEventCallback("renderAnnotations", "item", "dragstart", context);
  const payloads = [];
  const dataTransfer = { effectAllowed: "none", setData(type, value) { payloads.push([type, value]); } };
  let prevented = 0;
  const before = arrangementBoundary(state);
  start({ target: {}, dataTransfer, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(context.draggedAnnotationId, null);
  assert.deepEqual(payloads, []);
  start({ target: dragHandle, dataTransfer, preventDefault() { prevented += 1; } });
  assert.equal(context.draggedAnnotationId, annotationId);
  assert.equal(context.draggedAnnotationNodeKey, linkedNodeKey);
  assert.deepEqual(payloads, [["text/plain", annotationId]]);
  assert.equal(dataTransfer.effectAllowed, "move");
  assert.deepEqual(classChanges, ["is-dragging"]);
  assert.equal(context.selectedGraphNodeKey, previousSelection);
  assert.equal(status.textContent, "Existing annotation status");
  assert.deepEqual(row.getBoundingClientRect(), rowGeometry);
  assert.deepEqual(arrangementBoundary(state), before);

  // A drop may now select/reveal the linked node. It must do that before
  // converting the pointer position using the possibly changed graph camera.
  context.selectGraphNode = originalSelect;
  context.graphVisibleNodeKeys = new Set();
  context.elements.annotationLayoutStatus = { textContent: "Existing annotation status" };
  context.elements.sigmaContainer = { getBoundingClientRect() {
    assert.equal(context.selectedGraphNodeKey, linkedNodeKey);
    assert.ok(presentation.fittedViews.at(-1)?.includes(linkedNodeKey));
    return { left: 100, top: 200 };
  } };
  context.sigmaRenderer = { viewportToGraph(point) {
    assert.equal(context.selectedGraphNodeKey, linkedNodeKey);
    return { x: point.x / 100, y: point.y / 100 };
  }, scheduleRefresh() {} };
  let dirty = 0;
  context.markSnapshotDirty = () => { dirty += 1; };
  context.finishAnnotationDrag = () => { context.draggedAnnotationId = null; context.draggedAnnotationNodeKey = null; };
  const drop = appEventCallback("wireHumanControls", "elements.graphCanvasShell", "drop", context);
  drop({ clientX: 135, clientY: 245, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.equal(dirty, 1);
  assert.equal(context.draggedAnnotationId, null);
  assert.deepEqual(clampGraphPosition(state.graph.getNodeAttributes(linkedNodeKey)), { x: 0.35, y: 0.45 });
  assert.deepEqual(arrangementBoundary(state), before);
});

test("pointer grip drag captures only primary-left input and reorders from the release-time live target", async () => {
  const drag = await annotationPointerHarness();
  const [first, second, third] = drag.ids;
  drag.context.selectedGraphNodeKey = "node:section:introduction";
  const before = arrangementBoundary(drag.state);
  assert.equal(drag.begin(first, { button: 2 }), false);
  assert.equal(drag.begin(first, { isPrimary: false }), false);
  assert.equal(drag.counts().prevented, 0);
  assert.equal(drag.begin(), true);
  assert.equal(drag.rows.get(first).handle.captured(), 17);
  assert.equal(drag.context.draggedAnnotationId, first);
  assert.equal(drag.context.draggedAnnotationNodeKey, MOVED_NODE_KEY);
  assert.equal(drag.context.selectedGraphNodeKey, "node:section:introduction");
  assert.equal(drag.context.elements.annotationLayoutStatus.textContent, "Existing annotation status");
  drag.nativeStart();
  assert.equal(drag.context.annotationPointerDrag.identity.annotationId, first, "Native dragstart cannot replace a captured pointer gesture.");
  drag.setHit(second);
  drag.move({ clientX: 32, clientY: 22 });
  assert.equal(drag.traces.includes("hit-test"), false, "Small grip movement must stay below the gesture threshold.");
  drag.move({ clientX: 35, clientY: 180 });
  assert.equal(drag.rows.get(second).classList.values.has("is-drop-after"), true);
  assert.deepEqual([...drag.context.annotationOrder], drag.ids);
  assert.equal(drag.counts().render, 0);
  assert.equal(drag.counts().dirty, 0);
  assert.equal(drag.context.selectedGraphNodeKey, "node:section:introduction");
  assert.deepEqual(arrangementBoundary(drag.state), before);
  drag.setHit(third);
  assert.equal(drag.end({ clientX: 35, clientY: 210 }), true);
  assert.deepEqual([...drag.context.annotationOrder], [second, first, third], "Release target must be freshly hit-tested instead of reusing hover state.");
  assert.equal(drag.counts().render, 1);
  assert.equal(drag.counts().dirty, 1);
  assert.equal(drag.rows.get(first).handle.captured(), null);
  assert.equal(drag.context.annotationPointerDrag, null);
  assert.equal(drag.context.draggedAnnotationId, null);
  for (const row of drag.rows.values()) assert.equal(row.classList.values.size, 0);
  assert.deepEqual(arrangementBoundary(drag.state), before);

  assert.equal(drag.begin(first, { clientY: 120 }), true);
  drag.setHit(second);
  drag.move({ clientX: 35, clientY: 10 });
  assert.equal(drag.end({ clientX: 35, clientY: 10 }), true);
  assert.deepEqual([...drag.context.annotationOrder], drag.ids, "Repeated drags reuse current order, not initial row indexes.");
  assert.deepEqual(arrangementBoundary(drag.state), before);
});

test("pointer grip graph drop reveals before camera conversion and leaves all source and WebMCP semantics fixed", async () => {
  const drag = await annotationPointerHarness();
  const before = arrangementBoundary(drag.state);
  drag.context.selectedGraphNodeKey = "node:section:introduction";
  drag.context.graphVisibleNodeKeys = new Set();
  drag.begin();
  drag.setHit("graph");
  drag.move({ clientX: 135, clientY: 245 });
  assert.equal(drag.context.selectedGraphNodeKey, "node:section:introduction");
  assert.equal(drag.context.elements.graphCanvasShell.classList.values.has("is-drop-target"), true);
  assert.equal(drag.end({ clientX: 135, clientY: 245 }), true);
  assert.ok(drag.traces.indexOf("fit") < drag.traces.indexOf("bounds"));
  assert.ok(drag.traces.indexOf("bounds") < drag.traces.indexOf("convert"));
  assert.deepEqual(clampGraphPosition(drag.state.graph.getNodeAttributes(MOVED_NODE_KEY)), { x: .35, y: .45 });
  assert.deepEqual([...drag.context.annotationOrder], drag.ids);
  assert.equal(drag.counts().render, 0);
  assert.equal(drag.counts().dirty, 1);
  assert.equal(drag.context.elements.graphCanvasShell.classList.values.size, 0);
  assert.deepEqual(arrangementBoundary(drag.state), before);
});

test("pointer gesture cancellation, outside release and stale/retargeted IDs never apply a drop", async () => {
  const multiPointer = await annotationPointerHarness();
  multiPointer.begin();
  multiPointer.move({ pointerId: 18, clientY: 180 });
  multiPointer.cancel({ pointerId: 18 });
  assert.equal(multiPointer.end({ pointerId: 18, clientY: 180 }), false);
  assert.equal(multiPointer.context.annotationPointerDrag.pointerId, 17, "A secondary pointer cannot move or cancel the captured primary gesture.");
  assert.equal(multiPointer.end(), false, "A click below the movement threshold never becomes a drop.");
  assert.equal(multiPointer.context.annotationPointerDrag, null);
  assert.equal(multiPointer.counts().dirty, 0);
  for (const cancel of ["cancel", "escape", "blur"]) {
    const drag = await annotationPointerHarness();
    const before = arrangementBoundary(drag.state);
    drag.begin();
    drag.setHit(drag.ids[1]);
    drag.move({ clientY: 180 });
    drag[cancel]();
    assert.equal(drag.end({ clientY: 180 }), false);
    assert.equal(drag.context.annotationPointerDrag, null);
    assert.equal(drag.rows.get(drag.ids[0]).handle.captured(), null);
    assert.equal(drag.counts().dirty, 0);
    assert.deepEqual([...drag.context.annotationOrder], drag.ids);
    assert.deepEqual(arrangementBoundary(drag.state), before);
  }
  for (const change of [
    (drag) => drag.setHit(null),
    (drag) => { drag.rows.get(drag.ids[0]).handle.isConnected = false; },
    (drag) => { drag.state.annotations.get(drag.ids[0]).status = "tombstoned"; },
    (drag) => { drag.state.annotations.get(drag.ids[0]).graphNodeKeys = ["node:section:introduction"]; },
    (drag) => { drag.state.annotations.get(drag.ids[0]).entityRevision += 1; },
    (drag) => { drag.rows.get(drag.ids[1]).dataset.annotationId = "https://external.test/fake"; },
    (drag) => { drag.state.annotations.get(drag.ids[1]).status = "tombstoned"; },
  ]) {
    const drag = await annotationPointerHarness();
    drag.begin();
    drag.setHit(drag.ids[1]);
    drag.move({ clientY: 180 });
    change(drag);
    const before = arrangementBoundary(drag.state);
    assert.equal(drag.end({ clientY: 180 }), false);
    assert.equal(drag.counts().dirty, 0);
    assert.equal(drag.counts().render, 0);
    assert.deepEqual([...drag.context.annotationOrder], drag.ids);
    assert.deepEqual(arrangementBoundary(drag.state), before);
    assert.equal(drag.context.annotationPointerDrag, null);
  }
});

test("actual Sigma callbacks arrange without navigating PDF on trailing node or edge clicks", async () => {
  const state = await createFixture();
  const pointer = appPointerHarness(state);
  pointer.reconcile();
  const before = arrangementBoundary(state);
  const initialFocus = state.focusAnchorId;
  const edgeKey = state.graph.edges()[0];
  pointer.emit("downNode", { node: MOVED_NODE_KEY });
  assert.equal(pointer.cameraEnabled(), false);
  pointer.emit("moveBody", { event: { x: 7, y: -3, original: { preventDefault() {} } } });
  pointer.emit("upNode", { node: MOVED_NODE_KEY });
  assert.equal(pointer.cameraEnabled(), true);
  assert.equal(pointer.dirtyCount(), 1);
  pointer.emit("clickNode", { node: MOVED_NODE_KEY });
  pointer.emit("clickEdge", { edge: edgeKey });
  assert.deepEqual(pointer.focusedNodes, []);
  assert.deepEqual(pointer.focusedEdges, []);
  assert.deepEqual(clampGraphPosition(state.graph.getNodeAttributes(MOVED_NODE_KEY)), { x: 7, y: -3 });
  assert.equal(state.focusAnchorId, initialFocus);
  assert.deepEqual(arrangementBoundary(state), before);

  pointer.advance(1000);
  pointer.emit("downNode", { node: MOVED_NODE_KEY });
  pointer.emit("upNode", { node: MOVED_NODE_KEY });
  pointer.emit("clickNode", { node: MOVED_NODE_KEY });
  pointer.emit("clickEdge", { edge: edgeKey });
  assert.deepEqual(pointer.focusedNodes, [MOVED_NODE_KEY], "An ordinary click still opens the exact selected node.");
  assert.deepEqual(pointer.focusedEdges, [edgeKey], "An ordinary edge click still opens the exact selected edge.");
  assert.equal(pointer.dirtyCount(), 1, "A click without movement does not save layout.");
});

test("out-and-back graph dragging still suppresses PDF navigation without changing evidence", async () => {
  const state = await createFixture();
  const pointer = appPointerHarness(state);
  pointer.reconcile();
  const originalPosition = clampGraphPosition(state.graph.getNodeAttributes(MOVED_NODE_KEY));
  const before = arrangementBoundary(state);
  pointer.emit("downNode", { node: MOVED_NODE_KEY });
  pointer.emit("moveBody", { event: { x: originalPosition.x + 2, y: originalPosition.y + 3 } });
  pointer.emit("moveBody", { event: { ...originalPosition } });
  pointer.emit("upStage");
  pointer.emit("clickNode", { node: MOVED_NODE_KEY });
  assert.equal(pointer.cameraEnabled(), true);
  assert.deepEqual(pointer.focusedNodes, [], "Having moved during the gesture must suppress its trailing click, even at the original position.");
  assert.deepEqual(clampGraphPosition(state.graph.getNodeAttributes(MOVED_NODE_KEY)), originalPosition);
  assert.deepEqual(arrangementBoundary(state), before);
});

test("keyboard arrangement uses visual directions with Sigma and with its accessible fallback", async () => {
  const state = await createFixture();
  const pointer = appPointerHarness(state);
  pointer.reconcile();
  pointer.context.selectedGraphNodeKey = MOVED_NODE_KEY;
  const before = arrangementBoundary(state);
  const renderer = pointer.context.sigmaRenderer;
  const original = clampGraphPosition(state.graph.getNodeAttributes(MOVED_NODE_KEY));

  pointer.context.sigmaRenderer = null;
  pointer.nudge("up");
  assert.deepEqual(clampGraphPosition(state.graph.getNodeAttributes(MOVED_NODE_KEY)), { x: original.x, y: original.y + 0.25 }, "Graph +y is visually up, including when Sigma is unavailable.");
  pointer.nudge("down");
  assert.deepEqual(clampGraphPosition(state.graph.getNodeAttributes(MOVED_NODE_KEY)), original);

  renderer.graphToViewport = ({ x, y }) => ({ x: x * 20, y: -y * 20 });
  renderer.viewportToGraph = ({ x, y }) => ({ x: x / 20, y: -y / 20 });
  pointer.context.sigmaRenderer = renderer;
  pointer.nudge("up");
  const up = clampGraphPosition(state.graph.getNodeAttributes(MOVED_NODE_KEY));
  assert.ok(Math.abs(up.y - original.y - 1.2) < 1e-12, "Up moves 24 viewport pixels regardless of graph units.");
  pointer.nudge("right");
  const right = clampGraphPosition(state.graph.getNodeAttributes(MOVED_NODE_KEY));
  assert.ok(Math.abs(right.x - original.x - 1.2) < 1e-12);
  assert.equal(right.y, up.y);
  assert.deepEqual(pointer.focusedNodes, []);
  assert.deepEqual(pointer.focusedEdges, []);
  assert.deepEqual(arrangementBoundary(state), before);
});

test("derived layout and visible graph facts remain deterministic after shuffled insertion and canonical replacement", async () => {
  const state = await createFixture();
  const tools = toolsFor(state);
  const before = arrangementBoundary(state);
  const originalView = projectGraphView(state.graph, { selectedNodeKey: MOVED_NODE_KEY });
  const preferred = new Map([[MOVED_NODE_KEY, Object.freeze({ x: 4.25, y: -2.75 })]]);
  const originalLayout = createGraphLayout(state.graph, { nodeKeys: originalView.visibleNodeKeys, existingPositions: preferred });
  const exported = state.graph.export();
  const reordered = new MultiDirectedGraph({ allowSelfLoops: false });
  reordered.import({ ...exported, nodes: [...exported.nodes].reverse(), edges: [...exported.edges].reverse() });
  state.graph = reordered;
  assert.deepEqual(projectGraphView(state.graph, { selectedNodeKey: MOVED_NODE_KEY }), originalView);
  assert.deepEqual(createGraphLayout(state.graph, { nodeKeys: originalView.visibleNodeKeys, existingPositions: preferred }), originalLayout);
  assert.equal(sourceBytes(state), before.sources);
  assert.equal(state.workspaceDigest, before.workspaceDigest);

  const result = await tools.get("paperpilot.apply_graph").execute(graphCommand(state));
  assert.equal(result.status, "applied_reversible");
  const replacementView = projectGraphView(state.graph, { selectedNodeKey: MOVED_NODE_KEY });
  const replacementLayout = createGraphLayout(state.graph, { nodeKeys: replacementView.visibleNodeKeys, existingPositions: originalLayout });
  assert.deepEqual(replacementLayout.get(MOVED_NODE_KEY), preferred.get(MOVED_NODE_KEY));
  for (const [key, position] of originalLayout) assert.deepEqual(replacementLayout.get(key), position);
  assert.ok(replacementView.outlineNodeKeys.includes(result.affected.created[0]));
  assert.equal(sourceBytes(state), before.sources);
  const afterReplacement = arrangementBoundary(state);
  assert.equal((await undoLastHumanChange(state)).digestMatches, true);
  const undoLayout = createGraphLayout(state.graph, { existingPositions: replacementLayout });
  assert.deepEqual(undoLayout.get(MOVED_NODE_KEY), preferred.get(MOVED_NODE_KEY));
  assert.equal(undoLayout.has(result.affected.created[0]), false);
  assert.equal((await redoLastHumanChange(state)).digestMatches, true);
  assert.equal(state.workspaceDigest, afterReplacement.workspaceDigest);
  assert.equal(sourceBytes(state), before.sources);
});

test("source synchronization retains every exact annotation-linked node and edge across arrangement and tombstone Undo", async () => {
  const state = await createFixture();
  const tools = toolsFor(state);
  const presentation = appPresentationHarness(state);
  const sources = sourceBytes(state);
  const command = graphCommand(state);
  const concept = command.operations[0].node;
  command.operations = [
    { op: "add_node", clientRef: "client:layout:visual-a", node: {
      ...concept, label: "Visual A idea", sourceAnchorIds: ["anchor:visual:a"],
    } },
    { op: "add_node", clientRef: "client:layout:visual-b", node: {
      ...concept, label: "Visual B idea", sourceAnchorIds: ["anchor:visual:b"],
    } },
    { op: "add_edge", clientRef: "client:layout:visual-edge", edge: {
      source: { refType: "client_ref", clientRef: "client:layout:visual-a" },
      target: { refType: "client_ref", clientRef: "client:layout:visual-b" },
      kind: "supports", claim: "A fixture relation with two independently issued visual sources.",
      authority: "paper_grounded", sourceAnchorIds: ["anchor:visual:a", "anchor:visual:b"],
    } },
  ];
  const created = await tools.get("paperpilot.apply_graph").execute(command);
  assert.equal(created.status, "applied_reversible", JSON.stringify(created));
  const [firstNode, secondNode, edgeKey] = created.affected.created;
  const annotation = annotationCommand(state, firstNode, 1);
  annotation.operations[0].graphNodeKeys = [secondNode, firstNode];
  annotation.operations[0].graphEdgeKeys = [edgeKey];
  const annotationResult = await tools.get("paperpilot.apply_annotation").execute(annotation);
  assert.equal(annotationResult.status, "applied_reversible");
  const annotationId = annotationResult.affected.created[0];
  assert.deepEqual(state.annotations.get(annotationId).graphNodeKeys, [secondNode, firstNode]);
  state.focusAnchorId = ANCHOR_ID;
  const before = arrangementBoundary(state);
  presentation.reconcile();
  presentation.move(firstNode, { x: 4, y: 5 });
  presentation.syncSource();
  assert.ok(presentation.context.linkedFocusNodeKeys.has(MOVED_NODE_KEY));
  assert.ok(presentation.context.linkedFocusNodeKeys.has(firstNode));
  assert.ok(presentation.context.linkedFocusNodeKeys.has(secondNode));
  assert.ok(presentation.context.linkedFocusEdgeKeys.has(edgeKey));
  assert.deepEqual(presentation.sourceIds(state.graph.getEdgeAttributes(edgeKey)), ["anchor:visual:a", "anchor:visual:b"]);
  assert.deepEqual(arrangementBoundary(state), before);
  assert.equal(sourceBytes(state), sources);

  const remove = graphCommand(state);
  remove.idempotencyKey = "layout-source-tombstone-0001";
  remove.operations = [{ op: "tombstone_node", nodeKey: firstNode, expectedEntityRevision: 1 }];
  assert.equal((await tools.get("paperpilot.apply_graph").execute(remove)).status, "applied_reversible");
  presentation.syncSource();
  assert.equal(presentation.context.linkedFocusNodeKeys.has(firstNode), false);
  assert.equal(presentation.context.linkedFocusEdgeKeys.has(edgeKey), false);
  assert.equal(presentation.context.linkedFocusNodeKeys.has(secondNode), true);
  assert.equal((await undoLastHumanChange(state)).digestMatches, true);
  presentation.reconcile();
  presentation.syncSource();
  assert.equal(presentation.context.linkedFocusNodeKeys.has(firstNode), true);
  assert.equal(presentation.context.linkedFocusNodeKeys.has(secondNode), true);
  assert.equal(presentation.context.linkedFocusEdgeKeys.has(edgeKey), true);
  assert.deepEqual(clampGraphPosition(state.graph.getNodeAttributes(firstNode)), { x: 4, y: 5 });
  assert.deepEqual(state.annotations.get(annotationId).graphNodeKeys, [secondNode, firstNode]);
  assert.equal(sourceBytes(state), sources);
});

test("600-node/1200-edge arrangement smoke keeps complete outline identity and bounded WebMCP facts", async () => {
  const state = await createFixture();
  // A bounded trusted fixture supplies the dense topology; one real reducer
  // command below establishes its semantic digest before any layout is tested.
  const nodeTemplate = structuredClone(state.graph.getNodeAttributes(MOVED_NODE_KEY));
  for (let index = state.graph.order; index < 600; index += 1) {
    state.graph.addNode(`node:dense:${String(index).padStart(4, "0")}`, {
      ...nodeTemplate,
      label: `Dense ${index}`,
      summary: "A short source-grounded dense fixture node.",
      sourceAnchorIds: [ANCHOR_ID],
      salience: (index % 10) / 10,
      x: index,
      y: -index,
    });
  }
  const edgeTemplate = structuredClone(state.graph.getEdgeAttributes(state.graph.edges()[0]));
  const nodeKeys = state.graph.nodes().sort();
  for (let index = state.graph.size; index < 1200; index += 1) {
    const source = nodeKeys[index % nodeKeys.length];
    const target = nodeKeys[(index + 1 + Math.floor(index / nodeKeys.length)) % nodeKeys.length];
    state.graph.addDirectedEdgeWithKey(`edge:dense:${String(index).padStart(4, "0")}`, source, target, {
      ...edgeTemplate,
      kind: "supports",
      claim: "Dense fixture relation.",
      authority: "paper_grounded",
      sourceAnchorIds: [ANCHOR_ID],
    });
  }
  const tools = toolsFor(state);
  const command = graphCommand(state);
  command.operations = [{ op: "update_node", nodeKey: MOVED_NODE_KEY, expectedEntityRevision: 1, set: { label: nodeTemplate.label, salience: 0.72 } }];
  const seeded = await tools.get("paperpilot.apply_graph").execute(command);
  assert.equal(seeded.status, "applied_reversible", JSON.stringify(seeded));
  assert.equal(state.graph.order, 600);
  assert.equal(state.graph.size, 1200);
  const before = arrangementBoundary(state);
  const view = projectGraphView(state.graph, { selectedNodeKey: MOVED_NODE_KEY });
  assert.equal(view.outlineNodeKeys.length, 600);
  assert.equal(view.outlineEdgeKeys.length, 1200);
  assert.ok(view.visibleNodeKeys.length <= 15);
  assert.ok(view.visibleEdgeKeys.length <= 120);
  assert.equal(new Set(view.outlineNodeKeys).size, 600);
  assert.equal(new Set(view.outlineEdgeKeys).size, 1200);
  const positions = createGraphLayout(state.graph, { nodeKeys: view.visibleNodeKeys });
  assert.equal(positions.size, view.visibleNodeKeys.length);
  for (const [key, position] of positions) {
    assert.ok(state.graph.hasNode(key));
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
    assert.equal(Object.isFrozen(position), true);
  }
  const presentation = appPresentationHarness(state);
  presentation.reconcile();
  assert.equal(presentation.move(MOVED_NODE_KEY, { x: 9, y: -7 }), true);
  assert.deepEqual(arrangementBoundary(state), before);
  const read = await tools.get("paperpilot.read_graph").execute({ mode: "node", nodeKey: MOVED_NODE_KEY, radius: 1, limit: 12 });
  assert.equal(read.status, "ready");
  assert.ok(read.nodes.length <= 12);
  assert.ok(read.edges.length <= 200);
  for (const { key, sourceAnchorIds } of read.nodes) {
    assert.ok(view.outlineNodeKeys.includes(key));
    assert.deepEqual(sourceAnchorIds, state.graph.getNodeAttribute(key, "sourceAnchorIds"));
  }
  for (const key of PRESENTATION_ONLY_KEYS) assert.equal(collectObjectKeys(read).has(key), false);
  assert.equal(read.workspaceDigest, before.workspaceDigest);
  assert.equal(sourceBytes(state), before.sources);
});
