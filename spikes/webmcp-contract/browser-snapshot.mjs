import { validateSpatialAnchor } from "./spatial-anchor.mjs";
import { applyWorkspacePatch, createWorkspacePatch, invertWorkspacePatch, validateWorkspacePatch } from "./workspace-patch.mjs";
import { validateToolResult } from "./contracts.mjs";
import { MENTOR_SECTION_KEYS, mentorPayloadFromRecord, validateMentorPayload } from "./mentor-contract.mjs";

/**
 * Browser-local, opt-in persistence for the public PaperPilot vertical slice.
 *
 * The snapshot deliberately contains only PaperPilot's canonical in-app state:
 * source anchors, annotations, graph data/layout, reversible history, audit
 * events, idempotency receipts, and explanations the human explicitly saved.
 * PDF/File/Blob/ArrayBuffer data is rejected before serialization.
 */

// Version 3 retains canonical reversible patches. Version 2 is decoded and
// validated in full before migration; its stored bytes are never overwritten.
// Version-1 candidate-only snapshots remain preserved without hydration.
export const BROWSER_SNAPSHOT_SCHEMA_VERSION = 3;
export const MAX_BROWSER_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const BROWSER_SNAPSHOT_KEY_PREFIX = `paperpilot:webmcp:v${BROWSER_SNAPSHOT_SCHEMA_VERSION}:`;
export const BROWSER_SNAPSHOT_LIMITS = Object.freeze({
  history: 200,
  redoHistory: 200,
  revisions: 200,
  events: 500,
  requestResults: 200,
  annotations: 800,
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_BINARY_KEYS = new Set([
  "arrayBuffer",
  "bytes",
  "dataUrl",
  "file",
  "fileBytes",
  "objectUrl",
  "pdf",
  "pdfBytes",
  "pdfData",
  "rawFile",
]);
const SEMANTIC_DIGEST_EXCLUSIONS = new Set([
  "x",
  "y",
  "size",
  "color",
  "hidden",
  "selected",
  "hovered",
  "entityRevision",
  "createdAt",
  "updatedAt",
]);
const ANNOTATION_DIGEST_EXCLUSIONS = new Set(["entityRevision", "createdAt", "updatedAt"]);

class SnapshotValidationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "SnapshotValidationError";
    this.reason = reason;
  }
}

function fail(reason, message) {
  throw new SnapshotValidationError(reason, message);
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, reason, message) {
  if (!isPlainObject(value)) fail(reason, message);
  return value;
}

function assertExactKeys(value, expected, reason) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(reason, `Unexpected snapshot fields: ${actual.join(", ")}`);
  }
}

function assertString(value, reason, message, { max = 16_384, pattern } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) {
    fail(reason, message);
  }
  return value;
}

function assertInteger(value, reason, message, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(reason, message);
  return value;
}

function assertJsonSafe(value, path = "snapshot", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("binary_or_non_json_state", `${path} contains a non-finite number.`);
    return;
  }
  if (typeof value !== "object") fail("binary_or_non_json_state", `${path} is not JSON-safe.`);
  if (
    value instanceof ArrayBuffer
    || (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value))
    || (typeof Blob !== "undefined" && value instanceof Blob)
    || (typeof File !== "undefined" && value instanceof File)
  ) {
    fail("binary_or_non_json_state", `${path} contains file or binary data.`);
  }
  if (seen.has(value)) fail("binary_or_non_json_state", `${path} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) fail("binary_or_non_json_state", `${path} contains a non-plain object.`);
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_BINARY_KEYS.has(key)) fail("raw_pdf_state_rejected", `${path}.${key} may contain raw PDF or File data.`);
      assertJsonSafe(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function jsonClone(value, path) {
  assertJsonSafe(value, path);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    fail("binary_or_non_json_state", `${path} could not be serialized as JSON.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortedEntries(map, path) {
  if (!(map instanceof Map)) fail("invalid_live_state", `${path} must be a Map.`);
  return [...map.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, value]) => [String(key), jsonClone(value, `${path}.${String(key)}`)]);
}

function serializeSemanticState(state, path = "workspace.current") {
  if (!state?.graph || typeof state.graph.export !== "function") {
    fail("invalid_live_state", `${path}.graph must be a Graphology graph.`);
  }
  return {
    anchors: sortedEntries(state.anchors, `${path}.anchors`),
    annotations: sortedEntries(state.annotations, `${path}.annotations`),
    graph: jsonClone(state.graph.export(), `${path}.graph`),
    workspaceRevision: assertInteger(state.workspaceRevision, "invalid_live_state", `${path}.workspaceRevision is invalid.`, { min: 1 }),
    workspaceDigest: assertString(state.workspaceDigest, "invalid_live_state", `${path}.workspaceDigest is invalid.`, { pattern: SHA256_RE }),
    graphDigest: assertString(state.graphDigest, "invalid_live_state", `${path}.graphDigest is invalid.`, { pattern: SHA256_RE }),
    annotationDigest: assertString(state.annotationDigest, "invalid_live_state", `${path}.annotationDigest is invalid.`, { pattern: SHA256_RE }),
    focusAnchorId: assertString(state.focusAnchorId, "invalid_live_state", `${path}.focusAnchorId is invalid.`, { max: 128 }),
  };
}

function serializeHistory(history, path, limit) {
  if (!Array.isArray(history)) fail("invalid_live_state", `${path} is invalid.`);
  if (history.length > limit) fail("history_invalid", `${path} exceeds the retained history limit.`);
  return jsonClone(history, path);
}

function serializeRequestResults(requestResults) {
  if (!(requestResults instanceof Map)) fail("invalid_live_state", "requestResults is invalid.");
  return [...requestResults.entries()]
    .slice(-BROWSER_SNAPSHOT_LIMITS.requestResults)
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, value]) => [
      assertString(String(key), "invalid_live_state", "An idempotency key is invalid.", { max: 64 }),
      jsonClone(value, `requestResults.${String(key)}`),
    ]);
}

function paperIdentityFromState(state) {
  const paper = assertPlainObject(state?.paper, "invalid_live_state", "The active paper identity is missing.");
  return {
    paperRef: assertString(paper.paperRef, "invalid_live_state", "The active paperRef is invalid.", { max: 256 }),
    documentSha256: assertString(paper.documentSha256, "invalid_live_state", "The active PDF digest is invalid.", { pattern: SHA256_RE }),
    pageCount: assertInteger(paper.pageCount, "invalid_live_state", "The active PDF page count is invalid.", { min: 1, max: 10_000 }),
  };
}

function validatePresentation(value, annotations, reason = "presentation_invalid") {
  assertPlainObject(value, reason, "The presentation snapshot is invalid.");
  assertExactKeys(value, ["annotationOrder"], reason);
  if (!Array.isArray(value.annotationOrder) || value.annotationOrder.length > BROWSER_SNAPSHOT_LIMITS.annotations) {
    fail(reason, "The annotation presentation order is invalid or unbounded.");
  }
  const seen = new Set();
  for (const annotationId of value.annotationOrder) {
    assertString(annotationId, reason, "The annotation presentation order contains an invalid ID.", { max: 128 });
    if (seen.has(annotationId) || !annotations.has(annotationId)) {
      fail(reason, "The annotation presentation order contains a duplicate or unknown ID.");
    }
    seen.add(annotationId);
  }
  return { annotationOrder: [...value.annotationOrder] };
}

