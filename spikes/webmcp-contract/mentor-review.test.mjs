import assert from "node:assert/strict";
import test from "node:test";

import {
  MENTOR_SECTION_DEFINITIONS,
  MENTOR_SECTION_LABELS,
  applyHumanMentorDecision,
  createMentorReviewViewModel,
  normalizeMentorExplanation,
  selectLatestMentorExplanation,
} from "./mentor-review.mjs";

const SECTION_TEXT = Object.freeze({
  quickTake: "Attention lets the model compare relevant tokens directly.",
  paperFit: "This is the paper's central replacement for recurrence.",
  prerequisites: "A reader needs vectors, weighted sums, and probability basics.",
  howItWorks: "Queries score keys, and normalized scores combine value vectors.",
  paperEvidence: "The selected abstract passage says the architecture relies on attention.",
  relatedIdeas: "The map connects attention to the paper and its architecture.",
  limitations: "This draft teaches the cited passage; it does not verify the paper.",
});
function explanation(overrides = {}) {
  return {
    explanationId: "explanation:00000001",
    responseDigest: "a".repeat(64),
    focusAnchorId: "anchor:text:attention",
    expectedWorkspaceRevision: 3,
    expectedGraphDigest: "b".repeat(64),
    sections: { ...SECTION_TEXT },
    sourceAnchorIds: ["anchor:text:attention", "anchor:page:1"],
    graphEntityKeys: ["node:concept:attention", "node:paper"],
    visualEvidenceMode: "not_applicable",
    ...overrides,
  };
}

test("freezes seven progressive mentor sections without assigning authority from a heading", () => {
  assert.deepEqual(MENTOR_SECTION_DEFINITIONS.map(({ key }) => key), [
    "quickTake",
    "paperFit",
    "prerequisites",
    "howItWorks",
    "paperEvidence",
    "relatedIdeas",
    "limitations",
  ]);
  assert.deepEqual(MENTOR_SECTION_LABELS, {
    quickTake: "Quick take",
    paperFit: "Where this fits in the paper",
    prerequisites: "What you need first",
    howItWorks: "How it works",
    paperEvidence: "Evidence in the paper",
    relatedIdeas: "Related ideas in the map",
    limitations: "Limits and uncertainty",
  });
  const paperEvidence = MENTOR_SECTION_DEFINITIONS.find(({ key }) => key === "paperEvidence");
  assert.deepEqual(paperEvidence, {
    key: "paperEvidence",
    label: "Evidence in the paper",
    initiallyOpen: false,
  });
  assert.equal(
    MENTOR_SECTION_DEFINITIONS
      .every((section) => !Object.hasOwn(section, "authorityKind") && !Object.hasOwn(section, "authorityLabel")),
    true,
  );
  assert.equal(Object.isFrozen(MENTOR_SECTION_DEFINITIONS), true);
  assert.equal(MENTOR_SECTION_DEFINITIONS.every(Object.isFrozen), true);
});

test("normalizes a complete mentor explanation without changing its seven-section language", () => {
  const source = explanation();
  const before = structuredClone(source);
  const normalized = normalizeMentorExplanation(source);
  assert.deepEqual(normalized, {
    explanationId: source.explanationId,
    responseDigest: source.responseDigest,
    sections: SECTION_TEXT,
    sourceAnchorIds: ["anchor:text:attention", "anchor:page:1"],
    graphEntityKeys: ["node:concept:attention", "node:paper"],
    focusAnchorId: "anchor:text:attention",
    takeaway: "",
    savedAt: null,
    saved: false,
    claimSections: Object.fromEntries(Object.entries(SECTION_TEXT).map(([key, text]) => [key,
      [{ text, authority: "legacy_unclassified", anchorIds: [], graphEntityKeys: [], citationIds: [] }]])),
    provenanceMode: "legacy_unclassified", expectedGraphDigest: source.expectedGraphDigest,
    sourceCoverage: [], graphCoverage: [], externalCitations: [], visualObservation: "", visualEvidenceMode: "not_applicable",
  });
  assert.deepEqual(source, before, "normalization must not mutate the staged tool payload");
});

