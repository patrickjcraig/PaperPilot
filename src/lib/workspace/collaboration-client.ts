"use client";

import type {
  CancelWorkspaceInvitationResponse,
  CancelWorkspaceInvitationCommand,
  CreateWorkspaceInvitationCommand,
  CreateWorkspaceInvitationResponse,
  InvitationDecisionCommand,
  InvitationDecisionResponse,
  PendingWorkspaceInvitationDto,
  ReceivedWorkspaceInvitationDto,
  ReceivedWorkspaceInvitationsDto,
  RemoveWorkspaceMemberCommand,
  RemoveWorkspaceMemberResponse,
  UpdateWorkspaceMemberRoleCommand,
  UpdateWorkspaceMemberRoleResponse,
  WorkspaceCollaboratorDto,
  WorkspaceCollaboratorsDto,
  WorkspaceActivationResponse,
  WorkspaceDirectoryDto,
  WorkspaceSummaryDto,
} from "./collaboration-contracts";
import {
  isInvitableWorkspaceRole,
  isWorkspaceRole,
} from "@/lib/workspace-roles";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROHIBITED_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function requiredOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !PROHIBITED_TEXT_PATTERN.test(value);
}

function isEmail(value: unknown): value is string {
  return isText(value, 254)
    && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function workspaceSummary(value: unknown): WorkspaceSummaryDto | null {
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "kind", "role", "memberCount"])) {
    return null;
  }
  if (
    !isId(value.id)
    || !isText(value.name, 160)
    || (value.kind !== "personal" && value.kind !== "shared")
    || !isWorkspaceRole(value.role)
    || !Number.isSafeInteger(value.memberCount)
    || Number(value.memberCount) < 1
  ) return null;
  return value as unknown as WorkspaceSummaryDto;
}

function receivedInvitation(value: unknown): ReceivedWorkspaceInvitationDto | null {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "workspace", "inviter", "role", "createdAt", "expiresAt",
  ])) return null;
  if (
    !isRecord(value.workspace)
    || !exactKeys(value.workspace, ["id", "name"])
    || !isRecord(value.inviter)
    || !exactKeys(value.inviter, ["name"])
    || !isId(value.id)
    || !isId(value.workspace.id)
    || !isText(value.workspace.name, 160)
    || !isText(value.inviter.name, 120)
    || !isInvitableWorkspaceRole(value.role)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.expiresAt)
  ) return null;
  return value as unknown as ReceivedWorkspaceInvitationDto;
}

function collaborator(value: unknown): WorkspaceCollaboratorDto | null {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "name", "email", "emailVerified", "role", "joinedAt", "isCurrentUser",
  ])) return null;
  if (
    !isId(value.id)
    || !isText(value.name, 120)
    || !isEmail(value.email)
    || typeof value.emailVerified !== "boolean"
    || !isWorkspaceRole(value.role)
    || !isTimestamp(value.joinedAt)
    || typeof value.isCurrentUser !== "boolean"
  ) return null;
  return value as unknown as WorkspaceCollaboratorDto;
}

function pendingInvitation(value: unknown): PendingWorkspaceInvitationDto | null {
  if (!isRecord(value) || !exactKeys(value, ["id", "email", "role", "createdAt", "expiresAt"])) {
    return null;
  }
  if (
    !isId(value.id)
    || !isEmail(value.email)
    || !isInvitableWorkspaceRole(value.role)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.expiresAt)
  ) return null;
  return value as unknown as PendingWorkspaceInvitationDto;
}

export function decodeWorkspaceDirectory(value: unknown): WorkspaceDirectoryDto | null {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "activeWorkspaceId", "workspaces"])) {
    return null;
  }
  if (
    value.schemaVersion !== 1
    || (value.activeWorkspaceId !== null && !isId(value.activeWorkspaceId))
    || !Array.isArray(value.workspaces)
    || value.workspaces.length > 100
  ) return null;
  const workspaces = value.workspaces.map(workspaceSummary);
  if (workspaces.some((workspace) => workspace === null)) return null;
  const ids = workspaces.map((workspace) => workspace!.id);
  if (new Set(ids).size !== ids.length) return null;
  if (value.activeWorkspaceId !== null && !ids.includes(value.activeWorkspaceId)) return null;
  return { ...value, workspaces: workspaces as WorkspaceSummaryDto[] } as WorkspaceDirectoryDto;
}

