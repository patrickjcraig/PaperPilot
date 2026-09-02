import assert from "node:assert/strict";
import test from "node:test";

import { MultiDirectedGraph } from "graphology";

import {
  BROWSER_SNAPSHOT_KEY_PREFIX,
  BROWSER_SNAPSHOT_LIMITS,
  BROWSER_SNAPSHOT_SCHEMA_VERSION,
  MAX_BROWSER_SNAPSHOT_BYTES,
  browserSnapshotKey,
  clearBrowserSnapshot,
  loadBrowserSnapshot,
  saveBrowserSnapshot,
} from "./browser-snapshot.mjs";
import {
  PAPER_FIXTURE,
  SPIKE_VERSIONS,
  applyReaderAnnotation,
  createSpikeState,
  createToolSuite,
  mintReaderAnchor,
  removeReaderAnnotation,
  redoLastHumanChange,
  undoLastHumanChange,
} from "./contracts.mjs";
import {
  computeSpatialAnchorDigest,
  createSpatialAnchor,
  createSpatialRendererRecipe,
} from "./spatial-anchor.mjs";
import { createWholePaperStructuralMap } from "./structural-map.mjs";
import { applyWorkspacePatch, invertWorkspacePatch } from "./workspace-patch.mjs";

const CANONICAL_ANCHOR_ID = "anchor:reader:snapshot-canonical";

function memoryStorage({ setError, getError, removeError } = {}) {
  const values = new Map();
  const calls = { get: 0, set: 0, remove: 0 };
  return {
    values,
    calls,
    getItem(key) {
      calls.get += 1;
      if (getError) throw getError;
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      calls.set += 1;
      if (setError) throw setError;
      values.set(key, String(value));
    },
    removeItem(key) {
      calls.remove += 1;
      if (removeError) throw removeError;
      values.delete(key);
    },
  };
}

let fixtureSequence = 0;
function deterministicOptions(overrides = {}) {
  let sequence = 0;
  const instance = ++fixtureSequence;
  return {
    now: () => "2026-08-31T08:00:00.000Z",
    id: (prefix) => `${prefix}:fixture${instance}:${String(++sequence).padStart(8, "0")}`,
    ...overrides,
  };
}

async function fixture(overrides = {}) {
  return createSpikeState(MultiDirectedGraph, deterministicOptions(overrides));
}

function structuralMapFixture(outlineEntries = [
  { title: "Abstract", pageIndex: 0 },
  { title: "Methods", pageIndex: 5 },
  { title: "Results", pageIndex: 10 },
]) {
  return createWholePaperStructuralMap({
    documentSha256: PAPER_FIXTURE.documentSha256,
    pages: Array.from({ length: 15 }, (_, pageIndex) => ({
      pageIndex,
      pageLabel: String(pageIndex + 1),
      pageViewBox: [0, 0, 612, 792],
      pageRotation: 0,
      textCapability: "exact_candidate",
    })),
    outlineEntries,
  });
}

function toolsFor(state) {
  return new Map(createToolSuite(state).map((tool) => [tool.name, tool]));
}

function graphCommand(state, sequence) {
  return {
    idempotencyKey: `snapshot-graph-command-${String(sequence).padStart(4, "0")}`,
    baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest,
    baseGraphDigest: state.graphDigest,
    reason: `Create grounded concept ${sequence} before saving the browser snapshot.`,
    operations: [{
      op: "add_node",
      clientRef: `client:snapshot:${sequence}`,
      node: {
        kind: "concept",
        label: `Saved concept ${sequence}`,
        summary: `A paper-grounded concept used to verify browser snapshot history ${sequence}.`,
        authority: "paper_grounded",
        sourceAnchorIds: ["anchor:text:attention"],
        salience: 0.7,
      },
    }],
  };
}

function fingerprint(state) {
  return {
    paper: structuredClone(state.paper),
    revision: state.workspaceRevision,
    workspaceDigest: state.workspaceDigest,
    graphDigest: state.graphDigest,
    annotationDigest: state.annotationDigest,
    focusAnchorId: state.focusAnchorId,
    anchors: [...state.anchors].map(([key, value]) => [key, structuredClone(value)]),
    annotations: [...state.annotations].map(([key, value]) => [key, structuredClone(value)]),
    graph: state.graph.export(),
    history: state.history.length,
    redoHistory: state.redoHistory.length,
    revisions: structuredClone(state.revisions || []),
    events: structuredClone(state.events),
    requestResults: [...state.requestResults].map(([key, value]) => [key, structuredClone(value)]),
  };
}

function semanticSnapshotForHistory(state) {
  return {
    anchors: new Map([...state.anchors].map(([key, value]) => [key, structuredClone(value)])),
    annotations: new Map([...state.annotations].map(([key, value]) => [key, structuredClone(value)])),
    graph: state.graph.copy(),
    workspaceRevision: state.workspaceRevision,
    workspaceDigest: state.workspaceDigest,
    graphDigest: state.graphDigest,
    annotationDigest: state.annotationDigest,
    focusAnchorId: state.focusAnchorId,
  };
}

function canonicalSnapshotJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshotJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSnapshotJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serializeLegacyState(state, entry, prefix) {
  return {
    anchors: [...state.anchors].sort(([a], [b]) => a.localeCompare(b)),
    annotations: [...state.annotations].sort(([a], [b]) => a.localeCompare(b)),
    graph: state.graph.export(),
    workspaceRevision: entry ? entry[prefix === "before" ? "fromRevision" : "toRevision"] : state.workspaceRevision,
    workspaceDigest: entry ? entry[`${prefix}WorkspaceDigest`] : state.workspaceDigest,
    graphDigest: entry ? entry[`${prefix}GraphDigest`] : state.graphDigest,
    annotationDigest: entry ? entry[`${prefix}AnnotationDigest`] : state.annotationDigest,
    focusAnchorId: entry ? entry[`${prefix}FocusAnchorId`] : state.focusAnchorId,
  };
}

// Materialize the actual historical v2 format in test fixtures, not in runtime
// persistence. The migration tests exercise independent legacy decoding first.
async function legacyEnvelope(raw, state) {
  const envelope = JSON.parse(raw);
  envelope.schemaVersion = 2;
  envelope.payload.schemaVersion = 2;
  const expand = (entries, inverse) => {
    let cursor = semanticSnapshotForHistory(state);
    return [...entries].reverse().map((entry) => {
      const next = applyWorkspacePatch(cursor, inverse ? entry.inversePatch : entry.forwardPatch);
      const before = inverse ? next : cursor;
      const after = inverse ? cursor : next;
      cursor = next;
      return {
        kind: entry.kind, revisionId: entry.revisionId, operationId: entry.operationId,
        before: serializeLegacyState(before, entry, "before"),
        after: serializeLegacyState(after, entry, "after"),
      };
    }).reverse();
  };
  envelope.payload.workspace = {
    current: envelope.payload.workspace.current,
    history: expand(state.history, true),
    redoHistory: expand(state.redoHistory, false),
  };
  envelope.payloadChecksum = await sha256Text(canonicalSnapshotJson(envelope.payload));
  return JSON.stringify(envelope);
}

async function rechecksum(envelope) {
  envelope.payloadChecksum = await sha256Text(canonicalSnapshotJson(envelope.payload));
  return JSON.stringify(envelope);
}

