import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MultiDirectedGraph } from "graphology";

import { createSpikeState, createToolSuite } from "./contracts.mjs";
import { instrumentWebmcpTools } from "./webmcp-observer.mjs";

import {
  captureFocusBookmark,
  disclosureOpenState,
  planInteractionRefresh,
  resolveFocusBookmark,
} from "./interaction-state.mjs";

const stamp = () => ({ documentKey: "paper:one", graph: {}, workspaceRevision: 1, workspaceDigest: "digest:one", anchorCount: 3, mentorKey: "none" });
const target = (rowKey, action = "arrange", overrides = {}) => ({
  key: `${rowKey}:${action}`, regionKey: "graph-outline", rowKey, available: true, ...overrides,
});

test("initial content renders, while reads and focus-only changes preserve content controls", () => {
  const current = stamp();
  assert.deepEqual(planInteractionRefresh(null, current), { content: true, mentor: true });
  assert.deepEqual(planInteractionRefresh(current, { ...current }), { content: false, mentor: false });
  assert.deepEqual(planInteractionRefresh(current, { ...current, focusAnchorId: "anchor:other" }), { content: false, mentor: false });
});

test("semantic revisions, document/graph replacement, and new anchors invalidate content", () => {
  const current = stamp();
  for (const change of [
    { workspaceRevision: 2 }, { workspaceDigest: "digest:two" }, { documentKey: "paper:two" },
    { graph: {} }, { anchorCount: 4 },
  ]) assert.deepEqual(planInteractionRefresh(current, { ...current, ...change }), { content: true, mentor: true });
  assert.equal(current.workspaceRevision, 1);
});

test("explanation arrival or human review updates the mentor without rebuilding graph controls", () => {
  const current = stamp();
  assert.deepEqual(planInteractionRefresh(current, { ...current, mentorKey: "explanation:new" }), { content: false, mentor: true });
});

test("stable focused action survives graph reorder and does not depend on the label", () => {
  const before = [target("node:a"), target("node:b"), target("node:c")];
  const bookmark = captureFocusBookmark("node:b:arrange", before);
  assert.equal(resolveFocusBookmark(bookmark, [before[2], before[0], { ...before[1], label: "Renamed" }]), "node:b:arrange");
  assert.deepEqual(before.map(({ rowKey }) => rowKey), ["node:a", "node:b", "node:c"]);
});

test("a removed or disabled action prefers the next logical old row despite reordered output", () => {
  const before = [target("node:a"), target("node:b"), target("node:c"), target("node:d")];
  const bookmark = captureFocusBookmark("node:b:arrange", before);
  const after = [target("node:new"), before[3], target("node:b", "arrange", { available: false }), before[2], before[0]];
  assert.equal(resolveFocusBookmark(bookmark, after), "node:c:arrange");
  assert.equal(resolveFocusBookmark(bookmark, [before[0]]), "node:a:arrange");
});

test("focus fallback stays inside the initiating region and handles empty or entirely replaced lists", () => {
  const bookmark = captureFocusBookmark("node:a:arrange", [target("node:a")]);
  assert.equal(resolveFocusBookmark(bookmark, [target("node:z", "source", { regionKey: "mentor" })]), null);
  assert.equal(resolveFocusBookmark(bookmark, []), null);
  assert.equal(resolveFocusBookmark(bookmark, [target("node:new")]), "node:new:arrange");
  assert.equal(captureFocusBookmark("pdf-page-control", [target("node:a")]), null);
  assert.equal(resolveFocusBookmark(null, [target("node:a")]), null);
});

test("a disabled reorder action can fall back to the surviving same card when no other row exists", () => {
  const bookmark = captureFocusBookmark("annotation:a:earlier", [target("annotation:a", "earlier")]);
  assert.equal(resolveFocusBookmark(bookmark, [target("annotation:a", "earlier", { available: false }), target("annotation:a", "card")]), "annotation:a:card");
});

test("mentor disclosure choices survive same-draft repaint but do not cross explanation identity", () => {
  const previous = new Map([["explanation:a:howItWorks", true], ["explanation:a:paperEvidence", false]]);
  assert.equal(disclosureOpenState(previous, "explanation:a:howItWorks", false), true);
  assert.equal(disclosureOpenState(previous, "explanation:a:paperEvidence", true), false);
  assert.equal(disclosureOpenState(previous, "explanation:b:howItWorks", false), false);
  assert.equal(disclosureOpenState(previous, "explanation:b:paperEvidence", true), true);
});

