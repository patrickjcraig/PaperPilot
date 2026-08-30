import "server-only";

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import {
  credentialProtectorFromEnvironment,
  type CredentialProtector,
} from "@/server/integrations/credential-protection";
import { acquireWorkspaceMembershipAuthorityShared } from "@/server/workspaces/membership-lock";
import { ZoteroReadOnlyAdapter } from "./adapter";
import type {
  ZoteroIdentity,
  ZoteroIdentityAccess,
  ZoteroPermissionSet,
  ZoteroReadOnlyClient,
  ZoteroResponseMeta,
} from "./contracts";
import { ZoteroAdapterError } from "./errors";

const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;
const PROVIDER_LIBRARY_ID_PATTERN = /^[1-9][0-9]*$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const INTEGRATION_ADMIN_ROLES = new Set(["owner", "admin"]);
const MAX_DISCOVERED_LIBRARIES = 500;
const MAX_PROVIDER_GROUPS = 10_000;
const GROUP_PAGE_SIZE = 100;
const MAX_SELECTION_REVISION = 2_147_483_647;
const MAX_SERIALIZABLE_ATTEMPTS = 4;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const SELECTION_COMMAND = "selectZoteroLibraries:v1";

const CONNECTION_ATTENTION_CODES = new Set([
  "remote_revocation_pending",
  "remote_revocation_unconfirmed",
  "previous_key_revocation_pending",
  "previous_key_revocation_unconfirmed",
  "zotero_authentication_failed",
  "zotero_forbidden",
  "zotero_credential_unavailable",
  "zotero_unavailable",
] as const);

const REVOCATION_ATTENTION_CODES = new Set([
  "remote_revocation_pending",
  "remote_revocation_unconfirmed",
  "previous_key_revocation_pending",
  "previous_key_revocation_unconfirmed",
] as const);

const SYNC_ERROR_CODES = new Set([
  "zotero_authentication_failed",
  "zotero_bad_response",
  "zotero_credential_unavailable",
  "zotero_forbidden",
  "zotero_invalid_request",
  "zotero_not_found",
  "zotero_rate_limited",
  "zotero_timeout",
  "zotero_sync_resource_limit",
  "stable_version_changed",
  "internal_error",
] as const);

const SYNC_RUN_STATUSES = new Set([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "BACKING_OFF",
] as const);

export type ZoteroAttentionCode =
  | "remote_revocation_pending"
  | "remote_revocation_unconfirmed"
  | "previous_key_revocation_pending"
  | "previous_key_revocation_unconfirmed"
  | "zotero_authentication_failed"
  | "zotero_forbidden"
  | "zotero_credential_unavailable"
  | "zotero_unavailable";

export type ZoteroSyncErrorCode =
  | "zotero_authentication_failed"
  | "zotero_bad_response"
  | "zotero_credential_unavailable"
  | "zotero_forbidden"
  | "zotero_invalid_request"
  | "zotero_not_found"
  | "zotero_rate_limited"
  | "zotero_timeout"
  | "zotero_sync_resource_limit"
  | "stable_version_changed"
  | "internal_error";

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
  errorCode: ZoteroSyncErrorCode | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ZoteroLibrarySummary {
  id: string;
  type: "USER" | "GROUP";
  zoteroLibraryId: string;
  name: string | null;
  isReadable: boolean;
  isWritable: boolean;
  fileAccessStatus: ZoteroFileAccessStatusValue;
  syncEnabled: boolean;
  lastSyncedAt: string | null;
  lastSyncedVersion: string | null;
  lastSyncRun: ZoteroSyncRunSummary | null;
}

export const ZOTERO_FILE_ACCESS_STATUSES = [
  "AVAILABLE",
  "UNKNOWN",
  "UNAVAILABLE",
] as const;

export type ZoteroFileAccessStatusValue =
  (typeof ZOTERO_FILE_ACCESS_STATUSES)[number];

/**
 * Project only provider-confirmed file access. Zotero reports the personal
 * library's stored-file bit, but group entries commonly omit a separate file
 * bit. Absence is therefore unknown, never an inferred denial.
 */
export function zoteroFileAccessStatusFromPermission(
  permission: ZoteroPermissionSet | undefined,
  isReadable = true,
): ZoteroFileAccessStatusValue {
  if (
    !isReadable
    || permission?.library !== true
    || permission.files === false
  ) {
    return "UNAVAILABLE";
  }
  if (permission?.files === true) return "AVAILABLE";
  return "UNKNOWN";
}

export interface ZoteroConnectionCapabilities {
  personalLibrary: boolean;
  groupLibraries: boolean;
  notes: boolean;
  files: boolean;
}

export interface ZoteroConnectionSummary {
  id: string;
  status: "PENDING" | "CONNECTED" | "DEGRADED" | "REVOKED" | "DISCONNECTED";
  displayName: string | null;
  lastVerifiedAt: string | null;
  attentionCode: ZoteroAttentionCode | null;
  providerBackoffUntil: string | null;
  selectionRevision: number;
  librariesConfiguredAt: string | null;
  capabilities: ZoteroConnectionCapabilities;
  libraries: ZoteroLibrarySummary[];
}

export interface ZoteroConnectionsResponse {
  connections: ZoteroConnectionSummary[];
}

export interface DiscoverZoteroLibrariesInput {
  userId: string;
  workspaceId: string;
  connectionId: string;
  requestId?: string;
}

export interface ZoteroLibraryDiscoveryResponse {
  discovered: true;
  libraries: ZoteroLibrarySummary[];
}

export interface ZoteroLibrarySelectionCommand {
  clientOperationId: string;
  expectedSelectionRevision: number;
  selectedLibraryIds: string[];
}

export interface SelectZoteroLibrariesInput {
  userId: string;
  workspaceId: string;
  connectionId: string;
  requestId?: string;
  command: ZoteroLibrarySelectionCommand;
}

export interface ZoteroLibrarySelectionResponse {
  outcome: "applied" | "replayed" | "noop";
  selectionRevision: number;
  libraries: ZoteroLibrarySummary[];
}

type ZoteroLibraryDiscoveryClient = Pick<
  ZoteroReadOnlyClient,
  "getCurrentIdentity" | "listUserGroups"
>;

