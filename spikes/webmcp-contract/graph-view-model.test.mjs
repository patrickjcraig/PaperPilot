import assert from "node:assert/strict";
import test from "node:test";
import { MultiDirectedGraph } from "graphology";

import {
  createGraphLayout,
  DEFAULT_VISIBLE_GRAPH_NODES,
  graphDisplayLabel,
  MAX_VISIBLE_GRAPH_EDGES,
  MAX_VISIBLE_GRAPH_NODES,
  projectGraphView,
} from "./graph-view-model.mjs";

function node(key, extra = {}) {
  return [key, {
    kind: "main_idea", label: key, summary: "Canonical source-grounded meaning.",
    authority: "paper_grounded", origin: "automatic_map", status: "active",
    salience: 0.5, sourceAnchorIds: [], structuralCoverage: [], ...extra,
  }];
}

function edge(key, source, target, extra = {}) {
  return [key, source, target, { kind: "relates_to", status: "active", ...extra }];
}

function graphOf(nodes = [], edges = []) {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  for (const [key, attributes] of nodes) graph.addNode(key, structuredClone(attributes));
  for (const [key, source, target, attributes] of edges) graph.addDirectedEdgeWithKey(key, source, target, structuredClone(attributes));
  return graph;
}

function sampleNodes(count = 40) {
  return [
    node("node:paper", { kind: "paper", authority: "document_structure" }),
    ...Array.from({ length: count - 1 }, (_, index) => node(`node:idea:${String(index).padStart(3, "0")}`, {
      salience: 1 - index / count,
      sourceAnchorIds: [`anchor:source:${index}`],
    })),
  ];
}

