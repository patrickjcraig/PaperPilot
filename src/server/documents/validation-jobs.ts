import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueDocumentTextExtractionJob } from "./extraction-jobs";
import {
  DOCUMENT_VALIDATION_POLICY_VERSION,
  LOCAL_QUARANTINE_STORAGE_VERSION,
} from "./validation-constants";
import { ensureBrowserUploadIngestReceipt } from "./ingest-receipts";
import {
  projectDocumentPipelineLifecycle,
  type DocumentPipelineAuthorityKey,
} from "./intake-lifecycle";

export {
  DOCUMENT_VALIDATION_POLICY_VERSION,
  LOCAL_QUARANTINE_STORAGE_VERSION,
} from "./validation-constants";
export const DOCUMENT_VALIDATION_MAX_ATTEMPTS = 4;
export const DEFAULT_DOCUMENT_VALIDATION_LEASE_TTL_MS = 2 * 60_000;

const MIN_LEASE_TTL_MS = 10_000;
const MAX_LEASE_TTL_MS = 15 * 60_000;
const MAX_WORKER_ID_BYTES = 200;
const MAX_SAFE_ERROR_MESSAGE_BYTES = 500;
const MAX_CLAIM_REAP_LOOPS = 8;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:+/-]{0,127}$/;
const VALIDATION_REJECTION_CODES = new Set([
  "malware_detected",
  "pdf_invalid",
  "pdf_policy_violation",
  "pdf_resource_limit_exceeded",
  "malware_and_pdf_invalid",
]);

const SAFE_EXECUTION_FAILURES = {
  validation_service_unavailable: "The validation service was unavailable.",
  validation_service_timeout: "The validation service timed out.",
  validation_response_invalid: "The validation service returned an invalid response.",
  validation_attestation_stale: "The validation attestation was not fresh enough.",
  validation_input_changed: "The quarantined input changed during validation.",
  validation_object_missing: "The quarantined input could not be opened.",
  validation_worker_internal: "The validation worker could not finish safely.",
} as const;

export type DocumentValidationExecutionFailureCode = keyof typeof SAFE_EXECUTION_FAILURES;

export interface EnqueueDocumentValidationJobInput {
  organizationId: string;
  documentId: string;
  assetId: string;
  ingestReceiptId?: string;
  /** Transitional caller input; it is resolved to a generic receipt before enqueue. */
  uploadSessionId?: string;
  createdById?: string | null;
  policyVersion?: string;
  storageVersion?: string;
  now?: Date;
}

export interface DocumentValidationLease {
  organizationId: string;
  jobId: string;
  jobAttemptId: string;
  attemptNumber: number;
  workerId: string;
  leaseId: string;
  leaseExpiresAt: Date;
  documentId: string;
  assetId: string;
  intakeId: string;
  ingestReceiptId: string;
  storageProvider: "LOCAL";
  storageKey: string;
  inputSha256: string;
  inputSizeBytes: bigint;
  policyVersion: string;
  storageVersion: string;
  storageAuthorityGeneration?: string | null;
}

export interface ValidatedDocumentAttestation {
  inputSha256: string;
  inputSizeBytes: bigint;
  storageVersion: string;
  policyVersion: string;
  toolchainDigest: string;
  verdict: "ACCEPTED" | "REJECTED";
  rejectionCode: string | null;
  malwareVerdict: "CLEAN" | "INFECTED";
  malwareEngine: string;
  malwareEngineVersion: string;
  signatureVersion: string;
  signaturePublishedAt: Date;
  scannedAt: Date;
  pdfStructuralVerdict: "VALID" | "INVALID";
  pdfEngine: string;
  pdfEngineVersion: string;
  pdfVersion: string;
  pageCount: number | null;
  objectCount: number | null;
  revisionCount: number | null;
  checkedAt: Date;
  result: {
    schemaVersion: 1;
    detectionCount: number;
    warningCount: number;
    malwareDurationMs: number;
    pdfDurationMs: number;
    totalDurationMs: number;
    completedAt: string;
  };
}

export interface CompleteDocumentValidationResult {
  outcome: "applied" | "replayed";
  verdict: "ACCEPTED" | "REJECTED";
}

interface ValidationJobPayload {
  schemaVersion: 2;
  policyVersion: string;
  storageVersion: string;
  source: "document-ingest";
  ingestReceiptId: string;
}

interface CandidateRow {
  id: string;
}

type ValidationTransaction = Prisma.TransactionClient;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validIdentifier(value: string, maxBytes = 200): boolean {
  return value.length > 0 && byteLength(value) <= maxBytes;
}

function requireWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  if (!validIdentifier(normalized, MAX_WORKER_ID_BYTES)) {
    throw new TypeError("A bounded worker identifier is required.");
  }
  return normalized;
}

function requireLeaseTtl(leaseTtlMs: number): number {
  if (
    !Number.isSafeInteger(leaseTtlMs)
    || leaseTtlMs < MIN_LEASE_TTL_MS
    || leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new TypeError("The validation lease TTL is outside the supported range.");
  }
  return leaseTtlMs;
}

