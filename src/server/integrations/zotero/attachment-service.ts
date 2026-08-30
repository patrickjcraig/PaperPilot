import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { uploadConfigurationFromEnvironment } from "@/server/uploads/config";
import { acquireWorkspaceMembershipAuthorityShared } from "@/server/workspaces/membership-lock";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";
import { requireWorkspaceIntegrationRole } from "./oauth-service";
import {
  zoteroAttachmentDownloadJobDedupeKey,
  zoteroAttachmentDownloadJobPayload,
} from "./attachment-import-contract";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const SOURCE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MD5_PATTERN = /^[a-f0-9]{32}$/;
const POLICY_MODES = new Set(["DISABLED", "MANUAL"] as const);
const ELIGIBILITIES = new Set(["DOWNLOADABLE", "INELIGIBLE", "MALFORMED"] as const);
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const MAX_SERIALIZABLE_ATTEMPTS = 4;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const IMPORT_COMMAND = "importZoteroAttachment:v1";

const PUBLIC_FAILURE_CODES = new Set([
  "attachment_too_large",
  "attachment_integrity_failed",
  "zotero_attachment_unavailable",
  "attachment_download_failed",
  "source_changed",
  "credentials_changed",
  "policy_changed",
  "file_access_unavailable",
  "checksum_mismatch",
  "upload_too_large",
  "provider_unavailable",
  "download_failed",
  "cancelled",
]);

export type ZoteroAttachmentPolicyMode = "DISABLED" | "MANUAL";
export type ZoteroAttachmentEligibilityValue =
  | "DOWNLOADABLE"
  | "INELIGIBLE"
  | "MALFORMED";

export interface ZoteroAttachmentPolicySummary {
  mode: ZoteroAttachmentPolicyMode;
  revision: number;
  configuredAt: string | null;
}

export interface UpdateZoteroAttachmentPolicyCommand {
  mode: ZoteroAttachmentPolicyMode;
  expectedRevision: number;
}

export interface UpdateZoteroAttachmentPolicyResult
  extends ZoteroAttachmentPolicySummary {
  outcome: "applied" | "unchanged";
}

export interface ZoteroAttachmentImportSummary {
  id: string;
  status:
    | "QUEUED"
    | "DOWNLOADING"
    | "QUARANTINED"
    | "VALIDATING"
    | "EXTRACTING"
    | "READY"
    | "ATTENTION"
    | "FAILED"
    | "CANCELLED";
  documentId: string;
  assetId: string;
  intakeId: string;
  inboxEntryId: string | null;
  downloadJobId: string | null;
  sourceVersion: string;
  providerMd5: string;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ZoteroAttachmentSummary {
  id: string;
  libraryId: string;
  parentKey: string | null;
  linkMode: string | null;
  contentType: string | null;
  fileName: string | null;
  providerMd5: string | null;
  providerMtime: string | null;
  sourceVersion: string;
  metadataHash: string;
  eligibility: ZoteroAttachmentEligibilityValue;
  reasonCode: string | null;
  isDeleted: boolean;
  updatedAt: string;
  latestImport: ZoteroAttachmentImportSummary | null;
}

export interface ListZoteroAttachmentsQuery {
  after: string | null;
  limit: number;
  libraryId: string | null;
  eligibility: ZoteroAttachmentEligibilityValue | null;
  includeDeleted: boolean;
}

export interface ListZoteroAttachmentsResult {
  attachments: ZoteroAttachmentSummary[];
  nextCursor: string | null;
}

export interface QueueZoteroAttachmentImportCommand {
  clientOperationId: string;
  expectedPolicyRevision: number;
  sourceVersion: string;
  metadataHash: string;
  providerMd5: string;
}

export interface QueueZoteroAttachmentImportResult {
  outcome: "applied" | "replayed" | "coalesced";
  import: ZoteroAttachmentImportSummary;
}

interface AttachmentLimits {
  maxPdfBytes: number;
  maxRetainedBytes: number;
}

interface AttachmentServiceDependencies {
  database?: PrismaClient;
  id?: () => string;
  now?: () => Date;
  limits?: AttachmentLimits;
}

interface RetainedQuotaRow {
  retainedBytes: bigint;
}

const IMPORT_SUMMARY_SELECT = {
  id: true,
  status: true,
  documentId: true,
  assetId: true,
  intakeId: true,
  downloadJobId: true,
  sourceVersion: true,
  providerMd5: true,
  failureCode: true,
  createdAt: true,
  completedAt: true,
  intake: { select: { inboxEntryId: true } },
} as const;

type StoredImportSummary = Prisma.ZoteroAttachmentImportGetPayload<{
  select: typeof IMPORT_SUMMARY_SELECT;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    validation(`${label} contains unsupported or missing fields.`);
  }
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    validation(`${label} is invalid.`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > 2_147_483_647
  ) {
    validation(`${label} must be a non-negative integer.`);
  }
  return value;
}