test("fails closed on invalid identity and supplies explicit non-evidentiary display fallbacks", () => {
  assert.equal(normalizeMentorExplanation(null), null);
  assert.equal(normalizeMentorExplanation(explanation({ explanationId: "bad id" })), null);
  assert.equal(normalizeMentorExplanation(explanation({ responseDigest: "short" })), null);

  const normalized = normalizeMentorExplanation(explanation({
    sections: { quickTake: "", paperEvidence: "   " },
    sourceAnchorIds: ["anchor:page:1", "anchor:page:1", "bad id"],
    graphEntityKeys: ["node:paper", "node:paper", "bad id"],
  }));
  assert.equal(normalized.sections.quickTake, "The mentor returned a structured draft without a quick take.");
  assert.equal(normalized.sections.paperEvidence, "No content was provided for this section.");
  assert.equal(normalized.sections.limitations, "No content was provided for this section.");
  assert.deepEqual(normalized.sourceAnchorIds, ["anchor:page:1"]);
  assert.deepEqual(normalized.graphEntityKeys, ["node:paper"]);
});

test("uses the newest staged draft before the newest saved note", () => {
  const saved = explanation({ explanationId: "explanation:saved", humanDecision: "saved" });
  const draft = explanation({ explanationId: "explanation:draft" });
  assert.equal(selectLatestMentorExplanation([draft], [saved]), draft);
  assert.equal(selectLatestMentorExplanation([], [saved]), saved);
  assert.equal(selectLatestMentorExplanation([], []), null);
});

test("builds the empty, draft, and saved review states without any DOM dependency", () => {
  const empty = createMentorReviewViewModel();
  assert.deepEqual(empty, {
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
  });

  const draft = createMentorReviewViewModel({
    stagedExplanations: [explanation()],
    savedExplanations: [],
    currentAnchorIds: ["anchor:text:attention"],
    currentGraphNodeKeys: ["node:paper"],
  });
  assert.equal(draft.state, "draft");
  assert.equal(draft.stateLabel, "Draft");
  assert.equal(draft.showHumanDecisionActions, true);
  assert.equal(draft.quickTake, SECTION_TEXT.quickTake);
  assert.equal(draft.citedSourceCount, 2);
  assert.equal(draft.statusMessage, "Explanation ready. Nothing was saved. AI-generated · 2 cited sources · not scientifically verified.");
  assert.deepEqual(draft.sourceAnchorIds, ["anchor:text:attention"]);
  assert.deepEqual(draft.graphEntityKeys, ["node:paper"]);
  assert.equal(draft.sections.length, 6);
  assert.equal(draft.sections.find(({ key }) => key === "paperEvidence").claims[0].authorityLabel, "Legacy · unclassified");
  assert.equal(draft.sections.find(({ key }) => key === "paperEvidence").content, SECTION_TEXT.paperEvidence);

  const savedNote = explanation({
    explanationId: "explanation:saved",
    savedAt: "2026-08-31T09:00:00.000Z",
    humanDecision: "saved",
    takeaway: "Attention removes the sequential bottleneck by comparing tokens directly.",
  });
  const saved = createMentorReviewViewModel({ savedExplanations: [savedNote] });
  assert.equal(saved.state, "saved");
  assert.equal(saved.stateLabel, "Saved");
  assert.equal(saved.showHumanDecisionActions, false);
  assert.equal(saved.takeaway, savedNote.takeaway);
  assert.equal(saved.statusMessage, "Saved by the reader · 2026-08-31T09:00:00.000Z · AI-generated, not scientifically verified.");
});

function claim(text, authority, anchorIds = [], graphEntityKeys = [], citationIds = []) {
  return { text, authority, anchorIds, graphEntityKeys, citationIds };
}

function claimsExplanation(overrides = {}) {
  return explanation({ explanationVersion: 2,
    sections: {
      quickTake: [claim("The paper states x = y.", "document_evidence", ["anchor:text:attention"], ["node:concept:attention"])],
      paperFit: [claim("A useful reading is that x depends on y.", "mentor_interpretation", ["anchor:text:attention"])],
      prerequisites: [claim("A vector is an ordered collection of numbers.", "mentor_background")],
      howItWorks: [claim("x = Σᵢ αᵢvᵢ\nHere αᵢ is a weight; vᵢ is a value vector.", "mentor_background")],
      paperEvidence: [claim("The region shows a comparison.", "rendered_document_view", ["anchor:page:1"])],
      relatedIdeas: [claim("This outside explanation may help.", "external_source", [], [], ["citation:one"])],
      limitations: [claim("The available context does not establish the result.", "uncertain", [], ["edge:relation"])],
    },
    graphEntityKeys: ["node:concept:attention", "edge:relation"],
    sourceCoverage: [
      { anchorId: "anchor:text:attention", status: "used", explanation: "Used for the exact statement." },
      { anchorId: "anchor:page:1", status: "insufficient", explanation: "The locator alone cannot establish visual detail." },
    ],
    graphCoverage: [{ entityKey: "node:concept:attention", role: "explained" }, { entityKey: "edge:relation", role: "questioned" }],
    externalCitations: [{ citationId: "citation:one", title: "A separate teaching source", url: "https://example.org/reading", declaredBy: "agent", verification: "not_verified_by_paperpilot" }],
    ...overrides,
  });
}

