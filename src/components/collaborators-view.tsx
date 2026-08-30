"use client";

import {
  Building2,
  Check,
  Clock3,
  Crown,
  MailPlus,
  RefreshCw,
  ShieldCheck,
  UserRoundCheck,
  UserRoundMinus,
  UserRoundX,
  UsersRound,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  PendingWorkspaceInvitationDto,
  ReceivedWorkspaceInvitationDto,
  ReceivedWorkspaceInvitationsDto,
  WorkspaceCollaboratorDto,
  WorkspaceCollaboratorsDto,
  WorkspaceDirectoryDto,
  WorkspaceSummaryDto,
} from "@/lib/workspace/collaboration-contracts";
import type {
  InvitableWorkspaceRole,
  WorkspaceRole,
} from "@/lib/workspace-roles";

type CollaborationCallback = void | Promise<void>;

export type CollaboratorsViewProps = {
  collaborators: WorkspaceCollaboratorsDto | null;
  directory: WorkspaceDirectoryDto;
  invitations: ReceivedWorkspaceInvitationsDto;
  loading?: boolean;
  error?: string | null;
  onAcceptInvitation: (
    invitationId: ReceivedWorkspaceInvitationDto["id"],
  ) => CollaborationCallback;
  onCancelInvitation: (
    invitationId: PendingWorkspaceInvitationDto["id"],
  ) => CollaborationCallback;
  onChangeRole: (
    memberId: WorkspaceCollaboratorDto["id"],
    role: InvitableWorkspaceRole,
  ) => CollaborationCallback;
  onInvite: (
    email: PendingWorkspaceInvitationDto["email"],
    role: InvitableWorkspaceRole,
  ) => CollaborationCallback;
  onRefresh: () => CollaborationCallback;
  onRejectInvitation: (
    invitationId: ReceivedWorkspaceInvitationDto["id"],
  ) => CollaborationCallback;
  onRemoveMember: (
    memberId: WorkspaceCollaboratorDto["id"],
  ) => CollaborationCallback;
  onSwitchWorkspace: (
    workspaceId: WorkspaceSummaryDto["id"],
  ) => CollaborationCallback;
};

type ActionFeedback = {
  message: string;
  tone: "error" | "success";
};

const roleLabels: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Administrator",
  member: "Member",
  viewer: "Viewer",
};

const roleNotes: Record<WorkspaceRole, string> = {
  owner: "Workspace authority",
  admin: "Manages the register",
  member: "Creates and edits research",
  viewer: "Read-only access",
};

function dateLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(parsed);
}

function personInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = Array.from(words[0] ?? "?")[0] ?? "?";
  const last = Array.from(words.at(-1) ?? "")[0] ?? "";
  return `${first}${words.length > 1 ? last : ""}`.toLocaleUpperCase();
}

function actionError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
}

function canManageMember(
  currentRole: WorkspaceRole,
  member: WorkspaceCollaboratorDto,
): boolean {
  if (member.isCurrentUser || member.role === "owner") return false;
  if (currentRole === "owner") return true;
  return currentRole === "admin"
    && (member.role === "member" || member.role === "viewer");
}

