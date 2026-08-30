import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveLiveRetainedAuditPrincipal } from "@/server/audit/retained-principal";
import { LOCAL_QUARANTINE_STORAGE_VERSION } from "@/server/documents/validation-constants";
import { HttpProblem } from "@/server/http/problem";
import type { UploadConfiguration } from "@/server/uploads/config";
import {
  deleteLocalQuarantineAssetCustody,
  localQuarantineStorageKeyForAttempt,
  localQuarantineStorageAuthority,
  type LocalQuarantineCustodyDeletionProof,
} from "@/server/uploads/storage";
import { acquireWorkspaceMembershipAuthorityShared } from "@/server/workspaces/membership-lock";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";
import {
  parseCrawlerCustodyDeletionCommandV1,
} from "./crawler-deletion-command";
import { protectedCrawlerExtractionIds } from "./crawler-derived-text-policy";
import {
  CRAWLER_SUMMARY_SELECT,
  crawlerSummary,
  type CrawlerRequestSummary,
} from "./crawler-service";

const DELETE_COMMAND = "deleteGovernedCrawlerCustody:v1";
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SERIALIZABLE_ATTEMPTS = 4;
const DELETION_LEASE_MS = 60_000;
const DELETION_RETRY_BASE_MS = 60_000;
const DELETION_RETRY_MAX_MS = 24 * 60 * 60 * 1_000;
const DELETION_PROOF_DOMAIN = "paperpilot:crawler:custody-deletion-proof:v2\u0000";
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface DatabaseClockRow { now: Date }
interface CandidateRow { id: string }

interface CrawlerCustodyDeletionDependencies {
  database?: PrismaClient;
  id?: () => string;
  now?: () => Date;
}

export interface DeleteCrawlerCustodyResult {
  outcome: "applied" | "replayed";
  aggregateVersion: number;
  request: CrawlerRequestSummary;
}

export type CrawlerCustodyDeletionReconcileResult =
  | { outcome: "idle" }
  | { outcome: "deleted"; crawlerImportId: string; deletionProofDigest: string }
  | { outcome: "retrying"; crawlerImportId: string };

interface DeletionAttemptIdentity {
  id: string;
  storageKey: string;
  storageVersion: string;
  storageAuthorityGeneration: string | null;
  sha256: string | null;
}

interface ClaimedDeletion {
  crawlerImportId: string;
  organizationId: string;
  documentId: string;
  assetId: string;
  intakeId: string;
  deletionLeaseId: string;
  deletionAttemptCount: number;
  storageAuthorityGeneration: string | null;
  receiptStorageAuthorityGeneration: string | null | undefined;
  attempts: DeletionAttemptIdentity[];
}

interface DerivedTextRetirement {
  disposition: "NONE" | "PURGED" | "RETAINED_FOR_USER_EVIDENCE";
  purgedChunkCount: number;
  retainedChunkCount: number;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
  return value;
}

function requireCrawlerCustodyDeletionActor(
  role: string,
  userId: string,
  requestedById: string | null,
): void {
  if (
    role === "owner"
    || role === "admin"
    || (role === "member" && requestedById === userId)
  ) return;
  throw new HttpProblem(
    403,
    "crawler_custody_delete_forbidden",
    "You cannot delete custody for this crawler request.",
  );
}

function clockOverride(value: (() => Date) | undefined): Date | null {
  if (!value) return null;
  const now = value();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Crawler custody deletion clock override is invalid.");
  }
  return now;
}

async function authoritativeNow(
  transaction: Prisma.TransactionClient,
  override: Date | null,
): Promise<Date> {
  const [clock] = await transaction.$queryRaw<DatabaseClockRow[]>`
    SELECT COALESCE(CAST(${override} AS timestamptz), clock_timestamp()) AS "now"
  `;
  if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) {
    throw new Error("The database crawler deletion clock is unavailable.");
  }
  return clock.now;
}

function retryableTransactionError(error: unknown): boolean {
  return error instanceof PrismaRuntime.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034");
}

async function runSerializableTransaction<T>(
  database: PrismaClient,
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!retryableTransactionError(error) || attempt === MAX_SERIALIZABLE_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  throw lastError;
}

function replayCrawlerImportId(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || value.schemaVersion !== 1
    || typeof value.crawlerImportId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.crawlerImportId)
  ) return null;
  return value.crawlerImportId;
}

function updateDigestField(hash: ReturnType<typeof createHash>, value: string | null): void {
  const bytes = Buffer.from(value ?? "", "utf8");
  hash.update(Buffer.from(String(bytes.byteLength), "ascii"));
  hash.update("\u0000", "utf8");
  hash.update(bytes);
  hash.update("\u0000", "utf8");
}

