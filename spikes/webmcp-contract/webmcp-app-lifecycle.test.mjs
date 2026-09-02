import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { MultiDirectedGraph } from "graphology";
import { captureWebmcpInput, createSpikeState, createToolSuite, mountToolSuite, TOOL_NAMES } from "./contracts.mjs";
import { instrumentWebmcpTools, resolveObservedAnchor, createObservedTrace, createObservedPresentation } from "./webmcp-observer.mjs";

const source = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name)
  .map((node) => [node.name.text, node.getText(ast)]));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function harness(modelContext = { registerTool() {} }) {
  const events = [], results = [], markers = [];
  const state = await createSpikeState(MultiDirectedGraph);
  const elements = new Proxy({}, { get(target, key) {
    return target[key] ||= { textContent: "", disabled: false, classList: { add() {}, remove() {} } };
  } });
  const context = vm.createContext({
    state, tools: [], suiteHandle: null, registrationAttempt: null, registrationClosed: false, cleanupRequiresReload: false,
    toolSessionGeneration: 0, paperSessionGeneration: 0, pageLeaving: false, paperLoadController: null, demoLoadController: null,
    visualKeyRevealed: true, visualTrialObserved: false, graphNavigationGeneration: 0,
    graphToolNavigationGenerations: new WeakMap(), elements, document: { modelContext },
    AbortController, DOMException, captureWebmcpInput, createToolSuite, mountToolSuite, TOOL_NAMES,
    instrumentWebmcpTools, resolveObservedAnchor,
    recordActivity(type, details) { events.push({ type, ...details }); },
    renderLastResult(result) { results.push(result); },
    ensureAnchorVisible: async () => ({}),
    showToolRequest(name) { markers.push({ request: name }); },
    showToolResult(name, input, result) {
      markers.push(createObservedPresentation(createObservedTrace({ state: context.state, toolName: name, input, result })));
    },
    placeAgentCursor(...args) { markers.push(args); },
    markSnapshotDirty() {}, synchronizeGraphToolNavigation() {}, renderState() {},
    invalidateGraphNavigation() { context.graphNavigationGeneration += 1; },
    clearAgentEditHighlights() {}, disposeSigma() {}, paperViewer: { destroy() {} },
  });
  for (const name of ["registerSuite", "disposeSuite", "replacePaperToolSession", "instrumentTools", "closePaperToolSession", "recordVisualTrialAssessment", "navigateObservedPaperSource"]) {
    vm.runInContext(functions.get(name), context, { filename: `app.mjs:${name}` });
  }
  return { context, events, results, markers, elements, state };
}

test("production registration guards concurrent attempts and exposes readiness only after all native registrations", async () => {
  const gate = deferred(), registered = [];
  const h = await harness({ registerTool(tool, { signal }) { registered.push({ tool, signal }); return registered.length === 1 ? gate.promise : undefined; } });
  const pending = h.context.registerSuite();
  await flush();
  await h.context.registerSuite();
  assert.equal(registered.length, 1);
  assert.equal(h.elements.disposeTools.disabled, false, "Pending registration can be cancelled from the same UI control.");
  assert.equal((await registered[0].tool.execute({})).code, "webmcp_session_inactive");
  assert.equal(h.events.some(({ type }) => type === "page_callback_returned"), false);
  gate.resolve();
  await pending;
  assert.equal(registered.length, 6);
  assert.match(h.elements.webmcpStatus.textContent, /Registered 6 \/ 6/);
  assert.equal(h.events.filter(({ type }) => type === "tool_suite_registered").length, 1);
  const result = await registered[0].tool.execute({});
  assert.equal(result.status, "ready");
  assert.equal(h.events.filter(({ type }) => type === "page_callback_returned").length, 1);
});

