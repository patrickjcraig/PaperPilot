const ZOTERO_WEB_ORIGIN = "https://www.zotero.org";
const ZOTERO_AUTHORIZATION_PATH = "/oauth/authorize";
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const OPAQUE_ID = /^[a-zA-Z0-9._:-]{1,200}$/;

export const ZOTERO_SCOPE_PROFILES = [
  "personal_metadata",
  "personal_metadata_notes",
  "personal_group_metadata",
  "personal_group_metadata_notes",
] as const;

export type ZoteroScopeProfile = typeof ZOTERO_SCOPE_PROFILES[number];

export const ZOTERO_CONNECTION_STATUSES = [
  "PENDING",
  "CONNECTED",
  "DEGRADED",
  "REVOKED",
  "DISCONNECTED",
] as const;

export const ZOTERO_SYNC_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "BACKING_OFF",
] as const;

export const ZOTERO_FILE_ACCESS_STATUSES = [
  "AVAILABLE",
  "UNKNOWN",
  "UNAVAILABLE",
] as const;

export const ZOTERO_ATTACHMENT_POLICY_MODES = ["DISABLED", "MANUAL"] as const;

export const ZOTERO_ATTACHMENT_ELIGIBILITIES = [
  "DOWNLOADABLE",
  "INELIGIBLE",
  "MALFORMED",
] as const;

export const ZOTERO_ATTACHMENT_IMPORT_STATUSES = [
  "QUEUED",
  "DOWNLOADING",
  "QUARANTINED",
  "VALIDATING",
  "EXTRACTING",
  "READY",
  "ATTENTION",
  "FAILED",
  "CANCELLED",
] as const;

export const ZOTERO_ATTACHMENT_FAILURE_CODES = [
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
  "internal_error",
] as const;

/** Public, presentation-safe connection conditions. Raw provider errors stay server-side. */
export const ZOTERO_ATTENTION_CODES = [
  "remote_revocation_pending",
  "remote_revocation_unconfirmed",
  "previous_key_revocation_pending",
  "previous_key_revocation_unconfirmed",
  "zotero_authentication_failed",
  "zotero_forbidden",
  "zotero_credential_unavailable",
  "zotero_unavailable",
] as const;

/** Public sync failures that have fixed, non-secret UI copy. */
export const ZOTERO_SYNC_ERROR_CODES = [
  "zotero_authentication_failed",
  "zotero_bad_response",
  "zotero_credential_unavailable",
  "zotero_forbidden",
  "zotero_invalid_request",
  "zotero_not_found",
  "zotero_rate_limited",
  "zotero_timeout",
  "zotero_unavailable",
  "zotero_sync_resource_limit",
  "stable_version_changed",
  "internal_error",
] as const;

export type ZoteroConnectionStatus = typeof ZOTERO_CONNECTION_STATUSES[number];
export type ZoteroSyncRunStatus = typeof ZOTERO_SYNC_RUN_STATUSES[number];
export type ZoteroFileAccessStatus = typeof ZOTERO_FILE_ACCESS_STATUSES[number];
export type ZoteroAttachmentPolicyMode = typeof ZOTERO_ATTACHMENT_POLICY_MODES[number];
export type ZoteroAttachmentEligibility = typeof ZOTERO_ATTACHMENT_ELIGIBILITIES[number];
export type ZoteroAttachmentImportStatus = typeof ZOTERO_ATTACHMENT_IMPORT_STATUSES[number];
export type ZoteroAttachmentFailureCode = typeof ZOTERO_ATTACHMENT_FAILURE_CODES[number];
export type ZoteroAttentionCode = typeof ZOTERO_ATTENTION_CODES[number];
export type ZoteroSyncErrorCode = typeof ZOTERO_SYNC_ERROR_CODES[number];

export interface ZoteroAttachmentPolicyUiSummary {
  mode: ZoteroAttachmentPolicyMode;
  revision: number;
  configuredAt: string | null;
}

export interface ZoteroAttachmentPolicyUpdateUiResponse
  extends ZoteroAttachmentPolicyUiSummary {
  outcome: "applied" | "unchanged";
}

