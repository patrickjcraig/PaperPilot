import type {
  InvitableWorkspaceRole,
  WorkspaceRole,
} from "@/lib/workspace-roles";

export interface WorkspaceSummaryDto {
  id: string;
  name: string;
  kind: "personal" | "shared";
  role: WorkspaceRole;
  memberCount: number;
}

export interface WorkspaceDirectoryDto {
  schemaVersion: 1;
  activeWorkspaceId: string | null;
  workspaces: WorkspaceSummaryDto[];
}

export interface ReceivedWorkspaceInvitationDto {
  id: string;
  workspace: { id: string; name: string };
  inviter: { name: string };
  role: InvitableWorkspaceRole;
  createdAt: string;
  expiresAt: string;
}

export interface ReceivedWorkspaceInvitationsDto {
  schemaVersion: 1;
  invitations: ReceivedWorkspaceInvitationDto[];
}

export interface WorkspaceCollaboratorDto {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: WorkspaceRole;
  joinedAt: string;
  isCurrentUser: boolean;
}

export interface PendingWorkspaceInvitationDto {
  id: string;
  email: string;
  role: InvitableWorkspaceRole;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceCollaboratorsDto {
  schemaVersion: 1;
  workspaceId: string;
  aggregateVersion: number;
  currentRole: WorkspaceRole;
  capabilities: {
    inviteRoles: InvitableWorkspaceRole[];
    canManageMembers: boolean;
  };
  members: WorkspaceCollaboratorDto[];
  pendingInvitations: PendingWorkspaceInvitationDto[];
}

export interface WorkspaceActivationResponse {
  schemaVersion: 1;
  workspaceId: string;
}

export type CollaborationCommandOutcome = "applied" | "replayed";

export interface InvitationDecisionCommand {
  schemaVersion: 1;
  clientOperationId: string;
  decision: "accept" | "reject";
}

export interface InvitationDecisionResponse {
  schemaVersion: 1;
  outcome: CollaborationCommandOutcome;
  aggregateVersion: number;
  invitation: {
    id: string;
    status: "accepted" | "rejected";
  };
  membership?: {
    workspaceId: string;
    role: InvitableWorkspaceRole;
  };
}

export interface CreateWorkspaceInvitationCommand {
  schemaVersion: 1;
  clientOperationId: string;
  expectedVersion: number;
  email: string;
  role: InvitableWorkspaceRole;
}

export interface CancelWorkspaceInvitationCommand {
  schemaVersion: 1;
  clientOperationId: string;
  expectedVersion: number;
}

export interface UpdateWorkspaceMemberRoleCommand {
  schemaVersion: 1;
  clientOperationId: string;
  expectedVersion: number;
  role: InvitableWorkspaceRole;
}

export interface RemoveWorkspaceMemberCommand {
  schemaVersion: 1;
  clientOperationId: string;
  expectedVersion: number;
  confirmation: "REMOVE_MEMBER";
}

export interface CollaborationMutationBase {
  schemaVersion: 1;
  outcome: CollaborationCommandOutcome;
  aggregateVersion: number;
}

export interface CreateWorkspaceInvitationResponse extends CollaborationMutationBase {
  invitation: PendingWorkspaceInvitationDto & { status: "pending" };
}

export interface CancelWorkspaceInvitationResponse extends CollaborationMutationBase {
  invitation: { id: string; status: "canceled" };
}

export interface UpdateWorkspaceMemberRoleResponse extends CollaborationMutationBase {
  member: Pick<WorkspaceCollaboratorDto, "id" | "role">;
}

export interface RemoveWorkspaceMemberResponse extends CollaborationMutationBase {
  member: { id: string; status: "removed" };
}
