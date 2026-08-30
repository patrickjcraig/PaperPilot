import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { HttpProblem } from "@/server/http/problem";
import {
  MAX_READER_CURSOR_BYTES,
  ReaderCursorCodec,
  type ReaderCursorSubject,
} from "./reader-cursor";

const SECRET = "0123456789abcdef0123456789abcdef";
const SUBJECT: ReaderCursorSubject = {
  userId: "user-one",
  workspaceId: "workspace-one",
  paperId: "paper-one",
};
const CLAIMS = {
  generationId: "generation-one",
  nextSequence: 50,
};

function codec(secret: string | Uint8Array = SECRET): ReaderCursorCodec {
  return new ReaderCursorCodec({ secret });
}

function assertInvalidCursor(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof HttpProblem);
    assert.equal(error.status, 400);
    assert.equal(error.code, "validation");
    assert.equal(error.message, "Reader query parameters are invalid.");
    return true;
  });
}

function signedPayload(payloadBytes: Buffer, subject = SUBJECT): string {
  const encoded = payloadBytes.toString("base64url");
  const tokenWithoutSignature = `r1.${encoded}`;
  const authenticated = [
    "paperpilot.reader.cursor.r1",
    subject.userId,
    subject.workspaceId,
    subject.paperId,
    tokenWithoutSignature,
  ].join("\u0000");
  const signature = createHmac("sha256", SECRET)
    .update(authenticated, "utf8")
    .digest("base64url");
  return `${tokenWithoutSignature}.${signature}`;
}

function signedJson(payload: unknown, subject = SUBJECT): string {
  return signedPayload(Buffer.from(JSON.stringify(payload), "utf8"), subject);
}

