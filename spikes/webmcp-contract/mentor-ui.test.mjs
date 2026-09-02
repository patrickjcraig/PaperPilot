import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MultiDirectedGraph } from "graphology";
import { createSpikeState, createToolSuite, enqueueHumanWorkspaceAction } from "./contracts.mjs";
import { createMentorReviewViewModel, applyHumanMentorDecision } from "./mentor-review.mjs";
import { captureFocusBookmark, resolveFocusBookmark, disclosureOpenState, planInteractionRefresh } from "./interaction-state.mjs";

const source = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name)
  .map((node) => [node.name.text, node.getText(ast)]));

// Execute the real production handlers against a small explicit DOM fixture.
// These tests cover control identity and dispatch, not browser layout or AT.
class Element {
  constructor(document, tag) {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.id = "";
    this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map();
    this.disabled = false; this.hidden = false; this.open = false; this.value = ""; this.text = "";
    this.handlers = new Map(); this.scrollCalls = []; this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  get childElementCount() { return this.children.length; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) {
    if (this.children.some((child) => child.contains(this.ownerDocument.activeElement))) this.ownerDocument.activeElement = this.ownerDocument.body;
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.text = ""; this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "hidden") return this.hidden ? "" : null;
    if (name === "href") return this.href || null;
    if (name.startsWith("data-")) return this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] ?? null;
    return this.attributes.get(name) ?? null;
  }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
    const match = /^([a-z][a-z0-9]*)?(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/iu.exec(selector);
    assert.ok(match, `Unsupported test selector: ${selector}`);
    const [, tag, attribute, value] = match;
    return (!tag || this.tagName === tag.toUpperCase()) && (!attribute || (this.getAttribute(attribute) !== null && (value === undefined || this.getAttribute(attribute) === value)));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    if (selector.startsWith(":scope > ")) return this.children.filter((child) => child.matches(selector.slice(9)));
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) { this.handlers.set(name, callback); }
  click() { if (!this.disabled) return this.handlers.get("click")?.(); }
  focus() { if (this.isConnected && !this.disabled) this.ownerDocument.activeElement = this; }
  scrollIntoView(options) { this.scrollCalls.push(options); }
}

function draft(overrides = {}) {
  const block = (text, authority = "mentor_background", anchorIds = [], graphEntityKeys = [], citationIds = []) => ({ text, authority, anchorIds, graphEntityKeys, citationIds });
  return {
    explanationId: "explanation:current", responseDigest: "a".repeat(64), explanationVersion: 2,
    focusAnchorId: "anchor:text", expectedWorkspaceRevision: 1, expectedGraphDigest: "b".repeat(64),
    sourceAnchorIds: ["anchor:text", "anchor:region"], graphEntityKeys: ["node:idea", "edge:uses"],
    sections: {
      quickTake: [block("A paper statement.", "document_evidence", ["anchor:text"], ["node:idea"])],
      paperFit: [block("A reading of the claim.", "mentor_interpretation", ["anchor:text"])],
      prerequisites: [block("A vector is an ordered collection of numbers.")],
      howItWorks: [block("x = Σᵢ αᵢvᵢ\nαᵢ is a weight; vᵢ is a value vector.")],
      paperEvidence: [block("The selected region supplies context.", "rendered_document_view", ["anchor:region"])],
      relatedIdeas: [block("A map connection.", "mentor_interpretation", [], ["edge:uses"])],
      limitations: [block("Further reading is unverified.", "external_source", [], [], ["citation:one"])],
    },
    sourceCoverage: [{ anchorId: "anchor:text", status: "used", explanation: "For the paper statement." }, { anchorId: "anchor:region", status: "insufficient", explanation: "Pixel use is not verified." }],
    graphCoverage: [{ entityKey: "node:idea", role: "explained" }, { entityKey: "edge:uses", role: "related" }],
    externalCitations: [{ citationId: "citation:one", title: "External reading", url: "https://example.org/reading", declaredBy: "agent", verification: "not_verified_by_paperpilot" }],
    visualEvidenceMode: "not_applicable", ...overrides,
  };
}

