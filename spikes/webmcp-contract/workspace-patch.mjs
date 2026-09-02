// @ts-check

/**
 * Trusted, browser-independent workspace history patches. These are not model
 * commands. Anchor minting/digest verification remains the source adapter's job;
 * this layer checks exact history preconditions, same-paper references and the
 * immutable structural baseline before returning an independent workspace clone.
 */

/** @typedef {Record<string, unknown>} RecordValue */
/** @typedef {import("graphology").MultiDirectedGraph<RecordValue, RecordValue, RecordValue>} WorkspaceGraph */
/** @typedef {{anchors: Map<string, RecordValue>, graph: WorkspaceGraph, annotations: Map<string, RecordValue>, paper?: RecordValue}} WorkspaceState */
/** @typedef {"put_node" | "put_edge" | "put_annotation" | "put_anchor"} PatchKind */
/** @typedef {{op: PatchKind, key: string, before: RecordValue | null, after: RecordValue | null}} WorkspacePatchOperation */
/** @typedef {readonly WorkspacePatchOperation[]} WorkspacePatch */
/** @typedef {{nodes: Map<string, RecordValue>, edges: Map<string, RecordValue>, annotations: Map<string, RecordValue>, anchors: Map<string, RecordValue>}} WorkspaceRecords */

export const WORKSPACE_PATCH_LIMITS = Object.freeze({ nodes: 600, edges: 1200, annotations: 800, anchors: 2400, operations: 5000, bytes: 4 * 1024 * 1024 });