export interface ZoteroAttachmentImportUiSummary {
  id: string;
  status: ZoteroAttachmentImportStatus;
  documentId: string;
  assetId: string;
  intakeId: string;
  inboxEntryId: string | null;
  downloadJobId: string | null;
  sourceVersion: string;
  providerMd5: string;
  failureCode: ZoteroAttachmentFailureCode | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ZoteroAttachmentUiSummary {
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
  eligibility: ZoteroAttachmentEligibility;
  reasonCode: string | null;
  isDeleted: boolean;
  updatedAt: string;
  latestImport: ZoteroAttachmentImportUiSummary | null;
}

export interface ZoteroAttachmentListUiResponse {
  attachments: ZoteroAttachmentUiSummary[];
  nextCursor: string | null;
}

export interface ZoteroAttachmentImportUiResponse {
  outcome: "applied" | "replayed" | "coalesced";
  import: ZoteroAttachmentImportUiSummary;
}

export interface ZoteroAttachmentListUiQuery {
  after?: string;
  limit?: number;
  libraryId?: string;
  eligibility?: ZoteroAttachmentEligibility;
  includeDeleted?: boolean;
}

export function isZoteroAttachmentImportCurrent(
  attachment: ZoteroAttachmentUiSummary,
): boolean {
  return attachment.latestImport !== null
    && attachment.providerMd5 !== null
    && attachment.latestImport.sourceVersion === attachment.sourceVersion
    && attachment.latestImport.providerMd5 === attachment.providerMd5;
}

export interface ZoteroSyncRunUiSummary {
  id: string;
  status: ZoteroSyncRunStatus;
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

export interface ZoteroLibraryUiSummary {
  id: string;
  type: "USER" | "GROUP";
  zoteroLibraryId: string;
  name: string | null;
  isReadable: boolean;
  isWritable: boolean;
  fileAccessStatus: ZoteroFileAccessStatus;
  syncEnabled: boolean;
  lastSyncedAt: string | null;
  lastSyncedVersion: string | null;
  lastSyncRun: ZoteroSyncRunUiSummary | null;
}

export interface ZoteroConnectionUiSummary {
  id: string;
  status: ZoteroConnectionStatus;
  displayName: string | null;
  lastVerifiedAt: string | null;
  attentionCode: ZoteroAttentionCode | null;
  providerBackoffUntil: string | null;
  selectionRevision: number;
  librariesConfiguredAt: string | null;
  capabilities: {
    personalLibrary: boolean;
    groupLibraries: boolean;
    notes: boolean;
    files: boolean;
  };
  libraries: ZoteroLibraryUiSummary[];
}

export interface ZoteroConnectionsUiResponse {
  connections: ZoteroConnectionUiSummary[];
}

export interface ZoteroOAuthStartUiResponse {
  authorizationUrl: string;
  expiresAt: string;
  scopeProfile: ZoteroScopeProfile;
}

export interface ZoteroLibrarySelectionUiResponse {
  outcome: "applied" | "replayed" | "noop";
  selectionRevision: number;
  libraries: ZoteroLibraryUiSummary[];
}

export interface ZoteroLibraryDiscoveryUiResponse {
  discovered: true;
  libraries: ZoteroLibraryUiSummary[];
}

export interface ZoteroSyncRunsUiResponse {
  outcome: "queued" | "coalesced";
  queuedCount: number;
  coalescedCount: number;
  runs: ZoteroSyncRunUiSummary[];
}

export interface ZoteroCallbackConsumption {
  hadParameter: boolean;
  result: "connected" | "failed" | null;
  replacement: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contained an unsupported field.`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} was invalid.`);
  }
  return value;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new Error(`${label} was invalid.`);
  }
  return value;
}

