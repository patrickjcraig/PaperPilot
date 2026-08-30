import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  JobStatus,
  Prisma,
  type PrismaClient,
  type ZoteroObjectType,
  type ZoteroSyncRun,
} from "@/generated/prisma/client";
import type { StoredImportSnapshot } from "@/server/workspaces/import-dto";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { acquireWorkspaceMembershipAuthorityShared } from "@/server/workspaces/membership-lock";
import { requireWorkspaceIntegrationRole } from "./oauth-service";
import {
  normalizeZoteroItemForSync,
  zoteroContentHash,
} from "./normalization";
import { projectZoteroAttachment } from "./attachment-projection";
import { normalizeZoteroItemKey, toZoteroVersion } from "./protocol";
import type { ZoteroVersion } from "./contracts";

export const DEFAULT_ZOTERO_SYNC_LEASE_TTL_MS = 60_000;
export const DEFAULT_ZOTERO_SYNC_CADENCE_MS = 15 * 60_000;
const MAX_LEASE_TTL_MS = 15 * 60_000;
const MAX_WORKER_ID_BYTES = 200;
const MAX_TRANSACTION_ATTEMPTS = 4;
const MAX_CLAIM_LOOPS = 8;
const MAX_SELECTED_LIBRARIES_PER_TRIGGER = 500;
const MAX_SCHEDULE_BATCH = 100;
const ACTIVE_JOB_STATUSES = new Set<JobStatus>([
  "QUEUED",
  "RETRYING",
  "RUNNING",
]);
const AUTO_SCHEDULE_BLOCKED_JOB_STATUSES = new Set<JobStatus>([
  "FAILED",
  "CANCELLED",
  "DEAD_LETTER",
]);
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];
const OPAQUE_ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const PUBLIC_SYNC_ERROR_CODES = new Set([
  "zotero_authentication_failed",
  "zotero_forbidden",
  "zotero_credential_unavailable",
  "zotero_unavailable",
  "zotero_bad_response",
  "zotero_invalid_request",
  "zotero_not_found",
  "zotero_rate_limited",
  "zotero_timeout",
  "zotero_sync_resource_limit",
  "stable_version_changed",
  "internal_error",
]);

class ZoteroSyncCommitLeaseLostError extends Error {
  constructor() {
    super("The Zotero sync lease changed during atomic publication.");
    this.name = "ZoteroSyncCommitLeaseLostError";
  }
}

export interface ZoteroSyncRunSummary {
  id: string;
  status:
    | "QUEUED"
    | "RUNNING"
    | "SUCCEEDED"
    | "PARTIAL"
    | "FAILED"
    | "CANCELLED"
    | "BACKING_OFF";
  fromVersion: string | null;
  toVersion: string | null;
  objectsRead: number;
  objectsWritten: number;
  objectsDeleted: number;
  backoffUntil: string | null;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface QueueZoteroSyncResult {
  outcome: "queued" | "coalesced";
  queuedCount: number;
  coalescedCount: number;
  runs: ZoteroSyncRunSummary[];
}

interface ZoteroSyncJobPayload {
  schemaVersion: 1;
  runId: string;
  reason: "manual" | "scheduled" | "stream";
}

export interface ZoteroSyncLease {
  organizationId: string;
  connectionId: string;
  externalAccountId: string;
  connectionUpdatedAt: Date;
  credentialGeneration: number;
  credentialFingerprint: string;
  credentialKeyVersion: string;
  zoteroLibraryId: string;
  libraryType: "USER" | "GROUP";
  externalLibraryId: string;
  jobId: string;
  jobAttemptId: string;
  runId: string;
  attemptNumber: number;
  workerId: string;
  leaseId: string;
  leaseExpiresAt: Date;
  fromVersion: ZoteroVersion;
  actorUserId: string | null;
}

export interface ZoteroSyncStageInput {
  objectType: Extract<ZoteroObjectType, "ITEM" | "COLLECTION">;
  zoteroKey: string;
  parentKey?: string;
  version: ZoteroVersion;
  isDeleted: boolean;
  contentHash?: string;
  data?: Readonly<Record<string, unknown>>;
}

export type ZoteroSyncFailureCode =
  | "stable_version_changed"
  | "zotero_authentication_failed"
  | "zotero_forbidden"
  | "zotero_credential_unavailable"
  | "zotero_bad_response"
  | "zotero_invalid_request"
  | "zotero_not_found"
  | "zotero_rate_limited"
  | "zotero_timeout"
  | "zotero_sync_resource_limit"
  | "zotero_unavailable"
  | "internal_error";

function requiredOpaqueId(value: string, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new HttpProblem(400, "validation", label + " is invalid.");
  }
  return value;
}

function requiredWorkerId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || Buffer.byteLength(normalized, "utf8") > MAX_WORKER_ID_BYTES
    || /[\r\n]/.test(normalized)
  ) throw new Error("The Zotero worker ID is invalid.");
  return normalized;
}

function requiredLeaseTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5_000 || value > MAX_LEASE_TTL_MS) {
    throw new Error("The Zotero lease TTL is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): ZoteroSyncJobPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1
    || typeof value.runId !== "string"
    || !OPAQUE_ID.test(value.runId)
    || (
      value.reason !== "manual"
      && value.reason !== "scheduled"
      && value.reason !== "stream"
    )
    || Object.keys(value).some((key) =>
      key !== "schemaVersion" && key !== "runId" && key !== "reason"
    )
  ) return null;
  return value as unknown as ZoteroSyncJobPayload;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + stableJson(record[key])
  ).join(",") + "}";
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || error.code === "P2002");
}

async function withTransactionRetry<T>(
  database: PrismaClient,
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt + 1 >= MAX_TRANSACTION_ATTEMPTS || !isSerializationFailure(error)) {
        throw error;
      }
    }
  }
}

