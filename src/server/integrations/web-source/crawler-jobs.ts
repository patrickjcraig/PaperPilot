import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueDocumentValidationJob } from "@/server/documents/validation-jobs";
import { LOCAL_QUARANTINE_STORAGE_VERSION } from "@/server/documents/validation-constants";
import { HttpProblem } from "@/server/http/problem";
import type { UploadConfiguration } from "@/server/uploads/config";
import {
  localQuarantineStorageKeyForAttempt,
  localQuarantineStorageAuthority,
  removeLocalQuarantineAttemptObjects,
  type LocalQuarantineUploadResult,
} from "@/server/uploads/storage";
import {
  CRAWLER_ACQUISITION_MODE_V1,
  CRAWLER_RETENTION_MODE_V1,
  CRAWLER_RIGHTS_ATTESTATION_V1,
} from "./crawler-command";
import type { CrawlerConfiguration } from "./crawler-config";
import {
  GovernedCrawlerFetchError,
  type GovernedPdfFetchPolicy,
  type GovernedPdfFetchReceipt,
} from "./governed-pdf-fetch";
import {
  CrawlerOriginRateLimitError,
  type CrawlerOriginRateAuthority,
} from "./crawler-rate-limit";

export const CRAWLER_JOB_PAYLOAD_SCHEMA_VERSION = 1 as const;
export const CRAWLER_JOB_MAX_ATTEMPTS = 5;
export const DEFAULT_CRAWLER_JOB_LEASE_TTL_MS = 10 * 60_000;
export const CRAWLER_CLEANUP_ATTENTION_THRESHOLD = 20;

const MIN_LEASE_TTL_MS = 10_000;
const MAX_LEASE_TTL_MS = 15 * 60_000;
const MAX_WORKER_ID_BYTES = 200;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_CLAIM_REAP_LOOPS = 8;
const CLEANUP_LEASE_MS = 60_000;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MD5_PATTERN = /^[0-9a-f]{32}$/;
const SUPPORTED_RIGHTS_ATTESTATION_VERSION = "paperpilot-crawler-rights-v1";
const SUPPORTED_ROBOTS_POLICY_VERSION = "rfc9309-paperpilot-v1";
const SUPPORTED_RETENTION_POLICY_VERSION = "paperpilot-crawler-retention-v1";

const SAFE_FAILURE_MESSAGES = {
  policy_changed: "The crawler execution policy changed.",
  crawler_attempt_budget_exhausted: "The crawler attempt budget was exhausted.",
  crawler_lease_expired: "The crawler worker lease expired.",
  crawler_aborted: "The crawler import was interrupted.",
  crawler_storage_unavailable: "Private quarantine storage was unavailable.",
  crawler_storage_conflict: "The crawler quarantine target was inconsistent.",
  crawler_integrity_mismatch: "The crawler bytes failed an integrity check.",
  crawler_worker_internal: "The crawler worker could not finish safely.",
  crawler_origin_rate_limited: "The crawler origin request budget is temporarily exhausted.",
  crawler_request_invalid: "The governed crawler request is invalid.",
  crawler_url_invalid: "The governed crawler URL is not eligible.",
  crawler_policy_denied: "The governed crawler policy does not permit this resource.",
  crawler_dns_rejected: "The governed crawler could not admit the source network destination.",
  crawler_robots_denied: "The governed crawler is not permitted to retrieve this resource.",
  crawler_redirect_rejected: "The governed crawler rejected the response redirect.",
  crawler_bad_response: "The governed crawler received an ineligible response.",
  crawler_response_too_large: "The governed crawler response exceeds the admitted byte limit.",
  crawler_timeout: "The governed crawler request exceeded its deadline.",
  crawler_cancelled: "The governed crawler request was cancelled.",
  crawler_unavailable: "The governed crawler could not retrieve the resource.",
} as const;

export type CrawlerJobFailureCode = keyof typeof SAFE_FAILURE_MESSAGES;

export interface CrawlerJobPayloadV1 {
  schemaVersion: typeof CRAWLER_JOB_PAYLOAD_SCHEMA_VERSION;
  crawlerImportId: string;
}

export interface CrawlerFrozenGovernance {
  acquisitionMode: typeof CRAWLER_ACQUISITION_MODE_V1;
  policyVersion: string;
  rightsGrant: typeof CRAWLER_RIGHTS_ATTESTATION_V1;
  rightsAttestationVersion: string;
  rightsAttestedAt: Date;
  robotsPolicy: "RESPECT_RFC9309";
  robotsPolicyVersion: string;
  retentionPolicy: typeof CRAWLER_RETENTION_MODE_V1;
  retentionPolicyVersion: string;
  policyRevision: number;
}

export interface CrawlerJobLease {
  organizationId: string;
  crawlerImportId: string;
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
  inboxEntryId: string;
  importBatchId: string;
  requestedById: string | null;
  requestedByPrincipalId: string;
  canonicalSourceUrl: string;
  sourceUrlFingerprint: string;
  displayFileName: string;
  maximumBytes: number;
  storageVersion: typeof LOCAL_QUARANTINE_STORAGE_VERSION;
  storageAuthorityGeneration: string;
  storageKey: string;
  governance: Readonly<CrawlerFrozenGovernance>;
  fetchPolicy: Readonly<GovernedPdfFetchPolicy>;
  rateAuthority: Readonly<CrawlerOriginRateAuthority>;
}

export interface WrittenCrawlerDownload {
  storageKey: string;
  storageAuthorityGeneration: string;
  sizeBytes: bigint;
  sha256: string;
  md5: string;
  mimeType: "application/pdf";
  storedAt: Date;
  fetchReceipt: GovernedPdfFetchReceipt;
}

export interface CrawlerJobFailure {
  code: CrawlerJobFailureCode;
  retryable: boolean;
  /** Exact server-owned retry instant, used without exponential collapsing. */
  retryAt?: Date;
}

export type FailCrawlerJobResult =
  | { outcome: "lease-lost" }
  | {
      outcome: "cleanup-required";
      ingressAttemptId: string;
      terminal: boolean;
      retryAt: Date | null;
    };

export type CrawlerJobCleanupResult =
  | { outcome: "idle" }
  | { outcome: "cleaned"; jobId: string; ingressAttemptId: string }
  | { outcome: "retrying"; jobId: string; ingressAttemptId: string }
  | { outcome: "failed" | "dead-letter"; jobId: string; ingressAttemptId: string };

interface CandidateRow { id: string }
interface DatabaseClockRow { now: Date }
type CrawlerTransaction = Prisma.TransactionClient;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function crawlerJobPayload(crawlerImportId: string): Prisma.InputJsonObject {
  return {
    schemaVersion: CRAWLER_JOB_PAYLOAD_SCHEMA_VERSION,
    crawlerImportId: requireOpaqueId(crawlerImportId, "crawlerImportId"),
  };
}

export function parseCrawlerJobPayload(value: Prisma.JsonValue | null): CrawlerJobPayloadV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.includes("schemaVersion")
    || !keys.includes("crawlerImportId")
    || value.schemaVersion !== CRAWLER_JOB_PAYLOAD_SCHEMA_VERSION
    || typeof value.crawlerImportId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.crawlerImportId)
  ) return null;
  return {
    schemaVersion: CRAWLER_JOB_PAYLOAD_SCHEMA_VERSION,
    crawlerImportId: value.crawlerImportId,
  };
}

export function crawlerJobDedupeKey(crawlerImportId: string): string {
  return `crawler-import:${requireOpaqueId(crawlerImportId, "crawlerImportId")}:v1`;
}

