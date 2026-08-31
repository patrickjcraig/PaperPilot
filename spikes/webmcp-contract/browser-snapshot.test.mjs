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
  createSpikeState,
  createToolSuite,
  redoLastHumanChange,
  undoLastHumanChange,
} from "./contracts.mjs";
import {
  computeSpatialAnchorDigest,
  createSpatialAnchor,
  createSpatialRendererRecipe,
} from "./spatial-anchor.mjs";

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

function deterministicOptions(overrides = {}) {
  let sequence = 0;
  return {
    now: () => "2026-08-31T08:00:00.000Z",
    id: (prefix) => `${prefix}:${String(++sequence).padStart(8, "0")}`,
    ...overrides,
  };
}

async function fixture(overrides = {}) {
  return createSpikeState(MultiDirectedGraph, deterministicOptions(overrides));
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

test("versions and keys each browser snapshot by the lowercase PDF SHA-256 identity", () => {
  assert.equal(BROWSER_SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(MAX_BROWSER_SNAPSHOT_BYTES, 4 * 1024 * 1024);
  assert.equal(BROWSER_SNAPSHOT_KEY_PREFIX, "paperpilot:webmcp:v1:");
  assert.deepEqual(BROWSER_SNAPSHOT_LIMITS, {
    history: 200,
    redoHistory: 200,
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

test("retains only the newest bounded recovery, audit, and idempotency records", async () => {
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
  const semantic = semanticSnapshotForHistory(state);
  const seedHistory = {
    kind: "graph",
    revisionId: "revision:seed",
    before: semantic,
    after: semanticSnapshotForHistory(state),
  };
  state.history = Array.from({ length: BROWSER_SNAPSHOT_LIMITS.history + 5 }, (_, index) => ({
    ...seedHistory,
    revisionId: `revision:history:${String(index).padStart(4, "0")}`,
  }));
  state.redoHistory = Array.from({ length: BROWSER_SNAPSHOT_LIMITS.redoHistory + 3 }, (_, index) => ({
    ...seedHistory,
    revisionId: `revision:redo:${String(index).padStart(4, "0")}`,
  }));
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
        result: { schemaVersion: 1, status: "applied_reversible", sequence: index },
      },
    ],
  ));

  const storage = memoryStorage();
  const saved = await saveBrowserSnapshot({ storage, state });
  assert.equal(saved.status, "saved");
  const restored = await fixture(compactPaper);
  const loaded = await loadBrowserSnapshot({ storage, state: restored });
  assert.equal(loaded.status, "restored");
  assert.equal(restored.history.length, BROWSER_SNAPSHOT_LIMITS.history);
  assert.equal(restored.redoHistory.length, BROWSER_SNAPSHOT_LIMITS.redoHistory);
  assert.equal(restored.events.length, BROWSER_SNAPSHOT_LIMITS.events);
  assert.equal(restored.requestResults.size, BROWSER_SNAPSHOT_LIMITS.requestResults);
  assert.equal(restored.history[0].revisionId, "revision:history:0005");
  assert.equal(restored.redoHistory[0].revisionId, "revision:redo:0003");
  assert.equal(restored.events[0].sequence, 7);
  assert.equal(restored.requestResults.has("snapshot-request-0009"), true);
  assert.equal(restored.requestResults.has("snapshot-request-0008"), false);
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
  assert.deepEqual(clearBrowserSnapshot({ storage, documentSha256: digest }), { status: "cleared", key });
  assert.equal(storage.values.has(key), false);
  assert.equal(storage.values.size, 1);
  assert.deepEqual(clearBrowserSnapshot({ storage, documentSha256: digest }), { status: "not_found", key });

  const removeError = new Error("Storage blocked");
  removeError.name = "SecurityError";
  const blocked = memoryStorage({ removeError });
  blocked.values.set(key, "snapshot");
  assert.deepEqual(clearBrowserSnapshot({ storage: blocked, documentSha256: digest }), {
    status: "storage_error",
    reason: "storage_unavailable",
    errorName: "SecurityError",
    key,
  });
});