function buildPayload(state, { savedExplanations, savedAt, presentation }) {
  const explanations = savedExplanations ?? state.savedExplanations ?? [];
  if (!Array.isArray(explanations) || explanations.length > 200) {
    fail("invalid_live_state", "savedExplanations is invalid or unbounded.");
  }
  if (!Array.isArray(state.events)) fail("invalid_live_state", "events is invalid.");
  const serializedExplanations = jsonClone(explanations, "savedExplanations");
  // Complete mentor validation is shared with restore below, after the global
  // byte ceiling is checked. Invalid notes never replace an existing save.
  const serializedPresentation = validatePresentation(
    jsonClone(
      presentation ?? { annotationOrder: [...state.annotations.keys()].sort((left, right) => left.localeCompare(right)) },
      "presentation",
    ),
    state.annotations,
    "invalid_live_state",
  );
  const identity = paperIdentityFromState(state);
  return {
    schemaVersion: BROWSER_SNAPSHOT_SCHEMA_VERSION,
    kind: "paperpilot_browser_workspace",
    savedAt: assertString(savedAt, "invalid_live_state", "savedAt is invalid.", { max: 64 }),
    paperIdentity: identity,
    workspace: {
      current: serializeSemanticState(state),
      history: serializeHistory(state.history, "workspace.history", BROWSER_SNAPSHOT_LIMITS.history),
      redoHistory: serializeHistory(state.redoHistory, "workspace.redoHistory", BROWSER_SNAPSHOT_LIMITS.redoHistory),
      revisions: serializeHistory(state.revisions || [], "workspace.revisions", BROWSER_SNAPSHOT_LIMITS.revisions),
    },
    requestResults: serializeRequestResults(state.requestResults),
    events: jsonClone(state.events.slice(-BROWSER_SNAPSHOT_LIMITS.events), "events"),
    savedExplanations: serializedExplanations,
    presentation: serializedPresentation,
  };
}

async function validateSerializedSemanticState(value, identity) {
  value.anchors = await Promise.all(value.anchors.map(async ([key, anchor]) => [
    key,
    await validateAnchor(anchor, key, identity),
  ]));
}

async function validateSerializedPayloadAnchors(payload) {
  const states = [payload.workspace.current];
  await Promise.all(states.map((state) => validateSerializedSemanticState(state, payload.paperIdentity)));
}

async function serializeEnvelope(state, options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const savedAt = typeof now === "function" ? now() : now;
  const payload = buildPayload(state, {
    savedExplanations: options.savedExplanations,
    presentation: options.presentation,
    savedAt,
  });
  await validateSerializedPayloadAnchors(payload);
  const payloadChecksum = await sha256Text(canonicalJson(payload));
  const raw = JSON.stringify({
    schemaVersion: BROWSER_SNAPSHOT_SCHEMA_VERSION,
    payloadChecksum,
    payload,
  });
  // Validate the same complete replay surface before replacing any current-v3
  // save, not just on the next upload. Invalid live state must not poison it.
  if (utf8Bytes(raw) <= MAX_BROWSER_SNAPSHOT_BYTES) await decodeEnvelope(raw, state);
  return { raw, payload, payloadChecksum, bytes: utf8Bytes(raw) };
}

function validateStorage(storage) {
  if (
    !storage
    || typeof storage.getItem !== "function"
    || typeof storage.setItem !== "function"
    || typeof storage.removeItem !== "function"
  ) {
    throw new TypeError("An injected Storage-compatible adapter is required.");
  }
}

export function browserSnapshotKey(documentSha256) {
  assertString(documentSha256, "invalid_identity", "A lowercase SHA-256 document identity is required.", { pattern: SHA256_RE });
  return `${BROWSER_SNAPSHOT_KEY_PREFIX}${documentSha256}`;
}

function storageFailure(error) {
  const name = typeof error?.name === "string" ? error.name : "StorageError";
  const quota = name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
  return {
    status: "storage_error",
    reason: quota ? "quota_exceeded" : "storage_unavailable",
    errorName: name,
  };
}

export async function saveBrowserSnapshot({ storage, state, savedExplanations, presentation, now } = {}) {
  validateStorage(storage);
  let identity;
  let envelope;
  try {
    identity = paperIdentityFromState(state);
    envelope = await serializeEnvelope(state, { savedExplanations, presentation, now });
  } catch (error) {
    if (error instanceof SnapshotValidationError) {
      return { status: "invalid_state", reason: error.reason, message: error.message };
    }
    throw error;
  }
  const key = browserSnapshotKey(identity.documentSha256);
  if (envelope.bytes > MAX_BROWSER_SNAPSHOT_BYTES) {
    return {
      status: "too_large",
      key,
      bytes: envelope.bytes,
      maxBytes: MAX_BROWSER_SNAPSHOT_BYTES,
    };
  }
  try {
    storage.setItem(key, envelope.raw);
  } catch (error) {
    return { ...storageFailure(error), key, bytes: envelope.bytes };
  }
  return {
    status: "saved",
    key,
    bytes: envelope.bytes,
    savedAt: envelope.payload.savedAt,
    workspaceRevision: state.workspaceRevision,
  };
}

function validatePairEntries(value, reason, max) {
  if (!Array.isArray(value) || value.length > max) fail(reason, "Snapshot entries are invalid or unbounded.");
  const keys = new Set();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !isPlainObject(entry[1])) {
      fail(reason, "A snapshot entry is malformed.");
    }
    if (keys.has(entry[0])) fail(reason, "A snapshot entry key is duplicated.");
    keys.add(entry[0]);
  }
  return keys;
}

function importGraph(templateGraph, graphExport) {
  assertPlainObject(graphExport, "graph_invalid", "The stored graph export is invalid.");
  assertExactKeys(graphExport, ["options", "attributes", "nodes", "edges"], "graph_invalid");
  assertPlainObject(graphExport.options, "graph_invalid", "The stored graph options are invalid.");
  if (
    graphExport.options.type !== "directed"
    || graphExport.options.multi !== true
    || graphExport.options.allowSelfLoops !== false
    || !Array.isArray(graphExport.nodes)
    || graphExport.nodes.length > 600
    || !Array.isArray(graphExport.edges)
    || graphExport.edges.length > 1_200
  ) {
    fail("graph_invalid", "The stored graph exceeds or changes the frozen graph contract.");
  }
  try {
    const graph = templateGraph.copy();
    graph.clear();
    if (typeof graph.replaceAttributes === "function") graph.replaceAttributes({});
    graph.import(jsonClone(graphExport, "stored.graph"));
    return graph;
  } catch {
    fail("graph_invalid", "The stored graph could not be imported.");
  }
}

function isCanonicalSpatialAnchor(anchor) {
  const canonicalFields = ["documentSha256", "rendererRecipe", "geometryKind"];
  const presentFields = canonicalFields.filter(
    (field) => Object.prototype.hasOwnProperty.call(anchor, field),
  );
  return presentFields.length === canonicalFields.length
    || (anchor.schemaVersion === 1 && presentFields.length > 0);
}

async function validateAnchor(anchor, key, identity) {
  assertPlainObject(anchor, "anchor_invalid", `Anchor ${key} is invalid.`);
  if (isCanonicalSpatialAnchor(anchor)) {
    let validated;
    try {
      validated = await validateSpatialAnchor(anchor, {
        paperRef: identity.paperRef,
        documentSha256: identity.documentSha256,
        pageIndex: anchor.pageIndex,
      });
    } catch (error) {
      const detail = typeof error?.message === "string" && error.message
        ? ` ${error.message}`
        : "";
      fail("anchor_invalid", `Anchor ${key} failed canonical spatial validation.${detail}`);
    }
    if (validated.anchorId !== key) fail("anchor_invalid", `Anchor ${key} has a mismatched canonical ID.`);
    assertInteger(validated.pageIndex, "anchor_invalid", `Anchor ${key} has an invalid page.`, { min: 0, max: identity.pageCount - 1 });
    return validated;
  }
  if (anchor.anchorId !== key || anchor.paperRef !== identity.paperRef) fail("anchor_invalid", `Anchor ${key} is bound to another paper.`);
  assertString(anchor.anchorDigest, "anchor_invalid", `Anchor ${key} has an invalid digest.`, { pattern: SHA256_RE });
  const projection = { ...anchor };
  delete projection.anchorDigest;
  const expected = await sha256Text(canonicalJson(projection));
  if (expected !== anchor.anchorDigest) fail("anchor_digest_mismatch", `Anchor ${key} failed its digest check.`);
  assertInteger(anchor.pageIndex, "anchor_invalid", `Anchor ${key} has an invalid page.`, { min: 0, max: identity.pageCount - 1 });
  return anchor;
}

function semanticGraphProjection(graph) {
  const semanticAttributes = (attributes) => Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => !SEMANTIC_DIGEST_EXCLUSIONS.has(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    nodes: graph.nodes().sort().map((key) => ({ key, ...semanticAttributes(graph.getNodeAttributes(key)) })),
    edges: graph.edges().sort().map((key) => ({
      key,
      sourceKey: graph.source(key),
      targetKey: graph.target(key),
      ...semanticAttributes(graph.getEdgeAttributes(key)),
    })),
  };
}

