import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type {
  CreateUploadSessionResult,
  UploadStatusDto,
  WorkspaceCommandFailure,
  WorkspaceCommandResult,
} from "@/lib/workspace";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getDocumentExtractionLifecycles } from "@/server/documents/extraction-authority";
import { HttpProblem } from "@/server/http/problem";
import { enqueueDocumentValidationJob } from "@/server/documents/validation-jobs";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { acquireWorkspaceMembershipAuthorityShared } from "@/server/workspaces/membership-lock";
import {
  inboxEntryVisibleTo,
  requireWorkspaceMutationRole,
} from "@/server/workspaces/project-access";
import {
  uploadConfigurationFromEnvironment,
  uploadPolicyConfigurationFromEnvironment,
} from "./config";
import { uploadStatusDto, uploadStatusInclude } from "./dto";
import { inboxReaderAuthorityFromLifecycle } from "@/server/workspaces/import-dto";
import {
  localQuarantineStorageKeyForAttempt,
  removeLocalQuarantineObject,
  streamRequestToLocalQuarantine,
} from "./storage";
import {
  normalizeUploadDisplayFilename,
  parseContentLengthHeader,
  requireExactPdfContentType,
} from "./validation";

export const MAX_UPLOAD_SESSION_COMMAND_BYTES = 16 * 1_024;
const MAX_TRANSACTION_ATTEMPTS = 4;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,100}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface SessionUser {
  id: string;
  name: string;
}

interface ValidatedCreateUpload {
  clientOperationId: string;
  expectedVersion: number;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  declaredMimeType: "application/pdf";
}

interface UploadClaim {
  claimId: string;
  intakeId: string;
  assetId: string;
  expectedSizeBytes: bigint;
  expectedSha256: string;
  attemptNumber: number;
  storageKey: string;
  leaseExpiresAt: Date;
}

const CREATE_UPLOAD_KEYS = new Set([
  "clientOperationId",
  "expectedVersion",
  "fileName",
  "sizeBytes",
  "sha256",
  "declaredMimeType",
]);

interface RetainedQuotaRow {
  retainedBytes: bigint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function validateCreateUpload(value: unknown, maxBytes: number): ValidatedCreateUpload {
  if (!isRecord(value)) validation("A JSON object is required.");
  const unsupported = Object.keys(value).find((key) => !CREATE_UPLOAD_KEYS.has(key));
  if (unsupported) validation(`Upload command contains an unsupported field: ${unsupported}.`);
  if (
    typeof value.clientOperationId !== "string"
    || !OPERATION_ID_PATTERN.test(value.clientOperationId)
  ) validation("clientOperationId is invalid.");
  if (
    typeof value.expectedVersion !== "number"
    || !Number.isSafeInteger(value.expectedVersion)
    || value.expectedVersion < 0
  ) validation("expectedVersion must be a non-negative integer.");
  const fileName = normalizeUploadDisplayFilename(value.fileName);
  if (
    typeof value.sizeBytes !== "number"
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 1
  ) validation("sizeBytes must be a positive integer.");
  if (value.sizeBytes > maxBytes) {
    throw new HttpProblem(413, "upload_too_large", "The selected PDF exceeds the upload limit.");
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    validation("sha256 must be the lowercase SHA-256 of the selected PDF.");
  }
  const declaredMimeType = requireExactPdfContentType(
    typeof value.declaredMimeType === "string" ? value.declaredMimeType : null,
  );
  return {
    clientOperationId: value.clientOperationId,
    expectedVersion: value.expectedVersion,
    fileName,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    declaredMimeType,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function failure(
  code: WorkspaceCommandFailure["code"],
  aggregateVersion: number,
  message: string,
): WorkspaceCommandFailure {
  return { ok: false, code, aggregateVersion, message };
}

function retryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && new Set(["P2002", "P2034"]).has(error.code);
}

async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!retryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS - 1) throw error;
    }
  }
  throw lastError;
}

async function retainedWorkspaceIntakeBytes(
  transaction: Prisma.TransactionClient,
  organizationId: string,
): Promise<bigint> {
  const [usage] = await transaction.$queryRaw<RetainedQuotaRow[]>`
    SELECT (
      COALESCE((
        SELECT SUM(COALESCE(intake."committedBytes", intake."reservedBytes"))
        FROM "DocumentIntake" AS intake
        WHERE intake."organizationId" = ${organizationId}
          AND intake."quotaReleasedAt" IS NULL
      ), 0)
      + COALESCE((
        SELECT SUM(attempt."expectedSizeBytes")
        FROM "UploadAttempt" AS attempt
        WHERE attempt."organizationId" = ${organizationId}
          AND attempt."status" IN ('FAILED', 'ABANDONED')
          AND attempt."cleanupCompletedAt" IS NULL
      ), 0)
      + COALESCE((
        SELECT SUM(COALESCE(attempt."expectedSizeBytes", attempt."maximumSizeBytes"))
        FROM "DocumentIngressAttempt" AS attempt
        WHERE attempt."organizationId" = ${organizationId}
          AND attempt."status" IN ('FAILED', 'ABANDONED')
          AND attempt."cleanupCompletedAt" IS NULL
      ), 0)
    )::bigint AS "retainedBytes"
  `;
  if (!usage || typeof usage.retainedBytes !== "bigint" || usage.retainedBytes < 0n) {
    throw new HttpProblem(
      503,
      "storage_unavailable",
      "The workspace storage reservation could not be verified.",
    );
  }
  return usage.retainedBytes;
}

