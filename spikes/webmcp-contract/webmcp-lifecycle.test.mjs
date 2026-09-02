import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { MultiDirectedGraph } from "graphology";

import {
  TOOL_NAMES,
  createSpikeState,
  createToolSuite,
  mountToolSuite,
  validateToolResult,
} from "./contracts.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const state = await createSpikeState(MultiDirectedGraph, { now: () => "2026-09-02T12:00:00.000Z" });
  return { state, tools: createToolSuite(state) };
}

function nativeContext({ failAt, onRegister } = {}) {
  const calls = [], live = new Map();
  const failure = new Error("Native registration failed");
  const context = {
    calls, live, failure,
    async registerTool(tool, options) {
      assert.equal(this, context, "native method receiver is preserved");
      calls.push({ tool, signal: options.signal });
      live.set(tool.name, tool);
      options.signal.addEventListener("abort", () => {
        if (live.get(tool.name) === tool) live.delete(tool.name);
      }, { once: true });
      if (onRegister) await onRegister(tool, options, calls.length);
      if (calls.length === failAt) throw failure;
    },
  };
  return context;
}

function semanticSummary(state) {
  return structuredClone({
    anchors: [...state.anchors], graph: state.graph.export(), annotations: [...state.annotations],
    workspaceRevision: state.workspaceRevision, workspaceDigest: state.workspaceDigest,
    graphDigest: state.graphDigest, annotationDigest: state.annotationDigest,
    focusAnchorId: state.focusAnchorId, history: state.history, redoHistory: state.redoHistory,
    revisions: state.revisions, events: state.events, requestResults: [...state.requestResults],
    explanations: state.explanations, latestReadFocusReceipt: state.latestReadFocusReceipt,
    latestReadGraphReceipt: state.latestReadGraphReceipt,
  });
}

test("strict feature detection rejects missing native API without changing the local workspace", async () => {
  const { state, tools } = await fixture();
  const before = semanticSummary(state);
  for (const context of [null, undefined, {}, { registerTool: true }, { registerTool: "register" }]) {
    await assert.rejects(mountToolSuite(context, tools), { code: "webmcp_unavailable" });
  }
  assert.deepEqual(semanticSummary(state), before);
});

test("validates the entire ordered executable six-tool suite before any native registration", async () => {
  const { tools } = await fixture();
  for (const invalid of [
    null, {}, [], tools.slice(0, 5), [...tools].reverse(), [...tools, { name: "paperpilot.undo", execute() {} }],
    tools.map((tool, index) => index === 3 ? { ...tool, execute: null } : tool),
    tools.map((tool, index) => index === 3 ? { ...tool, name: "paperpilot.export" } : tool),
    Array(6), [tools[0], tools[1], tools[2], null, tools[4], tools[5]],
  ]) {
    const native = nativeContext();
    await assert.rejects(mountToolSuite(native, invalid), { code: "tool_suite_invalid" });
    assert.equal(native.calls.length, 0);
  }
});

test("registers unchanged six-tool schemas under one signal without producing callback evidence", async () => {
  const { state, tools } = await fixture();
  const before = semanticSummary(state);
  const originalExecutors = tools.map((tool) => tool.execute);
  const native = nativeContext();
  const handle = await mountToolSuite(native, tools);
  assert.deepEqual(handle.registrations, TOOL_NAMES);
  assert.equal(handle.active, true);
  assert.equal(handle.signal, handle.controller.signal);
  assert.equal(new Set(native.calls.map(({ signal }) => signal)).size, 1);
  assert.deepEqual(semanticSummary(state), before);
  for (const [index, { tool }] of native.calls.entries()) {
    const { execute: registeredExecute, ...registeredDefinition } = tool;
    const { execute: originalExecute, ...originalDefinition } = tools[index];
    assert.deepEqual(registeredDefinition, originalDefinition);
    assert.notEqual(registeredExecute, originalExecute);
    assert.equal(originalExecute, originalExecutors[index]);
  }
  assert.throws(() => handle.registrations.push("paperpilot.undo"), TypeError);
  handle.dispose();
});

test("callbacks retained during partial registration cannot read or mutate source state", async () => {
  const { state, tools } = await fixture();
  const pending = deferred(), reached = deferred();
  const native = nativeContext({ onRegister: async (_tool, _options, count) => {
    if (count === 4) { reached.resolve(); await pending.promise; }
  } });
  const before = semanticSummary(state);
  const mounting = mountToolSuite(native, tools);
  await reached.promise;
  for (const { tool } of native.calls) {
    const result = await tool.execute({});
    assert.equal(result.code, "webmcp_session_inactive");
    assert.equal(validateToolResult(tool.name, result), result);
  }
  assert.deepEqual(semanticSummary(state), before);
  pending.resolve();
  const handle = await mounting;
  assert.equal(handle.active, true);
  assert.equal((await native.live.get("paperpilot.read_focus").execute({})).status, "ready");
  handle.dispose();
});

