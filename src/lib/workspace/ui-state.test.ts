import assert from "node:assert/strict";
import test from "node:test";
import type { Collection, EvidenceNote, Paper, ResearchProject } from "../types";
import {
  applyCreatedCollection,
  applyCreatedEvidenceNote,
  applyEvidenceNoteRevision,
  evidenceRevisionNeedsRefresh,
  applyNoteCollectionLink,
  applyPaperCollectionLink,
  type WorkspaceUiState,
} from "./ui-state";

const timestamp = "2026-08-28T18:00:00.000Z";

function project(): ResearchProject {
  return {
    id: "project-1",
    name: "Project",
    question: "Question?",
    description: "",
    type: "evidence-map",
    visibility: "private",
    status: "active",
    paperIds: ["paper-1"],
    evidenceNoteIds: [],
    collectionIds: [],
    sourceConnectionIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function paper(): Paper {
  return {
    id: "paper-1",
    title: "Paper",
    shortTitle: "Paper",
    authors: ["Researcher"],
    year: 2026,
    venue: "Journal",
    type: "journal article",
    abstract: "Abstract",
    abstractSnippet: "Abstract",
    whyRead: "Relevant",
    relevanceScore: 90,
    relevanceTags: [],
    evidenceStrength: "unassessed",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 5,
    identifiers: [],
    isDemoRecord: false,
  };
}

function collection(): Collection {
  return {
    id: "collection-1",
    name: "Mechanisms",
    description: "",
    color: "teal",
    paperIds: [],
    noteIds: [],
    evidenceClaimCount: 0,
    openQuestionCount: 0,
    updatedAt: timestamp,
  };
}

function note(): EvidenceNote {
  return {
    id: "note-1",
    paperId: "paper-1",
    title: "Manual assertion",
    kind: "interpretation",
    claim: "Claim",
    evidence: "Researcher-entered evidence",
    interpretation: "Interpretation",
    confidence: "medium",
    status: "needs-verification",
    provenance: {
      id: "provenance-1",
      sourceType: "paper",
      sourceId: "paper-1",
      sourceTitle: "Paper",
      providerName: "PaperPilot researcher input",
      retrievedAt: timestamp,
      accessMethod: "manual",
      excerpt: "Researcher-entered evidence",
    },
    linkedHighlightIds: [],
    collectionIds: ["collection-1"],
    tags: ["manual assertion"],
    revision: { rootId: "note-1", number: 1, isLatest: true },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function state(): WorkspaceUiState {
  return {
    aggregateVersion: 3,
    projects: [project()],
    papers: [paper()],
    notes: [],
    collections: [],
  };
}

test("created collections merge into the project without duplicating a replay", () => {
  const created = applyCreatedCollection(state(), 4, {
    collection: collection(),
    projectId: "project-1",
  });
  const replayed = applyCreatedCollection(created, 4, {
    collection: collection(),
    projectId: "project-1",
  });

  assert.equal(replayed.collections.length, 1);
  assert.deepEqual(replayed.projects[0].collectionIds, ["collection-1"]);
});

test("created evidence updates project and collection counters once", () => {
  const initial = applyCreatedCollection(state(), 4, {
    collection: collection(),
    projectId: "project-1",
  });
  const result = {
    note: note(),
    linkedProjectIds: ["project-1"],
    updatedCollectionIds: ["collection-1"],
  };
  const created = applyCreatedEvidenceNote(initial, 5, result);
  const replayed = applyCreatedEvidenceNote(created, 5, result);

  assert.deepEqual(replayed.projects[0].evidenceNoteIds, ["note-1"]);
  assert.deepEqual(replayed.collections[0].noteIds, ["note-1"]);
  assert.equal(replayed.collections[0].evidenceClaimCount, 1);
});

test("server collection link results replace the returned entities", () => {
  const initial = applyCreatedCollection(state(), 4, {
    collection: collection(),
    projectId: "project-1",
  });
  const withPaper = applyPaperCollectionLink(initial, 5, {
    paper: paper(),
    collection: { ...collection(), paperIds: ["paper-1"] },
  });
  const withNote = applyNoteCollectionLink(withPaper, 6, {
    note: note(),
    collection: {
      ...collection(),
      paperIds: ["paper-1"],
      noteIds: ["note-1"],
      evidenceClaimCount: 1,
    },
  });

  assert.deepEqual(withNote.collections[0].paperIds, ["paper-1"]);
  assert.deepEqual(withNote.collections[0].noteIds, ["note-1"]);
  assert.equal(withNote.aggregateVersion, 6);
});

test("an immutable evidence revision advances head indexes without inflating collection counts", () => {
  const baseNote = note();
  const initial: WorkspaceUiState = {
    ...state(),
    aggregateVersion: 5,
    projects: [{ ...project(), evidenceNoteIds: [baseNote.id], collectionIds: ["collection-1"] }],
    notes: [baseNote],
    collections: [{
      ...collection(),
      noteIds: [baseNote.id],
      evidenceClaimCount: 1,
    }],
  };
  const successor: EvidenceNote = {
    ...baseNote,
    id: "note-2",
    status: "verified",
    reviewedAt: timestamp,
    revision: {
      rootId: baseNote.id,
      previousId: baseNote.id,
      number: 2,
      isLatest: true,
    },
  };
  const result = {
    predecessorId: baseNote.id,
    note: successor,
    linkedProjectIds: ["project-1"],
    updatedCollectionIds: ["collection-1"],
  };
  const revised = applyEvidenceNoteRevision(initial, 6, result);
  const replayed = applyEvidenceNoteRevision(revised, 6, result);

  assert.deepEqual(replayed.projects[0].evidenceNoteIds, [successor.id]);
  assert.deepEqual(replayed.collections[0].noteIds, [successor.id]);
  assert.equal(replayed.collections[0].evidenceClaimCount, 1);
  assert.equal(replayed.notes.length, 2);
  assert.deepEqual(replayed.notes.find((item) => item.id === baseNote.id)?.revision, {
    rootId: baseNote.id,
    number: 1,
    nextId: successor.id,
    isLatest: false,
  });
});

test("A to B to C replay never regresses head indexes to the non-head B revision", () => {
  const a = note();
  const b: EvidenceNote = {
    ...a,
    id: "note-2",
    revision: {
      rootId: a.id,
      previousId: a.id,
      nextId: "note-3",
      number: 2,
      isLatest: false,
    },
  };
  const c: EvidenceNote = {
    ...a,
    id: "note-3",
    status: "verified",
    reviewedAt: timestamp,
    revision: {
      rootId: a.id,
      previousId: b.id,
      number: 3,
      isLatest: true,
    },
  };
  const current: WorkspaceUiState = {
    ...state(),
    projects: [{ ...project(), evidenceNoteIds: [c.id], collectionIds: ["collection-1"] }],
    notes: [c, b, { ...a, revision: { ...a.revision, nextId: b.id, isLatest: false } }],
    collections: [{ ...collection(), noteIds: [c.id], evidenceClaimCount: 1 }],
  };
  const replay = {
    predecessorId: a.id,
    note: b,
    linkedProjectIds: ["project-1"],
    updatedCollectionIds: ["collection-1"],
  };

  assert.equal(evidenceRevisionNeedsRefresh(current, replay), false);
  const merged = applyEvidenceNoteRevision(current, 7, replay);
  assert.deepEqual(merged.projects[0].evidenceNoteIds, [c.id]);
  assert.deepEqual(merged.collections[0].noteIds, [c.id]);
  assert.equal(merged.collections[0].evidenceClaimCount, 1);
  assert.equal(merged.notes.filter((item) => item.id === b.id).length, 1);

  const stale: WorkspaceUiState = {
    ...current,
    projects: [{ ...project(), evidenceNoteIds: [a.id], collectionIds: ["collection-1"] }],
    notes: [a],
    collections: [{ ...collection(), noteIds: [a.id], evidenceClaimCount: 1 }],
  };
  assert.equal(evidenceRevisionNeedsRefresh(stale, replay), true);
  const safelyUninferred = applyEvidenceNoteRevision(stale, 7, replay);
  assert.deepEqual(safelyUninferred.projects[0].evidenceNoteIds, [a.id]);
  assert.deepEqual(safelyUninferred.collections[0].noteIds, [a.id]);
});

test("a delayed B-is-latest response cannot lower or split an A to B to C head", () => {
  const a = note();
  const preservedA: EvidenceNote = {
    ...a,
    revision: { ...a.revision, nextId: "note-2", isLatest: false },
  };
  const preservedB: EvidenceNote = {
    ...a,
    id: "note-2",
    revision: {
      rootId: a.id,
      previousId: a.id,
      nextId: "note-3",
      number: 2,
      isLatest: false,
    },
  };
  const c: EvidenceNote = {
    ...a,
    id: "note-3",
    status: "verified",
    reviewedAt: timestamp,
    revision: {
      rootId: a.id,
      previousId: preservedB.id,
      number: 3,
      isLatest: true,
    },
  };
  const current: WorkspaceUiState = {
    ...state(),
    aggregateVersion: 9,
    projects: [{ ...project(), evidenceNoteIds: [c.id], collectionIds: ["collection-1"] }],
    notes: [c, preservedB, preservedA],
    collections: [{ ...collection(), noteIds: [c.id], evidenceClaimCount: 1 }],
  };
  const delayedB: EvidenceNote = {
    ...preservedB,
    revision: {
      rootId: a.id,
      previousId: a.id,
      number: 2,
      isLatest: true,
    },
  };
  const delayed = {
    predecessorId: a.id,
    note: delayedB,
    linkedProjectIds: ["project-1"],
    updatedCollectionIds: ["collection-1"],
  };

  assert.equal(evidenceRevisionNeedsRefresh(current, delayed), true);
  const merged = applyEvidenceNoteRevision(current, 8, delayed);
  assert.equal(merged.aggregateVersion, 9);
  assert.deepEqual(merged.projects[0].evidenceNoteIds, [c.id]);
  assert.deepEqual(merged.collections[0].noteIds, [c.id]);
  assert.deepEqual(merged.notes.filter((item) => item.revision.isLatest).map((item) => item.id), [c.id]);
  assert.deepEqual(merged.notes.find((item) => item.id === preservedB.id)?.revision, preservedB.revision);
});
