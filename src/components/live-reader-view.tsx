"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpenText,
  CheckCircle2,
  FileCheck2,
  FileQuestion,
  Fingerprint,
  LoaderCircle,
  Network,
  Quote,
  RefreshCw,
  ScanText,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { Collection, EvidenceNote, Paper, ResearchProject } from "@/lib/types";
import type {
  EvidenceCaptureAction,
  EvidenceCaptureState,
  ReaderEvidenceSelectionPreview,
  ReaderTextChunk,
  WorkspacePaperReaderDto,
} from "@/lib/workspace";
import { selectionToGroundedAnchor } from "@/lib/workspace";
import { EvidenceCaptureDocket } from "./evidence-capture-docket";
import { ReaderPdfFirstPage } from "./reader-pdf-first-page";

type LiveReaderViewProps = {
  canCaptureEvidence: boolean;
  captureState: EvidenceCaptureState;
  collections: Collection[];
  error?: string;
  evidenceNotes: EvidenceNote[];
  loading: boolean;
  loadingMore: boolean;
  onBack: () => void;
  onCaptureAction: (action: EvidenceCaptureAction) => void;
  onCaptureSelection: (selection: ReaderEvidenceSelectionPreview, originElementId: string) => void;
  onDismissCapture: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onReloadCaptureSource: () => void;
  onSaveCapture: () => void;
  onViewEvidence: () => void;
  paper?: Paper;
  project?: ResearchProject;
  reader?: WorkspacePaperReaderDto;
  readerPdfJsEnabled: boolean;
  workspaceId: string;
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date)
    : "Timestamp unavailable";
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function shortDigest(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function chunksByPage(chunks: ReaderTextChunk[]): Array<{
  pageNumber: number;
  chunks: ReaderTextChunk[];
}> {
  const grouped = new Map<number, ReaderTextChunk[]>();
  for (const chunk of chunks) {
    grouped.set(chunk.pageNumber, [...(grouped.get(chunk.pageNumber) ?? []), chunk]);
  }
  return [...grouped].map(([pageNumber, pageChunks]) => ({
    pageNumber,
    chunks: pageChunks,
  }));
}

function chunkTextRoot(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest<HTMLElement>("[data-reader-chunk-text]") ?? null;
}

function utf16OffsetWithin(root: HTMLElement, node: Node, offset: number): number | null {
  if (node !== root && !root.contains(node)) return null;
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function activeCaptureSelection(state: EvidenceCaptureState): ReaderEvidenceSelectionPreview | undefined {
  return state.phase === "selected"
    || state.phase === "saving"
    || state.phase === "version-conflict"
    || state.phase === "revision-conflict"
    || state.phase === "source-changed"
      ? state.selection
      : undefined;
}

export function LiveReaderView({
  canCaptureEvidence,
  captureState,
  collections,
  error,
  evidenceNotes,
  loading,
  loadingMore,
  onBack,
  onCaptureAction,
  onCaptureSelection,
  onDismissCapture,
  onLoadMore,
  onRefresh,
  onReloadCaptureSource,
  onSaveCapture,
  onViewEvidence,
  paper,
  project,
  reader,
  readerPdfJsEnabled,
  workspaceId,
}: LiveReaderViewProps) {
  const [candidate, setCandidate] = useState<{
    generationId: string;
    selection: ReaderEvidenceSelectionPreview;
  }>();
  const [selectionFeedback, setSelectionFeedback] = useState<{
    generationId: string;
    message: string;
  }>();
  const selectionRequest = useRef(0);
  const readerGenerationId = reader?.state === "ready" ? reader.generation.id : undefined;
  const reanchorMode = captureState.phase !== "idle"
    && captureState.intent.action === "reanchor";
  const leaveReader = reanchorMode ? onDismissCapture : onBack;
  const pages = useMemo(
    () => reader?.state === "ready" ? chunksByPage(reader.chunks) : [],
    [reader],
  );
  const currentCaptureSelection = activeCaptureSelection(captureState);
  const candidateSelection = candidate && candidate.generationId === readerGenerationId
    && (captureState.phase === "idle" || captureState.phase === "reselecting")
      ? candidate.selection
      : undefined;
  const markedSelection = candidateSelection ?? currentCaptureSelection;
  const markedChunkIds = useMemo(
    () => new Set(markedSelection?.selectedChunkIds ?? []),
    [markedSelection],
  );
  const firstMarkedChunkId = markedSelection?.selectedChunkIds[0];
  const lastMarkedChunkId = markedSelection?.selectedChunkIds.at(-1);
  const groundedEvidence = useMemo(
    () => evidenceNotes.filter((note) => note.grounding),
    [evidenceNotes],
  );
  const sourceUpdateCount = useMemo(
    () => groundedEvidence.filter((note) => note.grounding?.state !== "current").length,
    [groundedEvidence],
  );
  const selectionEnabled = canCaptureEvidence && Boolean(project);
  const selectionStatus = selectionFeedback && selectionFeedback.generationId === readerGenerationId
    ? selectionFeedback.message
    : "";

  const captureWholeChunk = useCallback(async (chunk: ReaderTextChunk, originElementId: string) => {
    if (!reader || reader.state !== "ready" || !selectionEnabled) return;
    const result = await selectionToGroundedAnchor(
      reader.chunks,
      { chunkId: chunk.id, utf16Offset: 0 },
      { chunkId: chunk.id, utf16Offset: chunk.text.length },
    );
    if (!result.ok) {
      setSelectionFeedback({
        generationId: reader.generation.id,
        message: "That paragraph could not be anchored to the current source. Refresh and try again.",
      });
      return;
    }
    onCaptureSelection(result.selection, originElementId);
  }, [onCaptureSelection, reader, selectionEnabled]);

  const inspectBrowserSelection = useCallback(async () => {
    if (!reader || reader.state !== "ready" || !selectionEnabled) return;
    if (captureState.phase !== "idle" && captureState.phase !== "reselecting") return;
    const nativeSelection = window.getSelection();
    if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.rangeCount !== 1) {
      setCandidate(undefined);
      setSelectionFeedback(undefined);
      return;
    }
    const anchorRoot = chunkTextRoot(nativeSelection.anchorNode);
    const focusRoot = chunkTextRoot(nativeSelection.focusNode);
    const anchorChunkId = anchorRoot?.dataset.readerChunkId;
    const focusChunkId = focusRoot?.dataset.readerChunkId;
    if (
      !anchorRoot
      || !focusRoot
      || !anchorChunkId
      || !focusChunkId
      || !nativeSelection.anchorNode
      || !nativeSelection.focusNode
    ) {
      setCandidate(undefined);
      return;
    }
    const anchorOffset = utf16OffsetWithin(
      anchorRoot,
      nativeSelection.anchorNode,
      nativeSelection.anchorOffset,
    );
    const focusOffset = utf16OffsetWithin(
      focusRoot,
      nativeSelection.focusNode,
      nativeSelection.focusOffset,
    );
    if (anchorOffset === null || focusOffset === null) {
      setCandidate(undefined);
      return;
    }

    const requestId = ++selectionRequest.current;
    const result = await selectionToGroundedAnchor(
      reader.chunks,
      { chunkId: anchorChunkId, utf16Offset: anchorOffset },
      { chunkId: focusChunkId, utf16Offset: focusOffset },
    );
    if (requestId !== selectionRequest.current) return;
    if (!result.ok) {
      setCandidate(undefined);
      setSelectionFeedback({
        generationId: reader.generation.id,
        message: result.code === "selection_too_large"
          ? "Select no more than 24 contiguous paragraphs or 50 KB of text."
          : "Select complete characters within contiguous Reader paragraphs.",
      });
      return;
    }
    setCandidate({ generationId: reader.generation.id, selection: result.selection });
    setSelectionFeedback({
      generationId: reader.generation.id,
          message: `${result.selection.selectedChunkIds.length} ${result.selection.selectedChunkIds.length === 1 ? "paragraph" : "paragraphs"} ready to ${reanchorMode ? "re-anchor" : "capture"}.`,
    });
  }, [captureState.phase, reader, reanchorMode, selectionEnabled]);

  const fileCandidate = useCallback(() => {
    if (!candidateSelection || !lastMarkedChunkId || !reader || reader.state !== "ready") return;
    const lastChunk = reader.chunks.find((chunk) => chunk.id === lastMarkedChunkId);
    if (!lastChunk) return;
    const originElementId = `reader-capture-chunk-${lastChunk.sequence}`;
    onCaptureSelection(candidateSelection, originElementId);
    window.getSelection()?.removeAllRanges();
    selectionRequest.current += 1;
    setCandidate(undefined);
    setSelectionFeedback({
      generationId: reader.generation.id,
      message: reanchorMode
        ? "Replacement selection moved to the evidence docket."
        : "Selection moved to the evidence docket.",
    });
  }, [candidateSelection, lastMarkedChunkId, onCaptureSelection, reader, reanchorMode]);

  return (
    <section
      className="view reader-view live-reader-view"
      aria-label={paper ? `Source-grounded Reader for ${paper.title}` : "Source-grounded Reader"}
    >
      <div className="reader-toolbar">
        <div className="reader-breadcrumb">
          <button className="button ghost small" type="button" disabled={captureState.phase === "saving"} onClick={leaveReader}>
            <ArrowLeft size={13} aria-hidden="true" /> <span>{reanchorMode ? "Cancel re-anchor · Evidence trail" : "Project library"}</span>
          </button>
          <span aria-hidden="true">/</span>
          <strong>{paper?.shortTitle ?? "No paper selected"}</strong>
        </div>
        <div className="reader-toolbar-actions">
          {groundedEvidence.length ? (
            <button className="status-chip live-reader-evidence-chip" type="button" onClick={onViewEvidence}>
              <Network size={11} aria-hidden="true" /> {groundedEvidence.length} grounded
            </button>
          ) : null}
          <span className="status-chip live-reader-source-chip">
            <ShieldCheck size={11} aria-hidden="true" /> Server-attested text only
          </span>
          <button className="button small" type="button" disabled={loading} onClick={onRefresh}>
            <RefreshCw className={loading ? "auth-spinner" : undefined} size={13} aria-hidden="true" />
            <span>{loading ? "Checking…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {paper && reader && !error && reader.state !== "unavailable" ? (
        <div className="live-reader-pdf-gate">
          {readerPdfJsEnabled ? (
            <ReaderPdfFirstPage
              document={reader.document}
              paperId={paper.id}
              textCapability={reader.state === "ready"
                ? "exact"
                : reader.state === "no-text"
                  ? "limited"
                  : "preparing"}
              workspaceId={workspaceId}
            />
          ) : (
            <section
              className="reader-pdf-disabled"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-labelledby="reader-pdf-disabled-title"
            >
              <span className="eyebrow">Visual Reader unavailable</span>
              <h2 id="reader-pdf-disabled-title">PDF page rendering is disabled.</h2>
              <p>PaperPilot will not claim that a visual page is available. Exact text remains usable below when its admitted extraction is ready.</p>
            </section>
          )}
        </div>
      ) : null}

      {!paper ? (
        <div className="live-reader-state-wrap">
          <div className="live-reader-state-folio">
            <BookOpenText size={24} aria-hidden="true" />
            <span className="eyebrow">Reader</span>
            <h1>Select a workspace paper.</h1>
            <p>Open a paper from a project or collection to check for linked, validated text.</p>
            <button className="button primary" type="button" onClick={leaveReader}>{reanchorMode ? "Cancel re-anchor and return to evidence" : "Return to project library"}</button>
          </div>
        </div>
      ) : loading && !reader ? (
        <div className="live-reader-state-wrap" role="status" aria-live="polite">
          <div className="live-reader-state-folio">
            <LoaderCircle className="auth-spinner" size={24} aria-hidden="true" />
            <span className="eyebrow">Reader custody check</span>
            <h1>Confirming the document chain.</h1>
            <p>PaperPilot is requesting the linked document and its current extraction state.</p>
          </div>
        </div>
      ) : error ? (
        <div className="live-reader-state-wrap" role="alert">
          <div className="live-reader-state-folio live-reader-state-error">
            <TriangleAlert size={24} aria-hidden="true" />
            <span className="eyebrow">Reader request failed</span>
            <h1>The source could not be verified.</h1>
            <p>{error}</p>
            <button className="button primary" type="button" onClick={onRefresh}>Try again</button>
          </div>
        </div>
      ) : reader?.state === "unavailable" ? (
        <div className="live-reader-state-wrap">
          <div className="live-reader-state-folio">
            <FileQuestion size={24} aria-hidden="true" />
            <span className="eyebrow">Reader unavailable</span>
            <h1>No authoritative text is available.</h1>
            <p>This visible paper does not currently resolve to a linked, validated PDF with a current extraction. PaperPilot will not substitute the abstract, filename, or invented preview text.</p>
            <button className="button" type="button" onClick={leaveReader}>{reanchorMode ? "Cancel re-anchor and return to evidence" : "Return to project library"}</button>
          </div>
        </div>
      ) : reader?.state === "processing" ? (
        <div className="live-reader-state-wrap" role="status" aria-live="polite">
          <div className="live-reader-state-folio live-reader-state-processing">
            <LoaderCircle className="auth-spinner" size={24} aria-hidden="true" />
            <span className="eyebrow">Extraction in progress</span>
            <h1>The validated PDF is linked. Text is not ready yet.</h1>
            <p>PaperPilot is waiting for the current extraction policy to finish. This view refreshes while processing; no PDF text or evidence is shown before the attested result exists.</p>
            <dl className="live-reader-custody-grid">
              <div><dt>Document</dt><dd>{reader.document.id}</dd></div>
              <div><dt>Pages</dt><dd>{reader.document.pageCount}</dd></div>
              <div><dt>Validated</dt><dd>{formatDate(reader.document.validatedAt)}</dd></div>
              <div><dt>Policy</dt><dd>{reader.extractionPolicyVersion}</dd></div>
            </dl>
            {reanchorMode ? <button className="button" type="button" onClick={leaveReader}>Cancel re-anchor and return to evidence</button> : null}
          </div>
        </div>
      ) : reader?.state === "no-text" ? (
        <div className="live-reader-state-wrap">
          <div className="live-reader-state-folio live-reader-state-no-text">
            <ScanText size={24} aria-hidden="true" />
            <span className="eyebrow">Extraction complete · no text</span>
            <h1>The PDF contains no usable text layer.</h1>
            <p>The validated document remains linked, but the authoritative extractor returned no text. PaperPilot does not apply an unverified OCR fallback or create evidence from the paper metadata.</p>
            <dl className="live-reader-custody-grid">
              <div><dt>Document</dt><dd>{reader.document.id}</dd></div>
              <div><dt>Pages checked</dt><dd>{reader.generation.pageCount}</dd></div>
              <div><dt>Engine</dt><dd>{reader.generation.engine} {reader.generation.engineVersion}</dd></div>
              <div><dt>Completed</dt><dd>{formatDate(reader.generation.completedAt)}</dd></div>
            </dl>
            {reanchorMode ? <button className="button" type="button" onClick={leaveReader}>Cancel re-anchor and return to evidence</button> : null}
          </div>
        </div>
      ) : reader?.state === "ready" ? (
        <div className="live-reader-layout">
          <aside className="live-reader-folio" aria-label="Document custody folio">
            <div className="live-reader-folio-head">
              <span className="micro-label">Custody folio</span>
              <span className="live-reader-attested"><CheckCircle2 size={11} /> Text attested</span>
            </div>
            <dl className="live-reader-folio-list">
              <div><dt><FileCheck2 size={11} /> Validation</dt><dd>{formatDate(reader.document.validatedAt)}</dd><dd>{reader.document.validationPolicyVersion}</dd></div>
              <div><dt><ScanText size={11} /> Extraction</dt><dd>{reader.generation.engine} {reader.generation.engineVersion}</dd><dd>{formatDate(reader.generation.completedAt)}</dd></div>
              <div><dt><Fingerprint size={11} /> Source digest</dt><dd title={reader.document.inputSha256}>{shortDigest(reader.document.inputSha256)}</dd><dd>{formatBytes(Number(reader.document.inputSizeBytes))}</dd></div>
              <div><dt><ShieldCheck size={11} /> Admitted manifest</dt><dd title={reader.generation.manifestSha256}>{shortDigest(reader.generation.manifestSha256)}</dd><dd>{formatDate(reader.generation.manifestAdmittedAt)}</dd></div>
            </dl>
            <div className="live-reader-page-index">
              <span className="micro-label">Loaded page locators</span>
              <ol>
                {pages.map(({ pageNumber }) => (
                  <li key={pageNumber}>
                    <button type="button" onClick={() => document.getElementById(`live-reader-page-${pageNumber}`)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })}>Page {pageNumber}</button>
                  </li>
                ))}
              </ol>
            </div>
          </aside>

          <div className="live-reader-canvas">
            <article className="live-reader-paper" aria-labelledby="live-reader-paper-title">
              <header className="live-reader-paper-header">
                <div className="paper-running-head"><span>PaperPilot Reader · authoritative extraction</span><span>{reader.generation.chunkCount} source chunks</span></div>
                <span className="eyebrow">Linked workspace paper</span>
                <h1 className="paper-title" id="live-reader-paper-title">{paper.title}</h1>
                <p className="paper-byline">{paper.authors.join(", ") || "Authors unavailable"} · {paper.venue} · {paper.year || "Year unavailable"}</p>
                <div className="live-reader-source-notice" role="note"><ShieldCheck size={15} aria-hidden="true" /><p>The passages below are exact paginated chunks from the admitted Reader manifest. Select source text or use a paragraph capture button; the server reconstructs every saved quote.</p></div>
                {!project ? <div className="live-reader-source-notice live-reader-capture-unavailable" role="note"><TriangleAlert size={15} aria-hidden="true" /><p>Open this paper from a visible project before capturing evidence.</p></div> : null}
              </header>

              <div className="reader-selection-status" role="status" aria-live="polite">{selectionStatus}</div>

              {pages.map(({ pageNumber, chunks }) => (
                <section className="live-reader-page" id={`live-reader-page-${pageNumber}`} aria-labelledby={`live-reader-page-title-${pageNumber}`} key={pageNumber}>
                  <header><span>PDF page</span><h2 id={`live-reader-page-title-${pageNumber}`}>{pageNumber}</h2></header>
                  <div className="live-reader-page-text" onKeyUp={(event) => { if (event.key === "Shift" || event.key.startsWith("Arrow")) void inspectBrowserSelection(); }} onPointerUp={(event) => { if (!(event.target as Element).closest("button")) void inspectBrowserSelection(); }}>
                    {chunks.map((chunk) => {
                      const selected = markedChunkIds.has(chunk.id);
                      const captureButtonId = `reader-capture-chunk-${chunk.sequence}`;
                      return (
                        <div className={`live-reader-chunk${selected ? " capture-selected" : ""}${chunk.id === firstMarkedChunkId ? " capture-start" : ""}${chunk.id === lastMarkedChunkId ? " capture-end" : ""}${captureState.phase === "source-changed" && selected ? " capture-stale" : ""}`} id={`reader-chunk-${chunk.sequence}-${chunk.id}`} key={chunk.id}>
                          <span className="live-reader-locator">p. {chunk.pageNumber} · {chunk.paragraphId} · seq {chunk.sequence}</span>
                          <p data-reader-chunk-id={chunk.id} data-reader-chunk-text>{chunk.text}</p>
                          <button className="reader-paragraph-capture" id={captureButtonId} type="button" disabled={!selectionEnabled || (captureState.phase !== "idle" && captureState.phase !== "reselecting")} onClick={() => void captureWholeChunk(chunk, captureButtonId)} aria-label={`${reanchorMode ? "Re-anchor to" : "Capture"} paragraph ${chunk.paragraphId} on page ${chunk.pageNumber} as grounded evidence`}><Quote size={12} aria-hidden="true" /> {reanchorMode ? "Use as replacement" : "Capture paragraph"}</button>
                          {candidateSelection && chunk.id === lastMarkedChunkId ? (
                            <button className="reader-selection-capture" id={`reader-capture-selection-${chunk.id}`} type="button" onClick={fileCandidate}><Network size={12} aria-hidden="true" /> {reanchorMode ? "Use replacement text" : "Capture selected text"} <span>{candidateSelection.selectedByteLength.toLocaleString()} bytes</span></button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}

              {reader.nextCursor ? (
                <div className="live-reader-pagination">
                  <span>{reader.chunks.length} of {reader.generation.chunkCount} authoritative chunks loaded</span>
                  <button className="button primary" type="button" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? <LoaderCircle className="auth-spinner" size={13} /> : <BookOpenText size={13} />}{loadingMore ? "Loading next folio…" : "Load next folio"}</button>
                </div>
              ) : (
                <div className="live-reader-pagination live-reader-pagination-complete"><CheckCircle2 size={14} aria-hidden="true" />Complete extraction · {reader.chunks.length} authoritative chunks</div>
              )}
            </article>
          </div>

          {project ? (
            <EvidenceCaptureDocket
              canCapture={canCaptureEvidence}
              captureState={captureState}
              collections={collections}
              evidenceCount={groundedEvidence.length}
              onAction={onCaptureAction}
              onDismiss={onDismissCapture}
              onReloadSource={onReloadCaptureSource}
              onSave={onSaveCapture}
              onViewEvidence={onViewEvidence}
              project={project}
              sourceUpdateCount={sourceUpdateCount}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
