import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  Prisma,
  PrismaClient,
  ZoteroOAuthAttempt,
} from "@/generated/prisma/client";
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
} from "./contracts";
import {
  listZoteroConnections,
  zoteroFileAccessStatusFromPermission,
  type ZoteroConnectionSummary,
  type ZoteroConnectionsResponse,
  type ZoteroLibrarySummary,
} from "./library-service";
import {
  zoteroCallbackUrlWithState,
  zoteroOAuthConfigurationFromEnvironment,
  type ZoteroOAuthServerConfiguration,
} from "./oauth-config";
import { ZoteroOAuthStateCodec } from "./oauth-state";
import {
  ZoteroOAuthClient,
  buildZoteroAuthorizationUrl,
} from "./oauth";
import {
  ZOTERO_API_ORIGIN,
  assertZoteroApiUrl,
} from "./protocol";

const ATTEMPT_BINDING_PROVIDER = "ZOTERO";
const REVOCATION_BINDING_PROVIDER = "ZOTERO_REVOCATION";
const MAX_HASH_INPUT_BYTES = 8 * 1024;
const MAX_PENDING_REVOCATION_CIPHERTEXT_BYTES = 96 * 1024;
const MAX_PENDING_REVOCATIONS_PER_CONNECTION = 1_000;
const STALE_ATTEMPT_CLEANUP_BATCH_SIZE = 100;
const TERMINAL_ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CLAIMED_ATTEMPT_STALE_MS = 15 * 60 * 1_000;
const PENDING_REVOCATION_RETRY_GRACE_MS = 30 * 1_000;
const MAX_REMOTE_REVOCATION_TIMEOUT_MS = 5_000;
const DEFAULT_REMOTE_REVOCATION_TIMEOUT_MS = 2_000;
const MAX_SERIALIZABLE_ATTEMPTS = 3;
const CRITICAL_AUDIT_WRITE_ATTEMPTS = 3;
const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const INTEGRATION_ADMIN_ROLES = new Set(["owner", "admin"]);
const REVOCATION_UNCONFIRMED_CODES = new Set([
  "remote_revocation_pending",
  "remote_revocation_unconfirmed",
  "previous_key_revocation_pending",
  "previous_key_revocation_unconfirmed",
]);

type PendingRevocationReason = "disconnect" | "superseded_key";

interface PendingRevocationEnvelope {
  id: string;
  binding: "connection" | "revocation";
  ciphertext: string;
  fingerprint: string;
  keyVersion: string;
  reason: PendingRevocationReason;
  requestedAt: string;
  status: "pending" | "processing";
  leaseId?: string;
  claimedAt?: string;
}

export type ZoteroOAuthScopeProfile =
  | "personal_metadata"
  | "personal_metadata_notes"
  | "personal_group_metadata"
  | "personal_group_metadata_notes";

const SCOPE_PROFILES: Readonly<
  Record<
    ZoteroOAuthScopeProfile,
    {
      libraryAccess: true;
      notesAccess: boolean;
      writeAccess: false;
      allGroups: "none" | "read";
    }
  >
> = {
  personal_metadata: {
    libraryAccess: true,
    notesAccess: false,
    writeAccess: false,
    allGroups: "none",
  },
  personal_metadata_notes: {
    libraryAccess: true,
    notesAccess: true,
    writeAccess: false,
    allGroups: "none",
  },
  personal_group_metadata: {
    libraryAccess: true,
    notesAccess: false,
    writeAccess: false,
    allGroups: "read",
  },
  personal_group_metadata_notes: {
    libraryAccess: true,
    notesAccess: true,
    writeAccess: false,
    allGroups: "read",
  },
};

export const DEFAULT_ZOTERO_OAUTH_SCOPE_PROFILE: ZoteroOAuthScopeProfile =
  "personal_metadata";

export interface ZoteroOAuthActor {
  userId: string;
  workspaceId: string;
  requestId?: string;
}

export interface StartZoteroOAuthInput extends ZoteroOAuthActor {
  scopeProfile?: ZoteroOAuthScopeProfile;
}

export interface StartedZoteroOAuth {
  authorizationUrl: string;
  expiresAt: string;
  scopeProfile: ZoteroOAuthScopeProfile;
}

export interface CompleteZoteroOAuthInput {
  userId: string;
  state: string;
  requestToken: string;
  verifier: string;
  requestId?: string;
}

export interface CompletedZoteroOAuth {
  connectionId: string;
  workspaceId: string;
}

export { listZoteroConnections };
export type {
  ZoteroConnectionSummary,
  ZoteroConnectionsResponse,
  ZoteroLibrarySummary,
};

interface VerifyAccessTokenInput {
  accessToken: string;
  organizationId: string;
  attemptId: string;
}

export interface ZoteroOAuthLifecycleDependencies {
  database?: PrismaClient;
  credentialProtector: CredentialProtector;
  oauthClient: Pick<
    ZoteroOAuthClient,
    "requestTemporaryCredentials" | "exchangeAccessToken"
  >;
  stateCodec: Pick<ZoteroOAuthStateCodec, "issue" | "verify">;
  stateHashSecret: string;
  callbackUrl: URL;
  verifyAccessToken: (input: VerifyAccessTokenInput) => Promise<ZoteroIdentity>;
  revokeAccessToken?: (accessToken: string) => Promise<boolean>;
  now?: () => Date;
  id?: () => string;
}

export class ZoteroOAuthCallbackError extends Error {
  readonly code = "zotero_oauth_callback_failed" as const;

  constructor() {
    super("PaperPilot could not complete the Zotero connection.");
    this.name = "ZoteroOAuthCallbackError";
  }
}

/** Signals that the only durable manual-cleanup record could not be written. */
export class ZoteroOAuthCriticalAuditError extends Error {
  readonly code = "zotero_oauth_critical_audit_failed" as const;

  constructor() {
    super("PaperPilot could not record required Zotero credential cleanup.");
    this.name = "ZoteroOAuthCriticalAuditError";
  }
}

