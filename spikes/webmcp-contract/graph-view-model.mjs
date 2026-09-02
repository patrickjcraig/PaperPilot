// @ts-check

/**
 * Pure, presentation-only graph projection. A visual limit is not a semantic
 * limit: the complete active ID set always remains available to the DOM outline.
 * No renderer coordinates, shortened labels, or selection flags are written to
 * Graphology, sources, history, or WebMCP records by this module.
 */

/** @typedef {{ startPageIndex?: number, primaryAnchorId?: string }} StructuralCoverage */
/** @typedef {{
 *   kind?: string, label?: string, authority?: string, origin?: string,
 *   status?: string, salience?: number, sourceAnchorIds?: readonly string[],
 *   structuralCoverage?: readonly StructuralCoverage[],
 * }} GraphNodeAttributes */
/** @typedef {{ kind?: string, status?: string }} GraphEdgeAttributes */
/** @typedef {{
 *   nodes(): string[], edges(): string[],
 *   getNodeAttributes(key: string): GraphNodeAttributes,
 *   getEdgeAttributes(key: string): GraphEdgeAttributes,
 *   source(edgeKey: string): string, target(edgeKey: string): string,
 * }} GraphViewSource */
/** @typedef {{ x: number, y: number }} GraphPosition */
/** @typedef {{
 *   selectedNodeKey?: string | null, selectedEdgeKey?: string | null,
 *   maxVisibleNodes?: number, mode?: "focus" | "all",
 *   anchorPageIndices?: ReadonlyMap<string, number>,
 * }} GraphViewOptions */
/** @typedef {{
 *   nodeKeys?: readonly string[], anchorPageIndices?: ReadonlyMap<string, number>,
 *   existingPositions?: ReadonlyMap<string, GraphPosition>,
 * }} GraphLayoutOptions */
/** @typedef {{ key: string, attributes: GraphNodeAttributes, pageIndex: number }} NodeView */
/** @typedef {{ key: string, source: string, target: string, attributes: GraphEdgeAttributes }} EdgeView */

export const DEFAULT_VISIBLE_GRAPH_NODES = 15;
export const MAX_VISIBLE_GRAPH_NODES = 60;
export const MAX_VISIBLE_GRAPH_EDGES = 120;
const MAX_FOCUS_NEIGHBORS = 4;
const LAYOUT_POSITION_LIMIT = 10_000;

/** Lexical ID order does not depend on the browser locale or insertion order.
 * @param {string} left @param {string} right
 */
