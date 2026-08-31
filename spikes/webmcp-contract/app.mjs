import {
  INPUT_SCHEMAS,
  LIMITS,
  RESULT_SCHEMAS,
  TOOL_NAMES,
  SPIKE_VERSIONS,
  canonicalJson,
  createSpikeState,
  createToolSuite,
  mintReaderAnchor,
  applyReaderAnnotation,
  mountToolSuite,
  redoLastHumanChange,
  undoLastHumanChange,
} from "./contracts.mjs";
import { initializePaperPdfViewer, normalizePdfText, resolvePdfTextRangeGeometry } from "./pdf-viewer.mjs";
import {
  clampGraphPosition,
  moveAnnotation,
  nudgeGraphPosition,
  reconcileAnnotationOrder,
  resolvePrimaryGraphNodeKey,
} from "./presentation-layout.mjs";
import { analyzePaperPages } from "./paper-analysis.mjs";
import {
  clearBrowserSnapshot,
  loadBrowserSnapshot,
  saveBrowserSnapshot,
} from "./browser-snapshot.mjs";
import {
  TOOL_PRESENTATION_COPY,
  annotationAnchorId,
  createObservedTrace,
  instrumentWebmcpTools,
  resolveObservedAnchor,
} from "./webmcp-observer.mjs";
import {
  applyHumanMentorDecision,
  createMentorReviewViewModel,
} from "./mentor-review.mjs";
import {
  boundActivityForDisplay,
  createActivityRecord,
  formatActivityEvent,
  humanReadable,
  mergeRestoredActivity as mergeActivityLedger,
} from "./activity-ledger.mjs";
import {
  projectAccessibleAnnotationSummary,
  projectAccessibleGraphOutline,
} from "./accessibility-projection.mjs";

const byId = (id) => document.getElementById(id);

const elements = {
  skipLink: byId("skip-link"),
  webmcpStatus: byId("webmcp-status"),
  workspaceStatus: byId("workspace-status"),
  focusStatus: byId("focus-status"),
  paperAnalysisStatus: byId("paper-analysis-status"),
  paperBoundary: byId("paper-boundary"),
  paperHeading: byId("paper-heading"),
  paperSourceGate: byId("paper-source-gate"),
  paperFileInput: byId("paper-file-input"),
  paperSourceGateStatus: byId("paper-source-gate-status"),
  loadAttentionDemo: byId("load-attention-demo"),
  rendererStatus: byId("renderer-status"),
  sigmaContainer: byId("sigma-container"),
  graphCanvasShell: byId("graph-canvas-shell"),
  graphDropHint: byId("graph-drop-hint"),
  graphLayoutStatus: byId("graph-layout-status"),
  graphLayoutReset: byId("graph-layout-reset"),
  graphNudgeButtons: [...document.querySelectorAll("[data-graph-nudge]")],
  graphOutline: byId("graph-outline"),
  annotationList: byId("annotation-list"),
  annotationLayoutStatus: byId("annotation-layout-status"),
  activityList: byId("activity-list"),
  toolList: byId("tool-list"),
  lastResult: byId("last-result"),
  registerTools: byId("register-tools"),
  disposeTools: byId("dispose-tools"),
  humanUndo: byId("human-undo"),
  humanRedo: byId("human-redo"),
  revealVisualKey: byId("reveal-visual-key"),
  confirmVisualProof: byId("confirm-visual-proof"),
  visualMode: byId("visual-mode"),
  visualKey: byId("visual-key"),
  visualCommitment: byId("visual-commitment"),
  schemaSetHash: byId("schema-set-hash"),
  byteCeilings: byId("byte-ceilings"),
  runtimePins: byId("runtime-pins"),
  paperStage: byId("paper-stage"),
  pdfViewer: byId("pdf-viewer"),
  pdfIdentity: byId("pdf-identity"),
  pdfPageSurface: byId("pdf-page-surface"),
  pdfActivePageDescription: byId("pdf-active-page-description"),
  pdfLoading: byId("pdf-loading"),
  pdfSourceStatus: byId("pdf-source-status"),
  paperAnnotationSummary: byId("paper-annotation-summary"),
  get textSource() { return byId("text-source"); },
  visualRegionA: byId("visual-region-a"),
  visualRegionB: byId("visual-region-b"),
  canvasA: byId("visual-canvas-a"),
  canvasB: byId("visual-canvas-b"),
  annotationCount: byId("annotation-count"),
  agentCursor: byId("agent-cursor"),
  agentCursorLabel: byId("agent-cursor-label"),
  agentActionStatus: byId("agent-action-status"),
  agentAnnouncement: byId("agent-announcement"),
  replayAgentAction: byId("replay-agent-action"),
  readerAnnotationForm: byId("reader-annotation-form"),
  readerAnnotationLabel: byId("reader-annotation-label"),
  readerNodeKind: byId("reader-node-kind"),
  readerSelectionStatus: byId("reader-selection-status"),
  graphSearchForm: byId("graph-search-form"),
  graphSearchQuery: byId("graph-search-query"),
  graphSearchStatus: byId("graph-search-status"),
  graphSearchResults: byId("graph-search-results"),
  clearGraphSearch: byId("clear-graph-search"),
  paperAnalysisProgress: byId("paper-analysis-progress"),
  paperAnalysisSummary: byId("paper-analysis-summary"),
  criticalIdeaCount: byId("critical-idea-count"),
  criticalIdeaList: byId("critical-idea-list"),
  primarySourceButton: byId("primary-source-button"),
  mentorExplanationBody: byId("mentor-explanation-body"),
  mentorExplanationState: byId("mentor-explanation-state"),
  mentorExplanationActions: byId("mentor-explanation-actions"),
  mentorExplanationStatus: byId("mentor-explanation-status"),
  saveExplanation: byId("save-explanation"),
  discardExplanation: byId("discard-explanation"),
  mentorTakeaway: byId("mentor-takeaway"),
  browserSaveCard: document.querySelector(".browser-save-card"),
  saveWorkspace: byId("save-workspace"),
  clearSavedWorkspace: byId("clear-saved-workspace"),
  browserSaveStatus: byId("browser-save-status"),
  workspace: document.querySelector(".workspace"),
};

const activity = [];
let state;
let tools = [];
let suiteHandle = null;
let registrationClosed = false;
let sigmaRenderer = null;
let sigmaGraph = null;
let visualTrialObserved = false;
let visualKeyRevealed = false;
let lastObservedTrace = null;
let visualReplayQueue = Promise.resolve();
let paperViewer = null;
let pendingReaderCapture = null;
let pendingReaderOverlayId = null;
let annotationOrder = Object.freeze([]);
let selectedGraphNodeKey = null;
let draggedAnnotationId = null;
let draggedAnnotationNodeKey = null;
let draggedGraphNodeKey = null;
let graphDragStartPosition = null;
let paperAnalysis = null;
let savedExplanations = [];
let snapshotEnabled = false;
let snapshotDirty = false;
let snapshotStored = false;
let snapshotStatusKind = "idle";
let snapshotStatusMessage = "Not saved · active tab only";
let snapshotSaveQueue = Promise.resolve();
let clearSavedCopyArmed = false;
const criticalIdeaByNodeKey = new Map();
const initialGraphPositions = new Map();
const graphLayoutPositions = new Map();

const reducedMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

const ATTENTION_DEMO_URL = "https://arxiv.org/pdf/1706.03762";
const ATTENTION_DEMO_FILENAME = "Attention Is All You Need.pdf";
function timestamp() {
  return new Date().toISOString();
}

function recordActivity(eventType, details = {}) {
  const record = createActivityRecord(eventType, details, timestamp());
  activity.push(record);
  renderActivity();
  return record;
}

function mergeRestoredActivity(events) {
  activity.splice(0, activity.length, ...mergeActivityLedger({ current: activity, restored: events }));
}

function paperTitleFromFilename(filename) {
  const stem = String(filename || "Research paper").replace(/\.pdf$/iu, "");
  return stem.replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim() || "Research paper";
}

function setAnalysisProgress(value, maximum, label) {
  const max = Math.max(1, Number(maximum) || 1);
  elements.paperAnalysisProgress.max = max;
  if (value === null) {
    elements.paperAnalysisProgress.removeAttribute("value");
  } else {
    elements.paperAnalysisProgress.value = Math.max(0, Math.min(max, Number(value) || 0));
  }
  elements.paperAnalysisProgress.textContent = label;
  elements.paperAnalysisProgress.setAttribute("aria-valuetext", label);
}

function setPdfIdentity(label) {
  const dot = document.createElement("span");
  dot.className = "pdf-dot";
  dot.setAttribute("aria-hidden", "true");
  elements.pdfIdentity.replaceChildren(dot, document.createTextNode(label));
}

function browserStorageAdapter() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function sourceThreadToken(anchorId) {
  const anchor = state?.anchors?.get(anchorId);
  if (!anchor) return "Source unavailable";
  const sourceIndex = [...state.anchors.keys()].sort().indexOf(anchorId) + 1;
  return `P${anchor.pageLabel} · source ${String(Math.max(1, sourceIndex)).padStart(2, "0")}`;
}

