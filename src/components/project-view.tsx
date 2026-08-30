"use client";

import {
  ArrowLeft,
  BookOpenText,
  CircleHelp,
  FileText,
  LockKeyhole,
  Network,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import type {
  DocumentTextExtractionStage,
  EvidenceNote,
  Paper,
  ProjectType,
  ResearchProject,
} from "@/lib/types";

type ProjectViewProps = {
  project: ResearchProject;
  papers: Paper[];
  notes: EvidenceNote[];
  onAddPapers: () => void;
  onOpenPaper: (paperId: string) => void;
  onBack: () => void;
  readerStages?: Partial<Record<string, DocumentTextExtractionStage>>;
};

const projectTypeLabels: Record<ProjectType, string> = {
  "evidence-map": "Evidence map",
  "literature-review": "Literature review",
  "systematic-review": "Systematic review",
};

export function ProjectView({
  project,
  papers,
  notes,
  onAddPapers,
  onOpenPaper,
  onBack,
  readerStages,
}: ProjectViewProps) {
  const projectPapers = project.paperIds
    .map((paperId) => papers.find((paper) => paper.id === paperId))
    .filter((paper): paper is Paper => Boolean(paper));
  const projectNotes = project.evidenceNoteIds
    .map((noteId) => notes.find((note) => note.id === noteId))
    .filter((note): note is EvidenceNote => Boolean(note));
  const openQuestionCount = projectNotes.filter((note) => Boolean(note.openQuestion)).length;
  const verifiedEvidenceCount = projectNotes.filter((note) => note.status === "verified").length;

  return (
    <section className="view project-view" aria-labelledby="project-title">
      <div className="project-breadcrumb">
        <button className="button ghost" type="button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to workspace
        </button>
      </div>

      <div className="view-header project-view-header">
        <div>
          <span className="eyebrow">{projectTypeLabels[project.type]} · {project.status}</span>
          <h1 className="view-title" id="project-title">{project.name}</h1>
          <p className="view-subtitle">{project.question}</p>
          <div className="tag-row project-attributes" aria-label="Project attributes">
            <span className="status-chip">
              {project.visibility === "private" ? (
                <LockKeyhole size={10} aria-hidden="true" />
              ) : (
                <Users size={10} aria-hidden="true" />
              )}
              {project.visibility === "private" ? "Private" : "Workspace"}
            </span>
            <span className="type-chip">{projectTypeLabels[project.type]}</span>
          </div>
        </div>
        <button className="button primary" type="button" onClick={onAddPapers}>
          <Plus size={14} aria-hidden="true" /> Add papers
        </button>
      </div>

      <div className="status-strip project-status-strip" role="list" aria-label={`${project.name} totals`}>
        <div className="status-cell" role="listitem"><strong>{projectPapers.length}</strong><span>Papers</span></div>
        <div className="status-cell" role="listitem"><strong>{projectNotes.length}</strong><span>Evidence records</span></div>
        <div className="status-cell" role="listitem"><strong>{openQuestionCount}</strong><span>Open questions</span></div>
        <div className="status-cell" role="listitem"><strong>{project.sourceConnectionIds.length}</strong><span>Source links</span></div>
      </div>

      {project.description ? (
        <div className="project-question-sheet" role="note">
          <span className="micro-label">Project scope</span>
          <p>{project.description}</p>
        </div>
      ) : null}

      <div className="project-content-grid">
        <section className="panel project-library-panel" aria-labelledby="project-library-title">
          <header className="panel-header">
            <h2 className="panel-title" id="project-library-title">Project library</h2>
            <span className="micro-label">{projectPapers.length} papers</span>
          </header>
          {projectPapers.length ? (
            <div className="project-paper-list">
              {projectPapers.map((paper, index) => {
                const readerStage = readerStages?.[paper.id];
                const readerReady = readerStages === undefined || readerStage === "ready";
                const readerLabel = readerStages === undefined
                  ? "Read & extract"
                  : readerStage === "ready"
                    ? "Open Reader"
                    : readerStage === "queued" || readerStage === "extracting" || readerStage === "not-started"
                      ? "Text processing"
                      : readerStage === "no-text"
                        ? "No text layer"
                        : readerStage === "failed"
                          ? "Extraction failed"
                          : "Link PDF first";
                return (
                <article className="project-paper-row" aria-labelledby={`project-paper-${paper.id}`} key={paper.id}>
                  <span className="paper-row-number">{String(index + 1).padStart(2, "0")}</span>
                  <div className="project-paper-copy">
                    <h3 id={`project-paper-${paper.id}`}>{paper.title}</h3>
                    <p>{paper.authors.slice(0, 2).join(", ")}{paper.authors.length > 2 ? " et al." : ""} · {paper.venue} · {paper.year}</p>
                    <div className="tag-row" aria-label="Paper status">
                      <span className="tag">{paper.type}</span>
                      <span className="tag">{paper.readingStatus}</span>
                      {paper.identifiers[0] ? <span className="tag">{paper.identifiers[0].scheme.toUpperCase()}</span> : null}
                    </div>
                  </div>
                  <button
                    className={`button small${readerReady && readerStages !== undefined ? " primary" : ""}`}
                    type="button"
                    disabled={!readerReady}
                    onClick={() => onOpenPaper(paper.id)}
                  >
                    <BookOpenText size={12} aria-hidden="true" /> {readerLabel}
                  </button>
                </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state project-library-empty">
              <BookOpenText size={22} aria-hidden="true" />
              <strong>No papers in this project yet.</strong>
              Add papers from Discover or file a reviewed Inbox record here.
              <button className="button primary" type="button" onClick={onAddPapers}>
                <Plus size={14} aria-hidden="true" /> Find papers
              </button>
            </div>
          )}
        </section>

        <aside className="panel project-evidence-panel" aria-labelledby="project-evidence-title">
          <header className="panel-header">
            <h2 className="panel-title" id="project-evidence-title">Evidence snapshot</h2>
            <span className="micro-label">{verifiedEvidenceCount} verified</span>
          </header>
          {projectNotes.length ? (
            <div className="project-evidence-list">
              {projectNotes.slice(0, 5).map((note) => (
                <article className="project-evidence-row" key={note.id}>
                  <span className="project-evidence-icon" aria-hidden="true">
                    {note.openQuestion ? <CircleHelp size={13} /> : <Network size={13} />}
                  </span>
                  <div>
                    <h3>{note.title}</h3>
                    <p>{note.claim}</p>
                    <div className="project-evidence-source-row">
                      <span className="source-chip">
                        <FileText size={9} aria-hidden="true" /> {note.provenance.sourceTitle}
                      </span>
                      <span className={`project-grounding-state ${note.grounding?.state ?? "manual"}`}>
                        <ShieldCheck size={9} aria-hidden="true" />
                        {note.grounding?.state === "current"
                          ? "Source current"
                          : note.grounding?.state === "superseded"
                            ? "Source updated"
                            : note.grounding?.state === "unresolvable"
                              ? "Anchor unavailable"
                              : "Manual source"}
                      </span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state project-evidence-empty">
              <Network size={22} aria-hidden="true" />
              <strong>No evidence records yet.</strong>
              Open a paper and capture the first source-linked claim.
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