const ID = /^[a-z][a-z0-9:_-]{2,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PRESENTATION = new Set(["x", "y", "size", "color", "hidden", "selected", "hovered", "hover", "highlighted", "dragged", "dragging", "forceLabel", "zIndex", "labelColor", "borderColor", "borderSize", "type", "layout", "layoutOrder", "annotationOrder", "camera", "animation", "fixed", "fx", "fy", "vx", "vy"]);
const NODE_FIELDS = new Set(["key", "paperRef", "kind", "label", "summary", "authority", "sourceAnchorIds", "structuralCoverage", "structuralBasis", "structuralConfidence", "optionalCanonicalConceptKey", "salience", "origin", "status", "entityRevision", "createdAt", "updatedAt"]);
const EDGE_FIELDS = new Set(["key", "sourceKey", "targetKey", "paperRef", "kind", "claim", "authority", "sourceAnchorIds", "origin", "status", "entityRevision", "createdAt", "updatedAt"]);
const ANNOTATION_FIELDS = new Set(["schemaVersion", "annotationId", "paperRef", "anchorId", "kind", "label", "body", "graphNodeKeys", "graphEdgeKeys", "status", "authority", "entityRevision", "createdAt", "updatedAt"]);
const ANCHOR_FIELDS = new Set(["schemaVersion", "anchorId", "paperRef", "documentSha256", "documentRevision", "pageIndex", "pageLabel", "pageViewBox", "pageRotation", "rotation", "coordinateSpace", "normalizedCoordinateSpace", "rendererRecipe", "rendererRecipeDigest", "sourceKind", "geometryKind", "normalizedBounds", "normalizedPoints", "normalizedQuads", "pdfPoints", "pdfQuads", "quote", "textItemRefs", "regionDigest", "authority", "createdBy", "createdAt", "anchorDigest", "exactText", "exactTextSha256", "prefix", "suffix", "visibleRegionId", "regionDescription"]);
const NODE_KINDS = new Set(["paper", "section", "main_idea", "concept", "term", "method", "result", "prerequisite", "figure", "equation"]);
const EDGE_KINDS = new Set(["contains", "defines", "depends_on", "uses", "enables", "supports", "contrasts_with", "produces", "evidenced_by", "appears_in"]);
const AUTHORITIES = new Set(["document_structure", "paper_grounded", "mentor_background", "reader_authored"]);
const ORIGINS = new Set(["system", "automatic_map", "agent", "reader"]);
const FORBIDDEN_JSON = new Set(["__proto__", "prototype", "constructor", "pdfBytes", "pdfData", "rawFile", "arrayBuffer", "dataUrl", "objectUrl"]);
const PATCH_COLLECTION = /** @type {const} */ ({ put_node: "nodes", put_edge: "edges", put_annotation: "annotations", put_anchor: "anchors" });

export class WorkspacePatchError extends Error {
  /** @param {"workspace_patch_invalid" | "workspace_patch_conflict"} code */
  constructor(code) {
    super(code === "workspace_patch_conflict" ? "The workspace no longer matches this history patch." : "The workspace history patch is invalid.");
    this.name = "WorkspacePatchError";
    this.code = code;
  }
}

/** @returns {never} */
function invalid() { throw new WorkspacePatchError("workspace_patch_invalid"); }
/** @returns {never} */
function conflict() { throw new WorkspacePatchError("workspace_patch_conflict"); }
/** @param {unknown} value @returns {value is RecordValue} */
function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** JSON-only defensive copy: no getters, binary objects, cycles or prototypes. @param {unknown} value @param {Set<object>} [seen] @param {number} [depth] @returns {unknown} */
function copyJson(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { if (value.length > 65536) invalid(); return value; }
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return Object.is(value, -0) ? 0 : value; }
  if (typeof value !== "object" || depth > 32 || seen.has(value)) invalid();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > WORKSPACE_PATCH_LIMITS.operations || Reflect.ownKeys(value).length !== value.length + 1) invalid();
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
        result.push(copyJson(descriptor.value, seen, depth + 1));
      }
      return result;
    }
    if (!isRecord(value) || Reflect.ownKeys(value).length > 256) invalid();
    /** @type {RecordValue} */
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || FORBIDDEN_JSON.has(key)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
      result[key] = copyJson(descriptor.value, seen, depth + 1);
    }
    return result;
  } finally { seen.delete(value); }
}

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** @template T @param {T} value @returns {T} */
function frozen(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
/** @param {unknown} value @param {Set<string>} fields @param {string[]} required @returns {RecordValue} */
function closed(value, fields, required) {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.has(key)) || required.some((key) => !Object.hasOwn(value, key))) invalid();
  return value;
}
/** @param {unknown} value @returns {string} */
function id(value) { if (typeof value !== "string" || !ID.test(value)) invalid(); return value; }
/** @param {unknown} value @param {number} maximum @param {boolean} [empty] @returns {string} */
function text(value, maximum, empty = false) {
  if (typeof value !== "string" || (!empty && !value.length) || [...value].length > maximum) invalid();
  return value;
}
/** @param {unknown} value @param {number} [maximum] @returns {string[]} */
function ids(value, maximum = 12) {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const values = value.map(id);
  if (new Set(values).size !== values.length) invalid();
  return values;
}
/** @param {unknown} value @param {Set<string>} values */
function member(value, values) { if (typeof value !== "string" || !values.has(value)) invalid(); }
/** @param {unknown} value @param {number} [minimum] @returns {number} */
function integer(value, minimum = 0) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid(); return value; }
/** @param {RecordValue} value */
function lifecycle(value) {
  member(value.status, new Set(["active", "tombstoned"]));
  integer(value.entityRevision, 1);
  for (const key of ["createdAt", "updatedAt"]) if (value[key] !== undefined) text(value[key], 64);
  if (value.paperRef !== undefined) id(value.paperRef);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) invalid();
}

