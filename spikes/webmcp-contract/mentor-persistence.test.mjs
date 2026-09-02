import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MultiDirectedGraph } from "graphology";

import { browserSnapshotKey, loadBrowserSnapshot, saveBrowserSnapshot } from "./browser-snapshot.mjs";
import { applyReaderAnnotation, createSpikeState, createToolSuite, mintReaderAnchor, redoLastHumanChange, undoLastHumanChange } from "./contracts.mjs";
import { MENTOR_SECTION_KEYS, mentorPayloadFromRecord, normalizeMentorRecord } from "./mentor-contract.mjs";
import { applyHumanMentorDecision, createMentorReviewViewModel } from "./mentor-review.mjs";
import { createWholePaperStructuralMap } from "./structural-map.mjs";

const NOW = "2026-09-02T12:00:00.000Z";
let sequence = 0;
async function fixture(options = {}) {
  return createSpikeState(MultiDirectedGraph, { now: () => NOW, id: (prefix) => `${prefix}:mentor-test:${++sequence}`, ...options });
}
function storageFixture() {
  const values = new Map();
  let writes = 0;
  return {
    values, get writes() { return writes; },
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { writes += 1; values.set(key, value); },
    removeItem: (key) => values.delete(key),
  };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function claim(text, authority = "mentor_interpretation", anchorIds = [], graphEntityKeys = [], citationIds = []) {
  return { text, authority, anchorIds, graphEntityKeys, citationIds };
}
function payloadFor(state, { anchorId = "anchor:text:attention", graphKey = "node:concept:attention", visual = false } = {}) {
  const graphKeys = graphKey ? [graphKey] : [];
  return {
    explanationVersion: 2,
    focusAnchorId: anchorId,
    expectedWorkspaceRevision: state.workspaceRevision,
    expectedGraphDigest: state.graphDigest,
    sourceAnchorIds: [anchorId], graphEntityKeys: graphKeys,
    visualEvidenceMode: visual ? "locator_only" : "not_applicable",
    ...(visual ? { visualObservation: "The selected page region locates the figure. Its pixels have not been verified; this is a mentor interpretation." } : {}),
    sections: {
      quickTake: [claim("Attention chooses which representations contribute to a result.", "mentor_interpretation", [anchorId])],
      paperFit: [claim("This map item connects the selected passage to the architecture.", "mentor_interpretation", [anchorId], graphKeys)],
      prerequisites: [claim("A vector is an ordered list of numbers.", "mentor_background")],
      howItWorks: [claim("First compare the query and keys. Then use the scores to weight values; x < y is a mathematical comparison.", "mentor_interpretation", [anchorId])],
      paperEvidence: [claim(visual ? "This is an interpretation of a located region, not a pixel observation." : "The selected passage describes an architecture based on attention mechanisms.", visual ? "mentor_interpretation" : "document_evidence", [anchorId])],
      relatedIdeas: [claim("The original paper is also available from its external publisher record.", "external_source", [], [], ["citation:attention"])],
      limitations: [claim("This explanation is not scientific verification.", "uncertain")],
    },
    sourceCoverage: [{ anchorId, status: "used", explanation: "The selected source is linked to the explanation's claims." }],
    graphCoverage: graphKeys.map((entityKey) => ({ entityKey, role: "related" })),
    externalCitations: [{ citationId: "citation:attention", url: "https://arxiv.org/abs/1706.03762", title: "Attention Is All You Need", authors: ["Ashish Vaswani and colleagues"], year: 2017, declaredBy: "agent", verification: "not_verified_by_paperpilot" }],
  };
}
function savedRecord(payload, suffix = "one") {
  return { explanationId: `explanation:mentor:${suffix}`, responseDigest: digest(payload), ...structuredClone(payload), savedAt: NOW, humanDecision: "saved", takeaway: "I will revisit the selected evidence." };
}
function legacyRecord() {
  return {
    explanationId: "explanation:legacy:one", responseDigest: "a".repeat(64),
    focusAnchorId: "anchor:text:attention", sourceAnchorIds: ["anchor:text:attention"], graphEntityKeys: ["node:concept:attention"],
    sections: Object.fromEntries(MENTOR_SECTION_KEYS.map((key) => [key, `Original ${key} text — 𝛼 < 𝛽; do not alter or infer authority.`])),
    savedAt: NOW, humanDecision: "saved", takeaway: "My original note.",
  };
}
function fingerprint(state) {
  return structuredClone({
    anchors: [...state.anchors], annotations: [...state.annotations], graph: state.graph.export(),
    history: state.history, redoHistory: state.redoHistory, revisions: state.revisions,
    requestResults: [...state.requestResults], events: state.events, explanations: state.explanations,
    savedExplanations: state.savedExplanations, latestReadFocusReceipt: state.latestReadFocusReceipt,
    latestReadGraphReceipt: state.latestReadGraphReceipt, workspaceRevision: state.workspaceRevision,
    workspaceDigest: state.workspaceDigest, graphDigest: state.graphDigest, annotationDigest: state.annotationDigest,
  });
}
function rechecksum(envelope) {
  envelope.payloadChecksum = digest(envelope.payload);
  return JSON.stringify(envelope);
}

function reviewFor(state) {
  return createMentorReviewViewModel({
    savedExplanations: state.savedExplanations,
    currentAnchors: state.anchors,
    currentGraphNodes: new Map(state.graph.nodes().map((key) => [key, state.graph.getNodeAttributes(key)])),
    currentGraphEdges: new Map(state.graph.edges().map((key) => [key, state.graph.getEdgeAttributes(key)])),
    currentPaperRef: state.paper.paperRef, currentDocumentSha256: state.paper.documentSha256,
    currentGraphDigest: state.graphDigest,
  });
}

test("real read/read/stage callbacks remain session-only until a human saves the exact v2 response", async () => {
  const state = await fixture();
  const tools = new Map(createToolSuite(state).map((tool) => [tool.name, tool]));
  const beforeRevision = state.workspaceRevision;
  const beforeDigest = state.workspaceDigest;
  assert.equal((await tools.get("paperpilot.read_focus").execute({})).status, "ready");
  assert.equal((await tools.get("paperpilot.read_graph").execute({ mode: "overview" })).status, "ready");
  const payload = payloadFor(state);
  const result = await tools.get("paperpilot.stage_explain").execute(payload);
  assert.equal(result.status, "staged", JSON.stringify(result));
  assert.equal(result.responseDigest, digest(payload));
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state })).status, "saved");
  const unsavedReload = await fixture();
  assert.equal((await loadBrowserSnapshot({ storage, state: unsavedReload })).status, "restored");
  assert.deepEqual(unsavedReload.savedExplanations, []);
  assert.deepEqual(unsavedReload.explanations, []);
  const decision = applyHumanMentorDecision({ actor: "human", decision: "save", stagedExplanations: state.explanations, savedExplanations: [], savedAt: NOW, takeaway: "This is my own takeaway." });
  assert.equal(decision.status, "saved");
  state.savedExplanations = decision.savedExplanations;
  state.explanations = decision.stagedExplanations;
  assert.equal((await saveBrowserSnapshot({ storage, state })).status, "saved");
  const reloaded = await fixture();
  assert.equal((await loadBrowserSnapshot({ storage, state: reloaded })).status, "restored");
  assert.deepEqual(mentorPayloadFromRecord(reloaded.savedExplanations[0]), payload);
  assert.equal(reloaded.savedExplanations[0].responseDigest, result.responseDigest);
  assert.equal(reloaded.workspaceRevision, beforeRevision);
  assert.equal(reloaded.workspaceDigest, beforeDigest);
  assert.equal(reloaded.history.length, 0);
  assert.equal(reloaded.revisions.length, 0);
});