function callbackFailure(): never {
  throw new ZoteroOAuthCallbackError();
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function requiredOpaqueId(value: unknown, label: string): asserts value is string {
  if (!validOpaqueId(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
}

function boundedHashInput(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_HASH_INPUT_BYTES
  );
}

function normalizedNow(clock: () => Date): Date {
  let now: Date;
  try {
    now = clock();
  } catch {
    throw new Error("The Zotero OAuth lifecycle clock failed.");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("The Zotero OAuth lifecycle clock returned an invalid time.");
  }
  return new Date(now.getTime());
}

function oauthHash(secret: string, domain: string, value: string): string {
  return createHmac("sha256", secret)
    .update("paperpilot:zotero-oauth:lifecycle:v1\0", "utf8")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

/** Workspace-wide credentials may only be managed by integration admins. */
export function requireWorkspaceIntegrationRole(role: string): void {
  if (!INTEGRATION_ADMIN_ROLES.has(role)) {
    throw new HttpProblem(
      403,
      "workspace_forbidden",
      "This workspace role cannot manage integrations.",
    );
  }
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function scopeRecord(profile: ZoteroOAuthScopeProfile) {
  return { profile, ...SCOPE_PROFILES[profile] };
}

function isScopeProfile(value: unknown): value is ZoteroOAuthScopeProfile {
  return typeof value === "string" && Object.hasOwn(SCOPE_PROFILES, value);
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function validPendingRevocation(value: unknown): value is PendingRevocationEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (
    !validOpaqueId(entry.id) ||
    (entry.binding !== "connection" && entry.binding !== "revocation") ||
    typeof entry.ciphertext !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(entry.ciphertext) ||
    Buffer.byteLength(entry.ciphertext, "utf8") >
      Math.ceil((MAX_PENDING_REVOCATION_CIPHERTEXT_BYTES * 4) / 3) ||
    typeof entry.fingerprint !== "string" ||
    !/^hmac-sha256:[a-f0-9]{64}$/.test(entry.fingerprint) ||
    typeof entry.keyVersion !== "string" ||
    !OPAQUE_ID_PATTERN.test(entry.keyVersion) ||
    (entry.reason !== "disconnect" && entry.reason !== "superseded_key") ||
    typeof entry.requestedAt !== "string" ||
    (entry.status !== undefined &&
      entry.status !== "pending" &&
      entry.status !== "processing")
  ) {
    return false;
  }
  const requestedAt = new Date(entry.requestedAt);
  if (Number.isNaN(requestedAt.getTime()) || requestedAt.toISOString() !== entry.requestedAt) {
    return false;
  }
  const status = entry.status ?? "pending";
  if (status === "pending") {
    return entry.leaseId === undefined && entry.claimedAt === undefined;
  }
  if (
    !validOpaqueId(entry.leaseId) ||
    typeof entry.claimedAt !== "string"
  ) {
    return false;
  }
  const claimedAt = new Date(entry.claimedAt);
  return !Number.isNaN(claimedAt.getTime()) && claimedAt.toISOString() === entry.claimedAt;
}

function pendingRevocationsFromConfiguration(
  configuration: unknown,
): PendingRevocationEnvelope[] {
  const raw = jsonObject(configuration).pendingRevocations;
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_PENDING_REVOCATIONS_PER_CONNECTION ||
    !raw.every(validPendingRevocation)
  ) {
    throw new Error("The Zotero pending-revocation envelope is invalid.");
  }
  return raw.map((entry) => ({
    ...entry,
    status: entry.status ?? "pending",
  }));
}

function hasUnrecoverableRevocationHandle(configuration: unknown): boolean {
  const value = jsonObject(configuration);
  return (
    value.unresolvedRevocationWithoutHandle === true ||
    (Array.isArray(value.unreadablePendingRevocations) &&
      value.unreadablePendingRevocations.length > 0) ||
    (value.unreadablePendingRevocations !== undefined &&
      !Array.isArray(value.unreadablePendingRevocations))
  );
}

function connectionConfiguration(
  existing: unknown,
  requestedScopes: unknown,
  pendingRevocations: readonly PendingRevocationEnvelope[],
): Prisma.InputJsonValue {
  const configuration = jsonObject(existing);
  configuration.requestedScopes = requestedScopes;
  if (pendingRevocations.length > 0) {
    configuration.pendingRevocations = pendingRevocations;
  } else {
    delete configuration.pendingRevocations;
  }
  return jsonValue(configuration);
}

function protectedPendingRevocation(
  input: {
    id: string;
    reason: PendingRevocationReason;
    requestedAt: Date;
  },
  protectedCredential: {
    ciphertext: Uint8Array;
    fingerprint: string;
    keyVersion: string;
  },
  binding: PendingRevocationEnvelope["binding"],
): PendingRevocationEnvelope {
  return {
    id: input.id,
    binding,
    ciphertext: Buffer.from(protectedCredential.ciphertext).toString("base64url"),
    fingerprint: protectedCredential.fingerprint,
    keyVersion: protectedCredential.keyVersion,
    reason: input.reason,
    requestedAt: input.requestedAt.toISOString(),
    status: "pending",
  };
}

function equalCredentialPlaintext(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function equalCredentialCiphertext(
  left: Uint8Array | null,
  right: Uint8Array,
): boolean {
  if (left === null || left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function revealPendingRevocation(
  protector: CredentialProtector,
  organizationId: string,
  connectionId: string,
  entry: PendingRevocationEnvelope,
): string {
  return protector.reveal(
    Buffer.from(entry.ciphertext, "base64url"),
    entry.keyVersion,
    {
      organizationId,
      provider:
        entry.binding === "revocation"
          ? REVOCATION_BINDING_PROVIDER
          : ATTEMPT_BINDING_PROVIDER,
      subjectId: entry.binding === "revocation" ? entry.id : connectionId,
    },
  );
}

function readablePermission(permission: ZoteroPermissionSet | undefined): boolean {
  return permission?.library === true;
}

function hasReadableLibrary(access: ZoteroIdentityAccess): boolean {
  if (readablePermission(access.user)) return true;
  return Object.values(access.groups ?? {}).some(readablePermission);
}

function requestedScopeProfile(value: unknown): ZoteroOAuthScopeProfile | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("profile" in value) ||
    !isScopeProfile(value.profile)
  ) {
    return null;
  }
  return value.profile;
}

function permissionHasAnyAccess(permission: ZoteroPermissionSet | undefined): boolean {
  return permission !== undefined && Object.values(permission).some((value) => value === true);
}

/**
 * Zotero's authorize options are editable defaults, so effective access must be
 * capped. A personal-library key legitimately reports `files: true` whenever
 * `library: true`; file retrieval is therefore governed by PaperPilot's
 * explicit attachment-import policy rather than treated as an excess OAuth
 * grant. A file capability without the corresponding readable library is not a
 * coherent provider permission and is rejected fail-closed.
 */
function effectiveAccessMatchesRequestedPolicy(
  access: ZoteroIdentityAccess,
  requestedScopes: unknown,
): boolean {
  const profile = requestedScopeProfile(requestedScopes);
  if (!profile) return false;
  const policy = SCOPE_PROFILES[profile];
  const permissions = [access.user, ...Object.values(access.groups ?? {})];
  if (permissions.some((permission) => permission?.write === true)) return false;
  if (
    permissions.some(
      (permission) => permission?.files === true && permission.library !== true,
    )
  ) {
    return false;
  }
  if (
    !policy.notesAccess &&
    permissions.some((permission) => permission?.notes === true)
  ) {
    return false;
  }
  if (
    policy.allGroups === "none" &&
    Object.values(access.groups ?? {}).some(permissionHasAnyAccess)
  ) {
    return false;
  }
  return true;
}

function displayName(identity: ZoteroIdentity): string {
  const value =
    identity.displayName ?? identity.username ?? `Zotero user ${identity.userId}`;
  return value.slice(0, 200);
}

function sanitizedFailureCode(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    /^[a-z0-9_:-]{1,100}$/.test(value.code)
  ) {
    return value.code;
  }
  return "oauth_callback_failed";
}

function retryableTransactionConflict(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value.code === "P2034" || value.code === "P2002")
  );
}

async function runSerializableTransaction<T>(
  database: PrismaClient,
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await database.$transaction(work, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      lastError = error;
      if (!retryableTransactionConflict(error) || attempt === MAX_SERIALIZABLE_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function recordCredentialPersistenceUncertain(
  database: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    attemptId: string;
    requestId?: string;
    reason: "ambiguous_commit" | "unattributed_exchanged_key";
  },
): Promise<void> {
  for (let attempt = 1; attempt <= CRITICAL_AUDIT_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await database.auditEvent.create({
        data: {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: "zotero.credential_persistence_uncertain",
          entityType: "zotero-oauth-attempt",
          entityId: input.attemptId,
          requestId: input.requestId,
          metadata: jsonValue({
            remoteRevocationSkipped: true,
            reason: input.reason,
          }),
        },
      });
      return;
    } catch {
      if (attempt === CRITICAL_AUDIT_WRITE_ATTEMPTS) {
        throw new ZoteroOAuthCriticalAuditError();
      }
    }
  }
}

async function recordRemoteRevocationUnconfirmed(
  database: PrismaClient,
  input: {
    organizationId: string;
    connectionId: string;
    requestId?: string;
    code:
      | "remote_revocation_pending"
      | "remote_revocation_unconfirmed"
      | "previous_key_revocation_pending"
      | "previous_key_revocation_unconfirmed";
    reason: "disconnect" | "superseded_key";
  },
): Promise<void> {
  await runSerializableTransaction(database, async (transaction) => {
    const current = await transaction.integrationConnection.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: input.connectionId,
        },
      },
      select: { status: true },
    });
    if (current) {
      await transaction.integrationConnection.update({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: input.connectionId,
          },
        },
        data: {
          status:
            current.status === "DISCONNECTED" || current.status === "REVOKED"
              ? current.status
              : "DEGRADED",
          lastErrorCode: input.code,
        },
      });
    }
    await transaction.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        action: "zotero.remote_revocation_unconfirmed",
        entityType: "integration-connection",
        entityId: input.connectionId,
        requestId: input.requestId,
        metadata: jsonValue({ reason: input.reason }),
      },
    });
  });
}

function revocationUnconfirmed(code: string | null): boolean {
  return code !== null && REVOCATION_UNCONFIRMED_CODES.has(code);
}

function revocationCode(
  reason: PendingRevocationReason,
  phase: "pending" | "unconfirmed",
):
  | "remote_revocation_pending"
  | "remote_revocation_unconfirmed"
  | "previous_key_revocation_pending"
  | "previous_key_revocation_unconfirmed" {
  if (reason === "disconnect") {
    return phase === "pending"
      ? "remote_revocation_pending"
      : "remote_revocation_unconfirmed";
  }
  return phase === "pending"
    ? "previous_key_revocation_pending"
    : "previous_key_revocation_unconfirmed";
}