/** @param {PatchKind} kind @param {string} key @param {unknown} input @returns {RecordValue} */
function validateRecord(kind, key, input) {
  if (!isRecord(input)) invalid();
  const fields = kind === "put_node" ? NODE_FIELDS : kind === "put_edge" ? EDGE_FIELDS : kind === "put_annotation" ? ANNOTATION_FIELDS : ANCHOR_FIELDS;
  const identity = kind === "put_anchor" ? "anchorId" : kind === "put_annotation" ? "annotationId" : "key";
  const value = closed(input, fields, [identity]);
  if (id(value[identity]) !== key) invalid();
  if (kind === "put_node" || kind === "put_edge") {
    lifecycle(value);
    member(value.authority, AUTHORITIES); member(value.origin, ORIGINS);
    ids(value.sourceAnchorIds);
    if (kind === "put_node") {
      member(value.kind, NODE_KINDS); text(value.label, 240); text(value.summary, 1000, true);
      if (value.salience !== undefined && (typeof value.salience !== "number" || !Number.isFinite(value.salience) || value.salience < 0 || value.salience > 1)) invalid();
      if (value.optionalCanonicalConceptKey !== undefined) id(value.optionalCanonicalConceptKey);
      if (value.structuralCoverage !== undefined) {
        if (!Array.isArray(value.structuralCoverage) || value.structuralCoverage.length > 200) invalid();
        for (const range of value.structuralCoverage) {
          const item = closed(range, new Set(["startPageIndex", "endPageIndex", "primaryAnchorId"]), ["startPageIndex", "endPageIndex", "primaryAnchorId"]);
          if (integer(item.endPageIndex) < integer(item.startPageIndex)) invalid();
          id(item.primaryAnchorId);
        }
      }
      if (value.structuralBasis !== undefined) member(value.structuralBasis, new Set(["paper_root", "pdf_outline", "heading_heuristic", "page_fallback"]));
      if (value.structuralConfidence !== undefined) member(value.structuralConfidence, new Set(["document_declared", "system_inferred", "coverage_fallback"]));
    } else {
      member(value.kind, EDGE_KINDS);
      if (id(value.sourceKey) === id(value.targetKey)) invalid();
      if (value.claim !== undefined) text(value.claim, 1000, true);
    }
  } else if (kind === "put_annotation") {
    lifecycle(value); id(value.paperRef); id(value.anchorId);
    member(value.kind, new Set(["highlight", "question", "concept", "note", "region"]));
    member(value.authority, new Set(["reader", "agent", "system"]));
    text(value.label, 240); if (value.body !== undefined) text(value.body, 4096, true);
    ids(value.graphNodeKeys); ids(value.graphEdgeKeys);
  } else {
    id(value.paperRef); integer(value.pageIndex); text(value.pageLabel, 128);
    if (typeof value.anchorDigest !== "string" || !SHA256.test(value.anchorDigest)) invalid();
    member(value.sourceKind, new Set(["exact_text", "visual_region", "whole_page", "whole_figure", "equation"]));
    member(value.authority, new Set(["exact_document_text", "client_rendered_pdf"]));
    if (value.documentSha256 !== undefined && (typeof value.documentSha256 !== "string" || !SHA256.test(value.documentSha256))) invalid();
    if (value.documentRevision !== undefined && value.documentRevision !== 1) invalid();
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) invalid();
    for (const rotation of [value.rotation, value.pageRotation]) if (rotation !== undefined && ![0, 90, 180, 270].includes(/** @type {number} */ (rotation))) invalid();
    if (value.normalizedBounds !== undefined) {
      if (!Array.isArray(value.normalizedBounds) || !value.normalizedBounds.length || value.normalizedBounds.length > 32) invalid();
      for (const bounds of value.normalizedBounds) {
        const rect = closed(bounds, new Set(["x", "y", "width", "height"]), ["x", "y", "width", "height"]);
        for (const component of Object.values(rect)) if (typeof component !== "number" || !Number.isFinite(component)) invalid();
        const { x, y, width, height } = /** @type {{x:number,y:number,width:number,height:number}} */ (rect);
        if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 + 1e-9 || y + height > 1 + 1e-9) invalid();
      }
    }
    if (value.sourceKind === "exact_text" && value.authority !== "exact_document_text") invalid();
    // Canonical equation regions may carry an exact extracted quote too.
    if (!["exact_text", "equation"].includes(String(value.sourceKind)) && value.authority === "exact_document_text") invalid();
  }
  return value;
}