function harness(note = draft()) {
  const document = { body: null, activeElement: null, createElement(tag) { return new Element(document, tag); } };
  document.body = document.createElement("body"); document.activeElement = document.body;
  const byId = (id) => document.body.querySelectorAll("[id]").find((element) => element.id === id) || null;
  const make = (name, tag = "div") => { const element = document.createElement(tag); element.id = name; document.body.append(element); return element; };
  const elements = {};
  for (const name of ["paperStructureList", "criticalIdeaList", "graphOutline", "graphSelectionDetail", "annotationList", "graphSearchResults", "workspaceRevisionList", "graphVisualWorkspace"]) elements[name] = make(name);
  elements.mentorExplanationBody = make("mentor-explanation-body");
  for (const name of ["mentorExplanationState", "mentorExplanationActions", "mentorExplanationStatus", "mentorTakeaway", "goToExplanation", "workspaceStatus", "visualMode", "humanUndo", "humanRedo", "graphSearchQuery", "graphFilterKind", "graphFilterAuthority"]) elements[name] = make(name);
  elements.saveExplanation = make("save-explanation", "button");
  elements.discardExplanation = make("discard-explanation", "button");
  elements.mentorExplanationActions.append(elements.saveExplanation, elements.discardExplanation);
  elements.graphNudgeButtons = []; elements.graphLayoutReset = make("graph-layout-reset", "button");
  make("mentor-explanation-heading", "h3"); make("graph-heading", "h2");
  const graph = new MultiDirectedGraph();
  graph.addNode("node:idea", { label: "Critical idea", status: "active" });
  graph.addNode("node:values", { label: "Values", status: "active" });
  graph.addDirectedEdgeWithKey("edge:uses", "node:idea", "node:values", { kind: "uses", status: "active" });
  const paper = { paperRef: "paper:current", documentSha256: "c".repeat(64) };
  const state = { paper, graph, graphDigest: "b".repeat(64), workspaceDigest: "d".repeat(64), workspaceRevision: 1,
    anchors: new Map([["anchor:text", { ...paper, sourceKind: "exact_text", pageLabel: "2" }], ["anchor:region", { ...paper, sourceKind: "visual_region", pageLabel: "3" }]]),
    explanations: note ? [note] : [], mutationQueue: Promise.resolve(), focusAnchorId: "anchor:text", now: () => "2026-09-02T12:00:00Z", history: [], redoHistory: [], revisions: [], visualEvidenceMode: "locator_only" };
  const navigations = [], events = [], railViews = [];
  const context = vm.createContext({
    document, elements, byId, state, savedExplanations: [], snapshotDirty: false, snapshotEnabled: false,
    paperSessionGeneration: 1, pageLeaving: false, snapshotReady: true,
    lastInteractionRenderStamp: null, LIMITS: { workspaceRevisions: 200 },
    structuredClone, createMentorReviewViewModel, applyHumanMentorDecision, enqueueHumanWorkspaceAction, captureFocusBookmark, resolveFocusBookmark, disclosureOpenState, planInteractionRefresh,
    graphNodeLabel: (key) => context.state.graph.getNodeAttribute(key, "label"), humanReadable: (text = "") => text.replaceAll("_", " "),
    navigateGraphSource: async (key, options) => { navigations.push({ kind: "source", key, options }); return true; },
    focusGraphNodeEvidence: async (key) => { navigations.push({ kind: "node", key }); return true; },
    focusGraphEdgeEvidence: async (key) => { navigations.push({ kind: "edge", key }); return true; },
    showGraphRailView: (view) => railViews.push(view), prefersReducedMotion: () => true,
    recordHumanEvidenceEvent: (type, details) => events.push({ type, ...details }),
    persistBrowserWorkspace: async () => ({ status: "saved" }), markSnapshotDirty() {},
    renderWorkspaceHistory() {}, reconcileGraphPresentation() {}, syncPersistedAnnotationOverlays() {}, renderFocus() {}, renderStructuralMap() {},
    renderCriticalIdeaMap() {}, renderGraphOutline() {}, renderAnnotations() {}, renderGraphSearch() {}, renderSigma() {}, renderBrowserSaveState() {},
  });
  for (const name of ["currentMentorReview", "openMentorEvidence", "appendMentorEvidenceLinks", "renderMentorClaim", "goToMentorExplanation", "renderMentorExplanation", "decideMentorExplanation",
    "workspaceInteractionAvailable", "workspaceInteractionTargets", "captureWorkspaceInteraction", "restoreWorkspaceInteraction", "renderState"]) vm.runInContext(functions.get(name), context, { filename: `app.mjs:${name}` });
  return { context, document, elements, state, navigations, events, railViews, byId };
}

