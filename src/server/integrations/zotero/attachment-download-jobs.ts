import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueDocumentValidationJob } from "@/server/documents/validation-jobs";
import { LOCAL_QUARANTINE_STORAGE_VERSION } from "@/server/documents/validation-constants";
import { HttpProblem } from "@/server/http/problem";
import {
  credentialProtectorFromEnvironment,
  type CredentialProtector,
} from "@/server/integrations/credential-protection";
import {
  localQuarantineStorageKeyForAttempt,
  removeLocalQuarantineAttemptObjects,
  type LocalQuarantineUploadResult,
} from "@/server/uploads/storage";
import type { UploadConfiguration } from "@/server/uploads/config";
import {
  ZoteroAttachmentBinaryAdapter,
  type ZoteroAttachmentBlobAllowlistEntry,
} from "./attachment-binary-adapter";
import {
  parseZoteroAttachmentDownloadJobPayload,
  zoteroAttachmentDownloadJobDedupeKey,
} from "./attachment-import-contract";
import { createZoteroCredentialResolver } from "./client-factory";
import type { ZoteroCredentialResolver } from "./contracts";

export const ZOTERO_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS = 5;
export const DEFAULT_ZOTERO_ATTACHMENT_DOWNLOAD_LEASE_TTL_MS = 10 * 60_000;
/** Provider retry hints may delay one connection for at most six hours. */
export const MAX_ZOTERO_ATTACHMENT_PROVIDER_BACKOFF_MS = 6 * 60 * 60_000;

const MIN_LEASE_TTL_MS = 10_000;
const MAX_LEASE_TTL_MS = 15 * 60_000;
const MAX_WORKER_ID_BYTES = 200;
const MAX_CLAIM_REAP_LOOPS = 8;
const MAX_ALLOWLIST_ENTRIES = 32;
const CLEANUP_LEASE_MS = 60_000;
// Crossing this threshold surfaces the logical import as dead-lettered, but
// physical cleanup remains unbounded and independently scheduled. Quota stays
// charged until exact deletion is eventually proven.
export const ZOTERO_ATTACHMENT_CLEANUP_ATTENTION_THRESHOLD = 20;
const MD5_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PUBLIC_DNS_NAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const S3_BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/;
const PRIVATE_DNS_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "corp",
  "private",
] as const;

const SAFE_FAILURE_MESSAGES = {
  download_authority_stale: "The attachment download authority changed.",
  download_attempt_budget_exhausted: "The attachment download attempt budget was exhausted.",
  download_lease_expired: "The attachment download worker lease expired.",
  download_aborted: "The attachment download was interrupted.",
  download_storage_unavailable: "Private quarantine storage was unavailable.",
  download_storage_conflict: "The attachment quarantine target was inconsistent.",
  download_integrity_mismatch: "The attachment bytes failed an integrity check.",
  download_worker_internal: "The attachment download worker could not finish safely.",
  zotero_invalid_request: "Zotero rejected the attachment request.",
  zotero_credential_unavailable: "The Zotero credential was unavailable.",
  zotero_authentication_failed: "The Zotero connection is no longer authorized.",
  zotero_forbidden: "The Zotero connection cannot read this attachment.",
  zotero_not_found: "The Zotero attachment is no longer available.",
  zotero_rate_limited: "Zotero rate-limited the attachment request.",
  zotero_timeout: "The Zotero attachment request timed out.",
  zotero_unavailable: "Zotero attachment storage was unavailable.",
  zotero_response_too_large: "The Zotero attachment exceeds the import limit.",
  zotero_bad_response: "Zotero returned an invalid attachment response.",
} as const;

export type ZoteroAttachmentDownloadFailureCode = keyof typeof SAFE_FAILURE_MESSAGES;

export interface ZoteroAttachmentDownloadLease {
  organizationId: string;
  connectionId: string;
  zoteroLibraryId: string;
  libraryType: "USER" | "GROUP";
  externalLibraryId: string;
  zoteroObjectId: string;
  zoteroItemKey: string;
  attachmentImportId: string;
  jobId: string;
  jobAttemptId: string;
  ingressAttemptId: string;
  attemptNumber: number;
  workerId: string;
  leaseId: string;
  leaseExpiresAt: Date;
  intakeId: string;
  documentId: string;
  assetId: string;
  inboxEntryId: string | null;
  importBatchId: string | null;
  requestedById: string | null;
  policyRevision: number;
  credentialGeneration: number;
  credentialFingerprint: string;
  credentialKeyVersion: string;
  credentialExpiresAt: Date | null;
  sourceVersion: string;
  sourceMetadataHash: string;
  providerMd5: string;
  originalFileName: string;
  maximumBytes: number;
  storageVersion: typeof LOCAL_QUARANTINE_STORAGE_VERSION;
  storageKey: string;
}

export interface WrittenZoteroAttachmentDownload {
  storageKey: string;
  sizeBytes: bigint;
  sha256: string;
  md5: string;
  mimeType: "application/pdf";
  storedAt: Date;
}

export interface ZoteroAttachmentDownloadFailure {
  code: ZoteroAttachmentDownloadFailureCode;
  retryable: boolean;
  retryAt?: Date;
  connectionWideBackoff?: boolean;
}

export type FailZoteroAttachmentDownloadResult =
  | { outcome: "lease-lost" }
  | {
      outcome: "cleanup-required";
      ingressAttemptId: string;
      terminal: boolean;
    };

export type ZoteroAttachmentDownloadCleanupResult =
  | { outcome: "idle" }
  | { outcome: "cleaned"; jobId: string; ingressAttemptId: string }
  | { outcome: "retrying"; jobId: string; ingressAttemptId: string }
  | { outcome: "failed" | "dead-letter"; jobId: string; ingressAttemptId: string };

interface CandidateRow {
  id: string;
}

interface CleanupCandidateRow {
  id: string;
}

interface DatabaseClockRow {
  now: Date;
}

type DownloadTransaction = Prisma.TransactionClient;

function requireClockOverride(value: Date | undefined): Date | null {
  if (value === undefined) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("A valid attachment lifecycle clock override is required.");
  }
  return value;
}