export function crawlerReceiptSourceFingerprint(crawlerImportId: string): string {
  return `crawler-import:${requireOpaqueId(crawlerImportId, "crawlerImportId")}`;
}

function requireClockOverride(value: Date | undefined): Date | null {
  if (value === undefined) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("A valid crawler lifecycle clock override is required.");
  }
  return value;
}

async function authoritativeNow(
  transaction: CrawlerTransaction,
  override: Date | null,
): Promise<Date> {
  const rows = await transaction.$queryRaw<DatabaseClockRow[]>`
    SELECT COALESCE(CAST(${override} AS timestamptz), clock_timestamp()) AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("The database crawler lease clock is unavailable.");
  }
  return now;
}

function requireWorkerId(value: string): string {
  const workerId = value.trim();
  if (
    !workerId
    || byteLength(workerId) > MAX_WORKER_ID_BYTES
    || !WORKER_ID_PATTERN.test(workerId)
  ) {
    throw new TypeError("A bounded crawler worker identifier is required.");
  }
  return workerId;
}

function requireLeaseTtl(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < MIN_LEASE_TTL_MS
    || value > MAX_LEASE_TTL_MS
  ) throw new TypeError("The crawler lease TTL is outside the supported range.");
  return value;
}

function safeMaximumBytes(value: bigint): number | null {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function retryDelayMs(attemptNumber: number): number {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attemptNumber - 1)));
}

function cleanupDelayMs(attemptCount: number): number {
  return Math.min(15 * 60_000, 2_000 * (2 ** Math.max(0, attemptCount - 1)));
}

function validRetryAt(value: Date | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function crawlerFailureDisposition(input: {
  failure: CrawlerJobFailure;
  attemptNumber: number;
  maximumAttempts: number;
  now: Date;
}): { terminal: boolean; retryAt: Date } {
  if (
    !(input.now instanceof Date)
    || !Number.isFinite(input.now.getTime())
    || !Number.isSafeInteger(input.attemptNumber)
    || input.attemptNumber < 1
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1
  ) throw new TypeError("The crawler failure disposition authority is invalid.");
  const terminal = !input.failure.retryable
    || input.attemptNumber >= input.maximumAttempts;
  if (terminal) return { terminal: true, retryAt: input.now };
  return {
    terminal: false,
    retryAt: validRetryAt(input.failure.retryAt)
      ? input.failure.retryAt
      : new Date(input.now.getTime() + retryDelayMs(input.attemptNumber)),
  };
}

function publicFailureCode(code: CrawlerJobFailureCode): string {
  if (code === "crawler_attempt_budget_exhausted") return "crawler_unavailable";
  if (code === "crawler_lease_expired" || code === "crawler_worker_internal") {
    return "crawler_unavailable";
  }
  if (code.startsWith("crawler_storage_")) return "storage_unavailable";
  if (code === "crawler_integrity_mismatch") return "crawler_bad_response";
  return code;
}

function exactFetchPolicy(command: {
  canonicalSourceUrl: string | null;
  rightsGrant: string;
  robotsUserAgent: string;
  maxRedirects: number;
  maxDnsAddresses: number;
  dnsLookupTimeoutMs: number;
  maximumSizeBytes: bigint;
  maxResponseHeaderBytes: number;
  responseHeaderTimeoutMs: number;
  responseIdleTimeoutMs: number;
  absoluteDeadlineMs: number;
}): GovernedPdfFetchPolicy | null {
  const maximumBytes = safeMaximumBytes(command.maximumSizeBytes);
  if (
    maximumBytes === null
    || command.rightsGrant !== CRAWLER_RIGHTS_ATTESTATION_V1
    || command.canonicalSourceUrl === null
  ) {
    return null;
  }
  let source: URL;
  try {
    source = new URL(command.canonicalSourceUrl);
  } catch {
    return null;
  }
  if (
    source.protocol !== "https:"
    || source.port !== ""
    || source.username !== ""
    || source.password !== ""
    || source.search !== ""
    || source.hash !== ""
  ) return null;
  return {
    boundaries: [{
      origin: source.origin,
      pathPrefix: source.pathname,
      pathMatch: "exact",
    }],
    rightsGrant: CRAWLER_RIGHTS_ATTESTATION_V1,
    maximumBytes,
    robotsUserAgent: command.robotsUserAgent,
    maxRedirects: command.maxRedirects,
    maxDnsAddresses: command.maxDnsAddresses,
    dnsLookupTimeoutMs: command.dnsLookupTimeoutMs,
    maxResponseHeaderBytes: command.maxResponseHeaderBytes,
    responseHeaderTimeoutMs: command.responseHeaderTimeoutMs,
    responseIdleTimeoutMs: command.responseIdleTimeoutMs,
    absoluteDeadlineMs: command.absoluteDeadlineMs,
  };
}

async function loadCrawlerAuthority(
  transaction: CrawlerTransaction,
  organizationId: string,
  crawlerImportId: string,
) {
  const crawlerImport = await transaction.crawlerImport.findFirst({
    where: { id: crawlerImportId, organizationId },
    include: {
      intake: { include: { asset: true, document: true, inboxEntry: true, importBatch: true } },
    },
  });
  if (!crawlerImport) return null;
  const originalAsset = await transaction.documentAsset.findFirst({
    where: {
      organizationId,
      documentId: crawlerImport.documentId,
      assetId: crawlerImport.assetId,
      role: "ORIGINAL",
    },
    select: { id: true },
  });
  return { crawlerImport, originalAssetExists: originalAsset !== null };
}

type LoadedCrawlerAuthority = NonNullable<Awaited<ReturnType<typeof loadCrawlerAuthority>>>;

function crawlerInboxPayloadMatches(
  value: Prisma.JsonValue | null,
  crawlerImportId: string,
  importStatus: "QUEUED" | "FETCHING",
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 5
    && keys.every((key) => [
      "schemaVersion",
      "kind",
      "crawlerImportId",
      "importStatus",
      "phase",
    ].includes(key))
    && value.schemaVersion === 1
    && value.kind === "governed-crawler-import"
    && value.crawlerImportId === crawlerImportId
    && value.importStatus === importStatus
    && value.phase === "fetch";
}

function jobAndAuthorityMatch(input: {
  job: {
    id: string;
    organizationId: string;
    type: string;
    status: string;
    dedupeKey: string | null;
    documentId: string | null;
    assetId: string | null;
    intakeId: string | null;
    createdById: string | null;
    maxAttempts: number;
    runAfter: Date;
    integrationConnectionId: string | null;
    zoteroLibraryId: string | null;
    ingestReceiptId: string | null;
    payload: Prisma.JsonValue | null;
  };
  authority: LoadedCrawlerAuthority | null;
  phase: "claim" | "fetch";
  expectedLease?: CrawlerJobLease;
}): input is typeof input & { authority: LoadedCrawlerAuthority } {
  const payload = parseCrawlerJobPayload(input.job.payload);
  const command = input.authority?.crawlerImport;
  if (
    !payload
    || !command
    || !input.authority?.originalAssetExists
    || command.custodyStatus !== "RETAINED"
    || command.canonicalSourceUrl === null
  ) return false;
  const intake = command.intake;
  const maximumBytes = safeMaximumBytes(command.maximumSizeBytes);
  const fetchPolicy = exactFetchPolicy(command);
  const firstClaim = input.phase === "claim" && command.status === "QUEUED";
  const retryOrRunning = command.status === "FETCHING";
  const lifecycleMatches = input.phase === "claim"
    ? (input.job.status === "QUEUED" && firstClaim)
      || (input.job.status === "RETRYING" && retryOrRunning)
    : input.job.status === "RUNNING" && retryOrRunning;
  const lease = input.expectedLease;
  return input.job.type === "CRAWL"
    && payload.crawlerImportId === command.id
    && input.job.dedupeKey === crawlerJobDedupeKey(command.id)
    && command.crawlJobId === input.job.id
    && command.organizationId === input.job.organizationId
    && command.documentId === input.job.documentId
    && command.assetId === input.job.assetId
    && command.intakeId === input.job.intakeId
    && command.requestedById === input.job.createdById
    && input.job.maxAttempts === CRAWLER_JOB_MAX_ATTEMPTS
    && input.job.integrationConnectionId === null
    && input.job.zoteroLibraryId === null
    && input.job.ingestReceiptId === null
    && lifecycleMatches
    && command.acquisitionMode === CRAWLER_ACQUISITION_MODE_V1
    && command.rightsGrant === CRAWLER_RIGHTS_ATTESTATION_V1
    && command.rightsAttestationVersion === SUPPORTED_RIGHTS_ATTESTATION_VERSION
    && command.robotsPolicy === "RESPECT_RFC9309"
    && command.robotsPolicyVersion === SUPPORTED_ROBOTS_POLICY_VERSION
    && command.retentionPolicy === CRAWLER_RETENTION_MODE_V1
    && command.retentionPolicyVersion === SUPPORTED_RETENTION_POLICY_VERSION
    && command.policyRevision >= 0
    && maximumBytes !== null
    && fetchPolicy !== null
    && command.failureCode === null
    && command.completedAt === null
    && command.cancelledAt === null
    && (
      input.phase === "fetch"
      || (
        firstClaim
          ? command.retryAt === null
          : command.retryAt !== null
            && command.retryAt.getTime() === input.job.runAfter.getTime()
      )
    )
    && intake.source === "CRAWLER"
    && intake.documentId === command.documentId
    && intake.assetId === command.assetId
    && intake.inboxEntryId === command.inboxEntryId
    && intake.importBatchId === command.importBatchId
    && intake.reservedBytes === command.maximumSizeBytes
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
    && intake.document.sourceUri === command.canonicalSourceUrl
    && intake.document.sourceFingerprint === crawlerReceiptSourceFingerprint(command.id)
    && intake.document.contentHash === null
    && intake.inboxEntry?.id === command.inboxEntryId
    && intake.inboxEntry.status === "NEEDS_REVIEW"
    && intake.inboxEntry.source === "CRAWLER"
    && intake.inboxEntry.documentId === command.documentId
    && intake.inboxEntry.importBatchId === command.importBatchId
    && intake.inboxEntry.sourceKey === crawlerReceiptSourceFingerprint(command.id)
    && intake.inboxEntry.dedupeKey === crawlerReceiptSourceFingerprint(command.id)
    && intake.inboxEntry.createdById === command.requestedById
    && intake.inboxEntry.createdByPrincipalId === command.requestedByPrincipalId
    && crawlerInboxPayloadMatches(
      intake.inboxEntry.payload,
      command.id,
      firstClaim ? "QUEUED" : "FETCHING",
    )
    && intake.importBatch?.id === intake.importBatchId
    && intake.importBatch.status === "RUNNING"
    && intake.importBatch.source === "CRAWLER"
    && intake.importBatch.integrationConnectionId === null
    && intake.importBatch.requestedById === command.requestedById
    && intake.importBatch.externalRequestId === command.id
    && intake.importBatch.totalCount === 1
    && intake.importBatch.processedCount === 0
    && intake.importBatch.successCount === 0
    && intake.importBatch.failureCount === 0
    && intake.importBatch.completedAt === null
    && (
      !lease
      || (
        lease.organizationId === command.organizationId
        && lease.crawlerImportId === command.id
        && lease.jobId === command.crawlJobId
        && lease.intakeId === command.intakeId
        && lease.documentId === command.documentId
        && lease.assetId === command.assetId
        && lease.inboxEntryId === command.inboxEntryId
        && lease.importBatchId === command.importBatchId
        && lease.requestedById === command.requestedById
        && lease.requestedByPrincipalId === command.requestedByPrincipalId
        && lease.canonicalSourceUrl === command.canonicalSourceUrl
        && lease.sourceUrlFingerprint === command.sourceUrlFingerprint
        && lease.displayFileName === command.displayFileName
        && lease.maximumBytes === maximumBytes
        && lease.storageAuthorityGeneration === command.storageAuthorityGeneration
        && lease.governance.acquisitionMode === command.acquisitionMode
        && lease.governance.policyVersion === command.policyVersion
        && lease.governance.policyRevision === command.policyRevision
        && lease.fetchPolicy.robotsUserAgent === command.robotsUserAgent
        && lease.fetchPolicy.maxRedirects === command.maxRedirects
        && lease.fetchPolicy.maxDnsAddresses === command.maxDnsAddresses
        && lease.fetchPolicy.dnsLookupTimeoutMs === command.dnsLookupTimeoutMs
        && lease.fetchPolicy.maxResponseHeaderBytes === command.maxResponseHeaderBytes
        && lease.fetchPolicy.responseHeaderTimeoutMs === command.responseHeaderTimeoutMs
        && lease.fetchPolicy.responseIdleTimeoutMs === command.responseIdleTimeoutMs
        && lease.fetchPolicy.absoluteDeadlineMs === command.absoluteDeadlineMs
        && lease.rateAuthority.ratePolicyVersion === command.ratePolicyVersion
        && lease.rateAuthority.originRequestsPerMinute === command.originRequestsPerMinute
        && lease.rateAuthority.originBurst === command.originBurst
      )
    );
}

export function crawlerLeaseSupportsConfiguration(
  lease: Pick<CrawlerJobLease, "governance" | "fetchPolicy" | "rateAuthority">,
  configuration: Pick<
    CrawlerConfiguration,
    "acquisitionMode" | "policyVersion" | "robotsUserAgent" | "ratePolicyVersion"
  >,
): boolean {
  return lease.governance.acquisitionMode === configuration.acquisitionMode
    && lease.governance.policyVersion === configuration.policyVersion
    && lease.governance.rightsGrant === CRAWLER_RIGHTS_ATTESTATION_V1
    && lease.governance.rightsAttestationVersion === SUPPORTED_RIGHTS_ATTESTATION_VERSION
    && lease.governance.robotsPolicy === "RESPECT_RFC9309"
    && lease.governance.robotsPolicyVersion === SUPPORTED_ROBOTS_POLICY_VERSION
    && lease.governance.retentionPolicy === CRAWLER_RETENTION_MODE_V1
    && lease.governance.retentionPolicyVersion === SUPPORTED_RETENTION_POLICY_VERSION
    && lease.fetchPolicy.robotsUserAgent === configuration.robotsUserAgent
    && lease.rateAuthority.ratePolicyVersion === configuration.ratePolicyVersion;
}

async function terminalizeWithoutBytes(
  transaction: CrawlerTransaction,
  job: {
    id: string;
    organizationId: string;
    documentId: string | null;
    assetId: string | null;
    intakeId: string | null;
    lastErrorCode?: string | null;
  },
  payloadCrawlerImportId: string | null,
  code: CrawlerJobFailureCode,
  now: Date,
  deadLetter: boolean,
  finalizeBatchWhileCharged = false,
): Promise<void> {
  const hasTarget = job.documentId !== null && job.assetId !== null && job.intakeId !== null;
  const boundImport = hasTarget
    ? await transaction.crawlerImport.findFirst({
        where: {
          organizationId: job.organizationId,
          crawlJobId: job.id,
          documentId: job.documentId!,
          assetId: job.assetId!,
          intakeId: job.intakeId!,
          custodyStatus: "RETAINED",
          status: { in: ["QUEUED", "FETCHING", "FAILED"] },
        },
        include: { intake: { select: { importBatchId: true } } },
      })
    : null;
  const unsafeAttempts = await transaction.documentIngressAttempt.count({
    where: {
      organizationId: job.organizationId,
      jobId: job.id,
      OR: [
        { status: { in: ["RECEIVING", "WRITTEN", "ADOPTED"] } },
        { status: { in: ["FAILED", "ABANDONED"] }, cleanupCompletedAt: null },
      ],
    },
  });
  const safeToRelease = unsafeAttempts === 0;
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
  if (!boundImport) {
    await transaction.auditEvent.create({
      data: {
        organizationId: job.organizationId,
        action: deadLetter ? "crawler.import.dead-lettered" : "crawler.import.failed",
        entityType: "job",
        entityId: job.id,
        metadata: {
          failureCode: code,
          exactTargetBound: false,
          payloadMatchedBoundImport: false,
          quotaReleased: false,
        },
      },
    });
    return;
  }

  const publicCode = publicFailureCode(code);
  await transaction.crawlerImport.updateMany({
    where: {
      id: boundImport.id,
      organizationId: job.organizationId,
      crawlJobId: job.id,
      status: { in: ["QUEUED", "FETCHING"] },
    },
    data: {
      status: "FAILED",
      failureCode: publicCode,
      retryAt: null,
      completedAt: now,
    },
  });
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
        status: "FAILED",
        completedAt: { not: null },
        quotaReleasedAt: null,
      },
      data: { quotaReleasedAt: now },
    });
  }
  await transaction.asset.updateMany({
    where: {
      id: boundImport.assetId,
      organizationId: job.organizationId,
      status: "UPLOADING",
    },
    data: {
      status: "REJECTED",
      rejectionCode: publicCode,
      rejectedReason: "The governed source could not be copied into private quarantine.",
    },
  });
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
      id: boundImport.inboxEntryId,
      organizationId: job.organizationId,
      documentId: boundImport.documentId,
      status: { in: ["PENDING", "NEEDS_REVIEW"] },
    },
    data: {
      status: "FAILED",
      payload: {
        schemaVersion: 1,
        kind: "governed-crawler-import",
        crawlerImportId: boundImport.id,
        importStatus: "FAILED",
        phase: "failed",
      },
      failureCode: publicCode,
      failureMessage: "The governed source could not be imported.",
      resolvedAt: now,
    },
  });
  if ((safeToRelease || finalizeBatchWhileCharged) && boundImport.intake.importBatchId) {
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
      actorUserId: boundImport.requestedById,
      actorPrincipalId: boundImport.requestedByPrincipalId,
      action: deadLetter ? "crawler.import.dead-lettered" : "crawler.import.failed",
      entityType: "crawler-import",
      entityId: boundImport.id,
      metadata: {
        failureCode: code,
        exactTargetBound: true,
        payloadMatchedBoundImport: payloadCrawlerImportId === boundImport.id,
        quotaReleased: safeToRelease,
      },
    },
  });
}

async function reapExpiredCrawlerLease(
  transaction: CrawlerTransaction,
  job: Awaited<ReturnType<CrawlerTransaction["job"]["findUniqueOrThrow"]>>,
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
        errorCode: "policy_changed",
        errorMessage: SAFE_FAILURE_MESSAGES.policy_changed,
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
        lastErrorCode: "policy_changed",
        lastErrorMessage: SAFE_FAILURE_MESSAGES.policy_changed,
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
        failureCode: "crawler_lease_expired",
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
        errorCode: "crawler_lease_expired",
        errorMessage: SAFE_FAILURE_MESSAGES.crawler_lease_expired,
      },
    });
  }
  // Even an exhausted attempt remains FETCHING/RETRYING until exact cleanup
  // completes, so the deferred lifecycle guard requires one shared deadline.
  const retryAt = now;
  await transaction.job.update({
    where: { organizationId_id: { organizationId: job.organizationId, id: job.id } },
    data: {
      status: "RETRYING",
      runAfter: now,
      lockedAt: null,
      lockedBy: null,
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorCode: "crawler_lease_expired",
      lastErrorMessage: SAFE_FAILURE_MESSAGES.crawler_lease_expired,
    },
  });
  await transaction.crawlerImport.updateMany({
    where: {
      organizationId: job.organizationId,
      crawlJobId: job.id,
      status: "FETCHING",
    },
    data: { retryAt },
  });
}

export async function claimNextCrawlerJob(input: {
  workerId: string;
  configuration: Pick<UploadConfiguration, "quarantineRoot">;
  leaseTtlMs?: number;
  now?: Date;
  database?: PrismaClient;
}): Promise<CrawlerJobLease | null> {
  const database = input.database ?? prisma;
  const workerId = requireWorkerId(input.workerId);
  const leaseTtlMs = requireLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_CRAWLER_JOB_LEASE_TTL_MS,
  );
  const clockOverride = requireClockOverride(input.now);
  const storageAuthority = await localQuarantineStorageAuthority(input.configuration);

  for (let loop = 0; loop < MAX_CLAIM_REAP_LOOPS; loop += 1) {
    const claimed = await database.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<CandidateRow[]>`
        SELECT job."id"
        FROM "Job" AS job
        WHERE job."type" = 'CRAWL'
          AND EXISTS (
            SELECT 1
            FROM "CrawlerImport" AS crawler
            WHERE crawler."organizationId" = job."organizationId"
              AND crawler."crawlJobId" = job."id"
              AND (
                crawler."storageAuthorityGeneration" = ${storageAuthority.generation}
                OR (
                  crawler."storageAuthorityGeneration" IS NULL
                  AND crawler."status" = 'QUEUED'
                )
              )
          )
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
      const now = await authoritativeNow(transaction, clockOverride);
      if (job.status === "RUNNING") {
        if (!job.leaseExpiresAt || job.leaseExpiresAt > now) return { kind: "skip" as const };
        await reapExpiredCrawlerLease(transaction, job, now);
        return { kind: "skip" as const };
      }
      const payload = parseCrawlerJobPayload(job.payload);
      if (job.attempts >= job.maxAttempts) {
        await terminalizeWithoutBytes(
          transaction,
          job,
          payload?.crawlerImportId ?? null,
          "crawler_attempt_budget_exhausted",
          now,
          true,
        );
        return { kind: "skip" as const };
      }
      const authority = payload
        ? await loadCrawlerAuthority(transaction, job.organizationId, payload.crawlerImportId)
        : null;
      if (!authority || !jobAndAuthorityMatch({ job, authority, phase: "claim" })) {
        await terminalizeWithoutBytes(
          transaction,
          job,
          payload?.crawlerImportId ?? null,
          "policy_changed",
          now,
          true,
        );
        return { kind: "skip" as const };
      }
      const command = authority.crawlerImport;
      const intake = command.intake;
      if (
        (command.status !== "QUEUED" && command.storageAuthorityGeneration === null)
        || (
          command.storageAuthorityGeneration !== null
          && command.storageAuthorityGeneration !== storageAuthority.generation
        )
      ) {
        // This worker is healthy but mounted to a different local custody
        // generation. Leave the durable command claimable by a worker on the
        // admitted root; never convert an operational placement mismatch into
        // a terminal policy failure.
        return { kind: "skip" as const };
      }
      if (command.custodyStatus !== "RETAINED" || command.canonicalSourceUrl === null) {
        await terminalizeWithoutBytes(
          transaction,
          job,
          command.id,
          "policy_changed",
          now,
          true,
        );
        return { kind: "skip" as const };
      }
      const maximumBytes = safeMaximumBytes(command.maximumSizeBytes);
      const fetchPolicy = exactFetchPolicy(command);
      if (
        maximumBytes === null
        || !fetchPolicy
        || !intake.importBatchId
        || command.importBatchId !== intake.importBatchId
      ) {
        await terminalizeWithoutBytes(
          transaction,
          job,
          command.id,
          "policy_changed",
          now,
          true,
        );
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
      if (command.status === "QUEUED") {
        await transaction.crawlerImport.update({
          where: { organizationId_id: { organizationId: job.organizationId, id: command.id } },
          data: {
            status: "FETCHING",
            storageAuthorityGeneration: storageAuthority.generation,
            startedAt: now,
            retryAt: null,
          },
        });
      } else {
        await transaction.crawlerImport.update({
          where: { organizationId_id: { organizationId: job.organizationId, id: command.id } },
          data: { retryAt: null },
        });
      }
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
          storageAuthorityGeneration: storageAuthority.generation,
          status: "RECEIVING",
          maximumSizeBytes: command.maximumSizeBytes,
          expectedSizeBytes: null,
          providerMd5: null,
          leaseId,
          leaseExpiresAt,
        },
      });
      if (intake.status === "QUEUED") {
        await transaction.documentIntake.update({
          where: { organizationId_id: { organizationId: job.organizationId, id: intake.id } },
          data: { status: "RECEIVING" },
        });
      }
      await transaction.inboxEntry.update({
        where: {
          organizationId_id: {
            organizationId: job.organizationId,
            id: command.inboxEntryId,
          },
        },
        data: {
          payload: {
            schemaVersion: 1,
            kind: "governed-crawler-import",
            crawlerImportId: command.id,
            importStatus: "FETCHING",
            phase: "fetch",
          },
        },
      });
      return {
        kind: "claimed" as const,
        value: {
          organizationId: job.organizationId,
          crawlerImportId: command.id,
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
          inboxEntryId: command.inboxEntryId,
          importBatchId: command.importBatchId,
          requestedById: command.requestedById,
          requestedByPrincipalId: command.requestedByPrincipalId,
          canonicalSourceUrl: command.canonicalSourceUrl,
          sourceUrlFingerprint: command.sourceUrlFingerprint,
          displayFileName: command.displayFileName,
          maximumBytes,
          storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
          storageAuthorityGeneration: storageAuthority.generation,
          storageKey,
          governance: Object.freeze({
            acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
            policyVersion: command.policyVersion,
            rightsGrant: CRAWLER_RIGHTS_ATTESTATION_V1,
            rightsAttestationVersion: command.rightsAttestationVersion,
            rightsAttestedAt: command.rightsAttestedAt,
            robotsPolicy: "RESPECT_RFC9309",
            robotsPolicyVersion: command.robotsPolicyVersion,
            retentionPolicy: CRAWLER_RETENTION_MODE_V1,
            retentionPolicyVersion: command.retentionPolicyVersion,
            policyRevision: command.policyRevision,
          }),
          fetchPolicy: Object.freeze(fetchPolicy),
          rateAuthority: Object.freeze({
            ratePolicyVersion: command.ratePolicyVersion,
            originRequestsPerMinute: command.originRequestsPerMinute,
            originBurst: command.originBurst,
          }),
        } satisfies CrawlerJobLease,
      };
    });
    if (claimed.kind === "claimed") return claimed.value;
    if (claimed.kind === "empty") return null;
  }
  return null;
}