test("actual mentor renderer exposes seven semantic sections and per-claim authority without moving reader focus", () => {
  const h = harness(); h.elements.mentorTakeaway.focus();
  h.context.renderState();
  const sections = h.elements.mentorExplanationBody.querySelectorAll("details[data-mentor-section-key]");
  assert.equal(sections.length, 8, "Seven semantic sections plus optional coverage.");
  assert.equal(sections[0].open, true);
  assert.equal(sections.slice(1).every((section) => !section.open), true);
  assert.equal(h.elements.mentorExplanationBody.querySelectorAll("h4").length, 7);
  assert.match(h.elements.mentorExplanationBody.textContent, /Paper evidence/);
  assert.match(h.elements.mentorExplanationBody.textContent, /Mentor interpretation/);
  assert.match(h.elements.mentorExplanationBody.textContent, /x = Σᵢ αᵢvᵢ\nαᵢ is a weight/);
  assert.equal(h.document.activeElement, h.elements.mentorTakeaway);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.elements.goToExplanation.disabled, false);
});

test("Go to explanation is human-directed and does not change the PDF source", () => {
  const h = harness(); h.context.renderMentorExplanation();
  h.context.goToMentorExplanation();
  assert.equal(h.document.activeElement, h.byId("mentor-explanation-heading"));
  assert.equal(h.byId("mentor-explanation-heading").scrollCalls[0].behavior, "instant");
  assert.equal(h.state.focusAnchorId, "anchor:text"); assert.equal(h.navigations.length, 0);
  h.state.explanations = []; h.context.renderMentorExplanation();
  assert.equal(h.elements.goToExplanation.disabled, true);
});

test("per-claim source, node and directed-edge controls use the existing exact navigation controller", async () => {
  const h = harness(); h.context.renderMentorExplanation();
  const buttons = h.elements.mentorExplanationBody.querySelectorAll("button[data-mentor-reference]");
  for (const key of ["anchor:text", "node:idea", "edge:uses"]) {
    buttons.find((button) => button.dataset.mentorReference === key).click();
    await Promise.resolve();
  }
  assert.deepEqual(h.navigations.map(({ key, kind }) => [key, kind]), [["anchor:text", "source"], ["node:idea", "node"], ["edge:uses", "edge"]]);
  assert.deepEqual(h.railViews, ["map", "map"]);
  assert.equal(h.navigations[0].options.eventType, "mentor_evidence_focused");
});

test("missing source and tombstoned edge remain visible, disabled and cannot be activated through stale controls", async () => {
  const h = harness(); h.context.renderMentorExplanation();
  const stale = h.elements.mentorExplanationBody.querySelectorAll("button").find((button) => button.dataset.mentorReference === "edge:uses");
  h.state.anchors.delete("anchor:text"); h.state.graph.setEdgeAttribute("edge:uses", "status", "tombstoned");
  stale.click(); await Promise.resolve();
  assert.equal(h.navigations.length, 0);
  h.context.renderMentorExplanation();
  const links = h.elements.mentorExplanationBody.querySelectorAll("button").filter((button) => ["anchor:text", "edge:uses"].includes(button.dataset.mentorReference));
  assert.ok(links.length >= 2); assert.equal(links.every((button) => button.disabled), true);
  assert.equal(links.every((button) => button.textContent.startsWith("Source incomplete")), true);
});

