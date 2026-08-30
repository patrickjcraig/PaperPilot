import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { CreateEvidenceNoteCommand } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import {
  addWorkspaceNoteToCollection,
  addWorkspacePaperToCollection,
  createWorkspaceEvidenceNote,
} from "./evidence-service";
import { createWorkspaceProject, workspaceBootstrap, workspaceProject } from "./service";

after(async () => {
  await prisma.$disconnect();
});

test("structured evidence is durable, source-grounded, replay-safe, and tenant-isolated", async () => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({
    data: {
      id: `evidence-owner-${suffix}`,
      name: "Evidence Owner",
      email: `evidence-owner-${suffix}@example.test`,
    },
  });
  const collaborator = await prisma.user.create({
    data: {
      id: `evidence-collaborator-${suffix}`,
      name: "Evidence Collaborator",
      email: `evidence-collaborator-${suffix}@example.test`,
    },
  });
  const outsider = await prisma.user.create({
    data: {
      id: `evidence-outsider-${suffix}`,
      name: "Evidence Outsider",
      email: `evidence-outsider-${suffix}@example.test`,
    },
  });

  let workspaceId: string | undefined;
  let outsiderWorkspaceId: string | undefined;
  let paperId: string | undefined;
  try {
    const initial = await workspaceBootstrap(owner);
    workspaceId = initial.workspace.id;
    const createdProject = await createWorkspaceProject(owner, workspaceId, {
      clientOperationId: `project-${suffix}`,
      expectedVersion: initial.aggregateVersion,
      project: {
        name: "Private grounded review",
        question: "Which claim survives source verification?",
        description: "A private project for evidence integration testing.",
        type: "literature-review",
        visibility: "private",
      },
    });
    assert.equal(createdProject.ok, true);
    if (!createdProject.ok) return;

    const paper = await prisma.paper.create({
      data: {
        title: "A source-grounded outcome",
        abstractText: "A bounded abstract.",
        publicationYear: 2026,
        venueName: "Journal of Test Evidence",
        workType: "journal article",
        primarySource: "MANUAL",
        authors: { create: [{ position: 0, displayName: "Ada Evidence" }] },
        identifiers: {
          create: [{
            type: "DOI",
            value: `10.5555/${suffix}`,
            normalizedValue: `10.5555/${suffix}`.toLowerCase(),
            source: "MANUAL",
          }],
        },
      },
    });
    paperId = paper.id;
    const workspacePaper = await prisma.workspacePaper.create({
      data: {
        organizationId: workspaceId,
        paperId: paper.id,
        status: "SAVED",
        addedById: owner.id,
      },
    });
    await prisma.projectPaper.create({
      data: {
        organizationId: workspaceId,
        projectId: createdProject.data.project.id,
        workspacePaperId: workspacePaper.id,
        addedById: owner.id,
      },
    });
    const collection = await prisma.collection.create({
      data: {
        organizationId: workspaceId,
        projectId: createdProject.data.project.id,
        name: "Primary outcomes",
        description: "Direct outcome evidence.",
        color: "blue",
        createdById: owner.id,
      },
    });
    const secondCollection = await prisma.collection.create({
      data: {
        organizationId: workspaceId,
        projectId: createdProject.data.project.id,
        name: "Replication questions",
        description: "Questions that need another study.",
        color: "amber",
        createdById: owner.id,
      },
    });

    const command: CreateEvidenceNoteCommand = {
      clientOperationId: `evidence-${suffix}`,
      expectedVersion: createdProject.aggregateVersion,
      projectId: createdProject.data.project.id,
      note: {
        paperId: paper.id,
        title: "Primary outcome improved",
        kind: "direct-evidence",
        claim: "The intervention improved the prespecified primary outcome.",
        evidence: "The adjusted between-group difference was 12 points (95% CI 8–16).",
        interpretation: "The estimate is material but remains bounded to the enrolled population.",
        openQuestion: "Does the result replicate in older adults?",
        confidence: "medium",
        status: "needs-verification",
        provenance: {
          sourceType: "paper",
          sourceId: `doi:10.5555/${suffix}`,
          sourceTitle: paper.title,
          sourceUrl: `https://doi.org/10.5555/${suffix}`,
          providerName: "Researcher review",
          retrievedAt: new Date().toISOString(),
          accessMethod: "manual",
          locator: {
            paperId: paper.id,
            sectionId: "results",
            sectionTitle: "Results",
            pageRange: [7, 8],
            paragraphId: "results-primary-outcome",
          },
          excerpt: "The adjusted between-group difference was 12 points (95% CI 8–16).",
          version: "accepted-manuscript",
        },
        linkedHighlightIds: ["highlight-primary"],
        collectionIds: [collection.id],
        tags: ["primary outcome", "effect size"],
      },
    };

    const applied = await createWorkspaceEvidenceNote(owner, workspaceId, command);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.aggregateVersion, createdProject.aggregateVersion + 1);
    assert.equal(applied.data.note.claim, command.note.claim);
    assert.equal(applied.data.note.evidence, command.note.evidence);
    assert.equal(applied.data.note.interpretation, command.note.interpretation);
    assert.deepEqual(applied.data.note.provenance.locator?.pageRange, [7, 8]);
    assert.deepEqual(applied.data.linkedProjectIds, [createdProject.data.project.id]);
    assert.deepEqual(applied.data.updatedCollectionIds, [collection.id]);

    const replay = await createWorkspaceEvidenceNote(owner, workspaceId, command);
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.outcome, "replayed");
      assert.equal(replay.data.note.id, applied.data.note.id);
    }

    const stored = await prisma.evidenceNote.findUniqueOrThrow({
      where: { id: applied.data.note.id },
      include: { provenanceRecords: true, projectMemberships: true },
    });
    assert.equal(stored.claim, command.note.claim);
    assert.equal(stored.evidence, command.note.evidence);
    assert.equal(stored.interpretation, command.note.interpretation);
    assert.equal(stored.status, "NEEDS_VERIFICATION");
    assert.equal(stored.provenanceRecords.length, 1);
    assert.equal(stored.provenanceRecords[0].kind, "USER_ASSERTION");
    assert.ok(stored.provenanceRecords[0].payloadDigest);
    assert.equal(stored.projectMemberships[0].projectId, createdProject.data.project.id);

    const detail = await workspaceProject(owner, workspaceId, createdProject.data.project.id);
    assert.equal(detail?.notes.length, 1);
    assert.equal(detail?.notes[0].provenance.sourceId, command.note.provenance.sourceId);
    assert.ok(detail?.project.evidenceNoteIds.includes(applied.data.note.id));

    const paperFiled = await addWorkspacePaperToCollection(
      owner,
      workspaceId,
      collection.id,
      {
        clientOperationId: `collection-paper-${suffix}`,
        expectedVersion: applied.aggregateVersion,
        paperId: paper.id,
        collectionId: collection.id,
      },
    );
    assert.equal(paperFiled.ok, true);
    if (!paperFiled.ok) return;
    assert.equal(paperFiled.outcome, "applied");
    assert.deepEqual(paperFiled.data.collection.paperIds, [paper.id]);

    const noteFiled = await addWorkspaceNoteToCollection(
      owner,
      workspaceId,
      secondCollection.id,
      {
        clientOperationId: `collection-note-${suffix}`,
        expectedVersion: paperFiled.aggregateVersion,
        noteId: applied.data.note.id,
        collectionId: secondCollection.id,
      },
    );
    assert.equal(noteFiled.ok, true);
    if (!noteFiled.ok) return;
    assert.equal(noteFiled.outcome, "applied");
    assert.ok(noteFiled.data.note.collectionIds.includes(secondCollection.id));

    const noteNoop = await addWorkspaceNoteToCollection(
      owner,
      workspaceId,
      secondCollection.id,
      {
        clientOperationId: `collection-note-noop-${suffix}`,
        expectedVersion: noteFiled.aggregateVersion,
        noteId: applied.data.note.id,
        collectionId: secondCollection.id,
      },
    );
    assert.equal(noteNoop.ok, true);
    if (noteNoop.ok) {
      assert.equal(noteNoop.outcome, "noop");
      assert.equal(noteNoop.aggregateVersion, noteFiled.aggregateVersion);
    }

    await prisma.member.create({
      data: { organizationId: workspaceId, userId: collaborator.id, role: "member" },
    });
    const privateAttempt = await createWorkspaceEvidenceNote(collaborator, workspaceId, {
      ...command,
      clientOperationId: `private-attempt-${suffix}`,
      expectedVersion: noteFiled.aggregateVersion,
      note: { ...command.note, collectionIds: [] },
    });
    assert.equal(privateAttempt.ok, false);
    if (!privateAttempt.ok) assert.equal(privateAttempt.code, "not_found");
    assert.equal(
      await workspaceProject(collaborator, workspaceId, createdProject.data.project.id),
      null,
    );

    const outsiderWorkspace = await workspaceBootstrap(outsider);
    outsiderWorkspaceId = outsiderWorkspace.workspace.id;
    const outsiderProject = await prisma.project.create({
      data: {
        organizationId: outsiderWorkspaceId,
        name: "Outsider project",
        slug: `outsider-${suffix}`,
        type: "LITERATURE_REVIEW",
        visibility: "PRIVATE",
        createdById: outsider.id,
      },
    });
    const outsiderCollection = await prisma.collection.create({
      data: {
        organizationId: outsiderWorkspaceId,
        projectId: outsiderProject.id,
        name: "Foreign collection",
        color: "slate",
        createdById: outsider.id,
      },
    });
    const foreignCollection = await addWorkspacePaperToCollection(
      owner,
      workspaceId,
      outsiderCollection.id,
      {
        clientOperationId: `foreign-collection-${suffix}`,
        expectedVersion: noteFiled.aggregateVersion,
        paperId: paper.id,
        collectionId: outsiderCollection.id,
      },
    );
    assert.equal(foreignCollection.ok, false);
    if (!foreignCollection.ok) assert.equal(foreignCollection.code, "not_found");

    await prisma.member.update({
      where: { organizationId_userId: { organizationId: workspaceId, userId: collaborator.id } },
      data: { role: "viewer" },
    });
    await assert.rejects(
      createWorkspaceEvidenceNote(collaborator, workspaceId, {
        ...command,
        clientOperationId: `viewer-attempt-${suffix}`,
        expectedVersion: noteFiled.aggregateVersion,
      }),
      (error: unknown) => error instanceof HttpProblem
        && error.status === 403
        && error.code === "workspace_forbidden",
    );
  } finally {
    for (const organizationId of [workspaceId, outsiderWorkspaceId].filter(
      (value): value is string => Boolean(value),
    )) {
      await prisma.$transaction(async (transaction) => {
        await transaction.provenanceRecord.deleteMany({ where: { organizationId } });
        await transaction.auditEvent.deleteMany({ where: { organizationId } });
        await transaction.organization.deleteMany({ where: { id: organizationId } });
      });
    }
    if (paperId) await prisma.paper.deleteMany({ where: { id: paperId } });
    await prisma.user.deleteMany({
      where: { id: { in: [owner.id, collaborator.id, outsider.id] } },
    });
  }
});

