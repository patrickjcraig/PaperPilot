import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { HttpProblem } from "@/server/http/problem";
import { MAX_EXTRACTED_CHUNK_COUNT } from "./extraction-contract";

export const READER_CURSOR_VERSION = 1 as const;
export const MAX_READER_CURSOR_BYTES = 512;

const CURSOR_PREFIX = "r1";
const CURSOR_HMAC_DOMAIN = "paperpilot.reader.cursor.r1";
const MIN_CURSOR_SECRET_BYTES = 32;
const MAX_CURSOR_SECRET_BYTES = 4_096;
const MAX_OPAQUE_ID_BYTES = 200;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface ReaderCursorSubject {
  userId: string;
  workspaceId: string;
  paperId: string;
}

export interface ReaderCursorIssueInput {
  generationId: string;
  nextSequence: number;
}

export interface ReaderCursorClaims {
  version: typeof READER_CURSOR_VERSION;
  generationId: string;
  nextSequence: number;
}

export interface ReaderCursorCodecOptions {
  secret: string | Uint8Array;
}

interface SerializedReaderCursorClaims {
  g: string;
  s: number;
  v: typeof READER_CURSOR_VERSION;
}

function invalidCursor(): HttpProblem {
  return new HttpProblem(400, "validation", "Reader query parameters are invalid.");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && utf8Bytes(value) <= MAX_OPAQUE_ID_BYTES
    && OPAQUE_ID_PATTERN.test(value);
}

function validNextSequence(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value < MAX_EXTRACTED_CHUNK_COUNT;
}

function validSubject(value: unknown): value is ReaderCursorSubject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const subject = value as Record<string, unknown>;
  return Object.keys(subject).length === 3
    && validOpaqueId(subject.userId)
    && validOpaqueId(subject.workspaceId)
    && validOpaqueId(subject.paperId);
}

function cursorSecretBytes(value: string | Uint8Array): Buffer {
  let bytes: Buffer;
  if (typeof value === "string") {
    try {
      encodeURIComponent(value);
    } catch {
      throw new TypeError("The Reader cursor secret is invalid.");
    }
    bytes = Buffer.from(value, "utf8");
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    throw new TypeError("A Reader cursor secret is required.");
  }
  if (
    bytes.byteLength < MIN_CURSOR_SECRET_BYTES
    || bytes.byteLength > MAX_CURSOR_SECRET_BYTES
  ) {
    throw new TypeError(
      `The Reader cursor secret must contain between ${MIN_CURSOR_SECRET_BYTES} and ${MAX_CURSOR_SECRET_BYTES} bytes.`,
    );
  }
  return bytes;
}

function encodePayload(payload: SerializedReaderCursorClaims): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw invalidCursor();
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw invalidCursor();
  }
  if (bytes.toString("base64url") !== value) throw invalidCursor();
  return bytes;
}

function parsePayload(encoded: string, bytes: Buffer): SerializedReaderCursorClaims {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidCursor();
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw invalidCursor();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidCursor();
  }
  const claims = value as Record<string, unknown>;
  if (
    Object.keys(claims).sort().join("\u0000") !== "g\u0000s\u0000v"
    || claims.v !== READER_CURSOR_VERSION
    || !validOpaqueId(claims.g)
    || !validNextSequence(claims.s)
  ) {
    throw invalidCursor();
  }

  const canonical: SerializedReaderCursorClaims = {
    g: claims.g,
    s: claims.s,
    v: READER_CURSOR_VERSION,
  };
  if (encodePayload(canonical) !== encoded) throw invalidCursor();
  return canonical;
}

function authenticatedValue(
  tokenWithoutSignature: string,
  subject: ReaderCursorSubject,
): string {
  return [
    CURSOR_HMAC_DOMAIN,
    subject.userId,
    subject.workspaceId,
    subject.paperId,
    tokenWithoutSignature,
  ].join("\u0000");
}

/**
 * Issues and verifies deterministic, generation-bound Reader continuations.
 *
 * A cursor grants no access: verification authenticates its sequence and
 * request binding, while the Reader service must still authorize the caller
 * and prove that the encoded generation remains the current admitted source.
 */
export class ReaderCursorCodec {
  private readonly secret: Buffer;

  constructor(options: ReaderCursorCodecOptions) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Reader cursor options are required.");
    }
    this.secret = cursorSecretBytes(options.secret);
  }

  issue(subject: ReaderCursorSubject, input: ReaderCursorIssueInput): string {
    if (!validSubject(subject)) {
      throw new TypeError("The Reader cursor subject is invalid.");
    }
    if (
      typeof input !== "object"
      || input === null
      || Array.isArray(input)
      || Object.keys(input).length !== 2
      || !validOpaqueId(input.generationId)
      || !validNextSequence(input.nextSequence)
    ) {
      throw new TypeError("The Reader cursor claims are invalid.");
    }

    const payload = encodePayload({
      g: input.generationId,
      s: input.nextSequence,
      v: READER_CURSOR_VERSION,
    });
    const tokenWithoutSignature = `${CURSOR_PREFIX}.${payload}`;
    const signature = createHmac("sha256", this.secret)
      .update(authenticatedValue(tokenWithoutSignature, subject), "utf8")
      .digest("base64url");
    const token = `${tokenWithoutSignature}.${signature}`;
    if (utf8Bytes(token) > MAX_READER_CURSOR_BYTES) {
      throw new TypeError("The Reader cursor claims exceed the encoded limit.");
    }
    return token;
  }

  verify(token: string, subject: ReaderCursorSubject): ReaderCursorClaims {
    if (
      typeof token !== "string"
      || token.length === 0
      || utf8Bytes(token) > MAX_READER_CURSOR_BYTES
      || !validSubject(subject)
    ) {
      throw invalidCursor();
    }

    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) throw invalidCursor();
    const payload = decodeCanonicalBase64Url(parts[1] ?? "");
    const signature = decodeCanonicalBase64Url(parts[2] ?? "");
    if (signature.byteLength !== 32) throw invalidCursor();

    const tokenWithoutSignature = `${CURSOR_PREFIX}.${parts[1]}`;
    const expectedSignature = createHmac("sha256", this.secret)
      .update(authenticatedValue(tokenWithoutSignature, subject), "utf8")
      .digest();
    if (!timingSafeEqual(signature, expectedSignature)) throw invalidCursor();

    const claims = parsePayload(parts[1] ?? "", payload);
    return {
      version: READER_CURSOR_VERSION,
      generationId: claims.g,
      nextSequence: claims.s,
    };
  }
}
