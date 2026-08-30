"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Fingerprint,
  Link2,
  LoaderCircle,
  Network,
  Quote,
  RefreshCw,
  X,
} from "lucide-react";
import type { Collection, ResearchProject } from "@/lib/types";
import type {
  EvidenceCaptureAction,
  EvidenceCaptureState,
} from "@/lib/workspace";
import { focusTrapTarget } from "@/lib/workspace/focus-trap";

type EvidenceCaptureDocketProps = {
  canCapture: boolean;
  captureState: EvidenceCaptureState;
  collections: Collection[];
  evidenceCount: number;
  onAction: (action: EvidenceCaptureAction) => void;
  onDismiss: () => void;
  onReloadSource: () => void;
  onSave: () => void;
  onViewEvidence: () => void;
  project: ResearchProject;
  sourceUpdateCount: number;
};

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function pageLabel(start: number, end: number): string {
  return start === end ? `Page ${start}` : `Pages ${start}–${end}`;
}

export function EvidenceCaptureDocket({
  canCapture,
  captureState,
  collections,
  evidenceCount,
  onAction,
  onDismiss,
  onReloadSource,
  onSave,
  onViewEvidence,
  project,
  sourceUpdateCount,
}: EvidenceCaptureDocketProps) {
  const panelRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [compact, setCompact] = useState(false);
  const active = captureState.phase !== "idle" && captureState.phase !== "reselecting";
  const sourceChangedPhase = captureState.phase === "source-changed";
  const revisionConflictPhase = captureState.phase === "revision-conflict";
  const saving = captureState.phase === "saving";
  const reanchorIntent = captureState.phase !== "idle" && captureState.intent.action === "reanchor"
    ? captureState.intent
    : undefined;
  const reanchor = Boolean(reanchorIntent);
  const predecessorRevisionNumber = reanchorIntent?.predecessorRevisionNumber ?? 0;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1179px)");
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!active) return;
    titleRef.current?.focus({ preventScroll: true });
  }, [active, saving, sourceChangedPhase]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (!compact || event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const target = focusTrapTarget(focusable.length, activeIndex, event.shiftKey);
      if (target === "native") return;
      event.preventDefault();
      if (target === "container") panelRef.current.focus({ preventScroll: true });
      if (target === "first") first?.focus();
      if (target === "last") last?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, compact, onDismiss, saving]);

  if (!active) {
    const reselecting = captureState.phase === "reselecting";
    return (
      <aside className={`evidence-docket evidence-docket-idle${reselecting ? " evidence-docket-reselecting" : ""}`} aria-labelledby="evidence-docket-idle-title">
        <div className="evidence-docket-tab" aria-hidden="true">Evidence</div>
        <header className="evidence-docket-head">
          <span className="micro-label">Marginal evidence docket</span>
          <h2 id="evidence-docket-idle-title">
            {reselecting
              ? reanchor ? "Find the replacement passage." : "Select the replacement passage."
              : "Build from the exact source."}
          </h2>
          <p>
            {reselecting
              ? reanchor
                ? `Revision ${predecessorRevisionNumber} remains preserved. Select the corresponding passage in the current source; the claim and interpretation will carry forward unchanged.`
                : "Your note fields and retry identity are preserved. Select text in the current source to update only its custody anchor."
              : canCapture
              ? "Select text in the attested paper, or use a paragraph capture button."
              : "This workspace role can inspect grounded evidence but cannot create it."}
          </p>
        </header>
        <div className="evidence-docket-totals" aria-label="Evidence totals">
          <span><strong>{evidenceCount}</strong> grounded records</span>
          <span className={sourceUpdateCount ? "attention" : ""}>
            <strong>{sourceUpdateCount}</strong> source updates
          </span>
        </div>
        <div className="evidence-docket-instruction">
          <Quote size={18} aria-hidden="true" />
          <p>{reselecting
            ? reanchor
              ? "The next cobalt custody bracket will become the source for a new captured revision."
              : "The next cobalt custody bracket replaces the stale anchor; your research fields remain intact."
            : "A cobalt custody bracket will mark the selected source span before anything is saved."}</p>
        </div>
        <button className="button full" type="button" onClick={onViewEvidence}>
          <Network size={13} aria-hidden="true" /> View evidence trail
        </button>
        {reselecting ? (
          <button className="button ghost full evidence-reselection-cancel" type="button" onClick={onDismiss}>
            <X size={13} aria-hidden="true" /> {reanchor ? "Cancel re-anchor" : "Cancel reselection"}
          </button>
        ) : null}
      </aside>
    );
  }

  const draft = captureState.draft;
  const selection = captureState.selection;
  const sourceChanged = sourceChangedPhase;
  const canSave = canCapture
    && !saving
    && !sourceChanged
    && !revisionConflictPhase
    && (reanchor || (
      Boolean(draft.projectId)
      && Boolean(draft.title.trim())
      && Boolean(draft.claim.trim())
      && Boolean(draft.interpretation.trim())
    ));

  function change(field: keyof typeof draft, value: string | string[]) {
    onAction({ type: "field-changed", field, value });
  }

  return (
    <>
      {compact ? (
        <button
          className="evidence-docket-backdrop"
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          disabled={saving}
          onClick={onDismiss}
        />
      ) : null}
      <aside
        className={`evidence-docket evidence-docket-active${compact ? " compact" : ""}`}
        aria-labelledby="evidence-docket-title"
        aria-modal={compact ? "true" : "false"}
        aria-busy={saving}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="evidence-docket-tab" aria-hidden="true">Evidence</div>
        <header className="evidence-docket-head evidence-docket-capture-head">
          <div>
            <span className="micro-label">{reanchor ? `Evidence re-anchoring · revision ${predecessorRevisionNumber}` : "Grounded source capture"}</span>
            <h2 id="evidence-docket-title" ref={titleRef} tabIndex={-1}>{reanchor ? "Confirm replacement source." : "File this passage."}</h2>
          </div>
          <button className="button ghost icon-button" type="button" disabled={saving} onClick={onDismiss} aria-label="Close evidence capture">
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="evidence-source-slip">
          <div className="evidence-source-slip-head">
            <span><CheckCircle2 size={11} aria-hidden="true" /> {reanchor ? "Replacement Reader source" : "Exact Reader source"}</span>
            <span>{pageLabel(selection.pageStart, selection.pageEnd)}</span>
          </div>
          <blockquote aria-label="Exact source text; cannot be edited">{selection.quoteText}</blockquote>
          <div className="evidence-source-locator">
            <Link2 size={10} aria-hidden="true" />
            {selection.paragraphStartId === selection.paragraphEndId
              ? selection.paragraphStartId
              : `${selection.paragraphStartId} → ${selection.paragraphEndId}`}
            <span>·</span>
            {selection.selectedChunkIds.length} {selection.selectedChunkIds.length === 1 ? "chunk" : "chunks"}
          </div>
          <details>
            <summary><Fingerprint size={10} aria-hidden="true" /> Technical custody</summary>
            <dl>
              <div><dt>Extraction</dt><dd>{captureState.source.extractionId}</dd></div>
              <div><dt>Manifest</dt><dd>{captureState.source.manifestSha256}</dd></div>
              <div><dt>Selection hash</dt><dd>{selection.anchor.expectedQuoteSha256}</dd></div>
            </dl>
          </details>
        </div>

        {reanchor ? (
          <section className="evidence-reanchor-carry" aria-labelledby="evidence-reanchor-carry-title">
            <header>
              <div>
                <span className="micro-label">Research fields carried forward</span>
                <h3 id="evidence-reanchor-carry-title">{draft.title}</h3>
              </div>
              <span className="revision-number-stamp">v{predecessorRevisionNumber} → v{predecessorRevisionNumber + 1}</span>
            </header>
            <dl>
              <div><dt>Bounded claim</dt><dd>{draft.claim}</dd></div>
              <div><dt>Interpretation</dt><dd>{draft.interpretation}</dd></div>
              {draft.openQuestion ? <div><dt>Open question</dt><dd>{draft.openQuestion}</dd></div> : null}
            </dl>
            <p>The server copies these fields exactly. The replacement quote becomes a new <strong>Captured</strong> revision, ready for a separate review.</p>
          </section>
        ) : null}

        {sourceChanged ? (
          <div className="evidence-capture-alert source-changed" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <div>
              <strong>Source version changed.</strong>
              <p>Your fields are preserved, but this passage cannot be saved against the replacement source.</p>
              <button className="button small" type="button" onClick={onReloadSource}>
                <RefreshCw size={12} aria-hidden="true" /> Reload and reselect
              </button>
            </div>
          </div>
        ) : revisionConflictPhase ? (
          <div className="evidence-capture-alert source-changed" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <div>
              <strong>This evidence chain advanced.</strong>
              <p>{captureState.error ?? "Another revision became current before this replacement could be saved."}</p>
              <button className="button small" type="button" onClick={() => { onDismiss(); onViewEvidence(); }}>
                <Network size={12} aria-hidden="true" /> Review latest revision
              </button>
            </div>
          </div>
        ) : captureState.error ? (
          <div className="evidence-capture-alert" role="alert">
            <AlertTriangle size={15} aria-hidden="true" /> {captureState.error}
          </div>
        ) : null}

        <form
          className="evidence-capture-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) onSave();
          }}
        >
          {reanchor ? null : <>
          <label className="field-group">
            <span className="field-label">Evidence kind</span>
            <span className="select-wrap">
              <select value={draft.kind} onChange={(event) => change("kind", event.target.value)} disabled={saving || sourceChanged}>
                <option value="direct-evidence">Direct evidence</option>
                <option value="interpretation">Interpretation</option>
                <option value="open-question">Open question</option>
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </span>
          </label>

          <label className="field-group">
            <span className="field-label">Short label *</span>
            <input
              className="text-input"
              value={draft.title}
              onChange={(event) => change("title", event.target.value)}
              placeholder="What will you recognize later?"
              maxLength={200}
              disabled={saving || sourceChanged}
              required
            />
          </label>

          <label className="field-group">
            <span className="field-label">What this supports *</span>
            <textarea
              className="text-area evidence-capture-claim"
              value={draft.claim}
              onChange={(event) => change("claim", event.target.value)}
              placeholder="Write one bounded claim supported by this passage…"
              maxLength={20_000}
              disabled={saving || sourceChanged}
              required
            />
          </label>

          <label className="field-group">
            <span className="field-label">Your interpretation *</span>
            <textarea
              className="text-area"
              value={draft.interpretation}
              onChange={(event) => change("interpretation", event.target.value)}
              placeholder="What does the source mean in this project?"
              maxLength={20_000}
              disabled={saving || sourceChanged}
              required
            />
          </label>

          <label className="field-group">
            <span className="field-label">Open question</span>
            <textarea
              className="text-area"
              value={draft.openQuestion ?? ""}
              onChange={(event) => change("openQuestion", event.target.value)}
              placeholder="What still needs another source?"
              maxLength={10_000}
              disabled={saving || sourceChanged}
            />
          </label>

          <label className="field-group">
            <span className="field-label">Project</span>
            <span className="select-wrap">
              <select value={draft.projectId} onChange={(event) => change("projectId", event.target.value)} disabled={saving || sourceChanged} required>
                <option value={project.id}>{project.name}</option>
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </span>
            <span className="field-help">Grounded evidence always has an explicit project destination.</span>
          </label>

          <label className="field-group">
            <span className="field-label">Collection</span>
            <span className="select-wrap">
              <select value={draft.collectionId} onChange={(event) => change("collectionId", event.target.value)} disabled={saving || sourceChanged}>
                <option value="">Keep unfiled for now</option>
                {collections.map((collection) => (
                  <option value={collection.id} key={collection.id}>{collection.name}</option>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </span>
          </label>

          <label className="field-group">
            <span className="field-label">Confidence</span>
            <span className="select-wrap">
              <select value={draft.confidence} onChange={(event) => change("confidence", event.target.value)} disabled={saving || sourceChanged}>
                <option value="unspecified">Not assessed</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </span>
          </label>

          <label className="field-group">
            <span className="field-label">Tags</span>
            <input
              className="text-input"
              value={draft.tags.join(", ")}
              onChange={(event) => change("tags", Array.from(new Set(
                event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean),
              )).slice(0, 50))}
              placeholder="method, limitation, follow-up"
              maxLength={5_000}
              disabled={saving || sourceChanged}
            />
          </label>

          </>}

          <button className="button primary full evidence-capture-save" type="submit" disabled={!canSave}>
            {saving ? <LoaderCircle className="auth-spinner" size={13} aria-hidden="true" /> : <Network size={13} aria-hidden="true" />}
            {saving
              ? reanchor ? "Creating re-anchored revision…" : "Saving grounded evidence…"
              : reanchor ? "Create re-anchored revision" : "Save grounded evidence"}
          </button>
        </form>
      </aside>
    </>
  );
}
