import "server-only";

import type {
  CrawlerImportStatus,
  Prisma,
  ZoteroAttachmentImportStatus,
} from "@/generated/prisma/client";

const MAX_FAILURE_CODE_BYTES = 100;
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

const ZOTERO_IMPORT_STATUSES = new Set([
  "QUEUED",
  "DOWNLOADING",
  "QUARANTINED",
  "VALIDATING",
  "EXTRACTING",
  "READY",
  "ATTENTION",
  "FAILED",
  "CANCELLED",
]);

const ZOTERO_INBOX_PHASES = new Set([
  "validation",
  "extraction",
  "ready",
  "attention",
  "failed",
]);

const CRAWLER_IMPORT_STATUSES = new Set([
  "QUEUED",
  "FETCHING",
  "QUARANTINED",
  "VALIDATING",
  "EXTRACTING",
  "READY",
  "ATTENTION",
  "FAILED",
  "CANCELLED",
]);

const CRAWLER_INBOX_PHASES = new Set([
  "fetch",
  "validation",
  "extraction",
  "ready",
  "attention",
  "failed",
]);

export type CrawlerInboxLifecyclePhase =
  | "fetch"
  | "validation"
  | "extraction"
  | "ready"
  | "attention"
  | "failed";

export interface CrawlerInboxLifecyclePayload {
  schemaVersion: 1;
  kind: "governed-crawler-import";
  crawlerImportId: string;
  importStatus: CrawlerImportStatus;
  phase: CrawlerInboxLifecyclePhase;
}

export interface DocumentPipelineAuthorityKey {
  organizationId: string;
  intakeId: string;
  documentId: string;
  assetId: string;
  ingestReceiptId: string;
}

export type DocumentPipelineLifecycleProjection =
  | { stage: "validation-claim" }
  | { stage: "validation-retry" }
  | { stage: "validation-accepted" }
  | {
    stage: "validation-failed";
    failureCode: string;
    browserVerification: "rejected" | "unavailable";
  }
  | { stage: "extraction-claim" }
  | { stage: "extraction-retry" }
  | { stage: "extraction-ready" }
  | { stage: "extraction-attention"; failureCode: string };

type LifecycleTransaction = Prisma.TransactionClient;

interface LockedRow {
  id: string;
}

interface JsonRecord {
  [key: string]: Prisma.JsonValue;
}

function jsonRecord(value: Prisma.JsonValue | null): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function boundedFailureCode(value: string): string {
  if (
    Buffer.byteLength(value, "utf8") > MAX_FAILURE_CODE_BYTES
    || !FAILURE_CODE_PATTERN.test(value)
  ) {
    throw new TypeError("A bounded lifecycle failure code is required.");
  }
  return value;
}

/**
 * The Zotero Inbox envelope is intentionally closed. Its provider identity is
 * checked against relational authority and then preserved byte-for-byte; a
 * lifecycle projection may change only importStatus and phase.
 */
export function mergeZoteroAttachmentInboxLifecyclePayload(
  value: Prisma.JsonValue | null,
  expectedAttachmentImportId: string,
  importStatus: string,
  phase: string,
): Prisma.InputJsonObject | null {
  const payload = jsonRecord(value);
  if (
    !payload
    || !exactKeys(
      payload,
      payload.phase === undefined
        ? ["schemaVersion", "kind", "attachmentImportId", "importStatus"]
        : ["schemaVersion", "kind", "attachmentImportId", "importStatus", "phase"],
    )
    || payload.schemaVersion !== 1
    || payload.kind !== "zotero-attachment-import"
    || payload.attachmentImportId !== expectedAttachmentImportId
    || typeof payload.importStatus !== "string"
    || !ZOTERO_IMPORT_STATUSES.has(payload.importStatus)
    || (payload.phase !== undefined && (
      typeof payload.phase !== "string" || !ZOTERO_INBOX_PHASES.has(payload.phase)
    ))
    || !ZOTERO_IMPORT_STATUSES.has(importStatus)
    || !ZOTERO_INBOX_PHASES.has(phase)
  ) return null;

  return {
    schemaVersion: 1,
    kind: payload.kind,
    attachmentImportId: payload.attachmentImportId,
    importStatus,
    phase,
  };
}