/** URL-free, deterministic proof over every immutable local attempt identity. */
export function crawlerCustodyDeletionProofDigest(
  crawlerImportId: string,
  storageAuthorityGeneration: string,
  tombstoneDigest: string,
  attempts: readonly DeletionAttemptIdentity[],
): string {
  if (
    !SHA256_PATTERN.test(storageAuthorityGeneration)
    || !SHA256_PATTERN.test(tombstoneDigest)
  ) throw new TypeError("Crawler deletion storage proof identity is invalid.");
  const hash = createHash("sha256").update(DELETION_PROOF_DOMAIN, "utf8");
  updateDigestField(hash, requireOpaqueId(crawlerImportId, "crawlerImportId"));
  updateDigestField(hash, storageAuthorityGeneration);
  updateDigestField(hash, tombstoneDigest);
  const ordered = [...attempts].sort((left, right) => left.id.localeCompare(right.id));
  updateDigestField(hash, String(ordered.length));
  for (const attempt of ordered) {
    updateDigestField(hash, requireOpaqueId(attempt.id, "ingressAttemptId"));
    updateDigestField(hash, attempt.storageKey);
    updateDigestField(hash, attempt.storageVersion);
    updateDigestField(hash, attempt.storageAuthorityGeneration);
    updateDigestField(hash, attempt.sha256);
  }
  return hash.digest("hex");
}

function deletionRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(20, Math.max(0, attemptCount - 1));
  return Math.min(DELETION_RETRY_MAX_MS, DELETION_RETRY_BASE_MS * (2 ** exponent));
}

function maxDate(now: Date, values: readonly (Date | null)[]): Date {
  let milliseconds = now.getTime();
  for (const value of values) {
    if (value && value.getTime() >= milliseconds) milliseconds = value.getTime() + 1;
  }
  return new Date(milliseconds);
}

async function storedSummary(
  transaction: Prisma.TransactionClient,
  organizationId: string,
  crawlerImportId: string,
) {
  return transaction.crawlerImport.findFirst({
    where: { organizationId, id: crawlerImportId },
    select: CRAWLER_SUMMARY_SELECT,
  });
}

/**
 * Accept one explicit user deletion. Job rows are locked before the crawler
 * authority row, matching worker completion order, so either adoption commits
 * first and is cleaned or deletion wins and every later adoption is fenced.
 */
