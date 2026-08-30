import "server-only";

import { HttpProblem } from "@/server/http/problem";

export const MAX_UPLOAD_DISPLAY_FILENAME_BYTES = 255;
export const PDF_TRAILER_BUFFER_BYTES = 4 * 1024;

const PDF_HEADER_LENGTH = 8;
const PDF_EOF = new Uint8Array([0x25, 0x25, 0x45, 0x4f, 0x46]); // %%EOF
const FORBIDDEN_FILENAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const BIDI_CONTROL_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export type SupportedPdfVersion =
  | "1.0"
  | "1.1"
  | "1.2"
  | "1.3"
  | "1.4"
  | "1.5"
  | "1.6"
  | "1.7"
  | "2.0";

export interface PdfEnvelopeResult {
  version: SupportedPdfVersion;
}

function invalidFilename(): never {
  throw new HttpProblem(
    400,
    "invalid_filename",
    "The upload display filename is invalid.",
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a display-only filename. The returned value is still never safe as
 * a filesystem path, object key, command argument, or response header.
 */
export function normalizeUploadDisplayFilename(value: unknown): string {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    return invalidFilename();
  }
  const normalized = value.normalize("NFC");
  if (
    normalized.length === 0
    || normalized === "."
    || normalized === ".."
    || normalized.endsWith(".")
    || normalized.endsWith(" ")
    || FORBIDDEN_FILENAME_PATTERN.test(normalized)
    || BIDI_CONTROL_PATTERN.test(normalized)
    || Buffer.byteLength(normalized, "utf8") > MAX_UPLOAD_DISPLAY_FILENAME_BYTES
  ) {
    return invalidFilename();
  }

  const firstComponent = normalized.split(".", 1)[0].replace(/[ .]+$/g, "");
  if (WINDOWS_RESERVED_NAME_PATTERN.test(firstComponent)) {
    return invalidFilename();
  }
  return normalized;
}

/** HTTP media types are case-insensitive, but parameters and whitespace are not accepted. */
export function requireExactPdfContentType(value: string | null): "application/pdf" {
  if (value === null || value.toLowerCase() !== "application/pdf") {
    throw new HttpProblem(
      415,
      "unsupported_media_type",
      "The upload body must use exactly application/pdf.",
    );
  }
  return "application/pdf";
}

/**
 * Parse the normalized Fetch header without converting attacker-controlled
 * input to Number. Transport framing must also be validated by the HTTP proxy.
 */
export function parseContentLengthHeader(value: string | null): bigint | null {
  if (value === null) return null;
  if (value.length > 32 || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new HttpProblem(
      400,
      "invalid_content_length",
      "Content-Length must be one canonical decimal byte count.",
    );
  }
  return BigInt(value);
}

function pdfVersion(header: Uint8Array): SupportedPdfVersion | null {
  if (
    header.length !== PDF_HEADER_LENGTH
    || header[0] !== 0x25
    || header[1] !== 0x50
    || header[2] !== 0x44
    || header[3] !== 0x46
    || header[4] !== 0x2d
  ) {
    return null;
  }
  const version = String.fromCharCode(header[5], header[6], header[7]);
  return new Set<string>([
    "1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0",
  ]).has(version)
    ? version as SupportedPdfVersion
    : null;
}

function isPdfWhitespace(byte: number): boolean {
  return byte === 0x00
    || byte === 0x09
    || byte === 0x0a
    || byte === 0x0c
    || byte === 0x0d
    || byte === 0x20;
}

function markerAt(bytes: Uint8Array, index: number): boolean {
  for (let offset = 0; offset < PDF_EOF.length; offset += 1) {
    if (bytes[index + offset] !== PDF_EOF[offset]) return false;
  }
  return true;
}

/**
 * A bounded-memory envelope screen only. Passing this check does not mean a
 * PDF is well formed, malware-free, safe to parse, or safe to serve.
 */
export class IncrementalPdfEnvelopeValidator {
  readonly #header = new Uint8Array(PDF_HEADER_LENGTH);
  readonly #tail = new Uint8Array(PDF_TRAILER_BUFFER_BYTES);
  #headerLength = 0;
  #tailLength = 0;
  #tailWriteIndex = 0;
  #version: SupportedPdfVersion | null = null;
  #finished = false;

  push(chunk: Uint8Array): void {
    if (this.#finished) {
      throw new TypeError("A completed PDF envelope validator cannot accept more bytes.");
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("PDF envelope chunks must be Uint8Array values.");
    }
    if (chunk.byteLength === 0) return;

    if (this.#headerLength < PDF_HEADER_LENGTH) {
      const copied = Math.min(PDF_HEADER_LENGTH - this.#headerLength, chunk.byteLength);
      this.#header.set(chunk.subarray(0, copied), this.#headerLength);
      this.#headerLength += copied;
      if (this.#headerLength === PDF_HEADER_LENGTH) {
        this.#version = pdfVersion(this.#header);
        if (!this.#version) {
          throw new HttpProblem(
            422,
            "invalid_pdf_envelope",
            "The quarantined bytes do not have an accepted PDF envelope.",
          );
        }
      }
    }

    if (chunk.byteLength >= this.#tail.byteLength) {
      this.#tail.set(chunk.subarray(chunk.byteLength - this.#tail.byteLength));
      this.#tailLength = this.#tail.byteLength;
      this.#tailWriteIndex = 0;
      return;
    }

    const firstLength = Math.min(
      chunk.byteLength,
      this.#tail.byteLength - this.#tailWriteIndex,
    );
    this.#tail.set(chunk.subarray(0, firstLength), this.#tailWriteIndex);
    if (firstLength < chunk.byteLength) {
      this.#tail.set(chunk.subarray(firstLength), 0);
    }
    this.#tailWriteIndex = (this.#tailWriteIndex + chunk.byteLength) % this.#tail.byteLength;
    this.#tailLength = Math.min(this.#tail.byteLength, this.#tailLength + chunk.byteLength);
  }

  finish(): PdfEnvelopeResult {
    if (this.#finished) {
      throw new TypeError("A PDF envelope validator can be completed only once.");
    }
    this.#finished = true;
    if (this.#headerLength !== PDF_HEADER_LENGTH || !this.#version) {
      throw new HttpProblem(
        422,
        "invalid_pdf_envelope",
        "The quarantined bytes do not have an accepted PDF envelope.",
      );
    }

    const orderedTail = new Uint8Array(this.#tailLength);
    if (this.#tailLength < this.#tail.byteLength) {
      orderedTail.set(this.#tail.subarray(0, this.#tailLength));
    } else {
      const oldest = this.#tailWriteIndex;
      const firstLength = this.#tail.byteLength - oldest;
      orderedTail.set(this.#tail.subarray(oldest), 0);
      if (oldest > 0) orderedTail.set(this.#tail.subarray(0, oldest), firstLength);
    }

    let eofIndex = -1;
    for (let index = orderedTail.length - PDF_EOF.length; index >= 0; index -= 1) {
      if (markerAt(orderedTail, index)) {
        eofIndex = index;
        break;
      }
    }
    if (eofIndex < 0) {
      throw new HttpProblem(
        422,
        "invalid_pdf_envelope",
        "The quarantined bytes do not have an accepted PDF envelope.",
      );
    }
    for (let index = eofIndex + PDF_EOF.length; index < orderedTail.length; index += 1) {
      if (!isPdfWhitespace(orderedTail[index])) {
        throw new HttpProblem(
          422,
          "pdf_trailing_data",
          "The PDF envelope has unsupported trailing data.",
        );
      }
    }
    return { version: this.#version };
  }
}

export function validatePdfEnvelope(bytes: Uint8Array): PdfEnvelopeResult {
  const validator = new IncrementalPdfEnvelopeValidator();
  validator.push(bytes);
  return validator.finish();
}