/**
 * Preserve the immutable crawler request identity while projecting only the
 * shared pipeline status. Raw source URLs and fetch receipts never enter this
 * client-visible Inbox envelope.
 */
export function crawlerInboxLifecyclePayload(
  value: Prisma.JsonValue | null,
  expectedCrawlerImportId: string,
): CrawlerInboxLifecyclePayload | null {
  const payload = jsonRecord(value);
  if (
    !payload
    || !exactKeys(
      payload,
      ["schemaVersion", "kind", "crawlerImportId", "importStatus", "phase"],
    )
    || payload.schemaVersion !== 1
    || payload.kind !== "governed-crawler-import"
    || payload.crawlerImportId !== expectedCrawlerImportId
    || typeof payload.importStatus !== "string"
    || !CRAWLER_IMPORT_STATUSES.has(payload.importStatus)
    || typeof payload.phase !== "string"
    || !CRAWLER_INBOX_PHASES.has(payload.phase)
  ) return null;

  return {
    schemaVersion: 1,
    kind: "governed-crawler-import",
    crawlerImportId: expectedCrawlerImportId,
    importStatus: payload.importStatus as CrawlerImportStatus,
    phase: payload.phase as CrawlerInboxLifecyclePhase,
  };
}

export function mergeCrawlerInboxLifecyclePayload(
  value: Prisma.JsonValue | null,
  expectedCrawlerImportId: string,
  importStatus: string,
  phase: string,
): Prisma.InputJsonObject | null {
  const payload = crawlerInboxLifecyclePayload(value, expectedCrawlerImportId);
  if (
    !payload
    || !CRAWLER_IMPORT_STATUSES.has(importStatus)
    || !CRAWLER_INBOX_PHASES.has(phase)
  ) return null;

  return {
    ...payload,
    importStatus,
    phase,
  };
}

function mergeBrowserUploadInboxPayload(
  value: Prisma.JsonValue | null,
  projection: DocumentPipelineLifecycleProjection,
): Prisma.InputJsonObject | null {
  const payload = jsonRecord(value);
  if (
    !payload
    || payload.schemaVersion !== 1
    || payload.kind !== "document-upload"
  ) return null;

  if (projection.stage === "validation-claim" || projection.stage === "validation-retry") {
    return {
      schemaVersion: 1,
      kind: "document-upload",
      custody: "quarantined",
      verification: "validating",
    };
  }
  if (
    projection.stage === "validation-accepted"
    || projection.stage === "extraction-claim"
    || projection.stage === "extraction-retry"
  ) {
    return {
      schemaVersion: 1,
      kind: "document-upload",
      custody: "validated",
      verification: "accepted",
    };
  }
  if (projection.stage === "validation-failed") {
    return {
      schemaVersion: 1,
      kind: "document-upload",
      custody: "quarantined",
      verification: projection.browserVerification,
    };
  }
  if (projection.stage === "extraction-ready") {
    return {
      schemaVersion: 1,
      kind: "document-upload",
      custody: "validated",
      verification: "accepted",
      extraction: "ready",
    };
  }
  return {
    schemaVersion: 1,
    kind: "document-upload",
    custody: "validated",
    verification: "accepted",
    extraction: "attention",
  };
}