function requireSafeVersion(value: string, label: string): string {
  if (!SAFE_VALUE_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function documentValidationJobDedupeKey(
  ingestReceiptId: string,
  policyVersion = DOCUMENT_VALIDATION_POLICY_VERSION,
): string {
  if (!validIdentifier(ingestReceiptId, 200)) {
    throw new TypeError("A bounded document ingest receipt identifier is required.");
  }
  requireSafeVersion(policyVersion, "Validation policy version");
  return `document-ingest:${ingestReceiptId}:${policyVersion}`;
}

function validationPayload(
  input: EnqueueDocumentValidationJobInput,
  ingestReceiptId: string,
): ValidationJobPayload {
  const policyVersion = requireSafeVersion(
    input.policyVersion ?? DOCUMENT_VALIDATION_POLICY_VERSION,
    "Validation policy version",
  );
  const storageVersion = requireSafeVersion(
    input.storageVersion ?? LOCAL_QUARANTINE_STORAGE_VERSION,
    "Storage version",
  );
  if (!validIdentifier(ingestReceiptId, 200)) {
    throw new TypeError("A bounded document ingest receipt identifier is required.");
  }
  return {
    schemaVersion: 2,
    policyVersion,
    storageVersion,
    source: "document-ingest",
    ingestReceiptId,
  };
}

function parseValidationPayload(value: Prisma.JsonValue | null): ValidationJobPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const allowed = new Set([
    "schemaVersion",
    "policyVersion",
    "storageVersion",
    "source",
    "ingestReceiptId",
  ]);
  if (keys.some((key) => !allowed.has(key))) return null;
  const candidate = value as Record<string, Prisma.JsonValue>;
  if (
    candidate.schemaVersion !== 2
    || candidate.source !== "document-ingest"
    || typeof candidate.policyVersion !== "string"
    || typeof candidate.storageVersion !== "string"
    || typeof candidate.ingestReceiptId !== "string"
    || !SAFE_VALUE_PATTERN.test(candidate.policyVersion)
    || !SAFE_VALUE_PATTERN.test(candidate.storageVersion)
    || !validIdentifier(candidate.ingestReceiptId, 200)
  ) return null;
  return {
    schemaVersion: 2,
    source: "document-ingest",
    policyVersion: candidate.policyVersion,
    storageVersion: candidate.storageVersion,
    ingestReceiptId: candidate.ingestReceiptId,
  };
}

export async function enqueueDocumentValidationJob(
  transaction: ValidationTransaction,
  input: EnqueueDocumentValidationJobInput,
) {
  let ingestReceiptId = input.ingestReceiptId;
  if (input.uploadSessionId) {
    const browserReceipt = await ensureBrowserUploadIngestReceipt(transaction, {
      organizationId: input.organizationId,
      uploadSessionId: input.uploadSessionId,
      documentId: input.documentId,
      assetId: input.assetId,
      storageVersion: input.storageVersion,
    });
    if (ingestReceiptId && ingestReceiptId !== browserReceipt.id) {
      throw new Error("The upload session and ingest receipt identify different custody.");
    }
    ingestReceiptId = browserReceipt.id;
  }
  if (!ingestReceiptId) {
    throw new TypeError("A document ingest receipt is required.");
  }
  const receipt = await transaction.documentIngestReceipt.findFirst({
    where: {
      id: ingestReceiptId,
      organizationId: input.organizationId,
      documentId: input.documentId,
      assetId: input.assetId,
    },
  });
  if (!receipt) {
    throw new Error("The document ingest receipt does not authorize this validation target.");
  }
  const payload = validationPayload(input, receipt.id);
  const dedupeKey = documentValidationJobDedupeKey(
    receipt.id,
    payload.policyVersion,
  );
  const existing = await transaction.job.findUnique({
    where: {
      organizationId_type_dedupeKey: {
        organizationId: input.organizationId,
        type: "DOCUMENT_VALIDATE",
        dedupeKey,
      },
    },
  });
  if (existing) {
    const existingPayload = parseValidationPayload(existing.payload);
    if (
      !existingPayload
      || existingPayload.ingestReceiptId !== receipt.id
      || existingPayload.policyVersion !== payload.policyVersion
      || existingPayload.storageVersion !== payload.storageVersion
      || existing.organizationId !== input.organizationId
      || existing.documentId !== input.documentId
      || existing.assetId !== input.assetId
      || existing.intakeId !== receipt.intakeId
      || existing.ingestReceiptId !== receipt.id
    ) {
      throw new Error("A validation dedupe key resolved to a different target.");
    }
    return existing;
  }
  return transaction.job.create({
    data: {
      organizationId: input.organizationId,
      type: "DOCUMENT_VALIDATE",
      status: "QUEUED",
      dedupeKey,
      priority: 10,
      payload: { ...payload },
      attempts: 0,
      maxAttempts: DOCUMENT_VALIDATION_MAX_ATTEMPTS,
      runAfter: input.now ?? new Date(),
      documentId: input.documentId,
      assetId: input.assetId,
      intakeId: receipt.intakeId,
      ingestReceiptId: receipt.id,
      createdById: input.createdById ?? null,
    },
  });
}

function canonicalRejectionCode(attestation: ValidatedDocumentAttestation): string {
  if (attestation.malwareVerdict === "INFECTED") return "malware_detected";
  if (attestation.pdfStructuralVerdict === "INVALID") return "invalid_pdf_structure";
  const code = attestation.rejectionCode?.trim() ?? "";
  if (new Set([
    "malware_detected",
    "invalid_pdf_structure",
    "pdf_policy_violation",
    "pdf_resource_limit_exceeded",
    "integrity_check_failed",
  ]).has(code)) return code;
  return "validation_failed";
}

function assertAttestation(attestation: ValidatedDocumentAttestation): void {
  if (
    !SHA256_PATTERN.test(attestation.inputSha256)
    || !SHA256_PATTERN.test(attestation.toolchainDigest)
    || attestation.inputSizeBytes < 1n
  ) throw new TypeError("The validation attestation input identity is invalid.");
  for (const [label, value] of [
    ["storageVersion", attestation.storageVersion],
    ["policyVersion", attestation.policyVersion],
    ["malwareEngine", attestation.malwareEngine],
    ["malwareEngineVersion", attestation.malwareEngineVersion],
    ["signatureVersion", attestation.signatureVersion],
    ["pdfEngine", attestation.pdfEngine],
    ["pdfEngineVersion", attestation.pdfEngineVersion],
    ["pdfVersion", attestation.pdfVersion],
  ] as const) {
    requireSafeVersion(value, label);
  }
  for (const value of [
    attestation.signaturePublishedAt,
    attestation.scannedAt,
    attestation.checkedAt,
  ]) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("The validation attestation timestamp is invalid.");
    }
  }
  if (
    attestation.pageCount !== null
    && (!Number.isSafeInteger(attestation.pageCount) || attestation.pageCount < 1)
  ) throw new TypeError("The validation page count is invalid.");
  if (
    attestation.objectCount !== null
    && (!Number.isSafeInteger(attestation.objectCount) || attestation.objectCount < 0)
  ) throw new TypeError("The validation object count is invalid.");
  if (
    attestation.revisionCount !== null
    && (!Number.isSafeInteger(attestation.revisionCount) || attestation.revisionCount < 1)
  ) throw new TypeError("The validation revision count is invalid.");
  if (
    attestation.verdict === "ACCEPTED"
    && (
      attestation.rejectionCode !== null
      || attestation.malwareVerdict !== "CLEAN"
      || attestation.pdfStructuralVerdict !== "VALID"
      || attestation.pageCount === null
    )
  ) throw new TypeError("An accepted attestation is internally inconsistent.");
  if (
    attestation.verdict === "REJECTED"
    && (
      !attestation.rejectionCode
      || !VALIDATION_REJECTION_CODES.has(attestation.rejectionCode)
    )
  ) throw new TypeError("A rejected attestation requires a bounded rejection code.");
  if (attestation.verdict === "REJECTED") {
    const clean = attestation.malwareVerdict === "CLEAN";
    const structurallyValid = attestation.pdfStructuralVerdict === "VALID";
    if (
      (clean && structurallyValid
        && attestation.rejectionCode !== "pdf_policy_violation")
      || (clean && !structurallyValid
        && attestation.rejectionCode !== "pdf_invalid"
        && attestation.rejectionCode !== "pdf_resource_limit_exceeded")
      || (!clean && structurallyValid
        && attestation.rejectionCode !== "malware_detected")
      || (!clean && !structurallyValid
        && attestation.rejectionCode !== "malware_and_pdf_invalid")
    ) throw new TypeError("A rejected attestation is internally inconsistent.");
  }
  if (
    attestation.signaturePublishedAt > attestation.scannedAt
    || attestation.scannedAt > attestation.checkedAt
  ) throw new TypeError("The validation attestation chronology is invalid.");
  {
    const result = attestation.result;
    const keys = Object.keys(result);
    const expectedKeys = new Set([
      "schemaVersion",
      "detectionCount",
      "warningCount",
      "malwareDurationMs",
      "pdfDurationMs",
      "totalDurationMs",
      "completedAt",
    ]);
    if (
      keys.length !== expectedKeys.size
      || keys.some((key) => !expectedKeys.has(key))
      || result.schemaVersion !== 1
      || !Number.isSafeInteger(result.detectionCount)
      || result.detectionCount < 0
      || result.detectionCount > 128
      || !Number.isSafeInteger(result.warningCount)
      || result.warningCount < 0
      || result.warningCount > 10_000
      || !Number.isSafeInteger(result.malwareDurationMs)
      || result.malwareDurationMs < 0
      || result.malwareDurationMs > 120_000
      || !Number.isSafeInteger(result.pdfDurationMs)
      || result.pdfDurationMs < 0
      || result.pdfDurationMs > 120_000
      || !Number.isSafeInteger(result.totalDurationMs)
      || result.totalDurationMs < Math.max(result.malwareDurationMs, result.pdfDurationMs)
      || result.totalDurationMs > 120_000
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.completedAt)
      || !Number.isFinite(new Date(result.completedAt).getTime())
      || new Date(result.completedAt) < attestation.checkedAt
    ) throw new TypeError("The validation attestation result summary is invalid.");
  }
}