function shuffled(values, seed) {
  const result = [...values];
  let value = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    const target = value % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function assertProjectionConsistent(view, graph) {
  assert.equal(view.visibleNodeKeys.length, new Set(view.visibleNodeKeys).size);
  assert.equal(view.visibleEdgeKeys.length, new Set(view.visibleEdgeKeys).size);
  assert.equal(view.counts.visibleNodes + view.counts.hiddenNodes, view.counts.activeNodes);
  assert.equal(view.counts.visibleEdges + view.counts.hiddenEdges, view.counts.activeEdges);
  assert.equal(view.outlineNodeKeys.length, view.counts.activeNodes);
  assert.equal(view.outlineEdgeKeys.length, view.counts.activeEdges);
  const keys = new Set(view.visibleNodeKeys);
  for (const key of view.visibleEdgeKeys) {
    assert.ok(keys.has(graph.source(key)));
    assert.ok(keys.has(graph.target(key)));
  }
  for (const value of Object.values(view)) {
    if (value && typeof value === "object") assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(Object.isFrozen(view), true);
}

test("empty graph yields a complete frozen empty view and independent empty layout", () => {
  const graph = graphOf();
  const view = projectGraphView(graph);
  assertProjectionConsistent(view, graph);
  assert.deepEqual(view.visibleNodeKeys, []);
  assert.deepEqual(view.outlineEdgeKeys, []);
  assert.equal(view.truncated, false);
  assert.equal(view.outlineRecommended, false);
  assert.equal(view.selectedNodeKey, null);
  assert.equal(view.selectedEdgeKey, null);
  assert.deepEqual([...createGraphLayout(graph)], []);
  assert.notEqual(createGraphLayout(graph), createGraphLayout(graph));
});

test("default view favors paper and reader/agent additions before automatic salient candidates", () => {
  const graph = graphOf([
    ...sampleNodes(),
    node("node:reader", { origin: "reader", salience: 0, kind: "term" }),
    node("node:agent", { origin: "agent", salience: 0, kind: "prerequisite" }),
    node("node:structure", { authority: "document_structure", kind: "section", salience: 1 }),
  ]);
  const view = projectGraphView(graph);
  assertProjectionConsistent(view, graph);
  assert.equal(view.visibleNodeKeys.length, DEFAULT_VISIBLE_GRAPH_NODES);
  assert.deepEqual(view.visibleNodeKeys.slice(0, 4), ["node:paper", "node:reader", "node:agent", "node:idea:000"]);
  assert.equal(view.visibleNodeKeys.includes("node:structure"), false);
  assert.equal(view.outlineNodeKeys.includes("node:structure"), true);
  assert.equal(view.counts.activeNodes, 43);
  assert.equal(view.counts.hiddenNodes, 28);
  assert.equal(view.truncated, true);
  assert.equal(view.outlineRecommended, true);
});

test("real source pages and explicit IDs break salience ties, without parsing misleading labels or keys", () => {
  const graph = graphOf([
    node("node:page99", { sourceAnchorIds: ["anchor:early"], label: "Page 99 fake label" }),
    node("node:page01", { sourceAnchorIds: ["anchor:late"], label: "Page 1 fake label" }),
    node("node:alpha", { sourceAnchorIds: ["anchor:unknown"] }),
    node("node:Beta", { sourceAnchorIds: [] }),
  ]);
  const anchorPageIndices = new Map([["anchor:late", 12], ["anchor:early", 0]]);
  const view = projectGraphView(graph, { anchorPageIndices });
  assert.deepEqual(view.visibleNodeKeys, ["node:page99", "node:page01", "node:Beta", "node:alpha"]);
  const layout = createGraphLayout(graph, { anchorPageIndices });
  assert.equal(layout.get("node:page99").x < layout.get("node:page01").x, true);
  assert.equal(layout.get("node:page99").y > layout.get("node:Beta").y, true);
});

test("structural nodes retain source-page order ahead of salience, with unknown pages last", () => {
  const graph = graphOf([
    node("node:later", { kind: "section", salience: 1, structuralCoverage: [{ startPageIndex: 10 }] }),
    node("node:earlier", { kind: "section", salience: 0, structuralCoverage: [{ startPageIndex: 2 }] }),
    node("node:unknown", { kind: "section", salience: 1, structuralCoverage: [{ startPageIndex: -1 }] }),
  ]);
  assert.deepEqual(projectGraphView(graph).outlineNodeKeys, ["node:earlier", "node:later", "node:unknown"]);
});

test("selecting a normally hidden node reveals it and a bounded incoming/outgoing neighborhood", () => {
  const nodes = sampleNodes(50);
  const selected = "node:idea:048";
  const neighbors = ["node:idea:043", "node:idea:044", "node:idea:045", "node:idea:046", "node:idea:047"];
  const edges = neighbors.map((key, index) => index % 2
    ? edge(`edge:near:${index}`, key, selected) : edge(`edge:near:${index}`, selected, key));
  edges.push(edge("edge:parallel", selected, neighbors[0]));
  const graph = graphOf(nodes, edges);
  assert.equal(projectGraphView(graph).visibleNodeKeys.includes(selected), false);
  const view = projectGraphView(graph, { selectedNodeKey: selected });
  assertProjectionConsistent(view, graph);
  assert.equal(view.visibleNodeKeys.length, 15);
  assert.equal(view.selectedNodeKey, selected);
  assert.ok(view.visibleNodeKeys.includes("node:paper"));
  assert.ok(view.visibleNodeKeys.includes(selected));
  assert.equal(neighbors.filter((key) => view.visibleNodeKeys.includes(key)).length, 4);
  assert.ok(view.visibleEdgeKeys.includes("edge:parallel"));
});

test("selected edge always reveals its distinct endpoints and is retained under visual edge pressure", () => {
  const graph = graphOf(sampleNodes(50), Array.from({ length: 90 }, (_, index) =>
    edge(`edge:parallel:${String(index).padStart(3, "0")}`, "node:idea:047", "node:idea:048")));
  const view = projectGraphView(graph, { selectedNodeKey: "node:idea:046", selectedEdgeKey: "edge:parallel:089", maxVisibleNodes: 1 });
  assertProjectionConsistent(view, graph);
  assert.deepEqual(new Set(view.visibleNodeKeys), new Set(["node:paper", "node:idea:046", "node:idea:047", "node:idea:048"]));
  assert.equal(view.selectedEdgeKey, "edge:parallel:089");
  assert.equal(view.visibleEdgeKeys[0], "edge:parallel:089");
  assert.equal(view.visibleEdgeKeys.length, 24);
  assert.equal(view.outlineEdgeKeys.length, 90);
});

test("parallel and opposing directed edges keep explicit distinct IDs and full outline facts", () => {
  const graph = graphOf([node("node:one"), node("node:two")], [
    edge("edge:one", "node:one", "node:two"),
    edge("edge:two", "node:one", "node:two"),
    edge("edge:reverse", "node:two", "node:one"),
  ]);
  const view = projectGraphView(graph);
  assertProjectionConsistent(view, graph);
  assert.deepEqual(new Set(view.visibleEdgeKeys), new Set(["edge:one", "edge:two", "edge:reverse"]));
  assert.equal(view.counts.activeEdges, 3);
  assert.equal(view.truncated, false);
});

test("tombstones stay available for audit but cannot be selected, neighbors, or visual edges", () => {
  const graph = graphOf([
    node("node:one"), node("node:two"), node("node:gone", { status: "tombstoned", origin: "reader" }),
  ], [
    edge("edge:live", "node:one", "node:two"),
    edge("edge:gone", "node:one", "node:gone", { status: "tombstoned" }),
    edge("edge:orphan", "node:two", "node:gone"),
  ]);
  const view = projectGraphView(graph, { selectedNodeKey: "node:gone", selectedEdgeKey: "edge:gone" });
  assertProjectionConsistent(view, graph);
  assert.equal(view.selectedNodeKey, null);
  assert.equal(view.selectedEdgeKey, null);
  assert.deepEqual(view.tombstonedNodeKeys, ["node:gone"]);
  assert.deepEqual(view.tombstonedEdgeKeys, ["edge:gone"]);
  assert.deepEqual(view.outlineEdgeKeys, ["edge:live"]);
  assert.equal(view.counts.totalEdges, 3);
  assert.equal(view.counts.activeEdges, 1);
  assert.equal(createGraphLayout(graph).has("node:gone"), false);
  assert.deepEqual(projectGraphView(graph, { selectedNodeKey: "foreign:paper" }).visibleNodeKeys, view.visibleNodeKeys);
});

test("projection and layout are deterministic over node/edge/map insertion permutations", () => {
  const nodes = sampleNodes(31);
  nodes.push(node("node:reader", { origin: "reader", salience: 0 }));
  const edges = nodes.slice(1).flatMap(([key], index) => [
    edge(`edge:root:${index}`, "node:paper", key, { kind: "contains" }),
    ...(index ? [edge(`edge:idea:${index}`, nodes[index][0], key)] : []),
  ]);
  const pages = nodes.flatMap(([, attributes], index) => attributes.sourceAnchorIds.map((id) => [id, index % 5]));
  const options = { selectedNodeKey: "node:idea:029", selectedEdgeKey: "edge:idea:22", anchorPageIndices: new Map(pages) };
  const expectedView = projectGraphView(graphOf(nodes, edges), options);
  const expectedLayout = [...createGraphLayout(graphOf(nodes, edges), { nodeKeys: expectedView.visibleNodeKeys, anchorPageIndices: options.anchorPageIndices })];
  for (let seed = 1; seed <= 12; seed += 1) {
    const graph = graphOf(shuffled(nodes, seed), shuffled(edges, seed * 9));
    const actual = projectGraphView(graph, { ...options, anchorPageIndices: new Map(shuffled(pages, seed)) });
    assert.deepEqual(actual, expectedView);
    assert.deepEqual([...createGraphLayout(graph, { nodeKeys: shuffled(actual.visibleNodeKeys, seed), anchorPageIndices: options.anchorPageIndices })], expectedLayout);
  }
});

test("layout uses compact separated two-column bands instead of a near-vertical spine", () => {
  const graph = graphOf([
    node("node:paper", { kind: "paper" }),
    node("node:reader:a", { origin: "reader" }), node("node:reader:b", { origin: "reader" }),
    node("node:idea:a"), node("node:idea:b"),
    node("node:section:a", { kind: "section" }), node("node:section:b", { kind: "section" }),
    node("node:term", { kind: "term" }),
  ]);
  const layout = createGraphLayout(graph);
  assert.equal(layout.get("node:paper").x, 0);
  assert.equal(layout.get("node:idea:a").y, layout.get("node:idea:b").y);
  assert.ok(layout.get("node:idea:a").x < -0.5);
  assert.ok(layout.get("node:idea:b").x > 0.5);
  assert.ok(layout.get("node:paper").y > layout.get("node:reader:a").y);
  assert.ok(layout.get("node:reader:a").y > layout.get("node:idea:a").y);
  assert.ok(layout.get("node:idea:a").y > layout.get("node:section:a").y);
  assert.ok(layout.get("node:section:a").y > layout.get("node:term").y);
  for (const position of layout.values()) {
    assert.equal(Object.isFrozen(position), true);
    assert.ok(Math.abs(position.x) <= 1.2 && Math.abs(position.y) <= 1.2);
  }
});

test("newly revealed layout IDs avoid saved positions without moving surviving active preferences", () => {
  const graph = graphOf([node("node:alpha"), node("node:beta"), node("node:gamma"), node("node:gone", { status: "tombstoned" })]);
  const saved = new Map([
    ["node:alpha", { x: 0.78, y: 1.1 }], // The natural slot of beta.
    ["node:gamma", { x: 8, y: -7 }],
    ["node:gone", { x: 0, y: 0 }],
    ["node:foreign", { x: 1, y: 1 }],
  ]);
  const before = structuredClone(saved);
  const layout = createGraphLayout(graph, { nodeKeys: ["node:alpha", "node:beta", "node:gamma", "node:gone"], existingPositions: saved });
  assert.deepEqual(layout.get("node:alpha"), saved.get("node:alpha"));
  assert.deepEqual(layout.get("node:gamma"), saved.get("node:gamma"));
  assert.notEqual(layout.get("node:alpha"), saved.get("node:alpha"));
  assert.notDeepEqual(layout.get("node:beta"), layout.get("node:alpha"));
  assert.equal(layout.has("node:gone"), false);
  assert.equal(layout.has("node:foreign"), false);
  assert.deepEqual(saved, before);
  const reverse = createGraphLayout(graph, { existingPositions: new Map([...saved].reverse()) });
  assert.deepEqual([...reverse], [...layout]);
  layout.delete("node:alpha");
  assert.equal(saved.has("node:alpha"), true);
});

test("saved coordinates are finite bounded copies; empty requested subset means no layout", () => {
  const graph = graphOf([node("node:alpha"), node("node:beta")]);
  const layout = createGraphLayout(graph, { existingPositions: new Map([
    ["node:alpha", { x: Number.POSITIVE_INFINITY, y: 1 }],
    ["node:beta", { x: 1e10, y: -1e10 }],
  ]) });
  assert.ok(Number.isFinite(layout.get("node:alpha").x));
  assert.deepEqual(layout.get("node:beta"), { x: 10_000, y: -10_000 });
  assert.deepEqual([...createGraphLayout(graph, { nodeKeys: [] })], []);
});

test("600-node density keeps both visual modes bounded while preserving every active outline ID", () => {
  const nodes = sampleNodes(600);
  const edges = Array.from({ length: 1200 }, (_, index) => edge(`edge:dense:${String(index).padStart(4, "0")}`,
    nodes[index % 600][0], nodes[(index + 1) % 600][0]));
  const graph = graphOf(nodes, edges);
  for (const [mode, count] of [["focus", 15], ["all", MAX_VISIBLE_GRAPH_NODES]]) {
    const view = projectGraphView(graph, { mode, selectedNodeKey: "node:idea:598", selectedEdgeKey: "edge:dense:1198" });
    assertProjectionConsistent(view, graph);
    assert.equal(view.counts.visibleNodes, count);
    assert.ok(view.visibleEdgeKeys.length <= MAX_VISIBLE_GRAPH_EDGES);
    assert.equal(view.outlineNodeKeys.length, 600);
    assert.equal(view.outlineEdgeKeys.length, 1200);
    assert.ok(view.visibleNodeKeys.includes("node:idea:598"));
    assert.ok(view.visibleEdgeKeys.includes("edge:dense:1198"));
    assert.equal(view.truncated, true);
    assert.equal(view.outlineRecommended, true);
    const layout = createGraphLayout(graph, { nodeKeys: view.visibleNodeKeys });
    assert.equal(layout.size, count);
    assert.equal(new Set([...layout.values()].map(({ x, y }) => `${x}:${y}`)).size, count);
  }
  const allPositions = createGraphLayout(graph);
  assert.equal(allPositions.size, 600);
  assert.equal(new Set([...allPositions.values()].map(({ x, y }) => `${x}:${y}`)).size, 600);
  for (const position of allPositions.values()) assert.ok(Math.abs(position.x) < 10 && Math.abs(position.y) < 10);
});

test("node limit clamps invalid and oversized preferences and expanded mode never exceeds 60", () => {
  const graph = graphOf(sampleNodes(100));
  assert.equal(projectGraphView(graph, { maxVisibleNodes: NaN }).visibleNodeKeys.length, 15);
  assert.equal(projectGraphView(graph, { maxVisibleNodes: Infinity }).visibleNodeKeys.length, 15);
  assert.equal(projectGraphView(graph, { maxVisibleNodes: -5 }).visibleNodeKeys.length, 4);
  assert.equal(projectGraphView(graph, { maxVisibleNodes: 12.9 }).visibleNodeKeys.length, 12);
  assert.equal(projectGraphView(graph, { maxVisibleNodes: 1e9 }).visibleNodeKeys.length, 60);
  assert.equal(projectGraphView(graph, { mode: "all", maxVisibleNodes: 5 }).visibleNodeKeys.length, 60);
});

test("presentation projection never changes semantic labels, layout attrs, anchors, or caller collections", () => {
  const graph = graphOf([
    node("node:one", { x: 9, y: 8, label: "Canonical full label with Unicode 🧪 and source details", sourceAnchorIds: ["anchor:one"], entityRevision: 8 }),
    node("node:two", { x: -9, y: -8, structuralCoverage: [{ startPageIndex: 3, primaryAnchorId: "anchor:two" }] }),
  ], [edge("edge:one", "node:one", "node:two", { sourceAnchorIds: ["anchor:two"], entityRevision: 4 })]);
  const before = JSON.stringify(graph.export());
  const freeze = (value) => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  graph.forEachNode((_key, attributes) => freeze(attributes));
  graph.forEachEdge((_key, attributes) => freeze(attributes));
  const pages = new Map([["anchor:one", 0], ["anchor:two", 3]]);
  const view = projectGraphView(graph, { selectedEdgeKey: "edge:one", anchorPageIndices: pages });
  createGraphLayout(graph, { nodeKeys: view.visibleNodeKeys, anchorPageIndices: pages });
  graphDisplayLabel(graph.getNodeAttribute("node:one", "label"));
  assert.equal(JSON.stringify(graph.export()), before);
  assert.deepEqual([...pages], [["anchor:one", 0], ["anchor:two", 3]]);
  assert.throws(() => view.visibleNodeKeys.push("node:injected"), TypeError);
});

test("short canvas labels keep Unicode scalars and literal data, without replacing canonical labels", () => {
  assert.equal(graphDisplayLabel("  Short\n label  "), "Short label");
  assert.equal(graphDisplayLabel("🧪🧪🧪🧪🧪", { maxLength: 4 }), "🧪🧪🧪…");
  assert.equal(graphDisplayLabel("<script>evil()</script>", { maxLength: 80 }), "<script>evil()</script>");
  assert.ok(Array.from(graphDisplayLabel("z".repeat(200))).length <= 24);
  assert.equal(graphDisplayLabel("abcd", { maxLength: 0 }), "abcd");
  assert.equal(graphDisplayLabel("abcdef", { maxLength: 0 }), "abc…");
});
