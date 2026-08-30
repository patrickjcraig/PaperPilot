import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  DOCUMENT_VALIDATION_POLICY_VERSION,
  enqueueDocumentValidationJob,
} from "@/server/documents/validation-jobs";
import { uploadConfigurationFromEnvironment, type UploadConfiguration } from "./config";
import {
  localQuarantineStorageKeyForAttempt,
  removeLocalQuarantineAttemptObjects,
} from "./storage";

const DEFAULT_RECONCILE_BATCH_SIZE = 50;
const MAX_RECONCILE_BATCH_SIZE = 200;
const CLEANUP_LEASE_MS = 5 * 60_000;
const CLEANUP_MAX_BACKOFF_MS = 60 * 60_000;

interface CandidateRow {
  id: string;
}

interface CleanupClaim {
  id: string;
  organizationId: string;
  intakeId: string;
  assetId: string;
  storageKey: string;
  storageProvider: string;
  adopted: boolean;
}

export interface UploadReconciliationSummary {
  sessionsInspected: number;
  sessionsExpired: number;
  receiveLeasesReleased: number;
  validationJobsEnqueued: number;
  invalidStoredTargets: number;
  cleanupClaimed: number;
  cleanupCompleted: number;
  cleanupDeferred: number;
}

export interface ReconcileUploadIntakeOptions {
  now?: Date;
  sessionBatchSize?: number;
  jobBatchSize?: number;
  cleanupBatchSize?: number;
  configuration?: Pick<UploadConfiguration, "quarantineRoot">;
}

function requireBatchSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_RECONCILE_BATCH_SIZE;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > MAX_RECONCILE_BATCH_SIZE
  ) throw new TypeError("The reconciliation batch size is invalid.");
  return resolved;
}

function cleanupBackoffMs(attemptCount: number): number {
  return Math.min(
    CLEANUP_MAX_BACKOFF_MS,
    5_000 * (2 ** Math.min(10, Math.max(0, attemptCount - 1))),
  );
}

async function releaseFailedIntakeQuotaWhenClean(
  transaction: Prisma.TransactionClient,
  organizationId: string,
  intakeId: string,
  now: Date,
): Promise<boolean> {
  const intake = await transaction.documentIntake.findFirst({
    where: {
      id: intakeId,
      organizationId,
      source: "BROWSER_UPLOAD",
      status: { in: ["FAILED", "CANCELLED"] },
      quotaReleasedAt: null,
    },
    select: { id: true },
  });
  if (!intake) return false;

  const [retainedUploadAttempts, retainedIngressAttempts] = await Promise.all([
    transaction.uploadAttempt.count({
      where: {
        organizationId,
        uploadSession: { intakeId },
        OR: [
          { status: { in: ["RECEIVING", "WRITTEN", "COMMITTED"] } },
          {
            status: { in: ["FAILED", "ABANDONED"] },
            cleanupCompletedAt: null,
          },
          {
            status: { in: ["FAILED", "ABANDONED"] },
            cleanupFailureCode: "object_adopted",
          },
        ],
      },
    }),
    transaction.documentIngressAttempt.count({
      where: {
        organizationId,
        intakeId,
        OR: [
          { status: { in: ["RECEIVING", "WRITTEN", "ADOPTED"] } },
          {
            status: { in: ["FAILED", "ABANDONED"] },
            cleanupCompletedAt: null,
          },
          {
            status: { in: ["FAILED", "ABANDONED"] },
            cleanupFailureCode: "object_adopted",
          },
        ],
      },
    }),
  ]);
  if (retainedUploadAttempts !== 0 || retainedIngressAttempts !== 0) return false;
  const released = await transaction.documentIntake.updateMany({
    where: {
      id: intakeId,
      organizationId,
      source: "BROWSER_UPLOAD",
      status: { in: ["FAILED", "CANCELLED"] },
      quotaReleasedAt: null,
    },
    data: { quotaReleasedAt: now },
  });
  return released.count === 1;
}

async function reconcileActiveSessions(
  now: Date,
  limit: number,
): Promise<Pick<UploadReconciliationSummary,
  "sessionsInspected" | "sessionsExpired" | "receiveLeasesReleased"
