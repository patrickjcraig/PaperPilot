import assert from "node:assert/strict";
import test from "node:test";
import { papers } from "../data";
import type { Paper, Provenance } from "../types";
import type {
  CreateEvidenceNoteCommand,
  WorkspaceCommandResult,
  WorkspaceCommandSuccess,
} from "./contracts";
import {
  DEMO_WORKSPACE_CLIENT_METADATA_KEY,
  DemoWorkspaceClient,
} from "./demo-client";

class MemoryStorage {
  readonly values = new Map<string, string>();
  private failNextKey?: string;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failNextKey === key) {
      this.failNextKey = undefined;
      throw new Error(`Injected write failure for ${key}`);
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  failNextWrite(key: string): void {
    this.failNextKey = key;
  }
}

function createClient(storage = new MemoryStorage()) {
  let sequence = 0;
  const client = new DemoWorkspaceClient(storage, {
    now: () => "2026-08-28T18:00:00.000Z",
    idFactory: (prefix) => `${prefix}-test-${++sequence}`,
    workspaceId: "workspace-test",
    workspaceName: "Test workspace",
  });
  return { client, storage };
}

function assertSuccess<T>(
  result: WorkspaceCommandResult<T>,
): asserts result is WorkspaceCommandSuccess<T> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function externalPaper(): Paper {
  return {
    ...structuredClone(papers[5]),
    id: "paper-external-test",
    title: "A deterministic external paper for workspace-client tests",
    shortTitle: "Deterministic external paper",
    authors: ["Test Researcher"],
    identifiers: [{ scheme: "provider", value: "test-provider:paper-001" }],
    sourceUrl: "https://example.test/paper-001",
    isDemoRecord: false,
  };
}

function externalProvenance(paper: Paper): Provenance {
  return {
    id: "provenance-external-test",
    sourceType: "literature-index",
    sourceId: "test-provider:paper-001",
    sourceTitle: paper.title,
    sourceUrl: paper.sourceUrl,
    providerName: "Test literature provider",
    retrievedAt: "2026-08-28T17:59:00.000Z",
    accessMethod: "api",
    version: "1",
  };
}

test("project commands use optimistic versions, persistent idempotency, and clone-safe results", async () => {
  const { client, storage } = createClient();
  const before = await client.bootstrap();
  assert.equal(before.aggregateVersion, 0);
  assert.equal(before.workspace.role, "owner");

  const command = {
    clientOperationId: "operation-create-project",
    expectedVersion: before.aggregateVersion,
    project: {
      name: "Package reliability map",
      question: "Which imaging evidence predicts package reliability failures?",
      type: "evidence-map" as const,
      visibility: "private" as const,
    },
  };
  const applied = await client.createProject(command);
  assertSuccess(applied);
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.aggregateVersion, 1);
  assert.equal(applied.data.project.id, "project-test-1");

  applied.data.project.paperIds.push("mutation-only-in-command-result");
  const afterResultMutation = await client.bootstrap();
  assert.ok(!afterResultMutation.projects[0].paperIds.includes("mutation-only-in-command-result"));

  const replayedByNewClient = await new DemoWorkspaceClient(storage).createProject(command);
  assertSuccess(replayedByNewClient);
  assert.equal(replayedByNewClient.outcome, "replayed");
  assert.equal(replayedByNewClient.aggregateVersion, 1);
  assert.equal((await client.bootstrap()).projects.length, before.projects.length + 1);

  const reusedForDifferentPayload = await client.createProject({
    ...command,
    project: { ...command.project, name: "A different project" },
  });
  assert.equal(reusedForDifferentPayload.ok, false);
  if (!reusedForDifferentPayload.ok) {
    assert.equal(reusedForDifferentPayload.code, "idempotency_conflict");
  }

  const stale = await client.createProject({
    ...command,
    clientOperationId: "operation-stale-create-project",
    expectedVersion: 0,
    project: { ...command.project, name: "Stale project" },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "version_conflict");
});

