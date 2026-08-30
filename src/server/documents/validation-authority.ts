import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { MAX_EXTRACTED_PAGE_COUNT } from "./extraction-contract";
import {
  DOCUMENT_VALIDATION_POLICY_VERSION,
  LOCAL_QUARANTINE_STORAGE_VERSION,
} from "./validation-constants";

const MAX_OPAQUE_ID_BYTES = 200;
const MAX_INPUT_BYTES = 25n * 1_024n * 1_024n;
const MAX_DURATION_MS = 180_000;
const MAX_VALIDATION_OBJECT_COUNT = 10_000_000;
const MAX_VALIDATION_REVISION_COUNT = 10_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ValidationAuthorityDocument {
  id: string;
  workspacePaperId: string | null;
  paperId: string | null;
  kind: string;
  status: string;
  mimeType: string | null;
  pageCount: number | null;
  contentHash: string | null;
  validatedAt: Date | null;
  validationPolicyVersion: string | null;
  failureCode: string | null;
  archivedAt: Date | null;
}

export interface ValidationAuthorityAsset {
  id: string;
  storageProvider: string;
  objectKey: string;
  physicalLocator: string | null;
  status: string;
  mimeType: string | null;
  sizeBytes: bigint | null;
  sha256: string | null;
  scannedAt: Date | null;
  validatedAt: Date | null;
  validationPolicyVersion: string | null;
  rejectedReason: string | null;
  rejectionCode: string | null;
  deletedAt: Date | null;
}

export interface ValidationAuthorityAttestation {
  id: string;
  jobId: string;
  jobAttemptId: string;
  documentId: string;
  assetId: string;
  inputSha256: string;
  inputSizeBytes: bigint;
  storageVersion: string;
  policyVersion: string;
  toolchainDigest: string;
  verdict: string;
  rejectionCode: string | null;
  malwareVerdict: string;
  signaturePublishedAt: Date;
  scannedAt: Date;
  pdfStructuralVerdict: string;
  pageCount: number | null;
  objectCount: number | null;
  revisionCount: number | null;
  checkedAt: Date;
  result: Prisma.JsonValue | null;
  job: {
    id: string;
    type: string;
    status: string;
    documentId: string | null;
    assetId: string | null;
    attempts: number;
  };
  jobAttempt: {
    id: string;
    jobId: string;
    status: string;
    attemptNumber: number;
  };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validOpaqueId(value: string): boolean {
  return utf8Bytes(value) <= MAX_OPAQUE_ID_BYTES && OPAQUE_ID_PATTERN.test(value);
}

function validDigest(value: string): boolean {
  return SHA256_PATTERN.test(value) && !/^0{64}$/.test(value);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameDate(left: Date | null, right: Date): boolean {
  return left !== null && validDate(left) && left.getTime() === right.getTime();
}

function record(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validationResultIsSound(value: Prisma.JsonValue | null, checkedAt: Date): boolean {
  const result = record(value);
  if (!result || !exactKeys(result, [
    "schemaVersion",
    "detectionCount",
    "warningCount",
    "malwareDurationMs",
    "pdfDurationMs",
    "totalDurationMs",
    "completedAt",
  ])) return false;
  if (
    result.schemaVersion !== 1
    || result.detectionCount !== 0
    || result.warningCount !== 0
    || !boundedInteger(result.malwareDurationMs, 0, MAX_DURATION_MS)
    || !boundedInteger(result.pdfDurationMs, 0, MAX_DURATION_MS)
    || !boundedInteger(result.totalDurationMs, 0, MAX_DURATION_MS)
    || result.totalDurationMs < Math.max(result.malwareDurationMs, result.pdfDurationMs)
    || !canonicalTimestamp(result.completedAt)
  ) return false;
  return new Date(result.completedAt).getTime() >= checkedAt.getTime();
}

/**
 * One fail-closed definition of a current accepted PDF validation. Linking,
 * extraction admission, Reader serving, and status projections must all use
 * this predicate so a document cannot cross one boundary and fail another.
 */
export function currentAcceptedValidation(
  validation: ValidationAuthorityAttestation,
  document: ValidationAuthorityDocument,
  asset: ValidationAuthorityAsset,
  options: { requireLinkedPaper?: boolean } = {},
): validation is ValidationAuthorityAttestation & { pageCount: number } {
  const linkedPaperIsSound = options.requireLinkedPaper !== true
    || (
      document.workspacePaperId !== null
      && validOpaqueId(document.workspacePaperId)
      && document.paperId !== null
      && validOpaqueId(document.paperId)
    );
  return linkedPaperIsSound
    && validation.verdict === "ACCEPTED"
    && validation.rejectionCode === null
    && validation.malwareVerdict === "CLEAN"
    && validation.pdfStructuralVerdict === "VALID"
    && validOpaqueId(validation.id)
    && validOpaqueId(validation.jobId)
    && validOpaqueId(validation.jobAttemptId)
    && validOpaqueId(document.id)
    && validOpaqueId(asset.id)
    && validation.documentId === document.id
    && validation.assetId === asset.id
    && validation.job.id === validation.jobId
    && validation.job.type === "DOCUMENT_VALIDATE"
    && validation.job.status === "SUCCEEDED"
    && validation.job.documentId === document.id
    && validation.job.assetId === asset.id
    && boundedInteger(validation.job.attempts, 1, 1_000_000)
    && validation.jobAttempt.id === validation.jobAttemptId
    && validation.jobAttempt.jobId === validation.jobId
    && validation.jobAttempt.status === "SUCCEEDED"
    && boundedInteger(validation.jobAttempt.attemptNumber, 1, 1_000_000)
    && validDigest(validation.inputSha256)
    && validDigest(validation.toolchainDigest)
    && validation.inputSizeBytes >= 1n
    && validation.inputSizeBytes <= MAX_INPUT_BYTES
    && validation.storageVersion === LOCAL_QUARANTINE_STORAGE_VERSION
    && validation.policyVersion === DOCUMENT_VALIDATION_POLICY_VERSION
    && boundedInteger(validation.pageCount, 1, MAX_EXTRACTED_PAGE_COUNT)
    && boundedInteger(validation.objectCount, 0, MAX_VALIDATION_OBJECT_COUNT)
    && boundedInteger(validation.revisionCount, 1, MAX_VALIDATION_REVISION_COUNT)
    && validDate(validation.signaturePublishedAt)
    && validDate(validation.scannedAt)
    && validDate(validation.checkedAt)
    && validation.signaturePublishedAt <= validation.scannedAt
    && validation.scannedAt <= validation.checkedAt
    && validationResultIsSound(validation.result, validation.checkedAt)
    && document.kind === "PAPER_PDF"
    && document.status === "READY"
    && document.mimeType === "application/pdf"
    && document.failureCode === null
    && document.archivedAt === null
    && document.contentHash === validation.inputSha256
    && document.pageCount === validation.pageCount
    && document.validationPolicyVersion === validation.policyVersion
    && sameDate(document.validatedAt, validation.checkedAt)
    && asset.storageProvider === "LOCAL"
    && asset.objectKey.startsWith(`${validation.storageVersion}:`)
    && asset.physicalLocator === asset.objectKey
    && asset.status === "READY"
    && asset.mimeType === "application/pdf"
    && asset.rejectionCode === null
    && asset.rejectedReason === null
    && asset.deletedAt === null
    && asset.sha256 === validation.inputSha256
    && asset.sizeBytes === validation.inputSizeBytes
    && asset.validationPolicyVersion === validation.policyVersion
    && sameDate(asset.scannedAt, validation.scannedAt)
    && sameDate(asset.validatedAt, validation.checkedAt);
}
