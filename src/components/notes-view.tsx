"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileCheck2,
  History,
  Link2,
  Network,
  Quote,
  RefreshCw,
} from "lucide-react";
import { getSectionsForPaper } from "@/lib/data";
import type { Collection, ConfidenceLevel, EvidenceNote, EvidenceNoteKind, Paper, SourceLocator } from "@/lib/types";
import {
  evidenceReviewSessionProjection,
  evidenceRevisionActions,
  evidenceRevisionHistory,
  latestEvidenceNoteHeads,
} from "@/lib/workspace";
import { EvidenceReviewDialog } from "./evidence-review-dialog";
import type { WorkspaceActionResult } from "./workspace-action";

export type NoteDraft = {
  claim: string;
  collectionId: string;
  confidence: ConfidenceLevel;
  evidence: string;
  figureLabel: string;
  interpretation: string;
  openQuestion: string;
  page: string;
  paperId: string;
  sectionId: string;
  title: string;
};

type NotesViewProps = {
  collections: Collection[];
  currentPaperId: string;
  mode: "demo" | "live";
  notes: EvidenceNote[];
  onAddNote: (draft: NoteDraft) => Promise<WorkspaceActionResult>;
  onFileNote: (noteId: string, collectionId: string) => Promise<WorkspaceActionResult>;
  onJumpToSource: (paperId: string, locator?: SourceLocator, noteId?: string) => void;
  onReanchorNote?: (note: EvidenceNote, originElementId: string) => void;
  onReviewNote?: (
    noteId: string,
    operationId: string,
  ) => Promise<WorkspaceActionResult & { code?: "revision_conflict" }>;
  papers: Paper[];
};

type NoteFilter = "all" | EvidenceNoteKind;

const kindLabels: Record<EvidenceNoteKind, string> = {
  "direct-evidence": "Direct evidence",
  interpretation: "Interpretation",
  "open-question": "Open question",
};

function groundingLabel(note: EvidenceNote): string {
  if (note.grounding?.state === "superseded") return "Source updated";
  if (note.grounding?.state === "unresolvable") return "Anchor unavailable";
  return "Source current";
}

function reviewLabel(note: EvidenceNote): string {
  return note.status === "verified"
    ? "Reviewed"
    : note.status === "needs-verification"
      ? "Needs verification"
      : "Captured";
}

function formatRevisionDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date)
    : "Date unavailable";
}