test("new claim notes and original legacy prose round-trip without normalization, lost citations, or shared references", async () => {
  const state = await fixture();
  const saved = [legacyRecord(), savedRecord(payloadFor(state))];
  const original = structuredClone(saved);
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state, savedExplanations: saved, now: NOW })).status, "saved");
  saved[1].sections.quickTake[0].text = "Caller mutation after save";
  const target = await fixture();
  target.explanations = [{ transient: true }];
  target.latestReadFocusReceipt = { transient: true };
  target.latestReadGraphReceipt = { transient: true };
  const loaded = await loadBrowserSnapshot({ storage, state: target });
  assert.equal(loaded.status, "restored", JSON.stringify(loaded));
  assert.deepEqual(loaded.savedExplanations, original);
  assert.deepEqual(target.savedExplanations, original);
  assert.deepEqual(target.explanations, []);
  assert.equal(target.latestReadFocusReceipt, null);
  assert.equal(target.latestReadGraphReceipt, null);
  assert.equal(normalizeMentorRecord(target.savedExplanations[0]).provenanceMode, "legacy_unclassified");
  assert.ok(Object.values(normalizeMentorRecord(target.savedExplanations[0]).sections).every((blocks) => blocks[0].authority === "legacy_unclassified" && blocks[0].anchorIds.length === 0));
  loaded.savedExplanations[1].sections.quickTake[0].text = "Result mutation";
  assert.deepEqual(target.savedExplanations, original, "returned notes must not alias hydrated notes");
  assert.equal((await saveBrowserSnapshot({ storage, state: target, now: NOW })).status, "saved");
  assert.deepEqual(JSON.parse(storage.values.get(browserSnapshotKey(state.paper.documentSha256))).payload.savedExplanations, original);
});