function nullableText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null) return null;
  return boundedText(value, label, maximum);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  const timestamp = boundedText(value, label, 100);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} was invalid.`);
  return new Date(milliseconds).toISOString();
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = boundedText(value, label, 100);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} was invalid.`);
  return new Date(milliseconds).toISOString();
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} was invalid.`);
  }
  return value as number;
}

function nullableVersion(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} was invalid.`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} was invalid.`);
  return value;
}

function fileAccessStatus(value: unknown): ZoteroFileAccessStatus {
  if (
    typeof value !== "string"
    || !ZOTERO_FILE_ACCESS_STATUSES.includes(value as ZoteroFileAccessStatus)
  ) {
    throw new Error("The Zotero file access status was invalid.");
  }
  return value as ZoteroFileAccessStatus;
}

function attachmentPolicyMode(value: unknown): ZoteroAttachmentPolicyMode {
  if (
    typeof value !== "string"
    || !ZOTERO_ATTACHMENT_POLICY_MODES.includes(value as ZoteroAttachmentPolicyMode)
  ) {
    throw new Error("The Zotero attachment policy mode was invalid.");
  }
  return value as ZoteroAttachmentPolicyMode;
}

function attachmentEligibility(value: unknown): ZoteroAttachmentEligibility {
  if (
    typeof value !== "string"
    || !ZOTERO_ATTACHMENT_ELIGIBILITIES.includes(value as ZoteroAttachmentEligibility)
  ) {
    throw new Error("The Zotero attachment eligibility was invalid.");
  }
  return value as ZoteroAttachmentEligibility;
}

function attachmentImportStatus(value: unknown): ZoteroAttachmentImportStatus {
  if (
    typeof value !== "string"
    || !ZOTERO_ATTACHMENT_IMPORT_STATUSES.includes(value as ZoteroAttachmentImportStatus)
  ) {
    throw new Error("The Zotero attachment import status was invalid.");
  }
  return value as ZoteroAttachmentImportStatus;
}

function nullableOpaqueId(value: unknown, label: string): string | null {
  return value === null ? null : opaqueId(value, label);
}

function lowercaseDigest(
  value: unknown,
  label: string,
  length: 32 | 64,
): string {
  const expression = length === 32 ? /^[a-f0-9]{32}$/ : /^[a-f0-9]{64}$/;
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(`${label} was invalid.`);
  }
  return value;
}

function scopeProfile(value: unknown): ZoteroScopeProfile {
  if (
    typeof value !== "string"
    || !ZOTERO_SCOPE_PROFILES.includes(value as ZoteroScopeProfile)
  ) {
    throw new Error("The Zotero scope profile was invalid.");
  }
  return value as ZoteroScopeProfile;
}

function encodedRouteSegment(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 200
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} was invalid.`);
  }
  return encodeURIComponent(value);
}

export function zoteroConnectionsRoute(workspaceId: string): string {
  return `/api/workspaces/${encodedRouteSegment(workspaceId, "workspaceId")}/integrations/zotero`;
}

export function zoteroOAuthStartRoute(workspaceId: string): string {
  return `${zoteroConnectionsRoute(workspaceId)}/oauth/start`;
}

export function zoteroDisconnectRoute(
  workspaceId: string,
  connectionId: string,
): string {
  return `${zoteroConnectionsRoute(workspaceId)}/${encodedRouteSegment(connectionId, "connectionId")}`;
}

export function zoteroLibrarySelectionRoute(
  workspaceId: string,
  connectionId: string,
): string {
  return `${zoteroDisconnectRoute(workspaceId, connectionId)}/libraries/selection`;
}

export function zoteroLibraryDiscoveryRoute(
  workspaceId: string,
  connectionId: string,
): string {
  return `${zoteroDisconnectRoute(workspaceId, connectionId)}/libraries/discover`;
}

export function zoteroSyncRunsRoute(
  workspaceId: string,
  connectionId: string,
): string {
  return `${zoteroDisconnectRoute(workspaceId, connectionId)}/sync-runs`;
}

export function zoteroAttachmentPolicyRoute(
  workspaceId: string,
  connectionId: string,
): string {
  return `${zoteroDisconnectRoute(workspaceId, connectionId)}/attachment-policy`;
}

export function zoteroAttachmentsRoute(
  workspaceId: string,
  connectionId: string,
  query: ZoteroAttachmentListUiQuery = {},
): string {
  const route = zoteroDisconnectRoute(workspaceId, connectionId);
  const parameters = new URLSearchParams();
  if (query.after !== undefined) {
    parameters.set("after", opaqueId(query.after, "The Zotero attachment cursor"));
  }
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new Error("The Zotero attachment page size was invalid.");
    }
    parameters.set("limit", String(query.limit));
  }
  if (query.libraryId !== undefined) {
    parameters.set("libraryId", opaqueId(query.libraryId, "The Zotero library id"));
  }
  if (query.eligibility !== undefined) {
    parameters.set("eligibility", attachmentEligibility(query.eligibility));
  }
  if (query.includeDeleted !== undefined) {
    parameters.set("includeDeleted", String(query.includeDeleted));
  }
  const encoded = parameters.toString();
  return `${route}/attachments${encoded ? `?${encoded}` : ""}`;
}

export function zoteroAttachmentImportsRoute(
  workspaceId: string,
  connectionId: string,
  attachmentId: string,
): string {
  return `${zoteroDisconnectRoute(workspaceId, connectionId)}/attachments/${encodedRouteSegment(
    attachmentId,
    "attachmentId",
  )}/imports`;
}