function semanticAnnotationProjection(annotations) {
  return [...annotations.values()]
    .sort((left, right) => left.annotationId.localeCompare(right.annotationId))
    .map((annotation) => Object.fromEntries(
      Object.entries(annotation).filter(([key]) => !ANNOTATION_DIGEST_EXCLUSIONS.has(key)),
    ));
}

async function semanticStateDigests(decoded) {
  const graphProjection = semanticGraphProjection(decoded.graph);
  const annotationProjection = semanticAnnotationProjection(decoded.annotations);
  const graphDigest = await sha256Text(canonicalJson(graphProjection));
  const annotationDigest = await sha256Text(canonicalJson(annotationProjection));
  const workspaceDigest = await sha256Text(canonicalJson({ graph: graphProjection, annotations: annotationProjection }));
  return { graphDigest, annotationDigest, workspaceDigest };
}

async function verifySemanticDigests(decoded, stored) {
  const { graphDigest, annotationDigest, workspaceDigest } = await semanticStateDigests(decoded);
  if (
    graphDigest !== stored.graphDigest
    || annotationDigest !== stored.annotationDigest
    || workspaceDigest !== stored.workspaceDigest
  ) {
    fail("semantic_digest_mismatch", "The stored workspace failed its semantic digest check.");
  }
}

function validateGraphAnchorReferences(graph, anchors) {
  for (const key of graph.nodes()) {
    const attributes = graph.getNodeAttributes(key);
    for (const anchorId of attributes.sourceAnchorIds || []) {
      if (!anchors.has(anchorId)) fail("graph_reference_invalid", `Node ${key} references a missing anchor.`);
    }
    for (const coverage of attributes.structuralCoverage || []) {
      if (coverage.primaryAnchorId && !anchors.has(coverage.primaryAnchorId)) {
        fail("graph_reference_invalid", `Node ${key} has invalid structural provenance.`);
      }
    }
  }
  for (const key of graph.edges()) {
    const attributes = graph.getEdgeAttributes(key);
    for (const anchorId of attributes.sourceAnchorIds || []) {
      if (!anchors.has(anchorId)) fail("graph_reference_invalid", `Edge ${key} references a missing anchor.`);
    }
  }
}

function validateStructuralBaseline(snapshot, structuralMap, templateState) {
  if (!structuralMap) return;
  const { graph, anchors } = snapshot;
  const templateGraph = templateState.graph;
  const expectedNodeKeys = new Set(["node:paper", ...structuralMap.nodes.map(({ key }) => key)]);
  const expectedEdgeKeys = new Set(structuralMap.nodes.map(({ edgeKey }) => edgeKey));
  const root = graph.hasNode("node:paper") ? graph.getNodeAttributes("node:paper") : null;
  const baselineRoot = templateGraph.getNodeAttributes("node:paper");
  if (
    !root
    || root.kind !== "paper"
    || root.authority !== "document_structure"
    || root.status !== "active"
    || root.summary !== baselineRoot.summary
    || canonicalJson(root.sourceAnchorIds) !== canonicalJson(baselineRoot.sourceAnchorIds)
    || canonicalJson(root.structuralCoverage) !== canonicalJson(baselineRoot.structuralCoverage)
  ) {
    fail("structural_baseline_mismatch", "The stored graph does not retain the active PDF paper root.");
  }
  // The upload filename supplies this display title; it is not PDF identity.
  // Bound the stored value, then replace it with the current trusted title only
  // after the entire envelope (including all structural records) is validated.
  assertString(root.label, "structural_baseline_mismatch", "The stored paper display title is invalid.", { max: 240 });
  const expectedAnchorIds = new Set([
    ...baselineRoot.structuralCoverage.map(({ primaryAnchorId }) => primaryAnchorId),
    ...structuralMap.nodes.map(({ anchorId }) => anchorId),
  ]);
  for (const anchorId of expectedAnchorIds) {
    const trusted = templateState.anchors.get(anchorId);
    const stored = anchors.get(anchorId);
    // These page-minted baseline records have no volatile metadata: structural
    // createdAt is fixed, the paper-root anchor has no timestamp, and neither
    // includes the upload filename. Compare the complete canonical record, not
    // only a self-reported digest/ID that a stored envelope can recompute.
    if (!trusted || !stored || canonicalJson(stored) !== canonicalJson(trusted)) {
      fail("structural_baseline_mismatch", "A stored PDF-derived primary anchor no longer matches the current page-minted source.");
    }
  }
  for (const expected of structuralMap.nodes) {
    if (!graph.hasNode(expected.key) || !graph.hasEdge(expected.edgeKey)) {
      fail("structural_baseline_mismatch", "The stored graph is missing a PDF-derived structural range.");
    }
    const attributes = graph.getNodeAttributes(expected.key);
    const baselineAttributes = templateGraph.getNodeAttributes(expected.key);
    const coverage = attributes.structuralCoverage;
    if (
      attributes.kind !== "section"
      || attributes.authority !== "document_structure"
      || attributes.origin !== "automatic_map"
      || attributes.status !== "active"
      || attributes.label !== baselineAttributes.label
      || attributes.summary !== baselineAttributes.summary
      || canonicalJson(attributes.sourceAnchorIds) !== canonicalJson(baselineAttributes.sourceAnchorIds)
      || attributes.structuralBasis !== expected.basis
      || attributes.structuralConfidence !== expected.confidence
      || !Array.isArray(coverage)
      || coverage.length !== 1
      || coverage[0].startPageIndex !== expected.startPageIndex
      || coverage[0].endPageIndex !== expected.endPageIndex
      || coverage[0].primaryAnchorId !== expected.anchorId
    ) {
      fail("structural_baseline_mismatch", "A stored PDF-derived structural range no longer matches the current deterministic map.");
    }
    const edge = graph.getEdgeAttributes(expected.edgeKey);
    const baselineEdge = templateGraph.getEdgeAttributes(expected.edgeKey);
    if (
      graph.source(expected.edgeKey) !== "node:paper"
      || graph.target(expected.edgeKey) !== expected.key
      || edge.kind !== "contains"
      || edge.authority !== "document_structure"
      || edge.origin !== "automatic_map"
      || edge.status !== "active"
      || edge.claim !== baselineEdge.claim
      || !Array.isArray(edge.sourceAnchorIds)
      || edge.sourceAnchorIds.length !== 1
      || edge.sourceAnchorIds[0] !== expected.anchorId
    ) {
      fail("structural_baseline_mismatch", "A stored PDF-derived containment edge no longer matches the current deterministic map.");
    }
  }
  for (const key of graph.nodes()) {
    const attributes = graph.getNodeAttributes(key);
    if (attributes.authority === "document_structure" && !expectedNodeKeys.has(key)) {
      fail("structural_baseline_mismatch", "The stored graph contains an unexpected document-structure node.");
    }
  }
  for (const key of graph.edges()) {
    const attributes = graph.getEdgeAttributes(key);
    if (attributes.authority === "document_structure" && !expectedEdgeKeys.has(key)) {
      fail("structural_baseline_mismatch", "The stored graph contains an unexpected document-structure edge.");
    }
  }
}

function validateAnnotations(annotations, anchors, graph, identity) {
  for (const [key, annotation] of annotations) {
    if (annotation.annotationId !== key || annotation.paperRef !== identity.paperRef || !anchors.has(annotation.anchorId)) {
      fail("annotation_invalid", `Annotation ${key} has invalid paper provenance.`);
    }
    for (const nodeKey of annotation.graphNodeKeys || []) {
      if (!graph.hasNode(nodeKey)) fail("annotation_invalid", `Annotation ${key} references a missing graph node.`);
    }
    for (const edgeKey of annotation.graphEdgeKeys || []) {
      if (!graph.hasEdge(edgeKey)) fail("annotation_invalid", `Annotation ${key} references a missing graph edge.`);
    }
  }
}

