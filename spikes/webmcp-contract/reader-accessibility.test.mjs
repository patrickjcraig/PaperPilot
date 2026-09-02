import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const css = await readFile(new URL("./spike.css", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name)
  .map((node) => [node.name.text, node.getText(ast)]));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function rawCapture(overrides = {}) {
  return {
    anchorId: "anchor:draft", pageIndex: 0, documentSha256: "a".repeat(64), documentRevision: 1,
    exactText: "Attention uses weighted values.", pageViewBox: [0, 0, 600, 800], pageRotation: 0,
    normalizedBounds: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.03 }],
    pdfQuads: [[{ x: 60, y: 80 }, { x: 300, y: 80 }, { x: 300, y: 104 }, { x: 60, y: 104 }]],
    textItemRefs: ["item:1"], ...overrides,
  };
}

function harness() {
  const document = { activeElement: null, querySelector: () => ({ scrollTop: 0 }) };
  const make = (id) => ({
    id, textContent: "", value: "", disabled: false, hidden: false, required: false, inert: false,
    isConnected: true, tabIndex: 0, dataset: {}, attributes: new Map(), scrolls: [],
    setAttribute(key, value) { this.attributes.set(key, String(value)); },
    getAttribute(key) { return this.attributes.get(key) ?? null; },
    removeAttribute(key) { this.attributes.delete(key); },
    focus(options) { this.focusOptions = options; document.activeElement = this; },
    scrollIntoView(options) { this.scrolls.push(options); },
  });
  const elements = Object.fromEntries([
    "readerAnnotationError", "readerSelectionStatus", "readerAnnotationLabel", "readerRegionDescription",
    "readerNodeKind", "useTextSelection", "beginRegionSelection", "selectWholePage", "cancelRegionSelection",
    "regionDescriptionField", "createReaderAnnotation", "workspace", "graphVisualWorkspace", "graphSelection",
  ].map((id) => [id, make(id)]));
  const ids = Object.fromEntries(["paper-heading", "activity-heading", "graph-heading", "evidence-heading",
    "map-panel", "annotations-panel", "evidence-panel"].map((id) => [id, make(id)]));
  elements.readerNodeKind.value = "concept";
  elements.readerAnnotationLabel.value = "Weighted values";
  elements.graphRailTabs = ["map", "annotations", "evidence"].map((view) => {
    const tab = make(`tab:${view}`); tab.dataset.railTab = view; tab.setAttribute("aria-controls", `${view}-panel`); return tab;
  });
  const operations = [], overlays = [], activities = [], results = [], navigation = [];
  const state = { anchors: new Map(), workspaceRevision: 1, workspaceDigest: "b".repeat(64), focusAnchorId: "anchor:original" };
  let regionOptions;
  const viewer = {
    async beginRegionSelection(options) { regionOptions = options; },
    cancelRegionSelection(options) { operations.push({ type: "cancel-lens", options }); },
    async captureRegionSelection() { return rawCapture({ exactText: undefined }); },
    async captureSelection() { return rawCapture(); },
    removeAnchorOverlay(id) { overlays.push({ remove: id }); },
    upsertAnchorOverlay(value) { overlays.push({ add: value }); },
  };
  const context = vm.createContext({
    document, elements, state, paperViewer: viewer, byId: (id) => ids[id],
    readerSelectionGeneration: 0, regionSelectionActive: false, regionSelectionTrigger: null,
    pendingReaderCapture: null, pendingReaderOverlayId: null, readerAnnotationPending: null,
    activeRailView: "map", pageLeaving: false, structuredClone,
    prefersReducedMotion: () => true, requestAnimationFrame: (callback) => callback(), renderSigma() {}, renderState() {},
    async mintReaderAnchor(sourceState, capture) {
      operations.push({ type: "mint", sourceState, capture }); return { ...capture, anchorId: "anchor:saved", pageLabel: "1" };
    },
    async applyReaderAnnotation(sourceState, input) {
      operations.push({ type: "apply", sourceState, input }); sourceState.anchors.set(input.anchor.anchorId, input.anchor);
      return { status: "applied", anchorId: "anchor:saved", nodeKey: "node:reader", annotationId: "annotation:reader" };
    },
    markSnapshotDirty() { operations.push({ type: "dirty" }); },
    recordActivity(type, detail) { activities.push({ type, detail }); },
    renderLastResult(result) { results.push(result); },
    async ensureAnchorVisible(id, options) { navigation.push({ id, options }); },
  });
  for (const name of ["canonicalViewerQuads", "selectedReaderCapture", "selectedRegionCapture", "clearPendingReaderDraft",
    "reportReaderSelection", "readerSelectionFailure", "presentReaderSourceMode", "leaveRegionSelection", "cancelReaderSelection",
    "startRegionSelection", "captureReaderSelection", "performReaderAnnotationSubmission", "submitReaderAnnotation", "showGraphRailView",
    "navigateWorkspaceRegion"]) {
    assert.ok(functions.has(name), `Actual production function ${name} must exist.`);
    vm.runInContext(functions.get(name), context, { filename: `app.mjs:${name}` });
  }
  return { context, elements, ids, document, state, viewer, operations, overlays, activities, results, navigation,
    region: () => regionOptions, submit: () => context.submitReaderAnnotation({ preventDefault() {} }) };
}