export function isWorkspaceIntegrationManager(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function trustedZoteroAuthorizationUrl(value: unknown): string {
  const candidate = boundedText(value, "The Zotero authorization URL", 8_192);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("The Zotero authorization URL was invalid.");
  }
  if (
    url.origin !== ZOTERO_WEB_ORIGIN
    || url.protocol !== "https:"
    || url.hostname !== "www.zotero.org"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== ZOTERO_AUTHORIZATION_PATH
    || url.hash !== ""
  ) {
    throw new Error("The Zotero authorization URL was not trusted.");
  }

  const allowedParameters = new Set([
    "oauth_token",
    "name",
    "library_access",
    "notes_access",
    "write_access",
    "all_groups",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowedParameters.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("The Zotero authorization URL was invalid.");
    }
  }
  const token = url.searchParams.get("oauth_token");
  if (!token || token.length > 4_096 || CONTROL_CHARACTERS.test(token)) {
    throw new Error("The Zotero authorization URL was invalid.");
  }
  if (
    url.searchParams.get("library_access") !== "1"
    || url.searchParams.get("write_access") !== "0"
    || !["0", "1"].includes(url.searchParams.get("notes_access") ?? "")
    || !["none", "read"].includes(url.searchParams.get("all_groups") ?? "")
  ) {
    throw new Error("The Zotero authorization request was not read-only.");
  }
  return url.toString();
}

export function parseZoteroOAuthStartResponse(
  value: unknown,
  expectedProfile?: ZoteroScopeProfile,
): ZoteroOAuthStartUiResponse {
  const payload = record(value, "The Zotero OAuth response");
  exactKeys(
    payload,
    new Set(["authorizationUrl", "expiresAt", "scopeProfile"]),
    "The Zotero OAuth response",
  );
  const parsedProfile = scopeProfile(payload.scopeProfile);
  if (expectedProfile && parsedProfile !== expectedProfile) {
    throw new Error("The Zotero authorization scope did not match the request.");
  }
  const authorizationUrl = trustedZoteroAuthorizationUrl(payload.authorizationUrl);
  const url = new URL(authorizationUrl);
  const wantsNotes = parsedProfile.endsWith("_notes");
  const wantsGroups = parsedProfile.includes("_group_");
  if (
    url.searchParams.get("notes_access") !== (wantsNotes ? "1" : "0")
    || url.searchParams.get("all_groups") !== (wantsGroups ? "read" : "none")
  ) {
    throw new Error("The Zotero authorization scope did not match the request.");
  }
  return {
    authorizationUrl,
    expiresAt: requiredTimestamp(payload.expiresAt, "The Zotero OAuth expiry"),
    scopeProfile: parsedProfile,
  };
}

export function parseZoteroConnectionsResponse(
  value: unknown,
): ZoteroConnectionsUiResponse {
  const payload = record(value, "The Zotero connection response");
  exactKeys(payload, new Set(["connections"]), "The Zotero connection response");
  if (!Array.isArray(payload.connections) || payload.connections.length > 100) {
    throw new Error("The Zotero connection response was invalid.");
  }
  const connections = payload.connections.map((candidate, connectionIndex) => {
      const connection = record(candidate, `Zotero connection ${connectionIndex + 1}`);
      exactKeys(
        connection,
        new Set([
          "id",
          "status",
          "displayName",
          "lastVerifiedAt",
          "attentionCode",
          "providerBackoffUntil",
          "selectionRevision",
          "librariesConfiguredAt",
          "capabilities",
          "libraries",
        ]),
        `Zotero connection ${connectionIndex + 1}`,
      );
      if (
        typeof connection.status !== "string"
        || !ZOTERO_CONNECTION_STATUSES.includes(connection.status as ZoteroConnectionStatus)
      ) {
        throw new Error("A Zotero connection status was invalid.");
      }
      if (!Array.isArray(connection.libraries) || connection.libraries.length > 500) {
        throw new Error("A Zotero library summary was invalid.");
      }
      const capabilities = record(
        connection.capabilities,
        `Zotero connection ${connectionIndex + 1} capabilities`,
      );
      exactKeys(
        capabilities,
        new Set(["personalLibrary", "groupLibraries", "notes", "files"]),
        `Zotero connection ${connectionIndex + 1} capabilities`,
      );
      const attentionCode = connection.attentionCode === null
        ? null
        : boundedText(connection.attentionCode, "The Zotero attention code", 100);
      if (
        attentionCode !== null
        && !ZOTERO_ATTENTION_CODES.includes(attentionCode as ZoteroAttentionCode)
      ) {
        throw new Error("The Zotero attention code was invalid.");
      }
      return {
        id: opaqueId(connection.id, "The Zotero connection id"),
        status: connection.status as ZoteroConnectionStatus,
        displayName: nullableText(connection.displayName, "The Zotero connection name", 200),
        lastVerifiedAt: nullableTimestamp(
          connection.lastVerifiedAt,
          "The Zotero verification time",
        ),
        attentionCode: attentionCode as ZoteroAttentionCode | null,
        providerBackoffUntil: nullableTimestamp(
          connection.providerBackoffUntil,
          "The Zotero provider backoff time",
        ),
        selectionRevision: nonnegativeInteger(
          connection.selectionRevision,
          "The Zotero selection revision",
        ),
        librariesConfiguredAt: nullableTimestamp(
          connection.librariesConfiguredAt,
          "The Zotero library configuration time",
        ),
        capabilities: {
          personalLibrary: booleanValue(
            capabilities.personalLibrary,
            "The personal-library capability",
          ),
          groupLibraries: booleanValue(
            capabilities.groupLibraries,
            "The group-library capability",
          ),
          notes: booleanValue(capabilities.notes, "The notes capability"),
          files: booleanValue(capabilities.files, "The files capability"),
        },
        libraries: parseZoteroLibraries(
          connection.libraries,
          `Zotero connection ${connectionIndex + 1}`,
        ),
      };
    });
  if (new Set(connections.map((connection) => connection.id)).size !== connections.length) {
    throw new Error("The Zotero connection response contained duplicate connections.");
  }
  return { connections };
}

