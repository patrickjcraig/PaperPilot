import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RunnerFailure } from "../src/errors.js";
import { normalizePopplerText } from "../src/text-normalization.js";

function failure(kind: RunnerFailure["kind"]): (error: unknown) => boolean {
  return (error) => error instanceof RunnerFailure && error.kind === kind;
}

describe("Poppler text normalization", () => {
  it("builds deterministic flat page-local paragraphs with NFC text", () => {
    const raw = Buffer.from(
      "Cafe\u0301 first line\ncontinues here\n\nSecond\tparagraph\fPage\u00a0two\f",
      "utf8",
    );
    const result = normalizePopplerText(raw, 2, {
      maxTextBytes: 4 * 1_024,
      maxChunkCount: 16,
      maxChunkBytes: 1_024,
    });
    assert.deepEqual(result.chunks, [
      { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "Café first line continues here" },
      { sequence: 1, pageNumber: 1, paragraphId: "p1-p2", text: "Second paragraph" },
      { sequence: 2, pageNumber: 2, paragraphId: "p2-p1", text: "Page two" },
    ]);
    assert.equal(
      result.textBytes,
      result.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0),
    );
  });

  it("repeats only the logical paragraph id for deterministic byte-bounded splits", () => {
    const result = normalizePopplerText(Buffer.from("alpha beta gamma delta", "utf8"), 1, {
      maxTextBytes: 100,
      maxChunkCount: 10,
      maxChunkBytes: 10,
    });
    assert.deepEqual(result.chunks, [
      { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "alpha beta" },
      { sequence: 1, pageNumber: 1, paragraphId: "p1-p1", text: "gamma" },
      { sequence: 2, pageNumber: 1, paragraphId: "p1-p1", text: "delta" },
    ]);
    for (const chunk of result.chunks) {
      assert.ok(Buffer.byteLength(chunk.text, "utf8") <= 10);
    }
  });

  it("represents image-only pages as a successful empty extraction", () => {
    assert.deepEqual(normalizePopplerText(Buffer.from("\f\f", "ascii"), 2, {
      maxTextBytes: 100,
      maxChunkCount: 10,
      maxChunkBytes: 10,
    }), { chunks: [], textBytes: 0 });
  });

  it("rejects invalid UTF-8, page-boundary mismatch, controls, and bidi formats", () => {
    for (const [bytes, pages] of [
      [Buffer.from([0xc3, 0x28]), 1],
      [Buffer.from("one\ftwo\f", "utf8"), 1],
      [Buffer.from("text\f\u00a0", "utf8"), 1],
      [Buffer.from("text\u0000hidden", "utf8"), 1],
      [Buffer.from("safe\u202eevil", "utf8"), 1],
    ] as const) {
      assert.throws(() => normalizePopplerText(bytes, pages, {
        maxTextBytes: 100,
        maxChunkCount: 10,
        maxChunkBytes: 10,
      }), failure("protocol"));
    }
  });

  it("fails closed on normalized-text and chunk-count bombs", () => {
    assert.throws(() => normalizePopplerText(Buffer.from("01234567890", "ascii"), 1, {
      maxTextBytes: 10,
      maxChunkCount: 10,
      maxChunkBytes: 100,
    }), failure("output_limit"));
    assert.throws(() => normalizePopplerText(Buffer.from("aaaa bbbb c", "ascii"), 1, {
      maxTextBytes: 10,
      maxChunkCount: 10,
      maxChunkBytes: 5,
    }), failure("output_limit"));
    assert.throws(() => normalizePopplerText(Buffer.from("one\n\ntwo", "ascii"), 1, {
      maxTextBytes: 100,
      maxChunkCount: 1,
      maxChunkBytes: 100,
    }), failure("output_limit"));
  });
});