async function authoritativeLeaseNow(
  transaction: DownloadTransaction,
  override: Date | null,
): Promise<Date> {
  const rows = await transaction.$queryRaw<DatabaseClockRow[]>`
    SELECT COALESCE(CAST(${override} AS timestamptz), clock_timestamp()) AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("The database attachment lease clock is unavailable.");
  }
  return now;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function requireWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  if (
    !normalized
    || byteLength(normalized) > MAX_WORKER_ID_BYTES
    || /[\r\n]/.test(normalized)
  ) {
    throw new TypeError("A bounded attachment worker identifier is required.");
  }
  return normalized;
}

function requireLeaseTtl(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < MIN_LEASE_TTL_MS
    || value > MAX_LEASE_TTL_MS
  ) {
    throw new TypeError("The attachment download lease TTL is outside the supported range.");
  }
  return value;
}

function sameOptionalDate(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

function safeMaximumBytes(reservedBytes: bigint, configuredMaximum: number): number | null {
  if (
    reservedBytes < 1n
    || reservedBytes > BigInt(configuredMaximum)
    || reservedBytes > BigInt(Number.MAX_SAFE_INTEGER)
  ) return null;
  return Number(reservedBytes);
}

function retryDelayMs(attemptNumber: number): number {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attemptNumber - 1)));
}

export function clampZoteroAttachmentProviderRetryAt(
  requestedRetryAt: Date | undefined,
  now: Date,
): { retryAt: Date | undefined; clamped: boolean } {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("A valid attachment provider backoff clock is required.");
  }
  if (requestedRetryAt === undefined) {
    return { retryAt: undefined, clamped: false };
  }
  if (
    !(requestedRetryAt instanceof Date)
    || !Number.isFinite(requestedRetryAt.getTime())
  ) {
    return { retryAt: undefined, clamped: true };
  }
  const maximumRetryAt = new Date(
    now.getTime() + MAX_ZOTERO_ATTACHMENT_PROVIDER_BACKOFF_MS,
  );
  if (requestedRetryAt > maximumRetryAt) {
    return { retryAt: maximumRetryAt, clamped: true };
  }
  return { retryAt: requestedRetryAt, clamped: false };
}

function cleanupDelayMs(attemptCount: number): number {
  return Math.min(15 * 60_000, 2_000 * (2 ** Math.max(0, attemptCount - 1)));
}

function publicFailureCode(code: ZoteroAttachmentDownloadFailureCode): string {
  if (code === "zotero_response_too_large") return "attachment_too_large";
  if (
    code === "download_integrity_mismatch"
    || code === "zotero_bad_response"
  ) return "attachment_integrity_failed";
  if (
    code === "zotero_authentication_failed"
    || code === "zotero_credential_unavailable"
    || code === "zotero_forbidden"
    || code === "zotero_not_found"
    || code === "download_authority_stale"
  ) return "zotero_attachment_unavailable";
  return "attachment_download_failed";
}

function validHttpsOrigin(value: string): boolean {
  if (
    value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.includes("\\")
    || !/^https:\/\/[^/?#]+\/?$/.test(value)
  ) return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.port === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && PUBLIC_DNS_NAME_PATTERN.test(hostname)
      && !PRIVATE_DNS_SUFFIXES.some(
        (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
      );
  } catch {
    return false;
  }
}

function validS3Bucket(value: string): boolean {
  return value.length >= 3
    && value.length <= 63
    && S3_BUCKET_PATTERN.test(value)
    && !value.includes("..")
    && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

export function zoteroLibraryFileAccessPermitsDownload(
  status: "AVAILABLE" | "UNKNOWN" | "UNAVAILABLE",
): boolean {
  // UNKNOWN means Zotero did not expose a definitive file bit. The explicit
  // user command may probe the exact authenticated /file endpoint; only a
  // known denial is rejected before that request.
  return status !== "UNAVAILABLE";
}

export function zoteroAttachmentCredentialFenceWhere(
  lease: ZoteroAttachmentDownloadLease,
): Prisma.IntegrationConnectionWhereInput {
  return {
    id: lease.connectionId,
    organizationId: lease.organizationId,
    provider: "ZOTERO",
    status: "CONNECTED",
    credentialGeneration: lease.credentialGeneration,
    credentialFingerprint: lease.credentialFingerprint,
    credentialKeyVersion: lease.credentialKeyVersion,
    credentialExpiresAt: lease.credentialExpiresAt,
  };
}

/**
 * Parse trusted deployment configuration. Every redirect origin is explicit;
 * provider URLs, job payloads, and database metadata can never expand it.
 */
export function zoteroAttachmentBlobAllowlistFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly ZoteroAttachmentBlobAllowlistEntry[] {
  const raw = environment.PAPERPILOT_ZOTERO_ATTACHMENT_BLOB_ALLOWLIST;
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("PAPERPILOT_ZOTERO_ATTACHMENT_BLOB_ALLOWLIST is required.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("PAPERPILOT_ZOTERO_ATTACHMENT_BLOB_ALLOWLIST must be valid JSON.");
  }
  if (
    !Array.isArray(decoded)
    || decoded.length < 1
    || decoded.length > MAX_ALLOWLIST_ENTRIES
  ) {
    throw new Error("PAPERPILOT_ZOTERO_ATTACHMENT_BLOB_ALLOWLIST must be a bounded non-empty array.");
  }
  const entries: ZoteroAttachmentBlobAllowlistEntry[] = [];
  const identities = new Set<string>();
  for (const candidate of decoded) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("A Zotero attachment blob allowlist entry is invalid.");
    }
    const record = candidate as Record<string, unknown>;
    const keys = Object.keys(record);
    if (record.kind === "exact-origin") {
      if (
        keys.length !== 2
        || keys.some((key) => key !== "kind" && key !== "origin")
        || typeof record.origin !== "string"
        || !validHttpsOrigin(record.origin)
      ) throw new Error("A Zotero exact blob origin is invalid.");
      const entry = { kind: "exact-origin" as const, origin: record.origin };
      const identity = `${entry.kind}:${new URL(entry.origin).origin}`;
      if (identities.has(identity)) throw new Error("Zotero blob allowlist entries cannot be duplicated.");
      identities.add(identity);
      entries.push(entry);
      continue;
    }
    if (record.kind === "s3-path-style") {
      if (
        keys.length !== 3
        || keys.some((key) => key !== "kind" && key !== "origin" && key !== "bucket")
        || typeof record.origin !== "string"
        || typeof record.bucket !== "string"
        || !validHttpsOrigin(record.origin)
        || !validS3Bucket(record.bucket)
      ) throw new Error("A Zotero S3 blob allowlist entry is invalid.");
      const entry = {
        kind: "s3-path-style" as const,
        origin: record.origin,
        bucket: record.bucket,
      };
      const identity = `${entry.kind}:${new URL(entry.origin).origin}:${entry.bucket}`;
      if (identities.has(identity)) throw new Error("Zotero blob allowlist entries cannot be duplicated.");
      identities.add(identity);
      entries.push(entry);
      continue;
    }
    throw new Error("A Zotero attachment blob allowlist entry is invalid.");
  }
  // Reuse the hardened adapter's public-host and S3-origin validation. No
  // credential can be resolved while the constructor validates configuration.
  new ZoteroAttachmentBinaryAdapter({
    credentialResolver: async () => null,
    blobAllowlist: entries,
  });
  return entries;
}

interface AuthoritySnapshot {
  attachmentImport: NonNullable<Awaited<ReturnType<typeof loadAuthority>>>["attachmentImport"];
  originalAssetExists: boolean;
}

async function loadAuthority(
  transaction: DownloadTransaction,
  organizationId: string,
  attachmentImportId: string,
) {
  const attachmentImport = await transaction.zoteroAttachmentImport.findFirst({
    where: { id: attachmentImportId, organizationId },
    include: {
      integration: { include: { attachmentPolicy: true } },
      library: true,
      attachment: { include: { object: true } },
      intake: { include: { asset: true, document: true } },
    },
  });
  if (!attachmentImport) return null;
  const originalAssetExists = await transaction.documentAsset.findFirst({
    where: {
      organizationId,
      documentId: attachmentImport.documentId,
      assetId: attachmentImport.assetId,
      role: "ORIGINAL",
    },
    select: { id: true },
  });
  return { attachmentImport, originalAssetExists: originalAssetExists !== null };
}

function currentAuthorityMatches(input: {
  job: {
    id: string;
    organizationId: string;
    type: string;
    status: string;
    dedupeKey: string | null;
    integrationConnectionId: string | null;
    zoteroLibraryId: string | null;
    documentId: string | null;
    assetId: string | null;
    intakeId: string | null;
    payload: Prisma.JsonValue | null;
  };
  authority: AuthoritySnapshot | null;
  expectedLease?: ZoteroAttachmentDownloadLease;
  now: Date;
  maximumConfiguredBytes: number;
  phase: "claim" | "download";
}): input is typeof input & { authority: AuthoritySnapshot } {
  const payload = parseZoteroAttachmentDownloadJobPayload(input.job.payload);
  const command = input.authority?.attachmentImport;
  if (!payload || !command || !input.authority?.originalAssetExists) return false;
  const connection = command.integration;
  const policy = connection.attachmentPolicy;
  const library = command.library;
  const attachment = command.attachment;
  const sourceObject = attachment.object;
  const intake = command.intake;
  const firstClaim = input.phase === "claim" && command.status === "QUEUED";
  const retryOrRunning = command.status === "DOWNLOADING";
  const lifecycleMatches = input.phase === "claim"
    ? (input.job.status === "QUEUED" && firstClaim)
      || (input.job.status === "RETRYING" && retryOrRunning)
    : input.job.status === "RUNNING" && retryOrRunning;
  const maximumBytes = safeMaximumBytes(intake.reservedBytes, input.maximumConfiguredBytes);
  const lease = input.expectedLease;
  return input.job.type === "DOCUMENT_DOWNLOAD"
    && payload.attachmentImportId === command.id
    && input.job.dedupeKey === zoteroAttachmentDownloadJobDedupeKey(command.id)
    && command.downloadJobId === input.job.id
    && command.organizationId === input.job.organizationId
    && command.integrationConnectionId === input.job.integrationConnectionId
    && command.zoteroLibraryId === input.job.zoteroLibraryId
    && command.documentId === input.job.documentId
    && command.assetId === input.job.assetId
    && command.intakeId === input.job.intakeId
    && lifecycleMatches
    && connection.provider === "ZOTERO"
    && connection.status === "CONNECTED"
    && connection.credentialGeneration === command.credentialGeneration
    && connection.credentialGeneration > 0
    && connection.credentialFingerprint !== null
    && connection.credentialKeyVersion !== null
    && connection.credentialCiphertext !== null
    && (
      connection.credentialExpiresAt === null
      || connection.credentialExpiresAt > input.now
    )
    && policy !== null
    && policy.mode === "MANUAL"
    && policy.revision === command.policyRevision
    && library.integrationConnectionId === connection.id
    && library.syncEnabled
    && library.isReadable
    && zoteroLibraryFileAccessPermitsDownload(library.fileAccessStatus)
    && library.accessLostAt === null
    && attachment.eligibility === "DOWNLOADABLE"
    && !attachment.isDeleted
    && attachment.linkMode !== null
    && (attachment.linkMode === "imported_file" || attachment.linkMode === "imported_url")
    && attachment.contentType === "application/pdf"
    && attachment.fileName !== null
    && attachment.fileName.toLowerCase().endsWith(".pdf")
    && attachment.providerMd5 === command.providerMd5
    && attachment.sourceVersion === command.sourceVersion
    && attachment.metadataHash === command.sourceMetadataHash
    && MD5_PATTERN.test(command.providerMd5)
    && SHA256_PATTERN.test(command.sourceMetadataHash)
    && !sourceObject.isDeleted
    && sourceObject.version === command.sourceVersion
    && sourceObject.zoteroLibraryId === library.id
    && intake.source === "ZOTERO_ATTACHMENT"
    && intake.policyRevision === command.policyRevision
    && intake.committedBytes === null
    && intake.failureCode === null
    && intake.cancelRequestedAt === null
    && intake.cancelledAt === null
    && intake.completedAt === null
    && intake.quotaReleasedAt === null
    && (firstClaim ? intake.status === "QUEUED" : intake.status === "RECEIVING")
    && intake.asset.storageProvider === "LOCAL"
    && intake.asset.status === "UPLOADING"
    && intake.asset.physicalLocator === null
    && intake.asset.sizeBytes === null
    && intake.asset.sha256 === null
    && intake.asset.deletedAt === null
    && intake.document.status === "PENDING"
    && intake.document.contentHash === null
    && maximumBytes !== null
    && (
      !lease
      || (
        lease.organizationId === command.organizationId
        && lease.connectionId === command.integrationConnectionId
        && lease.zoteroLibraryId === command.zoteroLibraryId
        && lease.zoteroObjectId === command.zoteroObjectId
        && lease.attachmentImportId === command.id
        && lease.intakeId === command.intakeId
        && lease.documentId === command.documentId
        && lease.assetId === command.assetId
        && lease.policyRevision === command.policyRevision
        && lease.credentialGeneration === command.credentialGeneration
        && lease.credentialFingerprint === connection.credentialFingerprint
        && lease.credentialKeyVersion === connection.credentialKeyVersion
        && sameOptionalDate(lease.credentialExpiresAt, connection.credentialExpiresAt)
        && lease.sourceVersion === command.sourceVersion
        && lease.sourceMetadataHash === command.sourceMetadataHash
        && lease.providerMd5 === command.providerMd5
        && lease.maximumBytes === maximumBytes
        && lease.zoteroItemKey === sourceObject.zoteroKey
        && lease.externalLibraryId === library.zoteroLibraryId
        && lease.libraryType === library.libraryType
      )
    );
}

async function terminalizeWithoutBytes(
  transaction: DownloadTransaction,
  job: {
    id: string;
    organizationId: string;
    integrationConnectionId: string | null;
    zoteroLibraryId: string | null;
    documentId: string | null;
    assetId: string | null;
    intakeId: string | null;
  },
  payloadAttachmentImportId: string | null,
  code: ZoteroAttachmentDownloadFailureCode,
  now: Date,
  deadLetter: boolean,
  finalizeBatchWhileCharged = false,
): Promise<void> {
  const publicCode = publicFailureCode(code);
  const hasTypedTarget = job.integrationConnectionId !== null
    && job.zoteroLibraryId !== null
    && job.documentId !== null
    && job.assetId !== null
    && job.intakeId !== null;
  const boundImport = hasTypedTarget
    ? await transaction.zoteroAttachmentImport.findFirst({
      where: {
        organizationId: job.organizationId,
        downloadJobId: job.id,
        integrationConnectionId: job.integrationConnectionId!,
        zoteroLibraryId: job.zoteroLibraryId!,
        documentId: job.documentId!,
        assetId: job.assetId!,
        intakeId: job.intakeId!,
        status: { in: ["QUEUED", "DOWNLOADING", "FAILED"] },
      },
      include: { intake: { select: { importBatchId: true } } },
    })
    : null;
  const attemptsNeedingCleanup = await transaction.documentIngressAttempt.count({
    where: {
      jobId: job.id,
      organizationId: job.organizationId,
      OR: [
        { status: { in: ["RECEIVING", "WRITTEN"] } },
        {
          status: { in: ["FAILED", "ABANDONED"] },
          cleanupCompletedAt: null,
        },
        { status: "ADOPTED" },
      ],
    },
  });
  const safeToRelease = attemptsNeedingCleanup === 0;
  await transaction.job.update({
    where: { organizationId_id: { organizationId: job.organizationId, id: job.id } },
    data: {
      status: deadLetter ? "DEAD_LETTER" : "FAILED",
      completedAt: now,
      lockedAt: null,
      lockedBy: null,
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorCode: code,
      lastErrorMessage: SAFE_FAILURE_MESSAGES[code],
    },
  });
  if (boundImport) {
    await transaction.zoteroAttachmentImport.updateMany({
      where: {
        id: boundImport.id,
        organizationId: job.organizationId,
        downloadJobId: job.id,
        integrationConnectionId: boundImport.integrationConnectionId,
        zoteroLibraryId: boundImport.zoteroLibraryId,
        documentId: boundImport.documentId,
        assetId: boundImport.assetId,
        intakeId: boundImport.intakeId,
        status: { in: ["QUEUED", "DOWNLOADING"] },
      },
      data: {
        status: "FAILED",
        failureCode: publicCode,
        retryAt: null,
        completedAt: now,
      },
    });
  }
  if (boundImport) {
    await transaction.documentIntake.updateMany({
      where: {
        id: boundImport.intakeId,
        organizationId: job.organizationId,
        documentId: boundImport.documentId,
        assetId: boundImport.assetId,
        status: { in: ["QUEUED", "RECEIVING"] },
      },
      data: {
        status: "FAILED",
        failureCode: publicCode,
        completedAt: now,
        quotaReleasedAt: safeToRelease ? now : null,
      },
    });
    if (safeToRelease) {
      await transaction.documentIntake.updateMany({
        where: {
          id: boundImport.intakeId,
          organizationId: job.organizationId,
          documentId: boundImport.documentId,
          assetId: boundImport.assetId,
          status: "FAILED",
          completedAt: { not: null },
          quotaReleasedAt: null,
        },
        data: { quotaReleasedAt: now },
      });
    }
  }
  if (boundImport) {
    await transaction.asset.updateMany({
      where: {
        id: boundImport.assetId,
        organizationId: job.organizationId,
        status: "UPLOADING",
      },
      data: {
        status: "REJECTED",
        rejectionCode: publicCode,
        rejectedReason: "The Zotero attachment could not be copied into private quarantine.",
      },
    });
  }
  if (boundImport) {
    await transaction.document.updateMany({
      where: {
        id: boundImport.documentId,
        organizationId: job.organizationId,
        status: "PENDING",
      },
      data: { status: "FAILED", failureCode: publicCode },
    });
    await transaction.inboxEntry.updateMany({
      where: {
        organizationId: job.organizationId,
        documentId: boundImport.documentId,
        status: { in: ["PENDING", "NEEDS_REVIEW"] },
      },
      data: {
        status: "FAILED",
        payload: {
          schemaVersion: 1,
          kind: "zotero-attachment-import",
          attachmentImportId: boundImport.id,
          importStatus: "FAILED",
        },
        failureCode: publicCode,
        failureMessage: "The Zotero attachment could not be imported.",
        resolvedAt: now,
      },
    });
  }
  if (
    (safeToRelease || finalizeBatchWhileCharged)
    && boundImport?.intake.importBatchId
  ) {
    await transaction.importBatch.updateMany({
      where: {
        id: boundImport.intake.importBatchId,
        organizationId: job.organizationId,
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
  await transaction.auditEvent.create({
    data: {
      organizationId: job.organizationId,
      action: deadLetter
        ? "zotero.attachment-download.dead-lettered"
        : "zotero.attachment-download.failed",
      entityType: "job",
      entityId: job.id,
      metadata: {
        failureCode: code,
        quotaReleased: boundImport !== null && safeToRelease,
        exactTargetBound: boundImport !== null,
        payloadMatchedBoundImport:
          boundImport !== null && payloadAttachmentImportId === boundImport.id,
      },
    },
  });
}

async function reapExpiredDownloadLease(
  transaction: DownloadTransaction,
  job: Awaited<ReturnType<DownloadTransaction["job"]["findUniqueOrThrow"]>>,
  now: Date,
): Promise<void> {
  if (!job.leaseId) return;
  const attempt = await transaction.jobAttempt.findFirst({
    where: {
      organizationId: job.organizationId,
      jobId: job.id,
      leaseId: job.leaseId,
      status: "RUNNING",
    },
    include: { ingressAttempt: true },
  });
  const exhausted = job.attempts >= job.maxAttempts;
  if (attempt?.ingressAttempt?.status === "ADOPTED") {
    await transaction.jobAttempt.update({
      where: { organizationId_id: { organizationId: job.organizationId, id: attempt.id } },
      data: {
        status: "DEAD_LETTER",
        completedAt: now,
        errorCode: "download_authority_stale",
        errorMessage: SAFE_FAILURE_MESSAGES.download_authority_stale,
      },
    });
    await transaction.job.update({
      where: { organizationId_id: { organizationId: job.organizationId, id: job.id } },
      data: {
        status: "DEAD_LETTER",
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: "download_authority_stale",
        lastErrorMessage: SAFE_FAILURE_MESSAGES.download_authority_stale,
      },
    });
    return;
  }
  if (attempt?.ingressAttempt) {
    await transaction.documentIngressAttempt.updateMany({
      where: {
        id: attempt.ingressAttempt.id,
        organizationId: job.organizationId,
        status: { in: ["RECEIVING", "WRITTEN"] },
      },
      data: {
        status: "ABANDONED",
        completedAt: now,
        failureCode: "download_lease_expired",
        cleanupAfter: now,
      },
    });
  }
  if (attempt) {
    await transaction.jobAttempt.update({
      where: { organizationId_id: { organizationId: job.organizationId, id: attempt.id } },
      data: {
        status: exhausted ? "DEAD_LETTER" : "FAILED",
        completedAt: now,
        errorCode: "download_lease_expired",
        errorMessage: SAFE_FAILURE_MESSAGES.download_lease_expired,
      },
    });
  }
  await transaction.job.update({
    where: { organizationId_id: { organizationId: job.organizationId, id: job.id } },
    data: {
      status: "RETRYING",
      runAfter: now,
      lockedAt: null,
      lockedBy: null,
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorCode: "download_lease_expired",
      lastErrorMessage: SAFE_FAILURE_MESSAGES.download_lease_expired,
    },
  });
}

export async function claimNextZoteroAttachmentDownloadJob(input: {
  workerId: string;
  maximumDownloadBytes: number;
  leaseTtlMs?: number;
  now?: Date;
  database?: PrismaClient;
}): Promise<ZoteroAttachmentDownloadLease | null> {
  const database = input.database ?? prisma;
  const workerId = requireWorkerId(input.workerId);
  const leaseTtlMs = requireLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_ZOTERO_ATTACHMENT_DOWNLOAD_LEASE_TTL_MS,
  );
  if (!Number.isSafeInteger(input.maximumDownloadBytes) || input.maximumDownloadBytes < 1) {
    throw new TypeError("A positive safe attachment byte limit is required.");
  }
  const clockOverride = requireClockOverride(input.now);

  for (let loop = 0; loop < MAX_CLAIM_REAP_LOOPS; loop += 1) {
    const claimed = await database.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<CandidateRow[]>`
        SELECT job."id"
        FROM "Job" AS job
        WHERE job."type" = 'DOCUMENT_DOWNLOAD'
          AND (
            (
              job."status" IN ('QUEUED', 'RETRYING')
              AND (
                (
                  job."runAfter" <= COALESCE(
                    CAST(${clockOverride} AS timestamptz),
                    clock_timestamp()
                  )
                  AND job."attempts" < job."maxAttempts"
                )
                OR job."attempts" >= job."maxAttempts"
              )
              AND NOT EXISTS (
                SELECT 1
                FROM "DocumentIngressAttempt" AS ingress
                WHERE ingress."jobId" = job."id"
                  AND ingress."organizationId" = job."organizationId"
                  AND (
                    ingress."status" IN ('RECEIVING', 'WRITTEN', 'ADOPTED')
                    OR (
                      ingress."status" IN ('FAILED', 'ABANDONED')
                      AND ingress."cleanupCompletedAt" IS NULL
                    )
                  )
              )
            )
            OR (
              job."status" = 'RUNNING'
              AND job."leaseExpiresAt" <= COALESCE(
                CAST(${clockOverride} AS timestamptz),
                clock_timestamp()
              )
            )
          )
        ORDER BY job."priority" DESC, job."runAfter", job."createdAt", job."id"
        FOR UPDATE OF job SKIP LOCKED
        LIMIT 1
      `;
      const candidate = candidates[0];
      if (!candidate) return { kind: "empty" as const };
      const job = await transaction.job.findUniqueOrThrow({ where: { id: candidate.id } });
      // The database clock is read only after the candidate row is locked. In
      // production, host clock skew therefore cannot claim or reap a lease.
      // The override exists solely for deterministic lifecycle tests.
      const now = await authoritativeLeaseNow(transaction, clockOverride);
      if (job.status === "RUNNING") {
        if (!job.leaseExpiresAt || job.leaseExpiresAt > now) return { kind: "skip" as const };
        await reapExpiredDownloadLease(transaction, job, now);
        return { kind: "skip" as const };
      }
      const payload = parseZoteroAttachmentDownloadJobPayload(job.payload);
      if (job.attempts >= job.maxAttempts) {
        await terminalizeWithoutBytes(
          transaction,
          job,
          payload?.attachmentImportId ?? null,
          "download_attempt_budget_exhausted",
          now,
          true,
        );
        return { kind: "skip" as const };
      }
      const authority = payload
        ? await loadAuthority(transaction, job.organizationId, payload.attachmentImportId)
        : null;
      if (!currentAuthorityMatches({
        job,
        authority,
        now,
        maximumConfiguredBytes: input.maximumDownloadBytes,
        phase: "claim",
      })) {
        await terminalizeWithoutBytes(
          transaction,
          job,
          payload?.attachmentImportId ?? null,
          "download_authority_stale",
          now,
          true,
        );
        return { kind: "skip" as const };
      }
      if (!authority) return { kind: "skip" as const };
      const command = authority.attachmentImport;
      const connection = command.integration;
      const attachment = command.attachment;
      const sourceObject = attachment.object;
      const library = command.library;
      const intake = command.intake;
      const maximumBytes = safeMaximumBytes(intake.reservedBytes, input.maximumDownloadBytes)!;
      if (connection.providerBackoffUntil && connection.providerBackoffUntil > now) {
        const boundedBackoff = clampZoteroAttachmentProviderRetryAt(
          connection.providerBackoffUntil,
          now,
        );
        const runAfter = boundedBackoff.retryAt
          ?? new Date(now.getTime() + retryDelayMs(Math.max(1, job.attempts)));
        if (boundedBackoff.clamped) {
          await transaction.integrationConnection.updateMany({
            where: {
              id: command.integrationConnectionId,
              organizationId: command.organizationId,
              provider: "ZOTERO",
              status: "CONNECTED",
              credentialGeneration: command.credentialGeneration,
              credentialFingerprint: connection.credentialFingerprint!,
              credentialKeyVersion: connection.credentialKeyVersion!,
              credentialExpiresAt: connection.credentialExpiresAt,
            },
            data: { providerBackoffUntil: runAfter },
          });
        }
        await transaction.job.update({
          where: { organizationId_id: { organizationId: job.organizationId, id: job.id } },
          data: { runAfter },
        });
        return { kind: "skip" as const };
      }

      const leaseId = randomUUID();
      const jobAttemptId = randomUUID();
      const ingressAttemptId = randomUUID();
      const attemptNumber = job.attempts + 1;
      const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
      const storageKey = localQuarantineStorageKeyForAttempt(
        { organizationId: job.organizationId, assetId: command.assetId },
        ingressAttemptId,
      );
      await transaction.job.update({
        where: { organizationId_id: { organizationId: job.organizationId, id: job.id } },
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
      await transaction.documentIngressAttempt.create({
        data: {
          id: ingressAttemptId,
          organizationId: job.organizationId,
          intakeId: command.intakeId,
          documentId: command.documentId,
          assetId: command.assetId,
          jobId: job.id,
          jobAttemptId,
          attemptNumber,
          storageKey,
          storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
          status: "RECEIVING",
          maximumSizeBytes: BigInt(maximumBytes),
          expectedSizeBytes: null,
          providerMd5: command.providerMd5,
          leaseId,
          leaseExpiresAt,
        },
      });
      if (command.status === "QUEUED") {
        await transaction.zoteroAttachmentImport.update({
          where: { organizationId_id: { organizationId: job.organizationId, id: command.id } },
          data: { status: "DOWNLOADING", startedAt: now, retryAt: null },
        });
      } else {
        await transaction.zoteroAttachmentImport.update({
          where: { organizationId_id: { organizationId: job.organizationId, id: command.id } },
          data: { retryAt: null },
        });
      }
      if (intake.status === "QUEUED") {
        await transaction.documentIntake.update({
          where: { organizationId_id: { organizationId: job.organizationId, id: intake.id } },
          data: { status: "RECEIVING" },
        });
      }
      return {
        kind: "claimed" as const,
        value: {
          organizationId: job.organizationId,
          connectionId: command.integrationConnectionId,
          zoteroLibraryId: command.zoteroLibraryId,
          libraryType: library.libraryType,
          externalLibraryId: library.zoteroLibraryId,
          zoteroObjectId: command.zoteroObjectId,
          zoteroItemKey: sourceObject.zoteroKey,
          attachmentImportId: command.id,
          jobId: job.id,
          jobAttemptId,
          ingressAttemptId,
          attemptNumber,
          workerId,
          leaseId,
          leaseExpiresAt,
          intakeId: command.intakeId,
          documentId: command.documentId,
          assetId: command.assetId,
          inboxEntryId: intake.inboxEntryId,
          importBatchId: intake.importBatchId,
          requestedById: command.requestedById,
          policyRevision: command.policyRevision,
          credentialGeneration: command.credentialGeneration,
          credentialFingerprint: connection.credentialFingerprint!,
          credentialKeyVersion: connection.credentialKeyVersion!,
          credentialExpiresAt: connection.credentialExpiresAt,
          sourceVersion: command.sourceVersion,
          sourceMetadataHash: command.sourceMetadataHash,
          providerMd5: command.providerMd5,
          originalFileName: attachment.fileName!,
          maximumBytes,
          storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
          storageKey,
        } satisfies ZoteroAttachmentDownloadLease,
      };
    });
    if (claimed.kind === "claimed") return claimed.value;
    if (claimed.kind === "empty") return null;
  }
  return null;
}

async function loadAndCheckLeaseAuthority(
  transaction: DownloadTransaction,
  lease: ZoteroAttachmentDownloadLease,
  now: Date,
  maximumConfiguredBytes: number,
) {
  const job = await transaction.job.findUnique({
    where: { organizationId_id: { organizationId: lease.organizationId, id: lease.jobId } },
  });
  if (!job) return null;
  const authority = await loadAuthority(
    transaction,
    lease.organizationId,
    lease.attachmentImportId,
  );
  if (!currentAuthorityMatches({
    job,
    authority,
    expectedLease: lease,
    now,
    maximumConfiguredBytes,
    phase: "download",
  })) return null;
  return { job, authority };
}

export async function heartbeatZoteroAttachmentDownloadLease(input: {
  lease: ZoteroAttachmentDownloadLease;
  leaseTtlMs?: number;
  now?: Date;
  database?: PrismaClient;
}): Promise<boolean> {
  const database = input.database ?? prisma;
  const clockOverride = requireClockOverride(input.now);
  const leaseTtlMs = requireLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_ZOTERO_ATTACHMENT_DOWNLOAD_LEASE_TTL_MS,
  );
  return database.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "Job"
      WHERE "id" = ${input.lease.jobId}
        AND "organizationId" = ${input.lease.organizationId}
      FOR UPDATE
    `;
    if (!locked[0]) return false;
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const extended = new Date(now.getTime() + leaseTtlMs);
    const current = await loadAndCheckLeaseAuthority(
      transaction,
      input.lease,
      now,
      input.lease.maximumBytes,
    );
    if (
      !current
      || current.job.status !== "RUNNING"
      || current.job.lockedBy !== input.lease.workerId
      || current.job.leaseId !== input.lease.leaseId
      || !current.job.leaseExpiresAt
      || current.job.leaseExpiresAt <= now
      || current.job.attempts !== input.lease.attemptNumber
    ) return false;
    const attempt = await transaction.documentIngressAttempt.findFirst({
      where: {
        id: input.lease.ingressAttemptId,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        jobAttemptId: input.lease.jobAttemptId,
        leaseId: input.lease.leaseId,
        status: { in: ["RECEIVING", "WRITTEN"] },
      },
    });
    if (!attempt || attempt.storageKey !== input.lease.storageKey) return false;
    await transaction.job.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
      data: { leaseExpiresAt: extended },
    });
    await transaction.documentIngressAttempt.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
      data: { leaseExpiresAt: extended },
    });
    return true;
  });
}