export function CollaboratorsView({
  collaborators,
  directory,
  invitations,
  loading = false,
  error,
  onAcceptInvitation,
  onCancelInvitation,
  onChangeRole,
  onInvite,
  onRefresh,
  onRejectInvitation,
  onRemoveMember,
  onSwitchWorkspace,
}: CollaboratorsViewProps) {
  const instanceId = useId();
  const [feedback, setFeedback] = useState<ActionFeedback>();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitableWorkspaceRole>("member");
  const [pendingAction, setPendingAction] = useState<string>();
  const [confirmingMemberId, setConfirmingMemberId] = useState<string>();
  const removalConfirmRef = useRef<HTMLButtonElement | null>(null);
  const removalTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activeWorkspace = directory.workspaces.find(
    (workspace) => workspace.id === (collaborators?.workspaceId ?? directory.activeWorkspaceId),
  );
  const canManage = Boolean(collaborators?.capabilities.canManageMembers);
  const availableRoles = collaborators?.capabilities.inviteRoles ?? [];
  const effectiveInviteRole = availableRoles.includes(inviteRole)
    ? inviteRole
    : availableRoles[0] ?? "viewer";
  const busy = loading || pendingAction !== undefined;

  useEffect(() => {
    if (confirmingMemberId) removalConfirmRef.current?.focus();
  }, [confirmingMemberId]);

  async function runAction(
    key: string,
    action: () => CollaborationCallback,
    successMessage: string,
    failureMessage: string,
    onSuccess?: () => void,
  ) {
    if (pendingAction || loading) return;
    setPendingAction(key);
    setFeedback(undefined);
    try {
      await action();
      onSuccess?.();
      setFeedback({ message: successMessage, tone: "success" });
    } catch (cause) {
      setFeedback({
        message: actionError(cause, failureMessage),
        tone: "error",
      });
    } finally {
      setPendingAction(undefined);
    }
  }

  function cancelRemoval(memberId: string) {
    if (pendingAction === `remove:${memberId}`) return;
    setConfirmingMemberId(undefined);
    window.requestAnimationFrame(() => removalTriggerRefs.current[memberId]?.focus());
  }

  function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email || !availableRoles.length) return;
    void runAction(
      "invite",
      () => onInvite(email, effectiveInviteRole),
      `In-app invitation created for ${email}.`,
      "The in-app invitation could not be created.",
      () => setInviteEmail(""),
    );
  }

  return (
    <section
      aria-busy={busy}
      aria-labelledby={`${instanceId}-title`}
      className="view collaboration-view"
    >
      <div className="view-header collaboration-view-header">
        <div>
          <span className="eyebrow">Access and research authorship</span>
          <h1 className="view-title" id={`${instanceId}-title`}>People</h1>
          <p className="view-subtitle">
            Switch workspaces, answer invitations, and maintain the named authorship register for shared research.
          </p>
        </div>
        <button
          aria-label={loading ? "Refreshing collaboration register" : "Refresh collaboration register"}
          className="button collaboration-refresh-button"
          disabled={busy}
          onClick={() => void runAction(
            "refresh",
            onRefresh,
            "Collaboration register refreshed.",
            "The collaboration register could not be refreshed.",
          )}
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={pendingAction === "refresh" || loading ? "collaboration-spinner" : undefined}
            size={14}
          />
          {pendingAction === "refresh" || loading ? "Refreshing…" : "Refresh register"}
        </button>
      </div>

      {error ? (
        <div className="collaboration-feedback error" role="alert">
          <span className="collaboration-feedback-mark" aria-hidden="true">!</span>
          <span>{error}</span>
        </div>
      ) : null}
      {feedback ? (
        <div
          aria-live="polite"
          className={`collaboration-feedback ${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          <span className="collaboration-feedback-mark" aria-hidden="true">
            {feedback.tone === "success" ? "✓" : "!"}
          </span>
          <span>{feedback.message}</span>
        </div>
      ) : null}

      <section
        aria-labelledby={`${instanceId}-received-title`}
        className={`collaboration-invitation-docket${invitations.invitations.length ? " has-entries" : ""}`}
      >
        <div className="collaboration-docket-heading">
          <div>
            <span className="micro-label">Received invitation docket</span>
            <h2 id={`${instanceId}-received-title`}>Awaiting your decision</h2>
          </div>
          <span className="collaboration-count-stamp" aria-label={`${invitations.invitations.length} received invitations`}>
            {String(invitations.invitations.length).padStart(2, "0")}
          </span>
        </div>

        {invitations.invitations.length ? (
          <ol className="collaboration-received-list">
            {invitations.invitations.map((invitation) => {
              const acceptKey = `accept:${invitation.id}`;
              const rejectKey = `reject:${invitation.id}`;
              return (
                <li className="collaboration-received-entry" key={invitation.id}>
                  <span className="collaboration-entry-icon" aria-hidden="true">
                    <MailPlus size={17} />
                  </span>
                  <div className="collaboration-invitation-copy">
                    <span className="micro-label">Invited by {invitation.inviter.name}</span>
                    <strong>{invitation.workspace.name}</strong>
                    <span>
                      Offered {roleLabels[invitation.role].toLocaleLowerCase()} access · received {dateLabel(invitation.createdAt)}
                    </span>
                  </div>
                  <div className="collaboration-expiry">
                    <Clock3 size={11} aria-hidden="true" />
                    <span>Expires <time dateTime={invitation.expiresAt}>{dateLabel(invitation.expiresAt)}</time></span>
                  </div>
                  <div className="button-group collaboration-decision-actions" aria-label={`Invitation actions for ${invitation.workspace.name}`}>
                    <button
                      className="button small"
                      disabled={busy}
                      onClick={() => void runAction(
                        rejectKey,
                        () => onRejectInvitation(invitation.id),
                        `Invitation to ${invitation.workspace.name} rejected.`,
                        "The invitation could not be rejected.",
                      )}
                      type="button"
                    >
                      <UserRoundX size={12} aria-hidden="true" />
                      {pendingAction === rejectKey ? "Rejecting…" : "Reject"}
                    </button>
                    <button
                      className="button small primary"
                      disabled={busy}
                      onClick={() => void runAction(
                        acceptKey,
                        () => onAcceptInvitation(invitation.id),
                        `${invitation.workspace.name} added to your workspace shelf.`,
                        "The invitation could not be accepted.",
                      )}
                      type="button"
                    >
                      <UserRoundCheck size={12} aria-hidden="true" />
                      {pendingAction === acceptKey ? "Accepting…" : "Accept invitation"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="collaboration-docket-empty">
            No invitation needs a decision. New offers will remain here until accepted, rejected, or expired.
          </p>
        )}
      </section>

      <div className="collaboration-register-layout">
        <aside aria-labelledby={`${instanceId}-workspace-shelf-title`} className="collaboration-workspace-shelf">
          <div className="collaboration-section-heading">
            <div>
              <span className="micro-label">Workspace shelf</span>
              <h2 id={`${instanceId}-workspace-shelf-title`}>Research rooms</h2>
            </div>
            <Building2 size={17} aria-hidden="true" />
          </div>

          {directory.workspaces.length ? (
            <nav aria-label="Available workspaces">
              <ul className="collaboration-workspace-list">
                {directory.workspaces.map((workspace) => {
                  const isActive = workspace.id === directory.activeWorkspaceId;
                  const switchKey = `switch:${workspace.id}`;
                  return (
                    <li key={workspace.id}>
                      <button
                        aria-current={isActive ? "page" : undefined}
                        aria-label={isActive
                          ? `${workspace.name}, current workspace`
                          : `Switch to ${workspace.name}`}
                        className={`collaboration-workspace-tab${isActive ? " active" : ""}`}
                        disabled={busy || isActive}
                        onClick={() => void runAction(
                          switchKey,
                          () => onSwitchWorkspace(workspace.id),
                          `Opened ${workspace.name}.`,
                          `PaperPilot could not switch to ${workspace.name}.`,
                        )}
                        type="button"
                      >
                        <span className="collaboration-workspace-tab-mark" aria-hidden="true">
                          {workspace.kind === "personal" ? "P" : "W"}
                        </span>
                        <span className="collaboration-workspace-tab-copy">
                          <strong>{workspace.name}</strong>
                          <span>{workspace.kind === "personal" ? "Personal" : "Shared"} · {workspace.memberCount} {workspace.memberCount === 1 ? "person" : "people"}</span>
                        </span>
                        <span className="collaboration-workspace-role">{roleLabels[workspace.role]}</span>
                        {isActive ? <Check size={13} aria-hidden="true" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : (
            <p className="collaboration-shelf-empty">No workspace is available.</p>
          )}

          <div className="collaboration-shelf-note" role="note">
            <ShieldCheck size={14} aria-hidden="true" />
            <p>
              Switching rooms changes the complete research boundary. Membership never grants access across workspaces.
            </p>
          </div>
        </aside>

        <article aria-labelledby={`${instanceId}-ledger-title`} className="collaboration-ledger">
          <div className="collaboration-ledger-running-head">
            <span>PaperPilot authorship register</span>
            <span>Revision {collaborators?.aggregateVersion ?? "—"}</span>
          </div>

          <header className="collaboration-ledger-header">
            <div>
              <span className="micro-label">Authorship ledger</span>
              <h2 id={`${instanceId}-ledger-title`}>{activeWorkspace?.name ?? "Current workspace"}</h2>
              <p>
                Named access, verified contact state, and workspace authority are recorded together.
              </p>
            </div>
            {collaborators ? (
              <div className="collaboration-authority-stamp">
                {collaborators.currentRole === "owner" ? <Crown size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
                <span>Your authority</span>
                <strong>{roleLabels[collaborators.currentRole]}</strong>
              </div>
            ) : null}
          </header>

          {loading && !collaborators ? (
            <div className="collaboration-loading-state" role="status" aria-live="polite">
              <RefreshCw className="collaboration-spinner" size={17} aria-hidden="true" />
              <span>Opening the collaboration register…</span>
            </div>
          ) : collaborators ? (
            <>
              <div className="collaboration-ledger-columns" aria-hidden="true">
                <span>Researcher</span>
                <span>Joined</span>
                <span>Authority</span>
                <span>Register action</span>
              </div>
              <ol className="collaboration-member-list" aria-label="Workspace collaborators">
                {collaborators.members.map((member) => {
                  const roleKey = `role:${member.id}`;
                  const removeKey = `remove:${member.id}`;
                  const confirmingRemoval = confirmingMemberId === member.id;
                  const manageable = canManage
                    && canManageMember(collaborators.currentRole, member);
                  return (
                    <li className={`collaboration-member-row${confirmingRemoval ? " confirming-removal" : ""}`} key={member.id}>
                      <div className="collaboration-person-cell">
                        <span className="collaboration-person-seal" aria-hidden="true">
                          {personInitials(member.name)}
                        </span>
                        <div>
                          <strong>{member.name}</strong>
                          <span className="collaboration-person-email">{member.email}</span>
                          <span className={`collaboration-verification ${member.emailVerified ? "verified" : "unverified"}`}>
                            {member.emailVerified ? <Check size={9} aria-hidden="true" /> : <X size={9} aria-hidden="true" />}
                            {member.emailVerified ? "Verified email" : "Email unverified"}
                          </span>
                        </div>
                        {member.isCurrentUser ? <span className="collaboration-you-stamp">You</span> : null}
                      </div>

                      <div className="collaboration-joined-cell">
                        <span className="collaboration-mobile-label">Joined</span>
                        <time dateTime={member.joinedAt}>{dateLabel(member.joinedAt)}</time>
                      </div>

                      <div className="collaboration-role-cell">
                        <span className="collaboration-mobile-label">Authority</span>
                        {manageable ? (
                          <>
                            <label className="sr-only" htmlFor={`${instanceId}-role-${member.id}`}>
                              Role for {member.name}
                            </label>
                            <select
                              aria-label={`Role for ${member.name}`}
                              className="collaboration-role-select"
                              disabled={busy}
                              id={`${instanceId}-role-${member.id}`}
                              onChange={(event) => {
                                const role = event.target.value as InvitableWorkspaceRole;
                                if (role === member.role) return;
                                void runAction(
                                  roleKey,
                                  () => onChangeRole(member.id, role),
                                  `${member.name} is now a ${roleLabels[role].toLocaleLowerCase()}.`,
                                  `The role for ${member.name} could not be changed.`,
                                );
                              }}
                              value={member.role}
                            >
                              {availableRoles.map((role) => (
                                <option key={role} value={role}>{roleLabels[role]}</option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <div className={`collaboration-role-imprint role-${member.role}`}>
                            <strong>{roleLabels[member.role]}</strong>
                            <span>{roleNotes[member.role]}</span>
                          </div>
                        )}
                      </div>

                      <div className="collaboration-member-actions">
                        <span className="collaboration-mobile-label">Register action</span>
                        {manageable ? (
                          <button
                            aria-expanded={confirmingRemoval}
                            aria-controls={confirmingRemoval ? `${instanceId}-remove-${member.id}` : undefined}
                            className="button small danger-button collaboration-remove-trigger"
                            disabled={busy}
                            onClick={() => setConfirmingMemberId(member.id)}
                            ref={(node) => {
                              removalTriggerRefs.current[member.id] = node;
                            }}
                            type="button"
                          >
                            <UserRoundMinus size={12} aria-hidden="true" />
                            Remove…
                          </button>
                        ) : (
                          <span className="collaboration-protected-note">
                            {member.isCurrentUser
                              ? "Current membership"
                              : member.role === "owner"
                                ? "Protected owner"
                                : "Outside your authority"}
                          </span>
                        )}
                      </div>

                      {confirmingRemoval ? (
                        <div
                          aria-labelledby={`${instanceId}-remove-title-${member.id}`}
                          className="collaboration-remove-confirm"
                          id={`${instanceId}-remove-${member.id}`}
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") return;
                            event.preventDefault();
                            cancelRemoval(member.id);
                          }}
                          role="group"
                        >
                          <span className="collaboration-remove-icon" aria-hidden="true">
                            <UserRoundMinus size={15} />
                          </span>
                          <div>
                            <strong id={`${instanceId}-remove-title-${member.id}`}>
                              Remove {member.name} from this workspace?
                            </strong>
                            <p>
                              Their access ends immediately. Removal can be blocked until their private projects are reassigned or deleted.
                            </p>
                          </div>
                          <div className="button-group collaboration-remove-actions">
                            <button
                              className="button small"
                              disabled={pendingAction === removeKey}
                              onClick={() => cancelRemoval(member.id)}
                              type="button"
                            >
                              Cancel
                            </button>
                            <button
                              className="button small danger-button"
                              disabled={pendingAction === removeKey}
                              onClick={() => void runAction(
                                removeKey,
                                () => onRemoveMember(member.id),
                                `${member.name} was removed from the workspace.`,
                                `${member.name} could not be removed from the workspace.`,
                                () => setConfirmingMemberId(undefined),
                              )}
                              ref={removalConfirmRef}
                              type="button"
                            >
                              <UserRoundMinus size={12} aria-hidden="true" />
                              {pendingAction === removeKey ? "Removing…" : "Confirm removal"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>

              {canManage ? (
                <section aria-labelledby={`${instanceId}-dispatch-title`} className="collaboration-dispatch-section">
                  <div className="collaboration-dispatch-composer">
                    <div className="collaboration-dispatch-heading">
                      <span className="collaboration-entry-icon" aria-hidden="true"><MailPlus size={16} /></span>
                      <div>
                        <span className="micro-label">Manager desk</span>
                        <h3 id={`${instanceId}-dispatch-title`}>Create an in-app invitation</h3>
                        <p>The recipient can answer it from PaperPilot after signing in with this email address.</p>
                      </div>
                    </div>
                    <form className="collaboration-dispatch-form" onSubmit={submitInvitation}>
                      <label className="field-group">
                        <span className="field-label">Email address</span>
                        <input
                          autoComplete="email"
                          className="text-input"
                          disabled={busy}
                          maxLength={254}
                          name="collaborator-email"
                          onChange={(event) => setInviteEmail(event.target.value)}
                          placeholder="researcher@institution.edu"
                          required
                          type="email"
                          value={inviteEmail}
                        />
                      </label>
                      <label className="field-group">
                        <span className="field-label">Workspace role</span>
                        <select
                          className="collaboration-role-select collaboration-invite-role"
                          disabled={busy || !availableRoles.length}
                          name="collaborator-role"
                          onChange={(event) => setInviteRole(event.target.value as InvitableWorkspaceRole)}
                          value={effectiveInviteRole}
                        >
                          {availableRoles.map((role) => (
                            <option key={role} value={role}>{roleLabels[role]}</option>
                          ))}
                        </select>
                      </label>
                      <button className="button primary collaboration-dispatch-button" disabled={busy || !availableRoles.length} type="submit">
                        <MailPlus size={13} aria-hidden="true" />
                        {pendingAction === "invite" ? "Creating…" : "Create invitation"}
                      </button>
                    </form>
                  </div>

                  <div className="collaboration-pending-register">
                    <div className="collaboration-pending-heading">
                      <div>
                        <span className="micro-label">Pending invitations</span>
                        <h3>Open invitations</h3>
                      </div>
                      <span className="collaboration-count-stamp" aria-label={`${collaborators.pendingInvitations.length} pending invitations`}>
                        {String(collaborators.pendingInvitations.length).padStart(2, "0")}
                      </span>
                    </div>
                    {collaborators.pendingInvitations.length ? (
                      <ul className="collaboration-pending-list">
                        {collaborators.pendingInvitations.map((invitation) => {
                          const cancelKey = `cancel:${invitation.id}`;
                          return (
                            <li key={invitation.id}>
                              <span className="collaboration-pending-mark" aria-hidden="true"><Clock3 size={12} /></span>
                              <div>
                                <strong>{invitation.email}</strong>
                                <span>{roleLabels[invitation.role]} · created {dateLabel(invitation.createdAt)}</span>
                              </div>
                              <time dateTime={invitation.expiresAt}>Expires {dateLabel(invitation.expiresAt)}</time>
                              <button
                                aria-label={`Cancel invitation for ${invitation.email}`}
                                className="button small ghost collaboration-cancel-dispatch"
                                disabled={busy}
                                onClick={() => void runAction(
                                  cancelKey,
                                  () => onCancelInvitation(invitation.id),
                                  `Invitation for ${invitation.email} canceled.`,
                                  `The invitation for ${invitation.email} could not be canceled.`,
                                )}
                                type="button"
                              >
                                <X size={12} aria-hidden="true" />
                                {pendingAction === cancelKey ? "Canceling…" : "Cancel"}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="collaboration-pending-empty">No in-app invitation is awaiting a response.</p>
                    )}
                  </div>
                </section>
              ) : (
                <div className="collaboration-manager-boundary" role="note">
                  <UsersRound size={16} aria-hidden="true" />
                  <div>
                    <strong>The register is read-only for your role.</strong>
                    <span>Workspace owners and administrators maintain membership and pending invitations.</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="collaboration-loading-state" role="status">
              <UsersRound size={18} aria-hidden="true" />
              <span>Select or refresh a workspace to open its authorship ledger.</span>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