async function confirmPendingRevocation(
  database: PrismaClient,
  input: {
    organizationId: string;
    connectionId: string;
    pendingRevocationId: string;
    leaseId: string;
    requestId?: string;
  },
): Promise<void> {
  await runSerializableTransaction(database, async (transaction) => {
    const connection = await transaction.integrationConnection.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: input.connectionId,
        },
      },
      select: {
        status: true,
        lastErrorCode: true,
        configuration: true,
        credentialCiphertext: true,
      },
    });
    if (!connection) return;
    const pending = pendingRevocationsFromConfiguration(connection.configuration);
    const confirmed = pending.find(
      (entry) =>
        entry.id === input.pendingRevocationId &&
        entry.status === "processing" &&
        entry.leaseId === input.leaseId,
    );
    if (!confirmed) return;
    const remaining = pending.filter((entry) => entry.id !== input.pendingRevocationId);
    const canClearWarning =
      remaining.length === 0 &&
      !hasUnrecoverableRevocationHandle(connection.configuration) &&
      revocationUnconfirmed(connection.lastErrorCode);
    const requestedScopes = jsonObject(connection.configuration).requestedScopes ?? {};
    await transaction.integrationConnection.update({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: input.connectionId,
        },
      },
      data: {
        configuration: connectionConfiguration(
          connection.configuration,
          requestedScopes,
          remaining,
        ),
        status:
          canClearWarning && connection.status === "DEGRADED" && connection.credentialCiphertext
            ? "CONNECTED"
            : connection.status,
        lastErrorCode: canClearWarning ? null : connection.lastErrorCode,
        lastErrorMessage: canClearWarning ? null : undefined,
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        action: "zotero.remote_revocation.confirmed",
        entityType: "integration-connection",
        entityId: input.connectionId,
        requestId: input.requestId,
        metadata: jsonValue({ reason: confirmed.reason }),
      },
    });
  });
}

async function processPendingRevocation(
  database: PrismaClient,
  protector: CredentialProtector,
  revokeAccessToken: (accessToken: string) => Promise<boolean>,
  input: {
    organizationId: string;
    connectionId: string;
    pendingRevocationId: string;
    requestId?: string;
  },
): Promise<{ attempted: boolean; confirmed: boolean }> {
  const leaseId = randomUUID();
  const claimedAt = new Date();
  const claim = await runSerializableTransaction(database, async (transaction) => {
    const connection = await transaction.integrationConnection.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: input.connectionId,
        },
      },
      select: {
        status: true,
        lastErrorCode: true,
        configuration: true,
        credentialCiphertext: true,
        credentialKeyVersion: true,
      },
    });
    if (!connection) return { status: "absent" as const };
    let pending: PendingRevocationEnvelope[];
    try {
      pending = pendingRevocationsFromConfiguration(connection.configuration);
    } catch {
      return { status: "unrecoverable" as const };
    }
    const index = pending.findIndex(
      (candidate) => candidate.id === input.pendingRevocationId,
    );
    if (index < 0) return { status: "absent" as const };
    const entry = pending[index];
    if (
      entry.status === "processing" &&
      new Date(entry.claimedAt!).getTime() >
        claimedAt.getTime() - PENDING_REVOCATION_RETRY_GRACE_MS
    ) {
      return { status: "busy" as const };
    }

    let accessToken: string;
    try {
      accessToken = revealPendingRevocation(
        protector,
        input.organizationId,
        input.connectionId,
        entry,
      );
      if (connection.credentialCiphertext && connection.credentialKeyVersion) {
        const currentToken = protector.reveal(
          connection.credentialCiphertext,
          connection.credentialKeyVersion,
          {
            organizationId: input.organizationId,
            provider: ATTEMPT_BINDING_PROVIDER,
            subjectId: input.connectionId,
          },
        );
        if (equalCredentialPlaintext(accessToken, currentToken)) {
          const remaining = pending.filter((candidate) => candidate.id !== entry.id);
          const canClearWarning =
            remaining.length === 0 &&
            !hasUnrecoverableRevocationHandle(connection.configuration) &&
            revocationUnconfirmed(connection.lastErrorCode);
          await transaction.integrationConnection.update({
            where: {
              organizationId_id: {
                organizationId: input.organizationId,
                id: input.connectionId,
              },
            },
            data: {
              configuration: connectionConfiguration(
                connection.configuration,
                jsonObject(connection.configuration).requestedScopes ?? {},
                remaining,
              ),
              status:
                canClearWarning && connection.status === "DEGRADED"
                  ? "CONNECTED"
                  : connection.status,
              lastErrorCode: canClearWarning ? null : connection.lastErrorCode,
              lastErrorMessage: canClearWarning ? null : undefined,
            },
          });
          await transaction.auditEvent.create({
            data: {
              organizationId: input.organizationId,
              action: "zotero.remote_revocation.cancelled_current",
              entityType: "integration-connection",
              entityId: input.connectionId,
              requestId: input.requestId,
              metadata: jsonValue({ reason: entry.reason }),
            },
          });
          return { status: "current" as const };
        }
      }
    } catch {
      return { status: "unrecoverable" as const, reason: entry.reason };
    }

    const processing: PendingRevocationEnvelope = {
      ...entry,
      status: "processing",
      leaseId,
      claimedAt: claimedAt.toISOString(),
    };
    pending[index] = processing;
    await transaction.integrationConnection.update({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: input.connectionId,
        },
      },
      data: {
        configuration: connectionConfiguration(
          connection.configuration,
          jsonObject(connection.configuration).requestedScopes ?? {},
          pending,
        ),
      },
    });
    return {
      status: "claimed" as const,
      accessToken,
      reason: entry.reason,
    };
  });

  if (claim.status === "absent" || claim.status === "current") {
    return { attempted: false, confirmed: true };
  }
  if (claim.status === "busy") {
    return { attempted: false, confirmed: false };
  }
  if (claim.status === "unrecoverable") {
    if (claim.reason) {
      await recordRemoteRevocationUnconfirmed(database, {
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        requestId: input.requestId,
        code: revocationCode(claim.reason, "unconfirmed"),
        reason: claim.reason,
      }).catch(() => undefined);
    }
    return { attempted: false, confirmed: false };
  }

  const revoked = await revokeAccessToken(claim.accessToken).catch(() => false);
  if (!revoked) {
    await runSerializableTransaction(database, async (transaction) => {
      const connection = await transaction.integrationConnection.findUnique({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: input.connectionId,
          },
        },
        select: { status: true, configuration: true },
      });
      if (!connection) return;
      const pending = pendingRevocationsFromConfiguration(connection.configuration);
      const index = pending.findIndex(
        (entry) =>
          entry.id === input.pendingRevocationId &&
          entry.status === "processing" &&
          entry.leaseId === leaseId,
      );
      if (index < 0) return;
      pending[index] = {
        ...pending[index],
        status: "pending",
        leaseId: undefined,
        claimedAt: undefined,
      };
      await transaction.integrationConnection.update({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: input.connectionId,
          },
        },
        data: {
          configuration: connectionConfiguration(
            connection.configuration,
            jsonObject(connection.configuration).requestedScopes ?? {},
            pending,
          ),
          status:
            connection.status === "DISCONNECTED" || connection.status === "REVOKED"
              ? connection.status
              : "DEGRADED",
          lastErrorCode: revocationCode(claim.reason, "unconfirmed"),
        },
      });
      await transaction.auditEvent.create({
        data: {
          organizationId: input.organizationId,
          action: "zotero.remote_revocation_unconfirmed",
          entityType: "integration-connection",
          entityId: input.connectionId,
          requestId: input.requestId,
          metadata: jsonValue({ reason: claim.reason }),
        },
      });
    }).catch(() => undefined);
    return { attempted: true, confirmed: false };
  }
  await confirmPendingRevocation(database, { ...input, leaseId }).catch(() => undefined);
  return { attempted: true, confirmed: true };
}

