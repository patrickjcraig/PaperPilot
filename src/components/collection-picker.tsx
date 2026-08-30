"use client";

import { useEffect, useRef } from "react";
import { Check, FolderOpen, Plus, X } from "lucide-react";
import type { Collection, Paper } from "@/lib/types";

type CollectionPickerProps = {
  collections: Collection[];
  onAdd: (collectionId: string, paperId: string) => void;
  onClose: () => void;
  paper: Paper;
};

export function CollectionPicker({ collections, onAdd, onClose, paper }: CollectionPickerProps) {
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      modalRef.current?.querySelector<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled)")?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

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
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-picker-title"
        onKeyDown={keepFocusInside}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <span className="eyebrow">Save paper</span>
            <h2 className="modal-title" id="collection-picker-title">Choose a collection</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close collection picker">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <p className="result-venue" style={{ margin: "12px 0 8px" }}>{paper.title}</p>
          {collections.map((collection) => {
            const isSaved = collection.paperIds.includes(paper.id);
            return (
              <button
                className="modal-option"
                type="button"
                disabled={isSaved}
                onClick={() => onAdd(collection.id, paper.id)}
                key={collection.id}
              >
                <span className="collection-symbol"><FolderOpen size={15} aria-hidden="true" /></span>
                <span className="collection-copy">
                  <strong>{collection.name}</strong>
                  <span>{collection.paperIds.length} papers · {collection.evidenceClaimCount} evidence-backed claims</span>
                </span>
                {isSaved ? <Check size={15} color="var(--sage)" aria-label="Already saved" /> : <Plus size={15} aria-label="Add here" />}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
