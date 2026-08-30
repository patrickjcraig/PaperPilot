import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
} from "./extraction-config";
import {
  MAX_EXTRACTED_CHUNK_BYTES,
  MAX_EXTRACTED_CHUNK_COUNT,
  MAX_EXTRACTED_PAGE_COUNT,
  MAX_EXTRACTED_TEXT_BYTES,
  type DocumentTextExtractionAttestation,
  type ExtractedDocumentTextChunk,
} from "./extraction-contract";
import { currentAcceptedValidation } from "./validation-authority";
import {
  projectDocumentPipelineLifecycle,
  type DocumentPipelineAuthorityKey,
} from "./intake-lifecycle";

export { DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION } from "./extraction-config";

export const DOCUMENT_TEXT_EXTRACTION_MAX_ATTEMPTS = 4;
export const DEFAULT_DOCUMENT_TEXT_EXTRACTION_LEASE_TTL_MS = 2 * 60_000;
export const DOCUMENT_TEXT_EXTRACTION_STORAGE_VERSION = "local-quarantine-v2";
export const DOCUMENT_TEXT_EXTRACTION_ADMISSION_RETRY_DELAY_MS = 5_000;

const MIN_LEASE_TTL_MS = 10_000;
const MAX_LEASE_TTL_MS = 15 * 60_000;
const MAX_WORKER_ID_BYTES = 200;
const MAX_IDENTIFIER_BYTES = 200;
const MAX_SAFE_ERROR_MESSAGE_BYTES = 500;
const MAX_CLAIM_REAP_LOOPS = 8;
const MAX_INPUT_BYTES = 25n * 1_024n * 1_024n;
const MAX_DURATION_MS = 180_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/;
const POLICY_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PARAGRAPH_ID_PATTERN = /^p([1-9]\d*)-p([1-9]\d*)$/;
const PROHIBITED_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

const SAFE_EXECUTION_FAILURES = {
  extraction_service_unavailable: "The text extraction service was unavailable.",
  extraction_service_timeout: "The text extraction service timed out.",
  extraction_response_invalid: "The text extraction service returned an invalid response.",
  extraction_input_unsupported: "The validated PDF is not supported for text extraction.",
  extraction_resource_limit: "The validated PDF exceeded a supported text extraction limit.",
  extraction_attestation_stale: "The text extraction attestation was not fresh enough.",
  extraction_input_changed: "The validated extraction input changed.",
  extraction_object_missing: "The validated extraction input could not be opened.",
  extraction_worker_internal: "The text extraction worker could not finish safely.",
} as const;

export type DocumentTextExtractionExecutionFailureCode =
  keyof typeof SAFE_EXECUTION_FAILURES;

export interface EnqueueDocumentTextExtractionJobInput {
  organizationId: string;
  documentId: string;
  assetId: string;
  /** Optional caller pins; immutable validation custody remains authoritative. */
  intakeId?: string;
  ingestReceiptId?: string;
  validationAttestationId: string;
  toolchainDigest: string;
  createdById?: string | null;
  policyVersion?: string;
  storageVersion?: string;
  now?: Date;
}

export interface DocumentTextExtractionLease {
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
  validationAttestationId: string;
  storageProvider: "LOCAL";
  storageKey: string;
  inputSha256: string;
  inputSizeBytes: bigint;
  expectedPageCount: number;
  policyVersion: string;
  storageVersion: string;
  storageAuthorityGeneration?: string | null;
  toolchainDigest: string;
}

export interface CompleteDocumentTextExtractionResult {
  outcome: "applied" | "replayed";
  extractionId: string;
  verdict: "EXTRACTED" | "NO_TEXT";
  chunkCount: number;
}

interface TextExtractionJobPayload {
  schemaVersion: 1;
  source: "accepted-document-validation";
  validationAttestationId: string;
  policyVersion: string;
  storageVersion: string;
  toolchainDigest: string;
}

interface CandidateRow {
  id: string;
}

interface DatabaseClockRow {
  now: Date;
}

type ExtractionTransaction = Prisma.TransactionClient;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validIdentifier(value: unknown, maximum = MAX_IDENTIFIER_BYTES): value is string {
  return typeof value === "string"
    && value.length > 0
    && byteLength(value) <= maximum;
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
    throw new TypeError("The text extraction lease TTL is outside the supported range.");
  }
  return leaseTtlMs;
}

function requireNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("A valid extraction lifecycle timestamp is required.");
  }
  return now;
}

function requireClockOverride(value: Date | undefined): Date | null {
  if (value === undefined) return null;
  return requireNow(value);
}