test("Cancel region returns keyboard focus to the exact human opener, including whole-page", async () => {
  for (const opener of ["beginRegionSelection", "selectWholePage"]) {
    const h = harness();
    await h.context.startRegionSelection(undefined, { trigger: h.elements[opener] });
    h.elements.cancelRegionSelection.focus(); h.context.cancelReaderSelection();
    assert.equal(h.document.activeElement, h.elements[opener]);
    assert.equal(h.context.regionSelectionActive, false);
    assert.equal(h.elements.beginRegionSelection.getAttribute("aria-pressed"), "false");
    assert.equal(h.elements.useTextSelection.getAttribute("aria-pressed"), "true");
    assert.equal(h.elements.regionDescriptionField.hidden, true);
    assert.equal(h.elements.readerRegionDescription.required, false);
  }
});

test("region Enter goes to its nonvisual description, while Escape returns to its opener", async () => {
  const h = harness(); h.elements.selectWholePage.focus();
  await h.context.startRegionSelection(undefined, { trigger: h.elements.selectWholePage });
  assert.equal(h.document.activeElement, h.elements.selectWholePage, "Opening callbacks do not force the composer into focus.");
  h.region().onConfirm(); assert.equal(h.document.activeElement, h.elements.readerRegionDescription);
  h.region().onCancel(); assert.equal(h.document.activeElement, h.elements.selectWholePage);
  assert.equal(h.context.pendingReaderOverlayId, null);
});

test("cancelled or replaced-paper region callbacks cannot repaint status or steal keyboard focus", async () => {
  for (const invalidate of ["cancel", "paper"]) {
    const h = harness(); const waiting = deferred();
    h.viewer.beginRegionSelection = async (options) => { h.options = options; await waiting.promise; };
    const opening = h.context.startRegionSelection();
    if (invalidate === "cancel") h.context.cancelReaderSelection();
    else h.context.state = { ...h.state, anchors: new Map() };
    h.elements.readerAnnotationLabel.focus();
    const status = h.elements.readerSelectionStatus.textContent;
    h.options.onChange({ phase: "moved", pageNumber: 1, normalizedBounds: rawCapture().normalizedBounds, inputMethod: "keyboard" });
    h.options.onConfirm(); h.options.onCancel();
    waiting.resolve(); await opening;
    assert.equal(h.document.activeElement, h.elements.readerAnnotationLabel);
    assert.equal(h.elements.readerSelectionStatus.textContent, status);
    assert.equal(h.context.pendingReaderOverlayId, null);
  }
});

