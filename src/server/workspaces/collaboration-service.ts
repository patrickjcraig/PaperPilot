import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  isInvitableWorkspaceRole,
  isWorkspaceRole,
  type InvitableWorkspaceRole,
  type WorkspaceRole,
} from "@/lib/workspace-roles";
import { resolveLiveRetainedAuditPrincipal } from "@/server/audit/retained-principal";
import { HttpProblem } from "@/server/http/problem";
import {
  COLLABORATION_SCHEMA_VERSION,
  type CollaborationMutationResult,
  type InvitationInboxDto,
  type InvitationDecisionCommand,
  type WorkspaceCollaboratorsDto,
  type WorkspaceListDto,
  type CreateWorkspaceInvitationCommand,
  type CancelWorkspaceInvitationCommand,
  type WorkspaceRoleUpdateCommand,
  type WorkspaceMemberRemovalCommand,
  invitationRolesFor,
  normalizeCollaborationEmail,
  requireWorkspaceCollaborationManager,
  validateInvitationDecisionCommand,
  validateCreateWorkspaceInvitationCommand,
  validateCancelWorkspaceInvitationCommand,
  validateWorkspaceRoleUpdateCommand,
  validateWorkspaceMemberRemovalCommand,
} from "./collaboration-contract";
import { ensurePersonalWorkspace } from "./authorization";
import {
  acquireWorkspaceMembershipAuthorityExclusive,
  acquireWorkspaceMembershipAuthorityShared,
} from "./membership-lock";

export {
  invitationRolesFor,
  requireWorkspaceCollaborationManager,
} from "./collaboration-contract";

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SERIALIZABLE_ATTEMPTS = 4;
const MAX_USER_WORKSPACES = 100;
const MAX_INVITATION_INBOX = 100;
const MAX_WORKSPACE_MEMBERS = 500;
const MAX_WORKSPACE_PENDING_INVITATIONS = 100;

interface SessionUser {
  id: string;
  name: string;
  email: string;
}

type InvitationResource = {
  invitation: {
    id: string;
    email: string;
    role: InvitableWorkspaceRole;
    status: "pending";
    createdAt: string;
    expiresAt: string;
  };
};

type InvitationCancellationResource = {
  invitation: { id: string; status: "canceled" };
};

type InvitationDecisionResource = {
  invitation: { id: string; status: "accepted" | "rejected" };
  membership?: { workspaceId: string; role: InvitableWorkspaceRole };
};

type RoleUpdateResource = {
  member: { id: string; role: InvitableWorkspaceRole };
};

type MemberRemovalResource = {
  member: { id: string; status: "removed" };
};

export type CreateWorkspaceInvitationResult = CollaborationMutationResult<InvitationResource>;
export type CancelWorkspaceInvitationResult = CollaborationMutationResult<InvitationCancellationResource>;
export type InvitationDecisionResult = CollaborationMutationResult<InvitationDecisionResource>;
export type WorkspaceRoleUpdateResult = CollaborationMutationResult<RoleUpdateResource>;
export type WorkspaceMemberRemovalResult = CollaborationMutationResult<MemberRemovalResource>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(command: string, payload: unknown): string {
  return createHash("sha256")
    .update(stableJson({ command, payload }))
    .digest("hex");
}

function transactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034");
}

async function runSerializableTransaction<T>(
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!transactionConflict(error) || attempt === MAX_SERIALIZABLE_ATTEMPTS - 1) throw error;
    }
  }
  throw lastError;
}

function requireClosedRole(role: string): WorkspaceRole {
  if (!isWorkspaceRole(role)) {
    throw new HttpProblem(
      409,
      "workspace_role_invalid",
      "This workspace has an unsupported membership role.",
    );
  }
  return role;
}

function requireInvitableRole(role: string | null): InvitableWorkspaceRole {
  if (!isInvitableWorkspaceRole(role)) {
    throw new HttpProblem(
      409,
      "invitation_role_invalid",
      "This invitation has an unsupported workspace role.",
    );
  }
  return role;
}

function requireInvitePermission(
  actorRole: WorkspaceRole,
  invitationRole: InvitableWorkspaceRole,
): void {
  if (!invitationRolesFor(actorRole).includes(invitationRole)) {
    throw new HttpProblem(
      403,
      "workspace_forbidden",
      "This workspace role cannot grant the requested role.",
    );
  }
}

