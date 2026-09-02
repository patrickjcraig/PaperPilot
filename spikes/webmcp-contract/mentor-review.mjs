/**
 * Pure mentor-review helpers for PaperPilot's public vertical slice.
 *
 * This module deliberately knows nothing about the DOM, storage, WebMCP
 * registration, Graphology, or PDF.js. It turns an already-staged mentor
 * explanation into a stable seven-section view model and keeps Save/Discard a
 * page-owned human decision. No helper mutates its inputs.
 */

import { normalizeMentorRecord, safeExternalCitationUrl } from "./mentor-contract.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z][a-z0-9:_-]{2,127}$/u;
const MAX_SAVED_EXPLANATIONS = 200;
const MAX_TAKEAWAY_LENGTH = 1_200;

/** @typedef {"quickTake" | "paperFit" | "prerequisites" | "howItWorks" | "paperEvidence" | "relatedIdeas" | "limitations"} MentorSectionKey */
/** @typedef {"document_evidence" | "rendered_document_view" | "mentor_interpretation" | "mentor_background" | "external_source" | "uncertain" | "legacy_unclassified"} MentorAuthorityKind */
/** @typedef {{text: string, authority: MentorAuthorityKind, anchorIds: string[], graphEntityKeys: string[], citationIds: string[]}} MentorClaim */
/** @typedef {{key: string, kind: "source" | "node" | "edge" | "graph", label: string, available: boolean, detail: string}} MentorEvidenceLink */
/** @typedef {{citationId: string, title: string, href: string | null, label: string}} MentorCitationLink */
/** @typedef {MentorClaim & {key: string, authorityLabel: string, sourceLinks: MentorEvidenceLink[], graphLinks: MentorEvidenceLink[], citations: MentorCitationLink[], warnings: string[]}} MentorClaimView */
/** @typedef {"save" | "discard"} MentorDecision */
/** @typedef {"saved" | "discarded" | "rejected" | "no_staged_explanation"} MentorDecisionStatus */
/** @typedef {{eventType: "explanation_saved" | "explanation_discarded", actor: "human", explanationId: string, responseDigest: string}} MentorDecisionEvent */
/** @typedef {{status: MentorDecisionStatus, changed: boolean, stagedExplanations: unknown[], savedExplanations: unknown[], explanation?: unknown, event: MentorDecisionEvent | null, code?: string}} MentorDecisionResult */

/**
 * @typedef {object} MentorSectionDefinition
 * @property {MentorSectionKey} key
 * @property {string} label
 * @property {boolean} initiallyOpen
 */

/**
 * @typedef {object} NormalizedMentorExplanation
 * @property {string} explanationId
 * @property {string} responseDigest
 * @property {Record<MentorSectionKey, string>} sections
 * @property {Record<MentorSectionKey, MentorClaim[]>} claimSections
 * @property {"legacy_unclassified" | "claim_level"} provenanceMode
 * @property {string | null} expectedGraphDigest
 * @property {string} visualObservation
 * @property {string} visualEvidenceMode
 * @property {Array<{anchorId: string, status: string, explanation: string}>} sourceCoverage
 * @property {Array<{entityKey: string, role: string}>} graphCoverage
 * @property {Array<{citationId: string, title: string, url: string}>} externalCitations
 * @property {string[]} sourceAnchorIds
 * @property {string[]} graphEntityKeys
 * @property {string | null} focusAnchorId
 * @property {string} takeaway
 * @property {string | null} savedAt
 * @property {boolean} saved
 */

