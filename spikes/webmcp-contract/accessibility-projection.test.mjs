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
    structuralCoverage: [{ startPageIndex: 0, endPageIndex: 14, primaryAnchorId: "anchor:page:1" }],
    x: 99,
    y: -99,
  });
  graph.addNode("candidate:mechanism", {
    label: "Multi-Head Attention",
    kind: "main_idea",
    authority: "paper_grounded",
    origin: "agent",
    status: "active",
    salience: 0.91,
    sourceAnchorIds: ["anchor:auto:mechanism"],
    x: -4,
    y: 8,
  });
  graph.addDirectedEdgeWithKey("edge:paper:mechanism", "node:paper", "candidate:mechanism", {
    relation: "evidenced_by",
    status: "active",
    sourceAnchorIds: ["anchor:auto:mechanism"],
    x: 123,
  });

  const candidates = new Map([["candidate:mechanism", { rank: 2 }]]);
  const projected = projectAccessibleGraphOutline(
    /** @type {any} */ (graph),
    candidates,
  );

  assert.deepEqual(projected.nodes.map(({ key }) => key), ["candidate:mechanism", "node:paper"]);
  assert.deepEqual(projected.nodes[0], {
    type: "node",
    key: "candidate:mechanism",
    label: "Multi-Head Attention",
    kind: "main_idea",
    authority: "paper_grounded",
    origin: "agent",
    status: "active",
    sourceIds: ["anchor:auto:mechanism"],
    primarySourceId: "anchor:auto:mechanism",
    candidateRank: 2,
    candidateState: "agent refined",
    text: "Node · Multi-Head Attention · main idea · paper grounded · agent · active · critical candidate rank 2 · agent refined · source anchor:auto:mechanism",
  });
  assert.equal(projected.nodes[1].text, "Node · Paper root · paper · document structure · system · active · source anchor:page:1");
  assert.deepEqual(projected.edges[0], {
    type: "edge",
    key: "edge:paper:mechanism",
    sourceKey: "node:paper",
    targetKey: "candidate:mechanism",
    relation: "evidenced_by",
    status: "active",
    sourceIds: ["anchor:auto:mechanism"],
    text: "Edge · node:paper → candidate:mechanism · evidenced by · active · source anchor:auto:mechanism",
  });
  assert.equal("x" in projected.nodes[0], false);
  assert.equal("y" in projected.nodes[0], false);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.nodes[0].sourceIds), true);
});
test("uses the current graph-outline defaults and deterministic rank/salience ordering", () => {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  graph.addNode("node:lower", { salience: 0.2 });
  graph.addNode("node:higher", { salience: 0.8, sourceAnchorIds: [] });
  graph.addNode("candidate:first", {
    label: "First candidate",
    origin: "automatic_map",
    structuralCoverage: [{ primaryAnchorId: "anchor:section:1" }],
  });
  graph.addDirectedEdgeWithKey("edge:default", "node:lower", "node:higher", {});

  const projected = projectAccessibleGraphOutline(
    /** @type {any} */ (graph),
    new Map([["candidate:first", { rank: 1 }]]),
  );

  assert.deepEqual(projected.nodes.map(({ key }) => key), ["candidate:first", "node:higher", "node:lower"]);
  assert.equal(
    projected.nodes[0].text,
    "Node · First candidate · concept · unknown authority · automatic map · unknown status · critical candidate rank 1 · automatically ranked, unreviewed · source anchor:section:1",
  );
  assert.equal(projected.nodes[1].text, "Node · node:higher · concept · unknown authority · unknown origin · unknown status · source structural provenance");
  assert.equal(projected.edges[0].text, "Edge · node:lower → node:higher · relates to · unknown status · source structural provenance");
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