export function decodeReceivedInvitations(value: unknown): ReceivedWorkspaceInvitationsDto | null {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "invitations"])) return null;
  if (value.schemaVersion !== 1 || !Array.isArray(value.invitations) || value.invitations.length > 100) {
    return null;
  }
  const invitations = value.invitations.map(receivedInvitation);
  if (invitations.some((invitation) => invitation === null)) return null;
  const ids = invitations.map((invitation) => invitation!.id);
  if (new Set(ids).size !== ids.length) return null;
  return { schemaVersion: 1, invitations: invitations as ReceivedWorkspaceInvitationDto[] };
}

export function decodeWorkspaceCollaborators(value: unknown): WorkspaceCollaboratorsDto | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "workspaceId", "aggregateVersion", "currentRole", "capabilities", "members",
    "pendingInvitations",
  ])) return null;
  if (
    value.schemaVersion !== 1
    || !isId(value.workspaceId)
    || !Number.isSafeInteger(value.aggregateVersion)
    || Number(value.aggregateVersion) < 0
    || !isWorkspaceRole(value.currentRole)
    || !isRecord(value.capabilities)
    || !exactKeys(value.capabilities, ["inviteRoles", "canManageMembers"])
    || !Array.isArray(value.capabilities.inviteRoles)
    || !value.capabilities.inviteRoles.every(isInvitableWorkspaceRole)
    || new Set(value.capabilities.inviteRoles).size !== value.capabilities.inviteRoles.length
    || typeof value.capabilities.canManageMembers !== "boolean"
    || !Array.isArray(value.members)
    || value.members.length < 1
    || value.members.length > 500
    || !Array.isArray(value.pendingInvitations)
    || value.pendingInvitations.length > 100
  ) return null;
  const members = value.members.map(collaborator);
  const pendingInvitations = value.pendingInvitations.map(pendingInvitation);
  if (members.some((member) => member === null)
      || pendingInvitations.some((invitation) => invitation === null)) return null;
  if (members.filter((member) => member!.isCurrentUser).length !== 1) return null;
  if (members.find((member) => member!.isCurrentUser)?.role !== value.currentRole) return null;
  if (!value.capabilities.canManageMembers && value.pendingInvitations.length !== 0) return null;
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    aggregateVersion: Number(value.aggregateVersion),
    currentRole: value.currentRole,
    capabilities: value.capabilities as WorkspaceCollaboratorsDto["capabilities"],
    members: members as WorkspaceCollaboratorDto[],
    pendingInvitations: pendingInvitations as PendingWorkspaceInvitationDto[],
  };
}

interface ProblemPayload {
  error?: { code?: unknown; message?: unknown; requestId?: unknown };
}

export class CollaborationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly requestId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CollaborationHttpError";
  }
}

async function payloadFor(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function safeProblemText(value: unknown, fallback: string): string {
  return isText(value, 500) ? value : fallback;
}

async function requestJson(
  url: string,
  init: RequestInit | undefined,
  fallback: string,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const payload = await payloadFor(response);
  if (!response.ok) {
    const problem = isRecord(payload) ? payload as ProblemPayload : {};
    throw new CollaborationHttpError(
      response.status,
      typeof problem.error?.code === "string" ? problem.error.code : undefined,
      typeof problem.error?.requestId === "string" ? problem.error.requestId : undefined,
      safeProblemText(problem.error?.message, fallback),
    );
  }
  return payload;
}

function commandInit(command: { clientOperationId: string }): RequestInit {
  return {
    method: "POST",
    headers: { "Idempotency-Key": command.clientOperationId },
    body: JSON.stringify(command),
  };
}

function mutationEnvelope(
  value: unknown,
  resourceKey: "invitation" | "member",
): Record<string, unknown> | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "outcome", "aggregateVersion", resourceKey,
  ])) return null;
  if (
    value.schemaVersion !== 1
    || (value.outcome !== "applied" && value.outcome !== "replayed")
    || !Number.isSafeInteger(value.aggregateVersion)
    || Number(value.aggregateVersion) < 0
  ) return null;
  return value;
}