function compareKey(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {GraphNodeAttributes} attributes */
function group(attributes) {
  if (attributes.kind === "paper") return 0;
  if (attributes.origin === "reader") return 1;
  if (attributes.origin === "agent") return 2;
  if (["main_idea", "method", "result"].includes(attributes.kind || "")) return 3;
  if (attributes.authority === "document_structure" || attributes.kind === "section") return 4;
  if (attributes.kind === "prerequisite" || attributes.authority === "mentor_background") return 6;
  return 5;
}

/** @param {GraphNodeAttributes} attributes */
function salience(attributes) {
  const value = attributes.salience;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** @param {GraphNodeAttributes} attributes @param {ReadonlyMap<string, number> | undefined} pages */
function firstSourcePage(attributes, pages) {
  const indexes = (attributes.structuralCoverage || []).map((entry) => entry.startPageIndex);
  for (const id of attributes.sourceAnchorIds || []) indexes.push(pages?.get(id));
  for (const entry of attributes.structuralCoverage || []) {
    if (entry.primaryAnchorId) indexes.push(pages?.get(entry.primaryAnchorId));
  }
  let first = Number.POSITIVE_INFINITY;
  for (const index of indexes) {
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) first = Math.min(first, index);
  }
  return first;
}

/** @param {NodeView} left @param {NodeView} right */
function compareNodes(left, right) {
  const groupOrder = group(left.attributes) - group(right.attributes);
  if (groupOrder) return groupOrder;
  // Structure follows document order. Semantic candidates follow salience, then
  // real source pages; labels and opaque key formats are not parsed as evidence.
  const pageOrder = left.pageIndex === right.pageIndex ? 0 : left.pageIndex < right.pageIndex ? -1 : 1;
  if (group(left.attributes) === 4 && pageOrder) return pageOrder;
  return salience(right.attributes) - salience(left.attributes) || pageOrder || compareKey(left.key, right.key);
}

/** @param {GraphViewSource} graph @param {ReadonlyMap<string, number> | undefined} pages */
function inspectGraph(graph, pages) {
  const nodeKeys = [...new Set(graph.nodes())].sort(compareKey);
  const edgeKeys = [...new Set(graph.edges())].sort(compareKey);
  const nodes = nodeKeys.map((key) => {
    const attributes = graph.getNodeAttributes(key);
    return { key, attributes, pageIndex: firstSourcePage(attributes, pages) };
  });
  const activeNodes = nodes.filter((node) => node.attributes.status === "active").sort(compareNodes);
  const activeKeys = new Set(activeNodes.map((node) => node.key));
  const edges = edgeKeys.map((key) => ({
    key, attributes: graph.getEdgeAttributes(key), source: graph.source(key), target: graph.target(key),
  }));
  const activeEdges = edges.filter((edge) => edge.attributes.status === "active"
    && activeKeys.has(edge.source) && activeKeys.has(edge.target));
  return { nodes, activeNodes, edges, activeEdges, activeKeys };
}

/** @param {number | undefined} requested */
function nodeLimit(requested) {
  const value = typeof requested === "number" && Number.isFinite(requested)
    ? Math.floor(requested) : DEFAULT_VISIBLE_GRAPH_NODES;
  // Four slots can always retain a selected node, selected-edge endpoints, and
  // the paper root, even if a caller requests an impractically small view.
  return Math.max(4, Math.min(MAX_VISIBLE_GRAPH_NODES, value));
}

/**
 * Return immutable explicit-ID lists for both the bounded canvas and complete
 * active outline. Tombstones are separate audit lists, never visual neighbors.
 * `all` expands to at most 60 nodes, not an unbounded canvas. Counts report every
 * omitted node/edge, including parallel edges omitted from a dense visual slice.
 *
 * @param {GraphViewSource} graph @param {GraphViewOptions} [options]
 */
export function projectGraphView(graph, options = {}) {
  const inspected = inspectGraph(graph, options.anchorPageIndices);
  const { nodes, activeNodes, edges, activeEdges, activeKeys } = inspected;
  const limit = options.mode === "all" ? MAX_VISIBLE_GRAPH_NODES : nodeLimit(options.maxVisibleNodes);
  const selectedNodeKey = options.selectedNodeKey && activeKeys.has(options.selectedNodeKey)
    ? options.selectedNodeKey : null;
  const selectedEdge = activeEdges.find((edge) => edge.key === options.selectedEdgeKey);
  const selectedEdgeKey = selectedEdge?.key || null;
  const root = activeNodes.find((node) => node.attributes.kind === "paper");
  const selected = new Set(selectedNodeKey ? [selectedNodeKey] : []);
  if (selectedEdge) {
    selected.add(selectedEdge.source);
    selected.add(selectedEdge.target);
  }
  const visible = new Set(selected);
  if (root) visible.add(root.key);

  const neighbors = new Set();
  for (const edge of activeEdges) {
    if (selected.has(edge.source)) neighbors.add(edge.target);
    if (selected.has(edge.target)) neighbors.add(edge.source);
  }
  let addedNeighbors = 0;
  for (const node of activeNodes) {
    if (visible.size >= limit || addedNeighbors >= MAX_FOCUS_NEIGHBORS) break;
    if (!neighbors.has(node.key) || visible.has(node.key)) continue;
    visible.add(node.key);
    addedNeighbors += 1;
  }
  for (const node of activeNodes) {
    if (visible.size >= limit) break;
    visible.add(node.key);
  }
  const visibleNodeKeys = Object.freeze(activeNodes.filter((node) => visible.has(node.key)).map((node) => node.key));
  const visibleEdges = activeEdges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
  const edgeLimit = Math.min(MAX_VISIBLE_GRAPH_EDGES, Math.max(24, visible.size * 2));
  /** @param {EdgeView} edge */
  const edgePriority = (edge) => edge.key === selectedEdgeKey ? 0
    : selected.has(edge.source) || selected.has(edge.target) ? 1
      : edge.attributes.kind === "contains" ? 3 : 2;
  visibleEdges.sort((left, right) => edgePriority(left) - edgePriority(right)
    || compareKey(left.source, right.source) || compareKey(left.target, right.target) || compareKey(left.key, right.key));
  const visibleEdgeKeys = Object.freeze(visibleEdges.slice(0, edgeLimit).map((edge) => edge.key));
  const outlineNodeKeys = Object.freeze(activeNodes.map((node) => node.key));
  const outlineEdgeKeys = Object.freeze(activeEdges.map((edge) => edge.key));
  const tombstonedNodeKeys = Object.freeze(nodes.filter((node) => node.attributes.status === "tombstoned").map((node) => node.key));
  const tombstonedEdgeKeys = Object.freeze(edges.filter((edge) => edge.attributes.status === "tombstoned").map((edge) => edge.key));
  const counts = Object.freeze({
    totalNodes: nodes.length, activeNodes: activeNodes.length, tombstonedNodes: tombstonedNodeKeys.length,
    visibleNodes: visibleNodeKeys.length, hiddenNodes: activeNodes.length - visibleNodeKeys.length,
    totalEdges: edges.length, activeEdges: activeEdges.length, tombstonedEdges: tombstonedEdgeKeys.length,
    visibleEdges: visibleEdgeKeys.length, hiddenEdges: activeEdges.length - visibleEdgeKeys.length,
  });
  const truncated = counts.hiddenNodes > 0 || counts.hiddenEdges > 0;
  return Object.freeze({
    visibleNodeKeys, visibleEdgeKeys, outlineNodeKeys, outlineEdgeKeys, tombstonedNodeKeys, tombstonedEdgeKeys,
    selectedNodeKey, selectedEdgeKey, counts, truncated, outlineRecommended: truncated,
  });
}

/** @param {GraphPosition | undefined} position @returns {Readonly<GraphPosition> | null} */
function copyPosition(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const clamp = (/** @type {number} */ value) => Math.min(LAYOUT_POSITION_LIMIT, Math.max(-LAYOUT_POSITION_LIMIT, value));
  return Object.freeze({ x: clamp(position.x) || 0, y: clamp(position.y) || 0 });
}

/** @param {GraphPosition} position @param {readonly GraphPosition[]} occupied */
function hasSpace(position, occupied) {
  return occupied.every((other) => Math.abs(other.x - position.x) >= 0.08 || Math.abs(other.y - position.y) >= 0.08);
}

/** @param {GraphPosition} preferred @param {readonly GraphPosition[]} occupied */
function freePosition(preferred, occupied) {
  if (hasSpace(preferred, occupied)) return preferred;
  // Deterministic square rings provide >600 bounded spare slots when revealing
  // new nodes around saved positions. Existing user placements are not moved.
  for (let ring = 1; ring <= 40; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const candidate = { x: preferred.x + dx * 0.2, y: preferred.y + dy * 0.2 };
        if (hasSpace(candidate, occupied)) return candidate;
      }
    }
  }
  return preferred; // Beyond the admitted 600-node graph capacity only.
}