function parseZoteroSyncRun(value: unknown, label: string): ZoteroSyncRunUiSummary {
  const run = record(value, label);
  exactKeys(
    run,
    new Set([
      "id",
      "status",
      "fromVersion",
      "toVersion",
      "objectsRead",
      "objectsWritten",
      "objectsDeleted",
      "backoffUntil",
      "errorCode",
      "startedAt",
      "completedAt",
    ]),
    label,
  );
  if (
    typeof run.status !== "string"
    || !ZOTERO_SYNC_RUN_STATUSES.includes(run.status as ZoteroSyncRunStatus)
  ) {
    throw new Error(`${label} status was invalid.`);
  }
  const errorCode = run.errorCode === null
    ? null
    : boundedText(run.errorCode, `${label} error code`, 100);
  if (
    errorCode !== null
    && !ZOTERO_SYNC_ERROR_CODES.includes(errorCode as ZoteroSyncErrorCode)
  ) {
    throw new Error(`${label} error code was invalid.`);
  }
  const parsed: ZoteroSyncRunUiSummary = {
    id: opaqueId(run.id, `${label} id`),
    status: run.status as ZoteroSyncRunStatus,
    fromVersion: nullableVersion(run.fromVersion, `${label} starting version`),
    toVersion: nullableVersion(run.toVersion, `${label} ending version`),
    objectsRead: nonnegativeInteger(run.objectsRead, `${label} objects read`),
    objectsWritten: nonnegativeInteger(run.objectsWritten, `${label} objects written`),
    objectsDeleted: nonnegativeInteger(run.objectsDeleted, `${label} objects deleted`),
    backoffUntil: nullableTimestamp(run.backoffUntil, `${label} backoff time`),
    errorCode: errorCode as ZoteroSyncErrorCode | null,
    startedAt: nullableTimestamp(run.startedAt, `${label} start time`),
    completedAt: nullableTimestamp(run.completedAt, `${label} completion time`),
  };
  if (
    parsed.startedAt
    && parsed.completedAt
    && Date.parse(parsed.completedAt) < Date.parse(parsed.startedAt)
  ) {
    throw new Error(`${label} timing was invalid.`);
  }
  if (parsed.status === "SUCCEEDED" && parsed.errorCode !== null) {
    throw new Error(`${label} success state was invalid.`);
  }
  if (parsed.status === "BACKING_OFF" && parsed.backoffUntil === null) {
    throw new Error(`${label} backoff state was invalid.`);
  }
  return parsed;
}