function requireTargetManagementPermission(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
): void {
  if (targetRole === "owner") {
    throw new HttpProblem(
      409,
      "owner_membership_protected",
      "Owner membership cannot be transferred, changed, or removed.",
    );
  }
  if (actorRole === "owner") return;
  if (actorRole === "admin" && (targetRole === "member" || targetRole === "viewer")) return;
  throw new HttpProblem(
    403,
    "workspace_forbidden",
    "This workspace role cannot manage that collaborator.",
  );
}

async function lockOperation(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  operationId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`paperpilot:collaboration:v1:${workspaceId}:${operationId}`}, 0)
    )::text
  `);
}

async function lockCollaborationCardinalitySubject(
  transaction: Prisma.TransactionClient,
  kind: "recipient" | "user",
  subject: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`paperpilot:collaboration-cardinality:v1:${kind}:${subject}`}, 0)
    )::text
  `);
}

async function requireActorMembership(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
  const membership = await transaction.member.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId } },
    include: { organization: true },
  });
  if (!membership) {
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }
  return { ...membership, closedRole: requireClosedRole(membership.role) };
}

function idempotencyConflict(): never {
  throw new HttpProblem(
    409,
    "idempotency_conflict",
    "clientOperationId was already used for a different collaboration command.",
  );
}

function replayResult<T extends Record<string, unknown>>(
  response: Prisma.JsonValue | null,
  aggregateVersion: number,
): CollaborationMutationResult<T> {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new HttpProblem(
      409,
      "idempotency_in_progress",
      "The prior collaboration command is still being resolved.",
    );
  }
  const candidate = response as Record<string, unknown>;
  if (candidate.schemaVersion !== COLLABORATION_SCHEMA_VERSION) {
    throw new HttpProblem(
      409,
      "idempotency_schema_mismatch",
      "The prior collaboration result uses an unsupported schema version.",
    );
  }
  return {
    ...candidate,
    schemaVersion: COLLABORATION_SCHEMA_VERSION,
    outcome: "replayed",
    aggregateVersion,
  } as CollaborationMutationResult<T>;
}

async function replayIfPresent<T extends Record<string, unknown>>(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    operationId: string;
    command: string;
    hash: string;
    aggregateVersion: number;
  },
): Promise<CollaborationMutationResult<T> | null> {
  const prior = await transaction.idempotencyRecord.findUnique({
    where: {
      organizationId_key: {
        organizationId: input.workspaceId,
        key: input.operationId,
      },
    },
  });
  if (!prior) return null;
  if (
    prior.actorUserId !== input.actorUserId
    || prior.command !== input.command
    || prior.requestHash !== input.hash
  ) {
    idempotencyConflict();
  }
  return replayResult<T>(prior.response, input.aggregateVersion);
}

async function storeCompletedCommand(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    operationId: string;
    command: string;
    hash: string;
    result: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await transaction.idempotencyRecord.create({
    data: {
      organizationId: input.workspaceId,
      actorUserId: input.actorUserId,
      key: input.operationId,
      command: input.command,
      requestHash: input.hash,
      response: input.result as Prisma.InputJsonValue,
      status: "COMPLETED",
      completedAt: input.now,
      expiresAt: new Date(input.now.getTime() + IDEMPOTENCY_TTL_MS),
    },
  });
}

async function bumpExpectedRevision(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  expectedVersion: number,
): Promise<number> {
  const bumped = await transaction.organization.updateMany({
    where: { id: workspaceId, revision: expectedVersion },
    data: { revision: { increment: 1 } },
  });
  if (bumped.count !== 1) {
    throw new HttpProblem(
      409,
      "version_conflict",
      "Workspace changed since it was loaded. Refresh before retrying.",
    );
  }
  return expectedVersion + 1;
}

async function appendAudit(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    actorPrincipalId: string;
    action: string;
    entityType: string;
    entityId: string;
    requestId: string;
    metadata?: Prisma.InputJsonObject;
  },
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      organizationId: input.workspaceId,
      actorUserId: input.actorUserId,
      actorPrincipalId: input.actorPrincipalId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      requestId: input.requestId,
      metadata: input.metadata,
    },
  });
}

