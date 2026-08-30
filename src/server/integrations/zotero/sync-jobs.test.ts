import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??=
  "postgresql://paperpilot_runtime:unit@127.0.0.1:5432/paperpilot_sync_jobs_test?sslmode=disable";

const { zoteroAttachmentPersistenceProjection } = await import("./sync-jobs");

const MD5 = "0123456789abcdef0123456789abcdef";

test("downloadable persistence projections are deterministic and contain only sanitized fields", () => {
  const first = zoteroAttachmentPersistenceProjection({
    itemType: "attachment",
    linkMode: "imported_file",
    contentType: "application/pdf",
    filename: "Cafe\u0301.PDF",
    md5: MD5,
    mtime: 1_775_000_123_456,
    parentItem: "ABC12345",
    path: "C:\\Users\\researcher\\Private Study\\paper.pdf",
    signedUrl: "https://storage.invalid/secret-one",
  });
  const reordered = zoteroAttachmentPersistenceProjection({
    signedUrl: "https://storage.invalid/secret-two",
    path: "/Users/researcher/Private Study/paper.pdf",
    parentItem: "ABC12345",
    mtime: "1775000123456",
    md5: MD5,
    filename: "Café.PDF",
    contentType: "application/pdf",
    linkMode: "imported_file",
    itemType: "attachment",
  });

  assert.deepEqual(first, reordered);
  assert.deepEqual(first, {
    parentKey: "ABC12345",
    linkMode: "imported_file",
    contentType: "application/pdf",
    fileName: "Café.PDF",
    providerMd5: MD5,
    providerMtime: "1775000123456",
    eligibility: "DOWNLOADABLE",
    reasonCode: null,
    metadataHash: first.metadataHash,
  });
  assert.match(first.metadataHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /Private Study|storage\.invalid/i);
});

test("ineligible and malformed projections retain only their closed reason identity", () => {
  const linked = zoteroAttachmentPersistenceProjection({
    itemType: "attachment",
    linkMode: "linked_file",
    contentType: "application/pdf",
    filename: "local-only.pdf",
    md5: MD5,
    path: "C:\\Users\\researcher\\Private Study\\local-only.pdf",
  });
  assert.deepEqual(linked, {
    parentKey: null,
    linkMode: null,
    contentType: null,
    fileName: null,
    providerMd5: null,
    providerMtime: null,
    eligibility: "INELIGIBLE",
    reasonCode: "linked_file_not_downloadable",
    metadataHash: linked.metadataHash,
  });
  assert.doesNotMatch(JSON.stringify(linked), /Private Study|local-only\.pdf/i);

  const malformed = zoteroAttachmentPersistenceProjection({
    itemType: "attachment",
    linkMode: "imported_file",
    contentType: "application/pdf",
    filename: "bad-md5.pdf",
    md5: "INVALID",
  });
  assert.equal(malformed.eligibility, "MALFORMED");
  assert.equal(malformed.reasonCode, "invalid_md5");
  assert.equal(malformed.providerMd5, null);
  assert.notEqual(malformed.metadataHash, linked.metadataHash);
});