function evidenceContext() {
  return {
    currentPaperRef: "paper:current", currentDocumentSha256: "c".repeat(64), currentGraphDigest: "b".repeat(64),
    currentAnchors: new Map([
      ["anchor:text:attention", { paperRef: "paper:current", documentSha256: "c".repeat(64), sourceKind: "exact_text", pageLabel: "2" }],
      ["anchor:page:1", { paperRef: "paper:current", documentSha256: "c".repeat(64), sourceKind: "visual_region", pageLabel: "3" }],
    ]),
    currentGraphNodes: new Map([["node:concept:attention", { label: "Attention", status: "active" }]]),
    currentGraphEdges: new Map([["edge:relation", { label: "Attention → Values · uses", status: "active" }]]),
  };
}

test("versioned claims preserve per-claim authority, exact source IDs, edge context and plain mathematics", () => {
  const source = claimsExplanation();
  const before = structuredClone(source);
  const model = createMentorReviewViewModel({ stagedExplanations: [source], ...evidenceContext() });
  assert.equal(model.explanation.provenanceMode, "claim_level");
  assert.equal(model.quickTakeClaims[0].authorityLabel, "Paper evidence");
  assert.equal(model.quickTakeClaims[0].sourceLinks[0].key, "anchor:text:attention");
  assert.equal(model.quickTakeClaims[0].sourceLinks[0].label, "p. 2 · Exact text");
  assert.equal(model.sections.find(({ key }) => key === "prerequisites").claims[0].authorityLabel, "Mentor background");
  assert.equal(model.sections.find(({ key }) => key === "howItWorks").claims[0].text, source.sections.howItWorks[0].text);
  assert.equal(model.sections.find(({ key }) => key === "limitations").claims[0].graphLinks[0].kind, "edge");
  assert.equal(model.sections.find(({ key }) => key === "limitations").claims[0].graphLinks[0].available, true);
  assert.deepEqual(source, before);
});

test("missing, foreign and removed evidence is retained as disabled links and stale context is explicit", () => {
  const context = evidenceContext();
  context.currentAnchors.delete("anchor:text:attention");
  context.currentAnchors.get("anchor:page:1").paperRef = "paper:another";
  context.currentGraphEdges.get("edge:relation").status = "tombstoned";
  context.currentGraphDigest = "d".repeat(64);
  const model = createMentorReviewViewModel({ stagedExplanations: [claimsExplanation()], ...context });
  assert.equal(model.sourceLinks.length, 2);
  assert.equal(model.sourceLinks.every(({ available, label }) => !available && label === "Source incomplete"), true);
  assert.equal(model.quickTakeClaims[0].sourceLinks[0].available, false);
  assert.equal(model.quickTakeClaims[0].warnings.some((text) => text.startsWith("Source incomplete")), true);
  const edge = model.sections.find(({ key }) => key === "limitations").claims[0].graphLinks[0];
  assert.equal(edge.key, "edge:relation");
  assert.equal(edge.available, false);
  assert.match(edge.detail, /removed/);
  assert.equal(model.notices.some((text) => /map has changed/.test(text)), true);
  context.currentAnchors = evidenceContext().currentAnchors;
  const refreshed = createMentorReviewViewModel({ stagedExplanations: [claimsExplanation()], ...context });
  assert.equal(refreshed.quickTakeClaims[0].sourceLinks[0].available, true);
});