test("collection creation is project-scoped, replay-safe, duplicate-safe, and versioned", async () => {
  const { client, storage } = createClient();
  const before = await client.bootstrap();
  const project = before.projects[0];
  assert.ok(project);
  const command = {
    clientOperationId: "operation-create-collection",
    expectedVersion: before.aggregateVersion,
    projectId: project.id,
    name: "Reliability outcomes",
    description: "Claims and open questions about reliability outcomes.",
    color: "teal" as const,
  };

  const applied = await client.createCollection(command);
  assertSuccess(applied);
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.aggregateVersion, before.aggregateVersion + 1);
  assert.equal(applied.data.collection.id, "collection-test-1");
  assert.equal(applied.data.projectId, project.id);

  const stored = await client.bootstrap();
  assert.ok(stored.projects.find((candidate) => candidate.id === project.id)
    ?.collectionIds.includes(applied.data.collection.id));
  assert.equal(
    stored.collections.filter((collection) => collection.id === applied.data.collection.id).length,
    1,
  );

  const replayed = await new DemoWorkspaceClient(storage).createCollection(command);
  assertSuccess(replayed);
  assert.equal(replayed.outcome, "replayed");
  assert.equal(replayed.data.collection.id, applied.data.collection.id);

  const changedIntent = await client.createCollection({
    ...command,
    name: "Changed intent",
  });
  assert.equal(changedIntent.ok, false);
  if (!changedIntent.ok) assert.equal(changedIntent.code, "idempotency_conflict");

  const stale = await client.createCollection({
    ...command,
    clientOperationId: "operation-create-collection-stale",
    name: "Stale collection",
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "version_conflict");

  const duplicate = await client.createCollection({
    ...command,
    clientOperationId: "operation-create-collection-duplicate",
    expectedVersion: applied.aggregateVersion,
    name: "  RELIABILITY OUTCOMES  ",
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.code, "duplicate");

  const missingProject = await client.createCollection({
    ...command,
    clientOperationId: "operation-create-collection-missing-project",
    expectedVersion: applied.aggregateVersion,
    projectId: "project-does-not-exist",
    name: "Missing destination",
  });
  assert.equal(missingProject.ok, false);
  if (!missingProject.ok) assert.equal(missingProject.code, "not_found");
});

test("staging and filing an import updates inbox, library, and project atomically", async () => {
  const { client } = createClient();
  const before = await client.bootstrap();
  const paper = externalPaper();
  const provenance = externalProvenance(paper);

  const staged = await client.stageImport({
    clientOperationId: "operation-stage-import",
    expectedVersion: before.aggregateVersion,
    sourceKind: "discover",
    paper,
    provenance,
  });
  assertSuccess(staged);
  assert.equal(staged.outcome, "applied");
  assert.equal(staged.data.inboxEntry.status, "awaiting-review");

  const beforeFailedFile = await client.bootstrap();
  const failedFile = await client.fileImport({
    clientOperationId: "operation-file-missing-project",
    expectedVersion: staged.aggregateVersion,
    inboxEntryId: staged.data.inboxEntry.id,
    projectId: "project-does-not-exist",
  });
  assert.equal(failedFile.ok, false);
  if (!failedFile.ok) assert.equal(failedFile.code, "not_found");
  const afterFailedFile = await client.bootstrap();
  assert.equal(afterFailedFile.aggregateVersion, beforeFailedFile.aggregateVersion);
  assert.equal(
    afterFailedFile.inboxEntries.find((entry) => entry.id === staged.data.inboxEntry.id)?.status,
    "awaiting-review",
  );
  assert.ok(!afterFailedFile.projects.some((project) => project.paperIds.includes(paper.id)));

  const destinationProject = before.projects[0];
  const filedCommand = {
    clientOperationId: "operation-file-import",
    expectedVersion: staged.aggregateVersion,
    inboxEntryId: staged.data.inboxEntry.id,
    projectId: destinationProject.id,
  };
  const filed = await client.fileImport(filedCommand);
  assertSuccess(filed);
  assert.equal(filed.outcome, "applied");
  assert.equal(filed.aggregateVersion, staged.aggregateVersion + 1);

  const after = await client.bootstrap();
  assert.equal(
    after.inboxEntries.find((entry) => entry.id === staged.data.inboxEntry.id)?.status,
    "ready",
  );
  assert.equal(
    after.inboxEntries.find((entry) => entry.id === staged.data.inboxEntry.id)?.destinationProjectId,
    destinationProject.id,
  );
  assert.ok(after.papers.some((candidate) => candidate.id === paper.id));
  assert.ok(
    after.projects.find((project) => project.id === destinationProject.id)?.paperIds.includes(paper.id),
  );

  const replayed = await client.fileImport(filedCommand);
  assertSuccess(replayed);
  assert.equal(replayed.outcome, "replayed");
  assert.equal(replayed.aggregateVersion, filed.aggregateVersion);
});

test("evidence creation and collection filing keep both sides of every relationship consistent", async () => {
  const { client } = createClient();
  const before = await client.bootstrap();
  const project = before.projects[0];
  const paperId = project.paperIds[0];
  const firstCollection = before.collections.find((collection) =>
    project.collectionIds.includes(collection.id),
  );
  assert.ok(firstCollection);

  const command: CreateEvidenceNoteCommand = {
    clientOperationId: "operation-create-evidence",
    expectedVersion: before.aggregateVersion,
    projectId: project.id,
    note: {
      paperId,
      title: "Grounded test evidence",
      kind: "direct-evidence",
      claim: "A controlled result supports the bounded test claim.",
      evidence: "The same projections were used for all compared methods.",
      interpretation: "Input control improves attribution to the reconstruction method.",
      openQuestion: "Does the result transfer to natural defects?",
      confidence: "medium",
      status: "captured",
      provenance: {
        sourceType: "paper",
        sourceId: paperId,
        sourceTitle: "Grounded source",
        providerName: "PaperPilot test reader",
        accessMethod: "manual",
        locator: { paperId, page: 7 },
      },
      linkedHighlightIds: ["highlight-test"],
      collectionIds: [firstCollection.id],
      tags: ["test evidence"],
    },
  };

  const created = await client.createEvidenceNote(command);
  assertSuccess(created);
  assert.equal(created.outcome, "applied");
  const noteId = created.data.note.id;

  const afterCreate = await client.bootstrap();
  const updatedProject = afterCreate.projects.find((candidate) => candidate.id === project.id);
  const updatedFirstCollection = afterCreate.collections.find(
    (collection) => collection.id === firstCollection.id,
  );
  assert.ok(afterCreate.notes.some((note) => note.id === noteId));
  assert.ok(updatedProject?.evidenceNoteIds.includes(noteId));
  assert.ok(updatedFirstCollection?.noteIds.includes(noteId));
  assert.equal(
    updatedFirstCollection?.evidenceClaimCount,
    firstCollection.evidenceClaimCount + 1,
  );
  assert.equal(
    updatedFirstCollection?.openQuestionCount,
    firstCollection.openQuestionCount + 1,
  );

  const secondCollection = afterCreate.collections.find(
    (collection) => collection.id !== firstCollection.id,
  );
  assert.ok(secondCollection);
  const filed = await client.addNoteToCollection({
    clientOperationId: "operation-file-evidence-note",
    expectedVersion: created.aggregateVersion,
    noteId,
    collectionId: secondCollection.id,
  });
  assertSuccess(filed);
  assert.equal(filed.outcome, "applied");
  assert.ok(filed.data.note.collectionIds.includes(secondCollection.id));
  assert.ok(filed.data.collection.noteIds.includes(noteId));

  const duplicateLink = await client.addNoteToCollection({
    clientOperationId: "operation-file-evidence-note-again",
    expectedVersion: filed.aggregateVersion,
    noteId,
    collectionId: secondCollection.id,
  });
  assertSuccess(duplicateLink);
  assert.equal(duplicateLink.outcome, "noop");
  assert.equal(duplicateLink.aggregateVersion, filed.aggregateVersion);

  const beforeInvalid = await client.bootstrap();
  const invalid = await client.createEvidenceNote({
    ...command,
    clientOperationId: "operation-invalid-evidence",
    expectedVersion: beforeInvalid.aggregateVersion,
    note: { ...command.note, collectionIds: ["collection-missing"] },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, "not_found");
  const afterInvalid = await client.bootstrap();
  assert.equal(afterInvalid.aggregateVersion, beforeInvalid.aggregateVersion);
  assert.equal(afterInvalid.notes.length, beforeInvalid.notes.length);
});

test("bootstrap and project query return independent deep clones", async () => {
  const { client } = createClient();
  const first = await client.bootstrap();
  const projectId = first.projects[0].id;
  const originalPaperCount = first.projects[0].paperIds.length;
  const originalAuthor = first.papers[0].authors[0];

  first.projects[0].paperIds.push("client-only-paper");
  first.papers[0].authors[0] = "Client-only author";
  first.notes[0].provenance.locator!.pageRange = [90, 99];

  const second = await client.bootstrap();
  assert.equal(second.projects[0].paperIds.length, originalPaperCount);
  assert.equal(second.papers[0].authors[0], originalAuthor);
  assert.notDeepEqual(second.notes[0].provenance.locator?.pageRange, [90, 99]);

  const project = await client.getProject({ projectId });
  assert.ok(project);
  project.project.paperIds.push("query-only-paper");
  const projectAgain = await client.getProject({ projectId });
  assert.ok(projectAgain);
  assert.ok(!projectAgain.project.paperIds.includes("query-only-paper"));
});

test("a failed metadata write rolls the complete snapshot back", async () => {
  const { client, storage } = createClient();
  const before = await client.bootstrap();
  storage.failNextWrite(DEMO_WORKSPACE_CLIENT_METADATA_KEY);

  await assert.rejects(
    client.createProject({
      clientOperationId: "operation-injected-storage-failure",
      expectedVersion: before.aggregateVersion,
      project: {
        name: "Must roll back",
        question: "Does a partial write escape?",
        type: "literature-review",
        visibility: "private",
      },
    }),
    /Injected write failure/,
  );

  const after = await client.bootstrap();
  assert.equal(after.aggregateVersion, before.aggregateVersion);
  assert.deepEqual(
    after.projects.map((project) => project.id),
    before.projects.map((project) => project.id),
  );
});
