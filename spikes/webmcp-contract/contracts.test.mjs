import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MultiDirectedGraph } from "graphology";

import * as contract from "./contracts.mjs";

const {
  INPUT_SCHEMAS,
  LIMITS,
  PAPER_FIXTURE,
  RESULT_SCHEMAS,
  SOURCE_ANCHOR_TEXT,
  SOURCE_ANCHOR_TEXT_SHA256,
  SPIKE_VERSIONS,
  TOOL_NAMES,
  applyReaderAnnotation,
  createSpikeState,
  createToolSuite,
  mintReaderAnchor,
  mountToolSuite,
  redoLastHumanChange,
  resultSizeBytes,
  schemaObjectsAreClosed,
  undoLastHumanChange,
} = contract;

const FORBIDDEN_MODEL_FIELDS = new Set([
  "paperRef",
  "documentSha256",
  "origin",
  "createdAt",
  "updatedAt",
  "status",
  "entityRevision",
  "pdfQuads",
  "normalizedBounds",
  "coordinates",
  "viewportBounds",
  "rects",
  "quads",
  "pageViewBox",
  "pageRotation",
  "x",
  "y",
  "width",
  "height",
]);

const EXPECTED_TOOL_NAMES = [
  "paperpilot.read_focus",
  "paperpilot.read_graph",
  "paperpilot.stage_explain",
  "paperpilot.apply_graph",
  "paperpilot.apply_annotation",
  "paperpilot.focus_source",
];

const EXPLANATION_SECTIONS = {
  quickTake: "Attention lets the model compare relevant tokens directly.",
  paperFit: "This is the paper's central replacement for recurrence.",
  prerequisites: "A reader needs vectors, weighted sums, and probability basics.",
  howItWorks: "Queries score keys, and normalized scores combine the value vectors.",
  paperEvidence: "The active abstract anchor states that the architecture relies on attention.",
  relatedIdeas: "The graph connects the paper, its introduction, and the attention concept.",
  limitations: "This fixture establishes provenance behavior, not scientific completeness.",
};

function deterministicStateOptions(overrides = {}) {
  let sequence = 0;
  return {
    now: () => "2026-08-30T12:00:00.000Z",
    id: (prefix) => `${prefix}:${String(++sequence).padStart(8, "0")}`,
    ...overrides,
  };
}

async function createFixture(overrides = {}) {
  return createSpikeState(MultiDirectedGraph, deterministicStateOptions(overrides));
}

function automaticMapFixture({ candidates, coverage } = {}) {
  const baseCandidates = candidates || [
    {
      key: "candidate:idea:p2:alpha001",
      rank: 1,
      kind: "main_idea",
      label: "Direct comparison is the central candidate",
      summary: "The paper proposes direct comparison as the primary mechanism for relating positions.",
      salience: 0.94,
      authority: "system_derived_candidate",
      reviewState: "unreviewed",
      source: {
        pageIndex: 1,
        pageLabel: "2",
        exactText: "The paper proposes direct comparison as the primary mechanism for relating positions.",
        normalizedBounds: [{ x: 0.18, y: 0.24, width: 0.64, height: 0.05 }],
        pageViewBox: [0, 0, 612, 792],
        pageRotation: 0,
      },
    },
    {
      key: "candidate:idea:p7:beta002",
      rank: 2,
      kind: "result",
      label: "Evaluation reports a quality gain",
      summary: "The evaluation reports improved quality together with reduced training cost.",
      salience: 0.72,
      authority: "system_derived_candidate",
      reviewState: "unreviewed",
      source: {
        pageIndex: 6,
        pageLabel: "7",
        exactText: "The evaluation reports improved quality together with reduced training cost.",
        normalizedBounds: [{ x: 0.2, y: 0.62, width: 0.58, height: 0.045 }],
        pageViewBox: [0, 0, 612, 792],
        pageRotation: 0,
      },
    },
  ];
  return {
    schemaVersion: 1,
    status: baseCandidates.length >= 5 ? "candidate_ready" : "candidate_limited",
    claimBoundary: "Ranked from extracted PDF text by generic heuristics. These are reviewable candidates, not verified scientific claims.",
    pageCount: 15,
    coverage: coverage || Array.from({ length: 15 }, (_, pageIndex) => ({
      pageIndex,
      pageLabel: String(pageIndex + 1),
      textCapability: "exact_candidate",
    })),
    candidates: baseCandidates,
  };
}

function toolsFor(state) {
  return new Map(createToolSuite(state).map((tool) => [tool.name, tool]));
}

function graphCommand(state, overrides = {}) {
  return {
    idempotencyKey: "graph-command-0001",
    baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest,
    baseGraphDigest: state.graphDigest,
    reason: "Add one paper-grounded concept without changing the PDF.",
    operations: [
      {
        op: "add_node",
        clientRef: "client:concept:one",
        node: {
          kind: "concept",
          label: "Weighted token comparison",
          summary: "Attention compares token representations using learned query and key vectors.",
          authority: "paper_grounded",
          sourceAnchorIds: ["anchor:text:attention"],
          salience: 0.75,
        },
      },
    ],
    ...overrides,
  };
}

function annotationCommand(state, overrides = {}) {
  return {
    idempotencyKey: "annotation-command-0001",
    baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest,
    baseAnnotationDigest: state.annotationDigest,
    reason: "Connect the source passage to an in-app explanation marker.",
    operations: [
      {
        op: "create_annotation",
        anchorId: "anchor:text:attention",
        expectedAnchorDigest: state.anchors.get("anchor:text:attention").anchorDigest,
        annotationKind: "concept",
        label: "Ask the mentor how attention replaces recurrence.",
        graphNodeKeys: ["node:concept:attention"],
        graphEdgeKeys: [],
      },
    ],
    ...overrides,
  };
}

async function readerAnchor(state, overrides = {}) {
  return mintReaderAnchor(state, {
    pageIndex: 0,
    sourceKind: "exact_text",
    normalizedBounds: [{ x: 0.21, y: 0.54, width: 0.55, height: 0.028 }],
    pageViewBox: [0, 0, 612, 792],
    pageRotation: 0,
    exactText: "Attention mechanisms replace recurrence in this architecture.",
    prefix: "The reader selected this sentence after reading the abstract.",
    suffix: "The next sentence discusses translation experiments.",
    ...overrides,
  });
}

