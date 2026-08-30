"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import type { ProjectType, ProjectVisibility } from "@/lib/types";

export type ProjectDraft = {
  name: string;
  question: string;
  type: ProjectType;
  visibility: ProjectVisibility;
};

type ProjectCreateDialogProps = {
  existingProjectNames: string[];
  onClose: () => void;
  onCreate: (draft: ProjectDraft) => void;
};

const focusableSelector = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ProjectCreateDialog({ existingProjectNames, onClose, onCreate }: ProjectCreateDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState("");
  const [question, setQuestion] = useState("");
  const [type, setType] = useState<ProjectType>("evidence-map");
  const [visibility, setVisibility] = useState<ProjectVisibility>("private");
  const [error, setError] = useState("");

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());

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

  function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedQuestion = question.trim();

    if (!trimmedName) {
      setError("Enter a project name.");
      nameRef.current?.focus();
      return;
    }
    const normalizedName = trimmedName.toLocaleLowerCase().replace(/\s+/g, " ");
    if (existingProjectNames.some((projectName) =>
      projectName.trim().toLocaleLowerCase().replace(/\s+/g, " ") === normalizedName)) {
      setError("A project with this name already exists.");
      nameRef.current?.focus();
      return;
    }
    if (!trimmedQuestion) {
      setError("Enter the research question this project will answer.");
      questionRef.current?.focus();
      return;
    }

    setError("");
    onCreate({ name: trimmedName, question: trimmedQuestion, type, visibility });
  }

  return (
    <div className="modal-backdrop project-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal project-create-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-create-title"
        aria-describedby="project-create-description"
        onKeyDown={keepFocusInside}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head project-dialog-head">
          <div>
            <span className="eyebrow">Workspace</span>
            <h2 className="modal-title" id="project-create-title">Create a project</h2>
            <p className="view-subtitle" id="project-create-description">
              Give imported papers and evidence a clear research destination.
            </p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close project dialog">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <form className="modal-body project-form" onSubmit={submitProject} noValidate>
          {error ? <div className="project-form-error" role="alert">{error}</div> : null}

          <label className="field-group" htmlFor="project-name">
            <span className="field-label">Project name</span>
            <input
              className="text-input project-form-input"
              id="project-name"
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={error === "Enter a project name." || undefined}
              placeholder="Urban heat equity evidence map"
              autoComplete="off"
            />
          </label>

          <label className="field-group" htmlFor="project-question">
            <span className="field-label">Research question</span>
            <textarea
              className="text-area project-form-textarea"
              id="project-question"
              ref={questionRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              aria-invalid={error.startsWith("Enter the research question") || undefined}
              placeholder="Which interventions reduce heat exposure, for whom, and under what conditions?"
              rows={4}
            />
          </label>

          <div className="project-form-grid">
            <label className="field-group" htmlFor="project-type">
              <span className="field-label">Project type</span>
              <select
                className="project-form-select"
                id="project-type"
                value={type}
                onChange={(event) => setType(event.target.value as ProjectType)}
              >
                <option value="evidence-map">Evidence map</option>
                <option value="literature-review">Literature review</option>
                <option value="systematic-review">Systematic review</option>
              </select>
            </label>

            <label className="field-group" htmlFor="project-visibility">
              <span className="field-label">Visibility</span>
              <select
                className="project-form-select"
                id="project-visibility"
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as ProjectVisibility)}
              >
                <option value="private">Private</option>
                <option value="workspace">Workspace members</option>
              </select>
            </label>
          </div>

          <div className="project-dialog-actions">
            <button className="button" type="button" onClick={onClose}>Cancel</button>
            <button className="button primary" type="submit">
              <Plus size={14} aria-hidden="true" /> Create project
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
