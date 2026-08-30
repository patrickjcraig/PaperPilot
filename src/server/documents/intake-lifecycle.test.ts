import assert from "node:assert/strict";
import test from "node:test";

import {
  crawlerInboxLifecyclePayload,
  mergeCrawlerInboxLifecyclePayload,
  mergeZoteroAttachmentInboxLifecyclePayload,
} from "./intake-lifecycle";

const IMPORT_ID = "attachment-import-01";
const CRAWLER_IMPORT_ID = "crawler-import-01";

test("Zotero Inbox lifecycle preserves relational identity and changes only state", () => {
  const initial = {
    schemaVersion: 1,
    kind: "zotero-attachment-import",
    attachmentImportId: IMPORT_ID,
    importStatus: "QUARANTINED",
  } as const;

  assert.deepEqual(
    mergeZoteroAttachmentInboxLifecyclePayload(
      initial,
      IMPORT_ID,
      "VALIDATING",
      "validation",
    ),
    {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: IMPORT_ID,
      importStatus: "VALIDATING",
      phase: "validation",
    },
  );

  assert.deepEqual(
    mergeZoteroAttachmentInboxLifecyclePayload(
      {
        ...initial,
        importStatus: "VALIDATING",
        phase: "validation",
      },
      IMPORT_ID,
      "EXTRACTING",
      "extraction",
    ),
    {
      schemaVersion: 1,
      kind: "zotero-attachment-import",
      attachmentImportId: IMPORT_ID,
      importStatus: "EXTRACTING",
      phase: "extraction",
    },
  );
});

test("Zotero Inbox lifecycle fails closed on provider identity drift", () => {
  const payload = {
    schemaVersion: 1,
    kind: "zotero-attachment-import",
    attachmentImportId: "different-import",
    importStatus: "QUARANTINED",
  } as const;

  assert.equal(
    mergeZoteroAttachmentInboxLifecyclePayload(
      payload,
      IMPORT_ID,
      "VALIDATING",
      "validation",
    ),
    null,
  );
  assert.equal(
    mergeZoteroAttachmentInboxLifecyclePayload(
      { ...payload, attachmentImportId: IMPORT_ID, kind: "document-upload" },
      IMPORT_ID,
      "VALIDATING",
      "validation",
    ),
    null,
  );
});

test("Zotero Inbox lifecycle rejects open or malformed envelopes", () => {
  const base = {
    schemaVersion: 1,
    kind: "zotero-attachment-import",
    attachmentImportId: IMPORT_ID,
    importStatus: "QUARANTINED",
  } as const;

  assert.equal(
    mergeZoteroAttachmentInboxLifecyclePayload(
      { ...base, signedDownloadUrl: "https://secret.invalid/file" },
      IMPORT_ID,
      "VALIDATING",
      "validation",
    ),
    null,
  );
  assert.equal(
    mergeZoteroAttachmentInboxLifecyclePayload(
      { ...base, importStatus: "UNKNOWN" },
      IMPORT_ID,
      "VALIDATING",
      "validation",
    ),
    null,
  );
  assert.equal(
    mergeZoteroAttachmentInboxLifecyclePayload(
      base,
      IMPORT_ID,
      "READY",
      "not-a-phase",
    ),
    null,
  );
});

test("crawler Inbox lifecycle preserves its relational request identity without URL authority", () => {
  const initial = {
    schemaVersion: 1,
    kind: "governed-crawler-import",
    crawlerImportId: CRAWLER_IMPORT_ID,
    importStatus: "QUEUED",
    phase: "fetch",
  } as const;

  const validating = mergeCrawlerInboxLifecyclePayload(
    initial,
    CRAWLER_IMPORT_ID,
    "VALIDATING",
    "validation",
  );
  assert.deepEqual(validating, {
    schemaVersion: 1,
    kind: "governed-crawler-import",
    crawlerImportId: CRAWLER_IMPORT_ID,
    importStatus: "VALIDATING",
    phase: "validation",
  });
  assert.equal(JSON.stringify(validating).includes("http"), false);
  assert.deepEqual(
    crawlerInboxLifecyclePayload(validating, CRAWLER_IMPORT_ID),
    validating,
  );

  assert.deepEqual(
    mergeCrawlerInboxLifecyclePayload(
      validating,
      CRAWLER_IMPORT_ID,
      "READY",
      "ready",
    ),
    {
      schemaVersion: 1,
      kind: "governed-crawler-import",
      crawlerImportId: CRAWLER_IMPORT_ID,
      importStatus: "READY",
      phase: "ready",
    },
  );
});

test("crawler Inbox lifecycle rejects identity, status, phase, and open-shape drift", () => {
  const base = {
    schemaVersion: 1,
    kind: "governed-crawler-import",
    crawlerImportId: CRAWLER_IMPORT_ID,
    importStatus: "QUARANTINED",
    phase: "validation",
  } as const;
  const variants: unknown[] = [
    { ...base, crawlerImportId: "another-import" },
    { ...base, kind: "document-upload" },
    { ...base, importStatus: "UNKNOWN" },
    { ...base, phase: "network" },
    { ...base, sourceUrl: "https://private.example.test/paper.pdf" },
    { ...base, storageKey: "private/object" },
  ];
  for (const payload of variants) {
    assert.equal(
      mergeCrawlerInboxLifecyclePayload(
        payload as never,
        CRAWLER_IMPORT_ID,
        "VALIDATING",
        "validation",
      ),
      null,
    );
  }
  assert.equal(
    mergeCrawlerInboxLifecyclePayload(
      base,
      CRAWLER_IMPORT_ID,
      "UNKNOWN",
      "validation",
    ),
    null,
  );
  assert.equal(
    mergeCrawlerInboxLifecyclePayload(
      base,
      CRAWLER_IMPORT_ID,
      "READY",
      "network",
    ),
    null,
  );
});
