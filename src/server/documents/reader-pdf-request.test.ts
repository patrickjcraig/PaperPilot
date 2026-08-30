import assert from "node:assert/strict";
import test from "node:test";

import { HttpProblem } from "@/server/http/problem";
import {
  readerPdfJsEnabled,
  requireReaderPdfJsEnabled,
} from "./reader-pdf-config";
import { parseReaderPdfRequest } from "./reader-pdf-request";

const DOCUMENT_ID = "document:one";
const DIGEST = "a".repeat(64);

function assertProblem(
  operation: () => unknown,
  status: number,
  code: string,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof HttpProblem);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("Reader PDF request requires one canonical document, digest, and matching ETag", () => {
  const result = parseReaderPdfRequest(
    new URLSearchParams({ documentId: DOCUMENT_ID, inputSha256: DIGEST }),
    `"${DIGEST}"`,
  );
  assert.deepEqual(result, { documentId: DOCUMENT_ID, inputSha256: DIGEST });
});

test("Reader PDF request rejects ambiguous or malformed identities", () => {
  for (const query of [
    new URLSearchParams(),
    new URLSearchParams({ documentId: "unsafe document", inputSha256: DIGEST }),
    new URLSearchParams({ documentId: DOCUMENT_ID, inputSha256: "A".repeat(64) }),
    new URLSearchParams({ documentId: DOCUMENT_ID, inputSha256: DIGEST, extra: "true" }),
    new URLSearchParams(`documentId=${DOCUMENT_ID}&documentId=document:two&inputSha256=${DIGEST}`),
  ]) {
    assertProblem(() => parseReaderPdfRequest(query, `"${DIGEST}"`), 400, "validation");
  }
});

test("Reader PDF request fails the precondition when If-Match is missing or changed", () => {
  const query = new URLSearchParams({ documentId: DOCUMENT_ID, inputSha256: DIGEST });
  assertProblem(() => parseReaderPdfRequest(query, null), 412, "document_generation_changed");
  assertProblem(
    () => parseReaderPdfRequest(query, `"${"b".repeat(64)}"`),
    412,
    "document_generation_changed",
  );
});

test("Reader PDF.js feature flag defaults off and accepts only explicit binary values", () => {
  assert.equal(readerPdfJsEnabled({}), false);
  assert.equal(readerPdfJsEnabled({ PAPERPILOT_READER_PDFJS: "0" }), false);
  assert.equal(readerPdfJsEnabled({ PAPERPILOT_READER_PDFJS: "1" }), true);
  assert.throws(
    () => readerPdfJsEnabled({ PAPERPILOT_READER_PDFJS: "true" }),
    /must be exactly 0 or 1/,
  );
});

test("Reader PDF.js feature flag fails the binary route closed when disabled", () => {
  assert.throws(
    () => requireReaderPdfJsEnabled({ PAPERPILOT_READER_PDFJS: "0" }),
    (error: unknown) => error instanceof HttpProblem
      && error.status === 404
      && error.code === "reader_pdf_unavailable",
  );
  assert.doesNotThrow(
    () => requireReaderPdfJsEnabled({ PAPERPILOT_READER_PDFJS: "1" }),
  );
});