test("production disposal cancels pending native registration and late settlement cannot announce ready", async () => {
  const gate = deferred(), registered = [];
  const h = await harness({ registerTool(tool, { signal }) { registered.push({ tool, signal }); return gate.promise; } });
  const pending = h.context.registerSuite();
  await flush();
  h.context.disposeSuite("manual");
  await pending;
  const eventCount = h.events.length;
  gate.resolve();
  await flush();
  assert.equal(registered[0].signal.aborted, true);
  assert.equal((await registered[0].tool.execute({})).code, "webmcp_session_inactive");
  assert.equal(h.context.suiteHandle, null);
  assert.equal(h.elements.registerTools.disabled, true);
  assert.equal(h.events.length, eventCount);
  assert.equal(h.events.some(({ type }) => type === "tool_suite_registered"), false);
});

test("replacing the paper cannot clear a pending-native cleanup lock, including after late settlement", async () => {
  const gate = deferred();
  let registrations = 0;
  const h = await harness({ registerTool() { registrations += 1; return gate.promise; } });
  const pending = h.context.registerSuite();
  await flush();
  h.context.replacePaperToolSession();
  h.context.state = await createSpikeState(MultiDirectedGraph);
  await pending;
  assert.equal(h.context.cleanupRequiresReload, true);
  assert.equal(h.context.registrationClosed, true);
  await h.context.registerSuite();
  assert.equal(registrations, 1);
  assert.match(h.elements.webmcpStatus.textContent, /Local review.*reload required/);
  gate.resolve();
  await flush();
  h.context.replacePaperToolSession();
  await h.context.registerSuite();
  assert.equal(registrations, 1, "Late settlement does not establish safe same-name replacement.");
  assert.equal(h.context.cleanupRequiresReload, true);
});

test("replacing a fully registered paper can mount its fresh generation after abort cleanup", async () => {
  const signals = [];
  const h = await harness({ registerTool(tool, { signal }) { signals.push(signal); } });
  await h.context.registerSuite();
  h.context.replacePaperToolSession();
  h.context.state = await createSpikeState(MultiDirectedGraph);
  assert.equal(signals[0].aborted, true);
  assert.equal(h.context.cleanupRequiresReload, false);
  await h.context.registerSuite();
  assert.equal(signals.length, 12);
  assert.equal(h.context.suiteHandle.active, true);
});

test("settled partial-registration failure reports sanitized failure and allows an explicit retry", async () => {
  let calls = 0;
  const h = await harness({ registerTool() { calls += 1; if (calls === 2) throw new Error("private native implementation detail"); } });
  await h.context.registerSuite();
  assert.match(h.elements.webmcpStatus.textContent, /Tool registration failed/);
  assert.equal(h.elements.registerTools.disabled, false);
  assert.equal(h.elements.disposeTools.disabled, true);
  assert.equal(JSON.stringify(h.results).includes("private native"), false);
  await h.context.registerSuite();
  assert.equal(h.context.suiteHandle.active, true);
  assert.match(h.elements.webmcpStatus.textContent, /Registered 6 \/ 6/);
});

test("missing WebMCP remains local and no-paper registration never touches a native client", async () => {
  const h = await harness(null);
  await h.context.registerSuite();
  assert.match(h.elements.webmcpStatus.textContent, /Local review/);
  assert.equal(h.events.some(({ type }) => /callback|registered$/u.test(type)), false);
  h.context.state = null;
  const count = h.events.length;
  await h.context.registerSuite();
  assert.equal(h.events.length, count);
});

test("old-session callback presentation is suppressed after disposal and after document replacement", async () => {
  for (const invalidate of ["dispose", "replace"]) {
    const gate = deferred();
    const h = await harness();
    h.context.registrationAttempt = { controller: new AbortController() };
    const result = { schemaVersion: 1, status: "ready" };
    const [tool] = h.context.instrumentTools([{ name: "paperpilot.read_graph", execute: () => gate.promise }]);
    const pending = tool.execute({});
    await flush();
    if (invalidate === "dispose") h.context.disposeSuite();
    else h.context.state = await createSpikeState(MultiDirectedGraph);
    const count = h.events.length;
    gate.resolve(result);
    assert.equal(await pending, result, "Presentation cannot rewrite the authoritative callback result.");
    assert.equal(h.events.length, count);
    assert.equal(h.results.length, 0);
  }
});