function readerAnnotationCommand(state, anchor, overrides = {}) {
  return {
    baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest,
    anchor,
    annotation: {
      kind: "question",
      body: "How can attention replace a recurrent state?",
    },
    node: {
      kind: "concept",
      label: "Reader question about residual connections",
      summary: "The reader wants to understand normalization before attention and how information persists without recurrence.",
      salience: 0.82,
    },
    ...overrides,
  };
}

function collectSchemaPropertyNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaPropertyNames(item, names);
    return names;
  }
  if (!value || typeof value !== "object") return names;
  if (value.properties && typeof value.properties === "object") {
    for (const propertyName of Object.keys(value.properties)) names.add(propertyName);
  }
  for (const child of Object.values(value)) collectSchemaPropertyNames(child, names);
  return names;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function snapshotForAtomicTest(state) {
  return {
    workspaceRevision: state.workspaceRevision,
    workspaceDigest: state.workspaceDigest,
    graphDigest: state.graphDigest,
    annotationDigest: state.annotationDigest,
    anchors: [...state.anchors].map(([key, value]) => [key, structuredClone(value)]),
    annotations: [...state.annotations].map(([key, value]) => [key, structuredClone(value)]),
    nodes: state.graph.nodes().sort().map((key) => [key, structuredClone(state.graph.getNodeAttributes(key))]),
    edges: state.graph.edges().sort().map((key) => [key, state.graph.source(key), state.graph.target(key), structuredClone(state.graph.getEdgeAttributes(key))]),
    historyLength: state.history.length,
  };
}

test("freezes the exact six-tool registration surface and closed local schemas", () => {
  assert.deepEqual(TOOL_NAMES, EXPECTED_TOOL_NAMES);
  assert.deepEqual(createToolSuite, contract.createToolSuite);
  assert.deepEqual(sorted(Object.keys(INPUT_SCHEMAS)), sorted(EXPECTED_TOOL_NAMES));
  assert.ok(RESULT_SCHEMAS, "contracts.mjs must export local result/error schemas");
  assert.deepEqual(sorted(Object.keys(RESULT_SCHEMAS)), sorted(EXPECTED_TOOL_NAMES));

  for (const [name, schema] of Object.entries(INPUT_SCHEMAS)) {
    assert.equal(schemaObjectsAreClosed(schema), true, `${name} input schema must be recursively closed`);
  }
  for (const [name, schema] of Object.entries(RESULT_SCHEMAS)) {
    assert.equal(schemaObjectsAreClosed(schema), true, `${name} result schema must be recursively closed`);
  }

  const definitions = createToolSuite({});
  assert.deepEqual(definitions.map((tool) => tool.name), EXPECTED_TOOL_NAMES);
  for (const tool of definitions) {
    assert.strictEqual(tool.inputSchema, INPUT_SCHEMAS[tool.name]);
    assert.equal("outputSchema" in tool, false, "the current WebMCP draft only registers inputSchema");
  }
});

test("keeps page-owned authority, raw geometry, hard-delete, and human controls out of model input", async () => {
  const propertyNames = collectSchemaPropertyNames(INPUT_SCHEMAS);
  for (const field of FORBIDDEN_MODEL_FIELDS) {
    assert.equal(propertyNames.has(field), false, `${field} must remain page-owned`);
  }

  const serializedSchemas = JSON.stringify(INPUT_SCHEMAS);
  for (const forbiddenOperation of ["hard_delete", "delete_node", "delete_edge", "export_pdf", "undo", "redo", "save", "verify"]) {
    assert.equal(serializedSchemas.includes(`\"${forbiddenOperation}\"`), false);
  }

  const state = await createFixture();
  const tools = toolsFor(state);
  const trustedFieldResult = await tools.get("paperpilot.read_graph").execute({
    mode: "overview",
    paperRef: "paper:foreign",
  });
  assert.equal(trustedFieldResult.status, "rejected");
  assert.equal(trustedFieldResult.code, "trusted_field_rejected");

  const graphInput = graphCommand(state);
  graphInput.operations[0].node.normalizedBounds = [{ x: 0, y: 0, width: 1, height: 1 }];
  const rawGeometryResult = await tools.get("paperpilot.apply_graph").execute(graphInput);
  assert.equal(rawGeometryResult.status, "rejected");
  assert.equal(rawGeometryResult.code, "trusted_field_rejected");
});

test("pins the disposable spike dependency surface and excludes annotpdf", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));

  assert.equal(packageJson.dependencies["pdfjs-dist"], "6.3.289");
  assert.equal(packageJson.dependencies.graphology, "0.26.0");
  assert.equal(packageJson.dependencies.sigma, "3.0.3");
  assert.equal(SPIKE_VERSIONS.pdfjs, "6.3.289");
  assert.equal(SPIKE_VERSIONS.graphology, "0.26.0");
  assert.equal(SPIKE_VERSIONS.sigma, "3.0.3");

  assert.equal(packageLock.packages["node_modules/pdfjs-dist"].version, "6.3.289");
  assert.equal(packageLock.packages["node_modules/graphology"].version, "0.26.0");
  assert.equal(packageLock.packages["node_modules/sigma"].version, "3.0.3");
  assert.equal(packageJson.dependencies.annotpdf, undefined);
  assert.equal(packageJson.devDependencies.annotpdf, undefined);
  assert.deepEqual(
    Object.keys(packageLock.packages).filter((key) => /(?:^|node_modules[/\\])annotpdf$/i.test(key)),
    [],
  );

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  assert.equal(pdfjs.version, "6.3.289");
});

test("binds the contract to the verified arXiv v7 paper and a contiguous exact-text source", async () => {
  const state = await createFixture();
  const source = state.anchors.get("anchor:text:attention");
  const sourceBytes = new TextEncoder().encode(SOURCE_ANCHOR_TEXT);
  const sourceDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", sourceBytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const manifest = JSON.parse(await readFile(
    new URL("./assets/papers/attention-is-all-you-need-1706.03762v7.source.json", import.meta.url),
    "utf8",
  ));

  assert.deepEqual(state.paper, {
    paperRef: PAPER_FIXTURE.paperRef,
    filename: PAPER_FIXTURE.filename,
    documentSha256: PAPER_FIXTURE.documentSha256,
    pageCount: 15,
  });
  assert.equal(manifest.localFixture.pdfByteSha256, PAPER_FIXTURE.documentSha256);
  assert.equal(manifest.localFixture.pdfByteLength, PAPER_FIXTURE.byteLength);
  assert.equal(source.exactText, SOURCE_ANCHOR_TEXT);
  assert.equal(sourceDigest, SOURCE_ANCHOR_TEXT_SHA256);
  assert.match(source.anchorDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(source.anchorDigest, "2".repeat(64));
  assert.equal(source.pageIndex, 0);
  assert.equal(source.pageViewBox.join(","), "0,0,612,792");

  const changedGeometry = await createFixture({
    textAnchor: { normalizedBounds: [{ x: 0.2, y: 0.5, width: 0.4, height: 0.02 }] },
  });
  assert.notEqual(changedGeometry.anchors.get(source.anchorId).anchorDigest, source.anchorDigest);
});