async function refreshTrustedPaperTitle(decoded, state) {
  if (!state.structuralMap) return false;
  const trustedTitle = state.graph.getNodeAttribute("node:paper", "label");
  const snapshots = [decoded.current, ...[...decoded.history, ...decoded.redoHistory].flatMap((entry) => [entry.before, entry.after])];
  let refreshed = false;
  for (const snapshot of snapshots) {
    if (snapshot.graph.getNodeAttribute("node:paper", "label") === trustedTitle) continue;
    snapshot.graph.setNodeAttribute("node:paper", "label", trustedTitle);
    // The current schema includes labels in semantic digests. Normalize every
    // undo/redo snapshot consistently; original callback/event receipts remain
    // unchanged historical records of the earlier display-title generation.
    Object.assign(snapshot, await semanticStateDigests(snapshot));
    refreshed = true;
  }
  return refreshed;
}

async function decodeSemanticState(value, templateGraph, identity, path) {
  assertPlainObject(value, "workspace_invalid", `${path} is invalid.`);
  assertExactKeys(
    value,
    ["anchors", "annotations", "graph", "workspaceRevision", "workspaceDigest", "graphDigest", "annotationDigest", "focusAnchorId"],
    "workspace_invalid",
  );
  const anchorKeys = validatePairEntries(value.anchors, "anchor_invalid", 11_000);
  validatePairEntries(value.annotations, "annotation_invalid", 800);
  const anchors = new Map(await Promise.all(value.anchors.map(async ([key, anchor]) => {
    const cloned = structuredClone(anchor);
    return [key, await validateAnchor(cloned, key, identity)];
  })));
  const annotations = new Map(value.annotations.map(([key, annotation]) => [key, structuredClone(annotation)]));
  const graph = importGraph(templateGraph, value.graph);
  validateGraphAnchorReferences(graph, anchors);
  validateAnnotations(annotations, anchors, graph, identity);
  if (!anchorKeys.has(value.focusAnchorId)) fail("workspace_invalid", `${path}.focusAnchorId is missing.`);
  const decoded = {
    anchors,
    annotations,
    graph,
    workspaceRevision: assertInteger(value.workspaceRevision, "workspace_invalid", `${path}.workspaceRevision is invalid.`, { min: 1 }),
    workspaceDigest: assertString(value.workspaceDigest, "workspace_invalid", `${path}.workspaceDigest is invalid.`, { pattern: SHA256_RE }),
    graphDigest: assertString(value.graphDigest, "workspace_invalid", `${path}.graphDigest is invalid.`, { pattern: SHA256_RE }),
    annotationDigest: assertString(value.annotationDigest, "workspace_invalid", `${path}.annotationDigest is invalid.`, { pattern: SHA256_RE }),
    focusAnchorId: value.focusAnchorId,
  };
  await verifySemanticDigests(decoded, value);
  return decoded;
}

async function decodeHistory(value, templateGraph, identity, path) {
  const limit = path.endsWith("redoHistory")
    ? BROWSER_SNAPSHOT_LIMITS.redoHistory
    : BROWSER_SNAPSHOT_LIMITS.history;
  if (!Array.isArray(value) || value.length > limit) fail("history_invalid", `${path} is invalid or unbounded.`);
  return Promise.all(value.map(async (entry, index) => {
    assertPlainObject(entry, "history_invalid", `${path}[${index}] is invalid.`);
    const allowed = entry.operationId === undefined
      ? ["kind", "revisionId", "before", "after"]
      : ["kind", "revisionId", "operationId", "before", "after"];
    assertExactKeys(entry, allowed, "history_invalid");
    const decoded = {
      kind: assertString(entry.kind, "history_invalid", `${path}[${index}].kind is invalid.`, { max: 64 }),
      revisionId: assertString(entry.revisionId, "history_invalid", `${path}[${index}].revisionId is invalid.`, { max: 128 }),
      before: await decodeSemanticState(entry.before, templateGraph, identity, `${path}[${index}].before`),
      after: await decodeSemanticState(entry.after, templateGraph, identity, `${path}[${index}].after`),
    };
    if (entry.operationId !== undefined) decoded.operationId = assertString(entry.operationId, "history_invalid", `${path}[${index}].operationId is invalid.`, { max: 128 });
    return decoded;
  }));
}

const MENTOR_METADATA_FIELDS = ["explanationId", "responseDigest", "savedAt", "humanDecision", "takeaway"];
const MENTOR_ID_RE = /^[a-z][a-z0-9:_-]{2,127}$/u;

function validateMentorMetadata(explanation, index) {
  const reason = "saved_explanations_invalid";
  assertString(explanation.explanationId, reason, `Saved explanation ${index} has no valid id.`, { max: 128, pattern: MENTOR_ID_RE });
  assertString(explanation.responseDigest, reason, `Saved explanation ${index} has no valid digest.`, { pattern: SHA256_RE });
  if (Object.hasOwn(explanation, "savedAt")) assertString(explanation.savedAt, reason, "The saved mentor timestamp is invalid.", { max: 64 });
  if (Object.hasOwn(explanation, "humanDecision") && explanation.humanDecision !== "saved") fail(reason, "A persisted mentor decision must be saved by the human.");
  if (Object.hasOwn(explanation, "takeaway") && (typeof explanation.takeaway !== "string" || [...explanation.takeaway].length > 1200)) fail(reason, "The human takeaway is invalid or unbounded.");
}

function validateLegacyMentorRecord(explanation) {
  const reason = "saved_explanations_invalid";
  // Historical releases also retained partial seven-string notes. Preserve
  // their exact text and declared references, but never infer claim authority
  // or assert that their opaque responseDigest used the new digest recipe.
  const payload = mentorPayloadFromRecord(explanation);
  const metadata = MENTOR_METADATA_FIELDS.filter((key) => Object.hasOwn(explanation, key));
  assertExactKeys(explanation, [...Object.keys(payload), ...metadata], reason);
  if (Object.hasOwn(explanation, "explanationVersion") && explanation.explanationVersion !== 1) fail(reason, "The saved mentor version is unsupported.");
  assertPlainObject(explanation.sections, reason, "A legacy mentor note must contain its original prose sections.");
  for (const [key, section] of Object.entries(explanation.sections)) {
    const maximum = key === "howItWorks" ? 2000 : key === "quickTake" ? 1200 : 1500;
    if (!MENTOR_SECTION_KEYS.includes(key) || typeof section !== "string" || [...section].length > maximum) fail(reason, "A legacy mentor section is invalid or unbounded.");
  }
  for (const [key, maximum] of [["sourceAnchorIds", 12], ["graphEntityKeys", 20]]) {
    if (!Object.hasOwn(explanation, key)) continue;
    const ids = explanation[key];
    if (!Array.isArray(ids) || ids.length > maximum || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !MENTOR_ID_RE.test(id))) fail(reason, "A legacy mentor reference is invalid or unbounded.");
  }
  if (Object.hasOwn(explanation, "focusAnchorId")) assertString(explanation.focusAnchorId, reason, "The legacy focus ID is invalid.", { max: 128, pattern: MENTOR_ID_RE });
  if (Object.hasOwn(explanation, "expectedWorkspaceRevision")) assertInteger(explanation.expectedWorkspaceRevision, reason, "The legacy graph revision is invalid.", { min: 1 });
  if (Object.hasOwn(explanation, "expectedGraphDigest")) assertString(explanation.expectedGraphDigest, reason, "The legacy graph digest is invalid.", { pattern: SHA256_RE });
  if (Object.hasOwn(explanation, "visualEvidenceMode") && !["not_applicable", "locator_only", "client_visible_region"].includes(explanation.visualEvidenceMode)) fail(reason, "The legacy visual mode is invalid.");
  if (Object.hasOwn(explanation, "visualObservation")) assertString(explanation.visualObservation, reason, "The legacy visual observation is invalid.", { max: 1000 });
}

