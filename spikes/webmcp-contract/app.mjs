import {
  INPUT_SCHEMAS,
  LIMITS,
  RESULT_SCHEMAS,
  TOOL_NAMES,
  SPIKE_VERSIONS,
  canonicalJson,
  captureWebmcpInput,
  createSpikeState,
  createToolSuite,
  enqueueHumanWorkspaceAction,
  graphNodeReferencesAnchor,
  mintReaderAnchor,
  applyReaderAnnotation,
  removeReaderAnnotation,
  mountToolSuite,
  redoLastHumanChange,
  undoLastHumanChange,
} from "./contracts.mjs";
import { ATTENTION_PDF, PDF_RELEASE_LIMITS, initializePaperPdfViewer, normalizePdfText, resolvePdfTextRangeGeometry, safePdfError } from "./pdf-viewer.mjs";
import { PdfIntakeError, readBoundedPdfResponse, safeDemoFailure } from "./pdf-intake.mjs";
import {
  clampGraphPosition,
  moveAnnotation,
  nudgeGraphPosition,
  reconcileAnnotationOrder,
  resolvePrimaryGraphNodeKey,
} from "./presentation-layout.mjs";
import { createGraphLayout, graphDisplayLabel, projectGraphView } from "./graph-view-model.mjs";
import { analyzePaperPages } from "./paper-analysis.mjs";
import { createWholePaperStructuralMap } from "./structural-map.mjs";
import {
  clearBrowserSnapshot,
  loadBrowserSnapshot,
  saveBrowserSnapshot,
} from "./browser-snapshot.mjs";
import {
  TOOL_PRESENTATION_COPY,
  annotationAnchorId,
  createObservedPresentation,
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
import {
  captureFocusBookmark,
  disclosureOpenState,
  planInteractionRefresh,
  resolveFocusBookmark,
} from "./interaction-state.mjs";

const byId = (id) => document.getElementById(id);

const elements = {
  skipLink: byId("skip-link"),
  workspaceSkipLinks: byId("workspace-skip-links"),
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
  graphOutlineCount: byId("graph-outline-count"),
  graphOutlineDetails: byId("graph-outline-details"),
  graphSelection: byId("graph-selection"),
  graphSelectionHeading: byId("graph-selection-heading"),
  graphSelectionMeta: byId("graph-selection-meta"),
  graphSelectionDetail: byId("graph-selection-detail"),
  graphSelectionPosition: byId("graph-selection-position"),
  graphViewSummary: byId("graph-view-summary"),
  graphViewFocus: byId("graph-view-focus"),
  graphViewAll: byId("graph-view-all"),
  graphFit: byId("graph-fit"),
  graphVisualWorkspace: byId("graph-visual-workspace"),
  graphVisualFallback: byId("graph-visual-fallback"),
  graphFilterKind: byId("graph-filter-kind"),
  graphFilterAuthority: byId("graph-filter-authority"),
  graphRailTabs: [...document.querySelectorAll("[data-rail-tab]")],
  paperMap: byId("paper-map"),
  paperMapState: byId("paper-map-state"),
  paperMapStatus: byId("paper-map-status"),
  paperMapProgress: byId("paper-map-progress"),
  paperPageLedger: byId("paper-page-ledger"),
  paperMapIndexed: byId("paper-map-indexed"),
  paperMapNavigable: byId("paper-map-navigable"),
  paperMapLimited: byId("paper-map-limited"),
  paperMapFailed: byId("paper-map-failed"),
  paperStructureCount: byId("paper-structure-count"),
  paperStructureList: byId("paper-structure-list"),
  annotationList: byId("annotation-list"),
  annotationLayoutStatus: byId("annotation-layout-status"),
  activityList: byId("activity-list"),
  toolList: byId("tool-list"),
  lastResult: byId("last-result"),
  registerTools: byId("register-tools"),
  disposeTools: byId("dispose-tools"),
  humanUndo: byId("human-undo"),
  humanRedo: byId("human-redo"),
  workspaceChangeStatus: byId("workspace-change-status"),
  workspaceRevisionList: byId("workspace-revision-list"),
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
  readerAnnotationError: byId("reader-annotation-error"),
  useTextSelection: byId("use-text-selection"),
  beginRegionSelection: byId("begin-region-selection"),
  selectWholePage: byId("select-whole-page"),
  cancelRegionSelection: byId("cancel-region-selection"),
  regionDescriptionField: byId("region-description-field"),
  readerRegionDescription: byId("reader-region-description"),
  createReaderAnnotation: byId("create-reader-annotation"),
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
  goToExplanation: byId("go-to-explanation"),
  browserSaveCard: document.querySelector(".browser-save-card"),
  saveWorkspace: byId("save-workspace"),
  clearSavedWorkspace: byId("clear-saved-workspace"),
  cancelClearSavedWorkspace: byId("cancel-clear-saved-workspace"),
  browserClearWarning: byId("browser-clear-warning"),
  browserSaveStatus: byId("browser-save-status"),
  workspace: document.querySelector(".workspace"),
};

const activity = [];
let state;
let tools = [];
let suiteHandle = null;
let registrationClosed = false;
let cleanupRequiresReload = false;
let registrationAttempt = null;
let toolSessionGeneration = 0;
let paperSessionGeneration = 0;
let paperLoadController = null;
let demoLoadController = null;
let paperIntakeGeneration = 0;
let humanControlsWired = false;
let pageLeaving = false;
let sigmaRenderer = null;
let sigmaGraph = null;
let visualTrialObserved = false;
let visualKeyRevealed = false;
let lastObservedTrace = null;
let visualReplayQueue = Promise.resolve();
let paperViewer = null;
let pendingReaderCapture = null;
let pendingReaderOverlayId = null;
let regionSelectionActive = false;
let readerSelectionGeneration = 0;
let regionSelectionTrigger = null;
let readerAnnotationPending = null;
let pendingRemovalAnnotationId = null;
let removalConfirmationTimer = null;
let annotationOrder = Object.freeze([]);
let selectedGraphNodeKey = null;
let selectedGraphEdgeKey = null;
let lastGraphFocusAnchorId = null;
let graphNavigationGeneration = 0;
let pendingGraphNavigation = null;
const graphToolNavigationGenerations = new WeakMap();
let linkedFocusNodeKeys = new Set();
let linkedFocusEdgeKeys = new Set();
let graphViewMode = "focus";
let activeRailView = "map";
let graphView = null;
let graphVisibleNodeKeys = new Set();
let graphVisibleEdgeKeys = new Set();
let graphViewportBounds = null;
let graphSelectionStamp = null;
const graphSelectionDisclosureStates = new Map();
let graphFactsCache = null;
let graphFactsGraph = null;
let graphClickSuppressedUntil = 0;
let draggedAnnotationId = null;
let draggedAnnotationNodeKey = null;
let annotationPointerDrag = null;
let draggedGraphNodeKey = null;
let graphDragStartPosition = null;
let graphDragMoved = false;
let paperAnalysis = null;
let paperStructuralMap = null;
let savedExplanations = [];
let snapshotEnabled = false;
let snapshotDirty = false;
let snapshotStored = false;
let snapshotHasSavedCopies = false;
let snapshotStatusKind = "idle";
let snapshotStatusMessage = "Not saved · active tab only";
let snapshotSaveQueue = Promise.resolve();
let snapshotGeneration = 0;
let snapshotEditGeneration = 0;
let snapshotReady = false;
let snapshotPendingSaves = 0;
let snapshotClearPending = false;
let clearSavedCopyArmed = null;
const criticalIdeaByNodeKey = new Map();
const initialGraphPositions = new Map();
const graphLayoutPositions = new Map();

const reducedMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

const ATTENTION_DEMO_URL = ATTENTION_PDF.sourceUrl;
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

function currentMentorReview() {
  return createMentorReviewViewModel({
    stagedExplanations: state?.explanations,
    savedExplanations,
    currentAnchors: state?.anchors,
    currentGraphNodes: state?.graph ? new Map(state.graph.mapNodes((key, attributes) => [key, attributes])) : new Map(),
    currentGraphEdges: state?.graph ? new Map(state.graph.mapEdges((key, attributes, source, target) => [key, {
      ...attributes, label: `${graphNodeLabel(source)} → ${graphNodeLabel(target)} · ${humanReadable(attributes.kind)}`,
    }])) : new Map(),
    currentPaperRef: state?.paper?.paperRef,
    currentDocumentSha256: state?.paper?.documentSha256,
    currentGraphDigest: state?.graphDigest,
  });
}

async function openMentorEvidence(link) {
  // Resolve again on activation; a saved note or stale DOM control is not
  // authority to revive a removed item or navigate a different paper.
  const review = currentMentorReview();
  const current = (link.kind === "source" ? review.sourceLinks : review.graphLinks).find(({ key }) => key === link.key);
  if (!current?.available) {
    elements.mentorExplanationStatus.textContent = "Source incomplete. This reference is retained for audit but cannot be opened in the current paper.";
    return false;
  }
  if (current.kind === "source") {
    return navigateGraphSource(current.key, { eventType: "mentor_evidence_focused" });
  }
  showGraphRailView("map");
  return current.kind === "edge" ? focusGraphEdgeEvidence(current.key) : focusGraphNodeEvidence(current.key);
}

function appendMentorEvidenceLinks(parent, links, identity) {
  for (const link of links) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.interactionKey = `mentor:${identity}:${link.kind}:${link.key}`;
    button.dataset.mentorReference = link.key;
    button.textContent = link.label;
    button.title = `${link.detail} Reference: ${link.key}`;
    button.disabled = !link.available;
    button.setAttribute("aria-label", `${link.label}. ${link.detail} Reference ${link.key}`);
    button.addEventListener("click", () => void openMentorEvidence(link));
    parent.append(button);
  }
}

function renderMentorClaim(claim, explanationId) {
  const article = document.createElement("article");
  article.className = `mentor-claim is-${claim.authority.replaceAll("_", "-")}`;
  article.dataset.interactionKey = `${explanationId}:${claim.key}`;
  const authority = document.createElement("span");
  authority.className = "mentor-authority";
  authority.textContent = claim.authorityLabel;
  const content = document.createElement("p");
  content.className = "mentor-claim-text";
  content.textContent = claim.text;
  article.append(authority, content);
  for (const warning of claim.warnings) {
    const note = document.createElement("p");
    note.className = "mentor-claim-note";
    note.textContent = warning;
    article.append(note);
  }
  const links = document.createElement("div");
  links.className = "mentor-evidence-chips";
  appendMentorEvidenceLinks(links, [...claim.sourceLinks, ...claim.graphLinks], claim.key);
  for (const citation of claim.citations) {
    const item = document.createElement(citation.href ? "a" : "span");
    item.className = "mentor-external-citation";
    item.textContent = `${citation.title} · ${citation.label}`;
    if (citation.href) {
      item.href = citation.href;
      item.target = "_blank";
      item.rel = "noopener noreferrer";
      item.referrerPolicy = "no-referrer";
      item.dataset.interactionKey = `mentor:${claim.key}:citation:${citation.citationId}`;
      item.setAttribute("aria-label", `${citation.title}. Not verified by PaperPilot. Opens an external site in a new tab.`);
    }
    links.append(item);
  }
  if (links.childElementCount) article.append(links);
  return article;
}

function goToMentorExplanation() {
  if (!currentMentorReview().explanation) return;
  const heading = byId("mentor-explanation-heading");
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "instant" : "smooth" });
}

function renderMentorExplanation() {
  const interaction = captureWorkspaceInteraction();
  const disclosureStates = new Map([...elements.mentorExplanationBody.querySelectorAll("details[data-mentor-section-key]")]
    .map((section) => [section.dataset.mentorSectionKey, section.open]));
  const review = currentMentorReview();
  const explanation = review.explanation;
  elements.mentorExplanationBody.replaceChildren();
  elements.mentorExplanationState.className = "review-state is-empty";
  elements.mentorExplanationActions.hidden = true;
  elements.goToExplanation.disabled = !explanation;
  if (!explanation) {
    const empty = document.createElement("p");
    empty.textContent = review.quickTake;
    elements.mentorExplanationBody.append(empty);
    elements.mentorExplanationState.textContent = review.stateLabel;
    elements.mentorExplanationStatus.textContent = review.statusMessage;
    elements.mentorTakeaway.value = "";
    delete elements.mentorTakeaway.dataset.explanationId;
    delete elements.mentorTakeaway.dataset.responseDigest;
    restoreWorkspaceInteraction(interaction);
    return;
  }

  const saved = review.state === "saved";
  const takeawayChangedExplanation = elements.mentorTakeaway.dataset.explanationId !== explanation.explanationId;
  elements.mentorTakeaway.dataset.explanationId = explanation.explanationId;
  elements.mentorTakeaway.dataset.responseDigest = explanation.responseDigest;
  elements.mentorExplanationState.textContent = review.stateLabel;
  elements.mentorExplanationState.className = `review-state${saved ? " is-saved" : ""}`;
  for (const notice of review.notices) {
    const note = document.createElement("p");
    note.className = "mentor-review-notice";
    note.textContent = notice;
    elements.mentorExplanationBody.append(note);
  }
  for (const sectionModel of [{ key: "quickTake", label: "Quick take", initiallyOpen: true, claims: review.quickTakeClaims }, ...review.sections]) {
    const section = document.createElement("details");
    section.className = "mentor-section";
    section.dataset.mentorSectionKey = `${explanation.explanationId}:${sectionModel.key}`;
    section.dataset.interactionKey = `mentor-section:${sectionModel.key}`;
    section.open = disclosureOpenState(disclosureStates, section.dataset.mentorSectionKey, sectionModel.initiallyOpen);
    const summary = document.createElement("summary");
    const heading = document.createElement("h4");
    heading.textContent = sectionModel.label;
    summary.append(heading);
    section.append(summary);
    for (const claim of sectionModel.claims) section.append(renderMentorClaim(claim, explanation.explanationId));
    elements.mentorExplanationBody.append(section);
  }
  if (review.visualDescription) {
    const visual = document.createElement("section");
    visual.className = "mentor-visual-description";
    const heading = document.createElement("h4");
    heading.textContent = review.visualDescription.label;
    const description = document.createElement("p");
    description.textContent = review.visualDescription.text;
    const limit = document.createElement("p");
    limit.className = "mentor-claim-note";
    limit.textContent = review.visualDescription.limitation;
    const links = document.createElement("div");
    links.className = "mentor-evidence-chips";
    appendMentorEvidenceLinks(links, review.visualDescription.sourceLinks, "visual-description");
    visual.append(heading, description, limit, links);
    elements.mentorExplanationBody.append(visual);
  }
  const coverage = document.createElement("details");
  coverage.className = "mentor-section mentor-coverage";
  coverage.dataset.mentorSectionKey = `${explanation.explanationId}:coverage`;
  coverage.dataset.interactionKey = "mentor-section:coverage";
  coverage.open = disclosureOpenState(disclosureStates, coverage.dataset.mentorSectionKey, false);
  const summary = document.createElement("summary");
  summary.textContent = explanation.provenanceMode === "legacy_unclassified" ? "Legacy note context · not claim citations" : "Source and graph coverage";
  coverage.append(summary);
  if (review.sourceCoverage.length || review.graphCoverage.length) {
    for (const item of [...review.sourceCoverage, ...review.graphCoverage]) {
      const row = document.createElement("div");
      row.className = "mentor-coverage-row";
      const description = document.createElement("p");
      description.textContent = item.explanation ? `${humanReadable(item.status)} · ${item.explanation}` : humanReadable(item.role);
      row.append(description);
      appendMentorEvidenceLinks(row, [item.link], "coverage");
      coverage.append(row);
    }
  } else {
    const links = document.createElement("div");
    links.className = "mentor-evidence-chips";
    appendMentorEvidenceLinks(links, [...review.sourceLinks, ...review.graphLinks], "context");
    coverage.append(links);
  }
  elements.mentorExplanationBody.append(coverage);

  if (saved) {
    if (explanation.takeaway) {
      const takeaway = document.createElement("p");
      takeaway.className = "reader-takeaway";
      takeaway.textContent = `My takeaway: ${review.takeaway}`;
      elements.mentorExplanationBody.append(takeaway);
    }
    elements.mentorExplanationStatus.textContent = review.statusMessage;
    if (takeawayChangedExplanation) elements.mentorTakeaway.value = review.takeaway;
  } else {
    elements.mentorExplanationActions.hidden = !review.showHumanDecisionActions;
    elements.mentorExplanationStatus.textContent = review.statusMessage;
    if (takeawayChangedExplanation) elements.mentorTakeaway.value = "";
  }
  restoreWorkspaceInteraction(interaction);
}

async function decideMentorExplanation(decisionName) {
  if (!state || !snapshotReady || pageLeaving) return;
  const sourceState = state;
  const paperSession = paperSessionGeneration;
  // A replacement invalidates human intent before its new state is installed.
  // Checking state alone would let an old queued decision refill reset notes.
  const currentSession = () => !pageLeaving && state === sourceState && paperSessionGeneration === paperSession;
  const initiator = document.activeElement;
  const intent = {
    explanationId: elements.mentorTakeaway.dataset.explanationId,
    responseDigest: elements.mentorTakeaway.dataset.responseDigest,
    takeaway: elements.mentorTakeaway.value,
  };
  const decision = await enqueueHumanWorkspaceAction(sourceState, () => {
    if (!currentSession()) return { changed: false, code: "paper_changed" };
    const current = state.explanations.at(-1);
    if (!current || current.explanationId !== intent.explanationId || current.responseDigest !== intent.responseDigest) {
      return { changed: false, code: "mentor_draft_changed" };
    }
    const result = applyHumanMentorDecision({
      actor: "human", decision: decisionName, stagedExplanations: state.explanations, savedExplanations,
      takeaway: intent.takeaway, savedAt: state.now(),
    });
    if (!result.changed) return result;
    state.explanations = result.stagedExplanations;
    savedExplanations = result.savedExplanations;
    state.savedExplanations = structuredClone(savedExplanations);
    recordHumanEvidenceEvent(result.event.eventType, {
      explanationId: result.event.explanationId, responseDigest: result.event.responseDigest,
    });
    return result;
  });
  if (!currentSession()) return;
  if (!decision.changed) {
    elements.mentorExplanationStatus.textContent = decision.code === "mentor_draft_changed"
      ? "A newer mentor draft arrived before this action completed. Nothing was saved or discarded. Review the current draft and choose again."
      : decision.code === "saved_note_limit"
      ? "This paper already has 200 saved mentor notes. Nothing was removed. Your current draft remains available in this tab."
      : decision.code === "takeaway_too_long"
      ? "Shorten your takeaway to 1,200 characters, then save again." : "No current mentor draft could be changed. Read the current note and try again.";
    return;
  }
  snapshotDirty = true;
  renderState();
  // This focus move follows the reader's explicit decision, never arrival.
  if ([elements.saveExplanation, elements.discardExplanation].includes(initiator)
    && document.activeElement === initiator
    && elements.mentorExplanationActions.hidden) byId("mentor-explanation-heading").focus({ preventScroll: true });
  if (decisionName === "discard") {
    elements.mentorExplanationStatus.textContent = "Mentor draft discarded. The paper, graph, and annotations were not changed.";
    if (snapshotEnabled) markSnapshotDirty();
    return;
  }
  const result = await persistBrowserWorkspace({ enable: true, reason: "mentor note saved" });
  if (!currentSession() || currentMentorReview().explanation?.explanationId !== decision.event.explanationId) return;
  elements.mentorExplanationStatus.textContent = result.status === "saved"
    ? "Mentor note saved in this browser. Its original AI claims stay immutable and separate from your takeaway."
    : "Mentor note is kept in this tab, but browser recovery failed. Keep this tab open.";
}

