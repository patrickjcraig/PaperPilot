const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RESPONSE_KEYS = new Set(["outcome", "aggregateVersion", "request"]);
const DELETION_COMMAND_KEYS = new Set([
  "schemaVersion",
  "clientOperationId",
  "expectedVersion",
  "crawlerImportId",
  "confirmDeletion",
]);
const DELETION_RECOVERY_KEYS = new Set([
  "schemaVersion",
  "workspaceId",
  "body",
  "clientOperationId",
  "crawlerImportId",
  "expectedVersion",
]);
const DELETION_RECOVERY_STORAGE_PREFIX = "paperpilot:crawler-custody-recovery:v1:";
const MAX_DELETION_RECOVERY_BYTES = 8 * 1_024;

export interface CrawlerCustodyDeletionCommandV1 {
  schemaVersion: 1;
  clientOperationId: string;
  expectedVersion: number;
  crawlerImportId: string;
  confirmDeletion: true;
}

export interface FrozenCrawlerCustodyDeletionSubmission {
  readonly body: string;
  readonly clientOperationId: string;
  readonly crawlerImportId: string;
  readonly expectedVersion: number;
}

export interface CrawlerCustodyStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CrawlerCustodyDeletionRequestProjection {
  id: string;
  status: string;
}

export interface CrawlerCustodyDeletionResponse<
  TRequest extends CrawlerCustodyDeletionRequestProjection,
> {
  outcome: "applied" | "replayed";
  aggregateVersion: number;
  request: TRequest;
}

function invalid(): never {
  throw new Error("PaperPilot received an invalid crawler custody response.");
}

function opaqueId(value: string, label: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== RESPONSE_KEYS.size
    || keys.some((key) => !RESPONSE_KEYS.has(key))
    || [...RESPONSE_KEYS].some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key),
    )
  ) invalid();
  return record;
}

function exactRecordFor(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === expectedKeys.size
    && keys.every((key) => expectedKeys.has(key))
    && [...expectedKeys].every((key) => Object.prototype.hasOwnProperty.call(record, key))
    ? record
    : null;
}

function deletionBodyMatches(
  submission: FrozenCrawlerCustodyDeletionSubmission,
): boolean {
  if (new TextEncoder().encode(submission.body).byteLength > 4 * 1_024) return false;
  let decoded: unknown;
  try {
    decoded = JSON.parse(submission.body);
  } catch {
    return false;
  }
  if (JSON.stringify(decoded) !== submission.body) return false;
  const command = exactRecordFor(decoded, DELETION_COMMAND_KEYS);
  return Boolean(
    command
    && command.schemaVersion === 1
    && command.clientOperationId === submission.clientOperationId
    && command.expectedVersion === submission.expectedVersion
    && command.crawlerImportId === submission.crawlerImportId
    && command.confirmDeletion === true,
  );
}

export function crawlerCustodyDeletionRoute(
  workspaceId: string,
  crawlerImportId: string,
): string {
  return `/api/workspaces/${encodeURIComponent(opaqueId(workspaceId, "workspaceId"))}`
    + `/integrations/crawler/requests/${encodeURIComponent(opaqueId(
      crawlerImportId,
      "crawlerImportId",
    ))}/custody`;
}

/**
 * Freeze the exact destructive command before transport. It contains only
 * opaque IDs and a workspace revision; source authority never enters UI state.
 */
export function createCrawlerCustodyDeletionSubmission(input: {
  clientOperationId: string;
  crawlerImportId: string;
  expectedVersion: number;
}): Readonly<FrozenCrawlerCustodyDeletionSubmission> {
  const clientOperationId = opaqueId(input.clientOperationId, "clientOperationId");
  const crawlerImportId = opaqueId(input.crawlerImportId, "crawlerImportId");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TypeError("expectedVersion is invalid.");
  }
  const command: CrawlerCustodyDeletionCommandV1 = {
    schemaVersion: 1,
    clientOperationId,
    expectedVersion: input.expectedVersion,
    crawlerImportId,
    confirmDeletion: true,
  };
  return Object.freeze({
    body: JSON.stringify(command),
    clientOperationId,
    crawlerImportId,
    expectedVersion: input.expectedVersion,
  });
}

export function crawlerCustodyDeletionRecoveryStorageKey(workspaceId: string): string {
  return `${DELETION_RECOVERY_STORAGE_PREFIX}${opaqueId(workspaceId, "workspaceId")}`;
}

/**
 * Persist only the already-frozen, URL-free destructive command. This lets a
 * reload retry the same operation ID and exact JSON bytes after an ambiguous
 * network outcome instead of manufacturing a second deletion command.
 */