test("saved v2 response digest covers exact staged claims but not trusted ID or human metadata", async () => {
  const state = await fixture();
  const record = savedRecord(payloadFor(state));
  record.explanationId = "explanation:reader:renamed";
  record.savedAt = "2026-09-02T12:30:00.000Z";
  record.takeaway = "A revised human takeaway, separate from AI claims.";
  assert.equal(record.responseDigest, digest(mentorPayloadFromRecord(record)));
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state, savedExplanations: [record] })).status, "saved");
  const target = await fixture();
  assert.equal((await loadBrowserSnapshot({ storage, state: target })).status, "restored");
  assert.deepEqual(target.savedExplanations, [record]);
});

test("rehashing only the snapshot cannot hide modified claims, citations, or response digests", async (t) => {
  const variants = {
    claim: (record) => { record.sections.quickTake[0].text += " Changed."; },
    citation: (record) => { record.externalCitations[0].title = "Changed citation title"; },
    digest: (record) => { record.responseDigest = "f".repeat(64); },
    graphBasis: (record) => { record.expectedGraphDigest = "f".repeat(64); },
  };
  for (const [name, tamper] of Object.entries(variants)) await t.test(name, async () => {
    const source = await fixture();
    const storage = storageFixture();
    const key = browserSnapshotKey(source.paper.documentSha256);
    assert.equal((await saveBrowserSnapshot({ storage, state: source, savedExplanations: [savedRecord(payloadFor(source))] })).status, "saved");
    const envelope = JSON.parse(storage.values.get(key));
    tamper(envelope.payload.savedExplanations[0]);
    const tampered = rechecksum(envelope);
    storage.values.set(key, tampered);
    const target = await fixture();
    const before = fingerprint(target);
    const loaded = await loadBrowserSnapshot({ storage, state: target });
    assert.equal(loaded.status, "invalid");
    assert.equal(loaded.reason, "saved_explanation_digest_mismatch");
    assert.deepEqual(fingerprint(target), before);
    assert.equal(storage.values.get(key), tampered);
    assert.equal(storage.writes, 1);
  });
});

