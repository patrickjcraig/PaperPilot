/**
 * Pure mentor-review helpers for PaperPilot's public vertical slice.
 *
 * This module deliberately knows nothing about the DOM, storage, WebMCP
 * registration, Graphology, or PDF.js. It turns an already-staged mentor
 * explanation into a stable seven-section view model and keeps Save/Discard a
 * page-owned human decision. No helper mutates its inputs.
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z][a-z0-9:_-]{2,127}$/u;
const MAX_SAVED_EXPLANATIONS = 200;
const MAX_TAKEAWAY_LENGTH = 1_200;

/** @typedef {"quickTake" | "paperFit" | "prerequisites" | "howItWorks" | "paperEvidence" | "relatedIdeas" | "limitations"} MentorSectionKey */
/** @typedef {"paper_evidence" | "mentor_synthesis"} MentorAuthorityKind */
/** @typedef {"save" | "discard"} MentorDecision */
/** @typedef {"saved" | "discarded" | "rejected" | "no_staged_explanation"} MentorDecisionStatus */
/** @typedef {{eventType: "explanation_saved" | "explanation_discarded", actor: "human", explanationId: string, responseDigest: string}} MentorDecisionEvent */
/** @typedef {{status: MentorDecisionStatus, changed: boolean, stagedExplanations: unknown[], savedExplanations: unknown[], explanation?: unknown, event: MentorDecisionEvent | null, code?: string}} MentorDecisionResult */

/**
 * @typedef {object} MentorSectionDefinition
 * @property {MentorSectionKey} key
 * @property {string} label
 * @property {MentorAuthorityKind} authorityKind
 * @property {string} authorityLabel
 * @property {boolean} initiallyOpen
 */

/**
 * @typedef {object} NormalizedMentorExplanation
 * @property {string} explanationId
 * @property {string} responseDigest
 * @property {Record<MentorSectionKey, string>} sections
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
 * @property {Array<MentorSectionDefinition & {content: string}>} sections
 * @property {string[]} sourceAnchorIds
 * @property {string[]} graphEntityKeys
 * @property {number} citedSourceCount
 * @property {string} takeaway
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
  Object.freeze({ key: "quickTake", label: "Quick take", authorityKind: "mentor_synthesis", authorityLabel: "Mentor synthesis", initiallyOpen: true }),
  Object.freeze({ key: "paperFit", label: "Where this fits in the paper", authorityKind: "mentor_synthesis", authorityLabel: "Mentor synthesis", initiallyOpen: false }),
  Object.freeze({ key: "prerequisites", label: "What you need first", authorityKind: "mentor_synthesis", authorityLabel: "Mentor synthesis", initiallyOpen: false }),
  Object.freeze({ key: "howItWorks", label: "How it works", authorityKind: "mentor_synthesis", authorityLabel: "Mentor synthesis", initiallyOpen: false }),
  Object.freeze({ key: "paperEvidence", label: "Evidence in the paper", authorityKind: "paper_evidence", authorityLabel: "Paper evidence", initiallyOpen: true }),
  Object.freeze({ key: "relatedIdeas", label: "Related ideas in the map", authorityKind: "mentor_synthesis", authorityLabel: "Mentor synthesis", initiallyOpen: false }),
  Object.freeze({ key: "limitations", label: "Limits and uncertainty", authorityKind: "mentor_synthesis", authorityLabel: "Mentor synthesis", initiallyOpen: false }),
]);

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

/** @param {string[]} ids @param {unknown} currentIds @returns {string[]} */
function filterCurrentIds(ids, currentIds) {
  const current = currentIdSet(currentIds);
  return current === null ? [...ids] : ids.filter((id) => current.has(id));
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
  const suppliedSections = isRecord(record.sections) ? /** @type {Record<string, any>} */ (record.sections) : {};
  for (const { key } of MENTOR_SECTION_DEFINITIONS) {
    sections[key] = displayText(suppliedSections[key], SECTION_FALLBACKS[key]);
  }
  return {
    explanationId: record.explanationId,
    responseDigest: record.responseDigest,
    sections,
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
 * `currentAnchorIds` and `currentGraphNodeKeys` filter evidence controls so a
 * restored or stale explanation cannot navigate to a foreign/missing entity.
 * The cited count preserves the staged explanation's declared source count;
 * the navigable ID arrays contain only current-workspace evidence.
 *
 * @param {object} input
 * @param {unknown[]=} input.stagedExplanations
 * @param {unknown[]=} input.savedExplanations
 * @param {Iterable<string>=} input.currentAnchorIds
 * @param {Iterable<string>=} input.currentGraphNodeKeys
 * @returns {MentorReviewViewModel}
 */
export function createMentorReviewViewModel({
  stagedExplanations = [],
  savedExplanations = [],
  currentAnchorIds,
  currentGraphNodeKeys,
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
    };
  }
  const sourceAnchorIds = filterCurrentIds(explanation.sourceAnchorIds, currentAnchorIds);
  const graphEntityKeys = filterCurrentIds(explanation.graphEntityKeys, currentGraphNodeKeys);
  const sections = MENTOR_SECTION_DEFINITIONS
    .filter(({ key }) => key !== "quickTake")
    .map((definition) => ({ ...definition, content: explanation.sections[definition.key] }));
  const citedSourceCount = explanation.sourceAnchorIds.length;
  const citationNoun = citedSourceCount === 1 ? "source" : "sources";
  const statusMessage = explanation.saved
    ? `Saved by the reader · ${explanation.savedAt || "this session"} · AI-generated, not scientifically verified.`
    : `Mentor draft · AI-generated · ${citedSourceCount} cited ${citationNoun} · not saved or verified.`;
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
  const nextSaved = [
    ...saved.filter((item) => explanationId(item) !== normalized.explanationId),
    savedExplanation,
  ].slice(-MAX_SAVED_EXPLANATIONS);
  return {
    status: "saved",
    changed: true,
    stagedExplanations: remainingStaged,
    savedExplanations: nextSaved,
    explanation: jsonClone(savedExplanation),
    event: { eventType: "explanation_saved", ...eventBase },
  };
}