async function canonicalTextAnchor(state) {
  const seededPageAnchor = state.anchors.get("anchor:page:1");
  const pageViewBox = seededPageAnchor.pageViewBox;
  const rotation = seededPageAnchor.pageRotation;
  return createSpatialAnchor({
    anchorId: CANONICAL_ANCHOR_ID,
    paperRef: state.paper.paperRef,
    documentSha256: state.paper.documentSha256,
    pageIndex: 0,
    pageLabel: "1",
    pageViewBox,
    rotation,
    rendererRecipe: createSpatialRendererRecipe({
      rendererVersion: SPIKE_VERSIONS.pdfjs,
      pageViewBox,
      pageRotation: rotation,
    }),
    sourceKind: "exact_text",
    geometryKind: "text",
    normalizedBounds: [{ x: 0.12, y: 0.2, width: 0.3, height: 0.04 }],
    quote: {
      exact: "A canonical source passage persisted by the browser snapshot.",
      prefix: "Before the passage.",
      suffix: "After the passage.",
    },
    textItemRefs: ["page:1:text-item:7"],
    createdBy: "human",
    createdAt: "2026-08-31T08:00:00.000Z",
  });
}

function currentStoredAnchor(envelope) {
  return envelope.payload.workspace.current.anchors
    .find(([anchorId]) => anchorId === CANONICAL_ANCHOR_ID)?.[1];
}

async function tamperCanonicalEnvelope(raw, mutate, { rehashAnchor = true } = {}) {
  const envelope = JSON.parse(raw);
  const anchor = currentStoredAnchor(envelope);
  assert.ok(anchor, "the canonical anchor fixture must be present in the stored current workspace");
  mutate(anchor);
  if (rehashAnchor) anchor.anchorDigest = await computeSpatialAnchorDigest(anchor);
  envelope.payloadChecksum = await sha256Text(canonicalSnapshotJson(envelope.payload));
  return JSON.stringify(envelope);
}

async function tamperStoredGraph(raw, mutate) {
  const envelope = JSON.parse(raw);
  const current = envelope.payload.workspace.current;
  mutate(current.graph);
  const excluded = new Set(["x", "y", "size", "color", "hidden", "selected", "hovered", "entityRevision", "createdAt", "updatedAt"]);
  const attributes = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
  const graph = {
    nodes: [...current.graph.nodes].sort((left, right) => left.key.localeCompare(right.key)).map(({ key, attributes: value }) => ({ key, ...attributes(value) })),
    edges: [...current.graph.edges].sort((left, right) => left.key.localeCompare(right.key)).map(({ key, source, target, attributes: value }) => ({ key, sourceKey: source, targetKey: target, ...attributes(value) })),
  };
  const annotations = [...current.annotations].sort(([left], [right]) => left.localeCompare(right)).map(([, annotation]) => (
    Object.fromEntries(Object.entries(annotation).filter(([key]) => !["entityRevision", "createdAt", "updatedAt"].includes(key)))
  ));
  current.graphDigest = await sha256Text(canonicalSnapshotJson(graph));
  current.workspaceDigest = await sha256Text(canonicalSnapshotJson({ graph, annotations }));
  envelope.payloadChecksum = await sha256Text(canonicalSnapshotJson(envelope.payload));
  return JSON.stringify(envelope);
}

async function remintStoredStructuralAnchor(anchor, change) {
  const canonical = Boolean(anchor.rendererRecipe);
  const input = canonical
    ? Object.fromEntries([
      "anchorId", "paperRef", "documentSha256", "pageIndex", "pageLabel",
      "pageViewBox", "rotation", "rendererRecipe", "sourceKind", "geometryKind",
      "normalizedBounds", "textItemRefs", "createdBy", "createdAt",
    ].map((key) => [key, structuredClone(anchor[key])]))
    : structuredClone(anchor);
  if (change === "wrong page") {
    input.pageIndex = 14;
    input.pageLabel = "15";
  } else if (change === "different geometry") {
    input.pageViewBox = [20, 30, 590, 770];
    if (canonical) {
      input.rotation = 90;
      input.rendererRecipe = createSpatialRendererRecipe({
        rendererVersion: SPIKE_VERSIONS.pdfjs,
        pageViewBox: input.pageViewBox,
        pageRotation: input.rotation,
      });
    } else input.pageRotation = 90;
  } else if (change === "different source kind") {
    input.sourceKind = "visual_region";
  } else throw new Error(`Unknown structural-anchor test change: ${change}`);
  if (canonical) return createSpatialAnchor(input);
  delete input.anchorDigest;
  return { ...input, anchorDigest: await sha256Text(canonicalSnapshotJson(input)) };
}

test("versions and keys each browser snapshot by the lowercase PDF SHA-256 identity", () => {
  assert.equal(BROWSER_SNAPSHOT_SCHEMA_VERSION, 3);
  assert.equal(MAX_BROWSER_SNAPSHOT_BYTES, 4 * 1024 * 1024);
  assert.equal(BROWSER_SNAPSHOT_KEY_PREFIX, "paperpilot:webmcp:v3:");
  assert.deepEqual(BROWSER_SNAPSHOT_LIMITS, {
    history: 200,
    redoHistory: 200,
    revisions: 200,
    events: 500,
    requestResults: 200,
    annotations: 800,
  });
  assert.equal(
    browserSnapshotKey(PAPER_FIXTURE.documentSha256),
    `${BROWSER_SNAPSHOT_KEY_PREFIX}${PAPER_FIXTURE.documentSha256}`,
  );
  assert.throws(() => browserSnapshotKey("A".repeat(64)), /lowercase SHA-256/);
  assert.throws(() => browserSnapshotKey("short"), /lowercase SHA-256/);
});

test("detects only the exact current-PDF v1 key without decoding, hydrating, or changing its bytes", async () => {
  const state = await fixture({ structuralMap: structuralMapFixture() });
  const before = fingerprint(state);
  const storage = memoryStorage();
  const key = browserSnapshotKey(state.paper.documentSha256);
  const legacyKey = `paperpilot:webmcp:v1:${state.paper.documentSha256}`;
  const legacyBytes = "Preserved v1 bytes: intentionally not decoded as a v2 envelope.";
  const unrelatedKey = `paperpilot:webmcp:v1:${"f".repeat(64)}`;
  storage.values.set(legacyKey, legacyBytes);
  storage.values.set(unrelatedKey, "Another paper must never be inspected.");
  const requestedKeys = [];
  const getItem = storage.getItem.bind(storage);
  storage.getItem = (requestedKey) => {
    requestedKeys.push(requestedKey);
    return getItem(requestedKey);
  };
  assert.deepEqual(await loadBrowserSnapshot({ storage, state }), {
    status: "legacy_preserved",
    key,
    legacyKey,
    legacySchemaVersion: 1,
  });
  assert.deepEqual(requestedKeys, [key, `paperpilot:webmcp:v2:${state.paper.documentSha256}`, legacyKey]);
  assert.deepEqual(fingerprint(state), before);
  assert.equal(storage.values.get(legacyKey), legacyBytes);
  assert.equal(storage.values.get(unrelatedKey), "Another paper must never be inspected.");
  assert.equal(storage.values.has(key), false);
  assert.equal(storage.calls.set, 0);
  assert.equal(storage.calls.remove, 0);

  storage.values.delete(legacyKey);
  assert.deepEqual(await loadBrowserSnapshot({ storage, state }), { status: "not_found", key });
  assert.deepEqual(fingerprint(state), before);
});