test("semantic refresh preserves claim-control focus, disclosure choices and unsaved human takeaway", () => {
  const h = harness(); h.context.renderState();
  const section = h.elements.mentorExplanationBody.querySelectorAll("details")[1]; section.open = true;
  const button = section.querySelector("button"); button.focus();
  h.elements.mentorTakeaway.value = "My unfinished thought";
  h.state.workspaceRevision += 1; h.state.workspaceDigest = "f".repeat(64); h.context.renderState();
  const updated = h.elements.mentorExplanationBody.querySelectorAll("details")[1];
  assert.equal(updated.open, true);
  assert.equal(h.document.activeElement.dataset.interactionKey, button.dataset.interactionKey);
  assert.equal(h.document.activeElement.isConnected, true);
  assert.equal(h.elements.mentorTakeaway.value, "My unfinished thought");
  assert.equal(h.navigations.length, 0);
});

test("a same-size anchor replacement refreshes missing-source badges and falls back from a disabled source control", () => {
  const h = harness(); h.context.renderState();
  const button = h.elements.mentorExplanationBody.querySelector("button"); button.focus();
  h.state.anchors.delete("anchor:text"); h.state.anchors.set("anchor:other", { ...h.state.paper, sourceKind: "exact_text", pageLabel: "4" });
  h.context.renderState();
  const removed = h.elements.mentorExplanationBody.querySelectorAll("button").find((item) => item.dataset.mentorReference === "anchor:text");
  assert.equal(removed.disabled, true); assert.match(removed.textContent, /Source incomplete/);
  assert.equal(h.document.activeElement.isConnected, true); assert.notEqual(h.document.activeElement, removed);
});

test("safe external citations have explicit unverified labels and unsafe URLs/text cannot create active content", () => {
  const source = draft(); source.sections.quickTake[0].text = "<img src=x onerror=alert(1)> is untrusted text.";
  const h = harness(source); h.context.renderMentorExplanation();
  const link = h.elements.mentorExplanationBody.querySelector("a[href]");
  assert.equal(link.href, "https://example.org/reading"); assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.referrerPolicy, "no-referrer"); assert.match(link.textContent, /Not verified by PaperPilot/);
  assert.equal(h.elements.mentorExplanationBody.querySelectorAll("img").length, 0);
  assert.match(h.elements.mentorExplanationBody.textContent, /<img src=x/);
  source.externalCitations[0].url = "javascript:alert(1)"; h.context.renderMentorExplanation();
  assert.equal(h.elements.mentorExplanationBody.querySelectorAll("a").length, 0);
  assert.match(h.elements.mentorExplanationBody.textContent, /External source unavailable/);
});

test("visual description is a distinct accessible section with a reopenable region and locator limitation", () => {
  const h = harness(draft({ focusAnchorId: "anchor:region", visualEvidenceMode: "locator_only", visualObservation: "Reader-supplied context: two connected boxes." }));
  h.context.renderMentorExplanation();
  const headings = h.elements.mentorExplanationBody.querySelectorAll("h4");
  assert.ok(headings.some((heading) => heading.textContent === "Visual description · Mentor interpretation"));
  assert.match(h.elements.mentorExplanationBody.textContent, /Reader-supplied context: two connected boxes/);
  assert.match(h.elements.mentorExplanationBody.textContent, /has not verified pixel use/);
});

test("actual human Save keeps original claims, separates takeaway, and returns focus from the hidden action", async () => {
  const h = harness(); const before = structuredClone(h.state.explanations[0]);
  h.context.renderState(); h.elements.mentorTakeaway.value = "My own synthesis."; h.elements.saveExplanation.focus();
  await h.context.decideMentorExplanation("save");
  assert.equal(h.context.savedExplanations.length, 1);
  assert.deepEqual(h.context.savedExplanations[0].sections, before.sections);
  assert.equal(h.context.savedExplanations[0].takeaway, "My own synthesis.");
  assert.equal(h.events[0].type, "explanation_saved");
  assert.equal(h.document.activeElement, h.byId("mentor-explanation-heading"));
  assert.match(h.elements.mentorExplanationStatus.textContent, /saved in this browser/);
  assert.equal(h.navigations.length, 0);
});