function assertWrittenDownload(
  lease: ZoteroAttachmentDownloadLease,
  written: WrittenZoteroAttachmentDownload,
): void {
  if (
    written.storageKey !== lease.storageKey
    || written.sizeBytes < 1n
    || written.sizeBytes > BigInt(lease.maximumBytes)
    || !SHA256_PATTERN.test(written.sha256)
    || !MD5_PATTERN.test(written.md5)
    || written.md5 !== lease.providerMd5
    || written.mimeType !== "application/pdf"
    || !(written.storedAt instanceof Date)
    || !Number.isFinite(written.storedAt.getTime())
  ) throw new TypeError("The written attachment identity is invalid.");
}

export async function recordWrittenZoteroAttachmentDownload(input: {
  lease: ZoteroAttachmentDownloadLease;
  written: WrittenZoteroAttachmentDownload;
  now?: Date;
  database?: PrismaClient;
}): Promise<boolean> {
  assertWrittenDownload(input.lease, input.written);
  const database = input.database ?? prisma;
  const clockOverride = requireClockOverride(input.now);
  return database.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "Job"
      WHERE "id" = ${input.lease.jobId}
        AND "organizationId" = ${input.lease.organizationId}
      FOR UPDATE
    `;
    if (!locked[0]) return false;
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const current = await loadAndCheckLeaseAuthority(
      transaction,
      input.lease,
      now,
      input.lease.maximumBytes,
    );
    if (
      !current
      || current.job.status !== "RUNNING"
      || current.job.lockedBy !== input.lease.workerId
      || current.job.leaseId !== input.lease.leaseId
      || !current.job.leaseExpiresAt
      || current.job.leaseExpiresAt <= now
      || current.job.attempts !== input.lease.attemptNumber
    ) return false;
    const attempt = await transaction.documentIngressAttempt.findUnique({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
    });
    if (
      !attempt
      || attempt.jobId !== input.lease.jobId
      || attempt.jobAttemptId !== input.lease.jobAttemptId
      || attempt.leaseId !== input.lease.leaseId
      || attempt.storageKey !== input.written.storageKey
    ) return false;
    if (attempt.status === "WRITTEN" || attempt.status === "ADOPTED") {
      return attempt.receivedSizeBytes === input.written.sizeBytes
        && attempt.computedMd5 === input.written.md5
        && attempt.sha256 === input.written.sha256
        && attempt.storedAt?.getTime() === input.written.storedAt.getTime();
    }
    if (attempt.status !== "RECEIVING") return false;
    await transaction.documentIngressAttempt.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
      data: {
        status: "WRITTEN",
        receivedSizeBytes: input.written.sizeBytes,
        computedMd5: input.written.md5,
        sha256: input.written.sha256,
        storedAt: input.written.storedAt,
      },
    });
    return true;
  });
}

function completionResult(input: WrittenZoteroAttachmentDownload, receiptId: string) {
  return {
    schemaVersion: 1,
    ingestReceiptId: receiptId,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes.toString(),
    storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
  };
}

export async function completeZoteroAttachmentDownloadLease(input: {
  lease: ZoteroAttachmentDownloadLease;
  written: WrittenZoteroAttachmentDownload;
  now?: Date;
  database?: PrismaClient;
}): Promise<"applied" | "replayed" | "lease-lost"> {
  assertWrittenDownload(input.lease, input.written);
  const database = input.database ?? prisma;
  const clockOverride = requireClockOverride(input.now);
  return database.$transaction(async (transaction) => {
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
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
    });
    const existingReceipt = await transaction.documentIngestReceipt.findFirst({
      where: {
        organizationId: input.lease.organizationId,
        zoteroAttachmentImportId: input.lease.attachmentImportId,
        ingressAttemptId: input.lease.ingressAttemptId,
      },
    });
    const existingAttempt = await transaction.documentIngressAttempt.findUnique({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
    });
    if (job.status === "SUCCEEDED" && existingReceipt && existingAttempt?.status === "ADOPTED") {
      return existingReceipt.sha256 === input.written.sha256
        && existingReceipt.receivedSizeBytes === input.written.sizeBytes
        && existingReceipt.storageVersion === input.lease.storageVersion
        && existingReceipt.storedAt.getTime() === input.written.storedAt.getTime()
        ? "replayed" as const
        : "lease-lost" as const;
    }
    const current = await loadAndCheckLeaseAuthority(
      transaction,
      input.lease,
      now,
      input.lease.maximumBytes,
    );
    if (
      !current
      || job.status !== "RUNNING"
      || job.lockedBy !== input.lease.workerId
      || job.leaseId !== input.lease.leaseId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= now
      || job.attempts !== input.lease.attemptNumber
    ) return "lease-lost" as const;
    if (!current.authority) return "lease-lost" as const;
    const command = current.authority.attachmentImport;
    const attempt = await transaction.documentIngressAttempt.findUnique({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
    });
    const jobAttempt = await transaction.jobAttempt.findUnique({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobAttemptId } },
    });
    if (
      !attempt
      || attempt.status !== "WRITTEN"
      || attempt.jobId !== input.lease.jobId
      || attempt.jobAttemptId !== input.lease.jobAttemptId
      || attempt.leaseId !== input.lease.leaseId
      || attempt.storageKey !== input.written.storageKey
      || attempt.storageVersion !== input.lease.storageVersion
      || attempt.receivedSizeBytes !== input.written.sizeBytes
      || attempt.computedMd5 !== input.written.md5
      || attempt.providerMd5 !== input.lease.providerMd5
      || attempt.sha256 !== input.written.sha256
      || attempt.storedAt?.getTime() !== input.written.storedAt.getTime()
      || !jobAttempt
      || jobAttempt.status !== "RUNNING"
      || jobAttempt.jobId !== input.lease.jobId
      || jobAttempt.attemptNumber !== input.lease.attemptNumber
      || jobAttempt.workerId !== input.lease.workerId
      || jobAttempt.leaseId !== input.lease.leaseId
    ) return "lease-lost" as const;

    await transaction.asset.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.assetId } },
      data: {
        objectKey: input.written.storageKey,
        physicalLocator: input.written.storageKey,
        status: "QUARANTINED",
        originalFileName: input.lease.originalFileName,
        mimeType: input.written.mimeType,
        sizeBytes: input.written.sizeBytes,
        sha256: input.written.sha256,
        etag: null,
        rejectionCode: null,
        rejectedReason: null,
        metadata: {
          schemaVersion: 1,
          custody: "private-quarantine",
          source: "zotero-attachment",
          publicAccess: false,
        },
      },
    });
    await transaction.document.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.documentId } },
      data: {
        status: "PENDING",
        mimeType: input.written.mimeType,
        contentHash: input.written.sha256,
        failureCode: null,
        metadata: {
          schemaVersion: 1,
          custody: "private-quarantine",
          verification: "pending",
          source: "zotero-attachment",
        },
      },
    });
    await transaction.documentIntake.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.intakeId } },
      data: {
        status: "QUARANTINED",
        committedBytes: input.written.sizeBytes,
      },
    });
    await transaction.zoteroAttachmentImport.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.attachmentImportId } },
      data: {
        status: "QUARANTINED",
        quarantinedAt: now,
        retryAt: null,
        failureCode: null,
      },
    });
    await transaction.documentIngressAttempt.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
      data: { status: "ADOPTED", completedAt: now, cleanupAfter: null },
    });
    const receipt = await transaction.documentIngestReceipt.create({
      data: {
        id: randomUUID(),
        organizationId: input.lease.organizationId,
        source: "ZOTERO_ATTACHMENT",
        sourceFingerprint: `zotero-attachment-import:${input.lease.attachmentImportId}`,
        intakeId: input.lease.intakeId,
        assetId: input.lease.assetId,
        documentId: input.lease.documentId,
        inboxEntryId: input.lease.inboxEntryId,
        importBatchId: input.lease.importBatchId,
        ingressAttemptId: input.lease.ingressAttemptId,
        integrationConnectionId: input.lease.connectionId,
        zoteroLibraryId: input.lease.zoteroLibraryId,
        zoteroObjectId: input.lease.zoteroObjectId,
        zoteroAttachmentImportId: input.lease.attachmentImportId,
        requestedById: input.lease.requestedById,
        sourceVersion: input.lease.sourceVersion,
        sourceChecksumAlgorithm: "md5",
        sourceChecksum: input.lease.providerMd5,
        declaredMimeType: input.written.mimeType,
        receivedSizeBytes: input.written.sizeBytes,
        sha256: input.written.sha256,
        storageVersion: input.lease.storageVersion,
        storedAt: input.written.storedAt,
        metadata: {
          schemaVersion: 1,
          transport: "authenticated-zotero-file",
          publicAccess: false,
        },
      },
    });
    if (input.lease.inboxEntryId) {
      await transaction.inboxEntry.updateMany({
        where: {
          id: input.lease.inboxEntryId,
          organizationId: input.lease.organizationId,
          documentId: input.lease.documentId,
          status: "NEEDS_REVIEW",
        },
        data: {
          payload: {
            schemaVersion: 1,
            kind: "zotero-attachment-import",
            attachmentImportId: input.lease.attachmentImportId,
            importStatus: "QUARANTINED",
          },
          failureCode: null,
          failureMessage: null,
        },
      });
    }
    await enqueueDocumentValidationJob(transaction, {
      organizationId: input.lease.organizationId,
      documentId: input.lease.documentId,
      assetId: input.lease.assetId,
      ingestReceiptId: receipt.id,
      createdById: command.requestedById,
      storageVersion: input.lease.storageVersion,
      now,
    });
    const result = completionResult(input.written, receipt.id);
    await transaction.jobAttempt.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobAttemptId } },
      data: { status: "SUCCEEDED", completedAt: now, result },
    });
    await transaction.job.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
      data: {
        status: "SUCCEEDED",
        result,
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        actorUserId: command.requestedById,
        action: "zotero.attachment-download.quarantined",
        entityType: "zotero-attachment-import",
        entityId: command.id,
        metadata: {
          jobId: input.lease.jobId,
          ingestReceiptId: receipt.id,
          sizeBytes: input.written.sizeBytes.toString(),
        },
      },
    });
    return "applied" as const;
  }, { isolationLevel: "Serializable" });
}

export async function failZoteroAttachmentDownloadLease(input: {
  lease: ZoteroAttachmentDownloadLease;
  failure: ZoteroAttachmentDownloadFailure;
  now?: Date;
  database?: PrismaClient;
}): Promise<FailZoteroAttachmentDownloadResult> {
  const database = input.database ?? prisma;
  const clockOverride = requireClockOverride(input.now);
  return database.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "Job"
      WHERE "id" = ${input.lease.jobId}
        AND "organizationId" = ${input.lease.organizationId}
      FOR UPDATE
    `;
    if (!locked[0]) return { outcome: "lease-lost" as const };
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const job = await transaction.job.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
    });
    const payload = parseZoteroAttachmentDownloadJobPayload(job.payload);
    if (
      job.type !== "DOCUMENT_DOWNLOAD"
      || job.status !== "RUNNING"
      || job.lockedBy !== input.lease.workerId
      || job.leaseId !== input.lease.leaseId
      || !job.leaseExpiresAt
      || job.leaseExpiresAt <= now
      || job.attempts !== input.lease.attemptNumber
      || job.dedupeKey !== zoteroAttachmentDownloadJobDedupeKey(
        input.lease.attachmentImportId,
      )
      || payload?.attachmentImportId !== input.lease.attachmentImportId
      || job.integrationConnectionId !== input.lease.connectionId
      || job.zoteroLibraryId !== input.lease.zoteroLibraryId
      || job.documentId !== input.lease.documentId
      || job.assetId !== input.lease.assetId
      || job.intakeId !== input.lease.intakeId
    ) return { outcome: "lease-lost" as const };
    const attempt = await transaction.documentIngressAttempt.findUnique({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
    });
    if (
      !attempt
      || attempt.jobId !== input.lease.jobId
      || attempt.jobAttemptId !== input.lease.jobAttemptId
      || attempt.leaseId !== input.lease.leaseId
      || attempt.storageKey !== input.lease.storageKey
      || !["RECEIVING", "WRITTEN"].includes(attempt.status)
    ) return { outcome: "lease-lost" as const };
    const jobAttempt = await transaction.jobAttempt.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.jobAttemptId,
        },
      },
    });
    if (
      !jobAttempt
      || jobAttempt.jobId !== input.lease.jobId
      || jobAttempt.attemptNumber !== input.lease.attemptNumber
      || jobAttempt.status !== "RUNNING"
      || jobAttempt.workerId !== input.lease.workerId
      || jobAttempt.leaseId !== input.lease.leaseId
    ) return { outcome: "lease-lost" as const };
    const authority = await loadAuthority(
      transaction,
      input.lease.organizationId,
      input.lease.attachmentImportId,
    );
    const authorityCurrent = currentAuthorityMatches({
      job,
      authority,
      expectedLease: input.lease,
      now,
      maximumConfiguredBytes: input.lease.maximumBytes,
      phase: "download",
    });
    const failure: ZoteroAttachmentDownloadFailure = authorityCurrent
      ? input.failure
      : { code: "download_authority_stale", retryable: false };
    const terminal = !failure.retryable || job.attempts >= job.maxAttempts;
    if (attempt.status === "RECEIVING" || attempt.status === "WRITTEN") {
      await transaction.documentIngressAttempt.update({
        where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
        data: {
          status: "FAILED",
          completedAt: now,
          failureCode: failure.code,
          cleanupAfter: now,
        },
      });
    }
    await transaction.jobAttempt.updateMany({
      where: {
        id: input.lease.jobAttemptId,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        leaseId: input.lease.leaseId,
        status: "RUNNING",
      },
      data: {
        status: terminal ? "DEAD_LETTER" : "FAILED",
        completedAt: now,
        errorCode: failure.code,
        errorMessage: SAFE_FAILURE_MESSAGES[failure.code],
      },
    });
    const providerRetry = clampZoteroAttachmentProviderRetryAt(
      failure.retryAt,
      now,
    );
    const fallbackRetryAt = new Date(now.getTime() + retryDelayMs(job.attempts));
    const retryAt = providerRetry.retryAt && providerRetry.retryAt > fallbackRetryAt
      ? providerRetry.retryAt
      : fallbackRetryAt;
    await transaction.job.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
      data: {
        status: "RETRYING",
        runAfter: terminal ? now : retryAt,
        lockedAt: null,
        lockedBy: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: failure.code,
        lastErrorMessage: SAFE_FAILURE_MESSAGES[failure.code],
      },
    });
    await transaction.zoteroAttachmentImport.updateMany({
      where: {
        id: input.lease.attachmentImportId,
        organizationId: input.lease.organizationId,
        status: "DOWNLOADING",
      },
      data: { retryAt: terminal ? null : retryAt },
    });
    if (failure.connectionWideBackoff && !terminal) {
      await transaction.integrationConnection.updateMany({
        where: zoteroAttachmentCredentialFenceWhere(input.lease),
        data: { providerBackoffUntil: retryAt },
      });
    }
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        action: terminal
          ? "zotero.attachment-download.cleanup-pending-failure"
          : "zotero.attachment-download.retrying",
        entityType: "job",
        entityId: input.lease.jobId,
        metadata: {
          failureCode: failure.code,
          retryScheduled: !terminal,
          providerRetryClamped: providerRetry.clamped,
          authorityCurrent,
        },
      },
    });
    return {
      outcome: "cleanup-required" as const,
      ingressAttemptId: input.lease.ingressAttemptId,
      terminal,
    };
  });
}

