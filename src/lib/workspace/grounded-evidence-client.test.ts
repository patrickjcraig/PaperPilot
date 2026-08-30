import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { parseCaptureGroundedEvidenceResponse } from "./http-client";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const quote = "The admitted result supports this bounded claim.";
const manifestSha256 = "a".repeat(64);
const contentHash = "b".repeat(64);

function validCaptureResponse() {
  const grounding = {
    schemaVersion: 1 as const,
    state: "current" as const,
    documentId: "document:one",
    extractionId: "extraction:one",
    manifestSha256,
    start: {
      chunkId: "chunk:one",
      sequence: 0,
      byteOffset: 0,
      contentHash,
    },
    end: {
      chunkId: "chunk:one",
      sequence: 0,
      byteOffset: Buffer.byteLength(quote, "utf8"),
      contentHash,
    },
    quoteSha256: digest(quote),
    pageStart: 4,
    pageEnd: 4,
    paragraphStartId: "p4-p2",
    paragraphEndId: "p4-p2",
  };
  return {
    ok: true as const,
    outcome: "applied" as const,
    aggregateVersion: 9,
    data: {
      note: {
        id: "note:one",
        paperId: "paper:one",
        title: "Bounded result",
        kind: "direct-evidence" as const,
        claim: "The reported result supports the project claim.",
        evidence: quote,
        interpretation: "The result applies within the stated study population.",
        confidence: "unspecified" as const,
        status: "captured" as const,
        provenance: {
          id: "provenance:one",
          sourceType: "uploaded-file" as const,
          sourceId: "extraction:one",
          sourceTitle: "A source paper",
          providerName: "PaperPilot Reader",
          retrievedAt: "2026-08-28T12:00:00.000Z",
          accessMethod: "upload" as const,
          locator: {
            paperId: "paper:one",
            page: 4,
            paragraphId: "p4-p2",
          },
          excerpt: quote,
          version: `manifest:${manifestSha256}`,
        },
        linkedHighlightIds: [],
        collectionIds: ["collection:one"],
        tags: ["result"],
        grounding,
        revision: {
          rootId: "note:one",
          number: 1,
          isLatest: true,
        },
        createdAt: "2026-08-28T12:00:00.000Z",
        updatedAt: "2026-08-28T12:00:00.000Z",
      },
      linkedProjectIds: ["project:one"],
      updatedCollectionIds: ["collection:one"],
      grounding,
    },
  };
}

test("grounded capture parser admits a complete coherent EvidenceNote and installs its anchor", () => {
  const parsed = parseCaptureGroundedEvidenceResponse(
    validCaptureResponse(),
    "paper:one",
  );
  assert.equal(parsed?.ok, true);
  if (!parsed?.ok) return;
  assert.deepEqual(parsed.data.note.grounding, parsed.data.grounding);
  assert.equal(parsed.data.note.evidence, quote);
  assert.equal(parsed.data.note.provenance.excerpt, quote);
});

test("grounded capture parser rejects open note fields and a route-paper mismatch", () => {
  const withUnknown = validCaptureResponse();
  Object.assign(withUnknown.data.note, { serverDiagnostic: "must not cross the boundary" });
  assert.equal(parseCaptureGroundedEvidenceResponse(withUnknown, "paper:one"), null);
  assert.equal(
    parseCaptureGroundedEvidenceResponse(validCaptureResponse(), "paper:two"),
    null,
  );
});

test("grounded capture parser rejects excerpt, locator, and review-state drift", () => {
  const excerptDrift = validCaptureResponse();
  excerptDrift.data.note.provenance.excerpt = "A different quote.";
  assert.equal(parseCaptureGroundedEvidenceResponse(excerptDrift, "paper:one"), null);

  const locatorDrift = validCaptureResponse();
  locatorDrift.data.note.provenance.locator.page = 5;
  assert.equal(parseCaptureGroundedEvidenceResponse(locatorDrift, "paper:one"), null);

  const statusDrift = validCaptureResponse();
  statusDrift.data.note.status = "verified" as typeof statusDrift.data.note.status;
  assert.equal(parseCaptureGroundedEvidenceResponse(statusDrift, "paper:one"), null);
});

test("grounded capture replay reflects a superseded source and non-head root truthfully", () => {
  const replay = validCaptureResponse();
  (replay as { outcome: string }).outcome = "replayed";
  (replay.data.grounding as { state: string }).state = "superseded";
  replay.data.note.revision.isLatest = false;
  Object.assign(replay.data.note.revision, { nextId: "note:two" });

  const parsed = parseCaptureGroundedEvidenceResponse(replay, "paper:one");
  assert.equal(parsed?.ok, true);
  if (!parsed?.ok) return;
  assert.equal(parsed.data.grounding.state, "superseded");
  assert.equal(parsed.data.note.revision.isLatest, false);

  const impossibleApplied = structuredClone(replay);
  (impossibleApplied as { outcome: string }).outcome = "applied";
  assert.equal(parseCaptureGroundedEvidenceResponse(impossibleApplied, "paper:one"), null);
});