test("uses a directed multigraph with no self-loops and supports parallel evidence edges", async () => {
  const state = await createFixture();
  assert.equal(state.graph.type, "directed");
  assert.equal(state.graph.multi, true);
  assert.equal(state.graph.allowSelfLoops, false);
  assert.equal(state.graph.order, 3);
  assert.equal(state.graph.size, 2);

  state.graph.addDirectedEdge("node:paper", "node:concept:attention", { kind: "supports" });
  state.graph.addDirectedEdge("node:paper", "node:concept:attention", { kind: "evidenced_by" });
  assert.equal([...state.graph.directedEdgeEntries("node:paper", "node:concept:attention")].length, 2);
  assert.throws(() => state.graph.addDirectedEdge("node:paper", "node:paper"));
});

test("hydrates a deterministic grounded critical-idea map as the revision-one baseline", async () => {
  const automaticMap = automaticMapFixture();
  const first = await createFixture({ automaticMap });
  const second = await createFixture({
    automaticMap: { ...automaticMap, candidates: [...automaticMap.candidates].reverse() },
  });

  assert.equal(first.workspaceRevision, 1);
  assert.equal(first.history.length, 0);
  assert.equal(first.events.length, 0);
  assert.equal(first.graph.order, 3);
  assert.equal(first.graph.size, 2);
  assert.equal(first.annotations.size, 2);
  assert.equal(first.graphDigest, second.graphDigest);
  assert.equal(first.workspaceDigest, second.workspaceDigest);

  const candidate = first.graph.getNodeAttributes("candidate:idea:p2:alpha001");
  assert.equal(candidate.origin, "automatic_map");
  assert.equal(candidate.authority, "paper_grounded");
  assert.equal(candidate.salience, 0.94);
  assert.deepEqual(candidate.sourceAnchorIds, ["anchor:auto:idea:p2:alpha001"]);
  const anchor = first.anchors.get(candidate.sourceAnchorIds[0]);
  assert.equal(anchor.pageIndex, 1);
  assert.equal(anchor.sourceKind, "exact_text");
  assert.equal(anchor.exactText, automaticMap.candidates[0].source.exactText);
  assert.match(anchor.anchorDigest, /^[0-9a-f]{64}$/u);

  const read = await toolsFor(first).get("paperpilot.read_graph").execute({ mode: "overview", limit: 20 });
  assert.equal(read.status, "ready");
  assert.equal(read.coverage.pageCount, 15);
  assert.equal(read.coverage.semanticPages, 2);
  assert.equal(read.coverage.limitedPages, 0);
  assert.match(read.guidance, /automatically ranked, unreviewed/u);
  assert.equal(read.nodes.find(({ key }) => key === "candidate:idea:p2:alpha001").entityRevision, 1);
  assert.equal(read.edges.find(({ key }) => key === "edge:auto:idea:p2:alpha001").entityRevision, 1);
  assert.equal(JSON.stringify(read).includes('"x"'), false);
  assert.equal(JSON.stringify(read).includes("criticalityScore"), false);
});

test("binds an arbitrary browser-local PDF identity to the automatic map and first exact candidate", async () => {
  const automaticMap = automaticMapFixture({
    coverage: Array.from({ length: 8 }, (_, pageIndex) => ({
      pageIndex,
      pageLabel: String(pageIndex + 1),
      textCapability: "exact_candidate",
    })),
  });
  automaticMap.pageCount = 8;
  const digest = "a".repeat(64);
  const state = await createFixture({
    paper: {
      paperRef: `paper:sha256:${digest}`,
      filename: "reader-upload.pdf",
      documentSha256: digest,
      pageCount: 8,
      title: "A Browser-Local Research Paper",
      pageViewBox: [0, 0, 400, 700],
      pageRotation: 0,
    },
    textAnchor: null,
    automaticMap,
  });

  assert.deepEqual(state.paper, {
    paperRef: `paper:sha256:${digest}`,
    filename: "reader-upload.pdf",
    documentSha256: digest,
    pageCount: 8,
  });
  assert.equal(state.graph.getNodeAttribute("node:paper", "label"), "A Browser-Local Research Paper");
  assert.deepEqual(state.anchors.get("anchor:page:1").pageViewBox, [0, 0, 400, 700]);
  assert.equal(state.anchors.has("anchor:text:attention"), false);
  assert.equal(state.anchors.has("anchor:visual:a"), false);
  assert.equal(state.focusAnchorId, "anchor:auto:idea:p2:alpha001");
  const focus = await toolsFor(state).get("paperpilot.read_focus").execute({});
  assert.equal(focus.status, "ready");
  assert.equal(focus.paper.documentSha256, digest);
  assert.equal(focus.focus.exactText, automaticMap.candidates[0].source.exactText);
});

test("agent refinement and Human Undo preserve the automatic map and immutable source", async () => {
  const state = await createFixture({ automaticMap: automaticMapFixture() });
  const baselineDigest = state.workspaceDigest;
  const anchorBefore = structuredClone(state.anchors.get("anchor:auto:idea:p2:alpha001"));
  const result = await toolsFor(state).get("paperpilot.apply_graph").execute({
    idempotencyKey: "automatic-refine-0001",
    baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest,
    baseGraphDigest: state.graphDigest,
    reason: "Refine one automatically ranked candidate after reading its issued source.",
    operations: [{
      op: "update_node",
      nodeKey: "candidate:idea:p2:alpha001",
      expectedEntityRevision: 1,
      set: { label: "Direct comparison connects distant positions" },
    }],
  });
  assert.equal(result.status, "applied_reversible");
  assert.equal(state.graph.getNodeAttribute("candidate:idea:p2:alpha001", "origin"), "agent");
  assert.deepEqual(state.anchors.get(anchorBefore.anchorId), anchorBefore);

  const undone = await undoLastHumanChange(state);
  assert.equal(undone.status, "undone");
  assert.equal(state.workspaceDigest, baselineDigest);
  assert.equal(state.graph.getNodeAttribute("candidate:idea:p2:alpha001", "origin"), "automatic_map");
  assert.equal(state.graph.hasNode("candidate:idea:p7:beta002"), true);
  assert.deepEqual(state.anchors.get(anchorBefore.anchorId), anchorBefore);
});