function renderBrowserSaveState() {
  elements.browserSaveCard.classList.toggle("is-saved", snapshotStatusKind === "saved" || snapshotStatusKind === "restored");
  elements.browserSaveCard.classList.toggle("is-dirty", snapshotDirty && snapshotStatusKind !== "error");
  elements.browserSaveCard.classList.toggle("is-error", snapshotStatusKind === "error");
  elements.browserSaveStatus.setAttribute("role", snapshotStatusKind === "error" ? "alert" : "status");
  elements.browserSaveStatus.setAttribute("aria-live", snapshotStatusKind === "error" ? "assertive" : "polite");
  elements.browserSaveStatus.setAttribute("aria-atomic", "true");
  if (elements.browserSaveStatus.textContent !== snapshotStatusMessage) elements.browserSaveStatus.textContent = snapshotStatusMessage;
  elements.saveWorkspace.textContent = snapshotStored ? "Save changes" : "Save in this browser";
  elements.saveWorkspace.disabled = !snapshotReady;
  elements.saveWorkspace.setAttribute("aria-disabled", String(snapshotClearPending || snapshotPendingSaves > 0));
  elements.saveWorkspace.setAttribute("aria-busy", String(snapshotPendingSaves > 0));
  elements.clearSavedWorkspace.disabled = !snapshotReady || !snapshotHasSavedCopies;
  elements.clearSavedWorkspace.setAttribute("aria-disabled", String(snapshotClearPending));
  elements.clearSavedWorkspace.setAttribute("aria-busy", String(snapshotClearPending));
  const confirming = Boolean(clearSavedCopyArmed && isCurrentBrowserSnapshotSession(clearSavedCopyArmed));
  elements.clearSavedWorkspace.textContent = confirming ? "Confirm clear" : "Clear saved copies";
  elements.cancelClearSavedWorkspace.hidden = !confirming;
  elements.cancelClearSavedWorkspace.disabled = !snapshotReady;
  const warning = confirming
    ? "Clear all saved versions of this paper? The active paper, annotations, graph, and PDF will stay open. Older saved versions cannot be recovered unless still open in another tab. Choose Confirm clear or Cancel clear."
    : "";
  elements.browserClearWarning.hidden = !confirming;
  if (elements.browserClearWarning.textContent !== warning) elements.browserClearWarning.textContent = warning;
}

function resetBrowserWorkspacePersistence() {
  snapshotGeneration += 1;
  snapshotEditGeneration = 0;
  snapshotReady = false;
  snapshotPendingSaves = 0;
  snapshotClearPending = false;
  clearSavedCopyArmed = null;
  snapshotEnabled = false;
  snapshotStored = false;
  snapshotHasSavedCopies = false;
  snapshotDirty = false;
  savedExplanations = [];
  annotationOrder = Object.freeze([]);
  snapshotStatusKind = "idle";
  snapshotStatusMessage = "Not saved · waiting for this paper’s recovery check";
  // Old operations retain their generation guard. A slow former document must
  // not block the new document's independent save queue.
  snapshotSaveQueue = Promise.resolve();
  renderBrowserSaveState();
}

function captureBrowserSnapshotSession() {
  return { generation: snapshotGeneration, paperSession: paperSessionGeneration, state, paper: state?.paper,
    paperRef: state?.paper?.paperRef, documentSha256: state?.paper?.documentSha256, pageCount: state?.paper?.pageCount };
}

function isCurrentBrowserSnapshotSession(session) {
  return !pageLeaving && session.generation === snapshotGeneration && session.paperSession === paperSessionGeneration
    && session.state === state && session.paper === state?.paper && session.paperRef === state?.paper?.paperRef
    && session.documentSha256 === state?.paper?.documentSha256 && session.pageCount === state?.paper?.pageCount;
}

function snapshotPresentation() {
  return {
    annotationOrder: [...annotationOrder],
  };
}

function markSnapshotDirty({ saveIfEnabled = true } = {}) {
  if (!state || !snapshotReady || pageLeaving) return;
  snapshotEditGeneration += 1;
  snapshotDirty = true;
  if (snapshotClearPending) return;
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
  if (!state || !snapshotReady || snapshotClearPending || pageLeaving) return { status: "cancelled", reason: "workspace_not_ready" };
  const session = captureBrowserSnapshotSession();
  const wasEnabled = snapshotEnabled;
  if (enable) snapshotEnabled = true;
  snapshotPendingSaves += 1;
  renderBrowserSaveState();
  const task = async () => {
    if (!isCurrentBrowserSnapshotSession(session) || snapshotClearPending || (!enable && !snapshotEnabled)) return { status: "cancelled", reason: "superseded" };
    // Capture only after the canonical transaction queue settles. Otherwise an
    // async mandatory projection could still roll back the state being saved.
    let capturedEditGeneration;
    const result = await enqueueHumanWorkspaceAction(session.state, async () => {
      if (!isCurrentBrowserSnapshotSession(session) || snapshotClearPending) return { status: "cancelled", reason: "superseded" };
      const editGeneration = snapshotEditGeneration;
      capturedEditGeneration = editGeneration;
      const current = () => isCurrentBrowserSnapshotSession(session) && editGeneration === snapshotEditGeneration && !snapshotClearPending;
      const storage = browserStorageAdapter();
      if (!storage) return { status: "storage_error", reason: "storage_unavailable" };
      try {
        return await saveBrowserSnapshot({ storage, state: session.state, savedExplanations,
          presentation: snapshotPresentation(), isCurrent: current });
      } catch { return { status: "storage_error", reason: "snapshot_failed" }; }
    });
    if (!isCurrentBrowserSnapshotSession(session)) return { status: "cancelled", reason: "superseded" };
    if (result.status === "saved") {
      snapshotStored = true;
      snapshotHasSavedCopies = true;
      const latest = capturedEditGeneration === snapshotEditGeneration && result.workspaceRevision === state.workspaceRevision;
      snapshotDirty = !latest;
      snapshotStatusKind = latest ? "saved" : "dirty";
      snapshotStatusMessage = latest
        ? `Saved in this browser · ${new Date(result.savedAt).toLocaleString()} · exact PDF fingerprint only`
        : "An earlier workspace version was saved. Newer changes are not saved in this browser yet.";
      try { recordActivity("browser_workspace_saved", { actor: enable ? "human" : "page", status: `${reason} · revision ${result.workspaceRevision}` }); } catch { /* Optional activity cannot undo a successful write. */ }
      if (!latest) {
        renderBrowserSaveState();
        return { ...result, status: "saved_older" };
      }
    } else if (result.status === "cancelled") {
      snapshotDirty = true;
      snapshotStatusKind = "dirty";
      snapshotStatusMessage = "Not saved in this browser — newer changes are pending. Save again to keep the latest workspace.";
    } else {
      if (!wasEnabled) snapshotEnabled = false;
      snapshotDirty = true;
      snapshotStatusKind = "error";
      snapshotStatusMessage = snapshotFailureMessage(result);
      try { recordActivity("browser_workspace_save_failed", { actor: "page", status: result.reason || result.status }); } catch { /* Failure status remains visible without an optional event. */ }
    }
    renderBrowserSaveState();
    return result;
  };
  snapshotSaveQueue = snapshotSaveQueue.then(task, task);
  return snapshotSaveQueue.finally(() => {
    if (!isCurrentBrowserSnapshotSession(session)) return;
    snapshotPendingSaves = Math.max(0, snapshotPendingSaves - 1);
    renderBrowserSaveState();
  });
}

async function restoreBrowserWorkspace({ isCurrent = () => true } = {}) {
  const session = captureBrowserSnapshotSession();
  const current = () => isCurrentBrowserSnapshotSession(session) && isCurrent();
  if (!current()) return { status: "cancelled", reason: "superseded" };
  const storage = browserStorageAdapter();
  if (!storage) {
    snapshotReady = true;
    snapshotStatusKind = "error";
    snapshotStatusMessage = "Browser recovery is unavailable. This workspace will remain in the active tab only.";
    renderBrowserSaveState();
    return { status: "storage_error" };
  }
  let result;
  try {
    result = await enqueueHumanWorkspaceAction(session.state, () => loadBrowserSnapshot({ storage, state: session.state, isCurrent: current }));
  } catch { result = { status: "storage_error", reason: "snapshot_failed" }; }
  if (!current()) return { status: "cancelled", reason: "superseded" };
  snapshotReady = true;
  if (result.status === "restored") {
    savedExplanations = result.savedExplanations || [];
    annotationOrder = Object.freeze(result.presentation?.annotationOrder || []);
    mergeRestoredActivity(state.events);
    // Migration is read-only. An explicit Save creates the new-format copy;
    // merely inspecting an older workspace never overwrites it via autosave.
    snapshotEnabled = !result.migratedFrom;
    snapshotStored = !result.migratedFrom;
    snapshotHasSavedCopies = true;
    snapshotDirty = Boolean(result.displayTitleRefreshed || result.migratedFrom);
    snapshotStatusKind = snapshotDirty ? "dirty" : "restored";
    const titleNotice = (result.migratedFrom ? " · older copy preserved; Save to keep the new reversible history format"
      : result.displayTitleRefreshed ? " · current filename applied; save to update the stored title" : "")
      + (result.replayInvalidated ? " · historical retry keys protected; reread before new agent edits" : "");
    snapshotStatusMessage = `Restored from this browser · ${new Date(result.savedAt).toLocaleString()} · revision ${state.workspaceRevision}${titleNotice}`;
    recordActivity("browser_workspace_restored", { actor: "page", status: `revision ${state.workspaceRevision}${result.displayTitleRefreshed ? " · display title refreshed" : ""}` });
  } else if (result.status === "legacy_preserved") {
    snapshotEnabled = false;
    snapshotStored = false;
    snapshotHasSavedCopies = true;
    snapshotDirty = false;
    snapshotStatusKind = "legacy";
    snapshotStatusMessage = "An older saved workspace is preserved in this browser. It cannot be safely imported into the new paper map yet. Save here to start a separate compatible copy.";
    recordActivity("browser_workspace_legacy_preserved", { actor: "page", status: "older format retained without changes" });
  } else if (result.status === "not_found") {
    snapshotEnabled = false;
    snapshotStored = false;
    snapshotHasSavedCopies = false;
    snapshotDirty = false;
    snapshotStatusKind = "idle";
    snapshotStatusMessage = "Not saved · active tab only";
  } else if (result.status === "cancelled") {
    snapshotDirty = true;
    snapshotStatusKind = "dirty";
    snapshotStatusMessage = "Browser restore was cancelled because this workspace changed. Current work remains in this tab.";
  } else if (result.status === "storage_error") {
    snapshotEnabled = false;
    snapshotStored = false;
    snapshotHasSavedCopies = false;
    snapshotStatusKind = "error";
    snapshotStatusMessage = "Browser recovery could not be read. Current work is not saved in this browser; keep this tab open.";
  } else {
    snapshotEnabled = false;
    snapshotStored = !result.migratedFrom;
    snapshotHasSavedCopies = true;
    snapshotStatusKind = "error";
    snapshotStatusMessage = "A saved copy was found but failed validation. The fresh verified paper is active; no stored state was applied.";
    recordActivity("browser_workspace_restore_rejected", { actor: "page", status: result.reason || result.status });
  }
  renderBrowserSaveState();
  return result;
}

async function saveBrowserWorkspaceFromControl() {
  if (!snapshotReady || snapshotClearPending || snapshotPendingSaves > 0 || pageLeaving) return { status: "cancelled", reason: "workspace_not_ready" };
  clearSavedCopyArmed = null;
  snapshotStatusKind = "dirty";
  snapshotStatusMessage = "Saving this paper’s in-app workspace…";
  return persistBrowserWorkspace({ enable: true, reason: "explicit reader save" });
}

function cancelClearSavedBrowserWorkspaceFromControl() {
  if (!clearSavedCopyArmed || !isCurrentBrowserSnapshotSession(clearSavedCopyArmed) || snapshotClearPending) return { status: "cancelled", reason: "no_current_confirmation" };
  const initiator = document.activeElement;
  clearSavedCopyArmed = null;
  snapshotStatusMessage = `Clear cancelled. ${snapshotStatusMessage}`;
  renderBrowserSaveState();
  if (initiator === elements.cancelClearSavedWorkspace
    && [initiator, document.body, null].includes(document.activeElement)
    && !elements.clearSavedWorkspace.disabled) elements.clearSavedWorkspace.focus({ preventScroll: true });
  return { status: "confirmation_cancelled" };
}