test("prefers an existing v3 snapshot over v1 and never falls back from unsupported v3 formats", async () => {
  const source = await fixture({ structuralMap: structuralMapFixture() });
  const storage = memoryStorage();
  const legacyKey = `paperpilot:webmcp:v1:${source.paper.documentSha256}`;
  const legacyBytes = "The existing v1 snapshot stays separate.";
  storage.values.set(legacyKey, legacyBytes);
  const saved = await saveBrowserSnapshot({ storage, state: source });
  const requestedKeys = [];
  const getItem = storage.getItem.bind(storage);
  storage.getItem = (key) => {
    requestedKeys.push(key);
    return getItem(key);
  };
  const target = await fixture({ structuralMap: structuralMapFixture() });
  const restored = await loadBrowserSnapshot({ storage, state: target });
  assert.equal(restored.status, "restored");
  assert.deepEqual(requestedKeys, [saved.key]);
  assert.deepEqual(
    { ...fingerprint(target), anchors: target.anchors },
    { ...fingerprint(source), anchors: source.anchors },
    "Recovery preserves the anchor registry; serialized key order is not semantic state.",
  );
  assert.equal(storage.values.get(legacyKey), legacyBytes);
  assert.equal(storage.calls.set, 1);
  assert.equal(storage.calls.remove, 0);

  const unsupported = JSON.parse(storage.values.get(saved.key));
  unsupported.schemaVersion = 999;
  const unsupportedBytes = JSON.stringify(unsupported);
  storage.values.set(saved.key, unsupportedBytes);
  const before = fingerprint(target);
  requestedKeys.length = 0;
  const rejected = await loadBrowserSnapshot({ storage, state: target });
  assert.equal(rejected.status, "invalid");
  assert.equal(rejected.reason, "schema_version_mismatch");
  assert.deepEqual(requestedKeys, [saved.key]);
  assert.deepEqual(fingerprint(target), before);
  assert.equal(storage.values.get(saved.key), unsupportedBytes);
  assert.equal(storage.values.get(legacyKey), legacyBytes);
  assert.equal(storage.calls.set, 1);
  assert.equal(storage.calls.remove, 0);
});

test("round-trips graph, annotations, audit trail, idempotency receipts, saved explanations, and both history branches", async () => {
  const state = await fixture();
  const tools = toolsFor(state);
  const first = await tools.get("paperpilot.apply_graph").execute(graphCommand(state, 1));
  const second = await tools.get("paperpilot.apply_graph").execute(graphCommand(state, 2));
  assert.equal(first.status, "applied_reversible");
  assert.equal(second.status, "applied_reversible");
  const secondDigest = state.workspaceDigest;
  const undone = await undoLastHumanChange(state);
  assert.equal(undone.status, "undone");
  assert.equal(state.history.length, 1);
  assert.equal(state.redoHistory.length, 1);

  const savedExplanations = [{
    explanationId: "explanation:saved:attention",
    responseDigest: "c".repeat(64),
    focusAnchorId: "anchor:text:attention",
    sourceAnchorIds: ["anchor:text:attention"],
    sections: {
      quickTake: "Attention compares relevant token representations directly.",
      limitations: "This mentor explanation is saved by the human, not verified science.",
    },
    savedAt: "2026-08-31T08:01:00.000Z",
  }];
  const storage = memoryStorage();
  const presentation = {
    annotationOrder: [...state.annotations.keys()].reverse(),
  };
  const saved = await saveBrowserSnapshot({
    storage,
    state,
    savedExplanations,
    presentation,
    now: () => "2026-08-31T08:02:00.000Z",
  });
  assert.equal(saved.status, "saved");
  assert.ok(saved.bytes > 0 && saved.bytes <= MAX_BROWSER_SNAPSHOT_BYTES);
  assert.equal(storage.calls.set, 1);

  const restored = await fixture();
  const callbacks = {
    now: restored.now,
    id: restored.id,
    onStateChange: restored.onStateChange,
  };
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored");
  assert.equal(loaded.savedAt, "2026-08-31T08:02:00.000Z");
  assert.deepEqual(loaded.savedExplanations, savedExplanations);
  assert.deepEqual(loaded.presentation, presentation);
  assert.deepEqual(fingerprint(restored), fingerprint(state));
  assert.deepEqual(restored.savedExplanations, savedExplanations);
  assert.equal(restored.explanations.length, 0, "staged explanations must not cross a reload");
  assert.equal(restored.latestReadFocusReceipt, null);
  assert.equal(restored.latestReadGraphReceipt, null);
  assert.equal(restored.now, callbacks.now, "page-owned runtime callbacks must stay live");
  assert.equal(restored.id, callbacks.id);
  assert.equal(restored.onStateChange, callbacks.onStateChange);

  const redone = await redoLastHumanChange(restored);
  assert.equal(redone.status, "redone");
  assert.equal(redone.digestMatches, true);
  assert.equal(restored.workspaceDigest, secondDigest);
  assert.equal(restored.history.length, 2);
  assert.equal(restored.redoHistory.length, 0);
});

test("restores only snapshots that retain the current deterministic structural baseline", async () => {
  const structuralMap = structuralMapFixture();
  const source = await fixture({ structuralMap });
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  assert.equal(saved.status, "saved");

  const matching = await fixture({ structuralMap: structuralMapFixture() });
  const restored = await loadBrowserSnapshot({ storage, state: matching });
  assert.equal(restored.status, "restored");
  assert.ok(matching.structuralMap.nodes.every(({ key, edgeKey }) => (
    matching.graph.getNodeAttribute(key, "status") === "active"
    && matching.graph.getEdgeAttribute(edgeKey, "status") === "active"
  )));

  const changedStructure = structuralMapFixture([
    { title: "Abstract", pageIndex: 0 },
    { title: "Architecture", pageIndex: 4 },
    { title: "Evaluation", pageIndex: 11 },
  ]);
  const mismatched = await fixture({ structuralMap: changedStructure });
  const baseline = fingerprint(mismatched);
  const rejected = await loadBrowserSnapshot({ storage, state: mismatched });
  assert.equal(rejected.status, "invalid");
  assert.equal(rejected.reason, "structural_baseline_mismatch");
  assert.deepEqual(fingerprint(mismatched), baseline, "a rejected structural restore must be atomic");
});

test("rejects fully rehashed structural and paper-root anchor changes across current, Undo, and Redo snapshots", async (t) => {
  const paper = (filename, title) => ({ ...PAPER_FIXTURE, filename, title });
  const source = await fixture({
    paper: paper("original.pdf", "Original paper"),
    textAnchor: null,
    structuralMap: structuralMapFixture(),
  });
  const tools = toolsFor(source);
  for (const sequence of [1, 2]) {
    const command = graphCommand(source, sequence);
    command.operations[0].node.sourceAnchorIds = [source.structuralMap.nodes[0].anchorId];
    assert.equal((await tools.get("paperpilot.apply_graph").execute(command)).status, "applied_reversible");
  }
  assert.equal((await undoLastHumanChange(source)).status, "undone");
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  assert.equal(saved.status, "saved");
  const legacyKey = `paperpilot:webmcp:v2:${source.paper.documentSha256}`;
  const original = await legacyEnvelope(storage.values.get(saved.key), source);
  storage.values.delete(saved.key);
  const locations = [
    ["current", (workspace) => workspace.current],
    ["history before", (workspace) => workspace.history[0].before],
    ["history after", (workspace) => workspace.history[0].after],
    ["redo before", (workspace) => workspace.redoHistory[0].before],
    ["redo after", (workspace) => workspace.redoHistory[0].after],
  ];
  const targets = [
    ["structural range", source.structuralMap.nodes[0].anchorId],
    ["paper root", "anchor:page:1"],
  ];
  for (const [location, selectSnapshot] of locations) {
    for (const [targetKind, anchorId] of targets) {
      for (const change of ["wrong page", "different geometry", "different source kind"]) {
        await t.test(`${location}: ${targetKind} ${change}`, async () => {
          const envelope = JSON.parse(original);
          const snapshot = selectSnapshot(envelope.payload.workspace);
          const pair = snapshot.anchors.find(([key]) => key === anchorId);
          assert.ok(pair, "The generated primary anchor must exist in every retained snapshot.");
          pair[1] = await remintStoredStructuralAnchor(pair[1], change);
          envelope.payloadChecksum = await sha256Text(canonicalSnapshotJson(envelope.payload));
          const tampered = JSON.stringify(envelope);
          storage.values.set(legacyKey, tampered);
          const target = await fixture({
            paper: paper("renamed.pdf", "Renamed paper"),
            textAnchor: null,
            structuralMap: structuralMapFixture(),
          });
          const before = fingerprint(target);
          const storageWritesBefore = storage.calls.set;
          const storageRemovalsBefore = storage.calls.remove;
          const loaded = await loadBrowserSnapshot({ storage, state: target });
          assert.equal(loaded.status, "invalid");
          assert.equal(loaded.reason, "structural_baseline_mismatch",
            "Self-consistent canonical hashes must not bypass the fresh PDF baseline.");
          assert.deepEqual(fingerprint(target), before, "Rejection must preserve the complete live baseline.");
          assert.equal(target.savedExplanations, undefined);
          assert.equal(storage.values.get(legacyKey), tampered, "Read-only rejection must retain the stored copy.");
          assert.equal(storage.calls.set, storageWritesBefore);
          assert.equal(storage.calls.remove, storageRemovalsBefore);
        });
      }
    }
  }
});