test("rejects malformed automatic-map geometry atomically", async () => {
  const automaticMap = automaticMapFixture();
  const badCandidate = {
    ...automaticMap.candidates[0],
    source: {
      ...automaticMap.candidates[0].source,
      normalizedBounds: [{ x: 0.9, y: 0.2, width: 0.2, height: 0.1 }],
    },
  };
  await assert.rejects(
    createFixture({ automaticMap: { ...automaticMap, candidates: [badCandidate] } }),
    (error) => error.code === "automatic_map_invalid",
  );
});

test("rehydrates one explicit demo annotation without manufacturing mutation history", async () => {
  const firstLoad = await createFixture();
  const ordinaryReload = await createFixture();
  const fixtureId = "annotation:fixture:attention";
  const fixture = firstLoad.annotations.get(fixtureId);

  assert.equal(firstLoad.annotations.size, 1);
  assert.ok(fixture, "the diagnostic fixture annotation must be present on every fresh load");
  assert.deepEqual(fixture, {
    annotationId: fixtureId,
    paperRef: firstLoad.paper.paperRef,
    anchorId: "anchor:text:attention",
    kind: "highlight",
    label: "Demo fixture — attention-only architecture",
    graphNodeKeys: ["node:concept:attention"],
    graphEdgeKeys: ["edge:introduction:attention"],
    status: "active",
    authority: "system",
    entityRevision: 1,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  });
  assert.equal(firstLoad.anchors.get(fixture.anchorId).paperRef, firstLoad.paper.paperRef);
  assert.equal(firstLoad.graph.hasNode(fixture.graphNodeKeys[0]), true);
  assert.equal(firstLoad.graph.hasEdge(fixture.graphEdgeKeys[0]), true);
  assert.deepEqual([...ordinaryReload.annotations], [...firstLoad.annotations]);
  assert.equal(ordinaryReload.annotationDigest, firstLoad.annotationDigest);
  assert.equal(ordinaryReload.workspaceDigest, firstLoad.workspaceDigest);
  assert.equal(ordinaryReload.workspaceRevision, 1);
  assert.deepEqual(ordinaryReload.events, []);
  assert.deepEqual(ordinaryReload.history, []);
  assert.equal(ordinaryReload.requestResults.size, 0);
});

test("atomically turns a page-owned reader selection into a grounded annotation and reader graph node", async () => {
  const state = await createFixture();
  const baseline = {
    revision: state.workspaceRevision,
    workspaceDigest: state.workspaceDigest,
    graphDigest: state.graphDigest,
    annotationDigest: state.annotationDigest,
    anchors: state.anchors.size,
    annotations: state.annotations.size,
    nodes: state.graph.order,
    edges: state.graph.size,
  };
  const anchor = await readerAnchor(state);
  assert.equal(state.anchors.has(anchor.anchorId), false, "minting an anchor must not register it before the human commits");
  assert.equal(anchor.paperRef, state.paper.paperRef);
  assert.equal(anchor.authority, "exact_document_text");
  assert.match(anchor.anchorDigest, /^[0-9a-f]{64}$/);

  const applied = await applyReaderAnnotation(state, readerAnnotationCommand(state, anchor));
  assert.equal(applied.status, "applied_reversible");
  assert.equal(applied.actor, "reader");
  assert.equal(applied.fromRevision, baseline.revision);
  assert.equal(applied.toRevision, baseline.revision + 1);
  assert.equal(applied.anchorId, anchor.anchorId);
  assert.equal(applied.undoAvailable, true);
  assert.notEqual(applied.afterWorkspaceDigest, baseline.workspaceDigest);
  assert.notEqual(applied.afterGraphDigest, baseline.graphDigest);
  assert.notEqual(applied.afterAnnotationDigest, baseline.annotationDigest);
  assert.equal(state.anchors.size, baseline.anchors + 1);
  assert.equal(state.annotations.size, baseline.annotations + 1);
  assert.equal(state.graph.order, baseline.nodes + 1);
  assert.equal(state.graph.size, baseline.edges + 1);

  const annotation = state.annotations.get(applied.annotationId);
  const node = state.graph.getNodeAttributes(applied.nodeKey);
  const edge = state.graph.getEdgeAttributes(applied.edgeKey);
  assert.deepEqual(annotation, {
    annotationId: applied.annotationId,
    paperRef: state.paper.paperRef,
    anchorId: anchor.anchorId,
    kind: "question",
    label: "How can attention replace a recurrent state?",
    graphNodeKeys: [applied.nodeKey],
    graphEdgeKeys: [applied.edgeKey],
    status: "active",
    authority: "reader",
    entityRevision: 1,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  });
  assert.equal(node.authority, "reader_authored");
  assert.equal(node.origin, "reader");
  assert.deepEqual(node.sourceAnchorIds, [anchor.anchorId]);
  assert.equal(edge.authority, "reader_authored");
  assert.equal(edge.origin, "reader");
  assert.equal(state.graph.source(applied.edgeKey), applied.nodeKey);
  assert.equal(state.graph.target(applied.edgeKey), "node:paper");
  assert.deepEqual(edge.sourceAnchorIds, [anchor.anchorId]);
  assert.equal(state.events.at(-1).actor, "human");
  assert.equal(state.events.at(-1).eventType, "reader_annotation_graph_created");

  const tools = toolsFor(state);
  const bodyRewrite = await tools.get("paperpilot.apply_annotation").execute({
    ...annotationCommand(state, { idempotencyKey: "annotation-reader-rewrite-0001" }),
    operations: [{
      op: "update_annotation",
      annotationId: applied.annotationId,
      expectedEntityRevision: 1,
      set: { label: "An agent must not replace the reader's words." },
    }],
  });
  assert.equal(bodyRewrite.status, "rejected");
  assert.equal(bodyRewrite.code, "reader_annotation_protected");
  assert.equal(state.annotations.get(applied.annotationId).label, annotation.label);

  const undone = await undoLastHumanChange(state);
  assert.equal(undone.status, "undone");
  assert.equal(undone.digestMatches, true);
  assert.equal(state.anchors.has(anchor.anchorId), false);
  assert.equal(state.annotations.has(applied.annotationId), false);
  assert.equal(state.graph.hasNode(applied.nodeKey), false);
  assert.equal(state.workspaceDigest, baseline.workspaceDigest);
});