test("real tool reads need no content refresh and state changes render before their result receipt", async () => {
  const events = [];
  let sequence = 0;
  let previous;
  const renderStamp = (state) => ({
    documentKey: state.paper.documentSha256, graph: state.graph, workspaceRevision: state.workspaceRevision,
    workspaceDigest: state.workspaceDigest, anchorCount: state.anchors.size, mentorKey: String(state.explanations.length),
  });
  const state = await createSpikeState(MultiDirectedGraph, {
    now: () => "2026-09-01T12:00:00.000Z",
    id: (prefix) => `${prefix}:${String(++sequence).padStart(8, "0")}`,
    onStateChange(current) {
      const next = renderStamp(current);
      events.push({ kind: "render", ...planInteractionRefresh(previous, next) });
      previous = next;
    },
  });
  previous = renderStamp(state);
  const tools = new Map(instrumentWebmcpTools(createToolSuite(state), {
    onResult({ tool, result }) { events.push({ kind: "receipt", tool: tool.name, status: result.status }); },
  }).map((tool) => [tool.name, tool]));
  await tools.get("paperpilot.read_focus").execute({});
  await tools.get("paperpilot.read_graph").execute({ mode: "overview" });
  assert.deepEqual(events.map(({ kind }) => kind), ["receipt", "receipt"]);
  events.length = 0;

  const focused = await tools.get("paperpilot.focus_source").execute({ targetType: "anchor", targetId: "anchor:visual:a" });
  assert.equal(focused.status, "focused");
  assert.deepEqual(events[0], { kind: "render", content: false, mentor: false });
  assert.equal(events[1].kind, "receipt");
  events.length = 0;

  const command = {
    idempotencyKey: "interaction-state-patch", baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest, baseGraphDigest: state.graphDigest,
    reason: "Check that a real graph mutation refreshes the controls before its receipt.",
    operations: [{
      op: "add_node", clientRef: "client:interaction", node: {
        kind: "concept", label: "Reading context", summary: "A new concept linked to the exact source.",
        authority: "paper_grounded", sourceAnchorIds: ["anchor:text:attention"], salience: 0.5,
      },
    }],
  };
  const applied = await tools.get("paperpilot.apply_graph").execute(command);
  assert.equal(applied.status, "applied_reversible");
  assert.deepEqual(events[0], { kind: "render", content: true, mentor: true });
  assert.equal(events[1].kind, "receipt");
  assert.equal(events.length, 2);
  events.length = 0;
  const beforeReplay = { revision: state.workspaceRevision, digest: state.workspaceDigest };
  assert.equal((await tools.get("paperpilot.apply_graph").execute(command)).status, "replayed");
  assert.equal(events.at(-1).kind, "receipt");
  assert.equal(events.filter(({ kind }) => kind === "render").length <= 1, true);
  assert.deepEqual({ revision: state.workspaceRevision, digest: state.workspaceDigest }, beforeReplay);
});

test("composition uses one state-change render and keeps arrangement separate from source navigation", async () => {
  const source = await readFile(new URL("./app.mjs", import.meta.url), "utf8");
  const resultHook = source.slice(source.indexOf("    onResult({ tool, input, result, options })"), source.indexOf("    onError({ tool, input, error, options })"));
  assert.ok(resultHook.includes("showToolResult"));
  assert.doesNotMatch(resultHook, /renderState\(/u);
  for (const name of ["renderGraphOutline", "renderGraphSearch"]) {
    const start = source.indexOf(`function ${name}(`);
    const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
    const arrangeControl = /([A-Za-z_$][\w$]*)\.textContent = "Arrange this node";/u.exec(body)?.[1];
    assert.ok(arrangeControl, `${name} must expose a distinct Arrange control.`);
    assert.ok(body.includes(`${arrangeControl}.addEventListener("click", () => selectGraphNode(key));`),
      `${name}'s Arrange handler must only select the exact node, not navigate its PDF source.`);
    assert.match(body, /focusGraphNodeEvidence\(key\)/u,
      `${name} must retain a separate source-navigation action.`);
  }
  const selection = /function selectGraphNode\([^]*?\n\}/u.exec(source)?.[0];
  assert.ok(selection, "The Arrange selection entry point must exist.");
  assert.doesNotMatch(selection, /ensureAnchorVisible\(|focusGraphNodeEvidence\(|state\.focusAnchorId\s*=/u,
    "Selecting a node for arrangement must not move the PDF focus.");
});
