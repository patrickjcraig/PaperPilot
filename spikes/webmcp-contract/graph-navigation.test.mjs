import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { MultiDirectedGraph } from "graphology";
import ts from "typescript";

import { captureWebmcpInput, createSpikeState, createToolSuite, graphNodeReferencesAnchor } from "./contracts.mjs";
import { projectGraphView } from "./graph-view-model.mjs";
import { annotationAnchorId, instrumentWebmcpTools, resolveObservedAnchor } from "./webmcp-observer.mjs";

const appSource = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const parsedApp = ts.createSourceFile("app.mjs", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const appFunctions = new Map(parsedApp.statements
  .filter((node) => ts.isFunctionDeclaration(node) && node.name)
  .map((node) => [node.name.text, node.getText(parsedApp)]));

class ElementStub {
  children = [];
  handlers = new Map();
  attributes = new Map();
  dataset = {};
  textContent = "";
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, callback) { this.handlers.set(name, callback); }
  click() { return this.handlers.get("click")?.(); }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function basicState() {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  for (const [key, anchor] of [["node:a", "anchor:a"], ["node:b", "anchor:b"], ["node:shared", "anchor:a"]]) {
    graph.addNode(key, { kind: "main_idea", label: key, authority: "paper_grounded", origin: "automatic_map", status: "active", sourceAnchorIds: [anchor], salience: 0.5 });
  }
  for (const [key, anchor] of [["edge:a", "anchor:a"], ["edge:b", "anchor:b"], ["edge:shared", "anchor:a"]]) {
    graph.addDirectedEdgeWithKey(key, "node:a", "node:b", { kind: "relates_to", status: "active", sourceAnchorIds: [anchor] });
  }
  return {
    graph, paper: { paperRef: "paper:navigation" }, focusAnchorId: "anchor:start",
    anchors: new Map(["anchor:a", "anchor:b", "anchor:start"].map((anchorId, pageIndex) => [anchorId, {
      anchorId, pageIndex, pageLabel: String(pageIndex + 1), sourceKind: "exact_text", normalizedBounds: [], exactText: anchorId,
    }])),
    annotations: new Map(), history: [], redoHistory: [], events: [],
    workspaceRevision: 9, workspaceDigest: "workspace-unchanged", graphDigest: "graph-unchanged", annotationDigest: "annotation-unchanged",
  };
}

// Execute production function bodies without bootstrapping the app or browser.
// Only rendering sinks are substituted; graph projection and tool contracts are real.
function navigationHarness(state = basicState(), { actualEnsure = false } = {}) {
  const activity = [];
  const destinations = [];
  const fits = [];
  let ensure = async (anchorId) => {
    context.synchronizeGraphSourceFocus();
    return { anchorId };
  };
  const context = vm.createContext({
    toolSessionGeneration: 0, registrationAttempt: null, pageLeaving: false, DOMException,
    state, selectedGraphNodeKey: null, selectedGraphEdgeKey: null,
    graphNavigationGeneration: 0, pendingGraphNavigation: null, graphToolNavigationGenerations: new WeakMap(),
    lastGraphFocusAnchorId: state.focusAnchorId,
    graphVisibleNodeKeys: new Set(projectGraphView(state.graph).visibleNodeKeys),
    graphVisibleEdgeKeys: new Set(projectGraphView(state.graph).visibleEdgeKeys),
    linkedFocusNodeKeys: new Set(), linkedFocusEdgeKeys: new Set(),
    captureWebmcpInput, graphNodeReferencesAnchor, annotationAnchorId, instrumentWebmcpTools, resolveObservedAnchor,
    humanReadable: (value) => value.replaceAll("_", " "),
    elements: { graphLayoutStatus: new ElementStub(), paperStage: new ElementStub(), visualRegionA: new ElementStub() },
    document: { createElement: () => new ElementStub() },
    updateGraphSelectionPresentation() {
      const view = projectGraphView(state.graph, { selectedNodeKey: context.selectedGraphNodeKey, selectedEdgeKey: context.selectedGraphEdgeKey });
      context.graphVisibleNodeKeys = new Set(view.visibleNodeKeys);
      context.graphVisibleEdgeKeys = new Set(view.visibleEdgeKeys);
    },
    fitGraphView() { fits.push(context.selectedGraphNodeKey || context.selectedGraphEdgeKey); },
    recordActivity(type, details) { activity.push({ type, ...details }); },
    ensureAnchorVisible: (...args) => ensure(...args),
    renderLastResult() {}, markSnapshotDirty() {}, showToolRequest() {}, showToolResult() {},
    prefersReducedMotion: () => true,
    paperViewer: null,
    focusElementForAnchor: (anchorId) => ({ anchorId }),
    renderFocus(options) { destinations.push({ anchorId: state.focusAnchorId, ...options }); context.synchronizeGraphSourceFocus(); },
  });
  const names = ["activeGraphNodeKeys", "graphSourceIds", "graphNodeLabel", "invalidateGraphNavigation", "isCurrentGraphNavigation",
    "synchronizeGraphSourceFocus", "selectGraphNode", "selectGraphEdge", "focusGraphNodeEvidence", "focusGraphEdgeEvidence",
    "navigateGraphSource", "graphSourceActions", "synchronizeGraphToolNavigation", "navigateObservedPaperSource", "instrumentTools"];
  if (actualEnsure) names.push("ensureAnchorVisible");
  for (const name of names) {
    assert.ok(appFunctions.has(name), `Missing production function ${name}`);
    vm.runInContext(`"use strict";\n${appFunctions.get(name)}`, context, { filename: `app.mjs:${name}` });
  }
  return { context, state, activity, fits, destinations, setEnsure: (handler) => { ensure = handler; } };
}

test("node and edge navigation record success only after a real destination and preserve semantic evidence", async () => {
  const harness = navigationHarness();
  const { context, state, activity } = harness;
  const before = JSON.stringify({ graph: state.graph.export(), anchors: [...state.anchors], history: state.history, events: state.events,
    revision: state.workspaceRevision, workspace: state.workspaceDigest, graphDigest: state.graphDigest, annotation: state.annotationDigest });
  const wait = deferred();
  harness.setEnsure(() => wait.promise);
  const navigation = context.focusGraphNodeEvidence("node:a");
  assert.equal(activity.length, 0);
  wait.resolve({ anchorId: "anchor:a" });
  assert.equal(await navigation, true);
  assert.equal(activity[0].type, "graph_node_source_focused");
  harness.setEnsure(async () => { context.synchronizeGraphSourceFocus(); return { anchorId: "anchor:b" }; });
  assert.equal(await context.focusGraphEdgeEvidence("edge:b"), true);
  assert.equal(context.selectedGraphEdgeKey, "edge:b");
  assert.equal(activity[1].type, "graph_edge_source_focused");
  assert.equal(context.pendingGraphNavigation, null);
  assert.equal(JSON.stringify({ graph: state.graph.export(), anchors: [...state.anchors], history: state.history, events: state.events,
    revision: state.workspaceRevision, workspace: state.workspaceDigest, graphDigest: state.graphDigest, annotation: state.annotationDigest }), before);
});

test("reverse async edge completion leaves the latest edge and paper source selected", async () => {
  const harness = navigationHarness();
  const waits = new Map([["anchor:a", deferred()], ["anchor:b", deferred()]]);
  harness.setEnsure((anchorId) => waits.get(anchorId).promise);
  const first = harness.context.focusGraphEdgeEvidence("edge:a");
  const second = harness.context.focusGraphEdgeEvidence("edge:b");
  waits.get("anchor:b").resolve({ anchorId: "anchor:b" });
  assert.equal(await second, true);
  waits.get("anchor:a").resolve({ anchorId: "anchor:a" });
  assert.equal(await first, false);
  assert.equal(harness.context.selectedGraphEdgeKey, "edge:b");
  assert.equal(harness.state.focusAnchorId, "anchor:b");
  assert.deepEqual(harness.activity.map(({ type, status }) => [type, status]), [["graph_edge_source_focused", "edge:b"]]);
});

test("two different edge requests sharing one anchor still obey request order", async () => {
  const harness = navigationHarness();
  const firstWait = deferred(), secondWait = deferred();
  let invocation = 0;
  harness.setEnsure(() => (++invocation === 1 ? firstWait : secondWait).promise);
  const first = harness.context.focusGraphEdgeEvidence("edge:a");
  const second = harness.context.focusGraphEdgeEvidence("edge:shared");
  secondWait.resolve({ anchorId: "anchor:a" }); await second;
  firstWait.resolve({ anchorId: "anchor:a" });
  assert.equal(await first, false);
  assert.equal(harness.context.selectedGraphEdgeKey, "edge:shared");
  assert.equal(harness.activity.length, 1);
});

test("newer manual node selection invalidates an older edge request even on the same source", async () => {
  const harness = navigationHarness();
  const wait = deferred();
  harness.setEnsure(() => wait.promise);
  const navigation = harness.context.focusGraphEdgeEvidence("edge:a");
  harness.context.selectGraphNode("node:shared", { announce: false });
  wait.resolve({ anchorId: "anchor:a" });
  assert.equal(await navigation, false);
  assert.equal(harness.context.selectedGraphNodeKey, "node:shared");
  assert.equal(harness.context.selectedGraphEdgeKey, null);
  assert.equal(harness.activity.length, 0);
});

test("renderFocus synchronization preserves its own pending graph navigation", async () => {
  const harness = navigationHarness();
  assert.equal(await harness.context.focusGraphEdgeEvidence("edge:a"), true);
  assert.equal(harness.context.selectedGraphEdgeKey, "edge:a");
  assert.equal(harness.context.selectedGraphNodeKey, null);
  assert.equal(harness.activity.filter(({ type }) => type === "graph_edge_source_focused").length, 1);
});

test("source sync fits a newly revealed hidden node once, not passive unchanged reads", () => {
  const state = basicState();
  for (let index = 0; index < 30; index += 1) state.graph.addNode(`node:early:${index}`, {
    kind: "main_idea", label: `Early ${index}`, status: "active", origin: "automatic_map", salience: 1,
    sourceAnchorIds: ["anchor:start"],
  });
  const { context, fits } = navigationHarness(state);
  assert.equal(context.graphVisibleNodeKeys.has("node:b"), false);
  state.focusAnchorId = "anchor:b";
  context.synchronizeGraphSourceFocus();
  assert.equal(context.selectedGraphNodeKey, "node:b");
  assert.equal(context.graphVisibleNodeKeys.has("node:b"), true);
  assert.deepEqual(fits, ["node:b"]);
  context.synchronizeGraphSourceFocus();
  context.synchronizeGraphSourceFocus();
  assert.equal(fits.length, 1);
});

test("failed or missing navigation destinations are safe, caught, and never emit success", async () => {
  for (const failure of ["reject", "missing"]) {
    const harness = navigationHarness();
    harness.setEnsure(async () => {
      if (failure === "reject") throw new Error("SECRET C:\\private\\paper.pdf provider stack");
      return null;
    });
    assert.equal(await harness.context.focusGraphNodeEvidence("node:a"), false);
    assert.deepEqual(harness.activity.map(({ type }) => type), ["graph_source_navigation_failed"]);
    assert.equal(harness.context.pendingGraphNavigation, null);
    assert.match(harness.context.elements.graphLayoutStatus.textContent, /Could not open this paper source/u);
    assert.doesNotMatch(JSON.stringify(harness.activity) + harness.context.elements.graphLayoutStatus.textContent, /SECRET|private|provider stack/u);
  }
});

test("an obsolete navigation failure cannot replace the newer reader status or emit a failure event", async () => {
  const harness = navigationHarness();
  const wait = deferred();
  harness.setEnsure(() => wait.promise);
  const old = harness.context.focusGraphEdgeEvidence("edge:a");
  harness.context.selectGraphNode("node:b");
  const status = harness.context.elements.graphLayoutStatus.textContent;
  wait.reject(new Error("old private failure"));
  assert.equal(await old, false);
  assert.equal(harness.context.elements.graphLayoutStatus.textContent, status);
  assert.equal(harness.activity.length, 0);
});

test("graph source buttons share the guarded navigation path, including reverse completion", async () => {
  const harness = navigationHarness();
  const firstWait = deferred(), secondWait = deferred();
  harness.setEnsure((anchorId) => anchorId === "anchor:a" ? firstWait.promise : secondWait.promise);
  const firstActions = harness.context.graphSourceActions(["anchor:a"], { edgeKey: "edge:a" });
  const secondActions = harness.context.graphSourceActions(["anchor:b"], { edgeKey: "edge:b" });
  const first = firstActions.children[0].click();
  const second = secondActions.children[0].click();
  secondWait.resolve({ anchorId: "anchor:b" }); await second;
  firstWait.resolve({ anchorId: "anchor:a" }); await first;
  assert.equal(harness.context.selectedGraphEdgeKey, "edge:b");
  assert.deepEqual(harness.activity.map(({ type, status }) => [type, status]), [["graph_source_focused", "edge:b"]]);
});

test("actual PDF navigation seam prevents old post-render scrolling/focus after a newer source", async () => {
  const harness = navigationHarness(undefined, { actualEnsure: true });
  const firstWait = deferred(), secondWait = deferred();
  const focusCalls = [];
  harness.context.paperViewer = {
    getAnchorTarget: (id) => ({ id }),
    showPage: (pageNumber) => pageNumber === 1 ? firstWait.promise : secondWait.promise,
    focusAnchor: async (id, options) => { focusCalls.push({ id, options }); return { id }; },
  };
  const first = harness.context.focusGraphEdgeEvidence("edge:a");
  const second = harness.context.focusGraphEdgeEvidence("edge:b");
  secondWait.resolve({ pageNumber: 2 }); await second;
  firstWait.resolve({ pageNumber: 1 });
  assert.equal(await first, false);
  assert.deepEqual(focusCalls.map(({ id }) => id), ["anchor:b"]);
  assert.equal(focusCalls[0].options.scrollIntoView, false);
  assert.equal(focusCalls[0].options.moveKeyboardFocus, false);
  assert.deepEqual(harness.destinations.map(({ anchorId }) => anchorId), ["anchor:b"]);
});

test("non-graph source navigation invalidates pending graph work immediately, even away and back", async () => {
  const harness = navigationHarness(undefined, { actualEnsure: true });
  const wait = deferred();
  let pageCalls = 0;
  harness.context.paperViewer = {
    getAnchorTarget: (id) => ({ id }), showPage: () => ++pageCalls === 1 ? wait.promise : Promise.resolve({ pageNumber: pageCalls }),
    focusAnchor: async (id) => ({ id }),
  };
  const old = harness.context.focusGraphEdgeEvidence("edge:a");
  harness.state.focusAnchorId = "anchor:b";
  await harness.context.ensureAnchorVisible("anchor:b", { scrollIntoView: true });
  harness.state.focusAnchorId = "anchor:a";
  await harness.context.ensureAnchorVisible("anchor:a", { scrollIntoView: true });
  harness.context.selectGraphNode("node:shared", { announce: false });
  wait.resolve({ pageNumber: 1 });
  assert.equal(await old, false);
  assert.equal(harness.context.selectedGraphNodeKey, "node:shared");
  assert.equal(harness.activity.length, 0);
});

test("passive ensure markers do not cancel an actual graph navigation", async () => {
  const harness = navigationHarness(undefined, { actualEnsure: true });
  const wait = deferred();
  harness.context.paperViewer = {
    getAnchorTarget: (id) => ({ id }), showPage: () => wait.promise, focusAnchor: async (id) => ({ id }),
  };
  const navigation = harness.context.focusGraphEdgeEvidence("edge:a");
  const request = harness.context.pendingGraphNavigation;
  await harness.context.ensureAnchorVisible("anchor:a", { scrollIntoView: false, moveKeyboardFocus: false });
  assert.equal(harness.context.pendingGraphNavigation, request);
  wait.resolve({ pageNumber: 1 });
  assert.equal(await navigation, true);
});

test("real registered targetType/targetId callbacks select exact edge and node sharing a source", async () => {
  let sequence = 0;
  const state = await createSpikeState(MultiDirectedGraph, { id: (prefix) => `${prefix}:${String(++sequence).padStart(8, "0")}` });
  const harness = navigationHarness(state);
  state.onNavigate = async () => { harness.context.synchronizeGraphSourceFocus(); };
  state.onStateChange = () => {};
  const sourceId = "anchor:text:attention";
  state.graph.addNode("node:zzshared", {
    ...state.graph.getNodeAttributes("node:concept:attention"), label: "Exact requested shared-source node", sourceAnchorIds: [sourceId],
  });
  state.graph.addDirectedEdgeWithKey("edge:zzshared", "node:concept:attention", "node:zzshared", {
    ...state.graph.getEdgeAttributes(state.graph.edges()[0]), sourceAnchorIds: [sourceId],
  });
  const tools = harness.context.instrumentTools(createToolSuite(state));
  const tool = tools.find(({ name }) => name === "paperpilot.focus_source");
  const nodeResult = await tool.execute({ targetType: "node", targetId: "node:zzshared" });
  assert.equal(nodeResult.status, "focused");
  assert.equal(harness.context.selectedGraphNodeKey, "node:zzshared");
  const edgeResult = await tool.execute({ targetType: "edge", targetId: "edge:zzshared" });
  assert.equal(edgeResult.status, "focused");
  assert.equal(harness.context.selectedGraphEdgeKey, "edge:zzshared");
  assert.equal(harness.context.selectedGraphNodeKey, null);
});

test("late native focus result cannot override a newer manual node selection", async () => {
  const harness = navigationHarness();
  const wait = deferred();
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  const [tool] = harness.context.instrumentTools([{
    name: "paperpilot.focus_source", async execute(input) {
      reached(); await wait.promise;
      return { status: "focused", targetType: input.targetType, targetId: input.targetId, anchorId: "anchor:a" };
    },
  }]);
  harness.state.focusAnchorId = "anchor:a";
  const call = tool.execute({ targetType: "edge", targetId: "edge:a" });
  await started;
  harness.context.selectGraphNode("node:shared", { announce: false });
  wait.resolve(); await call;
  assert.equal(harness.context.selectedGraphNodeKey, "node:shared");
  assert.equal(harness.context.selectedGraphEdgeKey, null);
});

test("late real native PDF navigation returns no focused receipt after a newer manual selection", async () => {
  let sequence = 0;
  const state = await createSpikeState(MultiDirectedGraph, { id: (prefix) => `${prefix}:${String(++sequence).padStart(8, "0")}` });
  const harness = navigationHarness(state, { actualEnsure: true });
  const wait = deferred(), reachedPage = deferred();
  const focusCalls = [];
  harness.context.paperViewer = {
    getAnchorTarget: (id) => ({ id }),
    showPage() { reachedPage.resolve(); return wait.promise; },
    focusAnchor: async (id) => { focusCalls.push(id); return { id }; },
  };
  state.onNavigate = harness.context.navigateObservedPaperSource;
  state.onStateChange = () => {};
  const [tool] = harness.context.instrumentTools(createToolSuite(state).filter(({ name }) => name === "paperpilot.focus_source"));
  const before = state.events.filter(({ eventType }) => eventType === "source_focused").length;
  const call = tool.execute({ targetType: "node", targetId: "node:concept:attention" });
  await reachedPage.promise;
  const passiveFocusCount = focusCalls.length;
  const passiveDestinationCount = harness.destinations.length;
  harness.context.selectGraphNode("node:paper", { announce: false });
  wait.resolve({ pageNumber: 1 });
  const result = await call;
  assert.equal(result.status, "rejected");
  assert.equal(harness.context.selectedGraphNodeKey, "node:paper");
  assert.equal(state.events.filter(({ eventType }) => eventType === "source_focused").length, before);
  assert.equal(focusCalls.length, passiveFocusCount);
  assert.equal(harness.destinations.length, passiveDestinationCount);
});

test("boot navigation callback converts missing destinations and private render errors to safe failures", async () => {
  const harness = navigationHarness();
  for (const fail of [async () => null, async () => { throw new Error("PRIVATE E:\\research\\secret.pdf"); }]) {
    harness.setEnsure(fail);
    await assert.rejects(harness.context.navigateObservedPaperSource(harness.state.anchors.get("anchor:a")), {
      message: "The requested paper source could not be opened. Read the current focus and retry.",
    });
  }
  assert.match(appSource, /onNavigate:\s*navigateObservedPaperSource/u);
  assert.equal(harness.activity.filter(({ type }) => type === "source_focused").length, 0);
});

test("an optional activity renderer failure cannot turn successful source navigation into failure", async () => {
  const harness = navigationHarness();
  harness.context.recordActivity = () => { throw new Error("optional renderer"); };
  assert.equal(await harness.context.focusGraphNodeEvidence("node:a"), true);
  await assert.doesNotReject(harness.context.navigateObservedPaperSource(harness.state.anchors.get("anchor:a")));
  assert.equal(harness.context.pendingGraphNavigation, null);
  assert.doesNotMatch(harness.context.elements.graphLayoutStatus.textContent, /Could not open/u);
});