export async function deleteCrawlerCustody(
  input: {
    userId: string;
    workspaceId: string;
    crawlerImportId: string;
    command: unknown;
    requestId?: string;
  },
  dependencies: CrawlerCustodyDeletionDependencies = {},
): Promise<DeleteCrawlerCustodyResult> {
  const database = dependencies.database ?? prisma;
  const id = dependencies.id ?? randomUUID;
  const override = clockOverride(dependencies.now);
  const userId = requireOpaqueId(input.userId, "userId");
  const workspaceId = requireOpaqueId(input.workspaceId, "workspaceId");
  const crawlerImportId = requireOpaqueId(input.crawlerImportId, "crawlerImportId");
  const parsed = parseCrawlerCustodyDeletionCommandV1(input.command, crawlerImportId);
  const command = parsed.command;

  return runSerializableTransaction(database, async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`crawler-deletion-operation:${workspaceId}:${command.clientOperationId}`}, 0)
      )::text
    `;
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId } },
      include: { organization: { select: { revision: true } } },
    });
    if (!membership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    requireWorkspaceMutationRole(membership.role);

    const prior = await transaction.idempotencyRecord.findUnique({
      where: {
        organizationId_key: {
          organizationId: workspaceId,
          key: command.clientOperationId,
        },
      },
    });
    if (prior) {
      if (
        prior.actorUserId !== userId
        || prior.command !== DELETE_COMMAND
        || prior.requestHash !== parsed.requestHash
      ) {
        throw new HttpProblem(
          409,
          "idempotency_conflict",
          "clientOperationId was already used for a different command.",
        );
      }
      const replayId = replayCrawlerImportId(prior.response);
      const replayed = replayId
        ? await storedSummary(transaction, workspaceId, replayId)
        : null;
      if (!replayed || replayId !== crawlerImportId) {
        throw new HttpProblem(
          409,
          "operation_pending",
          "The prior crawler deletion is still resolving.",
        );
      }
      requireCrawlerCustodyDeletionActor(
        membership.role,
        userId,
        replayed.requestedById,
      );
      return {
        outcome: "replayed" as const,
        aggregateVersion: membership.organization.revision,
        request: crawlerSummary(replayed, { userId, role: membership.role }),
      };
    }

    const targetHint = await transaction.crawlerImport.findFirst({
      where: { organizationId: workspaceId, id: crawlerImportId },
      select: {
        id: true,
        documentId: true,
        assetId: true,
        crawlJobId: true,
      },
    });
    if (!targetHint) {
      throw new HttpProblem(404, "crawler_request_not_found", "Crawler request was not found.");
    }

    await transaction.$queryRaw`
      SELECT "id"
      FROM "Job"
      WHERE "organizationId" = ${workspaceId}
        AND "documentId" = ${targetHint.documentId}
        AND "assetId" = ${targetHint.assetId}
      ORDER BY "id"
      FOR UPDATE
    `;
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "CrawlerImport"
      WHERE "organizationId" = ${workspaceId}
        AND "id" = ${crawlerImportId}
      FOR UPDATE
    `;
    if (!locked[0]) {
      throw new HttpProblem(404, "crawler_request_not_found", "Crawler request was not found.");
    }
    const target = await transaction.crawlerImport.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: workspaceId, id: crawlerImportId } },
      include: {
        intake: { select: { status: true, quotaReleasedAt: true } },
        crawlJob: { select: { id: true } },
      },
    });
    requireCrawlerCustodyDeletionActor(
      membership.role,
      userId,
      target.requestedById,
    );

    if (
      target.deletionClientOperationId === command.clientOperationId
      && target.deletionRequestHash === parsed.requestHash
      && target.deletionRequestedById === userId
    ) {
      const replayed = await storedSummary(transaction, workspaceId, crawlerImportId);
      if (!replayed) throw new Error("The crawler deletion replay could not be loaded.");
      return {
        outcome: "replayed" as const,
        aggregateVersion: membership.organization.revision,
        request: crawlerSummary(replayed, { userId, role: membership.role }),
      };
    }
    if (target.custodyStatus === "DELETE_PENDING") {
      throw new HttpProblem(
        409,
        "crawler_custody_deletion_pending",
        "Crawler custody deletion is already in progress.",
      );
    }
    if (target.custodyStatus === "DELETED") {
      throw new HttpProblem(
        409,
        "crawler_custody_already_deleted",
        "Crawler custody was already deleted.",
      );
    }
    if (membership.organization.revision !== command.expectedVersion) {
      throw new HttpProblem(
        409,
        "version_conflict",
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const bumped = await transaction.organization.updateMany({
      where: { id: workspaceId, revision: command.expectedVersion },
      data: { revision: { increment: 1 } },
    });
    if (bumped.count !== 1) {
      throw new HttpProblem(
        409,
        "version_conflict",
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }
    const principal = await resolveLiveRetainedAuditPrincipal(
      transaction,
      workspaceId,
      userId,
    );
    const now = await authoritativeNow(transaction, override);
    const jobs = await transaction.job.findMany({
      where: {
        organizationId: workspaceId,
        documentId: target.documentId,
        assetId: target.assetId,
      },
      select: { id: true, leaseExpiresAt: true },
    });
    const ingressAttempts = await transaction.documentIngressAttempt.findMany({
      where: {
        organizationId: workspaceId,
        intakeId: target.intakeId,
        documentId: target.documentId,
        assetId: target.assetId,
      },
      select: { leaseExpiresAt: true },
    });
    const deletionAfter = maxDate(now, [
      ...jobs.map((job) => job.leaseExpiresAt),
      ...ingressAttempts.map((attempt) => attempt.leaseExpiresAt),
    ]);

    await transaction.jobAttempt.updateMany({
      where: {
        organizationId: workspaceId,
        jobId: { in: jobs.map((job) => job.id) },
        status: "RUNNING",
      },
      data: { status: "CANCELLED", completedAt: now, errorCode: "crawler_custody_deletion_requested" },
    });
    await transaction.job.updateMany({
      where: {
        organizationId: workspaceId,
        id: { in: jobs.map((job) => job.id) },
        status: { in: ["QUEUED", "RUNNING", "RETRYING"] },
      },
      data: {
        status: "CANCELLED",
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: "crawler_custody_deletion_requested",
        lastErrorMessage: "Crawler custody deletion was requested.",
      },
    });

    const activeLifecycle = [
      "QUEUED",
      "FETCHING",
      "QUARANTINED",
      "VALIDATING",
      "EXTRACTING",
      "ATTENTION",
    ].includes(target.status);
    if (activeLifecycle) {
      await transaction.documentIntake.update({
        where: { organizationId_id: { organizationId: workspaceId, id: target.intakeId } },
        data: {
          status: "CANCELLED",
          failureCode: null,
          cancelRequestedAt: now,
          cancelledAt: now,
          completedAt: now,
        },
      });
      await transaction.importBatch.update({
        where: { organizationId_id: { organizationId: workspaceId, id: target.importBatchId } },
        data: {
          status: "CANCELLED",
          processedCount: 0,
          successCount: 0,
          failureCount: 0,
          completedAt: now,
        },
      });
    }

    await transaction.crawlerImport.update({
      where: { organizationId_id: { organizationId: workspaceId, id: crawlerImportId } },
      data: {
        ...(activeLifecycle
          ? {
              status: "CANCELLED" as const,
              failureCode: null,
              retryAt: null,
              completedAt: now,
              cancelledAt: now,
            }
          : {}),
        canonicalSourceUrl: null,
        custodyStatus: "DELETE_PENDING",
        deletionRequestedById: userId,
        deletionRequestedByPrincipalId: principal.id,
        deletionClientOperationId: command.clientOperationId,
        deletionRequestHash: parsed.requestHash,
        deletionRequestedAt: now,
        deletionAfter,
        deletionFailureCode: null,
      },
    });
    await transaction.document.update({
      where: { organizationId_id: { organizationId: workspaceId, id: target.documentId } },
      data: {
        status: "ARCHIVED",
        sourceUri: null,
        failureCode: null,
        archivedAt: now,
        metadata: {
          schemaVersion: 1,
          custody: "deletion-pending",
          readerAvailable: false,
        },
      },
    });
    await transaction.asset.update({
      where: { organizationId_id: { organizationId: workspaceId, id: target.assetId } },
      data: {
        status: "REJECTED",
        deletedAt: null,
        rejectionCode: "crawler_custody_deletion_pending",
        rejectedReason: "User-directed crawler custody deletion is pending physical proof.",
        metadata: {
          schemaVersion: 1,
          custody: "deletion-pending",
          publicAccess: false,
        },
      },
    });
    await transaction.inboxEntry.update({
      where: { organizationId_id: { organizationId: workspaceId, id: target.inboxEntryId } },
      data: {
        status: "REJECTED",
        sourceUri: null,
        payload: {
          schemaVersion: 1,
          kind: "governed-crawler-import",
          crawlerImportId,
          importStatus: "DELETING",
          phase: "custody-deletion",
        },
        failureCode: "crawler_custody_deletion_requested",
        failureMessage: null,
        resolvedAt: now,
      },
    });
    await transaction.provenanceRecord.updateMany({
      where: {
        organizationId: workspaceId,
        kind: "CRAWL",
        OR: [
          { sourceRecordId: crawlerImportId },
          { documentId: target.documentId },
          { inboxEntryId: target.inboxEntryId },
        ],
      },
      data: {
        sourceUri: null,
        payload: {
          schemaVersion: 1,
          stage: "crawler-custody-deletion-requested",
        },
      },
    });
    await transaction.idempotencyRecord.create({
      data: {
        id: id(),
        organizationId: workspaceId,
        actorUserId: userId,
        key: command.clientOperationId,
        command: DELETE_COMMAND,
        requestHash: parsed.requestHash,
        response: { schemaVersion: 1, crawlerImportId },
        status: "COMPLETED",
        completedAt: now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
    await transaction.auditEvent.create({
      data: {
        id: id(),
        organizationId: workspaceId,
        actorUserId: userId,
        actorPrincipalId: principal.id,
        action: "crawler.custody.deletion-requested",
        entityType: "crawler-import",
        entityId: crawlerImportId,
        requestId: input.requestId ?? command.clientOperationId,
        metadata: {
          retentionPolicy: target.retentionPolicy,
          deletionScheduled: true,
          quotaReleased: target.intake.quotaReleasedAt !== null,
        },
      },
    });

    const summary = await storedSummary(transaction, workspaceId, crawlerImportId);
    if (!summary) throw new Error("The pending crawler deletion could not be loaded.");
    return {
      outcome: "applied" as const,
      aggregateVersion: command.expectedVersion + 1,
      request: crawlerSummary(summary, { userId, role: membership.role }),
    };
  });
}

async function claimCrawlerCustodyDeletion(input: {
  database: PrismaClient;
  crawlerImportId?: string;
  clockOverride: Date | null;
}): Promise<ClaimedDeletion | null> {
  return input.database.$transaction(async (transaction) => {
    const rows = input.crawlerImportId
      ? await transaction.$queryRaw<CandidateRow[]>`
          SELECT crawl."id"
          FROM "CrawlerImport" AS crawl
          WHERE crawl."id" = ${input.crawlerImportId}
            AND crawl."custodyStatus" = 'DELETE_PENDING'
            AND crawl."deletionAfter" <= COALESCE(
              CAST(${input.clockOverride} AS timestamptz), clock_timestamp()
            )
            AND (
              crawl."deletionLeaseExpiresAt" IS NULL
              OR crawl."deletionLeaseExpiresAt" <= COALESCE(
                CAST(${input.clockOverride} AS timestamptz), clock_timestamp()
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM "Job" AS job
              WHERE job."organizationId" = crawl."organizationId"
                AND job."documentId" = crawl."documentId"
                AND job."assetId" = crawl."assetId"
                AND job."status" IN ('QUEUED', 'RUNNING', 'RETRYING')
            )
          FOR UPDATE OF crawl SKIP LOCKED
          LIMIT 1
        `
      : await transaction.$queryRaw<CandidateRow[]>`
          SELECT crawl."id"
          FROM "CrawlerImport" AS crawl
          WHERE crawl."custodyStatus" = 'DELETE_PENDING'
            AND crawl."deletionAfter" <= COALESCE(
              CAST(${input.clockOverride} AS timestamptz), clock_timestamp()
            )
            AND (
              crawl."deletionLeaseExpiresAt" IS NULL
              OR crawl."deletionLeaseExpiresAt" <= COALESCE(
                CAST(${input.clockOverride} AS timestamptz), clock_timestamp()
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM "Job" AS job
              WHERE job."organizationId" = crawl."organizationId"
                AND job."documentId" = crawl."documentId"
                AND job."assetId" = crawl."assetId"
                AND job."status" IN ('QUEUED', 'RUNNING', 'RETRYING')
            )
          ORDER BY crawl."deletionAfter", crawl."deletionRequestedAt", crawl."id"
          FOR UPDATE OF crawl SKIP LOCKED
          LIMIT 1
        `;
    const row = rows[0];
    if (!row) return null;
    const now = await authoritativeNow(transaction, input.clockOverride);
    const target = await transaction.crawlerImport.findUniqueOrThrow({
      where: { id: row.id },
      include: {
        intake: { include: { asset: true } },
        ingestReceipt: true,
      },
    });
    const attempts = await transaction.documentIngressAttempt.findMany({
      where: {
        organizationId: target.organizationId,
        intakeId: target.intakeId,
        documentId: target.documentId,
        assetId: target.assetId,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        storageKey: true,
        storageVersion: true,
        storageAuthorityGeneration: true,
        sha256: true,
        leaseExpiresAt: true,
      },
    });
    if (
      target.intake.asset.storageProvider !== "LOCAL"
      || target.intake.asset.bucket !== "private-quarantine-v1"
      || attempts.some((attempt) => (
        attempt.storageVersion !== LOCAL_QUARANTINE_STORAGE_VERSION
        || attempt.storageKey !== localQuarantineStorageKeyForAttempt(
          { organizationId: target.organizationId, assetId: target.assetId },
          attempt.id,
        )
        || attempt.leaseExpiresAt > now
      ))
    ) {
      return null;
    }
    const attemptKeys = new Set(attempts.map((attempt) => attempt.storageKey));
    if (
      target.ingestReceipt
      && (
        !target.ingestReceipt.ingressAttemptId
        || !attemptKeys.has(target.intake.asset.objectKey)
        || target.intake.asset.objectKey !== target.intake.asset.physicalLocator
      )
    ) return null;
    if (
      !target.ingestReceipt
      && !target.intake.asset.objectKey.startsWith("pending:crawler:")
      && !attemptKeys.has(target.intake.asset.objectKey)
    ) return null;

    const deletionLeaseId = randomUUID();
    const deletionAttemptCount = target.deletionAttemptCount + 1;
    await transaction.crawlerImport.update({
      where: { id: target.id },
      data: {
        deletionLeaseId,
        deletionLeaseExpiresAt: new Date(now.getTime() + DELETION_LEASE_MS),
        deletionAttemptCount,
        deletionFailureCode: null,
      },
    });
    return {
      crawlerImportId: target.id,
      organizationId: target.organizationId,
      documentId: target.documentId,
      assetId: target.assetId,
      intakeId: target.intakeId,
      deletionLeaseId,
      deletionAttemptCount,
      storageAuthorityGeneration: target.storageAuthorityGeneration,
      receiptStorageAuthorityGeneration:
        target.ingestReceipt?.storageAuthorityGeneration,
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        storageKey: attempt.storageKey,
        storageVersion: attempt.storageVersion,
        storageAuthorityGeneration: attempt.storageAuthorityGeneration,
        sha256: attempt.sha256,
      })),
    };
  });
}