export async function listUserWorkspaces(
  user: SessionUser,
  activeOrganizationId?: string | null,
): Promise<WorkspaceListDto> {
  await ensurePersonalWorkspace({ id: user.id, name: user.name });
  const memberships = await prisma.member.findMany({
    where: { userId: user.id },
    include: {
      organization: { include: { _count: { select: { members: true } } } },
    },
    take: MAX_USER_WORKSPACES + 1,
  });
  if (memberships.length > MAX_USER_WORKSPACES) {
    throw new HttpProblem(409, "workspace_register_limit", "The workspace register exceeds its supported limit.");
  }
  const workspaces = memberships.map((membership) => {
    const role = requireClosedRole(membership.role);
    return {
      id: membership.organization.id,
      name: membership.organization.name,
      kind: membership.organization.personalOwnerId === user.id
        ? "personal" as const
        : "shared" as const,
      role,
      memberCount: membership.organization._count.members,
    };
  }).sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "personal" ? -1 : 1;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
  const activeWorkspaceId = activeOrganizationId
    && workspaces.some((workspace) => workspace.id === activeOrganizationId)
    ? activeOrganizationId
    : workspaces.find((workspace) => workspace.kind === "personal")?.id ?? null;
  return { schemaVersion: COLLABORATION_SCHEMA_VERSION, activeWorkspaceId, workspaces };
}

export async function listInvitationInbox(user: SessionUser): Promise<InvitationInboxDto> {
  const email = normalizeCollaborationEmail(user.email);
  const invitations = await prisma.invitation.findMany({
    where: {
      email: { equals: email, mode: "insensitive" },
      status: "pending",
      expiresAt: { gt: new Date() },
      teamId: null,
    },
    take: MAX_INVITATION_INBOX + 1,
    include: {
      organization: { select: { id: true, name: true } },
      inviter: { select: { name: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (invitations.length > MAX_INVITATION_INBOX) {
    throw new HttpProblem(409, "invitation_register_limit", "The invitation register exceeds its supported limit.");
  }
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION,
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      workspace: invitation.organization,
      inviter: invitation.inviter,
      role: requireInvitableRole(invitation.role),
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
    })),
  };
}

/** Resolve only an invitation belonging to the signed-in email; failures are indistinguishable. */
export async function requireInvitationInboxWorkspace(
  userEmail: string,
  invitationId: string,
): Promise<string> {
  const email = normalizeCollaborationEmail(userEmail);
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, email: { equals: email, mode: "insensitive" }, teamId: null },
    select: { organizationId: true },
  });
  if (!invitation) {
    throw new HttpProblem(404, "invitation_not_found", "Invitation was not found.");
  }
  return invitation.organizationId;
}

