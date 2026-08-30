import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { workspaceBootstrap, workspaceProject } from "./service";

after(async () => {
  await prisma.$disconnect();
});

test("workspace projections retain visible history but count only authorized revision heads", async () => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({
    data: {
      id: `revision-owner-${suffix}`,
      name: "Revision Owner",
      email: `revision-owner-${suffix}@example.test`,
    },
  });
  const collaborator = await prisma.user.create({
    data: {
      id: `revision-collaborator-${suffix}`,
      name: "Revision Collaborator",
      email: `revision-collaborator-${suffix}@example.test`,
    },
  });

  let workspaceId: string | undefined;
  let paperId: string | undefined;
  try {
    const initial = await workspaceBootstrap(owner);
    workspaceId = initial.workspace.id;
    await prisma.member.create({
      data: { organizationId: workspaceId, userId: collaborator.id, role: "member" },
    });
    const [sharedProject, privateProject, paper] = await Promise.all([
      prisma.project.create({
        data: {
          organizationId: workspaceId,
          name: "Shared revision history",
          slug: `shared-revisions-${suffix}`,
          type: "LITERATURE_REVIEW",
          visibility: "WORKSPACE",
          createdById: owner.id,
        },
      }),
      prisma.project.create({
        data: {
          organizationId: workspaceId,
          name: "Private predecessor",
          slug: `private-revisions-${suffix}`,
          type: "LITERATURE_REVIEW",
          visibility: "PRIVATE",
          createdById: owner.id,
        },
      }),
      prisma.paper.create({
        data: {
          title: "Immutable evidence revision study",
          publicationYear: 2026,
          primarySource: "MANUAL",
        },
      }),
    ]);
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
        projectId: sharedProject.id,
        workspacePaperId: workspacePaper.id,
        addedById: owner.id,
      },
    });
    const collection = await prisma.collection.create({
      data: {
        organizationId: workspaceId,
        projectId: sharedProject.id,
        name: "Active evidence only",
        color: "blue",
        createdById: owner.id,
      },
    });

    const baseTime = Date.parse("2026-08-28T10:00:00.000Z");
    const createNote = async (input: {
      id: string;
      supersedesId?: string;
      projectId: string | null;
      projectMembershipId: string;
      title: string;
      kind: "RESULT" | "QUESTION";
      status: "CAPTURED" | "VERIFIED";
      createdAt: Date;
      collectionId?: string;
    }) => {
      const verifiedAt = input.status === "VERIFIED"
        ? new Date(input.createdAt.getTime() + 1_000)
        : null;
      const note = await prisma.evidenceNote.create({
        data: {
          id: input.id,
          organizationId: workspaceId!,
          workspacePaperId: workspacePaper.id,
          projectId: input.projectId,
          createdById: owner.id,
          supersedesId: input.supersedesId,
          kind: input.kind,
          status: input.status,
          confidence: "HIGH",
          title: input.title,
          claim: `${input.title} claim`,
          evidence: `${input.title} quotation`,
          interpretation: `${input.title} interpretation`,
          openQuestion: input.kind === "QUESTION" ? "What remains uncertain?" : null,
          quote: `${input.title} quotation`,
          text: `${input.title} claim`,
          verifiedAt,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      });
      await prisma.projectEvidenceNote.create({
        data: {
          organizationId: workspaceId!,
          projectId: input.projectMembershipId,
          evidenceNoteId: note.id,
        },
      });
      if (input.collectionId) {
        await prisma.collectionEvidenceNote.create({
          data: {
            organizationId: workspaceId!,
            collectionId: input.collectionId,
            evidenceNoteId: note.id,
          },
        });
      }
      const provenancePayload = {
        schemaVersion: 1,
        provenance: {
          sourceType: "paper",
          sourceTitle: paper.title,
          providerName: "Researcher review",
          accessMethod: "manual",
        },
      } satisfies Prisma.InputJsonObject;
      await prisma.provenanceRecord.create({
        data: {
          organizationId: workspaceId!,
          kind: "USER_ASSERTION",
          paperId: paper.id,
          workspacePaperId: workspacePaper.id,
          evidenceNoteId: note.id,
          actorUserId: owner.id,
          sourceProvider: "Researcher review",
          sourceRecordId: `source-${note.id}`,
          retrievedAt: input.createdAt,
          payload: provenancePayload,
        },
      });
      return note;
    };

    const revision1 = await createNote({
      id: `revision-1-${suffix}`,
      projectId: sharedProject.id,
      projectMembershipId: sharedProject.id,
      title: "Reviewed predecessor",
      kind: "RESULT",
      status: "VERIFIED",
      createdAt: new Date(baseTime),
      collectionId: collection.id,
    });
    const revision2 = await createNote({
      id: `revision-2-${suffix}`,
      supersedesId: revision1.id,
      projectId: sharedProject.id,
      projectMembershipId: sharedProject.id,
      title: "Question revision",
      kind: "QUESTION",
      status: "CAPTURED",
      createdAt: new Date(baseTime + 10_000),
      collectionId: collection.id,
    });
    const revision3 = await createNote({
      id: `revision-3-${suffix}`,
      supersedesId: revision2.id,
      projectId: sharedProject.id,
      projectMembershipId: sharedProject.id,
      title: "Reviewed head",
      kind: "RESULT",
      status: "VERIFIED",
      createdAt: new Date(baseTime + 20_000),
      collectionId: collection.id,
    });

    // This deliberately malformed membership history proves that an opaque
    // predecessor visible only through a private project is not disclosed to
    // a collaborator when the successor is visible in a shared project.
    const privatePredecessor = await createNote({
      id: `private-predecessor-${suffix}`,
      projectId: null,
      projectMembershipId: privateProject.id,
      title: "Private predecessor",
      kind: "RESULT",
      status: "CAPTURED",
      createdAt: new Date(baseTime + 30_000),
    });
    const visibleSuccessor = await createNote({
      id: `visible-successor-${suffix}`,
      supersedesId: privatePredecessor.id,
      projectId: null,
      projectMembershipId: sharedProject.id,
      title: "Visible successor",
      kind: "RESULT",
      status: "CAPTURED",
      createdAt: new Date(baseTime + 40_000),
    });

    const detail = await workspaceProject(collaborator, workspaceId, sharedProject.id);
    assert.ok(detail);
    assert.deepEqual(
      new Set(detail.notes.map((note) => note.id)),
      new Set([revision1.id, revision2.id, revision3.id, visibleSuccessor.id]),
      "all and only visible immutable revisions remain available",
    );
    assert.deepEqual(
      new Set(detail.project.evidenceNoteIds),
      new Set([revision3.id, visibleSuccessor.id]),
      "default project IDs contain revision heads only",
    );
    assert.deepEqual(detail.collections[0].noteIds, [revision3.id]);
    assert.equal(detail.collections[0].evidenceClaimCount, 1);
    assert.equal(detail.collections[0].openQuestionCount, 0);

    const predecessorDto = detail.notes.find((note) => note.id === revision1.id)!;
    assert.equal(predecessorDto.status, "verified");
    assert.ok(predecessorDto.reviewedAt);
    assert.equal(predecessorDto.revision.rootId, revision1.id);
    assert.equal(predecessorDto.revision.number, 1);
    assert.equal(predecessorDto.revision.isLatest, false);
    assert.equal(predecessorDto.revision.nextId, revision2.id);
    const headDto = detail.notes.find((note) => note.id === revision3.id)!;
    assert.equal(headDto.revision.rootId, revision1.id);
    assert.equal(headDto.revision.number, 3);
    assert.equal(headDto.revision.previousId, revision2.id);
    assert.equal(headDto.revision.isLatest, true);

    const visibleSuccessorDto = detail.notes.find((note) => note.id === visibleSuccessor.id)!;
    assert.deepEqual(visibleSuccessorDto.revision, {
      rootId: visibleSuccessor.id,
      number: 1,
      isLatest: true,
    });
    assert.equal(JSON.stringify(detail).includes(privatePredecessor.id), false);

    const bootstrap = await workspaceBootstrap(collaborator, workspaceId, workspaceId);
    assert.equal(JSON.stringify(bootstrap).includes(privatePredecessor.id), false);
    assert.deepEqual(
      new Set(bootstrap.projects.find((project) => project.id === sharedProject.id)?.evidenceNoteIds),
      new Set([revision3.id, visibleSuccessor.id]),
    );
    assert.equal(
      bootstrap.notes.filter((note) => note.revision.isLatest).length,
      2,
    );
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
