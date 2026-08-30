"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FolderInput, Inbox, Link2, ShieldCheck, X } from "lucide-react";
import type { LiteratureSearchHit } from "@/lib/integrations";
import type { Paper, ResearchProject } from "@/lib/types";

type PaperImportDialogProps = {
  duplicatePaper?: Paper;
  hit: LiteratureSearchHit;
  onClose: () => void;
  onConfirm: (destinationProjectId?: string) => void;
  projects: ResearchProject[];
  isSubmitting?: boolean;
};

export function PaperImportDialog({
  duplicatePaper,
  hit,
  onClose,
  onConfirm,
  projects,
  isSubmitting = false,
}: PaperImportDialogProps) {
  const [destination, setDestination] = useState("inbox");
  const modalRef = useRef<HTMLElement>(null);
  const paper = hit.paper;
  const primaryIdentifier = paper.identifiers.find((identifier) => identifier.scheme === "doi")
    ?? paper.identifiers[0];

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      modalRef.current?.querySelector<HTMLElement>("select, button:not(:disabled)")?.focus();
    });
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  function keepFocusInside(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab" || !modalRef.current) return;
    const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(
      "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    )].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal import-dialog"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paper-import-title"
        onKeyDown={keepFocusInside}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <span className="eyebrow">Import preview</span>
            <h2 className="modal-title" id="paper-import-title">Save with its research trail</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close import preview"
            disabled={isSubmitting}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="import-dialog-body">
          <div className="import-paper-summary">
            <span className="micro-label">Paper</span>
            <strong>{paper.title}</strong>
            <span>{paper.authors.slice(0, 3).join(", ")} · {paper.year}</span>
          </div>

          <dl className="import-preflight">
            <div>
              <dt><Link2 size={13} aria-hidden="true" /> Source</dt>
              <dd>{hit.provenance.providerName}</dd>
            </div>
            <div>
              <dt><ShieldCheck size={13} aria-hidden="true" /> Identifier</dt>
              <dd>{primaryIdentifier ? `${primaryIdentifier.scheme.toUpperCase()}: ${primaryIdentifier.value}` : "Title fingerprint only"}</dd>
            </div>
            <div>
              <dt><FolderInput size={13} aria-hidden="true" /> Content</dt>
              <dd>{paper.access?.hasFullText ? "Full-text location available" : "Metadata and abstract only"}</dd>
            </div>
          </dl>

          {duplicatePaper ? (
            <div className="import-warning" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              <span><strong>Possible existing record.</strong> PaperPilot matched “{duplicatePaper.shortTitle}”. The import will preserve the new provider record without creating a second project membership.</span>
            </div>
          ) : (
            <div className="import-ready" role="status">
              <ShieldCheck size={16} aria-hidden="true" />
              <span><strong>No exact duplicate found.</strong> Checked DOI/provider identifiers and a normalized title fingerprint in this workspace.</span>
            </div>
          )}

          <label className="field-group" htmlFor="paper-import-destination">
            <span className="field-label">Destination</span>
            <select
              className="text-input"
              id="paper-import-destination"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              disabled={isSubmitting}
            >
              <option value="inbox">Research Inbox — review later</option>
              {projects.filter((project) => project.status === "active").map((project) => (
                <option value={project.id} key={project.id}>{project.name}</option>
              ))}
            </select>
          </label>

          <p className="import-disclosure">
            PaperPilot will retain the provider, retrieval time, source URL, version, and duplicate decision with this record. Metadata-only papers will not be presented as readable full text.
          </p>

          <div className="modal-actions">
            <button className="button" type="button" onClick={onClose} disabled={isSubmitting}>Cancel</button>
            <button
              className="button primary"
              type="button"
              disabled={isSubmitting}
              onClick={() => onConfirm(destination === "inbox" ? undefined : destination)}
            >
              {destination === "inbox" ? <Inbox size={14} aria-hidden="true" /> : <FolderInput size={14} aria-hidden="true" />}
              {isSubmitting
                ? "Saving…"
                : destination === "inbox" ? "Stage in Inbox" : "Save to project"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