test("closed saved claim contracts reject authority/citation/schema tampering even after both hashes are recomputed", async (t) => {
  const variants = {
    unknownOuter: (record) => { record.scientificallyVerified = true; },
    unknownClaim: (record) => { record.sections.quickTake[0].verified = true; },
    unknownCoverage: (record) => { record.sourceCoverage[0].verified = true; },
    unknownCitation: (record) => { record.externalCitations[0].body = "Unbounded external material"; },
    citationScheme: (record) => { record.externalCitations[0].url = "javascript:alert(1)"; },
    privateCitation: (record) => { record.externalCitations[0].url = "https://127.0.0.1/private"; },
    verifiedCitation: (record) => { record.externalCitations[0].verification = "verified"; },
    missingCitation: (record) => { record.sections.relatedIdeas[0].citationIds = ["citation:unknown"]; },
    backgroundBorrowing: (record) => { record.sections.prerequisites[0].anchorIds = [record.focusAnchorId]; },
    renderedText: (record) => { record.sections.paperEvidence[0].authority = "rendered_document_view"; },
    rawHtml: (record) => { record.sections.quickTake[0].text = "<script>exportAllPapers()</script>"; },
    absentSection: (record) => { delete record.sections.limitations; },
    futureRevision: (record) => { record.expectedWorkspaceRevision += 1; },
    versionDowngrade: (record) => { delete record.explanationVersion; },
    unsupportedVersion: (record) => { record.explanationVersion = 3; },
    duplicateCoverage: (record) => { record.sourceCoverage.push(structuredClone(record.sourceCoverage[0])); },
    countOverflow: (record) => { record.sections.limitations = Array.from({ length: 6 }, () => claim("Uncertainty", "uncertain")); },
    textOverflow: (record) => { record.sections.quickTake[0].text = "a".repeat(801); },
    graphReference: (record) => { record.sections.quickTake[0].graphEntityKeys = ["node:undeclared"]; },
    agentSaved: (record) => { record.humanDecision = "agent_saved"; },
  };
  for (const [name, tamper] of Object.entries(variants)) await t.test(name, async () => {
    const source = await fixture();
    const storage = storageFixture();
    const key = browserSnapshotKey(source.paper.documentSha256);
    const valid = savedRecord(payloadFor(source));
    assert.equal((await saveBrowserSnapshot({ storage, state: source, savedExplanations: [valid] })).status, "saved");
    const oldBytes = storage.values.get(key);
    const invalid = structuredClone(valid);
    tamper(invalid);
    invalid.responseDigest = digest(mentorPayloadFromRecord(invalid));
    const before = fingerprint(source);
    const saved = await saveBrowserSnapshot({ storage, state: source, savedExplanations: [invalid] });
    assert.equal(saved.status, "invalid_state", JSON.stringify(saved));
    assert.equal(storage.values.get(key), oldBytes, "invalid note must not overwrite the good save");
    assert.equal(storage.writes, 1);
    assert.deepEqual(fingerprint(source), before);
    const envelope = JSON.parse(oldBytes);
    envelope.payload.savedExplanations = [invalid];
    const tamperedBytes = rechecksum(envelope);
    storage.values.set(key, tamperedBytes);
    const target = await fixture();
    const targetBefore = fingerprint(target);
    assert.equal((await loadBrowserSnapshot({ storage, state: target })).status, "invalid");
    assert.deepEqual(fingerprint(target), targetBefore);
    assert.equal(storage.values.get(key), tamperedBytes);
  });
});

test("saved notes preserve stale graph context and tombstoned IDs without promoting them into current evidence", async () => {
  const state = await fixture();
  const record = savedRecord(payloadFor(state));
  const tool = createToolSuite(state).find(({ name }) => name === "paperpilot.apply_graph");
  const result = await tool.execute({
    idempotencyKey: "mentor-persist-tombstone", baseWorkspaceRevision: state.workspaceRevision,
    baseWorkspaceDigest: state.workspaceDigest, baseGraphDigest: state.graphDigest,
    reason: "Remove a graph item after a human saved its explanation.",
    operations: [{ op: "tombstone_node", nodeKey: "node:concept:attention", expectedEntityRevision: state.graph.getNodeAttribute("node:concept:attention", "entityRevision") }],
  });
  assert.equal(result.status, "applied_reversible", JSON.stringify(result));
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state, savedExplanations: [record] })).status, "saved");
  const target = await fixture();
  assert.equal((await loadBrowserSnapshot({ storage, state: target })).status, "restored");
  assert.deepEqual(target.savedExplanations, [record]);
  assert.notEqual(record.expectedGraphDigest, target.graphDigest);
  assert.ok(record.expectedWorkspaceRevision < target.workspaceRevision);
  assert.equal(target.graph.getNodeAttribute("node:concept:attention", "status"), "tombstoned");
  const review = reviewFor(target);
  assert.ok(review.notices.some((notice) => /map has changed/iu.test(notice)));
  assert.equal(review.graphLinks[0].available, false);
  assert.match(review.graphLinks[0].detail, /removed.*audit/iu);
  assert.equal(target.requestResults.size, 1, "saved mentor state must retain mutation replay keys");
  assert.equal((await undoLastHumanChange(target)).digestMatches, true);
  assert.deepEqual(target.savedExplanations, [record]);
});