/**
 * @typedef {object} MentorReviewViewModel
 * @property {"empty" | "draft" | "saved"} state
 * @property {string} stateLabel
 * @property {string} statusMessage
 * @property {boolean} showHumanDecisionActions
 * @property {NormalizedMentorExplanation | null} explanation
 * @property {string} quickTake
 * @property {MentorClaimView[]} quickTakeClaims
 * @property {Array<MentorSectionDefinition & {content: string, claims: MentorClaimView[]}>} sections
 * @property {string[]} sourceAnchorIds
 * @property {string[]} graphEntityKeys
 * @property {number} citedSourceCount
 * @property {string} takeaway
 * @property {MentorEvidenceLink[]} sourceLinks
 * @property {MentorEvidenceLink[]} graphLinks
 * @property {string[]} notices
 * @property {{text: string, label: string, limitation: string, sourceLinks: MentorEvidenceLink[]} | null} visualDescription
 * @property {Array<{link: MentorEvidenceLink, status: string, explanation: string}>} sourceCoverage
 * @property {Array<{link: MentorEvidenceLink, role: string}>} graphCoverage
 */

const SECTION_FALLBACKS = Object.freeze({
  quickTake: "The mentor returned a structured draft without a quick take.",
  paperFit: "No content was provided for this section.",
  prerequisites: "No content was provided for this section.",
  howItWorks: "No content was provided for this section.",
  paperEvidence: "No content was provided for this section.",
  relatedIdeas: "No content was provided for this section.",
  limitations: "No content was provided for this section.",
});

/** @type {ReadonlyArray<Readonly<MentorSectionDefinition>>} */
export const MENTOR_SECTION_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "quickTake", label: "Quick take", initiallyOpen: true }),
  Object.freeze({ key: "paperFit", label: "Where this fits in the paper", initiallyOpen: false }),
  Object.freeze({ key: "prerequisites", label: "What you need first", initiallyOpen: false }),
  Object.freeze({ key: "howItWorks", label: "How it works", initiallyOpen: false }),
  Object.freeze({ key: "paperEvidence", label: "Evidence in the paper", initiallyOpen: false }),
  Object.freeze({ key: "relatedIdeas", label: "Related ideas in the map", initiallyOpen: false }),
  Object.freeze({ key: "limitations", label: "Limits and uncertainty", initiallyOpen: false }),
]);

export const MENTOR_AUTHORITY_LABELS = Object.freeze({
  document_evidence: "Paper evidence",
  rendered_document_view: "Rendered-page observation",
  mentor_interpretation: "Mentor interpretation",
  mentor_background: "Mentor background",
  external_source: "External source · unverified",
  uncertain: "Uncertain",
  legacy_unclassified: "Legacy · unclassified",
});

