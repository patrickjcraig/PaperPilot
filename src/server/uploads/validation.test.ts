import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpProblem } from "@/server/http/problem";
import {
  IncrementalPdfEnvelopeValidator,
  MAX_UPLOAD_DISPLAY_FILENAME_BYTES,
  PDF_TRAILER_BUFFER_BYTES,
  normalizeUploadDisplayFilename,
  parseContentLengthHeader,
  requireExactPdfContentType,
  validatePdfEnvelope,
} from "./validation";

const encoder = new TextEncoder();

function problem(code: string): (error: unknown) => boolean {
  return (error) => error instanceof HttpProblem && error.code === code;
}

describe("upload request validation", () => {
  it("normalizes display-only filenames to NFC and enforces the UTF-8 byte limit", () => {
    assert.equal(normalizeUploadDisplayFilename("Cafe\u0301.pdf"), "Café.pdf");
    const exact = `${"a".repeat(MAX_UPLOAD_DISPLAY_FILENAME_BYTES - 4)}.pdf`;
    assert.equal(Buffer.byteLength(exact, "utf8"), MAX_UPLOAD_DISPLAY_FILENAME_BYTES);
    assert.equal(normalizeUploadDisplayFilename(exact), exact);

    const oversized = `${"a".repeat(MAX_UPLOAD_DISPLAY_FILENAME_BYTES - 3)}.pdf`;
    assert.throws(() => normalizeUploadDisplayFilename(oversized), problem("invalid_filename"));
    assert.throws(
      () => normalizeUploadDisplayFilename(`${"é".repeat(126)}.pdf`),
      problem("invalid_filename"),
    );
  });

  it("rejects path syntax, controls, bidi controls, dot paths, and Windows names", () => {
    for (const candidate of [
      "",
      ".",
      "..",
      "../paper.pdf",
      "..\\paper.pdf",
      "/paper.pdf",
      "C:\\paper.pdf",
      "paper.pdf:stream",
      "paper?.pdf",
      "paper.pdf.",
      "paper.pdf ",
      "paper\nname.pdf",
      "paper\u0085name.pdf",
      "paper\u202Efdp.exe",
      "CON",
      "con.pdf",
      "CON .pdf",
      "PrN.txt",
      "COM1.pdf",
      "lpt9.data",
      "\ud800.pdf",
      "paper.pdf\ud800",
    ]) {
      assert.throws(
        () => normalizeUploadDisplayFilename(candidate),
        problem("invalid_filename"),
        `unexpectedly accepted ${JSON.stringify(candidate)}`,
      );
    }
  });

  it("accepts only the exact parameter-free PDF media type", () => {
    assert.equal(requireExactPdfContentType("application/pdf"), "application/pdf");
    assert.equal(requireExactPdfContentType("Application/PDF"), "application/pdf");
    for (const value of [
      null,
      "",
      " application/pdf",
      "application/pdf ",
      "application/pdf; charset=binary",
      "application/octet-stream",
      "multipart/form-data",
    ]) {
      assert.throws(() => requireExactPdfContentType(value), problem("unsupported_media_type"));
    }
  });

  it("parses Content-Length as canonical decimal BigInt without Number coercion", () => {
    assert.equal(parseContentLengthHeader(null), null);
    assert.equal(parseContentLengthHeader("0"), 0n);
    assert.equal(parseContentLengthHeader("25"), 25n);
    assert.equal(
      parseContentLengthHeader("90071992547409931234567890123456"),
      90071992547409931234567890123456n,
    );
    for (const value of [
      "",
      "00",
      "01",
      "+1",
      "-1",
      "1.0",
      "1e3",
      " 1",
      "1 ",
      "1,2",
      "9".repeat(33),
    ]) {
      assert.throws(() => parseContentLengthHeader(value), problem("invalid_content_length"));
    }
  });
});