export interface ZoteroLibraryServiceDependencies {
  database?: PrismaClient;
  credentialProtector?: CredentialProtector;
  providerClientFactory?: (input: {
    organizationId: string;
    connectionId: string;
    accessToken: string;
    now: () => Date;
  }) => ZoteroLibraryDiscoveryClient;
  now?: () => Date;
}

const LIBRARY_SUMMARY_SELECT = {
  id: true,
  libraryType: true,
  zoteroLibraryId: true,
  name: true,
  isReadable: true,
  isWritable: true,
  fileAccessStatus: true,
  syncEnabled: true,
  lastSyncedAt: true,
  lastSyncedVersion: true,
  syncRuns: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: {
      id: true,
      status: true,
      fromVersion: true,
      toVersion: true,
      objectsRead: true,
      objectsWritten: true,
      objectsDeleted: true,
      backoffUntil: true,
      errorCode: true,
      startedAt: true,
      completedAt: true,
    },
  },
} satisfies Prisma.ZoteroLibrarySelect;

type LibrarySummaryRecord = Prisma.ZoteroLibraryGetPayload<{
  select: typeof LIBRARY_SUMMARY_SELECT;
}>;

interface DiscoveredLibrary {
  libraryType: "USER" | "GROUP";
  zoteroLibraryId: string;
  name: string | null;
  permission: ZoteroPermissionSet;
}

function requireOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
}

function requireIntegrationAdmin(role: string): void {
  if (!INTEGRATION_ADMIN_ROLES.has(role)) {
    throw new HttpProblem(
      403,
      "workspace_forbidden",
      "This workspace role cannot manage integrations.",
    );
  }
}

function normalizedNow(clock: () => Date): Date {
  let value: Date;
  try {
    value = clock();
  } catch {
    throw new Error("The Zotero library-service clock failed.");
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("The Zotero library-service clock returned an invalid time.");
  }
  return new Date(value.getTime());
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validProviderLibraryId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 200
    && PROVIDER_LIBRARY_ID_PATTERN.test(value);
}

function permission(value: unknown): ZoteroPermissionSet | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const result: ZoteroPermissionSet = {};
  for (const key of ["library", "files", "notes", "write"] as const) {
    if (typeof candidate[key] === "boolean") result[key] = candidate[key];
  }
  return result;
}

function identityAccess(value: unknown): ZoteroIdentityAccess {
  const candidate = record(value);
  if (!candidate) return {};
  const result: ZoteroIdentityAccess = {};
  const user = permission(candidate.user);
  if (user) result.user = user;
  const rawGroups = record(candidate.groups);
  if (rawGroups) {
    const groups: NonNullable<ZoteroIdentityAccess["groups"]> = {};
    for (const [groupId, rawPermission] of Object.entries(rawGroups)) {
      if (groupId !== "all" && !validProviderLibraryId(groupId)) continue;
      const parsed = permission(rawPermission);
      if (parsed) groups[groupId] = parsed;
    }
    result.groups = groups;
  }
  return result;
}

function readable(value: ZoteroPermissionSet | undefined): value is ZoteroPermissionSet {
  return value?.library === true;
}

function boundedNullableText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || CONTROL_CHARACTER_PATTERN.test(normalized)) return null;
  return normalized.slice(0, maximum);
}

function identityDisplayName(identity: ZoteroIdentity): string {
  return (
    boundedNullableText(identity.displayName, 200)
    ?? boundedNullableText(identity.username, 200)
    ?? `Zotero user ${identity.userId}`
  );
}

function safeVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}

export function sanitizedZoteroAttentionCode(value: unknown): ZoteroAttentionCode | null {
  return typeof value === "string" && CONNECTION_ATTENTION_CODES.has(
    value as ZoteroAttentionCode,
  )
    ? value as ZoteroAttentionCode
    : null;
}

export function sanitizedZoteroSyncErrorCode(
  value: unknown,
): ZoteroSyncErrorCode | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && SYNC_ERROR_CODES.has(
    value as ZoteroSyncErrorCode,
  )
    ? value as ZoteroSyncErrorCode
    : "internal_error";
}