test("request cancellation during the passive PDF await never paints a stale request or claims a completed action", async () => {
  const gate = deferred(), controller = new AbortController();
  const h = await harness();
  h.context.ensureAnchorVisible = () => gate.promise;
  const [tool] = h.context.instrumentTools([{ name: "paperpilot.read_graph", async execute() {
    return { schemaVersion: 1, status: "rejected", code: "request_aborted" };
  } }]);
  const pending = tool.execute({}, { signal: controller.signal });
  await flush();
  controller.abort();
  gate.resolve({});
  await pending;
  assert.equal(h.markers.some((value) => value.request), false);
  assert.equal(h.markers.at(-1).phase, "error");
  assert.match(h.markers.at(-1).label, /cancelled/);
});

test("a real committed mutation receipt stays true when only its individual observer signal aborts", async () => {
  const controller = new AbortController();
  const h = await harness();
  const receipt = { status: "applied_reversible", revisionId: "revision:committed" };
  const [tool] = h.context.instrumentTools([{ name: "paperpilot.apply_annotation", async execute() { controller.abort(); return receipt; } }]);
  assert.equal(await tool.execute({}, { signal: controller.signal }), receipt);
  assert.equal(h.results.at(-1), receipt);
  assert.equal(h.markers.at(-1).phase, "complete");
});

test("navigation cancellation rejects after its PDF await without a successful outcome", async () => {
  const gate = deferred(), controller = new AbortController();
  const h = await harness();
  h.context.ensureAnchorVisible = () => gate.promise;
  const pending = h.context.navigateObservedPaperSource(h.state.anchors.get(h.state.focusAnchorId), { signal: controller.signal });
  controller.abort();
  gate.resolve({});
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.events.some(({ type }) => type === "source_focused"), false);
});

test("pagehide/beforeunload close the same idempotent session even while native registration is pending", async () => {
  const gate = deferred();
  const h = await harness({ registerTool() { return gate.promise; } });
  const paperController = new AbortController();
  const demoController = new AbortController();
  h.context.paperLoadController = paperController;
  h.context.demoLoadController = demoController;
  const pending = h.context.registerSuite();
  await flush();
  h.context.closePaperToolSession();
  const generation = h.context.toolSessionGeneration;
  h.context.closePaperToolSession();
  await pending;
  gate.resolve();
  assert.equal(h.context.pageLeaving, true);
  assert.equal(paperController.signal.aborted, true);
  assert.equal(demoController.signal.aborted, true);
  assert.equal(h.context.demoLoadController, null);
  assert.equal(h.context.toolSessionGeneration, generation);
  assert.equal(h.events.some(({ type }) => type === "tool_suite_registered"), false);
  assert.match(source, /addEventListener\("pagehide", closePaperToolSession\)/u);
  assert.match(source, /addEventListener\("beforeunload", closePaperToolSession\)/u);
});

test("the human visual-trial button records an assessment without promoting pixel authority", async () => {
  const h = await harness();
  assert.equal(h.state.visualEvidenceMode, "locator_only");
  h.context.recordVisualTrialAssessment();
  assert.equal(h.state.visualEvidenceMode, "locator_only");
  assert.match(h.elements.visualKey.textContent, /does not verify pixel use/);
  assert.equal(h.events.at(-1).type, "visual_trial_human_assessment");
  assert.doesNotMatch(source, /visualEvidenceMode\s*=\s*"client_visible_region"/u);
  const focus = h.state.anchors.get("anchor:visual:a");
  h.state.focusAnchorId = focus.anchorId;
  const read = await createToolSuite(h.state).find(({ name }) => name === "paperpilot.read_focus").execute({});
  assert.equal(read.focus.visualEvidence.pixelUseVerified, false);
  assert.equal(read.focus.visualEvidence.mode, "locator_only");
});