async function failBrowserDocumentIntake(
  transaction: Prisma.TransactionClient,
  input: {
    organizationId: string;
    intakeId: string;
    documentId: string;
    assetId: string;
    failureCode: string;
    now: Date;
  },
): Promise<void> {
  const [pendingUploadAttempts, pendingIngressAttempts] = await Promise.all([
    transaction.uploadAttempt.count({
      where: {
        organizationId: input.organizationId,
        uploadSession: { intakeId: input.intakeId },
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
        organizationId: input.organizationId,
        intakeId: input.intakeId,
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
  const releasedAt = pendingUploadAttempts === 0 && pendingIngressAttempts === 0
    ? input.now
    : undefined;
  const updated = await transaction.documentIntake.updateMany({
    where: {
      id: input.intakeId,
      organizationId: input.organizationId,
      source: "BROWSER_UPLOAD",
      documentId: input.documentId,
      assetId: input.assetId,
      status: { in: ["RESERVED", "RECEIVING"] },
      quotaReleasedAt: null,
    },
    data: {
      status: "FAILED",
      failureCode: input.failureCode,
      completedAt: input.now,
      ...(releasedAt ? { quotaReleasedAt: releasedAt } : {}),
    },
  });
  if (updated.count !== 1) {
    throw new HttpProblem(
      409,
      "upload_state_changed",
      "The document intake state changed before the upload could close.",
    );
  }
}

function createUploadResult(
  status: UploadStatusDto,
  aggregateVersion: number,
  maxBytes: number,
  outcome: "applied" | "replayed",
  workspaceId: string,
): WorkspaceCommandResult<CreateUploadSessionResult> {
  return {
    ok: true,
    outcome,
    aggregateVersion,
    data: {
      inboxEntry: status.inboxEntry,
      upload: {
        id: status.upload.id,
        status: "awaiting-bytes",
        expiresAt: status.upload.expiresAt,
        maxBytes,
        contentUrl: `/api/workspaces/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(status.upload.id)}/content`,
      },
    },
  };
}

export async function createWorkspaceUploadSession(
  user: SessionUser,
  workspaceId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<CreateUploadSessionResult>> {
  const membership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(membership.role);
  // Reserving durable upload identity is a control-plane operation. It must not
  // require a local filesystem, because the serverless transfer adapter writes
  // the PDF directly to private object storage.
  const configuration = uploadPolicyConfigurationFromEnvironment();
  const command = validateCreateUpload(rawCommand, configuration.maxUploadBytes);
  const requestHash = digest({
    fileName: command.fileName,
    sizeBytes: command.sizeBytes,
    sha256: command.sha256,
    declaredMimeType: command.declaredMimeType,
  });

  return withTransactionRetry(() => prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`upload-operation:${workspaceId}:${command.clientOperationId}`}, 0)
      )::text
    `;
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`upload-quota:${workspaceId}`}, 0)
      )::text
    `;

    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, user.id);
    const currentMembership = await transaction.member.findUnique({
      where: {
        organizationId_userId: { organizationId: workspaceId, userId: user.id },
      },
      include: { organization: true },
    });
    if (!currentMembership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    requireWorkspaceMutationRole(currentMembership.role);

    const existing = await transaction.uploadSession.findUnique({
      where: {
        organizationId_clientOperationId: {
          organizationId: workspaceId,
          clientOperationId: command.clientOperationId,
        },
      },
      include: uploadStatusInclude,
    });
    if (existing) {
      if (existing.createdById !== user.id || existing.requestHash !== requestHash) {
        return failure(
          "idempotency_conflict",
          currentMembership.organization.revision,
          "clientOperationId was already used for a different upload.",
        );
      }
      return createUploadResult(
        uploadStatusDto(existing),
        currentMembership.organization.revision,
        configuration.maxUploadBytes,
        "replayed",
        workspaceId,
      );
    }

    if (currentMembership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        currentMembership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const now = new Date();
    const activeStatuses = ["ISSUED", "RECEIVING"] as const;
    const activeForUser = await transaction.uploadSession.count({
      where: {
        organizationId: workspaceId,
        createdById: user.id,
        status: { in: [...activeStatuses] },
        expiresAt: { gt: now },
      },
    });
    if (activeForUser >= configuration.maxConcurrentUploadsPerUser) {
      throw new HttpProblem(429, "upload_concurrency_exceeded", "Finish an active upload before starting another.");
    }
    const activeForWorkspace = await transaction.uploadSession.count({
      where: {
        organizationId: workspaceId,
        status: { in: [...activeStatuses] },
        expiresAt: { gt: now },
      },
    });
    if (activeForWorkspace >= configuration.maxConcurrentUploadsPerWorkspace) {
      throw new HttpProblem(429, "upload_concurrency_exceeded", "This workspace has too many active uploads.");
    }
    const retainedBytes = await retainedWorkspaceIntakeBytes(
      transaction,
      workspaceId,
    );
    if (
      retainedBytes + BigInt(command.sizeBytes)
      > BigInt(configuration.maxRetainedBytesPerWorkspace)
    ) {
      throw new HttpProblem(413, "storage_quota_exceeded", "This workspace's private upload storage limit has been reached.");
    }

    const bumped = await transaction.organization.updateMany({
      where: { id: workspaceId, revision: command.expectedVersion },
      data: { revision: { increment: 1 } },
    });
    if (bumped.count !== 1) {
      const current = await transaction.organization.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { revision: true },
      });
      return failure(
        "version_conflict",
        current.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const assetId = randomUUID();
    const documentId = randomUUID();
    const inboxEntryId = randomUUID();
    const uploadSessionId = randomUUID();
    const importBatchId = randomUUID();
    const expiresAt = new Date(now.getTime() + configuration.sessionTtlMs);
    await transaction.importBatch.create({
      data: {
        id: importBatchId,
        organizationId: workspaceId,
        source: "FILE_UPLOAD",
        status: "RUNNING",
        label: "Authenticated PDF upload",
        requestedById: user.id,
        externalRequestId: uploadSessionId,
        totalCount: 1,
        startedAt: now,
      },
    });
    await transaction.asset.create({
      data: {
        id: assetId,
        organizationId: workspaceId,
        storageProvider: "LOCAL",
        bucket: "private-quarantine-v1",
        objectKey: `pending:${assetId}`,
        status: "UPLOADING",
        originalFileName: command.fileName,
        mimeType: command.declaredMimeType,
        createdById: user.id,
        metadata: {
          custody: "reserved",
          publicAccess: false,
          verification: "not-started",
        },
      },
    });
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId: workspaceId,
        kind: "PAPER_PDF",
        status: "PENDING",
        mimeType: command.declaredMimeType,
        metadata: {
          custody: "upload-session",
          verification: "not-started",
          readerAvailable: false,
        },
      },
    });
    await transaction.documentAsset.create({
      data: {
        organizationId: workspaceId,
        documentId,
        assetId,
        role: "ORIGINAL",
      },
    });
    await transaction.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId: workspaceId,
        importBatchId,
        documentId,
        source: "FILE_UPLOAD",
        sourceKey: uploadSessionId,
        status: "NEEDS_REVIEW",
        payload: {
          schemaVersion: 1,
          kind: "document-upload",
          custody: "awaiting-bytes",
        },
        createdById: user.id,
      },
    });
    await transaction.documentIntake.create({
      data: {
        id: uploadSessionId,
        organizationId: workspaceId,
        source: "BROWSER_UPLOAD",
        status: "RESERVED",
        documentId,
        assetId,
        inboxEntryId,
        importBatchId,
        createdById: user.id,
        reservedBytes: BigInt(command.sizeBytes),
      },
    });
    await transaction.uploadSession.create({
      data: {
        id: uploadSessionId,
        organizationId: workspaceId,
        createdById: user.id,
        intakeId: uploadSessionId,
        assetId,
        documentId,
        inboxEntryId,
        clientOperationId: command.clientOperationId,
        requestHash,
        status: "ISSUED",
        originalFileName: command.fileName,
        declaredMimeType: command.declaredMimeType,
        expectedSizeBytes: BigInt(command.sizeBytes),
        sha256: command.sha256,
        expiresAt,
      },
    });
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "SYSTEM",
        inboxEntryId,
        documentId,
        actorUserId: user.id,
        sourceProvider: "PaperPilot upload",
        sourceRecordId: uploadSessionId,
        payload: {
          stage: "session-issued",
          expectedSha256: command.sha256,
          digestAuthority: "browser-claim-until-sandbox-verification",
        },
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        action: "upload.session.created",
        entityType: "upload-session",
        entityId: uploadSessionId,
        requestId: command.clientOperationId,
        metadata: {
          expectedSizeBytes: command.sizeBytes,
          expectedSha256: command.sha256,
          digestAuthority: "browser-claim-until-sandbox-verification",
          documentId,
          inboxEntryId,
        },
      },
    });
    const created = await transaction.uploadSession.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: workspaceId, id: uploadSessionId } },
      include: uploadStatusInclude,
    });
    return createUploadResult(
      uploadStatusDto(created),
      command.expectedVersion + 1,
      configuration.maxUploadBytes,
      "applied",
      workspaceId,
    );
  }, { isolationLevel: "Serializable" }));
}

