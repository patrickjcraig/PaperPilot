"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FileImage, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  RenderTask,
} from "pdfjs-dist";

import type { ReaderDocumentMetadata } from "@/lib/workspace";
import {
  fetchVerifiedReaderPdf,
  ReaderPdfClientError,
} from "@/lib/workspace/reader-pdf";

type ReaderPdfFirstPageProps = {
  document: ReaderDocumentMetadata;
  paperId: string;
  textCapability: "exact" | "limited" | "preparing";
  workspaceId: string;
};

type ViewerState =
  | { phase: "loading"; message: string }
  | { phase: "ready"; message: string }
  | { phase: "error"; message: string };

const PAGE_SCALE = 1.35;
const MAX_OUTPUT_SCALE = 2;

function readyMessage(pageCount: number, textCapability: ReaderPdfFirstPageProps["textCapability"]): string {
  const visual = `Page 1 of ${pageCount} is visually available from the admitted PDF.`;
  if (textCapability === "exact") return `${visual} Exact selectable text is available below.`;
  if (textCapability === "limited") return `${visual} Selectable text is limited in this document.`;
  return `${visual} Exact selectable text is still being prepared.`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ReaderPdfClientError) return error.message;
  return "This page cannot be rendered from the admitted PDF. Try again or use any available exact text below.";
}

function wasAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function ReaderPdfFirstPage({
  document,
  paperId,
  textCapability,
  workspaceId,
}: ReaderPdfFirstPageProps) {
  const instanceId = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [state, setState] = useState<ViewerState>({
    phase: "loading",
    message: "Loading admitted PDF page 1.",
  });
  const titleId = `reader-pdf-title-${instanceId}`;
  const summaryId = `reader-pdf-summary-${instanceId}`;
  const documentId = document.id;
  const inputSha256 = document.inputSha256;
  const inputSizeBytes = document.inputSizeBytes;
  const pageCount = document.pageCount;
  const statusMessage = state.phase === "ready"
    ? readyMessage(pageCount, textCapability)
    : state.message;

  useEffect(() => {
    const abortController = new AbortController();
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let renderTask: RenderTask | undefined;

    async function renderFirstPage(): Promise<void> {
      setState({ phase: "loading", message: "Loading admitted PDF page 1." });
      try {
        const bytes = await fetchVerifiedReaderPdf({
          document: { id: documentId, inputSha256, inputSizeBytes },
          paperId,
          signal: abortController.signal,
          workspaceId,
        });
        if (disposed) return;

        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        loadingTask = pdfjs.getDocument({
          data: bytes,
          useWorkerFetch: false,
        });
        const pdf = await loadingTask.promise;
        if (disposed) return;
        if (pdf.numPages !== pageCount) {
          throw new ReaderPdfClientError(
            "The rendered page count did not match the admitted source, so PaperPilot did not show the page.",
            "integrity",
          );
        }

        const page = await pdf.getPage(1);
        if (disposed) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { alpha: false });
        if (!canvas || !context) throw new Error("Canvas rendering is unavailable.");

        const viewport = page.getViewport({ scale: PAGE_SCALE });
        const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1
            ? undefined
            : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (disposed) return;
        setState({
          phase: "ready",
          message: "Page 1 rendered from the admitted PDF.",
        });
      } catch (error) {
        if (disposed || wasAborted(error)) return;
        setState({ phase: "error", message: errorMessage(error) });
      }
    }

    void renderFirstPage();
    return () => {
      disposed = true;
      abortController.abort();
      renderTask?.cancel();
      void loadingTask?.destroy();
    };
  }, [documentId, inputSha256, inputSizeBytes, pageCount, paperId, retryVersion, workspaceId]);

  return (
    <section
      className="reader-pdf-first-page"
      role="region"
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      aria-busy={state.phase === "loading" || undefined}
    >
      <header className="reader-pdf-first-page-head">
        <div>
          <span className="eyebrow">Admitted PDF · client-rendered view</span>
          <h2 id={titleId}>PDF page 1</h2>
        </div>
        <span className={`status-chip reader-pdf-capability ${state.phase}`}>
          <FileImage size={12} aria-hidden="true" />
          {state.phase === "ready" ? "Visual page ready" : state.phase === "error" ? "Page unavailable" : "Preparing page"}
        </span>
      </header>

      <div
        className="reader-pdf-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {state.phase === "error" ? "" : statusMessage}
      </div>

      {state.phase === "loading" ? (
        <div className="reader-pdf-loading" aria-hidden="true">
          <LoaderCircle className="auth-spinner" size={24} />
          <span>Verifying and rendering page 1…</span>
        </div>
      ) : null}

      <figure className={`reader-pdf-figure${state.phase === "ready" ? " ready" : ""}`}>
        <div className="reader-pdf-viewport">
          <canvas ref={canvasRef} aria-hidden="true" />
        </div>
        <figcaption id={summaryId}>
          {state.phase === "ready"
            ? statusMessage
            : "The canvas is a visual rendering only. It is hidden from assistive technology; page capability and limitations are stated in text."}
        </figcaption>
      </figure>

      {state.phase === "error" ? (
        <div className="reader-pdf-error" role="alert">
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <strong>This page cannot be rendered.</strong>
            <p>{state.message}</p>
          </div>
        </div>
      ) : null}

      {state.phase === "error" || retryVersion > 0 ? (
        <div className="reader-pdf-actions">
          <button
            className="button small"
            type="button"
            disabled={state.phase === "loading"}
            onClick={() => setRetryVersion((value) => value + 1)}
          >
            {state.phase === "loading"
              ? <LoaderCircle className="auth-spinner" size={13} aria-hidden="true" />
              : <RefreshCw size={13} aria-hidden="true" />}
            {state.phase === "loading" ? "Trying page again…" : "Render page again"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