/** Bounded outbox delivery for crash-recovered or previously failed deletes. */
export async function retryPendingZoteroRevocations(
  input: {
    organizationId: string;
    credentialProtector: CredentialProtector;
    revokeAccessToken: (accessToken: string) => Promise<boolean>;
    requestId?: string;
    limit?: number;
    now?: Date;
  },
  database: PrismaClient = prisma,
): Promise<{ attempted: number; confirmed: number }> {
  requiredOpaqueId(input.organizationId, "organizationId");
  const limit = input.limit ?? 1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("The Zotero pending-revocation retry limit is invalid.");
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("The Zotero pending-revocation retry time is invalid.");
  }
  const connections = await database.integrationConnection.findMany({
    where: {
      organizationId: input.organizationId,
      provider: "ZOTERO",
      lastErrorCode: { in: [...REVOCATION_UNCONFIRMED_CODES] },
    },
    orderBy: { updatedAt: "asc" },
    take: Math.min(limit * 4, 40),
    select: { id: true, configuration: true, lastErrorCode: true },
  });
  let attempted = 0;
  let confirmed = 0;
  let delivered = 0;
  for (const connection of connections) {
    let pending: PendingRevocationEnvelope[];
    try {
      pending = pendingRevocationsFromConfiguration(connection.configuration);
    } catch {
      continue;
    }
    for (const entry of pending) {
      const requestedAt = new Date(entry.requestedAt).getTime();
      if (
        connection.lastErrorCode?.endsWith("_pending") &&
        requestedAt > now.getTime() - PENDING_REVOCATION_RETRY_GRACE_MS
      ) {
        continue;
      }
      if (delivered >= limit) return { attempted, confirmed };
      delivered += 1;
      const outcome = await processPendingRevocation(
        database,
        input.credentialProtector,
        input.revokeAccessToken,
        {
          organizationId: input.organizationId,
          connectionId: connection.id,
          pendingRevocationId: entry.id,
          requestId: input.requestId,
        },
      );
      if (outcome.attempted) attempted += 1;
      if (outcome.confirmed) confirmed += 1;
    }
  }
  return { attempted, confirmed };
}

/**
 * Bounded hygiene pass for abandoned temporary credentials and old terminal
 * attempts. It is safe to call from a scheduler; start() also invokes it for
 * the current tenant so an abandoned provider page does not retain a secret
 * indefinitely in an active workspace.
 */
export async function cleanupZoteroOAuthAttempts(
  database: PrismaClient = prisma,
  now: Date = new Date(),
  workspaceId?: string,
): Promise<{ expired: number; deleted: number }> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("The Zotero OAuth cleanup time is invalid.");
  }
  if (workspaceId !== undefined) requiredOpaqueId(workspaceId, "workspaceId");
  const terminalBefore = new Date(now.getTime() - TERMINAL_ATTEMPT_RETENTION_MS);
  const claimedBefore = new Date(now.getTime() - CLAIMED_ATTEMPT_STALE_MS);
  return runSerializableTransaction(database, async (transaction) => {
    const expiredIds = (
      await transaction.zoteroOAuthAttempt.findMany({
        where: {
          ...(workspaceId ? { organizationId: workspaceId } : {}),
          OR: [
            { status: "PENDING", expiresAt: { lte: now } },
            { status: "CLAIMED", claimedAt: { lte: claimedBefore } },
          ],
        },
        orderBy: { expiresAt: "asc" },
        take: STALE_ATTEMPT_CLEANUP_BATCH_SIZE,
        select: { id: true },
      })
    ).map(({ id }) => id);
    const expired = expiredIds.length
      ? await transaction.zoteroOAuthAttempt.updateMany({
          where: {
            id: { in: expiredIds },
            OR: [
              { status: "PENDING", expiresAt: { lte: now } },
              { status: "CLAIMED", claimedAt: { lte: claimedBefore } },
            ],
          },
          data: {
            status: "EXPIRED",
            failureCode: "oauth_attempt_expired",
            completedAt: now,
            requestTokenSecretCiphertext: null,
            requestTokenSecretKeyVersion: null,
          },
        })
      : { count: 0 };
    const terminalIds = (
      await transaction.zoteroOAuthAttempt.findMany({
        where: {
          ...(workspaceId ? { organizationId: workspaceId } : {}),
          status: { in: ["SUCCEEDED", "FAILED", "EXPIRED"] },
          completedAt: { lte: terminalBefore },
        },
        orderBy: { completedAt: "asc" },
        take: STALE_ATTEMPT_CLEANUP_BATCH_SIZE,
        select: { id: true },
      })
    ).map(({ id }) => id);
    const deleted = terminalIds.length
      ? await transaction.zoteroOAuthAttempt.deleteMany({
          where: { id: { in: terminalIds } },
        })
      : { count: 0 };
    return { expired: expired.count, deleted: deleted.count };
  });
}

