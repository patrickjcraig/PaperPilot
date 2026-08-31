import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_PRESENTATION_COPY,
  annotationAnchorId,
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

test("rejects malformed tool definitions before registration", () => {
  assert.throws(() => instrumentWebmcpTools({}), /must be an array/u);
  assert.throws(() => instrumentWebmcpTools([{ name: "missing callback" }]), /name and execute/u);
});