>> {
  return prisma.$transaction(async (transaction) => {
    const candidates = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "UploadSession"
      WHERE (
          "status" IN ('ISSUED', 'RECEIVING')
          AND "expiresAt" <= ${now}
        )
        OR (
          "status" = 'RECEIVING'
          AND "claimExpiresAt" <= ${now}
        )
      ORDER BY LEAST("expiresAt", COALESCE("claimExpiresAt", "expiresAt")), "id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `;
    let sessionsExpired = 0;
    let receiveLeasesReleased = 0;
    for (const candidate of candidates) {
      const session = await transaction.uploadSession.findUnique({
        where: { id: candidate.id },
        include: {
          asset: { select: { id: true, status: true } },
          inboxEntry: { select: { id: true, importBatchId: true } },
          intake: true,
        },
      });
      if (!session || !new Set(["ISSUED", "RECEIVING"]).has(session.status)) continue;
      const intakeStatusMatches = session.status === "ISSUED"
        ? session.intake.status === "RESERVED" || session.intake.status === "RECEIVING"
        : session.intake.status === "RECEIVING";
      if (
        session.intakeId !== session.id
        || session.intake.source !== "BROWSER_UPLOAD"
        || session.intake.documentId !== session.documentId
        || session.intake.assetId !== session.assetId
        || !intakeStatusMatches
      ) continue;
      const expired = session.expiresAt <= now;
      const staleLease = session.status === "RECEIVING"
        && session.claimExpiresAt !== null
        && session.claimExpiresAt <= now;
      if (!expired && !staleLease) continue;

      if (session.claimId) {
        await transaction.uploadAttempt.updateMany({
          where: {
            id: session.claimId,
            organizationId: session.organizationId,
            uploadSessionId: session.id,
            assetId: session.assetId,
            status: { in: ["RECEIVING", "WRITTEN"] },
          },
          data: {
            status: "ABANDONED",
            completedAt: now,
            failureCode: expired ? "session_expired" : "receive_lease_expired",
            cleanupAfter: now,
          },
        });
      }

      if (expired) {
        const failedIntake = await transaction.documentIntake.updateMany({
          where: {
            id: session.intakeId,
            organizationId: session.organizationId,
            source: "BROWSER_UPLOAD",
            status: { in: ["RESERVED", "RECEIVING"] },
            documentId: session.documentId,
            assetId: session.assetId,
          },
          data: {
            status: "FAILED",
            failureCode: "session_expired",
            completedAt: now,
          },
        });
        if (failedIntake.count !== 1) {
          throw new Error("The expiring upload intake changed during reconciliation.");
        }
        await transaction.uploadSession.update({
          where: {
            organizationId_id: {
              organizationId: session.organizationId,
              id: session.id,
            },
          },
          data: {
            status: "EXPIRED",
            claimedAt: null,
            claimExpiresAt: null,
            claimId: null,
            rejectedAt: now,
            failureCode: "session_expired",
          },
        });
        await releaseFailedIntakeQuotaWhenClean(
          transaction,
          session.organizationId,
          session.intakeId,
          now,
        );
        await transaction.asset.updateMany({
          where: {
            id: session.assetId,
            organizationId: session.organizationId,
            status: "UPLOADING",
          },
          data: { status: "REJECTED", rejectionCode: "session_expired" },
        });
        if (session.documentId) {
          await transaction.document.updateMany({
            where: {
              id: session.documentId,
              organizationId: session.organizationId,
              status: { in: ["PENDING", "PROCESSING"] },
            },
            data: { status: "FAILED", failureCode: "session_expired" },
          });
        }
        if (session.inboxEntry) {
          await transaction.inboxEntry.updateMany({
            where: {
              id: session.inboxEntry.id,
              organizationId: session.organizationId,
              status: { in: ["PENDING", "NEEDS_REVIEW"] },
            },
            data: { status: "FAILED", failureCode: "session_expired" },
          });
          if (session.inboxEntry.importBatchId) {
            await transaction.importBatch.updateMany({
              where: {
                id: session.inboxEntry.importBatchId,
                organizationId: session.organizationId,
                status: { in: ["QUEUED", "RUNNING"] },
              },
              data: {
                status: "FAILED",
                processedCount: 1,
                failureCount: 1,
                completedAt: now,
              },
            });
          }
        }
        await transaction.auditEvent.create({
          data: {
            organizationId: session.organizationId,
            action: "upload.session.expired",
            entityType: "upload-session",
            entityId: session.id,
            metadata: { reconciliation: true },
          },
        });
        sessionsExpired += 1;
        continue;
      }

      const receivingIntake = await transaction.documentIntake.updateMany({
        where: {
          id: session.intakeId,
          organizationId: session.organizationId,
          source: "BROWSER_UPLOAD",
          status: "RECEIVING",
          documentId: session.documentId,
          assetId: session.assetId,
          quotaReleasedAt: null,
        },
        data: {
          failureCode: null,
          completedAt: null,
        },
      });
      if (receivingIntake.count !== 1) {
        throw new Error("The upload intake changed while releasing its receive lease.");
      }
      await transaction.uploadSession.update({
        where: {
          organizationId_id: {
            organizationId: session.organizationId,
            id: session.id,
          },
        },
        data: {
          status: "ISSUED",
          claimedAt: null,
          claimExpiresAt: null,
          claimId: null,
        },
      });
      await transaction.auditEvent.create({
        data: {
          organizationId: session.organizationId,
          action: "upload.receive_lease.released",
          entityType: "upload-session",
          entityId: session.id,
          metadata: { reconciliation: true },
        },
      });
      receiveLeasesReleased += 1;
    }
    return {
      sessionsInspected: candidates.length,
      sessionsExpired,
      receiveLeasesReleased,
    };
  });
}