test("external sources have explicit unverified links; unsafe or missing citations never get an href", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,test", "http://example.org", "https://user:pass@example.org", "https://127.0.0.1/internal"]) {
    const source = claimsExplanation();
    source.externalCitations[0].url = url;
    const model = createMentorReviewViewModel({ stagedExplanations: [source], ...evidenceContext() });
    const citation = model.sections.find(({ key }) => key === "relatedIdeas").claims[0].citations[0];
    assert.equal(citation.href, null, url);
    assert.match(citation.label, /Not verified by PaperPilot/);
  }
  const source = claimsExplanation();
  const model = createMentorReviewViewModel({ stagedExplanations: [source], ...evidenceContext() });
  assert.equal(model.sections.find(({ key }) => key === "relatedIdeas").claims[0].citations[0].href, "https://example.org/reading");
  source.externalCitations = [];
  const missing = createMentorReviewViewModel({ stagedExplanations: [source], ...evidenceContext() });
  assert.equal(missing.sections.find(({ key }) => key === "relatedIdeas").claims[0].citations[0].href, null);
});

test("visual description, observation and interpretation remain separate and locator-limited", () => {
  const source = claimsExplanation({ focusAnchorId: "anchor:page:1", visualEvidenceMode: "locator_only", visualObservation: "The reader selected a region containing boxes and connectors; their meaning needs context." });
  const model = createMentorReviewViewModel({ stagedExplanations: [source], ...evidenceContext() });
  assert.equal(model.visualDescription.text, source.visualObservation);
  assert.match(model.visualDescription.label, /Mentor interpretation/);
  assert.match(model.visualDescription.limitation, /reader-supplied or caption context/);
  assert.match(model.visualDescription.limitation, /not verified pixel use/);
  assert.equal(model.visualDescription.sourceLinks[0].key, "anchor:page:1");
  assert.equal(model.sections.find(({ key }) => key === "paperEvidence").claims[0].authorityLabel, "Rendered-page observation");
  assert.match(model.sections.find(({ key }) => key === "paperEvidence").claims[0].warnings[0], /Locator-only/);
});

test("legacy paperEvidence is unclassified and cannot acquire claim sources from note-wide citations", () => {
  const model = createMentorReviewViewModel({ savedExplanations: [explanation({ savedAt: "2026-09-02T10:00:00Z" })], ...evidenceContext() });
  for (const item of [...model.quickTakeClaims, ...model.sections.flatMap(({ claims }) => claims)]) {
    assert.equal(item.authority, "legacy_unclassified");
    assert.equal(item.authorityLabel, "Legacy · unclassified");
    assert.deepEqual(item.sourceLinks, []);
    assert.deepEqual(item.graphLinks, []);
  }
  assert.equal(model.sourceLinks.length, 2);
  assert.match(model.notices[0], /Section names do not establish evidence/);
});

test("human Save preserves exact versioned claims and response digest while keeping takeaway separate", () => {
  const source = claimsExplanation();
  const before = structuredClone(source);
  const result = applyHumanMentorDecision({ actor: "human", decision: "save", stagedExplanations: [source], takeaway: "My own understanding.", savedAt: "2026-09-02T12:00:00Z" });
  assert.equal(result.status, "saved");
  assert.deepEqual(result.savedExplanations[0].sections, before.sections);
  assert.equal(result.savedExplanations[0].responseDigest, before.responseDigest);
  assert.equal(result.savedExplanations[0].takeaway, "My own understanding.");
  assert.deepEqual(source, before);
});

test("rejects agent Save/Discard attempts and returns independent unchanged collections", () => {
  const staged = [explanation()];
  const saved = [explanation({ explanationId: "explanation:older", humanDecision: "saved" })];
  const before = structuredClone({ staged, saved });
  for (const decision of ["save", "discard"]) {
    const result = applyHumanMentorDecision({ actor: "agent", decision, stagedExplanations: staged, savedExplanations: saved });
    assert.equal(result.status, "rejected");
    assert.equal(result.code, "human_decision_required");
    assert.equal(result.changed, false);
    assert.equal(result.event, null);
    assert.deepEqual(result.stagedExplanations, staged);
    assert.deepEqual(result.savedExplanations, saved);
    assert.notEqual(result.stagedExplanations, staged);
    assert.notEqual(result.savedExplanations, saved);
  }
  assert.deepEqual({ staged, saved }, before);
});