/**
 * Remove every generated full-text generation that is not an FK-backed part
 * of user-authored evidence. A referenced generation remains whole so its
 * immutable manifest/content-hash proof continues to validate the excerpt.
 */
async function retireUnneededDerivedText(
  transaction: Prisma.TransactionClient,
  target: {
    organizationId: string;
    documentId: string;
  },
): Promise<DerivedTextRetirement> {
  // FOR UPDATE makes a concurrent EvidenceNote/EvidenceTextAnchor FK insert
  // wait until the disposition commits, instead of racing the dependency read.
  await transaction.$queryRaw`
    SELECT "id"
    FROM "DocumentTextExtraction"
    WHERE "organizationId" = ${target.organizationId}
      AND "documentId" = ${target.documentId}
    ORDER BY "id"
    FOR UPDATE
  `;
  await transaction.$queryRaw`
    SELECT "id"
    FROM "DocumentTextChunk"
    WHERE "organizationId" = ${target.organizationId}
      AND "documentId" = ${target.documentId}
    ORDER BY "id"
    FOR UPDATE
  `;

  const initialChunkCount = await transaction.documentTextChunk.count({
    where: {
      organizationId: target.organizationId,
      documentId: target.documentId,
    },
  });
  const anchoredGenerations = await transaction.evidenceTextAnchor.findMany({
    where: {
      organizationId: target.organizationId,
      documentId: target.documentId,
    },
    select: { extractionId: true },
  });
  const noteReferencedChunks = await transaction.documentTextChunk.findMany({
    where: {
      organizationId: target.organizationId,
      documentId: target.documentId,
      evidenceNotes: { some: {} },
    },
    select: { extractionId: true },
  });
  const protectedExtractionIds = protectedCrawlerExtractionIds({
    anchoredExtractionIds: anchoredGenerations.map((anchor) => anchor.extractionId),
    noteReferencedExtractionIds: noteReferencedChunks.map((chunk) => chunk.extractionId),
  });

  await transaction.documentTextExtraction.deleteMany({
    where: {
      organizationId: target.organizationId,
      documentId: target.documentId,
      ...(protectedExtractionIds.length > 0
        ? { id: { notIn: protectedExtractionIds } }
        : {}),
    },
  });
  // Legacy chunks without an extraction manifest are mutable, but still must
  // be retained when a user EvidenceNote directly references them.
  await transaction.documentTextChunk.deleteMany({
    where: {
      organizationId: target.organizationId,
      documentId: target.documentId,
      extractionId: null,
      evidenceNotes: { none: {} },
    },
  });

  const retainedChunkCount = await transaction.documentTextChunk.count({
    where: {
      organizationId: target.organizationId,
      documentId: target.documentId,
    },
  });
  const purgedChunkCount = initialChunkCount - retainedChunkCount;
  if (purgedChunkCount < 0) {
    throw new Error("Crawler derived-text retirement count is invalid.");
  }
  return {
    disposition: retainedChunkCount > 0
      ? "RETAINED_FOR_USER_EVIDENCE"
      : purgedChunkCount > 0
        ? "PURGED"
        : "NONE",
    purgedChunkCount,
    retainedChunkCount,
  };
}

