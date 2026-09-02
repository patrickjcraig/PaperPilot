// @ts-check

import { humanReadable } from "./activity-ledger.mjs";
import { annotationAnchorId } from "./webmcp-observer.mjs";

/**
 * Browser-independent accessibility projections for the graph outline and
 * annotation cards. This module owns no DOM, renderer, storage, or navigation
 * behavior; it only turns trusted PaperPilot state into copied visible facts.
 */

/** @typedef {{ startPageIndex?: number, endPageIndex?: number, primaryAnchorId: string }} StructuralCoverage */
/** @typedef {{
 *   label?: string,
 *   kind?: string,
 *   authority?: string,
 *   origin?: string,
 *   status?: string,
 *   salience?: number,
 *   sourceAnchorIds?: readonly string[],
 *   structuralCoverage?: readonly StructuralCoverage[],
 *   structuralBasis?: string,
 *   structuralConfidence?: string,
 * }} GraphNodeAttributes */
/** @typedef {{
 *   relation?: string,
 *   kind?: string,
 *   status?: string,
 *   sourceAnchorIds?: readonly string[],
 * }} GraphEdgeAttributes */
/** @typedef {{ rank: number }} CriticalIdeaCandidate */
/** @typedef {{
 *   nodes(): string[],
 *   edges(): string[],
 *   source(edgeKey: string): string,
 *   target(edgeKey: string): string,
 *   getNodeAttributes(nodeKey: string): Record<string, unknown>,
 *   getNodeAttribute(nodeKey: string, attributeName: string): unknown,
 *   getEdgeAttributes(edgeKey: string): Record<string, unknown>,
 * }} GraphOutlineSource */
/** @typedef {{
 *   type: "node",
 *   key: string,
 *   label: string,
 *   kind: string,
 *   authority: string,
 *   origin: string,
 *   status: string,
 *   sourceIds: readonly string[],
 *   primarySourceId: string | null,
 *   candidateRank: number | null,
 *   candidateState: "agent refined" | "automatically ranked, unreviewed" | null,
 *   text: string,
 * }} AccessibleNodeFact */
/** @typedef {{
 *   type: "edge",
 *   key: string,
 *   sourceKey: string,
 *   targetKey: string,
 *   relation: string,
 *   status: string,
 *   sourceIds: readonly string[],
 *   text: string,
 * }} AccessibleEdgeFact */
/** @typedef {{ nodes: readonly AccessibleNodeFact[], edges: readonly AccessibleEdgeFact[] }} AccessibleGraphOutline */
/** @typedef {{
 *   anchorId?: string,
 *   sourceAnchorId?: string,
 *   sourceAnchorIds?: string[],
 *   body?: string,
 *   text?: string,
 *   label?: string,
 *   note?: string,
 *   kind?: string,
 *   authority?: string,
 *   status?: string,
 * }} AnnotationLike */
/** @typedef {{
 *   anchorId?: string,
 *   pageLabel?: string,
 *   sourceKind?: string,
 *   exactText?: string,
 *   regionDescription?: string,
 *   quote?: { exact?: string },
 * }} AnchorLike */
/** @typedef {{
 *   annotationId: string,
 *   annotation: AnnotationLike,
 *   anchor?: AnchorLike | null,
 *   linkedNodeKey?: string | null,
 *   criticalIdeaRank?: number | null,
 * }} AnnotationProjectionInput */
/** @typedef {{
 *   annotationId: string,
 *   anchorId: string,
 *   linkedNodeKey: string | null,
 *   body: string,
 *   kind: string,
 *   authority: string,
 *   status: string,
 *   provenance: string,
 *   summaryText: string,
 *   sourceSummary: string | null,
 *   chipText: string,
 *   chipLabel: string,
 *   isFixture: boolean,
 *   isAutomatic: boolean,
 * }} AccessibleAnnotationSummary */

/**
 * @param {readonly string[] | undefined} directSources
 * @param {readonly StructuralCoverage[] | undefined} structuralCoverage
 * @returns {readonly string[]}
 */
function nodeSourceIds(directSources, structuralCoverage) {
  if (directSources?.length) return Object.freeze([...directSources]);
  const structuralSources = (structuralCoverage || []).map((coverage) => coverage.primaryAnchorId);
  return Object.freeze(structuralSources);
}

/** @param {GraphNodeAttributes} attributes */
function nodeGroup(attributes) {
  if (attributes.kind === "paper" || attributes.structuralBasis === "paper_root") return 0;
  return attributes.authority === "document_structure" ? 1 : 2;
}

