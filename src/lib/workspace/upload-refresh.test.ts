import assert from "node:assert/strict";
import test from "node:test";
import type {
  CrawlerDocumentInboxEntry,
  DocumentUploadInboxEntry,
  DocumentUploadStage,
  DocumentTextExtractionStage,
  InboxEntry,
} from "../types";
import {
  getRefreshableDocumentUploadIds,
  getLatestPaperExtractionStages,
  mergeRefreshedDocumentUploads,
} from "./upload-refresh";

const timestamp = "2026-08-28T12:00:00.000Z";

function uploadEntry(
  uploadId: string,
  stage: DocumentUploadStage,
  extractionStage: DocumentTextExtractionStage = "not-started",
  linkedPaperId?: string,
): DocumentUploadInboxEntry {
  return {
    entryKind: "document-upload",
    id: `inbox:${uploadId}`,
    sourceKind: "upload",
    provenance: {
      id: `provenance:${uploadId}`,
      sourceType: "uploaded-file",
      sourceId: uploadId,
      sourceTitle: `${uploadId}.pdf`,
      providerName: "PaperPilot private quarantine",
      retrievedAt: timestamp,
      accessMethod: "upload",
    },
    status: stage === "ready"
      ? "ready"
      : stage === "failed" || stage === "expired"
        ? "blocked"
        : "processing",
    upload: {
      id: uploadId,
      documentId: `document:${uploadId}`,
      fileName: `${uploadId}.pdf`,
      expectedSizeBytes: 17,
      receivedSizeBytes: 17,
      mediaType: "application/pdf",
      stage,
      extractionStage,
      readerAvailable: linkedPaperId !== undefined && extractionStage === "ready",
      ...(linkedPaperId ? { linkedPaperId } : {}),
      expiresAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function crawlerEntry(
  crawlerId: string,
  extractionStage: DocumentTextExtractionStage,
  linkedPaperId: string,
): CrawlerDocumentInboxEntry {
  return {
    entryKind: "crawler-document",
    id: `inbox:${crawlerId}`,
    sourceKind: "crawler",
    provenance: {
      id: `crawler:${crawlerId}`,
      sourceType: "web-source",
      sourceId: crawlerId,
      sourceTitle: `${crawlerId}.pdf`,
      providerName: "PaperPilot governed crawler",
      retrievedAt: timestamp,
      accessMethod: "crawler",
    },
    status: "ready",
    crawler: {
      id: crawlerId,
      documentId: `document:${crawlerId}`,
      fileName: `${crawlerId}.pdf`,
      mediaType: "application/pdf",
      stage: "ready",
      extractionStage,
      linkedPaperId,
      readerAvailable: extractionStage === "ready",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const paperEntry: InboxEntry = {
  entryKind: "paper",
  id: "inbox:paper",
  sourceKind: "discover",
  paper: {
    id: "paper:one",
    title: "Paper",
    shortTitle: "Paper",
    authors: ["Researcher"],
    year: 2026,
    venue: "Journal",
    type: "journal article",
    abstract: "Abstract",
    abstractSnippet: "Abstract",
    whyRead: "Relevant",
    relevanceScore: 90,
    relevanceTags: [],
    evidenceStrength: "unassessed",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 5,
    identifiers: [],
    isDemoRecord: false,
  },
  provenance: {
    id: "provenance:paper",
    sourceType: "literature-index",
    sourceId: "paper:one",
    sourceTitle: "Paper",
    providerName: "OpenAlex",
    retrievedAt: timestamp,
    accessMethod: "api",
  },
  status: "awaiting-review",
  createdAt: timestamp,
  updatedAt: timestamp,
};

test("validation and active text extraction keep document uploads refreshing", () => {
  const entries = [
    paperEntry,
    uploadEntry("awaiting", "awaiting-bytes"),
    uploadEntry("quarantined", "quarantined"),
    uploadEntry("validating", "validating"),
    uploadEntry("ready", "ready"),
    uploadEntry("queued", "ready", "queued", "paper:queued"),
    uploadEntry("extracting", "ready", "extracting", "paper:extracting"),
    uploadEntry("reader-ready", "ready", "ready", "paper:ready"),
    uploadEntry("no-text", "ready", "no-text", "paper:no-text"),
    uploadEntry("failed", "failed"),
    uploadEntry("expired", "expired"),
  ];

  assert.deepEqual(
    getRefreshableDocumentUploadIds(entries),
    ["quarantined", "validating", "queued", "extracting"],
  );
});

test("status refresh replaces only known document uploads without filing them", () => {
  const quarantined = uploadEntry("one", "quarantined");
  const untouched = uploadEntry("two", "validating");
  const ready = {
    ...uploadEntry("one", "ready"),
    updatedAt: "2026-08-28T12:05:00.000Z",
  };
  const entries = [paperEntry, quarantined, untouched];

  const merged = mergeRefreshedDocumentUploads(entries, [
    ready,
    uploadEntry("not-in-the-inbox", "ready"),
  ]);

  assert.deepEqual(merged.map((entry) => entry.id), entries.map((entry) => entry.id));
  assert.equal(merged[0], paperEntry);
  assert.equal(merged[1], ready);
  assert.equal(merged[2], untouched);
  assert.equal("paper" in merged[1], false);
  assert.equal("destinationProjectId" in merged[1], false);
});

test("Reader stages preserve the newest linked upload for each paper", () => {
  const newest = uploadEntry("newest", "ready", "ready", "paper:one");
  const older = uploadEntry("older", "ready", "failed", "paper:one");
  const other = uploadEntry("other", "ready", "no-text", "paper:two");

  assert.deepEqual(
    getLatestPaperExtractionStages([newest, other, older, paperEntry]),
    {
      "paper:one": "ready",
      "paper:two": "no-text",
    },
  );
});

test("Reader stages include linked governed crawler documents without changing upload polling", () => {
  const crawler = crawlerEntry("crawler-one", "ready", "paper:crawler");
  const upload = uploadEntry("upload-one", "ready", "no-text", "paper:upload");
  assert.deepEqual(getLatestPaperExtractionStages([crawler, upload]), {
    "paper:crawler": "ready",
    "paper:upload": "no-text",
  });
  assert.deepEqual(getRefreshableDocumentUploadIds([crawler, upload]), []);
});