export function zoteroSyncRunSummary(
  run: Pick<
    ZoteroSyncRun,
    | "id"
    | "status"
    | "fromVersion"
    | "toVersion"
    | "objectsRead"
    | "objectsWritten"
    | "objectsDeleted"
    | "backoffUntil"
    | "errorCode"
    | "startedAt"
    | "completedAt"
  >,
): ZoteroSyncRunSummary {
  return {
    id: run.id,
    status: run.status,
    fromVersion: run.fromVersion,
    toVersion: run.toVersion,
    objectsRead: run.objectsRead,
    objectsWritten: run.objectsWritten,
    objectsDeleted: run.objectsDeleted,
    backoffUntil: run.backoffUntil?.toISOString() ?? null,
    errorCode: run.errorCode === null
      ? null
      : PUBLIC_SYNC_ERROR_CODES.has(run.errorCode)
        ? run.errorCode
        : "internal_error",
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function replayedQueueResult(value: unknown): QueueZoteroSyncResult | null {
  if (!isRecord(value) || !Array.isArray(value.runs)) return null;
  if (value.outcome !== "queued" && value.outcome !== "coalesced") return null;
  if (value.queuedCount === undefined && value.coalescedCount === undefined) {
    // Preserve replay compatibility for receipts written before disposition
    // counts were added. Older queued receipts treated every run as new.
    return {
      ...(value as unknown as Omit<QueueZoteroSyncResult, "queuedCount" | "coalescedCount">),
      queuedCount: value.outcome === "queued" ? value.runs.length : 0,
      coalescedCount: value.outcome === "coalesced" ? value.runs.length : 0,
    };
  }
  if (
    !Number.isSafeInteger(value.queuedCount)
    || (value.queuedCount as number) < 0
    || !Number.isSafeInteger(value.coalescedCount)
    || (value.coalescedCount as number) < 0
    || (value.queuedCount as number) + (value.coalescedCount as number)
      !== value.runs.length
  ) return null;
  return value as unknown as QueueZoteroSyncResult;
}

export async function queueSelectedZoteroSyncs(
  input: {
    userId: string;
    workspaceId: string;
    connectionId: string;
    clientOperationId: string;
    reason?: "manual" | "scheduled" | "stream";
  },
  dependencies: {
    database?: PrismaClient;
    now?: () => Date;
    id?: () => string;
  } = {},
): Promise<QueueZoteroSyncResult> {
  const database = dependencies.database ?? prisma;
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? randomUUID;
  const userId = requiredOpaqueId(input.userId, "userId");
  const workspaceId = requiredOpaqueId(input.workspaceId, "workspaceId");
  const connectionId = requiredOpaqueId(input.connectionId, "connectionId");
  const operationId = requiredOpaqueId(input.clientOperationId, "clientOperationId");
  const reason = input.reason ?? "manual";
  const hash = requestHash({ command: "zoteroSync", connectionId, reason });

  return withTransactionRetry(database, () => database.$transaction(async (transaction) => {
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    requireWorkspaceIntegrationRole(membership.role);

    const prior = await transaction.idempotencyRecord.findUnique({
      where: { organizationId_key: { organizationId: workspaceId, key: operationId } },
    });
    if (prior) {
      if (
        prior.actorUserId !== userId
        || prior.command !== "zoteroSync"
        || prior.requestHash !== hash
      ) {
        throw new HttpProblem(
          409,
          "idempotency_conflict",
          "clientOperationId was already used for a different command.",
        );
      }
      const replay = replayedQueueResult(prior.response);
      if (replay) return replay;
      throw new HttpProblem(
        409,
        "operation_pending",
        "The prior Zotero sync request is still resolving.",
      );
    }

    const connection = await transaction.integrationConnection.findUnique({
      where: {
        organizationId_id: { organizationId: workspaceId, id: connectionId },
      },
      include: {
        zoteroLibraries: {
          where: { syncEnabled: true, isReadable: true },
          orderBy: [{ libraryType: "asc" }, { zoteroLibraryId: "asc" }],
        },
      },
    });
    if (
      !connection
      || connection.provider !== "ZOTERO"
      || (connection.status !== "CONNECTED" && connection.status !== "DEGRADED")
      || !connection.credentialCiphertext
      || !connection.credentialKeyVersion
      || connection.credentialGeneration <= 0
    ) {
      throw new HttpProblem(
        404,
        "zotero_connection_not_found",
        "Zotero connection was not found.",
      );
    }
    if (!connection.zoteroLibraries.length) {
      throw new HttpProblem(
        409,
        "zotero_selection_required",
        "Select at least one readable Zotero library before syncing.",
      );
    }
    if (connection.zoteroLibraries.length > MAX_SELECTED_LIBRARIES_PER_TRIGGER) {
      throw new HttpProblem(
        409,
        "zotero_selection_too_large",
        "Too many Zotero libraries are selected for one sync trigger.",
      );
    }

    const requestedAt = now();
    const runAfter = connection.providerBackoffUntil
      && connection.providerBackoffUntil > requestedAt
      ? connection.providerBackoffUntil
      : requestedAt;
    const runs: ZoteroSyncRun[] = [];
    let queuedCount = 0;
    let coalescedCount = 0;

    for (const library of connection.zoteroLibraries) {
      const dedupeKey = "zotero-library:" + library.id;
      const existingJob = await transaction.job.findUnique({
        where: {
          organizationId_type_dedupeKey: {
            organizationId: workspaceId,
            type: "ZOTERO_SYNC",
            dedupeKey,
          },
        },
      });
      const existingPayload = parsePayload(existingJob?.payload);
      if (
        existingJob
        && ACTIVE_JOB_STATUSES.has(existingJob.status)
        && existingPayload
      ) {
        const activeRun = await transaction.zoteroSyncRun.findFirst({
          where: {
            id: existingPayload.runId,
            organizationId: workspaceId,
            zoteroLibraryId: library.id,
            status: {
              in: ["QUEUED", "RUNNING", "PARTIAL", "BACKING_OFF"],
            },
          },
        });
        if (activeRun) {
          runs.push(activeRun);
          coalescedCount += 1;
          continue;
        }
      }

      const runId = id();
      requiredOpaqueId(runId, "runId");
      const run = await transaction.zoteroSyncRun.create({
        data: {
          id: runId,
          organizationId: workspaceId,
          zoteroLibraryId: library.id,
          direction: "PULL",
          status: runAfter > requestedAt ? "BACKING_OFF" : "QUEUED",
          fromVersion: library.lastSyncedVersion ?? "0",
          requestId: operationId + ":" + library.id,
          backoffUntil: runAfter > requestedAt ? runAfter : null,
        },
      });
      const payload: ZoteroSyncJobPayload = {
        schemaVersion: 1,
        runId,
        reason,
      };
      if (existingJob) {
        await transaction.job.update({
          where: {
            organizationId_id: { organizationId: workspaceId, id: existingJob.id },
          },
          data: {
            status: runAfter > requestedAt ? "RETRYING" : "QUEUED",
            payload: payload as unknown as Prisma.InputJsonValue,
            result: Prisma.DbNull,
            // JobAttempt rows are append-only and uniquely numbered per job.
            // Reusing the library's persistent job slot therefore keeps the
            // lifetime counter monotonic while opening a fresh eight-attempt
            // budget for this sync run.
            maxAttempts: existingJob.attempts + 8,
            runAfter,
            lockedAt: null,
            lockedBy: null,
            leaseId: null,
            leaseExpiresAt: null,
            completedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            integrationConnectionId: connection.id,
            zoteroLibraryId: library.id,
            createdById: userId,
          },
        });
      } else {
        await transaction.job.create({
          data: {
            id: id(),
            organizationId: workspaceId,
            type: "ZOTERO_SYNC",
            status: runAfter > requestedAt ? "RETRYING" : "QUEUED",
            dedupeKey,
            payload: payload as unknown as Prisma.InputJsonValue,
            maxAttempts: 8,
            runAfter,
            integrationConnectionId: connection.id,
            zoteroLibraryId: library.id,
            createdById: userId,
          },
        });
      }
      runs.push(run);
      queuedCount += 1;
    }

    const response: QueueZoteroSyncResult = {
      outcome: queuedCount > 0 ? "queued" : "coalesced",
      queuedCount,
      coalescedCount,
      runs: runs.map(zoteroSyncRunSummary),
    };
    await transaction.idempotencyRecord.create({
      data: {
        organizationId: workspaceId,
        actorUserId: userId,
        key: operationId,
        command: "zoteroSync",
        requestHash: hash,
        response: response as unknown as Prisma.InputJsonValue,
        status: "COMPLETED",
        completedAt: requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: userId,
        action: queuedCount > 0 ? "zotero.sync.queued" : "zotero.sync.coalesced",
        entityType: "integration-connection",
        entityId: connection.id,
        requestId: operationId,
        metadata: {
          selectedLibraryCount: connection.zoteroLibraries.length,
          queuedRunCount: queuedCount,
          coalescedRunCount: coalescedCount,
        },
      },
    });
    return response;
  }, { isolationLevel: "Serializable" }));
}

/**
 * Coalesce due selected libraries into their one persistent job slot. This is
 * safe to call from several worker processes: the compound job key plus the
 * serializable recheck allows only one active run per library.
 */
export async function scheduleDueZoteroSyncs(
  input: {
    now?: Date;
    cadenceMs?: number;
    limit?: number;
    database?: PrismaClient;
    id?: () => string;
  } = {},
): Promise<{ queued: number }> {
  const database = input.database ?? prisma;
  const now = input.now ?? new Date();
  const cadenceMs = input.cadenceMs ?? DEFAULT_ZOTERO_SYNC_CADENCE_MS;
  const limit = input.limit ?? MAX_SCHEDULE_BATCH;
  const id = input.id ?? randomUUID;
  if (
    !Number.isSafeInteger(cadenceMs)
    || cadenceMs < 60_000
    || cadenceMs > 30 * 24 * 60 * 60_000
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_SCHEDULE_BATCH
  ) throw new Error("The Zotero sync schedule configuration is invalid.");
  const dueBefore = new Date(now.getTime() - cadenceMs);
  const candidates = await database.zoteroLibrary.findMany({
    where: {
      isReadable: true,
      syncEnabled: true,
      integration: {
        provider: "ZOTERO",
        status: { in: ["CONNECTED", "DEGRADED"] },
      },
      // Exclude active and operator-blocked persistent jobs before `take` so
      // a backed-off first cohort cannot starve later due libraries.
      jobs: {
        none: {
          type: "ZOTERO_SYNC",
          status: { not: "SUCCEEDED" },
        },
      },
      OR: [
        { lastSyncedAt: null },
        { lastSyncedAt: { lte: dueBefore } },
      ],
    },
    orderBy: [{ lastSyncedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, organizationId: true },
  });
  let queued = 0;

  for (const candidate of candidates) {
    const applied = await withTransactionRetry(
      database,
      () => database.$transaction(async (transaction) => {
        const library = await transaction.zoteroLibrary.findUnique({
          where: {
            organizationId_id: {
              organizationId: candidate.organizationId,
              id: candidate.id,
            },
          },
          include: { integration: true },
        });
        if (
          !library
          || !library.isReadable
          || !library.syncEnabled
          || (
            library.lastSyncedAt !== null
            && library.lastSyncedAt > dueBefore
          )
          || library.integration.provider !== "ZOTERO"
          || (
            library.integration.status !== "CONNECTED"
            && library.integration.status !== "DEGRADED"
          )
        ) return false;
        const dedupeKey = "zotero-library:" + library.id;
        const existingJob = await transaction.job.findUnique({
          where: {
            organizationId_type_dedupeKey: {
              organizationId: library.organizationId,
              type: "ZOTERO_SYNC",
              dedupeKey,
            },
          },
        });
        if (existingJob && ACTIVE_JOB_STATUSES.has(existingJob.status)) {
          return false;
        }
        // Automatic scheduling must not silently resurrect a run that needs
        // operator attention. A manual sync remains the explicit recovery
        // path after credentials, permissions, or provider input are fixed.
        if (
          existingJob
          && AUTO_SCHEDULE_BLOCKED_JOB_STATUSES.has(existingJob.status)
        ) return false;
        const runId = id();
        requiredOpaqueId(runId, "runId");
        const delayedUntil = library.integration.providerBackoffUntil
          && library.integration.providerBackoffUntil > now
          ? library.integration.providerBackoffUntil
          : now;
        await transaction.zoteroSyncRun.create({
          data: {
            id: runId,
            organizationId: library.organizationId,
            zoteroLibraryId: library.id,
            direction: "PULL",
            status: delayedUntil > now ? "BACKING_OFF" : "QUEUED",
            fromVersion: library.lastSyncedVersion ?? "0",
            requestId: "scheduled:" + id(),
            backoffUntil: delayedUntil > now ? delayedUntil : null,
          },
        });
        const payload = {
          schemaVersion: 1,
          runId,
          reason: "scheduled",
        } satisfies ZoteroSyncJobPayload;
        if (existingJob) {
          await transaction.job.update({
            where: {
              organizationId_id: {
                organizationId: library.organizationId,
                id: existingJob.id,
              },
            },
            data: {
              status: delayedUntil > now ? "RETRYING" : "QUEUED",
              payload: payload as unknown as Prisma.InputJsonValue,
              result: Prisma.DbNull,
              // Preserve the append-only attempt sequence when the persistent
              // library job is reused, but grant this run its own retry budget.
              maxAttempts: existingJob.attempts + 8,
              runAfter: delayedUntil,
              lockedAt: null,
              lockedBy: null,
              leaseId: null,
              leaseExpiresAt: null,
              completedAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              integrationConnectionId: library.integrationConnectionId,
              zoteroLibraryId: library.id,
              createdById: null,
            },
          });
        } else {
          await transaction.job.create({
            data: {
              id: id(),
              organizationId: library.organizationId,
              type: "ZOTERO_SYNC",
              status: delayedUntil > now ? "RETRYING" : "QUEUED",
              dedupeKey,
              payload: payload as unknown as Prisma.InputJsonValue,
              maxAttempts: 8,
              runAfter: delayedUntil,
              integrationConnectionId: library.integrationConnectionId,
              zoteroLibraryId: library.id,
            },
          });
        }
        await transaction.auditEvent.create({
          data: {
            organizationId: library.organizationId,
            action: "zotero.sync.scheduled",
            entityType: "zotero-sync-run",
            entityId: runId,
            metadata: {
              cadenceMs,
              delayedByProvider: delayedUntil > now,
            },
          },
        });
        return true;
      }, { isolationLevel: "Serializable" }),
    );
    if (applied) queued += 1;
  }
  return { queued };
}

async function terminalInvalidJob(
  transaction: Prisma.TransactionClient,
  job: {
    id: string;
    organizationId: string;
    payload: Prisma.JsonValue | null;
  },
  now: Date,
  code: string,
): Promise<void> {
  const payload = parsePayload(job.payload);
  await transaction.job.update({
    where: { organizationId_id: { organizationId: job.organizationId, id: job.id } },
    data: {
      status: "DEAD_LETTER",
      completedAt: now,
      lockedAt: null,
      lockedBy: null,
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorCode: code,
      lastErrorMessage: null,
    },
  });
  if (payload) {
    await transaction.zoteroSyncRun.updateMany({
      where: { id: payload.runId, organizationId: job.organizationId },
      data: {
        status: "FAILED",
        completedAt: now,
        errorCode: "internal_error",
        errorMessage: null,
      },
    });
    await transaction.zoteroSyncStage.deleteMany({
      where: {
        organizationId: job.organizationId,
        zoteroSyncRunId: payload.runId,
      },
    });
  }
}

export async function claimNextZoteroSyncJob(input: {
  workerId: string;
  leaseTtlMs?: number;
  now?: Date;
  database?: PrismaClient;
}): Promise<ZoteroSyncLease | null> {
  const database = input.database ?? prisma;
  const workerId = requiredWorkerId(input.workerId);
  const leaseTtlMs = requiredLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_ZOTERO_SYNC_LEASE_TTL_MS,
  );
  const now = input.now ?? new Date();

  for (let loop = 0; loop < MAX_CLAIM_LOOPS; loop += 1) {
    const outcome = await withTransactionRetry(database, () =>
      database.$transaction(async (transaction) => {
      const job = await transaction.job.findFirst({
        where: {
          type: "ZOTERO_SYNC",
          OR: [
            {
              status: { in: ["QUEUED", "RETRYING"] },
              runAfter: { lte: now },
            },
            {
              status: "RUNNING",
              leaseExpiresAt: { lte: now },
            },
          ],
        },
        orderBy: [
          { priority: "desc" },
          { runAfter: "asc" },
          { createdAt: "asc" },
          { id: "asc" },
        ],
      });
      if (!job) return { kind: "empty" as const };

      const expectedLeaseId = job.leaseId;
      const claimGuard = job.status === "RUNNING"
        ? {
            id: job.id,
            organizationId: job.organizationId,
            status: "RUNNING" as const,
            leaseId: expectedLeaseId,
            leaseExpiresAt: { lte: now },
          }
        : {
            id: job.id,
            organizationId: job.organizationId,
            status: job.status,
            leaseId: null,
            runAfter: { lte: now },
          };

      const payload = parsePayload(job.payload);
      const library = job.zoteroLibraryId
        ? await transaction.zoteroLibrary.findUnique({
            where: {
              organizationId_id: {
                organizationId: job.organizationId,
                id: job.zoteroLibraryId,
              },
            },
            include: { integration: true },
          })
        : null;
      const run = payload && library
        ? await transaction.zoteroSyncRun.findFirst({
            where: {
              id: payload.runId,
              organizationId: job.organizationId,
              zoteroLibraryId: library.id,
            },
          })
        : null;
      if (
        !payload
        || !library
        || !run
        || !library.syncEnabled
        || !library.isReadable
        || !library.integration.credentialCiphertext
        || !library.integration.credentialFingerprint
        || !library.integration.credentialKeyVersion
        || library.integration.credentialGeneration <= 0
        || !library.integration.externalAccountId
        || library.integration.provider !== "ZOTERO"
        || (
          library.integration.status !== "CONNECTED"
          && library.integration.status !== "DEGRADED"
        )
        || job.integrationConnectionId !== library.integrationConnectionId
      ) {
        await terminalInvalidJob(
          transaction,
          job,
          now,
          "zotero_sync_target_invalid",
        );
        return { kind: "skip" as const };
      }
      if (
        library.integration.providerBackoffUntil
        && library.integration.providerBackoffUntil > now
      ) {
        await transaction.job.updateMany({
          where: claimGuard,
          data: {
            status: "RETRYING",
            runAfter: library.integration.providerBackoffUntil,
            lockedAt: null,
            lockedBy: null,
            leaseId: null,
            leaseExpiresAt: null,
          },
        });
        await transaction.zoteroSyncRun.update({
          where: {
            organizationId_id: {
              organizationId: job.organizationId,
              id: run.id,
            },
          },
          data: {
            status: "BACKING_OFF",
            backoffUntil: library.integration.providerBackoffUntil,
          },
        });
        return { kind: "skip" as const };
      }
      if (job.attempts >= job.maxAttempts) {
        await terminalInvalidJob(
          transaction,
          job,
          now,
          "zotero_sync_attempt_budget_exhausted",
        );
        return { kind: "skip" as const };
      }

      if (job.status === "RUNNING" && expectedLeaseId) {
        await transaction.jobAttempt.updateMany({
          where: {
            organizationId: job.organizationId,
            jobId: job.id,
            leaseId: expectedLeaseId,
            status: "RUNNING",
          },
          data: {
            status: "FAILED",
            completedAt: now,
            errorCode: "worker_lease_expired",
            errorMessage: null,
          },
        });
      }

      const leaseId = randomUUID();
      const jobAttemptId = randomUUID();
      const attemptNumber = job.attempts + 1;
      const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
      const claimed = await transaction.job.updateMany({
        where: claimGuard,
        data: {
          status: "RUNNING",
          attempts: attemptNumber,
          lockedAt: now,
          lockedBy: workerId,
          leaseId,
          leaseExpiresAt,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (claimed.count !== 1) return { kind: "skip" as const };

      await transaction.zoteroSyncStage.deleteMany({
        where: {
          organizationId: job.organizationId,
          zoteroSyncRunId: run.id,
        },
      });
      await transaction.zoteroSyncRun.update({
        where: {
          organizationId_id: { organizationId: job.organizationId, id: run.id },
        },
        data: {
          status: "RUNNING",
          fromVersion: library.lastSyncedVersion ?? "0",
          toVersion: null,
          objectsRead: 0,
          objectsWritten: 0,
          objectsDeleted: 0,
          conflicts: job.status === "RUNNING" ? { increment: 1 } : undefined,
          backoffUntil: null,
          errorCode: null,
          errorMessage: null,
          startedAt: run.startedAt ?? now,
          completedAt: null,
        },
      });
      await transaction.jobAttempt.create({
        data: {
          id: jobAttemptId,
          organizationId: job.organizationId,
          jobId: job.id,
          attemptNumber,
          status: "RUNNING",
          workerId,
          leaseId,
          startedAt: now,
        },
      });
      return {
        kind: "claimed" as const,
        value: {
          organizationId: job.organizationId,
          connectionId: library.integrationConnectionId,
          externalAccountId: library.integration.externalAccountId,
          connectionUpdatedAt: library.integration.updatedAt,
          credentialGeneration: library.integration.credentialGeneration,
          credentialFingerprint: library.integration.credentialFingerprint,
          credentialKeyVersion: library.integration.credentialKeyVersion,
          zoteroLibraryId: library.id,
          libraryType: library.libraryType,
          externalLibraryId: library.zoteroLibraryId,
          jobId: job.id,
          jobAttemptId,
          runId: run.id,
          attemptNumber,
          workerId,
          leaseId,
          leaseExpiresAt,
          fromVersion: toZoteroVersion(library.lastSyncedVersion ?? "0"),
          actorUserId: job.createdById,
        },
      };
    }, { isolationLevel: "Serializable" }));
    if (outcome.kind === "claimed") return outcome.value;
    if (outcome.kind === "empty") return null;
  }
  return null;
}

export async function heartbeatZoteroSyncLease(input: {
  lease: ZoteroSyncLease;
  leaseTtlMs?: number;
  now?: Date;
  database?: PrismaClient;
}): Promise<boolean> {
  const database = input.database ?? prisma;
  const now = input.now ?? new Date();
  const leaseTtlMs = requiredLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_ZOTERO_SYNC_LEASE_TTL_MS,
  );
  const updated = await database.job.updateMany({
    where: {
      id: input.lease.jobId,
      organizationId: input.lease.organizationId,
      type: "ZOTERO_SYNC",
      status: "RUNNING",
      lockedBy: input.lease.workerId,
      leaseId: input.lease.leaseId,
      leaseExpiresAt: { gt: now },
    },
    data: { leaseExpiresAt: new Date(now.getTime() + leaseTtlMs) },
  });
  return updated.count === 1;
}

function validateStage(stage: ZoteroSyncStageInput): ZoteroSyncStageInput {
  const zoteroKey = normalizeZoteroItemKey(stage.zoteroKey);
  const parentKey = stage.parentKey
    ? normalizeZoteroItemKey(stage.parentKey)
    : undefined;
  const version = toZoteroVersion(stage.version);
  if (stage.objectType !== "ITEM" && stage.objectType !== "COLLECTION") {
    throw new Error("The Zotero staged object type is invalid.");
  }
  if (stage.isDeleted) {
    if (stage.data !== undefined || stage.contentHash !== undefined) {
      throw new Error("A Zotero tombstone cannot contain object data.");
    }
  } else {
    if (!stage.data || stage.contentHash !== zoteroContentHash(stage.data)) {
      throw new Error("The Zotero staged object digest is invalid.");
    }
  }
  return {
    ...stage,
    zoteroKey,
    parentKey,
    version,
  };
}

async function leaseIsCurrent(
  transaction: Prisma.TransactionClient,
  lease: ZoteroSyncLease,
  now: Date,
): Promise<boolean> {
  const job = await transaction.job.findFirst({
    where: {
      id: lease.jobId,
      organizationId: lease.organizationId,
      type: "ZOTERO_SYNC",
      status: "RUNNING",
      lockedBy: lease.workerId,
      leaseId: lease.leaseId,
      leaseExpiresAt: { gt: now },
      zoteroLibraryId: lease.zoteroLibraryId,
      integrationConnectionId: lease.connectionId,
    },
    select: { id: true },
  });
  if (!job) return false;
  const connection = await transaction.integrationConnection.findFirst({
    where: {
      id: lease.connectionId,
      organizationId: lease.organizationId,
      provider: "ZOTERO",
      status: { in: ["CONNECTED", "DEGRADED"] },
      externalAccountId: lease.externalAccountId,
      updatedAt: lease.connectionUpdatedAt,
      credentialGeneration: lease.credentialGeneration,
      credentialFingerprint: lease.credentialFingerprint,
      credentialKeyVersion: lease.credentialKeyVersion,
    },
    select: { id: true },
  });
  if (!connection) return false;
  const library = await transaction.zoteroLibrary.findFirst({
    where: {
      id: lease.zoteroLibraryId,
      organizationId: lease.organizationId,
      integrationConnectionId: lease.connectionId,
      isReadable: true,
      syncEnabled: true,
    },
    select: { id: true },
  });
  return Boolean(library);
}

export async function stageZoteroSyncObjects(input: {
  lease: ZoteroSyncLease;
  stages: readonly ZoteroSyncStageInput[];
  now?: Date;
  database?: PrismaClient;
  id?: () => string;
}): Promise<boolean> {
  const database = input.database ?? prisma;
  const now = input.now ?? new Date();
  const id = input.id ?? randomUUID;
  const stages = input.stages.map(validateStage);
  if (!stages.length) return true;

  return withTransactionRetry(database, () =>
    database.$transaction(async (transaction) => {
    if (!await leaseIsCurrent(transaction, input.lease, now)) return false;
    for (const stage of stages) {
      await transaction.zoteroSyncStage.upsert({
        where: {
          zoteroSyncRunId_objectType_zoteroKey: {
            zoteroSyncRunId: input.lease.runId,
            objectType: stage.objectType,
            zoteroKey: stage.zoteroKey,
          },
        },
        create: {
          id: id(),
          organizationId: input.lease.organizationId,
          zoteroSyncRunId: input.lease.runId,
          zoteroLibraryId: input.lease.zoteroLibraryId,
          objectType: stage.objectType,
          zoteroKey: stage.zoteroKey,
          parentKey: stage.parentKey,
          version: stage.version,
          isDeleted: stage.isDeleted,
          contentHash: stage.contentHash,
          data: stage.data
            ? stage.data as Prisma.InputJsonValue
            : undefined,
          updatedAt: now,
        },
        update: {
          parentKey: stage.parentKey ?? null,
          version: stage.version,
          isDeleted: stage.isDeleted,
          contentHash: stage.contentHash ?? null,
          data: stage.data
            ? stage.data as Prisma.InputJsonValue
            : Prisma.DbNull,
          updatedAt: now,
        },
      });
    }
    await transaction.zoteroSyncRun.updateMany({
      where: {
        id: input.lease.runId,
        organizationId: input.lease.organizationId,
        zoteroLibraryId: input.lease.zoteroLibraryId,
        status: "RUNNING",
      },
      data: { objectsRead: { increment: stages.length } },
    });
    return true;
  }, { isolationLevel: "Serializable" }));
}

function sourceKey(lease: ZoteroSyncLease, objectType: string, key: string): string {
  return [
    "zotero",
    lease.connectionId,
    lease.libraryType.toLowerCase(),
    lease.externalLibraryId,
    objectType.toLowerCase(),
    key,
  ].join(":");
}

function sourceUri(lease: ZoteroSyncLease, objectType: string, key: string): string {
  const segment = lease.libraryType === "USER" ? "users" : "groups";
  const resource = objectType === "ITEM" ? "items" : "collections";
  return "https://api.zotero.org/" + segment + "/" + lease.externalLibraryId
    + "/" + resource + "/" + key;
}

type PersistedZoteroAttachmentProjection = {
  parentKey: string | null;
  linkMode: string | null;
  contentType: string | null;
  fileName: string | null;
  providerMd5: string | null;
  providerMtime: string | null;
  metadataHash: string;
  eligibility: "DOWNLOADABLE" | "INELIGIBLE" | "MALFORMED";
  reasonCode: string | null;
};

/**
 * Convert the closed metadata projector output into the exact database shape.
 * The digest covers only this sanitized, versioned shape: provider paths,
 * URLs, and unrecognized partial metadata never enter either the row or hash.
 */
export function zoteroAttachmentPersistenceProjection(
  data: Prisma.JsonValue | null,
): PersistedZoteroAttachmentProjection {
  const projection = projectZoteroAttachment({ objectType: "ITEM", data });
  const fields = projection.outcome === "downloadable"
    ? {
        parentKey: projection.candidate.parentItem ?? null,
        linkMode: projection.candidate.linkMode,
        contentType: projection.candidate.contentType,
        fileName: projection.candidate.filename,
        providerMd5: projection.candidate.md5,
        providerMtime: projection.candidate.mtime ?? null,
        eligibility: "DOWNLOADABLE" as const,
        reasonCode: null,
      }
    : {
        parentKey: null,
        linkMode: null,
        contentType: null,
        fileName: null,
        providerMd5: null,
        providerMtime: null,
        eligibility: projection.outcome === "ineligible"
          ? "INELIGIBLE" as const
          : "MALFORMED" as const,
        reasonCode: projection.reasonCode,
      };
  return {
    ...fields,
    metadataHash: zoteroContentHash({
      schemaVersion: 1,
      ...fields,
    }),
  };
}

async function upsertInboxSnapshot(
  transaction: Prisma.TransactionClient,
  input: {
    lease: ZoteroSyncLease;
    zoteroObjectId: string;
    stage: {
      zoteroKey: string;
      version: string;
      data: Prisma.JsonValue | null;
      contentHash: string | null;
    };
    snapshot: StoredImportSnapshot;
    now: Date;
    id: () => string;
  },
): Promise<string> {
  const key = sourceKey(input.lease, "ITEM", input.stage.zoteroKey);
  const existing = await transaction.inboxEntry.findUnique({
    where: {
      organizationId_source_sourceKey: {
        organizationId: input.lease.organizationId,
        source: "ZOTERO",
        sourceKey: key,
      },
    },
  });
  const restored = existing?.status === "REJECTED"
    && existing.failureCode === "zotero_source_deleted";
  const entry = existing
    ? await transaction.inboxEntry.update({
        where: {
          organizationId_id: {
            organizationId: input.lease.organizationId,
            id: existing.id,
          },
        },
        data: {
          proposedTitle: input.snapshot.paper.title,
          proposedYear: input.snapshot.paper.year || null,
          sourceUri: input.snapshot.provenance.sourceUrl,
          payload: input.snapshot as unknown as Prisma.InputJsonValue,
          ...(restored
            ? {
                status: "PENDING" as const,
                failureCode: null,
                failureMessage: null,
              }
            : {}),
        },
      })
    : await transaction.inboxEntry.create({
        data: {
          id: input.id(),
          organizationId: input.lease.organizationId,
          source: "ZOTERO",
          sourceKey: key,
          dedupeKey: key,
          status: "PENDING",
          proposedTitle: input.snapshot.paper.title,
          proposedYear: input.snapshot.paper.year || null,
          sourceUri: input.snapshot.provenance.sourceUrl,
          payload: input.snapshot as unknown as Prisma.InputJsonValue,
          createdById: input.lease.actorUserId,
        },
      });
  await transaction.provenanceRecord.create({
    data: {
      id: input.id(),
      organizationId: input.lease.organizationId,
      kind: "ZOTERO_SYNC",
      inboxEntryId: entry.id,
      zoteroObjectId: input.zoteroObjectId,
      integrationConnectionId: input.lease.connectionId,
      actorUserId: input.lease.actorUserId,
      sourceProvider: "Zotero",
      sourceRecordId: key,
      sourceUri: input.snapshot.provenance.sourceUrl,
      retrievedAt: input.now,
      payloadDigest: input.stage.contentHash,
      payload: {
        schemaVersion: 1,
        event: existing ? "metadata-updated" : "metadata-discovered",
        sourceVersion: input.stage.version,
        snapshot: input.snapshot,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  return entry.id;
}

export async function completeZoteroSyncLease(input: {
  lease: ZoteroSyncLease;
  targetVersion: ZoteroVersion;
  now?: Date;
  database?: PrismaClient;
  id?: () => string;
}): Promise<"applied" | "replayed" | "lease-lost"> {
  const database = input.database ?? prisma;
  const now = input.now ?? new Date();
  const id = input.id ?? randomUUID;
  const targetVersion = toZoteroVersion(input.targetVersion);

  try {
    return await withTransactionRetry(database, () =>
      database.$transaction(async (transaction) => {
    if (!await leaseIsCurrent(transaction, input.lease, now)) {
      const run = await transaction.zoteroSyncRun.findFirst({
        where: {
          id: input.lease.runId,
          organizationId: input.lease.organizationId,
          status: "SUCCEEDED",
          toVersion: targetVersion,
        },
        select: { id: true },
      });
      return run ? "replayed" as const : "lease-lost" as const;
    }

    const library = await transaction.zoteroLibrary.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.zoteroLibraryId,
        },
      },
    });
    if (
      !library
      || !library.isReadable
      || !library.syncEnabled
      || (library.lastSyncedVersion ?? "0") !== input.lease.fromVersion
    ) return "lease-lost" as const;

    const stages = await transaction.zoteroSyncStage.findMany({
      where: {
        organizationId: input.lease.organizationId,
        zoteroSyncRunId: input.lease.runId,
        zoteroLibraryId: input.lease.zoteroLibraryId,
      },
      orderBy: [{ objectType: "asc" }, { zoteroKey: "asc" }],
    });
    let written = 0;
    let deleted = 0;
    let inboxChanged = false;

    for (const stage of stages) {
      const existing = await transaction.zoteroObject.findUnique({
        where: {
          zoteroLibraryId_objectType_zoteroKey: {
            zoteroLibraryId: input.lease.zoteroLibraryId,
            objectType: stage.objectType,
            zoteroKey: stage.zoteroKey,
          },
        },
      });
      const object = existing
        ? await transaction.zoteroObject.update({
            where: {
              organizationId_id: {
                organizationId: input.lease.organizationId,
                id: existing.id,
              },
            },
            data: stage.isDeleted
              ? {
                  version: targetVersion,
                  isDeleted: true,
                  lastSyncedAt: now,
                }
              : {
                  parentKey: stage.parentKey,
                  version: stage.version,
                  isDeleted: false,
                  contentHash: stage.contentHash,
                  data: stage.data ?? Prisma.DbNull,
                  lastSyncedAt: now,
                },
          })
        : await transaction.zoteroObject.create({
            data: {
              id: id(),
              organizationId: input.lease.organizationId,
              zoteroLibraryId: input.lease.zoteroLibraryId,
              objectType: stage.objectType,
              zoteroKey: stage.zoteroKey,
              parentKey: stage.parentKey,
              version: stage.isDeleted ? targetVersion : stage.version,
              isDeleted: stage.isDeleted,
              contentHash: stage.contentHash,
              data: stage.data ?? undefined,
              lastSyncedAt: now,
            },
          });

      if (stage.objectType === "ITEM") {
        if (stage.isDeleted) {
          // Keep the last admitted metadata identity intact for historical
          // imports; deletion is a reversible provider state, not erasure.
          await transaction.zoteroAttachment.updateMany({
            where: {
              zoteroObjectId: object.id,
              organizationId: input.lease.organizationId,
              zoteroLibraryId: input.lease.zoteroLibraryId,
            },
            data: { isDeleted: true },
          });
        } else {
          const projection = zoteroAttachmentPersistenceProjection(stage.data);
          await transaction.zoteroAttachment.upsert({
            where: { zoteroObjectId: object.id },
            create: {
              zoteroObjectId: object.id,
              organizationId: input.lease.organizationId,
              zoteroLibraryId: input.lease.zoteroLibraryId,
              ...projection,
              sourceVersion: stage.version,
              isDeleted: false,
            },
            update: {
              ...projection,
              sourceVersion: stage.version,
              isDeleted: false,
            },
          });
        }
      }

      if (stage.isDeleted) {
        deleted += 1;
        const key = sourceKey(
          input.lease,
          stage.objectType,
          stage.zoteroKey,
        );
        const sourceInbox = await transaction.inboxEntry.findUnique({
          where: {
            organizationId_source_sourceKey: {
              organizationId: input.lease.organizationId,
              source: "ZOTERO",
              sourceKey: key,
            },
          },
          select: { id: true, status: true },
        });
        if (
          sourceInbox
          && ["PENDING", "MATCHED", "DUPLICATE", "NEEDS_REVIEW"].includes(
            sourceInbox.status,
          )
        ) {
          inboxChanged = true;
          await transaction.inboxEntry.update({
            where: {
              organizationId_id: {
                organizationId: input.lease.organizationId,
                id: sourceInbox.id,
              },
            },
            data: {
              status: "REJECTED",
              failureCode: "zotero_source_deleted",
              failureMessage: null,
            },
          });
        }
        await transaction.provenanceRecord.create({
          data: {
            id: id(),
            organizationId: input.lease.organizationId,
            kind: "ZOTERO_SYNC",
            inboxEntryId: sourceInbox?.id,
            zoteroObjectId: object.id,
            integrationConnectionId: input.lease.connectionId,
            actorUserId: input.lease.actorUserId,
            sourceProvider: "Zotero",
            sourceRecordId: key,
            sourceUri: sourceUri(
              input.lease,
              stage.objectType,
              stage.zoteroKey,
            ),
            retrievedAt: now,
            payload: {
              schemaVersion: 1,
              event: "tombstoned",
              libraryVersion: targetVersion,
            },
          },
        });
        continue;
      }

      written += 1;
      if (stage.objectType === "ITEM" && isRecord(stage.data)) {
        const normalized = normalizeZoteroItemForSync({
          item: {
            key: stage.zoteroKey,
            version: toZoteroVersion(stage.version),
            data: stage.data,
          },
          library: {
            kind: input.lease.libraryType === "USER" ? "user" : "group",
            id: input.lease.externalLibraryId,
          },
          retrievedAt: now.toISOString(),
        });
        if (normalized.inboxSnapshot) {
          inboxChanged = true;
          await upsertInboxSnapshot(transaction, {
            lease: input.lease,
            zoteroObjectId: object.id,
            stage,
            snapshot: normalized.inboxSnapshot,
            now,
            id,
          });
        } else {
          await transaction.provenanceRecord.create({
            data: {
              id: id(),
              organizationId: input.lease.organizationId,
              kind: "ZOTERO_SYNC",
              zoteroObjectId: object.id,
              integrationConnectionId: input.lease.connectionId,
              actorUserId: input.lease.actorUserId,
              sourceProvider: "Zotero",
              sourceRecordId: sourceKey(
                input.lease,
                stage.objectType,
                stage.zoteroKey,
              ),
              sourceUri: sourceUri(
                input.lease,
                stage.objectType,
                stage.zoteroKey,
              ),
              retrievedAt: now,
              payloadDigest: stage.contentHash,
              payload: {
                schemaVersion: 1,
                event: "metadata-updated",
                sourceVersion: stage.version,
              },
            },
          });
        }
      } else {
        await transaction.provenanceRecord.create({
          data: {
            id: id(),
            organizationId: input.lease.organizationId,
            kind: "ZOTERO_SYNC",
            zoteroObjectId: object.id,
            integrationConnectionId: input.lease.connectionId,
            actorUserId: input.lease.actorUserId,
            sourceProvider: "Zotero",
            sourceRecordId: sourceKey(
              input.lease,
              stage.objectType,
              stage.zoteroKey,
            ),
            sourceUri: sourceUri(
              input.lease,
              stage.objectType,
              stage.zoteroKey,
            ),
            retrievedAt: now,
            payloadDigest: stage.contentHash,
            payload: {
              schemaVersion: 1,
              event: "metadata-updated",
              sourceVersion: stage.version,
            },
          },
        });
      }
    }

    if (inboxChanged) {
      await transaction.organization.update({
        where: { id: input.lease.organizationId },
        data: { revision: { increment: 1 } },
      });
    }

    const libraryAdvanced = await transaction.zoteroLibrary.updateMany({
      where: {
        id: input.lease.zoteroLibraryId,
        organizationId: input.lease.organizationId,
        integrationConnectionId: input.lease.connectionId,
        isReadable: true,
        syncEnabled: true,
        lastSyncedVersion: library.lastSyncedVersion,
      },
      data: {
        lastSyncedVersion: targetVersion,
        lastItemVersion: targetVersion,
        lastCollectionVersion: targetVersion,
        lastDeletionVersion: targetVersion,
        lastSyncedAt: now,
      },
    });
    if (libraryAdvanced.count !== 1) {
      throw new ZoteroSyncCommitLeaseLostError();
    }

    const runCompleted = await transaction.zoteroSyncRun.updateMany({
      where: {
        id: input.lease.runId,
        organizationId: input.lease.organizationId,
        zoteroLibraryId: input.lease.zoteroLibraryId,
        status: "RUNNING",
        fromVersion: input.lease.fromVersion,
      },
      data: {
        status: "SUCCEEDED",
        toVersion: targetVersion,
        objectsRead: stages.length,
        objectsWritten: written,
        objectsDeleted: deleted,
        backoffUntil: null,
        errorCode: null,
        errorMessage: null,
        completedAt: now,
      },
    });
    if (runCompleted.count !== 1) {
      throw new ZoteroSyncCommitLeaseLostError();
    }
    const jobCompleted = await transaction.job.updateMany({
      where: {
        id: input.lease.jobId,
        organizationId: input.lease.organizationId,
        type: "ZOTERO_SYNC",
        status: "RUNNING",
        lockedBy: input.lease.workerId,
        leaseId: input.lease.leaseId,
        leaseExpiresAt: { gt: now },
        integrationConnectionId: input.lease.connectionId,
        zoteroLibraryId: input.lease.zoteroLibraryId,
      },
      data: {
        status: "SUCCEEDED",
        result: {
          schemaVersion: 1,
          runId: input.lease.runId,
          targetVersion,
          objectsWritten: written,
          objectsDeleted: deleted,
        },
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (jobCompleted.count !== 1) {
      throw new ZoteroSyncCommitLeaseLostError();
    }
    const attemptCompleted = await transaction.jobAttempt.updateMany({
      where: {
        id: input.lease.jobAttemptId,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        leaseId: input.lease.leaseId,
        status: "RUNNING",
      },
      data: {
        status: "SUCCEEDED",
        completedAt: now,
        result: {
          runId: input.lease.runId,
          targetVersion,
          objectsWritten: written,
          objectsDeleted: deleted,
        },
      },
    });
    if (attemptCompleted.count !== 1) {
      throw new ZoteroSyncCommitLeaseLostError();
    }
    await transaction.zoteroSyncStage.deleteMany({
      where: {
        organizationId: input.lease.organizationId,
        zoteroSyncRunId: input.lease.runId,
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        actorUserId: input.lease.actorUserId,
        action: "zotero.sync.succeeded",
        entityType: "zotero-sync-run",
        entityId: input.lease.runId,
        metadata: {
          fromVersion: input.lease.fromVersion,
          toVersion: targetVersion,
          objectsWritten: written,
          objectsDeleted: deleted,
        },
      },
    });
    return "applied" as const;
  }, {
    isolationLevel: "Serializable",
    maxWait: 10_000,
    timeout: 60_000,
    }));
  } catch (error) {
    if (error instanceof ZoteroSyncCommitLeaseLostError) return "lease-lost";
    throw error;
  }
}

function retryDelay(attemptNumber: number): number {
  return RETRY_DELAYS_MS[
    Math.min(Math.max(0, attemptNumber - 1), RETRY_DELAYS_MS.length - 1)
  ];
}

export async function failZoteroSyncLease(input: {
  lease: ZoteroSyncLease;
  code: ZoteroSyncFailureCode;
  retryable: boolean;
  retryAt?: Date;
  connectionWideBackoff?: boolean;
  now?: Date;
  database?: PrismaClient;
}): Promise<"retrying" | "failed" | "dead-letter" | "lease-lost"> {
  const database = input.database ?? prisma;
  const now = input.now ?? new Date();
  return withTransactionRetry(database, () =>
    database.$transaction(async (transaction) => {
    if (!await leaseIsCurrent(transaction, input.lease, now)) {
      return "lease-lost" as const;
    }
    const job = await transaction.job.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
    });
    const retryAt = input.retryAt
      ?? new Date(now.getTime() + retryDelay(input.lease.attemptNumber));
    const mayRetry = input.retryable && job.attempts < job.maxAttempts;
    const deadLetter = input.retryable && !mayRetry;

    if (
      input.code === "zotero_authentication_failed"
      || input.code === "zotero_credential_unavailable"
    ) {
      await transaction.integrationConnection.updateMany({
        where: {
          id: input.lease.connectionId,
          organizationId: input.lease.organizationId,
          provider: "ZOTERO",
          status: { in: ["CONNECTED", "DEGRADED"] },
          updatedAt: input.lease.connectionUpdatedAt,
          credentialGeneration: input.lease.credentialGeneration,
          credentialFingerprint: input.lease.credentialFingerprint,
          credentialKeyVersion: input.lease.credentialKeyVersion,
        },
        data: {
          status: input.code === "zotero_authentication_failed"
            ? "REVOKED"
            : "DEGRADED",
          lastErrorCode: input.code,
          lastErrorMessage: null,
          revokedAt: input.code === "zotero_authentication_failed" ? now : undefined,
        },
      });
    }
    if (input.code === "zotero_forbidden") {
      const degraded = await transaction.integrationConnection.updateMany({
        where: {
          id: input.lease.connectionId,
          organizationId: input.lease.organizationId,
          provider: "ZOTERO",
          status: { in: ["CONNECTED", "DEGRADED"] },
          updatedAt: input.lease.connectionUpdatedAt,
          credentialGeneration: input.lease.credentialGeneration,
          credentialFingerprint: input.lease.credentialFingerprint,
          credentialKeyVersion: input.lease.credentialKeyVersion,
        },
        data: {
          status: "DEGRADED",
          lastErrorCode: input.code,
          lastErrorMessage: null,
        },
      });
      if (degraded.count === 1) {
        await transaction.zoteroLibrary.updateMany({
          where: {
            id: input.lease.zoteroLibraryId,
            organizationId: input.lease.organizationId,
            integrationConnectionId: input.lease.connectionId,
          },
          data: { isReadable: false, accessLostAt: now },
        });
      }
    }
    // Zotero's Backoff header is provider-wide even when this particular run
    // has exhausted its retry budget or failed for another terminal reason.
    if (input.connectionWideBackoff) {
      await transaction.integrationConnection.updateMany({
        where: {
          id: input.lease.connectionId,
          organizationId: input.lease.organizationId,
          provider: "ZOTERO",
          OR: [
            { providerBackoffUntil: null },
            { providerBackoffUntil: { lt: retryAt } },
          ],
        },
        data: { providerBackoffUntil: retryAt },
      });
    }

    const terminalStatus = deadLetter ? "DEAD_LETTER" : "FAILED";
    await transaction.job.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
      data: {
        status: mayRetry ? "RETRYING" : terminalStatus,
        runAfter: mayRetry ? retryAt : job.runAfter,
        completedAt: mayRetry ? null : now,
        lockedAt: null,
        lockedBy: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: input.code,
        lastErrorMessage: null,
      },
    });
    await transaction.jobAttempt.updateMany({
      where: {
        id: input.lease.jobAttemptId,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        leaseId: input.lease.leaseId,
        status: "RUNNING",
      },
      data: {
        status: mayRetry ? "FAILED" : terminalStatus,
        completedAt: now,
        errorCode: input.code,
        errorMessage: null,
      },
    });
    await transaction.zoteroSyncRun.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.runId,
        },
      },
      data: {
        status: mayRetry ? "BACKING_OFF" : "FAILED",
        backoffUntil: mayRetry ? retryAt : null,
        errorCode: input.code,
        errorMessage: null,
        completedAt: mayRetry ? null : now,
        conflicts: input.code === "stable_version_changed"
          ? { increment: 1 }
          : undefined,
      },
    });
    await transaction.zoteroSyncStage.deleteMany({
      where: {
        organizationId: input.lease.organizationId,
        zoteroSyncRunId: input.lease.runId,
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        actorUserId: input.lease.actorUserId,
        action: mayRetry
          ? "zotero.sync.retrying"
          : deadLetter
            ? "zotero.sync.dead_lettered"
            : "zotero.sync.failed",
        entityType: "zotero-sync-run",
        entityId: input.lease.runId,
        metadata: {
          errorCode: input.code,
          retryAt: mayRetry ? retryAt.toISOString() : null,
        },
      },
    });
    return mayRetry
      ? "retrying" as const
      : deadLetter
        ? "dead-letter" as const
        : "failed" as const;
  }, { isolationLevel: "Serializable" }));
}