export function zoteroCapabilitiesFromScopes(
  scopes: unknown,
): ZoteroConnectionCapabilities {
  const access = identityAccess(scopes);
  const groupPermissions = Object.values(access.groups ?? {});
  const allPermissions = [access.user, ...groupPermissions];
  return {
    personalLibrary: access.user?.library === true,
    groupLibraries: groupPermissions.some((entry) => entry?.library === true),
    notes: allPermissions.some((entry) => entry?.notes === true),
    files: allPermissions.some((entry) => entry?.files === true),
  };
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function zoteroSyncRunSummary(
  run: LibrarySummaryRecord["syncRuns"][number] | undefined,
): ZoteroSyncRunSummary | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    fromVersion: safeVersion(run.fromVersion),
    toVersion: safeVersion(run.toVersion),
    objectsRead: safeCount(run.objectsRead),
    objectsWritten: safeCount(run.objectsWritten),
    objectsDeleted: safeCount(run.objectsDeleted),
    backoffUntil: run.backoffUntil?.toISOString() ?? null,
    errorCode: sanitizedZoteroSyncErrorCode(run.errorCode),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

export function zoteroLibrarySummary(
  library: LibrarySummaryRecord,
): ZoteroLibrarySummary {
  if (!validProviderLibraryId(library.zoteroLibraryId)) {
    throw new Error("A stored Zotero library identifier is invalid.");
  }
  return {
    id: library.id,
    type: library.libraryType,
    zoteroLibraryId: library.zoteroLibraryId,
    name: boundedNullableText(library.name, 500),
    isReadable: library.isReadable,
    isWritable: library.isWritable,
    fileAccessStatus: library.fileAccessStatus,
    syncEnabled: library.syncEnabled,
    lastSyncedAt: library.lastSyncedAt?.toISOString() ?? null,
    lastSyncedVersion: safeVersion(library.lastSyncedVersion),
    lastSyncRun: zoteroSyncRunSummary(library.syncRuns[0]),
  };
}

async function listLibrarySummaries(
  database: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  connectionId: string,
): Promise<ZoteroLibrarySummary[]> {
  const libraries = await database.zoteroLibrary.findMany({
    where: {
      organizationId: workspaceId,
      integrationConnectionId: connectionId,
    },
    orderBy: [{ libraryType: "asc" }, { zoteroLibraryId: "asc" }, { id: "asc" }],
    take: MAX_DISCOVERED_LIBRARIES + 1,
    select: LIBRARY_SUMMARY_SELECT,
  });
  if (libraries.length > MAX_DISCOVERED_LIBRARIES) {
    throw new HttpProblem(
      409,
      "zotero_library_limit_exceeded",
      `A Zotero connection may retain at most ${MAX_DISCOVERED_LIBRARIES} libraries.`,
    );
  }
  return libraries.map(zoteroLibrarySummary);
}

/** Credential-free status projection for every Zotero connection in a workspace. */
export async function listZoteroConnections(
  userId: string,
  workspaceId: string,
  database: PrismaClient = prisma,
): Promise<ZoteroConnectionsResponse> {
  requireOpaqueId(userId, "userId");
  requireOpaqueId(workspaceId, "workspaceId");
  const membership = await database.member.findUnique({
    where: {
      organizationId_userId: { organizationId: workspaceId, userId },
    },
    select: { id: true },
  });
  if (!membership) {
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }

  const connections = await database.integrationConnection.findMany({
    where: { organizationId: workspaceId, provider: "ZOTERO" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      displayName: true,
      scopes: true,
      lastVerifiedAt: true,
      lastErrorCode: true,
      providerBackoffUntil: true,
      zoteroSelectionRevision: true,
      zoteroLibrariesConfiguredAt: true,
      zoteroLibraries: {
        orderBy: [{ libraryType: "asc" }, { zoteroLibraryId: "asc" }, { id: "asc" }],
        take: MAX_DISCOVERED_LIBRARIES + 1,
        select: LIBRARY_SUMMARY_SELECT,
      },
    },
  });

  return {
    connections: connections.map((connection) => {
      if (connection.zoteroLibraries.length > MAX_DISCOVERED_LIBRARIES) {
        throw new HttpProblem(
          409,
          "zotero_library_limit_exceeded",
          `A Zotero connection may retain at most ${MAX_DISCOVERED_LIBRARIES} libraries.`,
        );
      }
      return {
      id: connection.id,
      status: connection.status,
      displayName: boundedNullableText(connection.displayName, 200),
      lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
      attentionCode: sanitizedZoteroAttentionCode(connection.lastErrorCode),
      providerBackoffUntil: connection.providerBackoffUntil?.toISOString() ?? null,
      selectionRevision: safeCount(connection.zoteroSelectionRevision),
      librariesConfiguredAt:
        connection.zoteroLibrariesConfiguredAt?.toISOString() ?? null,
      capabilities: zoteroCapabilitiesFromScopes(connection.scopes),
      libraries: connection.zoteroLibraries.map(zoteroLibrarySummary),
      };
    }),
  };
}

function serializableConflict(value: unknown): boolean {
  const candidate = record(value);
  return candidate?.code === "P2034" || candidate?.code === "P2002";
}

async function runSerializableTransaction<T>(
  database: PrismaClient,
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!serializableConflict(error) || attempt === MAX_SERIALIZABLE_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function selectionRequestHash(input: {
  connectionId: string;
  expectedSelectionRevision: number;
  selectedLibraryIds: readonly string[];
}): string {
  return createHash("sha256")
    .update(stableJson({
      command: SELECTION_COMMAND,
      connectionId: input.connectionId,
      expectedSelectionRevision: input.expectedSelectionRevision,
      selectedLibraryIds: [...input.selectedLibraryIds].sort(),
    }))
    .digest("hex");
}

export function parseZoteroLibrarySelectionCommand(
  value: unknown,
): ZoteroLibrarySelectionCommand {
  const candidate = record(value);
  if (!candidate) {
    throw new HttpProblem(400, "validation", "A Zotero library selection is required.");
  }
  const expectedKeys = new Set([
    "clientOperationId",
    "expectedSelectionRevision",
    "selectedLibraryIds",
  ]);
  const unknownKey = Object.keys(candidate).find((key) => !expectedKeys.has(key));
  if (unknownKey) {
    throw new HttpProblem(
      400,
      "validation",
      `Unknown Zotero library-selection field “${unknownKey}”.`,
    );
  }
  if (Object.keys(candidate).length !== expectedKeys.size) {
    throw new HttpProblem(
      400,
      "validation",
      "The Zotero library-selection command is incomplete.",
    );
  }
  requireOpaqueId(candidate.clientOperationId, "clientOperationId");
  if (
    !Number.isSafeInteger(candidate.expectedSelectionRevision)
    || (candidate.expectedSelectionRevision as number) < 0
    || (candidate.expectedSelectionRevision as number) > MAX_SELECTION_REVISION
  ) {
    throw new HttpProblem(
      400,
      "validation",
      "expectedSelectionRevision is invalid.",
    );
  }
  if (
    !Array.isArray(candidate.selectedLibraryIds)
    || candidate.selectedLibraryIds.length > MAX_DISCOVERED_LIBRARIES
  ) {
    throw new HttpProblem(
      400,
      "validation",
      `selectedLibraryIds must contain at most ${MAX_DISCOVERED_LIBRARIES} library IDs.`,
    );
  }
  const selectedLibraryIds = candidate.selectedLibraryIds.map((libraryId) => {
    requireOpaqueId(libraryId, "selectedLibraryIds entry");
    return libraryId;
  });
  if (new Set(selectedLibraryIds).size !== selectedLibraryIds.length) {
    throw new HttpProblem(
      400,
      "validation",
      "selectedLibraryIds must not contain duplicates.",
    );
  }
  return {
    clientOperationId: candidate.clientOperationId,
    expectedSelectionRevision: candidate.expectedSelectionRevision as number,
    selectedLibraryIds,
  };
}

function isNullableTimestamp(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string" && value.length <= 100 && Number.isFinite(Date.parse(value));
}

function storedSyncRun(value: unknown): ZoteroSyncRunSummary | null | undefined {
  if (value === null) return null;
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.id !== "string"
    || !OPAQUE_ID_PATTERN.test(candidate.id)
    || typeof candidate.status !== "string"
    || !SYNC_RUN_STATUSES.has(candidate.status as ZoteroSyncRunSummary["status"])
    || !(candidate.fromVersion === null || safeVersion(candidate.fromVersion) !== null)
    || !(candidate.toVersion === null || safeVersion(candidate.toVersion) !== null)
    || !Number.isSafeInteger(candidate.objectsRead)
    || (candidate.objectsRead as number) < 0
    || !Number.isSafeInteger(candidate.objectsWritten)
    || (candidate.objectsWritten as number) < 0
    || !Number.isSafeInteger(candidate.objectsDeleted)
    || (candidate.objectsDeleted as number) < 0
    || !isNullableTimestamp(candidate.backoffUntil)
    || !isNullableTimestamp(candidate.startedAt)
    || !isNullableTimestamp(candidate.completedAt)
  ) {
    return undefined;
  }
  const errorCode = candidate.errorCode === null
    ? null
    : sanitizedZoteroSyncErrorCode(candidate.errorCode);
  return {
    id: candidate.id,
    status: candidate.status as ZoteroSyncRunSummary["status"],
    fromVersion: candidate.fromVersion as string | null,
    toVersion: candidate.toVersion as string | null,
    objectsRead: candidate.objectsRead as number,
    objectsWritten: candidate.objectsWritten as number,
    objectsDeleted: candidate.objectsDeleted as number,
    backoffUntil: candidate.backoffUntil,
    errorCode,
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
  };
}

function storedLibrary(value: unknown): ZoteroLibrarySummary | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.id !== "string"
    || !OPAQUE_ID_PATTERN.test(candidate.id)
    || (candidate.type !== "USER" && candidate.type !== "GROUP")
    || typeof candidate.zoteroLibraryId !== "string"
    || candidate.zoteroLibraryId.length < 1
    || candidate.zoteroLibraryId.length > 200
    || CONTROL_CHARACTER_PATTERN.test(candidate.zoteroLibraryId)
    || !(candidate.name === null || (
      typeof candidate.name === "string"
      && candidate.name.length > 0
      && candidate.name.length <= 500
      && !CONTROL_CHARACTER_PATTERN.test(candidate.name)
    ))
    || typeof candidate.isReadable !== "boolean"
    || typeof candidate.isWritable !== "boolean"
    || !ZOTERO_FILE_ACCESS_STATUSES.includes(
      candidate.fileAccessStatus as ZoteroFileAccessStatusValue,
    )
    || (
      candidate.isReadable === false
      && candidate.fileAccessStatus !== "UNAVAILABLE"
    )
    || typeof candidate.syncEnabled !== "boolean"
    || !isNullableTimestamp(candidate.lastSyncedAt)
    || !(candidate.lastSyncedVersion === null || safeVersion(candidate.lastSyncedVersion) !== null)
  ) {
    return null;
  }
  const lastSyncRun = storedSyncRun(candidate.lastSyncRun);
  if (lastSyncRun === undefined) return null;
  return {
    id: candidate.id,
    type: candidate.type,
    zoteroLibraryId: candidate.zoteroLibraryId,
    name: candidate.name as string | null,
    isReadable: candidate.isReadable,
    isWritable: candidate.isWritable,
    fileAccessStatus: candidate.fileAccessStatus as ZoteroFileAccessStatusValue,
    syncEnabled: candidate.syncEnabled,
    lastSyncedAt: candidate.lastSyncedAt,
    lastSyncedVersion: candidate.lastSyncedVersion as string | null,
    lastSyncRun,
  };
}