async function authoritativeLeaseNow(
  transaction: ExtractionTransaction,
  override: Date | null,
): Promise<Date> {
  const rows = await transaction.$queryRaw<DatabaseClockRow[]>`
    SELECT COALESCE(CAST(${override} AS timestamptz), clock_timestamp()) AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("The database lease clock is unavailable.");
  }
  return now;
}

function requireVersion(
  value: string,
  label: string,
  pattern = SAFE_VALUE_PATTERN,
): string {
  if (!pattern.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function documentTextExtractionJobDedupeKey(
  validationAttestationId: string,
  policyVersion = DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
  toolchainDigest?: string,
): string {
  if (!validIdentifier(validationAttestationId)) {
    throw new TypeError("A bounded validation attestation identifier is required.");
  }
  requireVersion(
    policyVersion,
    "Text extraction policy version",
    POLICY_VALUE_PATTERN,
  );
  if (toolchainDigest === undefined || !SHA256_PATTERN.test(toolchainDigest) || /^0{64}$/.test(toolchainDigest)) {
    throw new TypeError("A nonzero expected extraction toolchain digest is required.");
  }
  return `accepted-validation:${validationAttestationId}:${policyVersion}:${toolchainDigest}`;
}

function extractionPayload(
  input: EnqueueDocumentTextExtractionJobInput,
): TextExtractionJobPayload {
  if (!validIdentifier(input.validationAttestationId)) {
    throw new TypeError("A bounded validation attestation identifier is required.");
  }
  return {
    schemaVersion: 1,
    source: "accepted-document-validation",
    validationAttestationId: input.validationAttestationId,
    policyVersion: requireVersion(
      input.policyVersion ?? DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION,
      "Text extraction policy version",
      POLICY_VALUE_PATTERN,
    ),
    storageVersion: requireVersion(
      input.storageVersion ?? DOCUMENT_TEXT_EXTRACTION_STORAGE_VERSION,
      "Storage version",
    ),
    toolchainDigest: (() => {
      if (!SHA256_PATTERN.test(input.toolchainDigest) || /^0{64}$/.test(input.toolchainDigest)) {
        throw new TypeError("A nonzero expected extraction toolchain digest is required.");
      }
      return input.toolchainDigest;
    })(),
  };
}

function parseExtractionPayload(
  value: Prisma.JsonValue | null,
): TextExtractionJobPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const expected = new Set([
    "schemaVersion",
    "source",
    "validationAttestationId",
    "policyVersion",
    "storageVersion",
    "toolchainDigest",
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) return null;
  const candidate = value as Record<string, Prisma.JsonValue>;
  if (
    candidate.schemaVersion !== 1
    || candidate.source !== "accepted-document-validation"
    || !validIdentifier(candidate.validationAttestationId)
    || typeof candidate.policyVersion !== "string"
    || !POLICY_VALUE_PATTERN.test(candidate.policyVersion)
    || typeof candidate.storageVersion !== "string"
    || !SAFE_VALUE_PATTERN.test(candidate.storageVersion)
    || typeof candidate.toolchainDigest !== "string"
    || !SHA256_PATTERN.test(candidate.toolchainDigest)
    || /^0{64}$/.test(candidate.toolchainDigest)
  ) return null;
  return {
    schemaVersion: 1,
    source: "accepted-document-validation",
    validationAttestationId: candidate.validationAttestationId,
    policyVersion: candidate.policyVersion,
    storageVersion: candidate.storageVersion,
    toolchainDigest: candidate.toolchainDigest,
  };
}

export async function enqueueDocumentTextExtractionJob(
  transaction: ExtractionTransaction,
  input: EnqueueDocumentTextExtractionJobInput,
) {
  for (const [label, value] of [
    ["organizationId", input.organizationId],
    ["documentId", input.documentId],
    ["assetId", input.assetId],
  ] as const) {
    if (!validIdentifier(value)) throw new TypeError(`${label} is invalid.`);
  }
  const payload = extractionPayload(input);
  const validation = await transaction.documentValidationAttestation.findFirst({
    where: {
      id: payload.validationAttestationId,
      organizationId: input.organizationId,
      documentId: input.documentId,
      assetId: input.assetId,
    },
    select: { ingestReceiptId: true },
  });
  if (!validation) {
    throw new Error("The accepted validation does not authorize this extraction target.");
  }
  const receipt = await transaction.documentIngestReceipt.findFirst({
    where: {
      id: validation.ingestReceiptId,
      organizationId: input.organizationId,
      documentId: input.documentId,
      assetId: input.assetId,
    },
    select: { id: true, intakeId: true },
  });
  if (
    !receipt
    || (input.intakeId !== undefined && input.intakeId !== receipt.intakeId)
    || (input.ingestReceiptId !== undefined && input.ingestReceiptId !== receipt.id)
  ) {
    throw new Error("The validation receipt does not authorize this extraction target.");
  }
  const dedupeKey = documentTextExtractionJobDedupeKey(
    payload.validationAttestationId,
    payload.policyVersion,
    payload.toolchainDigest,
  );
  const existing = await transaction.job.findUnique({
    where: {
      organizationId_type_dedupeKey: {
        organizationId: input.organizationId,
        type: "TEXT_EXTRACTION",
        dedupeKey,
      },
    },
  });
  if (existing) {
    const existingPayload = parseExtractionPayload(existing.payload);
    if (
      existing.organizationId !== input.organizationId
      || existing.documentId !== input.documentId
      || existing.assetId !== input.assetId
      || existing.intakeId !== receipt.intakeId
      || existing.ingestReceiptId !== receipt.id
      || !existingPayload
      || existingPayload.validationAttestationId !== payload.validationAttestationId
      || existingPayload.policyVersion !== payload.policyVersion
      || existingPayload.storageVersion !== payload.storageVersion
      || existingPayload.toolchainDigest !== payload.toolchainDigest
    ) {
      throw new Error("A text extraction dedupe key resolved to a different target.");
    }
    return existing;
  }
  return transaction.job.create({
    data: {
      organizationId: input.organizationId,
      type: "TEXT_EXTRACTION",
      status: "QUEUED",
      dedupeKey,
      priority: 5,
      payload: { ...payload },
      attempts: 0,
      maxAttempts: DOCUMENT_TEXT_EXTRACTION_MAX_ATTEMPTS,
      runAfter: requireNow(input.now),
      documentId: input.documentId,
      assetId: input.assetId,
      intakeId: receipt.intakeId,
      ingestReceiptId: receipt.id,
      createdById: input.createdById ?? null,
    },
  });
}

function retryDelayMs(attemptNumber: number): number {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attemptNumber - 1)));
}

async function failTargetWithoutClaim(
  transaction: ExtractionTransaction,
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
  code: "extraction_target_invalid" | "extraction_attempt_budget_exhausted" | "worker_lease_expired",
  now: Date,
): Promise<void> {
  const pipelineKey = extractionPipelineKey(job);
  if (pipelineKey) {
    await projectDocumentPipelineLifecycle(
      transaction,
      pipelineKey,
      { stage: "extraction-attention", failureCode: code },
      now,
    );
  }
  if (job.status === "RUNNING" && job.leaseId) {
    await transaction.jobAttempt.updateMany({
      where: {
        organizationId: job.organizationId,
        jobId: job.id,
        leaseId: job.leaseId,
        status: "RUNNING",
      },
      data: {
        status: "DEAD_LETTER",
        completedAt: now,
        errorCode: code,
        errorMessage: "The text extraction target failed an authoritative state check.",
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
      lastErrorMessage: "The text extraction target failed an authoritative state check.",
    },
  });
  await transaction.auditEvent.create({
    data: {
      organizationId: job.organizationId,
      action: "document.text_extraction.dead_lettered",
      entityType: "job",
      entityId: job.id,
      metadata: { failureCode: code },
    },
  });
}

function extractionPipelineKey(job: {
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

async function authoritativeExtractionTarget(
  transaction: ExtractionTransaction,
  job: {
    id: string;
    organizationId: string;
    documentId: string | null;
    assetId: string | null;
    intakeId: string | null;
    ingestReceiptId: string | null;
  },
  payload: TextExtractionJobPayload,
) {
  if (!job.documentId || !job.assetId || !job.intakeId || !job.ingestReceiptId) return null;
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
  const validation = await transaction.documentValidationAttestation.findUnique({
      where: {
        organizationId_id: {
          organizationId: job.organizationId,
          id: payload.validationAttestationId,
        },
      },
    });
  const receipt = await transaction.documentIngestReceipt.findFirst({
    where: {
      id: job.ingestReceiptId,
      organizationId: job.organizationId,
      documentId: job.documentId,
      assetId: job.assetId,
      intakeId: job.intakeId,
    },
  });
  const intake = await transaction.documentIntake.findFirst({
    where: {
      id: job.intakeId,
      organizationId: job.organizationId,
      documentId: job.documentId,
      assetId: job.assetId,
      status: { in: ["EXTRACTING", "ATTENTION", "READY"] },
    },
  });
  if (!document || !asset || !original || !validation || !receipt || !intake) return null;
  const validationJob = await transaction.job.findUnique({
      where: {
        organizationId_id: {
          organizationId: job.organizationId,
          id: validation.jobId,
        },
      },
    });
  const validationAttempt = await transaction.jobAttempt.findUnique({
      where: {
        organizationId_id: {
          organizationId: job.organizationId,
          id: validation.jobAttemptId,
        },
      },
    });
  const authoritativeValidation = validation && validationJob && validationAttempt
    ? { ...validation, job: validationJob, jobAttempt: validationAttempt }
    : null;
  if (
    !authoritativeValidation
    || validation.ingestReceiptId !== receipt.id
    || validation.storageVersion !== payload.storageVersion
    || !currentAcceptedValidation(authoritativeValidation, document, asset)
  ) return null;
  return {
    document,
    asset,
    validation,
    receipt,
    intake,
    pageCount: authoritativeValidation.pageCount,
  };
}

export async function claimNextDocumentTextExtractionJob(input: {
  workerId: string;
  expectedPolicyVersion: string;
  expectedToolchainDigest: string;
  leaseTtlMs?: number;
  now?: Date;
}): Promise<DocumentTextExtractionLease | null> {
  const workerId = requireWorkerId(input.workerId);
  const expectedPolicyVersion = requireVersion(
    input.expectedPolicyVersion,
    "Expected text extraction policy version",
    POLICY_VALUE_PATTERN,
  );
  if (!SHA256_PATTERN.test(input.expectedToolchainDigest) || /^0{64}$/.test(input.expectedToolchainDigest)) {
    throw new TypeError("A nonzero expected extraction toolchain digest is required.");
  }
  const leaseTtlMs = requireLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_DOCUMENT_TEXT_EXTRACTION_LEASE_TTL_MS,
  );
  const clockOverride = requireClockOverride(input.now);

  for (let loop = 0; loop < MAX_CLAIM_REAP_LOOPS; loop += 1) {
    const claimed = await prisma.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<CandidateRow[]>`
        SELECT "id"
        FROM "Job"
        WHERE "type" = 'TEXT_EXTRACTION'
          AND (
            (
              jsonb_typeof("payload"->'toolchainDigest') = 'string'
              AND "payload"->>'toolchainDigest' = ${input.expectedToolchainDigest}
            )
            OR jsonb_typeof("payload"->'toolchainDigest') IS DISTINCT FROM 'string'
            OR COALESCE("payload"->>'toolchainDigest', '') !~ '^[0-9a-f]{64}$'
            OR "payload"->>'toolchainDigest' = ${"0".repeat(64)}
          )
          AND (
            (
              jsonb_typeof("payload"->'policyVersion') = 'string'
              AND "payload"->>'policyVersion' = ${expectedPolicyVersion}
            )
            OR jsonb_typeof("payload"->'policyVersion') IS DISTINCT FROM 'string'
            OR COALESCE("payload"->>'policyVersion', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
          )
          AND (
            (
              "status" IN ('QUEUED', 'RETRYING')
              AND (
                ("runAfter" <= COALESCE(CAST(${clockOverride} AS timestamptz), clock_timestamp()) AND "attempts" < "maxAttempts")
                OR "attempts" >= "maxAttempts"
              )
            )
            OR (
              "status" = 'RUNNING'
              AND "leaseExpiresAt" <= COALESCE(CAST(${clockOverride} AS timestamptz), clock_timestamp())
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
      // Read the authoritative clock after the row lock. In production the
      // database, not a worker host, owns lease expiry. The override exists
      // solely for deterministic lifecycle tests.
      const now = await authoritativeLeaseNow(transaction, clockOverride);

      if (job.status !== "RUNNING" && job.attempts >= job.maxAttempts) {
        await failTargetWithoutClaim(
          transaction,
          job,
          "extraction_attempt_budget_exhausted",
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
          where: {
            organizationId: job.organizationId,
            jobId: job.id,
            leaseId: job.leaseId,
            status: "RUNNING",
          },
          data: {
            status: exhausted ? "DEAD_LETTER" : "FAILED",
            completedAt: now,
            errorCode: "worker_lease_expired",
            errorMessage: "The text extraction worker lease expired.",
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
      }

      const payload = parseExtractionPayload(job.payload);
      if (!payload) {
        await failTargetWithoutClaim(
          transaction,
          job,
          "extraction_target_invalid",
          now,
        );
        return { kind: "skip" as const };
      }
      const target = await authoritativeExtractionTarget(transaction, job, payload);
      if (!target) {
        await failTargetWithoutClaim(
          transaction,
          job,
          "extraction_target_invalid",
          now,
        );
        return { kind: "skip" as const };
      }
      if (!await projectDocumentPipelineLifecycle(
        transaction,
        {
          organizationId: job.organizationId,
          documentId: target.document.id,
          assetId: target.asset.id,
          intakeId: target.intake.id,
          ingestReceiptId: target.receipt.id,
        },
        { stage: "extraction-claim" },
        now,
      )) {
        await failTargetWithoutClaim(
          transaction,
          job,
          "extraction_target_invalid",
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
          documentId: target.document.id,
          assetId: target.asset.id,
          intakeId: target.intake.id,
          ingestReceiptId: target.receipt.id,
          validationAttestationId: target.validation.id,
          storageProvider: "LOCAL" as const,
          storageKey: target.asset.objectKey,
          inputSha256: target.validation.inputSha256,
          inputSizeBytes: target.validation.inputSizeBytes,
          expectedPageCount: target.pageCount,
          policyVersion: payload.policyVersion,
          storageVersion: payload.storageVersion,
          storageAuthorityGeneration: target.receipt.storageAuthorityGeneration,
          toolchainDigest: payload.toolchainDigest,
        },
      };
    });
    if (claimed.kind === "claimed") return claimed.value;
    if (claimed.kind === "empty") return null;
  }
  return null;
}

export async function heartbeatDocumentTextExtractionLease(input: {
  lease: DocumentTextExtractionLease;
  leaseTtlMs?: number;
  now?: Date;
}): Promise<boolean> {
  const clockOverride = requireClockOverride(input.now);
  const leaseTtlMs = requireLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_DOCUMENT_TEXT_EXTRACTION_LEASE_TTL_MS,
  );
  const updated = await prisma.$executeRaw`
    UPDATE "Job"
    SET "leaseExpiresAt" = COALESCE(
      CAST(${clockOverride} AS timestamptz),
      clock_timestamp()
    ) + (${leaseTtlMs} * INTERVAL '1 millisecond'),
    "updatedAt" = COALESCE(CAST(${clockOverride} AS timestamptz), clock_timestamp())
    WHERE "id" = ${input.lease.jobId}
      AND "organizationId" = ${input.lease.organizationId}
      AND "type" = 'TEXT_EXTRACTION'
      AND "status" = 'RUNNING'
      AND "lockedBy" = ${input.lease.workerId}
      AND "leaseId" = ${input.lease.leaseId}
      AND "documentId" = ${input.lease.documentId}
      AND "assetId" = ${input.lease.assetId}
      AND "intakeId" = ${input.lease.intakeId}
      AND "ingestReceiptId" = ${input.lease.ingestReceiptId}
      AND "payload"->>'validationAttestationId' = ${input.lease.validationAttestationId}
      AND "payload"->>'policyVersion' = ${input.lease.policyVersion}
      AND "payload"->>'storageVersion' = ${input.lease.storageVersion}
      AND "payload"->>'toolchainDigest' = ${input.lease.toolchainDigest}
      AND "leaseExpiresAt" > COALESCE(
        CAST(${clockOverride} AS timestamptz),
        clock_timestamp()
      )
  `;
  return updated === 1;
}

/**
 * Releases a claim that the isolated service explicitly rejected before
 * admitting or reading the PDF. The provisional JobAttempt is removed and the
 * counter is rewound atomically, so deployment saturation cannot consume the
 * document's bounded execution budget. An append-only audit event preserves
 * the admission deferral even though it was never an execution attempt.
 */
export async function deferDocumentTextExtractionLeaseBeforeAdmission(input: {
  lease: DocumentTextExtractionLease;
  now?: Date;
}): Promise<"deferred" | "lease-lost"> {
  const clockOverride = requireClockOverride(input.now);
  return prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "Job"
      WHERE "id" = ${input.lease.jobId}
        AND "organizationId" = ${input.lease.organizationId}
      FOR UPDATE
    `;
    if (!locked[0]) return "lease-lost" as const;
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const job = await transaction.job.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
    });
    if (
      job.type !== "TEXT_EXTRACTION"
      || job.status !== "RUNNING"
      || job.leaseId !== input.lease.leaseId
      || job.lockedBy !== input.lease.workerId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= now
      || job.documentId !== input.lease.documentId
      || job.assetId !== input.lease.assetId
      || job.intakeId !== input.lease.intakeId
      || job.ingestReceiptId !== input.lease.ingestReceiptId
      || job.attempts !== input.lease.attemptNumber
      || job.attempts < 1
    ) return "lease-lost" as const;
    const payload = parseExtractionPayload(job.payload);
    if (
      !payload
      || payload.validationAttestationId !== input.lease.validationAttestationId
      || payload.policyVersion !== input.lease.policyVersion
      || payload.storageVersion !== input.lease.storageVersion
      || payload.toolchainDigest !== input.lease.toolchainDigest
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
    if (!await projectDocumentPipelineLifecycle(
      transaction,
      {
        organizationId: input.lease.organizationId,
        documentId: input.lease.documentId,
        assetId: input.lease.assetId,
        intakeId: input.lease.intakeId,
        ingestReceiptId: input.lease.ingestReceiptId,
      },
      { stage: "extraction-retry" },
      now,
    )) return "lease-lost" as const;

    const removed = await transaction.jobAttempt.deleteMany({
      where: {
        id: attempt.id,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        status: "RUNNING",
        workerId: input.lease.workerId,
        leaseId: input.lease.leaseId,
      },
    });
    if (removed.count !== 1) {
      throw new Error("The extraction admission attempt changed concurrently.");
    }
    await transaction.job.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
      data: {
        status: "RETRYING",
        attempts: job.attempts - 1,
        runAfter: new Date(
          now.getTime() + DOCUMENT_TEXT_EXTRACTION_ADMISSION_RETRY_DELAY_MS,
        ),
        completedAt: null,
        lockedAt: null,
        lockedBy: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: "extraction_service_busy",
        lastErrorMessage: "The text extraction request was deferred before admission.",
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        action: "document.text_extraction.admission_deferred",
        entityType: "job",
        entityId: input.lease.jobId,
        metadata: {
          documentId: input.lease.documentId,
          assetId: input.lease.assetId,
          reservedAttemptNumber: input.lease.attemptNumber,
          reason: "extraction_service_busy",
        },
      },
    });
    return "deferred" as const;
  });
}

function assertExtractionChunk(
  chunk: ExtractedDocumentTextChunk,
  index: number,
  pageCount: number,
  previous: { page: number; paragraph: number },
): number {
  if (
    typeof chunk !== "object"
    || chunk === null
    || chunk.sequence !== index
    || !Number.isSafeInteger(chunk.pageNumber)
    || chunk.pageNumber < 1
    || chunk.pageNumber > pageCount
    || chunk.pageNumber < previous.page
    || typeof chunk.paragraphId !== "string"
  ) throw new TypeError("The extracted text chunk identity is invalid.");
  const match = PARAGRAPH_ID_PATTERN.exec(chunk.paragraphId);
  const paragraphPage = Number(match?.[1]);
  const paragraphOrdinal = Number(match?.[2]);
  if (
    !match
    || paragraphPage !== chunk.pageNumber
    || !Number.isSafeInteger(paragraphOrdinal)
    || (chunk.pageNumber !== previous.page && paragraphOrdinal !== 1)
    || (chunk.pageNumber === previous.page
      && paragraphOrdinal !== previous.paragraph
      && paragraphOrdinal !== previous.paragraph + 1)
  ) throw new TypeError("The extracted paragraph identity is invalid.");
  if (
    typeof chunk.text !== "string"
    || chunk.text.length === 0
    || chunk.text !== chunk.text.normalize("NFC")
    || chunk.text !== chunk.text.trim()
    || PROHIBITED_TEXT_PATTERN.test(chunk.text)
    || /\p{Zs}/u.test(chunk.text.replaceAll(" ", ""))
    || chunk.text.includes("  ")
    || byteLength(chunk.text) > MAX_EXTRACTED_CHUNK_BYTES
  ) throw new TypeError("The extracted text chunk is invalid.");
  previous.page = chunk.pageNumber;
  previous.paragraph = paragraphOrdinal;
  return byteLength(chunk.text);
}

function assertExtractionAttestation(
  attestation: DocumentTextExtractionAttestation,
): void {
  if (
    typeof attestation !== "object"
    || attestation === null
    || !SHA256_PATTERN.test(attestation.inputSha256)
    || attestation.inputSizeBytes < 1n
    || attestation.inputSizeBytes > MAX_INPUT_BYTES
    || !SAFE_VALUE_PATTERN.test(attestation.storageVersion)
    || !POLICY_VALUE_PATTERN.test(attestation.policyVersion)
    || !SHA256_PATTERN.test(attestation.toolchainDigest)
    || (attestation.verdict !== "EXTRACTED" && attestation.verdict !== "NO_TEXT")
    || attestation.engine !== "poppler"
    || !SAFE_VALUE_PATTERN.test(attestation.engineVersion)
    || !Number.isSafeInteger(attestation.pageCount)
    || attestation.pageCount < 1
    || attestation.pageCount > MAX_EXTRACTED_PAGE_COUNT
    || !Number.isSafeInteger(attestation.chunkCount)
    || attestation.chunkCount < 0
    || attestation.chunkCount > MAX_EXTRACTED_CHUNK_COUNT
    || !Number.isSafeInteger(attestation.textBytes)
    || attestation.textBytes < 0
    || attestation.textBytes > MAX_EXTRACTED_TEXT_BYTES
    || !(attestation.extractedAt instanceof Date)
    || !Number.isFinite(attestation.extractedAt.getTime())
    || !(attestation.completedAt instanceof Date)
    || !Number.isFinite(attestation.completedAt.getTime())
    || attestation.extractedAt > attestation.completedAt
    || !Number.isSafeInteger(attestation.durationMs)
    || attestation.durationMs < 0
    || attestation.durationMs > MAX_DURATION_MS
    || !Number.isSafeInteger(attestation.totalDurationMs)
    || attestation.totalDurationMs < attestation.durationMs
    || attestation.totalDurationMs > MAX_DURATION_MS
    || !Array.isArray(attestation.chunks)
    || attestation.chunks.length !== attestation.chunkCount
  ) throw new TypeError("The text extraction attestation is invalid.");
  const previous = { page: 0, paragraph: 0 };
  let measuredBytes = 0;
  for (let index = 0; index < attestation.chunks.length; index += 1) {
    const chunk = attestation.chunks[index];
    if (!chunk) throw new TypeError("The text extraction attestation is incomplete.");
    measuredBytes += assertExtractionChunk(chunk, index, attestation.pageCount, previous);
    if (measuredBytes > MAX_EXTRACTED_TEXT_BYTES) {
      throw new TypeError("The extracted text byte total is too large.");
    }
  }
  if (
    measuredBytes !== attestation.textBytes
    || (attestation.verdict === "EXTRACTED"
      && (attestation.chunkCount < 1 || attestation.textBytes < 1))
    || (attestation.verdict === "NO_TEXT"
      && (attestation.chunkCount !== 0 || attestation.textBytes !== 0))
  ) throw new TypeError("The text extraction attestation is internally inconsistent.");
}

function extractionResult(attestation: DocumentTextExtractionAttestation) {
  return {
    schemaVersion: 1,
    engine: "poppler",
    engineVersion: attestation.engineVersion,
    extractedAt: attestation.extractedAt.toISOString(),
    completedAt: attestation.completedAt.toISOString(),
    durationMs: attestation.durationMs,
    totalDurationMs: attestation.totalDurationMs,
  } as const;
}

function resultMatches(
  value: Prisma.JsonValue | null,
  attestation: DocumentTextExtractionAttestation,
): boolean {
  const expected = extractionResult(attestation);
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(expected).length
    && value.schemaVersion === expected.schemaVersion
    && value.engine === expected.engine
    && value.engineVersion === expected.engineVersion
    && value.extractedAt === expected.extractedAt
    && value.completedAt === expected.completedAt
    && value.durationMs === expected.durationMs
    && value.totalDurationMs === expected.totalDurationMs;
}

function locatorMatches(
  value: Prisma.JsonValue | null,
  chunk: ExtractedDocumentTextChunk,
): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 4
    && value.schemaVersion === 1
    && value.kind === "pdf-text"
    && value.pageNumber === chunk.pageNumber
    && value.paragraphId === chunk.paragraphId;
}

function extractionMatches(
  stored: {
    inputSha256: string;
    inputSizeBytes: bigint;
    storageVersion: string;
    extractionPolicyVersion: string;
    toolchainDigest: string;
    verdict: "EXTRACTED" | "NO_TEXT";
    engine: string;
    engineVersion: string;
    pageCount: number;
    chunkCount: number;
    textBytes: number;
    extractedAt: Date;
    completedAt: Date;
    durationMs: number;
    totalDurationMs: number;
    result: Prisma.JsonValue | null;
    chunks: Array<{
      sequence: number;
      pageStart: number | null;
      pageEnd: number | null;
      sectionId: string | null;
      sectionTitle: string | null;
      paragraphId: string | null;
      charStart: number | null;
      charEnd: number | null;
      text: string;
      contentHash: string;
      locator: Prisma.JsonValue | null;
    }>;
  },
  attestation: DocumentTextExtractionAttestation,
): boolean {
  if (
    stored.inputSha256 !== attestation.inputSha256
    || stored.inputSizeBytes !== attestation.inputSizeBytes
    || stored.storageVersion !== attestation.storageVersion
    || stored.extractionPolicyVersion !== attestation.policyVersion
    || stored.toolchainDigest !== attestation.toolchainDigest
    || stored.verdict !== attestation.verdict
    || stored.engine !== attestation.engine
    || stored.engineVersion !== attestation.engineVersion
    || stored.pageCount !== attestation.pageCount
    || stored.chunkCount !== attestation.chunkCount
    || stored.textBytes !== attestation.textBytes
    || stored.extractedAt.getTime() !== attestation.extractedAt.getTime()
    || stored.completedAt.getTime() !== attestation.completedAt.getTime()
    || stored.durationMs !== attestation.durationMs
    || stored.totalDurationMs !== attestation.totalDurationMs
    || !resultMatches(stored.result, attestation)
    || stored.chunks.length !== attestation.chunks.length
  ) return false;
  return stored.chunks.every((storedChunk, index) => {
    const requested = attestation.chunks[index];
    if (!requested) return false;
    return storedChunk.sequence === requested.sequence
      && storedChunk.pageStart === requested.pageNumber
      && storedChunk.pageEnd === requested.pageNumber
      && storedChunk.sectionId === null
      && storedChunk.sectionTitle === null
      && storedChunk.paragraphId === requested.paragraphId
      && storedChunk.charStart === null
      && storedChunk.charEnd === null
      && storedChunk.text === requested.text
      && storedChunk.contentHash === createHash("sha256").update(requested.text, "utf8").digest("hex")
      && locatorMatches(storedChunk.locator, requested);
  });
}

export async function completeDocumentTextExtractionLease(input: {
  lease: DocumentTextExtractionLease;
  attestation: DocumentTextExtractionAttestation;
  now?: Date;
}): Promise<CompleteDocumentTextExtractionResult | null> {
  assertExtractionAttestation(input.attestation);
  const clockOverride = requireClockOverride(input.now);
  return prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "Job"
      WHERE "id" = ${input.lease.jobId}
        AND "organizationId" = ${input.lease.organizationId}
      FOR UPDATE
    `;
    if (!locked[0]) return null;
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const job = await transaction.job.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
    });
    const existing = await transaction.documentTextExtraction.findUnique({
      where: { jobAttemptId: input.lease.jobAttemptId },
      include: {
        chunks: { orderBy: { sequence: "asc" } },
        manifestAdmission: true,
      },
    });
    if (job.status === "SUCCEEDED" && existing) {
      const replayPayload = parseExtractionPayload(job.payload);
      const replayTarget = replayPayload
        ? await authoritativeExtractionTarget(transaction, job, replayPayload)
        : null;
      return job.intakeId === input.lease.intakeId
        && job.ingestReceiptId === input.lease.ingestReceiptId
        && replayTarget?.intake.id === input.lease.intakeId
        && replayTarget.receipt.id === input.lease.ingestReceiptId
        && existing.organizationId === input.lease.organizationId
        && existing.jobId === input.lease.jobId
        && existing.jobAttemptId === input.lease.jobAttemptId
        && existing.assetId === input.lease.assetId
        && existing.documentId === input.lease.documentId
        && existing.validationAttestationId === input.lease.validationAttestationId
        && existing.manifestAdmission !== null
        && existing.manifestAdmission.organizationId === existing.organizationId
        && existing.manifestAdmission.documentId === existing.documentId
        && existing.manifestAdmission.extractionId === existing.id
        && existing.manifestAdmission.schemaVersion === 1
        && existing.manifestAdmission.verdict === existing.verdict
        && existing.manifestAdmission.pageCount === existing.pageCount
        && existing.manifestAdmission.chunkCount === existing.chunkCount
        && existing.manifestAdmission.textBytes === existing.textBytes
        && SHA256_PATTERN.test(existing.manifestAdmission.manifestSha256)
        && !/^0{64}$/.test(existing.manifestAdmission.manifestSha256)
        && extractionMatches(existing, input.attestation)
        ? {
          outcome: "replayed" as const,
          extractionId: existing.id,
          verdict: existing.verdict,
          chunkCount: existing.chunkCount,
        }
        : null;
    }
    if (
      job.type !== "TEXT_EXTRACTION"
      || job.status !== "RUNNING"
      || job.leaseId !== input.lease.leaseId
      || job.lockedBy !== input.lease.workerId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= now
      || job.documentId !== input.lease.documentId
      || job.assetId !== input.lease.assetId
      || job.intakeId !== input.lease.intakeId
      || job.ingestReceiptId !== input.lease.ingestReceiptId
      || job.attempts !== input.lease.attemptNumber
      || existing !== null
    ) return null;
    const payload = parseExtractionPayload(job.payload);
    if (
      !payload
      || payload.validationAttestationId !== input.lease.validationAttestationId
      || payload.policyVersion !== input.lease.policyVersion
      || payload.storageVersion !== input.lease.storageVersion
      || payload.toolchainDigest !== input.lease.toolchainDigest
      || input.attestation.inputSha256 !== input.lease.inputSha256
      || input.attestation.inputSizeBytes !== input.lease.inputSizeBytes
      || input.attestation.storageVersion !== input.lease.storageVersion
      || input.attestation.policyVersion !== input.lease.policyVersion
      || input.attestation.toolchainDigest !== input.lease.toolchainDigest
      || input.attestation.pageCount !== input.lease.expectedPageCount
    ) return null;
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
    ) return null;
    const target = await authoritativeExtractionTarget(transaction, job, payload);
    if (
      !target
      || target.asset.objectKey !== input.lease.storageKey
      || target.validation.id !== input.lease.validationAttestationId
      || target.validation.inputSha256 !== input.lease.inputSha256
      || target.validation.inputSizeBytes !== input.lease.inputSizeBytes
      || target.pageCount !== input.lease.expectedPageCount
      || target.intake.id !== input.lease.intakeId
      || target.receipt.id !== input.lease.ingestReceiptId
    ) return null;

    if (!await projectDocumentPipelineLifecycle(
      transaction,
      {
        organizationId: input.lease.organizationId,
        documentId: input.lease.documentId,
        assetId: input.lease.assetId,
        intakeId: input.lease.intakeId,
        ingestReceiptId: input.lease.ingestReceiptId,
      },
      { stage: "extraction-ready" },
      now,
    )) return null;

    const extraction = await transaction.documentTextExtraction.create({
      data: {
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        jobAttemptId: input.lease.jobAttemptId,
        validationAttestationId: input.lease.validationAttestationId,
        assetId: input.lease.assetId,
        documentId: input.lease.documentId,
        inputSha256: input.attestation.inputSha256,
        inputSizeBytes: input.attestation.inputSizeBytes,
        storageVersion: input.attestation.storageVersion,
        extractionPolicyVersion: input.attestation.policyVersion,
        toolchainDigest: input.attestation.toolchainDigest,
        verdict: input.attestation.verdict,
        engine: input.attestation.engine,
        engineVersion: input.attestation.engineVersion,
        pageCount: input.attestation.pageCount,
        chunkCount: input.attestation.chunkCount,
        textBytes: input.attestation.textBytes,
        extractedAt: input.attestation.extractedAt,
        completedAt: input.attestation.completedAt,
        durationMs: input.attestation.durationMs,
        totalDurationMs: input.attestation.totalDurationMs,
        checkedAt: now,
        result: extractionResult(input.attestation),
      },
    });
    if (input.attestation.chunks.length > 0) {
      await transaction.documentTextChunk.createMany({
        data: input.attestation.chunks.map((chunk) => ({
          organizationId: input.lease.organizationId,
          documentId: input.lease.documentId,
          extractionId: extraction.id,
          sequence: chunk.sequence,
          pageStart: chunk.pageNumber,
          pageEnd: chunk.pageNumber,
          sectionId: null,
          sectionTitle: null,
          paragraphId: chunk.paragraphId,
          charStart: null,
          charEnd: null,
          text: chunk.text,
          contentHash: createHash("sha256").update(chunk.text, "utf8").digest("hex"),
          locator: {
            schemaVersion: 1,
            kind: "pdf-text",
            pageNumber: chunk.pageNumber,
            paragraphId: chunk.paragraphId,
          },
        })),
      });
    }
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
          extractionId: extraction.id,
          verdict: input.attestation.verdict,
          chunkCount: input.attestation.chunkCount,
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
          extractionId: extraction.id,
          verdict: input.attestation.verdict,
          chunkCount: input.attestation.chunkCount,
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
        documentId: input.lease.documentId,
        sourceProvider: "PaperPilot isolated document text extraction",
        sourceRecordId: input.lease.jobAttemptId,
        retrievedAt: now,
        payloadDigest: input.attestation.toolchainDigest,
        payload: {
          stage: "document-text-extraction",
          extractionId: extraction.id,
          validationAttestationId: input.lease.validationAttestationId,
          verdict: input.attestation.verdict,
          policyVersion: input.attestation.policyVersion,
          toolchainDigest: input.lease.toolchainDigest,
          storageVersion: input.attestation.storageVersion,
          chunkCount: input.attestation.chunkCount,
          textBytes: input.attestation.textBytes,
        },
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        action: "document.text_extraction.completed",
        entityType: "document",
        entityId: input.lease.documentId,
        metadata: {
          jobId: input.lease.jobId,
          extractionId: extraction.id,
          assetId: input.lease.assetId,
          validationAttestationId: input.lease.validationAttestationId,
          verdict: input.attestation.verdict,
          policyVersion: input.attestation.policyVersion,
          chunkCount: input.attestation.chunkCount,
        },
      },
    });
    return {
      outcome: "applied" as const,
      extractionId: extraction.id,
      verdict: input.attestation.verdict,
      chunkCount: input.attestation.chunkCount,
    };
  });
}