async function validateSavedExplanations(value, current, identity) {
  if (!Array.isArray(value) || value.length > 200) fail("saved_explanations_invalid", "savedExplanations is invalid or unbounded.");
  const ids = new Set();
  for (const [index, explanation] of value.entries()) {
    assertPlainObject(explanation, "saved_explanations_invalid", `Saved explanation ${index} is invalid.`);
    validateMentorMetadata(explanation, index);
    if (ids.has(explanation.explanationId)) fail("saved_explanations_invalid", "A saved mentor ID is duplicated.");
    ids.add(explanation.explanationId);
    try {
      if (explanation.explanationVersion !== 2) {
        validateLegacyMentorRecord(explanation);
        continue;
      }
      const payload = mentorPayloadFromRecord(explanation);
      const metadata = MENTOR_METADATA_FIELDS.filter((key) => Object.hasOwn(explanation, key));
      assertExactKeys(explanation, [...Object.keys(payload), ...metadata], "saved_explanations_invalid");
      validateMentorPayload(payload, {
        paperRef: identity.paperRef,
        documentSha256: identity.documentSha256,
        resolveAnchor: (id) => current.anchors.get(id),
        resolveGraphEntity: (key) => current.graph.hasNode(key) ? current.graph.getNodeAttributes(key)
          : current.graph.hasEdge(key) ? current.graph.getEdgeAttributes(key) : undefined,
        allowMissingReferences: true,
        visualEvidenceMode: "locator_only",
      });
      // This public release does not retain or verify source-bound pixel use.
      // Missing references cannot turn that capability check into an exemption.
      if (payload.visualEvidenceMode === "client_visible_region") fail("saved_explanations_invalid", "The saved mentor note claims unsupported pixel evidence.");
      if (payload.expectedWorkspaceRevision > current.workspaceRevision) fail("saved_explanations_invalid", "The saved mentor note names a future workspace revision.");
      const digest = await sha256Text(canonicalJson(payload));
      if (digest !== explanation.responseDigest) fail("saved_explanation_digest_mismatch", "A saved mentor note no longer matches its original staged response digest.");
    } catch (error) {
      if (error instanceof SnapshotValidationError) throw error;
      fail("saved_explanations_invalid", "A saved mentor note failed its closed claim, citation, or source-authority contract.");
    }
  }
}

function validateRequestResults(value, { allowTombstones = false } = {}) {
  validatePairEntries(value, "request_results_invalid", BROWSER_SNAPSHOT_LIMITS.requestResults);
  const result = new Map();
  for (const [key, entry] of value) {
    assertString(key, "request_results_invalid", "A stored idempotency key is invalid.", { max: 64 });
    assertPlainObject(entry, "request_results_invalid", `Request result ${key} is invalid.`);
    assertExactKeys(entry, ["commandDigest", "result"], "request_results_invalid");
    assertString(entry.commandDigest, "request_results_invalid", `Request result ${key} has an invalid command digest.`, { pattern: SHA256_RE });
    if (allowTombstones && entry.result === null) {
      result.set(key, structuredClone(entry));
      continue;
    }
    assertPlainObject(entry.result, "request_results_invalid", `Request result ${key} has an invalid result.`);
    const toolName = Object.hasOwn(entry.result, "beforeGraphDigest") ? "paperpilot.apply_graph" : "paperpilot.apply_annotation";
    try {
      validateToolResult(toolName, entry.result);
    } catch {
      fail("request_results_invalid", `Request result ${key} does not match a closed mutation result.`);
    }
    if (entry.result.status !== "applied_reversible" || entry.result.replayed !== false || entry.result.idempotencyKey !== key) {
      fail("request_results_invalid", `Request result ${key} is not its original applied mutation receipt.`);
    }
    result.set(key, structuredClone(entry));
  }
  return result;
}

function validateRequestHistory(decoded, { legacy = false } = {}) {
  const originals = new Map([...decoded.history, ...decoded.redoHistory, ...decoded.revisions]
    .filter((entry) => ["graph", "annotation"].includes(entry.kind)).map((entry) => [entry.revisionId, entry]));
  let discarded = 0;
  for (const [key, receipt] of decoded.requestResults) {
    const result = receipt.result;
    if (result === null) continue;
    const entry = originals.get(result.revisionId);
    if (!entry) {
      if (legacy) { decoded.requestResults.set(key, { commandDigest: receipt.commandDigest, result: null }); discarded += 1; continue; }
      fail("request_results_invalid", "A cached applied receipt has no retained original revision.");
    }
    const kind = Object.hasOwn(result, "beforeGraphDigest") ? "graph" : "annotation";
    const patches = legacy ? createWorkspacePatch(entry.before, entry.after) : entry;
    const expected = legacy ? {
      operationId: entry.operationId,
      fromRevision: entry.before.workspaceRevision, toRevision: entry.after.workspaceRevision,
      beforeWorkspaceDigest: entry.before.workspaceDigest, afterWorkspaceDigest: entry.after.workspaceDigest,
      ...(kind === "graph" ? { beforeGraphDigest: entry.before.graphDigest, afterGraphDigest: entry.after.graphDigest }
        : { beforeAnnotationDigest: entry.before.annotationDigest, afterAnnotationDigest: entry.after.annotationDigest }),
    } : entry;
    const fields = ["operationId", "fromRevision", "toRevision", "beforeWorkspaceDigest", "afterWorkspaceDigest",
      ...(kind === "graph" ? ["beforeGraphDigest", "afterGraphDigest"] : ["beforeAnnotationDigest", "afterAnnotationDigest"])];
    if (kind !== entry.kind || fields.some((field) => expected[field] !== undefined && result[field] !== expected[field])
      || (!legacy && (receipt.commandDigest !== entry.commandDigest || key !== entry.idempotencyKey))) {
      fail("request_results_invalid", "A cached applied receipt disagrees with its retained original revision.");
    }
    const affected = [...new Set(Object.values(result.affected).flat())].sort();
    const patchKeys = [...new Set(patches.forwardPatch.map(({ key: affectedKey }) => affectedKey))].sort();
    if (canonicalJson(affected) !== canonicalJson(patchKeys)) fail("request_results_invalid", "A cached receipt reports different affected entities from its patch.");
    for (const patch of patches.forwardPatch) {
      const categories = Object.entries(result.affected).filter(([, keys]) => keys.includes(patch.key)).map(([category]) => category);
      if ((categories.includes("created") && patch.before !== null)
        || (categories.length === 1 && categories[0] === "tombstoned" && patch.after?.status !== "tombstoned")
        || (categories.length === 1 && categories[0] === "restored" && (patch.before?.status !== "tombstoned" || patch.after?.status !== "active"))) {
        fail("request_results_invalid", "A cached receipt misclassifies its affected entities.");
      }
    }
  }
  decoded.replayInvalidatedCount = discarded;
}

const REVISION_FIELDS = [
  "schemaVersion", "kind", "revisionId", "operationId", "paperRef", "idempotencyKey", "commandDigest", "actor", "transport",
  "reason", "fromRevision", "toRevision", "beforeWorkspaceDigest", "afterWorkspaceDigest", "beforeGraphDigest", "afterGraphDigest",
  "beforeAnnotationDigest", "afterAnnotationDigest", "forwardPatch", "inversePatch", "affectedKeys", "sourceAnchorIds", "reviewState",
  "createdAt", "beforeFocusAnchorId", "afterFocusAnchorId",
];
const ORIGINAL_REVISION_KINDS = new Set(["graph", "annotation", "reader_annotation_graph", "reader_annotation_removal"]);

function validateStringSet(values, path, max = 12_000) {
  if (!Array.isArray(values) || values.length > max || new Set(values).size !== values.length) fail("history_invalid", `${path} is invalid or duplicated.`);
  for (const value of values) assertString(value, "history_invalid", `${path} contains an invalid ID.`, { max: 256 });
}

