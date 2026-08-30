import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveLiveRetainedAuditPrincipal } from "@/server/audit/retained-principal";
import { HttpProblem } from "@/server/http/problem";
import { uploadConfigurationFromEnvironment } from "@/server/uploads/config";
import { acquireWorkspaceMembershipAuthorityShared } from "@/server/workspaces/membership-lock";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";
import {
  CRAWLER_ACQUISITION_MODE_V1,
  CRAWLER_RETENTION_MODE_V1,
  CRAWLER_RIGHTS_ATTESTATION_V1,
  CRAWLER_ROBOTS_MODE_V1,
  parseCrawlerAcquisitionCommandV1,
  parseCrawlerAcquisitionCommandV1ForReplay,
  type CrawlerAcquisitionCommandV1,
} from "./crawler-command";
import {
  crawlerConfigurationFromEnvironment,
  type CrawlerConfiguration,
} from "./crawler-config";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_SERIALIZABLE_ATTEMPTS = 4;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CRAWLER_COMMAND = "queueGovernedCrawlerImport:v1";
const CRAWLER_POLICY_REVISION = 1;
const CRAWLER_RIGHTS_ATTESTATION_VERSION = "paperpilot-crawler-rights-v1";
const CRAWLER_ROBOTS_POLICY_VERSION = "rfc9309-paperpilot-v1";
const CRAWLER_RETENTION_POLICY_VERSION = "paperpilot-crawler-retention-v1";
const CRAWLER_JOB_MAX_ATTEMPTS = 5;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const PUBLIC_FAILURE_CODES = new Set([
  "crawler_request_invalid",
  "crawler_url_invalid",
  "crawler_policy_denied",
  "crawler_dns_rejected",
  "crawler_robots_denied",
  "crawler_redirect_rejected",
  "crawler_bad_response",
  "crawler_response_too_large",
  "crawler_timeout",
  "crawler_cancelled",
  "crawler_unavailable",
  "content_length_mismatch",
  "invalid_pdf_envelope",
  "pdf_trailing_data",
  "upload_too_large",
  "upload_timed_out",
  "storage_unavailable",
  "storage_finalize_failed",
  "malware_detected",
  "pdf_invalid",
  "pdf_policy_violation",
  "pdf_resource_limit_exceeded",
  "malware_and_pdf_invalid",
  "extraction_unavailable",
  "extraction_failed",
  "cancelled",
  "crawler_custody_deletion_retrying",
]);

export type CrawlerRequestStatus =
  | "QUEUED"
  | "FETCHING"
  | "QUARANTINED"
  | "VALIDATING"
  | "EXTRACTING"
  | "READY"
  | "ATTENTION"
  | "FAILED"
  | "CANCELLED"
  | "DELETING"
  | "DELETED";

export interface CrawlerPolicySummary {
  acquisitionMode: typeof CRAWLER_ACQUISITION_MODE_V1;
  policyVersion: string;
  rightsAttestation: typeof CRAWLER_RIGHTS_ATTESTATION_V1;
  robotsMode: typeof CRAWLER_ROBOTS_MODE_V1;
  retentionMode: typeof CRAWLER_RETENTION_MODE_V1;
  maxResponseBytes: number;
  maxRedirects: number;
}

/** Deliberately omits source URL, URL digest, tenant, actor, storage and worker identity. */
export interface CrawlerRequestSummary {
  id: string;
  clientOperationId: string;
  displayFileName: string;
  status: CrawlerRequestStatus;
  policyVersion: string;
  maxBytes: number;
  receivedBytes: number | null;
  createdAt: string;
  updatedAt: string;
  retryAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  canDeleteCustody: boolean;
}

export interface ListCrawlerRequestsResult {
  schemaVersion: 1;
  policy: CrawlerPolicySummary;
  requests: CrawlerRequestSummary[];
}

export interface QueueCrawlerRequestResult {
  outcome: "applied" | "replayed";
  aggregateVersion: number;
  request: CrawlerRequestSummary;
}