test("a late text capture cannot replace the active region or a newly opened paper", async () => {
  for (const invalidate of ["region", "paper"]) {
    const h = harness(); const waiting = deferred();
    h.viewer.captureSelection = () => waiting.promise;
    const capture = h.context.captureReaderSelection({ announceFailure: true });
    if (invalidate === "region") await h.context.startRegionSelection();
    else h.context.state = { ...h.state, anchors: new Map() };
    const status = h.elements.readerSelectionStatus.textContent;
    waiting.resolve(rawCapture()); assert.equal(await capture, null);
    assert.equal(h.context.pendingReaderCapture, null);
    assert.equal(h.elements.readerSelectionStatus.textContent, status);
    assert.equal(h.overlays.length, 0, "Old capture does not remove the new region's overlay.");
  }
});

test("selection failures use concise static recovery and the error alert, not private exception text", async () => {
  for (const [code, pattern] of [["PDF_SELECTION_CROSS_PAGE", /one PDF page/], ["PDF_SELECTION_TOO_LARGE", /1,200 characters/],
    ["PDF_SELECTION_STALE", /page changed/], ["unknown", /Select text inside one PDF page/]]) {
    const h = harness();
    h.viewer.captureSelection = async () => { throw Object.assign(new Error("private://document/session-secret"), { code }); };
    assert.equal(await h.context.captureReaderSelection({ announceFailure: true }), null);
    assert.match(h.elements.readerAnnotationError.textContent, pattern);
    assert.doesNotMatch(h.elements.readerAnnotationError.textContent, /private|secret/);
    assert.equal(h.elements.readerSelectionStatus.textContent, "");
  }
});

test("missing region description and idea name identify and focus the invalid control without writes", async () => {
  for (const missing of ["description", "label"]) {
    const h = harness();
    if (missing === "description") await h.context.startRegionSelection();
    else { h.context.pendingReaderCapture = h.context.selectedReaderCapture(rawCapture()); h.elements.readerAnnotationLabel.value = ""; }
    await h.submit();
    const control = missing === "description" ? h.elements.readerRegionDescription : h.elements.readerAnnotationLabel;
    assert.equal(control.getAttribute("aria-invalid"), "true"); assert.equal(h.document.activeElement, control);
    assert.ok(h.elements.readerAnnotationError.textContent);
    assert.equal(h.operations.filter((item) => ["mint", "apply", "dirty"].includes(item.type)).length, 0);
    h.context.reportReaderSelection("Source selected.");
    assert.equal(control.getAttribute("aria-invalid"), null); assert.equal(h.elements.readerAnnotationError.textContent, "");
  }
});

test("pending annotation remains keyboard-focusable and duplicate activation cannot submit twice", async () => {
  const h = harness(); const waiting = deferred();
  h.viewer.captureSelection = () => waiting.promise;
  h.elements.createReaderAnnotation.focus();
  const pending = h.submit();
  assert.equal(h.elements.createReaderAnnotation.getAttribute("aria-disabled"), "true");
  assert.equal(h.elements.createReaderAnnotation.getAttribute("aria-busy"), "true");
  assert.equal(h.elements.createReaderAnnotation.disabled, false);
  assert.equal(h.document.activeElement, h.elements.createReaderAnnotation);
  await h.submit(); waiting.resolve(rawCapture()); await pending;
  assert.equal(h.operations.filter((item) => item.type === "apply").length, 1);
  assert.equal(h.elements.createReaderAnnotation.getAttribute("aria-disabled"), null);
  assert.equal(h.elements.createReaderAnnotation.getAttribute("aria-busy"), null);
  assert.equal(h.document.activeElement, h.elements.createReaderAnnotation);
  assert.equal(h.navigation[0].options.moveKeyboardFocus, false);
  assert.equal(h.navigation[0].options.scrollIntoView, false);
});