function callbackUrlIsValid(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.pathname === "/api/integrations/zotero/oauth/callback" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export function parseZoteroOAuthScopeProfile(
  value: unknown,
): ZoteroOAuthScopeProfile {
  if (value === undefined) return DEFAULT_ZOTERO_OAUTH_SCOPE_PROFILE;
  if (!isScopeProfile(value)) {
    throw new HttpProblem(
      400,
      "validation",
      "The Zotero OAuth scope profile is invalid.",
    );
  }
  return value;
}

/** Resolve a callback tenant only after the state is bound to its session user. */
export async function workspaceIdForZoteroOAuthState(
  state: unknown,
  userId: unknown,
  stateHashSecret: string,
  database: PrismaClient = prisma,
): Promise<string | null> {
  if (
    !boundedHashInput(state) ||
    !validOpaqueId(userId) ||
    Buffer.byteLength(stateHashSecret ?? "", "utf8") < 32
  ) {
    return null;
  }
  const attempt = await database.zoteroOAuthAttempt.findUnique({
    where: { stateTokenHash: oauthHash(stateHashSecret, "state", state) },
    select: { organizationId: true, userId: true },
  });
  if (attempt?.userId !== userId) return null;
  return attempt.organizationId;
}

export interface DisconnectZoteroConnectionDependencies {
  database?: PrismaClient;
  credentialProtector?: CredentialProtector;
  revokeAccessToken?: (accessToken: string) => Promise<boolean>;
  now?: () => Date;
}

/**
 * Erases local credentials even when handshake or encryption configuration is
 * unavailable. Remote cleanup is attempted only when the old envelope can be
 * opened, and every unconfirmed case remains durable for manual follow-up.
 */
export async function disconnectZoteroConnection(
  input: ZoteroOAuthActor & { connectionId: string },
  dependencies: DisconnectZoteroConnectionDependencies = {},
): Promise<{ disconnected: true; remoteRevocationAttempted: boolean }> {
  requiredOpaqueId(input.userId, "userId");
  requiredOpaqueId(input.workspaceId, "workspaceId");
  requiredOpaqueId(input.connectionId, "connectionId");
  const database = dependencies.database ?? prisma;
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
  requireWorkspaceIntegrationRole(membership.role);

  const disconnectedAt = normalizedNow(dependencies.now ?? (() => new Date()));
  const localDisconnect = await runSerializableTransaction(
    database,
    async (transaction) => {
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
      requireWorkspaceIntegrationRole(currentMembership.role);
      const connection = await transaction.integrationConnection.findUnique({
        where: {
          organizationId_id: {
            organizationId: input.workspaceId,
            id: input.connectionId,
          },
        },
      });
      if (!connection || connection.provider !== "ZOTERO") {
        throw new HttpProblem(
          404,
          "zotero_connection_not_found",
          "Zotero connection was not found.",
        );
      }

      let credentialUnrecoverable = false;
      let configurationForUpdate: unknown = connection.configuration;
      let pendingRevocations: PendingRevocationEnvelope[];
      try {
        pendingRevocations = pendingRevocationsFromConfiguration(
          connection.configuration,
        );
      } catch {
        credentialUnrecoverable = true;
        const recoveredConfiguration = jsonObject(connection.configuration);
        recoveredConfiguration.unreadablePendingRevocations =
          recoveredConfiguration.pendingRevocations;
        delete recoveredConfiguration.pendingRevocations;
        configurationForUpdate = recoveredConfiguration;
        pendingRevocations = [];
      }
      const inheritedRevocationWarning = revocationUnconfirmed(
        connection.lastErrorCode,
      );
      if (
        inheritedRevocationWarning &&
        pendingRevocations.length === 0 &&
        !hasUnrecoverableRevocationHandle(configurationForUpdate)
      ) {
        const recoveredConfiguration = jsonObject(configurationForUpdate);
        recoveredConfiguration.unresolvedRevocationWithoutHandle = true;
        configurationForUpdate = recoveredConfiguration;
      }
      let pendingRevocationId: string | undefined;
      if (
        connection.credentialCiphertext &&
        connection.credentialFingerprint &&
        connection.credentialKeyVersion
      ) {
        pendingRevocationId = randomUUID();
        let pendingCredential: {
          ciphertext: Uint8Array;
          fingerprint: string;
          keyVersion: string;
        } = {
          ciphertext: Uint8Array.from(connection.credentialCiphertext),
          fingerprint: connection.credentialFingerprint,
          keyVersion: connection.credentialKeyVersion,
        };
        let pendingBinding: PendingRevocationEnvelope["binding"] = "connection";
        if (dependencies.credentialProtector) {
          try {
            const token = dependencies.credentialProtector.reveal(
              connection.credentialCiphertext,
              connection.credentialKeyVersion,
              {
                organizationId: input.workspaceId,
                provider: ATTEMPT_BINDING_PROVIDER,
                subjectId: connection.id,
              },
            );
            pendingCredential = dependencies.credentialProtector.protect(token, {
              organizationId: input.workspaceId,
              provider: REVOCATION_BINDING_PROVIDER,
              subjectId: pendingRevocationId,
            });
            pendingBinding = "revocation";
          } catch {
            credentialUnrecoverable = true;
          }
        } else {
          credentialUnrecoverable = true;
        }
        const pending = protectedPendingRevocation(
          {
            id: pendingRevocationId,
            reason: "disconnect",
            requestedAt: disconnectedAt,
          },
          pendingCredential,
          pendingBinding,
        );
        if (pendingRevocations.length < MAX_PENDING_REVOCATIONS_PER_CONNECTION) {
          pendingRevocations.push(pending);
        } else {
          credentialUnrecoverable = true;
          const overflowConfiguration = jsonObject(configurationForUpdate);
          overflowConfiguration.unreadablePendingRevocations = [
            ...(Array.isArray(overflowConfiguration.unreadablePendingRevocations)
              ? overflowConfiguration.unreadablePendingRevocations
              : []),
            pending,
          ];
          configurationForUpdate = overflowConfiguration;
          pendingRevocationId = undefined;
        }
      }

      const requestedScopes =
        jsonObject(configurationForUpdate).requestedScopes ?? {};
      const credentialTupleChanged =
        connection.credentialCiphertext !== null
        || connection.credentialFingerprint !== null
        || connection.credentialKeyVersion !== null
        || connection.credentialExpiresAt !== null;

      const updated = await transaction.integrationConnection.updateMany({
        where: {
          id: input.connectionId,
          organizationId: input.workspaceId,
          provider: "ZOTERO",
        },
        data: {
          status: "DISCONNECTED",
          credentialCiphertext: null,
          credentialFingerprint: null,
          credentialKeyVersion: null,
          credentialExpiresAt: null,
          ...(credentialTupleChanged
            ? { credentialGeneration: { increment: 1 } }
            : {}),
          revokedAt: disconnectedAt,
          configuration: connectionConfiguration(
            configurationForUpdate,
            requestedScopes,
            pendingRevocations,
          ),
          lastErrorCode: credentialUnrecoverable
            ? "remote_revocation_unconfirmed"
            : inheritedRevocationWarning
              ? connection.lastErrorCode
              : pendingRevocationId
                ? "remote_revocation_pending"
                : null,
          lastErrorMessage: null,
        },
      });
      if (updated.count !== 1) {
        throw new HttpProblem(
          404,
          "zotero_connection_not_found",
          "Zotero connection was not found.",
        );
      }
      await transaction.zoteroLibrary.updateMany({
        where: {
          organizationId: input.workspaceId,
          integrationConnectionId: input.connectionId,
        },
        data: { syncEnabled: false },
      });
      await transaction.auditEvent.create({
        data: {
          organizationId: input.workspaceId,
          actorUserId: input.userId,
          action: "zotero.disconnected",
          entityType: "integration-connection",
          entityId: input.connectionId,
          requestId: input.requestId,
          metadata: jsonValue({
            remoteRevocationScheduled: Boolean(pendingRevocationId),
            remoteRevocationUnconfirmed:
              credentialUnrecoverable || inheritedRevocationWarning,
          }),
        },
      });
      return { pendingRevocationId };
    },
  );

  let remoteRevocationAttempted = false;
  if (
    localDisconnect.pendingRevocationId &&
    dependencies.credentialProtector &&
    dependencies.revokeAccessToken
  ) {
    const outcome = await processPendingRevocation(
      database,
      dependencies.credentialProtector,
      dependencies.revokeAccessToken,
      {
        organizationId: input.workspaceId,
        connectionId: input.connectionId,
        pendingRevocationId: localDisconnect.pendingRevocationId,
        requestId: input.requestId,
      },
    );
    remoteRevocationAttempted = outcome.attempted;
  }
  return {
    disconnected: true,
    remoteRevocationAttempted,
  };
}

export class ZoteroOAuthLifecycleService {
  private readonly database: PrismaClient;
  private readonly credentialProtector: CredentialProtector;
  private readonly oauthClient: ZoteroOAuthLifecycleDependencies["oauthClient"];
  private readonly stateCodec: ZoteroOAuthLifecycleDependencies["stateCodec"];
  private readonly stateHashSecret: string;
  private readonly callbackUrl: URL;
  private readonly verifyAccessToken: ZoteroOAuthLifecycleDependencies["verifyAccessToken"];
  private readonly revokeAccessToken: (accessToken: string) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(dependencies: ZoteroOAuthLifecycleDependencies) {
    if (Buffer.byteLength(dependencies.stateHashSecret ?? "", "utf8") < 32) {
      throw new Error("The Zotero OAuth lifecycle hash secret must contain at least 32 bytes.");
    }
    const callbackUrl = new URL(dependencies.callbackUrl.toString());
    if (!callbackUrlIsValid(callbackUrl)) {
      throw new Error("The Zotero OAuth lifecycle callback URL is invalid.");
    }
    this.database = dependencies.database ?? prisma;
    this.credentialProtector = dependencies.credentialProtector;
    this.oauthClient = dependencies.oauthClient;
    this.stateCodec = dependencies.stateCodec;
    this.stateHashSecret = dependencies.stateHashSecret;
    this.callbackUrl = callbackUrl;
    this.verifyAccessToken = dependencies.verifyAccessToken;
    this.revokeAccessToken = dependencies.revokeAccessToken ?? (async () => false);
    this.now = dependencies.now ?? (() => new Date());
    this.id = dependencies.id ?? randomUUID;
  }

  async start(input: StartZoteroOAuthInput): Promise<StartedZoteroOAuth> {
    requiredOpaqueId(input.userId, "userId");
    requiredOpaqueId(input.workspaceId, "workspaceId");
    const scopeProfile = parseZoteroOAuthScopeProfile(input.scopeProfile);
    await this.requireMutationMembership(input.userId, input.workspaceId);
    const startedAt = normalizedNow(this.now);
    await cleanupZoteroOAuthAttempts(
      this.database,
      startedAt,
      input.workspaceId,
    );
    await retryPendingZoteroRevocations(
      {
        organizationId: input.workspaceId,
        credentialProtector: this.credentialProtector,
        revokeAccessToken: this.revokeAccessToken,
        requestId: input.requestId,
        limit: 1,
        now: startedAt,
      },
      this.database,
    ).catch(() => undefined);

    const issuedState = this.stateCodec.issue({
      userId: input.userId,
      organizationId: input.workspaceId,
    });
    const callback = zoteroCallbackUrlWithState(
      { callbackUrl: this.callbackUrl },
      issuedState.token,
    );
    const temporary = await this.oauthClient.requestTemporaryCredentials(callback);
    const attemptId = this.id();
    requiredOpaqueId(attemptId, "OAuth attempt ID");
    const protectedSecret = this.credentialProtector.protect(
      temporary.requestTokenSecret,
      {
        organizationId: input.workspaceId,
        provider: ATTEMPT_BINDING_PROVIDER,
        subjectId: attemptId,
      },
    );
    const requestedScopes = scopeRecord(scopeProfile);
    const expiresAt = new Date(issuedState.claims.expiresAt * 1_000);

    await this.database.$transaction(async (transaction) => {
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
      requireWorkspaceIntegrationRole(membership.role);

      await transaction.zoteroOAuthAttempt.create({
        data: {
          id: attemptId,
          organizationId: input.workspaceId,
          userId: input.userId,
          stateTokenHash: this.hash("state", issuedState.token),
          stateNonceHash: this.hash("nonce", issuedState.claims.nonce),
          requestTokenHash: this.hash("request-token", temporary.requestToken),
          requestTokenSecretCiphertext: Uint8Array.from(protectedSecret.ciphertext),
          requestTokenSecretKeyVersion: protectedSecret.keyVersion,
          callbackUrlHash: this.hash("callback", callback.toString()),
          requestedScopes: jsonValue(requestedScopes),
          expiresAt,
        },
      });
      await transaction.auditEvent.create({
        data: {
          organizationId: input.workspaceId,
          actorUserId: input.userId,
          action: "zotero.oauth.started",
          entityType: "zotero-oauth-attempt",
          entityId: attemptId,
          requestId: input.requestId,
          metadata: jsonValue({ scopeProfile, expiresAt: expiresAt.toISOString() }),
        },
      });
    });

    const authorizationUrl = buildZoteroAuthorizationUrl(
      temporary.requestToken,
      {
        name: "PaperPilot inbound metadata",
        libraryAccess: requestedScopes.libraryAccess,
        notesAccess: requestedScopes.notesAccess,
        writeAccess: requestedScopes.writeAccess,
        allGroups: requestedScopes.allGroups,
      },
    );
    return {
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: expiresAt.toISOString(),
      scopeProfile,
    };
  }

  async workspaceIdForState(
    state: unknown,
    userId: unknown,
  ): Promise<string | null> {
    return workspaceIdForZoteroOAuthState(
      state,
      userId,
      this.stateHashSecret,
      this.database,
    );
  }

  async complete(
    input: CompleteZoteroOAuthInput,
  ): Promise<CompletedZoteroOAuth> {
    if (
      !validOpaqueId(input.userId) ||
      !boundedHashInput(input.state) ||
      !boundedHashInput(input.requestToken) ||
      !boundedHashInput(input.verifier)
    ) {
      callbackFailure();
    }

    const stateTokenHash = this.hash("state", input.state);
    const attempt = await this.database.zoteroOAuthAttempt.findUnique({
      where: { stateTokenHash },
    });
    if (!attempt) callbackFailure();

    let stateBoundToActor = false;
    let terminalStatusHandled = false;
    let unpersistedAccessToken: string | undefined;
    let unpersistedAccessTokenFingerprint: string | undefined;
    try {
      if (attempt.userId !== input.userId) callbackFailure();
      stateBoundToActor = true;

      const now = normalizedNow(this.now);
      if (attempt.expiresAt.getTime() <= now.getTime()) {
        await this.finishPendingAttempt(attempt, "EXPIRED", "oauth_attempt_expired", now);
        terminalStatusHandled = true;
        callbackFailure();
      }

      const claims = this.stateCodec.verify(input.state, {
        userId: input.userId,
        organizationId: attempt.organizationId,
      });

      const expectedCallback = zoteroCallbackUrlWithState(
        { callbackUrl: this.callbackUrl },
        input.state,
      ).toString();
      if (
        !equalHash(attempt.stateTokenHash, stateTokenHash) ||
        !equalHash(
          attempt.stateNonceHash,
          this.hash("nonce", claims.nonce),
        ) ||
        !equalHash(
          attempt.callbackUrlHash,
          this.hash("callback", expectedCallback),
        ) ||
        attempt.expiresAt.getTime() !== claims.expiresAt * 1_000
      ) {
        callbackFailure();
      }

      if (
        !equalHash(
          attempt.requestTokenHash,
          this.hash("request-token", input.requestToken),
        )
      ) {
        await this.finishPendingAttempt(attempt, "FAILED", "oauth_token_mismatch", now);
        terminalStatusHandled = true;
        callbackFailure();
      }

      if (
        attempt.status !== "PENDING" ||
        !attempt.requestTokenSecretCiphertext ||
        !attempt.requestTokenSecretKeyVersion
      ) {
        // A replay or concurrent loser must never be able to change the state
        // of the callback that already won the one-time claim.
        terminalStatusHandled = true;
        callbackFailure();
      }

      const claimWon = await this.serializableTransaction(async (transaction) => {
        await acquireWorkspaceMembershipAuthorityShared(
          transaction,
          attempt.organizationId,
          input.userId,
        );
        const membership = await transaction.member.findUnique({
          where: {
            organizationId_userId: {
              organizationId: attempt.organizationId,
              userId: input.userId,
            },
          },
          select: { role: true },
        });
        if (!membership) callbackFailure();
        requireWorkspaceIntegrationRole(membership.role);

        const claimed = await transaction.zoteroOAuthAttempt.updateMany({
          where: {
            id: attempt.id,
            organizationId: attempt.organizationId,
            userId: input.userId,
            status: "PENDING",
            claimedAt: null,
            stateTokenHash,
            stateNonceHash: attempt.stateNonceHash,
            requestTokenHash: attempt.requestTokenHash,
            callbackUrlHash: attempt.callbackUrlHash,
            expiresAt: { gt: now },
          },
          data: {
            status: "CLAIMED",
            claimedAt: now,
            requestTokenSecretCiphertext: null,
            requestTokenSecretKeyVersion: null,
          },
        });
        if (claimed.count !== 1) return false;
        await transaction.auditEvent.create({
          data: {
            organizationId: attempt.organizationId,
            actorUserId: input.userId,
            action: "zotero.oauth.claimed",
            entityType: "zotero-oauth-attempt",
            entityId: attempt.id,
            requestId: input.requestId,
          },
        });
        return true;
      });
      if (!claimWon) {
        terminalStatusHandled = true;
        callbackFailure();
      }

      const requestTokenSecret = this.credentialProtector.reveal(
        attempt.requestTokenSecretCiphertext,
        attempt.requestTokenSecretKeyVersion,
        {
          organizationId: attempt.organizationId,
          provider: ATTEMPT_BINDING_PROVIDER,
          subjectId: attempt.id,
        },
      );
      const access = await this.oauthClient.exchangeAccessToken({
        requestToken: input.requestToken,
        requestTokenSecret,
        verifier: input.verifier,
      });
      unpersistedAccessToken = access.accessToken;
      unpersistedAccessTokenFingerprint =
        this.credentialProtector.fingerprint(access.accessToken);
      const identity = await this.verifyAccessToken({
        accessToken: access.accessToken,
        organizationId: attempt.organizationId,
        attemptId: attempt.id,
      });
      if (
        identity.userId !== access.userId ||
        !hasReadableLibrary(identity.access) ||
        !effectiveAccessMatchesRequestedPolicy(
          identity.access,
          attempt.requestedScopes,
        )
      ) {
        callbackFailure();
      }

      const persisted = await this.persistConnection({
        attempt,
        actorUserId: input.userId,
        requestId: input.requestId,
        accessToken: access.accessToken,
        identity,
        completedAt: normalizedNow(this.now),
      });
      unpersistedAccessToken = undefined;
      unpersistedAccessTokenFingerprint = undefined;
      if (persisted.pendingRevocationId) {
        await processPendingRevocation(
          this.database,
          this.credentialProtector,
          this.revokeAccessToken,
          {
            organizationId: attempt.organizationId,
            connectionId: persisted.connectionId,
            pendingRevocationId: persisted.pendingRevocationId,
            requestId: input.requestId,
          },
        );
      }
      return {
        connectionId: persisted.connectionId,
        workspaceId: attempt.organizationId,
      };
    } catch (error) {
      let persistenceOutcome: "not_persisted" | "unknown" = "not_persisted";
      if (unpersistedAccessToken && unpersistedAccessTokenFingerprint) {
        const reconciliation = await this.reconcilePersistenceOutcome(
          attempt,
          unpersistedAccessTokenFingerprint,
        );
        if (reconciliation.status === "succeeded") {
          return {
            connectionId: reconciliation.connectionId,
            workspaceId: attempt.organizationId,
          };
        }
        persistenceOutcome = reconciliation.status;
      }
      if (stateBoundToActor && !terminalStatusHandled) {
        await this.failAttemptBestEffort(
          attempt,
          sanitizedFailureCode(error),
          normalizedNow(this.now),
        );
      }
      if (unpersistedAccessToken && persistenceOutcome === "not_persisted") {
        // A negative database scan cannot authorize DELETE: another workspace
        // may commit the same provider-global key immediately after the scan.
        // Without a global persistence/revocation lock, retain no plaintext and
        // require audited manual cleanup instead of risking a live credential.
        await recordCredentialPersistenceUncertain(this.database, {
          organizationId: attempt.organizationId,
          actorUserId: input.userId,
          attemptId: attempt.id,
          requestId: input.requestId,
          reason: "unattributed_exchanged_key",
        });
      } else if (unpersistedAccessToken && persistenceOutcome === "unknown") {
        await recordCredentialPersistenceUncertain(this.database, {
          organizationId: attempt.organizationId,
          actorUserId: input.userId,
          attemptId: attempt.id,
          requestId: input.requestId,
          reason: "ambiguous_commit",
        });
      }
      if (error instanceof ZoteroOAuthCallbackError) throw error;
      callbackFailure();
    }
  }

  async list(
    userId: string,
    workspaceId: string,
  ): Promise<ZoteroConnectionsResponse> {
    return listZoteroConnections(userId, workspaceId, this.database);
  }

  async disconnect(input: ZoteroOAuthActor & { connectionId: string }): Promise<{
    disconnected: true;
    remoteRevocationAttempted: boolean;
  }> {
    return disconnectZoteroConnection(input, {
      database: this.database,
      credentialProtector: this.credentialProtector,
      revokeAccessToken: this.revokeAccessToken,
      now: this.now,
    });
  }

  private hash(
    domain: "state" | "nonce" | "request-token" | "callback",
    value: string,
  ): string {
    return oauthHash(this.stateHashSecret, domain, value);
  }

  private async requireMembership(userId: string, workspaceId: string) {
    const membership = await this.database.member.findUnique({
      where: {
        organizationId_userId: { organizationId: workspaceId, userId },
      },
      select: { role: true },
    });
    if (!membership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    return membership;
  }

  private async requireMutationMembership(userId: string, workspaceId: string) {
    const membership = await this.requireMembership(userId, workspaceId);
    requireWorkspaceIntegrationRole(membership.role);
    return membership;
  }

  private async finishPendingAttempt(
    attempt: ZoteroOAuthAttempt,
    status: "FAILED" | "EXPIRED",
    failureCode: string,
    completedAt: Date,
  ): Promise<void> {
    await this.database.zoteroOAuthAttempt.updateMany({
      where: {
        id: attempt.id,
        organizationId: attempt.organizationId,
        status: "PENDING",
      },
      data: {
        status,
        failureCode,
        completedAt,
        requestTokenSecretCiphertext: null,
        requestTokenSecretKeyVersion: null,
      },
    });
  }

  private async failAttemptBestEffort(
    attempt: ZoteroOAuthAttempt,
    failureCode: string,
    completedAt: Date,
  ): Promise<void> {
    await this.database.zoteroOAuthAttempt.updateMany({
      where: {
        id: attempt.id,
        organizationId: attempt.organizationId,
        status: { in: ["PENDING", "CLAIMED"] },
      },
      data: {
        status: "FAILED",
        failureCode,
        completedAt,
        requestTokenSecretCiphertext: null,
        requestTokenSecretKeyVersion: null,
      },
    }).catch(() => undefined);
  }

  /**
   * PostgreSQL can commit while the client loses the COMMIT acknowledgement.
   * Reconcile the durable attempt and fingerprint before deciding that an
   * issued provider key is safe to revoke.
   */
  private async reconcilePersistenceOutcome(
    attempt: ZoteroOAuthAttempt,
    accessTokenFingerprint: string,
  ): Promise<
    | { status: "succeeded"; connectionId: string }
    | { status: "not_persisted" }
    | { status: "unknown" }
  > {
    try {
      const durableAttempt = await this.database.zoteroOAuthAttempt.findUnique({
        where: { id: attempt.id },
        select: { status: true, integrationConnectionId: true },
      });
      // Membership deletion cascades attempts but intentionally does not erase
      // the durable connection. Absence therefore cannot prove rollback.
      if (!durableAttempt) return { status: "unknown" };
      if (durableAttempt.status !== "SUCCEEDED") {
        return { status: "not_persisted" };
      }
      if (!durableAttempt.integrationConnectionId) return { status: "unknown" };
      const connection = await this.database.integrationConnection.findUnique({
        where: {
          organizationId_id: {
            organizationId: attempt.organizationId,
            id: durableAttempt.integrationConnectionId,
          },
        },
        select: { credentialFingerprint: true, configuration: true },
      });
      if (!connection) return { status: "unknown" };
      let pendingFingerprints: string[] = [];
      try {
        pendingFingerprints = pendingRevocationsFromConfiguration(
          connection.configuration,
        ).map((entry) => entry.fingerprint);
      } catch {
        return { status: "unknown" };
      }
      if (
        connection.credentialFingerprint === accessTokenFingerprint ||
        pendingFingerprints.includes(accessTokenFingerprint)
      ) {
        return {
          status: "succeeded",
          connectionId: durableAttempt.integrationConnectionId,
        };
      }
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  private async persistConnection(input: {
    attempt: ZoteroOAuthAttempt;
    actorUserId: string;
    requestId?: string;
    accessToken: string;
    identity: ZoteroIdentity;
    completedAt: Date;
  }): Promise<{ connectionId: string; pendingRevocationId?: string }> {
    return this.serializableTransaction(async (transaction) => {
      const claimedAttempt = await transaction.zoteroOAuthAttempt.findFirst({
        where: {
          id: input.attempt.id,
          organizationId: input.attempt.organizationId,
          userId: input.actorUserId,
          status: "CLAIMED",
        },
        select: { id: true, requestedScopes: true },
      });
      if (!claimedAttempt) callbackFailure();
      if (!effectiveAccessMatchesRequestedPolicy(
        input.identity.access,
        claimedAttempt.requestedScopes,
      )) {
        callbackFailure();
      }
      await acquireWorkspaceMembershipAuthorityShared(
        transaction,
        input.attempt.organizationId,
        input.actorUserId,
      );
      const membership = await transaction.member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: input.attempt.organizationId,
            userId: input.actorUserId,
          },
        },
        select: { role: true },
      });
      if (!membership) callbackFailure();
      requireWorkspaceIntegrationRole(membership.role);

      const connection = await transaction.integrationConnection.upsert({
        where: {
          organizationId_provider_externalAccountId: {
            organizationId: input.attempt.organizationId,
            provider: "ZOTERO",
            externalAccountId: input.identity.userId,
          },
        },
        update: {},
        create: {
          id: this.id(),
          organizationId: input.attempt.organizationId,
          provider: "ZOTERO",
          authType: "OAUTH1",
          status: "PENDING",
          externalAccountId: input.identity.userId,
          createdById: input.actorUserId,
        },
        select: {
          id: true,
          credentialCiphertext: true,
          credentialFingerprint: true,
          credentialKeyVersion: true,
          credentialExpiresAt: true,
          credentialGeneration: true,
          lastErrorCode: true,
          configuration: true,
        },
      });
      const protectedAccessToken = this.credentialProtector.protect(
        input.accessToken,
        {
          organizationId: input.attempt.organizationId,
          provider: ATTEMPT_BINDING_PROVIDER,
          subjectId: connection.id,
        },
      );
      let pendingRevocations = pendingRevocationsFromConfiguration(
        connection.configuration,
      );
      const pendingBeforeReconciliation = pendingRevocations.length;
      let cancelledCurrentRevocation = false;
      const reconciledPending: PendingRevocationEnvelope[] = [];
      for (const pending of pendingRevocations) {
        const pendingToken = revealPendingRevocation(
          this.credentialProtector,
          input.attempt.organizationId,
          connection.id,
          pending,
        );
        if (equalCredentialPlaintext(pendingToken, input.accessToken)) {
          // A claimed worker may already be deleting this provider key. The
          // serializable row update makes either its claim or this reconnect
          // win; installing a token after the claim is forbidden.
          if (pending.status === "processing") callbackFailure();
          cancelledCurrentRevocation = true;
          continue;
        }
        reconciledPending.push(pending);
      }
      pendingRevocations = reconciledPending;
      let pendingRevocationId: string | undefined;
      if (
        connection.credentialCiphertext &&
        connection.credentialFingerprint &&
        connection.credentialKeyVersion &&
        connection.credentialFingerprint !== protectedAccessToken.fingerprint
      ) {
        if (pendingRevocations.length >= MAX_PENDING_REVOCATIONS_PER_CONNECTION) {
          throw new Error("The Zotero pending-revocation queue is full.");
        }
        const previousAccessToken = this.credentialProtector.reveal(
          connection.credentialCiphertext,
          connection.credentialKeyVersion,
          {
            organizationId: input.attempt.organizationId,
            provider: ATTEMPT_BINDING_PROVIDER,
            subjectId: connection.id,
          },
        );
        if (!equalCredentialPlaintext(previousAccessToken, input.accessToken)) {
          pendingRevocationId = this.id();
          requiredOpaqueId(pendingRevocationId, "pending revocation ID");
          const protectedPreviousAccessToken = this.credentialProtector.protect(
            previousAccessToken,
            {
              organizationId: input.attempt.organizationId,
              provider: REVOCATION_BINDING_PROVIDER,
              subjectId: pendingRevocationId,
            },
          );
          pendingRevocations.push(
            protectedPendingRevocation(
              {
                id: pendingRevocationId,
                reason: "superseded_key",
                requestedAt: input.completedAt,
              },
              protectedPreviousAccessToken,
              "revocation",
            ),
          );
        }
      }
      const hadInheritedRevocationWarning = revocationUnconfirmed(
        connection.lastErrorCode,
      );
      let configurationForUpdate: unknown = connection.configuration;
      if (
        hadInheritedRevocationWarning &&
        pendingBeforeReconciliation === 0 &&
        !hasUnrecoverableRevocationHandle(connection.configuration)
      ) {
        const configuration = jsonObject(connection.configuration);
        configuration.unresolvedRevocationWithoutHandle = true;
        configurationForUpdate = configuration;
      }
      const inheritedRevocationWarning =
        hadInheritedRevocationWarning &&
        !(
          cancelledCurrentRevocation &&
          pendingRevocations.length === 0 &&
          !hasUnrecoverableRevocationHandle(configurationForUpdate)
        );
      const nextCredentialCiphertext = Uint8Array.from(
        protectedAccessToken.ciphertext,
      );
      const credentialTupleChanged =
        !equalCredentialCiphertext(
          connection.credentialCiphertext,
          nextCredentialCiphertext,
        )
        || connection.credentialFingerprint !== protectedAccessToken.fingerprint
        || connection.credentialKeyVersion !== protectedAccessToken.keyVersion
        || connection.credentialExpiresAt !== null;
      await transaction.integrationConnection.update({
        where: {
          organizationId_id: {
            organizationId: input.attempt.organizationId,
            id: connection.id,
          },
        },
        data: {
          authType: "OAUTH1",
          status: inheritedRevocationWarning || pendingRevocationId
            ? "DEGRADED"
            : "CONNECTED",
          displayName: displayName(input.identity),
          scopes: jsonValue(input.identity.access),
          configuration: connectionConfiguration(
            configurationForUpdate,
            claimedAttempt.requestedScopes,
            pendingRevocations,
          ),
          credentialCiphertext: nextCredentialCiphertext,
          credentialFingerprint: protectedAccessToken.fingerprint,
          credentialKeyVersion: protectedAccessToken.keyVersion,
          credentialExpiresAt: null,
          ...(credentialTupleChanged
            ? { credentialGeneration: { increment: 1 } }
            : {}),
          lastVerifiedAt: input.completedAt,
          providerBackoffUntil: null,
          lastErrorCode: inheritedRevocationWarning
            ? connection.lastErrorCode
            : pendingRevocationId
              ? "previous_key_revocation_pending"
              : null,
          lastErrorMessage: null,
          revokedAt: null,
        },
      });

      await transaction.zoteroLibrary.updateMany({
        where: {
          organizationId: input.attempt.organizationId,
          integrationConnectionId: connection.id,
        },
        data: {
          isReadable: false,
          isWritable: false,
          fileAccessStatus: "UNAVAILABLE",
          accessLostAt: input.completedAt,
          lastDiscoveredAt: input.completedAt,
        },
      });
      if (readablePermission(input.identity.access.user)) {
        await this.upsertLibrary(
          transaction,
          input.attempt.organizationId,
          connection.id,
          "USER",
          input.identity.userId,
          "My Library",
          input.identity.access.user,
          input.completedAt,
        );
      }
      for (const [groupId, permission] of Object.entries(
        input.identity.access.groups ?? {},
      )) {
        if (
          groupId === "all" ||
          !/^[1-9][0-9]*$/.test(groupId) ||
          !readablePermission(permission)
        ) {
          continue;
        }
        await this.upsertLibrary(
          transaction,
          input.attempt.organizationId,
          connection.id,
          "GROUP",
          groupId,
          null,
          permission,
          input.completedAt,
        );
      }

      const completed = await transaction.zoteroOAuthAttempt.updateMany({
        where: {
          id: input.attempt.id,
          organizationId: input.attempt.organizationId,
          status: "CLAIMED",
        },
        data: {
          status: "SUCCEEDED",
          completedAt: input.completedAt,
          failureCode: null,
          integrationConnectionId: connection.id,
        },
      });
      if (completed.count !== 1) callbackFailure();
      await transaction.auditEvent.create({
        data: {
          organizationId: input.attempt.organizationId,
          actorUserId: input.actorUserId,
          action: "zotero.connected",
          entityType: "integration-connection",
          entityId: connection.id,
          requestId: input.requestId,
          metadata: jsonValue({
            userLibraryReadable: readablePermission(input.identity.access.user),
            explicitGroupCount: Object.keys(input.identity.access.groups ?? {}).filter(
              (groupId) => groupId !== "all",
            ).length,
          }),
        },
      });
      return { connectionId: connection.id, pendingRevocationId };
    });
  }

  private async serializableTransaction<T>(
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return runSerializableTransaction(this.database, work);
  }

  private async upsertLibrary(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    connectionId: string,
    libraryType: "USER" | "GROUP",
    zoteroLibraryId: string,
    name: string | null,
    permission: ZoteroPermissionSet | undefined,
    discoveredAt: Date,
  ): Promise<void> {
    await transaction.zoteroLibrary.upsert({
      where: {
        integrationConnectionId_libraryType_zoteroLibraryId: {
          integrationConnectionId: connectionId,
          libraryType,
          zoteroLibraryId,
        },
      },
      update: {
        name,
        isReadable: true,
        isWritable: permission?.write === true,
        fileAccessStatus: zoteroFileAccessStatusFromPermission(permission),
        accessLostAt: null,
        lastDiscoveredAt: discoveredAt,
      },
      create: {
        organizationId,
        integrationConnectionId: connectionId,
        libraryType,
        zoteroLibraryId,
        name,
        isReadable: true,
        isWritable: permission?.write === true,
        fileAccessStatus: zoteroFileAccessStatusFromPermission(permission),
        accessLostAt: null,
        discoveredAt,
        lastDiscoveredAt: discoveredAt,
        syncEnabled: false,
      },
    });
  }
}

export function createZoteroOAuthLifecycleFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): { service: ZoteroOAuthLifecycleService; configuration: ZoteroOAuthServerConfiguration } {
  const configuration = zoteroOAuthConfigurationFromEnvironment(environment);
  const credentialProtector = credentialProtectorFromEnvironment(environment);
  const oauthClient = new ZoteroOAuthClient({
    consumerKey: configuration.consumerKey,
    consumerSecret: configuration.consumerSecret,
    fetchImpl,
  });
  const stateCodec = new ZoteroOAuthStateCodec({
    secret: configuration.stateSecret,
  });
  return {
    configuration,
    service: new ZoteroOAuthLifecycleService({
      credentialProtector,
      oauthClient,
      stateCodec,
      stateHashSecret: configuration.stateSecret,
      callbackUrl: configuration.callbackUrl,
      verifyAccessToken: async ({ accessToken, organizationId, attemptId }) => {
        const adapter = new ZoteroReadOnlyAdapter({
          fetchImpl,
          credentialResolver: async () => ({ accessToken }),
          timeoutMs: 5_000,
          maxResponseBytes: 64 * 1024,
        });
        return (
          await adapter.getCurrentIdentity({
            organizationId,
            connectionId: attemptId,
          })
        ).data;
      },
      revokeAccessToken: (accessToken) =>
        revokeZoteroAccessToken(accessToken, fetchImpl),
    }),
  };
}