function parseZoteroLibraries(value: unknown[], label: string): ZoteroLibraryUiSummary[] {
  const libraries = value.map((libraryCandidate, libraryIndex) => {
    const libraryLabel = `${label} library ${libraryIndex + 1}`;
    const library = record(libraryCandidate, libraryLabel);
    exactKeys(
      library,
      new Set([
        "id",
        "type",
        "zoteroLibraryId",
        "name",
        "isReadable",
        "isWritable",
        "fileAccessStatus",
        "syncEnabled",
        "lastSyncedAt",
        "lastSyncedVersion",
        "lastSyncRun",
      ]),
      libraryLabel,
    );
    if (
      library.type !== "USER"
      && library.type !== "GROUP"
    ) {
      throw new Error("A Zotero library type was invalid.");
    }
    const isReadable = booleanValue(library.isReadable, "The Zotero library readability");
    const isWritable = booleanValue(library.isWritable, "The Zotero library write capability");
    if (isWritable) {
      throw new Error("A Zotero library reported unsupported write access.");
    }
    const parsedFileAccessStatus = fileAccessStatus(library.fileAccessStatus);
    if (!isReadable && parsedFileAccessStatus !== "UNAVAILABLE") {
      throw new Error("An unreadable Zotero library had an invalid file access status.");
    }
    const syncEnabled = booleanValue(library.syncEnabled, "The Zotero library selection");
    return {
      id: opaqueId(library.id, "The Zotero library id"),
      type: library.type as ZoteroLibraryUiSummary["type"],
      zoteroLibraryId: boundedText(
        library.zoteroLibraryId,
        "The Zotero library identifier",
        200,
      ),
      name: nullableText(library.name, "The Zotero library name", 500),
      isReadable,
      isWritable,
      fileAccessStatus: parsedFileAccessStatus,
      syncEnabled,
      lastSyncedAt: nullableTimestamp(
        library.lastSyncedAt,
        "The Zotero library sync time",
      ),
      lastSyncedVersion: nullableVersion(
        library.lastSyncedVersion,
        "The Zotero library sync version",
      ),
      lastSyncRun: library.lastSyncRun === null
        ? null
        : parseZoteroSyncRun(library.lastSyncRun, `${libraryLabel} last sync run`),
    };
  });
  if (new Set(libraries.map((library) => library.id)).size !== libraries.length) {
    throw new Error(`${label} contained duplicate Zotero libraries.`);
  }
  return libraries;
}

function parseLibraryArray(value: unknown, label: string): ZoteroLibraryUiSummary[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error(`${label} was invalid.`);
  }
  return parseZoteroLibraries(value, label);
}

export function parseZoteroLibrarySelectionResponse(
  value: unknown,
): ZoteroLibrarySelectionUiResponse {
  const payload = record(value, "The Zotero library selection response");
  exactKeys(
    payload,
    new Set(["outcome", "selectionRevision", "libraries"]),
    "The Zotero library selection response",
  );
  if (
    payload.outcome !== "applied"
    && payload.outcome !== "replayed"
    && payload.outcome !== "noop"
  ) {
    throw new Error("The Zotero library selection outcome was invalid.");
  }
  return {
    outcome: payload.outcome,
    selectionRevision: nonnegativeInteger(
      payload.selectionRevision,
      "The Zotero selection revision",
    ),
    libraries: parseLibraryArray(payload.libraries, "The selected Zotero libraries"),
  };
}

export function parseZoteroLibraryDiscoveryResponse(
  value: unknown,
): ZoteroLibraryDiscoveryUiResponse {
  const payload = record(value, "The Zotero library discovery response");
  exactKeys(
    payload,
    new Set(["discovered", "libraries"]),
    "The Zotero library discovery response",
  );
  if (payload.discovered !== true) {
    throw new Error("The Zotero library discovery response was invalid.");
  }
  return {
    discovered: true,
    libraries: parseLibraryArray(payload.libraries, "The discovered Zotero libraries"),
  };
}

export function parseZoteroSyncRunsResponse(value: unknown): ZoteroSyncRunsUiResponse {
  const payload = record(value, "The Zotero sync response");
  exactKeys(
    payload,
    new Set(["outcome", "queuedCount", "coalescedCount", "runs"]),
    "The Zotero sync response",
  );
  if (payload.outcome !== "queued" && payload.outcome !== "coalesced") {
    throw new Error("The Zotero sync outcome was invalid.");
  }
  if (!Array.isArray(payload.runs) || payload.runs.length < 1 || payload.runs.length > 500) {
    throw new Error("The Zotero sync runs were invalid.");
  }
  const runs = payload.runs.map((run, index) =>
    parseZoteroSyncRun(run, `Zotero sync run ${index + 1}`));
  if (new Set(runs.map((run) => run.id)).size !== runs.length) {
    throw new Error("The Zotero sync response contained duplicate runs.");
  }
  const queuedCount = nonnegativeInteger(payload.queuedCount, "The queued sync count");
  const coalescedCount = nonnegativeInteger(
    payload.coalescedCount,
    "The coalesced sync count",
  );
  if (
    queuedCount + coalescedCount !== runs.length
    || (payload.outcome === "queued" && queuedCount < 1)
    || (payload.outcome === "coalesced" && (queuedCount !== 0 || coalescedCount < 1))
  ) throw new Error("The Zotero sync counts were inconsistent.");
  return { outcome: payload.outcome, queuedCount, coalescedCount, runs };
}

