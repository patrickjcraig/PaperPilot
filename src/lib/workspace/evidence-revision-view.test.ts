import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceNote } from "../types";
import {
  canSubmitEvidenceReviewAttempt,
  evidenceReviewSessionProjection,
  evidenceRevisionActions,
  evidenceRevisionDraft,
  evidenceRevisionHistory,
  evidenceNotesForHeads,
  latestEvidenceNoteHeads,
  staleEvidenceSelectionPreview,
} from "./evidence-revision-view";

function note(
  id: string,
  number: number,
  options: {
    isLatest?: boolean;
    sourceState?: "current" | "superseded" | "unresolvable";
    status?: "captured" | "verified";
  } = {},
): EvidenceNote {
  const quote = number === 1 ? "Earlier source quote." : "Current source quote.";
  return {
    id,
    paperId: "paper:one",
    title: "Bounded result",
    kind: "direct-evidence",
    claim: "A bounded claim.",
    evidence: quote,
    interpretation: "A bounded interpretation.",
    confidence: "medium",
    status: options.status ?? "captured",
    provenance: {
      id: `provenance:${id}`,
      sourceType: "uploaded-file",
      sourceId: `extraction:${number}`,
      sourceTitle: "Paper title",
      providerName: "PaperPilot Reader",
      retrievedAt: "2026-08-28T12:00:00.000Z",
      accessMethod: "upload",
      locator: { paperId: "paper:one", page: number, paragraphId: `p${number}-p1` },
      excerpt: quote,
      version: `manifest:${"a".repeat(64)}`,
    },
    linkedHighlightIds: [],
    collectionIds: ["collection:one", "collection:hidden"],
    tags: ["result"],
    grounding: {
      schemaVersion: 1,
      state: options.sourceState ?? "current",
      documentId: "document:one",
      extractionId: `extraction:${number}`,
      manifestSha256: "a".repeat(64),
      start: { chunkId: `chunk:${number}:one`, sequence: 0, byteOffset: 0, contentHash: "b".repeat(64) },
      end: { chunkId: `chunk:${number}:two`, sequence: 1, byteOffset: 8, contentHash: "c".repeat(64) },
      quoteSha256: "d".repeat(64),
      pageStart: number,
      pageEnd: number,
      paragraphStartId: `p${number}-p1`,
      paragraphEndId: `p${number}-p2`,
    },
    revision: {
      rootId: "note:root",
      previousId: number > 1 ? `note:${number - 1}` : undefined,
      nextId: options.isLatest === false ? `note:${number + 1}` : undefined,
      number,
      isLatest: options.isLatest ?? true,
    },
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
  };
}

test("revision view keeps only chain heads by default and orders inspectable history newest first", () => {
  const predecessor = note("note:1", 1, { isLatest: false });
  const head = note("note:2", 2);
  const unrelated = { ...note("note:other", 1), revision: { rootId: "note:other", number: 1, isLatest: true } };
  const notes = [predecessor, unrelated, head];

  assert.deepEqual(latestEvidenceNoteHeads(notes).map((item) => item.id), ["note:other", "note:2"]);
  assert.deepEqual(evidenceRevisionHistory(head, notes).map((item) => item.id), ["note:2", "note:1"]);
});

test("project head indexes recover full matching histories without importing unrelated chains", () => {
  const predecessor = note("note:1", 1, { isLatest: false });
  const head = note("note:2", 2);
  const unrelated = { ...note("note:other", 1), revision: { rootId: "note:other", number: 1, isLatest: true } };

  assert.deepEqual(
    evidenceNotesForHeads([predecessor, unrelated, head], [head.id]).map((item) => item.id),
    ["note:1", "note:2"],
  );
});

test("review and re-anchor eligibility keep review state separate from source state", () => {
  assert.deepEqual(evidenceRevisionActions(note("note:stale", 2, { sourceState: "superseded" })), {
    canReview: true,
    canReanchor: true,
  });
  assert.deepEqual(evidenceRevisionActions(note("note:reviewed", 2, {
    sourceState: "superseded",
    status: "verified",
  })), {
    canReview: false,
    canReanchor: true,
  });
  assert.deepEqual(evidenceRevisionActions(note("note:current", 2, { sourceState: "current" })), {
    canReview: true,
    canReanchor: false,
  });
});

test("review creation stays head-only while a submitted historical attempt remains retryable", () => {
  const historical = note("note:1", 1, { isLatest: false });
  const refreshedHistorical = {
    ...historical,
    grounding: historical.grounding
      ? { ...historical.grounding, state: "superseded" as const }
      : undefined,
  };

  assert.equal(evidenceRevisionActions(historical).canReview, false);
  assert.equal(canSubmitEvidenceReviewAttempt(historical), true);
  assert.equal(canSubmitEvidenceReviewAttempt({
    ...historical,
    status: "verified",
    reviewedAt: historical.updatedAt,
  }), false);
  assert.equal(canSubmitEvidenceReviewAttempt({ ...historical, grounding: undefined }), false);
  assert.deepEqual(
    evidenceReviewSessionProjection(historical, refreshedHistorical, {
      saving: false,
      submitted: false,
    }),
    { conflicted: true, dialogNote: undefined },
  );

  const submitted = evidenceReviewSessionProjection(historical, refreshedHistorical, {
    saving: false,
    submitted: true,
  });
  assert.equal(submitted.conflicted, false);
  assert.equal(submitted.dialogNote?.id, historical.id);
  assert.equal(submitted.dialogNote?.grounding?.state, "superseded");

  const missingAfterRefresh = evidenceReviewSessionProjection(historical, undefined, {
    saving: false,
    submitted: true,
  });
  assert.equal(missingAfterRefresh.conflicted, false);
  assert.equal(missingAfterRefresh.dialogNote, historical);
});

test("re-anchor preparation preserves researcher fields and never submits hidden collections", () => {
  const source = note("note:stale", 2, { sourceState: "unresolvable", status: "verified" });
  const draft = evidenceRevisionDraft(source, "project:one", new Set(["collection:one"]));
  const preview = staleEvidenceSelectionPreview(source);

  assert.equal(draft.claim, source.claim);
  assert.equal(draft.interpretation, source.interpretation);
  assert.equal(draft.collectionId, "collection:one");
  assert.deepEqual(draft.tags, ["result"]);
  assert.equal(preview?.quoteText, source.evidence);
  assert.deepEqual(preview?.selectedChunkIds, ["chunk:2:one", "chunk:2:two"]);
  assert.equal(preview?.anchor.expectedQuoteSha256, source.grounding?.quoteSha256);
});