/**
 * Zotero documents key deletion only as DELETE /keys/<key>. The key therefore
 * appears in this provider URL, but is never returned, logged, or copied into
 * an error. Local ciphertext erasure always precedes this best-effort call.
 */
export async function revokeZoteroAccessToken(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_REMOTE_REVOCATION_TIMEOUT_MS,
): Promise<boolean> {
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(accessToken) ||
    Buffer.byteLength(accessToken, "utf8") > 4 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_REMOTE_REVOCATION_TIMEOUT_MS
  ) {
    return false;
  }
  const url = assertZoteroApiUrl(
    new URL(`/keys/${encodeURIComponent(accessToken)}`, ZOTERO_API_ORIGIN),
  );
  const controller = new AbortController();
  const timeoutMarker = Symbol("zotero-revocation-timeout");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
    timeout = setTimeout(() => {
      resolve(timeoutMarker);
      controller.abort();
    }, timeoutMs);
  });
  const requestPromise = (async () => {
    try {
      const response = await fetchImpl(url, {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Zotero-API-Version": "3",
        },
        body: null,
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.redirected) return false;
      if (response.url) {
        let responseUrl: URL;
        try {
          responseUrl = assertZoteroApiUrl(response.url);
        } catch {
          return false;
        }
        if (responseUrl.toString() !== url.toString()) return false;
      }
      // Retried outbox delivery may see a key that a prior successful DELETE
      // already removed before its local acknowledgement committed.
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  })();

  try {
    const result = await Promise.race([requestPromise, timeoutPromise]);
    return result === timeoutMarker ? false : result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
