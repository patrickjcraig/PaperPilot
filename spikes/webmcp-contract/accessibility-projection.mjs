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
 *   summary?: string,
 *   kind?: string,
 *   authority?: string,
 *   origin?: string,
 *   status?: string,
 *   entityRevision?: number,
 *   salience?: number,
 *   sourceAnchorIds?: readonly string[],
 *   structuralCoverage?: readonly StructuralCoverage[],
 *   structuralBasis?: string,
 *   structuralConfidence?: string,
 * }} GraphNodeAttributes */
/** @typedef {{
 *   relation?: string,
 *   kind?: string,
 *   claim?: string,
 *   summary?: string,
 *   authority?: string,
 *   origin?: string,
 *   status?: string,
 *   entityRevision?: number,
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
 *   summary: string,
 *   kind: string,
 *   authority: string,
 *   origin: string,
 *   status: string,
 *   statusText: string,
 *   entityRevision: number | null,
 *   sourceIds: readonly string[],
 *   sourceCount: number,
 *   primarySourceId: string | null,
 *   sourceState: "declared" | "mentor_background" | "missing",
 *   sourceStatusText: string,
 *   incomingEdgeKeys: readonly string[],
 *   outgoingEdgeKeys: readonly string[],
 *   structuralCoverage: readonly Readonly<StructuralCoverage>[],
 *   structuralRangeText: string | null,
 *   structuralBasis: string | null,
 *   structuralBasisText: string | null,
 *   structuralConfidence: string | null,
 *   structuralConfidenceText: string | null,
 *   candidateRank: number | null,
 *   candidateState: "agent refined" | "automatically ranked, unreviewed" | null,
 *   text: string,
 * }} AccessibleNodeFact */