test("Undo-removed source and graph IDs remain exact audit references; Redo restores only the original anchors", async () => {
  const state = await fixture();
  const anchor = await mintReaderAnchor(state, {
    sourceKind: "exact_text", pageIndex: 0, normalizedBounds: [{ x: 0.2, y: 0.2, width: 0.3, height: 0.04 }],
    pageViewBox: [0, 0, 612, 792], pageRotation: 0, exactText: "An independent reader-selected passage.",
  });
  const created = await applyReaderAnnotation(state, {
    baseWorkspaceRevision: state.workspaceRevision, baseWorkspaceDigest: state.workspaceDigest, anchor,
    annotation: { kind: "question", body: "What does this mean?" },
    node: { kind: "concept", label: "Reader question", summary: "Reader context", salience: 0.5 },
  });
  assert.equal(created.status, "applied_reversible", JSON.stringify(created));
  const record = savedRecord(payloadFor(state, { anchorId: anchor.anchorId, graphKey: created.nodeKey }));
  assert.equal((await undoLastHumanChange(state)).digestMatches, true);
  assert.equal(state.anchors.has(anchor.anchorId), false);
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state, savedExplanations: [record] })).status, "saved");
  const target = await fixture();
  assert.equal((await loadBrowserSnapshot({ storage, state: target })).status, "restored");
  assert.deepEqual(target.savedExplanations, [record]);
  assert.equal(target.anchors.has(anchor.anchorId), false, "restore must not substitute or resurrect missing evidence");
  assert.equal(target.graph.hasNode(created.nodeKey), false);
  const review = reviewFor(target);
  assert.equal(review.sourceLinks[0].key, anchor.anchorId);
  assert.equal(review.sourceLinks[0].available, false);
  assert.equal(review.sourceLinks[0].label, "Source incomplete");
  assert.equal(review.graphLinks[0].available, false);
  assert.deepEqual(review.sourceAnchorIds, []);
  assert.ok(review.notices.some((notice) => /Source incomplete/u.test(notice)));
  assert.equal(target.redoHistory.length, 1);
  assert.equal((await redoLastHumanChange(target)).digestMatches, true);
  assert.deepEqual(target.anchors.get(anchor.anchorId), anchor);
  assert.deepEqual(target.savedExplanations, [record]);
});

test("missing references without retained history remain incomplete audit data rather than inferred foreign evidence", async () => {
  const state = await fixture();
  const record = savedRecord(payloadFor(state, { anchorId: "anchor:no-longer-available", graphKey: "node:no-longer-available" }));
  const legacy = legacyRecord();
  legacy.focusAnchorId = "anchor:legacy-unavailable";
  legacy.sourceAnchorIds = [legacy.focusAnchorId];
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state, savedExplanations: [record, legacy] })).status, "saved");
  const target = await fixture();
  assert.equal((await loadBrowserSnapshot({ storage, state: target })).status, "restored");
  assert.deepEqual(target.savedExplanations, [record, legacy]);
  assert.equal(target.anchors.has(record.focusAnchorId), false);
  assert.equal(target.graph.hasNode(record.graphEntityKeys[0]), false);
  assert.equal(target.history.length, 0);
  assert.equal(target.revisions.length, 0);
});

test("a visual locator note reloads unchanged, but pixel-proof promotion fails even with missing sources", async (t) => {
  const state = await fixture();
  const record = savedRecord(payloadFor(state, { anchorId: "anchor:visual:a", graphKey: null, visual: true }));
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state, savedExplanations: [record] })).status, "saved");
  const target = await fixture();
  assert.equal((await loadBrowserSnapshot({ storage, state: target })).status, "restored");
  assert.deepEqual(target.savedExplanations, [record]);
  for (const missing of [false, true]) for (const promoteMode of [false, true]) await t.test(`missing=${missing}, mode=${promoteMode}`, async () => {
    const invalid = structuredClone(record);
    if (missing) {
      invalid.focusAnchorId = "anchor:missing-visual";
      invalid.sourceAnchorIds = [invalid.focusAnchorId];
      invalid.sourceCoverage[0].anchorId = invalid.focusAnchorId;
      for (const blocks of Object.values(invalid.sections)) for (const block of blocks) if (block.anchorIds.length) block.anchorIds = [invalid.focusAnchorId];
    }
    if (promoteMode) invalid.visualEvidenceMode = "client_visible_region";
    else invalid.sections.paperEvidence[0].authority = "rendered_document_view";
    invalid.responseDigest = digest(mentorPayloadFromRecord(invalid));
    const writes = storage.writes;
    assert.equal((await saveBrowserSnapshot({ storage, state, savedExplanations: [invalid] })).status, "invalid_state");
    assert.equal(storage.writes, writes);
  });
});