test("replacing the document while a captured source is minted prevents writing or announcing for the new document", async () => {
  const h = harness(); const waiting = deferred();
  h.context.pendingReaderCapture = h.context.selectedReaderCapture(rawCapture());
  h.context.mintReaderAnchor = () => waiting.promise;
  const pending = h.submit();
  h.context.state = { ...h.state, anchors: new Map() };
  h.context.readerAnnotationPending = null;
  waiting.resolve({ ...rawCapture(), anchorId: "anchor:saved", pageLabel: "1" }); await pending;
  assert.equal(h.operations.filter((item) => ["apply", "dirty"].includes(item.type)).length, 0);
  assert.equal(h.results.length, 0); assert.equal(h.activities.length, 0); assert.equal(h.navigation.length, 0);
});

test("a committed annotation whose preview fails remains truthfully added and marked for browser save", async () => {
  const h = harness(); h.context.pendingReaderCapture = h.context.selectedReaderCapture(rawCapture());
  h.viewer.upsertAnchorOverlay = () => { throw new Error("private preview implementation details"); };
  await h.submit();
  assert.equal(h.state.anchors.has("anchor:saved"), true);
  assert.equal(h.operations.filter((item) => item.type === "dirty").length, 1);
  assert.match(h.elements.readerAnnotationError.textContent, /annotation was added.*preview could not refresh/);
  assert.equal(h.results.at(-1).status, "applied");
  assert.equal(h.activities.some((item) => item.type === "reader_annotation_graph_failed"), false);
  assert.equal(h.context.pendingReaderCapture, null, "The already committed draft cannot be accidentally retried.");
  assert.equal(h.elements.readerAnnotationLabel.value, "");
});

test("edit capacity and stale-workspace failures preserve the draft and explain why retrying immediately cannot help", async () => {
  for (const code of ["history_limit_exceeded", "graph_limit_exceeded", "annotation_limit_exceeded", "stale_workspace"]) {
    const h = harness(); const capture = h.context.selectedReaderCapture(rawCapture()); h.context.pendingReaderCapture = capture;
    h.context.applyReaderAnnotation = async () => { throw Object.assign(new Error("private implementation detail"), { code }); };
    await h.submit();
    assert.equal(h.context.pendingReaderCapture, capture);
    assert.equal(h.elements.readerAnnotationLabel.value, "Weighted values");
    assert.match(h.elements.readerAnnotationError.textContent, code === "stale_workspace" ? /workspace changed/ : /reached its editing limit/);
    assert.equal(h.operations.filter((item) => item.type === "dirty").length, 0);
  }
});

test("Evidence shortcut activates its tab before focusing the heading and never changes the PDF source", () => {
  const h = harness(); h.context.showGraphRailView("map");
  assert.equal(h.ids["evidence-panel"].hidden, true);
  assert.equal(h.context.navigateWorkspaceRegion("evidence"), true);
  assert.equal(h.ids["evidence-panel"].hidden, false);
  assert.equal(h.ids["map-panel"].hidden, true);
  assert.equal(h.document.activeElement, h.ids["evidence-heading"]);
  assert.equal(h.elements.graphRailTabs[2].tabIndex, 0);
  assert.equal(h.elements.graphRailTabs[2].getAttribute("aria-selected"), "true");
  assert.equal(h.ids["evidence-heading"].scrolls[0].behavior, "instant");
  assert.equal(h.state.focusAnchorId, "anchor:original");
  assert.equal(h.context.navigateWorkspaceRegion("graph"), true);
  assert.equal(h.ids["map-panel"].hidden, false);
  assert.equal(h.document.activeElement, h.ids["graph-heading"]);
});