test("searches graph labels and summaries literally with authority/type filters and deterministic truncation", async () => {
  const state = await createFixture();
  const firstAnchor = await readerAnchor(state);
  const first = await applyReaderAnnotation(state, readerAnnotationCommand(state, firstAnchor));
  const secondAnchor = await readerAnchor(state, {
    exactText: "Residual paths preserve information around each attention sub-layer.",
  });
  const second = await applyReaderAnnotation(state, readerAnnotationCommand(state, secondAnchor, {
    annotation: { kind: "note", body: "This residual path looks important." },
    node: {
      kind: "method",
      label: "Reader observation about residual paths",
      summary: "A reader-authored note about skip connections around attention.",
      salience: 0.7,
    },
  }));
  const tool = toolsFor(state).get("paperpilot.read_graph");

  const labelMatch = await tool.execute({
    mode: "search",
    query: "  RESIDUAL   CONNECTIONS ",
    authorities: ["reader_authored"],
    nodeKinds: ["concept"],
  });
  assert.equal(labelMatch.status, "ready");
  assert.deepEqual(labelMatch.nodes.map(({ key }) => key), [first.nodeKey]);

  const summaryMatch = await tool.execute({
    mode: "search",
    query: "normalization before attention",
    authorities: ["reader_authored"],
  });
  assert.deepEqual(summaryMatch.nodes.map(({ key }) => key), [first.nodeKey]);

  const filteredOut = await tool.execute({
    mode: "search",
    query: "reader",
    authorities: ["paper_grounded"],
  });
  assert.deepEqual(filteredOut.nodes, []);

  const regexCharactersStayLiteral = await tool.execute({ mode: "search", query: ".*[]()?" });
  assert.equal(regexCharactersStayLiteral.status, "ready");
  assert.deepEqual(regexCharactersStayLiteral.nodes, []);

  const truncated = await tool.execute({
    mode: "search",
    query: "reader",
    authorities: ["reader_authored"],
    limit: 1,
  });
  const repeated = await tool.execute({
    mode: "search",
    query: "reader",
    authorities: ["reader_authored"],
    limit: 1,
  });
  assert.equal(truncated.truncated, true);
  assert.deepEqual(truncated.nodes.map(({ key }) => key), repeated.nodes.map(({ key }) => key));
  assert.equal([first.nodeKey, second.nodeKey].includes(truncated.nodes[0].key), true);

  const unsafeControl = await tool.execute({ mode: "search", query: "reader\nnode" });
  assert.equal(unsafeControl.status, "rejected");
  assert.equal(unsafeControl.code, "read_graph_invalid");
});

test("keeps WebMCP graph create, update, tombstone, and explicit reader-node reauthoring reversible", async () => {
  const state = await createFixture();
  const tools = toolsFor(state);
  const created = await tools.get("paperpilot.apply_graph").execute(graphCommand(state));
  const agentNodeKey = created.affected.created[0];
  assert.equal(state.graph.getNodeAttribute(agentNodeKey, "origin"), "agent");

  const updated = await tools.get("paperpilot.apply_graph").execute(graphCommand(state, {
    idempotencyKey: "graph-command-update-0002",
    operations: [{
      op: "update_node",
      nodeKey: agentNodeKey,
      expectedEntityRevision: 1,
      set: { label: "Updated weighted token comparison" },
    }],
  }));
  assert.deepEqual(updated.affected.updated, [agentNodeKey]);
  assert.equal(state.graph.getNodeAttribute(agentNodeKey, "entityRevision"), 2);

  const tombstoned = await tools.get("paperpilot.apply_graph").execute(graphCommand(state, {
    idempotencyKey: "graph-command-tombstone-0003",
    operations: [{ op: "tombstone_node", nodeKey: agentNodeKey, expectedEntityRevision: 2 }],
  }));
  assert.deepEqual(tombstoned.affected.tombstoned, [agentNodeKey]);
  assert.equal(state.graph.getNodeAttribute(agentNodeKey, "status"), "tombstoned");

  const hidden = await tools.get("paperpilot.read_graph").execute({ mode: "search", query: "updated weighted" });
  const issued = await tools.get("paperpilot.read_graph").execute({ mode: "search", query: "updated weighted", includeTombstoned: true });
  assert.deepEqual(hidden.nodes, []);
  assert.deepEqual(issued.nodes.map(({ key, status }) => [key, status]), [[agentNodeKey, "tombstoned"]]);

  const anchor = await readerAnchor(state);
  const reader = await applyReaderAnnotation(state, readerAnnotationCommand(state, anchor));
  const originalBody = state.annotations.get(reader.annotationId).label;
  const reauthored = await tools.get("paperpilot.apply_graph").execute(graphCommand(state, {
    idempotencyKey: "graph-command-reader-0004",
    operations: [{
      op: "update_node",
      nodeKey: reader.nodeKey,
      expectedEntityRevision: 1,
      set: {
        label: "Paper-grounded residual connection question",
        authority: "paper_grounded",
        sourceAnchorIds: [reader.anchorId],
      },
    }],
  }));
  assert.deepEqual(reauthored.affected.updated, [reader.nodeKey]);
  assert.equal(state.graph.getNodeAttribute(reader.nodeKey, "origin"), "agent");
  assert.equal(state.graph.getNodeAttribute(reader.nodeKey, "authority"), "paper_grounded");
  assert.equal(state.annotations.get(reader.annotationId).label, originalBody, "graph interaction must not rewrite the reader annotation body");
});