describe("incremental PDF envelope screening", () => {
  it("accepts only PDF 1.0 through 1.7 and PDF 2.0 at byte zero", () => {
    for (const version of ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0"] as const) {
      assert.deepEqual(
        validatePdfEnvelope(encoder.encode(`%PDF-${version}\n%%EOF\n`)),
        { version },
      );
    }
    for (const invalid of [
      "%PDF-0.9\n%%EOF",
      "%PDF-1.8\n%%EOF",
      "%PDF-2.1\n%%EOF",
      " %PDF-1.7\n%%EOF",
      "\ufeff%PDF-1.7\n%%EOF",
      "%PDF-1.",
      "PK\u0003\u0004%PDF-1.7\n%%EOF",
    ]) {
      assert.throws(
        () => validatePdfEnvelope(encoder.encode(invalid)),
        problem("invalid_pdf_envelope"),
      );
    }
  });

  it("recognizes a header and final marker split across one-byte chunks", () => {
    const bytes = encoder.encode("%PDF-1.7\n1 0 obj\nendobj\n%%EOF\r\n");
    const validator = new IncrementalPdfEnvelopeValidator();
    for (const byte of bytes) validator.push(new Uint8Array([byte]));
    assert.deepEqual(validator.finish(), { version: "1.7" });
    assert.throws(() => validator.finish(), TypeError);
    assert.throws(() => validator.push(new Uint8Array([0])), TypeError);
  });

  it("permits only PDF whitespace after the final EOF marker", () => {
    const accepted = new Uint8Array([
      ...encoder.encode("%PDF-2.0\n%%EOF"),
      0x00,
      0x09,
      0x0a,
      0x0c,
      0x0d,
      0x20,
    ]);
    assert.deepEqual(validatePdfEnvelope(accepted), { version: "2.0" });

    for (const invalid of [
      "%PDF-1.7\nno marker",
      "%PDF-1.7\n%%EOFx",
      "%PDF-1.7\n%%EOF\nPK\u0003\u0004",
      "%PDF-1.7\n%%EOF\n<script>",
    ]) {
      assert.throws(
        () => validatePdfEnvelope(encoder.encode(invalid)),
        (error: unknown) =>
          error instanceof HttpProblem
          && (error.code === "invalid_pdf_envelope" || error.code === "pdf_trailing_data"),
      );
    }
  });

  it("uses the final marker for an incremental-looking update", () => {
    const bytes = encoder.encode(
      "%PDF-1.7\nfirst revision\n%%EOF\nsecond revision\n%%EOF\n",
    );
    assert.deepEqual(validatePdfEnvelope(bytes), { version: "1.7" });
  });

  it("preserves final-marker semantics after the fixed trailer ring wraps", () => {
    const validator = new IncrementalPdfEnvelopeValidator();
    validator.push(encoder.encode("%PDF-1.7\n"));
    validator.push(new Uint8Array(PDF_TRAILER_BUFFER_BYTES + 17).fill(0x61));
    validator.push(encoder.encode("%%"));
    validator.push(encoder.encode("EOF\r\n"));
    assert.deepEqual(validator.finish(), { version: "1.7" });

    const trailing = new IncrementalPdfEnvelopeValidator();
    trailing.push(encoder.encode("%PDF-1.7\n"));
    trailing.push(new Uint8Array(PDF_TRAILER_BUFFER_BYTES + 17).fill(0x61));
    trailing.push(encoder.encode("%%EOF\nX"));
    assert.throws(() => trailing.finish(), problem("pdf_trailing_data"));
  });

  it("requires EOF to remain in the bounded physical trailer window", () => {
    const validator = new IncrementalPdfEnvelopeValidator();
    validator.push(encoder.encode("%PDF-1.7\n%%EOF"));
    validator.push(new Uint8Array(PDF_TRAILER_BUFFER_BYTES + 1).fill(0x20));
    assert.throws(() => validator.finish(), problem("invalid_pdf_envelope"));
  });
});