async function reconcileMissingValidationJobs(
  now: Date,
  limit: number,
): Promise<Pick<UploadReconciliationSummary,
  "validationJobsEnqueued" | "invalidStoredTargets"
>> {
  return prisma.$transaction(async (transaction) => {
    const candidates = await transaction.$queryRaw<CandidateRow[]>`
      SELECT upload."id"
      FROM "UploadSession" AS upload
      WHERE upload."status" = 'STORED'
        AND NOT EXISTS (
          SELECT 1
          FROM "Job" AS job
          WHERE job."organizationId" = upload."organizationId"
            AND job."type" = 'DOCUMENT_VALIDATE'
            AND job."dedupeKey" = CONCAT(
              'document-ingest:',
              upload."id",
              ':',
              ${DOCUMENT_VALIDATION_POLICY_VERSION}::text
            )
        )
        AND EXISTS (
          SELECT 1
          FROM "DocumentIntake" AS intake
          WHERE intake."id" = upload."intakeId"
            AND intake."organizationId" = upload."organizationId"
            AND intake."source" = 'BROWSER_UPLOAD'
            AND intake."status" = 'QUARANTINED'
            AND intake."documentId" = upload."documentId"
            AND intake."assetId" = upload."assetId"
            AND intake."quotaReleasedAt" IS NULL
        )
      ORDER BY upload."storedAt", upload."createdAt", upload."id"
      FOR UPDATE OF upload SKIP LOCKED
      LIMIT ${limit}
    `;
    let validationJobsEnqueued = 0;
    let invalidStoredTargets = 0;
    for (const candidate of candidates) {
      const session = await transaction.uploadSession.findUnique({
        where: { id: candidate.id },
        include: {
          asset: true,
          document: true,
          inboxEntry: { select: { id: true, importBatchId: true } },
          intake: true,
        },
      });
      if (
        !session
        || session.status !== "STORED"
        || !session.document
        || session.intakeId !== session.id
        || session.intake.source !== "BROWSER_UPLOAD"
        || session.intake.status !== "QUARANTINED"
        || session.intake.documentId !== session.documentId
        || session.intake.assetId !== session.assetId
        || session.intake.quotaReleasedAt !== null
      ) {
        continue;
      }
      const original = await transaction.documentAsset.findFirst({
        where: {
          organizationId: session.organizationId,
          documentId: session.documentId,
          assetId: session.assetId,
          role: "ORIGINAL",
        },
        select: { id: true },
      });
      const validTarget = original !== null
        && session.asset.status === "QUARANTINED"
        && session.document.status === "PENDING"
        && session.asset.storageProvider === "LOCAL"
        && session.asset.objectKey.startsWith("local-quarantine-v2:")
        && session.asset.physicalLocator === session.asset.objectKey
        && session.asset.sha256 !== null
        && session.asset.sizeBytes !== null
        && session.asset.sizeBytes > 0n
        && session.sha256 === session.asset.sha256
        && session.receivedSizeBytes === session.asset.sizeBytes
        && session.document.contentHash === session.asset.sha256
        && session.intake.committedBytes === session.asset.sizeBytes;
      if (!validTarget) {
        await transaction.uploadAttempt.updateMany({
          where: {
            organizationId: session.organizationId,
            uploadSessionId: session.id,
            assetId: session.assetId,
            status: "COMMITTED",
          },
          data: {
            status: "FAILED",
            completedAt: now,
            failureCode: "integrity_check_failed",
            cleanupAfter: now,
          },
        });
        await transaction.documentIntake.update({
          where: {
            organizationId_id: {
              organizationId: session.organizationId,
              id: session.intakeId,
            },
          },
          data: {
            status: "FAILED",
            failureCode: "integrity_check_failed",
            completedAt: now,
          },
        });
        await transaction.uploadSession.update({
          where: {
            organizationId_id: {
              organizationId: session.organizationId,
              id: session.id,
            },
          },
          data: {
            status: "REJECTED",
            rejectedAt: now,
            failureCode: "integrity_check_failed",
            claimedAt: null,
            claimExpiresAt: null,
            claimId: null,
          },
        });
        await transaction.asset.updateMany({
          where: {
            id: session.assetId,
            organizationId: session.organizationId,
            status: "QUARANTINED",
          },
          data: {
            status: "REJECTED",
            rejectionCode: "integrity_check_failed",
            rejectedReason: "The quarantined object failed a custody integrity check.",
          },
        });
        await transaction.document.updateMany({
          where: {
            id: session.documentId,
            organizationId: session.organizationId,
            status: "PENDING",
          },
          data: { status: "FAILED", failureCode: "integrity_check_failed" },
        });
        if (session.inboxEntry) {
          await transaction.inboxEntry.updateMany({
            where: {
              id: session.inboxEntry.id,
              organizationId: session.organizationId,
              status: "NEEDS_REVIEW",
            },
            data: { status: "FAILED", failureCode: "integrity_check_failed" },
          });
          if (session.inboxEntry.importBatchId) {
            await transaction.importBatch.updateMany({
              where: {
                id: session.inboxEntry.importBatchId,
                organizationId: session.organizationId,
                status: { in: ["QUEUED", "RUNNING"] },
              },
              data: {
                status: "FAILED",
                processedCount: 1,
                successCount: 0,
                failureCount: 1,
                completedAt: now,
              },
            });
          }
        }
        await transaction.auditEvent.create({
          data: {
            organizationId: session.organizationId,
            action: "document.validation.target_rejected",
            entityType: "upload-session",
            entityId: session.id,
            metadata: { failureCode: "integrity_check_failed" },
          },
        });
        invalidStoredTargets += 1;
        continue;
      }
      await enqueueDocumentValidationJob(transaction, {
        organizationId: session.organizationId,
        documentId: session.documentId,
        assetId: session.assetId,
        uploadSessionId: session.id,
        createdById: session.createdById,
        now,
      });
      if (session.inboxEntry) {
        await transaction.inboxEntry.updateMany({
          where: {
            id: session.inboxEntry.id,
            organizationId: session.organizationId,
            status: "NEEDS_REVIEW",
          },
          data: {
            payload: {
              schemaVersion: 1,
              kind: "document-upload",
              custody: "quarantined",
              verification: "queued",
            },
          },
        });
      }
      await transaction.auditEvent.create({
        data: {
          organizationId: session.organizationId,
          action: "document.validation.job_reconciled",
          entityType: "upload-session",
          entityId: session.id,
          metadata: { reconciliation: true },
        },
      });
      validationJobsEnqueued += 1;
    }
    return { validationJobsEnqueued, invalidStoredTargets };
  });
}