function validatePatchRevision(value, identity, { ledger = false } = {}) {
  assertPlainObject(value, "history_invalid", "A patch revision is invalid.");
  const optional = ["toolName", "relatedRevisionId"].filter((key) => Object.hasOwn(value, key));
  assertExactKeys(value, [...REVISION_FIELDS, ...optional], "history_invalid");
  const reversal = value.kind === "undo" || value.kind === "redo";
  if (value.schemaVersion !== 1 || (!ORIGINAL_REVISION_KINDS.has(value.kind) && !(ledger && reversal))) fail("history_invalid", "A patch revision kind/version is invalid.");
  if (value.paperRef !== identity.paperRef) fail("identity_mismatch", "A history revision belongs to another paper.");
  for (const key of ["revisionId", "operationId", "beforeFocusAnchorId", "afterFocusAnchorId"]) {
    assertString(value[key], "history_invalid", `Revision ${key} is invalid.`, { max: 128 });
  }
  assertString(value.idempotencyKey, "history_invalid", "Revision idempotency key is invalid.", { max: 64 });
  assertString(value.commandDigest, "history_invalid", "Revision command digest is invalid.", { pattern: SHA256_RE });
  assertString(value.reason, "history_invalid", "Revision reason is invalid.", { max: 4096 });
  assertString(value.createdAt, "history_invalid", "Revision timestamp is invalid.", { max: 64 });
  if (!["human", "agent"].includes(value.actor) || !["direct_ui", "webmcp"].includes(value.transport)
    || !["unreviewed", "not_applicable"].includes(value.reviewState)) fail("history_invalid", "Revision attribution is invalid.");
  if ((value.actor === "agent") !== (value.transport === "webmcp")
    || (value.actor === "agent") !== (value.reviewState === "unreviewed")) fail("history_invalid", "Revision attribution is inconsistent.");
  if (!reversal && (value.actor === "agent") !== ["graph", "annotation"].includes(value.kind)) fail("history_invalid", "Revision kind and actor disagree.");
  if (value.toolName !== undefined && !["paperpilot.apply_graph", "paperpilot.apply_annotation"].includes(value.toolName)) fail("history_invalid", "Revision tool is invalid.");
  if (reversal && (value.actor !== "human" || !value.relatedRevisionId)) fail("history_invalid", "Undo/Redo must identify a human compensating revision.");
  if (value.relatedRevisionId !== undefined) assertString(value.relatedRevisionId, "history_invalid", "Related revision is invalid.", { max: 128 });
  if (!reversal && value.relatedRevisionId !== undefined) fail("history_invalid", "An original revision cannot impersonate a reversal.");
  assertInteger(value.fromRevision, "history_invalid", "Revision start is invalid.", { min: 1 });
  assertInteger(value.toRevision, "history_invalid", "Revision end is invalid.", { min: 2 });
  if (value.toRevision !== value.fromRevision + 1) fail("history_invalid", "A revision must advance exactly once.");
  for (const prefix of ["before", "after"]) for (const suffix of ["WorkspaceDigest", "GraphDigest", "AnnotationDigest"]) {
    assertString(value[`${prefix}${suffix}`], "history_invalid", "Revision endpoint digest is invalid.", { pattern: SHA256_RE });
  }
  validateStringSet(value.affectedKeys, "affectedKeys");
  validateStringSet(value.sourceAnchorIds, "sourceAnchorIds");
  let forwardPatch;
  let inversePatch;
  try {
    forwardPatch = validateWorkspacePatch(value.forwardPatch);
    inversePatch = validateWorkspacePatch(value.inversePatch);
    if (canonicalJson(invertWorkspacePatch(forwardPatch)) !== canonicalJson(inversePatch)) fail("history_inverse_mismatch", "The stored inverse does not exactly invert its forward patch.");
  } catch (error) {
    if (error instanceof SnapshotValidationError) throw error;
    fail("history_patch_invalid", "A stored patch is not a valid closed canonical patch.");
  }
  const affected = [...new Set(forwardPatch.map(({ key }) => key))].sort();
  if (canonicalJson([...value.affectedKeys].sort()) !== canonicalJson(affected)) fail("history_invalid", "Revision affected IDs differ from its patch.");
  return { ...structuredClone(value), forwardPatch, inversePatch };
}

function decodePatchRevisions(value, identity, { ledger = false } = {}) {
  if (!Array.isArray(value) || value.length > BROWSER_SNAPSHOT_LIMITS.revisions) fail("history_invalid", "Stored patch history is invalid or unbounded.");
  const revisions = value.map((entry) => validatePatchRevision(entry, identity, { ledger }));
  if (new Set(revisions.map(({ revisionId }) => revisionId)).size !== revisions.length) fail("history_invalid", "A revision ID is duplicated.");
  return revisions;
}

function revisionEndpoint(entry, prefix) {
  return {
    workspaceDigest: entry[`${prefix}WorkspaceDigest`], graphDigest: entry[`${prefix}GraphDigest`],
    annotationDigest: entry[`${prefix}AnnotationDigest`], focusAnchorId: entry[`${prefix}FocusAnchorId`],
    workspaceRevision: prefix === "before" ? entry.fromRevision : entry.toRevision,
  };
}

function protectStructuralPatch(entry, state) {
  if (!state.structuralMap) return;
  const nodeKeys = new Set(["node:paper", ...state.structuralMap.nodes.map(({ key }) => key)]);
  const edgeKeys = new Set(state.structuralMap.nodes.map(({ edgeKey }) => edgeKey));
  const anchorKeys = new Set([
    ...state.graph.getNodeAttribute("node:paper", "structuralCoverage").map(({ primaryAnchorId }) => primaryAnchorId),
    ...state.structuralMap.nodes.map(({ anchorId }) => anchorId),
  ]);
  for (const operation of entry.forwardPatch) {
    if ((operation.op === "put_node" && nodeKeys.has(operation.key))
      || (operation.op === "put_edge" && edgeKeys.has(operation.key))
      || (operation.op === "put_anchor" && anchorKeys.has(operation.key))) {
      fail("structural_baseline_mismatch", "A history patch attempts to change the immutable structural baseline.");
    }
  }
}

async function replayRevision(start, entry, direction, state, identity, endpoints) {
  protectStructuralPatch(entry, state);
  const sourcePrefix = direction === "forward" ? "before" : "after";
  const targetPrefix = direction === "forward" ? "after" : "before";
  await verifySemanticDigests(start, revisionEndpoint(entry, sourcePrefix));
  if (!start.anchors.has(entry[`${sourcePrefix}FocusAnchorId`])) fail("history_invalid", "A revision source focus is missing.");
  let applied;
  try {
    applied = applyWorkspacePatch(start, direction === "forward" ? entry.forwardPatch : entry.inversePatch);
  } catch {
    fail("history_chain_mismatch", "A history patch does not match its expected workspace records.");
  }
  const target = { ...applied, ...revisionEndpoint(entry, targetPrefix) };
  const decoded = await decodeSemanticState(serializeSemanticState(target), state.graph, identity, "workspace.replayed");
  validateStructuralBaseline(decoded, state.structuralMap, state);
  const pair = direction === "forward" ? { before: start, after: decoded } : { before: decoded, after: start };
  for (const anchorId of entry.sourceAnchorIds) {
    if (!pair.before.anchors.has(anchorId) && !pair.after.anchors.has(anchorId)) fail("history_invalid", "Revision source attribution references an unknown anchor.");
  }
  endpoints.set(entry, pair);
  return decoded;
}

async function validatePatchHistory(decoded, state, identity) {
  const endpoints = new Map();
  const retained = [...decoded.history, ...decoded.redoHistory];
  const stackIds = retained.map(({ revisionId }) => revisionId);
  if (new Set(stackIds).size !== stackIds.length) fail("history_invalid", "Undo and Redo contain the same revision.");
  if (retained.some((entry) => entry.toRevision > decoded.current.workspaceRevision)) fail("history_chain_mismatch", "A retained revision is newer than the current workspace head.");
  let cursor = decoded.current;
  for (const entry of [...decoded.history].reverse()) cursor = await replayRevision(cursor, entry, "inverse", state, identity, endpoints);
  cursor = decoded.current;
  for (const entry of [...decoded.redoHistory].reverse()) cursor = await replayRevision(cursor, entry, "forward", state, identity, endpoints);
  cursor = decoded.current;
  for (let index = decoded.revisions.length - 1; index >= 0; index -= 1) {
    const entry = decoded.revisions[index];
    if (entry.toRevision !== cursor.workspaceRevision) fail("history_chain_mismatch", "The revision ledger is not contiguous with the current workspace.");
    cursor = await replayRevision(cursor, entry, "inverse", state, identity, endpoints);
  }
  const ledgerById = new Map(decoded.revisions.map((entry) => [entry.revisionId, entry]));
  const originals = new Map([...decoded.history, ...decoded.redoHistory,
    ...decoded.revisions.filter((entry) => ORIGINAL_REVISION_KINDS.has(entry.kind))].map((entry) => [entry.revisionId, entry]));
  for (const entry of decoded.revisions) {
    if (ORIGINAL_REVISION_KINDS.has(entry.kind)) continue;
    const original = originals.get(entry.relatedRevisionId);
    // A v2 migration cannot recover an original that was subsequently undone
    // and removed from the Redo branch. Never invent it; validate any original
    // still available, and always replay the compensating patch itself.
    if (!original) {
      if (decoded.revisions[0].fromRevision === 1) fail("history_chain_mismatch", "A reversal names no original revision.");
      continue;
    }
    const inverse = entry.kind === "undo";
    if (original.toRevision > entry.fromRevision
      || canonicalJson(entry.forwardPatch) !== canonicalJson(inverse ? original.inversePatch : original.forwardPatch)) {
      fail("history_chain_mismatch", "A reversal does not reverse the original revision it names.");
    }
  }
  for (const entry of [...decoded.history, ...decoded.redoHistory]) {
    if (ledgerById.has(entry.revisionId) && canonicalJson(ledgerById.get(entry.revisionId)) !== canonicalJson(entry)) {
      fail("history_chain_mismatch", "A retained stack entry disagrees with its revision ledger record.");
    }
  }
  decoded.revisionEndpoints = endpoints;
}