async function loadAndCheckCrawlerLease(
  transaction: CrawlerTransaction,
  lease: CrawlerJobLease,
) {
  const job = await transaction.job.findUnique({
    where: { organizationId_id: { organizationId: lease.organizationId, id: lease.jobId } },
  });
  if (!job) return null;
  const authority = await loadCrawlerAuthority(
    transaction,
    lease.organizationId,
    lease.crawlerImportId,
  );
  if (!authority || !jobAndAuthorityMatch({
    job,
    authority,
    phase: "fetch",
    expectedLease: lease,
  })) return null;
  return { job, authority };
}

function activeLeaseMatches(
  job: {
    status: string;
    lockedBy: string | null;
    leaseId: string | null;
    leaseExpiresAt: Date | null;
    attempts: number;
  },
  lease: CrawlerJobLease,
  now: Date,
): boolean {
  return job.status === "RUNNING"
    && job.lockedBy === lease.workerId
    && job.leaseId === lease.leaseId
    && job.leaseExpiresAt !== null
    && job.leaseExpiresAt > now
    && job.attempts === lease.attemptNumber;
}

export async function heartbeatCrawlerJob(input: {
  lease: CrawlerJobLease;
  leaseTtlMs?: number;
  now?: Date;
  database?: PrismaClient;
}): Promise<boolean> {
  const database = input.database ?? prisma;
  const clockOverride = requireClockOverride(input.now);
  const leaseTtlMs = requireLeaseTtl(
    input.leaseTtlMs ?? DEFAULT_CRAWLER_JOB_LEASE_TTL_MS,
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
    const now = await authoritativeNow(transaction, clockOverride);
    const current = await loadAndCheckCrawlerLease(transaction, input.lease);
    if (!current || !activeLeaseMatches(current.job, input.lease, now)) return false;
    const ingress = await transaction.documentIngressAttempt.findFirst({
      where: {
        id: input.lease.ingressAttemptId,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        jobAttemptId: input.lease.jobAttemptId,
        leaseId: input.lease.leaseId,
        storageKey: input.lease.storageKey,
        storageAuthorityGeneration: input.lease.storageAuthorityGeneration,
        status: { in: ["RECEIVING", "WRITTEN"] },
      },
      select: { id: true },
    });
    const jobAttempt = await transaction.jobAttempt.findFirst({
      where: {
        id: input.lease.jobAttemptId,
        organizationId: input.lease.organizationId,
        jobId: input.lease.jobId,
        attemptNumber: input.lease.attemptNumber,
        workerId: input.lease.workerId,
        leaseId: input.lease.leaseId,
        status: "RUNNING",
      },
      select: { id: true },
    });
    if (!ingress || !jobAttempt) return false;
    const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
    await transaction.job.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
      data: { leaseExpiresAt },
    });
    await transaction.documentIngressAttempt.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
      data: { leaseExpiresAt },
    });
    return true;
  });
}

function canonicalUrlSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertWrittenCrawlerDownload(
  lease: CrawlerJobLease,
  written: WrittenCrawlerDownload,
): void {
  const receipt = written.fetchReceipt;
  if (
    written.storageKey !== lease.storageKey
    || written.storageAuthorityGeneration !== lease.storageAuthorityGeneration
    || written.sizeBytes < 1n
    || written.sizeBytes > BigInt(lease.maximumBytes)
    || !SHA256_PATTERN.test(written.sha256)
    || !MD5_PATTERN.test(written.md5)
    || written.mimeType !== "application/pdf"
    || !(written.storedAt instanceof Date)
    || !Number.isFinite(written.storedAt.getTime())
    || !receipt
    || receipt.schemaVersion !== 1
    || receipt.contentType !== "application/pdf"
    || receipt.contentEncoding !== "identity"
    || !Number.isSafeInteger(receipt.contentLength)
    || receipt.contentLength < 1
    || BigInt(receipt.contentLength) !== written.sizeBytes
    || receipt.requestedUrlSha256 !== canonicalUrlSha256(lease.canonicalSourceUrl)
    || receipt.finalUrlSha256 !== receipt.requestedUrlSha256
    || !SHA256_PATTERN.test(receipt.redirectChainSha256)
    || !Number.isSafeInteger(receipt.redirectCount)
    || receipt.redirectCount < 0
    || receipt.redirectCount > lease.fetchPolicy.maxRedirects
    || !Number.isSafeInteger(receipt.robotsCheckCount)
    || receipt.robotsCheckCount < 1
    || !Number.isSafeInteger(receipt.pinnedConnectionCount)
    || receipt.pinnedConnectionCount < 2
    || receipt.userAgent !== `${lease.fetchPolicy.robotsUserAgent}/1.0`
    || !Number.isFinite(new Date(receipt.retrievedAt).getTime())
  ) throw new TypeError("The crawler quarantine result does not match its frozen lease.");
}