interface CrawlerServiceConfiguration {
  crawler: Readonly<CrawlerConfiguration>;
  maxRetainedBytesPerWorkspace: number;
}

interface CrawlerServiceDependencies {
  database?: PrismaClient;
  id?: () => string;
  now?: () => Date;
  configuration?: CrawlerServiceConfiguration;
}

interface RetainedQuotaRow {
  retainedBytes: bigint;
}

interface DatabaseClockRow {
  now: Date;
}

export const CRAWLER_SUMMARY_SELECT = {
  id: true,
  clientOperationId: true,
  displayFileName: true,
  status: true,
  policyVersion: true,
  rightsAttestationVersion: true,
  maximumSizeBytes: true,
  failureCode: true,
  retryAt: true,
  completedAt: true,
  custodyStatus: true,
  deletionAfter: true,
  deletionFailureCode: true,
  deletedAt: true,
  requestedById: true,
  createdAt: true,
  updatedAt: true,
  intake: { select: { committedBytes: true } },
} as const;

type StoredCrawlerSummary = Prisma.CrawlerImportGetPayload<{
  select: typeof CRAWLER_SUMMARY_SELECT;
}>;

export interface CrawlerSummaryViewer {
  userId: string;
  role: string;
}

function callerOwnsCrawlerCustody(
  value: Pick<StoredCrawlerSummary, "requestedById">,
  viewer: CrawlerSummaryViewer,
): boolean {
  return viewer.role === "owner"
    || viewer.role === "admin"
    || (viewer.role === "member" && value.requestedById === viewer.userId);
}

/** URL- and identity-free row capability; clients must not infer requester ownership. */
export function canDeleteCrawlerCustody(
  value: Pick<StoredCrawlerSummary, "requestedById" | "custodyStatus">,
  viewer: CrawlerSummaryViewer,
): boolean {
  return value.custodyStatus === "RETAINED" && callerOwnsCrawlerCustody(value, viewer);
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
  return value;
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new HttpProblem(500, "invalid_crawler_state", `${label} is invalid.`);
  }
  return number;
}

function publicFailureCode(value: string | null): string | null {
  if (value === null) return null;
  return PUBLIC_FAILURE_CODES.has(value) ? value : "internal_error";
}

export function crawlerSummary(
  value: StoredCrawlerSummary,
  viewer: CrawlerSummaryViewer,
): CrawlerRequestSummary {
  const deleting = value.custodyStatus === "DELETE_PENDING";
  const deleted = value.custodyStatus === "DELETED";
  return {
    id: value.id,
    clientOperationId: value.clientOperationId,
    displayFileName: value.displayFileName,
    status: deleting ? "DELETING" : deleted ? "DELETED" : value.status,
    policyVersion: value.policyVersion,
    maxBytes: safeNumber(value.maximumSizeBytes, "Crawler byte ceiling"),
    receivedBytes: deleted || value.intake.committedBytes === null
      ? null
      : safeNumber(value.intake.committedBytes, "Crawler received byte count"),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    retryAt: deleting
      ? value.deletionAfter?.toISOString() ?? null
      : value.retryAt?.toISOString() ?? null,
    completedAt: deleting
      ? null
      : deleted
        ? value.deletedAt?.toISOString() ?? null
        : value.completedAt?.toISOString() ?? null,
    failureCode: deleting && value.deletionFailureCode
      ? "crawler_custody_deletion_retrying"
      : deleted
        ? null
        : publicFailureCode(value.failureCode),
    canDeleteCustody: canDeleteCrawlerCustody(value, viewer),
  };
}

function defaultConfiguration(): CrawlerServiceConfiguration {
  const upload = uploadConfigurationFromEnvironment();
  return {
    crawler: crawlerConfigurationFromEnvironment(upload),
    maxRetainedBytesPerWorkspace: upload.maxRetainedBytesPerWorkspace,
  };
}

function requireConfiguration(
  value: CrawlerServiceConfiguration,
): CrawlerServiceConfiguration {
  if (
    !value
    || typeof value !== "object"
    || !Number.isSafeInteger(value.maxRetainedBytesPerWorkspace)
    || value.maxRetainedBytesPerWorkspace < value.crawler.maxResponseBytes
  ) {
    throw new Error("Crawler service storage limits are invalid.");
  }
  return value;
}