test("byte-identical PDFs restore after filename changes with trusted title and consistent Undo/Redo digests", async () => {
  const paper = (filename, title) => ({ ...PAPER_FIXTURE, filename, title });
  const source = await fixture({ paper: paper("original.pdf", "Original paper"), textAnchor: null, structuralMap: structuralMapFixture() });
  const tools = toolsFor(source);
  for (const sequence of [1, 2]) {
    const command = graphCommand(source, sequence);
    command.operations[0].node.sourceAnchorIds = [source.structuralMap.nodes[0].anchorId];
    assert.equal((await tools.get("paperpilot.apply_graph").execute(command)).status, "applied_reversible");
  }
  assert.equal((await undoLastHumanChange(source)).status, "undone");
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  assert.equal(saved.status, "saved");
  const storedBytes = storage.values.get(saved.key);
  const originalEvents = structuredClone(source.events);
  const originalReceipts = structuredClone([...source.requestResults]);

  const restored = await fixture({ paper: paper("renamed.pdf", "Renamed paper"), textAnchor: null, structuralMap: structuralMapFixture() });
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored");
  assert.equal(loaded.displayTitleRefreshed, true);
  assert.equal(restored.paper.documentSha256, source.paper.documentSha256);
  assert.equal(restored.paper.filename, "renamed.pdf");
  assert.equal(restored.graph.getNodeAttribute("node:paper", "label"), "Renamed paper");
  assert.ok([...restored.history, ...restored.redoHistory].every((entry) => !Object.hasOwn(entry, "before") && !Object.hasOwn(entry, "after")));
  assert.deepEqual(restored.anchors, source.anchors);
  assert.deepEqual(restored.events, originalEvents, "historic receipts are not rewritten as new observations");
  assert.deepEqual([...restored.requestResults], originalReceipts.map(([key, receipt]) => [key, { commandDigest: receipt.commandDigest, result: null }]),
    "Historical digest-based replay is invalidated while its command keys stay reserved.");
  assert.equal(loaded.replayInvalidated, true);
  assert.equal(loaded.replayInvalidatedCount, 2);
  assert.equal(storage.values.get(saved.key), storedBytes, "read-only recovery must not overwrite the saved copy");
  const restoredDigest = restored.workspaceDigest;
  assert.equal((await undoLastHumanChange(restored)).digestMatches, true);
  assert.equal((await redoLastHumanChange(restored)).digestMatches, true);
  assert.equal(restored.workspaceDigest, restoredDigest);
  assert.equal((await redoLastHumanChange(restored)).digestMatches, true);

  assert.equal((await saveBrowserSnapshot({ storage, state: restored })).status, "saved");
  const reopened = await fixture({ paper: paper("renamed.pdf", "Renamed paper"), textAnchor: null, structuralMap: structuralMapFixture() });
  const reopenedResult = await loadBrowserSnapshot({ storage, state: reopened });
  assert.equal(reopenedResult.status, "restored");
  assert.equal(reopenedResult.displayTitleRefreshed, false);
  assert.equal(reopened.workspaceDigest, restored.workspaceDigest);
});

test("a rechecksummed stored root display title cannot override the current trusted title", async () => {
  const source = await fixture({ structuralMap: structuralMapFixture() });
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  storage.values.set(saved.key, await tamperStoredGraph(storage.values.get(saved.key), (graph) => {
    graph.nodes.find(({ key }) => key === "node:paper").attributes.label = "Untrusted stored display title";
  }));
  const restored = await fixture({ structuralMap: structuralMapFixture() });
  const trustedTitle = restored.graph.getNodeAttribute("node:paper", "label");
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored");
  assert.equal(loaded.displayTitleRefreshed, true);
  assert.equal(restored.graph.getNodeAttribute("node:paper", "label"), trustedTitle);
  assert.equal(restored.graphDigest, source.graphDigest);
  assert.equal(restored.workspaceDigest, source.workspaceDigest);
});

test("migrates validated v2 Undo/Redo to patches without rewriting legacy bytes or fabricating a ledger", async () => {
  const paper = (filename, title) => ({ ...PAPER_FIXTURE, filename, title });
  const options = { paper: paper("original.pdf", "Original paper"), textAnchor: null, structuralMap: structuralMapFixture() };
  const source = await fixture(options);
  for (const sequence of [1, 2, 3]) {
    const command = graphCommand(source, sequence);
    command.operations[0].node.sourceAnchorIds = [source.structuralMap.nodes[0].anchorId];
    assert.equal((await toolsFor(source).get("paperpilot.apply_graph").execute(command)).status, "applied_reversible");
  }
  await undoLastHumanChange(source);
  await undoLastHumanChange(source);
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  assert.equal(saved.status, "saved");
  const legacyRaw = await legacyEnvelope(storage.values.get(saved.key), source);
  const legacyKey = `paperpilot:webmcp:v2:${source.paper.documentSha256}`;
  storage.values.delete(saved.key);
  storage.values.set(legacyKey, legacyRaw);
  const writesBefore = storage.calls.set;
  const restored = await fixture({ ...options, paper: paper("renamed.pdf", "Renamed paper") });
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored", JSON.stringify(loaded));
  assert.equal(loaded.migratedFrom, 2);
  assert.equal(loaded.legacyKey, legacyKey);
  assert.equal(loaded.key, saved.key);
  assert.match(loaded.migrationNotice, /complete historical patch ledger was not available/);
  assert.equal(loaded.displayTitleRefreshed, true);
  assert.equal(restored.graph.getNodeAttribute("node:paper", "label"), "Renamed paper");
  assert.equal(restored.history.length, 1);
  assert.equal(restored.redoHistory.length, 2);
  assert.deepEqual(restored.revisions, [], "Migration does not pretend to have discarded historical ledger entries.");
  assert.deepEqual(restored.events, source.events);
  assert.deepEqual([...restored.requestResults], [...source.requestResults].map(([key, receipt]) => [key, { commandDigest: receipt.commandDigest, result: null }]));
  assert.equal(loaded.replayInvalidatedCount, 3);
  for (const entry of [...restored.history, ...restored.redoHistory]) {
    assert.equal(entry.schemaVersion, 1);
    assert.match(entry.reason, /Migrated retained version-2/);
    assert.equal(Object.hasOwn(entry, "before"), false);
    assert.equal(Object.hasOwn(entry, "after"), false);
    assert.deepEqual(entry.inversePatch, invertWorkspacePatch(entry.forwardPatch));
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.forwardPatch), true);
  }
  assert.equal(storage.values.get(legacyKey), legacyRaw);
  assert.equal(storage.values.has(saved.key), false, "Loading must not secretly write a v3 save.");
  assert.equal(storage.calls.set, writesBefore);
  assert.equal(storage.calls.remove, 0);
  assert.equal((await redoLastHumanChange(restored)).digestMatches, true);
  assert.equal((await undoLastHumanChange(restored)).digestMatches, true);
  assert.equal((await undoLastHumanChange(restored)).digestMatches, true);
  assert.equal((await redoLastHumanChange(restored)).digestMatches, true);
  const resaved = await saveBrowserSnapshot({ storage, state: restored });
  assert.equal(resaved.status, "saved", JSON.stringify(resaved));
  assert.equal(JSON.parse(storage.values.get(resaved.key)).schemaVersion, 3);
  assert.equal(storage.values.get(legacyKey), legacyRaw);
  const reopened = await fixture({ ...options, paper: paper("renamed-again.pdf", "Third trusted title") });
  const reopenedResult = await loadBrowserSnapshot({ storage, state: reopened });
  assert.equal(reopenedResult.status, "restored", JSON.stringify(reopenedResult));
  assert.equal(reopened.revisions.length, 4);
  assert.equal((await redoLastHumanChange(reopened)).digestMatches, true);
});