export function serializeCrawlerCustodyDeletionRecovery(
  workspaceId: string,
  submission: FrozenCrawlerCustodyDeletionSubmission,
): string {
  crawlerCustodyDeletionRecoveryStorageKey(workspaceId);
  opaqueId(submission.clientOperationId, "clientOperationId");
  opaqueId(submission.crawlerImportId, "crawlerImportId");
  if (
    !Number.isSafeInteger(submission.expectedVersion)
    || submission.expectedVersion < 0
    || !deletionBodyMatches(submission)
  ) {
    throw new TypeError("The crawler custody recovery submission is invalid.");
  }
  const serialized = JSON.stringify({
    schemaVersion: 1,
    workspaceId,
    body: submission.body,
    clientOperationId: submission.clientOperationId,
    crawlerImportId: submission.crawlerImportId,
    expectedVersion: submission.expectedVersion,
  });
  if (new TextEncoder().encode(serialized).byteLength > MAX_DELETION_RECOVERY_BYTES) {
    throw new TypeError("The crawler custody recovery submission is too large.");
  }
  return serialized;
}

export function parseCrawlerCustodyDeletionRecovery(
  serialized: string,
  workspaceId: string,
): Readonly<FrozenCrawlerCustodyDeletionSubmission> | null {
  try {
    crawlerCustodyDeletionRecoveryStorageKey(workspaceId);
  } catch {
    return null;
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_DELETION_RECOVERY_BYTES) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    return null;
  }
  const record = exactRecordFor(decoded, DELETION_RECOVERY_KEYS);
  if (
    !record
    || record.schemaVersion !== 1
    || record.workspaceId !== workspaceId
    || typeof record.body !== "string"
    || typeof record.clientOperationId !== "string"
    || !OPAQUE_ID_PATTERN.test(record.clientOperationId)
    || typeof record.crawlerImportId !== "string"
    || !OPAQUE_ID_PATTERN.test(record.crawlerImportId)
    || typeof record.expectedVersion !== "number"
    || !Number.isSafeInteger(record.expectedVersion)
    || record.expectedVersion < 0
  ) return null;
  const submission: FrozenCrawlerCustodyDeletionSubmission = {
    body: record.body,
    clientOperationId: record.clientOperationId,
    crawlerImportId: record.crawlerImportId,
    expectedVersion: record.expectedVersion,
  };
  return deletionBodyMatches(submission) ? Object.freeze(submission) : null;
}

export function persistCrawlerCustodyDeletionRecovery(
  storage: CrawlerCustodyStorageLike,
  workspaceId: string,
  submission: FrozenCrawlerCustodyDeletionSubmission,
): boolean {
  try {
    storage.setItem(
      crawlerCustodyDeletionRecoveryStorageKey(workspaceId),
      serializeCrawlerCustodyDeletionRecovery(workspaceId, submission),
    );
    return true;
  } catch {
    return false;
  }
}

export function restoreCrawlerCustodyDeletionRecovery(
  storage: CrawlerCustodyStorageLike,
  workspaceId: string,
): Readonly<FrozenCrawlerCustodyDeletionSubmission> | null {
  try {
    const key = crawlerCustodyDeletionRecoveryStorageKey(workspaceId);
    const serialized = storage.getItem(key);
    if (serialized === null) return null;
    const restored = parseCrawlerCustodyDeletionRecovery(serialized, workspaceId);
    if (restored) return restored;
    storage.removeItem(key);
  } catch {
    return null;
  }
  return null;
}

export function clearCrawlerCustodyDeletionRecovery(
  storage: CrawlerCustodyStorageLike,
  workspaceId: string,
): void {
  try {
    storage.removeItem(crawlerCustodyDeletionRecoveryStorageKey(workspaceId));
  } catch {
    // Storage denial must not strand the in-memory retry or sign-out flow.
  }
}

/**
 * Decode only the two documented success forms and bind the returned row to
 * the destructive target. Applied responses must schedule deletion exactly one
 * revision later; replays may observe a later workspace revision and completed
 * physical cleanup.
 */
export function parseCrawlerCustodyDeletionResponse<
  TRequest extends CrawlerCustodyDeletionRequestProjection,
>(input: {
  value: unknown;
  httpStatus: number;
  submission: FrozenCrawlerCustodyDeletionSubmission;
  parseRequest: (value: unknown) => TRequest;
}): CrawlerCustodyDeletionResponse<TRequest> {
  const record = exactRecord(input.value);
  if (
    (record.outcome !== "applied" && record.outcome !== "replayed")
    || typeof record.aggregateVersion !== "number"
    || !Number.isSafeInteger(record.aggregateVersion)
    || record.aggregateVersion < 0
  ) invalid();
  const request = input.parseRequest(record.request);
  if (
    request.id !== input.submission.crawlerImportId
    || (request.status !== "DELETING" && request.status !== "DELETED")
  ) invalid();
  const firstAppliedVersion = input.submission.expectedVersion + 1;
  if (!Number.isSafeInteger(firstAppliedVersion)) invalid();
  if (record.outcome === "applied") {
    if (
      input.httpStatus !== 202
      || record.aggregateVersion !== firstAppliedVersion
      || request.status !== "DELETING"
    ) invalid();
  } else if (
    input.httpStatus !== 200
    || record.aggregateVersion < firstAppliedVersion
  ) invalid();
  return {
    outcome: record.outcome,
    aggregateVersion: record.aggregateVersion,
    request,
  };
}