export function parseZoteroAttachmentPolicyCommand(
  value: unknown,
): UpdateZoteroAttachmentPolicyCommand {
  if (!isRecord(value)) validation("A JSON object is required.");
  requireExactKeys(value, ["mode", "expectedRevision"], "Attachment policy command");
  if (typeof value.mode !== "string" || !POLICY_MODES.has(value.mode as ZoteroAttachmentPolicyMode)) {
    validation("mode must be DISABLED or MANUAL.");
  }
  return {
    mode: value.mode as ZoteroAttachmentPolicyMode,
    expectedRevision: requireNonnegativeInteger(value.expectedRevision, "expectedRevision"),
  };
}

export function parseZoteroAttachmentListQuery(
  parameters: URLSearchParams,
): ListZoteroAttachmentsQuery {
  const supported = new Set([
    "after",
    "limit",
    "libraryId",
    "eligibility",
    "includeDeleted",
  ]);
  for (const key of parameters.keys()) {
    if (!supported.has(key)) validation(`Unsupported attachment query parameter: ${key}.`);
  }
  for (const key of supported) {
    if (parameters.getAll(key).length > 1) validation(`${key} may only be supplied once.`);
  }
  const rawLimit = parameters.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIST_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    validation(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  const after = parameters.get("after");
  const libraryId = parameters.get("libraryId");
  const eligibility = parameters.get("eligibility");
  if (after !== null) requireOpaqueId(after, "after");
  if (libraryId !== null) requireOpaqueId(libraryId, "libraryId");
  if (
    eligibility !== null
    && !ELIGIBILITIES.has(eligibility as ZoteroAttachmentEligibilityValue)
  ) validation("eligibility is invalid.");
  const rawIncludeDeleted = parameters.get("includeDeleted");
  if (rawIncludeDeleted !== null && rawIncludeDeleted !== "true" && rawIncludeDeleted !== "false") {
    validation("includeDeleted must be true or false.");
  }
  return {
    after,
    limit,
    libraryId,
    eligibility: eligibility as ZoteroAttachmentEligibilityValue | null,
    includeDeleted: rawIncludeDeleted === "true",
  };
}

export function parseQueueZoteroAttachmentImportCommand(
  value: unknown,
): QueueZoteroAttachmentImportCommand {
  if (!isRecord(value)) validation("A JSON object is required.");
  requireExactKeys(value, [
    "clientOperationId",
    "expectedPolicyRevision",
    "sourceVersion",
    "metadataHash",
    "providerMd5",
  ], "Zotero attachment import command");
  const clientOperationId = requireOpaqueId(value.clientOperationId, "clientOperationId");
  if (typeof value.sourceVersion !== "string" || !SOURCE_VERSION_PATTERN.test(value.sourceVersion)) {
    validation("sourceVersion is invalid.");
  }
  if (typeof value.metadataHash !== "string" || !SHA256_PATTERN.test(value.metadataHash)) {
    validation("metadataHash must be a lowercase SHA-256 digest.");
  }
  if (typeof value.providerMd5 !== "string" || !MD5_PATTERN.test(value.providerMd5)) {
    validation("providerMd5 must be a lowercase MD5 digest.");
  }
  return {
    clientOperationId,
    expectedPolicyRevision: requireNonnegativeInteger(
      value.expectedPolicyRevision,
      "expectedPolicyRevision",
    ),
    sourceVersion: value.sourceVersion,
    metadataHash: value.metadataHash,
    providerMd5: value.providerMd5,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(",")}}`;
}

export function zoteroAttachmentImportRequestHash(input: {
  connectionId: string;
  attachmentId: string;
  command: QueueZoteroAttachmentImportCommand;
}): string {
  return createHash("sha256").update(stableJson({
    command: IMPORT_COMMAND,
    connectionId: input.connectionId,
    attachmentId: input.attachmentId,
    expectedPolicyRevision: input.command.expectedPolicyRevision,
    sourceVersion: input.command.sourceVersion,
    metadataHash: input.command.metadataHash,
    providerMd5: input.command.providerMd5,
  }), "utf8").digest("hex");
}

function publicFailureCode(value: string | null): string | null {
  if (value === null) return null;
  return PUBLIC_FAILURE_CODES.has(value) ? value : "internal_error";
}

function importSummary(value: StoredImportSummary): ZoteroAttachmentImportSummary {
  return {
    id: value.id,
    status: value.status,
    documentId: value.documentId,
    assetId: value.assetId,
    intakeId: value.intakeId,
    inboxEntryId: value.intake.inboxEntryId,
    downloadJobId: value.downloadJobId,
    sourceVersion: value.sourceVersion,
    providerMd5: value.providerMd5,
    failureCode: publicFailureCode(value.failureCode),
    createdAt: value.createdAt.toISOString(),
    completedAt: value.completedAt?.toISOString() ?? null,
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

async function requireMember(
  transaction: Prisma.TransactionClient,
  userId: string,
  workspaceId: string,
): Promise<{ role: string }> {
  await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
  const membership = await transaction.member.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) {
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }
  return membership;
}

async function requireZoteroConnection(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  connectionId: string,
) {
  const connection = await transaction.integrationConnection.findFirst({
    where: {
      id: connectionId,
      organizationId: workspaceId,
      provider: "ZOTERO",
    },
    select: {
      id: true,
      status: true,
      credentialGeneration: true,
      credentialCiphertext: true,
      credentialKeyVersion: true,
    },
  });
  if (!connection) {
    throw new HttpProblem(
      404,
      "zotero_connection_not_found",
      "Zotero connection was not found.",
    );
  }
  return connection;
}

function policySummary(value: {
  mode: ZoteroAttachmentPolicyMode;
  revision: number;
  configuredAt: Date | null;
} | null): ZoteroAttachmentPolicySummary {
  return value
    ? {
        mode: value.mode,
        revision: value.revision,
        configuredAt: value.configuredAt?.toISOString() ?? null,
      }
    : { mode: "DISABLED", revision: 0, configuredAt: null };
}

export async function getZoteroAttachmentPolicy(
  input: { userId: string; workspaceId: string; connectionId: string },
  dependencies: Pick<AttachmentServiceDependencies, "database"> = {},
): Promise<ZoteroAttachmentPolicySummary> {
  const database = dependencies.database ?? prisma;
  const userId = requireOpaqueId(input.userId, "userId");
  const workspaceId = requireOpaqueId(input.workspaceId, "workspaceId");
  const connectionId = requireOpaqueId(input.connectionId, "connectionId");
  const membership = await database.member.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) {
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }
  const connection = await database.integrationConnection.findFirst({
    where: { id: connectionId, organizationId: workspaceId, provider: "ZOTERO" },
    select: { id: true },
  });
  if (!connection) {
    throw new HttpProblem(404, "zotero_connection_not_found", "Zotero connection was not found.");
  }
  const policy = await database.zoteroAttachmentPolicy.findFirst({
    where: { organizationId: workspaceId, integrationConnectionId: connectionId },
    select: { mode: true, revision: true, configuredAt: true },
  });
  return policySummary(policy);
}

export async function updateZoteroAttachmentPolicy(
  input: {
    userId: string;
    workspaceId: string;
    connectionId: string;
    command: UpdateZoteroAttachmentPolicyCommand;
    requestId?: string;
  },
  dependencies: AttachmentServiceDependencies = {},
): Promise<UpdateZoteroAttachmentPolicyResult> {
  const database = dependencies.database ?? prisma;
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? randomUUID;
  const userId = requireOpaqueId(input.userId, "userId");
  const workspaceId = requireOpaqueId(input.workspaceId, "workspaceId");
  const connectionId = requireOpaqueId(input.connectionId, "connectionId");
  const command = parseZoteroAttachmentPolicyCommand(input.command);

  return runSerializableTransaction(database, async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`zotero-attachment-policy:${workspaceId}:${connectionId}`}, 0)
      )::text
    `;
    const membership = await requireMember(transaction, userId, workspaceId);
    requireWorkspaceIntegrationRole(membership.role);
    const connection = await requireZoteroConnection(transaction, workspaceId, connectionId);
    if (
      command.mode === "MANUAL"
      && (
        connection.status !== "CONNECTED"
        || connection.credentialGeneration <= 0
        || connection.credentialCiphertext === null
        || connection.credentialKeyVersion === null
      )
    ) {
      throw new HttpProblem(
        409,
        "zotero_connection_unavailable",
        "Reconnect Zotero before enabling attachment imports.",
      );
    }
    const existing = await transaction.zoteroAttachmentPolicy.findFirst({
      where: { organizationId: workspaceId, integrationConnectionId: connectionId },
      select: { id: true, mode: true, revision: true, configuredAt: true },
    });
    const current = policySummary(existing);
    if (current.mode === command.mode) return { outcome: "unchanged", ...current };
    if (current.revision !== command.expectedRevision) {
      throw new HttpProblem(
        409,
        "attachment_policy_revision_conflict",
        "Attachment import settings changed. Refresh before retrying.",
      );
    }
    const configuredAt = now();
    const policy = existing
      ? await transaction.zoteroAttachmentPolicy.update({
          where: {
            organizationId_integrationConnectionId: {
              organizationId: workspaceId,
              integrationConnectionId: connectionId,
            },
          },
          data: {
            mode: command.mode,
            revision: { increment: 1 },
            configuredById: userId,
            configuredAt,
          },
          select: { mode: true, revision: true, configuredAt: true },
        })
      : await transaction.zoteroAttachmentPolicy.create({
          data: {
            id: id(),
            organizationId: workspaceId,
            integrationConnectionId: connectionId,
            mode: command.mode,
            revision: 1,
            configuredById: userId,
            configuredAt,
          },
          select: { mode: true, revision: true, configuredAt: true },
        });
    await transaction.auditEvent.create({
      data: {
        id: id(),
        organizationId: workspaceId,
        actorUserId: userId,
        action: "zotero.attachment_policy.updated",
        entityType: "integration-connection",
        entityId: connectionId,
        requestId: input.requestId,
        metadata: { mode: policy.mode, revision: policy.revision },
      },
    });
    return { outcome: "applied", ...policySummary(policy) };
  });
}