async function claimUpload(
  userId: string,
  workspaceId: string,
  uploadSessionId: string,
): Promise<UploadClaim | UploadStatusDto> {
  const configuration = uploadConfigurationFromEnvironment();
  const result = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`upload-content:${workspaceId}:${uploadSessionId}`}, 0)
      )::text
    `;
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId } },
    });
    if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    requireWorkspaceMutationRole(membership.role);
    const session = await transaction.uploadSession.findFirst({
      where: { id: uploadSessionId, organizationId: workspaceId, createdById: userId },
      include: { ...uploadStatusInclude, intake: true },
    });
    if (!session) throw new HttpProblem(404, "upload_not_found", "Upload was not found.");
    if (
      session.intakeId !== session.id
      || session.intake.source !== "BROWSER_UPLOAD"
      || session.intake.documentId !== session.documentId
      || session.intake.assetId !== session.assetId
    ) {
      throw new HttpProblem(500, "invalid_upload_state", "Stored upload state is invalid.");
    }
    if (typeof session.sha256 !== "string" || !SHA256_PATTERN.test(session.sha256)) {
      throw new HttpProblem(500, "invalid_upload_state", "Stored upload state is invalid.");
    }
    if (session.status === "STORED") return { kind: "stored" as const, value: uploadStatusDto(session) };
    if (session.status === "REJECTED" || session.status === "EXPIRED") {
      throw new HttpProblem(410, "upload_session_closed", "This upload session is no longer active.");
    }
    const now = new Date();
    if (session.expiresAt <= now) {
      if (session.claimId) {
        await transaction.uploadAttempt.updateMany({
          where: {
            id: session.claimId,
            organizationId: workspaceId,
            uploadSessionId: session.id,
            status: { in: ["RECEIVING", "WRITTEN"] },
          },
          data: {
            status: "ABANDONED",
            completedAt: now,
            failureCode: "session_expired",
            cleanupAfter: now,
          },
        });
      }
      await failBrowserDocumentIntake(transaction, {
        organizationId: workspaceId,
        intakeId: session.intakeId,
        documentId: session.documentId,
        assetId: session.assetId,
        failureCode: "session_expired",
        now,
      });
      await transaction.uploadSession.update({
        where: { organizationId_id: { organizationId: workspaceId, id: session.id } },
        data: {
          status: "EXPIRED",
          claimedAt: null,
          claimExpiresAt: null,
          claimId: null,
          rejectedAt: now,
          failureCode: "session_expired",
        },
      });
      await transaction.asset.update({
        where: { organizationId_id: { organizationId: workspaceId, id: session.assetId } },
        data: { status: "REJECTED", rejectionCode: "session_expired" },
      });
      if (session.documentId) {
        await transaction.document.update({
          where: {
            organizationId_id: {
              organizationId: workspaceId,
              id: session.documentId,
            },
          },
          data: { status: "FAILED", failureCode: "session_expired" },
        });
      }
      if (session.inboxEntryId) {
        await transaction.inboxEntry.update({
          where: {
            organizationId_id: {
              organizationId: workspaceId,
              id: session.inboxEntryId,
            },
          },
          data: { status: "FAILED", failureCode: "session_expired" },
        });
      }
      return { kind: "expired" as const };
    }
    if (
      session.status === "RECEIVING"
      && session.claimExpiresAt
      && session.claimExpiresAt > now
    ) {
      throw new HttpProblem(409, "upload_in_progress", "This PDF transfer is already in progress.");
    }
    if (session.status === "RECEIVING" && session.claimId) {
      await transaction.uploadAttempt.updateMany({
        where: {
          id: session.claimId,
          organizationId: workspaceId,
          uploadSessionId: session.id,
          status: { in: ["RECEIVING", "WRITTEN"] },
        },
        data: {
          status: "ABANDONED",
          completedAt: now,
          failureCode: "receive_lease_expired",
          cleanupAfter: now,
        },
      });
    }
    const claimedIntake = await transaction.documentIntake.updateMany({
      where: {
        id: session.intakeId,
        organizationId: workspaceId,
        source: "BROWSER_UPLOAD",
        status: { in: ["RESERVED", "RECEIVING"] },
        documentId: session.documentId,
        assetId: session.assetId,
        quotaReleasedAt: null,
      },
      data: {
        status: "RECEIVING",
        failureCode: null,
        completedAt: null,
      },
    });
    if (claimedIntake.count !== 1) {
      throw new HttpProblem(
        409,
        "upload_state_changed",
        "The document intake is no longer available for receiving bytes.",
      );
    }
    const claimId = randomUUID();
    const claimExpiresAt = new Date(now.getTime() + configuration.leaseTtlMs);
    const attemptNumber = session.attemptCount + 1;
    const storageKey = localQuarantineStorageKeyForAttempt(
      { organizationId: workspaceId, assetId: session.assetId },
      claimId,
    );
    await transaction.uploadAttempt.create({
      data: {
        id: claimId,
        organizationId: workspaceId,
        uploadSessionId: session.id,
        assetId: session.assetId,
        attemptNumber,
        storageKey,
        status: "RECEIVING",
        expectedSizeBytes: session.expectedSizeBytes,
        leaseExpiresAt: claimExpiresAt,
      },
    });
    await transaction.uploadSession.update({
      where: { organizationId_id: { organizationId: workspaceId, id: session.id } },
      data: {
        status: "RECEIVING",
        claimedAt: now,
        claimExpiresAt,
        claimId,
        attemptCount: { increment: 1 },
      },
    });
    return {
      kind: "claimed" as const,
      value: {
        claimId,
        intakeId: session.intakeId,
        assetId: session.assetId,
        expectedSizeBytes: session.expectedSizeBytes,
        expectedSha256: session.sha256 as string,
        attemptNumber,
        storageKey,
        leaseExpiresAt: claimExpiresAt,
      },
    };
  }, { isolationLevel: "Serializable" });

  if (result.kind === "expired") {
    throw new HttpProblem(410, "upload_session_expired", "This upload session expired.");
  }
  return result.value;
}

const SAFE_REJECTION_CODES = new Set([
  "invalid_pdf_envelope",
  "pdf_trailing_data",
  "size_mismatch",
  "sha256_mismatch",
  "upload_too_large",
  "upload_aborted",
  "upload_timed_out",
  "storage_unavailable",
  "storage_finalize_failed",
]);

async function rejectClaim(
  userId: string,
  workspaceId: string,
  uploadSessionId: string,
  claimId: string,
  rawFailureCode: string,
): Promise<void> {
  const failureCode = SAFE_REJECTION_CODES.has(rawFailureCode)
    ? rawFailureCode
    : rawFailureCode === "content_length_mismatch"
      ? "size_mismatch"
    : "storage_unavailable";
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`upload-content:${workspaceId}:${uploadSessionId}`}, 0)
      )::text
    `;
    const session = await transaction.uploadSession.findFirst({
      where: {
        id: uploadSessionId,
        organizationId: workspaceId,
        createdById: userId,
        status: "RECEIVING",
        claimId,
      },
      select: {
        intakeId: true,
        assetId: true,
        documentId: true,
        inboxEntryId: true,
      },
    });
    if (!session) return;
    const now = new Date();
    await transaction.uploadAttempt.updateMany({
      where: {
        id: claimId,
        organizationId: workspaceId,
        uploadSessionId,
        assetId: session.assetId,
        status: { in: ["RECEIVING", "WRITTEN"] },
      },
      data: {
        status: "FAILED",
        completedAt: now,
        failureCode,
        cleanupAfter: now,
      },
    });
    await failBrowserDocumentIntake(transaction, {
      organizationId: workspaceId,
      intakeId: session.intakeId,
      documentId: session.documentId,
      assetId: session.assetId,
      failureCode,
      now,
    });
    await transaction.uploadSession.update({
      where: { organizationId_id: { organizationId: workspaceId, id: uploadSessionId } },
      data: {
        status: "REJECTED",
        claimedAt: null,
        claimExpiresAt: null,
        claimId: null,
        rejectedAt: now,
        failureCode,
      },
    });
    await transaction.asset.update({
      where: { organizationId_id: { organizationId: workspaceId, id: session.assetId } },
      data: { status: "REJECTED", rejectionCode: failureCode },
    });
    await transaction.document.update({
      where: { organizationId_id: { organizationId: workspaceId, id: session.documentId } },
      data: { status: "FAILED", failureCode },
    });
    const entry = await transaction.inboxEntry.update({
      where: { organizationId_id: { organizationId: workspaceId, id: session.inboxEntryId } },
      data: { status: "FAILED", failureCode },
      select: { importBatchId: true },
    });
    if (entry.importBatchId) {
      await transaction.importBatch.update({
        where: { organizationId_id: { organizationId: workspaceId, id: entry.importBatchId } },
        data: {
          status: "FAILED",
          processedCount: 1,
          failureCount: 1,
          completedAt: now,
        },
      });
    }
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: userId,
        action: "upload.rejected",
        entityType: "upload-session",
        entityId: uploadSessionId,
        metadata: { failureCode },
      },
    });
  }, { isolationLevel: "Serializable" });
}

