import "server-only";

import type {
  InvitableWorkspaceRole,
  WorkspaceRole,
} from "@/lib/workspace-roles";
import { isInvitableWorkspaceRole, isWorkspaceRole } from "@/lib/workspace-roles";
import { HttpProblem } from "@/server/http/problem";

export const COLLABORATION_SCHEMA_VERSION = 1 as const;
export const MEMBER_REMOVAL_CONFIRMATION = "REMOVE_MEMBER" as const;

const OPERATION_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface WorkspaceSummaryDto {
  id: string;
  name: string;
  kind: "personal" | "shared";
  role: WorkspaceRole;
  memberCount: number;
}

export interface WorkspaceListDto {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  activeWorkspaceId: string | null;
  workspaces: WorkspaceSummaryDto[];
}

export interface InvitationInboxItemDto {
  id: string;
  workspace: { id: string; name: string };
  inviter: { name: string };
  role: InvitableWorkspaceRole;
  createdAt: string;
  expiresAt: string;
}

export interface InvitationInboxDto {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  invitations: InvitationInboxItemDto[];
}

export interface WorkspaceCollaboratorsDto {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  workspaceId: string;
  aggregateVersion: number;
  currentRole: WorkspaceRole;
  capabilities: {
    inviteRoles: InvitableWorkspaceRole[];
    canManageMembers: boolean;
  };
  members: Array<{
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    role: WorkspaceRole;
    joinedAt: string;
    isCurrentUser: boolean;
  }>;
  pendingInvitations: Array<{
    id: string;
    email: string;
    role: InvitableWorkspaceRole;
    createdAt: string;
    expiresAt: string;
  }>;
}

export type CollaborationMutationResult<T extends Record<string, unknown>> = {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  outcome: "applied" | "replayed";
  aggregateVersion: number;
} & T;

export interface CreateWorkspaceInvitationCommand {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  clientOperationId: string;
  expectedVersion: number;
  email: string;
  role: InvitableWorkspaceRole;
}

export interface CancelWorkspaceInvitationCommand {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  clientOperationId: string;
  expectedVersion: number;
}

export interface InvitationDecisionCommand {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  clientOperationId: string;
  decision: "accept" | "reject";
}

export interface WorkspaceRoleUpdateCommand {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  clientOperationId: string;
  expectedVersion: number;
  role: InvitableWorkspaceRole;
}

export interface WorkspaceMemberRemovalCommand {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION;
  clientOperationId: string;
  expectedVersion: number;
  confirmation: typeof MEMBER_REMOVAL_CONFIRMATION;
}

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function objectWithExactKeys(
  raw: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    validation(`${label} must be a JSON object.`);
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unexpected) validation(`${label} contains an unsupported field: ${unexpected}.`);
  return record;
}

function schemaVersion(record: Record<string, unknown>): typeof COLLABORATION_SCHEMA_VERSION {
  if (record.schemaVersion !== COLLABORATION_SCHEMA_VERSION) {
    validation(`schemaVersion must be ${COLLABORATION_SCHEMA_VERSION}.`);
  }
  return COLLABORATION_SCHEMA_VERSION;
}

function operationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    validation("clientOperationId must contain 1 to 200 letters, numbers, dots, underscores, colons, or hyphens.");
  }
  return value;
}

function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    validation("expectedVersion must be a non-negative integer.");
  }
  return value as number;
}

function invitableRole(value: unknown): InvitableWorkspaceRole {
  if (!isInvitableWorkspaceRole(value)) {
    validation("role must be admin, member, or viewer.");
  }
  return value;
}

/** Recipient comparison and persistence use this single canonical form. */
export function normalizeCollaborationEmail(value: unknown): string {
  if (typeof value !== "string") validation("email must be text.");
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3
    || normalized.length > 254
    || !EMAIL_PATTERN.test(normalized)
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    validation("email must be a valid address containing at most 254 characters.");
  }
  return normalized;
}

export function validateCollaborationPathId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    validation(`${label} is invalid.`);
  }
  return value;
}