test("rejects individually valid but incoherent legacy histories before migration", async () => {
  const source = await fixture();
  for (const sequence of [1, 2, 3]) await toolsFor(source).get("paperpilot.apply_graph").execute(graphCommand(source, sequence));
  await undoLastHumanChange(source);
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  const legacy = JSON.parse(await legacyEnvelope(storage.values.get(saved.key), source));
  legacy.payload.workspace.history.reverse();
  const legacyRaw = await rechecksum(legacy);
  const legacyKey = `paperpilot:webmcp:v2:${source.paper.documentSha256}`;
  storage.values.delete(saved.key);
  storage.values.set(legacyKey, legacyRaw);
  const target = await fixture();
  const before = fingerprint(target);
  const result = await loadBrowserSnapshot({ storage, state: target });
  assert.equal(result.status, "invalid");
  assert.equal(result.reason, "history_chain_mismatch");
  assert.deepEqual(fingerprint(target), before);
  assert.equal(storage.values.get(legacyKey), legacyRaw);
  assert.equal(storage.values.has(saved.key), false);
});

test("rejects retained revisions newer than the current head in v2 and migrated v3 without a ledger", async () => {
  const source = await fixture();
  await toolsFor(source).get("paperpilot.apply_graph").execute(graphCommand(source, 1));
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  const v3Raw = storage.values.get(saved.key);
  const v2Raw = await legacyEnvelope(v3Raw, source);
  const v2Key = `paperpilot:webmcp:v2:${source.paper.documentSha256}`;
  for (const [version, raw, key] of [[2, v2Raw, v2Key], [3, v3Raw, saved.key]]) {
    const envelope = JSON.parse(raw);
    envelope.payload.workspace.current.workspaceRevision = 1;
    if (version === 3) envelope.payload.workspace.revisions = [];
    storage.values.clear();
    storage.values.set(key, await rechecksum(envelope));
    const target = await fixture();
    const before = fingerprint(target);
    const loaded = await loadBrowserSnapshot({ storage, state: target });
    assert.equal(loaded.status, "invalid");
    assert.equal(loaded.reason, "history_chain_mismatch");
    assert.deepEqual(fingerprint(target), before);
  }
});

test("restores all four mutation kinds and canonical sources that exist only in Redo history", async () => {
  const source = await fixture();
  const anchor = await mintReaderAnchor(source, {
    sourceKind: "exact_text", pageIndex: 0,
    normalizedBounds: [{ x: 0.2, y: 0.2, width: 0.3, height: 0.04 }],
    pageViewBox: [0, 0, 612, 792], pageRotation: 0, exactText: "A real page-owned reader selection.",
  });
  const created = await applyReaderAnnotation(source, {
    baseWorkspaceRevision: source.workspaceRevision, baseWorkspaceDigest: source.workspaceDigest,
    anchor, annotation: { kind: "question", body: "What does this mean?" },
    node: { kind: "concept", label: "Reader question", summary: "Reader-authored context", salience: 0.5 },
  });
  assert.equal(created.status, "applied_reversible");
  assert.equal((await toolsFor(source).get("paperpilot.apply_graph").execute(graphCommand(source, 1))).status, "applied_reversible");
  assert.equal((await toolsFor(source).get("paperpilot.apply_annotation").execute({
    idempotencyKey: "snapshot-annotation-0001", baseWorkspaceRevision: source.workspaceRevision,
    baseWorkspaceDigest: source.workspaceDigest, baseAnnotationDigest: source.annotationDigest,
    reason: "Save a grounded annotation through the shared reducer.", operations: [{
      op: "create_annotation", anchorId: "anchor:text:attention", expectedAnchorDigest: source.anchors.get("anchor:text:attention").anchorDigest,
      annotationKind: "concept", label: "Agent source link", graphNodeKeys: ["node:concept:attention"], graphEdgeKeys: ["edge:introduction:attention"],
    }],
  })).status, "applied_reversible");
  assert.equal((await removeReaderAnnotation(source, created.annotationId)).status, "applied_reversible");
  assert.deepEqual(source.revisions.map(({ kind }) => kind), ["reader_annotation_graph", "graph", "annotation", "reader_annotation_removal"]);
  for (let index = 0; index < 4; index += 1) assert.equal((await undoLastHumanChange(source)).digestMatches, true);
  assert.equal(source.anchors.has(anchor.anchorId), false);
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  assert.equal(saved.status, "saved", JSON.stringify(saved));
  const restored = await fixture();
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored", JSON.stringify(loaded));
  assert.equal(restored.anchors.has(anchor.anchorId), false);
  assert.equal(restored.history.length, 0);
  assert.equal(restored.redoHistory.length, 4);
  assert.equal((await redoLastHumanChange(restored)).digestMatches, true);
  assert.deepEqual(restored.anchors.get(anchor.anchorId), anchor);
  assert.equal(Object.isFrozen(restored.anchors.get(anchor.anchorId)), true);
  for (let index = 0; index < 3; index += 1) assert.equal((await redoLastHumanChange(restored)).digestMatches, true);
  assert.equal(restored.annotations.get(created.annotationId).status, "tombstoned");
  assert.equal(restored.revisions.length, 12);
});

test("renamed-title replay tombstones reserve command keys across subsequent save and restore", async () => {
  const options = { paper: { ...PAPER_FIXTURE, filename: "original.pdf" }, textAnchor: null, structuralMap: structuralMapFixture() };
  const source = await fixture(options);
  const command = graphCommand(source, 1);
  command.operations[0].node.sourceAnchorIds = [source.structuralMap.nodes[0].anchorId];
  await toolsFor(source).get("paperpilot.apply_graph").execute(command);
  const storage = memoryStorage();
  await saveBrowserSnapshot({ storage, state: source });
  const restored = await fixture({ ...options, paper: { ...PAPER_FIXTURE, filename: "renamed.pdf", title: "Renamed display title" } });
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored", JSON.stringify(loaded));
  assert.equal(loaded.replayInvalidatedCount, 1);
  assert.match(loaded.recoveryNotice, /Existing command keys remain reserved/);
  for (const state of [restored, await fixture({ ...options, paper: restored.paper })]) {
    if (state !== restored) assert.equal((await loadBrowserSnapshot({ storage, state })).status, "restored");
    const baseline = fingerprint(state);
    const retry = await toolsFor(state).get("paperpilot.apply_graph").execute(command);
    assert.equal(retry.status, "rejected");
    assert.equal(retry.code, "idempotency_replay_unavailable");
    assert.deepEqual(fingerprint(state), baseline, "The original command cannot be duplicated after its digest basis changes.");
    const conflict = await toolsFor(state).get("paperpilot.apply_graph").execute({ ...command, reason: "Different intent under a reserved key" });
    assert.equal(conflict.code, "idempotency_conflict");
    assert.deepEqual(fingerprint(state), baseline);
    assert.equal((await saveBrowserSnapshot({ storage, state })).status, "saved");
  }
});

