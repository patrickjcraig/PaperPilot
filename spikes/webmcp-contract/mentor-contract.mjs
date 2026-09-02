// @ts-check
/** Pure claim-level mentor contracts. No storage, DOM, network, or graph mutation. */

export const MENTOR_SECTION_KEYS = Object.freeze([
  "quickTake", "paperFit", "prerequisites", "howItWorks", "paperEvidence", "relatedIdeas", "limitations",
]);
export const MENTOR_AUTHORITIES = Object.freeze([
  "document_evidence", "rendered_document_view", "mentor_interpretation", "mentor_background", "external_source", "uncertain",
]);
export const MENTOR_LIMITS = Object.freeze({ claimsPerSection: 5, totalClaims: 28, claimText: 800, sources: 12, graphEntities: 20, citations: 8, inputBytes: 32 * 1024 });
const SECTION_LIMITS = Object.freeze({ quickTake: 1200, paperFit: 1500, prerequisites: 1500, howItWorks: 2000, paperEvidence: 1500, relatedIdeas: 1500, limitations: 1500 });
const ID_PATTERN = "^[a-z][a-z0-9:_-]{2,127}$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
/** @typedef {Record<string, any>} JsonRecord */
/** @typedef {{resolveAnchor?:(id:string)=>JsonRecord|undefined|null, resolveGraphEntity?:(key:string)=>JsonRecord|undefined|null, readGraphEntityKeys?:Iterable<string>, visualEvidenceMode?:string, paperRef?:string, documentSha256?:string, allowMissingReferences?:boolean}} MentorValidationContext */
/** @param {number} maxLength @param {JsonRecord} [extra] */
const textSchema = (maxLength, extra = {}) => ({ type: "string", minLength: 1, maxLength, ...extra });
const idSchema = () => textSchema(128, { pattern: ID_PATTERN });
/** @param {JsonRecord} properties @param {string[]} [required] */
const objectSchema = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
/** @param {number} maxItems @param {number} [minItems] */
const idsSchema = (maxItems, minItems = 0) => ({ type: "array", minItems, maxItems, uniqueItems: true, items: idSchema() });
const commonProperties = {
  focusAnchorId: idSchema(), expectedWorkspaceRevision: { type: "integer", minimum: 1 },
  expectedGraphDigest: { type: "string", pattern: SHA256_PATTERN },
  sourceAnchorIds: idsSchema(MENTOR_LIMITS.sources, 1), graphEntityKeys: idsSchema(MENTOR_LIMITS.graphEntities),
  visualEvidenceMode: { type: "string", enum: ["not_applicable", "client_visible_region", "locator_only"] },
  visualObservation: textSchema(1000),
};
const commonRequired = Object.keys(commonProperties).filter((key) => key !== "visualObservation");
const claimSchema = objectSchema({
  text: textSchema(MENTOR_LIMITS.claimText), authority: { type: "string", enum: MENTOR_AUTHORITIES },
  anchorIds: idsSchema(MENTOR_LIMITS.sources), graphEntityKeys: idsSchema(MENTOR_LIMITS.graphEntities), citationIds: idsSchema(MENTOR_LIMITS.citations),
});
/** @template T @param {T} value @returns {Readonly<T>} */
function freezeDeep(value) {
  if (value && typeof value === "object") for (const item of Object.values(value)) freezeDeep(item);
  return Object.freeze(value);
}
export const STAGE_EXPLAIN_V1_SCHEMA = freezeDeep(objectSchema({
  ...commonProperties, explanationVersion: { const: 1 },
  sections: objectSchema(Object.fromEntries(MENTOR_SECTION_KEYS.map((key) => [key, textSchema(SECTION_LIMITS[/** @type {keyof typeof SECTION_LIMITS} */ (key)])]))),
}, [...commonRequired, "sections"]));
export const STAGE_EXPLAIN_V2_SCHEMA = freezeDeep(objectSchema({
  ...commonProperties, explanationVersion: { const: 2 },
  sections: objectSchema(Object.fromEntries(MENTOR_SECTION_KEYS.map((key) => [key, { type: "array", minItems: 1, maxItems: MENTOR_LIMITS.claimsPerSection, items: claimSchema }]))),
  sourceCoverage: { type: "array", minItems: 1, maxItems: MENTOR_LIMITS.sources, items: objectSchema({ anchorId: idSchema(), status: { type: "string", enum: ["used", "insufficient"] }, explanation: textSchema(500) }) },
  graphCoverage: { type: "array", maxItems: MENTOR_LIMITS.graphEntities, items: objectSchema({ entityKey: idSchema(), role: { type: "string", enum: ["explained", "related", "questioned"] } }) },
  externalCitations: { type: "array", maxItems: MENTOR_LIMITS.citations, items: objectSchema({
    citationId: idSchema(), url: textSchema(2048), title: textSchema(240),
    authors: { type: "array", minItems: 1, maxItems: 8, items: textSchema(120) }, year: { type: "integer", minimum: 1000, maximum: 2100 },
    declaredBy: { const: "agent" }, verification: { const: "not_verified_by_paperpilot" },
  }, ["citationId", "url", "title", "declaredBy", "verification"]) },
}, [...commonRequired, "explanationVersion", "sections", "sourceCoverage", "graphCoverage", "externalCitations"]));