async function finishCleanup(input: {
  database: PrismaClient;
  ingressAttemptId: string;
  expectedCleanupAttemptCount: number;
  cleanupSucceeded: boolean;
  clockOverride: Date | null;
}): Promise<ZoteroAttachmentDownloadCleanupResult> {
  return input.database.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CleanupCandidateRow[]>`
      SELECT "id"
      FROM "DocumentIngressAttempt"
      WHERE "id" = ${input.ingressAttemptId}
      FOR UPDATE
    `;
    if (!locked[0]) return { outcome: "idle" as const };
    const now = await authoritativeLeaseNow(transaction, input.clockOverride);
    const ingress = await transaction.documentIngressAttempt.findUniqueOrThrow({
      where: { id: input.ingressAttemptId },
      include: { jobAttempt: true, job: true },
    });
    if (
      ingress.status === "ADOPTED"
      || ingress.cleanupCompletedAt !== null
      || !["FAILED", "ABANDONED"].includes(ingress.status)
      || ingress.cleanupAttemptCount !== input.expectedCleanupAttemptCount
    ) return { outcome: "idle" as const };
    if (!input.cleanupSucceeded) {
      const requiresAttentionTerminalization =
        ingress.cleanupAttemptCount >= ZOTERO_ATTACHMENT_CLEANUP_ATTENTION_THRESHOLD
        && ingress.job.status !== "DEAD_LETTER";
      const next = new Date(
        now.getTime() + cleanupDelayMs(ingress.cleanupAttemptCount),
      );
      await transaction.documentIngressAttempt.update({
        where: { id: ingress.id },
        data: {
          cleanupAfter: next,
          cleanupFailureCode:
            ingress.cleanupAttemptCount >= ZOTERO_ATTACHMENT_CLEANUP_ATTENTION_THRESHOLD
            ? "cleanup_attention_required"
            : "cleanup_storage_unavailable",
        },
      });
      if (requiresAttentionTerminalization) {
        await transaction.jobAttempt.updateMany({
          where: {
            id: ingress.jobAttemptId,
            organizationId: ingress.organizationId,
            jobId: ingress.jobId,
            status: "FAILED",
          },
          data: { status: "DEAD_LETTER" },
        });
        const payload = parseZoteroAttachmentDownloadJobPayload(ingress.job.payload);
        const failureCode = (
          ingress.job.lastErrorCode
          && ingress.job.lastErrorCode in SAFE_FAILURE_MESSAGES
        )
          ? ingress.job.lastErrorCode as ZoteroAttachmentDownloadFailureCode
          : "download_storage_unavailable";
        await terminalizeWithoutBytes(
          transaction,
          ingress.job,
          payload?.attachmentImportId ?? null,
          failureCode,
          now,
          true,
          true,
        );
      } else {
        // Cleanup remains independently scheduled even after the logical job
        // is dead-lettered. A terminal job is intentionally not re-opened.
        await transaction.job.updateMany({
          where: {
            id: ingress.jobId,
            organizationId: ingress.organizationId,
            status: "RETRYING",
          },
          data: { runAfter: next },
        });
      }
      return {
        outcome: requiresAttentionTerminalization
          ? "dead-letter" as const
          : "retrying" as const,
        jobId: ingress.jobId,
        ingressAttemptId: ingress.id,
      };
    }
    await transaction.documentIngressAttempt.update({
      where: { id: ingress.id },
      data: {
        cleanupCompletedAt: now,
        cleanupAfter: null,
        cleanupFailureCode: null,
      },
    });
    const terminalAttempt = ingress.jobAttempt.status === "DEAD_LETTER"
      ? ingress.jobAttempt
      : await transaction.jobAttempt.findFirst({
        where: {
          organizationId: ingress.organizationId,
          jobId: ingress.jobId,
          status: "DEAD_LETTER",
        },
        orderBy: { attemptNumber: "desc" },
      });
    const remainingUnsafeAttempts = await transaction.documentIngressAttempt.count({
      where: {
        organizationId: ingress.organizationId,
        jobId: ingress.jobId,
        OR: [
          { status: { in: ["RECEIVING", "WRITTEN", "ADOPTED"] } },
          {
            status: { in: ["FAILED", "ABANDONED"] },
            cleanupCompletedAt: null,
          },
        ],
      },
    });
    if (terminalAttempt && remainingUnsafeAttempts === 0) {
      const payload = parseZoteroAttachmentDownloadJobPayload(ingress.job.payload);
      const code = (ingress.job.lastErrorCode && ingress.job.lastErrorCode in SAFE_FAILURE_MESSAGES)
        ? ingress.job.lastErrorCode as ZoteroAttachmentDownloadFailureCode
        : "download_worker_internal";
      const remainsDeadLetter = ingress.job.status === "DEAD_LETTER"
        || ingress.job.attempts >= ingress.job.maxAttempts;
      await terminalizeWithoutBytes(
        transaction,
        ingress.job,
        payload?.attachmentImportId ?? null,
        code,
        now,
        remainsDeadLetter,
      );
      return {
        outcome: remainsDeadLetter
          ? "dead-letter" as const
          : "failed" as const,
        jobId: ingress.jobId,
        ingressAttemptId: ingress.id,
      };
    }
    if (
      remainingUnsafeAttempts === 0
      && ["FAILED", "DEAD_LETTER"].includes(ingress.job.status)
      && ingress.job.intakeId
    ) {
      await transaction.documentIntake.updateMany({
        where: {
          id: ingress.job.intakeId,
          organizationId: ingress.organizationId,
          status: "FAILED",
          completedAt: { not: null },
          quotaReleasedAt: null,
        },
        data: { quotaReleasedAt: now },
      });
    }
    return {
      outcome: "cleaned" as const,
      jobId: ingress.jobId,
      ingressAttemptId: ingress.id,
    };
  });
}

