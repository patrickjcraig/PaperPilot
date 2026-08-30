"use client";

import type { ReactNode } from "react";
import {
  BookOpenText,
  Compass,
  FolderKanban,
  Inbox,
  LibraryBig,
  Network,
  PlugZap,
  Plus,
  UsersRound,
} from "lucide-react";

export type AppView =
  | "discover"
  | "workspace"
  | "collaboration"
  | "inbox"
  | "sources"
  | "project"
  | "reader"
  | "notes"
  | "collections";

type AppShellProps = {
  activeProjectName: string;
  activeView: AppView;
  children: ReactNode;
  collectionCount: number;
  inboxCount: number;
  noteCount: number;
  onNavigate: (view: AppView) => void;
  readingProgress: number;
  workspaceName?: string;
  userInitials?: string;
  userLabel?: string;
  onSignOut?: () => void;
};

const primaryNavigation = [
  { id: "discover" as const, label: "Discover", icon: Compass },
  { id: "workspace" as const, label: "Workspace", icon: FolderKanban },
  { id: "collaboration" as const, label: "People", icon: UsersRound },
  { id: "inbox" as const, label: "Inbox", icon: Inbox },
  { id: "sources" as const, label: "Sources", icon: PlugZap },
];

const projectNavigation = [
  { id: "project" as const, label: "Project library", icon: LibraryBig },
  { id: "reader" as const, label: "Paper reader", icon: BookOpenText },
  { id: "notes" as const, label: "Evidence", icon: Network },
  { id: "collections" as const, label: "Collections", icon: LibraryBig },
];

const workflowSteps = [
  { id: "discover", label: "Discover", views: ["discover"] },
  { id: "collect", label: "Collect", views: ["inbox", "sources"] },
  { id: "organize", label: "Organize", views: ["workspace", "collaboration", "project", "collections"] },
  { id: "evidence", label: "Build evidence", views: ["reader", "notes"] },
] as const;

export function AppShell({
  activeProjectName,
  activeView,
  children,
  collectionCount,
  inboxCount,
  noteCount,
  onNavigate,
  readingProgress,
  workspaceName = "Personal workspace",
  userInitials = "PR",
  userLabel = "Signed in as demo researcher",
  onSignOut,
}: AppShellProps) {
  const projectCounts: Partial<Record<AppView, number>> = {
    notes: noteCount,
    collections: collectionCount,
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <button className="brand" type="button" onClick={() => onNavigate("discover")} aria-label="Go to PaperPilot Discover">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span className="brand-wordmark">PaperPilot</span>
        </button>

        <div className="topbar-trail" aria-label={`Current project: ${activeProjectName}`}>
          <span className="trail-label">{workspaceName}</span>
          <span aria-hidden="true">/</span>
          <span className="trail-goal">{activeProjectName}</span>
        </div>

        <div className="topbar-actions">
          <button className="button small" type="button" onClick={() => onNavigate("sources")}>
            <Plus size={13} aria-hidden="true" /> Quick import
          </button>
          {onSignOut ? (
            <button
              className="avatar avatar-button"
              type="button"
              onClick={onSignOut}
              aria-label={`${userLabel}. Sign out`}
              title="Sign out"
            >
              {userInitials}
            </button>
          ) : (
            <span className="avatar" aria-label={userLabel}>{userInitials}</span>
          )}
        </div>
      </header>

      <aside className="sidebar" aria-label="Application navigation">
        <span className="sidebar-group-label">Research</span>
        <nav aria-label="Primary navigation">
          <ul className="nav-list">
            {primaryNavigation.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  className={`nav-button${activeView === id ? " active" : ""}`}
                  type="button"
                  aria-current={activeView === id ? "page" : undefined}
                  onClick={() => onNavigate(id)}
                >
                  <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                  <span>{label}</span>
                  {id === "inbox" ? <span className="nav-count">{inboxCount}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <span className="sidebar-group-label project-group-label">Current project</span>
        <nav aria-label="Current project navigation">
          <ul className="nav-list project-nav-list">
            {projectNavigation.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  className={`nav-button${activeView === id ? " active" : ""}`}
                  type="button"
                  aria-current={activeView === id ? "page" : undefined}
                  onClick={() => onNavigate(id)}
                >
                  <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                  <span>{label}</span>
                  {projectCounts[id] !== undefined ? <span className="nav-count">{projectCounts[id]}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-context">
          <span className="micro-label">Active project</span>
          <p className="context-title">{activeProjectName}</p>
          <div
            className="context-progress-track"
            role="progressbar"
            aria-label="Current paper reading progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={readingProgress}
          >
            <div className="context-progress-fill" style={{ width: `${readingProgress}%` }} />
          </div>
          <div className="context-meta"><span>Evidence linked</span><span>{readingProgress}% read</span></div>
        </div>
      </aside>

      <main className="main-content" id="main-content" tabIndex={-1}>
        <ol className="workflow-trace" aria-label="Research workflow">
          {workflowSteps.map((step, index) => {
            const isCurrent = step.views.some((view) => view === activeView);
            return (
              <li className={isCurrent ? "current" : ""} aria-current={isCurrent ? "step" : undefined} key={step.id}>
                <span className="workflow-number">{index + 1}</span>
                <span>{step.label}</span>
              </li>
            );
          })}
        </ol>
        {children}
      </main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {primaryNavigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`mobile-nav-button${activeView === id ? " active" : ""}`}
            type="button"
            aria-current={activeView === id ? "page" : undefined}
            onClick={() => onNavigate(id)}
          >
            <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
            {id === "inbox" && inboxCount ? <span className="mobile-nav-count">{inboxCount}</span> : null}
          </button>
        ))}
      </nav>
    </div>
  );
}
