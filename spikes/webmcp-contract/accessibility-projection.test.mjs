// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { MultiDirectedGraph } from "graphology";

import {
  projectAccessibleAnnotationSummary,
  projectAccessibleGraphOutline,
} from "./accessibility-projection.mjs";

test("projects stable Graphology node and edge facts without layout fields", () => {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  graph.addNode("node:paper", {
    label: "Paper root",
    kind: "paper",
    authority: "document_structure",
    origin: "system",
    status: "active",
    salience: 0.4,
    structuralBasis: "paper_root",
    structuralConfidence: "document_declared",
    structuralCoverage: [{ startPageIndex: 0, endPageIndex: 14, primaryAnchorId: "anchor:page:1" }],
    x: 99,
    y: -99,
  });
  graph.addNode("candidate:mechanism", {
    label: "Multi-Head Attention",
    summary: "Multiple attention heads read different representation subspaces.",
    kind: "main_idea",
    authority: "paper_grounded",
    origin: "agent",
    status: "active",
    entityRevision: 4,
    salience: 0.91,
    sourceAnchorIds: ["anchor:auto:mechanism"],
    x: -4,
    y: 8,
  });
  graph.addDirectedEdgeWithKey("edge:paper:mechanism", "node:paper", "candidate:mechanism", {
    relation: "evidenced_by",
    claim: "The paper describes multiple attention heads.",
    authority: "paper_grounded",
    origin: "agent",
    status: "active",
    entityRevision: 2,
    sourceAnchorIds: ["anchor:auto:mechanism"],
    x: 123,
  });

  const candidates = new Map([["candidate:mechanism", { rank: 2 }]]);
  const projected = projectAccessibleGraphOutline(
    /** @type {any} */ (graph),
    candidates,
  );

  assert.deepEqual(projected.nodes.map(({ key }) => key), ["node:paper", "candidate:mechanism"]);
  assert.deepEqual(projected.nodes[1], {
    type: "node",
    key: "candidate:mechanism",
    label: "Multi-Head Attention",
    summary: "Multiple attention heads read different representation subspaces.",
    kind: "main_idea",
    authority: "paper_grounded",
    origin: "agent",
    status: "active",
    statusText: "active",
    entityRevision: 4,
    sourceIds: ["anchor:auto:mechanism"],
    sourceCount: 1,
    primarySourceId: "anchor:auto:mechanism",
    sourceState: "declared",
    sourceStatusText: "1 linked source",
    incomingEdgeKeys: ["edge:paper:mechanism"],
    outgoingEdgeKeys: [],
    structuralCoverage: [],
    structuralRangeText: null,
    structuralBasis: null,
    structuralBasisText: null,
    structuralConfidence: null,
    structuralConfidenceText: null,
    candidateRank: 2,
    candidateState: "agent refined",
    text: "Node · Multi-Head Attention · Multiple attention heads read different representation subspaces. · main idea · paper grounded · agent · active · revision 4 · critical candidate rank 2 · agent refined, unreviewed · 1 linked source · source anchor:auto:mechanism",
  });
  assert.equal(
    projected.nodes[0].text,
    "Node · Paper root · paper · document structure · system · active · pages 1–15 · structural source paper root · confidence document-provided · 1 linked source · paper source anchor:page:1",
  );
  assert.deepEqual(projected.edges[0], {
    type: "edge",
    key: "edge:paper:mechanism",
    sourceKey: "node:paper",
    targetKey: "candidate:mechanism",
    sourceLabel: "Paper root",
    targetLabel: "Multi-Head Attention",
    relation: "evidenced_by",
    claim: "The paper describes multiple attention heads.",
    summary: "The paper describes multiple attention heads.",
    authority: "paper_grounded",
    origin: "agent",
    status: "active",
    statusText: "active",
    entityRevision: 2,
    sourceIds: ["anchor:auto:mechanism"],
    sourceCount: 1,
    primarySourceId: "anchor:auto:mechanism",
    sourceState: "declared",
    sourceStatusText: "1 linked source",
    text: "Edge · Paper root → Multi-Head Attention · evidenced by · The paper describes multiple attention heads. · paper grounded · agent · active · revision 2 · 1 linked source · source anchor:auto:mechanism",
  });
  assert.equal("x" in projected.nodes[1], false);
  assert.equal("y" in projected.nodes[1], false);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.nodes[0].sourceIds), true);
});
test("orders the paper root and structural leaves by page before semantic rank and salience", () => {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  graph.addNode("node:semantic:higher", {
    authority: "paper_grounded",
    salience: 0.8,
    sourceAnchorIds: [],
  });
  graph.addNode("candidate:first", {
    label: "First candidate",
    origin: "automatic_map",
    authority: "paper_grounded",
    sourceAnchorIds: ["anchor:candidate:1"],
  });
  graph.addNode("node:structure:later", {
    label: "Pages 5–10",
    kind: "section",
    authority: "document_structure",
    origin: "automatic_map",
    status: "active",
    salience: 0.99,
    structuralBasis: "page_fallback",
    structuralConfidence: "coverage_fallback",
    structuralCoverage: [{ startPageIndex: 4, endPageIndex: 9, primaryAnchorId: "anchor:structure:fallback" }],
  });
  graph.addNode("node:paper", {
    label: "Paper root",
    kind: "paper",
    authority: "document_structure",
    origin: "system",
    status: "active",
    structuralBasis: "paper_root",
    structuralConfidence: "document_declared",
    structuralCoverage: [{ startPageIndex: 0, endPageIndex: 9, primaryAnchorId: "anchor:page:1" }],
  });
  graph.addNode("node:structure:earlier", {
    label: "Methods",
    kind: "section",
    authority: "document_structure",
    origin: "automatic_map",
    status: "active",
    salience: 0.01,
    structuralBasis: "heading_heuristic",
    structuralConfidence: "system_inferred",
    structuralCoverage: [{ startPageIndex: 1, endPageIndex: 3, primaryAnchorId: "anchor:structure:methods" }],
  });
  graph.addDirectedEdgeWithKey("edge:default", "node:semantic:higher", "candidate:first", {});

  const projected = projectAccessibleGraphOutline(
    /** @type {any} */ (graph),
    new Map([["candidate:first", { rank: 1 }]]),
  );

  assert.deepEqual(projected.nodes.map(({ key }) => key), [
    "node:paper",
    "node:structure:earlier",
    "node:structure:later",
    "candidate:first",
    "node:semantic:higher",
  ]);
  assert.equal(
    projected.nodes[1].text,
    "Node · Methods · section · document structure · automatic map · active · pages 2–4 · structural source detected heading · confidence system-inferred, provisional · 1 linked source · paper source anchor:structure:methods",
  );
  assert.equal(
    projected.nodes[2].text,
    "Node · Pages 5–10 · section · document structure · automatic map · active · pages 5–10 · structural source deterministic page fallback · confidence coverage fallback, no heading claim · 1 linked source · paper source anchor:structure:fallback",
  );
  assert.equal(projected.nodes[1].primarySourceId, "anchor:structure:methods");
  assert.match(projected.nodes.at(-1).text, /Source incomplete$/u);
  assert.doesNotMatch(projected.nodes.at(-1).text, /structural provenance/u);
  assert.equal(projected.edges[0].text, "Edge · node:semantic:higher → First candidate · relates to · unknown authority · unknown origin · unknown status · Source incomplete");
  assert.equal(projected.nodes[3].candidateState, "automatically ranked, unreviewed");
  assert.match(projected.nodes[3].text, /automatically ranked, unreviewed/u);
  assert.equal(projected.nodes[1].structuralRangeText, "pages 2–4");
  assert.equal(projected.nodes[1].structuralBasis, "heading_heuristic");
  assert.equal(projected.nodes[1].structuralBasisText, "detected heading");
  assert.equal(projected.nodes[1].structuralConfidence, "system_inferred");
  assert.equal(projected.nodes[1].structuralConfidenceText, "system-inferred, provisional");
});