test("legacy version-2 browser migration preserves original mentor bytes and does not overwrite its key", async () => {
  const state = await fixture();
  const notes = [legacyRecord()];
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state, savedExplanations: notes, now: NOW })).status, "saved");
  const v3Key = browserSnapshotKey(state.paper.documentSha256);
  const envelope = JSON.parse(storage.values.get(v3Key));
  envelope.schemaVersion = 2;
  envelope.payload.schemaVersion = 2;
  delete envelope.payload.workspace.revisions;
  const legacyBytes = rechecksum(envelope);
  const v2Key = `paperpilot:webmcp:v2:${state.paper.documentSha256}`;
  storage.values.delete(v3Key);
  storage.values.set(v2Key, legacyBytes);
  const target = await fixture();
  const loaded = await loadBrowserSnapshot({ storage, state: target });
  assert.equal(loaded.status, "restored");
  assert.equal(loaded.migratedFrom, 2);
  assert.deepEqual(target.savedExplanations, notes);
  assert.equal(storage.values.get(v2Key), legacyBytes);
  assert.equal(storage.values.has(v3Key), false);
  assert.equal((await saveBrowserSnapshot({ storage, state: target })).status, "saved");
  assert.equal(storage.values.get(v2Key), legacyBytes);
  assert.deepEqual(JSON.parse(storage.values.get(v3Key)).payload.savedExplanations, notes);
});

test("trusted filename/title refresh retains the original explanation digest and marks its graph basis historical", async () => {
  const initial = await fixture();
  const structuralMap = createWholePaperStructuralMap({
    documentSha256: initial.paper.documentSha256,
    pages: Array.from({ length: initial.paper.pageCount }, (_, pageIndex) => ({
      pageIndex, pageLabel: String(pageIndex + 1), pageViewBox: [0, 0, 612, 792], pageRotation: 0, textCapability: "exact_candidate",
    })), outlineEntries: [{ title: "Introduction", pageIndex: 0 }],
  });
  const source = await fixture({ structuralMap, paper: { ...initial.paper, filename: "Original local copy.pdf", title: "Original trusted upload" } });
  const record = savedRecord(payloadFor(source, { anchorId: "anchor:page:1", graphKey: "node:paper", visual: true }));
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state: source, savedExplanations: [record] })).status, "saved");
  const target = await fixture({ structuralMap, paper: { ...source.paper, filename: "Renamed local copy.pdf", title: "Renamed trusted upload" } });
  const result = await loadBrowserSnapshot({ storage, state: target });
  assert.equal(result.status, "restored", JSON.stringify(result));
  assert.equal(result.displayTitleRefreshed, true);
  assert.deepEqual(target.savedExplanations, [record]);
  assert.notEqual(target.graphDigest, record.expectedGraphDigest);
  assert.ok(reviewFor(target).notices.some((notice) => /map has changed/iu.test(notice)));
  assert.equal((await saveBrowserSnapshot({ storage, state: target })).status, "saved");
  assert.equal(JSON.parse(storage.values.get(browserSnapshotKey(target.paper.documentSha256))).payload.savedExplanations[0].responseDigest, record.responseDigest);
});

test("new notes never enable resolvable foreign source records to enter a same-paper snapshot", async () => {
  const source = await fixture();
  const storage = storageFixture();
  assert.equal((await saveBrowserSnapshot({ storage, state: source, savedExplanations: [savedRecord(payloadFor(source))] })).status, "saved");
  const key = browserSnapshotKey(source.paper.documentSha256);
  const envelope = JSON.parse(storage.values.get(key));
  const anchor = envelope.payload.workspace.current.anchors.find(([id]) => id === "anchor:text:attention")[1];
  anchor.paperRef = "paper:foreign";
  const projection = { ...anchor };
  delete projection.anchorDigest;
  anchor.anchorDigest = digest(projection);
  storage.values.set(key, rechecksum(envelope));
  const target = await fixture();
  const before = fingerprint(target);
  const loaded = await loadBrowserSnapshot({ storage, state: target });
  assert.equal(loaded.status, "invalid");
  assert.equal(loaded.reason, "anchor_invalid");
  assert.deepEqual(fingerprint(target), before);
});