/** Validate and detach the closed trusted patch. It never mutates the argument. @param {unknown} input @returns {WorkspacePatch} */
export function validateWorkspacePatch(input) {
  if (!Array.isArray(input) || input.length > WORKSPACE_PATCH_LIMITS.operations) invalid();
  const clone = /** @type {unknown[]} */ (copyJson(input));
  if (new TextEncoder().encode(canonical(clone)).byteLength > WORKSPACE_PATCH_LIMITS.bytes) invalid();
  const seen = new Set();
  /** @type {WorkspacePatchOperation[]} */
  const result = [];
  for (const item of clone) {
    const operation = closed(item, new Set(["op", "key", "before", "after"]), ["op", "key", "before", "after"]);
    if (typeof operation.op !== "string" || !Object.hasOwn(PATCH_COLLECTION, operation.op)) invalid();
    const op = /** @type {PatchKind} */ (operation.op);
    const key = id(operation.key);
    if (seen.has(`${op}:${key}`)) invalid();
    seen.add(`${op}:${key}`);
    const before = operation.before === null ? null : validateRecord(op, key, operation.before);
    const after = operation.after === null ? null : validateRecord(op, key, operation.after);
    if ((!before && !after) || canonical(before) === canonical(after)) invalid();
    if (op === "put_anchor" && before && after) invalid();
    if (op === "put_edge" && before && after && (before.sourceKey !== after.sourceKey || before.targetKey !== after.targetKey)) invalid();
    if (op === "put_annotation" && before && after && before.anchorId !== after.anchorId) invalid();
    result.push({ op, key, before, after });
  }
  return frozen(result);
}

/** @param {unknown} patch @returns {WorkspacePatch} */
export function invertWorkspacePatch(patch) {
  return validateWorkspacePatch([...validateWorkspacePatch(patch)].reverse().map(({ op, key, before, after }) => ({ op, key, before: after, after: before })));
}

/** @param {RecordValue} attributes @returns {RecordValue} */
function graphAttributes(attributes) {
  const value = copyJson(attributes);
  if (!isRecord(value)) invalid();
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRESENTATION.has(key)));
}
/** @param {WorkspaceState} state @returns {WorkspaceRecords} */
function recordsFor(state) {
  if (!state || !(state.anchors instanceof Map) || !(state.annotations instanceof Map) || !state.graph
    || state.graph.type !== "directed" || !state.graph.multi || state.graph.allowSelfLoops !== false) invalid();
  /** @type {WorkspaceRecords} */
  const result = { nodes: new Map(), edges: new Map(), anchors: new Map(), annotations: new Map() };
  for (const key of state.graph.nodes()) {
    const attributes = graphAttributes(state.graph.getNodeAttributes(key));
    if (Object.hasOwn(attributes, "key")) invalid();
    result.nodes.set(id(key), validateRecord("put_node", key, { key, ...attributes }));
  }
  for (const key of state.graph.edges()) {
    const attributes = graphAttributes(state.graph.getEdgeAttributes(key));
    if (["key", "sourceKey", "targetKey"].some((field) => Object.hasOwn(attributes, field))) invalid();
    result.edges.set(id(key), validateRecord("put_edge", key, { key, sourceKey: state.graph.source(key), targetKey: state.graph.target(key), ...attributes }));
  }
  for (const [op, source, destination] of /** @type {const} */ ([["put_anchor", state.anchors, result.anchors], ["put_annotation", state.annotations, result.annotations]])) {
    for (const [key, record] of source) destination.set(id(key), validateRecord(op, key, copyJson(record)));
  }
  for (const name of /** @type {const} */ (["nodes", "edges", "annotations", "anchors"])) if (result[name].size > WORKSPACE_PATCH_LIMITS[name]) invalid();
  return result;
}

/** @param {WorkspaceState} state @param {WorkspaceRecords} records @returns {{paperRef: string | null, documentSha256: string | null, pageCount: number | null}} */
function paperIdentity(state, records) {
  const references = new Set([...records.anchors.values(), ...records.annotations.values(), ...records.nodes.values(), ...records.edges.values()]
    .flatMap((record) => record.paperRef === undefined ? [] : [id(record.paperRef)]));
  if (state.paper?.paperRef !== undefined) references.add(id(state.paper.paperRef));
  if (references.size > 1) invalid();
  const digests = new Set([...records.anchors.values()].flatMap((record) => record.documentSha256 === undefined ? [] : [String(record.documentSha256)]));
  if (state.paper?.documentSha256 !== undefined) {
    if (typeof state.paper.documentSha256 !== "string" || !SHA256.test(state.paper.documentSha256)) invalid();
    digests.add(state.paper.documentSha256);
  }
  if (digests.size > 1) invalid();
  return { paperRef: references.values().next().value ?? null, documentSha256: digests.values().next().value ?? null,
    pageCount: state.paper?.pageCount === undefined ? null : integer(state.paper.pageCount, 1) };
}