export async function listZoteroAttachments(
  input: {
    userId: string;
    workspaceId: string;
    connectionId: string;
    query: ListZoteroAttachmentsQuery;
  },
  dependencies: Pick<AttachmentServiceDependencies, "database"> = {},
): Promise<ListZoteroAttachmentsResult> {
  const database = dependencies.database ?? prisma;
  const userId = requireOpaqueId(input.userId, "userId");
  const workspaceId = requireOpaqueId(input.workspaceId, "workspaceId");
  const connectionId = requireOpaqueId(input.connectionId, "connectionId");
  const membership = await database.member.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) {
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }
  const connection = await database.integrationConnection.findFirst({
    where: { id: connectionId, organizationId: workspaceId, provider: "ZOTERO" },
    select: { id: true },
  });
  if (!connection) {
    throw new HttpProblem(404, "zotero_connection_not_found", "Zotero connection was not found.");
  }
  if (input.query.libraryId) {
    const library = await database.zoteroLibrary.findFirst({
      where: {
        id: input.query.libraryId,
        organizationId: workspaceId,
        integrationConnectionId: connectionId,
      },
      select: { id: true },
    });
    if (!library) {
      throw new HttpProblem(404, "zotero_library_not_found", "Zotero library was not found.");
    }
  }
  const rows = await database.zoteroAttachment.findMany({
    where: {
      organizationId: workspaceId,
      library: {
        organizationId: workspaceId,
        integrationConnectionId: connectionId,
      },
      ...(input.query.libraryId ? { zoteroLibraryId: input.query.libraryId } : {}),
      ...(input.query.eligibility ? { eligibility: input.query.eligibility } : {}),
      ...(input.query.includeDeleted ? {} : { isDeleted: false }),
      ...(input.query.after ? { zoteroObjectId: { gt: input.query.after } } : {}),
    },
    orderBy: { zoteroObjectId: "asc" },
    take: input.query.limit + 1,
    select: {
      zoteroObjectId: true,
      zoteroLibraryId: true,
      parentKey: true,
      linkMode: true,
      contentType: true,
      fileName: true,
      providerMd5: true,
      providerMtime: true,
      sourceVersion: true,
      metadataHash: true,
      eligibility: true,
      reasonCode: true,
      isDeleted: true,
      updatedAt: true,
      imports: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: IMPORT_SUMMARY_SELECT,
      },
    },
  });
  const hasNextPage = rows.length > input.query.limit;
  const page = hasNextPage ? rows.slice(0, input.query.limit) : rows;
  return {
    attachments: page.map((row) => ({
      id: row.zoteroObjectId,
      libraryId: row.zoteroLibraryId,
      parentKey: row.parentKey,
      linkMode: row.linkMode,
      contentType: row.contentType,
      fileName: row.fileName,
      providerMd5: row.providerMd5,
      providerMtime: row.providerMtime,
      sourceVersion: row.sourceVersion,
      metadataHash: row.metadataHash,
      eligibility: row.eligibility,
      reasonCode: row.reasonCode,
      isDeleted: row.isDeleted,
      updatedAt: row.updatedAt.toISOString(),
      latestImport: row.imports[0] ? importSummary(row.imports[0]) : null,
    })),
    nextCursor: hasNextPage ? page.at(-1)?.zoteroObjectId ?? null : null,
  };
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