async function claimCleanupAttempts(
  now: Date,
  limit: number,
): Promise<CleanupClaim[]> {
  return prisma.$transaction(async (transaction) => {
    const candidates = await transaction.$queryRaw<CandidateRow[]>`
      SELECT attempt."id"
      FROM "UploadAttempt" AS attempt
      WHERE attempt."status" IN ('FAILED', 'ABANDONED')
        AND attempt."cleanupCompletedAt" IS NULL
        AND attempt."cleanupAfter" <= ${now}
      ORDER BY attempt."cleanupAfter", attempt."createdAt", attempt."id"
      FOR UPDATE OF attempt SKIP LOCKED
      LIMIT ${limit}
    `;
    const claims: CleanupClaim[] = [];
    for (const candidate of candidates) {
      const attempt = await transaction.uploadAttempt.findUnique({
        where: { id: candidate.id },
        include: {
          asset: { select: { storageProvider: true, objectKey: true } },
          uploadSession: { select: { status: true, intakeId: true } },
        },
      });
      if (
        !attempt
        || !new Set(["FAILED", "ABANDONED"]).has(attempt.status)
        || attempt.cleanupCompletedAt !== null
        || attempt.cleanupAfter === null
        || attempt.cleanupAfter > now
      ) continue;
      const adopted = attempt.uploadSession.status === "STORED"
        && attempt.asset.objectKey === attempt.storageKey;
      await transaction.uploadAttempt.update({
        where: { id: attempt.id },
        data: {
          cleanupAttemptCount: { increment: 1 },
          cleanupAfter: new Date(now.getTime() + CLEANUP_LEASE_MS),
          cleanupFailureCode: null,
        },
      });
      claims.push({
        id: attempt.id,
        organizationId: attempt.organizationId,
        intakeId: attempt.uploadSession.intakeId,
        assetId: attempt.assetId,
        storageKey: attempt.storageKey,
        storageProvider: attempt.asset.storageProvider,
        adopted,
      });
    }
    return claims;
  });
}

