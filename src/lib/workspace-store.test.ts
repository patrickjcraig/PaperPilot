import assert from "node:assert/strict";
import test from "node:test";
import { papers } from "./data";
import type { EvidenceNote } from "./types";
import {
  LEGACY_WORKSPACE_STORAGE_KEYS,
  WORKSPACE_STORAGE_KEY,
  createInitialWorkspaceSnapshot,
  findPaperDuplicate,
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
} from "./workspace-store";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("version 3 round-trip preserves projects, evidence, collections, and active project", () => {
  const storage = new MemoryStorage();
  const snapshot = createInitialWorkspaceSnapshot();
  const now = "2026-08-28T18:00:00.000Z";
  const paper = papers[0];
  const note: EvidenceNote = {
    id: "note-user-round-trip",
    paperId: paper.id,
    title: "Persisted reader evidence",
    kind: "direct-evidence",
    claim: "The same raw projections were used across reconstruction baselines.",
    evidence: "All reconstruction methods used the fixed 240-view acquisition.",
    interpretation: "The comparison isolates reconstruction more fairly.",
    confidence: "medium",
    status: "verified",
    reviewedAt: now,
    provenance: {
      id: "provenance-user-round-trip",
      sourceType: "paper",
      sourceId: paper.id,
      sourceTitle: paper.title,
      providerName: "PaperPilot reader",
      retrievedAt: now,
      accessMethod: "manual",
      locator: { paperId: paper.id, page: 7 },
    },
    linkedHighlightIds: [],
    collectionIds: [snapshot.collections[0].id],
    tags: ["reader capture"],
    revision: { rootId: "note-user-round-trip", number: 1, isLatest: true },
    createdAt: now,
    updatedAt: now,
  };
  snapshot.notes = [note, ...snapshot.notes];
  snapshot.collections[0].noteIds = [note.id, ...snapshot.collections[0].noteIds];
  snapshot.collections[0].evidenceClaimCount += 1;
  snapshot.activeProjectId = snapshot.projects[1].id;

  saveWorkspaceSnapshot(storage, snapshot);
  const restored = loadWorkspaceSnapshot(storage);

  assert.equal(restored.version, 3);
  assert.equal(restored.activeProjectId, snapshot.projects[1].id);
  const restoredNote = restored.notes[0];
  assert.ok(restoredNote);
  assert.equal(restoredNote.id, note.id);
  assert.equal(restoredNote.reviewedAt, now);
  const restoredLocator = restoredNote.provenance.locator;
  assert.ok(restoredLocator);
  assert.equal(restoredLocator.paperId, paper.id);
  assert.equal(restoredLocator.page, 7);
  assert.ok(restored.collections[0].noteIds.includes(note.id));
  assert.equal(restored.collections[0].evidenceClaimCount, snapshot.collections[0].evidenceClaimCount);
  assert.ok(storage.getItem(WORKSPACE_STORAGE_KEY));
});

test("legacy version 1 snapshots migrate without discarding seeded notes and collections", () => {
  const storage = new MemoryStorage();
  const initial = createInitialWorkspaceSnapshot();
  const legacy = {
    version: 1,
    projects: initial.projects,
    inboxEntries: initial.inboxEntries,
    importedPapers: initial.importedPapers,
  };
  storage.setItem(LEGACY_WORKSPACE_STORAGE_KEYS[0], JSON.stringify(legacy));

  const migrated = loadWorkspaceSnapshot(storage);

  assert.equal(migrated.version, 3);
  assert.equal(migrated.notes.length, initial.notes.length);
  assert.equal(migrated.collections.length, initial.collections.length);
  assert.equal(migrated.activeProjectId, initial.projects[0].id);
});

test("legacy verified demo notes deterministically recover a review timestamp", () => {
  const storage = new MemoryStorage();
  const initial = createInitialWorkspaceSnapshot();
  const persisted = JSON.parse(JSON.stringify(initial)) as {
    notes: Array<{ id: string; status: string; reviewedAt?: string; updatedAt: string }>;
  };
  const verified = persisted.notes.find((note) => note.status === "verified");
  assert.ok(verified);
  const expectedReviewedAt = verified.updatedAt;
  delete verified.reviewedAt;
  storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(persisted));

  const restored = loadWorkspaceSnapshot(storage);
  assert.equal(
    restored.notes.find((note) => note.id === verified.id)?.reviewedAt,
    expectedReviewedAt,
  );
});

test("malformed and unsupported future snapshots fail safely to fresh workspace data", () => {
  const malformedStorage = new MemoryStorage();
  malformedStorage.setItem(WORKSPACE_STORAGE_KEY, "{not-json");
  const malformed = loadWorkspaceSnapshot(malformedStorage);

  const futureStorage = new MemoryStorage();
  futureStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 99 }));
  const future = loadWorkspaceSnapshot(futureStorage);

  assert.equal(malformed.version, 3);
  assert.equal(future.version, 3);
  assert.equal(malformed.projects[0].id, createInitialWorkspaceSnapshot().projects[0].id);
  assert.equal(future.projects[0].id, createInitialWorkspaceSnapshot().projects[0].id);
});

test("saved snapshots and restored snapshots do not share mutable nested arrays", () => {
  const storage = new MemoryStorage();
  const snapshot = createInitialWorkspaceSnapshot();
  saveWorkspaceSnapshot(storage, snapshot);
  const restored = loadWorkspaceSnapshot(storage);

  restored.projects[0].paperIds.push("paper-only-in-restored-copy");
  restored.notes[0].tags.push("tag-only-in-restored-copy");
  restored.collections[0].paperIds.push("collection-paper-only-in-restored-copy");

  const loadedAgain = loadWorkspaceSnapshot(storage);
  assert.ok(!loadedAgain.projects[0].paperIds.includes("paper-only-in-restored-copy"));
  assert.ok(!loadedAgain.notes[0].tags.includes("tag-only-in-restored-copy"));
  assert.ok(!loadedAgain.collections[0].paperIds.includes("collection-paper-only-in-restored-copy"));
});

test("duplicate detection normalizes DOI URLs and Unicode title punctuation", () => {
  const existing = papers[0];
  const doiCandidate = {
    ...existing,
    id: "candidate-doi",
    identifiers: [{ scheme: "doi" as const, value: " DOI:10.1109/TCPMT.2024.3471188. " }],
  };
  const titleCandidate = {
    ...existing,
    id: "candidate-title",
    identifiers: [],
    title: existing.title.normalize("NFD").replace(/-/g, " — "),
  };

  assert.equal(findPaperDuplicate(doiCandidate, [existing])?.id, existing.id);
  assert.equal(findPaperDuplicate(titleCandidate, [existing])?.id, existing.id);
});
