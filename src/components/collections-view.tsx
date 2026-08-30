"use client";

import { useCallback, useState } from "react";
import { ArrowRight, BookOpenText, Check, FileText, FolderOpen, Network, Plus } from "lucide-react";
import type {
  Collection,
  DocumentTextExtractionStage,
  EvidenceNote,
  Paper,
} from "@/lib/types";
import { CollectionCreateDialog, type CollectionDraft } from "./collection-create-dialog";
import type { WorkspaceActionResult } from "./workspace-action";

type CollectionsViewProps = {
  collections: Collection[];
  currentPaperId: string;
  mode: "demo" | "live";
  notes: EvidenceNote[];
  onAddPaper: (collectionId: string, paperId: string) => Promise<WorkspaceActionResult>;
  onCreateCollection: (draft: CollectionDraft) => Promise<WorkspaceActionResult>;
  onOpenPaper: (paperId: string) => void;
  papers: Paper[];
  projectName: string;
  selectedCollectionId: string;
  setSelectedCollectionId: (collectionId: string) => void;
  readerStages?: Partial<Record<string, DocumentTextExtractionStage>>;
};

export function CollectionsView({
  collections,
  currentPaperId,
  mode,
  notes,
  onAddPaper,
  onCreateCollection,
  onOpenPaper,
  papers,
  projectName,
  selectedCollectionId,
  setSelectedCollectionId,
  readerStages,
}: CollectionsViewProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedPaperId, setSelectedPaperId] = useState(currentPaperId);
  const [addingPaper, setAddingPaper] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "success";
    message: string;
  }>();
  const closeCreateDialog = useCallback(() => setShowCreateDialog(false), []);
  const collection = collections.find((item) => item.id === selectedCollectionId) ?? collections[0];
  const collectionPapers = collection ? collection.paperIds.map((id) => papers.find((paper) => paper.id === id)).filter((paper): paper is Paper => Boolean(paper)) : [];
  const collectionNotes = collection ? collection.noteIds.map((id) => notes.find((note) => note.id === id)).filter((note): note is EvidenceNote => Boolean(note)) : [];
  const effectivePaperId = papers.some((paper) => paper.id === selectedPaperId)
    ? selectedPaperId
    : papers.some((paper) => paper.id === currentPaperId)
      ? currentPaperId
      : papers[0]?.id ?? "";
  const hasSelectedPaper = collection?.paperIds.includes(effectivePaperId) ?? false;

  async function addSelectedPaper() {
    if (!collection || !effectivePaperId || hasSelectedPaper || addingPaper) return;
    setAddingPaper(true);
    setFeedback(undefined);
    try {
      const result = await onAddPaper(collection.id, effectivePaperId);
      setFeedback({
        tone: result.ok ? "success" : "error",
        message: result.message,
      });
    } catch (cause) {
      setFeedback({
        tone: "error",
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not add this paper to the collection.",
      });
    } finally {
      setAddingPaper(false);
    }
  }

  async function createCollection(draft: CollectionDraft): Promise<WorkspaceActionResult> {
    setFeedback(undefined);
    try {
      const result = await onCreateCollection(draft);
      setFeedback({
        tone: result.ok ? "success" : "error",
        message: result.message,
      });
      return result;
    } catch (cause) {
      const result = {
        ok: false,
        message: cause instanceof Error
          ? cause.message
          : "PaperPilot could not create this collection.",
      };
      setFeedback({ tone: "error", message: result.message });
      return result;
    }
  }

  return (
    <section className="view" aria-labelledby="collections-title">
      <div className="view-header">
        <div>
          <span className="eyebrow">Collections</span>
          <h1 className="view-title" id="collections-title">Evidence, with a destination.</h1>
          <p className="view-subtitle">Organize papers and attributable notes around the argument you are building—not around file locations.</p>
        </div>
        <div className="button-group">
          <span className="status-chip">
            <span className={`status-dot${mode === "live" ? " ready" : ""}`} />
            {mode === "live" ? "Durable workspace" : "Browser demo"}
          </span>
          <button className="button primary" type="button" onClick={() => setShowCreateDialog(true)}>
            <Plus size={13} aria-hidden="true" /> Create collection
          </button>
        </div>
      </div>

      {feedback ? (
        <div className={`workspace-action-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.message}
        </div>
      ) : null}

      <div className="collections-layout">
        <aside>
          <div className="notes-toolbar">
            <span className="result-count">{collections.length} active collections</span>
          </div>
          <div className="collection-list">
            {collections.map((item) => (
              <button
                className={`collection-button${collection?.id === item.id ? " active" : ""}`}
                type="button"
                onClick={() => setSelectedCollectionId(item.id)}
                key={item.id}
              >
                <span className="collection-symbol"><FolderOpen size={16} aria-hidden="true" /></span>
                <span className="collection-copy">
                  <strong>{item.name}</strong>
                  <span>{item.paperIds.length} papers · {item.evidenceClaimCount} claims</span>
                </span>
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            ))}
            {!collections.length ? (
              <div className="empty-state collection-list-empty">
                <strong>No collections in {projectName} yet.</strong>
                Create one to give papers and evidence a shared destination.
                <button className="button primary small" type="button" onClick={() => setShowCreateDialog(true)}>
                  <Plus size={12} aria-hidden="true" /> Create collection
                </button>
              </div>
            ) : null}
          </div>
        </aside>

        {collection ? (
          <article className="collection-detail">
            <header className="collection-detail-head">
              <div>
                <span className="eyebrow">Active collection</span>
                <h2 className="collection-detail-title">{collection.name}</h2>
                <p className="collection-detail-copy">{collection.description}</p>
                <div className="collection-add-paper" style={{ marginTop: 16 }}>
                  <label className="select-wrap">
                    <span className="sr-only">Choose a project paper</span>
                    <select
                      aria-label="Choose a project paper"
                      value={effectivePaperId}
                      onChange={(event) => setSelectedPaperId(event.target.value)}
                      disabled={addingPaper || !papers.length}
                    >
                      {!papers.length ? <option value="">No project papers</option> : null}
                      {papers.map((paper) => (
                        <option value={paper.id} key={paper.id}>{paper.shortTitle}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className={`button ${hasSelectedPaper ? "" : "primary"}`}
                    type="button"
                    disabled={addingPaper || !effectivePaperId || hasSelectedPaper}
                    onClick={() => void addSelectedPaper()}
                  >
                    {hasSelectedPaper ? <Check size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
                    {addingPaper ? "Adding…" : hasSelectedPaper ? "Paper already saved" : "Add project paper"}
                  </button>
                </div>
              </div>
              <div className="collection-stats" aria-label="Collection totals">
                <span className="collection-stat"><strong>{collection.paperIds.length}</strong><span>Papers</span></span>
                <span className="collection-stat"><strong>{collection.evidenceClaimCount}</strong><span>Claims</span></span>
                <span className="collection-stat"><strong>{collection.openQuestionCount}</strong><span>Questions</span></span>
              </div>
            </header>

            <section className="collection-section" aria-labelledby="collection-papers-heading">
              <div className="collection-section-head">
                <h3 className="panel-title" id="collection-papers-heading">Papers</h3>
                <span className="micro-label">Reading set</span>
              </div>
              {collectionPapers.map((paper, index) => {
                const readerStage = readerStages?.[paper.id];
                const readerReady = readerStages === undefined || readerStage === "ready";
                const readerLabel = readerStages === undefined || readerStage === "ready"
                  ? "Open Reader"
                  : readerStage === "queued" || readerStage === "extracting" || readerStage === "not-started"
                    ? "Text processing"
                    : readerStage === "no-text"
                      ? "No text layer"
                      : readerStage === "failed"
                        ? "Extraction failed"
                        : "Link PDF first";
                return (
                <div className="collection-paper-row" key={paper.id}>
                  <span className="paper-row-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="paper-row-copy">
                    <strong>{paper.title}</strong>
                    <span>{paper.authors[0]} et al. · {paper.venue} · {paper.year}</span>
                  </span>
                  <button
                    className={`button small${readerReady && readerStages !== undefined ? " primary" : ""}`}
                    type="button"
                    disabled={!readerReady}
                    onClick={() => onOpenPaper(paper.id)}
                  >
                    <BookOpenText size={12} aria-hidden="true" /> {readerLabel}
                  </button>
                </div>
                );
              })}
            </section>

            <section className="collection-section" aria-labelledby="collection-evidence-heading">
              <div className="collection-section-head">
                <h3 className="panel-title" id="collection-evidence-heading">Evidence notes</h3>
                <span className="micro-label">Claim layer</span>
              </div>
              {collectionNotes.length ? collectionNotes.map((note) => (
                <div className="collection-paper-row" key={note.id}>
                  <span className="paper-row-number"><Network size={12} aria-hidden="true" /></span>
                  <span className="paper-row-copy">
                    <strong>{note.title}</strong>
                    <span>
                      {note.status === "verified" ? "Verified" : note.status === "needs-verification" ? "Needs verification" : "Captured"}
                      {" · "}{note.confidence} confidence
                      {" · "}{note.provenance.locator?.figureLabel ?? (note.provenance.locator?.page ? `Page ${note.provenance.locator.page}` : "Paper identified")}
                    </span>
                  </span>
                  <span className="type-chip"><FileText size={9} aria-hidden="true" /> {note.kind.replace("-", " ")}</span>
                </div>
              )) : (
                <div className="empty-state">
                  <strong>No evidence notes in this collection yet.</strong>
                  Capture a note, then file it here from the Evidence view.
                </div>
              )}
            </section>
          </article>
        ) : (
          <article className="collection-detail collection-empty-detail">
            <div className="empty-state">
              <FolderOpen size={22} aria-hidden="true" />
              <strong>Create the first destination for this project.</strong>
              Collections keep a reading set and its evidence layer together.
            </div>
          </article>
        )}
      </div>

      {showCreateDialog ? (
        <CollectionCreateDialog
          existingCollectionNames={collections.map((item) => item.name)}
          mode={mode}
          onClose={closeCreateDialog}
          onCreate={createCollection}
        />
      ) : null}
    </section>
  );
}