export function invitationRolesFor(role: WorkspaceRole): InvitableWorkspaceRole[] {
  if (role === "owner") return ["admin", "member", "viewer"];
  if (role === "admin") return ["member", "viewer"];
  return [];
}

export function requireWorkspaceCollaborationManager(role: string): WorkspaceRole {
  if (!isWorkspaceRole(role)) {
    throw new HttpProblem(
      409,
      "workspace_role_invalid",
      "This workspace has an unsupported membership role.",
    );
  }
  if (role !== "owner" && role !== "admin") {
    throw new HttpProblem(
      403,
      "workspace_forbidden",
      "This workspace role cannot manage collaborators.",
    );
  }
  return role;
}

export function validateCreateWorkspaceInvitationCommand(
  raw: unknown,
): CreateWorkspaceInvitationCommand {
  const record = objectWithExactKeys(raw, "Invitation command", new Set([
    "schemaVersion",
    "clientOperationId",
    "expectedVersion",
    "email",
    "role",
  ]));
  return {
    schemaVersion: schemaVersion(record),
    clientOperationId: operationId(record.clientOperationId),
    expectedVersion: expectedVersion(record.expectedVersion),
    email: normalizeCollaborationEmail(record.email),
    role: invitableRole(record.role),
  };
}

export function validateCancelWorkspaceInvitationCommand(
  raw: unknown,
): CancelWorkspaceInvitationCommand {
  const record = objectWithExactKeys(raw, "Invitation cancellation", new Set([
    "schemaVersion",
    "clientOperationId",
    "expectedVersion",
  ]));
  return {
    schemaVersion: schemaVersion(record),
    clientOperationId: operationId(record.clientOperationId),
    expectedVersion: expectedVersion(record.expectedVersion),
  };
}

export function validateInvitationDecisionCommand(raw: unknown): InvitationDecisionCommand {
  const record = objectWithExactKeys(raw, "Invitation decision", new Set([
    "schemaVersion",
    "clientOperationId",
    "decision",
  ]));
  if (record.decision !== "accept" && record.decision !== "reject") {
    validation("decision must be accept or reject.");
  }
  return {
    schemaVersion: schemaVersion(record),
    clientOperationId: operationId(record.clientOperationId),
    decision: record.decision,
  };
}

export function validateWorkspaceRoleUpdateCommand(raw: unknown): WorkspaceRoleUpdateCommand {
  const record = objectWithExactKeys(raw, "Role update", new Set([
    "schemaVersion",
    "clientOperationId",
    "expectedVersion",
    "role",
  ]));
  return {
    schemaVersion: schemaVersion(record),
    clientOperationId: operationId(record.clientOperationId),
    expectedVersion: expectedVersion(record.expectedVersion),
    role: invitableRole(record.role),
  };
}

export function validateWorkspaceMemberRemovalCommand(
  raw: unknown,
): WorkspaceMemberRemovalCommand {
  const record = objectWithExactKeys(raw, "Member removal", new Set([
    "schemaVersion",
    "clientOperationId",
    "expectedVersion",
    "confirmation",
  ]));
  if (record.confirmation !== MEMBER_REMOVAL_CONFIRMATION) {
    validation(`confirmation must be ${MEMBER_REMOVAL_CONFIRMATION}.`);
  }
  return {
    schemaVersion: schemaVersion(record),
    clientOperationId: operationId(record.clientOperationId),
    expectedVersion: expectedVersion(record.expectedVersion),
    confirmation: MEMBER_REMOVAL_CONFIRMATION,
  };
}

/** Mirror the browser Idempotency-Key into the schema-versioned body. */
export function applyCollaborationIdempotencyHeader(
  request: Request,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const headerOperationId = request.headers.get("idempotency-key")?.trim();
  if (!headerOperationId) return body;
  operationId(headerOperationId);
  if (
    body.clientOperationId !== undefined
    && body.clientOperationId !== headerOperationId
  ) {
    throw new HttpProblem(
      400,
      "idempotency_mismatch",
      "Idempotency-Key must match clientOperationId.",
    );
  }
  return { ...body, clientOperationId: headerOperationId };
}
