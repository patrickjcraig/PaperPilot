"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { FolderPlus, X } from "lucide-react";
import type { Collection } from "@/lib/types";
import type { WorkspaceActionResult } from "./workspace-action";

export type CollectionDraft = Pick<Collection, "name" | "description" | "color">;

type CollectionCreateDialogProps = {
  existingCollectionNames: string[];
  mode: "demo" | "live";
  onClose: () => void;
  onCreate: (draft: CollectionDraft) => Promise<WorkspaceActionResult>;
};

const colors: Array<{ value: Collection["color"]; label: string }> = [
  { value: "teal", label: "Teal" },
  { value: "blue", label: "Blue" },
  { value: "amber", label: "Amber" },
  { value: "slate", label: "Slate" },
];

const focusableSelector = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function CollectionCreateDialog({
  existingCollectionNames,
  mode,
  onClose,
  onCreate,
}: CollectionCreateDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<Collection["color"]>("teal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) onClose();
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  function keepFocusInside(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => element.getClientRects().length > 0);
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

  async function submitCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError("Enter a collection name.");
      nameRef.current?.focus();
      return;
    }
    const comparableName = normalizedName.toLocaleLowerCase().replace(/\s+/g, " ");
    if (existingCollectionNames.some((candidate) =>
      candidate.trim().toLocaleLowerCase().replace(/\s+/g, " ") === comparableName)) {
      setError("A collection with this name already exists in this project.");
      nameRef.current?.focus();
      return;
    }

    setBusy(true);
    busyRef.current = true;
    setError("");
    try {
      const result = await onCreate({
        name: normalizedName,
        description: description.trim(),
        color,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "PaperPilot could not create this collection.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop project-dialog-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="modal project-create-dialog collection-create-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-create-title"
        aria-describedby="collection-create-description"
        aria-busy={busy}
        onKeyDown={keepFocusInside}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head project-dialog-head">
          <div>
            <span className="eyebrow">Current project</span>
            <h2 className="modal-title" id="collection-create-title">Create a collection</h2>
            <p className="view-subtitle" id="collection-create-description">
              {mode === "live"
                ? "Create a durable destination for this project’s papers and evidence."
                : "Demo collection—saved only in this browser on this device."}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close collection dialog"
            disabled={busy}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <form className="modal-body project-form" onSubmit={submitCollection} noValidate>
          {error ? <div className="project-form-error" role="alert">{error}</div> : null}

          <label className="field-group" htmlFor="collection-name">
            <span className="field-label">Collection name</span>
            <input
              className="text-input project-form-input"
              id="collection-name"
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="Mechanisms and boundary conditions"
              autoComplete="off"
              disabled={busy}
            />
          </label>

          <label className="field-group" htmlFor="collection-description">
            <span className="field-label">Purpose</span>
            <textarea
              className="text-area project-form-textarea"
              id="collection-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={5_000}
              placeholder="What belongs here, and how will you use it in the argument?"
              rows={4}
              disabled={busy}
            />
          </label>

          <fieldset className="collection-color-fieldset" disabled={busy}>
            <legend className="field-label">Index color</legend>
            <div className="collection-color-options">
              {colors.map((option) => (
                <label className={`collection-color-option ${option.value}`} key={option.value}>
                  <input
                    type="radio"
                    name="collection-color"
                    value={option.value}
                    checked={color === option.value}
                    onChange={() => setColor(option.value)}
                  />
                  <span className="collection-color-swatch" aria-hidden="true" />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="project-dialog-actions">
            <button className="button" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="button primary" type="submit" disabled={busy || !name.trim()}>
              <FolderPlus size={14} aria-hidden="true" />
              {busy ? "Creating…" : "Create collection"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