function replayedSelectionResponse(value: unknown): ZoteroLibrarySelectionResponse | null {
  const candidate = record(value);
  if (
    !candidate
    || (candidate.outcome !== "applied" && candidate.outcome !== "noop")
    || !Number.isSafeInteger(candidate.selectionRevision)
    || (candidate.selectionRevision as number) < 0
    || !Array.isArray(candidate.libraries)
    || candidate.libraries.length > MAX_DISCOVERED_LIBRARIES
  ) {
    return null;
  }
  const libraries = candidate.libraries.map(storedLibrary);
  if (libraries.some((entry) => entry === null)) return null;
  return {
    outcome: "replayed",
    selectionRevision: candidate.selectionRevision as number,
    libraries: libraries as ZoteroLibrarySummary[],
  };
}

/** Apply one exact, optimistic library selection with a durable replay receipt. */
export async function selectZoteroLibraries(
  input: SelectZoteroLibrariesInput,
  dependencies: Pick<ZoteroLibraryServiceDependencies, "database" | "now"> = {},
): Promise<ZoteroLibrarySelectionResponse> {
  requireOpaqueId(input.userId, "userId");
  requireOpaqueId(input.workspaceId, "workspaceId");
  requireOpaqueId(input.connectionId, "connectionId");
  const command = parseZoteroLibrarySelectionCommand(input.command);
  const database = dependencies.database ?? prisma;
  const now = normalizedNow(dependencies.now ?? (() => new Date()));
  const hash = selectionRequestHash({
    connectionId: input.connectionId,
    expectedSelectionRevision: command.expectedSelectionRevision,
    selectedLibraryIds: command.selectedLibraryIds,
  });

  return runSerializableTransaction(database, async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${input.workspaceId}:${command.clientOperationId}`}, 0)
      )::text
    `;

    await acquireWorkspaceMembershipAuthorityShared(
      transaction,
      input.workspaceId,
      input.userId,
    );
    const membership = await transaction.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: input.workspaceId,
          userId: input.userId,
        },
      },
      select: { role: true },
    });
    if (!membership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    requireIntegrationAdmin(membership.role);

    const prior = await transaction.idempotencyRecord.findUnique({
      where: {
        organizationId_key: {
          organizationId: input.workspaceId,
          key: command.clientOperationId,
        },
      },
      select: {
        actorUserId: true,
        command: true,
        requestHash: true,
        response: true,
        status: true,
      },
    });
    if (prior) {
      if (
        prior.actorUserId !== input.userId
        || prior.command !== SELECTION_COMMAND
        || prior.requestHash !== hash
      ) {
        throw new HttpProblem(
          409,
          "idempotency_conflict",
          "clientOperationId was already used for a different command.",
        );
      }
      const replay = prior.status === "COMPLETED"
        ? replayedSelectionResponse(prior.response)
        : null;
      if (!replay) {
        throw new HttpProblem(
          409,
          "idempotency_in_progress",
          "The prior Zotero selection is still being resolved. Refresh before retrying.",
        );
      }
      return replay;
    }

    const connection = await transaction.integrationConnection.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.workspaceId,
          id: input.connectionId,
        },
      },
      select: {
        id: true,
        provider: true,
        status: true,
        zoteroSelectionRevision: true,
        zoteroLibrariesConfiguredAt: true,
      },
    });
    if (!connection || connection.provider !== "ZOTERO") {
      throw new HttpProblem(
        404,
        "zotero_connection_not_found",
        "Zotero connection was not found.",
      );
    }
    if (connection.status !== "CONNECTED" && connection.status !== "DEGRADED") {
      throw new HttpProblem(
        409,
        "zotero_connection_inactive",
        "Reconnect Zotero before changing its library selection.",
      );
    }
    if (connection.zoteroSelectionRevision !== command.expectedSelectionRevision) {
      throw new HttpProblem(
        409,
        "zotero_selection_conflict",
        "The Zotero library selection changed. Refresh before retrying.",
      );
    }

    const currentLibraries = await transaction.zoteroLibrary.findMany({
      where: {
        organizationId: input.workspaceId,
        integrationConnectionId: input.connectionId,
      },
      orderBy: [{ libraryType: "asc" }, { zoteroLibraryId: "asc" }, { id: "asc" }],
      select: {
        id: true,
        isReadable: true,
        syncEnabled: true,
      },
    });
    const byId = new Map(currentLibraries.map((library) => [library.id, library]));
    for (const libraryId of command.selectedLibraryIds) {
      const library = byId.get(libraryId);
      if (!library) {
        throw new HttpProblem(
          400,
          "zotero_library_invalid",
          "A selected Zotero library does not belong to this connection.",
        );
      }
      if (!library.isReadable) {
        throw new HttpProblem(
          409,
          "zotero_library_unreadable",
          "A selected Zotero library is not currently readable.",
        );
      }
    }

    const selected = new Set(command.selectedLibraryIds);
    const exactSelection = currentLibraries.every(
      (library) => library.syncEnabled === selected.has(library.id),
    );
    const isNoop = exactSelection && connection.zoteroLibrariesConfiguredAt !== null;
    let selectionRevision = connection.zoteroSelectionRevision;
    let outcome: "applied" | "noop" = "noop";
    if (!isNoop) {
      if (connection.zoteroSelectionRevision >= MAX_SELECTION_REVISION) {
        throw new HttpProblem(
          409,
          "zotero_selection_revision_exhausted",
          "The Zotero library selection must be reinitialized.",
        );
      }
      const updatedConnection = await transaction.integrationConnection.updateMany({
        where: {
          organizationId: input.workspaceId,
          id: input.connectionId,
          provider: "ZOTERO",
          zoteroSelectionRevision: command.expectedSelectionRevision,
        },
        data: {
          zoteroSelectionRevision: { increment: 1 },
          zoteroLibrariesConfiguredAt: now,
        },
      });
      if (updatedConnection.count !== 1) {
        throw new HttpProblem(
          409,
          "zotero_selection_conflict",
          "The Zotero library selection changed. Refresh before retrying.",
        );
      }
      await transaction.zoteroLibrary.updateMany({
        where: {
          organizationId: input.workspaceId,
          integrationConnectionId: input.connectionId,
        },
        data: { syncEnabled: false },
      });
      if (command.selectedLibraryIds.length > 0) {
        await transaction.zoteroLibrary.updateMany({
          where: {
            organizationId: input.workspaceId,
            integrationConnectionId: input.connectionId,
            id: { in: command.selectedLibraryIds },
            isReadable: true,
          },
          data: { syncEnabled: true },
        });
      }
      selectionRevision += 1;
      outcome = "applied";
    }

    const libraries = await listLibrarySummaries(
      transaction,
      input.workspaceId,
      input.connectionId,
    );
    const response: ZoteroLibrarySelectionResponse = {
      outcome,
      selectionRevision,
      libraries,
    };
    await transaction.idempotencyRecord.create({
      data: {
        organizationId: input.workspaceId,
        actorUserId: input.userId,
        key: command.clientOperationId,
        command: SELECTION_COMMAND,
        requestHash: hash,
        response: jsonValue(response),
        status: "COMPLETED",
        completedAt: now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.workspaceId,
        actorUserId: input.userId,
        action: "zotero.libraries.selection_updated",
        entityType: "integration-connection",
        entityId: input.connectionId,
        requestId: input.requestId ?? command.clientOperationId,
        metadata: jsonValue({
          outcome,
          selectedCount: command.selectedLibraryIds.length,
          fromRevision: command.expectedSelectionRevision,
          toRevision: selectionRevision,
        }),
      },
    });
    return response;
  });
}