function decodeCreatedInvitation(value: unknown): CreateWorkspaceInvitationResponse | null {
  const envelope = mutationEnvelope(value, "invitation");
  if (!envelope || !isRecord(envelope.invitation) || !exactKeys(envelope.invitation, [
    "id", "email", "role", "status", "createdAt", "expiresAt",
  ])) return null;
  if (
    !isId(envelope.invitation.id)
    || !isEmail(envelope.invitation.email)
    || !isInvitableWorkspaceRole(envelope.invitation.role)
    || envelope.invitation.status !== "pending"
    || !isTimestamp(envelope.invitation.createdAt)
    || !isTimestamp(envelope.invitation.expiresAt)
  ) return null;
  return envelope as unknown as CreateWorkspaceInvitationResponse;
}

function decodeCanceledInvitation(value: unknown): CancelWorkspaceInvitationResponse | null {
  const envelope = mutationEnvelope(value, "invitation");
  if (!envelope || !isRecord(envelope.invitation)
      || !exactKeys(envelope.invitation, ["id", "status"])
      || !isId(envelope.invitation.id)
      || envelope.invitation.status !== "canceled") return null;
  return envelope as unknown as CancelWorkspaceInvitationResponse;
}

function decodeUpdatedMember(value: unknown): UpdateWorkspaceMemberRoleResponse | null {
  const envelope = mutationEnvelope(value, "member");
  if (!envelope || !isRecord(envelope.member)
      || !exactKeys(envelope.member, ["id", "role"])
      || !isId(envelope.member.id)
      || !isInvitableWorkspaceRole(envelope.member.role)) return null;
  return envelope as unknown as UpdateWorkspaceMemberRoleResponse;
}

function decodeRemovedMember(value: unknown): RemoveWorkspaceMemberResponse | null {
  const envelope = mutationEnvelope(value, "member");
  if (!envelope || !isRecord(envelope.member)
      || !exactKeys(envelope.member, ["id", "status"])
      || !isId(envelope.member.id)
      || envelope.member.status !== "removed") return null;
  return envelope as unknown as RemoveWorkspaceMemberResponse;
}

export class HttpCollaborationClient {
  async listWorkspaces(): Promise<WorkspaceDirectoryDto> {
    const payload = await requestJson("/api/workspaces", undefined, "Workspaces could not be loaded.");
    const decoded = decodeWorkspaceDirectory(payload);
    if (!decoded) throw new Error("PaperPilot returned an invalid workspace directory.");
    return decoded;
  }

  async listInvitations(): Promise<ReceivedWorkspaceInvitationsDto> {
    const payload = await requestJson("/api/invitations", undefined, "Invitations could not be loaded.");
    const decoded = decodeReceivedInvitations(payload);
    if (!decoded) throw new Error("PaperPilot returned an invalid invitation register.");
    return decoded;
  }

