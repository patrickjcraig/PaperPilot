import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { CreateCollectionCommand, CreateProjectCommand } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { createWorkspaceCollection } from "./collection-service";
import { createWorkspaceProject, workspaceBootstrap } from "./service";

after(async () => {
  await prisma.$disconnect();
});

function projectCommand(
  operationId: string,
  expectedVersion: number,
  name: string,
  visibility: "private" | "workspace",
): CreateProjectCommand {
  return {
    clientOperationId: operationId,
    expectedVersion,
    project: {
      name,
      question: `Which source-grounded findings belong in ${name}?`,
      description: "Collection integration-test destination.",
      type: "literature-review",
      visibility,
    },
  };
}

function collectionCommand(
  operationId: string,
  expectedVersion: number,
  projectId: string,
  name = "Outcome claims",
): CreateCollectionCommand {
  return {
    clientOperationId: operationId,
    expectedVersion,
    projectId,
    name,
    description: "Claims grouped by measured outcome.",
    color: "teal",
  };
}

test("collection creation is atomic, replay-safe, project-visible, and tenant-isolated", async () => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({
    data: {
      id: `collection-owner-${suffix}`,
      name: "Collection Owner",
      email: `collection-owner-${suffix}@example.test`,
    },
  });
  const collaborator = await prisma.user.create({
    data: {
      id: `collection-member-${suffix}`,
      name: "Collection Collaborator",
      email: `collection-member-${suffix}@example.test`,
    },
  });
  const outsider = await prisma.user.create({
    data: {
      id: `collection-outsider-${suffix}`,
      name: "Collection Outsider",
      email: `collection-outsider-${suffix}@example.test`,
    },
  });

  let workspaceId: string | undefined;
  let outsiderWorkspaceId: string | undefined;
  try {
    const initial = await workspaceBootstrap(owner);
    workspaceId = initial.workspace.id;
    const privateProjectResult = await createWorkspaceProject(
      owner,
      workspaceId,
      projectCommand("collection-private-project", 0, "Private collection project", "private"),
    );
    assert.equal(privateProjectResult.ok, true);
    if (!privateProjectResult.ok) return;
    const sharedProjectResult = await createWorkspaceProject(
      owner,
      workspaceId,
      projectCommand(
        "collection-shared-project",
        privateProjectResult.aggregateVersion,
        "Shared collection project",
        "workspace",
      ),
    );
    assert.equal(sharedProjectResult.ok, true);
    if (!sharedProjectResult.ok) return;

    await prisma.member.create({
      data: {
        organizationId: workspaceId,
        userId: collaborator.id,
        role: "member",
      },
    });

    const command = collectionCommand(
      "collection-create-applied",
      sharedProjectResult.aggregateVersion,
      sharedProjectResult.data.project.id,
    );
    const applied = await createWorkspaceCollection(owner, workspaceId, command);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.aggregateVersion, sharedProjectResult.aggregateVersion + 1);
    assert.equal(applied.data.projectId, sharedProjectResult.data.project.id);
    assert.deepEqual(
      Object.keys(applied.data.collection).sort(),
      [
        "color",
        "description",
        "evidenceClaimCount",
        "id",
        "name",
        "noteIds",
        "openQuestionCount",
        "paperIds",
        "updatedAt",
      ],
      "the response must expose the tenant-safe collection DTO only",
    );

    const concurrentCommand = collectionCommand(
      "collection-create-concurrent",
      applied.aggregateVersion,
      sharedProjectResult.data.project.id,
      "Concurrent retry",
    );
    const concurrentWorkspaceId = workspaceId;
    const concurrent = await Promise.all(
      Array.from({ length: 12 }, () =>
        createWorkspaceCollection(owner, concurrentWorkspaceId, concurrentCommand)),
    );
    assert.equal(
      concurrent.filter((result) => result.ok && result.outcome === "applied").length,
      1,
      "exactly one concurrent command applies",
    );
    assert.equal(
      concurrent.filter((result) => result.ok && result.outcome === "replayed").length,
      11,
      "all concurrent retries replay the committed receipt",
    );
    const concurrentIds = concurrent.flatMap((result) =>
      result.ok ? [result.data.collection.id] : []);
    assert.equal(new Set(concurrentIds).size, 1);

    const afterConcurrent = concurrent[0];
    assert.equal(afterConcurrent.ok, true);
    if (!afterConcurrent.ok) return;

    const replayed = await createWorkspaceCollection(owner, workspaceId, command);
    assert.equal(replayed.ok, true);
    if (replayed.ok) {
      assert.equal(replayed.outcome, "replayed");
      assert.equal(replayed.data.collection.id, applied.data.collection.id);
      assert.equal(
        replayed.aggregateVersion,
        afterConcurrent.aggregateVersion,
        "a historical receipt carries the current workspace version",
      );
    }

    const changedPayload = await createWorkspaceCollection(owner, workspaceId, {
      ...command,
      name: "Different intent",
    });
    assert.equal(changedPayload.ok, false);
    if (!changedPayload.ok) assert.equal(changedPayload.code, "idempotency_conflict");

    const stale = await createWorkspaceCollection(owner, workspaceId, collectionCommand(
      "collection-create-stale",
      sharedProjectResult.aggregateVersion,
      sharedProjectResult.data.project.id,
      "Stale collection",
    ));
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "version_conflict");

    const duplicate = await createWorkspaceCollection(owner, workspaceId, collectionCommand(
      "collection-create-duplicate",
      afterConcurrent.aggregateVersion,
      sharedProjectResult.data.project.id,
      "  OUTCOME CLAIMS  ",
    ));
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.code, "duplicate");
    assert.equal(await prisma.collection.count({
      where: {
        organizationId: workspaceId,
        projectId: sharedProjectResult.data.project.id,
        parentId: null,
        name: { equals: "Outcome claims", mode: "insensitive" },
      },
    }), 1, "nullable parent ids must not permit duplicate root collections");

    const hiddenPrivate = await createWorkspaceCollection(
      collaborator,
      workspaceId,
      collectionCommand(
        "collection-create-hidden-private",
        afterConcurrent.aggregateVersion,
        privateProjectResult.data.project.id,
        "Cannot see this",
      ),
    );
    assert.equal(hiddenPrivate.ok, false);
    if (!hiddenPrivate.ok) assert.equal(hiddenPrivate.code, "not_found");

    const memberApplied = await createWorkspaceCollection(
      collaborator,
      workspaceId,
      collectionCommand(
        "collection-create-member",
        afterConcurrent.aggregateVersion,
        sharedProjectResult.data.project.id,
        "Member synthesis",
      ),
    );
    assert.equal(memberApplied.ok, true);
    if (!memberApplied.ok) return;

    await prisma.member.update({
      where: {
        organizationId_userId: {
          organizationId: workspaceId,
          userId: collaborator.id,
        },
      },
      data: { role: "viewer" },
    });
    await assert.rejects(
      createWorkspaceCollection(
        collaborator,
        workspaceId,
        collectionCommand(
          "collection-create-viewer",
          memberApplied.aggregateVersion,
          sharedProjectResult.data.project.id,
          "Viewer cannot create",
        ),
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 403
        && error.code === "workspace_forbidden",
    );

    const outsiderBootstrap = await workspaceBootstrap(outsider);
    outsiderWorkspaceId = outsiderBootstrap.workspace.id;
    const outsiderProject = await createWorkspaceProject(
      outsider,
      outsiderWorkspaceId,
      projectCommand("collection-outsider-project", 0, "Outsider project", "workspace"),
    );
    assert.equal(outsiderProject.ok, true);
    if (!outsiderProject.ok) return;

    const foreignProject = await createWorkspaceCollection(
      owner,
      workspaceId,
      collectionCommand(
        "collection-create-foreign-project",
        memberApplied.aggregateVersion,
        outsiderProject.data.project.id,
        "Foreign project collection",
      ),
    );
    assert.equal(foreignProject.ok, false);
    if (!foreignProject.ok) assert.equal(foreignProject.code, "not_found");

    await assert.rejects(
      createWorkspaceCollection(
        outsider,
        workspaceId,
        collectionCommand(
          "collection-create-cross-tenant",
          memberApplied.aggregateVersion,
          sharedProjectResult.data.project.id,
          "Cross tenant collection",
        ),
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 404
        && error.code === "workspace_not_found",
    );

    const audit = await prisma.auditEvent.findFirst({
      where: {
        organizationId: workspaceId,
        action: "collection.created",
        entityId: applied.data.collection.id,
      },
    });
    assert.equal(audit?.actorUserId, owner.id);
    assert.equal(audit?.requestId, command.clientOperationId);
  } finally {
    const workspaceIds = [workspaceId, outsiderWorkspaceId].filter(
      (value): value is string => Boolean(value),
    );
    if (workspaceIds.length) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: { in: workspaceIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    await prisma.user.deleteMany({
      where: { id: { in: [owner.id, collaborator.id, outsider.id] } },
    });
  }
});
