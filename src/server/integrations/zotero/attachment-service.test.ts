import assert from "node:assert/strict";
import test from "node:test";
import { HttpProblem } from "@/server/http/problem";

process.env.DATABASE_URL ??=
  "postgresql://paperpilot_runtime:unit@127.0.0.1:5432/paperpilot_attachment_service_test?sslmode=disable";

const {
  parseQueueZoteroAttachmentImportCommand,
  parseZoteroAttachmentListQuery,
  parseZoteroAttachmentPolicyCommand,
  zoteroAttachmentImportRequestHash,
} = await import("./attachment-service");

const METADATA_HASH = "a".repeat(64);
const PROVIDER_MD5 = "0123456789abcdef0123456789abcdef";

function problem(code: string) {
  return (error: unknown) => error instanceof HttpProblem && error.code === code;
}

test("attachment policy HTTP command is closed and revision-bound", () => {
  assert.deepEqual(parseZoteroAttachmentPolicyCommand({
    mode: "MANUAL",
    expectedRevision: 0,
  }), {
    mode: "MANUAL",
    expectedRevision: 0,
  });
  assert.throws(
    () => parseZoteroAttachmentPolicyCommand({
      mode: "MANUAL",
      expectedRevision: 0,
      autoImport: true,
    }),
    problem("validation"),
  );
  assert.throws(
    () => parseZoteroAttachmentPolicyCommand({ mode: "AUTOMATIC", expectedRevision: 0 }),
    problem("validation"),
  );
  assert.throws(
    () => parseZoteroAttachmentPolicyCommand({ mode: "DISABLED", expectedRevision: -1 }),
    problem("validation"),
  );
});

test("attachment list route query is bounded, single-valued, and explicit", () => {
  assert.deepEqual(parseZoteroAttachmentListQuery(new URLSearchParams()), {
    after: null,
    limit: 50,
    libraryId: null,
    eligibility: null,
    includeDeleted: false,
  });
  assert.deepEqual(parseZoteroAttachmentListQuery(new URLSearchParams({
    after: "attachment:one",
    limit: "25",
    libraryId: "library:one",
    eligibility: "DOWNLOADABLE",
    includeDeleted: "true",
  })), {
    after: "attachment:one",
    limit: 25,
    libraryId: "library:one",
    eligibility: "DOWNLOADABLE",
    includeDeleted: true,
  });
  assert.throws(
    () => parseZoteroAttachmentListQuery(new URLSearchParams("limit=20&limit=30")),
    problem("validation"),
  );
  assert.throws(
    () => parseZoteroAttachmentListQuery(new URLSearchParams("limit=101")),
    problem("validation"),
  );
  assert.throws(
    () => parseZoteroAttachmentListQuery(new URLSearchParams("providerPath=C%3A%5Csecret")),
    problem("validation"),
  );
});

test("manual import HTTP command requires one exact immutable source generation", () => {
  const command = parseQueueZoteroAttachmentImportCommand({
    clientOperationId: "attachment-operation:one",
    expectedPolicyRevision: 3,
    sourceVersion: "42",
    metadataHash: METADATA_HASH,
    providerMd5: PROVIDER_MD5,
  });
  assert.deepEqual(command, {
    clientOperationId: "attachment-operation:one",
    expectedPolicyRevision: 3,
    sourceVersion: "42",
    metadataHash: METADATA_HASH,
    providerMd5: PROVIDER_MD5,
  });
  for (const malformed of [
    { ...command, metadataHash: METADATA_HASH.toUpperCase() },
    { ...command, providerMd5: "f".repeat(31) },
    { ...command, sourceVersion: "42/unsafe" },
    { ...command, signedUrl: "https://example.test/private" },
  ]) {
    assert.throws(
      () => parseQueueZoteroAttachmentImportCommand(malformed),
      problem("validation"),
    );
  }
});

test("manual import request hash binds connection, attachment, policy, and source snapshot", () => {
  const command = parseQueueZoteroAttachmentImportCommand({
    clientOperationId: "operation-one",
    expectedPolicyRevision: 7,
    sourceVersion: "99",
    metadataHash: METADATA_HASH,
    providerMd5: PROVIDER_MD5,
  });
  const baseline = zoteroAttachmentImportRequestHash({
    connectionId: "connection-one",
    attachmentId: "attachment-one",
    command,
  });
  assert.match(baseline, /^[a-f0-9]{64}$/);
  assert.equal(
    baseline,
    zoteroAttachmentImportRequestHash({
      attachmentId: "attachment-one",
      command: { ...command },
      connectionId: "connection-one",
    }),
  );
  assert.notEqual(
    baseline,
    zoteroAttachmentImportRequestHash({
      connectionId: "connection-one",
      attachmentId: "attachment-two",
      command,
    }),
  );
  assert.notEqual(
    baseline,
    zoteroAttachmentImportRequestHash({
      connectionId: "connection-one",
      attachmentId: "attachment-one",
      command: { ...command, expectedPolicyRevision: 8 },
    }),
  );
  assert.notEqual(
    baseline,
    zoteroAttachmentImportRequestHash({
      connectionId: "connection-one",
      attachmentId: "attachment-one",
      command: { ...command, sourceVersion: "100" },
    }),
  );
});