export async function markCrawlerIngressWritten(input: {
  lease: CrawlerJobLease;
  written: WrittenCrawlerDownload;
  now?: Date;
  database?: PrismaClient;
}): Promise<boolean> {
  assertWrittenCrawlerDownload(input.lease, input.written);
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
    const now = await authoritativeNow(transaction, clockOverride);
    const current = await loadAndCheckCrawlerLease(transaction, input.lease);
    if (!current || !activeLeaseMatches(current.job, input.lease, now)) return false;
    const attempt = await transaction.documentIngressAttempt.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.ingressAttemptId,
        },
      },
    });
    if (
      !attempt
      || attempt.jobId !== input.lease.jobId
      || attempt.jobAttemptId !== input.lease.jobAttemptId
      || attempt.leaseId !== input.lease.leaseId
      || attempt.storageKey !== input.written.storageKey
      || attempt.storageVersion !== input.lease.storageVersion
      || attempt.storageAuthorityGeneration !== input.lease.storageAuthorityGeneration
    ) return false;
    if (attempt.status === "WRITTEN" || attempt.status === "ADOPTED") {
      return attempt.receivedSizeBytes === input.written.sizeBytes
        && attempt.computedMd5 === input.written.md5
        && attempt.sha256 === input.written.sha256
        && attempt.storedAt?.getTime() === input.written.storedAt.getTime();
    }
    if (attempt.status !== "RECEIVING") return false;
    await transaction.documentIngressAttempt.update({
      where: {
        organizationId_id: {
          organizationId: input.lease.organizationId,
          id: input.lease.ingressAttemptId,
        },
      },
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

function crawlerCompletionResult(written: WrittenCrawlerDownload, receiptId: string) {
  return {
    schemaVersion: 1,
    ingestReceiptId: receiptId,
    sha256: written.sha256,
    sizeBytes: written.sizeBytes.toString(),
    storageVersion: LOCAL_QUARANTINE_STORAGE_VERSION,
    storageAuthorityGeneration: written.storageAuthorityGeneration,
  };
}

function fetchReceiptJson(receipt: GovernedPdfFetchReceipt): Prisma.InputJsonObject {
  return {
    schemaVersion: receipt.schemaVersion,
    requestedUrlSha256: receipt.requestedUrlSha256,
    finalUrlSha256: receipt.finalUrlSha256,
    redirectChainSha256: receipt.redirectChainSha256,
    redirectCount: receipt.redirectCount,
    robotsCheckCount: receipt.robotsCheckCount,
    pinnedConnectionCount: receipt.pinnedConnectionCount,
    retrievedAt: receipt.retrievedAt,
    contentType: receipt.contentType,
    contentEncoding: receipt.contentEncoding,
    contentLength: receipt.contentLength,
    userAgent: receipt.userAgent,
  };
}

export async function completeCrawlerJob(input: {
  lease: CrawlerJobLease;
  written: WrittenCrawlerDownload;
  now?: Date;
  database?: PrismaClient;
}): Promise<"applied" | "replayed" | "lease-lost"> {
  assertWrittenCrawlerDownload(input.lease, input.written);
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
    const now = await authoritativeNow(transaction, clockOverride);
    const job = await transaction.job.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
    });
    const existingReceipt = await transaction.documentIngestReceipt.findFirst({
      where: {
        organizationId: input.lease.organizationId,
        crawlerImportId: input.lease.crawlerImportId,
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
        && existingReceipt.storageAuthorityGeneration === input.lease.storageAuthorityGeneration
        && existingAttempt.storageAuthorityGeneration === input.lease.storageAuthorityGeneration
        && existingReceipt.storedAt.getTime() === input.written.storedAt.getTime()
        ? "replayed" as const
        : "lease-lost" as const;
    }
    const current = await loadAndCheckCrawlerLease(transaction, input.lease);
    if (!current || !activeLeaseMatches(job, input.lease, now)) return "lease-lost" as const;
    const command = current.authority.crawlerImport;
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
      || attempt.storageAuthorityGeneration !== input.lease.storageAuthorityGeneration
      || attempt.receivedSizeBytes !== input.written.sizeBytes
      || attempt.computedMd5 !== input.written.md5
      || attempt.providerMd5 !== null
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
        originalFileName: input.lease.displayFileName,
        mimeType: input.written.mimeType,
        sizeBytes: input.written.sizeBytes,
        sha256: input.written.sha256,
        etag: null,
        rejectionCode: null,
        rejectedReason: null,
        metadata: {
          schemaVersion: 1,
          custody: "private-quarantine",
          source: "governed-crawler",
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
          source: "governed-crawler",
        },
      },
    });
    await transaction.documentIntake.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.intakeId } },
      data: { status: "QUARANTINED", committedBytes: input.written.sizeBytes },
    });
    await transaction.crawlerImport.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.crawlerImportId } },
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
        source: "CRAWLER",
        // Receipt uniqueness identifies this explicit import, never the remote
        // URL. Canonical URL authority remains only on the frozen command row.
        sourceFingerprint: crawlerReceiptSourceFingerprint(input.lease.crawlerImportId),
        intakeId: input.lease.intakeId,
        assetId: input.lease.assetId,
        documentId: input.lease.documentId,
        inboxEntryId: input.lease.inboxEntryId,
        importBatchId: command.importBatchId,
        ingressAttemptId: input.lease.ingressAttemptId,
        crawlerImportId: input.lease.crawlerImportId,
        requestedById: input.lease.requestedById,
        sourceVersion: input.lease.governance.policyVersion,
        declaredMimeType: input.written.mimeType,
        receivedSizeBytes: input.written.sizeBytes,
        sha256: input.written.sha256,
        storageVersion: input.lease.storageVersion,
        storageAuthorityGeneration: input.lease.storageAuthorityGeneration,
        storedAt: input.written.storedAt,
        metadata: {
          schemaVersion: 1,
          transport: "governed-pinned-https",
          publicAccess: false,
          policyVersion: input.lease.governance.policyVersion,
          ratePolicyVersion: input.lease.rateAuthority.ratePolicyVersion,
          fetchReceipt: fetchReceiptJson(input.written.fetchReceipt),
        },
      },
    });
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
          kind: "governed-crawler-import",
          crawlerImportId: input.lease.crawlerImportId,
          importStatus: "QUARANTINED",
          phase: "validation",
        },
        failureCode: null,
        failureMessage: null,
      },
    });
    await transaction.importBatch.updateMany({
      where: {
        id: input.lease.importBatchId,
        organizationId: input.lease.organizationId,
        status: "RUNNING",
      },
      data: { status: "RUNNING" },
    });
    await enqueueDocumentValidationJob(transaction, {
      organizationId: input.lease.organizationId,
      documentId: input.lease.documentId,
      assetId: input.lease.assetId,
      ingestReceiptId: receipt.id,
      createdById: command.requestedById,
      storageVersion: input.lease.storageVersion,
      now,
    });
    const result = crawlerCompletionResult(input.written, receipt.id);
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
        actorPrincipalId: command.requestedByPrincipalId,
        action: "crawler.import.quarantined",
        entityType: "crawler-import",
        entityId: command.id,
        metadata: {
          jobId: input.lease.jobId,
          ingestReceiptId: receipt.id,
          sizeBytes: input.written.sizeBytes.toString(),
          policyVersion: input.lease.governance.policyVersion,
        },
      },
    });
    return "applied" as const;
  }, { isolationLevel: "Serializable" });
}