async function markUploadAttemptWritten(
  userId: string,
  workspaceId: string,
  uploadSessionId: string,
  claim: UploadClaim,
  stored: Awaited<ReturnType<typeof streamRequestToLocalQuarantine>>,
): Promise<void> {
  try {
    const written = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`upload-content:${workspaceId}:${uploadSessionId}`}, 0)
        )::text
      `;
      await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
      const membership = await transaction.member.findUnique({
        where: { organizationId_userId: { organizationId: workspaceId, userId } },
      });
      if (!membership) {
        throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
      }
      requireWorkspaceMutationRole(membership.role);
      const now = new Date();
      const session = await transaction.uploadSession.findFirst({
        where: {
          id: uploadSessionId,
          organizationId: workspaceId,
          createdById: userId,
          status: "RECEIVING",
          claimId: claim.claimId,
          intakeId: claim.intakeId,
          assetId: claim.assetId,
          claimExpiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (!session) return false;
      const updated = await transaction.uploadAttempt.updateMany({
        where: {
          id: claim.claimId,
          organizationId: workspaceId,
          uploadSessionId,
          assetId: claim.assetId,
          attemptNumber: claim.attemptNumber,
          storageKey: stored.storageKey,
          status: "RECEIVING",
          leaseExpiresAt: { gt: now },
          expectedSizeBytes: stored.sizeBytes,
        },
        data: {
          status: "WRITTEN",
          receivedSizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storedAt: now,
        },
      });
      if (updated.count === 1) return true;
      const replay = await transaction.uploadAttempt.findFirst({
        where: {
          id: claim.claimId,
          organizationId: workspaceId,
          uploadSessionId,
          assetId: claim.assetId,
          attemptNumber: claim.attemptNumber,
          storageKey: stored.storageKey,
          status: "WRITTEN",
          receivedSizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          leaseExpiresAt: { gt: now },
        },
        select: { id: true },
      });
      return replay !== null;
    }, { isolationLevel: "Serializable" });
    if (!written) {
      throw new HttpProblem(
        409,
        "upload_state_changed",
        "The upload attempt is no longer active.",
      );
    }
  } catch (error) {
    const replay = await prisma.uploadAttempt.findFirst({
      where: {
        id: claim.claimId,
        organizationId: workspaceId,
        uploadSessionId,
        assetId: claim.assetId,
        attemptNumber: claim.attemptNumber,
        storageKey: stored.storageKey,
        status: "WRITTEN",
        receivedSizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        leaseExpiresAt: { gt: new Date() },
        uploadSession: {
          organizationId: workspaceId,
          id: uploadSessionId,
          createdById: userId,
          status: "RECEIVING",
          claimId: claim.claimId,
          intakeId: claim.intakeId,
        },
      },
      select: { id: true },
    }).catch(() => null);
    if (!replay) throw error;
  }
}

async function finalizeUpload(
  userId: string,
  workspaceId: string,
  uploadSessionId: string,
  claim: UploadClaim,
  stored: Awaited<ReturnType<typeof streamRequestToLocalQuarantine>>,
): Promise<UploadStatusDto> {
  if (stored.storageKey !== claim.storageKey) {
    throw new HttpProblem(409, "upload_state_changed", "The upload storage identity changed.");
  }
  return prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`upload-content:${workspaceId}:${uploadSessionId}`}, 0)
      )::text
    `;
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId } },
    });
    if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    requireWorkspaceMutationRole(membership.role);
    const now = new Date();
    const session = await transaction.uploadSession.findFirst({
      where: {
        id: uploadSessionId,
        organizationId: workspaceId,
        createdById: userId,
        status: "RECEIVING",
        claimId: claim.claimId,
        intakeId: claim.intakeId,
        assetId: claim.assetId,
        claimExpiresAt: { gt: now },
      },
      select: {
        intakeId: true,
        documentId: true,
        inboxEntryId: true,
        assetId: true,
      },
    });
    if (!session || session.intakeId !== uploadSessionId) {
      throw new HttpProblem(409, "upload_state_changed", "The upload state changed before it could be finalized.");
    }
    const attempt = await transaction.uploadAttempt.findFirst({
      where: {
        id: claim.claimId,
        organizationId: workspaceId,
        uploadSessionId,
        assetId: claim.assetId,
        attemptNumber: claim.attemptNumber,
        storageKey: claim.storageKey,
        status: { in: ["RECEIVING", "WRITTEN"] },
        leaseExpiresAt: { gt: now },
      },
    });
    if (!attempt) {
      throw new HttpProblem(409, "upload_state_changed", "The upload attempt is no longer active.");
    }
    await transaction.asset.update({
      where: { organizationId_id: { organizationId: workspaceId, id: session.assetId } },
      data: {
        objectKey: stored.storageKey,
        physicalLocator: stored.storageKey,
        status: "QUARANTINED",
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        metadata: {
          custody: "private-quarantine",
          publicAccess: false,
          pdfEnvelopeRecognized: true,
          pdfVersion: stored.pdfVersion,
          malwareScan: "not-started",
          documentValidation: "not-started",
          readerAvailable: false,
        },
      },
    });
    await transaction.document.update({
      where: { organizationId_id: { organizationId: workspaceId, id: session.documentId } },
      data: {
        status: "PENDING",
        contentHash: stored.sha256,
        validatedAt: null,
        validationPolicyVersion: null,
        failureCode: null,
        metadata: {
          custody: "private-quarantine",
          pdfEnvelopeRecognized: true,
          malwareScan: "not-started",
          verification: "not-started",
          extraction: "not-started",
          readerAvailable: false,
        },
      },
    });
    await transaction.inboxEntry.update({
      where: { organizationId_id: { organizationId: workspaceId, id: session.inboxEntryId } },
      data: {
        status: "NEEDS_REVIEW",
        payload: {
          schemaVersion: 1,
          kind: "document-upload",
          custody: "quarantined",
          verification: "not-started",
        },
      },
    });
    const intake = await transaction.documentIntake.updateMany({
      where: {
        id: session.intakeId,
        organizationId: workspaceId,
        source: "BROWSER_UPLOAD",
        status: "RECEIVING",
        documentId: session.documentId,
        assetId: session.assetId,
        inboxEntryId: session.inboxEntryId,
        quotaReleasedAt: null,
      },
      data: {
        status: "QUARANTINED",
        committedBytes: stored.sizeBytes,
        failureCode: null,
        completedAt: null,
      },
    });
    if (intake.count !== 1) {
      throw new HttpProblem(
        409,
        "upload_state_changed",
        "The document intake state changed before the upload could be finalized.",
      );
    }
    await transaction.uploadSession.update({
      where: { organizationId_id: { organizationId: workspaceId, id: uploadSessionId } },
      data: {
        status: "STORED",
        receivedSizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storedAt: now,
        claimedAt: null,
        claimExpiresAt: null,
        claimId: null,
      },
    });
    await transaction.uploadAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "COMMITTED",
        receivedSizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storedAt: now,
        completedAt: now,
      },
    });
    await enqueueDocumentValidationJob(transaction, {
      organizationId: workspaceId,
      documentId: session.documentId,
      assetId: session.assetId,
      uploadSessionId,
      createdById: userId,
      now,
    });
    const inbox = await transaction.inboxEntry.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: workspaceId, id: session.inboxEntryId } },
      select: { importBatchId: true },
    });
    if (inbox.importBatchId) {
      await transaction.importBatch.update({
        where: { organizationId_id: { organizationId: workspaceId, id: inbox.importBatchId } },
        data: {
          status: "RUNNING",
          processedCount: 0,
          successCount: 0,
          failureCount: 0,
          completedAt: null,
        },
      });
    }
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "IMPORT",
        inboxEntryId: session.inboxEntryId,
        documentId: session.documentId,
        actorUserId: userId,
        sourceProvider: "PaperPilot upload",
        sourceRecordId: uploadSessionId,
        retrievedAt: now,
        payloadDigest: stored.sha256,
        payload: {
          custody: "private-quarantine",
          sizeBytes: Number(stored.sizeBytes),
          pdfEnvelopeRecognized: true,
          verification: "not-started",
        },
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: userId,
        action: "upload.quarantined",
        entityType: "upload-session",
        entityId: uploadSessionId,
        metadata: {
          documentId: session.documentId,
          inboxEntryId: session.inboxEntryId,
          sizeBytes: Number(stored.sizeBytes),
          pdfEnvelopeRecognized: true,
          verification: "not-started",
        },
      },
    });
    const finalized = await transaction.uploadSession.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: workspaceId, id: uploadSessionId } },
      include: uploadStatusInclude,
    });
    return uploadStatusDto(finalized);
  }, { isolationLevel: "Serializable" });
}