test("v2 receipts for discarded branches become safe reserved-key tombstones without inventing applied history", async () => {
  const source = await fixture();
  const discardedCommand = graphCommand(source, 1);
  await toolsFor(source).get("paperpilot.apply_graph").execute(discardedCommand);
  await undoLastHumanChange(source);
  await toolsFor(source).get("paperpilot.apply_graph").execute(graphCommand(source, 2));
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  const legacyRaw = await legacyEnvelope(storage.values.get(saved.key), source);
  const legacyKey = `paperpilot:webmcp:v2:${source.paper.documentSha256}`;
  storage.values.set(legacyKey, legacyRaw);
  storage.values.delete(saved.key);
  const restored = await fixture();
  const result = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(result.status, "restored", JSON.stringify(result));
  assert.equal(result.replayInvalidatedCount, 1);
  assert.deepEqual(restored.revisions, []);
  assert.equal(restored.requestResults.get(discardedCommand.idempotencyKey).result, null);
  assert.equal([...restored.requestResults.values()].filter(({ result: receipt }) => receipt !== null).length, 1);
  assert.equal((await toolsFor(restored).get("paperpilot.apply_graph").execute(discardedCommand)).code, "idempotency_replay_unavailable");
  assert.equal(storage.values.get(legacyKey), legacyRaw);
  assert.equal((await saveBrowserSnapshot({ storage, state: restored })).status, "saved");
});

test("rejects counterfeit or altered applied receipts despite valid outer checksums", async (t) => {
  const source = await fixture();
  await toolsFor(source).get("paperpilot.apply_graph").execute(graphCommand(source, 1));
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  const raw = storage.values.get(saved.key);
  const mutations = [
    ["fake applied receipt", (receipt) => { receipt.result = { schemaVersion: 1, status: "applied_reversible" }; }],
    ["wrong command digest", (receipt) => { receipt.commandDigest = "f".repeat(64); }],
    ["wrong operation", (receipt) => { receipt.result.operationId = "operation:invented"; }],
    ["missing revision", (receipt) => { receipt.result.revisionId = "revision:invented"; }],
    ["wrong command key", (receipt) => { receipt.result.idempotencyKey = "another-command-key-0001"; }],
    ["wrong endpoint", (receipt) => { receipt.result.afterGraphDigest = "f".repeat(64); }],
    ["wrong version", (receipt) => { receipt.result.toRevision += 1; }],
    ["invented affected entity", (receipt) => { receipt.result.affected.created = ["node:invented"]; }],
    ["wrong mutation category", (receipt) => { receipt.result.affected.tombstoned = receipt.result.affected.created; receipt.result.affected.created = []; }],
    ["extra receipt metadata", (receipt) => { receipt.proven = true; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const envelope = JSON.parse(raw);
    mutate(envelope.payload.requestResults[0][1]);
    const corrupted = await rechecksum(envelope);
    storage.values.set(saved.key, corrupted);
    const target = await fixture();
    const before = fingerprint(target);
    const loaded = await loadBrowserSnapshot({ storage, state: target });
    assert.equal(loaded.status, "invalid");
    assert.equal(loaded.reason, "request_results_invalid", JSON.stringify(loaded));
    assert.deepEqual(fingerprint(target), before);
    assert.equal(storage.values.get(saved.key), corrupted);
  });
});

test("validates complete v3 patch chains and ledger metadata atomically even after outer rechecksumming", async (t) => {
  const source = await fixture({ structuralMap: structuralMapFixture() });
  for (const sequence of [1, 2, 3]) await toolsFor(source).get("paperpilot.apply_graph").execute(graphCommand(source, sequence));
  await undoLastHumanChange(source);
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  assert.equal(saved.status, "saved");
  const raw = storage.values.get(saved.key);
  const oldKey = `paperpilot:webmcp:v2:${source.paper.documentSha256}`;
  const legacyRaw = await legacyEnvelope(raw, source);
  storage.values.set(oldKey, legacyRaw);
  const mutations = [
    ["inverse mismatch", (workspace) => { workspace.history[1].inversePatch[0].before.label = "Different inverse"; }, "history_inverse_mismatch"],
    ["renderer data in canonical patch", (workspace) => { workspace.history[0].forwardPatch[0].after.x = 15; }, "history_patch_invalid"],
    ["false endpoint digest", (workspace) => { workspace.history[1].afterGraphDigest = "f".repeat(64); }, "semantic_digest_mismatch"],
    ["reordered Undo", (workspace) => { workspace.history.reverse(); }, "semantic_digest_mismatch"],
    ["reordered ledger", (workspace) => { workspace.revisions.reverse(); }, "history_chain_mismatch"],
    ["missing middle ledger revision", (workspace) => { workspace.revisions.splice(1, 1); }, "history_chain_mismatch"],
    ["head revision drift", (workspace) => { workspace.current.workspaceRevision += 1; }, "history_chain_mismatch"],
    ["false source attribution", (workspace) => { workspace.history[0].sourceAnchorIds.push("anchor:missing"); }, "history_invalid"],
    ["duplicate stack entry", (workspace) => { workspace.history.push(workspace.history[0]); }, "history_invalid"],
    ["cross-paper revision", (workspace) => { workspace.history[0].paperRef = `paper:sha256:${"e".repeat(64)}`; }, "identity_mismatch"],
    ["wrong reversal target", (workspace) => { workspace.revisions.at(-1).relatedRevisionId = workspace.history[0].revisionId; }, "history_chain_mismatch"],
    ["promoted agent authority", (workspace) => { workspace.history[0].reviewState = "not_applicable"; }, "history_invalid"],
    ["unknown history fields", (workspace) => { workspace.history[0].verified = true; }, "history_invalid"],
    ["immutable structural patch", (workspace) => {
      const node = workspace.current.graph.nodes.find(({ key }) => key === source.structuralMap.nodes[0].key);
      const before = { key: node.key, ...node.attributes };
      for (const key of ["x", "y", "size", "color"]) delete before[key];
      const operation = { op: "put_node", key: node.key, before, after: { ...before, label: "Forged section heading" } };
      const entry = workspace.history[1];
      entry.forwardPatch.push(operation);
      entry.inversePatch = invertWorkspacePatch(entry.forwardPatch);
      entry.affectedKeys.push(node.key);
    }, "structural_baseline_mismatch"],
  ];
  for (const [name, mutate, reason] of mutations) await t.test(name, async () => {
    const envelope = JSON.parse(raw);
    mutate(envelope.payload.workspace);
    const corrupt = await rechecksum(envelope);
    storage.values.set(saved.key, corrupt);
    const target = await fixture({ structuralMap: structuralMapFixture() });
    const before = fingerprint(target);
    const reads = [];
    const adapter = { ...storage, getItem(key) { reads.push(key); return storage.getItem(key); } };
    const loaded = await loadBrowserSnapshot({ storage: adapter, state: target });
    assert.equal(loaded.status, "invalid", JSON.stringify(loaded));
    assert.equal(loaded.reason, reason, JSON.stringify(loaded));
    assert.deepEqual(reads, [saved.key], "Invalid v3 cannot fall back to an apparently valid older save.");
    assert.deepEqual(fingerprint(target), before);
    assert.equal(storage.values.get(saved.key), corrupt);
    assert.equal(storage.values.get(oldKey), legacyRaw);
  });
});

test("display-title normalization never relaxes structural labels, source ranges, root kind, or containment claims", async (t) => {
  const source = await fixture({ structuralMap: structuralMapFixture() });
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  const original = storage.values.get(saved.key);
  const sectionKey = source.structuralMap.nodes[0].key;
  const mutations = [
    ["section label", (graph) => { graph.nodes.find(({ key }) => key === sectionKey).attributes.label = "Invented section"; }],
    ["section source", (graph) => { graph.nodes.find(({ key }) => key === sectionKey).attributes.structuralCoverage[0].primaryAnchorId = "anchor:page:1"; }],
    ["section source override", (graph) => { graph.nodes.find(({ key }) => key === sectionKey).attributes.sourceAnchorIds = [source.structuralMap.nodes[2].anchorId]; }],
    ["root kind", (graph) => { graph.nodes.find(({ key }) => key === "node:paper").attributes.kind = "concept"; }],
    ["root summary", (graph) => { graph.nodes.find(({ key }) => key === "node:paper").attributes.summary = "Invented document summary"; }],
    ["root source override", (graph) => { graph.nodes.find(({ key }) => key === "node:paper").attributes.sourceAnchorIds = [source.structuralMap.nodes[2].anchorId]; }],
    ["containment claim", (graph) => { graph.edges[0].attributes.claim = "Invented containment claim"; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    storage.values.set(saved.key, await tamperStoredGraph(original, mutate));
    const target = await fixture({ structuralMap: structuralMapFixture() });
    const before = fingerprint(target);
    const loaded = await loadBrowserSnapshot({ storage, state: target });
    assert.equal(loaded.status, "invalid");
    assert.equal(loaded.reason, "structural_baseline_mismatch");
    assert.deepEqual(fingerprint(target), before, "rejected normalization must not touch live state");
  });
});

test("validates canonical spatial anchors before saving and restores their deeply frozen canonical records", async () => {
  const source = await fixture();
  const canonicalAnchor = await canonicalTextAnchor(source);
  source.anchors.set(canonicalAnchor.anchorId, canonicalAnchor);
  const storage = memoryStorage();

  const saved = await saveBrowserSnapshot({ storage, state: source });
  assert.equal(saved.status, "saved");
  assert.equal(storage.calls.set, 1);

  const restored = await fixture();
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored");
  const restoredAnchor = restored.anchors.get(CANONICAL_ANCHOR_ID);
  assert.deepEqual(restoredAnchor, canonicalAnchor);
  assert.notEqual(restoredAnchor, canonicalAnchor);
  assert.equal(Object.isFrozen(restoredAnchor), true);
  assert.equal(Object.isFrozen(restoredAnchor.rendererRecipe), true);
  assert.equal(Object.isFrozen(restoredAnchor.rendererRecipe.pageViewBox), true);
  assert.equal(Object.isFrozen(restoredAnchor.normalizedBounds), true);
  assert.equal(Object.isFrozen(restoredAnchor.normalizedBounds[0]), true);
  assert.equal(Object.isFrozen(restoredAnchor.pdfQuads[0]), true);

  const invalidSource = await fixture();
  const invalidAnchor = structuredClone(await canonicalTextAnchor(invalidSource));
  invalidAnchor.normalizedBounds[0].x = 0.9;
  invalidAnchor.anchorDigest = await computeSpatialAnchorDigest(invalidAnchor);
  invalidSource.anchors.set(invalidAnchor.anchorId, invalidAnchor);
  const isolated = memoryStorage();
  const rejected = await saveBrowserSnapshot({ storage: isolated, state: invalidSource });
  assert.equal(rejected.status, "invalid_state");
  assert.equal(rejected.reason, "anchor_invalid");
  assert.equal(isolated.calls.set, 0);
});

test("rejects rechecksummed canonical spatial corruption without mutating live state", async (t) => {
  const source = await fixture();
  const canonicalAnchor = await canonicalTextAnchor(source);
  source.anchors.set(canonicalAnchor.anchorId, canonicalAnchor);
  const sourceStorage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage: sourceStorage, state: source });
  assert.equal(saved.status, "saved");
  const raw = sourceStorage.values.get(saved.key);

  const corruptions = [
    {
      name: "normalized bounds outside the page with a freshly computed anchor hash",
      mutate(anchor) {
        anchor.normalizedBounds[0].x = 0.9;
      },
      reason: "anchor_invalid",
    },
    {
      name: "unsupported page rotation",
      mutate(anchor) {
        anchor.rotation = 45;
      },
      reason: "anchor_invalid",
    },
    {
      name: "quote bytes that disagree with the embedded quote digest",
      mutate(anchor) {
        anchor.quote.exact += " Altered after capture.";
      },
      reason: "anchor_invalid",
    },
    {
      name: "PDF-space geometry that no longer matches normalized geometry",
      mutate(anchor) {
        anchor.pdfQuads[0][0].x += 1;
      },
      reason: "anchor_invalid",
    },
    {
      name: "renderer bytes that no longer match the renderer recipe digest",
      mutate(anchor) {
        anchor.rendererRecipe.rendererVersion = "999.0.0";
      },
      reason: "anchor_invalid",
    },
    {
      name: "canonical anchor digest corruption",
      mutate(anchor) {
        anchor.anchorDigest = "0".repeat(64);
      },
      rehashAnchor: false,
      reason: "anchor_invalid",
    },
    {
      name: "wrong embedded document digest with a freshly computed anchor hash",
      mutate(anchor) {
        anchor.documentSha256 = "d".repeat(64);
      },
      reason: "anchor_invalid",
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, async () => {
      const target = await fixture();
      const baseline = fingerprint(target);
      const storage = memoryStorage();
      const tamperedRaw = await tamperCanonicalEnvelope(raw, corruption.mutate, {
        rehashAnchor: corruption.rehashAnchor,
      });
      const envelope = JSON.parse(tamperedRaw);
      assert.equal(
        envelope.payloadChecksum,
        await sha256Text(canonicalSnapshotJson(envelope.payload)),
        "the outer snapshot checksum must be valid so canonical validation is exercised",
      );
      if (corruption.rehashAnchor !== false) {
        const storedAnchor = currentStoredAnchor(envelope);
        assert.equal(
          storedAnchor.anchorDigest,
          await computeSpatialAnchorDigest(storedAnchor),
          "the generic anchor hash must be valid so semantic validation is exercised",
        );
      }
      storage.values.set(saved.key, tamperedRaw);
      const loaded = await loadBrowserSnapshot({ storage, state: target });
      assert.equal(loaded.status, "invalid");
      assert.equal(loaded.reason, corruption.reason);
      assert.deepEqual(fingerprint(target), baseline, "a rejected restore must be atomic");
    });
  }
});