test("distinguishes declared sources, intentional mentor background, and missing paper evidence", () => {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  graph.addNode("node:background", {
    label: "A prerequisite the paper does not explain",
    kind: "prerequisite",
    authority: "mentor_background",
    origin: "agent",
    status: "active",
    sourceAnchorIds: [],
  });
  graph.addNode("node:missing", {
    label: "A paper claim with missing evidence",
    authority: "paper_grounded",
    sourceAnchorIds: [],
    entityRevision: 0,
  });
  graph.addNode("node:declared", {
    label: "A referenced source is not a validation result",
    authority: "paper_grounded",
    sourceAnchorIds: ["anchor:declared:2", "anchor:declared:1", "anchor:declared:2"],
  });
  graph.addDirectedEdgeWithKey("edge:background", "node:background", "node:declared", {
    kind: "depends_on", authority: "mentor_background", sourceAnchorIds: [],
  });
  graph.addDirectedEdgeWithKey("edge:missing", "node:missing", "node:declared", {
    kind: "supports", authority: "paper_grounded", sourceAnchorIds: [],
  });
  graph.addDirectedEdgeWithKey("edge:declared", "node:declared", "node:missing", {
    kind: "contrasts_with", authority: "paper_grounded",
    sourceAnchorIds: ["anchor:declared:2", "anchor:declared:1", "anchor:declared:2"],
  });

  const projected = projectAccessibleGraphOutline(graph);
  const nodes = new Map(projected.nodes.map((fact) => [fact.key, fact]));
  const edges = new Map(projected.edges.map((fact) => [fact.key, fact]));
  for (const fact of [nodes.get("node:background"), edges.get("edge:background")]) {
    assert.equal(fact.sourceState, "mentor_background");
    assert.equal(fact.sourceCount, 0);
    assert.equal(fact.primarySourceId, null);
    assert.equal(fact.sourceStatusText, "Mentor background — no paper source expected");
    assert.match(fact.text, /Mentor background — no paper source expected/u);
    assert.doesNotMatch(fact.text, /Source incomplete|source unavailable/u);
  }
  for (const fact of [nodes.get("node:missing"), edges.get("edge:missing")]) {
    assert.equal(fact.sourceState, "missing");
    assert.equal(fact.sourceCount, 0);
    assert.equal(fact.primarySourceId, null);
    assert.equal(fact.sourceStatusText, "Source incomplete");
    assert.match(fact.text, /Source incomplete/u);
  }
  for (const fact of [nodes.get("node:declared"), edges.get("edge:declared")]) {
    assert.equal(fact.sourceState, "declared");
    assert.equal(fact.sourceCount, 2);
    assert.equal(fact.primarySourceId, "anchor:declared:2");
    assert.deepEqual(fact.sourceIds, ["anchor:declared:2", "anchor:declared:1"]);
    assert.equal(fact.sourceStatusText, "2 linked sources");
    assert.doesNotMatch(fact.text, /verified|validated|available/u);
  }
  assert.equal(nodes.get("node:missing").entityRevision, null);
});