function providerClient(
  input: {
    organizationId: string;
    connectionId: string;
    accessToken: string;
    now: () => Date;
  },
  factory?: ZoteroLibraryServiceDependencies["providerClientFactory"],
): ZoteroLibraryDiscoveryClient {
  if (factory) return factory(input);
  return new ZoteroReadOnlyAdapter({
    now: input.now,
    credentialResolver: async (lookup) =>
      lookup.organizationId === input.organizationId
      && lookup.connectionId === input.connectionId
        ? { accessToken: input.accessToken }
        : null,
  });
}

function providerDelayUntil(meta: ZoteroResponseMeta, now: Date): Date | null {
  const candidates: number[] = [];
  if (meta.backoffSeconds !== undefined) {
    const backoffUntil = now.getTime() + meta.backoffSeconds * 1_000;
    if (!Number.isFinite(backoffUntil) || backoffUntil > 8_640_000_000_000_000) {
      throw invalidProviderResponse("Zotero returned an invalid Backoff interval.");
    }
    candidates.push(backoffUntil);
  }
  if (meta.retryAfterSeconds !== undefined) {
    const retryUntil = now.getTime() + meta.retryAfterSeconds * 1_000;
    if (!Number.isFinite(retryUntil) || retryUntil > 8_640_000_000_000_000) {
      throw invalidProviderResponse("Zotero returned an invalid Retry-After interval.");
    }
    candidates.push(retryUntil);
  }
  if (meta.retryAt !== undefined) {
    const parsed = Date.parse(meta.retryAt);
    if (Number.isFinite(parsed)) candidates.push(parsed);
  }
  const maximum = candidates.length > 0 ? Math.max(...candidates) : Number.NaN;
  return Number.isFinite(maximum)
    && maximum > now.getTime()
    && maximum <= 8_640_000_000_000_000
    ? new Date(maximum)
    : null;
}

function maximumDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function effectiveGroupPermission(
  access: ZoteroIdentityAccess,
  groupId: string,
): ZoteroPermissionSet | undefined {
  return access.groups?.[groupId] ?? access.groups?.all;
}

function invalidProviderResponse(message: string): ZoteroAdapterError {
  return new ZoteroAdapterError(message, {
    code: "zotero_bad_response",
    status: 502,
    retryable: true,
  });
}

function providerBackoffError(until: Date, now: Date): ZoteroAdapterError {
  const backoffSeconds = Math.max(
    1,
    Math.ceil((until.getTime() - now.getTime()) / 1_000),
  );
  return new ZoteroAdapterError("Zotero requested a provider-wide pause.", {
    code: "zotero_rate_limited",
    status: 429,
    retryable: true,
    backoffSeconds,
    retryAfterSeconds: backoffSeconds,
    retryAt: until.toISOString(),
  });
}

async function discoverProviderLibraries(
  client: ZoteroLibraryDiscoveryClient,
  input: { organizationId: string; connectionId: string; expectedUserId: string },
  now: Date,
): Promise<{
  identity: ZoteroIdentity;
  libraries: DiscoveredLibrary[];
  providerBackoffUntil: Date | null;
}> {
  const identityResponse = await client.getCurrentIdentity({
    organizationId: input.organizationId,
    connectionId: input.connectionId,
  });
  const identity = identityResponse.data;
  if (!validProviderLibraryId(identity.userId)) {
    throw invalidProviderResponse("Zotero returned an invalid user identifier.");
  }
  if (identity.userId !== input.expectedUserId) {
    throw new ZoteroAdapterError("The Zotero identity no longer matches this connection.", {
      code: "zotero_authentication_failed",
      status: 409,
      retryable: false,
    });
  }
  let providerBackoffUntil = providerDelayUntil(identityResponse.meta, now);
  const libraries: DiscoveredLibrary[] = [];
  if (readable(identity.access.user)) {
    libraries.push({
      libraryType: "USER",
      zoteroLibraryId: identity.userId,
      name: "My Library",
      permission: identity.access.user,
    });
  }

  const hasReadableGroups = Object.values(identity.access.groups ?? {}).some(readable);
  if (hasReadableGroups) {
    if (providerBackoffUntil && providerBackoffUntil.getTime() > now.getTime()) {
      throw providerBackoffError(providerBackoffUntil, now);
    }
    let start = 0;
    let totalResults: number | undefined;
    const seenGroupIds = new Set<string>();
    while (true) {
      if (start >= MAX_PROVIDER_GROUPS) {
        throw invalidProviderResponse("Zotero returned too many groups for one connection.");
      }
      const page = await client.listUserGroups({
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        userId: identity.userId,
        start,
        limit: GROUP_PAGE_SIZE,
      });
      providerBackoffUntil = maximumDate(
        providerBackoffUntil,
        providerDelayUntil(page.meta, now),
      );
      if (
        page.meta.totalResults === undefined
        || !Number.isSafeInteger(page.meta.totalResults)
        || page.meta.totalResults < 0
        || page.meta.totalResults > MAX_PROVIDER_GROUPS
      ) {
        throw invalidProviderResponse("Zotero returned invalid group result metadata.");
      }
      if (totalResults === undefined) totalResults = page.meta.totalResults;
      if (page.meta.totalResults !== totalResults) {
        throw invalidProviderResponse("Zotero changed the group result count during discovery.");
      }
      if (page.data.length > GROUP_PAGE_SIZE || start + page.data.length > totalResults) {
        throw invalidProviderResponse("Zotero returned an inconsistent group page.");
      }
      for (const group of page.data) {
        if (!validProviderLibraryId(group.id)) {
          throw invalidProviderResponse("Zotero returned an invalid group identifier.");
        }
        if (seenGroupIds.has(group.id)) {
          throw invalidProviderResponse("Zotero returned duplicate groups across pages.");
        }
        seenGroupIds.add(group.id);
        const groupPermission = effectiveGroupPermission(identity.access, group.id);
        if (!readable(groupPermission)) continue;
        libraries.push({
          libraryType: "GROUP",
          zoteroLibraryId: group.id,
          name: boundedNullableText(group.name, 500),
          permission: groupPermission,
        });
        if (libraries.length > MAX_DISCOVERED_LIBRARIES) {
          throw new HttpProblem(
            409,
            "zotero_library_limit_exceeded",
            `A Zotero connection may expose at most ${MAX_DISCOVERED_LIBRARIES} libraries.`,
          );
        }
      }

      const consumed = start + page.data.length;
      if (consumed === totalResults) {
        if (page.meta.nextPageUrl !== undefined) {
          throw invalidProviderResponse("Zotero returned a next group page beyond the result set.");
        }
        break;
      }
      if (providerBackoffUntil && providerBackoffUntil.getTime() > now.getTime()) {
        throw providerBackoffError(providerBackoffUntil, now);
      }
      if (page.data.length !== GROUP_PAGE_SIZE || !page.meta.nextPageUrl) {
        throw invalidProviderResponse("Zotero omitted a required group page.");
      }
      const nextUrl = new URL(page.meta.nextPageUrl);
      const rawNextStart = nextUrl.searchParams.get("start");
      if (!rawNextStart || !/^(0|[1-9][0-9]*)$/.test(rawNextStart)) {
        throw invalidProviderResponse("Zotero returned an invalid group page offset.");
      }
      const nextStart = Number(rawNextStart);
      if (!Number.isSafeInteger(nextStart) || nextStart !== start + GROUP_PAGE_SIZE) {
        throw invalidProviderResponse("Zotero returned an inconsistent group page offset.");
      }
      start = nextStart;
    }
  }

  return { identity, libraries, providerBackoffUntil };
}

