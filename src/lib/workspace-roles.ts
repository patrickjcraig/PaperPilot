import {
  defaultAc,
  defaultRoles,
} from "better-auth/plugins/organization/access";

/**
 * PaperPilot deliberately uses one role per workspace membership. Better Auth
 * supports comma-separated and dynamic roles, but the research-service
 * authorization layer fails closed unless one of these exact values is stored.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type InvitableWorkspaceRole = Exclude<WorkspaceRole, "owner">;

export const MUTATING_WORKSPACE_ROLES = new Set<WorkspaceRole>([
  "owner",
  "admin",
  "member",
]);

export const MANAGING_WORKSPACE_ROLES = new Set<WorkspaceRole>([
  "owner",
  "admin",
]);

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string"
    && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function isInvitableWorkspaceRole(value: unknown): value is InvitableWorkspaceRole {
  return value === "admin" || value === "member" || value === "viewer";
}

/**
 * The organization plugin only controls its own session/list operations. All
 * PaperPilot data access is re-authorized by the application services. Viewer
 * therefore receives no Better Auth organization mutation permission.
 */
export const viewerOrganizationRole = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: [],
});

export const paperPilotOrganizationRoles = {
  ...defaultRoles,
  viewer: viewerOrganizationRole,
};

/**
 * PaperPilot owns collaboration mutations so they participate in optimistic
 * workspace revisions, idempotency, retained audit identity, and membership
 * race fencing. These generic Better Auth paths must remain closed.
 */
export const DISABLED_GENERIC_ORGANIZATION_PATHS = [
  "/organization/create",
  "/organization/check-slug",
  "/organization/update",
  "/organization/delete",
  "/organization/get-organization",
  "/organization/get-full-organization",
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/get-invitation",
  "/organization/list-invitations",
  "/organization/list-user-invitations",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/leave",
  "/organization/list-members",
  "/organization/set-active",
] as const;