test("rejects foreign, stale, tampered, and unknown reader/graph targets without partial changes", async () => {
  const foreignState = await createFixture();
  const foreignBaseline = snapshotForAtomicTest(foreignState);
  const foreignAnchor = await readerAnchor(foreignState);
  foreignAnchor.paperRef = "paper:foreign";
  await assert.rejects(
    applyReaderAnnotation(foreignState, readerAnnotationCommand(foreignState, foreignAnchor)),
    (error) => error.code === "not_found_in_active_paper",
  );
  assert.deepEqual(snapshotForAtomicTest(foreignState), foreignBaseline);

  const tamperedState = await createFixture();
  const tamperedBaseline = snapshotForAtomicTest(tamperedState);
  const tamperedAnchor = await readerAnchor(tamperedState);
  tamperedAnchor.normalizedBounds[0].x += 0.01;
  await assert.rejects(
    applyReaderAnnotation(tamperedState, readerAnnotationCommand(tamperedState, tamperedAnchor)),
    (error) => error.code === "anchor_digest_conflict",
  );
  assert.deepEqual(snapshotForAtomicTest(tamperedState), tamperedBaseline);

  const staleState = await createFixture();
  const staleAnchor = await readerAnchor(staleState);
  const staleCommand = readerAnnotationCommand(staleState, staleAnchor);
  await toolsFor(staleState).get("paperpilot.apply_graph").execute(graphCommand(staleState));
  const settled = snapshotForAtomicTest(staleState);
  await assert.rejects(
    applyReaderAnnotation(staleState, staleCommand),
    (error) => error.code === "stale_workspace",
  );
  assert.deepEqual(snapshotForAtomicTest(staleState), settled);

  const unknown = await toolsFor(staleState).get("paperpilot.read_graph").execute({
    mode: "node",
    nodeKey: "node:missing:reader",
  });
  assert.equal(unknown.status, "rejected");
  assert.equal(unknown.code, "not_found_in_active_paper");
  assert.deepEqual(snapshotForAtomicTest(staleState), settled);
});

test("keeps agent annotations memory-only while human Undo restores the hydrated fixture", async () => {
  const activeSession = await createFixture();
  const baselineDigest = activeSession.workspaceDigest;
  const baselineAnnotationDigest = activeSession.annotationDigest;
  const baselineAnnotations = [...activeSession.annotations].map(([key, value]) => [key, structuredClone(value)]);
  const tool = toolsFor(activeSession).get("paperpilot.apply_annotation");

  const applied = await tool.execute(annotationCommand(activeSession));
  assert.equal(applied.status, "applied_reversible");
  assert.equal(activeSession.annotations.size, baselineAnnotations.length + 1);
  const agentAnnotationId = applied.affected.created[0];
  assert.equal(activeSession.annotations.has(agentAnnotationId), true);

  const ordinaryReload = await createFixture();
  assert.deepEqual([...ordinaryReload.annotations], baselineAnnotations);
  assert.equal(ordinaryReload.annotations.has(agentAnnotationId), false);
  assert.equal(ordinaryReload.workspaceDigest, baselineDigest);
  assert.equal(ordinaryReload.annotationDigest, baselineAnnotationDigest);

  const undone = await undoLastHumanChange(activeSession);
  assert.equal(undone.status, "undone");
  assert.equal(undone.digestMatches, true);
  assert.deepEqual([...activeSession.annotations], baselineAnnotations);
  assert.equal(activeSession.workspaceDigest, baselineDigest);
  assert.equal(activeSession.annotationDigest, baselineAnnotationDigest);
});

test("requires provenance reads before staging and supports source focus without a transcript", async () => {
  const navigations = [];
  const state = await createFixture({ onNavigate: (anchor) => navigations.push(anchor.anchorId) });
  const tools = toolsFor(state);
  const stageInput = {
    focusAnchorId: state.focusAnchorId,
    expectedWorkspaceRevision: state.workspaceRevision,
    expectedGraphDigest: state.graphDigest,
    sections: EXPLANATION_SECTIONS,
    sourceAnchorIds: ["anchor:text:attention"],
    graphEntityKeys: ["node:concept:attention"],
    visualEvidenceMode: "not_applicable",
  };

  const tooEarly = await tools.get("paperpilot.stage_explain").execute(stageInput);
  assert.equal(tooEarly.status, "rejected");
  assert.equal(tooEarly.code, "read_required");

  const focusRead = await tools.get("paperpilot.read_focus").execute({});
  assert.equal(focusRead.status, "ready");
  assert.equal(focusRead.focus.anchorId, "anchor:text:attention");
  assert.match(focusRead.focus.exactText, /attention mechanisms/i);
  assert.equal("transcript" in focusRead, false);
  assert.equal("transcript" in focusRead.focus, false);

  const graphRead = await tools.get("paperpilot.read_graph").execute({ mode: "overview" });
  assert.equal(graphRead.status, "ready");
  assert.equal(graphRead.nodes.length, 3);
  assert.equal(graphRead.edges.length, 2);
  assert.equal(graphRead.workspaceRevision, state.workspaceRevision);

  const staged = await tools.get("paperpilot.stage_explain").execute(stageInput);
  assert.equal(staged.status, "staged");
  assert.match(staged.responseDigest, /^[0-9a-f]{64}$/);
  assert.equal(state.explanations.length, 1);

  const focused = await tools.get("paperpilot.focus_source").execute({
    targetType: "anchor",
    targetId: "anchor:visual:a",
  });
  assert.equal(focused.status, "focused");
  assert.equal(focused.anchorId, "anchor:visual:a");
  assert.deepEqual(navigations, ["anchor:visual:a"]);

  const visualRead = await tools.get("paperpilot.read_focus").execute({});
  assert.equal(visualRead.focus.sourceKind, "visual_region");
  assert.deepEqual(visualRead.focus.visualEvidence, {
    mode: "locator_only",
    visibleRegionId: "visual-region-a",
    pixelUseVerified: false,
  });
});

test("applies reversible graph and annotation commands against current digests", async () => {
  const state = await createFixture();
  const tools = toolsFor(state);
  const initialRevision = state.workspaceRevision;

  const graphResult = await tools.get("paperpilot.apply_graph").execute(graphCommand(state));
  assert.equal(graphResult.status, "applied_reversible");
  assert.equal(graphResult.replayed, false);
  assert.equal(graphResult.fromRevision, initialRevision);
  assert.equal(graphResult.toRevision, initialRevision + 1);
  assert.equal(graphResult.inverseRetained, true);
  assert.equal(graphResult.undoAvailable, true);
  assert.notEqual(graphResult.beforeGraphDigest, graphResult.afterGraphDigest);
  const createdNodeKey = graphResult.affected.created[0];
  assert.equal(state.graph.hasNode(createdNodeKey), true);
  assert.equal(state.graph.getNodeAttribute(createdNodeKey, "origin"), "agent");

  const annotationInput = annotationCommand(state);
  annotationInput.operations[0].graphNodeKeys = [createdNodeKey];
  const annotationResult = await tools.get("paperpilot.apply_annotation").execute(annotationInput);
  assert.equal(annotationResult.status, "applied_reversible");
  assert.equal(annotationResult.fromRevision, initialRevision + 1);
  assert.equal(annotationResult.toRevision, initialRevision + 2);
  assert.notEqual(annotationResult.beforeAnnotationDigest, annotationResult.afterAnnotationDigest);
  const annotationId = annotationResult.affected.created[0];
  assert.equal(state.annotations.get(annotationId).paperRef, state.paper.paperRef);
  assert.deepEqual(state.annotations.get(annotationId).graphNodeKeys, [createdNodeKey]);
});