function providerProblem(error: ZoteroAdapterError): HttpProblem {
  const messages: Record<string, string> = {
    zotero_invalid_request: "PaperPilot could not make a valid Zotero request.",
    zotero_credential_unavailable: "The Zotero credential is unavailable. Reconnect Zotero.",
    zotero_authentication_failed: "Zotero no longer accepts this connection. Reconnect Zotero.",
    zotero_forbidden: "This Zotero connection cannot read the requested libraries.",
    zotero_not_found: "The requested Zotero resource was not found.",
    zotero_rate_limited: "Zotero asked PaperPilot to wait before trying again.",
    zotero_timeout: "Zotero did not respond in time. Try again shortly.",
    zotero_unavailable: "Zotero is temporarily unavailable. Try again shortly.",
    zotero_bad_response: "Zotero returned an unexpected response. Try again shortly.",
    zotero_response_too_large: "Zotero returned more metadata than this operation can safely admit.",
  };
  return new HttpProblem(
    error.status,
    error.code,
    messages[error.code] ?? "PaperPilot could not refresh Zotero libraries.",
  );
}

function errorDelayUntil(error: ZoteroAdapterError, now: Date): Date | null {
  return providerDelayUntil({
    retrievedAt: now.toISOString(),
    providerStatus: error.providerStatus ?? error.status,
    backoffSeconds: error.backoffSeconds,
    retryAfterSeconds: error.retryAfterSeconds,
    retryAt: error.retryAt,
  }, now);
}

async function recordProviderFailure(
  database: PrismaClient,
  input: {
    workspaceId: string;
    connectionId: string;
    expectedCredentialGeneration: number;
    expectedCredentialFingerprint: string | null;
    expectedCredentialKeyVersion: string | null;
  },
  error: ZoteroAdapterError,
  now: Date,
): Promise<void> {
  const attentionCode = sanitizedZoteroAttentionCode(error.code);
  const providerBackoffUntil = errorDelayUntil(error, now);
  if (!attentionCode && !providerBackoffUntil) return;
  await database.integrationConnection.updateMany({
    where: {
      organizationId: input.workspaceId,
      id: input.connectionId,
      provider: "ZOTERO",
      credentialGeneration: input.expectedCredentialGeneration,
      credentialFingerprint: input.expectedCredentialFingerprint,
      credentialKeyVersion: input.expectedCredentialKeyVersion,
    },
    data: {
      ...(attentionCode
        ? {
            status: "DEGRADED" as const,
            lastErrorCode: attentionCode,
            lastErrorMessage: null,
          }
        : {}),
      ...(providerBackoffUntil ? { providerBackoffUntil } : {}),
    },
  });
}

