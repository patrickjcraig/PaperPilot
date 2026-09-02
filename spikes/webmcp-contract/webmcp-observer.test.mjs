import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { MultiDirectedGraph } from "graphology";

import { createSpikeState, createToolSuite } from "./contracts.mjs";

import {
  TOOL_PRESENTATION_COPY,
  annotationAnchorId,
  createObservedPresentation,
  createObservedTrace,
  instrumentWebmcpTools,
  resolveObservedAnchor,
} from "./webmcp-observer.mjs";

function fixtureState() {
  return {
    focusAnchorId: "anchor:focus",
    anchors: new Map([
      ["anchor:focus", { pageLabel: "2", sourceKind: "exact_text" }],
      ["anchor:issued", { pageLabel: "4", sourceKind: "page_region" }],
    ]),
    annotations: new Map([
      ["annotation:one", { sourceAnchorId: "anchor:issued" }],
    ]),
  };
}

test("resolves only page-issued source anchors for every mutation family", () => {
  const state = fixtureState();
  assert.equal(annotationAnchorId({ sourceAnchorIds: ["anchor:issued"] }), "anchor:issued");
  assert.equal(resolveObservedAnchor(state, "paperpilot.read_focus", {}, {
    focus: { anchorId: "anchor:issued" },
  }), "anchor:issued");
  assert.equal(resolveObservedAnchor(state, "paperpilot.stage_explain", {
    sourceAnchorIds: ["anchor:issued"],
  }), "anchor:issued");
  assert.equal(resolveObservedAnchor(state, "paperpilot.apply_annotation", {
    operations: [{ annotationId: "annotation:one" }],
  }), "anchor:issued");
  assert.equal(resolveObservedAnchor(state, "paperpilot.apply_annotation", {
    operations: [{ anchorId: "anchor:not-issued" }],
  }), "anchor:focus");
  assert.equal(resolveObservedAnchor(state, "paperpilot.apply_graph", {
    operations: [{ node: { sourceAnchorIds: ["anchor:not-issued", "anchor:issued"] } }],
  }), "anchor:issued");

  state.annotations.set("annotation:stale", { sourceAnchorId: "anchor:deleted" });
  assert.equal(resolveObservedAnchor(state, "paperpilot.read_focus", {}, {
    focus: { anchorId: "anchor:foreign" },
  }), "anchor:focus");
  assert.equal(resolveObservedAnchor(state, "paperpilot.focus_source", {}, {
    anchorId: "anchor:foreign",
  }), "anchor:focus");
  assert.equal(resolveObservedAnchor(state, "paperpilot.stage_explain", {
    focusAnchorId: "anchor:foreign",
    sourceAnchorIds: ["anchor:not-issued", "anchor:issued"],
  }), "anchor:issued");
  assert.equal(resolveObservedAnchor(state, "paperpilot.apply_annotation", {
    operations: [{ annotationId: "annotation:stale" }],
  }), "anchor:focus");

  state.focusAnchorId = "anchor:foreign";
  assert.equal(resolveObservedAnchor(state, "paperpilot.read_graph"), null);
});

test("creates a deterministic callback fact without inventing reasoning", () => {
  const trace = createObservedTrace({
    state: fixtureState(),
    toolName: "paperpilot.apply_graph",
    input: { operations: [{ node: { sourceAnchorIds: ["anchor:issued"] } }] },
    result: {
      status: "replayed",
      callbackReceiptId: "callback:123",
      revisionId: "revision:4",
    },
    now: () => "2026-08-31T12:00:00.000Z",
  });
  assert.deepEqual(trace, {
    toolName: "paperpilot.apply_graph",
    anchorId: "anchor:issued",
    pageLabel: "4",
    sourceKind: "page_region",
    phase: "complete",
    status: "replayed",
    code: null,
    callbackReceiptId: "callback:123",
    revisionId: "revision:4",
    replayed: true,
    observedAt: "2026-08-31T12:00:00.000Z",
  });
  assert.equal(Object.hasOwn(trace, "reasoning"), false);
  assert.equal(TOOL_PRESENTATION_COPY["paperpilot.stage_explain"].complete, "Explanation staged");
});

test("rolled-back, rejected, and unconfirmed mutation results never receive success copy or an edit flash", () => {
  for (const toolName of ["paperpilot.apply_graph", "paperpilot.apply_annotation"]) {
    for (const status of ["rolled_back", "rejected", "conflict", "returned"]) {
      const trace = createObservedTrace({ state: fixtureState(), toolName, result: { status, code: "workspace_rolled_back" } });
      const presentation = createObservedPresentation(trace);
      assert.equal(trace.status, status);
      assert.equal(presentation.phase, "error");
      assert.equal(presentation.flashAnnotation, false);
      assert.equal(presentation.label.includes("revision applied"), false);
      if (status === "rolled_back") {
        assert.match(presentation.label, /rolled back/u);
        assert.match(presentation.announcement, /prior workspace was restored/u);
        assert.match(presentation.announcement, /no annotation or graph revision from this callback remains applied/u);
      }
    }
  }
});