test("late save completion cannot replace the status of a newer paper or explanation", async () => {
  const h = harness(); let release;
  h.context.persistBrowserWorkspace = () => new Promise((resolve) => { release = resolve; });
  h.context.renderState(); const pending = h.context.decideMentorExplanation("save");
  await new Promise((resolve) => setImmediate(resolve));
  h.context.state = { ...h.state, paper: { ...h.state.paper, paperRef: "paper:next" } };
  h.elements.mentorExplanationStatus.textContent = "Reading the next paper";
  release({ status: "saved" }); await pending;
  assert.equal(h.elements.mentorExplanationStatus.textContent, "Reading the next paper");
});

test("actual queued stage cannot turn a click on the older draft into Save or Discard of the new one", async () => {
  for (const decision of ["save", "discard"]) {
    const h = harness(null);
    const actual = await createSpikeState(MultiDirectedGraph);
    const tools = createToolSuite(actual);
    const tool = (name) => tools.find((item) => item.name === `paperpilot.${name}`);
    await tool("read_focus").execute({}); await tool("read_graph").execute({ mode: "focus" });
    const payload = {
      focusAnchorId: actual.focusAnchorId, expectedWorkspaceRevision: actual.workspaceRevision, expectedGraphDigest: actual.graphDigest,
      sections: Object.fromEntries(Object.entries(draft().sections).map(([key, blocks]) => [key, blocks.map(({ text }) => text).join("\n")])),
      sourceAnchorIds: [actual.focusAnchorId], graphEntityKeys: [], visualEvidenceMode: "not_applicable",
    };
    assert.equal((await tool("stage_explain").execute(payload)).status, "staged");
    h.context.state = actual;
    h.context.renderMentorExplanation();
    const clickedId = h.elements.mentorTakeaway.dataset.explanationId;
    let release;
    actual.mutationQueue = new Promise((resolve) => { release = resolve; });
    const staging = tool("stage_explain").execute({ ...payload, sections: { ...payload.sections, quickTake: "A newer mentor draft." } });
    const deciding = h.context.decideMentorExplanation(decision);
    release();
    assert.equal((await staging).status, "staged");
    await deciding;
    assert.notEqual(actual.explanations.at(-1).explanationId, clickedId);
    assert.equal(actual.explanations.length, 2);
    assert.equal(h.context.savedExplanations.length, 0);
    assert.equal(h.events.length, 0);
    assert.match(h.elements.mentorExplanationStatus.textContent, /newer mentor draft.*Nothing was saved or discarded/);
  }
});

test("a queued human decision captures its takeaway at click and cannot mutate a replacement paper", async () => {
  const h = harness(); h.context.renderState();
  let release;
  h.state.mutationQueue = new Promise((resolve) => { release = resolve; });
  h.elements.mentorTakeaway.value = "Clicked takeaway";
  const pending = h.context.decideMentorExplanation("save");
  h.elements.mentorTakeaway.value = "Later typing";
  release(); await pending;
  assert.equal(h.context.savedExplanations[0].takeaway, "Clicked takeaway");

  const next = harness(); next.context.renderState();
  next.state.mutationQueue = new Promise((resolve) => { release = resolve; });
  const stale = next.context.decideMentorExplanation("discard");
  next.context.state = { ...next.state, paper: { ...next.state.paper, paperRef: "paper:new" } };
  next.elements.mentorExplanationStatus.textContent = "New paper";
  release(); await stale;
  assert.equal(next.events.length, 0); assert.equal(next.state.explanations.length, 1);
  assert.equal(next.elements.mentorExplanationStatus.textContent, "New paper");
});

