import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { CreateProjectCommand } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { createWorkspaceProject, workspaceBootstrap, workspaceProject } from "./service";

after(async () => {
  await prisma.$disconnect();
});

function command(
  operationId: string,
  expectedVersion: number,
  name: string,
): CreateProjectCommand {
  return {
    clientOperationId: operationId,
    expectedVersion,
    project: {
      name,
      question: `Which source-grounded findings belong in ${name}?`,
      description: "Created by the authenticated workspace integration test.",
      type: "literature-review",
      visibility: "private",
    },
  };
}

test("authenticated workspace projects are durable, replay-safe, concurrent, and tenant-isolated", async () => {
  const suffix = randomUUID();
  const userA = await prisma.user.create({
    data: {
      id: `test-user-a-${suffix}`,
      name: "Workspace Test A",
      email: `workspace-a-${suffix}@example.test`,
    },
  });
  const userB = await prisma.user.create({
    data: {
      id: `test-user-b-${suffix}`,
      name: "Workspace Test B",
      email: `workspace-b-${suffix}@example.test`,
    },
  });

  let workspaceId: string | undefined;
  try {
    const initial = await workspaceBootstrap(userA);
    workspaceId = initial.workspace.id;
    assert.equal(initial.workspace.mode, "live");
    assert.equal(initial.aggregateVersion, 0);
    assert.equal(initial.projects.length, 0);

    const create = command("integration-create-project", 0, "Durable evidence map");
    const concurrentWorkspaceId = workspaceId;
    const simultaneousRetries = await Promise.all(
      Array.from({ length: 12 }, () =>
        createWorkspaceProject(userA, concurrentWorkspaceId, create)),
    );
    assert.equal(
      simultaneousRetries.filter((result) => result.ok && result.outcome === "applied").length,
      1,
      "one simultaneous project command applies",
    );
    assert.equal(
      simultaneousRetries.filter((result) => result.ok && result.outcome === "replayed").length,
      11,
      "all simultaneous retries replay the committed project",
    );
    const successfulProjectIds = simultaneousRetries.flatMap((result) =>
      result.ok ? [result.data.project.id] : []);
    assert.equal(new Set(successfulProjectIds).size, 1);
    const applied = simultaneousRetries.find(
      (result) => result.ok && result.outcome === "applied",
    );
    assert.ok(applied?.ok);
    if (!applied?.ok) return;
    assert.equal(applied.ok, true);
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.aggregateVersion, 1);

    const replayed = await createWorkspaceProject(userA, workspaceId, create);
    assert.equal(replayed.ok, true);
    if (replayed.ok) {
      assert.equal(replayed.outcome, "replayed");
      assert.equal(replayed.data.project.id, applied.data.project.id);
      assert.equal(replayed.aggregateVersion, 1);
    }

    const idempotencyConflict = await createWorkspaceProject(userA, workspaceId, {
      ...create,
      project: { ...create.project, name: "Different intent" },
    });
    assert.equal(idempotencyConflict.ok, false);
    if (!idempotencyConflict.ok) {
      assert.equal(idempotencyConflict.code, "idempotency_conflict");
    }

    const stale = await createWorkspaceProject(
      userA,
      workspaceId,
      command("integration-stale-project", 0, "Stale project"),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.code, "version_conflict");
      assert.equal(stale.aggregateVersion, 1);
    }

    const concurrent = await Promise.all([
      createWorkspaceProject(
        userA,
        workspaceId,
        command("integration-concurrent-a", 1, "Concurrent project A"),
      ),
      createWorkspaceProject(
        userA,
        workspaceId,
        command("integration-concurrent-b", 1, "Concurrent project B"),
      ),
    ]);
    assert.equal(concurrent.filter((result) => result.ok).length, 1);
    assert.equal(
      concurrent.filter((result) => !result.ok && result.code === "version_conflict").length,
      1,
    );

    const restored = await workspaceBootstrap(userA, null, workspaceId);
    assert.equal(restored.aggregateVersion, 2);
    assert.equal(restored.projects.length, 2);
    assert.ok(restored.projects.some((project) => project.id === applied.data.project.id));

    await assert.rejects(
      createWorkspaceProject(
        userB,
        workspaceId,
        command("integration-cross-tenant", 2, "Forbidden project"),
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 404
        && error.code === "workspace_not_found",
    );

    const memberB = await prisma.member.create({
      data: {
        organizationId: workspaceId,
        userId: userB.id,
        role: "member",
      },
    });
    const sharedCommand = command(
      "integration-shared-project",
      restored.aggregateVersion,
      "Shared evidence map",
    );
    sharedCommand.project.visibility = "workspace";
    const shared = await createWorkspaceProject(userA, workspaceId, sharedCommand);
    assert.equal(shared.ok, true);
    if (!shared.ok) return;

    const ownerPrivateDetail = await workspaceProject(userA, workspaceId, applied.data.project.id);
    assert.equal(ownerPrivateDetail?.project.id, applied.data.project.id);
    assert.equal(ownerPrivateDetail?.aggregateVersion, shared.aggregateVersion);

    const hiddenPrivateDetail = await workspaceProject(userB, workspaceId, applied.data.project.id);
    assert.equal(
      hiddenPrivateDetail,
      null,
      "a hidden project must be non-enumerating even for another workspace member",
    );

    const collaboratorSharedDetail = await workspaceProject(userB, workspaceId, shared.data.project.id);
    assert.equal(collaboratorSharedDetail?.project.id, shared.data.project.id);
    assert.equal(collaboratorSharedDetail?.project.visibility, "workspace");

    const collaboratorView = await workspaceBootstrap(userB, null, workspaceId);
    assert.deepEqual(
      collaboratorView.projects.map((project) => project.id),
      [shared.data.project.id],
      "collaborators must not receive another researcher's private projects",
    );

    await prisma.member.update({
      where: { id: memberB.id },
      data: { role: "viewer" },
    });
    await assert.rejects(
      createWorkspaceProject(
        userB,
        workspaceId,
        command("integration-viewer-write", shared.aggregateVersion, "Viewer write"),
      ),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 403
        && error.code === "workspace_forbidden",
    );
  } finally {
    if (workspaceId) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: workspaceId } });
      await prisma.organization.deleteMany({ where: { id: workspaceId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  }
});