test("only a fresh applied annotation receipt permits an edit flash and visual replay preserves the observed outcome", () => {
  const traceFor = (toolName, status) => createObservedTrace({ state: fixtureState(), toolName, result: { status } });
  const annotation = traceFor("paperpilot.apply_annotation", "applied_reversible");
  assert.equal(createObservedPresentation(annotation).flashAnnotation, true);
  assert.equal(createObservedPresentation(traceFor("paperpilot.apply_graph", "applied_reversible")).flashAnnotation, false);
  assert.equal(createObservedPresentation(traceFor("paperpilot.apply_annotation", "replayed")).flashAnnotation, false);
  assert.match(createObservedPresentation(traceFor("paperpilot.apply_annotation", "replayed")).label, /no new revision/u);
  for (const status of ["applied_reversible", "replayed", "rolled_back", "rejected"]) {
    const presentation = createObservedPresentation(traceFor("paperpilot.apply_annotation", status), { replay: true });
    assert.equal(presentation.flashAnnotation, false);
    assert.equal(presentation.phase, status === "rolled_back" || status === "rejected" ? "error" : "complete");
    assert.match(presentation.label, /^Replay/u);
    assert.match(presentation.announcement, /No tool or command ran during this replay and no revision changed/u);
  }
});

test("the app result and replay helpers show rollback errors and remove leftover edit styling without replaying an edit", async () => {
  const source = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function showToolResult(");
  const end = source.indexOf("function enqueueObservedTraceReplay(", start);
  assert.ok(start >= 0 && end > start);
  const makeTarget = () => {
    const classes = new Set(["is-agent-editing"]);
    return { classes, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } };
  };
  const target = makeTarget();
  const highlight = makeTarget();
  const cursorCalls = [];
  const timers = [];
  const activity = [];
  const context = {
    state: fixtureState(),
    createObservedTrace,
    createObservedPresentation,
    lastObservedTrace: null,
    elements: { replayAgentAction: { disabled: true } },
    cursorTargetForAnchor: () => target,
    placeAgentCursor: (anchorId, phase, label, announcement) => cursorCalls.push({ anchorId, phase, label, announcement }),
    document: { querySelectorAll: (selector) => selector === ".is-agent-editing" ? [target, highlight] : [highlight] },
    setTimeout: (callback) => timers.push(callback),
    waitForReplay: async () => {},
    recordActivity: (eventType, details) => activity.push({ eventType, ...details }),
  };
  const helpers = runInNewContext(`${source.slice(start, end)}\n({ showToolResult, replayObservedTrace });`, context);
  helpers.showToolResult("paperpilot.apply_annotation", {}, { status: "rolled_back", code: "workspace_rolled_back" });
  assert.equal(cursorCalls.at(-1).phase, "error");
  assert.equal(timers.length, 0);
  assert.equal(target.classes.has("is-agent-editing"), false);
  assert.equal(highlight.classes.has("is-agent-editing"), false);
  const rolledBackTrace = context.lastObservedTrace;
  helpers.showToolResult("paperpilot.apply_annotation", {}, { status: "applied_reversible" });
  assert.equal(cursorCalls.at(-1).phase, "complete");
  assert.equal(timers.length, 1);
  timers[0]();
  helpers.showToolResult("paperpilot.apply_annotation", {}, { status: "replayed", replayed: true });
  assert.equal(timers.length, 1, "an idempotent replay must not animate another edit");
  await helpers.replayObservedTrace(rolledBackTrace);
  assert.equal(cursorCalls.at(-1).phase, "error");
  assert.match(cursorCalls.at(-1).label, /rolled back/u);
  assert.equal(timers.length, 1);
  assert.deepEqual(activity.map(({ eventType }) => eventType), ["callback_visual_replay_started", "callback_visual_replay_completed"]);
  assert.equal(activity.at(-1).status, "rolled_back");
});

test("instruments callback order and preserves tool input, options, and result", async () => {
  const observed = [];
  const input = { query: "attention" };
  const options = { signal: new AbortController().signal };
  const tools = instrumentWebmcpTools([{
    name: "paperpilot.read_graph",
    description: "preserved",
    async execute(receivedInput, receivedOptions) {
      assert.equal(receivedInput, input);
      assert.equal(receivedOptions, options);
      observed.push("execute");
      return { status: "ready" };
    },
  }], {
    beforeExecute({ tool }) {
      observed.push(`before:${tool.name}`);
    },
    onResult({ result }) {
      observed.push(`result:${result.status}`);
    },
  });

  assert.equal(tools[0].description, "preserved");
  assert.deepEqual(await tools[0].execute(input, options), { status: "ready" });
  assert.deepEqual(observed, ["before:paperpilot.read_graph", "execute", "result:ready"]);
});

test("reports callback failures once and rethrows the original error", async () => {
  const failure = new Error("closed failure");
  const observed = [];
  const [tool] = instrumentWebmcpTools([{
    name: "paperpilot.read_focus",
    async execute() {
      throw failure;
    },
  }], {
    onError({ tool: failedTool, error }) {
      observed.push([failedTool.name, error]);
    },
  });
  await assert.rejects(tool.execute(), (error) => error === failure);
  assert.deepEqual(observed, [["paperpilot.read_focus", failure]]);
});