test("queued mentor decisions cannot cross a replacement intake before the new state is installed", async () => {
  for (const decision of ["save", "discard"]) {
    const h = harness(); h.context.renderState();
    const before = structuredClone(h.state.explanations);
    let release;
    h.state.mutationQueue = new Promise((resolve) => { release = resolve; });
    let persistenceCalls = 0;
    h.context.persistBrowserWorkspace = async () => { persistenceCalls += 1; return { status: "saved" }; };
    const pending = h.context.decideMentorExplanation(decision);
    // boot() invalidates the session and resets notes before it awaits the
    // replacement PDF. The former state object is still installed meanwhile.
    h.context.paperSessionGeneration += 1;
    h.context.savedExplanations = [];
    h.context.snapshotDirty = false;
    h.context.snapshotReady = false;
    h.elements.mentorExplanationStatus.textContent = "Opening a replacement PDF";
    release(); await pending;
    await h.context.decideMentorExplanation(decision);
    assert.equal(h.context.state, h.state, "Exercise the pre-state-swap window.");
    assert.deepEqual(h.state.explanations, before);
    assert.equal(h.state.savedExplanations, undefined);
    assert.equal(h.context.savedExplanations.length, 0);
    assert.equal(h.context.snapshotDirty, false);
    assert.equal(h.events.length, 0);
    assert.equal(persistenceCalls, 0);
    assert.equal(h.elements.mentorExplanationStatus.textContent, "Opening a replacement PDF");
  }
});

test("page exit cancels queued and newly attempted human mentor decisions without state or UI effects", async () => {
  for (const decision of ["save", "discard"]) {
    const h = harness(); h.context.renderState();
    const before = structuredClone(h.state.explanations);
    let release;
    h.state.mutationQueue = new Promise((resolve) => { release = resolve; });
    let persistenceCalls = 0;
    h.context.persistBrowserWorkspace = async () => { persistenceCalls += 1; return { status: "saved" }; };
    const pending = h.context.decideMentorExplanation(decision);
    h.context.pageLeaving = true;
    h.elements.mentorExplanationStatus.textContent = "Page is leaving";
    release(); await pending;
    await h.context.decideMentorExplanation(decision);
    assert.deepEqual(h.state.explanations, before);
    assert.equal(h.state.savedExplanations, undefined);
    assert.equal(h.context.savedExplanations.length, 0);
    assert.equal(h.context.snapshotDirty, false);
    assert.equal(h.events.length, 0);
    assert.equal(persistenceCalls, 0);
    assert.equal(h.elements.mentorExplanationStatus.textContent, "Page is leaving");
  }
});

test("a late mentor persistence result cannot announce success in a superseding intake or departed page", async () => {
  for (const cause of ["replacement", "page_exit"]) {
    const h = harness(); h.context.renderState();
    let release;
    const persistence = new Promise((resolve) => { release = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    h.context.persistBrowserWorkspace = () => { entered(); return persistence; };
    const pending = h.context.decideMentorExplanation("save");
    await started;
    const committed = structuredClone(h.state.savedExplanations);
    if (cause === "replacement") h.context.paperSessionGeneration += 1;
    else h.context.pageLeaving = true;
    h.elements.mentorExplanationStatus.textContent = "New lifecycle status";
    release({ status: "saved" }); await pending;
    assert.deepEqual(h.state.savedExplanations, committed, "A completed human decision is not retroactively erased.");
    assert.equal(h.events.length, 1);
    assert.equal(h.elements.mentorExplanationStatus.textContent, "New lifecycle status");
  }
});

test("the human Save limit preserves all saved notes and the draft, with an actionable status", async () => {
  const h = harness();
  h.context.savedExplanations = Array.from({ length: 200 }, (_, index) => draft({ explanationId: `explanation:saved:${index}`, savedAt: "2026-09-01T12:00:00Z", humanDecision: "saved" }));
  const before = structuredClone(h.context.savedExplanations);
  h.context.renderState(); h.elements.saveExplanation.focus();
  await h.context.decideMentorExplanation("save");
  assert.deepEqual(h.context.savedExplanations, before);
  assert.equal(h.state.explanations.length, 1);
  assert.equal(h.events.length, 0);
  assert.equal(h.document.activeElement, h.elements.saveExplanation);
  assert.match(h.elements.mentorExplanationStatus.textContent, /200 saved mentor notes.*Nothing was removed.*draft remains/);
});