test("replays the same graph command with a fresh callback receipt and no new revision", async () => {
  const state = await createFixture();
  const tool = toolsFor(state).get("paperpilot.apply_graph");
  const input = graphCommand(state);
  const applied = await tool.execute(input);
  assert.equal(applied.status, "applied_reversible");

  const revisionAfterApply = state.workspaceRevision;
  const graphOrderAfterApply = state.graph.order;
  const eventCountAfterApply = state.events.length;
  const replayed = await tool.execute(structuredClone(input));

  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.operationId, applied.operationId);
  assert.equal(replayed.revisionId, applied.revisionId);
  assert.notEqual(replayed.callbackReceiptId, applied.callbackReceiptId);
  assert.equal(state.workspaceRevision, revisionAfterApply);
  assert.equal(state.graph.order, graphOrderAfterApply);
  assert.equal(state.events.length, eventCountAfterApply + 1);
  assert.equal(state.events.at(-1).callbackReceiptId, replayed.callbackReceiptId);
  assert.equal(state.events.at(-1).toolName, "paperpilot.apply_graph");
});

test("serializes concurrent duplicate commands into one apply and one replay", async () => {
  const state = await createFixture();
  const tool = toolsFor(state).get("paperpilot.apply_graph");
  const input = graphCommand(state, { idempotencyKey: "graph-concurrent-0001" });
  const initialRevision = state.workspaceRevision;
  const initialOrder = state.graph.order;

  const results = await Promise.all([
    tool.execute(structuredClone(input)),
    tool.execute(structuredClone(input)),
  ]);

  assert.deepEqual(sorted(results.map((result) => result.status)), ["applied_reversible", "replayed"]);
  assert.notEqual(results[0].callbackReceiptId, results[1].callbackReceiptId);
  assert.equal(state.workspaceRevision, initialRevision + 1);
  assert.equal(state.graph.order, initialOrder + 1);
});

test("rejects idempotency conflicts and stale mutation bases without partial changes", async () => {
  const state = await createFixture();
  const tool = toolsFor(state).get("paperpilot.apply_graph");
  const original = graphCommand(state);
  const applied = await tool.execute(original);
  assert.equal(applied.status, "applied_reversible");
  const settledRevision = state.workspaceRevision;
  const settledDigest = state.workspaceDigest;
  const settledOrder = state.graph.order;

  const conflictInput = structuredClone(original);
  conflictInput.reason = "Different semantic content using the same key.";
  const conflict = await tool.execute(conflictInput);
  assert.equal(conflict.status, "rejected");
  assert.equal(conflict.code, "idempotency_conflict");

  const staleInput = structuredClone(original);
  staleInput.idempotencyKey = "graph-command-stale-0002";
  const stale = await tool.execute(staleInput);
  assert.equal(stale.status, "rejected");
  assert.equal(stale.code, "stale_workspace");
  assert.equal(state.workspaceRevision, settledRevision);
  assert.equal(state.workspaceDigest, settledDigest);
  assert.equal(state.graph.order, settledOrder);
});

test("rejects foreign-paper sources and rolls graph and annotation batches back atomically", async () => {
  const state = await createFixture();
  const tools = toolsFor(state);
  const initialRevision = state.workspaceRevision;
  const initialWorkspaceDigest = state.workspaceDigest;
  const initialGraphDigest = state.graphDigest;
  const initialAnnotationDigest = state.annotationDigest;
  const initialAnnotationCount = state.annotations.size;
  const initialOrder = state.graph.order;

  state.anchors.set("anchor:foreign:one", {
    ...structuredClone(state.anchors.get("anchor:text:attention")),
    anchorId: "anchor:foreign:one",
    paperRef: "paper:foreign",
  });
  const foreignAnnotation = annotationCommand(state, {
    idempotencyKey: "annotation-foreign-0001",
  });
  foreignAnnotation.operations[0].anchorId = "anchor:foreign:one";
  const foreignResult = await tools.get("paperpilot.apply_annotation").execute(foreignAnnotation);
  assert.equal(foreignResult.status, "rejected");
  assert.equal(foreignResult.code, "not_found_in_active_paper");

  const atomicGraph = graphCommand(state, {
    idempotencyKey: "graph-atomicity-0001",
    operations: [
      graphCommand(state).operations[0],
      {
        op: "add_edge",
        clientRef: "client:edge:one",
        edge: {
          source: { refType: "client_ref", clientRef: "client:concept:one" },
          target: { refType: "client_ref", clientRef: "client:missing:one" },
          kind: "supports",
          claim: "This must not survive a failed batch.",
          authority: "paper_grounded",
          sourceAnchorIds: ["anchor:text:attention"],
        },
      },
    ],
  });
  const graphFailure = await tools.get("paperpilot.apply_graph").execute(atomicGraph);
  assert.equal(graphFailure.status, "rejected");
  assert.equal(graphFailure.code, "graph_endpoint_invalid");

  const atomicAnnotation = annotationCommand(state, {
    idempotencyKey: "annotation-atomicity-0001",
    operations: [
      annotationCommand(state).operations[0],
      {
        op: "update_annotation",
        annotationId: "annotation:missing:one",
        expectedEntityRevision: 1,
        set: { label: "This must not survive a failed batch." },
      },
    ],
  });
  const annotationFailure = await tools.get("paperpilot.apply_annotation").execute(atomicAnnotation);
  assert.equal(annotationFailure.status, "rejected");
  assert.equal(annotationFailure.code, "not_found_in_active_paper");

  assert.equal(state.workspaceRevision, initialRevision);
  assert.equal(state.workspaceDigest, initialWorkspaceDigest);
  assert.equal(state.graphDigest, initialGraphDigest);
  assert.equal(state.annotationDigest, initialAnnotationDigest);
  assert.equal(state.graph.order, initialOrder);
  assert.equal(state.annotations.size, initialAnnotationCount);
});