export class MentorContractError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "MentorContractError"; this.code = code; }
}
/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) { throw new MentorContractError(code, message); }
/** @param {unknown} value @returns {JsonRecord} */
function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("explanation_invalid", "The mentor payload must contain plain objects.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("explanation_invalid", "The mentor payload must contain plain objects.");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || ["__proto__", "constructor", "prototype"].includes(key)) {
      fail("explanation_invalid", "Executable properties are not mentor content.");
    }
  }
  return /** @type {JsonRecord} */ (value);
}
/** @param {unknown} value @param {JsonRecord} schema */
function validateShape(value, schema) {
  if (Object.hasOwn(schema, "const") && value !== schema.const) fail("explanation_invalid", "The mentor payload has an unsupported constant.");
  if (schema.enum && !schema.enum.includes(value)) fail("explanation_invalid", "The mentor payload has an unsupported value.");
  if (schema.type === "object") {
    const record = plainRecord(value);
    if (Object.keys(record).some((key) => !Object.hasOwn(schema.properties, key)) || schema.required.some((/** @type {string} */ key) => !Object.hasOwn(record, key))) fail("explanation_invalid", "The mentor payload has unknown or missing fields.");
    for (const key of Object.keys(record)) validateShape(record[key], schema.properties[key]);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < (schema.minItems || 0) || value.length > schema.maxItems || Reflect.ownKeys(value).length !== value.length + 1) fail("explanation_invalid", "A mentor list is invalid or exceeds its limit.");
    for (let i = 0; i < value.length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail("explanation_invalid", "A mentor list must contain plain values.");
      validateShape(descriptor.value, schema.items);
    }
    if (schema.uniqueItems && new Set(value).size !== value.length) fail("explanation_invalid", "A mentor reference is duplicated.");
  } else if (schema.type === "string") {
    if (typeof value !== "string" || [...value].length < (schema.minLength || 0) || [...value].length > (schema.maxLength || 4096) || (schema.pattern && !new RegExp(schema.pattern, "u").test(value))) fail("explanation_invalid", "A mentor string is invalid or exceeds its limit.");
    // Mathematical comparisons such as x < y are ordinary text; HTML tags are not.
    if (/<\/?[a-z][^>]*>/iu.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail("explanation_invalid", "Mentor content must be plain text, not HTML or control characters.");
  } else if (schema.type === "integer" && (!Number.isSafeInteger(value) || Number(value) < schema.minimum || Number(value) > (schema.maximum || Number.MAX_SAFE_INTEGER))) {
    fail("explanation_invalid", "A mentor number is outside its supported range.");
  }
}

/** Public HTTPS citation links only. Does not fetch, resolve DNS, or verify a source. @param {unknown} value @returns {string|null} */
export function safeExternalCitationUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\//iu.test(value) || /[\s\\<>"'`\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !host.includes(".") || host.endsWith(".") || host.includes(":") || /^[\d.]+$/u.test(host)
      || /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion|home|lan)$/u.test(host)) return null;
    return url.href;
  } catch { return null; }
}

/**
 * Validate the exact model payload. Context performs source/graph binding only;
 * freshness belongs to the live callback. Audit mode tolerates missing/tombstoned
 * references, never an existing foreign or incompatible source.
 * @param {unknown} value @param {MentorValidationContext} [context]
 * @returns {JsonRecord}
 */
