import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { ZoteroOAuthError } from "./oauth";
import { ZoteroOAuthStateCodec } from "./oauth-state";

const STATE_SECRET = "0123456789abcdef0123456789abcdef";
const ISSUED_AT_MILLISECONDS = 1_700_000_000_123;
const SUBJECT = {
  userId: "user-123",
  organizationId: "workspace-456",
};

function createCodec(
  options: Partial<ConstructorParameters<typeof ZoteroOAuthStateCodec>[0]> = {},
): ZoteroOAuthStateCodec {
  return new ZoteroOAuthStateCodec({
    secret: STATE_SECRET,
    clock: () => ISSUED_AT_MILLISECONDS,
    nonce: () => "deterministic_nonce_1234567890",
    ttlSeconds: 600,
    maxClockSkewSeconds: 30,
    ...options,
  });
}

function assertInvalidState(operation: () => unknown): void {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof ZoteroOAuthError &&
      error.code === "zotero_oauth_invalid_state" &&
      error.status === 400 &&
      error.retryable === false,
  );
}

test("state issuance is deterministic, bounded, and round-trips authenticated claims", () => {
  const codec = createCodec();
  const issued = codec.issue(SUBJECT);

  assert.equal(
    issued.token,
    "v1.eyJ2IjoxLCJzdWIiOiJ1c2VyLTEyMyIsIm9yZyI6IndvcmtzcGFjZS00NTYiLCJuIjoiZGV0ZXJtaW5pc3RpY19ub25jZV8xMjM0NTY3ODkwIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDA2MDB9.tHOiBCnyLb5W6aqt5BL8ZFpiD-eT1tF1dUCOueq4Dn8",
  );
  assert.deepEqual(issued.claims, {
    version: 1,
    userId: "user-123",
    organizationId: "workspace-456",
    nonce: "deterministic_nonce_1234567890",
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_600,
  });
  assert.deepEqual(codec.verify(issued.token, SUBJECT), issued.claims);
});

test("state verification binds the authenticated user and workspace", () => {
  const codec = createCodec();
  const issued = codec.issue(SUBJECT);

  assertInvalidState(() =>
    codec.verify(issued.token, {
      userId: "other-user",
      organizationId: SUBJECT.organizationId,
    }),
  );
  assertInvalidState(() =>
    codec.verify(issued.token, {
      userId: SUBJECT.userId,
      organizationId: "other-workspace",
    }),
  );
});

test("state expires at its exact boundary and tolerates only configured issue-time skew", () => {
  const issuer = createCodec();
  const issued = issuer.issue(SUBJECT);

  const beforeExpiry = createCodec({
    clock: () => (1_700_000_600 - 1) * 1_000,
  });
  assert.deepEqual(beforeExpiry.verify(issued.token, SUBJECT), issued.claims);

  const atExpiry = createCodec({ clock: () => 1_700_000_600 * 1_000 });
  assertInvalidState(() => atExpiry.verify(issued.token, SUBJECT));

  const futureIssuer = createCodec({ clock: () => 1_700_000_031 * 1_000 });
  const futureState = futureIssuer.issue(SUBJECT);
  assertInvalidState(() => issuer.verify(futureState.token, SUBJECT));

  const skewBoundaryIssuer = createCodec({ clock: () => 1_700_000_030 * 1_000 });
  assert.doesNotThrow(() =>
    issuer.verify(skewBoundaryIssuer.issue(SUBJECT).token, SUBJECT),
  );
});

test("payload, signature, version, and signing-key tampering fail closed", () => {
  const codec = createCodec();
  const issued = codec.issue(SUBJECT);
  const [version, payload, signature] = issued.token.split(".");

  const alteredPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
  const alteredSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  for (const token of [
    `v2.${payload}.${signature}`,
    `${version}.${alteredPayload}.${signature}`,
    `${version}.${payload}.${alteredSignature}`,
    `${issued.token}.extra`,
    `${version}.${payload}.%%%`,
    "",
  ]) {
    assertInvalidState(() => codec.verify(token, SUBJECT));
  }

  const otherKeyCodec = createCodec({
    secret: "abcdef0123456789abcdef0123456789",
  });
  assertInvalidState(() => otherKeyCodec.verify(issued.token, SUBJECT));
});

test("signed payloads with extra fields, invalid TTLs, or malformed claims are rejected", () => {
  const signPayload = (payload: unknown): string => {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const authenticated = `v1.${encoded}`;
    const signature = createHmac("sha256", STATE_SECRET)
      .update(authenticated, "utf8")
      .digest("base64url");
    return `v1.${encoded}.${signature}`;
  };

  for (const payload of [
    { v: 1, sub: "user-123", org: "workspace-456", n: "short", iat: 1, exp: 2 },
    {
      v: 1,
      sub: "user-123",
      org: "workspace-456",
      n: "deterministic_nonce_1234567890",
      iat: 1,
      exp: 2,
      admin: true,
    },
    {
      v: 1,
      sub: "user-123",
      org: "workspace-456",
      n: "deterministic_nonce_1234567890",
      iat: 1_700_000_000,
      exp: 1_700_000_901,
    },
    {
      v: 1,
      sub: "user-123",
      org: "workspace-456",
      n: "deterministic_nonce_1234567890",
      iat: 1_700_000_000,
      exp: 1_700_000_000,
    },
    [],
  ]) {
    assertInvalidState(() => createCodec().verify(signPayload(payload), SUBJECT));
  }
});

test("verification authenticates state but does not consume its nonce", () => {
  const codec = createCodec();
  const issued = codec.issue(SUBJECT);

  assert.deepEqual(codec.verify(issued.token, SUBJECT), issued.claims);
  assert.deepEqual(codec.verify(issued.token, SUBJECT), issued.claims);
  // The route/persistence layer must atomically consume claims.nonce exactly once.
});

test("configuration rejects weak secrets, excessive TTLs, invalid IDs, nonce, and clock", () => {
  assert.throws(
    () => new ZoteroOAuthStateCodec({ secret: "too-short" }),
    (error: unknown) =>
      error instanceof ZoteroOAuthError &&
      error.code === "zotero_oauth_invalid_configuration",
  );
  assert.throws(
    () => createCodec({ ttlSeconds: 901 }),
    /between 1 and 900/,
  );
  assert.throws(
    () => createCodec({ maxClockSkewSeconds: 301 }),
    /between 0 and 300/,
  );
  assert.throws(
    () => createCodec({ clock: () => Number.NaN }).issue(SUBJECT),
    /invalid time/,
  );
  assert.throws(
    () => createCodec({ nonce: () => "short" }).issue(SUBJECT),
    /invalid nonce/,
  );
  assert.throws(
    () => codecWithDefaults().issue({ ...SUBJECT, userId: "unsafe\r\nuser" }),
    /user ID is required/,
  );

  function codecWithDefaults(): ZoteroOAuthStateCodec {
    return createCodec();
  }
});

test("oversized and noncanonical state encodings are rejected without parsing", () => {
  const codec = createCodec();
  assertInvalidState(() => codec.verify(`v1.${"A".repeat(5_000)}.AAAA`, SUBJECT));

  const issued = codec.issue(SUBJECT);
  const [version, payload, signature] = issued.token.split(".");
  assertInvalidState(() => codec.verify(`${version}.${payload}.${signature}=`, SUBJECT));
});
