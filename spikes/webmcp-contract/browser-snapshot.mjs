import { validateSpatialAnchor } from "./spatial-anchor.mjs";

/**
 * Browser-local, opt-in persistence for the public PaperPilot vertical slice.
 *
 * The snapshot deliberately contains only PaperPilot's canonical in-app state:
 * source anchors, annotations, graph data/layout, reversible history, audit
 * events, idempotency receipts, and explanations the human explicitly saved.
 * PDF/File/Blob/ArrayBuffer data is rejected before serialization.
 */

// Version 2 guarantees that a saved graph was created from the whole-paper
// structural baseline. Version-1 candidate-only snapshots are intentionally
// not hydrated over the new deterministic structure.
export const BROWSER_SNAPSHOT_SCHEMA_VERSION = 2;
export const MAX_BROWSER_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const BROWSER_SNAPSHOT_KEY_PREFIX = `paperpilot:webmcp:v${BROWSER_SNAPSHOT_SCHEMA_VERSION}:`;
export const BROWSER_SNAPSHOT_LIMITS = Object.freeze({
  history: 200,
  redoHistory: 200,
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
  return history.slice(-limit).map((entry, index) => {
    assertPlainObject(entry, "invalid_live_state", `${path}[${index}] is invalid.`);
    const serialized = {
      kind: assertString(entry.kind, "invalid_live_state", `${path}[${index}].kind is invalid.`, { max: 64 }),
      revisionId: assertString(entry.revisionId, "invalid_live_state", `${path}[${index}].revisionId is invalid.`, { max: 128 }),
      before: serializeSemanticState(entry.before, `${path}[${index}].before`),
      after: serializeSemanticState(entry.after, `${path}[${index}].after`),
    };
    if (entry.operationId !== undefined) {
      serialized.operationId = assertString(entry.operationId, "invalid_live_state", `${path}[${index}].operationId is invalid.`, { max: 128 });
    }
    return serialized;
  });
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
  validateSavedExplanations(serializedExplanations, state.anchors);
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
  for (const entry of [...payload.workspace.history, ...payload.workspace.redoHistory]) {
    states.push(entry.before, entry.after);
  }
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

function validateSavedExplanations(value, anchors) {
  if (!Array.isArray(value) || value.length > 200) fail("saved_explanations_invalid", "savedExplanations is invalid or unbounded.");
  for (const [index, explanation] of value.entries()) {
    assertPlainObject(explanation, "saved_explanations_invalid", `Saved explanation ${index} is invalid.`);
    assertString(explanation.explanationId, "saved_explanations_invalid", `Saved explanation ${index} has no valid id.`, { max: 128 });
    assertString(explanation.responseDigest, "saved_explanations_invalid", `Saved explanation ${index} has no valid digest.`, { pattern: SHA256_RE });
    if (explanation.focusAnchorId !== undefined && !anchors.has(explanation.focusAnchorId)) {
      fail("saved_explanations_invalid", `Saved explanation ${index} references a missing focus anchor.`);
    }
    if (explanation.sourceAnchorIds !== undefined) {
      if (!Array.isArray(explanation.sourceAnchorIds) || explanation.sourceAnchorIds.some((anchorId) => !anchors.has(anchorId))) {
        fail("saved_explanations_invalid", `Saved explanation ${index} references a missing source anchor.`);
      }
    }
  }
}

function validateRequestResults(value) {
  validatePairEntries(value, "request_results_invalid", BROWSER_SNAPSHOT_LIMITS.requestResults);
  const result = new Map();
  for (const [key, entry] of value) {
    assertString(key, "request_results_invalid", "A stored idempotency key is invalid.", { max: 64 });
    assertPlainObject(entry, "request_results_invalid", `Request result ${key} is invalid.`);
    assertString(entry.commandDigest, "request_results_invalid", `Request result ${key} has an invalid command digest.`, { pattern: SHA256_RE });
    assertPlainObject(entry.result, "request_results_invalid", `Request result ${key} has an invalid result.`);
    result.set(key, structuredClone(entry));
  }
  return result;
}

async function decodeEnvelope(raw, state) {
  if (typeof raw !== "string" || utf8Bytes(raw) > MAX_BROWSER_SNAPSHOT_BYTES) fail("snapshot_too_large", "The stored snapshot exceeds 4 MiB.");
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    fail("invalid_json", "The stored snapshot is not valid JSON.");
  }
  assertPlainObject(envelope, "envelope_invalid", "The snapshot envelope is invalid.");
  assertExactKeys(envelope, ["schemaVersion", "payloadChecksum", "payload"], "envelope_invalid");
  if (envelope.schemaVersion !== BROWSER_SNAPSHOT_SCHEMA_VERSION) fail("schema_version_mismatch", "The snapshot schema version is not supported.");
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
  if (payload.schemaVersion !== BROWSER_SNAPSHOT_SCHEMA_VERSION || payload.kind !== "paperpilot_browser_workspace") {
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
  assertExactKeys(payload.workspace, ["current", "history", "redoHistory"], "workspace_invalid");

  const current = await decodeSemanticState(payload.workspace.current, state.graph, expectedIdentity, "workspace.current");
  const history = await decodeHistory(payload.workspace.history, state.graph, expectedIdentity, "workspace.history");
  const redoHistory = await decodeHistory(payload.workspace.redoHistory, state.graph, expectedIdentity, "workspace.redoHistory");
  validateStructuralBaseline(current, state.structuralMap, state);
  for (const entry of [...history, ...redoHistory]) {
    validateStructuralBaseline(entry.before, state.structuralMap, state);
    validateStructuralBaseline(entry.after, state.structuralMap, state);
  }
  const requestResults = validateRequestResults(payload.requestResults);
  if (
    !Array.isArray(payload.events)
    || payload.events.length > BROWSER_SNAPSHOT_LIMITS.events
    || payload.events.some((event) => !isPlainObject(event))
  ) {
    fail("events_invalid", "The stored audit events are invalid or unbounded.");
  }
  validateSavedExplanations(payload.savedExplanations, current.anchors);
  const presentation = validatePresentation(payload.presentation, current.annotations);
  assertJsonSafe(payload.events, "events");
  assertJsonSafe(payload.savedExplanations, "savedExplanations");
  return {
    savedAt: payload.savedAt,
    current,
    history,
    redoHistory,
    requestResults,
    events: structuredClone(payload.events),
    savedExplanations: structuredClone(payload.savedExplanations),
    presentation,
  };
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
  state.history = decoded.history;
  state.redoHistory = decoded.redoHistory;
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
  try {
    raw = storage.getItem(key);
  } catch (error) {
    return { ...storageFailure(error), key };
  }
  if (raw === null || raw === undefined) {
    // Detect only this PDF's known predecessor key. Preserve its bytes without
    // decoding or hydrating candidate-only state over the structural baseline.
    const legacyKey = `paperpilot:webmcp:v1:${identity.documentSha256}`;
    let legacyRaw;
    try {
      legacyRaw = storage.getItem(legacyKey);
    } catch (error) {
      return { ...storageFailure(error), key };
    }
    if (legacyRaw !== null && legacyRaw !== undefined) {
      return { status: "legacy_preserved", key, legacyKey, legacySchemaVersion: 1 };
    }
    return { status: "not_found", key };
  }
  let decoded;
  try {
    decoded = await decodeEnvelope(raw, state);
    decoded.displayTitleRefreshed = await refreshTrustedPaperTitle(decoded, state);
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