function desiredLifecycle(projection: DocumentPipelineLifecycleProjection) {
  switch (projection.stage) {
    case "validation-claim":
    case "validation-retry":
      return {
        intakeStatus: "VALIDATING" as const,
        importStatus: "VALIDATING" as const,
        phase: "validation" as const,
        allowedIntakeStatuses: new Set(["QUARANTINED", "VALIDATING"]),
        allowedImportStatuses: new Set(["QUARANTINED", "VALIDATING"]),
        completedAt: null,
        failureCode: null,
        batchStatus: "RUNNING" as const,
        allowedBatchStatuses: new Set(["RUNNING"]),
        allowedInboxStatuses: new Set(["NEEDS_REVIEW"]),
      };
    case "validation-accepted":
    case "extraction-claim":
    case "extraction-retry":
      return {
        intakeStatus: "EXTRACTING" as const,
        importStatus: "EXTRACTING" as const,
        phase: "extraction" as const,
        allowedIntakeStatuses: projection.stage === "validation-accepted"
          ? new Set(["VALIDATING", "EXTRACTING"])
          : new Set(["EXTRACTING", "ATTENTION"]),
        allowedImportStatuses: projection.stage === "validation-accepted"
          ? new Set(["VALIDATING", "EXTRACTING"])
          : new Set(["EXTRACTING", "ATTENTION"]),
        completedAt: null,
        failureCode: null,
        batchStatus: "RUNNING" as const,
        allowedBatchStatuses: projection.stage === "validation-accepted"
          ? new Set(["RUNNING"])
          : new Set(["RUNNING", "PARTIAL"]),
        allowedInboxStatuses: projection.stage === "validation-accepted"
          ? new Set(["NEEDS_REVIEW"])
          : new Set(["NEEDS_REVIEW", "IMPORTED"]),
      };
    case "validation-failed":
      return {
        intakeStatus: "FAILED" as const,
        importStatus: "FAILED" as const,
        phase: "failed" as const,
        allowedIntakeStatuses: new Set(["QUARANTINED", "VALIDATING", "ATTENTION"]),
        allowedImportStatuses: new Set(["QUARANTINED", "VALIDATING", "ATTENTION"]),
        completedAt: "terminal" as const,
        failureCode: boundedFailureCode(projection.failureCode),
        batchStatus: "FAILED" as const,
        allowedBatchStatuses: new Set(["RUNNING"]),
        allowedInboxStatuses: new Set(["PENDING", "NEEDS_REVIEW"]),
      };
    case "extraction-ready":
      return {
        intakeStatus: "READY" as const,
        importStatus: "READY" as const,
        phase: "ready" as const,
        allowedIntakeStatuses: new Set(["EXTRACTING"]),
        allowedImportStatuses: new Set(["EXTRACTING"]),
        completedAt: "terminal" as const,
        failureCode: null,
        batchStatus: "SUCCEEDED" as const,
        allowedBatchStatuses: new Set(["RUNNING"]),
        allowedInboxStatuses: new Set(["NEEDS_REVIEW", "IMPORTED"]),
      };
    case "extraction-attention":
      return {
        intakeStatus: "ATTENTION" as const,
        importStatus: "ATTENTION" as const,
        phase: "attention" as const,
        allowedIntakeStatuses: new Set(["EXTRACTING"]),
        allowedImportStatuses: new Set(["EXTRACTING"]),
        // DocumentIntake ATTENTION is deliberately nonterminal, while the
        // transport-specific Zotero command is terminal until requeued.
        completedAt: "attention" as const,
        failureCode: boundedFailureCode(projection.failureCode),
        batchStatus: "PARTIAL" as const,
        allowedBatchStatuses: new Set(["RUNNING"]),
        allowedInboxStatuses: new Set(["NEEDS_REVIEW", "IMPORTED"]),
      };
  }
}

/**
 * Atomically project the shared downstream lifecycle from one immutable ingest
 * receipt. JSON is never used to select a target; every target is first closed
 * over organization + intake + document + asset + receipt foreign authority.
 */