function parseZoteroAttachmentPolicy(
  value: unknown,
  label: string,
  includeOutcome: boolean,
): ZoteroAttachmentPolicyUiSummary & { outcome?: "applied" | "unchanged" } {
  const payload = record(value, label);
  exactKeys(
    payload,
    new Set(includeOutcome
      ? ["outcome", "mode", "revision", "configuredAt"]
      : ["mode", "revision", "configuredAt"]),
    label,
  );
  let outcome: "applied" | "unchanged" | undefined;
  if (includeOutcome) {
    if (payload.outcome !== "applied" && payload.outcome !== "unchanged") {
      throw new Error(`${label} outcome was invalid.`);
    }
    outcome = payload.outcome;
  }
  const mode = attachmentPolicyMode(payload.mode);
  const revision = nonnegativeInteger(payload.revision, `${label} revision`);
  const configuredAt = nullableTimestamp(payload.configuredAt, `${label} configuration time`);
  if (
    (revision === 0 && (mode !== "DISABLED" || configuredAt !== null))
    || (revision > 0 && configuredAt === null)
  ) {
    throw new Error(`${label} state was inconsistent.`);
  }
  return { ...(outcome ? { outcome } : {}), mode, revision, configuredAt };
}

export function parseZoteroAttachmentPolicyResponse(
  value: unknown,
): ZoteroAttachmentPolicyUiSummary {
  return parseZoteroAttachmentPolicy(value, "The Zotero attachment policy response", false);
}

export function parseZoteroAttachmentPolicyUpdateResponse(
  value: unknown,
): ZoteroAttachmentPolicyUpdateUiResponse {
  const parsed = parseZoteroAttachmentPolicy(
    value,
    "The Zotero attachment policy update response",
    true,
  );
  if (!parsed.outcome) {
    throw new Error("The Zotero attachment policy update outcome was invalid.");
  }
  return {
    outcome: parsed.outcome,
    mode: parsed.mode,
    revision: parsed.revision,
    configuredAt: parsed.configuredAt,
  };
}

function parseZoteroAttachmentImport(
  value: unknown,
  label: string,
): ZoteroAttachmentImportUiSummary {
  const payload = record(value, label);
  exactKeys(
    payload,
    new Set([
      "id",
      "status",
      "documentId",
      "assetId",
      "intakeId",
      "inboxEntryId",
      "downloadJobId",
      "sourceVersion",
      "providerMd5",
      "failureCode",
      "createdAt",
      "completedAt",
    ]),
    label,
  );
  const failureCode = payload.failureCode === null
    ? null
    : boundedText(payload.failureCode, `${label} failure code`, 100);
  if (
    failureCode !== null
    && !ZOTERO_ATTACHMENT_FAILURE_CODES.includes(failureCode as ZoteroAttachmentFailureCode)
  ) {
    throw new Error(`${label} failure code was invalid.`);
  }
  const createdAt = requiredTimestamp(payload.createdAt, `${label} creation time`);
  const completedAt = nullableTimestamp(payload.completedAt, `${label} completion time`);
  if (completedAt && Date.parse(completedAt) < Date.parse(createdAt)) {
    throw new Error(`${label} timing was invalid.`);
  }
  const status = attachmentImportStatus(payload.status);
  if (
    ["READY", "ATTENTION", "FAILED", "CANCELLED"].includes(status)
    && completedAt === null
  ) {
    throw new Error(`${label} terminal state was invalid.`);
  }
  return {
    id: opaqueId(payload.id, `${label} id`),
    status,
    documentId: opaqueId(payload.documentId, `${label} document id`),
    assetId: opaqueId(payload.assetId, `${label} asset id`),
    intakeId: opaqueId(payload.intakeId, `${label} intake id`),
    inboxEntryId: nullableOpaqueId(payload.inboxEntryId, `${label} inbox entry id`),
    downloadJobId: nullableOpaqueId(payload.downloadJobId, `${label} download job id`),
    sourceVersion: boundedText(payload.sourceVersion, `${label} source version`, 128),
    providerMd5: lowercaseDigest(payload.providerMd5, `${label} provider checksum`, 32),
    failureCode: failureCode as ZoteroAttachmentFailureCode | null,
    createdAt,
    completedAt,
  };
}

