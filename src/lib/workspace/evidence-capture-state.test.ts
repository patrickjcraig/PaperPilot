import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceCaptureReducer,
  type EvidenceCaptureState,
} from "./evidence-capture-state";

const selection = {
  anchor: {
    start: { chunkId: "chunk:1", sequence: 1, byteOffset: 2, contentHash: "a".repeat(64) },
    end: { chunkId: "chunk:1", sequence: 1, byteOffset: 12, contentHash: "a".repeat(64) },
    expectedQuoteSha256: "b".repeat(64),
  },
  quoteText: "source text",
  pageStart: 1,
  pageEnd: 1,
  paragraphStartId: "p1-p2",
  paragraphEndId: "p1-p2",
  selectedChunkIds: ["chunk:1"],
  selectedByteLength: 10,
};

function selectedState(): EvidenceCaptureState {
  return evidenceCaptureReducer({ phase: "idle" }, {
    type: "selection-created",
    operationId: "operation:one",
    source: {
      paperId: "paper:one",
      documentId: "document:one",
      extractionId: "extraction:one",
      manifestSha256: "c".repeat(64),
    },
    selection,
    originElementId: "reader-capture-chunk-1",
    projectId: "project:one",
    collectionId: "collection:one",
  });
}

test("evidenceCaptureReducer preserves fields and operation id on source replacement", () => {
  let state = selectedState();
  state = evidenceCaptureReducer(state, { type: "field-changed", field: "claim", value: "Bounded claim" });
  state = evidenceCaptureReducer(state, { type: "save-requested" });
  state = evidenceCaptureReducer(state, { type: "source-replaced", extractionId: "extraction:two" });

  assert.equal(state.phase, "source-changed");
  assert.equal(state.operationId, "operation:one");
  assert.equal(state.draft.claim, "Bounded claim");
  assert.equal(state.source.extractionId, "extraction:one");
});

test("evidenceCaptureReducer reuses the operation id across a version-conflict retry", () => {
  let state = selectedState();
  state = evidenceCaptureReducer(state, { type: "save-requested" });
  state = evidenceCaptureReducer(state, { type: "version-conflict", message: "Workspace changed." });
  state = evidenceCaptureReducer(state, { type: "retry-ready" });
  state = evidenceCaptureReducer(state, { type: "save-requested" });

  assert.equal(state.phase, "saving");
  assert.equal(state.operationId, "operation:one");
});

test("an in-flight immutable evidence write cannot be dismissed", () => {
  let state = selectedState();
  state = evidenceCaptureReducer(state, { type: "save-requested" });
  state = evidenceCaptureReducer(state, { type: "dismissed" });

  assert.equal(state.phase, "saving");
  assert.equal(state.operationId, "operation:one");
});

test("evidenceCaptureReducer preserves fields and operation id while re-anchoring", () => {
  let state = selectedState();
  state = evidenceCaptureReducer(state, { type: "field-changed", field: "title", value: "Preserved title" });
  state = evidenceCaptureReducer(state, { type: "save-requested" });
  state = evidenceCaptureReducer(state, { type: "source-conflict" });
  state = evidenceCaptureReducer(state, { type: "reselection-requested" });
  assert.equal(state.phase, "reselecting");
  state = evidenceCaptureReducer(state, {
    type: "source-replaced",
    extractionId: "extraction:two",
  });
  assert.equal(state.phase, "reselecting");

  state = evidenceCaptureReducer(state, {
    type: "selection-created",
    operationId: "operation:must-not-replace",
    source: {
      paperId: "paper:one",
      documentId: "document:one",
      extractionId: "extraction:two",
      manifestSha256: "d".repeat(64),
    },
    selection: { ...selection, quoteText: "replacement text" },
    originElementId: "reader-capture-chunk-2",
    projectId: "project:one",
  });

  assert.equal(state.phase, "selected");
  assert.equal(state.operationId, "operation:one");
  assert.equal(state.draft.title, "Preserved title");
  assert.equal(state.source.extractionId, "extraction:two");
  assert.equal(state.selection.quoteText, "replacement text");
});

test("evidenceCaptureReducer starts an immutable re-anchor with preserved researcher fields", () => {
  const state = evidenceCaptureReducer({ phase: "idle" }, {
    type: "reanchor-requested",
    operationId: "operation:revision",
    predecessorId: "note:one",
    predecessorRevisionNumber: 2,
    predecessorSourceState: "superseded",
    predecessorStatus: "verified",
    source: {
      paperId: "paper:one",
      documentId: "document:old",
      extractionId: "extraction:old",
      manifestSha256: "c".repeat(64),
    },
    selection,
    originElementId: "evidence-note-note:one-reanchor",
    draft: {
      projectId: "project:one",
      collectionId: "collection:one",
      kind: "direct-evidence",
      title: "Preserved label",
      claim: "Preserved claim",
      interpretation: "Preserved interpretation",
      openQuestion: "Preserved question",
      confidence: "high",
      tags: ["preserved"],
    },
  });

  assert.equal(state.phase, "reselecting");
  assert.deepEqual(state.intent, {
    action: "reanchor",
    predecessorId: "note:one",
    predecessorRevisionNumber: 2,
    predecessorSourceState: "superseded",
    predecessorStatus: "verified",
  });
  assert.equal(state.operationId, "operation:revision");
  assert.equal(state.draft.claim, "Preserved claim");
});

test("evidenceCaptureReducer keeps revision identity after a concurrent chain advance", () => {
  let state = evidenceCaptureReducer({ phase: "idle" }, {
    type: "reanchor-requested",
    operationId: "operation:revision",
    predecessorId: "note:one",
    predecessorRevisionNumber: 1,
    predecessorSourceState: "unresolvable",
    predecessorStatus: "captured",
    source: {
      paperId: "paper:one",
      documentId: "document:old",
      extractionId: "extraction:old",
      manifestSha256: "c".repeat(64),
    },
    selection,
    originElementId: "evidence-note-note:one-reanchor",
    draft: {
      projectId: "project:one",
      collectionId: "",
      kind: "direct-evidence",
      title: "Label",
      claim: "Claim",
      interpretation: "Interpretation",
      openQuestion: "",
      confidence: "unspecified",
      tags: [],
    },
  });
  state = evidenceCaptureReducer(state, {
    type: "selection-created",
    operationId: "operation:must-not-replace",
    source: {
      paperId: "paper:one",
      documentId: "document:new",
      extractionId: "extraction:new",
      manifestSha256: "d".repeat(64),
    },
    selection,
    originElementId: "reader-capture-chunk-1",
    projectId: "project:one",
  });
  state = evidenceCaptureReducer(state, { type: "save-requested" });
  state = evidenceCaptureReducer(state, {
    type: "revision-conflict",
    message: "A newer revision already exists.",
  });

  assert.equal(state.phase, "revision-conflict");
  assert.equal(state.operationId, "operation:revision");
  assert.equal(state.intent.action, "reanchor");
  assert.equal(state.originElementId, "evidence-note-note:one-reanchor");
  assert.equal(state.error, "A newer revision already exists.");
});