function renderMentorExplanation() {
  const review = createMentorReviewViewModel({
    stagedExplanations: state?.explanations,
    savedExplanations,
    currentAnchorIds: state?.anchors?.keys(),
    currentGraphNodeKeys: state?.graph?.nodes(),
  });
  const explanation = review.explanation;
  elements.mentorExplanationBody.replaceChildren();
  elements.mentorExplanationState.className = "review-state is-empty";
  elements.mentorExplanationActions.hidden = true;
  if (!explanation) {
    const empty = document.createElement("p");
    empty.textContent = review.quickTake;
    elements.mentorExplanationBody.append(empty);
    elements.mentorExplanationState.textContent = review.stateLabel;
    elements.mentorExplanationStatus.textContent = review.statusMessage;
    elements.mentorTakeaway.value = "";
    delete elements.mentorTakeaway.dataset.explanationId;
    return;
  }

  const saved = review.state === "saved";
  const takeawayChangedExplanation = elements.mentorTakeaway.dataset.explanationId !== explanation.explanationId;
  elements.mentorTakeaway.dataset.explanationId = explanation.explanationId;
  elements.mentorExplanationState.textContent = review.stateLabel;
  elements.mentorExplanationState.className = `review-state${saved ? " is-saved" : ""}`;
  const quickTake = document.createElement("p");
  quickTake.className = "mentor-quick-take";
  quickTake.textContent = review.quickTake;
  elements.mentorExplanationBody.append(quickTake);

  for (const sectionModel of review.sections) {
    const section = document.createElement("details");
    section.className = "mentor-section";
    section.open = sectionModel.initiallyOpen;
    const summary = document.createElement("summary");
    summary.textContent = sectionModel.label;
    const authority = document.createElement("span");
    authority.className = `mentor-authority ${sectionModel.authorityKind === "paper_evidence" ? "is-paper" : "is-mentor"}`;
    authority.textContent = sectionModel.authorityLabel;
    const content = document.createElement("p");
    content.textContent = sectionModel.content;
    section.append(summary, authority, content);
    elements.mentorExplanationBody.append(section);
  }

  const chips = document.createElement("div");
  chips.className = "mentor-evidence-chips";
  for (const anchorId of review.sourceAnchorIds) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = sourceThreadToken(anchorId);
    button.setAttribute("aria-label", `Go to ${sourceThreadToken(anchorId)} used by this mentor note`);
    button.addEventListener("click", async () => {
      state.focusAnchorId = anchorId;
      recordActivity("mentor_evidence_focused", { actor: "human", status: anchorId });
      await ensureAnchorVisible(anchorId, { moveKeyboardFocus: true, scrollIntoView: true });
    });
    chips.append(button);
  }
  for (const graphKey of review.graphEntityKeys) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Map · ${graphNodeLabel(graphKey)}`;
    button.setAttribute("aria-label", `Select ${graphNodeLabel(graphKey)} in the knowledge graph and go to its paper evidence`);
    button.addEventListener("click", () => focusGraphNodeEvidence(graphKey));
    chips.append(button);
  }
  if (chips.childElementCount) elements.mentorExplanationBody.append(chips);

  if (saved) {
    if (explanation.takeaway) {
      const takeaway = document.createElement("p");
      takeaway.className = "reader-takeaway";
      takeaway.textContent = `My takeaway: ${review.takeaway}`;
      elements.mentorExplanationBody.append(takeaway);
    }
    elements.mentorExplanationStatus.textContent = `Saved by the reader · ${explanation.savedAt ? new Date(explanation.savedAt).toLocaleString() : "this session"} · AI-generated, not scientifically verified.`;
    if (takeawayChangedExplanation) elements.mentorTakeaway.value = review.takeaway;
  } else {
    elements.mentorExplanationActions.hidden = !review.showHumanDecisionActions;
    elements.mentorExplanationStatus.textContent = review.statusMessage;
    if (takeawayChangedExplanation) elements.mentorTakeaway.value = "";
  }
}

function renderBrowserSaveState() {
  elements.browserSaveCard.classList.toggle("is-saved", snapshotStatusKind === "saved" || snapshotStatusKind === "restored");
  elements.browserSaveCard.classList.toggle("is-dirty", snapshotDirty && snapshotStatusKind !== "error");
  elements.browserSaveCard.classList.toggle("is-error", snapshotStatusKind === "error");
  elements.browserSaveStatus.textContent = snapshotStatusMessage;
  elements.saveWorkspace.textContent = snapshotStored ? "Save changes" : "Save in this browser";
  elements.clearSavedWorkspace.disabled = !snapshotStored;
}

function snapshotPresentation() {
  return {
    annotationOrder: [...annotationOrder],
  };
}

function markSnapshotDirty({ saveIfEnabled = true } = {}) {
  if (!state) return;
  snapshotDirty = true;
  if (!snapshotStored) {
    snapshotStatusKind = "idle";
    snapshotStatusMessage = "Not saved · active tab only";
  } else {
    snapshotStatusKind = "dirty";
    snapshotStatusMessage = "Changes since the last browser save";
  }
  renderBrowserSaveState();
  if (snapshotEnabled && saveIfEnabled) void persistBrowserWorkspace({ enable: false, reason: "automatic update" });
}

function snapshotFailureMessage(result) {
  if (result?.status === "too_large") return "Not saved in this browser — the workspace exceeded the 4 MiB recovery limit. Keep this tab open.";
  if (result?.reason === "quota_exceeded") return "Not saved in this browser — browser storage is full. Keep this tab open.";
  if (result?.status === "invalid_state") return "Not saved in this browser — PaperPilot rejected an unsafe recovery snapshot. Keep this tab open.";
  return "Not saved in this browser — storage is unavailable. Keep this tab open.";
}

async function persistBrowserWorkspace({ enable = false, reason = "manual save" } = {}) {
  const wasEnabled = snapshotEnabled;
  if (enable) snapshotEnabled = true;
  const task = async () => {
    const storage = browserStorageAdapter();
    if (!storage) {
      if (!wasEnabled) snapshotEnabled = false;
      snapshotStatusKind = "error";
      snapshotStatusMessage = snapshotFailureMessage({ status: "storage_error" });
      renderBrowserSaveState();
      return { status: "storage_error", reason: "storage_unavailable" };
    }
    const result = await saveBrowserSnapshot({
      storage,
      state,
      savedExplanations,
      presentation: snapshotPresentation(),
    });
    if (result.status === "saved") {
      snapshotStored = true;
      snapshotDirty = false;
      snapshotStatusKind = "saved";
      snapshotStatusMessage = `Saved in this browser · ${new Date(result.savedAt).toLocaleString()} · exact PDF fingerprint only`;
      recordActivity("browser_workspace_saved", { actor: "human", status: `${reason} · revision ${state.workspaceRevision}` });
    } else {
      if (!wasEnabled) snapshotEnabled = false;
      snapshotStatusKind = "error";
      snapshotStatusMessage = snapshotFailureMessage(result);
      recordActivity("browser_workspace_save_failed", { actor: "page", status: result.reason || result.status });
    }
    renderBrowserSaveState();
    return result;
  };
  snapshotSaveQueue = snapshotSaveQueue.then(task, task);
  return snapshotSaveQueue;
}

async function restoreBrowserWorkspace() {
  const storage = browserStorageAdapter();
  if (!storage) {
    snapshotStatusKind = "error";
    snapshotStatusMessage = "Browser recovery is unavailable. This workspace will remain in the active tab only.";
    renderBrowserSaveState();
    return { status: "storage_error" };
  }
  const result = await loadBrowserSnapshot({ storage, state });
  if (result.status === "restored") {
    savedExplanations = result.savedExplanations || [];
    annotationOrder = Object.freeze(result.presentation?.annotationOrder || []);
    mergeRestoredActivity(state.events);
    snapshotEnabled = true;
    snapshotStored = true;
    snapshotDirty = false;
    snapshotStatusKind = "restored";
    snapshotStatusMessage = `Restored from this browser · ${new Date(result.savedAt).toLocaleString()} · revision ${state.workspaceRevision}`;
    recordActivity("browser_workspace_restored", { actor: "page", status: `revision ${state.workspaceRevision}` });
  } else if (result.status === "not_found") {
    snapshotStatusKind = "idle";
    snapshotStatusMessage = "Not saved · active tab only";
  } else {
    snapshotStored = true;
    snapshotStatusKind = "error";
    snapshotStatusMessage = "A saved copy was found but failed validation. The fresh verified paper is active; no stored state was applied.";
    recordActivity("browser_workspace_restore_rejected", { actor: "page", status: result.reason || result.status });
  }
  renderBrowserSaveState();
  return result;
}

function mergeExactRangeRectsByLine(rectangles) {
  const sorted = rectangles
    .map((rectangle) => ({ ...rectangle }))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const merged = [];
  for (const rectangle of sorted) {
    const current = merged.at(-1);
    const currentCenter = current ? current.y + current.height / 2 : 0;
    const nextCenter = rectangle.y + rectangle.height / 2;
    const sameLine = current
      && Math.abs(currentCenter - nextCenter) <= Math.max(current.height, rectangle.height) * 0.62
      && rectangle.x <= current.x + current.width + Math.max(current.height, rectangle.height) * 2.5;
    if (!sameLine) {
      merged.push(rectangle);
      continue;
    }
    const right = Math.max(current.x + current.width, rectangle.x + rectangle.width);
    const bottom = Math.max(current.y + current.height, rectangle.y + rectangle.height);
    current.x = Math.min(current.x, rectangle.x);
    current.y = Math.min(current.y, rectangle.y);
    current.width = right - current.x;
    current.height = bottom - current.y;
  }
  return merged;
}

function sourceRectsForCandidate(documentText, candidate) {
  const source = candidate?.sourceLocator;
  const page = documentText?.pages?.find((entry) => entry.pageIndex === source?.pageIndex);
  if (!page || !source) return null;
  const geometry = resolvePdfTextRangeGeometry(page, {
    startOffset: source.startOffset,
    endOffset: source.endOffset,
    exactText: source.exactText,
  });
  if (!geometry) {
    const normalizedPage = normalizePdfText(page.text);
    const normalizedExact = normalizePdfText(source.exactText);
    const firstMatch = normalizedPage.indexOf(normalizedExact);
    const secondMatch = firstMatch < 0 ? -1 : normalizedPage.indexOf(normalizedExact, firstMatch + normalizedExact.length);
    recordActivity("candidate_geometry_rejected", {
      actor: "page",
      status: `${candidate.key} · exact range not resolved · normalized matches ${firstMatch >= 0 ? (secondMatch >= 0 ? "multiple" : "one") : "zero"}`,
    });
    return null;
  }
  if (geometry.geometryCoverage < 0.98) {
    recordActivity("candidate_geometry_rejected", { actor: "page", status: `${candidate.key} · coverage ${geometry.geometryCoverage}` });
    return null;
  }
  const normalizedBounds = mergeExactRangeRectsByLine(geometry.normalizedBounds);
  if (normalizedBounds.length === 0 || normalizedBounds.length > 32) {
    recordActivity("candidate_geometry_rejected", { actor: "page", status: `${candidate.key} · ${normalizedBounds.length} merged rectangles` });
    return null;
  }
  return {
    page,
    normalizedBounds,
    geometryMethod: geometry.geometryMethod,
    geometryCoverage: geometry.geometryCoverage,
  };
}

function groundAutomaticMap(documentText, analysis) {
  const candidates = analysis.candidates.flatMap((candidate) => {
    const located = sourceRectsForCandidate(documentText, candidate);
    if (!located) return [];
    return [{
      key: candidate.key,
      rank: candidate.rank,
      kind: candidate.kind,
      label: candidate.label,
      summary: candidate.summary,
      salience: candidate.salience,
      authority: candidate.authority,
      reviewState: candidate.reviewState,
      source: {
        pageIndex: candidate.sourceLocator.pageIndex,
        pageLabel: candidate.sourceLocator.pageLabel,
        exactText: candidate.sourceLocator.exactText,
        normalizedBounds: located.normalizedBounds,
        pageViewBox: [...located.page.pageViewBox],
        pageRotation: located.page.pageRotation,
      },
    }];
  });
  const groundedKeys = new Set(candidates.map((candidate) => candidate.key));
  return {
    contract: {
      schemaVersion: 1,
      status: candidates.length === 0
        ? "no_text"
        : candidates.length < 5
          ? "candidate_limited"
          : analysis.status,
      claimBoundary: analysis.claimBoundary,
      pageCount: analysis.pageCount,
      coverage: analysis.coverage.map(({ pageIndex, pageLabel, textCapability }) => ({
        pageIndex,
        pageLabel,
        textCapability,
      })),
      candidates,
    },
    presentation: {
      ...analysis,
      candidateCount: candidates.length,
      candidates: analysis.candidates.filter((candidate) => groundedKeys.has(candidate.key)),
      layout: {
        ...analysis.layout,
        positions: analysis.layout.positions.filter((position) => groundedKeys.has(position.nodeKey)),
        spine: analysis.layout.spine.filter((edge) => groundedKeys.has(edge.fromKey) && groundedKeys.has(edge.toKey)),
      },
    },
  };
}

function prefersReducedMotion() {
  return Boolean(reducedMotionQuery?.matches);
}

function waitForReplay(milliseconds) {
  if (prefersReducedMotion() || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resetAgentCursorClasses() {
  elements.agentCursor.classList.remove(
    "at-text",
    "at-visual-a",
    "at-visual-b",
    "at-page",
    "is-ready",
    "is-working",
    "is-editing",
    "is-complete",
    "is-error",
  );
}

function cursorTargetForAnchor(anchorId) {
  return focusElementForAnchor(anchorId) || elements.paperStage;
}

async function ensureAnchorVisible(anchorId, { moveKeyboardFocus = false, scrollIntoView = true } = {}) {
  const anchor = state?.anchors.get(anchorId);
  if (!anchor) return null;
  if (paperViewer && anchor.sourceKind !== "visual_region") {
    if (typeof paperViewer.focusAnchor === "function") {
      await paperViewer.focusAnchor(anchorId, {
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "center",
        scrollIntoView,
      });
    } else {
      await paperViewer.showPage(anchor.pageIndex + 1);
    }
  }
  if (anchor.sourceKind === "visual_region") {
    elements.visualRegionA.closest("details")?.setAttribute("open", "");
  }
  renderFocus({ moveKeyboardFocus, scrollIntoView: anchor.sourceKind === "visual_region" && scrollIntoView });
  return focusElementForAnchor(anchorId);
}

function placeAgentCursor(anchorId, phase, label, announcement = label) {
  const target = cursorTargetForAnchor(anchorId);
  if (elements.agentCursor.parentElement !== target) target.append(elements.agentCursor);
  resetAgentCursorClasses();
  if (anchorId === "anchor:visual:a") elements.agentCursor.classList.add("at-visual-a");
  else if (anchorId === "anchor:visual:b") elements.agentCursor.classList.add("at-visual-b");
  else if (anchorId === "anchor:text:attention") elements.agentCursor.classList.add("at-text");
  else elements.agentCursor.classList.add("at-page");
  elements.agentCursor.classList.add(`is-${phase}`);
  elements.agentCursor.dataset.agentState = phase;
  elements.agentCursorLabel.textContent = label;
  elements.agentActionStatus.textContent = announcement;
  elements.agentAnnouncement.textContent = announcement;
}

function showToolRequest(toolName, input) {
  const copy = TOOL_PRESENTATION_COPY[toolName] || { action: "Running page callback" };
  const anchorId = resolveObservedAnchor(state, toolName, input, {});
  placeAgentCursor(
    anchorId,
    toolName.startsWith("paperpilot.apply_") ? "editing" : "working",
    copy.action,
    `Request reached the PaperPilot page for ${toolName}.`,
  );
}

function showToolResult(toolName, input, result) {
  const trace = createObservedTrace({ state, toolName, input, result });
  const copy = TOOL_PRESENTATION_COPY[toolName] || { complete: "Page callback returned" };
  const replayCopy = trace.status === "rejected"
    ? `Callback rejected · ${humanReadable(trace.code || "invalid request")}`
    : trace.replayed
      ? "Idempotent replay · no new revision"
      : `${copy.complete} · ${humanReadable(trace.status)}`;
  placeAgentCursor(
    trace.anchorId,
    trace.status === "rejected" ? "error" : "complete",
    replayCopy,
    trace.status === "rejected"
      ? `PaperPilot rejected ${toolName}. No annotation or graph revision was created.`
      : `PaperPilot returned ${trace.status} from ${toolName} at page ${trace.pageLabel}. This confirms a page callback, not private model reasoning.`,
  );
  lastObservedTrace = trace;
  elements.replayAgentAction.disabled = false;

  if (toolName === "paperpilot.apply_annotation" && trace.status !== "rejected") {
    const target = cursorTargetForAnchor(trace.anchorId);
    target.classList.add("is-agent-editing");
    const highlights = [...document.querySelectorAll(".pdf-source-highlight")];
    for (const highlight of highlights) highlight.classList.add("is-agent-editing");
    setTimeout(() => {
      target.classList.remove("is-agent-editing");
      for (const highlight of highlights) highlight.classList.remove("is-agent-editing");
    }, 1_300);
  }
}

async function replayObservedTrace(trace) {
  if (!trace) return;
  elements.replayAgentAction.disabled = true;
  recordActivity("callback_visual_replay_started", { actor: "human", toolName: trace.toolName });
  placeAgentCursor(
    trace.anchorId,
    "working",
    "Replay · request reached page",
    `Replaying the observed page callback for ${trace.toolName}. No tool or mutation is running.`,
  );
  await waitForReplay(650);
  placeAgentCursor(
    trace.anchorId,
    "complete",
    `Replay · page returned ${humanReadable(trace.status)}`,
    `Replay complete for ${trace.toolName}. No command ran and no revision changed.`,
  );
  await waitForReplay(450);
  elements.replayAgentAction.disabled = false;
  recordActivity("callback_visual_replay_completed", { actor: "human", toolName: trace.toolName, status: trace.status });
}

function enqueueObservedTraceReplay(trace) {
  visualReplayQueue = visualReplayQueue.then(() => replayObservedTrace(trace), () => replayObservedTrace(trace));
  return visualReplayQueue;
}

function appendTextListItem(list, text, className) {
  const item = document.createElement("li");
  if (className) item.className = className;
  item.textContent = text;
  list.append(item);
  return item;
}

function renderActivity() {
  elements.activityList.replaceChildren();
  const visible = boundActivityForDisplay(activity);
  if (visible.length === 0) {
    appendTextListItem(elements.activityList, "No page or tool activity observed yet.");
    return;
  }
  for (const event of visible) {
    appendTextListItem(elements.activityList, formatActivityEvent(event));
  }
}

function renderToolList() {
  elements.toolList.replaceChildren();
  for (const name of TOOL_NAMES) appendTextListItem(elements.toolList, name);
}

async function renderContractManifest() {
  elements.schemaSetHash.textContent = await sha256(canonicalJson({ input: INPUT_SCHEMAS, result: RESULT_SCHEMAS }));
  elements.byteCeilings.textContent = `${LIMITS.inputBytes / 1024} KiB canonical input / ${LIMITS.resultBytes / 1024} KiB result`;
  elements.runtimePins.textContent = `PDF.js ${SPIKE_VERSIONS.pdfjs} · Graphology ${SPIKE_VERSIONS.graphology} · Sigma ${SPIKE_VERSIONS.sigma}`;
}

function renderLastResult(result) {
  elements.lastResult.textContent = JSON.stringify(result, null, 2);
}

function focusElementForAnchor(anchorId) {
  return paperViewer?.getAnchorTarget?.(anchorId) || {
    "anchor:text:attention": elements.textSource,
    "anchor:visual:a": elements.visualRegionA,
    "anchor:visual:b": elements.visualRegionB,
  }[anchorId] || null;
}

function renderFocus({ moveKeyboardFocus = false, scrollIntoView = moveKeyboardFocus } = {}) {
  const focusAnchor = state.anchors.get(state.focusAnchorId);
  const target = focusElementForAnchor(state.focusAnchorId);
  const anchorTargets = [
    ...document.querySelectorAll("[data-anchor-id]"),
    elements.textSource,
    elements.visualRegionA,
    elements.visualRegionB,
  ].filter(Boolean);
  for (const element of new Set(anchorTargets)) {
    element.classList.toggle("active", element === target);
  }
  const pageSurface = paperViewer?.getPageSurface?.((focusAnchor?.pageIndex ?? 0) + 1) || elements.pdfPageSurface;
  const scrollTarget = target && !target.hidden ? target : pageSurface || elements.paperStage;
  elements.focusStatus.textContent = focusAnchor
    ? `${focusAnchor.pageLabel} · ${humanReadable(focusAnchor.sourceKind)}`
    : "Unavailable";
  if (scrollIntoView) {
    scrollTarget.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
  if (moveKeyboardFocus) {
    const keyboardTarget = target?.closest?.(".pdf-page-surface") || (target === elements.textSource ? pageSurface : scrollTarget);
    keyboardTarget?.focus({ preventScroll: true });
  }
}

function activeGraphNodeKeys() {
  if (!state?.graph) return [];
  return state.graph.nodes().filter((key) => state.graph.getNodeAttribute(key, "status") === "active");
}

function reconcileGraphPresentation() {
  if (!state?.graph) return;
  for (const key of [...graphLayoutPositions.keys()]) {
    if (state.graph.hasNode(key)) continue;
    graphLayoutPositions.delete(key);
    initialGraphPositions.delete(key);
  }
  state.graph.forEachNode((key, attributes) => {
    const current = clampGraphPosition({ x: attributes.x, y: attributes.y });
    const preferred = graphLayoutPositions.get(key);
    if (!preferred) {
      graphLayoutPositions.set(key, current);
      initialGraphPositions.set(key, current);
      return;
    }
    if (current.x !== preferred.x || current.y !== preferred.y) {
      state.graph.mergeNodeAttributes(key, preferred);
    }
  });
}

function graphNodeLabel(key) {
  if (!key || !state?.graph?.hasNode(key)) return "graph node";
  return state.graph.getNodeAttribute(key, "label") || key;
}

function linkedGraphNode(annotation) {
  if (annotation?.status !== "active") return null;
  return resolvePrimaryGraphNodeKey(annotation, activeGraphNodeKeys());
}

function updateGraphSelectionPresentation() {
  const selectedIsActive = selectedGraphNodeKey &&
    state?.graph?.hasNode(selectedGraphNodeKey) &&
    state.graph.getNodeAttribute(selectedGraphNodeKey, "status") === "active";
  if (!selectedIsActive) selectedGraphNodeKey = null;

  for (const button of elements.graphNudgeButtons) button.disabled = !selectedGraphNodeKey;
  elements.graphLayoutReset.disabled = initialGraphPositions.size === 0;
  for (const item of document.querySelectorAll("[data-graph-node-key]")) {
    const selected = item.dataset.graphNodeKey === selectedGraphNodeKey;
    item.classList.toggle("is-selected", selected);
    if (item.matches("button")) item.setAttribute("aria-pressed", String(selected));
  }
  if (sigmaRenderer && sigmaGraph === state.graph) sigmaRenderer.scheduleRefresh();
}

function selectGraphNode(nodeKey, { announce = true } = {}) {
  if (
    !nodeKey ||
    !state?.graph?.hasNode(nodeKey) ||
    state.graph.getNodeAttribute(nodeKey, "status") !== "active"
  ) {
    return false;
  }
  selectedGraphNodeKey = nodeKey;
  updateGraphSelectionPresentation();
  if (announce) {
    elements.graphLayoutStatus.textContent = `Selected “${graphNodeLabel(nodeKey)}.” Drag it in the map or use the arrow controls. Evidence stays fixed.`;
  }
  return true;
}

async function focusGraphNodeEvidence(nodeKey) {
  if (!selectGraphNode(nodeKey)) return false;
  const attributes = state.graph.getNodeAttributes(nodeKey);
  const anchorId = attributes.sourceAnchorIds?.[0] || attributes.structuralCoverage?.[0]?.primaryAnchorId;
  if (!anchorId || !state.anchors.has(anchorId)) {
    elements.graphLayoutStatus.textContent = `Selected “${graphNodeLabel(nodeKey)},” but it has no navigable paper source.`;
    return true;
  }
  state.focusAnchorId = anchorId;
  recordActivity("graph_node_source_focused", { actor: "human", status: nodeKey });
  await ensureAnchorVisible(anchorId, { moveKeyboardFocus: true, scrollIntoView: true });
  return true;
}

function setGraphNodePosition(nodeKey, position, { announce = true, record = true } = {}) {
  if (
    !nodeKey ||
    !state?.graph?.hasNode(nodeKey) ||
    state.graph.getNodeAttribute(nodeKey, "status") !== "active"
  ) {
    return false;
  }
  if (selectedGraphNodeKey !== nodeKey) selectGraphNode(nodeKey, { announce: false });
  const next = clampGraphPosition(position);
  const current = clampGraphPosition(state.graph.getNodeAttributes(nodeKey));
  if (next.x === current.x && next.y === current.y) return false;
  graphLayoutPositions.set(nodeKey, next);
  state.graph.mergeNodeAttributes(nodeKey, next);
  sigmaRenderer?.scheduleRefresh({ partialGraph: { nodes: [nodeKey] } });
  if (announce) {
    elements.graphLayoutStatus.textContent = `Moved “${graphNodeLabel(nodeKey)}.” Only its view position changed; provenance and WebMCP facts are unchanged.`;
  }
  if (record) {
    recordActivity("graph_layout_changed", {
      actor: "human",
      status: `${nodeKey} · presentation only`,
    });
    markSnapshotDirty();
  }
  return true;
}

function resetGraphLayout() {
  reconcileGraphPresentation();
  let restored = 0;
  for (const [key, position] of initialGraphPositions) {
    if (!state.graph.hasNode(key)) continue;
    const current = clampGraphPosition(state.graph.getNodeAttributes(key));
    if (current.x === position.x && current.y === position.y) continue;
    graphLayoutPositions.set(key, position);
    state.graph.mergeNodeAttributes(key, position);
    restored += 1;
  }
  sigmaRenderer?.setCustomBBox(null);
  sigmaRenderer?.refresh();
  elements.graphLayoutStatus.textContent = restored
    ? `Reset ${restored} ${restored === 1 ? "node" : "nodes"} to the initial view. Evidence and WebMCP facts were not changed.`
    : "The graph is already in its initial view. Evidence and WebMCP facts were not changed.";
  recordActivity("graph_layout_reset", { actor: "human", status: `${restored} presentation positions` });
  if (restored) markSnapshotDirty();
}

function clearAnnotationDropIndicators() {
  for (const item of elements.annotationList.querySelectorAll(".is-drop-before, .is-drop-after")) {
    item.classList.remove("is-drop-before", "is-drop-after");
  }
}

function finishAnnotationDrag() {
  draggedAnnotationId = null;
  draggedAnnotationNodeKey = null;
  clearAnnotationDropIndicators();
  elements.graphCanvasShell.classList.remove("is-drop-target");
  for (const item of elements.annotationList.querySelectorAll(".is-dragging")) item.classList.remove("is-dragging");
}

function focusReorderButton(annotationId, direction) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const item = [...elements.annotationList.querySelectorAll("[data-annotation-id]")]
        .find((candidate) => candidate.dataset.annotationId === annotationId);
      const preferred = item?.querySelector(`[data-reorder-direction="${direction}"]`);
      const fallbackDirection = direction === "earlier" ? "later" : "earlier";
      const fallback = item?.querySelector(`[data-reorder-direction="${fallbackDirection}"]`);
      const target = preferred?.disabled ? fallback : preferred;
      target?.focus({ preventScroll: true });
    });
  });
}

function reorderAnnotation(annotationId, targetId, placement, { direction = null } = {}) {
  const nextOrder = moveAnnotation(annotationOrder, annotationId, targetId, placement);
  if (nextOrder.every((key, index) => key === annotationOrder[index])) return false;
  annotationOrder = nextOrder;
  const annotation = state.annotations.get(annotationId);
  const body = annotation?.body || annotation?.label || annotationId;
  elements.annotationLayoutStatus.textContent = `Moved “${body}” ${placement} its neighbor. Paper anchors and graph identity are unchanged.`;
  recordActivity("annotation_layout_reordered", {
    actor: "human",
    status: `${annotationId} · presentation only`,
  });
  renderAnnotations();
  markSnapshotDirty();
  if (direction) focusReorderButton(annotationId, direction);
  return true;
}

function renderCriticalIdeaMap() {
  elements.criticalIdeaList.replaceChildren();
  if (!paperAnalysis || !state?.automaticMap) {
    elements.criticalIdeaCount.textContent = "0";
    elements.criticalIdeaCount.setAttribute("aria-label", "0 critical idea candidates");
    appendTextListItem(elements.criticalIdeaList, "No grounded critical-idea candidates are available.");
    return;
  }
  const ordered = [...paperAnalysis.candidates].sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
  const activeCount = ordered.filter((candidate) => (
    state.graph.hasNode(candidate.key) && state.graph.getNodeAttribute(candidate.key, "status") === "active"
  )).length;
  elements.criticalIdeaCount.textContent = String(activeCount);
  elements.criticalIdeaCount.setAttribute(
    "aria-label",
    `${activeCount} active critical idea ${activeCount === 1 ? "candidate" : "candidates"}`,
  );
  for (const candidate of ordered) {
    const attributes = state.graph.hasNode(candidate.key) ? state.graph.getNodeAttributes(candidate.key) : null;
    const seeded = state.automaticMap.candidates.find((entry) => entry.key === candidate.key);
    const isActive = attributes?.status === "active";
    const item = document.createElement("li");
    item.dataset.graphNodeKey = candidate.key;
    item.dataset.candidateRank = String(candidate.rank);
    if (!isActive) item.classList.add("is-tombstoned");
    const copy = document.createElement("div");
    copy.className = "critical-idea-copy";
    const label = document.createElement("strong");
    label.textContent = attributes?.label || candidate.label;
    const meta = document.createElement("p");
    meta.className = "critical-idea-meta";
    const page = document.createElement("span");
    page.className = "critical-idea-page";
    page.textContent = `Page ${candidate.sourceLocator.pageLabel}`;
    const kind = document.createElement("span");
    kind.textContent = humanReadable(attributes?.kind || candidate.kind);
    const origin = document.createElement("span");
    origin.textContent = attributes?.origin === "agent" ? "Agent refined" : "Automatic map · unreviewed";
    const stateLabel = document.createElement("span");
    const currentSalience = Number(attributes?.salience ?? candidate.salience);
    stateLabel.textContent = isActive ? `Salience ${currentSalience.toFixed(2)}` : "Removed from map";
    meta.append(page, kind, origin, stateLabel);
    const excerpt = document.createElement("p");
    excerpt.className = "critical-idea-excerpt";
    excerpt.textContent = attributes?.summary || candidate.summary;
    const actions = document.createElement("div");
    actions.className = "critical-idea-actions";
    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.textContent = "Select in graph";
    selectButton.disabled = !isActive;
    selectButton.setAttribute("aria-pressed", String(candidate.key === selectedGraphNodeKey));
    selectButton.addEventListener("click", () => { void focusGraphNodeEvidence(candidate.key); });
    actions.append(selectButton);
    if (seeded?.anchorId && state.anchors.has(seeded.anchorId)) {
      const sourceButton = document.createElement("button");
      sourceButton.type = "button";
      sourceButton.textContent = `Go to page ${candidate.sourceLocator.pageLabel} evidence`;
      sourceButton.addEventListener("click", async () => {
        state.focusAnchorId = seeded.anchorId;
        recordActivity("critical_idea_source_focused", { actor: "human", status: candidate.key });
        await ensureAnchorVisible(seeded.anchorId, { moveKeyboardFocus: true, scrollIntoView: true });
      });
      actions.append(sourceButton);
    }
    copy.append(label, meta, excerpt, actions);
    item.append(copy);
    elements.criticalIdeaList.append(item);
  }
}

function renderGraphOutline() {
  elements.graphOutline.replaceChildren();
  const outline = projectAccessibleGraphOutline(state.graph, criticalIdeaByNodeKey);
  for (const node of outline.nodes) {
    const key = node.key;
    const item = appendTextListItem(elements.graphOutline, node.text);
    item.dataset.graphNodeKey = key;
    const actions = document.createElement("div");
    actions.className = "graph-outline-actions";
    if (node.status === "active") {
      const arrangeButton = document.createElement("button");
      arrangeButton.type = "button";
      arrangeButton.dataset.graphNodeKey = key;
      arrangeButton.textContent = "Arrange this node";
      arrangeButton.setAttribute("aria-pressed", String(key === selectedGraphNodeKey));
      arrangeButton.addEventListener("click", () => { void focusGraphNodeEvidence(key); });
      actions.append(arrangeButton);
    }
    const primaryAnchorId = node.primarySourceId;
    if (primaryAnchorId && state.anchors.has(primaryAnchorId)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Go to paper source";
      button.addEventListener("click", async () => {
        state.focusAnchorId = primaryAnchorId;
        recordActivity("graph_source_focused", { actor: "human", status: key });
        await ensureAnchorVisible(primaryAnchorId, { moveKeyboardFocus: true, scrollIntoView: true });
      });
      actions.append(button);
    }
    if (actions.childElementCount) item.append(actions);
  }
  for (const edge of outline.edges) appendTextListItem(elements.graphOutline, edge.text);
  updateGraphSelectionPresentation();
}

function renderAnnotations() {
  for (const target of document.querySelectorAll(".is-reader[data-anchor-id]")) {
    const anchorId = target.dataset.anchorId;
    if (state.anchors.has(anchorId)) continue;
    paperViewer?.removeAnchorOverlay?.(anchorId);
    if (target.isConnected) target.remove();
  }
  elements.annotationList.replaceChildren();
  elements.paperAnnotationSummary.replaceChildren();
  for (const target of new Set([
    ...document.querySelectorAll("[data-anchor-id]"),
    elements.textSource,
    elements.visualRegionA,
    elements.visualRegionB,
  ].filter(Boolean))) {
    target.classList.remove("has-annotations");
    for (const marker of target.querySelectorAll(":scope > .runtime-annotation-pin")) marker.remove();
  }
  for (const marker of elements.paperStage.querySelectorAll(":scope > .runtime-annotation-pin")) marker.remove();
  const activeAnnotationCount = [...state.annotations.values()].filter((annotation) => annotation.status === "active").length;
  elements.annotationCount.textContent = String(activeAnnotationCount);
  elements.annotationCount.setAttribute(
    "aria-label",
    `${activeAnnotationCount} active ${activeAnnotationCount === 1 ? "annotation" : "annotations"}`,
  );
  if (state.annotations.size === 0) {
    annotationOrder = Object.freeze([]);
    appendTextListItem(elements.annotationList, "No annotations in this page session.");
    return;
  }
  annotationOrder = reconcileAnnotationOrder(annotationOrder, [...state.annotations.keys()]);
  for (const [orderIndex, key] of annotationOrder.entries()) {
    const annotation = state.annotations.get(key);
    if (!annotation) continue;
    const nodeKey = linkedGraphNode(annotation);
    const issuedAnchorId = annotationAnchorId(annotation) || "unknown anchor";
    const issuedAnchor = state.anchors.get(issuedAnchorId);
    const annotationView = projectAccessibleAnnotationSummary({
      annotationId: key,
      annotation,
      anchor: issuedAnchor,
      linkedNodeKey: nodeKey,
      criticalIdeaRank: nodeKey ? criticalIdeaByNodeKey.get(nodeKey)?.rank : null,
    });
    const anchor = annotationView.anchorId;
    const body = annotationView.body;
    const isFixture = annotationView.isFixture;
    const isAutomatic = annotationView.isAutomatic;
    const item = document.createElement("li");
    item.className = `annotation-item${annotation.authority === "agent" ? " is-agent" : annotation.authority === "reader" ? " is-reader" : isAutomatic ? " is-automatic" : ""}`;
    item.dataset.annotationId = key;
    if (nodeKey) item.dataset.graphNodeKey = nodeKey;
    item.draggable = false;
    item.title = nodeKey
      ? "Drag to reorder, or drop on the graph to place the linked node."
      : "Drag to reorder this annotation card.";
    const head = document.createElement("div");
    head.className = "annotation-card-head";
    const dragHandle = document.createElement("span");
    dragHandle.className = "annotation-drag-handle";
    dragHandle.draggable = true;
    dragHandle.title = item.title;
    dragHandle.textContent = "⠿";
    dragHandle.setAttribute("aria-hidden", "true");
    const summary = document.createElement("span");
    summary.className = "annotation-card-summary";
    summary.textContent = annotationView.summaryText;
    head.append(dragHandle, summary);
    item.append(head);
    if (annotationView.sourceSummary) {
      const sourceSummary = document.createElement("small");
      sourceSummary.className = "annotation-source-summary";
      sourceSummary.textContent = annotationView.sourceSummary;
      item.append(sourceSummary);
    }

    const actions = document.createElement("div");
    actions.className = "annotation-actions";
    if (state.anchors.has(anchor)) {
      const focusButton = document.createElement("button");
      focusButton.type = "button";
      focusButton.textContent = "Go to source";
      focusButton.addEventListener("click", async () => {
        if (nodeKey) selectGraphNode(nodeKey, { announce: false });
        state.focusAnchorId = anchor;
        recordActivity("annotation_source_focused", { actor: "human", status: key });
        await ensureAnchorVisible(anchor, { moveKeyboardFocus: true, scrollIntoView: true });
      });
      actions.append(focusButton);
    }
    if (nodeKey) {
      const arrangeButton = document.createElement("button");
      arrangeButton.type = "button";
      arrangeButton.dataset.graphNodeKey = nodeKey;
      arrangeButton.textContent = "Arrange linked node";
      arrangeButton.setAttribute("aria-pressed", String(nodeKey === selectedGraphNodeKey));
      arrangeButton.addEventListener("click", () => selectGraphNode(nodeKey));
      actions.append(arrangeButton);
    }
    const earlierButton = document.createElement("button");
    earlierButton.type = "button";
    earlierButton.dataset.reorderDirection = "earlier";
    earlierButton.textContent = "Move earlier";
    earlierButton.disabled = orderIndex === 0;
    earlierButton.addEventListener("click", () => {
      const targetId = annotationOrder[orderIndex - 1];
      if (targetId) reorderAnnotation(key, targetId, "before", { direction: "earlier" });
    });
    const laterButton = document.createElement("button");
    laterButton.type = "button";
    laterButton.dataset.reorderDirection = "later";
    laterButton.textContent = "Move later";
    laterButton.disabled = orderIndex === annotationOrder.length - 1;
    laterButton.addEventListener("click", () => {
      const targetId = annotationOrder[orderIndex + 1];
      if (targetId) reorderAnnotation(key, targetId, "after", { direction: "later" });
    });
    actions.append(earlierButton, laterButton);
    item.append(actions);

    item.addEventListener("dragstart", (event) => {
      draggedAnnotationId = key;
      draggedAnnotationNodeKey = nodeKey;
      event.dataTransfer?.setData("text/plain", key);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      item.classList.add("is-dragging");
      if (nodeKey) selectGraphNode(nodeKey, { announce: false });
      elements.annotationLayoutStatus.textContent = nodeKey
        ? `Moving “${body}.” Drop on another card to reorder it, or on the graph to place “${graphNodeLabel(nodeKey)}.”`
        : `Moving “${body}.” Drop on another card to reorder it.`;
    });
    item.addEventListener("dragover", (event) => {
      if (!draggedAnnotationId || draggedAnnotationId === key) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      clearAnnotationDropIndicators();
      const rect = item.getBoundingClientRect();
      item.classList.add(event.clientY < rect.top + rect.height / 2 ? "is-drop-before" : "is-drop-after");
    });
    item.addEventListener("drop", (event) => {
      if (!draggedAnnotationId || draggedAnnotationId === key) return;
      event.preventDefault();
      const rect = item.getBoundingClientRect();
      const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      const movedId = draggedAnnotationId;
      reorderAnnotation(movedId, key, placement);
      finishAnnotationDrag();
    });
    item.addEventListener("dragend", finishAnnotationDrag);
    elements.annotationList.append(item);

    if (annotation.status !== "active" || !state.anchors.has(anchor)) continue;
    const target = cursorTargetForAnchor(anchor);
    if (!target || target === elements.paperStage) continue;
    target.classList.add("has-annotations");
    const chip = document.createElement("span");
    chip.className = `annotation-chip runtime-annotation-pin ${isFixture ? "is-fixture" : annotation.authority === "agent" ? "is-agent" : annotation.authority === "reader" ? "is-reader" : ""}`.trim();
    chip.textContent = annotationView.chipText;
    chip.title = annotationView.chipLabel;
    chip.setAttribute("aria-label", annotationView.chipLabel);
    chip.setAttribute("role", "listitem");
    if (target === elements.textSource) elements.paperAnnotationSummary.append(chip);
    else target.append(chip);
  }
  updateGraphSelectionPresentation();
}

function disposeSigma() {
  draggedGraphNodeKey = null;
  graphDragStartPosition = null;
  elements.graphCanvasShell.classList.remove("is-node-dragging", "is-node-hovered");
  if (!sigmaRenderer) return;
  try {
    sigmaRenderer.kill();
  } catch (error) {
    recordActivity("sigma_disposal_warning", { status: error?.name || "error" });
  }
  sigmaRenderer = null;
  sigmaGraph = null;
}

function finishGraphNodeDrag(renderer = sigmaRenderer) {
  if (!draggedGraphNodeKey) return;
  const nodeKey = draggedGraphNodeKey;
  const start = graphDragStartPosition;
  draggedGraphNodeKey = null;
  graphDragStartPosition = null;
  renderer?.getCamera().enable();
  renderer?.setCustomBBox(null);
  elements.graphCanvasShell.classList.remove("is-node-dragging");
  const current = state.graph.hasNode(nodeKey)
    ? clampGraphPosition(state.graph.getNodeAttributes(nodeKey))
    : null;
  const moved = current && start && (current.x !== start.x || current.y !== start.y);
  if (moved) {
    elements.graphLayoutStatus.textContent = `Placed “${graphNodeLabel(nodeKey)}.” Only its view position changed; provenance and WebMCP facts are unchanged.`;
    recordActivity("graph_layout_changed", { actor: "human", status: `${nodeKey} · presentation only` });
    markSnapshotDirty();
  }
  renderer?.refresh();
}

function bindSigmaInteractions(renderer) {
  renderer.on("clickNode", ({ node }) => { void focusGraphNodeEvidence(node); });
  renderer.on("enterNode", () => elements.graphCanvasShell.classList.add("is-node-hovered"));
  renderer.on("leaveNode", () => elements.graphCanvasShell.classList.remove("is-node-hovered"));
  renderer.on("downNode", ({ node, event, preventSigmaDefault }) => {
    if (!selectGraphNode(node, { announce: false })) return;
    preventSigmaDefault();
    event.original?.preventDefault?.();
    draggedGraphNodeKey = node;
    graphDragStartPosition = clampGraphPosition(state.graph.getNodeAttributes(node));
    const bbox = renderer.getBBox();
    renderer.setCustomBBox({ x: [...bbox.x], y: [...bbox.y] });
    renderer.getCamera().disable();
    elements.graphCanvasShell.classList.add("is-node-dragging");
    elements.graphLayoutStatus.textContent = `Moving “${graphNodeLabel(node)}.” Its evidence anchor remains fixed in the paper.`;
  });
  renderer.on("moveBody", ({ event, preventSigmaDefault }) => {
    if (!draggedGraphNodeKey || renderer !== sigmaRenderer) return;
    preventSigmaDefault();
    event.original?.preventDefault?.();
    const position = renderer.viewportToGraph({ x: event.x, y: event.y });
    setGraphNodePosition(draggedGraphNodeKey, position, { announce: false, record: false });
  });
  renderer.on("upNode", () => finishGraphNodeDrag(renderer));
  renderer.on("upStage", () => finishGraphNodeDrag(renderer));
}

function renderSigma() {
  if (sigmaGraph !== state.graph) disposeSigma();
  if (sigmaRenderer) {
    try {
      sigmaRenderer.refresh();
      elements.rendererStatus.textContent = "Sigma active + outline";
      return;
    } catch (error) {
      disposeSigma();
      recordActivity("sigma_refresh_failed", { status: error?.name || "error" });
    }
  }

  const SigmaConstructor = globalThis.Sigma?.default || globalThis.Sigma;
  if (typeof SigmaConstructor !== "function") {
    elements.rendererStatus.textContent = "Outline fallback · Sigma missing";
    return;
  }

  try {
    sigmaRenderer = new SigmaConstructor(state.graph, elements.sigmaContainer, {
      allowInvalidContainer: false,
      renderEdgeLabels: false,
      defaultNodeColor: "#6456d6",
      defaultEdgeColor: "#8794a8",
      labelFont: "Inter, ui-sans-serif, system-ui, sans-serif",
      labelRenderedSizeThreshold: 7,
      stagePadding: 28,
      nodeReducer(node, data) {
        if (!state.graph.hasNode(node) || state.graph.getNodeAttribute(node, "status") !== "active") {
          return { ...data, hidden: true };
        }
        if (node !== selectedGraphNodeKey) return data;
        return {
          ...data,
          color: "#f06449",
          highlighted: true,
          size: Math.max(Number(data.size) || 8, 10),
          zIndex: 2,
        };
      },
      edgeReducer(edge, data) {
        if (!state.graph.hasEdge(edge)) return { ...data, hidden: true };
        const source = state.graph.source(edge);
        const target = state.graph.target(edge);
        const hidden = state.graph.getEdgeAttribute(edge, "status") !== "active"
          || state.graph.getNodeAttribute(source, "status") !== "active"
          || state.graph.getNodeAttribute(target, "status") !== "active";
        return hidden ? { ...data, hidden: true } : data;
      },
    });
    sigmaGraph = state.graph;
    bindSigmaInteractions(sigmaRenderer);
    elements.rendererStatus.textContent = "Sigma active + outline";
    recordActivity("sigma_renderer_ready", { status: SPIKE_VERSIONS.sigma });
  } catch (error) {
    disposeSigma();
    elements.rendererStatus.textContent = "Accessible outline fallback";
    recordActivity("sigma_renderer_fallback", { status: error?.name || "error" });
  }
}

function renderState() {
  reconcileGraphPresentation();
  elements.workspaceStatus.textContent = `Revision ${state.workspaceRevision} · ${state.workspaceDigest.slice(0, 10)}…`;
  elements.visualMode.textContent = `Evidence mode: ${state.visualEvidenceMode}`;
  elements.humanUndo.disabled = state.history.length === 0;
  elements.humanRedo.disabled = state.redoHistory.length === 0;
  renderFocus();
  renderCriticalIdeaMap();
  renderGraphOutline();
  renderAnnotations();
  renderMentorExplanation();
  renderBrowserSaveState();
  if (elements.graphSearchQuery.value.trim()) renderGraphSearch();
  renderSigma();
}

function instrumentTools(rawTools) {
  return instrumentWebmcpTools(rawTools, {
    async beforeExecute({ tool, input }) {
      recordActivity("webmcp_request_reached_page", { actor: "WebMCP caller", toolName: tool.name });
      await ensureAnchorVisible(resolveObservedAnchor(state, tool.name, input, {}), {
        moveKeyboardFocus: false,
        scrollIntoView: false,
      });
      showToolRequest(tool.name, input);
    },
    onResult({ tool, input, result }) {
      recordActivity("page_callback_returned", {
        actor: "PaperPilot page",
        toolName: tool.name,
        status: result?.status || "returned",
      });
      renderLastResult(result);
      if (tool.name === "paperpilot.read_focus" && result?.focus?.sourceKind === "visual_region") {
        visualTrialObserved = true;
        elements.revealVisualKey.disabled = false;
        elements.visualKey.textContent = "A visual-region callback completed. This proves a locator was returned, not that pixels were used. Record the client's independent answer, then reveal the key.";
        recordActivity("visual_region_callback_returned", { actor: "WebMCP caller", toolName: tool.name });
      }
      if (
        (tool.name === "paperpilot.apply_graph" || tool.name === "paperpilot.apply_annotation")
        && result?.status === "applied_reversible"
      ) {
        markSnapshotDirty();
      }
      if (tool.name === "paperpilot.focus_source" && result?.status === "focused") markSnapshotDirty();
      if (tool.name === "paperpilot.stage_explain" && result?.status === "staged") {
        elements.mentorExplanationStatus.textContent = "Explanation ready for your review. Save or discard it; the browser agent cannot make that decision.";
        elements.agentAnnouncement.textContent = "A source-grounded mentor explanation is ready for human review.";
      }
      renderState();
      showToolResult(tool.name, input, result);
    },
    onError({ tool, input, error }) {
      recordActivity("page_callback_threw", {
        actor: "PaperPilot page",
        toolName: tool.name,
        status: error?.name || "error",
      });
      renderLastResult({ status: "threw", name: error?.name, message: error?.message });
      placeAgentCursor(
        resolveObservedAnchor(state, tool.name, input, {}),
        "error",
        "Page callback failed",
        `PaperPilot callback ${tool.name} failed with ${error?.name || "an error"}.`,
      );
    },
  });
}

async function registerSuite({ automatic = false } = {}) {
  if (suiteHandle || registrationClosed) return;
  const modelContext = document.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    elements.webmcpStatus.textContent = "Local review — WebMCP was not invoked";
    elements.agentActionStatus.textContent = "Local review only · no WebMCP callback observed";
    elements.registerTools.disabled = false;
    elements.disposeTools.disabled = true;
    recordActivity("webmcp_unavailable", { actor: automatic ? "page" : "human" });
    return;
  }

  elements.webmcpStatus.textContent = "Registering six tools…";
  elements.registerTools.disabled = true;
  elements.disposeTools.disabled = true;
  recordActivity("tool_suite_registration_started", { actor: automatic ? "page" : "human" });

  const observedContext = {
    async registerTool(tool, options) {
      const result = await modelContext.registerTool(tool, options);
      recordActivity("tool_registered", { actor: "page", toolName: tool.name, status: "registered" });
      return result;
    },
  };

  try {
    suiteHandle = await mountToolSuite(observedContext, tools, {
      onDispose({ reason, registrations }) {
        recordActivity("tool_suite_disposed", {
          actor: reason === "manual" ? "human" : "page",
          status: `${reason} · ${registrations.length} registrations`,
        });
      },
    });
    elements.webmcpStatus.textContent = `Registered ${suiteHandle.registrations.length} / ${TOOL_NAMES.length}`;
    elements.disposeTools.disabled = false;
    recordActivity("tool_suite_registered", { actor: "page", status: "ready" });
  } catch (error) {
    registrationClosed = true;
    elements.webmcpStatus.textContent = "Registration failed · reload required";
    elements.registerTools.disabled = true;
    elements.disposeTools.disabled = true;
    recordActivity("tool_suite_registration_failed", {
      actor: "page",
      status: error?.name || "error",
    });
    renderLastResult({ status: "registration_failed", name: error?.name, message: error?.message });
  }
}

function disposeSuite(reason = "manual") {
  if (!suiteHandle) return;
  suiteHandle.dispose(reason);
  suiteHandle = null;
  registrationClosed = true;
  elements.webmcpStatus.textContent = "Disposed · reload before re-registering";
  elements.registerTools.disabled = true;
  elements.disposeTools.disabled = true;
}

function randomIndex(maximum) {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % maximum;
}

function randomHex(byteCount = 16) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function paintBackdrop(context, width, height) {
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#dbe3ed";
  context.lineWidth = 1;
  for (let x = 18; x < width; x += 36) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 18; y < height; y += 36) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

const visualPatterns = [
  {
    key: "coral-chevron-ladder",
    descriptor: "coral chevrons climbing from lower left to upper right",
    draw(context, width, height) {
      context.strokeStyle = "#e85d4a";
      context.lineWidth = 12;
      context.lineJoin = "round";
      for (let x = 45; x < width - 20; x += 70) {
        context.beginPath();
        context.moveTo(x, height - 45);
        context.lineTo(x + 28, height / 2);
        context.lineTo(x + 56, 45);
        context.stroke();
      }
    },
  },
  {
    key: "violet-concentric-orbits",
    descriptor: "violet concentric circles around a small mint center",
    draw(context, width, height) {
      context.strokeStyle = "#6456d6";
      context.lineWidth = 9;
      for (const radius of [28, 55, 82]) {
        context.beginPath();
        context.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
        context.stroke();
      }
      context.fillStyle = "#3cbfa0";
      context.beginPath();
      context.arc(width / 2, height / 2, 11, 0, Math.PI * 2);
      context.fill();
    },
  },
  {
    key: "mint-three-towers",
    descriptor: "three mint towers increasing in height from left to right",
    draw(context, width, height) {
      context.fillStyle = "#3cbfa0";
      const base = height - 30;
      [70, 125, 180].forEach((towerHeight, index) => {
        context.fillRect(52 + index * 105, base - towerHeight, 62, towerHeight);
      });
    },
  },
  {
    key: "navy-crossed-waves",
    descriptor: "two navy waves crossing at the center with coral endpoints",
    draw(context, width, height) {
      context.strokeStyle = "#14213d";
      context.lineWidth = 11;
      for (const phase of [0, Math.PI]) {
        context.beginPath();
        for (let x = 20; x <= width - 20; x += 4) {
          const y = height / 2 + Math.sin((x / width) * Math.PI * 2 + phase) * 58;
          if (x === 20) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      context.fillStyle = "#e85d4a";
      for (const x of [20, width - 20]) {
        context.beginPath();
        context.arc(x, height / 2, 10, 0, Math.PI * 2);
        context.fill();
      }
    },
  },
];

function drawVisualPattern(canvas, pattern) {
  const context = canvas.getContext("2d", { alpha: false });
  paintBackdrop(context, canvas.width, canvas.height);
  pattern.draw(context, canvas.width, canvas.height);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function setupVisualTrial() {
  const indexA = randomIndex(visualPatterns.length);
  let indexB = randomIndex(visualPatterns.length - 1);
  if (indexB >= indexA) indexB += 1;
  const patternA = visualPatterns[indexA];
  const patternB = visualPatterns[indexB];
  const nonce = randomHex();
  const sealedPayload = JSON.stringify({ nonce, a: patternA.key, b: patternB.key });
  const commitment = await sha256(sealedPayload);

  drawVisualPattern(elements.canvasA, patternA);
  drawVisualPattern(elements.canvasB, patternB);
  elements.visualCommitment.textContent = `sha256:${commitment}`;

  elements.revealVisualKey.addEventListener("click", () => {
    if (!visualTrialObserved || visualKeyRevealed) return;
    visualKeyRevealed = true;
    elements.visualKey.textContent = `A: ${patternA.descriptor}. B: ${patternB.descriptor}. Nonce: ${nonce}.`;
    elements.revealVisualKey.disabled = true;
    elements.confirmVisualProof.disabled = false;
    recordActivity("visual_key_revealed", { actor: "human", status: `commitment ${commitment.slice(0, 12)}…` });
  });
}

function normalizeGraphSearchText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function selectedReaderCapture(rawCapture) {
  if (!rawCapture || typeof rawCapture !== "object") throw new Error("Select text inside one rendered PDF page first.");
  const normalizedBounds = rawCapture.normalizedBounds || rawCapture.normalizedRects || rawCapture.rects;
  const pageIndex = Number.isInteger(rawCapture.pageIndex)
    ? rawCapture.pageIndex
    : Number.isInteger(rawCapture.pageNumber)
      ? rawCapture.pageNumber - 1
      : null;
  const pageViewBox = rawCapture.pageViewBox || rawCapture.viewport?.viewBox || (
    rawCapture.viewport?.width && rawCapture.viewport?.height && rawCapture.viewport?.scale
      ? [0, 0, rawCapture.viewport.width / rawCapture.viewport.scale, rawCapture.viewport.height / rawCapture.viewport.scale]
      : null
  );
  const pageRotation = rawCapture.pageRotation ?? rawCapture.viewport?.rotation ?? 0;
  const exactText = rawCapture.exactText || rawCapture.text;
  if (!Number.isInteger(pageIndex) || !Array.isArray(normalizedBounds) || !Array.isArray(pageViewBox) || !exactText) {
    throw new Error("The PDF selection did not resolve to trusted page text and geometry.");
  }
  return {
    pageIndex,
    sourceKind: "exact_text",
    normalizedBounds: normalizedBounds.map(({ x, y, width, height }) => ({ x, y, width, height })),
    pageViewBox: [...pageViewBox],
    pageRotation,
    exactText: String(exactText),
    ...(rawCapture.prefix ? { prefix: String(rawCapture.prefix) } : {}),
    ...(rawCapture.suffix ? { suffix: String(rawCapture.suffix) } : {}),
  };
}

function syncPersistedAnnotationOverlays() {
  if (!paperViewer?.upsertAnchorOverlay || !state?.annotations) return;
  for (const [annotationId, annotation] of state.annotations) {
    if (annotation.status !== "active") continue;
    const anchorId = annotationAnchorId(annotation);
    const anchor = state.anchors.get(anchorId);
    if (!anchor || !Array.isArray(anchor.normalizedBounds) || anchor.normalizedBounds.length === 0) continue;
    const isAutomatic = annotationId.startsWith("annotation:auto:");
    const className = annotation.authority === "reader"
      ? "is-reader"
      : annotation.authority === "agent"
        ? "is-agent"
        : isAutomatic
          ? "pdf-automatic-map-anchor"
          : "is-system";
    paperViewer.upsertAnchorOverlay({
      anchorId,
      pageIndex: anchor.pageIndex,
      normalizedBounds: anchor.normalizedBounds,
      className,
      ariaLabel: `${annotation.body || annotation.label || "PaperPilot annotation"}, ${humanReadable(annotation.authority || "system")} source on page ${anchor.pageLabel}`,
    });
  }
}

async function captureReaderSelection({ announceFailure = false } = {}) {
  if (typeof paperViewer?.captureSelection !== "function") {
    if (announceFailure) elements.readerSelectionStatus.textContent = "Selection capture is unavailable in this viewer build.";
    return null;
  }
  try {
    const rawCapture = await paperViewer.captureSelection();
    const capture = selectedReaderCapture(rawCapture);
    if (pendingReaderOverlayId && pendingReaderOverlayId !== rawCapture.anchorId && !state.anchors.has(pendingReaderOverlayId)) {
      paperViewer.removeAnchorOverlay?.(pendingReaderOverlayId);
    }
    pendingReaderOverlayId = rawCapture.anchorId || null;
    pendingReaderCapture = capture;
    const excerpt = capture.exactText.length > 150 ? `${capture.exactText.slice(0, 147)}…` : capture.exactText;
    elements.readerSelectionStatus.textContent = `Page ${capture.pageIndex + 1} selected · “${excerpt}”`;
    if (!elements.readerAnnotationLabel.value.trim()) {
      const suggested = capture.exactText.replace(/\s+/gu, " ").trim().slice(0, 72);
      elements.readerAnnotationLabel.value = suggested;
    }
    return capture;
  } catch (error) {
    if (announceFailure) elements.readerSelectionStatus.textContent = error?.message || "Select text inside one PDF page first.";
    return null;
  }
}

function renderGraphSearch(query = elements.graphSearchQuery.value) {
  elements.graphSearchResults.replaceChildren();
  const normalizedQuery = normalizeGraphSearchText(query);
  if (!normalizedQuery) {
    elements.graphSearchStatus.textContent = "Showing the whole map.";
    return;
  }
  const matches = state.graph.nodes()
    .map((key) => ({ key, attributes: state.graph.getNodeAttributes(key) }))
    .filter(({ attributes }) => attributes.status === "active")
    .map(({ key, attributes }) => {
      const label = normalizeGraphSearchText(attributes.label);
      const summary = normalizeGraphSearchText(attributes.summary);
      const rank = label === normalizedQuery ? 0 : label.startsWith(normalizedQuery) ? 1 : label.includes(normalizedQuery) ? 2 : summary.includes(normalizedQuery) ? 3 : -1;
      return { key, attributes, rank };
    })
    .filter(({ rank }) => rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key))
    .slice(0, 20);

  elements.graphSearchStatus.textContent = matches.length
    ? `${matches.length} matching ${matches.length === 1 ? "node" : "nodes"}. WebMCP can run the same search with read_graph mode search.`
    : "No label or summary matches in the current paper graph.";
  for (const { key, attributes } of matches) {
    const item = document.createElement("li");
    const summary = document.createElement("span");
    summary.textContent = `${attributes.label || key} · ${humanReadable(attributes.kind)} · ${humanReadable(attributes.authority)}`;
    item.append(summary);
    const actions = document.createElement("div");
    actions.className = "graph-outline-actions";
    const arrangeButton = document.createElement("button");
    arrangeButton.type = "button";
    arrangeButton.dataset.graphNodeKey = key;
    arrangeButton.textContent = "Arrange this node";
    arrangeButton.setAttribute("aria-pressed", String(key === selectedGraphNodeKey));
    arrangeButton.addEventListener("click", () => { void focusGraphNodeEvidence(key); });
    actions.append(arrangeButton);
    const anchorId = attributes.sourceAnchorIds?.[0] || attributes.structuralCoverage?.[0]?.primaryAnchorId;
    if (anchorId && state.anchors.has(anchorId)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Go to source";
      button.addEventListener("click", async () => {
        state.focusAnchorId = anchorId;
        recordActivity("graph_search_source_focused", { actor: "human", status: key });
        await ensureAnchorVisible(anchorId, { moveKeyboardFocus: true, scrollIntoView: true });
      });
      actions.append(button);
    }
    item.append(actions);
    elements.graphSearchResults.append(item);
  }
  updateGraphSelectionPresentation();
}

function nudgeSelectedGraphNode(direction) {
  const nodeKey = selectedGraphNodeKey;
  if (!nodeKey || !state.graph.hasNode(nodeKey)) {
    selectedGraphNodeKey = null;
    updateGraphSelectionPresentation();
    elements.graphLayoutStatus.textContent = "Choose a current graph node before moving it.";
    return;
  }
  const current = clampGraphPosition(state.graph.getNodeAttributes(nodeKey));
  const viewportDelta = {
    left: { x: -24, y: 0 },
    up: { x: 0, y: -24 },
    down: { x: 0, y: 24 },
    right: { x: 24, y: 0 },
  }[direction];
  let next = nudgeGraphPosition(current, direction);
  if (sigmaRenderer && viewportDelta) {
    const viewport = sigmaRenderer.graphToViewport(current);
    next = clampGraphPosition(sigmaRenderer.viewportToGraph({
      x: viewport.x + viewportDelta.x,
      y: viewport.y + viewportDelta.y,
    }));
  }
  if (setGraphNodePosition(nodeKey, next)) {
    elements.graphLayoutStatus.textContent = `Moved “${graphNodeLabel(nodeKey)}” ${direction}. Only the view changed; provenance and WebMCP facts are unchanged.`;
  }
}

function currentDraggedAnnotationNode() {
  if (!draggedAnnotationId || !draggedAnnotationNodeKey) return null;
  const annotation = state.annotations.get(draggedAnnotationId);
  const currentNodeKey = linkedGraphNode(annotation);
  return currentNodeKey === draggedAnnotationNodeKey ? currentNodeKey : null;
}

function recordHumanEvidenceEvent(eventType, details = {}) {
  const record = {
    eventId: state.id("event"),
    observedAt: state.now(),
    paperRef: state.paper.paperRef,
    eventType,
    actor: "human",
    ...details,
  };
  state.events.push(record);
  state.onEvent(record);
  return record;
}

function wireHumanControls() {
  for (const button of document.querySelectorAll("[data-focus-anchor]")) {
    button.addEventListener("click", async () => {
      const anchorId = button.dataset.focusAnchor;
      if (!state.anchors.has(anchorId)) return;
      state.focusAnchorId = anchorId;
      recordActivity("source_focused", { actor: "human", status: anchorId });
      await ensureAnchorVisible(anchorId, { moveKeyboardFocus: true, scrollIntoView: true });
    });
  }

  elements.registerTools.addEventListener("click", () => registerSuite({ automatic: false }));
  elements.disposeTools.addEventListener("click", () => disposeSuite("manual"));
  elements.replayAgentAction.addEventListener("click", () => enqueueObservedTraceReplay(lastObservedTrace));

  elements.saveWorkspace.addEventListener("click", async () => {
    elements.saveWorkspace.disabled = true;
    snapshotStatusKind = "dirty";
    snapshotStatusMessage = "Saving this paper’s in-app workspace…";
    renderBrowserSaveState();
    try {
      await persistBrowserWorkspace({ enable: true, reason: "explicit reader save" });
    } finally {
      elements.saveWorkspace.disabled = false;
    }
  });

  elements.clearSavedWorkspace.addEventListener("click", () => {
    if (!clearSavedCopyArmed) {
      clearSavedCopyArmed = true;
      elements.clearSavedWorkspace.textContent = "Confirm clear";
      snapshotStatusMessage = "Clear only the browser-saved copy? The active paper, annotations, graph, and PDF will stay open.";
      renderBrowserSaveState();
      setTimeout(() => {
        if (!clearSavedCopyArmed) return;
        clearSavedCopyArmed = false;
        elements.clearSavedWorkspace.textContent = "Clear saved copy";
        renderBrowserSaveState();
      }, 6_000);
      return;
    }
    clearSavedCopyArmed = false;
    elements.clearSavedWorkspace.textContent = "Clear saved copy";
    const storage = browserStorageAdapter();
    const result = storage
      ? clearBrowserSnapshot({ storage, documentSha256: state.paper.documentSha256 })
      : { status: "storage_error", reason: "storage_unavailable" };
    if (result.status === "cleared" || result.status === "not_found") {
      snapshotEnabled = false;
      snapshotStored = false;
      snapshotDirty = true;
      snapshotStatusKind = "idle";
      snapshotStatusMessage = "Saved copy cleared · this active tab and the original PDF are unchanged";
      recordHumanEvidenceEvent("browser_workspace_cleared", { status: result.status });
    } else {
      snapshotStatusKind = "error";
      snapshotStatusMessage = "The saved copy could not be cleared because browser storage is unavailable.";
    }
    renderBrowserSaveState();
  });

  elements.saveExplanation.addEventListener("click", async () => {
    const decision = applyHumanMentorDecision({
      actor: "human",
      decision: "save",
      stagedExplanations: state.explanations,
      savedExplanations,
      takeaway: elements.mentorTakeaway.value,
      savedAt: state.now(),
    });
    if (!decision.changed) return;
    state.explanations = decision.stagedExplanations;
    savedExplanations = decision.savedExplanations;
    state.savedExplanations = structuredClone(savedExplanations);
    recordHumanEvidenceEvent(decision.event.eventType, {
      explanationId: decision.event.explanationId,
      responseDigest: decision.event.responseDigest,
    });
    snapshotDirty = true;
    renderMentorExplanation();
    const result = await persistBrowserWorkspace({ enable: true, reason: "mentor note saved" });
    elements.mentorExplanationStatus.textContent = result.status === "saved"
      ? "Mentor note saved in this browser. Its source text and AI response remain distinct from your takeaway."
      : "Mentor note is kept in this tab, but browser recovery failed. Keep this tab open.";
  });

  elements.discardExplanation.addEventListener("click", () => {
    const decision = applyHumanMentorDecision({
      actor: "human",
      decision: "discard",
      stagedExplanations: state.explanations,
      savedExplanations,
    });
    if (!decision.changed) return;
    state.explanations = decision.stagedExplanations;
    savedExplanations = decision.savedExplanations;
    recordHumanEvidenceEvent(decision.event.eventType, {
      explanationId: decision.event.explanationId,
      responseDigest: decision.event.responseDigest,
    });
    renderMentorExplanation();
    elements.mentorExplanationStatus.textContent = "Mentor draft discarded. The paper, graph, and annotations were not changed.";
    if (snapshotEnabled) markSnapshotDirty();
  });

  const recaptureSelection = () => {
    queueMicrotask(() => captureReaderSelection({ announceFailure: false }));
  };
  elements.pdfViewer.addEventListener("pointerup", recaptureSelection);
  elements.pdfViewer.addEventListener("keyup", recaptureSelection);

  elements.readerAnnotationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const capture = pendingReaderCapture || await captureReaderSelection({ announceFailure: true });
    if (!capture) return;
    const label = elements.readerAnnotationLabel.value.trim();
    const nodeKind = elements.readerNodeKind.value;
    if (!label) {
      elements.readerSelectionStatus.textContent = "Name the idea before adding it to the graph.";
      elements.readerAnnotationLabel.focus();
      return;
    }
    const submitButton = elements.readerAnnotationForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      const anchor = await mintReaderAnchor(state, capture);
      const exactTextSummary = capture.exactText.replace(/\s+/gu, " ").trim();
      const result = await applyReaderAnnotation(state, {
        baseWorkspaceRevision: state.workspaceRevision,
        baseWorkspaceDigest: state.workspaceDigest,
        anchor,
        annotation: { kind: "highlight", body: label },
        node: {
          kind: nodeKind,
          label,
          summary: `Reader-authored idea grounded in page ${capture.pageIndex + 1}: “${exactTextSummary.slice(0, 700)}${exactTextSummary.length > 700 ? "…" : ""}”`,
          salience: 0.8,
        },
      });
      if (pendingReaderOverlayId && pendingReaderOverlayId !== result.anchorId) {
        paperViewer?.removeAnchorOverlay?.(pendingReaderOverlayId);
      }
      paperViewer?.upsertAnchorOverlay?.({
        anchorId: result.anchorId,
        pageIndex: anchor.pageIndex,
        normalizedBounds: anchor.normalizedBounds,
        className: "is-reader",
        ariaLabel: `${label}, reader highlight on page ${anchor.pageLabel}`,
      });
      state.focusAnchorId = result.anchorId;
      pendingReaderCapture = null;
      pendingReaderOverlayId = null;
      globalThis.getSelection?.()?.removeAllRanges?.();
      elements.readerAnnotationLabel.value = "";
      elements.readerSelectionStatus.textContent = `Added “${label}” to the graph from page ${anchor.pageLabel}. Human Undo is available.`;
      recordActivity("reader_annotation_graph_created", {
        actor: "human",
        status: `${result.nodeKey} · ${result.annotationId}`,
      });
      renderLastResult(result);
      renderState();
      await ensureAnchorVisible(result.anchorId, { moveKeyboardFocus: false, scrollIntoView: false });
      markSnapshotDirty();
    } catch (error) {
      elements.readerSelectionStatus.textContent = error?.message || "The reader annotation could not be added.";
      recordActivity("reader_annotation_graph_failed", { actor: "human", status: error?.code || error?.name || "error" });
      renderLastResult({ status: "reader_annotation_failed", code: error?.code, message: error?.message });
    } finally {
      submitButton.disabled = false;
    }
  });

  elements.graphSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    renderGraphSearch();
  });
  elements.clearGraphSearch.addEventListener("click", () => {
    elements.graphSearchQuery.value = "";
    renderGraphSearch("");
    elements.graphSearchQuery.focus();
  });

  for (const button of elements.graphNudgeButtons) {
    button.addEventListener("click", () => nudgeSelectedGraphNode(button.dataset.graphNudge));
  }
  elements.graphLayoutReset.addEventListener("click", resetGraphLayout);

  elements.graphCanvasShell.addEventListener("dragover", (event) => {
    const nodeKey = currentDraggedAnnotationNode();
    if (!nodeKey || !sigmaRenderer) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    elements.graphDropHint.textContent = `Drop to place “${graphNodeLabel(nodeKey)}”`;
    elements.graphCanvasShell.classList.add("is-drop-target");
  });
  elements.graphCanvasShell.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && elements.graphCanvasShell.contains(event.relatedTarget)) return;
    elements.graphCanvasShell.classList.remove("is-drop-target");
  });
  elements.graphCanvasShell.addEventListener("drop", (event) => {
    const nodeKey = currentDraggedAnnotationNode();
    if (!nodeKey || !sigmaRenderer) return;
    event.preventDefault();
    const bounds = elements.sigmaContainer.getBoundingClientRect();
    const position = sigmaRenderer.viewportToGraph({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    const annotation = state.annotations.get(draggedAnnotationId);
    const body = annotation?.body || annotation?.label || draggedAnnotationId;
    selectGraphNode(nodeKey, { announce: false });
    setGraphNodePosition(nodeKey, position);
    elements.annotationLayoutStatus.textContent = `Placed the linked idea for “${body}” in the map. The PDF annotation itself did not move.`;
    finishAnnotationDrag();
  });

  elements.humanUndo.addEventListener("click", async () => {
    const result = await undoLastHumanChange(state);
    recordActivity("human_undo_control", { actor: "human", status: result.status });
    renderLastResult(result);
    renderState();
    if (result.status === "undone") markSnapshotDirty();
  });

  elements.humanRedo.addEventListener("click", async () => {
    const result = await redoLastHumanChange(state);
    recordActivity("human_redo_control", { actor: "human", status: result.status });
    renderLastResult(result);
    renderState();
    if (result.status === "redone") markSnapshotDirty();
  });

  elements.confirmVisualProof.addEventListener("click", () => {
    if (!visualKeyRevealed || state.visualEvidenceMode === "client_visible_region") return;
    state.visualEvidenceMode = "client_visible_region";
    elements.confirmVisualProof.disabled = true;
    recordActivity("visual_proof_promoted", { actor: "human", status: "client_visible_region" });
    renderState();
  });

  window.addEventListener("beforeunload", () => {
    if (suiteHandle) disposeSuite("page_unload");
    disposeSigma();
    paperViewer?.destroy();
  });
}

async function boot({ pdfFile = null } = {}) {
  renderToolList();
  await renderContractManifest();
  renderActivity();
  elements.registerTools.disabled = true;
  elements.disposeTools.disabled = true;
  elements.humanUndo.disabled = true;
  elements.humanRedo.disabled = true;
  elements.replayAgentAction.disabled = true;

  const MultiDirectedGraph = globalThis.graphology?.MultiDirectedGraph;
  if (typeof MultiDirectedGraph !== "function") {
    elements.webmcpStatus.textContent = "Graphology fixture failed";
    elements.rendererStatus.textContent = "Outline unavailable";
    recordActivity("graphology_missing", { status: SPIKE_VERSIONS.graphology });
    return;
  }

  elements.webmcpStatus.textContent = "Waiting for verified paper";
  let verifiedTextAnchor = null;
  paperViewer = await initializePaperPdfViewer({
    pdfFile,
    title: pdfFile ? paperTitleFromFilename(pdfFile.name) : undefined,
    filename: pdfFile?.name,
    contentType: pdfFile?.type || undefined,
    sourceAnchor: pdfFile ? null : undefined,
    onStatus({ kind, message }) {
      elements.pdfLoading.textContent = message;
      if (kind === "ready") elements.pdfLoading.hidden = true;
    },
    onError(error) {
      elements.pdfLoading.hidden = false;
      elements.pdfLoading.textContent = pdfFile
        ? `${error.message} Choose a valid PDF and try again.`
        : `${error.message} Run npm run spike:webmcp:paper:fetch, then reload.`;
      elements.webmcpStatus.textContent = "Not registered · PDF verification failed";
    },
    onAnchorResolved(anchor) {
      verifiedTextAnchor = anchor;
      elements.pdfSourceStatus.textContent = `Exact page 1 sentence verified from the PDF.js text layer · ${anchor.rects.length} live text rectangles.`;
    },
    onPageChange({ pageNumber, pageCount }) {
      const activeSurface = document.querySelector(`.pdf-page-surface[data-page-number="${pageNumber}"]`) || (pageNumber === 1 ? elements.pdfPageSurface : null);
      for (const surface of document.querySelectorAll(".pdf-page-surface")) {
        surface.classList.toggle("is-active-page", surface === activeSurface);
      }
      activeSurface?.setAttribute("aria-label", `PDF page ${pageNumber} of ${pageCount}`);
      elements.pdfActivePageDescription.textContent = `Page ${pageNumber} is centered`;
    },
  });
  const exactAnchor = paperViewer.exactTextAnchor || verifiedTextAnchor;
  if (!paperViewer.documentFacts?.integrityVerified || (!pdfFile && !exactAnchor)) {
    throw new Error(
      `The exact paper or its page-owned source geometry was not verified (integrity=${String(paperViewer.documentFacts?.integrityVerified)}, anchor=${String(Boolean(exactAnchor))}).`,
    );
  }
  const paperFacts = paperViewer.documentFacts;
  elements.paperHeading.textContent = paperFacts.title;
  elements.pdfViewer.setAttribute("aria-label", `${paperFacts.title} PDF viewer`);
  setPdfIdentity(pdfFile ? `PDF.js · ${paperFacts.filename} · browser local` : "PDF.js · arXiv:1706.03762v7");
  elements.paperBoundary.textContent = pdfFile
    ? `Exact-byte fingerprint ${paperFacts.sha256.slice(0, 12)}… · browser-local analysis · no export`
    : "Official arXiv v7 bytes · real PDF.js text geometry · no PDF export";
  document.title = `${paperFacts.title} — PaperPilot`;
  if (!exactAnchor) {
    elements.pdfSourceStatus.textContent = "Whole-paper text is being indexed. Each critical candidate will receive its own page-owned source anchor.";
  }
  elements.pdfLoading.hidden = true;
  recordActivity(pdfFile ? "browser_local_pdf_fingerprinted" : "exact_pdf_verified", {
    actor: "page",
    status: `${paperFacts.pageCount} pages · sha256 ${paperFacts.sha256.slice(0, 12)}…`,
  });

  let documentText = null;
  let groundedAutomaticMap;
  try {
    elements.paperAnalysisStatus.textContent = `Reading 0 / ${paperFacts.pageCount} pages`;
    setAnalysisProgress(0, paperFacts.pageCount, `0 of ${paperFacts.pageCount} pages read`);
    elements.paperAnalysisSummary.textContent = "Reading the verified PDF text layer without rendering a transcript.";
    recordActivity("paper_text_index_started", { actor: "page", status: `${paperViewer.documentFacts.pageCount} pages` });
    documentText = await paperViewer.extractDocumentText({
      onProgress({ indexedPages, pageCount, pageNumber }) {
        setAnalysisProgress(indexedPages, pageCount, `${indexedPages} of ${pageCount} pages read`);
        elements.paperAnalysisStatus.textContent = `Reading ${indexedPages} / ${pageCount} pages`;
        if (indexedPages === 1 || indexedPages === pageCount || indexedPages % 5 === 0) {
          elements.paperAnalysisSummary.textContent = `Read ${indexedPages} of ${pageCount} verified pages · currently page ${pageNumber}.`;
        }
      },
    });
    recordActivity("paper_text_index_completed", {
      actor: "page",
      status: `${documentText.exactCandidatePages} text pages · ${documentText.visualOnlyPages} visual-only · ${documentText.failedPages} failed`,
    });

    setAnalysisProgress(null, paperFacts.pageCount, "Ranking grounded passages");
    elements.paperAnalysisStatus.textContent = "Ranking grounded passages…";
    elements.paperAnalysisSummary.textContent = "Segmenting sections and ranking extractive candidates. Importance is heuristic, not a truth score.";
    const analysis = analyzePaperPages(documentText.pages, { minCandidates: 5, maxCandidates: 10 });
    groundedAutomaticMap = groundAutomaticMap(documentText, analysis);
    setAnalysisProgress(0, groundedAutomaticMap.contract.candidates.length, `0 of ${groundedAutomaticMap.contract.candidates.length} candidates grounded`);
    elements.paperAnalysisStatus.textContent = `Grounding 0 / ${groundedAutomaticMap.contract.candidates.length} candidates`;
  } catch (error) {
    const pageCount = paperFacts.pageCount;
    const coverage = documentText?.pages?.map(({ pageIndex, pageLabel, textCapability }) => ({
      pageIndex,
      pageLabel,
      textCapability,
    })) || Array.from({ length: pageCount }, (_, pageIndex) => ({
      pageIndex,
      pageLabel: String(pageIndex + 1),
      textCapability: "failed",
    }));
    const claimBoundary = "Automatic critical-idea analysis was unavailable. The verified PDF remains readable; no fallback ideas were fabricated.";
    groundedAutomaticMap = {
      contract: {
        schemaVersion: 1,
        status: "no_text",
        claimBoundary,
        pageCount,
        coverage,
        candidates: [],
      },
      presentation: {
        schemaVersion: 1,
        status: "no_text",
        authority: "system_derived_candidate",
        claimBoundary,
        pageCount,
        candidateCount: 0,
        candidates: [],
        layout: { strategy: "critical_idea_spine_v1", presentationOnly: true, semanticEdgesInferred: false, positions: [], spine: [] },
      },
    };
    setAnalysisProgress(0, pageCount, `0 of ${pageCount} pages produced grounded candidates`);
    elements.paperAnalysisStatus.textContent = "Automatic map unavailable";
    elements.paperAnalysisSummary.textContent = `${claimBoundary} ${error?.message || ""}`.trim();
    recordActivity("automatic_map_failed", { actor: "page", status: error?.name || "analysis_error" });
  }

  paperAnalysis = groundedAutomaticMap.presentation;
  criticalIdeaByNodeKey.clear();
  for (const candidate of paperAnalysis.candidates) criticalIdeaByNodeKey.set(candidate.key, candidate);

  state = await createSpikeState(MultiDirectedGraph, {
    visualEvidenceMode: "locator_only",
    paper: {
      paperRef: paperFacts.paperRef,
      filename: paperFacts.filename,
      title: paperFacts.title,
      documentSha256: paperFacts.sha256,
      pageCount: paperFacts.pageCount,
      pageViewBox: paperFacts.firstPageViewBox,
      pageRotation: paperFacts.firstPageRotation,
    },
    automaticMap: groundedAutomaticMap.contract,
    textAnchor: exactAnchor ? {
      normalizedBounds: exactAnchor.rects.map((rectangle) => ({ ...rectangle })),
      pdfQuads: exactAnchor.pdfQuads.map((quad) => ({ points: [...quad.points] })),
      pageViewBox: [...paperFacts.firstPageViewBox],
      pageRotation: exactAnchor.viewport.rotation,
    } : null,
    onEvent(event) {
      activity.push(event);
      renderActivity();
    },
    async onNavigate(anchor) {
      recordActivity("navigation_callback_observed", { actor: "page", status: anchor.anchorId });
      await ensureAnchorVisible(anchor.anchorId, { moveKeyboardFocus: false, scrollIntoView: true });
    },
    onStateChange() {
      renderState();
    },
  });
  if (state.graph.hasNode("node:paper")) {
    state.graph.mergeNodeAttributes("node:paper", { x: 0, y: -1.6, size: 16 });
  }
  for (const position of paperAnalysis.layout.positions) {
    if (!state.graph.hasNode(position.nodeKey)) continue;
    state.graph.mergeNodeAttributes(position.nodeKey, { x: position.x, y: position.y });
  }
  await restoreBrowserWorkspace();
  let groundedCount = 0;
  for (const seeded of state.automaticMap?.candidates || []) {
    const anchor = state.anchors.get(seeded.anchorId);
    const candidate = criticalIdeaByNodeKey.get(seeded.key);
    if (!anchor || !candidate) continue;
    paperViewer.upsertAnchorOverlay({
      anchorId: anchor.anchorId,
      pageIndex: anchor.pageIndex,
      normalizedRects: anchor.normalizedBounds,
      className: "pdf-automatic-map-anchor",
      ariaLabel: `Automatic critical-idea candidate on page ${anchor.pageLabel}: ${candidate.label}`,
    });
    groundedCount += 1;
    setAnalysisProgress(groundedCount, paperAnalysis.candidateCount, `${groundedCount} of ${paperAnalysis.candidateCount} candidates grounded`);
    elements.paperAnalysisStatus.textContent = `Grounding ${groundedCount} / ${paperAnalysis.candidateCount} candidates`;
  }
  syncPersistedAnnotationOverlays();
  const textLimitedPages = state.automaticMap?.coverage.filter((entry) => (
    entry.textCapability === "no_text" || entry.textCapability === "visual_only" || entry.textCapability === "failed"
    || entry.textCapability === "weak_text"
  )).length || 0;
  setAnalysisProgress(
    paperFacts.pageCount - textLimitedPages,
    paperFacts.pageCount,
    `${paperFacts.pageCount - textLimitedPages} of ${paperFacts.pageCount} pages indexed with usable text`,
  );
  if (paperAnalysis.candidateCount > 0) {
    elements.paperAnalysisStatus.textContent = `${paperAnalysis.candidateCount} candidates · ${paperFacts.pageCount} pages read`;
    elements.paperAnalysisSummary.textContent = `${paperAnalysis.candidateCount} critical-idea candidates were ranked and grounded across the verified paper. ${textLimitedPages} pages had limited or failed text.`;
    recordActivity("automatic_map_hydrated", {
      actor: "page",
      status: `${paperAnalysis.candidateCount} candidates · revision 1 baseline`,
    });
  }
  tools = instrumentTools(createToolSuite(state));
  elements.primarySourceButton.dataset.focusAnchor = state.focusAnchorId;
  elements.primarySourceButton.disabled = !state.anchors.has(state.focusAnchorId);
  elements.primarySourceButton.textContent = state.anchors.get(state.focusAnchorId)?.sourceKind === "exact_text"
    ? "Go to current source"
    : "Go to current page source";
  wireHumanControls();
  await setupVisualTrial();
  renderState();
  placeAgentCursor(
    state.focusAnchorId,
    "ready",
    "Waiting for a WebMCP callback",
    "The provenance cursor will move only when PaperPilot observes a WebMCP page callback.",
  );
  await registerSuite({ automatic: true });
}

function reportInitializationFailure(error) {
  elements.webmcpStatus.textContent = "Spike initialization failed";
  elements.rendererStatus.textContent = "Accessible diagnostics only";
  recordActivity("spike_initialization_failed", { status: error?.name || "error" });
  renderLastResult({ status: "initialization_failed", name: error?.name, message: error?.message });
}

async function beginWithPaper(pdfFile = null) {
  elements.workspace.inert = false;
  document.body.classList.remove("is-waiting-for-paper");
  elements.skipLink.href = "#contract-workspace";
  elements.skipLink.textContent = "Skip to PaperPilot workspace";
  try {
    await boot({ pdfFile });
    if (pdfFile) {
      elements.paperSourceGateStatus.textContent = `${pdfFile.name} is active in this tab.`;
      elements.paperFileInput.disabled = true;
      elements.loadAttentionDemo.disabled = true;
      elements.paperSourceGate.hidden = true;
    }
  } catch (error) {
    reportInitializationFailure(error);
    if (pdfFile) {
      paperViewer?.destroy();
      paperViewer = null;
      elements.paperFileInput.disabled = false;
      elements.loadAttentionDemo.disabled = false;
      elements.paperFileInput.value = "";
      elements.paperSourceGateStatus.textContent = `${error?.message || "The PDF could not be opened."} Choose another PDF.`;
      elements.workspace.inert = true;
      document.body.classList.add("is-waiting-for-paper");
      elements.skipLink.href = "#paper-source-gate";
      elements.skipLink.textContent = "Skip to paper intake";
    }
  }
}

const startupParameters = new URLSearchParams(globalThis.location.search);
const forceUploadMode = startupParameters.has("upload");
const localFixtureMode = !forceUploadMode
  && startupParameters.has("fixture")
  && ["localhost", "127.0.0.1", "::1"].includes(globalThis.location.hostname);

if (localFixtureMode) {
  elements.paperSourceGate.hidden = true;
  void beginWithPaper();
} else {
  elements.workspace.inert = true;
  renderToolList();
  void renderContractManifest();
  renderActivity();
  elements.loadAttentionDemo.addEventListener("click", async () => {
    elements.loadAttentionDemo.disabled = true;
    elements.paperFileInput.disabled = true;
    elements.paperSourceGateStatus.textContent = "Fetching the official arXiv v7 Attention paper into this tab…";
    try {
      const response = await fetch(ATTENTION_DEMO_URL, { mode: "cors", credentials: "omit", redirect: "follow" });
      if (!response.ok) throw new Error(`arXiv returned HTTP ${response.status}.`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/pdf")) throw new Error("arXiv did not return a PDF response.");
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > 64 * 1024 * 1024) throw new Error("The demo paper was empty or exceeded the 64 MiB browser limit.");
      const pdfFile = new File([blob], ATTENTION_DEMO_FILENAME, { type: "application/pdf", lastModified: 0 });
      elements.paperSourceGateStatus.textContent = "Opening the verified Attention paper locally—nothing is being uploaded.";
      await beginWithPaper(pdfFile);
    } catch (error) {
      elements.loadAttentionDemo.disabled = false;
      elements.paperFileInput.disabled = false;
      elements.paperSourceGateStatus.textContent = `${error?.message || "The demo paper could not be fetched."} Choose a local PDF instead.`;
    }
  });
  elements.paperFileInput.addEventListener("change", () => {
    const [pdfFile] = elements.paperFileInput.files || [];
    if (!pdfFile) return;
    if (pdfFile.size === 0) {
      elements.paperSourceGateStatus.textContent = "That file is empty. Choose a PDF with paper content.";
      elements.paperFileInput.value = "";
      return;
    }
    if (pdfFile.size > 64 * 1024 * 1024) {
      elements.paperSourceGateStatus.textContent = "That PDF is larger than the 64 MiB browser-memory limit.";
      elements.paperFileInput.value = "";
      return;
    }
    elements.paperFileInput.disabled = true;
    elements.loadAttentionDemo.disabled = true;
    elements.paperSourceGateStatus.textContent = `Opening ${pdfFile.name} locally—nothing is being uploaded.`;
    void beginWithPaper(pdfFile);
  });
}