test("retains canonical primary sources and copies all structural source ranges without mutation", () => {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  const coverage = [{ startPageIndex: 3, endPageIndex: 8, primaryAnchorId: "anchor:page:4" }];
  const directSources = ["anchor:text:4", "anchor:text:4"];
  graph.addNode("node:structure:legacy", {
    label: "Methods", kind: "section", authority: "document_structure",
    structuralBasis: "pdf_outline", structuralConfidence: "document_declared",
    sourceAnchorIds: directSources,
    structuralCoverage: coverage,
  });
  graph.addNode("node:structure:primary", {
    label: "Paper", kind: "paper", authority: "document_structure",
    sourceAnchorIds: [], structuralCoverage: coverage,
  });
  graph.addNode("node:structure:separated", {
    label: "Separated ranges", kind: "section", authority: "document_structure",
    structuralCoverage: [
      { startPageIndex: 9, endPageIndex: 10, primaryAnchorId: "anchor:page:10" },
      { startPageIndex: 2, endPageIndex: 2, primaryAnchorId: "anchor:page:3" },
    ],
  });
  const before = structuredClone(graph.export());
  const projected = projectAccessibleGraphOutline(graph);
  const facts = new Map(projected.nodes.map((fact) => [fact.key, fact]));
  const legacy = facts.get("node:structure:legacy");
  const primary = facts.get("node:structure:primary");
  assert.equal(legacy.primarySourceId, "anchor:text:4");
  assert.deepEqual(legacy.sourceIds, ["anchor:text:4", "anchor:page:4"]);
  assert.equal(legacy.sourceCount, 2);
  assert.equal(primary.primarySourceId, "anchor:page:4");
  assert.equal(primary.sourceCount, 1);
  assert.deepEqual(primary.structuralCoverage, coverage);
  assert.equal(primary.structuralRangeText, "pages 4–9");
  assert.equal(legacy.structuralBasisText, "PDF outline");
  assert.equal(legacy.structuralConfidenceText, "document-provided");
  assert.equal(facts.get("node:structure:separated").structuralRangeText, "page 3, pages 10–11");
  assert.equal(facts.get("node:structure:separated").primarySourceId, "anchor:page:10");
  assert.deepEqual(facts.get("node:structure:separated").sourceIds, ["anchor:page:10", "anchor:page:3"]);
  assert.notEqual(primary.structuralCoverage, coverage);
  assert.notEqual(primary.structuralCoverage[0], coverage[0]);
  assert.equal(Object.isFrozen(primary.structuralCoverage[0]), true);
  assert.equal(Object.isFrozen(coverage[0]), false);
  assert.equal(Object.isFrozen(directSources), false);
  assert.throws(() => { /** @type {any} */ (primary.structuralCoverage[0]).startPageIndex = 99; }, TypeError);
  assert.throws(() => { /** @type {any} */ (legacy.sourceIds).push("anchor:injected"); }, TypeError);
  assert.deepEqual(graph.export(), before);
});