function defaultLimits(): AttachmentLimits {
  const configuration = uploadConfigurationFromEnvironment();
  return {
    maxPdfBytes: configuration.maxUploadBytes,
    maxRetainedBytes: configuration.maxRetainedBytesPerWorkspace,
  };
}

function requireLimits(value: AttachmentLimits): AttachmentLimits {
  if (
    !Number.isSafeInteger(value.maxPdfBytes)
    || value.maxPdfBytes < 1
    || !Number.isSafeInteger(value.maxRetainedBytes)
    || value.maxRetainedBytes < value.maxPdfBytes
  ) throw new Error("Zotero attachment byte limits are invalid.");
  return value;
}

function replayImportId(value: Prisma.JsonValue | null): string | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || value.schemaVersion !== 1
    || typeof value.attachmentImportId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.attachmentImportId)
  ) return null;
  return value.attachmentImportId;
}

async function storedImportById(
  transaction: Prisma.TransactionClient,
  organizationId: string,
  id: string,
): Promise<StoredImportSummary | null> {
  return transaction.zoteroAttachmentImport.findFirst({
    where: { id, organizationId },
    select: IMPORT_SUMMARY_SELECT,
  });
}

export async function queueZoteroAttachmentImport(
  input: {
    userId: string;
    workspaceId: string;
    connectionId: string;
    attachmentId: string;
    command: QueueZoteroAttachmentImportCommand;
    requestId?: string;
  },
  dependencies: AttachmentServiceDependencies = {},
): Promise<QueueZoteroAttachmentImportResult> {
  const database = dependencies.database ?? prisma;
  const id = dependencies.id ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  const limits = requireLimits(dependencies.limits ?? defaultLimits());
  const userId = requireOpaqueId(input.userId, "userId");
  const workspaceId = requireOpaqueId(input.workspaceId, "workspaceId");
  const connectionId = requireOpaqueId(input.connectionId, "connectionId");
  const attachmentId = requireOpaqueId(input.attachmentId, "attachmentId");
  const command = parseQueueZoteroAttachmentImportCommand(input.command);
  const requestHash = zoteroAttachmentImportRequestHash({
    connectionId,
    attachmentId,
    command,
  });

  return runSerializableTransaction(database, async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`zotero-attachment-operation:${workspaceId}:${command.clientOperationId}`}, 0)
      )::text
    `;
    const membership = await requireMember(transaction, userId, workspaceId);
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
        || prior.command !== IMPORT_COMMAND
        || prior.requestHash !== requestHash
      ) {
        throw new HttpProblem(
          409,
          "idempotency_conflict",
          "clientOperationId was already used for a different command.",
        );
      }
      const priorImportId = replayImportId(prior.response);
      const replay = priorImportId
        ? await storedImportById(transaction, workspaceId, priorImportId)
        : null;
      if (!replay) {
        throw new HttpProblem(
          409,
          "operation_pending",
          "The prior attachment import request is still resolving.",
        );
      }
      return { outcome: "replayed", import: importSummary(replay) };
    }

    const legacyReplay = await transaction.zoteroAttachmentImport.findUnique({
      where: {
        organizationId_clientOperationId: {
          organizationId: workspaceId,
          clientOperationId: command.clientOperationId,
        },
      },
      select: {
        requestedById: true,
        requestHash: true,
        ...IMPORT_SUMMARY_SELECT,
      },
    });
    if (legacyReplay) {
      if (legacyReplay.requestedById !== userId || legacyReplay.requestHash !== requestHash) {
        throw new HttpProblem(
          409,
          "idempotency_conflict",
          "clientOperationId was already used for a different command.",
        );
      }
      return { outcome: "replayed", import: importSummary(legacyReplay) };
    }

    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`zotero-attachment-policy:${workspaceId}:${connectionId}`}, 0)
      )::text
    `;
    const connection = await requireZoteroConnection(transaction, workspaceId, connectionId);
    if (
      connection.status !== "CONNECTED"
      || connection.credentialGeneration <= 0
      || connection.credentialCiphertext === null
      || connection.credentialKeyVersion === null
    ) {
      throw new HttpProblem(
        409,
        "zotero_connection_unavailable",
        "Reconnect Zotero before importing stored files.",
      );
    }
    const policy = await transaction.zoteroAttachmentPolicy.findFirst({
      where: { organizationId: workspaceId, integrationConnectionId: connectionId },
      select: { mode: true, revision: true },
    });
    if (!policy || policy.mode !== "MANUAL") {
      throw new HttpProblem(
        409,
        "attachment_import_disabled",
        "Enable manual Zotero attachment imports before importing a file.",
      );
    }
    if (policy.revision !== command.expectedPolicyRevision) {
      throw new HttpProblem(
        409,
        "attachment_policy_revision_conflict",
        "Attachment import settings changed. Refresh before retrying.",
      );
    }
    const attachment = await transaction.zoteroAttachment.findFirst({
      where: {
        zoteroObjectId: attachmentId,
        organizationId: workspaceId,
        zoteroLibraryId: { not: "" },
        library: {
          organizationId: workspaceId,
          integrationConnectionId: connectionId,
        },
      },
      select: {
        zoteroObjectId: true,
        zoteroLibraryId: true,
        fileName: true,
        contentType: true,
        providerMd5: true,
        sourceVersion: true,
        metadataHash: true,
        eligibility: true,
        isDeleted: true,
        library: {
          select: {
            isReadable: true,
            syncEnabled: true,
            accessLostAt: true,
            fileAccessStatus: true,
          },
        },
        object: { select: { isDeleted: true, version: true } },
      },
    });
    if (!attachment) {
      throw new HttpProblem(404, "zotero_attachment_not_found", "Zotero attachment was not found.");
    }
    if (
      !attachment.library.isReadable
      || !attachment.library.syncEnabled
      || attachment.library.accessLostAt !== null
    ) {
      throw new HttpProblem(
        409,
        "zotero_library_unavailable",
        "Select a readable Zotero library before importing its files.",
      );
    }
    if (attachment.library.fileAccessStatus === "UNAVAILABLE") {
      throw new HttpProblem(
        409,
        "zotero_file_access_unavailable",
        "Zotero reports that stored files are unavailable for this library.",
      );
    }
    if (
      attachment.eligibility !== "DOWNLOADABLE"
      || attachment.isDeleted
      || attachment.object.isDeleted
      || attachment.providerMd5 === null
      || attachment.contentType !== "application/pdf"
      || attachment.fileName === null
    ) {
      throw new HttpProblem(
        409,
        "zotero_attachment_not_downloadable",
        "This Zotero attachment is not an eligible stored PDF.",
      );
    }
    if (
      attachment.sourceVersion !== command.sourceVersion
      || attachment.object.version !== command.sourceVersion
      || attachment.metadataHash !== command.metadataHash
      || attachment.providerMd5 !== command.providerMd5
    ) {
      throw new HttpProblem(
        409,
        "zotero_attachment_source_changed",
        "The Zotero attachment changed. Refresh before importing it.",
      );
    }

    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`zotero-attachment-source:${workspaceId}:${attachmentId}:${command.sourceVersion}:${command.providerMd5}`}, 0)
      )::text
    `;
    const existingGeneration = await transaction.zoteroAttachmentImport.findFirst({
      where: {
        organizationId: workspaceId,
        zoteroObjectId: attachmentId,
        sourceVersion: command.sourceVersion,
        providerMd5: command.providerMd5,
        // Failed and cancelled rows are immutable historical attempts. A new
        // explicit operation may retry the same exact provider generation,
        // while every active, attention, or ready import remains singleton.
        status: { notIn: ["FAILED", "CANCELLED"] },
      },
      select: IMPORT_SUMMARY_SELECT,
    });
    if (existingGeneration) {
      const completedAt = now();
      await transaction.idempotencyRecord.create({
        data: {
          id: id(),
          organizationId: workspaceId,
          actorUserId: userId,
          key: command.clientOperationId,
          command: IMPORT_COMMAND,
          requestHash,
          status: "COMPLETED",
          response: { schemaVersion: 1, attachmentImportId: existingGeneration.id },
          completedAt,
          expiresAt: new Date(completedAt.getTime() + IDEMPOTENCY_TTL_MS),
        },
      });
      return { outcome: "coalesced", import: importSummary(existingGeneration) };
    }

    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`upload-quota:${workspaceId}`}, 0)
      )::text
    `;
    const retainedBytes = await retainedWorkspaceIntakeBytes(transaction, workspaceId);
    if (retainedBytes + BigInt(limits.maxPdfBytes) > BigInt(limits.maxRetainedBytes)) {
      throw new HttpProblem(
        413,
        "storage_quota_exceeded",
        "This workspace's private upload storage limit has been reached.",
      );
    }

    const createdAt = now();
    const importId = id();
    const documentId = id();
    const assetId = id();
    const intakeId = id();
    const inboxEntryId = id();
    const importBatchId = id();
    const jobId = id();
    // Attempt-scoped identity keeps immutable failed/cancelled documents and
    // inbox entries for audit while allowing an explicit replacement attempt.
    // ZoteroAttachmentImport remains the provider-generation coalescing
    // authority; the eventual DocumentIngestReceipt repeats that identity.
    const sourceFingerprint = `zotero-attachment-import:${importId}`;

    await transaction.asset.create({
      data: {
        id: assetId,
        organizationId: workspaceId,
        storageProvider: "LOCAL",
        bucket: "private-quarantine-v1",
        objectKey: `pending:zotero:${assetId}`,
        status: "UPLOADING",
        originalFileName: attachment.fileName,
        mimeType: "application/pdf",
        createdById: userId,
        metadata: {
          schemaVersion: 1,
          custody: "reserved",
          publicAccess: false,
          source: "zotero-attachment",
        },
      },
    });
    await transaction.document.create({
      data: {
        id: documentId,
        organizationId: workspaceId,
        kind: "PAPER_PDF",
        status: "PENDING",
        title: attachment.fileName,
        sourceFingerprint,
        mimeType: "application/pdf",
        metadata: {
          schemaVersion: 1,
          custody: "zotero-attachment-import",
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
        source: "ZOTERO",
        status: "RUNNING",
        label: "Zotero stored PDF import",
        integrationConnectionId: connectionId,
        requestedById: userId,
        externalRequestId: importId,
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
        source: "ZOTERO",
        sourceKey: `attachment-import:${importId}`,
        dedupeKey: sourceFingerprint,
        status: "NEEDS_REVIEW",
        proposedTitle: attachment.fileName,
        payload: {
          schemaVersion: 1,
          kind: "zotero-attachment-import",
          attachmentImportId: importId,
          importStatus: "QUEUED",
        },
        createdById: userId,
      },
    });
    await transaction.documentIntake.create({
      data: {
        id: intakeId,
        organizationId: workspaceId,
        source: "ZOTERO_ATTACHMENT",
        status: "QUEUED",
        documentId,
        assetId,
        inboxEntryId,
        importBatchId,
        createdById: userId,
        reservedBytes: BigInt(limits.maxPdfBytes),
        policyRevision: policy.revision,
      },
    });
    await transaction.zoteroAttachmentImport.create({
      data: {
        id: importId,
        organizationId: workspaceId,
        integrationConnectionId: connectionId,
        zoteroLibraryId: attachment.zoteroLibraryId,
        zoteroObjectId: attachmentId,
        intakeId,
        documentId,
        assetId,
        requestedById: userId,
        clientOperationId: command.clientOperationId,
        requestHash,
        policyRevision: policy.revision,
        credentialGeneration: connection.credentialGeneration,
        sourceVersion: command.sourceVersion,
        sourceMetadataHash: command.metadataHash,
        providerMd5: command.providerMd5,
        status: "QUEUED",
      },
    });
    const jobPayload = zoteroAttachmentDownloadJobPayload(importId);
    await transaction.job.create({
      data: {
        id: jobId,
        organizationId: workspaceId,
        type: "DOCUMENT_DOWNLOAD",
        status: "QUEUED",
        dedupeKey: zoteroAttachmentDownloadJobDedupeKey(importId),
        payload: jobPayload as unknown as Prisma.InputJsonValue,
        maxAttempts: 5,
        runAfter: createdAt,
        integrationConnectionId: connectionId,
        zoteroLibraryId: attachment.zoteroLibraryId,
        documentId,
        assetId,
        intakeId,
        createdById: userId,
      },
    });
    const bound = await transaction.zoteroAttachmentImport.updateMany({
      where: {
        id: importId,
        organizationId: workspaceId,
        downloadJobId: null,
        status: "QUEUED",
      },
      data: { downloadJobId: jobId },
    });
    if (bound.count !== 1) {
      throw new HttpProblem(
        409,
        "zotero_attachment_import_state_changed",
        "Attachment import state changed before its download was queued.",
      );
    }
    await transaction.idempotencyRecord.create({
      data: {
        id: id(),
        organizationId: workspaceId,
        actorUserId: userId,
        key: command.clientOperationId,
        command: IMPORT_COMMAND,
        requestHash,
        status: "COMPLETED",
        response: { schemaVersion: 1, attachmentImportId: importId },
        completedAt: createdAt,
        expiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
    await transaction.auditEvent.create({
      data: {
        id: id(),
        organizationId: workspaceId,
        actorUserId: userId,
        action: "zotero.attachment_import.queued",
        entityType: "zotero-attachment-import",
        entityId: importId,
        requestId: input.requestId ?? command.clientOperationId,
        metadata: {
          attachmentId,
          libraryId: attachment.zoteroLibraryId,
          policyRevision: policy.revision,
          credentialGeneration: connection.credentialGeneration,
          reservedBytes: String(limits.maxPdfBytes),
        },
      },
    });
    const stored = await storedImportById(transaction, workspaceId, importId);
    if (!stored) throw new Error("The queued Zotero attachment import could not be reloaded.");
    return { outcome: "applied", import: importSummary(stored) };
  });
}