async function finishCrawlerCustodyDeletion(input: {
  database: PrismaClient;
  claimed: ClaimedDeletion;
  storageProof: LocalQuarantineCustodyDeletionProof | null;
  clockOverride: Date | null;
}): Promise<CrawlerCustodyDeletionReconcileResult> {
  return input.database.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "CrawlerImport"
      WHERE "id" = ${input.claimed.crawlerImportId}
        AND "organizationId" = ${input.claimed.organizationId}
      FOR UPDATE
    `;
    if (!rows[0]) return { outcome: "idle" as const };
    const now = await authoritativeNow(transaction, input.clockOverride);
    const target = await transaction.crawlerImport.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.claimed.organizationId,
          id: input.claimed.crawlerImportId,
        },
      },
      include: {
        ingestReceipt: { select: { storageAuthorityGeneration: true } },
      },
    });
    if (
      target.custodyStatus !== "DELETE_PENDING"
      || target.deletionLeaseId !== input.claimed.deletionLeaseId
      || target.deletionAttemptCount !== input.claimed.deletionAttemptCount
    ) return { outcome: "idle" as const };

    if (!input.storageProof) {
      await transaction.crawlerImport.update({
        where: { id: target.id },
        data: {
          deletionLeaseId: null,
          deletionLeaseExpiresAt: null,
          deletionAfter: new Date(
            now.getTime() + deletionRetryDelayMs(target.deletionAttemptCount),
          ),
          deletionFailureCode: "crawler_custody_deletion_storage_unavailable",
        },
      });
      await transaction.auditEvent.create({
        data: {
          organizationId: target.organizationId,
          actorUserId: target.deletionRequestedById,
          actorPrincipalId: target.deletionRequestedByPrincipalId,
          action: "crawler.custody.deletion-retrying",
          entityType: "crawler-import",
          entityId: target.id,
          metadata: {
            attemptCount: target.deletionAttemptCount,
            quotaReleased: false,
            failureCode: "crawler_custody_deletion_storage_unavailable",
          },
        },
      });
      return { outcome: "retrying" as const, crawlerImportId: target.id };
    }

    const attempts = await transaction.documentIngressAttempt.findMany({
      where: {
        organizationId: target.organizationId,
        intakeId: target.intakeId,
        documentId: target.documentId,
        assetId: target.assetId,
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        storageKey: true,
        storageVersion: true,
        storageAuthorityGeneration: true,
        sha256: true,
        leaseExpiresAt: true,
      },
    });
    const proof = crawlerCustodyDeletionProofDigest(
      target.id,
      input.storageProof.storageAuthorityGeneration,
      input.storageProof.tombstoneDigest,
      attempts,
    );
    const claimedProof = crawlerCustodyDeletionProofDigest(
      input.claimed.crawlerImportId,
      input.storageProof.storageAuthorityGeneration,
      input.storageProof.tombstoneDigest,
      input.claimed.attempts,
    );
    if (
      proof !== claimedProof
      || attempts.length !== input.claimed.attempts.length
      || attempts.some((attempt) => attempt.leaseExpiresAt > now)
      || target.storageAuthorityGeneration !== input.claimed.storageAuthorityGeneration
      || target.ingestReceipt?.storageAuthorityGeneration
        !== input.claimed.receiptStorageAuthorityGeneration
      || (
        target.storageAuthorityGeneration !== null
        && target.storageAuthorityGeneration
          !== input.storageProof.storageAuthorityGeneration
      )
      || attempts.some((attempt) => (
        attempt.storageAuthorityGeneration
          !== input.storageProof!.storageAuthorityGeneration
      ))
      || (
        target.ingestReceipt !== null
        && target.ingestReceipt.storageAuthorityGeneration
          !== input.storageProof.storageAuthorityGeneration
      )
    ) {
      await transaction.crawlerImport.update({
        where: { id: target.id },
        data: {
          deletionLeaseId: null,
          deletionLeaseExpiresAt: null,
          deletionAfter: new Date(now.getTime() + DELETION_RETRY_BASE_MS),
          deletionFailureCode: "crawler_custody_deletion_identity_changed",
        },
      });
      return { outcome: "retrying" as const, crawlerImportId: target.id };
    }

    await transaction.$executeRaw`
      UPDATE "DocumentIngressAttempt"
      SET
        "status" = CASE
          WHEN "status" IN ('RECEIVING', 'WRITTEN') THEN 'ABANDONED'::"DocumentIngressAttemptStatus"
          ELSE "status"
        END,
        "failureCode" = CASE
          WHEN "status" IN ('RECEIVING', 'WRITTEN')
            THEN 'crawler_custody_deletion_requested'
          ELSE "failureCode"
        END,
        "completedAt" = COALESCE("completedAt", ${now}),
        "cleanupCompletedAt" = ${now},
        "cleanupAfter" = NULL,
        "cleanupFailureCode" = NULL,
        "updatedAt" = ${now}
      WHERE "organizationId" = ${target.organizationId}
        AND "intakeId" = ${target.intakeId}
        AND "documentId" = ${target.documentId}
        AND "assetId" = ${target.assetId}
    `;
    const derivedText = await retireUnneededDerivedText(transaction, target);
    await transaction.asset.update({
      where: {
        organizationId_id: {
          organizationId: target.organizationId,
          id: target.assetId,
        },
      },
      data: {
        status: "DELETED",
        objectKey: `deleted:crawler:${target.id}`,
        physicalLocator: null,
        sizeBytes: null,
        sha256: null,
        etag: null,
        rejectionCode: null,
        rejectedReason: null,
        deletedAt: now,
        metadata: {
          schemaVersion: 1,
          custody: "deleted",
          publicAccess: false,
          deletionProofDigest: proof,
          storageAuthorityGeneration:
            input.storageProof.storageAuthorityGeneration,
          deletionTombstoneDigest: input.storageProof.tombstoneDigest,
        },
      },
    });
    await transaction.document.update({
      where: {
        organizationId_id: {
          organizationId: target.organizationId,
          id: target.documentId,
        },
      },
      data: {
        status: "ARCHIVED",
        sourceUri: null,
        contentHash: null,
        failureCode: null,
        archivedAt: target.deletionRequestedAt ?? now,
        metadata: {
          schemaVersion: 1,
          custody: "deleted",
          readerAvailable: false,
        },
      },
    });
    await transaction.documentIntake.update({
      where: {
        organizationId_id: {
          organizationId: target.organizationId,
          id: target.intakeId,
        },
      },
      data: { quotaReleasedAt: now },
    });
    await transaction.inboxEntry.update({
      where: {
        organizationId_id: {
          organizationId: target.organizationId,
          id: target.inboxEntryId,
        },
      },
      data: {
        status: "REJECTED",
        sourceUri: null,
        payload: {
          schemaVersion: 1,
          kind: "governed-crawler-import",
          crawlerImportId: target.id,
          importStatus: "DELETED",
          phase: "custody-deletion",
        },
        failureCode: "crawler_custody_deleted",
        failureMessage: null,
        resolvedAt: now,
      },
    });
    await transaction.provenanceRecord.updateMany({
      where: {
        organizationId: target.organizationId,
        kind: "CRAWL",
        OR: [
          { sourceRecordId: target.id },
          { documentId: target.documentId },
          { inboxEntryId: target.inboxEntryId },
        ],
      },
      data: {
        sourceUri: null,
        payload: {
          schemaVersion: 1,
          stage: "crawler-custody-deleted",
          deletionProofDigest: proof,
        },
      },
    });
    await transaction.crawlerImport.update({
      where: { id: target.id },
      data: {
        custodyStatus: "DELETED",
        deletionAfter: null,
        deletionLeaseId: null,
        deletionLeaseExpiresAt: null,
        deletionFailureCode: null,
        deletionProofDigest: proof,
        deletionStorageAuthorityGeneration:
          input.storageProof.storageAuthorityGeneration,
        deletionTombstoneDigest: input.storageProof.tombstoneDigest,
        derivedTextDisposition: derivedText.disposition,
        derivedTextDisposedAt: now,
        derivedTextPurgedChunkCount: derivedText.purgedChunkCount,
        derivedTextRetainedChunkCount: derivedText.retainedChunkCount,
        deletedAt: now,
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: target.organizationId,
        actorUserId: target.deletionRequestedById,
        actorPrincipalId: target.deletionRequestedByPrincipalId,
        action: "crawler.custody.deleted",
        entityType: "crawler-import",
        entityId: target.id,
        metadata: {
          deletionProofDigest: proof,
          storageAuthorityGeneration:
            input.storageProof.storageAuthorityGeneration,
          deletionTombstoneDigest: input.storageProof.tombstoneDigest,
          objectCount: attempts.length,
          derivedTextDisposition: derivedText.disposition,
          derivedTextPurgedChunkCount: derivedText.purgedChunkCount,
          derivedTextRetainedChunkCount: derivedText.retainedChunkCount,
          quotaReleased: true,
        },
      },
    });
    return {
      outcome: "deleted" as const,
      crawlerImportId: target.id,
      deletionProofDigest: proof,
    };
  });
}

/**
 * Reconcile one scheduled deletion. The filesystem operation is idempotent;
 * database publication is fenced by a short deletion lease and exact digest.
 */
export async function reconcileCrawlerCustodyDeletion(input: {
  configuration: Pick<UploadConfiguration, "quarantineRoot">;
  crawlerImportId?: string;
  now?: Date;
  database?: PrismaClient;
}): Promise<CrawlerCustodyDeletionReconcileResult> {
  const database = input.database ?? prisma;
  const override = input.now === undefined
    ? null
    : clockOverride(() => input.now!);
  const crawlerImportId = input.crawlerImportId === undefined
    ? undefined
    : requireOpaqueId(input.crawlerImportId, "crawlerImportId");
  const claimed = await claimCrawlerCustodyDeletion({
    database,
    crawlerImportId,
    clockOverride: override,
  });
  if (!claimed) return { outcome: "idle" };

  let storageProof: LocalQuarantineCustodyDeletionProof | null = null;
  try {
    const expectedGeneration = claimed.storageAuthorityGeneration
      ?? (claimed.attempts.length === 0
        ? (await localQuarantineStorageAuthority(input.configuration)).generation
        : null);
    if (
      expectedGeneration === null
      || claimed.attempts.some((attempt) => (
        attempt.storageVersion !== LOCAL_QUARANTINE_STORAGE_VERSION
        || attempt.storageAuthorityGeneration !== expectedGeneration
        || attempt.storageKey !== localQuarantineStorageKeyForAttempt(
          { organizationId: claimed.organizationId, assetId: claimed.assetId },
          attempt.id,
        )
      ))
      || (
        claimed.receiptStorageAuthorityGeneration !== undefined
        && claimed.receiptStorageAuthorityGeneration !== expectedGeneration
      )
    ) throw new Error("Crawler storage authority is not deletion-certifiable.");
    storageProof = await deleteLocalQuarantineAssetCustody(
      input.configuration,
      { organizationId: claimed.organizationId, assetId: claimed.assetId },
      expectedGeneration,
    );
  } catch {
    storageProof = null;
  }
  return finishCrawlerCustodyDeletion({
    database,
    claimed,
    storageProof,
    clockOverride: override,
  });
}