test("human Undo restores the semantic digest while advancing the audit revision", async () => {
  const state = await createFixture();
  const tools = toolsFor(state);
  const originalRevision = state.workspaceRevision;
  const originalDigest = state.workspaceDigest;
  const applied = await tools.get("paperpilot.apply_graph").execute(graphCommand(state));
  const createdNodeKey = applied.affected.created[0];
  assert.equal(state.graph.hasNode(createdNodeKey), true);

  const undone = await undoLastHumanChange(state);
  assert.equal(undone.status, "undone");
  assert.equal(undone.relatedRevisionId, applied.revisionId);
  assert.equal(undone.expectedWorkspaceDigest, originalDigest);
  assert.equal(undone.restoredWorkspaceDigest, originalDigest);
  assert.equal(undone.digestMatches, true);
  assert.equal(state.workspaceDigest, originalDigest);
  assert.equal(state.workspaceRevision, originalRevision + 2);
  assert.equal(state.graph.hasNode(createdNodeKey), false);
  assert.equal(state.events.at(-1).actor, "human");
  assert.equal(state.events.at(-1).eventType, "undo_applied");
});

test("Human Redo restores the exact semantic after-digest while advancing audit revision", async () => {
  const state = await createFixture();
  const applied = await toolsFor(state).get("paperpilot.apply_graph").execute(graphCommand(state));
  const appliedDigest = applied.afterWorkspaceDigest;
  const appliedRevision = state.workspaceRevision;

  const undone = await undoLastHumanChange(state);
  assert.equal(undone.status, "undone");
  assert.equal(state.redoHistory.length, 1);
  assert.ok(state.workspaceRevision > appliedRevision);

  const redone = await redoLastHumanChange(state);
  assert.equal(redone.status, "redone");
  assert.equal(redone.digestMatches, true);
  assert.equal(state.workspaceDigest, appliedDigest);
  assert.equal(state.redoHistory.length, 0);
  assert.equal(state.history.length, 1);
  assert.ok(state.workspaceRevision > appliedRevision + 1);
  assert.equal(state.events.at(-1).eventType, "redo_applied");
});

test("a divergent reader or agent mutation clears the Human Redo branch", async () => {
  const state = await createFixture();
  await toolsFor(state).get("paperpilot.apply_graph").execute(graphCommand(state));
  await undoLastHumanChange(state);
  assert.equal(state.redoHistory.length, 1);

  const divergent = graphCommand(state, {
    idempotencyKey: "graph-command-divergent-0002",
    reason: "Create a different grounded concept after choosing a new history branch.",
    operations: [{
      op: "add_node",
      clientRef: "client:concept:divergent",
      node: {
        kind: "concept",
        label: "Divergent grounded branch",
        summary: "This new node deliberately replaces the undone history branch.",
        authority: "paper_grounded",
        sourceAnchorIds: ["anchor:text:attention"],
        salience: 0.61,
      },
    }],
  });
  const applied = await toolsFor(state).get("paperpilot.apply_graph").execute(divergent);
  assert.equal(applied.status, "applied_reversible");
  assert.equal(state.redoHistory.length, 0);
  assert.deepEqual(await redoLastHumanChange(state), { status: "nothing_to_redo" });
});

test("enforces canonical UTF-8 input and JSON result byte budgets without clipping", async () => {
  assert.equal(LIMITS.inputBytes, 32 * 1024);
  assert.equal(LIMITS.resultBytes, 48 * 1024);
  const unicodeValue = { mentor: "résumé → attention" };
  assert.equal(resultSizeBytes(unicodeValue), Buffer.byteLength(JSON.stringify(unicodeValue), "utf8"));

  const state = await createFixture();
  const tools = toolsFor(state);
  const oversizedInput = await tools.get("paperpilot.read_focus").execute({
    padding: "x".repeat(LIMITS.inputBytes),
  });
  assert.equal(oversizedInput.status, "rejected");
  assert.equal(oversizedInput.code, "input_too_large");

  state.paper.filename = "x".repeat(LIMITS.resultBytes);
  const oversizedResult = await tools.get("paperpilot.read_focus").execute({});
  assert.deepEqual(oversizedResult, {
    schemaVersion: 1,
    status: "rejected",
    code: "result_too_large",
    message: "The bounded result exceeded the frozen 48 KiB UTF-8 ceiling.",
  });
});

test("mounts all tools under one registration signal and disposes the suite", async () => {
  const state = await createFixture();
  const tools = createToolSuite(state);
  const calls = [];
  const disposals = [];
  const modelContext = {
    async registerTool(tool, options) {
      calls.push({ tool, signal: options.signal });
    },
  };

  const mounted = await mountToolSuite(modelContext, tools, {
    onDispose: (record) => disposals.push(record),
  });
  assert.deepEqual(mounted.registrations, EXPECTED_TOOL_NAMES);
  assert.deepEqual(calls.map(({ tool }) => tool.name), EXPECTED_TOOL_NAMES);
  assert.equal(new Set(calls.map(({ signal }) => signal)).size, 1);
  assert.strictEqual(calls[0].signal, mounted.controller.signal);
  assert.equal(mounted.controller.signal.aborted, false);

  mounted.dispose("test_complete");
  assert.equal(mounted.controller.signal.aborted, true);
  assert.deepEqual(disposals, [{ reason: "test_complete", registrations: EXPECTED_TOOL_NAMES }]);
});

test("aborts every shared registration after a partial registration failure", async () => {
  const state = await createFixture();
  const tools = createToolSuite(state);
  const signals = [];
  const disposals = [];
  const registrationError = new Error("client rejected registration four");
  let callCount = 0;
  const modelContext = {
    async registerTool(_tool, options) {
      signals.push(options.signal);
      callCount += 1;
      if (callCount === 4) throw registrationError;
    },
  };

  await assert.rejects(
    mountToolSuite(modelContext, tools, { onDispose: (record) => disposals.push(record) }),
    (error) => error === registrationError,
  );
  assert.equal(signals.length, 4);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(disposals, [{
    reason: "partial_registration_failure",
    registrations: EXPECTED_TOOL_NAMES.slice(0, 3),
  }]);
});