test("captures the authored suite before asynchronous native registration yields", async () => {
  const { tools } = await fixture();
  const native = nativeContext({ onRegister(_tool, _options, count) {
    if (count === 1) { tools[1] = { name: "paperpilot.export", execute() { throw new Error("must not execute"); } }; }
  } });
  const handle = await mountToolSuite(native, tools);
  assert.deepEqual(native.calls.map(({ tool }) => tool.name), TOOL_NAMES);
  assert.equal((await native.live.get("paperpilot.read_graph").execute({ mode: "overview" })).status, "ready");
  handle.dispose();
});

test("each possible partial failure aborts all attempted registrations and invalidates retained callbacks", async (t) => {
  for (let failAt = 1; failAt <= TOOL_NAMES.length; failAt += 1) await t.test(`failure at registration ${failAt}`, async () => {
    const { state, tools } = await fixture();
    const before = semanticSummary(state);
    const disposals = [], native = nativeContext({ failAt });
    await assert.rejects(mountToolSuite(native, tools, { onDispose: (entry) => disposals.push(entry) }), (error) => error === native.failure);
    assert.equal(native.calls.length, failAt);
    assert.equal(native.live.size, 0);
    assert.ok(native.calls.every(({ signal }) => signal.aborted));
    assert.deepEqual(disposals, [{ reason: "partial_registration_failure", registrations: TOOL_NAMES.slice(0, failAt - 1) }]);
    for (const { tool } of native.calls) assert.equal((await tool.execute({})).code, "webmcp_session_inactive");
    assert.deepEqual(semanticSummary(state), before);
  });
});