export async function storeWorkspaceUploadContent(
  user: SessionUser,
  workspaceId: string,
  uploadSessionId: string,
  request: Request,
): Promise<UploadStatusDto> {
  const initialMembership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(initialMembership.role);
  requireExactPdfContentType(request.headers.get("content-type"));
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new HttpProblem(415, "unsupported_content_encoding", "Compressed upload requests are not supported.");
  }
  const declaredContentLength = parseContentLengthHeader(request.headers.get("content-length"));
  const preview = await prisma.uploadSession.findFirst({
    where: { id: uploadSessionId, organizationId: workspaceId, createdById: user.id },
    select: { expectedSizeBytes: true },
  });
  if (!preview) throw new HttpProblem(404, "upload_not_found", "Upload was not found.");
  if (declaredContentLength !== null && declaredContentLength !== preview.expectedSizeBytes) {
    throw new HttpProblem(400, "content_length_mismatch", "Content-Length does not match the reserved upload size.");
  }

  const configuration = uploadConfigurationFromEnvironment();
  const claimed = await claimUpload(user.id, workspaceId, uploadSessionId);
  if (!("claimId" in claimed)) return claimed;
  let stored: Awaited<ReturnType<typeof streamRequestToLocalQuarantine>>;
  try {
    stored = await streamRequestToLocalQuarantine({
      request,
      configuration,
      organizationId: workspaceId,
      assetId: claimed.assetId,
      attemptId: claimed.claimId,
      expectedSizeBytes: claimed.expectedSizeBytes,
    });
  } catch (error) {
    const failureCode = error instanceof HttpProblem ? error.code : "storage_unavailable";
    await rejectClaim(user.id, workspaceId, uploadSessionId, claimed.claimId, failureCode)
      .catch(() => undefined);
    throw error;
  }

  if (stored.sha256 !== claimed.expectedSha256) {
    await removeLocalQuarantineObject(configuration, stored.storageKey, {
      organizationId: workspaceId,
      assetId: claimed.assetId,
    }).catch(() => undefined);
    await rejectClaim(
      user.id,
      workspaceId,
      uploadSessionId,
      claimed.claimId,
      "sha256_mismatch",
    ).catch(() => undefined);
    throw new HttpProblem(
      409,
      "sha256_mismatch",
      "The received PDF does not match the file that was reserved.",
    );
  }

  try {
    await markUploadAttemptWritten(
      user.id,
      workspaceId,
      uploadSessionId,
      claimed,
      stored,
    );
    return await finalizeUpload(user.id, workspaceId, uploadSessionId, claimed, stored);
  } catch (error) {
    const committed = await prisma.uploadSession.findFirst({
      where: { id: uploadSessionId, organizationId: workspaceId, sha256: stored.sha256 },
      include: { ...uploadStatusInclude, intake: true },
    }).catch(() => null);
    if (
      committed?.status === "STORED"
      && committed.intakeId === uploadSessionId
      && committed.intake.source === "BROWSER_UPLOAD"
      && committed.intake.status === "QUARANTINED"
      && committed.intake.committedBytes === stored.sizeBytes
      && committed.intake.quotaReleasedAt === null
      && committed.assetId === claimed.assetId
      && committed.asset.objectKey === stored.storageKey
      && committed.asset.physicalLocator === stored.storageKey
      && committed.asset.sha256 === stored.sha256
      && committed.asset.sizeBytes === stored.sizeBytes
      && committed.receivedSizeBytes === stored.sizeBytes
    ) {
      return uploadStatusDto(committed);
    }
    await removeLocalQuarantineObject(configuration, stored.storageKey, {
      organizationId: workspaceId,
      assetId: claimed.assetId,
    }).catch(() => undefined);
    await rejectClaim(
      user.id,
      workspaceId,
      uploadSessionId,
      claimed.claimId,
      "storage_finalize_failed",
    ).catch(() => undefined);
    throw error;
  }
}

export async function getWorkspaceUploadStatus(
  userId: string,
  workspaceId: string,
  uploadSessionId: string,
): Promise<UploadStatusDto> {
  await requireWorkspaceMembership(userId, workspaceId);
  const session = await prisma.uploadSession.findFirst({
    where: {
      id: uploadSessionId,
      organizationId: workspaceId,
      inboxEntry: inboxEntryVisibleTo(userId, workspaceId),
    },
    include: uploadStatusInclude,
  });
  if (!session) throw new HttpProblem(404, "upload_not_found", "Upload was not found.");
  const linkedPaperId = session.document?.paperId && session.document.workspacePaperId
    ? session.document.paperId
    : undefined;
  const lifecycles = session.document
    ? await getDocumentExtractionLifecycles(workspaceId, [session.document.id])
    : new Map();
  const lifecycle = session.document ? lifecycles.get(session.document.id) : undefined;
  return uploadStatusDto(
    session,
    linkedPaperId && lifecycle
      ? inboxReaderAuthorityFromLifecycle(linkedPaperId, lifecycle)
      : undefined,
    !linkedPaperId ? lifecycle : undefined,
  );
}