test("names full directed parallel relationships and retains clearly labeled tombstones for audit", () => {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  const sourceLabel = "The complete encoder-side representation, including every qualifier";
  const targetLabel = "The complete decoder-side representation, not just its opaque identifier";
  graph.addNode("node:opaque:01", { label: sourceLabel, status: "active", summary: "Encoder summary.", entityRevision: 3 });
  graph.addNode("node:opaque:02", { label: targetLabel, status: "tombstoned", summary: "Retained decoder summary.", entityRevision: 8 });
  const relationAttributes = {
    authority: "paper_grounded", origin: "agent", status: "tombstoned", entityRevision: 9,
    sourceAnchorIds: ["anchor:proof:1", "anchor:proof:2"],
  };
  graph.addDirectedEdgeWithKey("edge:z-reverse", "node:opaque:02", "node:opaque:01", {
    ...relationAttributes, kind: "depends_on", claim: "The decoder depends on the encoder.",
  });
  graph.addDirectedEdgeWithKey("edge:b-parallel", "node:opaque:01", "node:opaque:02", {
    ...relationAttributes, kind: "enables", claim: "The encoder enables decoder cross-attention.",
    summary: "An independently stored edge summary remains distinct from its claim.",
  });
  graph.addDirectedEdgeWithKey("edge:a-parallel", "node:opaque:01", "node:opaque:02", {
    ...relationAttributes, kind: "produces", claim: "The encoder produces representations for the decoder.",
  });
  const projected = projectAccessibleGraphOutline(graph);
  const nodes = new Map(projected.nodes.map((fact) => [fact.key, fact]));
  assert.deepEqual(projected.edges.map(({ key }) => key), ["edge:a-parallel", "edge:b-parallel", "edge:z-reverse"]);
  assert.deepEqual(nodes.get("node:opaque:01").outgoingEdgeKeys, ["edge:a-parallel", "edge:b-parallel"]);
  assert.deepEqual(nodes.get("node:opaque:01").incomingEdgeKeys, ["edge:z-reverse"]);
  assert.deepEqual(nodes.get("node:opaque:02").outgoingEdgeKeys, ["edge:z-reverse"]);
  assert.deepEqual(nodes.get("node:opaque:02").incomingEdgeKeys, ["edge:a-parallel", "edge:b-parallel"]);
  for (const edge of projected.edges) {
    assert.equal(edge.sourceLabel, edge.sourceKey === "node:opaque:01" ? sourceLabel : targetLabel);
    assert.equal(edge.targetLabel, edge.targetKey === "node:opaque:02" ? targetLabel : sourceLabel);
    assert.ok(edge.text.includes(`${edge.sourceLabel} → ${edge.targetLabel}`));
    assert.ok(edge.text.includes(edge.claim));
    assert.ok(edge.text.includes(edge.summary));
    assert.equal(edge.entityRevision, 9);
    assert.equal(edge.authority, "paper_grounded");
    assert.equal(edge.origin, "agent");
    assert.equal(edge.sourceCount, 2);
    assert.match(edge.statusText, /tombstoned.*retained for audit/u);
    assert.match(edge.text, /tombstoned.*retained for audit/u);
    assert.doesNotMatch(edge.text, /node:opaque/u);
  }
  assert.match(nodes.get("node:opaque:02").text, /Retained decoder summary.*tombstoned.*retained for audit.*revision 8/u);
  assert.equal(Object.isFrozen(nodes.get("node:opaque:01").outgoingEdgeKeys), true);
});