export async function projectDocumentPipelineLifecycle(
  transaction: LifecycleTransaction,
  key: DocumentPipelineAuthorityKey,
  projection: DocumentPipelineLifecycleProjection,
  now: Date,
): Promise<boolean> {
  if (!validDate(now)) throw new TypeError("A valid lifecycle timestamp is required.");
  const desired = desiredLifecycle(projection);
  const locked = await transaction.$queryRaw<LockedRow[]>`
    SELECT "id"
    FROM "DocumentIngestReceipt"
    WHERE "id" = ${key.ingestReceiptId}
      AND "organizationId" = ${key.organizationId}
      AND "intakeId" = ${key.intakeId}
      AND "documentId" = ${key.documentId}
      AND "assetId" = ${key.assetId}
    FOR UPDATE
  `;
  if (!locked[0]) return false;

  const receipt = await transaction.documentIngestReceipt.findFirst({
    where: {
      id: key.ingestReceiptId,
      organizationId: key.organizationId,
      intakeId: key.intakeId,
      documentId: key.documentId,
      assetId: key.assetId,
    },
    select: {
      id: true,
      source: true,
      intakeId: true,
      documentId: true,
      assetId: true,
      inboxEntryId: true,
      importBatchId: true,
      zoteroAttachmentImportId: true,
      crawlerImportId: true,
    },
  });
  const intake = await transaction.documentIntake.findFirst({
    where: {
      id: key.intakeId,
      organizationId: key.organizationId,
      documentId: key.documentId,
      assetId: key.assetId,
    },
    select: {
      id: true,
      source: true,
      status: true,
      inboxEntryId: true,
      importBatchId: true,
    },
  });
  if (
    !receipt
    || !intake
    || receipt.intakeId !== intake.id
    || receipt.documentId !== key.documentId
    || receipt.assetId !== key.assetId
    || receipt.source !== intake.source
    || receipt.inboxEntryId !== intake.inboxEntryId
    || receipt.importBatchId !== intake.importBatchId
    || !desired.allowedIntakeStatuses.has(intake.status)
  ) return false;

  const inbox = intake.inboxEntryId
    ? await transaction.inboxEntry.findUnique({
      where: {
        organizationId_id: {
          organizationId: key.organizationId,
          id: intake.inboxEntryId,
        },
      },
      select: {
        id: true,
        organizationId: true,
        documentId: true,
        importBatchId: true,
        source: true,
        status: true,
        payload: true,
      },
    })
    : null;
  if (intake.inboxEntryId && (
    !inbox
    || inbox.documentId !== key.documentId
    || inbox.importBatchId !== intake.importBatchId
    || !desired.allowedInboxStatuses.has(inbox.status)
  )) return false;

  const batch = intake.importBatchId
    ? await transaction.importBatch.findUnique({
      where: {
        organizationId_id: {
          organizationId: key.organizationId,
          id: intake.importBatchId,
        },
      },
      select: {
        id: true,
        organizationId: true,
        source: true,
        status: true,
        totalCount: true,
      },
    })
    : null;
  if (intake.importBatchId && (
    !batch
    || batch.totalCount !== 1
    || !desired.allowedBatchStatuses.has(batch.status)
  )) return false;

  let attachmentImport: {
    id: string;
    status: ZoteroAttachmentImportStatus;
  } | null = null;
  let crawlerImport: {
    id: string;
    status: CrawlerImportStatus;
  } | null = null;
  let nextInboxPayload: Prisma.InputJsonObject | null = null;
  if (receipt.source === "ZOTERO_ATTACHMENT") {
    if (
      !receipt.zoteroAttachmentImportId
      || !inbox
      || inbox.source !== "ZOTERO"
      || !batch
      || batch.source !== "ZOTERO"
    ) return false;
    attachmentImport = await transaction.zoteroAttachmentImport.findFirst({
      where: {
        id: receipt.zoteroAttachmentImportId,
        organizationId: key.organizationId,
        intakeId: key.intakeId,
        documentId: key.documentId,
        assetId: key.assetId,
      },
      select: { id: true, status: true },
    });
    if (
      !attachmentImport
      || !desired.allowedImportStatuses.has(attachmentImport.status)
    ) return false;
    nextInboxPayload = mergeZoteroAttachmentInboxLifecyclePayload(
      inbox.payload,
      attachmentImport.id,
      desired.importStatus,
      desired.phase,
    );
    if (!nextInboxPayload) return false;
  } else if (receipt.source === "CRAWLER") {
    if (
      receipt.zoteroAttachmentImportId !== null
      || !receipt.crawlerImportId
      || !inbox
      || inbox.source !== "CRAWLER"
      || !batch
      || batch.source !== "CRAWLER"
    ) return false;
    crawlerImport = await transaction.crawlerImport.findFirst({
      where: {
        id: receipt.crawlerImportId,
        organizationId: key.organizationId,
        intakeId: key.intakeId,
        documentId: key.documentId,
        assetId: key.assetId,
      },
      select: { id: true, status: true },
    });
    if (
      !crawlerImport
      || !desired.allowedImportStatuses.has(crawlerImport.status)
    ) return false;
    nextInboxPayload = mergeCrawlerInboxLifecyclePayload(
      inbox.payload,
      crawlerImport.id,
      desired.importStatus,
      desired.phase,
    );
    if (!nextInboxPayload) return false;
  } else {
    if (
      receipt.zoteroAttachmentImportId !== null
      || receipt.crawlerImportId !== null
    ) return false;
    if (receipt.source === "BROWSER_UPLOAD" && inbox) {
      if (inbox.source !== "FILE_UPLOAD") return false;
      nextInboxPayload = mergeBrowserUploadInboxPayload(inbox.payload, projection);
      if (!nextInboxPayload) return false;
    }
  }

  const intakeCompletedAt = desired.completedAt === "terminal" ? now : null;
  const intakeUpdated = await transaction.documentIntake.updateMany({
    where: {
      id: key.intakeId,
      organizationId: key.organizationId,
      documentId: key.documentId,
      assetId: key.assetId,
      status: intake.status,
    },
    data: {
      status: desired.intakeStatus,
      failureCode: desired.failureCode,
      completedAt: intakeCompletedAt,
    },
  });
  if (intakeUpdated.count !== 1) throw new Error("The document intake lifecycle changed concurrently.");

  if (attachmentImport) {
    const importCompletedAt = desired.completedAt === null ? null : now;
    const importUpdated = await transaction.zoteroAttachmentImport.updateMany({
      where: {
        id: attachmentImport.id,
        organizationId: key.organizationId,
        intakeId: key.intakeId,
        documentId: key.documentId,
        assetId: key.assetId,
        status: attachmentImport.status,
      },
      data: {
        status: desired.importStatus,
        failureCode: desired.failureCode,
        completedAt: importCompletedAt,
      },
    });
    if (importUpdated.count !== 1) {
      throw new Error("The Zotero attachment import lifecycle changed concurrently.");
    }
  }

  if (crawlerImport) {
    const importCompletedAt = desired.completedAt === null ? null : now;
    const importUpdated = await transaction.crawlerImport.updateMany({
      where: {
        id: crawlerImport.id,
        organizationId: key.organizationId,
        intakeId: key.intakeId,
        documentId: key.documentId,
        assetId: key.assetId,
        status: crawlerImport.status,
      },
      data: {
        status: desired.importStatus,
        failureCode: desired.failureCode,
        completedAt: importCompletedAt,
      },
    });
    if (importUpdated.count !== 1) {
      throw new Error("The crawler import lifecycle changed concurrently.");
    }
  }

  if (inbox && nextInboxPayload) {
    const terminalValidation = projection.stage === "validation-failed";
    const attention = projection.stage === "extraction-attention";
    const inboxUpdated = await transaction.inboxEntry.updateMany({
      where: {
        id: inbox.id,
        organizationId: key.organizationId,
        documentId: key.documentId,
        importBatchId: intake.importBatchId,
        status: inbox.status,
      },
      data: {
        payload: nextInboxPayload,
        status: terminalValidation
          ? "FAILED"
          : inbox.status === "IMPORTED"
            ? "IMPORTED"
            : "NEEDS_REVIEW",
        failureCode: terminalValidation || attention ? desired.failureCode : null,
        failureMessage: null,
      },
    });
    if (inboxUpdated.count !== 1) throw new Error("The Inbox lifecycle changed concurrently.");
  }

  if (batch) {
    const terminal = desired.batchStatus !== "RUNNING";
    const batchUpdated = await transaction.importBatch.updateMany({
      where: {
        id: batch.id,
        organizationId: key.organizationId,
        status: batch.status,
        totalCount: 1,
      },
      data: terminal
        ? {
          status: desired.batchStatus,
          processedCount: 1,
          successCount: desired.batchStatus === "SUCCEEDED" ? 1 : 0,
          failureCount: desired.batchStatus === "SUCCEEDED" ? 0 : 1,
          completedAt: now,
        }
        : {
          status: "RUNNING",
          processedCount: 0,
          successCount: 0,
          failureCount: 0,
          completedAt: null,
        },
    });
    if (batchUpdated.count !== 1) throw new Error("The import batch lifecycle changed concurrently.");
  }
  return true;
}