export function crawlerPolicySummary(
  configuration = requireConfiguration(defaultConfiguration()),
): CrawlerPolicySummary {
  return {
    acquisitionMode: configuration.crawler.acquisitionMode,
    policyVersion: configuration.crawler.policyVersion,
    rightsAttestation: CRAWLER_RIGHTS_ATTESTATION_V1,
    robotsMode: CRAWLER_ROBOTS_MODE_V1,
    retentionMode: CRAWLER_RETENTION_MODE_V1,
    maxResponseBytes: configuration.crawler.maxResponseBytes,
    maxRedirects: configuration.crawler.maxRedirects,
  };
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

async function authoritativeAdmissionTime(
  transaction: Prisma.TransactionClient,
  override: Date | null,
): Promise<Date> {
  const [clock] = await transaction.$queryRaw<DatabaseClockRow[]>`
    SELECT COALESCE(CAST(${override} AS timestamptz), clock_timestamp()) AS "now"
  `;
  if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) {
    throw new Error("The database crawler admission clock is unavailable.");
  }
  return clock.now;
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

function crawlerJobPayload(crawlerImportId: string): Prisma.InputJsonObject {
  return { schemaVersion: 1, crawlerImportId };
}

function crawlerJobDedupeKey(crawlerImportId: string): string {
  return `crawler-import:${crawlerImportId}:v1`;
}

async function storedSummaryById(
  transaction: Prisma.TransactionClient,
  organizationId: string,
  crawlerImportId: string,
): Promise<StoredCrawlerSummary | null> {
  return transaction.crawlerImport.findFirst({
    where: { id: crawlerImportId, organizationId },
    select: CRAWLER_SUMMARY_SELECT,
  });
}

export async function listCrawlerRequests(
  input: {
    userId: string;
    workspaceId: string;
    limit?: number;
  },
  dependencies: CrawlerServiceDependencies = {},
): Promise<ListCrawlerRequestsResult> {
  const database = dependencies.database ?? prisma;
  const configuration = requireConfiguration(
    dependencies.configuration ?? defaultConfiguration(),
  );
  const userId = requireOpaqueId(input.userId, "userId");
  const workspaceId = requireOpaqueId(input.workspaceId, "workspaceId");
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new HttpProblem(400, "validation", "Crawler request limit is invalid.");
  }

  const membership = await database.member.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId } },
    select: { id: true, role: true },
  });
  if (!membership) {
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }
  const requests = await database.crawlerImport.findMany({
    where: { organizationId: workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: CRAWLER_SUMMARY_SELECT,
  });
  return {
    schemaVersion: 1,
    policy: crawlerPolicySummary(configuration),
    requests: requests.map((request) => crawlerSummary(request, {
      userId,
      role: membership.role,
    })),
  };
}