test("sync and async cleanup-observer failures do not mask native failure or prevent disposal", async () => {
  const { tools } = await fixture();
  for (const observer of [() => { throw new Error("Observer failed"); }, async () => { throw new Error("Async observer failed"); }]) {
    const native = nativeContext({ failAt: 4 });
    await assert.rejects(mountToolSuite(native, tools, { onDispose: observer }), (error) => error === native.failure);
    assert.equal(native.live.size, 0);
    const healthyNative = nativeContext();
    const handle = await mountToolSuite(healthyNative, tools, { onDispose: observer });
    assert.deepEqual(handle.dispose(), { requiresReload: false });
    assert.equal(handle.active, false);
    assert.equal(healthyNative.live.size, 0);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("dispose is idempotent, including direct controller abort, and observer records cannot mutate registration names", async () => {
  const { tools } = await fixture();
  const native = nativeContext(), records = [];
  const handle = await mountToolSuite(native, tools, { onDispose: (entry) => { records.push(entry); entry.registrations.length = 0; } });
  handle.controller.abort();
  assert.deepEqual(handle.dispose("again"), { requiresReload: false });
  handle.dispose("again twice");
  assert.equal(records.length, 1);
  assert.equal(records[0].reason, "aborted");
  assert.equal(handle.active, false);
  assert.deepEqual(handle.registrations, TOOL_NAMES);
  assert.equal(native.live.size, 0);
});

test("stale handles remain inactive after a different document suite is mounted", async () => {
  const previous = await fixture(), current = await fixture();
  const native = nativeContext();
  const oldHandle = await mountToolSuite(native, previous.tools);
  const retained = native.calls.map(({ tool }) => tool);
  oldHandle.dispose("document_changed");
  const handle = await mountToolSuite(native, current.tools);
  const previousBefore = semanticSummary(previous.state), currentBefore = semanticSummary(current.state);
  for (const tool of retained) assert.equal((await tool.execute({})).code, "webmcp_session_inactive");
  assert.deepEqual(semanticSummary(previous.state), previousBefore);
  assert.deepEqual(semanticSummary(current.state), currentBefore);
  assert.equal((await native.live.get("paperpilot.read_focus").execute({})).status, "ready");
  assert.equal(handle.active, true);
  handle.dispose();
});

test("pre-aborted or invalid document lifecycle options register nothing", async () => {
  const { tools } = await fixture();
  const parent = new AbortController(); parent.abort();
  const native = nativeContext(), disposals = [];
  await assert.rejects(mountToolSuite(native, tools, { signal: parent.signal, onDispose: (entry) => disposals.push(entry) }),
    (error) => error.code === "webmcp_registration_aborted" && error.requiresReload === false);
  assert.equal(native.calls.length, 0);
  assert.deepEqual(disposals, [{ reason: "aborted", registrations: [] }]);
  for (const options of [null, { signal: null }, { signal: {} }, { signal: { aborted: false } }]) {
    await assert.rejects(mountToolSuite(native, tools, options), { code: "registration_options_invalid" });
    assert.equal(native.calls.length, 0);
  }
});

test("document abort interrupts pending registration, requires reload, and late native resolution cannot become ready", { timeout: 2000 }, async () => {
  const { state, tools } = await fixture();
  const parent = new AbortController(), reached = deferred(), pending = deferred();
  const records = [], before = semanticSummary(state);
  const native = nativeContext({ onRegister: async (_tool, _options, count) => {
    if (count === 3) { reached.resolve(); await pending.promise; }
  } });
  const mounting = mountToolSuite(native, tools, { signal: parent.signal, onDispose: (entry) => records.push(entry) });
  const failure = assert.rejects(mounting, (error) => error.code === "webmcp_registration_aborted" && error.requiresReload === true);
  await reached.promise; parent.abort(); await failure;
  assert.equal(native.live.size, 0);
  assert.deepEqual(records, [{ reason: "aborted", registrations: TOOL_NAMES.slice(0, 2), requiresReload: true }]);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  pending.resolve(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(native.calls.length, 3);
  for (const { tool } of native.calls) assert.equal((await tool.execute({})).code, "webmcp_session_inactive");
  assert.deepEqual(semanticSummary(state), before);
});

test("a late rejected native promise is consumed after document cancellation", { timeout: 2000 }, async () => {
  const { tools } = await fixture();
  const parent = new AbortController(), reached = deferred(), pending = deferred();
  const native = nativeContext({ onRegister: async () => { reached.resolve(); await pending.promise; } });
  const mounting = mountToolSuite(native, tools, { signal: parent.signal });
  const failure = assert.rejects(mounting, { code: "webmcp_registration_aborted" });
  await reached.promise; parent.abort(); await failure;
  pending.reject(new Error("Native late rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(native.calls.length, 1);
  assert.equal(native.live.size, 0);
});

test("document abort after readiness disposes once and removes the external lifecycle listener", async () => {
  const { tools } = await fixture();
  const parent = new AbortController(), records = [], native = nativeContext();
  const handle = await mountToolSuite(native, tools, { signal: parent.signal, onDispose: (entry) => records.push(entry) });
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  parent.abort(); handle.dispose();
  assert.equal(handle.active, false);
  assert.equal(handle.signal.aborted, true);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].requiresReload, undefined);
  assert.equal(native.live.size, 0);
});

test("callback options are forwarded with a combined signal without mutating the caller's object", async () => {
  const { tools } = await fixture();
  let seen;
  tools[0] = { ...tools[0], async execute(input, options) { seen = { input, options }; return { accepted: true }; } };
  const native = nativeContext(), handle = await mountToolSuite(native, tools);
  const caller = new AbortController(), onProgress = () => {};
  const options = Object.freeze({ signal: caller.signal, requestId: "native:request", onProgress });
  const input = { ordinary: "test input" };
  assert.deepEqual(await native.calls[0].tool.execute(input, options), { accepted: true });
  assert.equal(seen.input, input);
  assert.equal(seen.options.requestId, options.requestId);
  assert.equal(seen.options.onProgress, onProgress);
  assert.notEqual(seen.options.signal, caller.signal);
  assert.notEqual(seen.options.signal, handle.signal);
  assert.equal(seen.options.signal.aborted, false);
  assert.equal(options.signal, caller.signal);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  handle.dispose();
});

test("pre-cancelled callback fails locally while unrelated callbacks and the mount stay active", async () => {
  const { state, tools } = await fixture();
  const native = nativeContext(), handle = await mountToolSuite(native, tools);
  const before = semanticSummary(state), caller = new AbortController(); caller.abort();
  const result = await native.calls[0].tool.execute({}, { signal: caller.signal });
  assert.equal(result.code, "request_aborted");
  assert.equal(validateToolResult(TOOL_NAMES[0], result), result);
  assert.deepEqual(semanticSummary(state), before);
  assert.equal(handle.signal.aborted, false);
  assert.equal((await native.calls[0].tool.execute({})).status, "ready");
  handle.dispose();
});

test("malformed callback signals fail safely before entering the authored callback", async () => {
  const { state, tools } = await fixture();
  const native = nativeContext(), handle = await mountToolSuite(native, tools), before = semanticSummary(state);
  for (const options of [null, { signal: null }, { signal: {} }, { signal: { aborted: false } }]) {
    const result = await native.calls[0].tool.execute({}, options);
    assert.equal(result.code, "callback_options_invalid");
    validateToolResult(TOOL_NAMES[0], result);
  }
  assert.deepEqual(semanticSummary(state), before);
  handle.dispose();
});

test("per-call abort only cancels its own signal and detaches listeners after both calls settle", async () => {
  const { tools } = await fixture();
  const entered = deferred(), finish = deferred(), signals = [];
  tools[0] = { ...tools[0], async execute(_input, options) {
    signals.push(options.signal); if (signals.length === 2) entered.resolve();
    await finish.promise; return { cancelled: options.signal.aborted };
  } };
  const native = nativeContext(), handle = await mountToolSuite(native, tools);
  const baseline = getEventListeners(handle.signal, "abort").length;
  const first = new AbortController(), second = new AbortController();
  const one = native.calls[0].tool.execute({}, { signal: first.signal });
  const two = native.calls[0].tool.execute({}, { signal: second.signal });
  await entered.promise; first.abort();
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false); assert.equal(handle.signal.aborted, false);
  finish.resolve();
  assert.deepEqual(await one, { cancelled: true }); assert.deepEqual(await two, { cancelled: false });
  assert.equal(getEventListeners(handle.signal, "abort").length, baseline);
  assert.equal(getEventListeners(first.signal, "abort").length, 0); assert.equal(getEventListeners(second.signal, "abort").length, 0);
  handle.dispose();
});

test("session disposal reaches every in-flight signal without falsely racing a committed result", async () => {
  const { tools } = await fixture();
  const entered = deferred(), finish = deferred(), signals = [];
  const committed = { schemaVersion: 1, status: "applied_reversible", retainedFact: "already committed by authored handler" };
  tools[4] = { ...tools[4], async execute(_input, options) { signals.push(options.signal); entered.resolve(); await finish.promise; return committed; } };
  const native = nativeContext(), handle = await mountToolSuite(native, tools);
  const caller = new AbortController(), running = native.calls[4].tool.execute({}, { signal: caller.signal });
  await entered.promise; handle.dispose("document_changed");
  assert.equal(signals[0].aborted, true);
  finish.resolve();
  assert.equal(await running, committed, "only the canonical transaction knows whether a successful edit committed");
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.equal((await native.calls[4].tool.execute({})).code, "webmcp_session_inactive");
});

test("per-call listener cleanup also runs when the authored callback rejects", async () => {
  const { tools } = await fixture();
  const failure = new Error("Authored callback failed");
  tools[0] = { ...tools[0], async execute() { throw failure; } };
  const native = nativeContext(), handle = await mountToolSuite(native, tools);
  const baseline = getEventListeners(handle.signal, "abort").length, caller = new AbortController();
  await assert.rejects(native.calls[0].tool.execute({}, { signal: caller.signal }), (error) => error === failure);
  assert.equal(getEventListeners(handle.signal, "abort").length, baseline);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  handle.dispose();
});

test("all six real queued callbacks observe their combined session cancellation before any callback evidence", async () => {
  const { state, tools } = await fixture();
  const native = nativeContext(), handle = await mountToolSuite(native, tools), pending = deferred();
  const before = semanticSummary(state);
  state.mutationQueue = pending.promise;
  const callbacks = native.calls.map(({ tool }) => tool.execute({}));
  handle.dispose("document_changed");
  pending.resolve();
  for (const [index, result] of (await Promise.all(callbacks)).entries()) {
    assert.equal(result.code, "request_aborted", TOOL_NAMES[index]);
    validateToolResult(TOOL_NAMES[index], result);
  }
  assert.deepEqual(semanticSummary(state), before);
});

test("a queued real callback can be cancelled without disposing the ready suite", async () => {
  const { state, tools } = await fixture();
  const native = nativeContext(), handle = await mountToolSuite(native, tools), pending = deferred();
  const before = semanticSummary(state), caller = new AbortController();
  state.mutationQueue = pending.promise;
  const running = native.live.get("paperpilot.read_focus").execute({}, { signal: caller.signal });
  caller.abort(); pending.resolve();
  assert.equal((await running).code, "request_aborted");
  assert.deepEqual(semanticSummary(state), before);
  assert.equal(handle.active, true);
  assert.equal((await native.live.get("paperpilot.read_focus").execute({})).status, "ready");
  handle.dispose();
});