function RevisionLedger({ head, notes }: { head: EvidenceNote; notes: EvidenceNote[] }) {
  const history = evidenceRevisionHistory(head, notes);
  if (history.length < 2) return null;
  return (
    <details className="revision-ledger">
      <summary>
        <span><History size={12} aria-hidden="true" /> Revision ledger</span>
        <span>{history.length} immutable revisions <ChevronDown size={11} aria-hidden="true" /></span>
      </summary>
      <ol>
        {history.map((revision) => (
          <li className={revision.revision.isLatest ? "current" : undefined} key={revision.id}>
            <span className="revision-ledger-marker">v{revision.revision.number}</span>
            <div className="revision-ledger-entry">
              <header>
                <strong>{revision.revision.isLatest ? "Current head" : "Preserved revision"}</strong>
                <span><Clock3 size={9} aria-hidden="true" /> {formatRevisionDate(revision.reviewedAt ?? revision.updatedAt)}</span>
              </header>
              <div className="revision-ledger-stamps">
                <span className={`verification-chip ${revision.status}`}>{reviewLabel(revision)}</span>
                {revision.grounding ? <span className={`grounding-chip ${revision.grounding.state}`}>{groundingLabel(revision)}</span> : null}
              </div>
              {!revision.revision.isLatest ? (
                <details className="revision-ledger-inspection">
                  <summary>Inspect preserved revision</summary>
                  <div>
                    <span className="source-label">Claim</span>
                    <p>{revision.claim}</p>
                    <span className="source-label">Exact excerpt</span>
                    <blockquote>{revision.evidence}</blockquote>
                    <span className="source-label">Interpretation</span>
                    <p>{revision.interpretation}</p>
                  </div>
                </details>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function NotesView({ collections, currentPaperId, mode, notes, onAddNote, onFileNote, onJumpToSource, onReanchorNote, onReviewNote, papers }: NotesViewProps) {
  const [filter, setFilter] = useState<NoteFilter>("all");
  const [saving, setSaving] = useState(false);
  const [filingNoteId, setFilingNoteId] = useState<string>();
  const [feedback, setFeedback] = useState<{
    tone: "error" | "success";
    message: string;
  }>();
  const [reviewSession, setReviewSession] = useState<{
    note: EvidenceNote;
    operationId: string;
    originElementId: string;
    submitted: boolean;
  }>();
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const [draft, setDraft] = useState<NoteDraft>({
    claim: "",
    collectionId: "",
    confidence: "medium",
    evidence: "",
    figureLabel: "",
    interpretation: "",
    openQuestion: "",
    page: "",
    paperId: currentPaperId,
    sectionId: "",
    title: "",
  });

  const headNotes = useMemo(() => latestEvidenceNoteHeads(notes), [notes]);
  const currentReviewNote = reviewSession
    ? notes.find((note) => note.id === reviewSession.note.id)
    : undefined;
  const reviewProjection = reviewSession
    ? evidenceReviewSessionProjection(reviewSession.note, currentReviewNote, {
        saving: reviewSaving,
        submitted: reviewSession.submitted,
      })
    : undefined;
  const reviewSessionConflict = reviewProjection?.conflicted === true;
  const reviewDialogNote = reviewProjection?.dialogNote;
  const visibleFeedback = reviewSessionConflict
    ? {
        tone: "error" as const,
        message: "This evidence chain advanced. Review the latest revision before marking it reviewed.",
      }
    : feedback;
  const filteredNotes = useMemo(
    () => headNotes.filter((note) => filter === "all" || note.kind === filter),
    [filter, headNotes],
  );
  const selectedPaperId = papers.some((paper) => paper.id === draft.paperId)
    ? draft.paperId
    : papers.some((paper) => paper.id === currentPaperId)
      ? currentPaperId
      : papers[0]?.id ?? "";
  const sourceSections = getSectionsForPaper(selectedPaperId);

  useEffect(() => {
    if (!reviewSession || !reviewSessionConflict) return;
    const chainElementId = `evidence-chain-${reviewSession.note.revision.rootId}`;
    const frame = window.requestAnimationFrame(() => {
      setReviewSession(undefined);
      setReviewError(undefined);
      setFeedback({
        tone: "error",
        message: "This evidence chain advanced. Review the latest revision before marking it reviewed.",
      });
      document.getElementById(chainElementId)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reviewSession, reviewSessionConflict]);

  function updateDraft<Field extends keyof NoteDraft>(field: Field, value: NoteDraft[Field]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function submitNote(event: React.FormEvent) {
    event.preventDefault();
    if (
      saving
      || !selectedPaperId
      || !draft.claim.trim()
      || !draft.evidence.trim()
      || !draft.interpretation.trim()
    ) return;
    setSaving(true);
    setFeedback(undefined);
    try {
      const result = await onAddNote({ ...draft, paperId: selectedPaperId });
      if (!result.ok) {
        setFeedback({ tone: "error", message: result.message });
        return;
      }
      setDraft((current) => ({
        ...current,
        claim: "",
        evidence: "",
        interpretation: "",
        openQuestion: "",
        title: "",
      }));
      setFeedback({ tone: "success", message: result.message });
    } catch (cause) {
      setFeedback({
        tone: "error",
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not save this evidence note.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function fileNote(noteId: string, collectionId: string) {
    if (!collectionId || filingNoteId) return;
    setFilingNoteId(noteId);
    setFeedback(undefined);
    try {
      const result = await onFileNote(noteId, collectionId);
      setFeedback({
        tone: result.ok ? "success" : "error",
        message: result.message,
      });
    } catch (cause) {
      setFeedback({
        tone: "error",
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not file this note.",
      });
    } finally {
      setFilingNoteId(undefined);
    }
  }

  function closeReview() {
    if (reviewSaving) return;
    const originElementId = reviewSession?.originElementId;
    setReviewSession(undefined);
    setReviewError(undefined);
    if (originElementId) {
      window.requestAnimationFrame(() => {
        document.getElementById(originElementId)?.focus({ preventScroll: true });
      });
    }
  }

  async function confirmReview() {
    if (!reviewSession || !onReviewNote || reviewSaving) return;
    const submittedSession = reviewSession;
    setReviewSession((current) => current?.operationId === submittedSession.operationId
      ? { ...current, submitted: true }
      : current);
    setReviewSaving(true);
    setReviewError(undefined);
    try {
      const result = await onReviewNote(submittedSession.note.id, submittedSession.operationId);
      if (!result.ok) {
        if (result.code === "revision_conflict") {
          const chainElementId = `evidence-chain-${submittedSession.note.revision.rootId}`;
          setReviewSession(undefined);
          setReviewError(undefined);
          setFeedback({ tone: "error", message: result.message });
          window.requestAnimationFrame(() => {
            document.getElementById(chainElementId)?.focus({ preventScroll: true });
          });
          return;
        }
        setReviewError(result.message);
        return;
      }
      const chainElementId = `evidence-chain-${submittedSession.note.revision.rootId}`;
      setReviewSession(undefined);
      setFeedback({ tone: "success", message: result.message });
      window.requestAnimationFrame(() => {
        document.getElementById(chainElementId)?.focus({ preventScroll: true });
      });
    } catch (cause) {
      setReviewError(cause instanceof Error
        ? cause.message
        : "PaperPilot could not create the reviewed revision.");
    } finally {
      setReviewSaving(false);
    }
  }

  return (
    <section className="view" aria-labelledby="notes-title">
      <div className="view-header">
        <div>
          <span className="eyebrow">Notes &amp; evidence</span>
          <h1 className="view-title" id="notes-title">A trail you can defend.</h1>
          <p className="view-subtitle">Claims, source evidence, your interpretation, and unresolved questions stay distinct—and travel together.</p>
        </div>
        <div className="button-group">
          <span className="status-chip">
            <span className={`status-dot${mode === "live" ? " ready" : ""}`} />
            {mode === "live" ? "Durable workspace" : "Browser demo"}
          </span>
          <span className="status-chip"><span className="status-dot ready" /> {headNotes.length} active records{notes.length > headNotes.length ? ` · ${notes.length - headNotes.length} preserved` : ""}</span>
        </div>
      </div>

      {visibleFeedback ? (
        <div className={`workspace-action-feedback ${visibleFeedback.tone}`} role={visibleFeedback.tone === "error" ? "alert" : "status"}>
          {visibleFeedback.message}
        </div>
      ) : null}

      <div className="notes-layout">
        <div>
          <div className="notes-toolbar">
            <div className="segmented" aria-label="Filter evidence notes">
              {([
                ["all", "All"],
                ["direct-evidence", "Evidence"],
                ["interpretation", "Interpretations"],
                ["open-question", "Questions"],
              ] as const).map(([value, label]) => (
                <button
                  className={`segment${filter === value ? " active" : ""}`}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  key={value}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="result-count">Showing {filteredNotes.length} of {headNotes.length} active chains</span>
          </div>

          <div className="evidence-cards">
            {filteredNotes.map((note) => {
              const locator = note.provenance.locator;
              const paper = papers.find((item) => item.id === note.paperId);
              const availableCollections = collections.filter(
                (collection) => !note.collectionIds.includes(collection.id),
              );
              const revisionActions = evidenceRevisionActions(note);
              const reviewButtonId = `evidence-note-${note.id}-review`;
              const reanchorButtonId = `evidence-note-${note.id}-reanchor`;
              return (
                <article className={`evidence-card${note.kind === "open-question" ? " question-card" : ""}`} id={`evidence-chain-${note.revision.rootId}`} tabIndex={-1} key={note.id}>
                  <header className="evidence-card-header">
                    <span className="type-chip">
                      {note.kind === "direct-evidence" ? <FileCheck2 size={9} aria-hidden="true" /> : note.kind === "interpretation" ? <Brain size={9} aria-hidden="true" /> : <CircleHelp size={9} aria-hidden="true" />}
                      {kindLabels[note.kind]}
                    </span>
                    <span className={`confidence-chip${note.confidence === "unspecified" ? " unspecified" : note.confidence === "medium" || note.confidence === "low" ? " medium" : ""}`}>
                      {note.confidence === "unspecified" ? "Confidence not assessed" : `${note.confidence} confidence`}
                    </span>
                    {note.grounding ? (
                      <span className={`grounding-chip ${note.grounding.state}`}>
                        <Link2 size={9} aria-hidden="true" />
                        {note.grounding.state === "current"
                          ? "Source current"
                          : note.grounding.state === "superseded"
                            ? "Source updated"
                            : "Anchor unavailable"}
                      </span>
                    ) : null}
                    <span className={`verification-chip ${note.status}`}>
                      {reviewLabel(note)}
                    </span>
                    <span className="revision-number-stamp">v{note.revision.number}</span>
                    <label className="select-wrap">
                      <span className="sr-only">Add {note.title} to another collection</span>
                      <select
                        aria-label={`Add ${note.title} to another collection`}
                        value=""
                        disabled={filingNoteId === note.id || !availableCollections.length}
                        onChange={(event) => {
                          if (event.target.value) void fileNote(note.id, event.target.value);
                        }}
                      >
                        <option value="">
                          {filingNoteId === note.id
                            ? "Filing…"
                            : !collections.length
                              ? "No collections yet"
                              : !availableCollections.length
                                ? "Filed in all collections"
                                : note.collectionIds.length
                                  ? "Add to another…"
                                  : "File in collection…"}
                        </option>
                        {availableCollections.map((collection) => (
                          <option value={collection.id} key={collection.id}>{collection.name}</option>
                        ))}
                      </select>
                      <ChevronDown size={12} aria-hidden="true" />
                    </label>
                  </header>
                  <div className="evidence-nodes">
                    <div className="evidence-node">
                      <span className="node-marker-wrap"><span className="node-marker"><Quote size={10} aria-hidden="true" /></span></span>
                      <div className="node-content claim">
                        <span className="source-label">Claim · {note.title}</span>
                        <p>{note.claim}</p>
                      </div>
                    </div>
                    <div className="evidence-node">
                      <span className="node-marker-wrap"><span className="node-marker source"><BookOpen size={10} aria-hidden="true" /></span></span>
                      <div className="node-content source-content">
                        <span className="source-label">
                          {note.grounding?.state === "current"
                            ? "Server-reconstructed source excerpt"
                            : note.grounding?.state === "superseded"
                              ? "Exact excerpt · earlier admitted source"
                              : note.grounding?.state === "unresolvable"
                                ? "Exact excerpt · source anchor unavailable"
                                : note.status === "verified"
                                  ? "Verified source excerpt"
                                  : "Researcher-entered source text · verification pending"}
                        </span>
                        <p>{note.evidence}</p>
                        <button
                          className="source-chip"
                          type="button"
                          onClick={() => onJumpToSource(note.paperId, locator, note.id)}
                        >
                          <Link2 size={9} aria-hidden="true" />
                          {paper?.shortTitle ?? note.provenance.sourceTitle}
                          {locator?.sectionTitle ? ` · ${locator.sectionTitle}` : ""}
                          {locator?.figureLabel
                            ? ` · ${locator.figureLabel}`
                            : locator?.page
                              ? ` · p. ${locator.page}`
                              : locator?.pageRange
                                ? ` · pp. ${locator.pageRange[0]}–${locator.pageRange[1]}`
                                : ""}
                        </button>
                      </div>
                    </div>
                    <div className="evidence-node">
                      <span className="node-marker-wrap"><span className="node-marker interpretation"><Brain size={10} aria-hidden="true" /></span></span>
                      <div className="node-content">
                        <span className="source-label">Researcher interpretation</span>
                        <p>{note.interpretation}</p>
                      </div>
                    </div>
                    {note.openQuestion ? (
                      <div className="evidence-node">
                        <span className="node-marker-wrap"><span className="node-marker question"><CircleHelp size={10} aria-hidden="true" /></span></span>
                        <div className="node-content question-content">
                          <span className="source-label">Requires verification</span>
                          <p>{note.openQuestion}</p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {mode === "live" && (revisionActions.canReview || revisionActions.canReanchor) ? (
                    <div className="evidence-revision-actions" aria-label={`Revision actions for ${note.title}`}>
                      <div>
                        <span className="micro-label">Immutable revision controls</span>
                        <p>Each action creates a new head and keeps v{note.revision.number} in the ledger.</p>
                      </div>
                      <div className="button-group">
                        {revisionActions.canReview && onReviewNote ? (
                          <button
                            className="button small"
                            id={reviewButtonId}
                            type="button"
                            onClick={() => {
                              setReviewError(undefined);
                              setReviewSession({
                                note,
                                operationId: crypto.randomUUID(),
                                originElementId: reviewButtonId,
                                submitted: false,
                              });
                            }}
                          >
                            <CheckCheck size={12} aria-hidden="true" /> Review evidence
                          </button>
                        ) : null}
                        {revisionActions.canReanchor && onReanchorNote ? (
                          <button
                            className="button small"
                            id={reanchorButtonId}
                            type="button"
                            onClick={() => onReanchorNote(note, reanchorButtonId)}
                          >
                            <RefreshCw size={12} aria-hidden="true" /> Re-anchor in current Reader
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  <RevisionLedger head={note} notes={notes} />
                </article>
              );
            })}
            {!filteredNotes.length ? (
              <div className="empty-state">
                <strong>No notes in this evidence layer yet.</strong>
                {mode === "live"
                  ? "Use the structured form to capture a manual assertion for verification."
                  : "Use the guided reader or the structured form to capture one in this browser demo."}
              </div>
            ) : null}
          </div>
        </div>

        <form className="note-composer" onSubmit={submitNote} aria-labelledby="composer-title">
          <div className="composer-head">
            <span className="stage-label">Manual capture · verification required</span>
            <h2 id="composer-title">Add an evidence note</h2>
          </div>
          <div className="composer-body" aria-busy={saving}>
            <div className="manual-evidence-notice">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>
                Text entered here is a researcher assertion. PaperPilot saves its source pointer as <strong>needs verification</strong> until a processed document can confirm the excerpt.
              </span>
            </div>
            {!papers.length ? (
              <div className="project-form-error" role="alert">
                Add a paper to the active project before creating an evidence note.
              </div>
            ) : null}
            <label className="field-group">
              <span className="field-label">Short label</span>
              <input className="text-input" value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="What will you recognize later?" maxLength={200} disabled={saving || !papers.length} />
            </label>
            <label className="field-group">
              <span className="field-label">Claim *</span>
              <textarea className="text-area" required value={draft.claim} onChange={(event) => updateDraft("claim", event.target.value)} placeholder="Write the bounded claim…" maxLength={20_000} disabled={saving || !papers.length} />
            </label>
            <label className="field-group">
              <span className="field-label">Source text to verify *</span>
              <textarea className="text-area" required value={draft.evidence} onChange={(event) => updateDraft("evidence", event.target.value)} placeholder="Enter the passage or observation you will verify against the paper…" maxLength={50_000} disabled={saving || !papers.length} />
            </label>
            <label className="field-group">
              <span className="field-label">Interpretation *</span>
              <textarea className="text-area" required value={draft.interpretation} onChange={(event) => updateDraft("interpretation", event.target.value)} placeholder="What do you think this evidence means?" maxLength={20_000} disabled={saving || !papers.length} />
            </label>
            <label className="field-group">
              <span className="field-label">Open question</span>
              <textarea className="text-area" value={draft.openQuestion} onChange={(event) => updateDraft("openQuestion", event.target.value)} placeholder="What needs another source?" maxLength={10_000} disabled={saving || !papers.length} />
            </label>
            <label className="field-group">
              <span className="field-label">Source paper</span>
              <span className="select-wrap">
                <select
                  value={selectedPaperId}
                  onChange={(event) => setDraft((current) => ({ ...current, paperId: event.target.value, sectionId: "", page: "", figureLabel: "" }))}
                  style={{ width: "100%" }}
                  disabled={saving || !papers.length}
                >
                  {papers.map((paper) => <option value={paper.id} key={paper.id}>{paper.shortTitle}</option>)}
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </span>
              <span className="field-help"><Link2 size={9} style={{ verticalAlign: -2 }} aria-hidden="true" /> Saves with a source identifier, manual-access marker, and retrieval time.</span>
            </label>
            <label className="field-group">
              <span className="field-label">Claimed source section</span>
              <span className="select-wrap">
                <select value={draft.sectionId} onChange={(event) => updateDraft("sectionId", event.target.value)} style={{ width: "100%" }} disabled={saving || !papers.length}>
                  <option value="">Location not specified</option>
                  {sourceSections.map((section) => <option value={section.id} key={section.id}>{section.title}</option>)}
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </span>
              <span className="field-help">Leave unspecified when the exact location has not been verified.</span>
            </label>
            <div className="composer-split">
              <label className="field-group">
                <span className="field-label">Page</span>
                <input className="text-input" type="number" min="1" max="100000" value={draft.page} onChange={(event) => updateDraft("page", event.target.value)} placeholder="e.g. 7" disabled={saving || !papers.length} />
              </label>
              <label className="field-group">
                <span className="field-label">Figure</span>
                <input className="text-input" value={draft.figureLabel} onChange={(event) => updateDraft("figureLabel", event.target.value)} placeholder="e.g. Figure 5" maxLength={500} disabled={saving || !papers.length} />
              </label>
            </div>
            <label className="field-group">
              <span className="field-label">Confidence</span>
              <span className="select-wrap">
                <select value={draft.confidence} onChange={(event) => updateDraft("confidence", event.target.value as ConfidenceLevel)} style={{ width: "100%" }} disabled={saving || !papers.length}>
                  <option value="high">High — strong researcher confidence</option>
                  <option value="medium">Medium — bounded or incomplete reasoning</option>
                  <option value="low">Low — provisional assertion</option>
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </span>
            </label>
            <label className="field-group">
              <span className="field-label">File in collection</span>
              <span className="select-wrap">
                <select value={draft.collectionId} onChange={(event) => updateDraft("collectionId", event.target.value)} style={{ width: "100%" }} disabled={saving || !papers.length}>
                  <option value="">Keep unfiled for now</option>
                  {collections.map((collection) => <option value={collection.id} key={collection.id}>{collection.name}</option>)}
                </select>
                <ChevronDown size={12} aria-hidden="true" />
              </span>
            </label>
            <button className="button primary full" type="submit" disabled={saving || !selectedPaperId || !draft.claim.trim() || !draft.evidence.trim() || !draft.interpretation.trim()}>
              <Network size={13} aria-hidden="true" /> {saving ? "Saving evidence…" : "Add to evidence trail"}
            </button>
          </div>
        </form>
      </div>
      {reviewSession && reviewDialogNote ? (
        <EvidenceReviewDialog
          error={reviewError}
          key={`${reviewSession.note.id}:${reviewDialogNote.grounding?.state ?? "ungrounded"}`}
          note={reviewDialogNote}
          onCancel={closeReview}
          onConfirm={() => { void confirmReview(); }}
          paperTitle={papers.find((paper) => paper.id === reviewDialogNote.paperId)?.shortTitle ?? reviewDialogNote.provenance.sourceTitle}
          saving={reviewSaving}
        />
      ) : null}
    </section>
  );
}