export async function failDocumentTextExtractionLease(input: {
  lease: DocumentTextExtractionLease;
  code: DocumentTextExtractionExecutionFailureCode;
  retryable: boolean;
  now?: Date;
}): Promise<"retrying" | "dead-letter" | "lease-lost"> {
  const clockOverride = requireClockOverride(input.now);
  const message = SAFE_EXECUTION_FAILURES[input.code];
  if (typeof message !== "string" || byteLength(message) > MAX_SAFE_ERROR_MESSAGE_BYTES) {
    throw new TypeError("The safe text extraction error message is too large.");
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
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const job = await transaction.job.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobId,
        },
      },
    });
    if (
      job.type !== "TEXT_EXTRACTION"
      || job.status !== "RUNNING"
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
    const payload = parseExtractionPayload(job.payload);
    if (
      !payload
      || payload.validationAttestationId !== input.lease.validationAttestationId
      || payload.policyVersion !== input.lease.policyVersion
      || payload.storageVersion !== input.lease.storageVersion
      || payload.toolchainDigest !== input.lease.toolchainDigest
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
        ? { stage: "extraction-retry" }
        : { stage: "extraction-attention", failureCode: input.code },
      now,
    )) return "lease-lost" as const;
    const closed = await transaction.jobAttempt.updateMany({
      where: {
        id: input.lease.jobAttemptId,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        leaseId: input.lease.leaseId,
        workerId: input.lease.workerId,
        status: "RUNNING",
      },
      data: {
        status: canRetry ? "FAILED" : "DEAD_LETTER",
        completedAt: now,
        errorCode: input.code,
        errorMessage: message,
      },
    });
    if (closed.count !== 1) {
      throw new Error("The extraction attempt changed concurrently.");
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
    if (!canRetry) {
      await transaction.auditEvent.create({
        data: {
          organizationId: input.lease.organizationId,
          action: "document.text_extraction.dead_lettered",
          entityType: "job",
          entityId: input.lease.jobId,
          metadata: { failureCode: input.code },
        },
      });
    }
    return canRetry ? "retrying" as const : "dead-letter" as const;
  });
}