/** @typedef {{
 *   type: "edge",
 *   key: string,
 *   sourceKey: string,
 *   targetKey: string,
 *   sourceLabel: string,
 *   targetLabel: string,
 *   relation: string,
 *   claim: string,
 *   summary: string,
 *   authority: string,
 *   origin: string,
 *   status: string,
 *   statusText: string,
 *   entityRevision: number | null,
 *   sourceIds: readonly string[],
 *   sourceCount: number,
 *   primarySourceId: string | null,
 *   sourceState: "declared" | "mentor_background" | "missing",
 *   sourceStatusText: string,
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
  const structuralSources = (structuralCoverage || []).map((coverage) => coverage.primaryAnchorId);
  // Preserve the canonical primary source, but do not hide additional range
  // anchors when a legacy structural node also has direct text sources.
  return Object.freeze([...new Set([...(directSources || []), ...structuralSources])]);
}

/** @param {string} left @param {string} right */
function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {number | undefined} value */
function entityRevision(value) {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

/** @param {string} status */
function statusText(status) {
  return status === "tombstoned" ? "tombstoned (removed; retained for audit)" : humanReadable(status);
}

/**
 * "declared" means source references exist, not that this projection has
 * validated the source registry or the scientific claim. Navigation resolves
 * current anchors and handles any stale/missing target separately.
 * @param {string} authority
 * @param {readonly string[]} sourceIds
 */
function sourceFacts(authority, sourceIds) {
  const sourceCount = sourceIds.length;
  const sourceState = sourceCount > 0
    ? /** @type {const} */ ("declared")
    : authority === "mentor_background"
      ? /** @type {const} */ ("mentor_background")
      : /** @type {const} */ ("missing");
  return {
    sourceIds,
    sourceCount,
    primarySourceId: sourceIds[0] || null,
    sourceState,
    sourceStatusText: sourceCount > 0
      ? `${sourceCount} linked ${sourceCount === 1 ? "source" : "sources"}`
      : sourceState === "mentor_background"
        ? "Mentor background — no paper source expected"
        : "Source incomplete",
  };
}

/** @param {readonly StructuralCoverage[] | undefined} coverage */
function copyStructuralCoverage(coverage) {
  return Object.freeze((coverage || []).map(({ startPageIndex, endPageIndex, primaryAnchorId }) => Object.freeze({
    ...(startPageIndex !== undefined ? { startPageIndex } : {}),
    ...(endPageIndex !== undefined ? { endPageIndex } : {}),
    primaryAnchorId,
  })));
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
  )).sort((left, right) => Number(left.startPageIndex) - Number(right.startPageIndex)
    || Number(left.endPageIndex) - Number(right.endPageIndex));
  if (!ranges.length) return null;
  // Distinct ranges must not imply coverage of any gap between them.
  return ranges.map(({ startPageIndex, endPageIndex }) => {
    const start = Number(startPageIndex) + 1;
    const end = Number(endPageIndex) + 1;
    return start === end ? `page ${start}` : `pages ${start}–${end}`;
  }).join(", ");
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
        || compareKeys(left, right);
    }
    const leftRank = criticalIdeasByNodeKey.get(left)?.rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = criticalIdeasByNodeKey.get(right)?.rank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftSalience = Number(graph.getNodeAttribute(left, "salience")) || 0;
    const rightSalience = Number(graph.getNodeAttribute(right, "salience")) || 0;
    return rightSalience - leftSalience || compareKeys(left, right);
  });

  // Keys, not insertion order or layout, define relationship order. Build
  // adjacency once so the complete 600-node/1,200-edge outline stays linear
  // after sorting and retains distinct parallel and reverse relationships.
  const orderedEdgeKeys = [...graph.edges()].sort(compareKeys);
  const incomingByNode = new Map(orderedNodeKeys.map((key) => [key, /** @type {string[]} */ ([])]));
  const outgoingByNode = new Map(orderedNodeKeys.map((key) => [key, /** @type {string[]} */ ([])]));
  for (const key of orderedEdgeKeys) {
    incomingByNode.get(graph.target(key))?.push(key);
    outgoingByNode.get(graph.source(key))?.push(key);
  }

  const nodes = orderedNodeKeys.map((key) => {
    const attributes = /** @type {GraphNodeAttributes} */ (graph.getNodeAttributes(key));
    const sourceIds = nodeSourceIds(attributes.sourceAnchorIds, attributes.structuralCoverage);
    const candidate = criticalIdeasByNodeKey.get(key);
    const candidateState = candidate
      ? attributes.origin === "agent" ? "agent refined" : "automatically ranked, unreviewed"
      : null;
    const candidateContext = candidate
      ? ` · critical candidate rank ${candidate.rank} · ${candidateState}${candidateState === "agent refined" ? ", unreviewed" : ""}`
      : attributes.origin === "automatic_map" && attributes.authority !== "document_structure"
        ? " · automatically suggested, unreviewed"
        : "";
    const label = attributes.label || key;
    const summary = attributes.summary || "";
    const kind = attributes.kind || "concept";
    const authority = attributes.authority || "unknown authority";
    const origin = attributes.origin || "unknown origin";
    const status = attributes.status || "unknown status";
    const revision = entityRevision(attributes.entityRevision);
    const presentedStatus = statusText(status);
    const sources = sourceFacts(authority, sourceIds);
    const rangeText = structuralRangeText(attributes.structuralCoverage);
    const structuralContext = authority === "document_structure" && rangeText
      ? ` · ${rangeText} · structural source ${structuralBasisText(attributes.structuralBasis)} · confidence ${structuralConfidenceText(attributes.structuralConfidence)}`
      : "";
    const sourceLabel = authority === "document_structure" ? "paper source" : "source";
    const sourceContext = sourceIds.length ? ` · ${sourceLabel} ${sourceIds.join(", ")}` : "";
    return Object.freeze({
      type: /** @type {const} */ ("node"),
      key,
      label,
      summary,
      kind,
      authority,
      origin,
      status,
      statusText: presentedStatus,
      entityRevision: revision,
      ...sources,
      incomingEdgeKeys: Object.freeze(incomingByNode.get(key) || []),
      outgoingEdgeKeys: Object.freeze(outgoingByNode.get(key) || []),
      structuralCoverage: copyStructuralCoverage(attributes.structuralCoverage),
      structuralRangeText: authority === "document_structure" ? rangeText : null,
      structuralBasis: attributes.structuralBasis || null,
      structuralBasisText: authority === "document_structure" ? structuralBasisText(attributes.structuralBasis) : null,
      structuralConfidence: attributes.structuralConfidence || null,
      structuralConfidenceText: authority === "document_structure" ? structuralConfidenceText(attributes.structuralConfidence) : null,
      candidateRank: candidate?.rank ?? null,
      candidateState,
      text: `Node · ${label}${summary ? ` · ${summary}` : ""} · ${humanReadable(kind)} · ${humanReadable(authority)} · ${humanReadable(origin)} · ${presentedStatus}${revision !== null ? ` · revision ${revision}` : ""}${candidateContext}${structuralContext} · ${sources.sourceStatusText}${sourceContext}`,
    });
  });

  const edges = orderedEdgeKeys.map((key) => {
    const attributes = /** @type {GraphEdgeAttributes} */ (graph.getEdgeAttributes(key));
    const sourceKey = graph.source(key);
    const targetKey = graph.target(key);
    const sourceLabel = String(graph.getNodeAttribute(sourceKey, "label") || sourceKey);
    const targetLabel = String(graph.getNodeAttribute(targetKey, "label") || targetKey);
    const relation = attributes.relation || attributes.kind || "relates to";
    const claim = attributes.claim || "";
    const summary = attributes.summary || claim;
    const authority = attributes.authority || "unknown authority";
    const origin = attributes.origin || "unknown origin";
    const status = attributes.status || "unknown status";
    const presentedStatus = statusText(status);
    const revision = entityRevision(attributes.entityRevision);
    const sourceIds = Object.freeze([...new Set(attributes.sourceAnchorIds || [])]);
    const sources = sourceFacts(authority, sourceIds);
    const claimContext = claim ? ` · ${claim}` : "";
    const summaryContext = summary && summary !== claim ? ` · ${summary}` : "";
    const sourceContext = sourceIds.length ? ` · source ${sourceIds.join(", ")}` : "";
    return Object.freeze({
      type: /** @type {const} */ ("edge"),
      key,
      sourceKey,
      targetKey,
      sourceLabel,
      targetLabel,
      relation,
      claim,
      summary,
      authority,
      origin,
      status,
      statusText: presentedStatus,
      entityRevision: revision,
      ...sources,
      text: `Edge · ${sourceLabel} → ${targetLabel} · ${humanReadable(relation)}${claimContext}${summaryContext} · ${humanReadable(authority)} · ${humanReadable(origin)} · ${presentedStatus}${revision !== null ? ` · revision ${revision}` : ""} · ${sources.sourceStatusText}${sourceContext}`,
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