async function clearSavedBrowserWorkspaceFromControl() {
  if (!state || !snapshotReady || !snapshotHasSavedCopies || snapshotClearPending || pageLeaving) return { status: "cancelled", reason: "workspace_not_ready" };
  if (!clearSavedCopyArmed || !isCurrentBrowserSnapshotSession(clearSavedCopyArmed)) {
    clearSavedCopyArmed = captureBrowserSnapshotSession();
    renderBrowserSaveState();
    return { status: "confirmation_required" };
  }
  const initiator = document.activeElement;
  // Invalidate pending and queued saves immediately, before waiting to clear.
  // Every old save checks this generation directly before its storage write.
  snapshotGeneration += 1;
  snapshotPendingSaves = 0;
  snapshotEnabled = false;
  snapshotClearPending = true;
  clearSavedCopyArmed = null;
  snapshotDirty = true;
  snapshotStatusKind = "dirty";
  snapshotStatusMessage = "Clearing all saved versions of only this paper…";
  const session = captureBrowserSnapshotSession();
  renderBrowserSaveState();
  const task = () => enqueueHumanWorkspaceAction(session.state, () => {
    if (!isCurrentBrowserSnapshotSession(session)) return { status: "cancelled", reason: "superseded" };
    const storage = browserStorageAdapter();
    const result = storage ? clearBrowserSnapshot({ storage, documentSha256: session.documentSha256 })
      : { status: "storage_error", reason: "storage_unavailable" };
    snapshotClearPending = false;
    if (result.status === "cleared" || result.status === "not_found") {
      snapshotStored = false;
      snapshotHasSavedCopies = false;
      snapshotStatusKind = "idle";
      snapshotStatusMessage = "All saved versions cleared · not saved in this browser. This active tab and the original PDF are unchanged.";
      try { recordHumanEvidenceEvent("browser_workspace_cleared", { status: result.status }); } catch { /* The completed clear remains authoritative. */ }
    } else {
      if (Array.isArray(result.remainingVersions)) {
        snapshotStored = result.remainingVersions.includes(3);
        snapshotHasSavedCopies = result.remainingVersions.length > 0;
      }
      snapshotStatusKind = "error";
      snapshotStatusMessage = result.status === "partial_clear"
        ? `Some older saved versions were cleared (${result.removedVersions.map((version) => `v${version}`).join(", ")}); ${result.remainingVersions.map((version) => `v${version}`).join(", ")} could not be cleared and remain saved. Automatic saving is off. Keep this tab open and retry Clear.`
        : "The saved copies could not be cleared. Nothing was removed; automatic saving is off. Keep this tab open.";
    }
    renderBrowserSaveState();
    if (["cleared", "not_found"].includes(result.status) && initiator === elements.clearSavedWorkspace
      && [initiator, document.body, null].includes(document.activeElement)
      && !elements.saveWorkspace.disabled && elements.saveWorkspace.getAttribute("aria-disabled") !== "true") {
      elements.saveWorkspace.focus({ preventScroll: true });
    }
    return result;
  });
  snapshotSaveQueue = snapshotSaveQueue.then(task, task);
  return snapshotSaveQueue;
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

async function ensureAnchorVisible(anchorId, {
  moveKeyboardFocus = false,
  scrollIntoView = true,
  behavior = prefersReducedMotion() ? "auto" : "smooth",
  navigationRequest = null,
  signal = null,
} = {}) {
  if (signal?.aborted) return null;
  // External source controls win immediately, even while a previous graph
  // navigation is awaiting page rendering. Passive callback markers do not.
  if ((scrollIntoView || moveKeyboardFocus) && pendingGraphNavigation !== navigationRequest) invalidateGraphNavigation();
  if (navigationRequest && !isCurrentGraphNavigation(navigationRequest)) return null;
  const sourceNavigationGeneration = graphNavigationGeneration;
  const sourceState = state;
  const sourceViewer = paperViewer;
  const navigationIsCurrent = () => !signal?.aborted && sourceState === state && sourceViewer === paperViewer
    && ((!scrollIntoView && !moveKeyboardFocus)
      || (sourceNavigationGeneration === graphNavigationGeneration
        && (!navigationRequest || isCurrentGraphNavigation(navigationRequest))));
  const anchor = state?.anchors.get(anchorId);
  if (!anchor) return null;
  const diagnosticVisual = anchor.sourceKind === "visual_region"
    && ["visual-region-a", "visual-region-b"].includes(anchor.visibleRegionId);
  if (paperViewer && !diagnosticVisual) {
    if (anchor.sourceKind === "whole_page") {
      if (scrollIntoView || moveKeyboardFocus) {
        const destination = await paperViewer.showPage(anchor.pageIndex + 1, {
          behavior,
          block: "start",
        });
        if (!destination || !navigationIsCurrent()) return null;
      }
      const target = paperViewer.getPageSurface?.(anchor.pageIndex + 1) || elements.paperStage;
      renderFocus();
      if (moveKeyboardFocus) target.focus({ preventScroll: true });
      return target;
    }
    if (!paperViewer.getAnchorTarget?.(anchorId) && Array.isArray(anchor.normalizedBounds)) {
      const linkedAnnotation = [...state.annotations.values()].find((annotation) => (
        annotationAnchorId(annotation) === anchorId && annotation.status === "active"
      ));
      const nonvisualDescription = anchor.regionDescription
        || (anchor.sourceKind === "visual_region" ? linkedAnnotation?.body : "")
        || anchor.quote?.exact
        || anchor.exactText
        || "";
      paperViewer.upsertAnchorOverlay?.({
        anchorId,
        pageIndex: anchor.pageIndex,
        normalizedBounds: anchor.normalizedBounds,
        className: anchor.sourceKind === "visual_region" ? "is-page-region" : "is-exact-text",
        ariaLabel: `${linkedAnnotation?.label || nonvisualDescription || "Paper source"}, page ${anchor.pageLabel}`,
        ariaDescription: nonvisualDescription,
        visibleLabel: anchor.sourceKind === "visual_region" ? `Region · p.${anchor.pageLabel}` : "",
      });
    }
    if (typeof paperViewer.focusAnchor === "function") {
      if (scrollIntoView) {
        // The viewer's combined helper scrolls again after its render await.
        // Split that await from final focus so an older request cannot move the
        // paper after a newer reader action has already won.
        const destination = await paperViewer.showPage(anchor.pageIndex + 1, { behavior: "auto", block: "nearest" });
        if (!destination || !navigationIsCurrent()) return null;
      }
      await paperViewer.focusAnchor(anchorId, {
        behavior,
        block: "center",
        scrollIntoView: false,
        moveKeyboardFocus: false,
      });
    } else {
      const destination = await paperViewer.showPage(anchor.pageIndex + 1);
      if (!destination || !navigationIsCurrent()) return null;
    }
  }
  if (!navigationIsCurrent()) return null;
  if (diagnosticVisual) {
    elements.visualRegionA.closest("details")?.setAttribute("open", "");
  }
  const target = focusElementForAnchor(anchorId);
  if (!target) return null;
  // Native focus_source commits state.focusAnchorId only after onNavigate
  // succeeds. Navigate this explicit destination; rendering the old semantic
  // focus with scroll enabled would send the PDF back to its previous page.
  renderFocus();
  const pageSurface = paperViewer?.getPageSurface?.(anchor.pageIndex + 1) || elements.pdfPageSurface;
  const destination = !target.hidden ? target : pageSurface || target;
  if (scrollIntoView) destination.scrollIntoView({ block: "center", behavior });
  if (moveKeyboardFocus) destination.focus({ preventScroll: true });
  return target;
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
  const presentation = createObservedPresentation(trace);
  placeAgentCursor(
    trace.anchorId,
    presentation.phase,
    presentation.label,
    presentation.announcement,
  );
  lastObservedTrace = trace;
  elements.replayAgentAction.disabled = false;

  if (presentation.phase === "error") clearAgentEditHighlights();
  if (presentation.flashAnnotation) {
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

function clearAgentEditHighlights() {
  for (const target of document.querySelectorAll(".is-agent-editing")) {
    target.classList.remove("is-agent-editing");
  }
}

async function replayObservedTrace(trace) {
  if (!trace || pageLeaving) return;
  const session = toolSessionGeneration;
  elements.replayAgentAction.disabled = true;
  recordActivity("callback_visual_replay_started", { actor: "human", toolName: trace.toolName });
  placeAgentCursor(
    trace.anchorId,
    "working",
    "Replay · request reached page",
    `Replaying the observed page callback for ${trace.toolName}. No tool or mutation is running.`,
  );
  await waitForReplay(650);
  if (pageLeaving || session !== toolSessionGeneration) return;
  const presentation = createObservedPresentation(trace, { replay: true });
  placeAgentCursor(
    trace.anchorId,
    presentation.phase,
    presentation.label,
    presentation.announcement,
  );
  if (presentation.phase === "error") clearAgentEditHighlights();
  await waitForReplay(450);
  if (pageLeaving || session !== toolSessionGeneration) return;
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
  elements.primarySourceButton.dataset.focusAnchor = focusAnchor?.anchorId || "";
  elements.primarySourceButton.disabled = !focusAnchor;
  elements.primarySourceButton.textContent = focusAnchor?.sourceKind === "exact_text"
    ? "Go to current passage"
    : focusAnchor?.sourceKind === "visual_region"
      ? "Go to current region"
      : "Go to current page source";
  if (scrollIntoView) {
    scrollTarget.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
  if (moveKeyboardFocus) {
    const keyboardTarget = target && !target.hidden ? target : pageSurface || scrollTarget;
    keyboardTarget?.focus({ preventScroll: true });
  }
  synchronizeGraphSourceFocus();
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
  const anchorPageIndices = new Map([...state.anchors].map(([key, anchor]) => [key, anchor.pageIndex]));
  graphView = projectGraphView(state.graph, { selectedNodeKey: selectedGraphNodeKey,
    selectedEdgeKey: selectedGraphEdgeKey, mode: graphViewMode, anchorPageIndices });
  graphVisibleNodeKeys = new Set(graphView.visibleNodeKeys);
  graphVisibleEdgeKeys = new Set(graphView.visibleEdgeKeys);
  const layout = createGraphLayout(state.graph, { nodeKeys: graphView.visibleNodeKeys,
    anchorPageIndices, existingPositions: graphLayoutPositions });
  const defaults = createGraphLayout(state.graph, { nodeKeys: graphView.visibleNodeKeys, anchorPageIndices });
  for (const [key, position] of layout) {
    if (!graphLayoutPositions.has(key)) graphLayoutPositions.set(key, position);
    if (!initialGraphPositions.has(key)) initialGraphPositions.set(key, defaults.get(key) || position);
  }
  for (const [key, preferred] of graphLayoutPositions) {
    const current = state.graph.getNodeAttributes(key);
    if (current.x !== preferred.x || current.y !== preferred.y) state.graph.mergeNodeAttributes(key, preferred);
  }
  const counts = graphView.counts;
  elements.graphViewSummary.textContent = `${counts.visibleNodes} of ${counts.activeNodes} nodes · ${counts.visibleEdges} of ${counts.activeEdges} relationships. ${graphView.truncated ? "Every item is in the outline." : "Full active map."}`;
  elements.graphViewFocus.setAttribute("aria-pressed", String(graphViewMode === "focus"));
  elements.graphViewAll.setAttribute("aria-pressed", String(graphViewMode === "all"));
  elements.graphCanvasShell.dataset.visibleNodes = String(counts.visibleNodes);
  elements.graphCanvasShell.dataset.visibleEdges = String(counts.visibleEdges);
  elements.graphCanvasShell.dataset.totalNodes = String(counts.activeNodes);
  elements.graphCanvasShell.dataset.totalEdges = String(counts.activeEdges);
}

function graphFacts() {
  if (!graphFactsCache || graphFactsGraph !== state.graph) {
    graphFactsCache = projectAccessibleGraphOutline(state.graph, criticalIdeaByNodeKey);
    graphFactsGraph = state.graph;
  }
  return graphFactsCache;
}

function graphSourceIds(attributes) {
  return [...new Set([...(attributes.sourceAnchorIds || []),
    ...(attributes.structuralCoverage || []).map((range) => range.primaryAnchorId)])];
}

function invalidateGraphNavigation() {
  graphNavigationGeneration += 1;
  pendingGraphNavigation = null;
}

function isCurrentGraphNavigation(request) {
  return pendingGraphNavigation === request && request.generation === graphNavigationGeneration
    && request.paperRef === state.paper.paperRef && request.anchorId === state.focusAnchorId
    && state.anchors.has(request.anchorId)
    && (!request.nodeKey || (state.graph.hasNode(request.nodeKey) && state.graph.getNodeAttribute(request.nodeKey, "status") === "active"))
    && (!request.edgeKey || (state.graph.hasEdge(request.edgeKey) && state.graph.getEdgeAttribute(request.edgeKey, "status") === "active"));
}

function synchronizeGraphSourceFocus() {
  if (!state?.graph) return;
  const changed = lastGraphFocusAnchorId !== state.focusAnchorId;
  if (pendingGraphNavigation && pendingGraphNavigation.anchorId !== state.focusAnchorId) invalidateGraphNavigation();
  const previousVisibleNodes = graphVisibleNodeKeys;
  lastGraphFocusAnchorId = state.focusAnchorId;
  linkedFocusNodeKeys = new Set(activeGraphNodeKeys().filter((key) =>
    graphNodeReferencesAnchor(state.graph.getNodeAttributes(key), state.focusAnchorId)));
  linkedFocusEdgeKeys = new Set(state.graph.edges().filter((key) =>
    state.graph.getEdgeAttribute(key, "status") === "active"
      && (state.graph.getEdgeAttribute(key, "sourceAnchorIds") || []).includes(state.focusAnchorId)));
  for (const annotation of state.annotations.values()) {
    if (annotation.status !== "active" || annotationAnchorId(annotation) !== state.focusAnchorId) continue;
    for (const key of annotation.graphNodeKeys || []) {
      if (state.graph.hasNode(key) && state.graph.getNodeAttribute(key, "status") === "active") linkedFocusNodeKeys.add(key);
    }
    for (const key of annotation.graphEdgeKeys || []) {
      if (state.graph.hasEdge(key) && state.graph.getEdgeAttribute(key, "status") === "active") linkedFocusEdgeKeys.add(key);
    }
  }
  const requestedSelection = pendingGraphNavigation && isCurrentGraphNavigation(pendingGraphNavigation)
    && ((pendingGraphNavigation.nodeKey && pendingGraphNavigation.nodeKey === selectedGraphNodeKey)
      || (pendingGraphNavigation.edgeKey && pendingGraphNavigation.edgeKey === selectedGraphEdgeKey));
  if (changed && !requestedSelection && !linkedFocusNodeKeys.has(selectedGraphNodeKey)) {
    selectedGraphNodeKey = [...linkedFocusNodeKeys].sort()[0] || null;
    selectedGraphEdgeKey = null;
  }
  updateGraphSelectionPresentation();
  if (changed && selectedGraphNodeKey && !previousVisibleNodes.has(selectedGraphNodeKey)) fitGraphView();
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
  if (selectedGraphEdgeKey && (!state.graph.hasEdge(selectedGraphEdgeKey)
    || state.graph.getEdgeAttribute(selectedGraphEdgeKey, "status") !== "active")) selectedGraphEdgeKey = null;

  for (const button of elements.graphNudgeButtons) button.disabled = !selectedGraphNodeKey;
  elements.graphLayoutReset.disabled = initialGraphPositions.size === 0;
  for (const item of document.querySelectorAll("[data-graph-node-key]")) {
    const selected = item.dataset.graphNodeKey === selectedGraphNodeKey;
    item.classList.toggle("is-selected", selected);
    item.classList.toggle("is-source-linked", linkedFocusNodeKeys.has(item.dataset.graphNodeKey));
    if (item.matches("button")) item.setAttribute("aria-pressed", String(selected));
  }
  for (const item of document.querySelectorAll("[data-graph-edge-key]")) {
    item.classList.toggle("is-selected", item.dataset.graphEdgeKey === selectedGraphEdgeKey);
  }
  reconcileGraphPresentation();
  renderGraphSelection();
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
  invalidateGraphNavigation();
  const wasVisible = graphVisibleNodeKeys.has(nodeKey);
  selectedGraphNodeKey = nodeKey;
  selectedGraphEdgeKey = null;
  updateGraphSelectionPresentation();
  if (!wasVisible) fitGraphView();
  if (announce) {
    elements.graphLayoutStatus.textContent = `Selected “${graphNodeLabel(nodeKey)}.” Drag it in the map or use the arrow controls. Evidence stays fixed.`;
  }
  return true;
}

async function focusGraphNodeEvidence(nodeKey) {
  if (!selectGraphNode(nodeKey)) return false;
  const attributes = state.graph.getNodeAttributes(nodeKey);
  const anchorId = graphSourceIds(attributes).find((key) => state.anchors.has(key));
  if (!anchorId || !state.anchors.has(anchorId)) {
    elements.graphLayoutStatus.textContent = attributes.authority === "mentor_background"
      ? `Selected “${graphNodeLabel(nodeKey)}.” Mentor background is not a claim made by this paper.`
      : `Selected “${graphNodeLabel(nodeKey)}.” Source incomplete: no paper source is available.`;
    return true;
  }
  return navigateGraphSource(anchorId, { nodeKey, eventType: "graph_node_source_focused" });
}

function selectGraphEdge(edgeKey) {
  if (!state.graph.hasEdge(edgeKey) || state.graph.getEdgeAttribute(edgeKey, "status") !== "active") return false;
  invalidateGraphNavigation();
  const wasVisible = graphVisibleEdgeKeys.has(edgeKey);
  selectedGraphEdgeKey = edgeKey;
  selectedGraphNodeKey = null;
  updateGraphSelectionPresentation();
  if (!wasVisible) fitGraphView();
  return true;
}

async function focusGraphEdgeEvidence(edgeKey, { navigate = true } = {}) {
  if (!selectGraphEdge(edgeKey)) return false;
  const attributes = state.graph.getEdgeAttributes(edgeKey);
  const anchorId = graphSourceIds(attributes).find((key) => state.anchors.has(key));
  if (navigate && anchorId) {
    return navigateGraphSource(anchorId, { edgeKey, eventType: "graph_edge_source_focused" });
  } else if (navigate) {
    elements.graphLayoutStatus.textContent = attributes.authority === "mentor_background"
      ? "This relationship is mentor background, not a paper claim."
      : "Source incomplete: this relationship has no available paper anchor.";
  }
  return true;
}

async function navigateGraphSource(anchorId, { nodeKey = null, edgeKey = null, eventType = "graph_source_focused" } = {}) {
  if (!state.anchors.has(anchorId)) return false;
  if (nodeKey && !selectGraphNode(nodeKey, { announce: false })) return false;
  if (edgeKey && !selectGraphEdge(edgeKey)) return false;
  if (!nodeKey && !edgeKey) invalidateGraphNavigation();
  const request = { generation: graphNavigationGeneration, paperRef: state.paper.paperRef, anchorId, nodeKey, edgeKey };
  pendingGraphNavigation = request;
  state.focusAnchorId = anchorId;
  try {
    const destination = await ensureAnchorVisible(anchorId, {
      moveKeyboardFocus: true, scrollIntoView: true, navigationRequest: request,
    });
    if (!isCurrentGraphNavigation(request)) return false;
    if (!destination) throw new Error("Source destination unavailable");
    if (nodeKey || edgeKey) {
      selectedGraphNodeKey = nodeKey;
      selectedGraphEdgeKey = edgeKey;
      updateGraphSelectionPresentation();
    }
    try {
      recordActivity(eventType, { actor: "human", status: nodeKey || edgeKey || anchorId });
    } catch { /* An optional activity renderer cannot reverse a completed source navigation. */ }
    return true;
  } catch {
    if (!isCurrentGraphNavigation(request)) return false;
    elements.graphLayoutStatus.textContent = "Could not open this paper source. Try another source or the paper controls. Graph and annotation evidence were not changed.";
    try {
      recordActivity("graph_source_navigation_failed", { actor: "human", status: "navigation_failed" });
    } catch { /* Keep the safe associated failure even if activity rendering is unavailable. */ }
    return false;
  } finally {
    if (pendingGraphNavigation === request) pendingGraphNavigation = null;
  }
}

function synchronizeGraphToolNavigation(input, result) {
  const generation = graphToolNavigationGenerations.get(input);
  graphToolNavigationGenerations.delete(input);
  if ((generation !== undefined && generation !== graphNavigationGeneration) || result.anchorId !== state.focusAnchorId) return;
  if (result.targetType === "node" || result.targetType === "section") selectGraphNode(result.targetId, { announce: false });
  else if (result.targetType === "edge") selectGraphEdge(result.targetId);
}

async function navigateObservedPaperSource(anchor, { signal } = {}) {
  const sourceState = state;
  const session = toolSessionGeneration;
  const active = () => !pageLeaving && !signal?.aborted && state === sourceState && session === toolSessionGeneration;
  if (!active()) throw new DOMException("The source request was cancelled.", "AbortError");
  try {
    recordActivity("navigation_callback_observed", { actor: "page", status: anchor.anchorId });
  } catch { /* Optional callback presentation does not control navigation authority. */ }
  try {
    const destination = await ensureAnchorVisible(anchor.anchorId, { moveKeyboardFocus: false, scrollIntoView: true, signal });
    if (!active()) throw new DOMException("The source request was cancelled.", "AbortError");
    if (!destination) throw new Error("Source destination unavailable");
  } catch {
    if (!active()) throw new DOMException("The source request was cancelled.", "AbortError");
    throw new Error("The requested paper source could not be opened. Read the current focus and retry.");
  }
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
  renderGraphPosition();
  sigmaRenderer?.scheduleRefresh({ partialGraph: { nodes: [nodeKey] } });
  if (announce) {
    elements.graphLayoutStatus.textContent = `Moved “${graphNodeLabel(nodeKey)}.” Only its view position changed; provenance and WebMCP facts are unchanged.`;
  }
  if (record) {
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
  fitGraphView();
  renderGraphPosition();
  elements.graphLayoutStatus.textContent = restored
    ? `Reset ${restored} ${restored === 1 ? "node" : "nodes"} to the initial view. Evidence and WebMCP facts were not changed.`
    : "The graph is already in its initial view. Evidence and WebMCP facts were not changed.";
  if (restored) markSnapshotDirty();
}

function clearAnnotationDropIndicators() {
  for (const item of elements.annotationList.querySelectorAll(".is-drop-before, .is-drop-after")) {
    item.classList.remove("is-drop-before", "is-drop-after");
  }
}

function finishAnnotationDrag() {
  const pointer = annotationPointerDrag;
  annotationPointerDrag = null;
  draggedAnnotationId = null;
  draggedAnnotationNodeKey = null;
  if (pointer) {
    pointer.item.classList.remove("is-dragging");
    try {
      if (pointer.handle.hasPointerCapture?.(pointer.pointerId)) pointer.handle.releasePointerCapture(pointer.pointerId);
    } catch { /* A replaced or detached grip may already have lost capture. */ }
  }
  clearAnnotationDropIndicators();
  elements.graphCanvasShell.classList.remove("is-drop-target");
  for (const item of elements.annotationList.querySelectorAll(".is-dragging")) item.classList.remove("is-dragging");
}

function captureAnnotationDragIdentity(annotationId) {
  const annotation = state?.annotations?.get(annotationId);
  const anchorId = annotationAnchorId(annotation);
  const anchor = state?.anchors?.get(anchorId);
  if (!annotation || annotation.status !== "active" || annotation.paperRef !== state.paper.paperRef || !anchor) return null;
  return {
    annotationId,
    nodeKey: linkedGraphNode(annotation),
    signature: canonicalJson({
      paperRef: state.paper.paperRef,
      annotationId,
      entityRevision: annotation.entityRevision,
      anchorId,
      anchorDigest: anchor.anchorDigest,
      graphNodeKeys: [...(annotation.graphNodeKeys || [])].sort(),
      graphEdgeKeys: [...(annotation.graphEdgeKeys || [])].sort(),
    }),
  };
}

function currentAnnotationPointerDrag(event) {
  const gesture = annotationPointerDrag;
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return null;
  const current = captureAnnotationDragIdentity(gesture.identity.annotationId);
  if (!gesture.handle.isConnected || !current || current.signature !== gesture.identity.signature
    || current.nodeKey !== gesture.identity.nodeKey) return null;
  return gesture;
}

function beginAnnotationPointerDrag(event, annotationId, handle, item) {
  if (event.button !== 0 || event.isPrimary === false || annotationPointerDrag
    || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)
    || typeof handle.setPointerCapture !== "function" || !elements.annotationList.contains(item)
    || item.dataset.annotationId !== annotationId) return false;
  const identity = captureAnnotationDragIdentity(annotationId);
  if (!identity) return false;
  event.preventDefault();
  annotationPointerDrag = { pointerId: event.pointerId, handle, item, identity,
    startX: event.clientX, startY: event.clientY, moved: false };
  draggedAnnotationId = identity.annotationId;
  draggedAnnotationNodeKey = identity.nodeKey;
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    finishAnnotationDrag();
    return false;
  }
  return true;
}

function annotationPointerDestination(clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const target = document.elementFromPoint(clientX, clientY);
  const row = target?.closest?.("[data-annotation-id]");
  const annotationId = row?.dataset.annotationId;
  if (row && elements.annotationList.contains(row) && annotationId !== draggedAnnotationId
    && captureAnnotationDragIdentity(annotationId)) {
    const rect = row.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.height) || rect.height <= 0) return null;
    return { kind: "annotation", annotationId, row, placement: clientY < rect.top + rect.height / 2 ? "before" : "after" };
  }
  if (target && elements.sigmaContainer.contains(target) && sigmaRenderer && currentDraggedAnnotationNode()) return { kind: "graph" };
  return null;
}

function moveAnnotationPointerDrag(event) {
  if (!annotationPointerDrag || event.pointerId !== annotationPointerDrag.pointerId) return;
  const gesture = currentAnnotationPointerDrag(event);
  if (!gesture) { finishAnnotationDrag(); return; }
  event.preventDefault();
  if (!gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 5) return;
  gesture.moved = true;
  gesture.item.classList.add("is-dragging");
  clearAnnotationDropIndicators();
  elements.graphCanvasShell.classList.remove("is-drop-target");
  const destination = annotationPointerDestination(event.clientX, event.clientY);
  if (destination?.kind === "annotation") destination.row.classList.add(`is-drop-${destination.placement}`);
  else if (destination?.kind === "graph") elements.graphCanvasShell.classList.add("is-drop-target");
}

function placeDraggedAnnotationNode(clientX, clientY) {
  const nodeKey = currentDraggedAnnotationNode();
  if (!nodeKey || !sigmaRenderer || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  if (!selectGraphNode(nodeKey, { announce: false })) return false;
  const bounds = elements.sigmaContainer.getBoundingClientRect();
  const position = sigmaRenderer.viewportToGraph({ x: clientX - bounds.left, y: clientY - bounds.top });
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  const annotation = state.annotations.get(draggedAnnotationId);
  const body = annotation?.body || annotation?.label || draggedAnnotationId;
  const changed = setGraphNodePosition(nodeKey, position);
  elements.annotationLayoutStatus.textContent = `Placed the linked idea for “${body}” in the map. The PDF annotation itself did not move.`;
  return changed;
}

function finishAnnotationPointerDrag(event) {
  if (!annotationPointerDrag || event.pointerId !== annotationPointerDrag.pointerId) return false;
  const gesture = currentAnnotationPointerDrag(event);
  try {
    if (!gesture?.moved) return false;
    event.preventDefault();
    const destination = annotationPointerDestination(event.clientX, event.clientY);
    if (destination?.kind === "annotation") return reorderAnnotation(gesture.identity.annotationId, destination.annotationId, destination.placement);
    if (destination?.kind === "graph") return placeDraggedAnnotationNode(event.clientX, event.clientY);
    return false;
  } finally {
    finishAnnotationDrag();
  }
}

function cancelAnnotationPointerDrag(event) {
  if (annotationPointerDrag && (!event || event.pointerId === annotationPointerDrag.pointerId)) finishAnnotationDrag();
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
  renderAnnotations();
  markSnapshotDirty();
  if (direction) focusReorderButton(annotationId, direction);
  return true;
}

function structuralRangeLabel(startPageIndex, endPageIndex) {
  return startPageIndex === endPageIndex
    ? `Page ${startPageIndex + 1}`
    : `Pages ${startPageIndex + 1}–${endPageIndex + 1}`;
}

function structuralBasisLabel(basis) {
  if (basis === "pdf_outline") return "PDF outline";
  if (basis === "heading_heuristic") return "Detected heading · provisional";
  return "Page fallback";
}

function semanticPagesInCurrentGraph() {
  const pages = new Set();
  if (!state?.graph) return pages;
  state.graph.forEachNode((_key, attributes) => {
    if (attributes.status !== "active" || attributes.authority !== "paper_grounded") return;
    for (const anchorId of attributes.sourceAnchorIds || []) {
      const anchor = state.anchors.get(anchorId);
      if (anchor) pages.add(anchor.pageIndex);
    }
  });
  return pages;
}

async function focusStructuralRange(node) {
  const graphNode = state?.graph?.hasNode(node.key) ? state.graph.getNodeAttributes(node.key) : null;
  const structuralCoverage = graphNode?.structuralCoverage?.[0];
  const anchorId = structuralCoverage?.primaryAnchorId;
  if (!anchorId || !state.anchors.has(anchorId)) {
    elements.paperMapStatus.textContent = `${node.label} has incomplete page provenance and cannot be opened from the map.`;
    return false;
  }
  state.focusAnchorId = anchorId;
  recordActivity("structural_source_focused", {
    actor: "human",
    status: `${node.key} · ${node.startPageIndex + 1}-${node.endPageIndex + 1}`,
  });
  await ensureAnchorVisible(anchorId, { moveKeyboardFocus: true, scrollIntoView: true });
  elements.paperMapStatus.textContent = `${graphNode.label || node.label} covers ${structuralRangeLabel(node.startPageIndex, node.endPageIndex).toLocaleLowerCase("en-US")}. Moved to page ${node.startPageIndex + 1} of ${paperStructuralMap.pageCount}.`;
  return true;
}

function renderStructuralMap() {
  elements.paperPageLedger.replaceChildren();
  elements.paperStructureList.replaceChildren();
  if (!paperStructuralMap || !state?.structuralMap) {
    elements.paperMapState.textContent = "Waiting";
    elements.paperMapState.dataset.state = "waiting";
    elements.paperMapStatus.textContent = "Waiting for the verified page index.";
    elements.paperMapProgress.max = 1;
    elements.paperMapProgress.value = 0;
    elements.paperMapProgress.setAttribute("aria-valuetext", "No pages mapped");
    elements.paperMapIndexed.textContent = "0";
    elements.paperMapNavigable.textContent = "0";
    elements.paperMapLimited.textContent = "0";
    elements.paperMapFailed.textContent = "0";
    elements.paperStructureCount.textContent = "0 ranges";
    appendTextListItem(elements.paperStructureList, "Paper structure has not been built.");
    return;
  }

  const { counts, coverage, nodes, status, pageCount } = paperStructuralMap;
  const semanticPages = semanticPagesInCurrentGraph();
  const stateLabel = status === "structural_ready" ? "Map ready" : status === "structural_partial" ? "Map partial" : "Map unavailable";
  const stateKind = status === "structural_ready" ? "ready" : status === "structural_partial" ? "partial" : "failed";
  elements.paperMapState.textContent = stateLabel;
  elements.paperMapState.dataset.state = stateKind;
  elements.paperMapStatus.textContent = status === "structural_ready"
    ? `Map ready · ${counts.navigablePages} of ${pageCount} pages navigable${counts.limitedPages ? ` · ${counts.limitedPages} limited` : ""}.`
    : status === "structural_partial"
      ? `Map partial · ${counts.navigablePages} of ${pageCount} pages navigable · ${counts.failedPages} failed.`
      : "Map unavailable · no navigable page structure.";
  elements.paperMapProgress.max = pageCount;
  elements.paperMapProgress.value = counts.navigablePages;
  elements.paperMapProgress.textContent = `${counts.navigablePages} of ${pageCount} pages navigable`;
  elements.paperMapProgress.setAttribute(
    "aria-valuetext",
    `${counts.navigablePages} of ${pageCount} pages navigable; ${counts.limitedPages} limited; ${counts.failedPages} failed`,
  );
  elements.paperMapIndexed.textContent = String(pageCount);
  elements.paperMapNavigable.textContent = String(counts.navigablePages);
  elements.paperMapLimited.textContent = String(counts.limitedPages);
  elements.paperMapFailed.textContent = String(counts.failedPages);
  elements.paperPageLedger.style.setProperty("--page-count", String(pageCount));
  for (const entry of coverage) {
    const segment = document.createElement("span");
    segment.classList.toggle("is-limited", entry.mappingState === "limited");
    segment.classList.toggle("is-failed", entry.mappingState === "failed");
    segment.classList.toggle("has-semantic", semanticPages.has(entry.pageIndex));
    segment.title = `Page ${entry.pageLabel} · ${humanReadable(entry.mappingState)}${semanticPages.has(entry.pageIndex) ? " · idea evidence present" : ""}`;
    elements.paperPageLedger.append(segment);
  }

  const unavailablePages = coverage.filter(({ mappingState }) => mappingState === "failed");
  elements.paperStructureCount.textContent = `${nodes.length} ${nodes.length === 1 ? "range" : "ranges"}${unavailablePages.length ? ` · ${unavailablePages.length} unavailable` : ""}`;
  for (const node of nodes) {
    const graphNode = state.graph.hasNode(node.key) ? state.graph.getNodeAttributes(node.key) : null;
    const active = graphNode?.status === "active";
    const item = document.createElement("li");
    if (node.limited) item.classList.add("is-limited");
    if (!active) item.classList.add("is-failed");
    item.dataset.graphNodeKey = node.key;
    const label = document.createElement("strong");
    label.className = "paper-structure-label";
    label.textContent = graphNode?.label || node.label;
    const meta = document.createElement("p");
    meta.className = "paper-structure-meta";
    const range = document.createElement("span");
    range.textContent = structuralRangeLabel(node.startPageIndex, node.endPageIndex);
    const authority = document.createElement("span");
    authority.textContent = "Document structure";
    const basis = document.createElement("span");
    basis.textContent = structuralBasisLabel(node.basis);
    const limitation = document.createElement("span");
    limitation.textContent = active ? (node.limited ? "Limited text" : "Navigable") : "Removed from active graph";
    meta.append(range, authority, basis, limitation);
    const summary = document.createElement("p");
    summary.className = "paper-structure-summary";
    summary.textContent = graphNode?.summary || node.summary;
    const actions = document.createElement("div");
    actions.className = "paper-structure-actions";
    const sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.disabled = !active;
    sourceButton.textContent = `Go to page ${node.startPageIndex + 1}`;
    sourceButton.setAttribute(
      "aria-label",
      `Go to ${graphNode?.label || node.label}, ${structuralRangeLabel(node.startPageIndex, node.endPageIndex)}; ${structuralBasisLabel(node.basis)}`,
    );
    sourceButton.addEventListener("click", () => { void focusStructuralRange(node); });
    actions.append(sourceButton);
    item.append(label, meta, summary, actions);
    elements.paperStructureList.append(item);
  }
  for (const page of unavailablePages) {
    const item = document.createElement("li");
    item.className = "is-failed";
    const label = document.createElement("strong");
    label.className = "paper-structure-label";
    label.textContent = `Page ${page.pageLabel} · source unavailable`;
    const summary = document.createElement("p");
    summary.className = "paper-structure-summary";
    summary.textContent = "This page remains explicit in coverage but was not promoted into a navigable structural leaf.";
    item.append(label, summary);
    elements.paperStructureList.append(item);
  }
}

function renderCriticalIdeaMap() {
  elements.criticalIdeaList.replaceChildren();
  if (!paperAnalysis || !state?.automaticMap) {
    elements.criticalIdeaCount.textContent = "0";
    elements.criticalIdeaCount.setAttribute("aria-label", "0 unreviewed idea candidates");
    appendTextListItem(elements.criticalIdeaList, "No grounded, unreviewed idea candidates are available.");
    return;
  }
  const ordered = [...paperAnalysis.candidates].sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
  const activeCount = ordered.filter((candidate) => (
    state.graph.hasNode(candidate.key) && state.graph.getNodeAttribute(candidate.key, "status") === "active"
  )).length;
  elements.criticalIdeaCount.textContent = String(activeCount);
  elements.criticalIdeaCount.setAttribute(
    "aria-label",
    `${activeCount} active unreviewed idea ${activeCount === 1 ? "candidate" : "candidates"}`,
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
    origin.textContent = attributes?.origin === "agent" ? "Agent refined" : "Automatically suggested · unreviewed";
    const stateLabel = document.createElement("span");
    stateLabel.textContent = isActive ? "Paper-grounded" : "Removed from map";
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

function graphSourceActions(sourceIds, { nodeKey = null, edgeKey = null } = {}) {
  const actions = document.createElement("div");
  actions.className = "graph-source-actions";
  for (const [index, anchorId] of sourceIds.entries()) {
    const anchor = state.anchors.get(anchorId);
    if (!anchor) {
      const missing = document.createElement("span");
      missing.className = "graph-fact-meta";
      missing.textContent = `Source ${index + 1} incomplete`;
      actions.append(missing);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.interactionKey = `source:${anchorId}`;
    button.textContent = `Page ${anchor.pageLabel} · ${humanReadable(anchor.sourceKind)}`;
    button.setAttribute("aria-label", `Go to source ${index + 1} on page ${anchor.pageLabel}, ${humanReadable(anchor.sourceKind)}`);
    button.addEventListener("click", async () => {
      await navigateGraphSource(anchorId, { nodeKey, edgeKey });
    });
    actions.append(button);
  }
  return actions;
}

function graphRelationList(edgeKeys, nodeKey = null) {
  const list = document.createElement("ul");
  list.className = "graph-relations";
  const edges = new Map(graphFacts().edges.map((edge) => [edge.key, edge]));
  for (const edgeKey of edgeKeys) {
    const edge = edges.get(edgeKey);
    if (!edge) continue;
    const item = document.createElement("li");
    const direction = nodeKey ? edge.sourceKey === nodeKey ? "Outgoing" : "Incoming" : "Relationship";
    const title = `${direction}: ${edge.sourceLabel} → ${humanReadable(edge.relation)} → ${edge.targetLabel}`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.dataset.graphEdgeKey = edgeKey;
    button.dataset.interactionKey = `relation:${edgeKey}`;
    button.disabled = edge.status !== "active";
    button.addEventListener("click", () => { void focusGraphEdgeEvidence(edgeKey); });
    const evidence = document.createElement("div");
    evidence.className = "graph-fact-meta";
    evidence.textContent = `${humanReadable(edge.authority)} · ${humanReadable(edge.origin)} · ${edge.sourceStatusText} · ${edge.statusText}`;
    item.append(button, evidence);
    list.append(item);
  }
  return list;
}

function renderGraphPosition() {
  const position = selectedGraphNodeKey && state.graph.hasNode(selectedGraphNodeKey)
    ? clampGraphPosition(state.graph.getNodeAttributes(selectedGraphNodeKey)) : null;
  elements.graphSelectionPosition.textContent = position
    ? `View position ${position.x.toFixed(2)}, ${position.y.toFixed(2)} · not evidence` : "";
  elements.graphSelectionPosition.dataset.nodeKey = selectedGraphNodeKey || "";
}

function graphCandidateStateText(fact) {
  if (fact.candidateState === "agent refined") return "agent refined, unreviewed";
  if (fact.candidateState) return fact.candidateState;
  return fact.origin === "automatic_map" && fact.authority !== "document_structure"
    ? "automatically suggested, unreviewed" : "";
}

function renderGraphSelection() {
  const key = selectedGraphEdgeKey || selectedGraphNodeKey;
  renderGraphPosition();
  if (graphSelectionStamp?.key === key && graphSelectionStamp.graph === state.graph) return;
  const previousRelationships = elements.graphSelectionDetail.querySelector("details[data-selection-relations]");
  if (previousRelationships && graphSelectionStamp?.key) {
    graphSelectionDisclosureStates.set(graphSelectionStamp.key, previousRelationships.open);
  }
  graphSelectionStamp = { key, graph: state.graph };
  const outline = graphFacts();
  const fact = selectedGraphEdgeKey ? outline.edges.find((edge) => edge.key === key)
    : outline.nodes.find((node) => node.key === key);
  elements.graphSelectionDetail.replaceChildren();
  elements.graphSelection.dataset.interactionKey = key || "no-selection";
  if (!fact) {
    elements.graphSelectionHeading.textContent = "Choose an idea";
    elements.graphSelectionMeta.textContent = "Open a node to see its source and connections. Arrange moves only its position.";
    return;
  }
  elements.graphSelectionHeading.textContent = fact.type === "node" ? fact.label
    : `${fact.sourceLabel} → ${humanReadable(fact.relation)} → ${fact.targetLabel}`;
  const candidateState = graphCandidateStateText(fact);
  elements.graphSelectionMeta.textContent = `${humanReadable(fact.type === "node" ? fact.kind : fact.relation)} · ${humanReadable(fact.authority)} · ${humanReadable(fact.origin)} · ${fact.statusText}${candidateState ? ` · ${candidateState}` : ""}`;
  const summary = document.createElement("p");
  summary.textContent = fact.summary || (fact.type === "node" ? "No summary added yet." : "No relationship claim added yet.");
  const sourceStatus = document.createElement("p");
  sourceStatus.className = "graph-fact-meta";
  sourceStatus.textContent = `${fact.sourceStatusText}${fact.type === "node" && fact.structuralRangeText ? ` · ${fact.structuralRangeText}` : ""}`;
  elements.graphSelectionDetail.append(summary, sourceStatus, graphSourceActions(fact.sourceIds,
    fact.type === "node" ? { nodeKey: key } : { edgeKey: key }));
  if (fact.type === "node") {
    const edgeKeys = [...new Set([...fact.incomingEdgeKeys, ...fact.outgoingEdgeKeys])];
    if (edgeKeys.length) {
      const details = document.createElement("details");
      details.dataset.selectionRelations = key;
      details.open = graphSelectionDisclosureStates.get(key) === true;
      const heading = document.createElement("summary");
      heading.dataset.interactionKey = "selection-relations";
      heading.textContent = `${edgeKeys.length} directed ${edgeKeys.length === 1 ? "relationship" : "relationships"}`;
      details.append(heading, graphRelationList(edgeKeys, key));
      elements.graphSelectionDetail.append(details);
    }
  }
}

function renderGraphOutline() {
  const openRows = new Set([...elements.graphOutline.querySelectorAll("details[open]")]
    .map((details) => details.closest("li")?.dataset.interactionKey));
  elements.graphOutline.replaceChildren();
  const outline = graphFacts();
  elements.graphOutlineCount.textContent = `· ${outline.nodes.length} nodes / ${outline.edges.length} relationships`;
  for (const fact of [...outline.nodes, ...outline.edges]) {
    const key = fact.key;
    const isNode = fact.type === "node";
    const item = document.createElement("li");
    item.dataset.outlineKind = fact.type;
    item.dataset.interactionKey = key;
    item.dataset.status = fact.status;
    if (isNode) item.dataset.graphNodeKey = key;
    else item.dataset.graphEdgeKey = key;
    item.classList.toggle("graph-fact-tombstoned", fact.status !== "active");
    const title = document.createElement("button");
    title.type = "button";
    title.className = "graph-node-title";
    title.textContent = isNode ? fact.label : `${fact.sourceLabel} → ${humanReadable(fact.relation)} → ${fact.targetLabel}`;
    title.dataset.interactionKey = "open-source";
    title.disabled = fact.status !== "active";
    title.addEventListener("click", () => { void (isNode ? focusGraphNodeEvidence(key) : focusGraphEdgeEvidence(key)); });
    const meta = document.createElement("p");
    meta.className = "graph-fact-meta";
    const candidateState = graphCandidateStateText(fact);
    meta.textContent = `${humanReadable(isNode ? fact.kind : fact.relation)} · ${humanReadable(fact.authority)} · ${humanReadable(fact.origin)} · ${fact.statusText}${candidateState ? ` · ${candidateState}` : ""}`;
    const sources = document.createElement("p");
    sources.className = "graph-fact-meta";
    sources.textContent = `${fact.sourceStatusText}${isNode && fact.structuralRangeText ? ` · ${fact.structuralRangeText}` : ""}`;
    item.append(title, meta, sources);
    if (isNode && fact.status === "active") {
      const actions = document.createElement("div");
      actions.className = "graph-outline-actions";
      const arrange = document.createElement("button");
      arrange.type = "button";
      arrange.dataset.graphNodeKey = key;
      arrange.dataset.interactionKey = "arrange";
      arrange.textContent = "Arrange this node";
      arrange.setAttribute("aria-pressed", String(key === selectedGraphNodeKey));
      arrange.addEventListener("click", () => selectGraphNode(key));
      actions.append(arrange);
      item.append(actions);
    }
    const details = document.createElement("details");
    details.className = "graph-entity-details";
    details.open = openRows.has(key);
    const heading = document.createElement("summary");
    heading.textContent = "Summary, sources & relationships";
    heading.dataset.interactionKey = "entity-details";
    const body = document.createElement("div");
    const summary = document.createElement("p");
    summary.className = "graph-fact-summary";
    summary.textContent = fact.summary || "No summary recorded.";
    body.append(summary, graphSourceActions(fact.sourceIds, isNode ? { nodeKey: key } : { edgeKey: key }));
    if (isNode) {
      const related = [...new Set([...fact.incomingEdgeKeys, ...fact.outgoingEdgeKeys])];
      if (related.length) body.append(graphRelationList(related, key));
      if (fact.structuralRangeText) {
        const structural = document.createElement("p");
        structural.className = "graph-fact-meta";
        structural.textContent = `${fact.structuralBasisText} · ${fact.structuralConfidenceText}`;
        body.append(structural);
      }
    }
    const identity = document.createElement("p");
    identity.className = "graph-entity-key";
    identity.textContent = `${key} · entity revision ${fact.entityRevision ?? "not recorded"}`;
    body.append(identity);
    details.append(heading, body);
    item.append(details);
    elements.graphOutline.append(item);
  }
  updateGraphSelectionPresentation();
}

function renderAnnotations() {
  const openSources = new Set([...elements.annotationList.querySelectorAll("details[open]")]
    .map((details) => details.closest("[data-annotation-id]")?.dataset.annotationId));
  if (pendingRemovalAnnotationId && state.annotations.get(pendingRemovalAnnotationId)?.status !== "active") {
    pendingRemovalAnnotationId = null;
    if (removalConfirmationTimer) clearTimeout(removalConfirmationTimer);
    removalConfirmationTimer = null;
  }
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
    item.tabIndex = 0;
    item.setAttribute(
      "aria-label",
      `${annotationView.summaryText}. ${annotationView.sourceSummary || "Source description unavailable"}. ${annotation.graphNodeKeys?.length || 0} linked graph nodes and ${annotation.graphEdgeKeys?.length || 0} linked graph edges.`,
    );
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
    dragHandle.style.touchAction = "none";
    dragHandle.style.userSelect = "none";
    dragHandle.title = item.title;
    dragHandle.textContent = "⠿";
    dragHandle.setAttribute("aria-hidden", "true");
    dragHandle.addEventListener("pointerdown", (event) => beginAnnotationPointerDrag(event, key, dragHandle, item));
    dragHandle.addEventListener("lostpointercapture", cancelAnnotationPointerDrag);
    const summary = document.createElement("span");
    summary.className = "annotation-card-summary";
    const title = document.createElement("strong");
    title.textContent = body;
    const metadata = document.createElement("small");
    metadata.textContent = `Page ${issuedAnchor?.pageLabel || "?"} · ${humanReadable(annotationView.kind)} · ${humanReadable(annotationView.authority)} · ${annotationView.status}${isAutomatic ? " · unreviewed" : ""}`;
    summary.append(title, metadata);
    head.append(dragHandle, summary);
    item.append(head);
    if (annotationView.sourceSummary) {
      const details = document.createElement("details");
      details.className = "annotation-source-details";
      details.open = openSources.has(key);
      const heading = document.createElement("summary");
      heading.textContent = `Source · page ${issuedAnchor?.pageLabel || "?"} · ${humanReadable(issuedAnchor?.sourceKind || "paper source")}`;
      heading.dataset.interactionKey = "annotation-source-details";
      const sourceSummary = document.createElement("small");
      sourceSummary.className = "annotation-source-summary";
      sourceSummary.textContent = issuedAnchor?.quote?.exact || issuedAnchor?.exactText
        || issuedAnchor?.regionDescription || annotationView.sourceSummary;
      details.append(heading, sourceSummary);
      item.append(details);
    }

    const actions = document.createElement("div");
    actions.className = "annotation-actions";
    if (state.anchors.has(anchor)) {
      const focusButton = document.createElement("button");
      focusButton.type = "button";
      focusButton.textContent = "Go to source";
      focusButton.setAttribute("aria-label", `Go to source for ${body} on page ${issuedAnchor?.pageLabel || "unknown"}`);
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
    if (annotation.authority === "reader" && annotation.status === "active") {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.dataset.removeAnnotation = key;
      removeButton.textContent = pendingRemovalAnnotationId === key ? "Confirm remove" : "Remove from PaperPilot";
      removeButton.setAttribute(
        "aria-label",
        pendingRemovalAnnotationId === key
          ? `Confirm removal of ${body}. The PDF file will not change.`
          : `Remove ${body} from PaperPilot. The PDF file will not change.`,
      );
      removeButton.addEventListener("click", async () => {
        if (pendingRemovalAnnotationId !== key) {
          pendingRemovalAnnotationId = key;
          if (removalConfirmationTimer) clearTimeout(removalConfirmationTimer);
          removalConfirmationTimer = setTimeout(() => {
            if (pendingRemovalAnnotationId !== key) return;
            pendingRemovalAnnotationId = null;
            removalConfirmationTimer = null;
            renderAnnotations();
          }, 6_000);
          elements.annotationLayoutStatus.textContent = `Remove “${body}” and its linked reader idea from PaperPilot? The PDF will not change. Activate Confirm remove to continue.`;
          renderAnnotations();
          requestAnimationFrame(() => elements.annotationList.querySelector(`[data-remove-annotation="${CSS.escape(key)}"]`)?.focus());
          return;
        }
        if (removalConfirmationTimer) clearTimeout(removalConfirmationTimer);
        removalConfirmationTimer = null;
        pendingRemovalAnnotationId = null;
        const activeIds = annotationOrder.filter((annotationId) => state.annotations.get(annotationId)?.status === "active");
        const activeIndex = activeIds.indexOf(key);
        const nextFocusId = activeIds[activeIndex + 1] || activeIds[activeIndex - 1] || null;
        try {
          const result = await removeReaderAnnotation(state, key);
          recordActivity("reader_annotation_removed", { actor: "human", status: key });
          elements.annotationLayoutStatus.textContent = `Removed “${body}” and its linked reader idea from PaperPilot. The PDF file is unchanged; Human Undo is available.`;
          renderLastResult(result);
          renderState();
          markSnapshotDirty();
          requestAnimationFrame(() => {
            const next = nextFocusId
              ? elements.annotationList.querySelector(`[data-annotation-id="${CSS.escape(nextFocusId)}"]`)
              : null;
            (next || elements.annotationList)?.focus?.({ preventScroll: true });
          });
        } catch (error) {
          elements.annotationLayoutStatus.textContent = error?.message || "The reader annotation could not be removed.";
          renderLastResult({ status: "reader_annotation_removal_failed", code: error?.code, message: error?.message });
          renderAnnotations();
        }
      });
      actions.append(removeButton);
    }
    item.append(actions);

    item.addEventListener("dragstart", (event) => {
      if (annotationPointerDrag || event.target !== dragHandle || !captureAnnotationDragIdentity(key)) { event.preventDefault(); return; }
      draggedAnnotationId = key;
      draggedAnnotationNodeKey = nodeKey;
      event.dataTransfer?.setData("text/plain", key);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      item.classList.add("is-dragging");
      // Keep the target cards still until drop; replacing the selection detail
      // or expanding the status here would move them underneath the pointer.
    });
    item.addEventListener("dragover", (event) => {
      if (annotationPointerDrag || !captureAnnotationDragIdentity(draggedAnnotationId) || draggedAnnotationId === key) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      clearAnnotationDropIndicators();
      const rect = item.getBoundingClientRect();
      item.classList.add(event.clientY < rect.top + rect.height / 2 ? "is-drop-before" : "is-drop-after");
    });
    item.addEventListener("drop", (event) => {
      if (annotationPointerDrag || !captureAnnotationDragIdentity(draggedAnnotationId) || !captureAnnotationDragIdentity(key) || draggedAnnotationId === key) return;
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
  graphDragMoved = false;
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
  const wasDragged = graphDragMoved;
  draggedGraphNodeKey = null;
  graphDragStartPosition = null;
  graphDragMoved = false;
  renderer?.getCamera().enable();
  elements.graphCanvasShell.classList.remove("is-node-dragging");
  const current = state.graph.hasNode(nodeKey)
    ? clampGraphPosition(state.graph.getNodeAttributes(nodeKey))
    : null;
  const moved = current && start && (current.x !== start.x || current.y !== start.y);
  if (wasDragged || moved) {
    // Sigma's default drag counter is bypassed by our own movement handler.
    // Suppress the trailing click explicitly so arranging cannot navigate PDF.
    graphClickSuppressedUntil = performance.now() + 350;
    elements.graphLayoutStatus.textContent = `Placed “${graphNodeLabel(nodeKey)}.” Only its view position changed; provenance and WebMCP facts are unchanged.`;
    if (moved) markSnapshotDirty();
  }
  renderer?.refresh();
}

function bindSigmaInteractions(renderer) {
  renderer.on("clickNode", ({ node }) => {
    if (performance.now() < graphClickSuppressedUntil) return;
    void focusGraphNodeEvidence(node);
  });
  renderer.on("clickEdge", ({ edge }) => {
    if (performance.now() < graphClickSuppressedUntil) return;
    void focusGraphEdgeEvidence(edge);
  });
  renderer.on("enterNode", () => elements.graphCanvasShell.classList.add("is-node-hovered"));
  renderer.on("leaveNode", () => elements.graphCanvasShell.classList.remove("is-node-hovered"));
  renderer.on("downNode", ({ node, event, preventSigmaDefault }) => {
    graphClickSuppressedUntil = 0;
    graphDragMoved = false;
    if (!selectGraphNode(node, { announce: false })) return;
    preventSigmaDefault();
    event.original?.preventDefault?.();
    draggedGraphNodeKey = node;
    graphDragStartPosition = clampGraphPosition(state.graph.getNodeAttributes(node));
    const bbox = graphViewportBounds || renderer.getBBox();
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
    if (setGraphNodePosition(draggedGraphNodeKey, position, { announce: false, record: false })) graphDragMoved = true;
  });
  renderer.on("upNode", () => finishGraphNodeDrag(renderer));
  renderer.on("upStage", () => finishGraphNodeDrag(renderer));
}

function fitGraphView({ resetCamera = true } = {}) {
  if (!sigmaRenderer || !graphVisibleNodeKeys.size) return;
  const positions = [...graphVisibleNodeKeys].filter((key) => state.graph.hasNode(key))
    .map((key) => clampGraphPosition(state.graph.getNodeAttributes(key)));
  const xs = positions.map(({ x }) => x);
  const ys = positions.map(({ y }) => y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xPad = Math.max(.22, (xMax - xMin) * .12);
  const yPad = Math.max(.22, (yMax - yMin) * .12);
  graphViewportBounds = { x: [xMin - xPad, xMax + xPad], y: [yMin - yPad, yMax + yPad] };
  sigmaRenderer.setCustomBBox(graphViewportBounds);
  if (resetCamera) sigmaRenderer.getCamera().setState({ x: .5, y: .5, angle: 0, ratio: 1 });
  sigmaRenderer.refresh();
}

function drawGraphNodeLabel(context, data, settings) {
  if (data.viewSelected) {
    context.beginPath();
    context.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
    context.strokeStyle = "#14213d";
    context.lineWidth = 1.5;
    context.stroke();
  }
  if (!data.label) return;
  const size = settings.labelSize;
  const label = graphDisplayLabel(data.label, { maxLength: 26 });
  const words = label.split(" ");
  const lines = [""];
  for (const word of words) {
    const line = lines.length - 1;
    if (lines[line] && `${lines[line]} ${word}`.length > 15 && lines.length < 2) lines.push(word);
    else lines[line] += `${lines[line] ? " " : ""}${word}`;
  }
  context.font = `600 ${size}px ${settings.labelFont}`;
  context.textAlign = "center";
  context.textBaseline = "top";
  for (const [index, line] of lines.entries()) {
    const text = graphDisplayLabel(line, { maxLength: 17 });
    const y = data.y + data.size + 4 + index * (size + 2);
    const x = Math.max(50, Math.min(context.canvas.width / (window.devicePixelRatio || 1) - 50, data.x));
    context.fillStyle = "rgba(251,249,254,.92)";
    context.fillRect(x - context.measureText(text).width / 2 - 2, y - 1, context.measureText(text).width + 4, size + 3);
    context.fillStyle = "#14213d";
    context.fillText(text, x, y);
  }
}

function renderSigma() {
  // A hidden tab has no measurable canvas. Keep its renderer/camera until the
  // reader returns, then bind the latest graph without reporting a false error.
  if (activeRailView === "evidence") return;
  if (!elements.sigmaContainer.isConnected || elements.sigmaContainer.offsetWidth <= 0 || elements.sigmaContainer.offsetHeight <= 0) {
    disposeSigma();
    elements.rendererStatus.textContent = "Outline fallback · no drawing area";
    showGraphFallback("The visual map has no available drawing area. Every node, relationship and source remains in the complete outline.");
    return;
  }
  const cameraState = sigmaRenderer?.getCamera().getState();
  const preservedBounds = graphViewportBounds;
  if (sigmaGraph !== state.graph) disposeSigma();
  if (sigmaRenderer) {
    try {
      sigmaRenderer.refresh();
      elements.rendererStatus.textContent = "Sigma active + outline";
      elements.graphVisualFallback.hidden = true;
      return;
    } catch (error) {
      disposeSigma();
      recordActivity("sigma_refresh_failed", { status: error?.name || "error" });
    }
  }

  const SigmaConstructor = globalThis.Sigma?.default || globalThis.Sigma;
  if (typeof SigmaConstructor !== "function") {
    elements.rendererStatus.textContent = "Outline fallback · Sigma missing";
    showGraphFallback("The visual map is unavailable. Every node, relationship and source remains in the complete outline.");
    return;
  }

  try {
    sigmaRenderer = new SigmaConstructor(state.graph, elements.sigmaContainer, {
      // Sigma 3.0.3 also schedules its own resize frames. A frame queued before
      // switching to Evidence can see zero dimensions; this documented setting
      // permits that transient state without swallowing unrelated WebGL errors.
      allowInvalidContainer: true,
      enableEdgeEvents: true,
      enableCameraRotation: false,
      renderEdgeLabels: false,
      defaultEdgeType: "arrow",
      defaultNodeColor: "#6456d6",
      defaultEdgeColor: "#8794a8",
      labelFont: "Inter, ui-sans-serif, system-ui, sans-serif",
      labelSize: 10,
      labelRenderedSizeThreshold: 0,
      labelDensity: .7,
      labelGridCellSize: 55,
      stagePadding: 35,
      minCameraRatio: .15,
      maxCameraRatio: 4,
      zoomDuration: prefersReducedMotion() ? 0 : 120,
      doubleClickZoomingDuration: prefersReducedMotion() ? 0 : 120,
      defaultDrawNodeLabel: drawGraphNodeLabel,
      defaultDrawNodeHover: drawGraphNodeLabel,
      nodeReducer(node, data) {
        if (!graphVisibleNodeKeys.has(node) || !state.graph.hasNode(node) || state.graph.getNodeAttribute(node, "status") !== "active") {
          return { ...data, hidden: true };
        }
        const selected = node === selectedGraphNodeKey;
        const linked = linkedFocusNodeKeys.has(node)
          || (selectedGraphEdgeKey && [state.graph.source(selectedGraphEdgeKey), state.graph.target(selectedGraphEdgeKey)].includes(node));
        const attributes = state.graph.getNodeAttributes(node);
        const color = attributes.origin === "reader" ? "#267c69"
          : attributes.origin === "agent" ? "#c7513b" : attributes.authority === "document_structure" ? "#718598" : "#6456d6";
        return {
          ...data,
          label: graphDisplayLabel(attributes.label || node, { maxLength: 32 }),
          color,
          viewSelected: selected,
          highlighted: selected || linked,
          forceLabel: selected || linked,
          size: selected ? 8 : attributes.kind === "paper" ? 7 : linked ? 6 : 4.5,
          zIndex: selected ? 3 : linked ? 2 : 1,
        };
      },
      edgeReducer(edge, data) {
        if (!state.graph.hasEdge(edge)) return { ...data, hidden: true };
        const source = state.graph.source(edge);
        const target = state.graph.target(edge);
        const hidden = !graphVisibleEdgeKeys.has(edge) || state.graph.getEdgeAttribute(edge, "status") !== "active"
          || state.graph.getNodeAttribute(source, "status") !== "active"
          || state.graph.getNodeAttribute(target, "status") !== "active";
        const emphasized = edge === selectedGraphEdgeKey || linkedFocusEdgeKeys.has(edge)
          || source === selectedGraphNodeKey || target === selectedGraphNodeKey;
        return hidden ? { ...data, hidden: true } : { ...data, size: emphasized ? 1.8 : .7,
          color: emphasized ? "#a93625" : "#b9b2c9", zIndex: emphasized ? 2 : 0 };
      },
    });
    sigmaGraph = state.graph;
    bindSigmaInteractions(sigmaRenderer);
    if (preservedBounds) {
      graphViewportBounds = preservedBounds;
      sigmaRenderer.setCustomBBox(preservedBounds);
      if (cameraState) sigmaRenderer.getCamera().setState(cameraState);
      sigmaRenderer.refresh();
    } else fitGraphView();
    elements.graphVisualFallback.hidden = true;
    elements.rendererStatus.textContent = "Sigma active + outline";
    recordActivity("sigma_renderer_ready", { status: SPIKE_VERSIONS.sigma });
  } catch (error) {
    disposeSigma();
    elements.rendererStatus.textContent = "Accessible outline fallback";
    showGraphFallback("The visual map could not render. Use the complete outline: sources, relationships and keyboard controls still work.");
    recordActivity("sigma_renderer_fallback", { status: error?.name || "error" });
  }
}

function showGraphFallback(message) {
  elements.graphVisualFallback.textContent = message;
  elements.graphVisualFallback.hidden = false;
  elements.graphOutlineDetails.open = true;
}

let lastInteractionRenderStamp = null;

function workspaceInteractionAvailable(element) {
  if (!element?.isConnected || element.disabled || element.closest("[hidden], [inert]")) return false;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName !== "DETAILS" || ancestor.open) continue;
    // A closed details exposes only its own summary. Check every ancestor:
    // an inner summary is still hidden when an outer disclosure is closed.
    const summary = ancestor.querySelector(":scope > summary");
    if (!summary?.contains(element)) return false;
  }
  return true;
}

function workspaceInteractionTargets() {
  const targets = [];
  for (const region of [elements.paperStructureList, elements.criticalIdeaList, elements.graphOutline, elements.graphSelectionDetail,
    elements.annotationList, elements.graphSearchResults, elements.mentorExplanationBody, elements.workspaceRevisionList]) {
    for (const element of region.querySelectorAll("button, summary, a[href], [tabindex]")) {
      const row = element.closest("[data-annotation-id]") || element.closest("[data-mentor-section-key]")
        || element.closest("li[data-interaction-key]") || element.closest("li[data-graph-node-key]")
        || element.closest("[data-graph-node-key]") || element.closest("[data-interaction-key]");
      const rowKey = row?.dataset.annotationId || row?.dataset.graphNodeKey || row?.dataset.interactionKey || row?.dataset.mentorSectionKey
        || element.dataset.interactionKey || element.id;
      if (!rowKey) continue;
      const action = element.dataset.interactionKey || element.dataset.reorderDirection
        || (element.dataset.removeAnnotation ? "remove-annotation" : null)
        || (element === row ? "card" : element.tagName === "SUMMARY" ? "disclosure" : element.textContent);
      targets.push({
        key: JSON.stringify([region.id, rowKey, action]),
        regionKey: region.id,
        rowKey,
        available: workspaceInteractionAvailable(element),
        element,
      });
    }
  }
  for (const element of [...elements.graphNudgeButtons, elements.graphLayoutReset]) {
    const action = element.dataset.graphNudge ? `nudge:${element.dataset.graphNudge}` : "reset-layout";
    targets.push({
      key: JSON.stringify([elements.graphVisualWorkspace.id, "arrangement", action]),
      regionKey: elements.graphVisualWorkspace.id,
      rowKey: "arrangement",
      available: workspaceInteractionAvailable(element),
      element,
    });
  }
  return targets;
}

function captureWorkspaceInteraction() {
  const targets = workspaceInteractionTargets();
  const active = targets.find(({ element }) => element === document.activeElement);
  return { element: active?.element, bookmark: captureFocusBookmark(active?.key || null, targets) };
}

function restoreWorkspaceInteraction(previous) {
  if (!previous.bookmark || workspaceInteractionAvailable(previous.element)) return;
  // Do not override an intentional focus change made elsewhere during rendering.
  if (document.activeElement && document.activeElement !== document.body && document.activeElement !== previous.element) return;
  const targets = workspaceInteractionTargets();
  const disabledArrangement = previous.bookmark.target.regionKey === elements.graphVisualWorkspace.id
    && previous.element?.disabled;
  const key = disabledArrangement ? null : resolveFocusBookmark(previous.bookmark, targets);
  const target = targets.find((entry) => entry.key === key)?.element;
  if (target) {
    target.focus({ preventScroll: true });
    return;
  }
  const region = byId(previous.bookmark.target.regionKey);
  const fallback = region === elements.mentorExplanationBody ? byId("mentor-explanation-heading")
    : region === elements.annotationList ? elements.annotationList : byId("graph-heading");
  fallback?.setAttribute("tabindex", "-1");
  fallback?.focus({ preventScroll: true });
}

let renderedRevisionHead = null;
function renderWorkspaceHistory() {
  const entries = state.revisions || [];
  const latest = entries.at(-1);
  const stamp = `${state.paper.paperRef}:${latest?.revisionId || "baseline"}:${state.history.length}:${state.redoHistory.length}`;
  if (stamp === renderedRevisionHead) return;
  renderedRevisionHead = stamp;
  const actor = latest?.actor === "agent" ? "Agent" : "You";
  elements.workspaceChangeStatus.textContent = latest
    ? `${actor} ${latest.kind === "undo" ? "undid a change" : latest.kind === "redo" ? "redid a change" : "changed the workspace"} · ${latest.forwardPatch.length} ${latest.forwardPatch.length === 1 ? "record" : "records"} · ${!elements.humanUndo.disabled ? "Undo available" : "Nothing to undo"}${state.redoHistory.length ? elements.humanRedo.disabled ? " · Redo retained; history limit reached" : " · Redo available" : ""}${latest.actor === "agent" ? " · Unreviewed" : ""}`
    : state.history.length || state.redoHistory.length
      ? "Older reversible history restored. New changes will appear here; original activity is in Evidence."
      : "No edits yet. Changes to the map and annotations stay reversible.";
  const disclosureState = new Set([...elements.workspaceRevisionList.querySelectorAll("details[open]")].map((element) => element.dataset.revisionId));
  elements.workspaceRevisionList.replaceChildren();
  // Display window only: the complete bounded ledger is retained in state.
  for (const revision of entries.slice(-20).reverse()) {
    const row = document.createElement("li");
    row.dataset.interactionKey = revision.revisionId;
    const detail = document.createElement("details");
    detail.dataset.revisionId = revision.revisionId;
    detail.open = disclosureState.has(revision.revisionId);
    const title = document.createElement("summary");
    title.textContent = `Revision ${revision.toRevision} · ${revision.actor === "agent" ? "Agent · Unreviewed" : "Human"} · ${revision.reason}`;
    detail.append(title);
    const edits = document.createElement("ul");
    for (const operation of revision.forwardPatch) {
      const from = operation.before;
      const to = operation.after;
      const action = !from ? "Created" : !to ? "Removed by Undo" : from.status !== to.status
        ? to.status === "tombstoned" ? "Removed in-app" : "Restored" : "Updated";
      const label = to?.label || from?.label || to?.claim || from?.claim || operation.key;
      const item = document.createElement("li");
      item.textContent = `${action} ${operation.op.slice(4)}: ${label}`;
      if (from && to) {
        const changes = Object.keys(to).filter((key) => !["entityRevision", "updatedAt", "createdAt"].includes(key) && JSON.stringify(from[key]) !== JSON.stringify(to[key]));
        const values = document.createElement("p");
        values.textContent = changes.map((key) => `${key}: ${JSON.stringify(from[key])} → ${JSON.stringify(to[key])}`).join("; ");
        item.append(values);
      }
      edits.append(item);
    }
    const integrity = document.createElement("p");
    integrity.textContent = `Workspace ${revision.beforeWorkspaceDigest.slice(0, 12)}… → ${revision.afterWorkspaceDigest.slice(0, 12)}… · ${revision.inversePatch.length} inverse records retained · ${revision.sourceAnchorIds.length} source anchors`;
    detail.append(edits, integrity);
    row.append(detail);
    elements.workspaceRevisionList.append(row);
  }
  if (!entries.length) appendTextListItem(elements.workspaceRevisionList, "No new revision recorded in this session history.");
}

let humanHistoryBusy = false;
function handleHistoryShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
  const key = event.key.toLowerCase();
  const direction = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey ? "redo" : null;
  if (!direction || document.body.classList.contains("is-waiting-for-paper")) return;
  event.preventDefault();
  if (!(direction === "undo" ? elements.humanUndo : elements.humanRedo).disabled) void performHumanHistoryAction(direction);
}

async function performHumanHistoryAction(direction) {
  if (humanHistoryBusy) return;
  humanHistoryBusy = true;
  try {
    const result = await (direction === "undo" ? undoLastHumanChange(state) : redoLastHumanChange(state));
    recordActivity(`human_${direction}_control`, { actor: "human", status: result.status });
    renderLastResult(result);
    renderState();
    if (result.status === "undone" || result.status === "redone") markSnapshotDirty();
  } catch (error) {
    const message = `Cannot ${direction} this change. ${error?.message || "The current workspace was preserved."}`;
    elements.workspaceChangeStatus.textContent = message;
    recordActivity(`human_${direction}_failed`, { actor: "human", status: error?.code || "history_failed" });
  } finally {
    humanHistoryBusy = false;
  }
}

function renderState() {
  const nextStamp = {
    documentKey: `${state.paper.paperRef}:${state.paper.documentSha256}`,
    graph: state.graph,
    workspaceRevision: state.workspaceRevision,
    workspaceDigest: state.workspaceDigest,
    anchorCount: state.anchors.size,
    mentorKey: JSON.stringify([[state.explanations, savedExplanations].map((explanations) => explanations.map(
      ({ explanationId, responseDigest, humanDecision, savedAt, takeaway }) => [explanationId, responseDigest, humanDecision, savedAt, takeaway],
    )), [...state.anchors.keys()].sort(), state.graphDigest]),
  };
  const refresh = planInteractionRefresh(lastInteractionRenderStamp, nextStamp);
  const interaction = refresh.content || refresh.mentor ? captureWorkspaceInteraction() : null;
  // A projection error may trigger a reducer rollback. Do not leave a cache
  // stamp that would mistake its required repaint for an unchanged workspace.
  if (refresh.content || refresh.mentor) lastInteractionRenderStamp = null;
  elements.workspaceStatus.textContent = `Revision ${state.workspaceRevision} · ${state.workspaceDigest.slice(0, 10)}…`;
  elements.visualMode.textContent = `Evidence mode: ${state.visualEvidenceMode}`;
  elements.humanUndo.disabled = state.history.length === 0 || state.revisions.length >= LIMITS.workspaceRevisions;
  elements.humanRedo.disabled = state.redoHistory.length === 0 || state.revisions.length + state.history.length + 2 > LIMITS.workspaceRevisions;
  renderWorkspaceHistory();
  if (refresh.content) {
    reconcileGraphPresentation();
    syncPersistedAnnotationOverlays();
  }
  renderFocus();
  if (refresh.content) {
    renderStructuralMap();
    renderCriticalIdeaMap();
    renderGraphOutline();
    renderAnnotations();
    if (elements.graphSearchQuery.value.trim() || elements.graphFilterKind.value || elements.graphFilterAuthority.value) renderGraphSearch();
    renderSigma();
  }
  if (refresh.mentor) renderMentorExplanation();
  renderBrowserSaveState();
  if (interaction) restoreWorkspaceInteraction(interaction);
  lastInteractionRenderStamp = nextStamp;
}

function instrumentTools(rawTools) {
  const observedState = state;
  const session = toolSessionGeneration;
  const active = () => !pageLeaving && observedState === state && session === toolSessionGeneration
    && !registrationAttempt?.controller.signal.aborted;
  return instrumentWebmcpTools(rawTools, {
    captureInput: captureWebmcpInput,
    async beforeExecute({ tool, input, options }) {
      if (!active() || options.signal?.aborted) return;
      if (tool.name === "paperpilot.focus_source") {
        invalidateGraphNavigation();
        graphToolNavigationGenerations.set(input, graphNavigationGeneration);
      }
      recordActivity("webmcp_request_reached_page", { actor: "WebMCP caller", toolName: tool.name });
      await ensureAnchorVisible(resolveObservedAnchor(state, tool.name, input, {}), {
        moveKeyboardFocus: false,
        scrollIntoView: false,
        signal: options.signal,
      });
      if (!active() || options.signal?.aborted) return;
      showToolRequest(tool.name, input);
    },
    onResult({ tool, input, result, options }) {
      if (!active()) return;
      const committedMutation = tool.name.startsWith("paperpilot.apply_")
        && ["applied_reversible", "replayed"].includes(result?.status);
      if (options.signal?.aborted && result?.code !== "request_aborted" && !committedMutation) return;
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
      if (tool.name === "paperpilot.focus_source" && result?.status === "focused") {
        synchronizeGraphToolNavigation(input, result);
        markSnapshotDirty();
      }
      if (tool.name === "paperpilot.stage_explain" && result?.status === "staged") {
        elements.mentorExplanationStatus.textContent = "Explanation ready. Nothing was saved. Review each claim’s authority and evidence, then save or discard the note yourself.";
        elements.agentAnnouncement.textContent = "A mentor explanation is ready. Nothing was saved. Use Go to explanation when you are ready.";
      }
      // Mutating tools already publish through state.onStateChange. Reads only
      // update their receipt/pointer, never rebuild the reader's controls.
      showToolResult(tool.name, input, result);
    },
    onError({ tool, input, error, options }) {
      if (!active()) return;
      const cancelled = options.signal?.aborted || error?.name === "AbortError";
      recordActivity("page_callback_threw", {
        actor: "PaperPilot page",
        toolName: tool.name,
        status: cancelled ? "request_aborted" : "callback_failed",
      });
      renderLastResult({ schemaVersion: 1, status: "rejected", code: cancelled ? "request_aborted" : "callback_failed", message: cancelled ? "The page request was cancelled." : "The page callback could not complete. Read the current focus and retry." });
      placeAgentCursor(
        resolveObservedAnchor(state, tool.name, input, {}),
        "error",
        cancelled ? "Request cancelled" : "Page callback failed",
        cancelled ? "The request was cancelled. No completed action is claimed." : `PaperPilot callback ${tool.name} could not complete. Read the current focus and retry.`,
      );
    },
  });
}

async function registerSuite({ automatic = false } = {}) {
  if (cleanupRequiresReload) {
    elements.webmcpStatus.textContent = "Local review · reload required before registering tools";
    elements.registerTools.disabled = true;
    elements.disposeTools.disabled = true;
    return;
  }
  if (suiteHandle || registrationAttempt || registrationClosed || pageLeaving || !state?.paper) return;
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
  const attempt = { controller: new AbortController(), state, session: ++toolSessionGeneration };
  registrationAttempt = attempt;
  elements.disposeTools.disabled = false;
  tools = instrumentTools(createToolSuite(state));
  const current = () => !pageLeaving && registrationAttempt === attempt && state === attempt.state
    && toolSessionGeneration === attempt.session;

  const observedContext = {
    async registerTool(tool, options) {
      const result = await modelContext.registerTool(tool, options);
      if (current() && !attempt.controller.signal.aborted) recordActivity("tool_registered", { actor: "page", toolName: tool.name, status: "registered" });
      return result;
    },
  };

  try {
    const handle = await mountToolSuite(observedContext, tools, {
      signal: attempt.controller.signal,
      onDispose({ reason, registrations, requiresReload = false }) {
        // This is a page-lifetime native cleanup requirement, even after the
        // paper/session which initiated the registration has been replaced.
        cleanupRequiresReload ||= requiresReload;
        if (current()) recordActivity("tool_suite_disposed", {
          actor: reason === "manual" ? "human" : "page",
          status: `${reason} · ${registrations.length} registrations`,
        });
      },
    });
    if (!current() || attempt.controller.signal.aborted) {
      handle.dispose("stale_session");
      return;
    }
    suiteHandle = handle;
    elements.webmcpStatus.textContent = `Registered ${suiteHandle.registrations.length} / ${TOOL_NAMES.length}`;
    elements.disposeTools.disabled = false;
    recordActivity("tool_suite_registered", { actor: "page", status: "ready" });
  } catch (error) {
    cleanupRequiresReload ||= error?.requiresReload === true;
    if (!current()) return;
    attempt.controller.abort("registration_failed");
    registrationAttempt = null;
    registrationClosed = cleanupRequiresReload;
    elements.webmcpStatus.textContent = registrationClosed
      ? "Tool registration failed · reload required for cleanup"
      : "Tool registration failed · retry available";
    elements.registerTools.disabled = registrationClosed;
    elements.disposeTools.disabled = true;
    recordActivity("tool_suite_registration_failed", {
      actor: "page",
      status: registrationClosed ? "reload_required" : "registration_failed",
    });
    renderLastResult({ schemaVersion: 1, status: "registration_failed", message: registrationClosed
      ? "Registration was interrupted while the client was still processing it. Your paper remains available; reload before registering again."
      : "The full tool suite could not be registered. The partial suite was cancelled; retry registration." });
  }
}

function disposeSuite(reason = "manual") {
  if (!suiteHandle && !registrationAttempt) return;
  const attempt = registrationAttempt;
  attempt?.controller.abort(reason);
  const cleanup = suiteHandle?.dispose(reason);
  cleanupRequiresReload ||= cleanup?.requiresReload === true;
  suiteHandle = null;
  registrationAttempt = null;
  toolSessionGeneration += 1;
  invalidateGraphNavigation();
  registrationClosed = true;
  clearAgentEditHighlights();
  elements.replayAgentAction.disabled = true;
  elements.webmcpStatus.textContent = "Disposed · reload before re-registering";
  elements.registerTools.disabled = true;
  elements.disposeTools.disabled = true;
}

function replacePaperToolSession() {
  disposeSuite("paper_replaced");
  registrationClosed = cleanupRequiresReload;
  toolSessionGeneration += 1;
}

function closePaperToolSession() {
  if (pageLeaving) return;
  pageLeaving = true;
  paperLoadController?.abort("page_unload");
  demoLoadController?.abort("page_unload");
  demoLoadController = null;
  disposeSuite("page_unload");
  toolSessionGeneration += 1;
  invalidateGraphNavigation();
  disposeSigma();
  paperViewer?.destroy();
}

function recordVisualTrialAssessment() {
  if (!visualKeyRevealed || !state || pageLeaving) return;
  elements.confirmVisualProof.disabled = true;
  elements.visualKey.textContent = "Human trial assessment recorded. It does not verify pixel use or enable visual understanding for this paper. Evidence mode remains locator_only.";
  recordActivity("visual_trial_human_assessment", { actor: "human", status: "locator_only · pixel use not verified" });
  renderState();
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

function canonicalViewerQuads(value) {
  if (!Array.isArray(value)) return [];
  return value.map((quad) => {
    if (Array.isArray(quad) && quad.length === 4) {
      return quad.map(({ x, y }) => ({ x: Number(x), y: Number(y) }));
    }
    if (Array.isArray(quad?.points) && quad.points.length === 8) {
      return Array.from({ length: 4 }, (_, index) => ({
        x: Number(quad.points[index * 2]),
        y: Number(quad.points[(index * 2) + 1]),
      }));
    }
    throw new Error("The PDF source quadrilateral is malformed.");
  });
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
    documentSha256: String(rawCapture.documentSha256 || ""),
    documentRevision: Number(rawCapture.documentRevision || 1),
    coordinateSpace: String(rawCapture.coordinateSpace || "pdf-crop-box"),
    normalizedBounds: normalizedBounds.map(({ x, y, width, height }) => ({ x, y, width, height })),
    pdfQuads: canonicalViewerQuads(rawCapture.pdfQuads),
    textItemRefs: Array.isArray(rawCapture.textItemRefs) ? rawCapture.textItemRefs.map(String) : [],
    pageViewBox: [...pageViewBox],
    pageRotation,
    exactText: String(exactText),
    exactTextSha256: rawCapture.exactTextSha256 ? String(rawCapture.exactTextSha256) : undefined,
    rendererRecipe: rawCapture.rendererRecipe ? structuredClone(rawCapture.rendererRecipe) : undefined,
    resolvedFrom: String(rawCapture.resolvedFrom || "pdfjs_text_layer_user_range"),
    ...(rawCapture.prefix ? { prefix: String(rawCapture.prefix) } : {}),
    ...(rawCapture.suffix ? { suffix: String(rawCapture.suffix) } : {}),
  };
}

function selectedRegionCapture(rawCapture, regionDescription) {
  if (!rawCapture || typeof rawCapture !== "object") throw new Error("Mark a region on a rendered PDF page first.");
  const normalizedBounds = rawCapture.normalizedBounds || rawCapture.rects;
  const pageIndex = Number.isInteger(rawCapture.pageIndex)
    ? rawCapture.pageIndex
    : Number.isInteger(rawCapture.pageNumber)
      ? rawCapture.pageNumber - 1
      : null;
  const pageViewBox = rawCapture.pageViewBox || rawCapture.viewport?.viewBox;
  const description = String(regionDescription || "").replace(/\s+/gu, " ").trim();
  if (!Number.isInteger(pageIndex) || !Array.isArray(normalizedBounds) || !Array.isArray(pageViewBox) || !description) {
    throw new Error("The PDF region needs trusted page geometry and a screen-reader description.");
  }
  return {
    pageIndex,
    sourceKind: "visual_region",
    documentSha256: String(rawCapture.documentSha256 || ""),
    documentRevision: Number(rawCapture.documentRevision || 1),
    coordinateSpace: String(rawCapture.coordinateSpace || "pdf-crop-box"),
    normalizedBounds: normalizedBounds.map(({ x, y, width, height }) => ({ x, y, width, height })),
    pdfQuads: canonicalViewerQuads(rawCapture.pdfQuads),
    textItemRefs: [],
    pageViewBox: [...pageViewBox],
    pageRotation: rawCapture.pageRotation ?? rawCapture.viewport?.rotation ?? 0,
    rendererRecipe: rawCapture.rendererRecipe ? structuredClone(rawCapture.rendererRecipe) : undefined,
    regionDigest: String(rawCapture.regionDigest || ""),
    regionDescription: description,
    resolvedFrom: String(rawCapture.resolvedFrom || "pdfjs_page_region"),
  };
}

function syncPersistedAnnotationOverlays() {
  if (!paperViewer?.upsertAnchorOverlay || !state?.annotations) return;
  const activeReaderAnchors = new Set(
    [...state.annotations.values()]
      .filter((annotation) => annotation.status === "active" && annotation.authority === "reader")
      .map((annotation) => annotationAnchorId(annotation))
      .filter(Boolean),
  );
  for (const [annotationId, annotation] of state.annotations) {
    const anchorId = annotationAnchorId(annotation);
    if (annotation.authority === "reader" && annotation.status !== "active" && !activeReaderAnchors.has(anchorId)) {
      paperViewer.removeAnchorOverlay?.(anchorId);
      continue;
    }
    if (annotation.status !== "active") continue;
    const anchor = state.anchors.get(anchorId);
    if (!anchor || !Array.isArray(anchor.normalizedBounds) || anchor.normalizedBounds.length === 0) continue;
    const isAutomatic = annotationId.startsWith("annotation:auto:");
    const sourceClass = anchor.sourceKind === "visual_region" ? "is-page-region" : "is-exact-text";
    const authorityClass = annotation.authority === "reader"
      ? "is-reader"
      : annotation.authority === "agent"
        ? "is-agent"
        : isAutomatic
          ? "pdf-automatic-map-anchor"
          : "is-system";
    const className = `${authorityClass} ${sourceClass}`;
    const nonvisualDescription = anchor.regionDescription
      || (anchor.sourceKind === "visual_region" ? annotation.body : "")
      || anchor.quote?.exact
      || anchor.exactText
      || "";
    paperViewer.upsertAnchorOverlay({
      anchorId,
      pageIndex: anchor.pageIndex,
      normalizedBounds: anchor.normalizedBounds,
      className,
      ariaLabel: `${annotation.label || annotation.body || "PaperPilot annotation"}, ${humanReadable(anchor.sourceKind || "source")} on page ${anchor.pageLabel}`,
      ariaDescription: nonvisualDescription,
      visibleLabel: anchor.sourceKind === "visual_region" ? `${annotation.label || "Region"} · p.${anchor.pageLabel}` : "",
    });
  }
}

function clearPendingReaderDraft({ removeOverlay = true } = {}) {
  readerSelectionGeneration += 1;
  if (removeOverlay && pendingReaderOverlayId && !state?.anchors?.has(pendingReaderOverlayId)) {
    paperViewer?.removeAnchorOverlay?.(pendingReaderOverlayId);
  }
  pendingReaderCapture = null;
  pendingReaderOverlayId = null;
}

function reportReaderSelection(message, { error = false, control = null } = {}) {
  elements.readerAnnotationError.textContent = error ? message : "";
  elements.readerSelectionStatus.textContent = error ? "" : message;
  for (const field of [elements.readerAnnotationLabel, elements.readerRegionDescription]) {
    if (error && field === control) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
  }
}

function readerSelectionFailure(error, fallback) {
  if (error?.code === "PDF_SELECTION_CROSS_PAGE") return "Select text from one PDF page at a time, or create separate annotations.";
  if (error?.code === "PDF_SELECTION_TOO_LARGE") return "Select a shorter passage: at most 1,200 characters and 8 KiB of text.";
  if (["PDF_SELECTION_STALE", "PDF_REGION_SELECTION_STALE", "PDF_SELECTION_DETACHED"].includes(error?.code)) return "The selected page changed. Select the passage or region again before adding it.";
  if (error?.code === "stale_workspace") return "The workspace changed. Check your selected source, then add the annotation again.";
  if (["history_limit_exceeded", "graph_limit_exceeded", "annotation_limit_exceeded"].includes(error?.code)) return "This workspace has reached its editing limit. Your existing work is unchanged; keep this tab open or save it in this browser.";
  return fallback;
}

function presentReaderSourceMode(mode) {
  const regionMode = mode === "region";
  regionSelectionActive = regionMode;
  elements.useTextSelection.setAttribute("aria-pressed", String(!regionMode));
  elements.beginRegionSelection.setAttribute("aria-pressed", String(regionMode));
  elements.cancelRegionSelection.hidden = false;
  elements.regionDescriptionField.hidden = !regionMode;
  elements.readerRegionDescription.required = regionMode;
  elements.createReaderAnnotation.textContent = regionMode ? "Add region to the graph" : "Add highlight to the graph";
}

function leaveRegionSelection({ cancelViewer = true, message = "Region selection cancelled. Select text or start another region lens." } = {}) {
  if (cancelViewer) paperViewer?.cancelRegionSelection?.({ notify: false });
  clearPendingReaderDraft({ removeOverlay: !cancelViewer });
  presentReaderSourceMode("text");
  reportReaderSelection(message);
}

function cancelReaderSelection() {
  const trigger = regionSelectionActive ? regionSelectionTrigger || elements.beginRegionSelection : elements.useTextSelection;
  if (regionSelectionActive) leaveRegionSelection();
  else {
    clearPendingReaderDraft();
    globalThis.getSelection?.()?.removeAllRanges?.();
    reportReaderSelection("Selection cleared. Highlight text, mark a region, or use the whole page.");
  }
  if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
}

async function startRegionSelection(initialBounds, { trigger = elements.beginRegionSelection } = {}) {
  if (typeof paperViewer?.beginRegionSelection !== "function") {
    reportReaderSelection("Region selection is unavailable in this viewer build.", { error: true });
    return;
  }
  clearPendingReaderDraft();
  const generation = readerSelectionGeneration;
  const sourceState = state;
  const viewer = paperViewer;
  const current = () => generation === readerSelectionGeneration && state === sourceState && paperViewer === viewer && !pageLeaving;
  regionSelectionTrigger = trigger;
  globalThis.getSelection?.()?.removeAllRanges?.();
  presentReaderSourceMode("region");
  if (elements.readerNodeKind.value === "concept") elements.readerNodeKind.value = "figure";
  reportReaderSelection("Opening a page-owned region lens…");
  try {
    await viewer.beginRegionSelection({
      ...(initialBounds ? { initialBounds } : {}),
      onChange({ phase, pageNumber, normalizedBounds, inputMethod }) {
        if (!current()) return;
        const region = normalizedBounds[0];
        const width = Math.round(region.width * 100);
        const height = Math.round(region.height * 100);
        const left = Math.round(region.x * 100);
        const top = Math.round(region.y * 100);
        reportReaderSelection(`Page ${pageNumber} region ${phase} · ${left}% from left, ${top}% from top · ${width}% wide × ${height}% high · ${inputMethod}. Add a nonvisual description before saving.`);
      },
      onConfirm() {
        if (!current()) return;
        reportReaderSelection("Region confirmed. Describe what is visible, name the idea, then add it to the graph.");
        elements.readerRegionDescription.focus();
      },
      onCancel() {
        if (!current()) return;
        leaveRegionSelection({ cancelViewer: false });
        if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
      },
    });
    if (current()) pendingReaderOverlayId = "anchor:region:draft";
  } catch (error) {
    if (!current()) return;
    leaveRegionSelection({ cancelViewer: false });
    reportReaderSelection(readerSelectionFailure(error, "The region lens could not start. Try the current page again."), { error: true });
    if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
  }
}

async function captureReaderSelection({ announceFailure = false } = {}) {
  if (regionSelectionActive) return null;
  if (typeof paperViewer?.captureSelection !== "function") {
    if (announceFailure) reportReaderSelection("Selection capture is unavailable. Use Mark a region or Use whole page.", { error: true });
    return null;
  }
  const generation = ++readerSelectionGeneration;
  const sourceState = state;
  const viewer = paperViewer;
  const current = () => generation === readerSelectionGeneration && state === sourceState && paperViewer === viewer && !pageLeaving;
  try {
    const rawCapture = await viewer.captureSelection();
    if (!current()) return null;
    const capture = selectedReaderCapture(rawCapture);
    if (pendingReaderOverlayId && pendingReaderOverlayId !== rawCapture.anchorId && !state.anchors.has(pendingReaderOverlayId)) {
      paperViewer.removeAnchorOverlay?.(pendingReaderOverlayId);
    }
    pendingReaderOverlayId = rawCapture.anchorId || null;
    pendingReaderCapture = capture;
    const excerpt = capture.exactText.length > 150 ? `${capture.exactText.slice(0, 147)}…` : capture.exactText;
    reportReaderSelection(`Page ${capture.pageIndex + 1} selected · “${excerpt}”`);
    if (!elements.readerAnnotationLabel.value.trim()) {
      const suggested = capture.exactText.replace(/\s+/gu, " ").trim().slice(0, 72);
      elements.readerAnnotationLabel.value = suggested;
    }
    return capture;
  } catch (error) {
    if (!current()) return null;
    clearPendingReaderDraft();
    if (announceFailure) reportReaderSelection(readerSelectionFailure(error, "Select text inside one PDF page first, or use Mark a region."), { error: true });
    return null;
  }
}

async function performReaderAnnotationSubmission(event, request) {
  event.preventDefault();
  const { sourceState, viewer, current } = request;
  let committedResult = null;
  let capture;
  if (regionSelectionActive) {
    const description = elements.readerRegionDescription.value.trim();
    if (!description) {
      reportReaderSelection("Describe the visible region so a screen-reader user can inspect it.", { error: true, control: elements.readerRegionDescription });
      elements.readerRegionDescription.focus();
      return;
    }
    try {
      capture = selectedRegionCapture(await viewer.captureRegionSelection(), description);
    } catch (error) {
      if (current()) reportReaderSelection(readerSelectionFailure(error, "Mark a PDF region before adding it to the graph."), { error: true });
      return;
    }
  } else {
    capture = pendingReaderCapture || await captureReaderSelection({ announceFailure: true });
  }
  if (!capture || !current()) return;
  const label = elements.readerAnnotationLabel.value.trim();
  const nodeKind = elements.readerNodeKind.value;
  if (!label) {
    reportReaderSelection("Name the idea before adding it to the graph.", { error: true, control: elements.readerAnnotationLabel });
    elements.readerAnnotationLabel.focus();
    return;
  }
  try {
    const anchor = await mintReaderAnchor(sourceState, capture);
    if (!current()) return;
    const exactTextSummary = capture.sourceKind === "exact_text"
      ? capture.exactText.replace(/\s+/gu, " ").trim()
      : capture.regionDescription;
    const result = await applyReaderAnnotation(sourceState, {
      baseWorkspaceRevision: sourceState.workspaceRevision,
      baseWorkspaceDigest: sourceState.workspaceDigest,
      anchor,
      annotation: capture.sourceKind === "exact_text"
        ? { kind: "highlight", label }
        : { kind: "region", label, body: capture.regionDescription },
      node: {
        kind: nodeKind,
        label,
        summary: capture.sourceKind === "exact_text"
          ? `Reader-authored idea grounded in page ${capture.pageIndex + 1}: “${exactTextSummary.slice(0, 700)}${exactTextSummary.length > 700 ? "…" : ""}”`
          : `Reader-authored idea grounded in a described PDF region on page ${capture.pageIndex + 1}: ${exactTextSummary.slice(0, 700)}${exactTextSummary.length > 700 ? "…" : ""}`,
        salience: 0.8,
      },
    });
    committedResult = result;
    if (!current()) return;
    markSnapshotDirty();
    const draftOverlayId = pendingReaderOverlayId;
    state.focusAnchorId = result.anchorId;
    clearPendingReaderDraft({ removeOverlay: false });
    elements.readerAnnotationLabel.value = "";
    globalThis.getSelection?.()?.removeAllRanges?.();
    if (regionSelectionActive) {
      paperViewer?.cancelRegionSelection?.({ notify: false });
      presentReaderSourceMode("text");
      elements.readerRegionDescription.value = "";
    }
    if (draftOverlayId && draftOverlayId !== result.anchorId) {
      paperViewer?.removeAnchorOverlay?.(draftOverlayId);
    }
    paperViewer?.upsertAnchorOverlay?.({
      anchorId: result.anchorId,
      pageIndex: anchor.pageIndex,
      normalizedBounds: anchor.normalizedBounds,
      className: capture.sourceKind === "exact_text" ? "is-reader is-exact-text" : "is-reader is-page-region",
      ariaLabel: `${label}, reader ${capture.sourceKind === "exact_text" ? "highlight" : "region"} on page ${anchor.pageLabel}`,
      ariaDescription: capture.sourceKind === "exact_text" ? capture.exactText : capture.regionDescription,
      visibleLabel: capture.sourceKind === "visual_region" ? `${label} · p.${anchor.pageLabel}` : "",
    });
    reportReaderSelection(`Added “${label}” from page ${anchor.pageLabel} as a ${capture.sourceKind === "exact_text" ? "text highlight" : "described region"}. Human Undo is available.`);
    recordActivity("reader_annotation_graph_created", {
      actor: "human",
      status: `${result.nodeKey} · ${result.annotationId}`,
    });
    renderLastResult(result);
    renderState();
    await ensureAnchorVisible(result.anchorId, { moveKeyboardFocus: false, scrollIntoView: false });
  } catch (error) {
    if (!current()) return;
    if (committedResult) {
      reportReaderSelection("The annotation was added, but its preview could not refresh. Use the Annotations tab to inspect it; Undo remains available.", { error: true });
      renderLastResult(committedResult);
      return;
    }
    reportReaderSelection(readerSelectionFailure(error, "The annotation could not be added. Check the selected source and try again."), { error: true });
    recordActivity("reader_annotation_graph_failed", { actor: "human", status: error?.code || error?.name || "error" });
    renderLastResult({ status: "reader_annotation_failed", code: error?.code || "annotation_failed", message: "The reader annotation could not be added." });
  }
}

async function submitReaderAnnotation(event) {
  event.preventDefault();
  if (!state || readerAnnotationPending) return;
  const sourceState = state;
  const viewer = paperViewer;
  const request = { sourceState, viewer, current: () => state === sourceState && paperViewer === viewer && readerAnnotationPending === request && !pageLeaving };
  readerAnnotationPending = request;
  elements.createReaderAnnotation.setAttribute("aria-disabled", "true");
  elements.createReaderAnnotation.setAttribute("aria-busy", "true");
  try {
    await performReaderAnnotationSubmission(event, request);
  } finally {
    if (readerAnnotationPending === request) {
      readerAnnotationPending = null;
      elements.createReaderAnnotation.removeAttribute("aria-disabled");
      elements.createReaderAnnotation.removeAttribute("aria-busy");
    }
  }
}

function renderGraphSearch(query = elements.graphSearchQuery.value) {
  elements.graphSearchResults.replaceChildren();
  const normalizedQuery = normalizeGraphSearchText(query);
  const kind = elements.graphFilterKind.value;
  const authority = elements.graphFilterAuthority.value;
  if (!normalizedQuery && !kind && !authority) {
    elements.graphSearchStatus.textContent = "Search uses the same label-and-summary matching as WebMCP.";
    return;
  }
  const matches = state.graph.nodes()
    .map((key) => ({ key, attributes: state.graph.getNodeAttributes(key) }))
    .filter(({ attributes }) => attributes.status === "active")
    .filter(({ attributes }) => (!kind || attributes.kind === kind) && (!authority || attributes.authority === authority))
    .map(({ key, attributes }) => {
      const label = normalizeGraphSearchText(attributes.label);
      const summary = normalizeGraphSearchText(attributes.summary);
      const rank = !normalizedQuery ? 0 : label === normalizedQuery ? 0 : label.startsWith(normalizedQuery) ? 1 : label.includes(normalizedQuery) ? 2 : summary.includes(normalizedQuery) ? 3 : -1;
      return { key, attributes, rank };
    })
    .filter(({ rank }) => rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));

  elements.graphSearchStatus.textContent = matches.length
    ? `${matches.length} matching ${matches.length === 1 ? "node" : "nodes"}${matches.length > 20 ? " · first 20 shown; refine your search" : ""}. Same filters and matching as WebMCP.`
    : "No label or summary matches in the current paper graph.";
  for (const { key, attributes } of matches.slice(0, 20)) {
    const item = document.createElement("li");
    item.dataset.graphNodeKey = key;
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
    arrangeButton.addEventListener("click", () => selectGraphNode(key));
    actions.append(arrangeButton);
    const anchorId = attributes.sourceAnchorIds?.[0] || attributes.structuralCoverage?.[0]?.primaryAnchorId;
    if (anchorId && state.anchors.has(anchorId)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Go to source";
      button.addEventListener("click", async () => {
        await focusGraphNodeEvidence(key);
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
  const fallbackDirection = direction === "up" ? "down" : direction === "down" ? "up" : direction;
  let next = nudgeGraphPosition(current, fallbackDirection);
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

function showGraphRailView(view, { focus = false } = {}) {
  if (!["map", "annotations", "evidence"].includes(view)) return;
  activeRailView = view;
  for (const button of elements.graphRailTabs) {
    const selected = button.dataset.railTab === view;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId(button.getAttribute("aria-controls")).hidden = !selected;
    if (selected && focus) button.focus();
  }
  elements.graphVisualWorkspace.hidden = view === "evidence";
  elements.graphSelection.hidden = view === "evidence";
  document.querySelector(".graph-rail-body").scrollTop = 0;
  if (view !== "evidence") requestAnimationFrame(() => renderSigma());
}

function navigateWorkspaceRegion(region) {
  if (!state || elements.workspace.inert) return false;
  if (region === "graph") showGraphRailView("map");
  else if (region === "evidence") showGraphRailView("evidence");
  const id = { paper: "paper-heading", mentor: "activity-heading", graph: "graph-heading", evidence: "evidence-heading" }[region];
  const target = id && byId(id);
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "instant" : "smooth" });
  return true;
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
  // Stable page controls already read the current document through trusted refs.
  // Rebinding on retry/replacement could turn one Clear click into two actions.
  if (humanControlsWired) return;
  humanControlsWired = true;
  for (const link of document.querySelectorAll("[data-workspace-skip]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateWorkspaceRegion(link.dataset.workspaceSkip);
    });
  }
  for (const tab of elements.graphRailTabs) {
    tab.addEventListener("click", () => showGraphRailView(tab.dataset.railTab));
    tab.addEventListener("keydown", (event) => {
      const index = elements.graphRailTabs.indexOf(tab);
      const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3
        : event.key === "Home" ? 0 : event.key === "End" ? 2 : null;
      if (next === null) return;
      event.preventDefault();
      showGraphRailView(elements.graphRailTabs[next].dataset.railTab, { focus: true });
    });
  }
  for (const [button, mode] of [[elements.graphViewFocus, "focus"], [elements.graphViewAll, "all"]]) {
    button.addEventListener("click", () => {
      graphViewMode = mode;
      reconcileGraphPresentation();
      fitGraphView();
      elements.graphLayoutStatus.textContent = mode === "all" && graphView.counts.activeNodes > 60
        ? "The visual overview is limited to 60 nodes. The complete outline keeps every node and relationship available."
        : "Map density changed. Source anchors and WebMCP facts are unchanged.";
    });
  }
  elements.graphFit.addEventListener("click", () => fitGraphView());
  for (const filter of [elements.graphFilterKind, elements.graphFilterAuthority]) {
    filter.addEventListener("change", () => renderGraphSearch());
  }
  for (const button of document.querySelectorAll("[data-focus-anchor]")) {
    button.addEventListener("click", async () => {
      const anchorId = button.dataset.focusAnchor;
      if (!state.anchors.has(anchorId)) return;
      await navigateGraphSource(anchorId, { eventType: "source_focused" });
    });
  }

  elements.registerTools.addEventListener("click", () => registerSuite({ automatic: false }));
  elements.disposeTools.addEventListener("click", () => disposeSuite("manual"));
  elements.replayAgentAction.addEventListener("click", () => enqueueObservedTraceReplay(lastObservedTrace));

  elements.saveWorkspace.addEventListener("click", () => void saveBrowserWorkspaceFromControl());
  elements.clearSavedWorkspace.addEventListener("click", () => void clearSavedBrowserWorkspaceFromControl());
  elements.cancelClearSavedWorkspace.addEventListener("click", cancelClearSavedBrowserWorkspaceFromControl);

  elements.goToExplanation.addEventListener("click", goToMentorExplanation);
  elements.saveExplanation.addEventListener("click", () => void decideMentorExplanation("save"));
  elements.discardExplanation.addEventListener("click", () => void decideMentorExplanation("discard"));

  const recaptureSelection = () => {
    queueMicrotask(() => captureReaderSelection({ announceFailure: false }));
  };
  elements.pdfViewer.addEventListener("pointerup", recaptureSelection);
  elements.pdfViewer.addEventListener("keyup", recaptureSelection);

  elements.useTextSelection.addEventListener("click", () => {
    if (regionSelectionActive) leaveRegionSelection();
    else {
      presentReaderSourceMode("text");
      reportReaderSelection("Select text directly on one rendered PDF page, then name the idea. For a keyboard alternative, use Mark a region or Use whole page.");
    }
  });
  elements.beginRegionSelection.addEventListener("click", () => { void startRegionSelection(undefined, { trigger: elements.beginRegionSelection }); });
  elements.selectWholePage.addEventListener("click", () => {
    void startRegionSelection({ x: 0, y: 0, width: 1, height: 1 }, { trigger: elements.selectWholePage });
  });
  elements.cancelRegionSelection.addEventListener("click", cancelReaderSelection);

  elements.readerAnnotationForm.addEventListener("submit", submitReaderAnnotation);

  elements.graphSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    renderGraphSearch();
  });
  elements.clearGraphSearch.addEventListener("click", () => {
    elements.graphSearchQuery.value = "";
    elements.graphFilterKind.value = "";
    elements.graphFilterAuthority.value = "";
    renderGraphSearch("");
    elements.graphSearchQuery.focus();
  });

  for (const button of elements.graphNudgeButtons) {
    button.addEventListener("click", () => nudgeSelectedGraphNode(button.dataset.graphNudge));
  }
  elements.graphLayoutReset.addEventListener("click", resetGraphLayout);
  window.addEventListener("blur", () => { finishGraphNodeDrag(); finishAnnotationDrag(); });
  window.addEventListener("pointermove", moveAnnotationPointerDrag, { passive: false });
  window.addEventListener("pointerup", (event) => { finishGraphNodeDrag(); finishAnnotationPointerDrag(event); });
  window.addEventListener("pointercancel", cancelAnnotationPointerDrag);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { finishGraphNodeDrag(); finishAnnotationDrag(); }
    handleHistoryShortcut(event);
  });

  elements.graphCanvasShell.addEventListener("dragover", (event) => {
    if (annotationPointerDrag) return;
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
    if (annotationPointerDrag) return;
    const nodeKey = currentDraggedAnnotationNode();
    if (!nodeKey || !sigmaRenderer) return;
    event.preventDefault();
    try { placeDraggedAnnotationNode(event.clientX, event.clientY); }
    finally { finishAnnotationDrag(); }
  });

  elements.humanUndo.addEventListener("click", () => void performHumanHistoryAction("undo"));
  elements.humanRedo.addEventListener("click", () => void performHumanHistoryAction("redo"));

  elements.confirmVisualProof.textContent = "Record human trial assessment (not pixel proof)";
  elements.confirmVisualProof.addEventListener("click", recordVisualTrialAssessment);
}

async function boot({ pdfFile = null } = {}) {
  if (pageLeaving) return;
  paperLoadController?.abort("paper_replaced");
  paperLoadController = new AbortController();
  const loadSignal = paperLoadController.signal;
  clearPendingReaderDraft();
  readerAnnotationPending = null;
  regionSelectionTrigger = null;
  presentReaderSourceMode("text");
  elements.readerAnnotationLabel.value = "";
  elements.readerRegionDescription.value = "";
  elements.createReaderAnnotation.removeAttribute("aria-disabled");
  elements.createReaderAnnotation.removeAttribute("aria-busy");
  reportReaderSelection("Highlight text, mark a region, or use the whole page.");
  replacePaperToolSession();
  const paperSession = ++paperSessionGeneration;
  resetBrowserWorkspacePersistence();
  const current = () => !pageLeaving && paperSessionGeneration === paperSession;
  lastObservedTrace = null;
  visualTrialObserved = false;
  visualKeyRevealed = false;
  paperStructuralMap = null;
  paperAnalysis = null;
  criticalIdeaByNodeKey.clear();
  renderToolList();
  await renderContractManifest();
  if (!current()) return;
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
  const initializedViewer = await initializePaperPdfViewer({
    signal: loadSignal,
    pdfFile,
    title: pdfFile ? paperTitleFromFilename(pdfFile.name) : undefined,
    filename: pdfFile?.name,
    contentType: pdfFile?.type || undefined,
    sourceAnchor: pdfFile ? null : undefined,
    onStatus({ kind, message }) {
      if (!current()) return;
      elements.pdfLoading.textContent = message;
      if (kind === "ready") elements.pdfLoading.hidden = true;
    },
    onError(error) {
      if (!current()) return;
      elements.pdfLoading.hidden = false;
      elements.pdfLoading.textContent = pdfFile
        ? `${error.message} Choose a valid PDF and try again.`
        : `${error.message} Run npm run spike:webmcp:paper:fetch, then reload.`;
      elements.webmcpStatus.textContent = "Not registered · PDF verification failed";
    },
    onAnchorResolved(anchor) {
      if (!current()) return;
      verifiedTextAnchor = anchor;
      elements.pdfSourceStatus.textContent = `Exact page 1 sentence verified from the PDF.js text layer · ${anchor.rects.length} live text rectangles.`;
    },
    onPageChange({ pageNumber, pageCount }) {
      if (!current()) return;
      const activeSurface = document.querySelector(`.pdf-page-surface[data-page-number="${pageNumber}"]`) || (pageNumber === 1 ? elements.pdfPageSurface : null);
      for (const surface of document.querySelectorAll(".pdf-page-surface")) {
        surface.classList.toggle("is-active-page", surface === activeSurface);
      }
      activeSurface?.setAttribute("aria-label", `PDF page ${pageNumber} of ${pageCount}`);
      elements.pdfActivePageDescription.textContent = `Page ${pageNumber} is centered`;
    },
  });
  if (!current()) { initializedViewer.destroy(); return; }
  paperViewer = initializedViewer;
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
  elements.paperMapState.textContent = "Building";
  elements.paperMapState.dataset.state = "building";
  elements.paperMapStatus.textContent = `Indexing 0 of ${paperFacts.pageCount} pages for the structural map.`;
  elements.paperMapProgress.max = paperFacts.pageCount;
  elements.paperMapProgress.removeAttribute("value");
  elements.paperMapProgress.textContent = "Building the structural page map";
  elements.paperMapProgress.setAttribute("aria-valuetext", "Building the structural page map");
  try {
    elements.paperAnalysisStatus.textContent = `Reading 0 / ${paperFacts.pageCount} pages`;
    setAnalysisProgress(0, paperFacts.pageCount, `0 of ${paperFacts.pageCount} pages read`);
    elements.paperAnalysisSummary.textContent = "Reading the verified PDF text layer without rendering a transcript.";
    recordActivity("paper_text_index_started", { actor: "page", status: `${paperViewer.documentFacts.pageCount} pages` });
    documentText = await paperViewer.extractDocumentText({
      onProgress({ indexedPages, pageCount, pageNumber }) {
        if (!current()) return;
        setAnalysisProgress(indexedPages, pageCount, `${indexedPages} of ${pageCount} pages read`);
        elements.paperAnalysisStatus.textContent = `Reading ${indexedPages} / ${pageCount} pages`;
        if (indexedPages === 1 || indexedPages === pageCount || indexedPages % 5 === 0) {
          elements.paperAnalysisSummary.textContent = `Read ${indexedPages} of ${pageCount} verified pages · currently page ${pageNumber}.`;
        }
      },
    });
    if (!current()) return;
    recordActivity("paper_text_index_completed", {
      actor: "page",
      status: `${documentText.exactCandidatePages} text pages · ${documentText.visualOnlyPages} visual-only · ${documentText.failedPages} failed`,
    });

    setAnalysisProgress(null, paperFacts.pageCount, "Ranking grounded passages");
    elements.paperAnalysisStatus.textContent = "Ranking grounded passages…";
    elements.paperAnalysisSummary.textContent = "Segmenting sections and ranking extractive candidates. Importance is heuristic, not a truth score.";
    const analysis = analyzePaperPages(documentText.pages, { minCandidates: 5, maxCandidates: 10 });
    paperStructuralMap = createWholePaperStructuralMap({
      documentSha256: paperFacts.sha256,
      pages: documentText.pages,
      outlineEntries: documentText.outline?.entries || [],
      heuristicHeadings: analysis.headings,
    });
    recordActivity("structural_map_created", {
      actor: "page",
      status: `${paperStructuralMap.status} · ${paperStructuralMap.nodes.length} ranges · ${paperStructuralMap.counts.navigablePages}/${paperStructuralMap.pageCount} navigable`,
    });
    groundedAutomaticMap = groundAutomaticMap(documentText, analysis);
    setAnalysisProgress(0, groundedAutomaticMap.contract.candidates.length, `0 of ${groundedAutomaticMap.contract.candidates.length} candidates grounded`);
    elements.paperAnalysisStatus.textContent = `Grounding 0 / ${groundedAutomaticMap.contract.candidates.length} candidates`;
  } catch (error) {
    if (!current()) return;
    const pageCount = paperFacts.pageCount;
    if (!paperStructuralMap) {
      const structuralPages = documentText?.pages || paperViewer.getStructuralPageRecords();
      try {
        paperStructuralMap = createWholePaperStructuralMap({
          documentSha256: paperFacts.sha256,
          pages: structuralPages,
          outlineEntries: documentText?.outline?.entries || [],
          heuristicHeadings: [],
        });
      } catch (structuralError) {
        paperStructuralMap = createWholePaperStructuralMap({
          documentSha256: paperFacts.sha256,
          pages: structuralPages.map((page) => ({ ...page, textCapability: "failed" })),
          outlineEntries: [],
          heuristicHeadings: [],
        });
        recordActivity("structural_map_failed_closed", {
          actor: "page",
          status: structuralError?.name || "structural_map_error",
        });
      }
      recordActivity("structural_map_created", {
        actor: "page",
        status: `${paperStructuralMap.status} · fallback ranges · ${paperStructuralMap.counts.navigablePages}/${paperStructuralMap.pageCount} navigable`,
      });
    }
    const coverage = documentText?.pages?.map(({ pageIndex, pageLabel, textCapability }) => ({
      pageIndex,
      pageLabel,
      textCapability,
    })) || paperViewer.getStructuralPageRecords().map(({ pageIndex, pageLabel, textCapability }) => ({
      pageIndex,
      pageLabel,
      textCapability,
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

  const initializedState = await createSpikeState(MultiDirectedGraph, {
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
    structuralMap: paperStructuralMap,
    automaticMap: groundedAutomaticMap.contract,
    textAnchor: exactAnchor ? {
      normalizedBounds: exactAnchor.rects.map((rectangle) => ({ ...rectangle })),
      pdfQuads: exactAnchor.pdfQuads.map((quad) => ({ points: [...quad.points] })),
      pageViewBox: [...paperFacts.firstPageViewBox],
      pageRotation: exactAnchor.viewport.rotation,
    } : null,
    onEvent(event) {
      if (!current()) return;
      activity.push(event);
      renderActivity();
    },
    onNavigate: navigateObservedPaperSource,
    onStateChange() {
      if (!current()) return;
      renderState();
    },
  });
  if (!current()) return;
  state = initializedState;
  const restoredWorkspace = await restoreBrowserWorkspace({ isCurrent: current });
  if (!current()) return;
  if (restoredWorkspace.status === "restored") {
    // Existing browser preferences stay intact. Reset layout opts into the new seed.
    state.graph.forEachNode((key, attributes) => {
      if (Number.isFinite(attributes.x) && Number.isFinite(attributes.y)) {
        graphLayoutPositions.set(key, clampGraphPosition(attributes));
      }
    });
  }
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
  const textLimitedPages = paperStructuralMap.counts.limitedPages + paperStructuralMap.counts.failedPages;
  setAnalysisProgress(
    groundedCount,
    Math.max(1, paperAnalysis.candidateCount),
    `${groundedCount} of ${paperAnalysis.candidateCount} unreviewed suggestions grounded`,
  );
  const mapStatusLabel = paperStructuralMap.status === "structural_ready"
    ? "Map ready"
    : paperStructuralMap.status === "structural_partial"
      ? "Map partial"
      : "Map unavailable";
  elements.paperAnalysisStatus.textContent = `${mapStatusLabel} · ${paperStructuralMap.counts.navigablePages} / ${paperFacts.pageCount} pages navigable`;
  elements.pdfSourceStatus.textContent = `${paperStructuralMap.counts.navigablePages} of ${paperFacts.pageCount} pages have source locators. ${textLimitedPages ? `${textLimitedPages} pages have limited or failed text; use their visible PDF regions.` : "Choose a passage, annotation, or map source to return to its place in the PDF."}`;
  if (paperAnalysis.candidateCount > 0) {
    elements.paperAnalysisSummary.textContent = `${paperAnalysis.candidateCount} unreviewed idea suggestions were grounded separately from the whole-paper structure. ${textLimitedPages} pages had limited or failed text.`;
    recordActivity("automatic_map_hydrated", {
      actor: "page",
      status: `${paperAnalysis.candidateCount} candidates · revision 1 baseline`,
    });
  } else {
    elements.paperAnalysisSummary.textContent = `The paper structure is available, but PaperPilot found no reliable text for idea suggestions. ${textLimitedPages} pages had limited or failed text.`;
  }
  elements.primarySourceButton.dataset.focusAnchor = state.focusAnchorId;
  elements.primarySourceButton.disabled = !state.anchors.has(state.focusAnchorId);
  elements.primarySourceButton.textContent = state.anchors.get(state.focusAnchorId)?.sourceKind === "exact_text"
    ? "Go to current source"
    : "Go to current page source";
  wireHumanControls();
  await setupVisualTrial();
  if (!current()) return;
  renderState();
  if (restoredWorkspace.status === "restored" && state.anchors.has(state.focusAnchorId)) {
    try {
      await ensureAnchorVisible(state.focusAnchorId, {
        moveKeyboardFocus: false,
        scrollIntoView: true,
        behavior: "auto",
      });
      if (!current()) return;
    } catch {
      if (!current()) return;
      elements.pdfSourceStatus.textContent = "Your workspace was restored, but the saved source could not be brought into view. Use the page locator or a source link to continue.";
      recordActivity("restored_source_navigation_failed", { actor: "page", status: "source_unavailable" });
    }
  }
  placeAgentCursor(
    state.focusAnchorId,
    "ready",
    "Waiting for a WebMCP callback",
    "The provenance cursor will move only when PaperPilot observes a WebMCP page callback.",
  );
  await registerSuite({ automatic: true });
}

function reportInitializationFailure(error) {
  const safe = safePdfError(error);
  elements.webmcpStatus.textContent = "Not registered · paper could not be opened";
  elements.rendererStatus.textContent = "Waiting for a valid paper";
  recordActivity("spike_initialization_failed", { status: safe.code });
  renderLastResult({ status: "initialization_failed", code: safe.code, message: safe.message });
  return safe;
}

function setPaperIntakeStatus(message, { error = false } = {}) {
  elements.paperSourceGateStatus.setAttribute("role", error ? "alert" : "status");
  elements.paperSourceGateStatus.setAttribute("aria-live", error ? "assertive" : "polite");
  elements.paperSourceGateStatus.setAttribute("aria-atomic", "true");
  elements.paperSourceGateStatus.textContent = message;
}

async function beginWithPaper(pdfFile = null) {
  if (pageLeaving) return;
  const intake = ++paperIntakeGeneration;
  const current = () => !pageLeaving && paperIntakeGeneration === intake;
  elements.workspace.inert = false;
  document.body.classList.remove("is-waiting-for-paper");
  elements.skipLink.href = "#contract-workspace";
  elements.skipLink.textContent = "Skip to PaperPilot workspace";
  try {
    await boot({ pdfFile });
    if (!current()) return;
    if (!state?.paper || !paperViewer?.documentFacts?.integrityVerified) {
      throw new Error("The reading workspace is not ready.");
    }
    elements.workspaceSkipLinks.hidden = false;
    if (pdfFile) {
      setPaperIntakeStatus(`${pdfFile.name} is active in this tab.`);
      elements.paperFileInput.disabled = true;
      elements.loadAttentionDemo.disabled = true;
      elements.paperSourceGate.hidden = true;
    }
  } catch (error) {
    if (!current()) return;
    const safe = reportInitializationFailure(error);
    if (pdfFile) {
      paperLoadController?.abort();
      paperViewer?.destroy();
      paperViewer = null;
      elements.paperFileInput.disabled = false;
      elements.loadAttentionDemo.disabled = false;
      elements.paperFileInput.value = "";
      setPaperIntakeStatus(`${safe.message} Choose another PDF.`, { error: true });
      elements.paperSourceGate.hidden = false;
      elements.workspaceSkipLinks.hidden = true;
      elements.workspace.inert = true;
      document.body.classList.add("is-waiting-for-paper");
      elements.skipLink.href = "#paper-source-gate";
      elements.skipLink.textContent = "Skip to paper intake";
    }
  }
}

async function loadAttentionDemo() {
  if (pageLeaving || demoLoadController) return;
  const controller = new AbortController();
  demoLoadController = controller;
  const current = () => !pageLeaving && demoLoadController === controller;
  const timer = setTimeout(() => controller.abort(), 45_000);
  elements.loadAttentionDemo.disabled = true;
  elements.paperFileInput.disabled = true;
  setPaperIntakeStatus("Fetching the official arXiv v7 Attention paper into this tab…");
  try {
    const response = await fetch(ATTENTION_DEMO_URL, {
      mode: "cors", credentials: "omit", redirect: "error", signal: controller.signal,
    });
    const bytes = await readBoundedPdfResponse(response, { maxBytes: PDF_RELEASE_LIMITS.maxBytes, signal: controller.signal });
    if (!current()) return;
    if (controller.signal.aborted) throw new PdfIntakeError("intake_cancelled");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!current()) return;
    if (controller.signal.aborted) throw new PdfIntakeError("intake_cancelled");
    if (bytes.byteLength !== ATTENTION_PDF.byteLength || digest !== ATTENTION_PDF.sha256) {
      throw new PdfIntakeError("demo_integrity_mismatch");
    }
    const pdfFile = new File([bytes], ATTENTION_DEMO_FILENAME, { type: "application/pdf", lastModified: 0 });
    setPaperIntakeStatus("Opening the exact Attention v7 PDF locally—nothing is being uploaded.");
    clearTimeout(timer);
    await beginWithPaper(pdfFile);
  } catch (error) {
    if (!current()) return;
    const safe = safeDemoFailure(controller.signal.aborted ? new PdfIntakeError("intake_cancelled") : error);
    setPaperIntakeStatus(safe.message, { error: true });
    elements.loadAttentionDemo.disabled = false;
    elements.paperFileInput.disabled = false;
  } finally {
    clearTimeout(timer);
    if (demoLoadController === controller) demoLoadController = null;
  }
}

function openSelectedPaper() {
  if (pageLeaving) return;
  const [pdfFile] = elements.paperFileInput.files || [];
  if (!pdfFile) return;
  // A file-picker completion is a newer reader intent, even if its change event
  // was queued before the demo button disabled intake controls.
  demoLoadController?.abort();
  demoLoadController = null;
  if (pdfFile.size === 0 || pdfFile.size > PDF_RELEASE_LIMITS.maxBytes) {
    setPaperIntakeStatus(pdfFile.size === 0
      ? "That file is empty. Choose a PDF with paper content."
      : "That PDF is larger than the 25 MiB browser-local limit. Choose a smaller PDF.", { error: true });
    elements.paperFileInput.value = "";
    elements.paperFileInput.disabled = false;
    elements.loadAttentionDemo.disabled = false;
    return;
  }
  elements.paperFileInput.disabled = true;
  elements.loadAttentionDemo.disabled = true;
  setPaperIntakeStatus(`Opening ${pdfFile.name} locally—nothing is being uploaded.`);
  void beginWithPaper(pdfFile);
}

const startupParameters = new URLSearchParams(globalThis.location.search);
window.addEventListener("beforeunload", closePaperToolSession);
window.addEventListener("pagehide", closePaperToolSession);
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
  elements.loadAttentionDemo.addEventListener("click", () => void loadAttentionDemo());
  elements.paperFileInput.addEventListener("change", openSelectedPaper);
}