test("projects all 600 nodes and 1200 edges equivalently under permuted insertion and presentation fields", () => {
  const nodeRecords = Array.from({ length: 600 }, (_, index) => {
    const key = `node:${String(index).padStart(3, "0")}`;
    const authority = index <= 20 ? "document_structure" : index % 11 === 0 ? "mentor_background" : "paper_grounded";
    return { key, attributes: {
      label: `Concept ${index}: a complete readable label`,
      summary: `Canonical summary ${index}. ${"Evidence remains separate from interpretation. ".repeat(12)}`,
      kind: index === 0 ? "paper" : index <= 20 ? "section" : "concept",
      authority,
      origin: index <= 20 ? "system" : index % 2 ? "automatic_map" : "agent",
      status: index % 37 === 0 ? "tombstoned" : "active",
      entityRevision: index + 1,
      sourceAnchorIds: authority === "mentor_background" || authority === "document_structure" ? [] : [`anchor:${index}:primary`, `anchor:${index}:alternative`],
      structuralCoverage: index <= 20 ? [{ startPageIndex: index, endPageIndex: index, primaryAnchorId: `anchor:page:${index}` }] : [],
      structuralBasis: index === 0 ? "paper_root" : index <= 20 ? "page_fallback" : undefined,
      structuralConfidence: index <= 20 ? "coverage_fallback" : undefined,
      salience: (index % 13) / 13,
      x: index, y: -index, size: 4, color: "red", hidden: false, highlighted: true,
      selected: true, camera: { ratio: 2 },
    } };
  });
  const edgeRecords = Array.from({ length: 1200 }, (_, index) => ({
    key: `edge:${String(index).padStart(4, "0")}`,
    source: nodeRecords[index % 600].key,
    target: nodeRecords[(index % 600 + (index < 600 ? 1 : 2)) % 600].key,
    attributes: {
      kind: index % 2 ? "supports" : "depends_on",
      claim: `Canonical relationship claim ${index}. ${"Do not truncate the actual claim. ".repeat(12)}`,
      authority: index % 17 ? "paper_grounded" : "mentor_background",
      origin: "agent", status: "tombstoned", entityRevision: index + 1,
      sourceAnchorIds: index % 17 ? [`anchor:edge:${index}`] : [],
      x: -index, y: index, hidden: true, selected: true, color: "blue",
    },
  }));
  /** @param {number[]} nodeOrder @param {number[]} edgeOrder @param {boolean} [changeLayout] */
  function makeGraph(nodeOrder, edgeOrder, changeLayout = false) {
    const graph = new MultiDirectedGraph({ allowSelfLoops: false });
    for (const index of nodeOrder) {
      const record = nodeRecords[index];
      graph.addNode(record.key, { ...record.attributes, ...(changeLayout ? { x: -99, y: 44, hidden: true, selected: false } : {}) });
    }
    for (const index of edgeOrder) {
      const record = edgeRecords[index];
      graph.addDirectedEdgeWithKey(record.key, record.source, record.target, { ...record.attributes, ...(changeLayout ? { color: "green", hidden: false } : {}) });
    }
    return graph;
  }
  const nodeOrder = nodeRecords.map((_, index) => index);
  const edgeOrder = edgeRecords.map((_, index) => index);
  const original = makeGraph(nodeOrder, edgeOrder);
  const permuted = makeGraph([...nodeOrder].reverse(), [...edgeOrder].reverse(), true);
  const shuffled = makeGraph(nodeOrder.map((index) => (index * 137) % 600), edgeOrder.map((index) => (index * 337) % 1200));
  const candidates = new Map([["node:100", { rank: 1 }], ["node:050", { rank: 2 }]]);
  const before = structuredClone(original.export());
  const candidateBefore = structuredClone([...candidates]);
  const projected = projectAccessibleGraphOutline(original, candidates);
  assert.deepEqual(projectAccessibleGraphOutline(permuted, new Map([...candidates].reverse())), projected);
  assert.deepEqual(projectAccessibleGraphOutline(shuffled, candidates), projected);
  assert.equal(projected.nodes.length, original.order);
  assert.equal(projected.edges.length, original.size);
  assert.equal(projected.nodes.length, 600);
  assert.equal(projected.edges.length, 1200);
  assert.equal(projected.nodes.reduce((sum, fact) => sum + fact.incomingEdgeKeys.length, 0), 1200);
  assert.equal(projected.nodes.reduce((sum, fact) => sum + fact.outgoingEdgeKeys.length, 0), 1200);
  const nodes = new Map(projected.nodes.map((fact) => [fact.key, fact]));
  for (const fact of projected.nodes) {
    const attributes = original.getNodeAttributes(fact.key);
    assert.equal(fact.label, attributes.label);
    assert.equal(fact.summary, attributes.summary);
    assert.equal(fact.kind, attributes.kind);
    assert.equal(fact.authority, attributes.authority);
    assert.equal(fact.origin, attributes.origin);
    assert.equal(fact.status, attributes.status);
    assert.equal(fact.entityRevision, attributes.entityRevision);
    assert.equal(fact.sourceCount, fact.sourceIds.length);
    assert.ok(fact.text.includes(attributes.summary));
    for (const key of fact.incomingEdgeKeys) assert.equal(original.target(key), fact.key);
    for (const key of fact.outgoingEdgeKeys) assert.equal(original.source(key), fact.key);
    if (fact.origin === "automatic_map") assert.match(fact.text, /unreviewed/u);
  }
  for (const fact of projected.edges) {
    const attributes = original.getEdgeAttributes(fact.key);
    assert.equal(fact.sourceKey, original.source(fact.key));
    assert.equal(fact.targetKey, original.target(fact.key));
    assert.equal(fact.sourceLabel, nodes.get(fact.sourceKey).label);
    assert.equal(fact.targetLabel, nodes.get(fact.targetKey).label);
    assert.equal(fact.relation, attributes.kind);
    assert.equal(fact.claim, attributes.claim);
    assert.equal(fact.summary, attributes.claim);
    assert.equal(fact.authority, attributes.authority);
    assert.equal(fact.origin, attributes.origin);
    assert.equal(fact.status, attributes.status);
    assert.equal(fact.entityRevision, attributes.entityRevision);
    assert.deepEqual(fact.sourceIds, attributes.sourceAnchorIds);
    assert.ok(fact.text.includes(attributes.claim));
  }
  for (const fact of [...projected.nodes, ...projected.edges]) {
    for (const field of ["x", "y", "size", "color", "hidden", "highlighted", "selected", "camera", "salience"]) {
      assert.equal(field in fact, false, `${fact.key} must not expose ${field}`);
    }
    assert.doesNotMatch(fact.text, /salience/u);
    assert.equal(Object.isFrozen(fact), true);
    assert.equal(Object.isFrozen(fact.sourceIds), true);
  }
  assert.deepEqual(original.export(), before);
  assert.deepEqual([...candidates], candidateBefore);
});

