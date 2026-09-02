// @ts-check

/**
 * Browser-independent observation helpers for the page-owned WebMCP adapter.
 *
 * This module deliberately knows nothing about `document`, PDF.js, Sigma, or
 * the PaperPilot DOM. The composition root supplies those effects as hooks.
 */

/** @typedef {{ anchorId?: string, sourceAnchorId?: string, sourceAnchorIds?: string[] }} AnnotationLike */
/** @typedef {{ anchorId?: string, annotationId?: string, node?: { sourceAnchorIds?: string[] }, edge?: { sourceAnchorIds?: string[] }, set?: { sourceAnchorIds?: string[] } }} ToolOperation */
/** @typedef {{ focusAnchorId?: string | null, anchors: Map<string, unknown>, annotations: Map<string, AnnotationLike> }} ObserverState */
/** @typedef {{ name: string, execute(input?: Record<string, any>, options?: Record<string, any>): Promise<any> }} ExecutableTool */
/** @typedef {{ tool: ExecutableTool, input: Record<string, any>, options: Record<string, any> }} BeforeContext */
/** @typedef {BeforeContext & { result: any }} ResultContext */
/** @typedef {BeforeContext & { error: unknown }} ErrorContext */
/** @typedef {{ beforeExecute?(context: BeforeContext): void | Promise<void>, onResult?(context: ResultContext): void | Promise<void>, onError?(context: ErrorContext): void | Promise<void> }} ToolObservationHooks */

export const TOOL_PRESENTATION_COPY = Object.freeze({
  "paperpilot.read_focus": { action: "Focus request reached page", complete: "Focus returned" },
  "paperpilot.read_graph": { action: "Graph request reached page", complete: "Graph view returned" },
  "paperpilot.stage_explain": { action: "Explanation request reached page", complete: "Explanation staged" },
  "paperpilot.apply_graph": { action: "Graph-change request reached page", complete: "Graph revision applied" },
  "paperpilot.apply_annotation": { action: "Annotation request reached page", complete: "Annotation revision applied" },
  "paperpilot.focus_source": { action: "Source-focus request reached page", complete: "Source focused" },
});

/**
 * Resolve an annotation's page-owned source without accepting caller geometry.
 *
 * @param {AnnotationLike | null | undefined} annotation
 * @returns {string | null}
 */
export function annotationAnchorId(annotation) {
  return annotation?.anchorId || annotation?.sourceAnchorId || annotation?.sourceAnchorIds?.[0] || null;
}

/**
 * Select the already-issued anchor that should receive visible callback proof.
 * Unknown or ungrounded operations fall back to the current page-owned focus.
 *
 * @param {ObserverState} state
 * @param {string} toolName
 * @param {Record<string, any>} [input]
 * @param {Record<string, any>} [result]
 * @returns {string | null}
 */
export function resolveObservedAnchor(state, toolName, input = {}, result = {}) {
  /** @param {unknown} candidate @returns {string | null} */
  const issued = (candidate) => typeof candidate === "string" && state.anchors.has(candidate) ? candidate : null;
  const fallback = issued(state.focusAnchorId);
  if (toolName === "paperpilot.read_focus") return issued(result?.focus?.anchorId) || fallback;
  if (toolName === "paperpilot.focus_source") return issued(result?.anchorId) || fallback;
  if (toolName === "paperpilot.stage_explain") {
    return issued(input.focusAnchorId)
      || input.sourceAnchorIds?.map(issued).find(Boolean)
      || fallback;
  }
  if (toolName === "paperpilot.apply_annotation") {
    for (const operation of /** @type {ToolOperation[]} */ (input.operations || [])) {
      if (operation.anchorId && state.anchors.has(operation.anchorId)) return operation.anchorId;
      const anchorId = annotationAnchorId(state.annotations.get(String(operation.annotationId || "")));
      if (issued(anchorId)) return anchorId;
    }
  }
  if (toolName === "paperpilot.apply_graph") {
    for (const operation of /** @type {ToolOperation[]} */ (input.operations || [])) {
      const sourceAnchorIds = operation.node?.sourceAnchorIds
        || operation.edge?.sourceAnchorIds
        || operation.set?.sourceAnchorIds;
      const issuedAnchor = sourceAnchorIds?.find((anchorId) => state.anchors.has(anchorId));
      if (issuedAnchor) return issuedAnchor;
    }
  }
  return fallback;
}

