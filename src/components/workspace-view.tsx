"use client";

import {
  ArrowRight,
  FolderKanban,
  Inbox,
  LockKeyhole,
  Plus,
  Users,
} from "lucide-react";
import type {
  EvidenceNote,
  Paper,
  ProjectType,
  ResearchProject,
} from "@/lib/types";

type WorkspaceViewProps = {
  projects: ResearchProject[];
  papers: Paper[];
  notes: EvidenceNote[];
  onCreateProject: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenInbox: () => void;
};

const projectTypeLabels: Record<ProjectType, string> = {
  "evidence-map": "Evidence map",
  "literature-review": "Literature review",
  "systematic-review": "Systematic review",
};

function formatUpdatedAt(value: string) {
  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.getTime())) return "Recently updated";

  return `Updated ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(updatedAt)}`;
}

export function WorkspaceView({
  projects,
  papers,
  notes,
  onCreateProject,
  onOpenProject,
  onOpenInbox,
}: WorkspaceViewProps) {
  const knownPaperIds = new Set(papers.map((paper) => paper.id));
  const knownNoteIds = new Set(notes.map((note) => note.id));
  const activeProjects = projects.filter((project) => project.status === "active").length;
  const paperCount = new Set(
    projects.flatMap((project) => project.paperIds.filter((paperId) => knownPaperIds.has(paperId))),
  ).size;
  const evidenceCount = new Set(
    projects.flatMap((project) =>
      project.evidenceNoteIds.filter((noteId) => knownNoteIds.has(noteId)),
    ),
  ).size;

  return (
    <section className="view workspace-view" aria-labelledby="workspace-title">
      <div className="view-header">
        <div>
          <span className="eyebrow">Projects and shared research</span>
          <h1 className="view-title" id="workspace-title">Workspace</h1>
          <p className="view-subtitle">
            Keep each research question, source trail, reading set, and evidence record in one durable place.
          </p>
        </div>
        <div className="button-group" aria-label="Workspace actions">
          <button className="button" type="button" onClick={onOpenInbox}>
            <Inbox size={14} aria-hidden="true" /> Review inbox
          </button>
          <button className="button primary" type="button" onClick={onCreateProject}>
            <Plus size={14} aria-hidden="true" /> New project
          </button>
        </div>
      </div>

      <div className="status-strip workspace-status-strip" role="list" aria-label="Workspace totals">
        <div className="status-cell" role="listitem">
          <strong>{activeProjects}</strong>
          <span>Active projects</span>
        </div>
        <div className="status-cell" role="listitem">
          <strong>{paperCount}</strong>
          <span>Unique papers</span>
        </div>
        <div className="status-cell" role="listitem">
          <strong>{evidenceCount}</strong>
          <span>Evidence records</span>
        </div>
        <div className="status-cell" role="listitem">
          <strong>{projects.reduce((total, project) => total + project.sourceConnectionIds.length, 0)}</strong>
          <span>Source links</span>
        </div>
      </div>

      {projects.length ? (
        <div className="project-grid" aria-label="Research projects">
          {projects.map((project) => {
            const projectPapers = project.paperIds.filter((paperId) => knownPaperIds.has(paperId));
            const projectNotes = notes.filter((note) => project.evidenceNoteIds.includes(note.id));
            const openQuestionCount = projectNotes.filter((note) => Boolean(note.openQuestion)).length;
            const titleId = `workspace-project-${project.id}`;

            return (
              <article className="project-card" aria-labelledby={titleId} key={project.id}>
                <div className="project-card-head">
                  <div className="tag-row" aria-label="Project attributes">
                    <span className="type-chip">{projectTypeLabels[project.type]}</span>
                    <span className="status-chip">
                      {project.visibility === "private" ? (
                        <LockKeyhole size={10} aria-hidden="true" />
                      ) : (
                        <Users size={10} aria-hidden="true" />
                      )}
                      {project.visibility === "private" ? "Private" : "Workspace"}
                    </span>
                    {project.status === "archived" ? <span className="status-chip">Archived</span> : null}
                  </div>
                  <span className="micro-label">{formatUpdatedAt(project.updatedAt)}</span>
                </div>

                <div className="project-card-body">
                  <span className="project-card-symbol" aria-hidden="true">
                    <FolderKanban size={17} />
                  </span>
                  <div>
                    <h2 className="project-card-title" id={titleId}>{project.name}</h2>
                    <p className="project-card-question">{project.question}</p>
                    {project.description ? (
                      <p className="project-card-copy">{project.description}</p>
                    ) : null}
                  </div>
                </div>

                <div className="project-card-metrics" role="list" aria-label={`${project.name} totals`}>
                  <span role="listitem"><strong>{projectPapers.length}</strong> Papers</span>
                  <span role="listitem"><strong>{projectNotes.length}</strong> Evidence</span>
                  <span role="listitem"><strong>{openQuestionCount}</strong> Questions</span>
                  <span role="listitem"><strong>{project.sourceConnectionIds.length}</strong> Sources</span>
                </div>

                <div className="project-card-actions">
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => onOpenProject(project.id)}
                  >
                    Open project <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state workspace-empty-state">
          <FolderKanban size={24} aria-hidden="true" />
          <strong>Start with one research question.</strong>
          Create a project to give new papers, imports, and evidence a durable destination.
          <button className="button primary" type="button" onClick={onCreateProject}>
            <Plus size={14} aria-hidden="true" /> Create your first project
          </button>
        </div>
      )}
    </section>
  );
}
