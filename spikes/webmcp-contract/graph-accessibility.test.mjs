import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { MultiDirectedGraph } from "graphology";
import ts from "typescript";

import { projectAccessibleGraphOutline } from "./accessibility-projection.mjs";
import { humanReadable } from "./activity-ledger.mjs";
import { graphDisplayLabel } from "./graph-view-model.mjs";
import { captureFocusBookmark, resolveFocusBookmark } from "./interaction-state.mjs";

const appSource = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const parsedApp = ts.createSourceFile("app.mjs", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const appFunctions = new Map(parsedApp.statements
  .filter((node) => ts.isFunctionDeclaration(node) && node.name)
  .map((node) => [node.name.text, node.getText(parsedApp)]));

// A bounded DOM fixture, not a browser emulator. Production app function bodies
// below execute unchanged; browser proof still owns actual focus/AT rendering.
class TestElement {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = "";
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.className = "";
    this.text = "";
    this.listeners = new Map();
    this.classList = { toggle() {}, add() {}, remove() {} };
  }

  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "open") return this.open ? "" : null;
    if (name === "hidden") return this.hidden ? "" : null;
    if (name.startsWith("data-")) return this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] ?? null;
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  append(...elements) {
    for (const element of elements) {
      if (element.parentElement) element.parentElement.children = element.parentElement.children.filter((child) => child !== element);
      element.parentElement = this;
      this.children.push(element);
    }
  }
  replaceChildren(...elements) {
    const removedFocus = this.children.some((child) => child.contains(this.ownerDocument.activeElement));
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.text = "";
    this.append(...elements);
    if (removedFocus) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
    const match = /^([a-z]+)?(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/iu.exec(selector);
    assert.ok(match, `The bounded test fixture must explicitly support selector ${selector}`);
    const [, tag, attribute, value] = match;
    return (!tag || this.tagName === tag.toUpperCase())
      && (!attribute || (this.getAttribute(attribute) !== null && (value === undefined || this.getAttribute(attribute) === value)));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    if (selector.startsWith(":scope > ")) return this.children.filter((child) => child.matches(selector.slice(9)));
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {
    if (this.isConnected && !this.disabled) this.ownerDocument.activeElement = this;
  }
}

function createDocument() {
  const document = {
    body: null,
    activeElement: null,
    createElement(tag) { return new TestElement(document, tag); },
    querySelectorAll(selector) { return document.body.querySelectorAll(selector); },
    getElementById(id) { return document.body.querySelectorAll("[id]").find((element) => element.id === id) || null; },
  };
  document.body = document.createElement("body");
  document.activeElement = document.body;
  return document;
}

function graphAccessibilityHarness() {
  const document = createDocument();
  const element = (tag, id, parent = document.body) => {
    const item = document.createElement(tag);
    item.id = id;
    parent.append(item);
    return item;
  };
  const elements = {};
  for (const [name, id] of [
    ["paperStructureList", "paper-structure-list"], ["criticalIdeaList", "critical-idea-list"],
    ["graphOutline", "graph-outline"], ["annotationList", "annotation-list"],
    ["graphSearchResults", "graph-search-results"], ["mentorExplanationBody", "mentor-explanation-body"],
    ["workspaceRevisionList", "workspace-revision-list"],
  ]) elements[name] = element("div", id);
  elements.graphOutlineCount = element("span", "graph-outline-count");
  elements.graphSelection = element("section", "graph-selection");
  elements.graphSelectionHeading = element("h3", "graph-selection-heading", elements.graphSelection);
  elements.graphSelectionMeta = element("p", "graph-selection-meta", elements.graphSelection);
  elements.graphSelectionDetail = element("div", "graph-selection-detail", elements.graphSelection);
  elements.graphVisualWorkspace = element("section", "graph-visual-workspace");
  elements.graphNudgeButtons = ["left", "up", "down", "right"].map((direction) => {
    const button = element("button", "", elements.graphVisualWorkspace);
    button.dataset.graphNudge = direction;
    return button;
  });
  elements.graphLayoutReset = element("button", "graph-layout-reset", elements.graphVisualWorkspace);
  const graphHeading = element("h2", "graph-heading");
  element("h3", "mentor-explanation-heading");
  const outsideInput = element("input", "outside-input");
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  for (const [key, label, origin] of [["node:a", "An agent-refined idea", "agent"], ["node:b", "A reader idea", "reader"]]) {
    graph.addNode(key, { label, summary: `Summary for ${label}.`, kind: "concept", authority: "paper_grounded", origin,
      sourceAnchorIds: ["anchor:a"], status: "active", entityRevision: 1 });
  }
  graph.addDirectedEdgeWithKey("edge:a:b", "node:a", "node:b", {
    kind: "supports", claim: "The first idea supports the second.", authority: "paper_grounded", origin: "agent",
    sourceAnchorIds: ["anchor:a"], status: "active", entityRevision: 1,
  });
  const state = { graph, anchors: new Map([["anchor:a", { anchorId: "anchor:a", pageLabel: "4", sourceKind: "exact_text" }]]) };
  const candidates = new Map([["node:a", { rank: 1 }]]);
  const context = vm.createContext({
    document, elements, state,
    selectedGraphNodeKey: "node:a", selectedGraphEdgeKey: null,
    graphSelectionStamp: null, graphSelectionDisclosureStates: new Map(),
    initialGraphPositions: new Map([["node:a", { x: 0, y: 0 }]]),
    linkedFocusNodeKeys: new Set(), linkedFocusEdgeKeys: new Set(), sigmaRenderer: null,
    byId: (id) => document.getElementById(id),
    graphFacts: () => projectAccessibleGraphOutline(state.graph, candidates),
    humanReadable, captureFocusBookmark, resolveFocusBookmark,
    renderGraphPosition() {}, reconcileGraphPresentation() {},
    selectGraphNode() {}, focusGraphNodeEvidence() {}, focusGraphEdgeEvidence() {},
    recordActivity() {}, ensureAnchorVisible() {},
  });
  for (const name of [
    "graphCandidateStateText", "graphSourceActions", "graphRelationList", "renderGraphSelection", "renderGraphOutline",
    "workspaceInteractionAvailable", "workspaceInteractionTargets", "captureWorkspaceInteraction", "restoreWorkspaceInteraction",
    "updateGraphSelectionPresentation",
  ]) {
    assert.ok(appFunctions.has(name), `The app must retain its tested ${name} entry point.`);
    vm.runInContext(`"use strict";\n${appFunctions.get(name)}`, context, { filename: `app.mjs:${name}` });
  }
  return { context, state, elements, document, graphHeading, outsideInput, element };
}

test("actual selection detail preserves relationship disclosure and focused relation over repeated graph replacement", () => {
  const { context, state, elements, document } = graphAccessibilityHarness();
  context.renderGraphSelection();
  let details = elements.graphSelectionDetail.querySelector("details[data-selection-relations]");
  assert.equal(details.open, false);
  details.open = true;
  let relation = details.querySelector("button[data-graph-edge-key]");
  relation.focus();
  for (let revision = 2; revision <= 4; revision += 1) {
    const interaction = context.captureWorkspaceInteraction();
    assert.ok(interaction.bookmark);
    const previousRelation = relation;
    state.graph = state.graph.copy();
    state.graph.mergeNodeAttributes("node:b", { label: `An unrelated renamed idea ${revision}`, entityRevision: revision });
    const beforeRender = JSON.stringify(state.graph.export());
    context.renderGraphSelection();
    context.restoreWorkspaceInteraction(interaction);
    details = elements.graphSelectionDetail.querySelector("details[data-selection-relations]");
    relation = details.querySelector("button[data-graph-edge-key]");
    assert.equal(details.open, true);
    assert.equal(previousRelation.isConnected, false);
    assert.notEqual(relation, previousRelation);
    assert.equal(document.activeElement, relation);
    assert.equal(relation.dataset.graphEdgeKey, "edge:a:b");
    assert.equal(JSON.stringify(state.graph.export()), beforeRender, "Rendering must not mutate the graph");
  }
  details.open = false;
  state.graph = state.graph.copy();
  context.renderGraphSelection();
  assert.equal(elements.graphSelectionDetail.querySelector("details[data-selection-relations]").open, false);
});

test("relationship disclosure state belongs to its entity, not the next selected node", () => {
  const { context, elements } = graphAccessibilityHarness();
  context.renderGraphSelection();
  elements.graphSelectionDetail.querySelector("details").open = true;
  context.selectedGraphNodeKey = "node:b";
  context.renderGraphSelection();
  assert.equal(elements.graphSelectionDetail.querySelector("details").open, false);
  context.selectedGraphNodeKey = "node:a";
  context.renderGraphSelection();
  assert.equal(elements.graphSelectionDetail.querySelector("details").open, true);
  context.selectedGraphNodeKey = null;
  context.renderGraphSelection();
  assert.equal(elements.graphSelectionDetail.querySelector("details"), null);
  context.selectedGraphNodeKey = "node:a";
  context.renderGraphSelection();
  assert.equal(elements.graphSelectionDetail.querySelector("details").open, true);
});

test("actual arrangement controls keep focus during writes and fall back to the graph heading when tombstoned", () => {
  const { context, state, elements, document, graphHeading } = graphAccessibilityHarness();
  context.updateGraphSelectionPresentation();
  const button = elements.graphNudgeButtons[2];
  button.focus();
  let interaction = context.captureWorkspaceInteraction();
  assert.ok(interaction.bookmark);
  assert.equal(interaction.bookmark.target.regionKey, "graph-visual-workspace");
  assert.ok(interaction.bookmark.target.key.includes("nudge:down"));
  state.graph = state.graph.copy();
  state.graph.setNodeAttribute("node:b", "label", "Renamed while arranging another node");
  context.updateGraphSelectionPresentation();
  context.restoreWorkspaceInteraction(interaction);
  assert.equal(document.activeElement, button);
  assert.equal(button.disabled, false);

  interaction = context.captureWorkspaceInteraction();
  state.graph = state.graph.copy();
  state.graph.setNodeAttribute("node:a", "status", "tombstoned");
  state.graph.setEdgeAttribute("edge:a:b", "status", "tombstoned");
  context.updateGraphSelectionPresentation();
  context.restoreWorkspaceInteraction(interaction);
  assert.equal(elements.graphNudgeButtons.every((entry) => entry.disabled), true);
  assert.equal(document.activeElement, graphHeading);
  assert.equal(graphHeading.getAttribute("tabindex"), "-1");
});

test("reset-layout disablement has a stable fallback without overriding intentional focus elsewhere", () => {
  const { context, elements, document, graphHeading, outsideInput } = graphAccessibilityHarness();
  context.updateGraphSelectionPresentation();
  elements.graphLayoutReset.focus();
  const interaction = context.captureWorkspaceInteraction();
  assert.ok(interaction.bookmark.target.key.includes("reset-layout"));
  context.initialGraphPositions.clear();
  context.updateGraphSelectionPresentation();
  outsideInput.focus();
  context.restoreWorkspaceInteraction(interaction);
  assert.equal(document.activeElement, outsideInput);
  assert.equal(context.captureWorkspaceInteraction().bookmark, null);
  document.activeElement = document.body;
  context.restoreWorkspaceInteraction(interaction);
  assert.equal(document.activeElement, graphHeading);
});

test("focus availability checks every closed disclosure ancestor, plus hidden and inert panels", () => {
  const { context, elements, document, element } = graphAccessibilityHarness();
  const outer = element("details", "", elements.graphOutline);
  const outerSummary = element("summary", "", outer);
  outerSummary.dataset.interactionKey = "outer-summary";
  const inner = element("details", "", outer);
  const innerSummary = element("summary", "", inner);
  innerSummary.dataset.interactionKey = "inner-summary";
  const action = element("button", "", inner);
  action.dataset.interactionKey = "nested-action";
  const available = (item) => context.workspaceInteractionTargets().find((target) => target.element === item)?.available;
  assert.equal(available(outerSummary), true);
  assert.equal(available(innerSummary), false, "An inner closed-details summary is hidden by its closed outer ancestor");
  assert.equal(available(action), false);
  outer.open = true;
  assert.equal(available(innerSummary), true);
  assert.equal(available(action), false);
  inner.open = true;
  assert.equal(available(action), true);
  action.focus();
  const interaction = context.captureWorkspaceInteraction();
  outer.open = false;
  context.restoreWorkspaceInteraction(interaction);
  assert.equal(document.activeElement, outerSummary, "A still-connected but newly hidden target must use a visible fallback");
  outer.open = true;
  elements.graphOutline.hidden = true;
  assert.equal(available(outerSummary), false);
  assert.equal(available(action), false);
  elements.graphOutline.hidden = false;
  elements.graphOutline.setAttribute("inert", "");
  assert.equal(available(outerSummary), false);
  assert.equal(available(action), false);
});

test("actual detail and outline render agent-refined candidates explicitly unreviewed", () => {
  const { context, state, elements } = graphAccessibilityHarness();
  context.renderGraphSelection();
  context.renderGraphOutline();
  assert.match(elements.graphSelectionMeta.textContent, /agent refined, unreviewed/u);
  const refinedRow = elements.graphOutline.querySelector('[data-interaction-key="node:a"]');
  assert.match(refinedRow.textContent, /agent refined, unreviewed/u);
  const readerRow = elements.graphOutline.querySelector('[data-interaction-key="node:b"]');
  assert.doesNotMatch(readerRow.textContent, /unreviewed/u);
  state.graph = state.graph.copy();
  state.graph.setNodeAttribute("node:b", "origin", "automatic_map");
  context.selectedGraphNodeKey = "node:b";
  context.renderGraphSelection();
  context.renderGraphOutline();
  assert.match(elements.graphSelectionMeta.textContent, /automatically suggested, unreviewed/u);
  assert.match(elements.graphOutline.querySelector('[data-interaction-key="node:b"]').textContent, /automatically suggested, unreviewed/u);
  assert.equal(context.graphCandidateStateText({ origin: "automatic_map", authority: "document_structure" }), "");
});

function graphRendererHarness({ reducedMotion = false, constructorMode = "ready" } = {}) {
  const harness = graphAccessibilityHarness();
  const { context, state, elements, element } = harness;
  context.renderGraphOutline();
  elements.graphOutlineDetails = element("details", "graph-outline-details");
  element("summary", "outline-heading", elements.graphOutlineDetails);
  elements.graphOutlineDetails.append(elements.graphOutline);
  elements.graphCanvasShell = element("div", "graph-canvas-shell", elements.graphVisualWorkspace);
  elements.sigmaContainer = element("div", "sigma-container", elements.graphCanvasShell);
  elements.graphVisualFallback = element("p", "graph-visual-fallback", elements.graphCanvasShell);
  elements.graphVisualFallback.hidden = true;
  elements.rendererStatus = element("span", "renderer-status");
  const events = [];
  const instances = [];
  class FixtureSigma {
    constructor(graph, container, settings) {
      if (constructorMode === "throws") throw new Error("Fixture WebGL constructor failure");
      this.graph = graph;
      this.container = container;
      this.settings = settings;
      this.killed = false;
      this.camera = { getState: () => ({ x: 0.5, y: 0.5, ratio: 1 }), setState() {} };
      instances.push(this);
    }
    getSettings() { return this.settings; }
    getCamera() { return this.camera; }
    setCustomBBox() {}
    refresh() {}
    kill() { this.killed = true; }
  }
  Object.assign(context, {
    Sigma: constructorMode === "missing" ? undefined : FixtureSigma,
    activeRailView: "map", graphViewportBounds: null, sigmaGraph: null,
    draggedGraphNodeKey: null, graphDragStartPosition: null, graphDragMoved: false,
    graphVisibleNodeKeys: new Set(state.graph.nodes()), graphVisibleEdgeKeys: new Set(state.graph.edges()),
    reducedMotionQuery: { matches: reducedMotion }, graphDisplayLabel,
    window: { devicePixelRatio: 1 }, SPIKE_VERSIONS: { sigma: "fixture" },
    recordActivity(eventType, detail) { events.push({ eventType, ...detail }); },
    bindSigmaInteractions() {}, fitGraphView() {},
  });
  for (const name of ["prefersReducedMotion", "drawGraphNodeLabel", "disposeSigma", "showGraphFallback", "renderSigma"]) {
    assert.ok(appFunctions.has(name), `The app must retain its tested ${name} renderer entry point.`);
    vm.runInContext(`"use strict";\n${appFunctions.get(name)}`, context, { filename: `app.mjs:${name}` });
  }
  return { ...harness, instances, events };
}

for (const constructorMode of ["missing", "throws"]) {
  test(`actual renderSigma exposes the complete-outline fallback when the constructor ${constructorMode}`, () => {
    const { context, state, elements, instances, events } = graphRendererHarness({ constructorMode });
    const rows = [...elements.graphOutline.children];
    const outlineFacts = elements.graphOutline.textContent;
    const canonicalBefore = JSON.stringify(state.graph.export());
    context.renderSigma();
    assert.equal(elements.graphVisualFallback.hidden, false);
    assert.match(elements.graphVisualFallback.textContent, /complete outline/u);
    assert.match(elements.graphVisualFallback.textContent, /source/u);
    assert.equal(elements.graphOutlineDetails.open, true);
    assert.equal(elements.rendererStatus.textContent, constructorMode === "missing"
      ? "Outline fallback · Sigma missing" : "Accessible outline fallback");
    assert.equal(context.sigmaRenderer, null);
    assert.equal(instances.length, 0);
    assert.equal(events.some(({ eventType }) => eventType === "sigma_renderer_ready"), false);
    assert.equal(events.some(({ eventType }) => eventType === "sigma_renderer_fallback"), constructorMode === "throws");
    assert.deepEqual(elements.graphOutline.children, rows, "Fallback must keep the same outline elements and handlers");
    assert.equal(elements.graphOutline.textContent, outlineFacts);
    assert.equal(rows.length, state.graph.order + state.graph.size);
    for (const row of rows) {
      assert.equal(row.isConnected, true);
      const source = row.querySelector('[data-interaction-key="source:anchor:a"]');
      assert.ok(source?.listeners.has("click"), "Complete-outline source navigation remains wired");
    }
    assert.equal(JSON.stringify(state.graph.export()), canonicalBefore);
  });
}

test("actual renderSigma disables both zoom animations for reduced motion", () => {
  for (const reducedMotion of [true, false]) {
    const { context, instances, elements, state } = graphRendererHarness({ reducedMotion });
    const canonicalBefore = JSON.stringify(state.graph.export());
    context.renderSigma();
    assert.equal(instances.length, 1);
    const settings = instances[0].getSettings();
    assert.equal(settings.zoomDuration, reducedMotion ? 0 : 120);
    assert.equal(settings.doubleClickZoomingDuration, reducedMotion ? 0 : 120);
    assert.equal(settings.enableCameraRotation, false);
    assert.equal(elements.graphVisualFallback.hidden, true);
    assert.equal(elements.rendererStatus.textContent, "Sigma active + outline");
    assert.equal(JSON.stringify(state.graph.export()), canonicalBefore);
  }
});

test("actual renderer preserves origin colors and draws a view-only selection ring without canonical flags", () => {
  const { context, state, instances } = graphRendererHarness();
  for (const [key, authority] of [["node:structure", "document_structure"], ["node:automatic", "paper_grounded"]]) {
    state.graph.addNode(key, { label: key, summary: "A fixture presentation category.", kind: "concept", authority,
      origin: "automatic_map", sourceAnchorIds: ["anchor:a"], status: "active", entityRevision: 1 });
    context.graphVisibleNodeKeys.add(key);
  }
  const canonicalBefore = JSON.stringify(state.graph.export());
  context.renderSigma();
  const settings = instances[0].getSettings();
  assert.equal(settings.defaultDrawNodeLabel, settings.defaultDrawNodeHover);
  for (const [nodeKey, expectedColor] of [
    ["node:a", "#c7513b"], ["node:b", "#267c69"], ["node:structure", "#718598"], ["node:automatic", "#6456d6"],
  ]) {
    const data = Object.freeze({ label: state.graph.getNodeAttribute(nodeKey, "label"), x: 120, y: 80, size: 4, color: "#123456" });
    context.selectedGraphNodeKey = null;
    const unselected = settings.nodeReducer(nodeKey, data);
    context.selectedGraphNodeKey = nodeKey;
    const selected = settings.nodeReducer(nodeKey, data);
    assert.equal(unselected.color, expectedColor);
    assert.equal(selected.color, expectedColor, "Selection must not masquerade as another node origin");
    assert.equal(unselected.viewSelected, false);
    assert.equal(selected.viewSelected, true);
    assert.equal(selected.highlighted, true);
    assert.equal(selected.forceLabel, true);
    assert.notEqual(selected, data);
    assert.equal(data.color, "#123456");
    const drawn = [];
    const canvas = {
      canvas: { width: 360 },
      beginPath() { drawn.push(["beginPath"]); },
      arc(...args) { drawn.push(["arc", ...args]); },
      stroke() { drawn.push(["stroke", this.strokeStyle, this.lineWidth]); },
      measureText(text) { return { width: text.length * 5 }; },
      fillRect() {}, fillText() {},
    };
    settings.defaultDrawNodeLabel(canvas, selected, settings);
    assert.deepEqual(drawn, [["beginPath"], ["arc", selected.x, selected.y, selected.size + 3, 0, Math.PI * 2], ["stroke", "#14213d", 1.5]]);
    drawn.length = 0;
    settings.defaultDrawNodeLabel(canvas, unselected, settings);
    assert.equal(drawn.length, 0, "Unselected nodes must not receive the selection ring");
    for (const field of ["viewSelected", "highlighted", "forceLabel", "selected", "zIndex", "color", "size"]) {
      assert.equal(field in state.graph.getNodeAttributes(nodeKey), false, `Canonical ${nodeKey} must not gain ${field}`);
    }
  }
  assert.equal(JSON.stringify(state.graph.export()), canonicalBefore);
});