function retryDelayMs(attemptNumber: number): number {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attemptNumber - 1)));
}

function validationPipelineKey(job: {
  organizationId: string;
  documentId: string | null;
  assetId: string | null;
  intakeId: string | null;
  ingestReceiptId: string | null;
}): DocumentPipelineAuthorityKey | null {
  return job.documentId && job.assetId && job.intakeId && job.ingestReceiptId
    ? {
      organizationId: job.organizationId,
      documentId: job.documentId,
      assetId: job.assetId,
      intakeId: job.intakeId,
      ingestReceiptId: job.ingestReceiptId,
    }
    : null;
}

async function failTargetWithoutClaim(
  transaction: ValidationTransaction,
  job: {
    id: string;
    organizationId: string;
    documentId: string | null;
    assetId: string | null;
    intakeId: string | null;
    ingestReceiptId: string | null;
    leaseId: string | null;
    status: string;
  },
  code: string,
  now: Date,
): Promise<void> {
  const pipelineKey = validationPipelineKey(job);
  if (pipelineKey) {
    await projectDocumentPipelineLifecycle(
      transaction,
      pipelineKey,
      {
        stage: "validation-failed",
        failureCode: code === "validation_target_invalid"
          ? "integrity_check_failed"
          : "validation_unavailable",
        browserVerification: "unavailable",
      },
      now,
    );
  }
  if (job.status === "RUNNING" && job.leaseId) {
    await transaction.jobAttempt.updateMany({
      where: { jobId: job.id, leaseId: job.leaseId, status: "RUNNING" },
      data: {
        status: "DEAD_LETTER",
        completedAt: now,
        errorCode: code,
        errorMessage: "The validation target failed an authoritative state check.",
      },
    });
  }
  await transaction.job.update({
    where: {
      organizationId_id: {
        organizationId: job.organizationId,
        id: job.id,
      },
    },
    data: {
      status: "DEAD_LETTER",
      completedAt: now,
      lockedAt: null,
      lockedBy: null,
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorCode: code,
      lastErrorMessage: "The validation target failed an authoritative state check.",
    },
  });
  if (code === "worker_lease_expired" && job.assetId) {
    await transaction.asset.updateMany({
      where: {
        id: job.assetId,
        organizationId: job.organizationId,
        status: "SCANNING",
      },
      data: { status: "QUARANTINED" },
    });
  }
  const publicFailureCode = code === "validation_target_invalid"
    ? "integrity_check_failed"
    : "validation_unavailable";
  if (job.documentId) {
    await transaction.document.updateMany({
      where: {
        id: job.documentId,
        organizationId: job.organizationId,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "FAILED", failureCode: publicFailureCode },
    });
  }
  await transaction.auditEvent.create({
    data: {
      organizationId: job.organizationId,
      action: "document.validation.dead_lettered",
      entityType: "job",
      entityId: job.id,
      metadata: { failureCode: code },
    },
  });
}