/** @param {GraphNodeAttributes} attributes */
function firstStructuralPage(attributes) {
  const indexes = (attributes.structuralCoverage || [])
    .map(({ startPageIndex }) => Number(startPageIndex))
    .filter(Number.isInteger);
  return indexes.length ? Math.min(...indexes) : Number.MAX_SAFE_INTEGER;
}

/** @param {GraphNodeAttributes} attributes */
function lastStructuralPage(attributes) {
  const indexes = (attributes.structuralCoverage || [])
    .map(({ endPageIndex }) => Number(endPageIndex))
    .filter(Number.isInteger);
  return indexes.length ? Math.max(...indexes) : Number.MAX_SAFE_INTEGER;
}

/** @param {readonly StructuralCoverage[] | undefined} coverage */
function structuralRangeText(coverage) {
  const ranges = (coverage || []).filter(({ startPageIndex, endPageIndex }) => (
    Number.isInteger(startPageIndex) && Number.isInteger(endPageIndex)
  ));
  if (!ranges.length) return null;
  const start = Math.min(...ranges.map(({ startPageIndex }) => Number(startPageIndex)));
  const end = Math.max(...ranges.map(({ endPageIndex }) => Number(endPageIndex)));
  return start === end ? `page ${start + 1}` : `pages ${start + 1}–${end + 1}`;
}

/** @param {string | undefined} value */
function structuralBasisText(value) {
  if (value === "paper_root") return "paper root";
  if (value === "pdf_outline") return "PDF outline";
  if (value === "heading_heuristic") return "detected heading";
  if (value === "page_fallback") return "deterministic page fallback";
  return "document structure";
}

/** @param {string | undefined} value */
function structuralConfidenceText(value) {
  if (value === "document_declared") return "document-provided";
  if (value === "system_inferred") return "system-inferred, provisional";
  if (value === "coverage_fallback") return "coverage fallback, no heading claim";
  return "not recorded";
}
/**
 * Project the facts currently exposed by Sigma's equal accessible DOM outline.
 * Layout attributes are intentionally excluded: they are presentation-only and
 * must not change the screen-reader graph facts or WebMCP semantics.
 *
 * @param {GraphOutlineSource} graph
 * @param {ReadonlyMap<string, CriticalIdeaCandidate>} [criticalIdeasByNodeKey]
 * @returns {AccessibleGraphOutline}
 */
export function projectAccessibleGraphOutline(graph, criticalIdeasByNodeKey = new Map()) {
  const orderedNodeKeys = [...graph.nodes()].sort((left, right) => {
    const leftAttributes = /** @type {GraphNodeAttributes} */ (graph.getNodeAttributes(left));
    const rightAttributes = /** @type {GraphNodeAttributes} */ (graph.getNodeAttributes(right));
    const groupDifference = nodeGroup(leftAttributes) - nodeGroup(rightAttributes);
    if (groupDifference !== 0) return groupDifference;
    if (nodeGroup(leftAttributes) < 2) {
      return firstStructuralPage(leftAttributes) - firstStructuralPage(rightAttributes)
        || lastStructuralPage(leftAttributes) - lastStructuralPage(rightAttributes)
        || left.localeCompare(right);
    }
    const leftRank = criticalIdeasByNodeKey.get(left)?.rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = criticalIdeasByNodeKey.get(right)?.rank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftSalience = Number(graph.getNodeAttribute(left, "salience")) || 0;
    const rightSalience = Number(graph.getNodeAttribute(right, "salience")) || 0;
    return rightSalience - leftSalience || left.localeCompare(right);
  });

  const nodes = orderedNodeKeys.map((key) => {
    const attributes = /** @type {GraphNodeAttributes} */ (graph.getNodeAttributes(key));
    const sourceIds = nodeSourceIds(attributes.sourceAnchorIds, attributes.structuralCoverage);
    const sources = sourceIds.join(", ") || "unavailable";
    const candidate = criticalIdeasByNodeKey.get(key);
    const candidateState = candidate
      ? attributes.origin === "agent" ? "agent refined" : "automatically ranked, unreviewed"
      : null;
    const candidateContext = candidate
      ? ` · critical candidate rank ${candidate.rank} · ${candidateState}`
      : "";
    const label = attributes.label || key;
    const kind = attributes.kind || "concept";
    const authority = attributes.authority || "unknown authority";
    const origin = attributes.origin || "unknown origin";
    const status = attributes.status || "unknown status";
    const rangeText = structuralRangeText(attributes.structuralCoverage);
    const structuralContext = authority === "document_structure" && rangeText
      ? ` · ${rangeText} · structural source ${structuralBasisText(attributes.structuralBasis)} · confidence ${structuralConfidenceText(attributes.structuralConfidence)}`
      : "";
    const sourceLabel = authority === "document_structure" ? "paper source" : "source";
    return Object.freeze({
      type: /** @type {const} */ ("node"),
      key,
      label,
      kind,
      authority,
      origin,
      status,
      sourceIds,
      primarySourceId: sourceIds[0] || null,
      candidateRank: candidate?.rank ?? null,
      candidateState,
      text: `Node · ${label} · ${humanReadable(kind)} · ${humanReadable(authority)} · ${humanReadable(origin)} · ${humanReadable(status)}${candidateContext}${structuralContext} · ${sourceLabel} ${sources}`,
    });
  });

  const edges = graph.edges().map((key) => {
    const attributes = /** @type {GraphEdgeAttributes} */ (graph.getEdgeAttributes(key));
    const sourceKey = graph.source(key);
    const targetKey = graph.target(key);
    const relation = attributes.relation || attributes.kind || "relates to";
    const status = attributes.status || "unknown status";
    const sourceIds = Object.freeze([...(attributes.sourceAnchorIds || [])]);
    const sources = sourceIds.join(", ") || "unavailable";
    return Object.freeze({
      type: /** @type {const} */ ("edge"),
      key,
      sourceKey,
      targetKey,
      relation,
      status,
      sourceIds,
      text: `Edge · ${sourceKey} → ${targetKey} · ${humanReadable(relation)} · ${humanReadable(status)} · source ${sources}`,
    });
  });

  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
}