export const MENTOR_SECTION_LABELS = Object.freeze(Object.fromEntries(
  MENTOR_SECTION_DEFINITIONS.map(({ key, label }) => [key, label]),
));

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {any} value @returns {any} */
function jsonClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** @param {unknown} value @returns {value is string} */
function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** @param {unknown} value @returns {value is string} */
function validDigest(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function displayText(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/** @param {unknown} value @param {number} maximum @returns {string[]} */
function uniqueIds(value, maximum) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const candidate of value) {
    if (!validId(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
    if (result.length === maximum) break;
  }
  return result;
}

/** @param {unknown} value @returns {Set<string> | null} */
function currentIdSet(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof /** @type {any} */ (value)?.[Symbol.iterator] !== "function") return new Set();
  return new Set([.../** @type {Iterable<unknown>} */ (value)].filter(validId));
}

/** @param {unknown} value @returns {unknown[]} */
function cloneList(value) {
  return Array.isArray(value) ? value.map((entry) => jsonClone(entry)) : [];
}

/** @param {unknown} value @returns {string | null} */
function explanationId(value) {
  if (!isRecord(value)) return null;
  const candidate = /** @type {Record<string, unknown>} */ (value).explanationId;
  return validId(candidate) ? candidate : null;
}

/**
 * Normalize one staged or saved explanation for presentation.
 *
 * Invalid identity/digest records fail closed with `null`. Missing section
 * content receives explicit UI fallback copy; it is never confused with a
 * claim from the paper.
 *
 * @param {unknown} value
 * @param {{savedExplanationIds?: Iterable<string>}=} options
 * @returns {NormalizedMentorExplanation | null}
 */
export function normalizeMentorExplanation(value, options = {}) {
  if (!isRecord(value)) return null;
  const record = /** @type {Record<string, any>} */ (value);
  if (!validId(record.explanationId) || !validDigest(record.responseDigest)) return null;
  const savedIds = currentIdSet(options.savedExplanationIds);
  const hasSavedAt = typeof record.savedAt === "string" && record.savedAt.length > 0;
  const saved = record.humanDecision === "saved" || hasSavedAt || Boolean(savedIds?.has(record.explanationId));
  /** @type {Record<MentorSectionKey, string>} */
  const sections = /** @type {Record<MentorSectionKey, string>} */ ({});
  const normalized = normalizeMentorRecord(record);
  if (!normalized) return null;
  const claimSections = /** @type {Record<MentorSectionKey, MentorClaim[]>} */ ({});
  for (const { key } of MENTOR_SECTION_DEFINITIONS) {
    const claims = /** @type {MentorClaim[]} */ (normalized.sections[key]);
    claimSections[key] = claims.length ? claims.map((claim) => ({ ...claim,
      text: displayText(claim.text, SECTION_FALLBACKS[key]),
      anchorIds: [...claim.anchorIds], graphEntityKeys: [...claim.graphEntityKeys], citationIds: [...claim.citationIds],
    })) : [{ text: SECTION_FALLBACKS[key], authority: "uncertain", anchorIds: [], graphEntityKeys: [], citationIds: [] }];
    sections[key] = claimSections[key].map(({ text }) => text).join("\n\n");
  }
  return {
    explanationId: record.explanationId,
    responseDigest: record.responseDigest,
    sections,
    claimSections,
    provenanceMode: normalized.provenanceMode,
    expectedGraphDigest: validDigest(record.expectedGraphDigest) ? record.expectedGraphDigest : null,
    sourceCoverage: normalized.sourceCoverage,
    graphCoverage: normalized.graphCoverage,
    externalCitations: normalized.externalCitations,
    visualObservation: typeof record.visualObservation === "string" ? record.visualObservation : "",
    visualEvidenceMode: typeof record.visualEvidenceMode === "string" ? record.visualEvidenceMode : "not_applicable",
    sourceAnchorIds: uniqueIds(record.sourceAnchorIds, 12),
    graphEntityKeys: uniqueIds(record.graphEntityKeys, 20),
    focusAnchorId: validId(record.focusAnchorId) ? record.focusAnchorId : null,
    takeaway: typeof record.takeaway === "string" ? record.takeaway : "",
    savedAt: hasSavedAt ? record.savedAt : null,
    saved,
  };
}

/**
 * Pick the visible explanation using the current UI rule: the newest staged
 * draft takes precedence over the newest saved note.
 *
 * @param {unknown[]} stagedExplanations
 * @param {unknown[]} savedExplanations
 * @returns {unknown | null}
 */
export function selectLatestMentorExplanation(stagedExplanations, savedExplanations) {
  const staged = Array.isArray(stagedExplanations) ? stagedExplanations.at(-1) : null;
  const saved = Array.isArray(savedExplanations) ? savedExplanations.at(-1) : null;
  return staged || saved || null;
}

/**
 * Create a DOM-independent representation of the mentor review card.
 *
 * Preserve every declared reference for audit, but only enable references that
 * resolve in the current workspace. Authority comes from individual blocks,
 * never from the section heading. Legacy context links are not claim citations.
 *
 * @param {object} input
 * @param {unknown[]=} input.stagedExplanations
 * @param {unknown[]=} input.savedExplanations
 * @param {Iterable<string>=} input.currentAnchorIds
 * @param {Iterable<string>=} input.currentGraphNodeKeys
 * @param {Iterable<string>=} input.currentGraphEdgeKeys
 * @param {Map<string, any>=} input.currentAnchors
 * @param {Map<string, any>=} input.currentGraphNodes
 * @param {Map<string, any>=} input.currentGraphEdges
 * @param {string=} input.currentPaperRef
 * @param {string=} input.currentDocumentSha256
 * @param {string=} input.currentGraphDigest
 * @returns {MentorReviewViewModel}
 */
export function createMentorReviewViewModel({
  stagedExplanations = [],
  savedExplanations = [],
  currentAnchorIds,
  currentGraphNodeKeys,
  currentGraphEdgeKeys,
  currentAnchors,
  currentGraphNodes,
  currentGraphEdges,
  currentPaperRef,
  currentDocumentSha256,
  currentGraphDigest,
} = {}) {
  const selected = selectLatestMentorExplanation(stagedExplanations, savedExplanations);
  const savedIds = cloneList(savedExplanations).map(explanationId).filter(validId);
  const explanation = normalizeMentorExplanation(selected, { savedExplanationIds: savedIds });
  if (!explanation) {
    return {
      state: "empty",
      stateLabel: "Waiting",
      statusMessage: "Nothing has been staged yet.",
      showHumanDecisionActions: false,
      explanation: null,
      quickTake: "Select a difficult passage, then ask the browser agent to explain it. PaperPilot will keep the paper’s claims separate from mentor background knowledge.",
      sections: [],
      sourceAnchorIds: [],
      graphEntityKeys: [],
      citedSourceCount: 0,
      takeaway: "",
      quickTakeClaims: [], sourceLinks: [], graphLinks: [], notices: [], visualDescription: null,
      sourceCoverage: [], graphCoverage: [],
    };
  }
  const anchorKeys = currentIdSet(currentAnchors?.keys() || currentAnchorIds);
  const nodeKeys = currentIdSet(currentGraphNodes?.keys() || currentGraphNodeKeys);
  const edgeKeys = currentIdSet(currentGraphEdges?.keys() || currentGraphEdgeKeys);
  /** @param {string} key @returns {MentorEvidenceLink} */
  const sourceLink = (key) => {
    const anchor = currentAnchors?.get(key);
    const available = anchorKeys?.has(key) === true
      && (!currentPaperRef || !anchor?.paperRef || anchor.paperRef === currentPaperRef)
      && (!currentDocumentSha256 || !anchor?.documentSha256 || anchor.documentSha256 === currentDocumentSha256);
    const kind = anchor?.sourceKind === "exact_text" ? "Exact text" : "Paper region";
    return { key, kind: "source", available,
      label: available ? `${anchor?.pageLabel ? `p. ${anchor.pageLabel} · ` : ""}${kind}` : "Source incomplete",
      detail: available ? `Open ${kind.toLowerCase()}${anchor?.pageLabel ? ` on page ${anchor.pageLabel}` : ""}` : "The cited source is not available in this paper.",
    };
  };
  /** @param {string} key @returns {MentorEvidenceLink} */
  const graphLink = (key) => {
    const isNode = nodeKeys?.has(key) === true;
    const isEdge = edgeKeys?.has(key) === true;
    const record = isNode ? currentGraphNodes?.get(key) : currentGraphEdges?.get(key);
    const available = (isNode || isEdge) && (!record?.status || record.status === "active")
      && (!currentPaperRef || !record?.paperRef || record.paperRef === currentPaperRef);
    const label = record?.label || record?.claim || key;
    return { key, kind: isNode ? "node" : isEdge ? "edge" : "graph", available,
      label: available ? `${isEdge ? "Relationship" : "Map"} · ${label}` : `Source incomplete · ${label}`,
      detail: available ? "Open graph context and its paper source. A graph item is not proof of a claim."
        : record?.status === "tombstoned" ? "This graph item was removed; the citation is retained for audit." : "This graph reference is not available in the current paper.",
    };
  };
  /** @param {string} citationId @returns {MentorCitationLink} */
  const citationLink = (citationId) => {
    const citation = explanation.externalCitations.find((item) => item.citationId === citationId);
    const href = citation ? safeExternalCitationUrl(citation.url) : null;
    return { citationId, title: citation?.title || citationId, href,
      label: href ? "External source · Not verified by PaperPilot" : "External source unavailable · Not verified by PaperPilot" };
  };
  /** @param {MentorSectionKey} sectionKey @returns {MentorClaimView[]} */
  const claimViews = (sectionKey) => explanation.claimSections[sectionKey].map((claim, index) => {
    const sourceLinks = claim.anchorIds.map(sourceLink);
    const graphLinks = claim.graphEntityKeys.map(graphLink);
    const warnings = [];
    if (sourceLinks.some((link) => !link.available)) warnings.push("Source incomplete. This claim’s missing source remains listed below.");
    if (graphLinks.some((link) => !link.available)) warnings.push("Graph context incomplete. A cited item is missing or has been removed.");
    if (claim.authority === "rendered_document_view") warnings.push("Locator-only context. This is a reported observation, not verified pixel use.");
    if (claim.authority === "mentor_background") warnings.push("Teaching context, not a statement attributed to this paper.");
    return { ...claim, key: `${sectionKey}:${index}`, authorityLabel: MENTOR_AUTHORITY_LABELS[claim.authority],
      sourceLinks, graphLinks, citations: claim.citationIds.map(citationLink), warnings };
  });
  const sourceLinks = explanation.sourceAnchorIds.map(sourceLink);
  const graphLinks = explanation.graphEntityKeys.map(graphLink);
  const sourceAnchorIds = sourceLinks.filter(({ available }) => available).map(({ key }) => key);
  const graphEntityKeys = graphLinks.filter(({ available }) => available).map(({ key }) => key);
  const sections = MENTOR_SECTION_DEFINITIONS
    .filter(({ key }) => key !== "quickTake")
    .map((definition) => ({ ...definition, content: explanation.sections[definition.key], claims: claimViews(definition.key) }));
  const citedSourceCount = explanation.sourceAnchorIds.length;
  const citationNoun = citedSourceCount === 1 ? "source" : "sources";
  const statusMessage = explanation.saved
    ? `Saved by the reader · ${explanation.savedAt || "this session"} · AI-generated, not scientifically verified.`
    : `Explanation ready. Nothing was saved. AI-generated · ${citedSourceCount} cited ${citationNoun} · not scientifically verified.`;
  const notices = [];
  if (explanation.provenanceMode === "legacy_unclassified") notices.push("Legacy note: claims were not individually classified. Section names do not establish evidence; the links below are note-wide context only.");
  if (currentGraphDigest && explanation.expectedGraphDigest && currentGraphDigest !== explanation.expectedGraphDigest) notices.push("The map has changed since this explanation. Its original claims are unchanged; check the current linked context.");
  if (sourceLinks.some(({ available }) => !available)) notices.push("Source incomplete: one or more original paper sources cannot currently be opened.");
  return {
    state: explanation.saved ? "saved" : "draft",
    stateLabel: explanation.saved ? "Saved" : "Draft",
    statusMessage,
    showHumanDecisionActions: !explanation.saved,
    explanation,
    quickTake: explanation.sections.quickTake,
    sections,
    sourceAnchorIds,
    graphEntityKeys,
    citedSourceCount,
    takeaway: explanation.saved ? explanation.takeaway : "",
    quickTakeClaims: claimViews("quickTake"), sourceLinks, graphLinks, notices,
    sourceCoverage: explanation.sourceCoverage.map((item) => ({ link: sourceLink(item.anchorId), status: item.status, explanation: item.explanation })),
    graphCoverage: explanation.graphCoverage.map((item) => ({ link: graphLink(item.entityKey), role: item.role })),
    visualDescription: explanation.visualObservation ? { text: explanation.visualObservation,
      label: "Visual description · Mentor interpretation",
      limitation: "Uses the selected region and any reader-supplied or caption context. Locator only: PaperPilot has not verified pixel use. Separate visible observations from inferred meaning.",
      sourceLinks: explanation.focusAnchorId ? [sourceLink(explanation.focusAnchorId)] : [],
    } : null,
  };
}

/**
 * @param {"rejected" | "no_staged_explanation"} status
 * @param {unknown[]} stagedExplanations
 * @param {unknown[]} savedExplanations
 * @param {{code?: string}} [extra]
 * @returns {MentorDecisionResult}
 */
function unchangedDecisionResult(status, stagedExplanations, savedExplanations, extra = {}) {
  return {
    status,
    changed: false,
    stagedExplanations: cloneList(stagedExplanations),
    savedExplanations: cloneList(savedExplanations),
    event: null,
    ...extra,
  };
}

/**
 * Apply a human-only Save or Discard decision to the newest staged draft.
 *
 * This is intentionally not a WebMCP reducer and accepts no graph, annotation,
 * or PDF state. Agent/system actors fail closed. The caller owns persistence
 * and evidence-event append after accepting the returned immutable values.
 *
 * @param {object} input
 * @param {"human" | string=} input.actor
 * @param {MentorDecision=} input.decision
 * @param {unknown[]=} input.stagedExplanations
 * @param {unknown[]=} input.savedExplanations
 * @param {string=} input.takeaway
 * @param {string=} input.savedAt
 * @returns {MentorDecisionResult}
 */
export function applyHumanMentorDecision({
  actor,
  decision,
  stagedExplanations = [],
  savedExplanations = [],
  takeaway = "",
  savedAt,
} = {}) {
  if (actor !== "human") {
    return unchangedDecisionResult("rejected", stagedExplanations, savedExplanations, { code: "human_decision_required" });
  }
  if (decision !== "save" && decision !== "discard") {
    return unchangedDecisionResult("rejected", stagedExplanations, savedExplanations, { code: "decision_invalid" });
  }
  const staged = cloneList(stagedExplanations);
  const saved = cloneList(savedExplanations);
  const explanation = staged.at(-1);
  const normalized = normalizeMentorExplanation(explanation);
  if (!normalized) return unchangedDecisionResult("no_staged_explanation", staged, saved);
  const remainingStaged = staged.filter((item) => explanationId(item) !== normalized.explanationId);
  const eventBase = {
    actor: /** @type {"human"} */ ("human"),
    explanationId: normalized.explanationId,
    responseDigest: normalized.responseDigest,
  };

  if (decision === "discard") {
    return {
      status: "discarded",
      changed: true,
      stagedExplanations: remainingStaged,
      savedExplanations: saved,
      explanation: jsonClone(explanation),
      event: { eventType: "explanation_discarded", ...eventBase },
    };
  }

  if (typeof savedAt !== "string" || savedAt.length === 0 || savedAt.length > 64) {
    return unchangedDecisionResult("rejected", staged, saved, { code: "saved_at_required" });
  }
  if (typeof takeaway !== "string") {
    return unchangedDecisionResult("rejected", staged, saved, { code: "takeaway_invalid" });
  }
  const trimmedTakeaway = takeaway.trim();
  if (trimmedTakeaway.length > MAX_TAKEAWAY_LENGTH) {
    return unchangedDecisionResult("rejected", staged, saved, { code: "takeaway_too_long" });
  }
  const savedExplanation = {
    ...jsonClone(explanation),
    savedAt,
    humanDecision: "saved",
    ...(trimmedTakeaway ? { takeaway: trimmedTakeaway } : {}),
  };
  if (saved.length >= MAX_SAVED_EXPLANATIONS && !saved.some((item) => explanationId(item) === normalized.explanationId)) {
    return unchangedDecisionResult("rejected", staged, saved, { code: "saved_note_limit" });
  }
  const nextSaved = [
    ...saved.filter((item) => explanationId(item) !== normalized.explanationId),
    savedExplanation,
  ];
  return {
    status: "saved",
    changed: true,
    stagedExplanations: remainingStaged,
    savedExplanations: nextSaved,
    explanation: jsonClone(savedExplanation),
    event: { eventType: "explanation_saved", ...eventBase },
  };
}