/** @param {RecordValue | null} record @returns {boolean} */
function protectedNode(record) {
  return Boolean(record && (record.authority === "document_structure" || record.kind === "paper" || record.kind === "section"
    || (Array.isArray(record.structuralCoverage) && record.structuralCoverage.length)));
}
/** @param {WorkspaceRecords} records @returns {Set<string>} */
function structuralAnchorIds(records) {
  const result = new Set();
  for (const node of records.nodes.values()) {
    if (!protectedNode(node)) continue;
    for (const anchorId of ids(node.sourceAnchorIds)) result.add(anchorId);
    for (const coverage of /** @type {RecordValue[]} */ (node.structuralCoverage || [])) result.add(id(coverage.primaryAnchorId));
  }
  for (const edge of records.edges.values()) if (edge.authority === "document_structure") for (const anchorId of ids(edge.sourceAnchorIds)) result.add(anchorId);
  return result;
}

/** @param {WorkspaceRecords} records @param {ReturnType<typeof paperIdentity>} identity */
function validateReferences(records, identity) {
  for (const name of /** @type {const} */ (["nodes", "edges", "annotations", "anchors"])) {
    if (records[name].size > WORKSPACE_PATCH_LIMITS[name]) invalid();
    for (const record of records[name].values()) if (record.paperRef !== undefined && record.paperRef !== identity.paperRef) invalid();
  }
  for (const anchor of records.anchors.values()) {
    if (anchor.paperRef !== identity.paperRef || (identity.documentSha256 && anchor.documentSha256 !== undefined && anchor.documentSha256 !== identity.documentSha256)
      || (identity.pageCount !== null && integer(anchor.pageIndex) >= identity.pageCount)) invalid();
  }
  for (const record of [...records.nodes.values(), ...records.edges.values()]) {
    const sources = ids(record.sourceAnchorIds);
    if (["paper_grounded", "reader_authored"].includes(String(record.authority)) && !sources.length) invalid();
    for (const source of sources) if (!records.anchors.has(source)) invalid();
  }
  for (const node of records.nodes.values()) {
    for (const coverage of /** @type {RecordValue[]} */ (node.structuralCoverage || [])) {
      const anchor = records.anchors.get(id(coverage.primaryAnchorId));
      if (!anchor || anchor.sourceKind !== "whole_page" || anchor.pageIndex !== coverage.startPageIndex
        || (identity.pageCount !== null && integer(coverage.endPageIndex) >= identity.pageCount)) invalid();
    }
  }
  for (const edge of records.edges.values()) {
    const source = records.nodes.get(id(edge.sourceKey));
    const target = records.nodes.get(id(edge.targetKey));
    if (!source || !target || (edge.status === "active" && (source.status !== "active" || target.status !== "active"))) invalid();
  }
  for (const annotation of records.annotations.values()) {
    if (!records.anchors.has(id(annotation.anchorId))) invalid();
    // Tombstoned graph links remain valid audit references. Missing IDs do not.
    for (const key of ids(annotation.graphNodeKeys)) if (!records.nodes.has(key)) invalid();
    for (const key of ids(annotation.graphEdgeKeys)) if (!records.edges.has(key)) invalid();
  }
}