export async function claimNextDocumentValidationJob(input: {
  workerId: string;
  leaseTtlMs?: number;
  now?: Date;
}): Promise<DocumentValidationLease | null> {
  const workerId = requireWorkerId(input.workerId);
  const leaseTtlMs = requireLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_DOCUMENT_VALIDATION_LEASE_TTL_MS,
  );
  const now = input.now ?? new Date();

  for (let loop = 0; loop < MAX_CLAIM_REAP_LOOPS; loop += 1) {
    const claimed = await prisma.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<CandidateRow[]>`
        SELECT "id"
        FROM "Job"
        WHERE "type" = 'DOCUMENT_VALIDATE'
          AND (
            (
              "status" IN ('QUEUED', 'RETRYING')
              AND (
                ("runAfter" <= ${now} AND "attempts" < "maxAttempts")
                OR "attempts" >= "maxAttempts"
              )
            )
            OR (
              "status" = 'RUNNING'
              AND "leaseExpiresAt" <= ${now}
            )
          )
        ORDER BY "priority" DESC, "runAfter", "createdAt", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const candidate = candidates[0];
      if (!candidate) return { kind: "empty" as const };
      const job = await transaction.job.findUniqueOrThrow({
        where: { id: candidate.id },
      });

      if (job.status !== "RUNNING" && job.attempts >= job.maxAttempts) {
        await failTargetWithoutClaim(
          transaction,
          job,
          "validation_attempt_budget_exhausted",
          now,
        );
        return { kind: "skip" as const };
      }

      if (job.status === "RUNNING") {
        if (!job.leaseId || !job.leaseExpiresAt || job.leaseExpiresAt > now) {
          return { kind: "skip" as const };
        }
        const exhausted = job.attempts >= job.maxAttempts;
        await transaction.jobAttempt.updateMany({
          where: { jobId: job.id, leaseId: job.leaseId, status: "RUNNING" },
          data: {
            status: exhausted ? "DEAD_LETTER" : "FAILED",
            completedAt: now,
            errorCode: "worker_lease_expired",
            errorMessage: "The validation worker lease expired.",
          },
        });
        if (exhausted) {
          await failTargetWithoutClaim(
            transaction,
            job,
            "worker_lease_expired",
            now,
          );
          return { kind: "skip" as const };
        }
        if (job.assetId) {
          await transaction.asset.updateMany({
            where: {
              id: job.assetId,
              organizationId: job.organizationId,
              status: "SCANNING",
            },
            data: { status: "QUARANTINED" },
          });
        }
        if (job.documentId) {
          await transaction.document.updateMany({
            where: {
              id: job.documentId,
              organizationId: job.organizationId,
              status: "PROCESSING",
            },
            data: { status: "PENDING" },
          });
        }
      }

      const payload = parseValidationPayload(job.payload);
      if (
        !payload
        || !job.documentId
        || !job.assetId
        || !job.intakeId
        || !job.ingestReceiptId
        || job.ingestReceiptId !== payload.ingestReceiptId
      ) {
        await failTargetWithoutClaim(
          transaction,
          job,
          "validation_target_invalid",
          now,
        );
        return { kind: "skip" as const };
      }
      const document = await transaction.document.findUnique({
          where: {
            organizationId_id: {
              organizationId: job.organizationId,
              id: job.documentId,
            },
          },
        });
      const asset = await transaction.asset.findUnique({
          where: {
            organizationId_id: {
              organizationId: job.organizationId,
              id: job.assetId,
            },
          },
        });
      const original = await transaction.documentAsset.findFirst({
          where: {
            organizationId: job.organizationId,
            documentId: job.documentId,
            assetId: job.assetId,
            role: "ORIGINAL",
          },
        });
      const receipt = await transaction.documentIngestReceipt.findFirst({
          where: {
            id: payload.ingestReceiptId,
            organizationId: job.organizationId,
            documentId: job.documentId,
            assetId: job.assetId,
            intakeId: job.intakeId,
          },
        });
      if (
        !document
        || !asset
        || !original
        || !receipt
        || receipt.intakeId !== job.intakeId
        || document.status !== "PENDING"
        || asset.status !== "QUARANTINED"
        || asset.storageProvider !== "LOCAL"
        || !asset.objectKey.startsWith("local-quarantine-v2:")
        || asset.physicalLocator !== asset.objectKey
        || !asset.sha256
        || !SHA256_PATTERN.test(asset.sha256)
        || asset.sizeBytes === null
        || asset.sizeBytes < 1n
        || document.contentHash !== asset.sha256
        || receipt.sha256 !== asset.sha256
        || receipt.receivedSizeBytes !== asset.sizeBytes
        || receipt.storageVersion !== payload.storageVersion
        || receipt.declaredMimeType !== "application/pdf"
      ) {
        await failTargetWithoutClaim(
          transaction,
          job,
          "validation_target_invalid",
          now,
        );
        return { kind: "skip" as const };
      }

      if (!await projectDocumentPipelineLifecycle(
        transaction,
        {
          organizationId: job.organizationId,
          documentId: job.documentId,
          assetId: job.assetId,
          intakeId: job.intakeId,
          ingestReceiptId: job.ingestReceiptId,
        },
        { stage: "validation-claim" },
        now,
      )) {
        await failTargetWithoutClaim(
          transaction,
          job,
          "validation_target_invalid",
          now,
        );
        return { kind: "skip" as const };
      }

      const leaseId = randomUUID();
      const jobAttemptId = randomUUID();
      const attemptNumber = job.attempts + 1;
      const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
      await transaction.job.update({
        where: {
          organizationId_id: {
            organizationId: job.organizationId,
            id: job.id,
          },
        },
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
      await transaction.asset.update({
        where: {
          organizationId_id: {
            organizationId: job.organizationId,
            id: asset.id,
          },
        },
        data: { status: "SCANNING", rejectionCode: null, rejectedReason: null },
      });
      await transaction.document.update({
        where: {
          organizationId_id: {
            organizationId: job.organizationId,
            id: document.id,
          },
        },
        data: { status: "PROCESSING", failureCode: null },
      });
      return {
        kind: "claimed" as const,
        value: {
          organizationId: job.organizationId,
          jobId: job.id,
          jobAttemptId,
          attemptNumber,
          workerId,
          leaseId,
          leaseExpiresAt,
          documentId: document.id,
          assetId: asset.id,
          intakeId: receipt.intakeId,
          ingestReceiptId: receipt.id,
          storageProvider: "LOCAL" as const,
          storageKey: asset.objectKey,
          inputSha256: asset.sha256,
          inputSizeBytes: asset.sizeBytes,
          policyVersion: payload.policyVersion,
          storageVersion: payload.storageVersion,
          storageAuthorityGeneration: receipt.storageAuthorityGeneration,
        },
      };
    });
    if (claimed.kind === "claimed") return claimed.value;
    if (claimed.kind === "empty") return null;
  }
  return null;
}

export async function heartbeatDocumentValidationLease(input: {
  lease: DocumentValidationLease;
  leaseTtlMs?: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const leaseTtlMs = requireLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_DOCUMENT_VALIDATION_LEASE_TTL_MS,
  );
  const extended = new Date(now.getTime() + leaseTtlMs);
  const updated = await prisma.job.updateMany({
    where: {
      id: input.lease.jobId,
      organizationId: input.lease.organizationId,
      type: "DOCUMENT_VALIDATE",
      status: "RUNNING",
      lockedBy: input.lease.workerId,
      leaseId: input.lease.leaseId,
      leaseExpiresAt: { gt: now },
      documentId: input.lease.documentId,
      assetId: input.lease.assetId,
      intakeId: input.lease.intakeId,
      ingestReceiptId: input.lease.ingestReceiptId,
    },
    data: { leaseExpiresAt: extended },
  });
  return updated.count === 1;
}

function attestationMatches(
  stored: {
    inputSha256: string;
    inputSizeBytes: bigint;
    policyVersion: string;
    storageVersion: string;
    toolchainDigest: string;
    verdict: "ACCEPTED" | "REJECTED";
    rejectionCode: string | null;
    malwareVerdict: "CLEAN" | "INFECTED";
    malwareEngine: string;
    malwareEngineVersion: string;
    signatureVersion: string;
    signaturePublishedAt: Date;
    scannedAt: Date;
    pdfStructuralVerdict: "VALID" | "INVALID";
    pdfEngine: string;
    pdfEngineVersion: string;
    pdfVersion: string;
    pageCount: number | null;
    objectCount: number | null;
    revisionCount: number | null;
    checkedAt: Date;
    result: Prisma.JsonValue | null;
  },
  requested: ValidatedDocumentAttestation,
): boolean {
  const result = stored.result;
  const resultMatches = typeof result === "object"
    && result !== null
    && !Array.isArray(result)
    && Object.keys(result).length === 7
    && result.schemaVersion === requested.result.schemaVersion
    && result.detectionCount === requested.result.detectionCount
    && result.warningCount === requested.result.warningCount
    && result.malwareDurationMs === requested.result.malwareDurationMs
    && result.pdfDurationMs === requested.result.pdfDurationMs
    && result.totalDurationMs === requested.result.totalDurationMs
    && result.completedAt === requested.result.completedAt;
  return stored.inputSha256 === requested.inputSha256
    && stored.inputSizeBytes === requested.inputSizeBytes
    && stored.policyVersion === requested.policyVersion
    && stored.storageVersion === requested.storageVersion
    && stored.toolchainDigest === requested.toolchainDigest
    && stored.verdict === requested.verdict
    && stored.rejectionCode === requested.rejectionCode
    && stored.malwareVerdict === requested.malwareVerdict
    && stored.malwareEngine === requested.malwareEngine
    && stored.malwareEngineVersion === requested.malwareEngineVersion
    && stored.signatureVersion === requested.signatureVersion
    && stored.signaturePublishedAt.getTime() === requested.signaturePublishedAt.getTime()
    && stored.scannedAt.getTime() === requested.scannedAt.getTime()
    && stored.pdfStructuralVerdict === requested.pdfStructuralVerdict
    && stored.pdfEngine === requested.pdfEngine
    && stored.pdfEngineVersion === requested.pdfEngineVersion
    && stored.pdfVersion === requested.pdfVersion
    && stored.pageCount === requested.pageCount
    && stored.objectCount === requested.objectCount
    && stored.revisionCount === requested.revisionCount
    && stored.checkedAt.getTime() === requested.checkedAt.getTime()
    && resultMatches;
}

export async function completeDocumentValidationLease(input: {
  lease: DocumentValidationLease;
  attestation: ValidatedDocumentAttestation;
  /** Independent worker-side pin carried into the durable extraction job. */
  extractionToolchainDigest: string;
  now?: Date;
}): Promise<CompleteDocumentValidationResult | null> {
  assertAttestation(input.attestation);
  if (
    !SHA256_PATTERN.test(input.extractionToolchainDigest)
    || /^0{64}$/.test(input.extractionToolchainDigest)
  ) {
    throw new TypeError("A nonzero expected extraction toolchain digest is required.");
  }
  const now = input.now ?? new Date();
  return prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "Job"
      WHERE "id" = ${input.lease.jobId}
        AND "organizationId" = ${input.lease.organizationId}
      FOR UPDATE
    `;
    if (!locked[0]) return null;
    const job = await transaction.job.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
    });
    const payload = parseValidationPayload(job.payload);
    const receipt = job.documentId && job.assetId && job.intakeId && job.ingestReceiptId
      ? await transaction.documentIngestReceipt.findFirst({
        where: {
          id: job.ingestReceiptId,
          organizationId: job.organizationId,
          documentId: job.documentId,
          assetId: job.assetId,
          intakeId: job.intakeId,
        },
      })
      : null;
    const exactAuthority = job.type === "DOCUMENT_VALIDATE"
      && job.documentId === input.lease.documentId
      && job.assetId === input.lease.assetId
      && job.intakeId === input.lease.intakeId
      && job.ingestReceiptId === input.lease.ingestReceiptId
      && payload?.ingestReceiptId === input.lease.ingestReceiptId
      && payload.policyVersion === input.lease.policyVersion
      && payload.storageVersion === input.lease.storageVersion
      && receipt?.intakeId === input.lease.intakeId
      && receipt.sha256 === input.lease.inputSha256
      && receipt.receivedSizeBytes === input.lease.inputSizeBytes
      && receipt.storageVersion === input.lease.storageVersion
      && receipt.declaredMimeType === "application/pdf";
    const existing = await transaction.documentValidationAttestation.findUnique({
      where: { jobAttemptId: input.lease.jobAttemptId },
      select: {
        organizationId: true,
        jobId: true,
        jobAttemptId: true,
        assetId: true,
        documentId: true,
        ingestReceiptId: true,
        inputSha256: true,
        inputSizeBytes: true,
        policyVersion: true,
        storageVersion: true,
        toolchainDigest: true,
        verdict: true,
        rejectionCode: true,
        malwareVerdict: true,
        malwareEngine: true,
        malwareEngineVersion: true,
        signatureVersion: true,
        signaturePublishedAt: true,
        scannedAt: true,
        pdfStructuralVerdict: true,
        pdfEngine: true,
        pdfEngineVersion: true,
        pdfVersion: true,
        pageCount: true,
        objectCount: true,
        revisionCount: true,
        checkedAt: true,
        result: true,
      },
    });
    if (job.status === "SUCCEEDED" && existing) {
      return exactAuthority
        && existing.organizationId === input.lease.organizationId
        && existing.jobId === input.lease.jobId
        && existing.jobAttemptId === input.lease.jobAttemptId
        && existing.assetId === input.lease.assetId
        && existing.documentId === input.lease.documentId
        && existing.ingestReceiptId === input.lease.ingestReceiptId
        && attestationMatches(existing, input.attestation)
        ? { outcome: "replayed" as const, verdict: existing.verdict }
        : null;
    }
    if (
      job.status !== "RUNNING"
      || job.leaseId !== input.lease.leaseId
      || job.lockedBy !== input.lease.workerId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= now
      || job.documentId !== input.lease.documentId
      || job.assetId !== input.lease.assetId
      || job.intakeId !== input.lease.intakeId
      || job.attempts !== input.lease.attemptNumber
      || !exactAuthority
    ) return null;
    if (
      !payload
      || payload.ingestReceiptId !== input.lease.ingestReceiptId
      || job.ingestReceiptId !== input.lease.ingestReceiptId
      || payload.policyVersion !== input.lease.policyVersion
      || payload.storageVersion !== input.lease.storageVersion
      || input.attestation.inputSha256 !== input.lease.inputSha256
      || input.attestation.inputSizeBytes !== input.lease.inputSizeBytes
      || input.attestation.policyVersion !== input.lease.policyVersion
      || input.attestation.storageVersion !== input.lease.storageVersion
    ) return null;
    const attempt = await transaction.jobAttempt.findUnique({
        where: {
          organizationId_id: {
            organizationId: input.lease.organizationId,
            id: input.lease.jobAttemptId,
          },
        },
      });
    const document = await transaction.document.findUnique({
        where: {
          organizationId_id: {
            organizationId: input.lease.organizationId,
            id: input.lease.documentId,
          },
        },
      });
    const asset = await transaction.asset.findUnique({
        where: {
          organizationId_id: {
            organizationId: input.lease.organizationId,
            id: input.lease.assetId,
          },
        },
      });
    if (
      !attempt
      || attempt.status !== "RUNNING"
      || attempt.jobId !== input.lease.jobId
      || attempt.attemptNumber !== input.lease.attemptNumber
      || attempt.leaseId !== input.lease.leaseId
      || attempt.workerId !== input.lease.workerId
      || !document
      || document.status !== "PROCESSING"
      || !asset
      || asset.status !== "SCANNING"
      || asset.storageProvider !== input.lease.storageProvider
      || asset.objectKey !== input.lease.storageKey
      || asset.physicalLocator !== input.lease.storageKey
      || asset.sha256 !== input.lease.inputSha256
      || asset.sizeBytes !== input.lease.inputSizeBytes
      || document.contentHash !== input.lease.inputSha256
      || !receipt
      || receipt.intakeId !== input.lease.intakeId
      || receipt.sha256 !== input.lease.inputSha256
      || receipt.receivedSizeBytes !== input.lease.inputSizeBytes
      || receipt.storageVersion !== input.lease.storageVersion
    ) return null;

    const rejectionCode = input.attestation.verdict === "REJECTED"
      ? canonicalRejectionCode(input.attestation)
      : null;
    const accepted = input.attestation.verdict === "ACCEPTED";
    if (!await projectDocumentPipelineLifecycle(
      transaction,
      {
        organizationId: input.lease.organizationId,
        documentId: input.lease.documentId,
        assetId: input.lease.assetId,
        intakeId: input.lease.intakeId,
        ingestReceiptId: input.lease.ingestReceiptId,
      },
      accepted
        ? { stage: "validation-accepted" }
        : {
          stage: "validation-failed",
          failureCode: rejectionCode ?? "validation_failed",
          browserVerification: "rejected",
        },
      now,
    )) return null;
    const persistedAttestation = await transaction.documentValidationAttestation.create({
      data: {
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        jobAttemptId: input.lease.jobAttemptId,
        assetId: input.lease.assetId,
        documentId: input.lease.documentId,
        ingestReceiptId: input.lease.ingestReceiptId,
        inputSha256: input.attestation.inputSha256,
        inputSizeBytes: input.attestation.inputSizeBytes,
        storageVersion: input.attestation.storageVersion,
        policyVersion: input.attestation.policyVersion,
        toolchainDigest: input.attestation.toolchainDigest,
        verdict: input.attestation.verdict,
        rejectionCode: input.attestation.rejectionCode,
        malwareVerdict: input.attestation.malwareVerdict,
        malwareEngine: input.attestation.malwareEngine,
        malwareEngineVersion: input.attestation.malwareEngineVersion,
        signatureVersion: input.attestation.signatureVersion,
        signaturePublishedAt: input.attestation.signaturePublishedAt,
        scannedAt: input.attestation.scannedAt,
        pdfStructuralVerdict: input.attestation.pdfStructuralVerdict,
        pdfEngine: input.attestation.pdfEngine,
        pdfEngineVersion: input.attestation.pdfEngineVersion,
        pdfVersion: input.attestation.pdfVersion,
        pageCount: input.attestation.pageCount,
        objectCount: input.attestation.objectCount,
        revisionCount: input.attestation.revisionCount,
        checkedAt: input.attestation.checkedAt,
        result: { ...input.attestation.result },
      },
    });
    if (accepted) {
      await enqueueDocumentTextExtractionJob(transaction, {
        organizationId: input.lease.organizationId,
        documentId: input.lease.documentId,
        assetId: input.lease.assetId,
        intakeId: input.lease.intakeId,
        ingestReceiptId: input.lease.ingestReceiptId,
        validationAttestationId: persistedAttestation.id,
        toolchainDigest: input.extractionToolchainDigest,
        createdById: job.createdById,
        storageVersion: input.attestation.storageVersion,
        now,
      });
    }
    await transaction.asset.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.assetId,
        },
      },
      data: accepted
        ? {
          status: "READY",
          scannedAt: input.attestation.scannedAt,
          validatedAt: input.attestation.checkedAt,
          validationPolicyVersion: input.attestation.policyVersion,
          rejectionCode: null,
          rejectedReason: null,
          metadata: {
            custody: "private-validated",
            publicAccess: false,
            malwareScan: "clean",
            documentValidation: "accepted",
            readerAvailable: false,
          },
        }
        : {
          status: "REJECTED",
          scannedAt: input.attestation.scannedAt,
          validatedAt: input.attestation.checkedAt,
          validationPolicyVersion: input.attestation.policyVersion,
          rejectionCode,
          rejectedReason: "The uploaded PDF did not pass the validation policy.",
          metadata: {
            custody: "private-quarantine",
            publicAccess: false,
            malwareScan: input.attestation.malwareVerdict === "INFECTED" ? "infected" : "clean",
            documentValidation: "rejected",
            readerAvailable: false,
          },
        },
    });
    await transaction.document.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.documentId,
        },
      },
      data: accepted
        ? {
          status: "READY",
          pageCount: input.attestation.pageCount,
          validatedAt: input.attestation.checkedAt,
          validationPolicyVersion: input.attestation.policyVersion,
          failureCode: null,
          metadata: {
            custody: "private-validated",
            malwareScan: "clean",
            verification: "accepted",
            extraction: "not-started",
            readerAvailable: false,
          },
        }
        : {
          status: "FAILED",
          validatedAt: input.attestation.checkedAt,
          validationPolicyVersion: input.attestation.policyVersion,
          failureCode: rejectionCode,
          metadata: {
            custody: "private-quarantine",
            malwareScan: input.attestation.malwareVerdict === "INFECTED" ? "infected" : "clean",
            verification: "rejected",
            extraction: "not-started",
            readerAvailable: false,
          },
        },
    });
    const inbox = receipt.inboxEntryId
      ? await transaction.inboxEntry.findFirst({
        where: {
          organizationId: input.lease.organizationId,
          id: receipt.inboxEntryId,
          documentId: input.lease.documentId,
        },
        select: { id: true },
      })
      : null;
    await transaction.jobAttempt.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobAttemptId,
        },
      },
      data: {
        status: "SUCCEEDED",
        completedAt: now,
        result: {
          schemaVersion: 1,
          verdict: input.attestation.verdict,
          rejectionCode,
        },
      },
    });
    await transaction.job.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
      data: {
        status: "SUCCEEDED",
        result: {
          schemaVersion: 1,
          verdict: input.attestation.verdict,
          rejectionCode,
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
    await transaction.provenanceRecord.create({
      data: {
        organizationId: input.lease.organizationId,
        kind: "SYSTEM",
        inboxEntryId: inbox?.id ?? null,
        documentId: input.lease.documentId,
        sourceProvider: "PaperPilot isolated document validation",
        sourceRecordId: input.lease.jobAttemptId,
        retrievedAt: now,
        payloadDigest: input.attestation.toolchainDigest,
        payload: {
          stage: "document-validation",
          verdict: input.attestation.verdict,
          policyVersion: input.attestation.policyVersion,
          storageVersion: input.attestation.storageVersion,
          rejectionCode,
          validatorRejectionCode: input.attestation.rejectionCode,
        },
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        action: accepted
          ? "document.validation.accepted"
          : "document.validation.rejected",
        entityType: "document",
        entityId: input.lease.documentId,
        metadata: {
          jobId: input.lease.jobId,
          assetId: input.lease.assetId,
          policyVersion: input.attestation.policyVersion,
          rejectionCode,
          validatorRejectionCode: input.attestation.rejectionCode,
        },
      },
    });
    return {
      outcome: "applied" as const,
      verdict: input.attestation.verdict,
    };
  });
}