export async function failCrawlerJob(input: {
  lease: CrawlerJobLease;
  failure: CrawlerJobFailure;
  now?: Date;
  database?: PrismaClient;
}): Promise<FailCrawlerJobResult> {
  const database = input.database ?? prisma;
  const clockOverride = requireClockOverride(input.now);
  if (!(input.failure.code in SAFE_FAILURE_MESSAGES)) {
    throw new TypeError("The crawler failure code is not supported.");
  }
  return database.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "Job"
      WHERE "id" = ${input.lease.jobId}
        AND "organizationId" = ${input.lease.organizationId}
      FOR UPDATE
    `;
    if (!locked[0]) return { outcome: "lease-lost" as const };
    const now = await authoritativeNow(transaction, clockOverride);
    const job = await transaction.job.findUniqueOrThrow({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
    });
    const payload = parseCrawlerJobPayload(job.payload);
    if (
      !activeLeaseMatches(job, input.lease, now)
      || job.type !== "CRAWL"
      || job.dedupeKey !== crawlerJobDedupeKey(input.lease.crawlerImportId)
      || payload?.crawlerImportId !== input.lease.crawlerImportId
      || job.documentId !== input.lease.documentId
      || job.assetId !== input.lease.assetId
      || job.intakeId !== input.lease.intakeId
    ) return { outcome: "lease-lost" as const };
    const attempt = await transaction.documentIngressAttempt.findUnique({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
    });
    const jobAttempt = await transaction.jobAttempt.findUnique({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobAttemptId } },
    });
    if (
      !attempt
      || attempt.jobId !== input.lease.jobId
      || attempt.jobAttemptId !== input.lease.jobAttemptId
      || attempt.leaseId !== input.lease.leaseId
      || attempt.storageKey !== input.lease.storageKey
      || !["RECEIVING", "WRITTEN"].includes(attempt.status)
      || !jobAttempt
      || jobAttempt.jobId !== input.lease.jobId
      || jobAttempt.attemptNumber !== input.lease.attemptNumber
      || jobAttempt.status !== "RUNNING"
      || jobAttempt.workerId !== input.lease.workerId
      || jobAttempt.leaseId !== input.lease.leaseId
    ) return { outcome: "lease-lost" as const };

    const authority = await loadCrawlerAuthority(
      transaction,
      input.lease.organizationId,
      input.lease.crawlerImportId,
    );
    const authorityCurrent = jobAndAuthorityMatch({
      job,
      authority,
      phase: "fetch",
      expectedLease: input.lease,
    });
    const failure: CrawlerJobFailure = authorityCurrent
      ? input.failure
      : { code: "policy_changed", retryable: false };
    const disposition = crawlerFailureDisposition({
      failure,
      attemptNumber: job.attempts,
      maximumAttempts: job.maxAttempts,
      now,
    });
    const { terminal, retryAt } = disposition;

    await transaction.documentIngressAttempt.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.ingressAttemptId } },
      data: {
        status: "FAILED",
        completedAt: now,
        failureCode: failure.code,
        cleanupAfter: now,
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
        status: terminal ? "DEAD_LETTER" : "FAILED",
        completedAt: now,
        errorCode: failure.code,
        errorMessage: SAFE_FAILURE_MESSAGES[failure.code],
      },
    });
    await transaction.job.update({
      where: { organizationId_id: { organizationId: input.lease.organizationId, id: input.lease.jobId } },
      data: {
        // Cleanup must prove the attempt object absent before retry or terminal
        // quota release. A terminal failure is finalized by reconciliation.
        status: "RETRYING",
        runAfter: retryAt,
        lockedAt: null,
        lockedBy: null,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: failure.code,
        lastErrorMessage: SAFE_FAILURE_MESSAGES[failure.code],
      },
    });
    await transaction.crawlerImport.updateMany({
      where: {
        id: input.lease.crawlerImportId,
        organizationId: input.lease.organizationId,
        status: "FETCHING",
      },
      data: { retryAt },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.lease.organizationId,
        actorUserId: authority?.crawlerImport.requestedById ?? null,
        actorPrincipalId: authority?.crawlerImport.requestedByPrincipalId,
        action: terminal
          ? "crawler.import.cleanup-pending-failure"
          : "crawler.import.retrying",
        entityType: "job",
        entityId: input.lease.jobId,
        metadata: {
          failureCode: failure.code,
          retryScheduled: !terminal,
          exactRetryAuthority: validRetryAt(failure.retryAt),
          authorityCurrent,
        },
      },
    });
    return {
      outcome: "cleanup-required" as const,
      ingressAttemptId: input.lease.ingressAttemptId,
      terminal,
      retryAt,
    };
  });
}

async function finishCrawlerCleanup(input: {
  database: PrismaClient;
  ingressAttemptId: string;
  expectedCleanupAttemptCount: number;
  cleanupSucceeded: boolean;
  clockOverride: Date | null;
}): Promise<CrawlerJobCleanupResult> {
  return input.database.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<CandidateRow[]>`
      SELECT "id"
      FROM "DocumentIngressAttempt"
      WHERE "id" = ${input.ingressAttemptId}
      FOR UPDATE
    `;
    if (!locked[0]) return { outcome: "idle" as const };
    const now = await authoritativeNow(transaction, input.clockOverride);
    const ingress = await transaction.documentIngressAttempt.findUniqueOrThrow({
      where: { id: input.ingressAttemptId },
      include: { jobAttempt: true, job: true },
    });
    if (
      ingress.job.type !== "CRAWL"
      || ingress.status === "ADOPTED"
      || ingress.cleanupCompletedAt !== null
      || !["FAILED", "ABANDONED"].includes(ingress.status)
      || ingress.cleanupAttemptCount !== input.expectedCleanupAttemptCount
    ) return { outcome: "idle" as const };
    if (!input.cleanupSucceeded) {
      const terminalize = ingress.cleanupAttemptCount >= CRAWLER_CLEANUP_ATTENTION_THRESHOLD
        && ingress.job.status !== "DEAD_LETTER";
      const next = new Date(now.getTime() + cleanupDelayMs(ingress.cleanupAttemptCount));
      await transaction.documentIngressAttempt.update({
        where: { id: ingress.id },
        data: {
          cleanupAfter: next,
          cleanupFailureCode: terminalize
            ? "cleanup_attention_required"
            : "cleanup_storage_unavailable",
        },
      });
      if (terminalize) {
        await transaction.jobAttempt.updateMany({
          where: {
            id: ingress.jobAttemptId,
            organizationId: ingress.organizationId,
            jobId: ingress.jobId,
            status: "FAILED",
          },
          data: { status: "DEAD_LETTER" },
        });
        const payload = parseCrawlerJobPayload(ingress.job.payload);
        const failureCode = ingress.job.lastErrorCode
          && ingress.job.lastErrorCode in SAFE_FAILURE_MESSAGES
          ? ingress.job.lastErrorCode as CrawlerJobFailureCode
          : "crawler_storage_unavailable";
        await terminalizeWithoutBytes(
          transaction,
          ingress.job,
          payload?.crawlerImportId ?? null,
          failureCode,
          now,
          true,
          true,
        );
      } else {
        await transaction.job.updateMany({
          where: {
            id: ingress.jobId,
            organizationId: ingress.organizationId,
            status: "RETRYING",
          },
          data: { runAfter: next },
        });
        await transaction.crawlerImport.updateMany({
          where: {
            organizationId: ingress.organizationId,
            crawlJobId: ingress.jobId,
            status: "FETCHING",
          },
          data: { retryAt: next },
        });
      }
      return {
        outcome: terminalize ? "dead-letter" as const : "retrying" as const,
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
    const unsafeAttempts = await transaction.documentIngressAttempt.count({
      where: {
        organizationId: ingress.organizationId,
        jobId: ingress.jobId,
        OR: [
          { status: { in: ["RECEIVING", "WRITTEN", "ADOPTED"] } },
          { status: { in: ["FAILED", "ABANDONED"] }, cleanupCompletedAt: null },
        ],
      },
    });
    if (terminalAttempt && unsafeAttempts === 0) {
      const payload = parseCrawlerJobPayload(ingress.job.payload);
      const code = ingress.job.lastErrorCode
        && ingress.job.lastErrorCode in SAFE_FAILURE_MESSAGES
        ? ingress.job.lastErrorCode as CrawlerJobFailureCode
        : "crawler_worker_internal";
      const deadLetter = ingress.job.status === "DEAD_LETTER"
        || ingress.job.attempts >= ingress.job.maxAttempts
        || terminalAttempt.status === "DEAD_LETTER";
      await terminalizeWithoutBytes(
        transaction,
        ingress.job,
        payload?.crawlerImportId ?? null,
        code,
        now,
        deadLetter,
      );
      return {
        outcome: deadLetter ? "dead-letter" as const : "failed" as const,
        jobId: ingress.jobId,
        ingressAttemptId: ingress.id,
      };
    }
    return {
      outcome: "cleaned" as const,
      jobId: ingress.jobId,
      ingressAttemptId: ingress.id,
    };
  });
}

export async function reconcileCrawlerJobCleanup(input: {
  configuration: Pick<UploadConfiguration, "quarantineRoot">;
  ingressAttemptId?: string;
  now?: Date;
  database?: PrismaClient;
}): Promise<CrawlerJobCleanupResult> {
  const database = input.database ?? prisma;
  const clockOverride = requireClockOverride(input.now);
  const candidate = await database.$transaction(async (transaction) => {
    const rows = input.ingressAttemptId
      ? await transaction.$queryRaw<CandidateRow[]>`
          SELECT ingress."id"
          FROM "DocumentIngressAttempt" AS ingress
          JOIN "Job" AS job
            ON job."organizationId" = ingress."organizationId"
           AND job."id" = ingress."jobId"
          WHERE ingress."id" = ${input.ingressAttemptId}
            AND job."type" = 'CRAWL'
            AND ingress."status" IN ('FAILED', 'ABANDONED')
            AND ingress."cleanupCompletedAt" IS NULL
            AND (
              ingress."cleanupAfter" IS NULL
              OR ingress."cleanupAfter" <= COALESCE(
                CAST(${clockOverride} AS timestamptz),
                clock_timestamp()
              )
            )
          FOR UPDATE OF ingress SKIP LOCKED
          LIMIT 1
        `
      : await transaction.$queryRaw<CandidateRow[]>`
          SELECT ingress."id"
          FROM "DocumentIngressAttempt" AS ingress
          JOIN "Job" AS job
            ON job."organizationId" = ingress."organizationId"
           AND job."id" = ingress."jobId"
          WHERE job."type" = 'CRAWL'
            AND ingress."status" IN ('FAILED', 'ABANDONED')
            AND ingress."cleanupCompletedAt" IS NULL
            AND (
              ingress."cleanupAfter" IS NULL
              OR ingress."cleanupAfter" <= COALESCE(
                CAST(${clockOverride} AS timestamptz),
                clock_timestamp()
              )
            )
          ORDER BY ingress."cleanupAfter" NULLS FIRST, ingress."createdAt", ingress."id"
          FOR UPDATE OF ingress SKIP LOCKED
          LIMIT 1
        `;
    const row = rows[0];
    if (!row) return null;
    const now = await authoritativeNow(transaction, clockOverride);
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
      storageVersion: attempt.storageVersion,
      storageAuthorityGeneration: attempt.storageAuthorityGeneration,
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
    if (
      candidate.storageKey !== expectedStorageKey
      || candidate.storageVersion !== LOCAL_QUARANTINE_STORAGE_VERSION
      || candidate.storageAuthorityGeneration === null
    ) {
      throw new Error("The ingress storage key does not match its immutable attempt.");
    }
    await removeLocalQuarantineAttemptObjects(
      input.configuration,
      { organizationId: candidate.organizationId, assetId: candidate.assetId },
      candidate.id,
      candidate.storageAuthorityGeneration,
    );
    cleanupSucceeded = true;
  } catch {
    cleanupSucceeded = false;
  }
  return finishCrawlerCleanup({
    database,
    ingressAttemptId: candidate.id,
    expectedCleanupAttemptCount: candidate.cleanupAttemptCount,
    cleanupSucceeded,
    clockOverride,
  });
}

export async function cleanupCrawlerJobAttempt(input: {
  configuration: Pick<UploadConfiguration, "quarantineRoot">;
  ingressAttemptId: string;
  now?: Date;
  database?: PrismaClient;
}): Promise<CrawlerJobCleanupResult> {
  return reconcileCrawlerJobCleanup(input);
}

export function writtenCrawlerDownloadFromStorage(
  result: LocalQuarantineUploadResult,
  storedAt: Date,
  fetchReceipt: GovernedPdfFetchReceipt,
): WrittenCrawlerDownload {
  return {
    storageKey: result.storageKey,
    storageAuthorityGeneration: result.storageAuthorityGeneration,
    sizeBytes: result.sizeBytes,
    sha256: result.sha256,
    md5: result.md5,
    mimeType: result.mimeType,
    storedAt,
    fetchReceipt,
  };
}

export function crawlerJobFailureFromUnknown(
  caught: unknown,
): CrawlerJobFailure {
  if (caught instanceof CrawlerOriginRateLimitError) {
    return {
      code: "crawler_origin_rate_limited",
      retryable: true,
      retryAt: caught.retryAt,
    };
  }
  if (caught instanceof GovernedCrawlerFetchError) {
    return { code: caught.code, retryable: caught.retryable };
  }
  if (caught instanceof HttpProblem) {
    switch (caught.code) {
      case "upload_too_large":
        return { code: "crawler_response_too_large", retryable: false };
      case "content_length_mismatch":
      case "content_md5_mismatch":
      case "invalid_pdf_header":
      case "invalid_pdf_trailer":
        return { code: "crawler_integrity_mismatch", retryable: false };
      case "upload_timed_out":
        return { code: "crawler_timeout", retryable: true };
      case "upload_aborted":
        return { code: "crawler_aborted", retryable: true };
      case "upload_already_stored":
      case "storage_key_mismatch":
      case "storage_authority_mismatch":
      case "quarantine_custody_deleted":
        return { code: "crawler_storage_conflict", retryable: false };
      case "storage_unavailable":
      case "storage_finalize_failed":
        return { code: "crawler_storage_unavailable", retryable: true };
    }
  }
  return { code: "crawler_worker_internal", retryable: true };
}
