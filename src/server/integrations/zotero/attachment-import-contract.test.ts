import assert from "node:assert/strict";
import test from "node:test";
import {
  parseZoteroAttachmentDownloadJobPayload,
  zoteroAttachmentDownloadJobDedupeKey,
  zoteroAttachmentDownloadJobPayload,
  zoteroAttachmentDownloadJobPayloadHash,
} from "./attachment-import-contract";

test("attachment download job payload is minimal, closed, and deterministic", () => {
  const payload = zoteroAttachmentDownloadJobPayload("attachment-import:one");
  assert.deepEqual(payload, {
    schemaVersion: 1,
    attachmentImportId: "attachment-import:one",
  });
  assert.deepEqual(parseZoteroAttachmentDownloadJobPayload(payload), payload);
  assert.equal(
    zoteroAttachmentDownloadJobPayloadHash(payload),
    zoteroAttachmentDownloadJobPayloadHash({
      attachmentImportId: "attachment-import:one",
      schemaVersion: 1,
    }),
  );
  assert.equal(
    zoteroAttachmentDownloadJobDedupeKey("attachment-import:one"),
    "zotero-attachment-download:attachment-import:one",
  );
});

test("attachment download payload parser rejects extra, malformed, and secret fields", () => {
  assert.equal(parseZoteroAttachmentDownloadJobPayload(null), null);
  assert.equal(parseZoteroAttachmentDownloadJobPayload({ schemaVersion: 2, attachmentImportId: "one" }), null);
  assert.equal(parseZoteroAttachmentDownloadJobPayload({ schemaVersion: 1, attachmentImportId: "" }), null);
  assert.equal(parseZoteroAttachmentDownloadJobPayload({
    schemaVersion: 1,
    attachmentImportId: "one",
    accessToken: "must-not-enter-the-queue",
  }), null);
  assert.throws(
    () => zoteroAttachmentDownloadJobPayload("contains spaces"),
    /identifier is invalid/,
  );
});