/**
 * Seed a compact two-column view with separated paper / authored / critical
 * idea / structure / detail bands. Rank is a display aid, never a causal claim.
 * Pass `nodeKeys: view.visibleNodeKeys` so hidden nodes do not shrink the canvas.
 * A supplied existingPositions map preserves active saved coordinates and keeps
 * newly revealed nodes away from occupied slots; no input map/object is reused.
 *
 * @param {GraphViewSource} graph @param {GraphLayoutOptions} [options]
 * @returns {Map<string, Readonly<GraphPosition>>}
 */
export function createGraphLayout(graph, options = {}) {
  const { activeNodes, activeKeys } = inspectGraph(graph, options.anchorPageIndices);
  const requested = options.nodeKeys ? new Set(options.nodeKeys) : activeKeys;
  const nodes = activeNodes.filter((node) => requested.has(node.key));
  /** @type {Map<string, Readonly<GraphPosition>>} */
  const positions = new Map();
  if (!nodes.length) return positions;
  /** @type {Map<string, Readonly<GraphPosition>>} */
  const saved = new Map();
  for (const [key, value] of options.existingPositions || []) {
    const position = copyPosition(value);
    if (activeKeys.has(key) && position) saved.set(key, position);
  }
  const occupied = [...saved.values()];
  const bands = [...new Set(nodes.map((node) => group(node.attributes)))].sort((left, right) => left - right);
  /** @type {{ key: string, x: number, row: number }[]} */
  const seeds = [];
  let row = 0;
  for (const band of bands) {
    const members = nodes.filter((node) => group(node.attributes) === band);
    for (let index = 0; index < members.length; index += 1) {
      const singleton = members.length % 2 === 1 && index === members.length - 1;
      seeds.push({ key: members[index].key, x: singleton ? 0 : index % 2 === 0 ? -0.78 : 0.78, row: row + Math.floor(index / 2) });
    }
    row += Math.ceil(members.length / 2) + 0.6;
  }
  const lastRow = seeds.at(-1)?.row || 0;
  for (const seed of seeds) {
    const existing = saved.get(seed.key);
    if (existing) {
      positions.set(seed.key, Object.freeze({ ...existing }));
      continue;
    }
    const preferred = { x: seed.x, y: lastRow ? 1.1 - (seed.row / lastRow) * 2.2 : 0 };
    const position = Object.freeze(freePosition(preferred, occupied));
    positions.set(seed.key, position);
    occupied.push(position);
  }
  return positions;
}

/**
 * Canvas-only short label. Use the canonical label in the outline/details and
 * accessible name; this string is not source text or a serialized graph label.
 * Unicode scalar values are not split, and paper strings remain plain text.
 * @param {string} label @param {{ maxLength?: number }} [options]
 */
export function graphDisplayLabel(label, options = {}) {
  const requested = options.maxLength;
  const limit = typeof requested === "number" && Number.isFinite(requested)
    ? Math.max(4, Math.min(80, Math.floor(requested))) : 24;
  const characters = Array.from(String(label).replace(/\s+/gu, " ").trim());
  return characters.length <= limit ? characters.join("") : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}
