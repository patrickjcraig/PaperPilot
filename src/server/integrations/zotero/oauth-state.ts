import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { ZoteroOAuthError } from "./oauth";

const STATE_VERSION = 1 as const;
const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 15 * 60;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4 * 1024;
const MAX_ID_BYTES = 512;
const MAX_STATE_TOKEN_BYTES = 4 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
// At least 22 base64url characters are required (132 encoded bits). The
// default source emits 256 random bits.
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,256}$/;

export interface ZoteroOAuthStateSubject {
  userId: string;
  organizationId: string;
}

export interface ZoteroOAuthStateClaims extends ZoteroOAuthStateSubject {
  version: typeof STATE_VERSION;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface IssuedZoteroOAuthState {
  token: string;
  claims: ZoteroOAuthStateClaims;
}

export interface ZoteroOAuthStateCodecOptions {
  /** Independent server secret with at least 256 bits of entropy. */
  secret: string | Uint8Array;
  /** Returns Unix epoch milliseconds. */
  clock?: () => number;
  nonce?: () => string;
  ttlSeconds?: number;
  maxClockSkewSeconds?: number;
}

interface SerializedStateClaims {
  v: typeof STATE_VERSION;
  sub: string;
  org: string;
  n: string;
  iat: number;
  exp: number;
}

function invalidConfiguration(message: string): ZoteroOAuthError {
  return new ZoteroOAuthError(message, {
    code: "zotero_oauth_invalid_configuration",
    status: 500,
    retryable: false,
  });
}

function invalidState(): ZoteroOAuthError {
  return new ZoteroOAuthError("The Zotero OAuth state is invalid or expired.", {
    code: "zotero_oauth_invalid_state",
    status: 400,
    retryable: false,
  });
}

function assertBoundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidConfiguration(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function validatedClockValue(clock: () => number): number {
  let value: number;
  try {
    value = clock();
  } catch {
    throw invalidConfiguration("The Zotero OAuth state clock failed.");
  }
  const seconds = Math.floor(value / 1_000);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(seconds)
  ) {
    throw invalidConfiguration("The Zotero OAuth state clock returned an invalid time.");
  }
  return seconds;
}

function validateId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw invalidConfiguration(`${label} is required.`);
  }
  try {
    encodeURIComponent(value);
  } catch {
    throw invalidConfiguration(`${label} contains invalid Unicode.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) {
    throw invalidConfiguration(`${label} is too long.`);
  }
}

function secretBytes(value: string | Uint8Array): Buffer {
  let bytes: Buffer;
  if (typeof value === "string") {
    try {
      encodeURIComponent(value);
    } catch {
      throw invalidConfiguration("The Zotero OAuth state secret is invalid.");
    }
    bytes = Buffer.from(value, "utf8");
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    throw invalidConfiguration("A Zotero OAuth state secret is required.");
  }

  if (bytes.byteLength < MIN_SECRET_BYTES || bytes.byteLength > MAX_SECRET_BYTES) {
    throw invalidConfiguration(
      `The Zotero OAuth state secret must be between ${MIN_SECRET_BYTES} and ${MAX_SECRET_BYTES} bytes.`,
    );
  }
  return bytes;
}

function encodePayload(payload: SerializedStateClaims): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw invalidState();
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw invalidState();
  }
  if (bytes.toString("base64url") !== value) throw invalidState();
  return bytes;
}

function parsePayload(value: string): SerializedStateClaims {
  const bytes = decodeCanonicalBase64Url(value);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidState();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw invalidState();
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw invalidState();
  }

  const record = payload as Record<string, unknown>;
  const expectedKeys = ["exp", "iat", "n", "org", "sub", "v"];
  if (
    Object.keys(record).sort().join("\u0000") !== expectedKeys.join("\u0000") ||
    record.v !== STATE_VERSION ||
    typeof record.sub !== "string" ||
    typeof record.org !== "string" ||
    typeof record.n !== "string" ||
    !NONCE_PATTERN.test(record.n) ||
    !Number.isSafeInteger(record.iat) ||
    !Number.isSafeInteger(record.exp)
  ) {
    throw invalidState();
  }

  if (
    record.sub.length === 0 ||
    record.org.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(record.sub) ||
    CONTROL_CHARACTER_PATTERN.test(record.org) ||
    Buffer.byteLength(record.sub, "utf8") > MAX_ID_BYTES ||
    Buffer.byteLength(record.org, "utf8") > MAX_ID_BYTES
  ) {
    throw invalidState();
  }

  return record as unknown as SerializedStateClaims;
}

/**
 * Issues and verifies integrity-protected, short-lived OAuth callback state.
 * The claims are authenticated but intentionally not encrypted. Persistence
 * must still bind the nonce to the temporary token and atomically consume it.
 */
export class ZoteroOAuthStateCodec {
  private readonly secret: Buffer;
  private readonly clock: () => number;
  private readonly nonce: () => string;
  private readonly ttlSeconds: number;
  private readonly maxClockSkewSeconds: number;

  constructor(options: ZoteroOAuthStateCodecOptions) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw invalidConfiguration("Zotero OAuth state options are required.");
    }
    const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const maxClockSkewSeconds =
      options.maxClockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    assertBoundedInteger(ttlSeconds, "The Zotero OAuth state TTL", 1, MAX_TTL_SECONDS);
    assertBoundedInteger(
      maxClockSkewSeconds,
      "The Zotero OAuth state clock skew",
      0,
      MAX_CLOCK_SKEW_SECONDS,
    );
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw invalidConfiguration("The Zotero OAuth state clock is invalid.");
    }
    if (options.nonce !== undefined && typeof options.nonce !== "function") {
      throw invalidConfiguration("The Zotero OAuth state nonce source is invalid.");
    }

    this.secret = secretBytes(options.secret);
    this.clock = options.clock ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(32).toString("base64url"));
    this.ttlSeconds = ttlSeconds;
    this.maxClockSkewSeconds = maxClockSkewSeconds;
  }

  issue(subject: ZoteroOAuthStateSubject): IssuedZoteroOAuthState {
    if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
      throw invalidConfiguration("A Zotero OAuth state subject is required.");
    }
    validateId(subject.userId, "A Zotero OAuth state user ID");
    validateId(subject.organizationId, "A Zotero OAuth state workspace ID");
    const issuedAt = validatedClockValue(this.clock);

    let nonce: string;
    try {
      nonce = this.nonce();
    } catch {
      throw invalidConfiguration("The Zotero OAuth state nonce source failed.");
    }
    if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
      throw invalidConfiguration("The Zotero OAuth state nonce source returned an invalid nonce.");
    }

    const serialized: SerializedStateClaims = {
      v: STATE_VERSION,
      sub: subject.userId,
      org: subject.organizationId,
      n: nonce,
      iat: issuedAt,
      exp: issuedAt + this.ttlSeconds,
    };
    const payload = encodePayload(serialized);
    const authenticated = `v1.${payload}`;
    const signature = createHmac("sha256", this.secret)
      .update(authenticated, "utf8")
      .digest("base64url");

    return {
      token: `${authenticated}.${signature}`,
      claims: {
        version: STATE_VERSION,
        userId: serialized.sub,
        organizationId: serialized.org,
        nonce: serialized.n,
        issuedAt: serialized.iat,
        expiresAt: serialized.exp,
      },
    };
  }

  verify(
    token: string,
    expectedSubject: ZoteroOAuthStateSubject,
  ): ZoteroOAuthStateClaims {
    if (
      typeof expectedSubject !== "object" ||
      expectedSubject === null ||
      Array.isArray(expectedSubject)
    ) {
      throw invalidConfiguration("A Zotero OAuth state subject is required.");
    }
    validateId(expectedSubject.userId, "A Zotero OAuth state user ID");
    validateId(expectedSubject.organizationId, "A Zotero OAuth state workspace ID");
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      Buffer.byteLength(token, "utf8") > MAX_STATE_TOKEN_BYTES
    ) {
      throw invalidState();
    }

    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw invalidState();
    const signature = decodeCanonicalBase64Url(parts[2]);
    if (signature.byteLength !== 32) throw invalidState();

    const authenticated = `${parts[0]}.${parts[1]}`;
    const expectedSignature = createHmac("sha256", this.secret)
      .update(authenticated, "utf8")
      .digest();
    if (!timingSafeEqual(signature, expectedSignature)) throw invalidState();

    const payload = parsePayload(parts[1]);
    const now = validatedClockValue(this.clock);
    if (
      payload.sub !== expectedSubject.userId ||
      payload.org !== expectedSubject.organizationId ||
      payload.iat > now + this.maxClockSkewSeconds ||
      payload.exp <= now ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > MAX_TTL_SECONDS
    ) {
      throw invalidState();
    }

    return {
      version: STATE_VERSION,
      userId: payload.sub,
      organizationId: payload.org,
      nonce: payload.n,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  }
}