export function validateMentorPayload(value, context = {}) {
  const input = plainRecord(value);
  const v2 = input.explanationVersion === 2;
  validateShape(input, v2 ? STAGE_EXPLAIN_V2_SCHEMA : STAGE_EXPLAIN_V1_SCHEMA);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MENTOR_LIMITS.inputBytes) fail("input_too_large", "Tool input exceeds 32 KiB canonical UTF-8 JSON.");
  if (!input.sourceAnchorIds.includes(input.focusAnchorId)) fail("source_coverage_missing", "The active focus must be declared as a source.");
  /** @type {Map<string, JsonRecord|undefined|null>} */
  const anchors = new Map();
  for (const id of input.sourceAnchorIds) {
    const anchor = context.resolveAnchor?.(id);
    if (context.resolveAnchor && !anchor && !context.allowMissingReferences) fail("not_found_in_active_paper", "A source is unavailable in the active paper.");
    if (anchor && ((context.paperRef && anchor.paperRef !== context.paperRef) || (context.documentSha256 && anchor.documentSha256 && anchor.documentSha256 !== context.documentSha256))) fail("not_found_in_active_paper", "A source is unavailable in the active paper.");
    anchors.set(id, anchor);
  }
  const readable = context.readGraphEntityKeys ? new Set(context.readGraphEntityKeys) : null;
  for (const key of input.graphEntityKeys) {
    const entity = context.resolveGraphEntity?.(key);
    if (context.resolveGraphEntity && (!entity || entity.status === "tombstoned") && !context.allowMissingReferences) fail("not_found_in_active_paper", "A graph reference is not active in this paper.");
    if (entity?.paperRef && context.paperRef && entity.paperRef !== context.paperRef) fail("not_found_in_active_paper", "A graph reference is unavailable in the active paper.");
    if (v2 && readable && !readable.has(key)) fail("graph_read_required", "Read the referenced graph items in the current bounded graph context before explaining them.");
  }
  const focus = anchors.get(input.focusAnchorId);
  if (focus) {
    const visual = v2 ? focus.authority === "client_rendered_pdf" && !focus.quote?.exact && !focus.exactText : focus.sourceKind === "visual_region";
    if (visual) {
      if (!input.visualObservation) fail("visual_observation_required", "A visual-source explanation must include its accessible interpretation and limits.");
      if (input.visualEvidenceMode === "not_applicable" || (context.visualEvidenceMode && input.visualEvidenceMode !== context.visualEvidenceMode)) fail("visual_evidence_mode_mismatch", "The visual evidence mode does not match the available source view.");
    } else if (input.visualEvidenceMode !== "not_applicable") fail("visual_evidence_mode_mismatch", "Exact-text focus must use not_applicable visual evidence mode.");
  }
  if (!v2) return input;
  /** @type {JsonRecord[]} */
  const claims = MENTOR_SECTION_KEYS.flatMap((key) => input.sections[key]);
  if (claims.length > MENTOR_LIMITS.totalClaims) fail("explanation_invalid", "The explanation exceeds the total claim limit.");
  for (const key of MENTOR_SECTION_KEYS) {
    if (input.sections[key].reduce((/** @type {number} */ sum, /** @type {JsonRecord} */ claim) => sum + [...claim.text].length, 0) > SECTION_LIMITS[/** @type {keyof typeof SECTION_LIMITS} */ (key)]) fail("explanation_invalid", "A mentor section exceeds its combined text limit.");
  }
  const declaredSources = new Set(input.sourceAnchorIds);
  const declaredGraph = new Set(input.graphEntityKeys);
  const citationIds = new Set(input.externalCitations.map((/** @type {JsonRecord} */ citation) => citation.citationId));
  if (citationIds.size !== input.externalCitations.length) fail("citation_invalid", "Citation IDs must be unique.");
  for (const citation of input.externalCitations) if (!safeExternalCitationUrl(citation.url)) fail("citation_invalid", "External citations require a public HTTPS link without credentials or private hosts.");
  /** @type {Set<string>} */ const usedSources = new Set();
  /** @type {Set<string>} */ const evidenceSources = new Set();
  /** @type {Set<string>} */ const usedGraph = new Set();
  /** @type {Set<string>} */ const usedCitations = new Set();
  for (const claim of claims) {
    for (const id of claim.anchorIds) { if (!declaredSources.has(id)) fail("source_coverage_missing", "Every claim source must be declared in this explanation."); usedSources.add(id); }
    for (const key of claim.graphEntityKeys) { if (!declaredGraph.has(key)) fail("graph_coverage_missing", "Every claim graph reference must be declared in this explanation."); usedGraph.add(key); }
    for (const id of claim.citationIds) { if (!citationIds.has(id)) fail("citation_invalid", "Every claim citation must be declared in this explanation."); usedCitations.add(id); }
    if (["document_evidence", "rendered_document_view"].includes(claim.authority)) {
      if (!claim.anchorIds.length) fail("claim_authority_invalid", "Paper evidence requires a compatible issued source anchor.");
      for (const id of claim.anchorIds) {
        evidenceSources.add(id);
        const anchor = anchors.get(id);
        if (anchor && (claim.authority === "document_evidence"
          ? anchor.authority !== "exact_document_text" || !["exact_text", "equation"].includes(anchor.sourceKind) || !(anchor.quote?.exact || anchor.exactText)
          : anchor.authority !== "client_rendered_pdf" || !!(anchor.quote?.exact || anchor.exactText))) fail("claim_authority_invalid", "A claim's authority does not match its source anchor.");
      }
      if (claim.authority === "rendered_document_view" && (input.visualEvidenceMode !== "client_visible_region" || context.visualEvidenceMode !== "client_visible_region")) fail("visual_evidence_mode_mismatch", "Locator-only regions do not establish observed pixels; use mentor interpretation and explicit limits.");
    }
    if (["mentor_background", "external_source"].includes(claim.authority) && claim.anchorIds.length) fail("claim_authority_invalid", "Background and external-source claims cannot inherit paper-anchor authority.");
    if ((claim.authority === "external_source") !== (claim.citationIds.length > 0)) fail("citation_invalid", "Only external-source claims use declared external citations, and they require at least one.");
  }
  const coverageIds = input.sourceCoverage.map((/** @type {JsonRecord} */ item) => item.anchorId);
  if (new Set(coverageIds).size !== coverageIds.length || coverageIds.length !== declaredSources.size || coverageIds.some((/** @type {string} */ id) => !declaredSources.has(id))) fail("source_coverage_missing", "Cover each declared source exactly once as used or insufficient.");
  for (const item of input.sourceCoverage) {
    if ((item.status === "used" && !usedSources.has(item.anchorId)) || (item.status === "insufficient" && evidenceSources.has(item.anchorId))) fail("source_coverage_mismatch", "Source coverage disagrees with the claim's evidence use.");
  }
  const coverageKeys = input.graphCoverage.map((/** @type {JsonRecord} */ item) => item.entityKey);
  if (new Set(coverageKeys).size !== coverageKeys.length || coverageKeys.length !== declaredGraph.size || coverageKeys.some((/** @type {string} */ key) => !declaredGraph.has(key) || !usedGraph.has(key))) fail("graph_coverage_missing", "Cover each declared graph reference exactly once and link it from a claim.");
  if (usedCitations.size !== citationIds.size) fail("citation_invalid", "Every declared citation must be used by an external-source claim.");
  return input;
}