test("collection filing exposes only visible lineage heads and never indexes a historical predecessor", async () => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({
    data: {
      id: `lineage-owner-${suffix}`,
      name: "Lineage Owner",
      email: `lineage-owner-${suffix}@example.test`,
    },
  });
  const collaborator = await prisma.user.create({
    data: {
      id: `lineage-collaborator-${suffix}`,
      name: "Lineage Collaborator",
      email: `lineage-collaborator-${suffix}@example.test`,
    },
  });

  let workspaceId: string | undefined;
  let paperId: string | undefined;
  try {
    const initial = await workspaceBootstrap(owner);
    workspaceId = initial.workspace.id;
    const privateProjectResult = await createWorkspaceProject(owner, workspaceId, {
      clientOperationId: `lineage-private-project-${suffix}`,
      expectedVersion: initial.aggregateVersion,
      project: {
        name: "Private predecessor project",
        question: "Can a hidden predecessor leak through a shared successor?",
        description: "Owner-only custody for the first revision.",
        type: "literature-review",
        visibility: "private",
      },
    });
    assert.equal(privateProjectResult.ok, true);
    if (!privateProjectResult.ok) return;
    const sharedProjectResult = await createWorkspaceProject(owner, workspaceId, {
      clientOperationId: `lineage-shared-project-${suffix}`,
      expectedVersion: privateProjectResult.aggregateVersion,
      project: {
        name: "Shared successor project",
        question: "Can collaborators file the visible revision head safely?",
        description: "Workspace-visible custody for the successor revision.",
        type: "literature-review",
        visibility: "workspace",
      },
    });
    assert.equal(sharedProjectResult.ok, true);
    if (!sharedProjectResult.ok) return;

    await prisma.member.create({
      data: { organizationId: workspaceId, userId: collaborator.id, role: "member" },
    });
    const paper = await prisma.paper.create({
      data: {
        title: "Visibility-safe evidence revision filing",
        abstractText: "A fixture for collection filing authorization.",
        publicationYear: 2026,
        primarySource: "MANUAL",
      },
    });
    paperId = paper.id;
    const workspacePaper = await prisma.workspacePaper.create({
      data: {
        organizationId: workspaceId,
        paperId: paper.id,
        status: "SAVED",
        addedById: owner.id,
      },
    });
    await prisma.projectPaper.createMany({
      data: [privateProjectResult.data.project.id, sharedProjectResult.data.project.id].map(
        (projectId) => ({
          organizationId: workspaceId as string,
          projectId,
          workspacePaperId: workspacePaper.id,
          addedById: owner.id,
        }),
      ),
    });
    const sharedCollection = await prisma.collection.create({
      data: {
        organizationId: workspaceId,
        projectId: sharedProjectResult.data.project.id,
        name: "Visible revision heads",
        color: "teal",
        createdById: owner.id,
      },
    });

    const sourceRetrievedAt = new Date("2026-08-28T14:00:00.000Z").toISOString();
    const predecessorResult = await createWorkspaceEvidenceNote(owner, workspaceId, {
      clientOperationId: `lineage-predecessor-${suffix}`,
      expectedVersion: sharedProjectResult.aggregateVersion,
      projectId: privateProjectResult.data.project.id,
      note: {
        paperId: paper.id,
        title: "Private predecessor",
        kind: "direct-evidence",
        claim: "The predecessor is private to its original project.",
        evidence: "Private source excerpt.",
        interpretation: "This revision must not be named to collaborators.",
        confidence: "medium",
        status: "captured",
        provenance: {
          sourceType: "paper",
          sourceId: `lineage-source-${suffix}`,
          sourceTitle: paper.title,
          providerName: "Researcher review",
          retrievedAt: sourceRetrievedAt,
          accessMethod: "manual",
          locator: { paperId: paper.id, page: 1, paragraphId: "private-predecessor" },
          excerpt: "Private source excerpt.",
          version: "fixture-v1",
        },
        linkedHighlightIds: [],
        collectionIds: [],
        tags: ["lineage"],
      },
    });
    assert.equal(predecessorResult.ok, true);
    if (!predecessorResult.ok) return;
    const predecessorId = predecessorResult.data.note.id;
    const predecessor = await prisma.evidenceNote.findUniqueOrThrow({
      where: { id: predecessorId },
      include: { provenanceRecords: true },
    });
    const predecessorAssertion = predecessor.provenanceRecords.find(
      ({ kind }) => kind === "USER_ASSERTION",
    );
    assert.ok(predecessorAssertion);

    const successor = await prisma.evidenceNote.create({
      data: {
        organizationId: workspaceId,
        workspacePaperId: workspacePaper.id,
        projectId: privateProjectResult.data.project.id,
        createdById: owner.id,
        supersedesId: predecessor.id,
        kind: "QUOTE",
        status: "CAPTURED",
        confidence: "MEDIUM",
        title: "Shared successor",
        claim: "The visible successor replaces the private predecessor.",
        evidence: "Shared source excerpt.",
        interpretation: "Only the visible portion of the chain may be projected.",
        linkedHighlightIds: [],
        tags: ["lineage", "shared"],
        text: "The visible successor replaces the private predecessor.",
        pageStart: 2,
        pageEnd: 2,
        paragraphId: "shared-successor",
        createdAt: new Date(predecessor.createdAt.getTime() + 1),
      },
    });
    await prisma.projectEvidenceNote.create({
      data: {
        organizationId: workspaceId,
        projectId: sharedProjectResult.data.project.id,
        evidenceNoteId: successor.id,
      },
    });
    await prisma.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "USER_ASSERTION",
        paperId: paper.id,
        workspacePaperId: workspacePaper.id,
        evidenceNoteId: successor.id,
        actorUserId: owner.id,
        supersedesId: predecessorAssertion?.id,
        sourceProvider: "Researcher review",
        sourceRecordId: `lineage-source-${suffix}`,
        retrievedAt: new Date(sourceRetrievedAt),
        payload: {
          schemaVersion: 2,
          provenance: {
            sourceType: "paper",
            sourceId: `lineage-source-${suffix}`,
            sourceTitle: paper.title,
            providerName: "Researcher review",
            retrievedAt: sourceRetrievedAt,
            accessMethod: "manual",
            locator: { paperId: paper.id, page: 2, paragraphId: "shared-successor" },
            excerpt: "Shared source excerpt.",
            version: "fixture-v2",
          },
        },
      },
    });

    const filed = await addWorkspaceNoteToCollection(
      collaborator,
      workspaceId,
      sharedCollection.id,
      {
        clientOperationId: `lineage-file-successor-${suffix}`,
        expectedVersion: predecessorResult.aggregateVersion,
        noteId: successor.id,
        collectionId: sharedCollection.id,
      },
    );
    assert.equal(filed.ok, true);
    if (!filed.ok) return;
    assert.equal(filed.outcome, "applied");
    assert.deepEqual(filed.data.note.revision, {
      rootId: successor.id,
      number: 1,
      isLatest: true,
    });
    assert.equal(JSON.stringify(filed.data).includes(predecessorId), false);
    assert.deepEqual(filed.data.collection.noteIds, [successor.id]);
    assert.equal(filed.data.collection.noteIds.includes(predecessorId), false);

    const replay = await addWorkspaceNoteToCollection(
      collaborator,
      workspaceId,
      sharedCollection.id,
      {
        clientOperationId: `lineage-file-successor-${suffix}`,
        expectedVersion: predecessorResult.aggregateVersion,
        noteId: successor.id,
        collectionId: sharedCollection.id,
      },
    );
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.outcome, "replayed");
      assert.deepEqual(replay.data.note.revision, {
        rootId: successor.id,
        number: 1,
        isLatest: true,
      });
      assert.equal(JSON.stringify(replay.data).includes(predecessorId), false);
    }

    const historicalFiling = await addWorkspaceNoteToCollection(
      owner,
      workspaceId,
      sharedCollection.id,
      {
        clientOperationId: `lineage-file-history-${suffix}`,
        expectedVersion: filed.aggregateVersion,
        noteId: predecessorId,
        collectionId: sharedCollection.id,
      },
    );
    assert.equal(historicalFiling.ok, false);
    if (!historicalFiling.ok) assert.equal(historicalFiling.code, "not_found");
    assert.equal(await prisma.collectionEvidenceNote.count({
      where: {
        organizationId: workspaceId,
        collectionId: sharedCollection.id,
        evidenceNoteId: predecessorId,
      },
    }), 0);
    const storedCollection = await prisma.collectionEvidenceNote.findMany({
      where: { organizationId: workspaceId, collectionId: sharedCollection.id },
      select: { evidenceNoteId: true },
    });
    assert.deepEqual(storedCollection.map(({ evidenceNoteId }) => evidenceNoteId), [successor.id]);
  } finally {
    if (workspaceId) {
      await prisma.$transaction(async (transaction) => {
        await transaction.provenanceRecord.deleteMany({ where: { organizationId: workspaceId } });
        await transaction.auditEvent.deleteMany({ where: { organizationId: workspaceId } });
        await transaction.organization.deleteMany({ where: { id: workspaceId } });
      });
    }
    if (paperId) await prisma.paper.deleteMany({ where: { id: paperId } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, collaborator.id] } } });
  }
});