export async function reconcileZoteroAttachmentDownloadCleanup(input: {
  configuration: Pick<UploadConfiguration, "quarantineRoot">;
  ingressAttemptId?: string;
  now?: Date;
  database?: PrismaClient;
}): Promise<ZoteroAttachmentDownloadCleanupResult> {
  const database = input.database ?? prisma;
  const clockOverride = requireClockOverride(input.now);
  const candidate = await database.$transaction(async (transaction) => {
    const rows = input.ingressAttemptId
      ? await transaction.$queryRaw<CleanupCandidateRow[]>`
          SELECT "id"
          FROM "DocumentIngressAttempt"
          WHERE "id" = ${input.ingressAttemptId}
            AND "status" IN ('FAILED', 'ABANDONED')
            AND "cleanupCompletedAt" IS NULL
            AND (
              "cleanupAfter" IS NULL
              OR "cleanupAfter" <= COALESCE(
                CAST(${clockOverride} AS timestamptz),
                clock_timestamp()
              )
            )
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `
      : await transaction.$queryRaw<CleanupCandidateRow[]>`
          SELECT "id"
          FROM "DocumentIngressAttempt"
          WHERE "status" IN ('FAILED', 'ABANDONED')
            AND "cleanupCompletedAt" IS NULL
            AND (
              "cleanupAfter" IS NULL
              OR "cleanupAfter" <= COALESCE(
                CAST(${clockOverride} AS timestamptz),
                clock_timestamp()
              )
            )
          ORDER BY "cleanupAfter" NULLS FIRST, "createdAt", "id"
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
    const row = rows[0];
    if (!row) return null;
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const attempt = await transaction.documentIngressAttempt.findUniqueOrThrow({
      where: { id: row.id },
    });
    await transaction.documentIngressAttempt.update({
      where: { id: row.id },
      data: {
        cleanupAttemptCount: { increment: 1 },
        cleanupAfter: new Date(now.getTime() + CLEANUP_LEASE_MS),
        cleanupFailureCode: null,
      },
    });
    return {
      id: attempt.id,
      organizationId: attempt.organizationId,
      assetId: attempt.assetId,
      storageKey: attempt.storageKey,
      cleanupAttemptCount: attempt.cleanupAttemptCount + 1,
    };
  });
  if (!candidate) return { outcome: "idle" };
  let cleanupSucceeded = false;
  try {
    const expectedStorageKey = localQuarantineStorageKeyForAttempt(
      { organizationId: candidate.organizationId, assetId: candidate.assetId },
      candidate.id,
    );
    if (candidate.storageKey !== expectedStorageKey) {
      throw new Error("The ingress storage key does not match its immutable attempt.");
    }
    await removeLocalQuarantineAttemptObjects(
      input.configuration,
      { organizationId: candidate.organizationId, assetId: candidate.assetId },
      candidate.id,
    );
    cleanupSucceeded = true;
  } catch {
    cleanupSucceeded = false;
  }
  return finishCleanup({
    database,
    ingressAttemptId: candidate.id,
    expectedCleanupAttemptCount: candidate.cleanupAttemptCount,
    cleanupSucceeded,
    clockOverride,
  });
}

async function credentialFenceMatches(
  database: PrismaClient,
  lease: ZoteroAttachmentDownloadLease,
  clockOverride: Date | null,
): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const connection = await transaction.integrationConnection.findUnique({
      where: { organizationId_id: { organizationId: lease.organizationId, id: lease.connectionId } },
      select: {
        provider: true,
        status: true,
        credentialGeneration: true,
        credentialFingerprint: true,
        credentialKeyVersion: true,
        credentialExpiresAt: true,
      },
    });
    return connection?.provider === "ZOTERO"
      && connection.status === "CONNECTED"
      && connection.credentialGeneration === lease.credentialGeneration
      && connection.credentialFingerprint === lease.credentialFingerprint
      && connection.credentialKeyVersion === lease.credentialKeyVersion
      && sameOptionalDate(connection.credentialExpiresAt, lease.credentialExpiresAt)
      && (connection.credentialExpiresAt === null || connection.credentialExpiresAt > now);
  });
}

async function executionAuthorityFenceMatches(
  database: PrismaClient,
  lease: ZoteroAttachmentDownloadLease,
  clockOverride: Date | null,
): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const now = await authoritativeLeaseNow(transaction, clockOverride);
    const current = await loadAndCheckLeaseAuthority(
      transaction,
      lease,
      now,
      lease.maximumBytes,
    );
    if (
      !current
      || current.job.status !== "RUNNING"
      || current.job.lockedBy !== lease.workerId
      || current.job.leaseId !== lease.leaseId
      || !current.job.leaseExpiresAt
      || current.job.leaseExpiresAt <= now
      || current.job.attempts !== lease.attemptNumber
    ) return false;
    const [jobAttempt, ingressAttempt] = await Promise.all([
      transaction.jobAttempt.findFirst({
        where: {
          id: lease.jobAttemptId,
          organizationId: lease.organizationId,
          jobId: lease.jobId,
          attemptNumber: lease.attemptNumber,
          workerId: lease.workerId,
          leaseId: lease.leaseId,
          status: "RUNNING",
        },
        select: { id: true },
      }),
      transaction.documentIngressAttempt.findFirst({
        where: {
          id: lease.ingressAttemptId,
          organizationId: lease.organizationId,
          jobId: lease.jobId,
          jobAttemptId: lease.jobAttemptId,
          intakeId: lease.intakeId,
          documentId: lease.documentId,
          assetId: lease.assetId,
          leaseId: lease.leaseId,
          storageKey: lease.storageKey,
          status: { in: ["RECEIVING", "WRITTEN"] },
        },
        select: { id: true },
      }),
    ]);
    return jobAttempt !== null && ingressAttempt !== null;
  });
}

/**
 * Wrap the shared resolver with a before/after generation fence. Plaintext is
 * returned only when the exact admitted credential tuple remained current for
 * the complete resolution; it is never added to the lease, payload, or DB.
 */
export function createFencedZoteroAttachmentCredentialResolver(input: {
  lease: ZoteroAttachmentDownloadLease;
  database?: PrismaClient;
  credentialProtector?: CredentialProtector;
  now?: () => Date;
  /** Test-only seam; production callers use the complete durable authority fence. */
  authorityVerifier?: () => Promise<boolean>;
}): ZoteroCredentialResolver {
  const database = input.database ?? prisma;
  const base = createZoteroCredentialResolver({
    database,
    credentialProtector: input.credentialProtector,
  });
  const clockOverride = () => input.now === undefined
    ? null
    : requireClockOverride(input.now());
  const authorityVerifier = input.authorityVerifier
    ?? (() => executionAuthorityFenceMatches(
      database,
      input.lease,
      clockOverride(),
    ));
  return async (lookup) => {
    if (
      lookup.organizationId !== input.lease.organizationId
      || lookup.connectionId !== input.lease.connectionId
      || !await authorityVerifier()
      || !await credentialFenceMatches(database, input.lease, clockOverride())
    ) return null;
    const credential = await base(lookup);
    if (
      !credential
      || !await authorityVerifier()
      || !await credentialFenceMatches(database, input.lease, clockOverride())
    ) {
      return null;
    }
    return credential;
  };
}

export function createFencedZoteroAttachmentBinaryAdapter(input: {
  lease: ZoteroAttachmentDownloadLease;
  database?: PrismaClient;
  credentialProtector?: CredentialProtector;
  blobAllowlist?: readonly ZoteroAttachmentBlobAllowlistEntry[];
  environment?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): ZoteroAttachmentBinaryAdapter {
  const protector = input.credentialProtector ?? credentialProtectorFromEnvironment(
    input.environment ?? process.env,
  );
  return new ZoteroAttachmentBinaryAdapter({
    credentialResolver: createFencedZoteroAttachmentCredentialResolver({
      lease: input.lease,
      database: input.database,
      credentialProtector: protector,
      now: input.now,
    }),
    blobAllowlist: input.blobAllowlist
      ?? zoteroAttachmentBlobAllowlistFromEnvironment(input.environment),
    fetchImpl: input.fetchImpl,
    now: input.now,
    timeoutMs: input.timeoutMs,
  });
}

export function writtenDownloadFromStorage(
  result: LocalQuarantineUploadResult,
  storedAt: Date,
): WrittenZoteroAttachmentDownload {
  return {
    storageKey: result.storageKey,
    sizeBytes: result.sizeBytes,
    sha256: result.sha256,
    md5: result.md5,
    mimeType: result.mimeType,
    storedAt,
  };
}

export function zoteroAttachmentDownloadFailureFromUnknown(
  error: unknown,
  now: Date = new Date(),
): ZoteroAttachmentDownloadFailure {
  if (
    typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "ZoteroAdapterError"
    && "code" in error
    && typeof error.code === "string"
    && error.code in SAFE_FAILURE_MESSAGES
  ) {
    const adapterError = error as {
      code: ZoteroAttachmentDownloadFailureCode;
      retryable?: unknown;
      retryAt?: unknown;
      retryAfterSeconds?: unknown;
      backoffSeconds?: unknown;
    };
    const explicitRetryAt = typeof adapterError.retryAt === "string"
      ? new Date(adapterError.retryAt)
      : null;
    const retrySeconds = Math.max(
      typeof adapterError.retryAfterSeconds === "number" ? adapterError.retryAfterSeconds : 0,
      typeof adapterError.backoffSeconds === "number" ? adapterError.backoffSeconds : 0,
    );
    const retryAt = explicitRetryAt && Number.isFinite(explicitRetryAt.getTime())
      ? explicitRetryAt
      : retrySeconds > 0
        ? new Date(now.getTime() + retrySeconds * 1_000)
        : undefined;
    return {
      code: adapterError.code,
      retryable: adapterError.retryable === true,
      retryAt,
      connectionWideBackoff:
        typeof adapterError.backoffSeconds === "number"
        && adapterError.backoffSeconds > 0,
    };
  }
  if (error instanceof HttpProblem) {
    switch (error.code) {
      case "upload_too_large":
        return { code: "zotero_response_too_large", retryable: false };
      case "content_length_mismatch":
      case "content_md5_mismatch":
      case "invalid_pdf_header":
      case "invalid_pdf_trailer":
        return { code: "download_integrity_mismatch", retryable: false };
      case "upload_timed_out":
        return { code: "zotero_timeout", retryable: true };
      case "upload_aborted":
        return { code: "download_aborted", retryable: true };
      case "upload_already_stored":
      case "storage_key_mismatch":
        return { code: "download_storage_conflict", retryable: false };
      case "storage_unavailable":
        return { code: "download_storage_unavailable", retryable: true };
    }
  }
  return { code: "download_worker_internal", retryable: true };
}