test("bounds audit and idempotency records but never silently truncates reversible history", async () => {
  const digest = "a".repeat(64);
  const compactPaper = {
    paper: {
      paperRef: `paper:sha256:${digest}`,
      filename: "compact-limit-fixture.pdf",
      documentSha256: digest,
      pageCount: 1,
      title: "Compact limit fixture",
      pageViewBox: [0, 0, 612, 792],
      pageRotation: 0,
    },
    textAnchor: null,
  };
  const state = await fixture(compactPaper);
  state.events = Array.from({ length: BROWSER_SNAPSHOT_LIMITS.events + 7 }, (_, index) => ({
    eventType: "snapshot_limit_fixture",
    actor: "system",
    sequence: index,
  }));
  state.requestResults = new Map(Array.from(
    { length: BROWSER_SNAPSHOT_LIMITS.requestResults + 9 },
    (_, index) => [
      `snapshot-request-${String(index).padStart(4, "0")}`,
      {
        commandDigest: index.toString(16).padStart(64, "0"),
        result: null,
      },
    ],
  ));

  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state });
  assert.equal(saved.status, "saved");
  const restored = await fixture(compactPaper);
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored");
  assert.equal(restored.history.length, 0);
  assert.equal(restored.redoHistory.length, 0);
  assert.equal(restored.events.length, BROWSER_SNAPSHOT_LIMITS.events);
  assert.equal(restored.requestResults.size, BROWSER_SNAPSHOT_LIMITS.requestResults);
  assert.equal(restored.events[0].sequence, 7);
  assert.equal(restored.requestResults.has("snapshot-request-0009"), true);
  assert.equal(restored.requestResults.has("snapshot-request-0008"), false);
  const savedBytes = storage.values.get(saved.key);
  for (const collection of ["history", "redoHistory", "revisions"]) {
    state[collection] = Array.from({ length: BROWSER_SNAPSHOT_LIMITS[collection] + 1 }, () => ({}));
    const rejected = await saveBrowserSnapshot({ storage, state });
    assert.equal(rejected.status, "invalid_state");
    assert.equal(storage.values.get(saved.key), savedBytes, "Over-limit state cannot replace an existing recoverable save.");
    state[collection] = [];
  }
});