export async function getWorkspaceCollaborators(
  user: SessionUser,
  workspaceId: string,
): Promise<WorkspaceCollaboratorsDto> {
  return prisma.$transaction(async (transaction) => {
    const membership = await requireActorMembership(transaction, workspaceId, user.id);
    const currentRole = membership.closedRole;
    const canManageMembers = currentRole === "owner" || currentRole === "admin";
    const revisionRows = await transaction.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
      SELECT organization."revision"
      FROM "public"."Organization" AS organization
      WHERE organization."id" = ${workspaceId}
      FOR SHARE
    `);
    if (revisionRows.length !== 1 || !Number.isSafeInteger(revisionRows[0]?.revision)) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    const [members, pendingInvitations] = await Promise.all([
      transaction.member.findMany({
        where: { organizationId: workspaceId },
        include: { user: { select: { name: true, email: true, emailVerified: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_WORKSPACE_MEMBERS + 1,
      }),
      canManageMembers
        ? transaction.invitation.findMany({
            where: {
              organizationId: workspaceId,
              status: "pending",
              expiresAt: { gt: new Date() },
              teamId: null,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: MAX_WORKSPACE_PENDING_INVITATIONS + 1,
          })
        : Promise.resolve([]),
    ]);
    if (members.length > MAX_WORKSPACE_MEMBERS) {
      throw new HttpProblem(409, "member_register_limit", "The collaborator register exceeds its supported limit.");
    }
    if (pendingInvitations.length > MAX_WORKSPACE_PENDING_INVITATIONS) {
      throw new HttpProblem(409, "invitation_register_limit", "The invitation register exceeds its supported limit.");
    }
    return {
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      workspaceId,
      aggregateVersion: revisionRows[0].revision,
      currentRole,
      capabilities: {
        inviteRoles: invitationRolesFor(currentRole),
        canManageMembers,
      },
      members: members.map((member) => ({
        id: member.id,
        name: member.user.name,
        email: member.user.email,
        emailVerified: member.user.emailVerified,
        role: requireClosedRole(member.role),
        joinedAt: member.createdAt.toISOString(),
        isCurrentUser: member.userId === user.id,
      })),
      pendingInvitations: pendingInvitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: requireInvitableRole(invitation.role),
        createdAt: invitation.createdAt.toISOString(),
        expiresAt: invitation.expiresAt.toISOString(),
      })),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function createWorkspaceInvitation(
  user: SessionUser,
  workspaceId: string,
  rawCommand: unknown,
): Promise<CreateWorkspaceInvitationResult> {
  const command: CreateWorkspaceInvitationCommand = validateCreateWorkspaceInvitationCommand(rawCommand);
  const commandName = "collaboration.invitation.create.v1";
  const hash = requestHash(commandName, { email: command.email, role: command.role });

  return runSerializableTransaction(async (transaction) => {
    const actor = await requireActorMembership(transaction, workspaceId, user.id);
    requireWorkspaceCollaborationManager(actor.closedRole);
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    await lockCollaborationCardinalitySubject(transaction, "recipient", command.email);
    const replay = await replayIfPresent<InvitationResource>(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      aggregateVersion: actor.organization.revision,
    });
    if (replay) return replay;
    if (actor.organization.revision !== command.expectedVersion) {
      throw new HttpProblem(409, "version_conflict", "Workspace changed since it was loaded. Refresh before retrying.");
    }
    requireInvitePermission(actor.closedRole, command.role);

    const recipient = await transaction.user.findFirst({
      where: { email: { equals: command.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (recipient) {
      await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, recipient.id);
      const existingMember = await transaction.member.findUnique({
        where: { organizationId_userId: { organizationId: workspaceId, userId: recipient.id } },
        select: { id: true },
      });
      if (existingMember) {
        throw new HttpProblem(409, "already_a_member", "That recipient already belongs to this workspace.");
      }
    }

    const now = new Date();
    await transaction.invitation.updateMany({
      where: {
        organizationId: workspaceId,
        email: { equals: command.email, mode: "insensitive" },
        status: "pending",
        expiresAt: { lte: now },
      },
      data: { status: "canceled" },
    });
    const duplicate = await transaction.invitation.findFirst({
      where: {
        organizationId: workspaceId,
        email: { equals: command.email, mode: "insensitive" },
        status: "pending",
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new HttpProblem(409, "invitation_pending", "That recipient already has a pending invitation.");
    }
    const [workspacePendingCount, recipientPendingCount] = await Promise.all([
      transaction.invitation.count({
        where: { organizationId: workspaceId, status: "pending", expiresAt: { gt: now } },
      }),
      transaction.invitation.count({
        where: {
          email: { equals: command.email, mode: "insensitive" },
          status: "pending",
          expiresAt: { gt: now },
          teamId: null,
        },
      }),
    ]);
    if (workspacePendingCount >= MAX_WORKSPACE_PENDING_INVITATIONS) {
      throw new HttpProblem(409, "invitation_register_limit", "This workspace has reached its pending invitation limit.");
    }
    if (recipientPendingCount >= MAX_INVITATION_INBOX) {
      throw new HttpProblem(409, "recipient_invitation_limit", "That recipient has reached the pending invitation limit.");
    }

    const aggregateVersion = await bumpExpectedRevision(transaction, workspaceId, command.expectedVersion);
    const actorPrincipal = await resolveLiveRetainedAuditPrincipal(transaction, workspaceId, user.id);
    const invitation = await transaction.invitation.create({
      data: {
        organizationId: workspaceId,
        inviterId: user.id,
        email: command.email,
        role: command.role,
        status: "pending",
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      },
    });
    const result: CreateWorkspaceInvitationResult = {
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      outcome: "applied",
      aggregateVersion,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: command.role,
        status: "pending",
        createdAt: invitation.createdAt.toISOString(),
        expiresAt: invitation.expiresAt.toISOString(),
      },
    };
    await storeCompletedCommand(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      result,
      now,
    });
    await appendAudit(transaction, {
      workspaceId,
      actorUserId: user.id,
      actorPrincipalId: actorPrincipal.id,
      action: "collaboration.invitation.created",
      entityType: "invitation",
      entityId: invitation.id,
      requestId: command.clientOperationId,
      metadata: { role: command.role },
    });
    return result;
  });
}

export async function cancelWorkspaceInvitation(
  user: SessionUser,
  workspaceId: string,
  invitationId: string,
  rawCommand: unknown,
): Promise<CancelWorkspaceInvitationResult> {
  const command: CancelWorkspaceInvitationCommand = validateCancelWorkspaceInvitationCommand(rawCommand);
  const commandName = "collaboration.invitation.cancel.v1";
  const hash = requestHash(commandName, { invitationId });

  return runSerializableTransaction(async (transaction) => {
    const actor = await requireActorMembership(transaction, workspaceId, user.id);
    requireWorkspaceCollaborationManager(actor.closedRole);
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    const replay = await replayIfPresent<InvitationCancellationResource>(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      aggregateVersion: actor.organization.revision,
    });
    if (replay) return replay;
    if (actor.organization.revision !== command.expectedVersion) {
      throw new HttpProblem(409, "version_conflict", "Workspace changed since it was loaded. Refresh before retrying.");
    }
    const invitation = await transaction.invitation.findFirst({
      where: { id: invitationId, organizationId: workspaceId, teamId: null },
    });
    if (!invitation) {
      throw new HttpProblem(404, "invitation_not_found", "Invitation was not found.");
    }
    const invitationRole = requireInvitableRole(invitation.role);
    requireInvitePermission(actor.closedRole, invitationRole);
    if (invitation.status !== "pending") {
      throw new HttpProblem(409, "invitation_not_pending", "Invitation is no longer pending.");
    }
    const now = new Date();
    const aggregateVersion = await bumpExpectedRevision(transaction, workspaceId, command.expectedVersion);
    const actorPrincipal = await resolveLiveRetainedAuditPrincipal(transaction, workspaceId, user.id);
    await transaction.invitation.update({ where: { id: invitation.id }, data: { status: "canceled" } });
    const result: CancelWorkspaceInvitationResult = {
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      outcome: "applied",
      aggregateVersion,
      invitation: { id: invitation.id, status: "canceled" },
    };
    await storeCompletedCommand(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      result,
      now,
    });
    await appendAudit(transaction, {
      workspaceId,
      actorUserId: user.id,
      actorPrincipalId: actorPrincipal.id,
      action: "collaboration.invitation.canceled",
      entityType: "invitation",
      entityId: invitation.id,
      requestId: command.clientOperationId,
      metadata: { role: invitationRole },
    });
    return result;
  });
}

export async function decideWorkspaceInvitation(
  user: SessionUser,
  invitationId: string,
  rawCommand: unknown,
): Promise<InvitationDecisionResult> {
  const command: InvitationDecisionCommand = validateInvitationDecisionCommand(rawCommand);
  const userEmail = normalizeCollaborationEmail(user.email);
  const initial = await prisma.invitation.findFirst({
    where: { id: invitationId, email: { equals: userEmail, mode: "insensitive" }, teamId: null },
    select: { organizationId: true },
  });
  if (!initial) {
    throw new HttpProblem(404, "invitation_not_found", "Invitation was not found.");
  }
  const workspaceId = initial.organizationId;
  const commandName = `collaboration.invitation.${command.decision}.v1`;
  const hash = requestHash(commandName, { invitationId });

  return runSerializableTransaction(async (transaction) => {
    await acquireWorkspaceMembershipAuthorityExclusive(transaction, workspaceId, user.id);
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    await lockCollaborationCardinalitySubject(transaction, "user", user.id);
    const invitation = await transaction.invitation.findFirst({
      where: {
        id: invitationId,
        organizationId: workspaceId,
        email: { equals: userEmail, mode: "insensitive" },
        teamId: null,
      },
      include: { organization: true },
    });
    if (!invitation) {
      throw new HttpProblem(404, "invitation_not_found", "Invitation was not found.");
    }
    const replay = await replayIfPresent<InvitationDecisionResource>(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      aggregateVersion: invitation.organization.revision,
    });
    if (replay) return replay;
    if (invitation.status !== "pending" || invitation.expiresAt <= new Date()) {
      throw new HttpProblem(409, "invitation_not_pending", "Invitation is no longer pending.");
    }
    const invitationRole = requireInvitableRole(invitation.role);
    const inviterMembership = await requireActorMembership(
      transaction,
      workspaceId,
      invitation.inviterId,
    );
    requireInvitePermission(inviterMembership.closedRole, invitationRole);

    const existingMembership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId: user.id } },
      select: { id: true },
    });
    if (existingMembership) {
      throw new HttpProblem(409, "already_a_member", "This account already belongs to the workspace.");
    }
    if (command.decision === "accept") {
      const [workspaceCount, userWorkspaceCount] = await Promise.all([
        transaction.member.count({ where: { organizationId: workspaceId } }),
        transaction.member.count({ where: { userId: user.id } }),
      ]);
      if (workspaceCount >= MAX_WORKSPACE_MEMBERS) {
        throw new HttpProblem(409, "member_register_limit", "This workspace has reached its collaborator limit.");
      }
      if (userWorkspaceCount >= MAX_USER_WORKSPACES) {
        throw new HttpProblem(409, "workspace_register_limit", "This account has reached its workspace limit.");
      }
    }
    const now = new Date();
    const aggregateVersion = await bumpExpectedRevision(
      transaction,
      workspaceId,
      invitation.organization.revision,
    );
    if (command.decision === "accept") {
      await transaction.member.create({
        data: { organizationId: workspaceId, userId: user.id, role: invitationRole },
      });
    }
    const actorPrincipal = await resolveLiveRetainedAuditPrincipal(transaction, workspaceId, user.id);
    const terminalStatus = command.decision === "accept" ? "accepted" as const : "rejected" as const;
    await transaction.invitation.update({
      where: { id: invitation.id },
      data: { status: terminalStatus },
    });
    const result: InvitationDecisionResult = {
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      outcome: "applied",
      aggregateVersion,
      invitation: { id: invitation.id, status: terminalStatus },
      ...(command.decision === "accept"
        ? { membership: { workspaceId, role: invitationRole } }
        : {}),
    };
    await storeCompletedCommand(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      result,
      now,
    });
    await appendAudit(transaction, {
      workspaceId,
      actorUserId: user.id,
      actorPrincipalId: actorPrincipal.id,
      action: `collaboration.invitation.${terminalStatus}`,
      entityType: "invitation",
      entityId: invitation.id,
      requestId: command.clientOperationId,
      metadata: { role: invitationRole },
    });
    return result;
  });
}

export async function updateWorkspaceMemberRole(
  user: SessionUser,
  workspaceId: string,
  memberId: string,
  rawCommand: unknown,
): Promise<WorkspaceRoleUpdateResult> {
  const command: WorkspaceRoleUpdateCommand = validateWorkspaceRoleUpdateCommand(rawCommand);
  const commandName = "collaboration.member.role.update.v1";
  const hash = requestHash(commandName, { memberId, role: command.role });

  return runSerializableTransaction(async (transaction) => {
    const actor = await requireActorMembership(transaction, workspaceId, user.id);
    requireWorkspaceCollaborationManager(actor.closedRole);
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    const replay = await replayIfPresent<RoleUpdateResource>(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      aggregateVersion: actor.organization.revision,
    });
    if (replay) return replay;
    if (actor.organization.revision !== command.expectedVersion) {
      throw new HttpProblem(409, "version_conflict", "Workspace changed since it was loaded. Refresh before retrying.");
    }
    const initialTarget = await transaction.member.findFirst({
      where: { id: memberId, organizationId: workspaceId },
      select: { userId: true },
    });
    if (!initialTarget) {
      throw new HttpProblem(404, "member_not_found", "Collaborator was not found.");
    }
    if (initialTarget.userId === user.id) {
      throw new HttpProblem(409, "self_membership_protected", "Use another owner to change your membership.");
    }
    await acquireWorkspaceMembershipAuthorityExclusive(transaction, workspaceId, initialTarget.userId);
    const target = await transaction.member.findFirst({
      where: { id: memberId, organizationId: workspaceId, userId: initialTarget.userId },
    });
    if (!target) {
      throw new HttpProblem(404, "member_not_found", "Collaborator was not found.");
    }
    const targetRole = requireClosedRole(target.role);
    requireTargetManagementPermission(actor.closedRole, targetRole);
    if (actor.closedRole === "admin" && command.role === "admin") {
      throw new HttpProblem(403, "workspace_forbidden", "Administrators cannot grant the administrator role.");
    }
    const now = new Date();
    const aggregateVersion = await bumpExpectedRevision(transaction, workspaceId, command.expectedVersion);
    const actorPrincipal = await resolveLiveRetainedAuditPrincipal(transaction, workspaceId, user.id);
    await transaction.member.update({ where: { id: target.id }, data: { role: command.role } });
    const result: WorkspaceRoleUpdateResult = {
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      outcome: "applied",
      aggregateVersion,
      member: { id: target.id, role: command.role },
    };
    await storeCompletedCommand(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      result,
      now,
    });
    await appendAudit(transaction, {
      workspaceId,
      actorUserId: user.id,
      actorPrincipalId: actorPrincipal.id,
      action: "collaboration.member.role.updated",
      entityType: "member",
      entityId: target.id,
      requestId: command.clientOperationId,
      metadata: { previousRole: targetRole, role: command.role },
    });
    return result;
  });
}

export async function removeWorkspaceMember(
  user: SessionUser,
  workspaceId: string,
  memberId: string,
  rawCommand: unknown,
): Promise<WorkspaceMemberRemovalResult> {
  const command: WorkspaceMemberRemovalCommand = validateWorkspaceMemberRemovalCommand(rawCommand);
  const commandName = "collaboration.member.remove.v1";
  const hash = requestHash(commandName, { memberId, confirmation: command.confirmation });

  return runSerializableTransaction(async (transaction) => {
    const actor = await requireActorMembership(transaction, workspaceId, user.id);
    requireWorkspaceCollaborationManager(actor.closedRole);
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    const replay = await replayIfPresent<MemberRemovalResource>(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      aggregateVersion: actor.organization.revision,
    });
    if (replay) return replay;
    if (actor.organization.revision !== command.expectedVersion) {
      throw new HttpProblem(409, "version_conflict", "Workspace changed since it was loaded. Refresh before retrying.");
    }
    const initialTarget = await transaction.member.findFirst({
      where: { id: memberId, organizationId: workspaceId },
      select: { userId: true },
    });
    if (!initialTarget) {
      throw new HttpProblem(404, "member_not_found", "Collaborator was not found.");
    }
    if (initialTarget.userId === user.id) {
      throw new HttpProblem(409, "self_membership_protected", "Use another owner to remove your membership.");
    }
    await acquireWorkspaceMembershipAuthorityExclusive(transaction, workspaceId, initialTarget.userId);
    const target = await transaction.member.findFirst({
      where: { id: memberId, organizationId: workspaceId, userId: initialTarget.userId },
    });
    if (!target) {
      throw new HttpProblem(404, "member_not_found", "Collaborator was not found.");
    }
    const targetRole = requireClosedRole(target.role);
    requireTargetManagementPermission(actor.closedRole, targetRole);
    const privateProjectCount = await transaction.project.count({
      where: {
        organizationId: workspaceId,
        createdById: target.userId,
        visibility: "PRIVATE",
      },
    });
    if (privateProjectCount > 0) {
      throw new HttpProblem(
        409,
        "private_projects_require_reassignment",
        "Reassign or delete this collaborator's private projects before removal.",
      );
    }
    const now = new Date();
    const aggregateVersion = await bumpExpectedRevision(transaction, workspaceId, command.expectedVersion);
    const actorPrincipal = await resolveLiveRetainedAuditPrincipal(transaction, workspaceId, user.id);
    const canceled = await transaction.invitation.updateMany({
      where: { organizationId: workspaceId, inviterId: target.userId, status: "pending" },
      data: { status: "canceled" },
    });
    await transaction.session.updateMany({
      where: { userId: target.userId, activeOrganizationId: workspaceId },
      data: { activeOrganizationId: null, activeTeamId: null },
    });
    await transaction.member.delete({ where: { id: target.id } });
    const result: WorkspaceMemberRemovalResult = {
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      outcome: "applied",
      aggregateVersion,
      member: { id: target.id, status: "removed" },
    };
    await storeCompletedCommand(transaction, {
      workspaceId,
      actorUserId: user.id,
      operationId: command.clientOperationId,
      command: commandName,
      hash,
      result,
      now,
    });
    await appendAudit(transaction, {
      workspaceId,
      actorUserId: user.id,
      actorPrincipalId: actorPrincipal.id,
      action: "collaboration.member.removed",
      entityType: "member",
      entityId: target.id,
      requestId: command.clientOperationId,
      metadata: { previousRole: targetRole, canceledInvitationCount: canceled.count },
    });
    return result;
  });
}