test("human Save binds a trimmed takeaway, deduplicates the note, and emits a page-owned evidence event", () => {
  const draft = explanation();
  const previousVersion = explanation({
    savedAt: "2026-08-30T09:00:00.000Z",
    humanDecision: "saved",
    takeaway: "Old takeaway",
  });
  const inputs = {
    stagedExplanations: [draft],
    savedExplanations: [previousVersion],
  };
  const before = structuredClone(inputs);
  const result = applyHumanMentorDecision({
    actor: "human",
    decision: "save",
    ...inputs,
    takeaway: "  Attention compares token representations directly.  ",
    savedAt: "2026-08-31T10:00:00.000Z",
  });
  assert.equal(result.status, "saved");
  assert.equal(result.changed, true);
  assert.deepEqual(result.stagedExplanations, []);
  assert.equal(result.savedExplanations.length, 1);
  assert.deepEqual(result.explanation, {
    ...draft,
    savedAt: "2026-08-31T10:00:00.000Z",
    humanDecision: "saved",
    takeaway: "Attention compares token representations directly.",
  });
  assert.deepEqual(result.event, {
    eventType: "explanation_saved",
    actor: "human",
    explanationId: draft.explanationId,
    responseDigest: draft.responseDigest,
  });
  assert.deepEqual(inputs, before, "the decision helper must not mutate app state");
});

test("human Save remains bounded and rejects missing timestamps or oversized takeaways", () => {
  const draft = explanation({ explanationId: "explanation:new" });
  const existing = Array.from({ length: 200 }, (_, index) => explanation({
    explanationId: `explanation:old:${String(index).padStart(3, "0")}`,
    responseDigest: index.toString(16).padStart(64, "0"),
    savedAt: "2026-08-30T09:00:00.000Z",
    humanDecision: "saved",
  }));
  const saved = applyHumanMentorDecision({
    actor: "human",
    decision: "save",
    stagedExplanations: [draft],
    savedExplanations: existing,
    savedAt: "2026-08-31T10:00:00.000Z",
  });
  assert.equal(saved.status, "rejected");
  assert.equal(saved.code, "saved_note_limit");
  assert.equal(saved.savedExplanations.length, 200);
  assert.deepEqual(saved.savedExplanations, existing);
  assert.deepEqual(saved.stagedExplanations, [draft]);
  assert.equal(saved.changed, false);
  assert.equal(saved.event, null);
  const replacement = applyHumanMentorDecision({
    actor: "human", decision: "save", savedExplanations: existing,
    stagedExplanations: [explanation({ explanationId: "explanation:old:000" })], savedAt: "2026-09-02T12:00:00Z",
  });
  assert.equal(replacement.status, "saved");
  assert.equal(replacement.savedExplanations.length, 200);
  assert.equal(replacement.savedExplanations.at(-1).explanationId, "explanation:old:000");
  assert.equal(replacement.savedExplanations.at(-1).savedAt, "2026-09-02T12:00:00Z");

  const noTimestamp = applyHumanMentorDecision({
    actor: "human",
    decision: "save",
    stagedExplanations: [draft],
  });
  assert.equal(noTimestamp.status, "rejected");
  assert.equal(noTimestamp.code, "saved_at_required");
  assert.equal(noTimestamp.changed, false);

  const oversized = applyHumanMentorDecision({
    actor: "human",
    decision: "save",
    stagedExplanations: [draft],
    savedAt: "2026-08-31T10:00:00.000Z",
    takeaway: "x".repeat(1_201),
  });
  assert.equal(oversized.status, "rejected");
  assert.equal(oversized.code, "takeaway_too_long");
  assert.equal(oversized.changed, false);
});

test("human Discard removes only the staged draft and leaves saved notes intact", () => {
  const draft = explanation();
  const olderDraft = explanation({ explanationId: "explanation:older-draft" });
  const saved = [explanation({ explanationId: "explanation:saved", humanDecision: "saved" })];
  const result = applyHumanMentorDecision({
    actor: "human",
    decision: "discard",
    stagedExplanations: [olderDraft, draft],
    savedExplanations: saved,
  });
  assert.equal(result.status, "discarded");
  assert.equal(result.changed, true);
  assert.deepEqual(result.stagedExplanations, [olderDraft]);
  assert.deepEqual(result.savedExplanations, saved);
  assert.deepEqual(result.event, {
    eventType: "explanation_discarded",
    actor: "human",
    explanationId: draft.explanationId,
    responseDigest: draft.responseDigest,
  });

  const nothing = applyHumanMentorDecision({ actor: "human", decision: "discard", stagedExplanations: [] });
  assert.equal(nothing.status, "no_staged_explanation");
  assert.equal(nothing.changed, false);
  assert.equal(nothing.event, null);
});