/** Reverify a key, enumerate its effective libraries, and atomically publish permissions. */
export async function discoverZoteroLibraries(
  input: DiscoverZoteroLibrariesInput,
  dependencies: ZoteroLibraryServiceDependencies = {},
): Promise<ZoteroLibraryDiscoveryResponse> {
  requireOpaqueId(input.userId, "userId");
  requireOpaqueId(input.workspaceId, "workspaceId");
  requireOpaqueId(input.connectionId, "connectionId");
  const database = dependencies.database ?? prisma;
  const clock = dependencies.now ?? (() => new Date());
  const now = normalizedNow(clock);

  const membership = await database.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.workspaceId,
        userId: input.userId,
      },
    },
    select: { role: true },
  });
  if (!membership) {
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }
  requireIntegrationAdmin(membership.role);

  const connection = await database.integrationConnection.findUnique({
    where: {
      organizationId_id: {
        organizationId: input.workspaceId,
        id: input.connectionId,
      },
    },
    select: {
      id: true,
      provider: true,
      status: true,
      externalAccountId: true,
      credentialCiphertext: true,
      credentialGeneration: true,
      credentialFingerprint: true,
      credentialKeyVersion: true,
      providerBackoffUntil: true,
    },
  });
  if (!connection || connection.provider !== "ZOTERO") {
    throw new HttpProblem(
      404,
      "zotero_connection_not_found",
      "Zotero connection was not found.",
    );
  }
  if (connection.status !== "CONNECTED" && connection.status !== "DEGRADED") {
    throw new HttpProblem(
      409,
      "zotero_connection_inactive",
      "Reconnect Zotero before refreshing libraries.",
    );
  }
  if (
    connection.providerBackoffUntil
    && connection.providerBackoffUntil.getTime() > now.getTime()
  ) {
    throw new HttpProblem(
      429,
      "zotero_rate_limited",
      "Zotero asked PaperPilot to wait before trying again.",
    );
  }
  if (
    !connection.externalAccountId
    || !validProviderLibraryId(connection.externalAccountId)
    || !connection.credentialCiphertext
    || !connection.credentialKeyVersion
  ) {
    const unavailable = new ZoteroAdapterError("The Zotero credential is unavailable.", {
      code: "zotero_credential_unavailable",
      status: 503,
      retryable: false,
    });
    await recordProviderFailure(database, {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      expectedCredentialGeneration: connection.credentialGeneration,
      expectedCredentialFingerprint: connection.credentialFingerprint,
      expectedCredentialKeyVersion: connection.credentialKeyVersion,
    }, unavailable, now);
    throw providerProblem(unavailable);
  }

  let accessToken: string;
  try {
    const protector = dependencies.credentialProtector
      ?? credentialProtectorFromEnvironment();
    accessToken = protector.reveal(
      Uint8Array.from(connection.credentialCiphertext),
      connection.credentialKeyVersion,
      {
        organizationId: input.workspaceId,
        provider: "ZOTERO",
        subjectId: input.connectionId,
      },
    );
  } catch {
    const unavailable = new ZoteroAdapterError("The Zotero credential is unavailable.", {
      code: "zotero_credential_unavailable",
      status: 503,
      retryable: false,
    });
    await recordProviderFailure(database, {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      expectedCredentialGeneration: connection.credentialGeneration,
      expectedCredentialFingerprint: connection.credentialFingerprint,
      expectedCredentialKeyVersion: connection.credentialKeyVersion,
    }, unavailable, now);
    throw providerProblem(unavailable);
  }

  let discovered: Awaited<ReturnType<typeof discoverProviderLibraries>>;
  try {
    const client = providerClient({
      organizationId: input.workspaceId,
      connectionId: input.connectionId,
      accessToken,
      now: clock,
    }, dependencies.providerClientFactory);
    discovered = await discoverProviderLibraries(client, {
      organizationId: input.workspaceId,
      connectionId: input.connectionId,
      expectedUserId: connection.externalAccountId,
    }, now);
  } catch (error) {
    if (error instanceof ZoteroAdapterError) {
      await recordProviderFailure(database, {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        expectedCredentialGeneration: connection.credentialGeneration,
        expectedCredentialFingerprint: connection.credentialFingerprint,
        expectedCredentialKeyVersion: connection.credentialKeyVersion,
      }, error, now);
      throw providerProblem(error);
    }
    throw error;
  }

  return runSerializableTransaction(database, async (transaction) => {
    await acquireWorkspaceMembershipAuthorityShared(
      transaction,
      input.workspaceId,
      input.userId,
    );
    const currentMembership = await transaction.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: input.workspaceId,
          userId: input.userId,
        },
      },
      select: { role: true },
    });
    if (!currentMembership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    requireIntegrationAdmin(currentMembership.role);

    const currentConnection = await transaction.integrationConnection.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.workspaceId,
          id: input.connectionId,
        },
      },
      select: {
        provider: true,
        status: true,
        externalAccountId: true,
        credentialGeneration: true,
        credentialFingerprint: true,
        credentialKeyVersion: true,
        lastErrorCode: true,
      },
    });
    if (!currentConnection || currentConnection.provider !== "ZOTERO") {
      throw new HttpProblem(
        404,
        "zotero_connection_not_found",
        "Zotero connection was not found.",
      );
    }
    if (
      (currentConnection.status !== "CONNECTED" && currentConnection.status !== "DEGRADED")
      || currentConnection.externalAccountId !== discovered.identity.userId
      || currentConnection.externalAccountId !== connection.externalAccountId
      || currentConnection.credentialGeneration !== connection.credentialGeneration
      || currentConnection.credentialFingerprint !== connection.credentialFingerprint
      || currentConnection.credentialKeyVersion !== connection.credentialKeyVersion
    ) {
      throw new HttpProblem(
        409,
        "zotero_connection_changed",
        "The Zotero connection changed during discovery. Refresh before retrying.",
      );
    }

    const existingLibraries = await transaction.zoteroLibrary.findMany({
      where: {
        organizationId: input.workspaceId,
        integrationConnectionId: input.connectionId,
      },
      select: { libraryType: true, zoteroLibraryId: true },
    });
    const retainedLibraryKeys = new Set(
      existingLibraries.map((library) =>
        `${library.libraryType}:${library.zoteroLibraryId}`),
    );
    for (const library of discovered.libraries) {
      retainedLibraryKeys.add(`${library.libraryType}:${library.zoteroLibraryId}`);
    }
    if (retainedLibraryKeys.size > MAX_DISCOVERED_LIBRARIES) {
      throw new HttpProblem(
        409,
        "zotero_library_limit_exceeded",
        `A Zotero connection may retain at most ${MAX_DISCOVERED_LIBRARIES} libraries.`,
      );
    }

    await transaction.zoteroLibrary.updateMany({
      where: {
        organizationId: input.workspaceId,
        integrationConnectionId: input.connectionId,
      },
      data: {
        isReadable: false,
        isWritable: false,
        fileAccessStatus: "UNAVAILABLE",
        accessLostAt: now,
        lastDiscoveredAt: now,
      },
    });
    for (const library of discovered.libraries) {
      await transaction.zoteroLibrary.upsert({
        where: {
          integrationConnectionId_libraryType_zoteroLibraryId: {
            integrationConnectionId: input.connectionId,
            libraryType: library.libraryType,
            zoteroLibraryId: library.zoteroLibraryId,
          },
        },
        update: {
          name: library.name,
          isReadable: true,
          isWritable: library.permission.write === true,
          fileAccessStatus: zoteroFileAccessStatusFromPermission(
            library.permission,
          ),
          accessLostAt: null,
          lastDiscoveredAt: now,
        },
        create: {
          organizationId: input.workspaceId,
          integrationConnectionId: input.connectionId,
          libraryType: library.libraryType,
          zoteroLibraryId: library.zoteroLibraryId,
          name: library.name,
          isReadable: true,
          isWritable: library.permission.write === true,
          fileAccessStatus: zoteroFileAccessStatusFromPermission(
            library.permission,
          ),
          accessLostAt: null,
          discoveredAt: now,
          lastDiscoveredAt: now,
          syncEnabled: false,
        },
      });
    }

    const preservedRevocationCode = REVOCATION_ATTENTION_CODES.has(
      currentConnection.lastErrorCode as never,
    )
      ? currentConnection.lastErrorCode
      : null;
    await transaction.integrationConnection.update({
      where: {
        organizationId_id: {
          organizationId: input.workspaceId,
          id: input.connectionId,
        },
      },
      data: {
        status: preservedRevocationCode ? "DEGRADED" : "CONNECTED",
        displayName: identityDisplayName(discovered.identity),
        scopes: jsonValue(discovered.identity.access),
        lastVerifiedAt: now,
        providerBackoffUntil: discovered.providerBackoffUntil,
        lastErrorCode: preservedRevocationCode,
        lastErrorMessage: null,
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.workspaceId,
        actorUserId: input.userId,
        action: "zotero.libraries.discovered",
        entityType: "integration-connection",
        entityId: input.connectionId,
        requestId: input.requestId,
        metadata: jsonValue({
          readableLibraryCount: discovered.libraries.length,
          personalLibraryReadable: discovered.libraries.some(
            (library) => library.libraryType === "USER",
          ),
          groupLibraryCount: discovered.libraries.filter(
            (library) => library.libraryType === "GROUP",
          ).length,
        }),
      },
    });

    return {
      discovered: true,
      libraries: await listLibrarySummaries(
        transaction,
        input.workspaceId,
        input.connectionId,
      ),
    };
  });
}