  async collaborators(workspaceId: string): Promise<WorkspaceCollaboratorsDto> {
    if (!isId(workspaceId)) throw new Error("workspaceId is invalid.");
    const payload = await requestJson(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/collaborators`,
      undefined,
      "Collaborators could not be loaded.",
    );
    const decoded = decodeWorkspaceCollaborators(payload);
    if (!decoded) throw new Error("PaperPilot returned an invalid collaborator register.");
    if (decoded.workspaceId !== workspaceId) {
      throw new Error("PaperPilot returned a collaborator register for another workspace.");
    }
    return decoded;
  }

  async activateWorkspace(workspaceId: string): Promise<WorkspaceActivationResponse> {
    if (!isId(workspaceId)) throw new Error("workspaceId is invalid.");
    const payload = await requestJson(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/activate`,
      {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1 }),
      },
      "The workspace could not be activated.",
    );
    if (
      !isRecord(payload)
      || !exactKeys(payload, ["schemaVersion", "workspaceId"])
      || payload.schemaVersion !== 1
      || payload.workspaceId !== workspaceId
    ) {
      throw new Error("PaperPilot returned an invalid workspace activation result.");
    }
    return payload as unknown as WorkspaceActivationResponse;
  }

  async decideInvitation(
    invitationId: string,
    command: InvitationDecisionCommand,
  ): Promise<InvitationDecisionResponse> {
    if (!isId(invitationId)) throw new Error("invitationId is invalid.");
    const payload = await requestJson(
      `/api/invitations/${encodeURIComponent(invitationId)}/decision`,
      commandInit(command),
      "The invitation decision could not be saved.",
    );
    if (!isRecord(payload) || !requiredOptionalKeys(payload, [
      "schemaVersion", "outcome", "aggregateVersion", "invitation",
    ], ["membership"])) throw new Error("PaperPilot returned an invalid invitation decision.");
    if (
      payload.schemaVersion !== 1
      || (payload.outcome !== "applied" && payload.outcome !== "replayed")
      || !Number.isSafeInteger(payload.aggregateVersion)
      || Number(payload.aggregateVersion) < 0
      || !isRecord(payload.invitation)
      || !exactKeys(payload.invitation, ["id", "status"])
      || payload.invitation.id !== invitationId
      || (payload.invitation.status !== "accepted" && payload.invitation.status !== "rejected")
    ) throw new Error("PaperPilot returned an invalid invitation decision.");
    if (payload.invitation.status === "accepted") {
      if (!isRecord(payload.membership)
          || !exactKeys(payload.membership, ["workspaceId", "role"])
          || !isId(payload.membership.workspaceId)
          || !isInvitableWorkspaceRole(payload.membership.role)) {
        throw new Error("PaperPilot returned an invalid accepted membership.");
      }
    } else if (payload.membership !== undefined) {
      throw new Error("PaperPilot returned membership for a rejected invitation.");
    }
    return payload as unknown as InvitationDecisionResponse;
  }

  async invite(
    workspaceId: string,
    command: CreateWorkspaceInvitationCommand,
  ): Promise<CreateWorkspaceInvitationResponse> {
    if (!isId(workspaceId)) throw new Error("workspaceId is invalid.");
    const payload = await this.mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
      command,
      "The invitation could not be created.",
    );
    const decoded = decodeCreatedInvitation(payload);
    if (!decoded) throw new Error("PaperPilot returned an invalid invitation command result.");
    return decoded;
  }

  async cancelInvitation(
    workspaceId: string,
    invitationId: string,
    command: CancelWorkspaceInvitationCommand,
  ): Promise<CancelWorkspaceInvitationResponse> {
    if (!isId(workspaceId)) throw new Error("workspaceId is invalid.");
    if (!isId(invitationId)) throw new Error("invitationId is invalid.");
    const payload = await this.mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}/cancel`,
      command,
      "The invitation could not be canceled.",
    );
    const decoded = decodeCanceledInvitation(payload);
    if (!decoded || decoded.invitation.id !== invitationId) {
      throw new Error("PaperPilot returned an invalid invitation cancellation result.");
    }
    return decoded;
  }

  async updateMemberRole(
    workspaceId: string,
    memberId: string,
    command: UpdateWorkspaceMemberRoleCommand,
  ): Promise<UpdateWorkspaceMemberRoleResponse> {
    if (!isId(workspaceId)) throw new Error("workspaceId is invalid.");
    if (!isId(memberId)) throw new Error("memberId is invalid.");
    const payload = await this.mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}/role`,
      command,
      "The collaborator role could not be changed.",
    );
    const decoded = decodeUpdatedMember(payload);
    if (!decoded || decoded.member.id !== memberId) {
      throw new Error("PaperPilot returned an invalid collaborator role result.");
    }
    return decoded;
  }

  async removeMember(
    workspaceId: string,
    memberId: string,
    command: RemoveWorkspaceMemberCommand,
  ): Promise<RemoveWorkspaceMemberResponse> {
    if (!isId(workspaceId)) throw new Error("workspaceId is invalid.");
    if (!isId(memberId)) throw new Error("memberId is invalid.");
    const payload = await this.mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}/remove`,
      command,
      "The collaborator could not be removed.",
    );
    const decoded = decodeRemovedMember(payload);
    if (!decoded || decoded.member.id !== memberId) {
      throw new Error("PaperPilot returned an invalid collaborator removal result.");
    }
    return decoded;
  }

  private async mutation(
    url: string,
    command: { clientOperationId: string },
    fallback: string,
  ): Promise<unknown> {
    return requestJson(url, commandInit(command), fallback);
  }
}
