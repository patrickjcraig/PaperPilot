import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  selectionToGroundedAnchor,
  type ReaderSelectionChunk,
} from "./reader-evidence-selection";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function chunk(
  sequence: number,
  text: string,
  pageNumber = 1,
): ReaderSelectionChunk {
  return {
    id: `chunk:${sequence}`,
    sequence,
    pageNumber,
    paragraphId: `p${pageNumber}-p${sequence + 1}`,
    text,
    contentHash: digest(text),
  };
}

test("selectionToGroundedAnchor converts Unicode boundaries to UTF-8 byte offsets", async () => {
  const source = chunk(0, "Alpha 😀 café omega.");
  const start = source.text.indexOf("😀");
  const end = source.text.indexOf(" omega");

  const result = await selectionToGroundedAnchor(
    [source],
    { chunkId: source.id, utf16Offset: start },
    { chunkId: source.id, utf16Offset: end },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.quoteText, "😀 café");
  assert.equal(result.selection.anchor.start.byteOffset, Buffer.byteLength("Alpha ", "utf8"));
  assert.equal(
    result.selection.anchor.end.byteOffset,
    Buffer.byteLength("Alpha 😀 café", "utf8"),
  );
  assert.equal(result.selection.anchor.expectedQuoteSha256, digest("😀 café"));
});

test("selectionToGroundedAnchor normalizes a backwards multi-chunk selection", async () => {
  const chunks = [
    chunk(4, "First authoritative paragraph."),
    chunk(5, "Middle paragraph."),
    chunk(6, "Final source paragraph.", 2),
  ];
  const result = await selectionToGroundedAnchor(
    chunks,
    { chunkId: chunks[2]!.id, utf16Offset: 12 },
    { chunkId: chunks[0]!.id, utf16Offset: 6 },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.selection.quoteText,
    "authoritative paragraph.\n\nMiddle paragraph.\n\nFinal source",
  );
  assert.equal(result.selection.anchor.start.sequence, 4);
  assert.equal(result.selection.anchor.end.sequence, 6);
  assert.equal(result.selection.anchor.start.byteOffset, 6);
  assert.equal(result.selection.anchor.end.byteOffset, 12);
  assert.deepEqual(result.selection.selectedChunkIds, ["chunk:4", "chunk:5", "chunk:6"]);
});

test("selectionToGroundedAnchor rejects a boundary that splits a surrogate pair", async () => {
  const source = chunk(0, "A😀B");
  const result = await selectionToGroundedAnchor(
    [source],
    { chunkId: source.id, utf16Offset: 2 },
    { chunkId: source.id, utf16Offset: 3 },
  );
  assert.deepEqual(result, { ok: false, code: "boundary_invalid" });
});

test("selectionToGroundedAnchor rejects a boundary inside a combining grapheme", async () => {
  const source = chunk(0, "Cafe\u0301 source");
  const result = await selectionToGroundedAnchor(
    [source],
    { chunkId: source.id, utf16Offset: 3 },
    { chunkId: source.id, utf16Offset: 4 },
  );
  assert.deepEqual(result, { ok: false, code: "boundary_invalid" });
});

test("selectionToGroundedAnchor rejects non-contiguous chunk identities", async () => {
  const chunks = [chunk(0, "First"), chunk(2, "Third")];
  const result = await selectionToGroundedAnchor(
    chunks,
    { chunkId: chunks[0]!.id, utf16Offset: 0 },
    { chunkId: chunks[1]!.id, utf16Offset: chunks[1]!.text.length },
  );
  assert.deepEqual(result, { ok: false, code: "chunk_order_invalid" });
});

test("selectionToGroundedAnchor rejects whitespace-only selections", async () => {
  const source = chunk(0, "Alpha   omega");
  const result = await selectionToGroundedAnchor(
    [source],
    { chunkId: source.id, utf16Offset: 5 },
    { chunkId: source.id, utf16Offset: 8 },
  );
  assert.deepEqual(result, { ok: false, code: "selection_empty" });
});
