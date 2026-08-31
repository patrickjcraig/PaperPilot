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

test("freezes the exact seven mentor sections and keeps paper evidence distinct from mentor synthesis", () => {
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
    authorityKind: "paper_evidence",
    authorityLabel: "Paper evidence",
    initiallyOpen: true,
  });
  assert.equal(
    MENTOR_SECTION_DEFINITIONS
      .filter(({ key }) => key !== "paperEvidence")
      .every(({ authorityKind }) => authorityKind === "mentor_synthesis"),
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
  assert.equal(draft.statusMessage, "Mentor draft · AI-generated · 2 cited sources · not saved or verified.");
  assert.deepEqual(draft.sourceAnchorIds, ["anchor:text:attention"]);
  assert.deepEqual(draft.graphEntityKeys, ["node:paper"]);
  assert.equal(draft.sections.length, 6);
  assert.equal(draft.sections.find(({ key }) => key === "paperEvidence").authorityKind, "paper_evidence");
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
  assert.equal(saved.status, "saved");
  assert.equal(saved.savedExplanations.length, 200);
  assert.equal(saved.savedExplanations.at(-1).explanationId, draft.explanationId);
  assert.equal(saved.savedExplanations.some(({ explanationId }) => explanationId === "explanation:old:000"), false);

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
