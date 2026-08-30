import assert from "node:assert/strict";
import test from "node:test";
import { HttpProblem } from "@/server/http/problem";

process.env.DATABASE_URL ??= "postgres://paperpilot_runtime:unit@127.0.0.1:1/paperpilot_unit?sslmode=disable";

const {
  applyEvidenceIdempotencyHeader,
  validateCreateEvidenceNoteCommand,
  validateNoteCollectionCommand,
  validatePaperCollectionCommand,
} = await import("./evidence-service");

function validCommand() {
  return {
    clientOperationId: "evidence-operation-one",
    expectedVersion: 3,
    projectId: "project-one",
    note: {
      paperId: "paper-one",
      title: "Bounded result",
      kind: "direct-evidence",
      claim: "The intervention improved the prespecified primary outcome.",
      evidence: "Participants improved by 12 points relative to control.",
      interpretation: "The effect is material within this study population.",
      openQuestion: "Does the effect transfer to older adults?",
      confidence: "medium",
      status: "needs-verification",
      provenance: {
        sourceType: "paper",
        sourceId: "doi:10.1000/example",
        sourceTitle: "A bounded clinical result",
        sourceUrl: "https://example.test/paper",
        providerName: "Manual review",
        retrievedAt: "2026-08-28T12:00:00.000Z",
        accessMethod: "manual",
        locator: {
          paperId: "paper-one",
          sectionId: "results",
          sectionTitle: "Results",
          pageRange: [7, 8],
        },
        excerpt: "Participants improved by 12 points relative to control.",
        version: "accepted-manuscript",
      },
      linkedHighlightIds: ["highlight-one", "highlight-one"],
      collectionIds: ["collection-one"],
      tags: ["outcome", "outcome"],
    },
  };
}

function validationError(action: () => unknown): HttpProblem {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof HttpProblem);
    assert.equal(error.status, 400);
    assert.equal(error.code, "validation");
    return error;
  }
  assert.fail("Expected evidence validation to fail.");
}

test("structured evidence validation normalizes bounded source custody", () => {
  const result = validateCreateEvidenceNoteCommand(validCommand());
  assert.equal(result.note.provenance.sourceUrl, "https://example.test/paper");
  assert.deepEqual(result.note.linkedHighlightIds, ["highlight-one"]);
  assert.deepEqual(result.note.tags, ["outcome"]);
  assert.deepEqual(result.note.provenance.locator?.pageRange, [7, 8]);
  assert.equal(result.note.provenance.excerpt, result.note.evidence);
});

test("evidence validation rejects lossy, ungrounded, or overclaimed records", () => {
  const projectless = { ...validCommand(), projectId: undefined };
  assert.match(
    validationError(() => validateCreateEvidenceNoteCommand(projectless)).message,
    /projectId/,
  );

  const unknown = validCommand();
  Object.assign(unknown.note, { mergedClaimAndEvidence: "unsafe" });
  assert.match(validationError(() => validateCreateEvidenceNoteCommand(unknown)).message, /unsupported field/);

  const wrongPaper = validCommand();
  wrongPaper.note.provenance.locator.paperId = "paper-two";
  assert.match(validationError(() => validateCreateEvidenceNoteCommand(wrongPaper)).message, /note's paper/);

  const mismatchedExcerpt = validCommand();
  mismatchedExcerpt.note.provenance.excerpt = "A different passage";
  assert.match(validationError(() => validateCreateEvidenceNoteCommand(mismatchedExcerpt)).message, /must match/);

  const verified = validCommand();
  verified.note.status = "verified";
  assert.match(validationError(() => validateCreateEvidenceNoteCommand(verified)).message, /captured or needs-verification/);

  const credentialUrl = validCommand();
  credentialUrl.note.provenance.sourceUrl = "https://user:secret@example.test/paper";
  assert.match(validationError(() => validateCreateEvidenceNoteCommand(credentialUrl)).message, /embedded credentials/);
});

test("collection edge commands must agree with their route resource", () => {
  assert.deepEqual(
    validatePaperCollectionCommand({
      clientOperationId: "paper-file-one",
      expectedVersion: 4,
      paperId: "paper-one",
      collectionId: "collection-one",
    }, "collection-one").paperId,
    "paper-one",
  );
  validationError(() => validatePaperCollectionCommand({
    clientOperationId: "paper-file-two",
    expectedVersion: 4,
    paperId: "paper-one",
    collectionId: "collection-two",
  }, "collection-one"));
  validationError(() => validateNoteCollectionCommand({
    clientOperationId: "note-file-one",
    expectedVersion: 4,
    noteId: "note-one",
    collectionId: "collection-two",
  }, "collection-one"));
});

test("Idempotency-Key fills a missing body key and rejects ambiguous intent", () => {
  const request = new Request("https://paperpilot.test/evidence", {
    method: "POST",
    headers: { "Idempotency-Key": "header-operation" },
  });
  assert.deepEqual(
    applyEvidenceIdempotencyHeader(request, { expectedVersion: 1 }),
    { clientOperationId: "header-operation", expectedVersion: 1 },
  );
  validationError(() => applyEvidenceIdempotencyHeader(request, {
    clientOperationId: "body-operation",
    expectedVersion: 1,
  }));
});