test("accepts only bounded current-annotation IDs in caller-supplied presentation order", async () => {
  const state = await fixture();
  const annotationId = [...state.annotations.keys()][0];
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({
    storage,
    state,
    presentation: { annotationOrder: [annotationId] },
  });
  assert.equal(saved.status, "saved");
  const restored = await fixture();
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.deepEqual(loaded.presentation, { annotationOrder: [annotationId] });

  for (const presentation of [
    { annotationOrder: ["annotation:foreign"] },
    { annotationOrder: [annotationId, annotationId] },
    { annotationOrder: Array.from({ length: 801 }, () => annotationId) },
    { annotationOrder: [annotationId], camera: { x: 0, y: 0 } },
  ]) {
    const isolated = memoryStorage();
    const result = await saveBrowserSnapshot({ storage: isolated, state, presentation });
    assert.equal(result.status, "invalid_state");
    assert.equal(isolated.calls.set, 0);
  }
});

test("persists only in-app state and rejects raw PDF, File, Blob, ArrayBuffer, or typed-array fields", async () => {
  const clean = await fixture();
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: clean, now: "2026-08-31T08:00:00.000Z" });
  assert.equal(saved.status, "saved");
  const raw = storage.values.get(saved.key);
  assert.equal(raw.includes('"filename"'), false, "the original File name is outside the persistence payload");
  assert.equal(raw.includes("pdfBytes"), false);
  assert.equal(raw.includes("rawFile"), false);
  assert.equal(raw.includes("objectUrl"), false);

  const cases = [
    ["pdfBytes", new Uint8Array([37, 80, 68, 70])],
    ["rawFile", new ArrayBuffer(4)],
    ["pdfData", typeof Blob === "undefined" ? new Uint8Array([1]) : new Blob(["%PDF"])],
  ];
  for (const [key, binary] of cases) {
    const state = await fixture();
    state.anchors.get("anchor:text:attention")[key] = binary;
    const isolated = memoryStorage();
    const result = await saveBrowserSnapshot({ storage: isolated, state });
    assert.equal(result.status, "invalid_state");
    assert.match(result.reason, /raw_pdf_state_rejected|binary_or_non_json_state/);
    assert.equal(isolated.calls.set, 0);
    assert.equal(isolated.values.size, 0);
  }
});

test("fails closed on invalid JSON and checksum corruption without changing the live workspace", async () => {
  const source = await fixture();
  await toolsFor(source).get("paperpilot.apply_graph").execute(graphCommand(source, 1));
  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state: source });
  assert.equal(saved.status, "saved");

  const target = await fixture();
  const baseline = fingerprint(target);
  storage.values.set(saved.key, "{definitely not json");
  const invalidJson = await loadBrowserSnapshot({ storage, state: target });
  assert.deepEqual(invalidJson.status, "invalid");
  assert.equal(invalidJson.reason, "invalid_json");
  assert.deepEqual(fingerprint(target), baseline);

  const secondSave = await saveBrowserSnapshot({ storage, state: source });
  const envelope = JSON.parse(storage.values.get(secondSave.key));
  envelope.payload.workspace.current.workspaceRevision += 1;
  storage.values.set(secondSave.key, JSON.stringify(envelope));
  const corrupt = await loadBrowserSnapshot({ storage, state: target });
  assert.equal(corrupt.status, "invalid");
  assert.equal(corrupt.reason, "checksum_mismatch");
  assert.deepEqual(fingerprint(target), baseline);
});

test("will not restore a valid snapshot under a different PDF identity", async () => {
  const source = await fixture();
  await toolsFor(source).get("paperpilot.apply_graph").execute(graphCommand(source, 1));
  const sourceStorage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage: sourceStorage, state: source });
  assert.equal(saved.status, "saved");
  const raw = sourceStorage.values.get(saved.key);

  const otherDigest = "d".repeat(64);
  const other = await fixture({
    paper: {
      paperRef: `paper:sha256:${otherDigest}`,
      filename: "other-paper.pdf",
      documentSha256: otherDigest,
      pageCount: 3,
      title: "Another paper",
      pageViewBox: [0, 0, 612, 792],
      pageRotation: 0,
    },
    textAnchor: null,
  });
  const baseline = fingerprint(other);
  const storage = memoryStorage();
  storage.values.set(browserSnapshotKey(otherDigest), raw);
  const loaded = await loadBrowserSnapshot({ storage, state: other });
  assert.equal(loaded.status, "invalid");
  assert.equal(loaded.reason, "identity_mismatch");
  assert.deepEqual(fingerprint(other), baseline);
});

test("enforces the 4 MiB UTF-8 ceiling before touching storage", async () => {
  const state = await fixture();
  const storage = memoryStorage();
  const result = await saveBrowserSnapshot({
    storage,
    state,
    savedExplanations: [{
      explanationId: "explanation:oversized",
      responseDigest: "e".repeat(64),
      body: "界".repeat(MAX_BROWSER_SNAPSHOT_BYTES),
    }],
  });
  assert.equal(result.status, "too_large");
  assert.ok(result.bytes > MAX_BROWSER_SNAPSHOT_BYTES);
  assert.equal(result.maxBytes, MAX_BROWSER_SNAPSHOT_BYTES);
  assert.equal(storage.calls.set, 0);
  assert.equal(storage.values.size, 0);
});

test("reports quota failure while leaving the live state exactly untouched", async () => {
  const state = await fixture();
  await toolsFor(state).get("paperpilot.apply_graph").execute(graphCommand(state, 1));
  const baseline = fingerprint(state);
  const quotaError = new Error("Browser quota exhausted");
  quotaError.name = "QuotaExceededError";
  const storage = memoryStorage({ setError: quotaError });
  const result = await saveBrowserSnapshot({ storage, state });
  assert.equal(result.status, "storage_error");
  assert.equal(result.reason, "quota_exceeded");
  assert.equal(result.errorName, "QuotaExceededError");
  assert.equal(storage.calls.set, 1);
  assert.deepEqual(fingerprint(state), baseline);
});

test("clears only the exact document snapshot and reports storage failures", async () => {
  const digest = PAPER_FIXTURE.documentSha256;
  const key = browserSnapshotKey(digest);
  const storage = memoryStorage();
  storage.values.set(key, "snapshot");
  storage.values.set(browserSnapshotKey("f".repeat(64)), "other");
  assert.deepEqual(clearBrowserSnapshot({ storage, documentSha256: digest }), { status: "cleared", key, removedVersions: [3], remainingVersions: [] });
  assert.equal(storage.values.has(key), false);
  assert.equal(storage.values.size, 1);
  assert.deepEqual(clearBrowserSnapshot({ storage, documentSha256: digest }), { status: "not_found", key, removedVersions: [], remainingVersions: [] });

  const removeError = new Error("Storage blocked");
  removeError.name = "SecurityError";
  const blocked = memoryStorage({ removeError });
  blocked.values.set(key, "snapshot");
  assert.deepEqual(clearBrowserSnapshot({ storage: blocked, documentSha256: digest }), {
    status: "storage_error",
    reason: "storage_unavailable",
    errorName: "SecurityError",
    key,
    phase: "remove",
    removedVersions: [],
    remainingVersions: [3],
  });
});