export function parseZoteroAttachmentListResponse(
  value: unknown,
): ZoteroAttachmentListUiResponse {
  const payload = record(value, "The Zotero attachment list response");
  exactKeys(
    payload,
    new Set(["attachments", "nextCursor"]),
    "The Zotero attachment list response",
  );
  if (!Array.isArray(payload.attachments) || payload.attachments.length > 100) {
    throw new Error("The Zotero attachment list response was invalid.");
  }
  const attachments = payload.attachments.map((candidate, index) => {
    const label = `Zotero attachment ${index + 1}`;
    const attachment = record(candidate, label);
    exactKeys(
      attachment,
      new Set([
        "id",
        "libraryId",
        "parentKey",
        "linkMode",
        "contentType",
        "fileName",
        "providerMd5",
        "providerMtime",
        "sourceVersion",
        "metadataHash",
        "eligibility",
        "reasonCode",
        "isDeleted",
        "updatedAt",
        "latestImport",
      ]),
      label,
    );
    return {
      id: opaqueId(attachment.id, `${label} id`),
      libraryId: opaqueId(attachment.libraryId, `${label} library id`),
      parentKey: nullableText(attachment.parentKey, `${label} parent key`, 200),
      linkMode: nullableText(attachment.linkMode, `${label} link mode`, 100),
      contentType: nullableText(attachment.contentType, `${label} content type`, 200),
      fileName: nullableText(attachment.fileName, `${label} file name`, 1_000),
      providerMd5: attachment.providerMd5 === null
        ? null
        : lowercaseDigest(attachment.providerMd5, `${label} provider checksum`, 32),
      providerMtime: nullableText(attachment.providerMtime, `${label} provider time`, 100),
      sourceVersion: boundedText(attachment.sourceVersion, `${label} source version`, 128),
      metadataHash: lowercaseDigest(attachment.metadataHash, `${label} metadata digest`, 64),
      eligibility: attachmentEligibility(attachment.eligibility),
      reasonCode: nullableText(attachment.reasonCode, `${label} reason code`, 200),
      isDeleted: booleanValue(attachment.isDeleted, `${label} deletion state`),
      updatedAt: requiredTimestamp(attachment.updatedAt, `${label} update time`),
      latestImport: attachment.latestImport === null
        ? null
        : parseZoteroAttachmentImport(attachment.latestImport, `${label} latest import`),
    } satisfies ZoteroAttachmentUiSummary;
  });
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
    throw new Error("The Zotero attachment list contained duplicate attachments.");
  }
  return {
    attachments,
    nextCursor: nullableOpaqueId(payload.nextCursor, "The Zotero attachment cursor"),
  };
}

export function parseZoteroAttachmentImportResponse(
  value: unknown,
): ZoteroAttachmentImportUiResponse {
  const payload = record(value, "The Zotero attachment import response");
  exactKeys(
    payload,
    new Set(["outcome", "import"]),
    "The Zotero attachment import response",
  );
  if (
    payload.outcome !== "applied"
    && payload.outcome !== "replayed"
    && payload.outcome !== "coalesced"
  ) {
    throw new Error("The Zotero attachment import outcome was invalid.");
  }
  return {
    outcome: payload.outcome,
    import: parseZoteroAttachmentImport(
      payload.import,
      "The Zotero attachment import",
    ),
  };
}

export function parseZoteroDisconnectResponse(value: unknown): { disconnected: true } {
  const payload = record(value, "The Zotero disconnect response");
  exactKeys(
    payload,
    new Set(["disconnected", "remoteRevocationAttempted"]),
    "The Zotero disconnect response",
  );
  if (payload.disconnected !== true || typeof payload.remoteRevocationAttempted !== "boolean") {
    throw new Error("The Zotero disconnect response was invalid.");
  }
  return { disconnected: true };
}

export function zoteroCallbackConsumption(href: string): ZoteroCallbackConsumption {
  const url = new URL(href);
  const values = url.searchParams.getAll("zotero");
  const hadParameter = values.length > 0;
  const result = values.length === 1 && (values[0] === "connected" || values[0] === "failed")
    ? values[0]
    : null;
  if (hadParameter) url.searchParams.delete("zotero");
  const query = url.searchParams.toString();
  return {
    hadParameter,
    result,
    replacement: `${url.pathname}${query ? `?${query}` : ""}${url.hash}`,
  };
}

export function safeApiProblemMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return fallback;
  const message = (error as { message?: unknown }).message;
  if (
    typeof message !== "string"
    || message.length < 1
    || message.length > 500
    || CONTROL_CHARACTERS.test(message)
  ) {
    return fallback;
  }
  return message;
}
