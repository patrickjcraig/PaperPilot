"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCheck,
  Fingerprint,
  LoaderCircle,
  Quote,
  X,
} from "lucide-react";
import type { EvidenceNote } from "@/lib/types";
import { focusTrapTarget } from "@/lib/workspace/focus-trap";

type EvidenceReviewDialogProps = {
  error?: string;
  note: EvidenceNote;
  onCancel: () => void;
  onConfirm: () => void;
  paperTitle: string;
  saving: boolean;
};

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function sourceStateLabel(note: EvidenceNote): string {
  if (note.grounding?.state === "superseded") return "Source updated";
  if (note.grounding?.state === "unresolvable") return "Anchor unavailable";
  return "Source current";
}

export function EvidenceReviewDialog({
  error,
  note,
  onCancel,
  onConfirm,
  paperTitle,
  saving,
}: EvidenceReviewDialogProps) {
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sourceCurrent = note.grounding?.state === "current";

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const target = focusTrapTarget(focusable.length, activeIndex, event.shiftKey);
      if (target === "native") return;
      event.preventDefault();
      if (target === "container") dialogRef.current.focus({ preventScroll: true });
      if (target === "first") first?.focus();
      if (target === "last") last?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, saving]);

  return (
    <div className="evidence-review-layer">
      <button
        className="evidence-review-backdrop"
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        disabled={saving}
        onClick={onCancel}
      />
      <section
        className="evidence-review-folio"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-review-title"
        aria-describedby="evidence-review-description"
        aria-busy={saving}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="evidence-review-head">
          <div>
            <span className="micro-label">Review folio · revision {note.revision.number}</span>
            <h2 id="evidence-review-title" ref={titleRef} tabIndex={-1}>Review evidence.</h2>
            <p id="evidence-review-description">
              Marking this reviewed creates revision {note.revision.number + 1}. Revision {note.revision.number} remains preserved in the ledger.
            </p>
          </div>
          <button className="button ghost icon-button" type="button" disabled={saving} onClick={onCancel} aria-label="Close evidence review">
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="evidence-review-custody">
          <div className="evidence-review-stamp-row">
            <span className={`grounding-chip ${note.grounding?.state ?? "current"}`}>
              <Fingerprint size={9} aria-hidden="true" /> {sourceStateLabel(note)}
            </span>
            <span className="revision-number-stamp">v{note.revision.number} → v{note.revision.number + 1}</span>
          </div>
          <span className="source-label">{paperTitle} · exact source excerpt</span>
          <blockquote><Quote size={13} aria-hidden="true" /> <span>{note.evidence}</span></blockquote>
          <dl>
            <div><dt>Bounded claim</dt><dd>{note.claim}</dd></div>
            <div><dt>Interpretation</dt><dd>{note.interpretation}</dd></div>
          </dl>
        </div>

        {!sourceCurrent ? (
          <div className="evidence-review-warning" role="note">
            <AlertTriangle size={14} aria-hidden="true" />
            <p><strong>{sourceStateLabel(note)}.</strong> Review confirms the claim and interpretation recorded with this excerpt; it does not make the earlier anchor current. Re-anchor remains a separate revision.</p>
          </div>
        ) : null}

        {error ? <div className="evidence-capture-alert" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {error}</div> : null}

        <label className="evidence-review-confirmation">
          <input type="checkbox" checked={confirmed} disabled={saving} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>I reviewed the exact quote, bounded claim, and interpretation together.</span>
        </label>

        <footer className="evidence-review-actions">
          <button className="button ghost" type="button" disabled={saving} onClick={onCancel}>Keep captured</button>
          <button className="button primary" type="button" disabled={saving || !confirmed} onClick={onConfirm}>
            {saving ? <LoaderCircle className="auth-spinner" size={13} aria-hidden="true" /> : <CheckCheck size={13} aria-hidden="true" />}
            {saving ? "Creating reviewed revision…" : "Mark reviewed"}
          </button>
        </footer>
      </section>
    </div>
  );
}