test("Reader cursor issuance is deterministic, canonical, bounded, and round-trips", () => {
  const cursorCodec = codec();
  const first = cursorCodec.issue(SUBJECT, CLAIMS);
  const second = cursorCodec.issue(SUBJECT, CLAIMS);

  assert.equal(first, second);
  assert.match(first, /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.ok(Buffer.byteLength(first, "utf8") <= MAX_READER_CURSOR_BYTES);
  assert.deepEqual(cursorCodec.verify(first, SUBJECT), {
    version: 1,
    generationId: CLAIMS.generationId,
    nextSequence: CLAIMS.nextSequence,
  });

  const [, encodedPayload] = first.split(".");
  assert.equal(
    Buffer.from(encodedPayload ?? "", "base64url").toString("utf8"),
    '{"g":"generation-one","s":50,"v":1}',
  );
  assert.equal(first.includes(SUBJECT.userId), false);
  assert.equal(first.includes(SUBJECT.workspaceId), false);
  assert.equal(first.includes(SUBJECT.paperId), false);
});

test("Reader cursors bind the authenticated user, workspace, and paper", () => {
  const cursorCodec = codec();
  const token = cursorCodec.issue(SUBJECT, CLAIMS);

  for (const subject of [
    { ...SUBJECT, userId: "user-other" },
    { ...SUBJECT, workspaceId: "workspace-other" },
    { ...SUBJECT, paperId: "paper-other" },
  ]) {
    assertInvalidCursor(() => cursorCodec.verify(token, subject));
  }
  assert.deepEqual(cursorCodec.verify(token, SUBJECT), {
    version: 1,
    generationId: CLAIMS.generationId,
    nextSequence: CLAIMS.nextSequence,
  });
});

test("Reader cursor version, payload, signature, key, and framing tampering fail closed", () => {
  const cursorCodec = codec();
  const token = cursorCodec.issue(SUBJECT, CLAIMS);
  const [prefix = "", payload = "", signature = ""] = token.split(".");
  const alteredPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
  const alteredSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

  for (const candidate of [
    `r2.${payload}.${signature}`,
    `${prefix}.${alteredPayload}.${signature}`,
    `${prefix}.${payload}.${alteredSignature}`,
    `${token}.extra`,
    `${prefix}.${payload}.%%%`,
    `${prefix}.${payload}.${signature}=`,
    "",
  ]) {
    assertInvalidCursor(() => cursorCodec.verify(candidate, SUBJECT));
  }
  assertInvalidCursor(() => codec("abcdef0123456789abcdef0123456789").verify(token, SUBJECT));
});

test("signed noncanonical or malformed cursor payloads fail closed", () => {
  const cursorCodec = codec();
  const malformed: string[] = [
    signedJson({ g: "generation-one", s: 50, v: 2 }),
    signedJson({ g: "generation-one", s: 50, v: 1, admin: true }),
    signedJson({ g: "generation one", s: 50, v: 1 }),
    signedJson({ g: "generation-one", s: 0, v: 1 }),
    signedJson({ g: "generation-one", s: 4_096, v: 1 }),
    signedJson({ g: "generation-one", s: 1.5, v: 1 }),
    signedJson({ s: 50, g: "generation-one", v: 1 }),
    signedPayload(Buffer.from('{ "g":"generation-one","s":50,"v":1 }', "utf8")),
    signedJson([]),
    signedJson(null),
    signedPayload(Buffer.from([0xc3, 0x28])),
  ];

  for (const token of malformed) {
    assertInvalidCursor(() => cursorCodec.verify(token, SUBJECT));
  }
});

test("Reader cursor verification rejects oversized input before parsing", () => {
  const cursorCodec = codec();
  const oversized = `r1.${"A".repeat(MAX_READER_CURSOR_BYTES)}.${"A".repeat(43)}`;
  assert.ok(Buffer.byteLength(oversized, "utf8") > MAX_READER_CURSOR_BYTES);
  assertInvalidCursor(() => cursorCodec.verify(oversized, SUBJECT));
});

test("Reader cursor configuration and issuance validate secrets, subjects, and claims", () => {
  assert.throws(
    () => new ReaderCursorCodec({ secret: "too-short" }),
    /between 32 and 4096 bytes/,
  );
  assert.throws(
    () => new ReaderCursorCodec({ secret: new Uint8Array(4_097) }),
    /between 32 and 4096 bytes/,
  );
  assert.throws(
    () => new ReaderCursorCodec({ secret: "x".repeat(31) + "\ud800" }),
    /secret is invalid/,
  );
  assert.doesNotThrow(() => new ReaderCursorCodec({ secret: new Uint8Array(32) }));

  const cursorCodec = codec();
  for (const subject of [
    { ...SUBJECT, userId: "unsafe user" },
    { ...SUBJECT, workspaceId: `w${"x".repeat(200)}` },
    { ...SUBJECT, paperId: "" },
  ]) {
    assert.throws(() => cursorCodec.issue(subject, CLAIMS), /subject is invalid/);
    assertInvalidCursor(() => cursorCodec.verify("r1.A.A", subject));
  }

  for (const claims of [
    { ...CLAIMS, generationId: "generation id" },
    { ...CLAIMS, generationId: `g${"x".repeat(200)}` },
    { ...CLAIMS, nextSequence: 0 },
    { ...CLAIMS, nextSequence: 4_096 },
    { ...CLAIMS, nextSequence: Number.NaN },
  ]) {
    assert.throws(() => cursorCodec.issue(SUBJECT, claims), /claims are invalid/);
  }
});

test("Reader cursors are retryable and do not consume server state", () => {
  const cursorCodec = codec();
  const token = cursorCodec.issue(SUBJECT, {
    generationId: "generation-retry",
    nextSequence: 4_095,
  });
  const expected = {
    version: 1 as const,
    generationId: "generation-retry",
    nextSequence: 4_095,
  };

  assert.deepEqual(cursorCodec.verify(token, SUBJECT), expected);
  assert.deepEqual(cursorCodec.verify(token, SUBJECT), expected);
});
