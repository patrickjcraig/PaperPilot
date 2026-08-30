import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { LOCAL_QUARANTINE_STORAGE_VERSION } from "./validation-constants";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface EnsureBrowserUploadIngestReceiptInput {
  organizationId: string;
  uploadSessionId: string;
  documentId: string;
  assetId: string;
  storageVersion?: string;
}

/**
 * Browser receipt IDs intentionally reuse the opaque upload-session ID. This
 * makes historical backfill and crash reconciliation deterministic without
 * turning the upload reservation itself into validation authority.
 */
export function browserUploadIngestReceiptId(uploadSessionId: string): string {
  return uploadSessionId;
}

function browserUploadSourceFingerprint(uploadSessionId: string): string {
  return `upload-session:${uploadSessionId}`;
}

/**
 * Adopt a completed browser transport into the source-neutral custody graph.
 * The caller must already hold the upload's transaction/advisory lock. Every
 * field is derived from tenant-bound database rows; no public payload supplies
 * receipt authority.
 */
export async function ensureBrowserUploadIngestReceipt(
  transaction: Prisma.TransactionClient,
  input: EnsureBrowserUploadIngestReceiptInput,
) {
  const session = await transaction.uploadSession.findFirst({
    where: {
      id: input.uploadSessionId,
      organizationId: input.organizationId,
      documentId: input.documentId,
      assetId: input.assetId,
      status: "STORED",
    },
    include: {
      asset: true,
      document: true,
      intake: true,
      inboxEntry: { select: { id: true, importBatchId: true } },
      attempts: {
        where: { status: "COMMITTED" },
        orderBy: { attemptNumber: "desc" },
        take: 2,
      },
    },
  });
  const committedAttempt = session?.attempts[0] ?? null;
  if (
    !session
    || !session.documentId
    || !session.inboxEntryId
    || !session.inboxEntry
    || session.receivedSizeBytes === null
    || session.receivedSizeBytes < 1n
    || !session.sha256
    || !SHA256_PATTERN.test(session.sha256)
    || !session.storedAt
    || !session.document
    || session.declaredMimeType !== "application/pdf"
    || session.asset.status !== "QUARANTINED"
    || session.asset.storageProvider !== "LOCAL"
    || session.asset.sizeBytes !== session.receivedSizeBytes
    || session.asset.sha256 !== session.sha256
    || session.document.status !== "PENDING"
    || session.document.contentHash !== session.sha256
    || session.intake.id !== session.intakeId
    || session.intake.organizationId !== input.organizationId
    || session.intake.source !== "BROWSER_UPLOAD"
    || session.intake.status !== "QUARANTINED"
    || session.intake.documentId !== input.documentId
    || session.intake.assetId !== input.assetId
    || session.intake.inboxEntryId !== session.inboxEntryId
    || session.intake.importBatchId !== session.inboxEntry.importBatchId
    || session.intake.createdById !== session.createdById
    || session.intake.reservedBytes !== session.expectedSizeBytes
    || session.intake.committedBytes !== session.receivedSizeBytes
    || session.intake.failureCode !== null
    || session.intake.cancelRequestedAt !== null
    || session.intake.cancelledAt !== null
    || session.intake.completedAt !== null
    || session.intake.quotaReleasedAt !== null
    || session.attempts.length > 1
    || (committedAttempt !== null && (
      committedAttempt.organizationId !== input.organizationId
      || committedAttempt.uploadSessionId !== input.uploadSessionId
      || committedAttempt.assetId !== input.assetId
      || committedAttempt.storageKey !== session.asset.objectKey
      || committedAttempt.expectedSizeBytes !== session.expectedSizeBytes
      || committedAttempt.receivedSizeBytes !== session.receivedSizeBytes
      || committedAttempt.sha256 !== session.sha256
      || committedAttempt.storedAt?.getTime() !== session.storedAt.getTime()
      || committedAttempt.completedAt === null
    ))
  ) {
    throw new Error("A completed browser upload could not establish an ingest receipt.");
  }
  const original = await transaction.documentAsset.findFirst({
    where: {
      organizationId: input.organizationId,
      documentId: input.documentId,
      assetId: input.assetId,
      role: "ORIGINAL",
    },
    select: { id: true },
  });
  if (!original) {
    throw new Error("The completed browser upload has no authoritative original asset.");
  }

  const id = browserUploadIngestReceiptId(input.uploadSessionId);
  const existing = await transaction.documentIngestReceipt.findUnique({
    where: { organizationId_id: { organizationId: input.organizationId, id } },
  });
  const storageVersion = input.storageVersion ?? LOCAL_QUARANTINE_STORAGE_VERSION;
  if (existing) {
    if (
      existing.source !== "BROWSER_UPLOAD"
      || existing.sourceFingerprint !== browserUploadSourceFingerprint(input.uploadSessionId)
      || existing.intakeId !== session.intakeId
      || existing.uploadSessionId !== input.uploadSessionId
      || (
        existing.uploadAttemptId !== null
        && existing.uploadAttemptId !== committedAttempt?.id
      )
      || existing.assetId !== input.assetId
      || existing.documentId !== input.documentId
      || existing.inboxEntryId !== session.inboxEntryId
      || existing.importBatchId !== session.inboxEntry.importBatchId
      || existing.receivedSizeBytes !== session.receivedSizeBytes
      || existing.sha256 !== session.sha256
      || existing.declaredMimeType !== session.declaredMimeType
      || existing.storageVersion !== storageVersion
      || existing.storedAt.getTime() !== session.storedAt.getTime()
    ) {
      throw new Error("The browser upload ingest receipt resolved to different custody.");
    }
    return existing;
  }

  return transaction.documentIngestReceipt.create({
    data: {
      id,
      organizationId: input.organizationId,
      source: "BROWSER_UPLOAD",
      sourceFingerprint: browserUploadSourceFingerprint(input.uploadSessionId),
      intakeId: session.intakeId,
      assetId: input.assetId,
      documentId: input.documentId,
      inboxEntryId: session.inboxEntryId,
      importBatchId: session.inboxEntry.importBatchId,
      uploadSessionId: input.uploadSessionId,
      uploadAttemptId: committedAttempt?.id,
      requestedById: session.createdById,
      sourceVersion: session.id,
      sourceChecksumAlgorithm: "sha256",
      sourceChecksum: session.sha256,
      declaredMimeType: session.declaredMimeType,
      receivedSizeBytes: session.receivedSizeBytes,
      sha256: session.sha256,
      storageVersion,
      storedAt: session.storedAt,
      metadata: {
        schemaVersion: 1,
        transport: "authenticated-browser-upload",
        publicAccess: false,
      },
    },
  });
}