async function refreshTrustedPatchTitle(decoded, state) {
  if (!state.structuralMap) return false;
  const trustedTitle = state.graph.getNodeAttribute("node:paper", "label");
  const snapshots = new Set([decoded.current]);
  for (const pair of decoded.revisionEndpoints.values()) { snapshots.add(pair.before); snapshots.add(pair.after); }
  let refreshed = false;
  for (const snapshot of snapshots) {
    if (snapshot.graph.getNodeAttribute("node:paper", "label") === trustedTitle) continue;
    snapshot.graph.setNodeAttribute("node:paper", "label", trustedTitle);
    Object.assign(snapshot, await semanticStateDigests(snapshot));
    refreshed = true;
  }
  if (refreshed) for (const [entry, pair] of decoded.revisionEndpoints) {
    for (const prefix of ["before", "after"]) for (const suffix of ["WorkspaceDigest", "GraphDigest", "AnnotationDigest"]) {
      entry[`${prefix}${suffix}`] = pair[prefix][suffix[0].toLowerCase() + suffix.slice(1)];
    }
  }
  return refreshed;
}

function sameLegacyWorkspace(left, right) {
  try {
    return createWorkspacePatch(left, right).forwardPatch.length === 0;
  } catch {
    return false;
  }
}

function validateLegacyChains(decoded) {
  const retained = [...decoded.history, ...decoded.redoHistory];
  if (new Set(retained.map(({ revisionId }) => revisionId)).size !== retained.length) fail("history_invalid", "A legacy revision ID is duplicated.");
  for (const entry of retained) {
    if (entry.after.workspaceRevision !== entry.before.workspaceRevision + 1) fail("history_invalid", "A legacy revision must advance exactly once.");
    if (entry.after.workspaceRevision > decoded.current.workspaceRevision) fail("history_chain_mismatch", "A legacy revision is newer than the current workspace head.");
  }
  let cursor = decoded.current;
  for (const entry of [...decoded.history].reverse()) {
    if (!sameLegacyWorkspace(cursor, entry.after)) fail("history_chain_mismatch", "The legacy Undo stack does not lead to the current workspace.");
    cursor = entry.before;
  }
  cursor = decoded.current;
  for (const entry of [...decoded.redoHistory].reverse()) {
    if (!sameLegacyWorkspace(cursor, entry.before)) fail("history_chain_mismatch", "The legacy Redo stack does not start at the current workspace.");
    cursor = entry.after;
  }
}

async function migrateLegacyHistory(decoded, state) {
  const identity = paperIdentityFromState(state);
  const migrate = async (entry) => {
    const patches = createWorkspacePatch(entry.before, entry.after);
    const receipt = [...decoded.requestResults.entries()].find(([, value]) => value.result?.revisionId === entry.revisionId);
    const agent = entry.kind === "graph" || entry.kind === "annotation";
    const commandDigest = receipt?.[1]?.commandDigest || await sha256Text(canonicalJson(patches.forwardPatch));
    const sourceAnchorIds = new Set();
    for (const operation of patches.forwardPatch) for (const record of [operation.before, operation.after]) {
      if (!record) continue;
      for (const anchorId of record.sourceAnchorIds || []) sourceAnchorIds.add(anchorId);
      for (const coverage of record.structuralCoverage || []) sourceAnchorIds.add(coverage.primaryAnchorId);
      if (record.anchorId) sourceAnchorIds.add(record.anchorId);
    }
    const migrated = {
      schemaVersion: 1, kind: entry.kind, revisionId: entry.revisionId,
      operationId: entry.operationId || `migration:${(await sha256Text(entry.revisionId)).slice(0, 32)}`,
      paperRef: identity.paperRef,
      idempotencyKey: receipt?.[0] || `migration-${(await sha256Text(entry.revisionId)).slice(0, 32)}`,
      commandDigest, actor: agent ? "agent" : "human", transport: agent ? "webmcp" : "direct_ui",
      ...(agent ? { toolName: entry.kind === "graph" ? "paperpilot.apply_graph" : "paperpilot.apply_annotation" } : {}),
      reason: "Migrated retained version-2 Undo/Redo state. Original command reason and complete patch ledger were not stored.",
      fromRevision: entry.before.workspaceRevision, toRevision: entry.before.workspaceRevision + 1,
      ...patches, affectedKeys: [...new Set(patches.forwardPatch.map(({ key }) => key))].sort(),
      sourceAnchorIds: [...sourceAnchorIds].sort(), reviewState: agent ? "unreviewed" : "not_applicable",
      createdAt: decoded.savedAt, beforeFocusAnchorId: entry.before.focusAnchorId, afterFocusAnchorId: entry.after.focusAnchorId,
    };
    for (const prefix of ["before", "after"]) for (const suffix of ["WorkspaceDigest", "GraphDigest", "AnnotationDigest"]) {
      migrated[`${prefix}${suffix}`] = entry[prefix][suffix[0].toLowerCase() + suffix.slice(1)];
    }
    return validatePatchRevision(migrated, identity);
  };
  decoded.history = await Promise.all(decoded.history.map(migrate));
  decoded.redoHistory = await Promise.all(decoded.redoHistory.map(migrate));
  decoded.revisions = [];
  await validatePatchHistory(decoded, state, identity);
}