test("projects the exact accessible annotation summary, source, and chip facts", () => {
  const automatic = projectAccessibleAnnotationSummary({
    annotationId: "annotation:auto:multi-head",
    annotation: {
      anchorId: "anchor:auto:multi-head",
      label: "Automatic candidate 3 — Multi-Head Attention",
      kind: "main_idea",
      authority: "system",
      status: "active",
    },
    anchor: {
      anchorId: "anchor:auto:multi-head",
      pageLabel: "4",
      exactText: "Multi-head attention allows the model to jointly attend.",
    },
    linkedNodeKey: "candidate:multi-head",
    criticalIdeaRank: 3,
  });

  assert.deepEqual(automatic, {
    annotationId: "annotation:auto:multi-head",
    anchorId: "anchor:auto:multi-head",
    linkedNodeKey: "candidate:multi-head",
    body: "Automatic candidate 3 — Multi-Head Attention",
    kind: "main_idea",
    authority: "system",
    status: "active",
    provenance: "automatically ranked, unreviewed paper candidate",
    summaryText: "Automatic candidate 3 — Multi-Head Attention · main idea · automatically ranked, unreviewed paper candidate · active",
    sourceSummary: "Page 4 · anchor:auto:multi-head · “Multi-head attention allows the model to jointly attend.”",
    chipText: "Idea 3",
    chipLabel: "Automatic candidate 3 — Multi-Head Attention · automatically ranked, unreviewed paper candidate",
    isFixture: false,
    isAutomatic: true,
  });
  assert.equal(Object.isFrozen(automatic), true);

  const reader = projectAccessibleAnnotationSummary({
    annotationId: "annotation:reader:1",
    annotation: {
      sourceAnchorIds: ["anchor:reader:1"],
      body: "Why divide by the square root?",
      kind: "question",
      authority: "reader",
      status: "active",
    },
  });
  assert.equal(reader.anchorId, "anchor:reader:1");
  assert.equal(reader.provenance, "created by the reader and linked to the graph");
  assert.equal(reader.summaryText, "Why divide by the square root? · question · created by the reader and linked to the graph · active");
  assert.equal(reader.sourceSummary, null);
  assert.equal(reader.chipText, "Why divide by the square root?");

  const region = projectAccessibleAnnotationSummary({
    annotationId: "annotation:reader:region",
    annotation: {
      anchorId: "anchor:reader:region",
      label: "Transformer architecture",
      body: "A two-column encoder-decoder diagram joined by arrows.",
      kind: "region",
      authority: "reader",
      status: "active",
    },
    anchor: {
      anchorId: "anchor:reader:region",
      pageLabel: "3",
      sourceKind: "visual_region",
    },
  });
  assert.equal(region.body, "Transformer architecture");
  assert.equal(
    region.sourceSummary,
    "Page 3 · described visual region · A two-column encoder-decoder diagram joined by arrows.",
  );

  const fixture = projectAccessibleAnnotationSummary({
    annotationId: "annotation:fixture:attention",
    annotation: { sourceAnchorId: "anchor:text:attention", kind: "highlight", authority: "agent", status: "active" },
  });
  assert.equal(fixture.body, "Annotation");
  assert.equal(fixture.provenance, "deterministic demo fixture");
  assert.equal(fixture.chipLabel, "Annotation · deterministic demo fixture");
});