async function finishCleanupClaim(
  claim: CleanupClaim,
  now: Date,
  failureCode: string | null,
): Promise<void> {
  if (failureCode === null || claim.adopted) {
    await prisma.$transaction(async (transaction) => {
      const completed = await transaction.uploadAttempt.updateMany({
        where: {
          id: claim.id,
          organizationId: claim.organizationId,
          assetId: claim.assetId,
          status: { in: ["FAILED", "ABANDONED"] },
          cleanupCompletedAt: null,
        },
        data: {
          cleanupCompletedAt: now,
          cleanupAfter: null,
          cleanupFailureCode: claim.adopted ? "object_adopted" : failureCode,
        },
      });
      if (completed.count === 1) {
        await releaseFailedIntakeQuotaWhenClean(
          transaction,
          claim.organizationId,
          claim.intakeId,
          now,
        );
      }
    });
    return;
  }
  const current = await prisma.uploadAttempt.findUnique({
    where: { id: claim.id },
    select: { cleanupAttemptCount: true },
  });
  if (!current) return;
  await prisma.uploadAttempt.updateMany({
    where: {
      id: claim.id,
      organizationId: claim.organizationId,
      assetId: claim.assetId,
      status: { in: ["FAILED", "ABANDONED"] },
      cleanupCompletedAt: null,
    },
    data: {
      cleanupAfter: new Date(now.getTime() + cleanupBackoffMs(current.cleanupAttemptCount)),
      cleanupFailureCode: failureCode,
    },
  });
}

async function reconcileAttemptCleanup(
  now: Date,
  limit: number,
  configuration: Pick<UploadConfiguration, "quarantineRoot">,
): Promise<Pick<UploadReconciliationSummary,
  "cleanupClaimed" | "cleanupCompleted" | "cleanupDeferred"
>> {
  const claims = await claimCleanupAttempts(now, limit);
  let cleanupCompleted = 0;
  let cleanupDeferred = 0;
  for (const claim of claims) {
    if (claim.adopted) {
      await finishCleanupClaim(claim, now, "object_adopted");
      cleanupCompleted += 1;
      continue;
    }
    if (claim.storageProvider !== "LOCAL") {
      await finishCleanupClaim(claim, now, "unsupported_storage_provider");
      cleanupDeferred += 1;
      continue;
    }
    const expectedKey = localQuarantineStorageKeyForAttempt(
      { organizationId: claim.organizationId, assetId: claim.assetId },
      claim.id,
    );
    if (expectedKey !== claim.storageKey) {
      await finishCleanupClaim(claim, now, "quarantine_identity_mismatch");
      cleanupDeferred += 1;
      continue;
    }
    try {
      await removeLocalQuarantineAttemptObjects(
        configuration,
        { organizationId: claim.organizationId, assetId: claim.assetId },
        claim.id,
      );
      await finishCleanupClaim(claim, now, null);
      cleanupCompleted += 1;
    } catch {
      await finishCleanupClaim(claim, now, "quarantine_cleanup_failed");
      cleanupDeferred += 1;
    }
  }
  return { cleanupClaimed: claims.length, cleanupCompleted, cleanupDeferred };
}

export async function reconcileUploadIntake(
  options: ReconcileUploadIntakeOptions = {},
): Promise<UploadReconciliationSummary> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("The reconciliation time is invalid.");
  const sessionBatchSize = requireBatchSize(options.sessionBatchSize);
  const jobBatchSize = requireBatchSize(options.jobBatchSize);
  const cleanupBatchSize = requireBatchSize(options.cleanupBatchSize);
  const configuration = options.configuration ?? uploadConfigurationFromEnvironment();
  const sessions = await reconcileActiveSessions(now, sessionBatchSize);
  const jobs = await reconcileMissingValidationJobs(now, jobBatchSize);
  const cleanup = await reconcileAttemptCleanup(now, cleanupBatchSize, configuration);
  return { ...sessions, ...jobs, ...cleanup };
}