test("workspace shortcuts remain inert until a paper is available and honor reduced motion", () => {
  const h = harness(); h.elements.workspace.inert = true;
  assert.equal(h.context.navigateWorkspaceRegion("paper"), false); assert.equal(h.document.activeElement, null);
  h.elements.workspace.inert = false; h.context.prefersReducedMotion = () => false;
  assert.equal(h.context.navigateWorkspaceRegion("mentor"), true);
  assert.equal(h.ids["activity-heading"].scrolls[0].behavior, "smooth");
  assert.equal(h.context.navigateWorkspaceRegion("unknown"), false);
});

test("static controls associate errors, limits and keyboard instructions with discoverable focus targets", () => {
  assert.match(html, /id="reader-annotation-error"[^>]*role="alert"[^>]*aria-atomic="true"/u);
  for (const id of ["reader-annotation-label", "reader-region-description", "create-reader-annotation", "use-text-selection", "begin-region-selection", "select-whole-page"]) {
    const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`, "u"))?.[0];
    assert.match(tag || "", /aria-describedby="[^"]*reader-annotation-error/u, id);
  }
  for (const id of ["paper-heading", "activity-heading", "graph-heading", "evidence-heading"]) {
    assert.match(html, new RegExp(`<h[23][^>]*id="${id}"[^>]*tabindex="-1"`, "u"));
  }
  for (const id of ["load-attention-demo", "paper-file-input"]) {
    assert.match(html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`, "u"))?.[0] || "", /aria-describedby="paper-source-gate-status"/u);
  }
  assert.match(html, /25 MiB and 200 pages/u);
  assert.match(html, /Shift[^<]*Arrow/u);
  assert.match(html, /Escape[^<]*opened/u);
  assert.match(html, /human trial assessment is not proof of pixel use/u);
});

function readerMarkup() {
  const markup = html.match(/<article class="paper-panel"[\s\S]*?<\/article>/u)?.[0];
  assert.ok(markup, "The centered paper remains a semantic article.");
  const tree = ts.createSourceFile("reader.tsx", markup, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(tree.parseDiagnostics.length, 0);
  const article = tree.statements[0].expression;
  const opening = (element) => ts.isJsxElement(element) ? element.openingElement : element;
  const attribute = (element, name) => opening(element).attributes.properties
    .find((property) => ts.isJsxAttribute(property) && property.name.getText(tree) === name)?.initializer?.text;
  const children = (element) => ts.isJsxElement(element)
    ? element.children.filter((child) => ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) : [];
  const descendants = (element) => children(element).flatMap((child) => [child, ...descendants(child)]);
  const elements = descendants(article);
  const byId = (id) => elements.find((element) => attribute(element, "id") === id);
  return { article, attribute, children, descendants, byId, opening, tree };
}

test("the complete annotation form precedes the PDF box in the centered reader DOM", () => {
  const { article, attribute, children, descendants, byId } = readerMarkup();
  const form = byId("reader-annotation-form"), stage = byId("paper-stage"), viewer = byId("pdf-viewer");
  const sections = children(article);
  assert.ok(sections.includes(form), "The form belongs to the paper panel, outside the PDF box.");
  assert.ok(sections.indexOf(form) < sections.indexOf(stage), "The whole form must come before the PDF box, not just be visually reordered.");
  assert.ok(descendants(stage).includes(viewer), "The continuous viewer stays inside its original PDF box.");
  assert.equal(descendants(stage).includes(form), false);
  assert.equal(attribute(viewer, "tabindex"), "0");
  assert.equal(attribute(viewer, "role"), "region");
  assert.equal(attribute(viewer, "aria-label"), "Scientific paper PDF viewer");
  assert.ok(html.indexOf('class="paper-panel"') < html.indexOf('class="activity-panel"'));
  assert.match(css, /\.workspace\s*\{[^}]*grid-template-areas:\s*"mentor paper rail"/u);
});

test("the relocated form retains one set of controls, their keyboard order and local status associations", () => {
  const { attribute, descendants, byId, opening, tree } = readerMarkup();
  const form = byId("reader-annotation-form");
  const controls = descendants(form).filter((element) => ["button", "input", "select", "textarea"].includes(opening(element).tagName.getText(tree)));
  const expected = ["use-text-selection", "begin-region-selection", "select-whole-page", "cancel-region-selection",
    "reader-annotation-label", "reader-node-kind", "create-reader-annotation", "reader-region-description"];
  assert.deepEqual(controls.map((element) => attribute(element, "id")), expected);
  const formIds = new Set(descendants(form).map((element) => attribute(element, "id")).filter(Boolean));
  assert.ok(formIds.has(attribute(form, "aria-labelledby")));
  for (const control of controls) {
    const id = attribute(control, "id");
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, "gu"))].length, 1, `${id} remains uniquely wired.`);
    assert.equal(attribute(control, "tabindex"), undefined, `${id} uses natural keyboard order.`);
    for (const description of (attribute(control, "aria-describedby") || "").split(/\s+/u).filter(Boolean)) {
      assert.ok(formIds.has(description), `${id} retains its ${description} association inside the form.`);
    }
  }
  assert.equal(attribute(byId("create-reader-annotation"), "type"), "submit");
  assert.equal(attribute(byId("reader-annotation-error"), "role"), "alert");
  assert.equal(attribute(byId("reader-selection-status"), "aria-live"), "polite");
  assert.ok(opening(byId("region-description-field")).attributes.properties.some((property) => property.name?.getText(tree) === "hidden"));
});