async function decodeEnvelope(raw, state, expectedVersion = BROWSER_SNAPSHOT_SCHEMA_VERSION) {
  if (typeof raw !== "string" || utf8Bytes(raw) > MAX_BROWSER_SNAPSHOT_BYTES) fail("snapshot_too_large", "The stored snapshot exceeds 4 MiB.");
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    fail("invalid_json", "The stored snapshot is not valid JSON.");
  }
  assertPlainObject(envelope, "envelope_invalid", "The snapshot envelope is invalid.");
  assertExactKeys(envelope, ["schemaVersion", "payloadChecksum", "payload"], "envelope_invalid");
  if (envelope.schemaVersion !== expectedVersion) fail("schema_version_mismatch", "The snapshot schema version is not supported.");
  assertString(envelope.payloadChecksum, "envelope_invalid", "The snapshot checksum is invalid.", { pattern: SHA256_RE });
  assertPlainObject(envelope.payload, "payload_invalid", "The snapshot payload is invalid.");
  const actualChecksum = await sha256Text(canonicalJson(envelope.payload));
  if (actualChecksum !== envelope.payloadChecksum) fail("checksum_mismatch", "The stored snapshot checksum does not match its payload.");

  const payload = envelope.payload;
  assertExactKeys(
    payload,
    ["schemaVersion", "kind", "savedAt", "paperIdentity", "workspace", "requestResults", "events", "savedExplanations", "presentation"],
    "payload_invalid",
  );
  if (payload.schemaVersion !== expectedVersion || payload.kind !== "paperpilot_browser_workspace") {
    fail("schema_version_mismatch", "The snapshot payload schema is not supported.");
  }
  assertString(payload.savedAt, "payload_invalid", "The snapshot savedAt value is invalid.", { max: 64 });
  const expectedIdentity = paperIdentityFromState(state);
  assertPlainObject(payload.paperIdentity, "identity_mismatch", "The snapshot paper identity is invalid.");
  assertExactKeys(payload.paperIdentity, ["paperRef", "documentSha256", "pageCount"], "identity_mismatch");
  if (
    payload.paperIdentity.paperRef !== expectedIdentity.paperRef
    || payload.paperIdentity.documentSha256 !== expectedIdentity.documentSha256
    || payload.paperIdentity.pageCount !== expectedIdentity.pageCount
  ) {
    fail("identity_mismatch", "The snapshot belongs to a different PDF identity.");
  }
  assertPlainObject(payload.workspace, "workspace_invalid", "The snapshot workspace is invalid.");
  assertExactKeys(payload.workspace, ["current", "history", "redoHistory", ...(expectedVersion === 3 ? ["revisions"] : [])], "workspace_invalid");

  const current = await decodeSemanticState(payload.workspace.current, state.graph, expectedIdentity, "workspace.current");
  const history = expectedVersion === 2
    ? await decodeHistory(payload.workspace.history, state.graph, expectedIdentity, "workspace.history")
    : decodePatchRevisions(payload.workspace.history, expectedIdentity);
  const redoHistory = expectedVersion === 2
    ? await decodeHistory(payload.workspace.redoHistory, state.graph, expectedIdentity, "workspace.redoHistory")
    : decodePatchRevisions(payload.workspace.redoHistory, expectedIdentity);
  validateStructuralBaseline(current, state.structuralMap, state);
  const legacyEntries = expectedVersion === 2 ? [...history, ...redoHistory] : [];
  for (const entry of legacyEntries) {
    validateStructuralBaseline(entry.before, state.structuralMap, state);
    validateStructuralBaseline(entry.after, state.structuralMap, state);
  }
  for (const snapshot of [current, ...legacyEntries.flatMap((entry) => [entry.before, entry.after])]) {
    try {
      // A no-op application validates the complete closed canonical state and
      // same-paper references even when the saved Undo/Redo stacks are empty.
      applyWorkspacePatch({ ...snapshot, paper: expectedIdentity }, []);
    } catch {
      fail("workspace_invalid", "The stored workspace violates canonical record or same-paper reference invariants.");
    }
  }
  const requestResults = validateRequestResults(payload.requestResults, { allowTombstones: expectedVersion === 3 });
  if (
    !Array.isArray(payload.events)
    || payload.events.length > BROWSER_SNAPSHOT_LIMITS.events
    || payload.events.some((event) => !isPlainObject(event))
  ) {
    fail("events_invalid", "The stored audit events are invalid or unbounded.");
  }
  await validateSavedExplanations(payload.savedExplanations, current, expectedIdentity);
  const presentation = validatePresentation(payload.presentation, current.annotations);
  assertJsonSafe(payload.events, "events");
  assertJsonSafe(payload.savedExplanations, "savedExplanations");
  const decoded = {
    savedAt: payload.savedAt,
    current,
    history,
    redoHistory,
    revisions: expectedVersion === 3 ? decodePatchRevisions(payload.workspace.revisions, expectedIdentity, { ledger: true }) : [],
    requestResults,
    events: structuredClone(payload.events),
    savedExplanations: structuredClone(payload.savedExplanations),
    presentation,
  };
  if (expectedVersion === 2) validateLegacyChains(decoded);
  else await validatePatchHistory(decoded, state, expectedIdentity);
  validateRequestHistory(decoded, { legacy: expectedVersion === 2 });
  return decoded;
}

function applyDecodedState(state, decoded) {
  state.anchors = decoded.current.anchors;
  state.annotations = decoded.current.annotations;
  state.graph = decoded.current.graph;
  state.workspaceRevision = decoded.current.workspaceRevision;
  state.workspaceDigest = decoded.current.workspaceDigest;
  state.graphDigest = decoded.current.graphDigest;
  state.annotationDigest = decoded.current.annotationDigest;
  state.focusAnchorId = decoded.current.focusAnchorId;
  const freezeRevision = (value) => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freezeRevision(child);
      Object.freeze(value);
    }
    return value;
  };
  state.history = decoded.history.map(freezeRevision);
  state.redoHistory = decoded.redoHistory.map(freezeRevision);
  state.revisions = decoded.revisions.map(freezeRevision);
  state.requestResults = decoded.requestResults;
  state.events = decoded.events;
  state.savedExplanations = decoded.savedExplanations;
  // Read receipts and staged (unsaved) explanations never cross a reload.
  state.latestReadFocusReceipt = null;
  state.latestReadGraphReceipt = null;
  state.explanations = [];
}

export async function loadBrowserSnapshot({ storage, state } = {}) {
  validateStorage(storage);
  const identity = paperIdentityFromState(state);
  const key = browserSnapshotKey(identity.documentSha256);
  let raw;
  let migratedFrom;
  let legacyKey;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    return { ...storageFailure(error), key };
  }
  if (raw === null || raw === undefined) {
    legacyKey = `paperpilot:webmcp:v2:${identity.documentSha256}`;
    try {
      raw = storage.getItem(legacyKey);
    } catch (error) {
      return { ...storageFailure(error), key };
    }
    if (raw !== null && raw !== undefined) {
      migratedFrom = 2;
    } else {
      // Candidate-only v1 state cannot replace the generated structural map.
      const versionOneKey = `paperpilot:webmcp:v1:${identity.documentSha256}`;
      let versionOneRaw;
      try {
        versionOneRaw = storage.getItem(versionOneKey);
      } catch (error) {
        return { ...storageFailure(error), key };
      }
      if (versionOneRaw !== null && versionOneRaw !== undefined) {
        return { status: "legacy_preserved", key, legacyKey: versionOneKey, legacySchemaVersion: 1 };
      }
      return { status: "not_found", key };
    }
  }
  let decoded;
  try {
    decoded = await decodeEnvelope(raw, state, migratedFrom || BROWSER_SNAPSHOT_SCHEMA_VERSION);
    if (migratedFrom === 2) {
      decoded.displayTitleRefreshed = await refreshTrustedPaperTitle(decoded, state);
      await migrateLegacyHistory(decoded, state);
    } else {
      decoded.displayTitleRefreshed = await refreshTrustedPatchTitle(decoded, state);
    }
    if (decoded.displayTitleRefreshed) {
      for (const [requestKey, receipt] of decoded.requestResults) {
        if (receipt.result === null) continue;
        decoded.requestResults.set(requestKey, { commandDigest: receipt.commandDigest, result: null });
        decoded.replayInvalidatedCount += 1;
      }
    }
  } catch (error) {
    if (error instanceof SnapshotValidationError) {
      return { status: "invalid", key, reason: error.reason, message: error.message };
    }
    return { status: "invalid", key, reason: "decode_failed", message: "The stored snapshot could not be decoded." };
  }
  applyDecodedState(state, decoded);
  return {
    status: "restored",
    key,
    savedAt: decoded.savedAt,
    workspaceRevision: state.workspaceRevision,
    savedExplanations: structuredClone(decoded.savedExplanations),
    presentation: structuredClone(decoded.presentation),
    displayTitleRefreshed: decoded.displayTitleRefreshed,
    replayInvalidated: decoded.replayInvalidatedCount > 0,
    replayInvalidatedCount: decoded.replayInvalidatedCount,
    ...(decoded.replayInvalidatedCount ? {
      recoveryNotice: `${decoded.replayInvalidatedCount} historical command replay${decoded.replayInvalidatedCount === 1 ? " was" : "s were"} invalidated because its original digest basis could not be reused. Read the current workspace and use a new command key. Existing command keys remain reserved.`,
    } : {}),
    ...(migratedFrom ? {
      migratedFrom,
      legacyKey,
      migrationNotice: "Retained version-2 Undo/Redo steps were migrated. The original save is preserved; a complete historical patch ledger was not available.",
    } : {}),
  };
}

export function clearBrowserSnapshot({ storage, documentSha256 } = {}) {
  validateStorage(storage);
  const key = browserSnapshotKey(documentSha256);
  let existed;
  try {
    existed = storage.getItem(key) !== null;
    storage.removeItem(key);
  } catch (error) {
    return { ...storageFailure(error), key };
  }
  return { status: existed ? "cleared" : "not_found", key };
}
