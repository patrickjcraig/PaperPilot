"use client";

import { useEffect, useId, useRef } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  AlertTriangle,
  FileText,
  FileUp,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";

export type UploadFilePhase =
  | "idle"
  | "selected"
  | "creating"
  | "transferring"
  | "quarantined"
  | "error";

export type UploadFileSelection = {
  fileName: string;
  sizeBytes: number;
  mediaType?: string;
};

export type UploadFileController = {
  role: string;
  canUpload: boolean;
  maxBytes: number;
  phase: UploadFilePhase;
  selected?: UploadFileSelection;
  loadedBytes?: number;
  totalBytes?: number;
  message?: string;
  onSelect: (file: File | null) => void;
  onStart: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
};

export type FileUploadCardProps = {
  controller: UploadFileController;
};

const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function safeDisplayText(
  value: string | undefined,
  fallback: string,
  maximumCharacters: number,
): string {
  const cleaned = value?.replace(UNSAFE_DISPLAY_CHARACTERS, "�").trim() || fallback;
  const characters = Array.from(cleaned);
  if (characters.length <= maximumCharacters) return cleaned;
  return `${characters.slice(0, Math.max(1, maximumCharacters - 1)).join("")}…`;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function formatBytes(value: number | undefined): string {
  const bytes = finiteNonNegative(value);
  if (bytes === undefined) return "Size unavailable";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_024 ** 2).toFixed(bytes < 10 * 1_024 ** 2 ? 1 : 0)} MB`;
}

function phaseStatus(
  controller: UploadFileController,
  selectionIssue: string | undefined,
  progressPercent: number,
): string {
  const supplied = controller.message
    ? safeDisplayText(controller.message, "", 500)
    : undefined;
  if (supplied) return supplied;

  switch (controller.phase) {
    case "idle":
      return "Choose a PDF to begin. No file has been selected or uploaded.";
    case "selected":
      return selectionIssue ?? "PDF selected. Selection has not been uploaded.";
    case "creating":
      return "Creating a private upload session. No document is ready yet.";
    case "transferring":
      return `Transferring PDF bytes — ${progressPercent}% complete.`;
    case "quarantined":
      return "Transfer complete. The PDF is staged in the Research Inbox as quarantined and awaiting verification.";
    case "error":
      return "PaperPilot could not accept this PDF. Review the file and try again.";
  }
}

function PhaseIcon({ phase }: { phase: UploadFilePhase }) {
  if (phase === "creating" || phase === "transferring") {
    return <LoaderCircle className="upload-file-spinner" size={16} aria-hidden="true" />;
  }
  if (phase === "quarantined") {
    return <LockKeyhole size={16} aria-hidden="true" />;
  }
  if (phase === "error") {
    return <AlertTriangle size={16} aria-hidden="true" />;
  }
  return <FileText size={16} aria-hidden="true" />;
}

export function FileUploadCard({ controller }: FileUploadCardProps) {
  const instanceId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `paper-pdf-${instanceId}`;
  const helpId = `paper-pdf-help-${instanceId}`;
  const statusId = `paper-pdf-status-${instanceId}`;
  const errorId = `paper-pdf-error-${instanceId}`;
  const isBusy = controller.phase === "creating" || controller.phase === "transferring";
  const selectedSize = finiteNonNegative(controller.selected?.sizeBytes);
  const maximumSize = finiteNonNegative(controller.maxBytes);
  const selectionIssue = controller.selected
    ? selectedSize === undefined || selectedSize === 0
      ? "Choose a non-empty PDF."
      : maximumSize === undefined || maximumSize === 0
        ? "The workspace upload limit is unavailable. Refresh before trying again."
        : selectedSize > maximumSize
          ? `Choose a PDF no larger than ${formatBytes(maximumSize)}.`
          : undefined
    : undefined;
  const progressTotal = Math.max(
    1,
    finiteNonNegative(controller.totalBytes)
      ?? selectedSize
      ?? maximumSize
      ?? 1,
  );
  const progressLoaded = Math.min(
    progressTotal,
    finiteNonNegative(controller.loadedBytes) ?? 0,
  );
  const progressPercent = Math.round((progressLoaded / progressTotal) * 100);
  const statusMessage = phaseStatus(controller, selectionIssue, progressPercent);
  const displayedFileName = controller.selected
    ? safeDisplayText(controller.selected.fileName, "Selected PDF", 180)
    : undefined;
  const displayedMediaType = controller.selected?.mediaType
    ? safeDisplayText(controller.selected.mediaType, "Type unavailable", 80)
    : "Type reported by browser unavailable";
  const roleLabel = safeDisplayText(controller.role, "workspace role", 80).toLowerCase();
  const canStart = controller.canUpload
    && controller.phase === "selected"
    && Boolean(controller.selected)
    && !selectionIssue;
  const canClearSelection = Boolean(controller.selected)
    && (controller.phase === "selected" || controller.phase === "error");
  const hasError = controller.phase === "error" || Boolean(selectionIssue);
  const stateDescriptionId = hasError
    ? errorId
    : controller.phase === "idle"
      ? undefined
      : statusId;
  const describedBy = stateDescriptionId ? `${helpId} ${stateDescriptionId}` : helpId;

  useEffect(() => {
    if (!controller.selected && inputRef.current?.value) {
      inputRef.current.value = "";
    }
  }, [controller.selected]);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    controller.onSelect(event.currentTarget.files?.item(0) ?? null);
  }

  function clearSelection() {
    if (inputRef.current) inputRef.current.value = "";
    controller.onSelect(null);
    inputRef.current?.focus();
  }

  function startUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canStart) void controller.onStart();
  }

  return (
    <article
      className="source-card source-card-live source-card-upload-live"
      aria-labelledby={`source-upload-${instanceId}`}
      aria-busy={isBusy || undefined}
    >
      <div className="source-card-head">
        <span className="source-card-icon" aria-hidden="true"><FileUp size={18} /></span>
        <span className={`status-chip source-status ${controller.canUpload ? "source-status-live" : "source-status-upcoming"}`}>
          {controller.canUpload ? "PDF transfer live" : "Read-only"}
        </span>
      </div>

      <div className="source-card-body upload-file-card-body">
        <div>
          <h2 id={`source-upload-${instanceId}`}>PDF upload</h2>
          <p className="source-card-copy">
            Choose one PDF to stage in the Research Inbox through the authenticated workspace.
          </p>
        </div>

        <div className="upload-file-boundary" role="note">
          <LockKeyhole size={15} aria-hidden="true" />
          <span>
            <strong>Private quarantine comes first.</strong> A completed transfer is not yet verified, parsed, or available in Reader.
          </span>
        </div>

        {controller.canUpload ? (
          <form className="upload-file-form" onSubmit={startUpload} noValidate>
            <label className="field-group upload-file-picker" htmlFor={inputId}>
              <span className="field-label">PDF file</span>
              <input
                ref={inputRef}
                className="upload-file-input"
                id={inputId}
                type="file"
                accept=".pdf,application/pdf"
                aria-describedby={describedBy}
                aria-errormessage={hasError ? errorId : undefined}
                aria-invalid={hasError || undefined}
                disabled={isBusy}
                onChange={selectFile}
              />
              <span className="upload-file-help" id={helpId}>
                One PDF, up to {maximumSize ? formatBytes(maximumSize) : "the workspace limit"}. Selecting a file does not upload it.
              </span>
            </label>

            {controller.selected && displayedFileName ? (
              <div className="upload-file-selection">
                <span className="upload-file-selection-icon" aria-hidden="true"><FileText size={15} /></span>
                <span className="upload-file-selection-copy">
                  <strong>{displayedFileName}</strong>
                  <span>{displayedMediaType} · {formatBytes(selectedSize)}</span>
                </span>
              </div>
            ) : null}

            {controller.phase === "transferring" ? (
              <div className="upload-file-progress">
                <div className="upload-file-progress-head">
                  <span>Transfer progress</span>
                  <strong>{progressPercent}%</strong>
                </div>
                <progress
                  className="upload-file-progress-meter"
                  max={progressTotal}
                  value={progressLoaded}
                  aria-label="PDF transfer progress"
                >
                  {progressPercent}%
                </progress>
                <span>{formatBytes(progressLoaded)} of {formatBytes(progressTotal)} transferred</span>
              </div>
            ) : controller.phase === "creating" ? (
              <progress className="upload-file-progress-meter" aria-label="Creating private upload session" />
            ) : null}

            {hasError ? (
              <div className="upload-file-state error" id={errorId} role="alert">
                <PhaseIcon phase="error" />
                <div className="upload-file-state-copy">
                  <strong>{selectionIssue ? "PDF cannot be uploaded" : "PDF not accepted"}</strong>
                  <span>{statusMessage}</span>
                </div>
              </div>
            ) : controller.phase !== "idle" ? (
              <div
                className={`upload-file-state ${controller.phase}`}
                id={statusId}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <PhaseIcon phase={controller.phase} />
                <div className="upload-file-state-copy">
                  <strong>
                    {controller.phase === "selected"
                      ? "Ready to transfer"
                      : controller.phase === "creating"
                        ? "Preparing transfer"
                        : controller.phase === "transferring"
                          ? "Transfer in progress"
                          : "Private quarantine"}
                  </strong>
                  <span>{statusMessage}</span>
                </div>
              </div>
            ) : null}

            <div className="upload-file-actions">
              {canClearSelection ? (
                <button className="button" type="button" onClick={clearSelection}>
                  <X size={13} aria-hidden="true" /> Clear selection
                </button>
              ) : null}

              {canStart ? (
                <button className="button primary" type="submit">
                  <FileUp size={13} aria-hidden="true" /> Upload PDF
                </button>
              ) : null}

              {isBusy ? (
                <>
                  <button className="button primary" type="button" disabled>
                    <LoaderCircle className="upload-file-spinner" size={13} aria-hidden="true" />
                    {controller.phase === "creating" ? "Preparing…" : "Transferring…"}
                  </button>
                  {controller.onCancel ? (
                    <button className="button" type="button" onClick={() => void controller.onCancel?.()}>
                      Cancel transfer
                    </button>
                  ) : null}
                </>
              ) : null}

              {controller.phase === "error" && !selectionIssue && controller.onRetry ? (
                <button className="button primary" type="button" onClick={() => void controller.onRetry?.()}>
                  <FileUp size={13} aria-hidden="true" /> Retry upload
                </button>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="upload-file-role-note" role="note">
            File upload is unavailable for this {roleLabel}. Workspace permissions and upload policy are enforced by the server.
          </div>
        )}
      </div>
    </article>
  );
}