/**
 * Project the exact accessible annotation card, source, and paper-chip copy.
 * The annotation and anchor are not mutated, and raw geometry is never copied.
 *
 * @param {AnnotationProjectionInput} input
 * @returns {AccessibleAnnotationSummary}
 */
export function projectAccessibleAnnotationSummary({
  annotationId,
  annotation,
  anchor = null,
  linkedNodeKey = null,
  criticalIdeaRank = null,
}) {
  const anchorId = annotationAnchorId(annotation) || "unknown anchor";
  const body = annotation.label || annotation.body || annotation.text || annotation.note || "Annotation";
  const isFixture = annotationId.startsWith("annotation:fixture:");
  const isAutomatic = annotationId.startsWith("annotation:auto:");
  const authority = annotation.authority || "unknown";
  const provenance = isFixture
    ? "deterministic demo fixture"
    : isAutomatic
      ? "automatically ranked, unreviewed paper candidate"
      : authority === "agent"
        ? "created through WebMCP"
        : authority === "reader"
          ? "created by the reader and linked to the graph"
          : `${authority} origin`;
  const kind = annotation.kind || "";
  const status = annotation.status || "unknown status";
  const quotedSource = anchor?.quote?.exact || anchor?.exactText;
  const regionDescription = anchor?.regionDescription
    || (anchor?.sourceKind === "visual_region" && annotation.body && annotation.body !== annotation.label ? annotation.body : "");
  const sourceSummary = quotedSource
    ? `Page ${anchor?.pageLabel || "?"} · ${anchor?.anchorId || "exact text"} · “${quotedSource}”`
    : regionDescription
      ? `Page ${anchor?.pageLabel || "?"} · described ${humanReadable(anchor?.sourceKind || "visual region")} · ${regionDescription}`
      : anchor?.pageLabel
        ? `Page ${anchor.pageLabel} · ${humanReadable(anchor.sourceKind || "paper source")} · no nonvisual description available`
        : null;
  const automaticRank = isAutomatic && linkedNodeKey && Number.isInteger(criticalIdeaRank) && Number(criticalIdeaRank) > 0
    ? Number(criticalIdeaRank)
    : null;

  return Object.freeze({
    annotationId,
    anchorId,
    linkedNodeKey,
    body,
    kind,
    authority,
    status,
    provenance,
    summaryText: `${body} · ${humanReadable(kind)} · ${provenance} · ${status}`,
    sourceSummary,
    chipText: automaticRank ? `Idea ${automaticRank}` : body,
    chipLabel: `${body} · ${provenance}`,
    isFixture,
    isAutomatic,
  });
}