/** Construct deterministic detached forward/inverse canonical record patches. @param {WorkspaceState} before @param {WorkspaceState} after @returns {{forwardPatch: WorkspacePatch, inversePatch: WorkspacePatch}} */
export function createWorkspacePatch(before, after) {
  const left = recordsFor(before), right = recordsFor(after);
  const identity = paperIdentity(before, left);
  const afterIdentity = paperIdentity(after, right);
  if (identity.paperRef !== afterIdentity.paperRef
    || (identity.documentSha256 && afterIdentity.documentSha256 && identity.documentSha256 !== afterIdentity.documentSha256)
    || (identity.pageCount !== null && afterIdentity.pageCount !== null && identity.pageCount !== afterIdentity.pageCount)) invalid();
  validateReferences(left, identity); validateReferences(right, identity);
  /** @type {WorkspacePatchOperation[]} */
  const operations = [];
  for (const op of /** @type {PatchKind[]} */ (["put_anchor", "put_node", "put_edge", "put_annotation"])) {
    const name = PATCH_COLLECTION[op];
    for (const key of [...new Set([...left[name].keys(), ...right[name].keys()])].sort()) {
      const previous = left[name].get(key) ?? null, next = right[name].get(key) ?? null;
      if (canonical(previous) !== canonical(next)) operations.push({ op, key, before: previous, after: next });
    }
  }
  const forwardPatch = validateWorkspacePatch(operations);
  // Exercise the same trusted baseline and reference checks used by replay.
  applyWorkspacePatch(before, forwardPatch);
  return frozen({ forwardPatch, inversePatch: invertWorkspacePatch(forwardPatch) });
}

/** Atomically apply a trusted patch on independent collections; live state is never changed. @param {WorkspaceState} state @param {unknown} input @returns {{anchors: Map<string, RecordValue>, graph: WorkspaceGraph, annotations: Map<string, RecordValue>}} */
export function applyWorkspacePatch(state, input) {
  const patch = validateWorkspacePatch(input);
  const records = recordsFor(state);
  const identity = paperIdentity(state, records);
  validateReferences(records, identity);
  const protectedAnchors = structuralAnchorIds(records);
  for (const operation of patch) {
    const current = records[PATCH_COLLECTION[operation.op]].get(operation.key) ?? null;
    if (canonical(current) !== canonical(operation.before)) conflict();
    if (operation.op === "put_node" && (protectedNode(operation.before) || protectedNode(operation.after))) invalid();
    if (operation.op === "put_edge" && (operation.before?.authority === "document_structure" || operation.after?.authority === "document_structure")) invalid();
    if (operation.op === "put_anchor" && protectedAnchors.has(operation.key)) invalid();
  }
  // Resolve the complete final topology before building Graphology. A node
  // removal cannot silently drop omitted incident edges or dangling links.
  for (const { op, key, after } of patch) {
    const target = records[PATCH_COLLECTION[op]];
    if (after === null) target.delete(key);
    else target.set(key, /** @type {RecordValue} */ (copyJson(after)));
  }
  validateReferences(records, identity);
  // Graphology emptyCopy retains all nodes; nullCopy retains only graph options.
  const graph = /** @type {WorkspaceGraph} */ (state.graph.nullCopy());
  graph.replaceAttributes(/** @type {RecordValue} */ (copyJson(state.graph.getAttributes())));
  for (const [key, record] of records.nodes) {
    const attributes = { ...record }; delete attributes.key;
    const prior = state.graph.hasNode(key) ? state.graph.getNodeAttributes(key) : {};
    const display = Object.fromEntries(Object.entries(prior).filter(([name]) => PRESENTATION.has(name)));
    graph.addNode(key, { ...attributes, .../** @type {RecordValue} */ (copyJson(display)) });
  }
  for (const [key, record] of records.edges) {
    const attributes = { ...record }; delete attributes.key; delete attributes.sourceKey; delete attributes.targetKey;
    const prior = state.graph.hasEdge(key) ? state.graph.getEdgeAttributes(key) : {};
    const display = Object.fromEntries(Object.entries(prior).filter(([name]) => PRESENTATION.has(name)));
    graph.addDirectedEdgeWithKey(key, id(record.sourceKey), id(record.targetKey), { ...attributes, .../** @type {RecordValue} */ (copyJson(display)) });
  }
  // Page-minted evidence remains immutable after history replay as well as mint.
  for (const record of records.anchors.values()) frozen(record);
  return { anchors: records.anchors, graph, annotations: records.annotations };
}
