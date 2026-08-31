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
  undoLastHumanChange,
} from "./contracts.mjs";
import { initializePaperPdfViewer } from "./pdf-viewer.mjs";

const byId = (id) => document.getElementById(id);

const elements = {
  webmcpStatus: byId("webmcp-status"),
  workspaceStatus: byId("workspace-status"),
  focusStatus: byId("focus-status"),
  rendererStatus: byId("renderer-status"),
  sigmaContainer: byId("sigma-container"),
  graphOutline: byId("graph-outline"),
  annotationList: byId("annotation-list"),
  activityList: byId("activity-list"),
  toolList: byId("tool-list"),
  lastResult: byId("last-result"),
  registerTools: byId("register-tools"),
  disposeTools: byId("dispose-tools"),
  humanUndo: byId("human-undo"),
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

const reducedMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

const TOOL_COPY = Object.freeze({
  "paperpilot.read_focus": { action: "Focus request reached page", complete: "Focus returned" },
  "paperpilot.read_graph": { action: "Graph request reached page", complete: "Graph view returned" },
  "paperpilot.stage_explain": { action: "Explanation request reached page", complete: "Explanation staged" },
  "paperpilot.apply_graph": { action: "Graph-change request reached page", complete: "Graph revision applied" },
  "paperpilot.apply_annotation": { action: "Annotation request reached page", complete: "Annotation revision applied" },
  "paperpilot.focus_source": { action: "Source-focus request reached page", complete: "Source focused" },
});

function timestamp() {
  return new Date().toISOString();
}

function recordActivity(eventType, details = {}) {
  const record = { observedAt: timestamp(), eventType, ...details };
  activity.push(record);
  renderActivity();
  return record;
}

function humanReadable(value) {
  return String(value ?? "").replaceAll("_", " ");
}

function prefersReducedMotion() {
  return Boolean(reducedMotionQuery?.matches);
}

function presentedActor(actor) {
  if (actor === "agent" || actor === "webmcp_caller" || actor === "WebMCP caller") return "WebMCP caller";
  if (actor === "page" || actor === "PaperPilot page") return "PaperPilot page";
  if (actor === "human") return "Human";
  return humanReadable(actor || "");
}

function waitForReplay(milliseconds) {
  if (prefersReducedMotion() || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function annotationAnchorId(annotation) {
  return annotation?.anchorId || annotation?.sourceAnchorId || annotation?.sourceAnchorIds?.[0] || null;
}

function resolveToolAnchor(toolName, input = {}, result = {}) {
  if (toolName === "paperpilot.read_focus") return result?.focus?.anchorId || state.focusAnchorId;
  if (toolName === "paperpilot.focus_source") return result?.anchorId || state.focusAnchorId;
  if (toolName === "paperpilot.stage_explain") return input.focusAnchorId || input.sourceAnchorIds?.[0] || state.focusAnchorId;
  if (toolName === "paperpilot.apply_annotation") {
    for (const operation of input.operations || []) {
      if (operation.anchorId && state.anchors.has(operation.anchorId)) return operation.anchorId;
      const annotation = state.annotations.get(operation.annotationId);
      const anchorId = annotationAnchorId(annotation);
      if (anchorId) return anchorId;
    }
  }
  if (toolName === "paperpilot.apply_graph") {
    for (const operation of input.operations || []) {
      const sourceAnchorIds = operation.node?.sourceAnchorIds || operation.edge?.sourceAnchorIds || operation.set?.sourceAnchorIds;
      const issuedAnchor = sourceAnchorIds?.find((anchorId) => state.anchors.has(anchorId));
      if (issuedAnchor) return issuedAnchor;
    }
  }
  return state.focusAnchorId;
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

function createObservedTrace(toolName, input, result, phase = "complete") {
  const anchorId = resolveToolAnchor(toolName, input, result);
  const anchor = state.anchors.get(anchorId);
  return {
    toolName,
    anchorId,
    pageLabel: anchor?.pageLabel || "unknown",
    sourceKind: anchor?.sourceKind || "paper context",
    phase,
    status: result?.status || "returned",
    code: result?.code || null,
    callbackReceiptId: result?.callbackReceiptId || null,
    revisionId: result?.revisionId || null,
    replayed: result?.replayed === true || result?.status === "replayed",
    observedAt: timestamp(),
  };
}

function showToolRequest(toolName, input) {
  const copy = TOOL_COPY[toolName] || { action: "Running page callback" };
  const anchorId = resolveToolAnchor(toolName, input, {});
  placeAgentCursor(
    anchorId,
    toolName.startsWith("paperpilot.apply_") ? "editing" : "working",
    copy.action,
    `Request reached the PaperPilot page for ${toolName}.`,
  );
}

function showToolResult(toolName, input, result) {
  const trace = createObservedTrace(toolName, input, result);
  const copy = TOOL_COPY[toolName] || { complete: "Page callback returned" };
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
  const visible = activity.slice(-80).reverse();
  if (visible.length === 0) {
    appendTextListItem(elements.activityList, "No page or tool activity observed yet.");
    return;
  }
  for (const event of visible) {
    const actor = event.actor ? ` · ${presentedActor(event.actor)}` : "";
    const tool = event.toolName ? ` · ${event.toolName}` : "";
    const outcome = event.status ? ` · ${event.status}` : "";
    appendTextListItem(
      elements.activityList,
      `${event.observedAt} · ${humanReadable(event.eventType)}${actor}${tool}${outcome}`,
    );
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

function renderGraphOutline() {
  elements.graphOutline.replaceChildren();
  state.graph.forEachNode((key, attributes) => {
    const sources = attributes.sourceAnchorIds?.join(", ") ||
      attributes.structuralCoverage?.map((coverage) => coverage.primaryAnchorId).join(", ") ||
      "structural provenance";
    const item = appendTextListItem(
      elements.graphOutline,
      `Node · ${attributes.label || key} · ${humanReadable(attributes.kind || "concept")} · ${humanReadable(attributes.authority || "unknown authority")} · ${humanReadable(attributes.origin || "unknown origin")} · source ${sources}`,
    );
    const primaryAnchorId = attributes.sourceAnchorIds?.[0] || attributes.structuralCoverage?.[0]?.primaryAnchorId;
    if (primaryAnchorId && state.anchors.has(primaryAnchorId)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Go to paper source";
      button.addEventListener("click", async () => {
        state.focusAnchorId = primaryAnchorId;
        recordActivity("graph_source_focused", { actor: "human", status: key });
        await ensureAnchorVisible(primaryAnchorId, { moveKeyboardFocus: true, scrollIntoView: true });
      });
      item.append(button);
    }
  });
  state.graph.forEachEdge((key, attributes, source, target) => {
    const relation = attributes.relation || attributes.kind || "relates to";
    const sources = attributes.sourceAnchorIds?.join(", ") || "structural provenance";
    appendTextListItem(
      elements.graphOutline,
      `Edge · ${source} → ${target} · ${humanReadable(relation)} · source ${sources}`,
    );
  });
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
    appendTextListItem(elements.annotationList, "No annotations in this page session.");
    return;
  }
  for (const [key, annotation] of state.annotations) {
    const anchor = annotationAnchorId(annotation) || "unknown anchor";
    const body = annotation.body || annotation.text || annotation.label || annotation.note || "Annotation";
    const isFixture = key.startsWith("annotation:fixture:");
    const item = document.createElement("li");
    item.className = `annotation-item${annotation.authority === "agent" ? " is-agent" : annotation.authority === "reader" ? " is-reader" : ""}`;
    const summary = document.createElement("span");
    const provenance = isFixture
      ? "deterministic demo fixture"
      : annotation.authority === "agent"
        ? "created through WebMCP"
        : annotation.authority === "reader"
          ? "created by the reader and linked to the graph"
          : `${annotation.authority || "unknown"} origin`;
    summary.textContent = `${body} · ${humanReadable(annotation.kind)} · ${provenance} · ${annotation.status}`;
    item.append(summary);
    const issuedAnchor = state.anchors.get(anchor);
    if (issuedAnchor?.exactText) {
      const sourceSummary = document.createElement("small");
      sourceSummary.className = "annotation-source-summary";
      sourceSummary.textContent = `Page ${issuedAnchor.pageLabel} · ${issuedAnchor.anchorId} · “${issuedAnchor.exactText}”`;
      item.append(sourceSummary);
    }

    if (state.anchors.has(anchor)) {
      const focusButton = document.createElement("button");
      focusButton.type = "button";
      focusButton.textContent = "Go to source";
      focusButton.addEventListener("click", async () => {
        state.focusAnchorId = anchor;
        recordActivity("annotation_source_focused", { actor: "human", status: key });
        await ensureAnchorVisible(anchor, { moveKeyboardFocus: true, scrollIntoView: true });
      });
      item.append(focusButton);
    }
    elements.annotationList.append(item);

    if (annotation.status !== "active" || !state.anchors.has(anchor)) continue;
    const target = cursorTargetForAnchor(anchor);
    if (!target || target === elements.paperStage) continue;
    target.classList.add("has-annotations");
    const chip = document.createElement("span");
    chip.className = `annotation-chip runtime-annotation-pin ${isFixture ? "is-fixture" : annotation.authority === "agent" ? "is-agent" : annotation.authority === "reader" ? "is-reader" : ""}`.trim();
    chip.textContent = body;
    chip.title = `${body} · ${provenance}`;
    chip.setAttribute("role", "listitem");
    if (target === elements.textSource) elements.paperAnnotationSummary.append(chip);
    else target.append(chip);
  }
}

function disposeSigma() {
  if (!sigmaRenderer) return;
  try {
    sigmaRenderer.kill();
  } catch (error) {
    recordActivity("sigma_disposal_warning", { status: error?.name || "error" });
  }
  sigmaRenderer = null;
  sigmaGraph = null;
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
    });
    sigmaGraph = state.graph;
    elements.rendererStatus.textContent = "Sigma active + outline";
    recordActivity("sigma_renderer_ready", { status: SPIKE_VERSIONS.sigma });
  } catch (error) {
    disposeSigma();
    elements.rendererStatus.textContent = "Accessible outline fallback";
    recordActivity("sigma_renderer_fallback", { status: error?.name || "error" });
  }
}

function renderState() {
  elements.workspaceStatus.textContent = `Revision ${state.workspaceRevision} · ${state.workspaceDigest.slice(0, 10)}…`;
  elements.visualMode.textContent = `Evidence mode: ${state.visualEvidenceMode}`;
  elements.humanUndo.disabled = state.history.length === 0;
  renderFocus();
  renderGraphOutline();
  renderAnnotations();
  if (elements.graphSearchQuery.value.trim()) renderGraphSearch();
  renderSigma();
}

function instrumentTools(rawTools) {
  return rawTools.map((tool) => ({
    ...tool,
    async execute(input = {}, options = {}) {
      recordActivity("webmcp_request_reached_page", { actor: "WebMCP caller", toolName: tool.name });
      await ensureAnchorVisible(resolveToolAnchor(tool.name, input, {}), {
        moveKeyboardFocus: false,
        scrollIntoView: false,
      });
      showToolRequest(tool.name, input);
      try {
        const result = await tool.execute(input, options);
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
        renderState();
        showToolResult(tool.name, input, result);
        return result;
      } catch (error) {
        recordActivity("page_callback_threw", {
          actor: "PaperPilot page",
          toolName: tool.name,
          status: error?.name || "error",
        });
        renderLastResult({ status: "threw", name: error?.name, message: error?.message });
        placeAgentCursor(
          resolveToolAnchor(tool.name, input, {}),
          "error",
          "Page callback failed",
          `PaperPilot callback ${tool.name} failed with ${error?.name || "an error"}.`,
        );
        throw error;
      }
    },
  }));
}

async function registerSuite({ automatic = false } = {}) {
  if (suiteHandle || registrationClosed) return;
  const modelContext = document.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    elements.webmcpStatus.textContent = "Unavailable in this client";
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
      item.append(button);
    }
    elements.graphSearchResults.append(item);
  }
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

  elements.humanUndo.addEventListener("click", async () => {
    const result = await undoLastHumanChange(state);
    recordActivity("human_undo_control", { actor: "human", status: result.status });
    renderLastResult(result);
    renderState();
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

async function boot() {
  renderToolList();
  await renderContractManifest();
  renderActivity();
  elements.registerTools.disabled = true;
  elements.disposeTools.disabled = true;
  elements.humanUndo.disabled = true;
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
    onStatus({ kind, message }) {
      elements.pdfLoading.textContent = message;
      if (kind === "ready") elements.pdfLoading.hidden = true;
    },
    onError(error) {
      elements.pdfLoading.hidden = false;
      elements.pdfLoading.textContent = `${error.message} Run npm run spike:webmcp:paper:fetch, then reload.`;
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
  if (!paperViewer.documentFacts?.integrityVerified || !exactAnchor) {
    throw new Error(
      `The exact paper or its page-owned source geometry was not verified (integrity=${String(paperViewer.documentFacts?.integrityVerified)}, anchor=${String(Boolean(exactAnchor))}).`,
    );
  }
  elements.pdfLoading.hidden = true;
  recordActivity("exact_pdf_verified", {
    actor: "page",
    status: `${paperViewer.documentFacts.pageCount} pages · sha256 ${paperViewer.documentFacts.sha256.slice(0, 12)}…`,
  });

  state = await createSpikeState(MultiDirectedGraph, {
    visualEvidenceMode: "locator_only",
    textAnchor: {
      normalizedBounds: exactAnchor.rects.map((rectangle) => ({ ...rectangle })),
      pdfQuads: exactAnchor.pdfQuads.map((quad) => ({ points: [...quad.points] })),
      pageViewBox: [0, 0, 612, 792],
      pageRotation: exactAnchor.viewport.rotation,
    },
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
  tools = instrumentTools(createToolSuite(state));
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

boot().catch((error) => {
  elements.webmcpStatus.textContent = "Spike initialization failed";
  elements.rendererStatus.textContent = "Accessible diagnostics only";
  recordActivity("spike_initialization_failed", { status: error?.name || "error" });
  renderLastResult({ status: "initialization_failed", name: error?.name, message: error?.message });
});
