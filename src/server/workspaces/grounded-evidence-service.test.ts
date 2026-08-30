import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { GroundedEvidenceSelection } from "@/lib/workspace/contracts";
import { HttpProblem } from "@/server/http/problem";

process.env.DATABASE_URL ??= "postgres://paperpilot_runtime:unit@127.0.0.1:1/paperpilot_unit?sslmode=disable";

const {
  reconstructGroundedEvidenceQuote,
  validateCaptureGroundedEvidenceCommand,
} = await import("./grounded-evidence-service");

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function chunk(id: string, sequence: number, text: string, page: number) {
  return {
    id,
    sequence,
    pageStart: page,
    pageEnd: page,
    sectionId: null,
    sectionTitle: null,
    paragraphId: `p${page}-p1`,
    charStart: 0,
    charEnd: text.length,
    text,
    contentHash: digest(text),
    locator: {
      schemaVersion: 1,
      kind: "pdf-text",
      pageNumber: page,
      paragraphId: `p${page}-p1`,
    },
  };
}

function command() {
  const quote = "grounded evidence";
  return {
    clientOperationId: "grounded-op-1",
    expectedVersion: 4,
    projectId: "project-1",
    collectionIds: ["collection-1"],
    note: {
      kind: "direct-evidence",
      title: "Primary result",
      claim: "The paper reports a result.",
      interpretation: "This directly supports the claim.",
      confidence: "unspecified",
      tags: ["result"],
    },
    selection: {
      documentId: "document-1",
      extractionId: "extraction-1",
      manifestSha256: digest("manifest"),
      start: {
        chunkId: "chunk-1",
        sequence: 0,
        byteOffset: 0,
        contentHash: digest(quote),
      },
      end: {
        chunkId: "chunk-1",
        sequence: 0,
        byteOffset: Buffer.byteLength(quote, "utf8"),
        contentHash: digest(quote),
      },
      expectedQuoteSha256: digest(quote),
    },
  };
}

function expectProblem(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) =>
    error instanceof HttpProblem && error.code === code);
}

test("grounded evidence command validation is exact and preserves explicit scope", () => {
  const parsed = validateCaptureGroundedEvidenceCommand(command());
  assert.equal(parsed.projectId, "project-1");
  assert.deepEqual(parsed.collectionIds, ["collection-1"]);
  assert.equal(parsed.note.confidence, "unspecified");
  assert.equal(parsed.selection.end.byteOffset, 17);

  expectProblem(() => validateCaptureGroundedEvidenceCommand({
    ...command(),
    quote: "client supplied text is forbidden",
  }), "validation");
  expectProblem(() => validateCaptureGroundedEvidenceCommand({
    ...command(),
    projectId: undefined,
  }), "validation");
  expectProblem(() => validateCaptureGroundedEvidenceCommand({
    ...command(),
    collectionIds: ["collection-1", "collection-1"],
  }), "validation");
});

test("grounded evidence command rejects empty and over-wide selection ranges", () => {
  const empty = command();
  empty.selection.end.byteOffset = 0;
  expectProblem(() => validateCaptureGroundedEvidenceCommand(empty), "validation");

  const wide = command();
  wide.selection.end = {
    chunkId: "chunk-101",
    sequence: 100,
    byteOffset: 1,
    contentHash: digest("last"),
  };
  expectProblem(() => validateCaptureGroundedEvidenceCommand(wide), "validation");
});

test("server reconstruction uses UTF-8 byte offsets and the canonical inter-chunk delimiter", () => {
  const first = chunk("chunk-1", 5, "prefix α", 2);
  const last = chunk("chunk-2", 6, "beta suffix", 3);
  const quoteText = "α\n\nbeta";
  const selection: GroundedEvidenceSelection = {
    documentId: "document-1",
    extractionId: "extraction-1",
    manifestSha256: digest("manifest"),
    start: {
      chunkId: first.id,
      sequence: first.sequence,
      byteOffset: Buffer.byteLength("prefix ", "utf8"),
      contentHash: first.contentHash,
    },
    end: {
      chunkId: last.id,
      sequence: last.sequence,
      byteOffset: Buffer.byteLength("beta", "utf8"),
      contentHash: last.contentHash,
    },
    expectedQuoteSha256: digest(quoteText),
  };

  assert.deepEqual(reconstructGroundedEvidenceQuote([first, last], selection), {
    quoteText,
    quoteSha256: digest(quoteText),
    pageStart: 2,
    pageEnd: 3,
    paragraphStartId: "p2-p1",
    paragraphEndId: "p3-p1",
  });
});

test("server reconstruction rejects split UTF-8 boundaries and client hash drift", () => {
  const source = chunk("chunk-1", 0, "évidence", 1);
  const splitSelection: GroundedEvidenceSelection = {
    documentId: "document-1",
    extractionId: "extraction-1",
    manifestSha256: digest("manifest"),
    start: {
      chunkId: source.id,
      sequence: 0,
      byteOffset: 1,
      contentHash: source.contentHash,
    },
    end: {
      chunkId: source.id,
      sequence: 0,
      byteOffset: 3,
      contentHash: source.contentHash,
    },
    expectedQuoteSha256: digest("not the selected text"),
  };
  expectProblem(
    () => reconstructGroundedEvidenceQuote([source], splitSelection),
    "selection_conflict",
  );

  const driftSelection = {
    ...splitSelection,
    start: { ...splitSelection.start, byteOffset: 0 },
    end: { ...splitSelection.end, byteOffset: Buffer.byteLength(source.text, "utf8") },
  };
  expectProblem(
    () => reconstructGroundedEvidenceQuote([source], driftSelection),
    "selection_conflict",
  );
});
