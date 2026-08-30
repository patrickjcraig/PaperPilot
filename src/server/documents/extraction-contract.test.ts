import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DocumentExtractionContractError,
  MAX_EXTRACTED_CHUNK_BYTES,
  parseExternalDocumentExtractionResponse,
} from "./extraction-contract";

const SHA256 = "a".repeat(64);
const TOOLCHAIN = "b".repeat(64);
const NOW = new Date("2026-08-28T16:00:10.000Z");

function expectations() {
  return {
    inputSha256: SHA256,
    inputSizeBytes: 123n,
    storageVersion: "local-quarantine-v2",
    policyVersion: "paperpilot-text-extraction-v1",
    toolchainDigest: TOOLCHAIN,
    expectedEngineVersion: "25.06.0",
    now: NOW,
    maxDurationMs: 75_000,
    resultMaxAgeMs: 15 * 60_000,
    futureClockSkewMs: 5 * 60_000,
  };
}

function response() {
  return {
    schemaVersion: 1,
    policyVersion: "paperpilot-text-extraction-v1",
    storageVersion: "local-quarantine-v2",
    toolchainDigest: TOOLCHAIN,
    verdict: "extracted",
    input: { sha256: SHA256, sizeBytes: "123" },
    extraction: {
      engine: "poppler",
      engineVersion: "25.06.0",
      pageCount: 2,
      chunkCount: 3,
      textBytes: Buffer.byteLength("First paragraphSecond paragraphThird paragraph"),
      extractedAt: "2026-08-28T16:00:01.000Z",
      durationMs: 900,
    },
    chunks: [
      { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "First paragraph" },
      { sequence: 1, pageNumber: 1, paragraphId: "p1-p2", text: "Second paragraph" },
      { sequence: 2, pageNumber: 2, paragraphId: "p2-p1", text: "Third paragraph" },
    ],
    completedAt: "2026-08-28T16:00:02.000Z",
    totalDurationMs: 1_000,
  };
}

function failureOf(error: unknown): string | undefined {
  return error instanceof DocumentExtractionContractError ? error.failure : undefined;
}

describe("external document extraction response contract", () => {
  it("normalizes a closed extracted response with deterministic page-local chunks", () => {
    const parsed = parseExternalDocumentExtractionResponse(response(), expectations());
    assert.equal(parsed.verdict, "EXTRACTED");
    assert.equal(parsed.inputSizeBytes, 123n);
    assert.equal(parsed.pageCount, 2);
    assert.equal(parsed.chunkCount, 3);
    assert.deepEqual(parsed.chunks[2], {
      sequence: 2,
      pageNumber: 2,
      paragraphId: "p2-p1",
      text: "Third paragraph",
    });
    assert.equal(parsed.completedAt.toISOString(), "2026-08-28T16:00:02.000Z");
  });

  it("accepts an explicit no-text result without fabricating chunks", () => {
    const value = response();
    value.verdict = "no_text";
    value.extraction.chunkCount = 0;
    value.extraction.textBytes = 0;
    value.chunks = [];
    const parsed = parseExternalDocumentExtractionResponse(value, expectations());
    assert.equal(parsed.verdict, "NO_TEXT");
    assert.deepEqual(parsed.chunks, []);
  });

  it("requires exact content, storage, and policy bindings", () => {
    for (const [path, value, failure] of [
      ["input.sha256", "c".repeat(64), "input_mismatch"],
      ["input.sizeBytes", "124", "input_mismatch"],
      ["storageVersion", "other-storage-v1", "input_mismatch"],
      ["policyVersion", "other-policy-v1", "policy_mismatch"],
      ["toolchainDigest", "c".repeat(64), "toolchain_mismatch"],
      ["extraction.engineVersion", "26.01.0", "engine_mismatch"],
    ] as const) {
      const body = response() as Record<string, unknown>;
      if (path.startsWith("input.")) {
        (body.input as Record<string, unknown>)[path.slice(6)] = value;
      } else if (path.startsWith("extraction.")) {
        (body.extraction as Record<string, unknown>)[path.slice(11)] = value;
      } else {
        body[path] = value;
      }
      assert.throws(
        () => parseExternalDocumentExtractionResponse(body, expectations()),
        (error) => failureOf(error) === failure,
      );
    }
  });

  it("rejects unknown fields and malformed nested shapes", () => {
    for (const mutate of [
      (body: ReturnType<typeof response>) => Object.assign(body, { debug: "raw output" }),
      (body: ReturnType<typeof response>) => Object.assign(body.input, { path: "/tmp/a" }),
      (body: ReturnType<typeof response>) => Object.assign(body.extraction, { warnings: [] }),
      (body: ReturnType<typeof response>) => Object.assign(body.chunks[0]!, { html: "<b>x</b>" }),
    ]) {
      const body = response();
      mutate(body);
      assert.throws(() => parseExternalDocumentExtractionResponse(body, expectations()));
    }
  });

  it("enforces contiguous sequences, page order, paragraph ordinals, and exact byte totals", () => {
    for (const mutate of [
      (body: ReturnType<typeof response>) => { body.chunks[1]!.sequence = 2; },
      (body: ReturnType<typeof response>) => { body.chunks[2]!.pageNumber = 1; },
      (body: ReturnType<typeof response>) => { body.chunks[1]!.paragraphId = "p1-p4"; },
      (body: ReturnType<typeof response>) => { body.chunks[2]!.paragraphId = "p3-p1"; },
      (body: ReturnType<typeof response>) => { body.extraction.chunkCount = 2; },
      (body: ReturnType<typeof response>) => { body.extraction.textBytes += 1; },
    ]) {
      const body = response();
      mutate(body);
      assert.throws(() => parseExternalDocumentExtractionResponse(body, expectations()));
    }
  });

  it("rejects non-NFC, controls, bidi overrides, whitespace padding, and oversized chunks", () => {
    for (const text of [
      "Cafe\u0301",
      "line one\nline two",
      "trusted\u202Efdp.exe",
      "non\u00a0breaking",
      "double  space",
      " padded",
      "x".repeat(MAX_EXTRACTED_CHUNK_BYTES + 1),
    ]) {
      const body = response();
      body.chunks[0]!.text = text;
      body.extraction.textBytes = body.chunks.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk.text),
        0,
      );
      assert.throws(() => parseExternalDocumentExtractionResponse(body, expectations()));
    }
  });

  it("bounds canonical timestamps, chronology, duration, freshness, and future clocks", () => {
    for (const [mutate, failure] of [
      [(body: ReturnType<typeof response>) => { body.completedAt = "2026-08-28T16:00:02Z"; }, "invalid_response"],
      [(body: ReturnType<typeof response>) => { body.extraction.extractedAt = "2026-08-28T16:00:03.000Z"; }, "invalid_response"],
      [(body: ReturnType<typeof response>) => { body.totalDurationMs = 899; }, "invalid_response"],
      [(body: ReturnType<typeof response>) => {
        body.extraction.extractedAt = "2026-08-28T15:39:59.000Z";
        body.completedAt = "2026-08-28T15:40:00.000Z";
      }, "result_stale"],
      [(body: ReturnType<typeof response>) => {
        body.extraction.extractedAt = "2026-08-28T16:06:00.000Z";
        body.completedAt = "2026-08-28T16:06:01.000Z";
      }, "clock_invalid"],
    ] as const) {
      const body = response();
      mutate(body);
      assert.throws(
        () => parseExternalDocumentExtractionResponse(body, expectations()),
        (error) => failureOf(error) === failure,
      );
    }
  });
});