test("optional before/result observer failures preserve a returned applied receipt and never manufacture a callback error", async () => {
  for (const asyncFailure of [false, true]) {
    const failure = () => {
      if (asyncFailure) return Promise.reject(new Error("optional observer failed"));
      throw new Error("optional observer failed");
    };
    const result = { status: "applied_reversible", callbackReceiptId: "callback:applied", revisionId: "revision:one" };
    let executions = 0;
    let falseFailures = 0;
    const [tool] = instrumentWebmcpTools([{
      name: "paperpilot.apply_graph",
      async execute() { executions += 1; return result; },
    }], {
      beforeExecute: failure,
      onResult: failure,
      onError() { falseFailures += 1; },
    });
    assert.equal(await tool.execute(), result);
    assert.equal(executions, 1);
    assert.equal(falseFailures, 0);
  }
});

test("a failing error observer cannot replace the actual callback failure", async () => {
  const actualFailure = new Error("actual callback failure");
  const [tool] = instrumentWebmcpTools([{
    name: "paperpilot.read_graph",
    async execute() { throw actualFailure; },
  }], {
    async onError() { throw new Error("optional error renderer failed"); },
  });
  await assert.rejects(tool.execute(), (error) => error === actualFailure);
});

for (const kind of ["graph", "annotation"]) {
  test(`${kind} rollback/retry produces no duplicate success event and observer errors preserve the applied receipt`, async () => {
    const activity = [];
    const presentations = [];
    const state = await createSpikeState(MultiDirectedGraph, { onEvent: (event) => activity.push(event) });
    let throwOnResult = false;
    let errorCallbacks = 0;
    const tools = instrumentWebmcpTools(createToolSuite(state), {
      onResult({ tool, input, result }) {
        activity.push({ eventType: "page_callback_returned", status: result.status, toolName: tool.name });
        presentations.push(createObservedPresentation(createObservedTrace({ state, toolName: tool.name, input, result })));
        if (throwOnResult) throw new Error("optional result renderer failed");
      },
      onError() { errorCallbacks += 1; },
    });
    const tool = tools.find(({ name }) => name === `paperpilot.apply_${kind}`);
    const command = {
      idempotencyKey: `observed-${kind}-retry-0001`,
      baseWorkspaceRevision: state.workspaceRevision,
      baseWorkspaceDigest: state.workspaceDigest,
      ...(kind === "graph" ? { baseGraphDigest: state.graphDigest } : { baseAnnotationDigest: state.annotationDigest }),
      reason: "Verify truthful observed rollback and retry outcomes.",
      operations: kind === "graph" ? [{
        op: "add_node", clientRef: "client:observed:one",
        node: { kind: "concept", label: "Observed concept", summary: "A grounded contract test concept.", authority: "paper_grounded", sourceAnchorIds: ["anchor:text:attention"], salience: 0.5 },
      }] : [{
        op: "create_annotation", anchorId: "anchor:text:attention", expectedAnchorDigest: state.anchors.get("anchor:text:attention").anchorDigest,
        annotationKind: "concept", label: "Observed annotation", graphNodeKeys: ["node:concept:attention"], graphEdgeKeys: [],
      }],
    };
    state.onStateChange = () => { throw new Error("mandatory projection failed"); };
    const rollback = await tool.execute(command);
    assert.equal(rollback.status, "rolled_back");
    assert.deepEqual(activity.map(({ eventType }) => eventType), ["graph_rolled_back", "page_callback_returned"]);
    assert.equal(presentations.at(-1).phase, "error");
    assert.equal(presentations.at(-1).flashAnnotation, false);
    assert.equal(state.history.length, 0);

    state.onStateChange = () => {};
    throwOnResult = true;
    const applied = await tool.execute(command);
    assert.equal(applied.status, "applied_reversible");
    assert.equal(state.history.length, 1);
    assert.equal(presentations.at(-1).phase, "complete");
    const replayed = await tool.execute(command);
    assert.equal(replayed.status, "replayed");
    assert.equal(presentations.at(-1).flashAnnotation, false);
    const appliedType = kind === "graph" ? "graph_applied" : "annotation_changed";
    assert.equal(activity.filter(({ eventType }) => eventType === appliedType).length, 1);
    assert.equal(activity.filter(({ eventType }) => eventType === "mutation_replayed").length, 1);
    assert.deepEqual(activity.filter(({ eventType }) => eventType === "page_callback_returned").map(({ status }) => status), ["rolled_back", "applied_reversible", "replayed"]);
    assert.equal(errorCallbacks, 0);
  });
}

test("rejects malformed tool definitions before registration", () => {
  assert.throws(() => instrumentWebmcpTools({}), /must be an array/u);
  assert.throws(() => instrumentWebmcpTools([{ name: "missing callback" }]), /name and execute/u);
});
