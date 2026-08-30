import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import {
  cancelWorkspaceInvitation,
  createWorkspaceInvitation,
  decideWorkspaceInvitation,
  getWorkspaceCollaborators,
  listInvitationInbox,
  listUserWorkspaces,
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
} from "./collaboration-service";

after(async () => {
  await prisma.$disconnect();
});

function command(operation: string, expectedVersion: number) {
  return {
    schemaVersion: 1 as const,
    clientOperationId: operation,
    expectedVersion,
  };
}

function problem(status: number, code: string) {
  return (error: unknown) =>
    error instanceof HttpProblem && error.status === status && error.code === code;
}

test("collaboration lifecycle is tenant-safe, replay-safe, audited, and owner protected", async () => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({
    data: {
      id: `collaboration-owner-${suffix}`,
      name: "Collaboration Owner",
      email: `collaboration-owner-${suffix}@example.test`,
      emailVerified: true,
    },
  });
  const admin = await prisma.user.create({
    data: {
      id: `collaboration-admin-${suffix}`,
      name: "Collaboration Admin",
      email: `collaboration-admin-${suffix}@example.test`,
      emailVerified: true,
    },
  });
  const member = await prisma.user.create({
    data: {
      id: `collaboration-member-${suffix}`,
      name: "Collaboration Member",
      email: `collaboration-member-${suffix}@example.test`,
      emailVerified: true,
    },
  });
  const rejectUser = await prisma.user.create({
    data: {
      id: `collaboration-reject-${suffix}`,
      name: "Collaboration Rejector",
      email: `collaboration-reject-${suffix}@example.test`,
      emailVerified: true,
    },
  });
  let workspaceId: string | undefined;

  try {
    const directory = await listUserWorkspaces(owner, null);
    assert.equal(directory.schemaVersion, 1);
    assert.equal(directory.workspaces.length, 1);
    assert.equal(directory.workspaces[0]?.kind, "personal");
    assert.equal(directory.workspaces[0]?.role, "owner");
    workspaceId = directory.workspaces[0]?.id;
    assert.ok(workspaceId);

    const adminInviteCommand = {
      ...command("collaboration-invite-admin", 0),
      email: `  ${admin.email.toUpperCase()}  `,
      role: "admin" as const,
    };
    const adminInvite = await createWorkspaceInvitation(owner, workspaceId, adminInviteCommand);
    assert.equal(adminInvite.outcome, "applied");
    assert.equal(adminInvite.aggregateVersion, 1);
    assert.equal(adminInvite.invitation.email, admin.email);
    assert.deepEqual(
      Object.keys(adminInvite).sort(),
      ["aggregateVersion", "invitation", "outcome", "schemaVersion"],
    );

    const replay = await createWorkspaceInvitation(owner, workspaceId, adminInviteCommand);
    assert.equal(replay.outcome, "replayed");
    assert.equal(replay.invitation.id, adminInvite.invitation.id);
    assert.equal(replay.aggregateVersion, 1);
    await assert.rejects(
      createWorkspaceInvitation(owner, workspaceId, {
        ...adminInviteCommand,
        clientOperationId: "collaboration-invite-admin-duplicate",
        expectedVersion: 1,
      }),
      problem(409, "invitation_pending"),
    );

    const inbox = await listInvitationInbox(admin);
    assert.equal(inbox.invitations.length, 1);
    assert.equal(inbox.invitations[0]?.id, adminInvite.invitation.id);
    assert.equal("email" in (inbox.invitations[0] ?? {}), false);

    const acceptedAdmin = await decideWorkspaceInvitation(admin, adminInvite.invitation.id, {
      schemaVersion: 1,
      clientOperationId: "collaboration-accept-admin",
      decision: "accept",
    });
    assert.equal(acceptedAdmin.aggregateVersion, 2);
    assert.equal(acceptedAdmin.invitation.status, "accepted");
    assert.deepEqual(acceptedAdmin.membership, { workspaceId, role: "admin" });
    const acceptedReplay = await decideWorkspaceInvitation(admin, adminInvite.invitation.id, {
      schemaVersion: 1,
      clientOperationId: "collaboration-accept-admin",
      decision: "accept",
    });
    assert.equal(acceptedReplay.outcome, "replayed");
    assert.equal(acceptedReplay.aggregateVersion, 2);

    await assert.rejects(
      createWorkspaceInvitation(admin, workspaceId, {
        ...command("collaboration-admin-cannot-grant-admin", 2),
        email: `blocked-${suffix}@example.test`,
        role: "admin",
      }),
      problem(403, "workspace_forbidden"),
    );

    const memberInvite = await createWorkspaceInvitation(admin, workspaceId, {
      ...command("collaboration-invite-member", 2),
      email: member.email,
      role: "member",
    });
    assert.equal(memberInvite.aggregateVersion, 3);
    const acceptedMember = await decideWorkspaceInvitation(member, memberInvite.invitation.id, {
      schemaVersion: 1,
      clientOperationId: "collaboration-accept-member",
      decision: "accept",
    });
    assert.equal(acceptedMember.aggregateVersion, 4);

    let collaborators = await getWorkspaceCollaborators(owner, workspaceId);
    assert.equal(collaborators.workspaceId, workspaceId);
    const ownerMember = collaborators.members.find((entry) => entry.isCurrentUser);
    const memberEntry = collaborators.members.find((entry) => entry.email === member.email);
    assert.ok(ownerMember);
    assert.ok(memberEntry);
    assert.deepEqual(collaborators.capabilities.inviteRoles, ["admin", "member", "viewer"]);

    const roleUpdated = await updateWorkspaceMemberRole(
      admin,
      workspaceId,
      memberEntry.id,
      { ...command("collaboration-member-viewer", 4), role: "viewer" },
    );
    assert.equal(roleUpdated.aggregateVersion, 5);
    assert.equal(roleUpdated.member.role, "viewer");

    const privateProject = await prisma.project.create({
      data: {
        organizationId: workspaceId,
        name: "Removal preflight project",
        slug: `collaboration-private-${suffix}`,
        visibility: "PRIVATE",
        createdById: member.id,
      },
    });
    await assert.rejects(
      removeWorkspaceMember(admin, workspaceId, memberEntry.id, {
        ...command("collaboration-remove-blocked", 5),
        confirmation: "REMOVE_MEMBER",
      }),
      problem(409, "private_projects_require_reassignment"),
    );
    await prisma.project.delete({ where: { id: privateProject.id } });
    const removed = await removeWorkspaceMember(admin, workspaceId, memberEntry.id, {
      ...command("collaboration-remove-member", 5),
      confirmation: "REMOVE_MEMBER",
    });
    assert.equal(removed.aggregateVersion, 6);
    assert.equal(removed.member.status, "removed");

    const canceledInvite = await createWorkspaceInvitation(owner, workspaceId, {
      ...command("collaboration-invite-cancel", 6),
      email: `cancel-${suffix}@example.test`,
      role: "viewer",
    });
    const canceled = await cancelWorkspaceInvitation(
      owner,
      workspaceId,
      canceledInvite.invitation.id,
      command("collaboration-cancel", 7),
    );
    assert.equal(canceled.aggregateVersion, 8);
    assert.equal(canceled.invitation.status, "canceled");

    const rejectedInvite = await createWorkspaceInvitation(owner, workspaceId, {
      ...command("collaboration-invite-reject", 8),
      email: rejectUser.email,
      role: "viewer",
    });
    const rejected = await decideWorkspaceInvitation(rejectUser, rejectedInvite.invitation.id, {
      schemaVersion: 1,
      clientOperationId: "collaboration-reject",
      decision: "reject",
    });
    assert.equal(rejected.aggregateVersion, 10);
    assert.equal(rejected.invitation.status, "rejected");
    assert.equal(rejected.membership, undefined);

    collaborators = await getWorkspaceCollaborators(admin, workspaceId);
    assert.deepEqual(collaborators.capabilities.inviteRoles, ["member", "viewer"]);
    await assert.rejects(
      updateWorkspaceMemberRole(admin, workspaceId, ownerMember.id, {
        ...command("collaboration-owner-protected", 10),
        role: "member",
      }),
      problem(409, "owner_membership_protected"),
    );

    await assert.rejects(
      prisma.member.delete({ where: { id: ownerMember.id } }),
      () => true,
      "the deferred database guard must reject removal of the personal/last owner",
    );
    assert.ok(await prisma.member.findUnique({ where: { id: ownerMember.id } }));

    await assert.rejects(
      prisma.invitation.create({
        data: {
          organizationId: workspaceId,
          inviterId: owner.id,
          email: `Upper-${suffix}@example.test`,
          role: "member",
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
      () => true,
      "the database must reject non-normalized invitation recipients",
    );

    const auditActions = await prisma.auditEvent.findMany({
      where: { organizationId: workspaceId, action: { startsWith: "collaboration." } },
      select: { action: true, actorPrincipalId: true, requestId: true },
    });
    assert.ok(auditActions.length >= 8);
    assert.ok(auditActions.every((event) => event.actorPrincipalId && event.requestId));
    assert.equal(
      await prisma.idempotencyRecord.count({
        where: { organizationId: workspaceId, command: { startsWith: "collaboration." } },
      }),
      auditActions.length,
    );
  } finally {
    if (workspaceId) {
      await prisma.auditEvent.deleteMany({ where: { organizationId: workspaceId } });
      await prisma.retainedAuditPrincipal.deleteMany({ where: { organizationId: workspaceId } });
      await prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({
      where: { id: { in: [owner.id, admin.id, member.id, rejectUser.id] } },
    });
  }
});