export async function queueCrawlerRequest(
  input: {
    userId: string;
    workspaceId: string;
    command: unknown;
    requestId?: string;
  },
  dependencies: CrawlerServiceDependencies = {},
): Promise<QueueCrawlerRequestResult> {
  const database = dependencies.database ?? prisma;
  const id = dependencies.id ?? randomUUID;
  const clockOverride = dependencies.now?.() ?? null;
  if (
    clockOverride !== null
    && (!(clockOverride instanceof Date) || !Number.isFinite(clockOverride.getTime()))
  ) {
    throw new Error("Crawler service clock override is invalid.");
  }
  const configuration = requireConfiguration(
    dependencies.configuration ?? defaultConfiguration(),
  );
  const userId = requireOpaqueId(input.userId, "userId");
  const workspaceId = requireOpaqueId(input.workspaceId, "workspaceId");
  // Decode the closed v1 shape without granting current admission so a lost
  // response remains recoverable after a policy rollout. New work is admitted
  // against the current policy only after the authenticated replay checks.
  const replayCandidate = parseCrawlerAcquisitionCommandV1ForReplay(input.command);
  const replayCommand = replayCandidate.command;

  return runSerializableTransaction(database, async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`crawler-operation:${workspaceId}:${replayCommand.clientOperationId}`}, 0)
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
          key: replayCommand.clientOperationId,
        },
      },
    });
    if (prior) {
      if (
        prior.actorUserId !== userId
        || prior.command !== CRAWLER_COMMAND
        || prior.requestHash !== replayCandidate.requestHash
      ) {
        throw new HttpProblem(
          409,
          "idempotency_conflict",
          "clientOperationId was already used for a different command.",
        );
      }
      const priorId = replayCrawlerImportId(prior.response);
      const stored = priorId
        ? await storedSummaryById(transaction, workspaceId, priorId)
        : null;
      if (!stored) {
        throw new HttpProblem(
          409,
          "operation_pending",
          "The prior crawler request is still resolving.",
        );
      }
      return {
        outcome: "replayed",
        aggregateVersion: membership.organization.revision,
        request: crawlerSummary(stored, { userId, role: membership.role }),
      };
    }

    const legacyReplay = await transaction.crawlerImport.findUnique({
      where: {
        organizationId_clientOperationId: {
          organizationId: workspaceId,
          clientOperationId: replayCommand.clientOperationId,
        },
      },
      select: {
        requestHash: true,
        ...CRAWLER_SUMMARY_SELECT,
      },
    });
    if (legacyReplay) {
      if (
        legacyReplay.requestedById !== userId
        || legacyReplay.requestHash !== replayCandidate.requestHash
      ) {
        throw new HttpProblem(
          409,
          "idempotency_conflict",
          "clientOperationId was already used for a different command.",
        );
      }
      return {
        outcome: "replayed",
        aggregateVersion: membership.organization.revision,
        request: crawlerSummary(legacyReplay, { userId, role: membership.role }),
      };
    }

    const parsed = parseCrawlerAcquisitionCommandV1(input.command, {
      policyVersion: configuration.crawler.policyVersion,
      maxResponseBytes: configuration.crawler.maxResponseBytes,
    });
    const command = parsed.command;

    if (membership.organization.revision !== command.expectedVersion) {
      throw new HttpProblem(
        409,
        "version_conflict",
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`crawler-source:${workspaceId}:${parsed.sourceUrlFingerprint}`}, 0)
      )::text
    `;
    const existingSource = await transaction.crawlerImport.findFirst({
      where: {
        organizationId: workspaceId,
        sourceUrlFingerprint: parsed.sourceUrlFingerprint,
        custodyStatus: { not: "DELETED" },
        status: { notIn: ["FAILED", "CANCELLED"] },
      },
      select: { id: true },
    });
    if (existingSource) {
      throw new HttpProblem(
        409,
        "crawler_source_already_active",
        "This PDF source is already present or being processed in the workspace.",
      );
    }

    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`upload-quota:${workspaceId}`}, 0)
      )::text
    `;
    const retainedBytes = await retainedWorkspaceIntakeBytes(transaction, workspaceId);
    if (
      retainedBytes + BigInt(command.maxBytes)
      > BigInt(configuration.maxRetainedBytesPerWorkspace)
    ) {
      throw new HttpProblem(
        413,
        "storage_quota_exceeded",
        "This workspace's private upload storage limit has been reached.",
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
    const retainedPrincipal = await resolveLiveRetainedAuditPrincipal(
      transaction,
      workspaceId,
      userId,
    );

    // The same database clock owns both the rights declaration and the row
    // chronology. This prevents ordinary application/database clock skew from
    // violating the retained attestation constraint.
    const createdAt = await authoritativeAdmissionTime(transaction, clockOverride);
    const crawlerImportId = id();
    const documentId = id();
    const assetId = id();
    const intakeId = id();
    const inboxEntryId = id();
    const importBatchId = id();
    const jobId = id();
    const sourceFingerprint = `crawler-import:${crawlerImportId}`;

    await transaction.asset.create({
      data: {
        id: assetId,
        organizationId: workspaceId,
        storageProvider: "LOCAL",
        bucket: "private-quarantine-v1",
        objectKey: `pending:crawler:${assetId}`,
        status: "UPLOADING",
        originalFileName: command.displayFileName,
        mimeType: "application/pdf",
        createdById: userId,
        metadata: {
          schemaVersion: 1,
          custody: "reserved",
          publicAccess: false,
          source: "governed-crawler",
        },
      },
    });
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId: workspaceId,
        kind: "PAPER_PDF",
        status: "PENDING",
        title: command.displayFileName,
        sourceUri: command.sourceUrl,
        sourceFingerprint,
        mimeType: "application/pdf",
        metadata: {
          schemaVersion: 1,
          custody: "governed-crawler-import",
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
    await transaction.importBatch.create({
      data: {
        id: importBatchId,
        organizationId: workspaceId,
        source: "CRAWLER",
        status: "RUNNING",
        label: "Governed crawler PDF intake",
        requestedById: userId,
        externalRequestId: crawlerImportId,
        totalCount: 1,
        startedAt: createdAt,
      },
    });
    await transaction.inboxEntry.create({
      data: {
        id: inboxEntryId,
        organizationId: workspaceId,
        importBatchId,
        documentId,
        source: "CRAWLER",
        sourceKey: `crawler-import:${crawlerImportId}`,
        dedupeKey: sourceFingerprint,
        status: "NEEDS_REVIEW",
        proposedTitle: command.displayFileName,
        sourceUri: command.sourceUrl,
        payload: {
          schemaVersion: 1,
          kind: "governed-crawler-import",
          crawlerImportId,
          importStatus: "QUEUED",
          phase: "fetch",
        },
        createdById: userId,
        createdByPrincipalId: retainedPrincipal.id,
      },
    });
    await transaction.documentIntake.create({
      data: {
        id: intakeId,
        organizationId: workspaceId,
        source: "CRAWLER",
        status: "QUEUED",
        documentId,
        assetId,
        inboxEntryId,
        importBatchId,
        createdById: userId,
        reservedBytes: BigInt(command.maxBytes),
        policyRevision: CRAWLER_POLICY_REVISION,
      },
    });
    await transaction.job.create({
      data: {
        id: jobId,
        organizationId: workspaceId,
        type: "CRAWL",
        status: "QUEUED",
        dedupeKey: crawlerJobDedupeKey(crawlerImportId),
        payload: crawlerJobPayload(crawlerImportId),
        maxAttempts: CRAWLER_JOB_MAX_ATTEMPTS,
        runAfter: createdAt,
        documentId,
        assetId,
        intakeId,
        createdById: userId,
      },
    });
    await transaction.crawlerImport.create({
      data: {
        id: crawlerImportId,
        organizationId: workspaceId,
        importBatchId,
        intakeId,
        documentId,
        assetId,
        inboxEntryId,
        requestedById: userId,
        requestedByPrincipalId: retainedPrincipal.id,
        clientOperationId: command.clientOperationId,
        requestHash: parsed.requestHash,
        canonicalSourceUrl: command.sourceUrl,
        sourceUrlFingerprint: parsed.sourceUrlFingerprint,
        displayFileName: command.displayFileName,
        rightsGrant: "INDEFINITE_RESEARCH_CUSTODY",
        rightsAttestationVersion: CRAWLER_RIGHTS_ATTESTATION_VERSION,
        rightsAttestedAt: createdAt,
        robotsPolicy: "RESPECT_RFC9309",
        robotsPolicyVersion: CRAWLER_ROBOTS_POLICY_VERSION,
        retentionPolicy: "INDEFINITE_UNTIL_USER_DELETION",
        retentionPolicyVersion: CRAWLER_RETENTION_POLICY_VERSION,
        acquisitionMode: configuration.crawler.acquisitionMode,
        policyVersion: configuration.crawler.policyVersion,
        robotsUserAgent: configuration.crawler.robotsUserAgent,
        maxRedirects: configuration.crawler.maxRedirects,
        maxDnsAddresses: configuration.crawler.maxDnsAddresses,
        dnsLookupTimeoutMs: configuration.crawler.dnsLookupTimeoutMs,
        maxResponseHeaderBytes: configuration.crawler.maxResponseHeaderBytes,
        responseHeaderTimeoutMs: configuration.crawler.responseHeaderTimeoutMs,
        responseIdleTimeoutMs: configuration.crawler.responseIdleTimeoutMs,
        absoluteDeadlineMs: configuration.crawler.absoluteDeadlineMs,
        ratePolicyVersion: configuration.crawler.ratePolicyVersion,
        originRequestsPerMinute: configuration.crawler.originRequestsPerMinute,
        originBurst: configuration.crawler.originBurst,
        maximumSizeBytes: BigInt(command.maxBytes),
        policyRevision: CRAWLER_POLICY_REVISION,
        status: "QUEUED",
        crawlJobId: jobId,
        createdAt,
        updatedAt: createdAt,
      },
    });
    await transaction.idempotencyRecord.create({
      data: {
        id: id(),
        organizationId: workspaceId,
        actorUserId: userId,
        key: command.clientOperationId,
        command: CRAWLER_COMMAND,
        requestHash: parsed.requestHash,
        status: "COMPLETED",
        response: { schemaVersion: 1, crawlerImportId },
        completedAt: createdAt,
        expiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
    await transaction.provenanceRecord.create({
      data: {
        id: id(),
        organizationId: workspaceId,
        kind: "CRAWL",
        inboxEntryId,
        documentId,
        actorUserId: userId,
        actorPrincipalId: retainedPrincipal.id,
        sourceProvider: "PaperPilot governed crawler",
        sourceRecordId: crawlerImportId,
        sourceUri: command.sourceUrl,
        retrievedAt: createdAt,
        payloadDigest: parsed.requestHash,
        payload: {
          schemaVersion: 1,
          stage: "crawler-request-queued",
          sourceUrlFingerprint: parsed.sourceUrlFingerprint,
          policyVersion: configuration.crawler.policyVersion,
          rightsGrant: CRAWLER_RIGHTS_ATTESTATION_V1,
          robotsMode: CRAWLER_ROBOTS_MODE_V1,
          retentionMode: CRAWLER_RETENTION_MODE_V1,
          maximumSizeBytes: command.maxBytes,
        },
      },
    });
    await transaction.auditEvent.create({
      data: {
        id: id(),
        organizationId: workspaceId,
        actorUserId: userId,
        actorPrincipalId: retainedPrincipal.id,
        action: "crawler.import.queued",
        entityType: "crawler-import",
        entityId: crawlerImportId,
        requestId: input.requestId ?? command.clientOperationId,
        metadata: {
          policyVersion: configuration.crawler.policyVersion,
          policyRevision: CRAWLER_POLICY_REVISION,
          maximumSizeBytes: command.maxBytes,
          rightsAttestationVersion: CRAWLER_RIGHTS_ATTESTATION_VERSION,
          robotsPolicyVersion: CRAWLER_ROBOTS_POLICY_VERSION,
          retentionPolicyVersion: CRAWLER_RETENTION_POLICY_VERSION,
        },
      },
    });

    const stored = await storedSummaryById(transaction, workspaceId, crawlerImportId);
    if (!stored) throw new Error("The queued crawler request could not be reloaded.");
    return {
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      request: crawlerSummary(stored, { userId, role: membership.role }),
    };
  });
}

/** Exported for worker/tests; URL and policy authority are always re-read from CrawlerImport. */
export const crawlerServiceAuthority = Object.freeze({
  command: CRAWLER_COMMAND,
  policyRevision: CRAWLER_POLICY_REVISION,
  rightsAttestationVersion: CRAWLER_RIGHTS_ATTESTATION_VERSION,
  robotsPolicyVersion: CRAWLER_ROBOTS_POLICY_VERSION,
  retentionPolicyVersion: CRAWLER_RETENTION_POLICY_VERSION,
});

export type { CrawlerAcquisitionCommandV1 };