/**
 * Create the durable, user-visible fact for one observed page callback.
 * This records what the page saw; it does not claim private model reasoning.
 *
 * @param {{ state: ObserverState, toolName: string, input?: Record<string, any>, result?: Record<string, any>, phase?: string, now?: () => string }} options
 */
export function createObservedTrace({
  state,
  toolName,
  input = {},
  result = {},
  phase = "complete",
  now = () => new Date().toISOString(),
}) {
  const anchorId = resolveObservedAnchor(state, toolName, input, result);
  const anchor = anchorId ? /** @type {any} */ (state.anchors.get(anchorId)) : null;
  return Object.freeze({
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
    observedAt: now(),
  });
}

/**
 * Turn an observed result into outcome copy, never inferring an applied edit
 * merely because a callback returned. Visual replay has no mutation effects.
 *
 * @param {ReturnType<typeof createObservedTrace>} trace
 * @param {{ replay?: boolean }} [options]
 */
export function createObservedPresentation(trace, { replay = false } = {}) {
  const copy = TOOL_PRESENTATION_COPY[/** @type {keyof typeof TOOL_PRESENTATION_COPY} */ (trace.toolName)]
    || { complete: "Page callback returned" };
  const mutation = trace.toolName === "paperpilot.apply_graph" || trace.toolName === "paperpilot.apply_annotation";
  const applied = mutation && trace.status === "applied_reversible" && !trace.replayed;
  const readableStatus = String(trace.status).replaceAll("_", " ");
  /** @type {"error" | "complete"} */
  let phase = "complete";
  let label;
  let announcement;
  if (trace.status === "rolled_back") {
    phase = "error";
    label = "Change rolled back · no revision kept";
    announcement = `PaperPilot rolled back ${trace.toolName}. The prior workspace was restored; no annotation or graph revision from this callback remains applied.`;
  } else if (trace.status === "rejected") {
    phase = "error";
    label = `Callback rejected · ${String(trace.code || "invalid request").replaceAll("_", " ")}`;
    announcement = `PaperPilot rejected ${trace.toolName}. No annotation or graph revision was created.`;
  } else if (mutation && !applied && !trace.replayed) {
    phase = "error";
    label = `No applied revision receipt · ${readableStatus}`;
    announcement = `PaperPilot returned ${trace.status} from ${trace.toolName}. This is not an applied mutation receipt; no edit is being shown.`;
  } else {
    label = trace.replayed ? "Idempotent replay · no new revision" : `${copy.complete} · ${readableStatus}`;
    announcement = `PaperPilot returned ${trace.status} from ${trace.toolName} at page ${trace.pageLabel}. This confirms a page callback, not private model reasoning.`;
  }
  return Object.freeze({
    phase,
    label: replay ? `Replay · ${label}` : label,
    announcement: replay
      ? `Replaying the observed outcome. ${announcement} No tool or command ran during this replay and no revision changed.`
      : announcement,
    flashAnnotation: !replay && applied && trace.toolName === "paperpilot.apply_annotation",
  });
}

/**
 * Wrap trusted tool callbacks with observable lifecycle hooks while preserving
 * the original tool definitions, callback arguments, and authoritative outcome.
 * Observer failures must not stop a callback or turn a committed edit into a
 * thrown request. The page's canonical receipts remain the source of truth.
 *
 * @param {ExecutableTool[]} rawTools
 * @param {ToolObservationHooks} [hooks]
 * @returns {ExecutableTool[]}
 */
export function instrumentWebmcpTools(rawTools, hooks = {}) {
  if (!Array.isArray(rawTools)) throw new TypeError("rawTools must be an array.");
  return rawTools.map((tool) => {
    if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
      throw new TypeError("Each WebMCP tool must expose a name and execute callback.");
    }
    return {
      ...tool,
      async execute(input = {}, options = {}) {
        const before = { tool, input, options };
        try {
          await hooks.beforeExecute?.(before);
        } catch {
          // A missing visual request indicator does not change tool authority.
        }
        let result;
        try {
          result = await tool.execute(input, options);
        } catch (error) {
          try {
            await hooks.onError?.({ ...before, error });
          } catch {
            // Keep the real callback failure rather than an observer exception.
          }
          throw error;
        }
        try {
          await hooks.onResult?.({ ...before, result });
        } catch {
          // The tool returned; do not invent a second failed callback event.
        }
        return result;
      },
    };
  });
}