/** Extract only exact wire fields; never normalize before checking the original response digest. @param {unknown} value @returns {JsonRecord} */
export function mentorPayloadFromRecord(value) {
  const record = plainRecord(value);
  const fields = Object.keys(record.explanationVersion === 2 ? STAGE_EXPLAIN_V2_SCHEMA.properties : STAGE_EXPLAIN_V1_SCHEMA.properties);
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(record, key)).map((key) => [key, structuredClone(record[key])]));
}

/** Presentation projection only. Legacy prose gains no invented claim authority or source links. @param {unknown} value @returns {JsonRecord} */
export function normalizeMentorRecord(value) {
  const record = plainRecord(value);
  const v2 = record.explanationVersion === 2;
  const sections = plainRecord(record.sections || {});
  return {
    ...structuredClone(record), explanationVersion: v2 ? 2 : 1, provenanceMode: v2 ? "claim_level" : "legacy_unclassified",
    sections: Object.fromEntries(MENTOR_SECTION_KEYS.map((key) => [key, v2
      ? (Array.isArray(sections[key]) ? structuredClone(sections[key]) : [])
      : (typeof sections[key] === "string" ? [{ text: sections[key], authority: "legacy_unclassified", anchorIds: [], graphEntityKeys: [], citationIds: [] }] : [])])),
    sourceCoverage: v2 ? structuredClone(record.sourceCoverage || []) : [],
    graphCoverage: v2 ? structuredClone(record.graphCoverage || []) : [],
    externalCitations: v2 ? structuredClone(record.externalCitations || []) : [],
  };
}