test("the compact annotation toolbar keeps wrapping controls and a natural single-column mobile fallback", () => {
  const formRule = css.match(/\.reader-annotation-composer\s*\{([^}]*)\}/u)?.[1] || "";
  assert.match(formRule, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, \.65fr\) auto/u);
  assert.match(formRule, /margin:\s*0 0 12px/u);
  assert.doesNotMatch(formRule, /\b(?:height|position|order):/u, "The toolbar must not clip or visually reorder keyboard content.");
  assert.match(css, /\.reader-annotation-composer > \*\s*\{\s*min-width:\s*0/u);
  assert.match(css, /\.annotation-source-mode\s*\{[^}]*flex-wrap:\s*wrap/u);
  const mobile = css.slice(css.indexOf("@media (max-width: 700px)"), css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(mobile, /\.reader-annotation-composer,[^{]*\{\s*grid-template-columns:\s*1fr/u);
  assert.match(mobile, /\.reader-annotation-composer > \*,[^{]*\{\s*grid-column:\s*1/u);
  assert.match(mobile, /\.annotation-source-mode button\s*\{[^}]*max-width:\s*100%[^}]*white-space:\s*normal/u);
  assert.match(mobile, /\.pdf-scrollport\s*\{[^}]*min-height:\s*480px/u, "The continuous paper retains its reading space.");
});

test("reflow and forced-color rules retain readable audit records and explicit error distinctions", () => {
  assert.match(css, /\.annotation-source-mode\s*\{\s*min-width:\s*0;/u);
  assert.match(css, /\.annotation-source-mode span\s*\{[^}]*flex-basis:\s*100%[^}]*overflow-wrap:\s*anywhere/u);
  for (const selector of [".annotation-chip.is-tombstoned", ".graph-fact-tombstoned", "#critical-idea-list > li.is-tombstoned"]) {
    const rule = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^}]*)\\}`, "u"))?.[1];
    assert.ok(rule, selector); assert.doesNotMatch(rule, /opacity/u);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /@media \(forced-colors: active\)/u);
  assert.match(css, /\.reader-annotation-error\s*\{[^}]*color:\s*CanvasText[^}]*border-color:\s*CanvasText/u);
  assert.match(css, /\.annotation-item\.is-agent\s*\{[^}]*border-left-style:\s*dashed/u);
  assert.match(css, /\.annotation-item\.is-reader\s*\{[^}]*border-left-style:\s*solid/u);
});