export async function failDocumentValidationLease(input: {
  lease: DocumentValidationLease;
  code: DocumentValidationExecutionFailureCode;
  retryable: boolean;
  now?: Date;
}): Promise<"retrying" | "dead-letter" | "lease-lost"> {
  const now = input.now ?? new Date();
  const message = SAFE_EXECUTION_FAILURES[input.code];
  if (typeof message !== "string" || byteLength(message) > MAX_SAFE_ERROR_MESSAGE_BYTES) {
    throw new TypeError("The safe validation error message is too large.");
  }
  return prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "Job"
      WHERE "id" = ${input.lease.jobId}
        AND "organizationId" = ${input.lease.organizationId}
      FOR UPDATE
    `;
    if (!locked[0]) return "lease-lost" as const;
    const job = await transaction.job.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
    });
    if (
      job.status !== "RUNNING"
      || job.leaseId !== input.lease.leaseId
      || job.lockedBy !== input.lease.workerId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= now
      || job.documentId !== input.lease.documentId
      || job.assetId !== input.lease.assetId
      || job.intakeId !== input.lease.intakeId
      || job.ingestReceiptId !== input.lease.ingestReceiptId
      || job.attempts !== input.lease.attemptNumber
    ) return "lease-lost" as const;
    const attempt = await transaction.jobAttempt.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobAttemptId,
        },
      },
    });
    if (
      !attempt
      || attempt.jobId !== input.lease.jobId
      || attempt.attemptNumber !== input.lease.attemptNumber
      || attempt.status !== "RUNNING"
      || attempt.workerId !== input.lease.workerId
      || attempt.leaseId !== input.lease.leaseId
    ) return "lease-lost" as const;
    const canRetry = input.retryable && job.attempts < job.maxAttempts;
    if (!await projectDocumentPipelineLifecycle(
      transaction,
      {
        organizationId: input.lease.organizationId,
        documentId: input.lease.documentId,
        assetId: input.lease.assetId,
        intakeId: input.lease.intakeId,
        ingestReceiptId: input.lease.ingestReceiptId,
      },
      canRetry
        ? { stage: "validation-retry" }
        : {
          stage: "validation-failed",
          failureCode: new Set<DocumentValidationExecutionFailureCode>([
            "validation_input_changed",
            "validation_object_missing",
          ]).has(input.code)
            ? "integrity_check_failed"
            : input.code === "validation_response_invalid"
              ? "validation_failed"
              : "validation_unavailable",
          browserVerification: "unavailable",
        },
      now,
    )) return "lease-lost" as const;
    const closedAttempt = await transaction.jobAttempt.updateMany({
      where: {
        id: input.lease.jobAttemptId,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        leaseId: input.lease.leaseId,
        status: "RUNNING",
      },
      data: {
        status: canRetry ? "FAILED" : "DEAD_LETTER",
        completedAt: now,
        errorCode: input.code,
        errorMessage: message,
      },
    });
    if (closedAttempt.count !== 1) {
      throw new Error("The validation attempt changed concurrently.");
    }
    await transaction.job.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
      data: canRetry
        ? {
          status: "RETRYING",
          runAfter: new Date(now.getTime() + retryDelayMs(job.attempts)),
          completedAt: null,
          lockedAt: null,
          lockedBy: null,
          leaseId: null,
          leaseExpiresAt: null,
          lastErrorCode: input.code,
          lastErrorMessage: message,
        }
        : {
          status: "DEAD_LETTER",
          completedAt: now,
          lockedAt: null,
          lockedBy: null,
          leaseId: null,
          leaseExpiresAt: null,
          lastErrorCode: input.code,
          lastErrorMessage: message,
        },
    });
    await transaction.asset.updateMany({
      where: {
        id: input.lease.assetId,
        organizationId: input.lease.organizationId,
        status: "SCANNING",
        objectKey: input.lease.storageKey,
        sha256: input.lease.inputSha256,
        sizeBytes: input.lease.inputSizeBytes,
      },
      data: { status: "QUARANTINED" },
    });
    if (canRetry) {
      await transaction.document.updateMany({
        where: {
          id: input.lease.documentId,
          organizationId: input.lease.organizationId,
          status: "PROCESSING",
        },
        data: { status: "PENDING", failureCode: null },
      });
      return "retrying" as const;
    }
    const terminalFailureCode = new Set<DocumentValidationExecutionFailureCode>([
      "validation_input_changed",
      "validation_object_missing",
    ]).has(input.code)
      ? "integrity_check_failed"
      : input.code === "validation_response_invalid"
        ? "validation_failed"
        : "validation_unavailable";
    if (terminalFailureCode === "integrity_check_failed") {
      await transaction.asset.updateMany({
        where: {
          id: input.lease.assetId,
          organizationId: input.lease.organizationId,
          status: "QUARANTINED",
          objectKey: input.lease.storageKey,
        },
        data: {
          status: "REJECTED",
          rejectionCode: terminalFailureCode,
          rejectedReason: "The quarantined object failed a custody integrity check.",
        },
      });
    }
    await transaction.document.updateMany({
      where: {
        id: input.lease.documentId,
        organizationId: input.lease.organizationId,
        status: "PROCESSING",
      },
      data: { status: "FAILED", failureCode: terminalFailureCode },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        action: "document.validation.dead_lettered",
        entityType: "job",
        entityId: input.lease.jobId,
        metadata: { failureCode: input.code },
      },
    });
    return "dead-letter" as const;
  });
}
