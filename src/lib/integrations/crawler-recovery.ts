const STORAGE_KEY_PREFIX = "paperpilot:crawler-recovery:v1:";
const MAX_RECOVERY_BYTES = 24 * 1_024;
const MAX_COMMAND_BYTES = 16 * 1_024;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const RECOVERY_KEYS = new Set([
  "schemaVersion",
  "workspaceId",
  "body",
  "clientOperationId",
  "displayFileName",
  "expectedVersion",
  "maxBytes",
  "policy",
  "policyVersion",
]);
const POLICY_KEYS = new Set([
  "acquisitionMode",
  "policyVersion",
  "rightsAttestation",
  "robotsMode",
  "retentionMode",
  "maxResponseBytes",
  "maxRedirects",
]);
const COMMAND_KEYS = new Set([
  "schemaVersion",
  "clientOperationId",
  "expectedVersion",
  "policyVersion",
  "sourceUrl",
  "displayFileName",
  "rightsAttestation",
  "robotsMode",
  "retentionMode",
  "maxBytes",
]);
const RIGHTS_KEYS = new Set(["scope", "userDeclared"]);

export interface CrawlerRecoveryPolicy {
  acquisitionMode: "EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1";
  policyVersion: string;
  rightsAttestation: "INDEFINITE_RESEARCH_CUSTODY";
  robotsMode: "REQUIRE_ALLOW";
  retentionMode: "INDEFINITE_UNTIL_USER_DELETION";
  maxResponseBytes: number;
  maxRedirects: 0;
}

/**
 * The raw URL exists only inside `body`, the exact already-serialized command
 * that must be replayed byte-for-byte. Every sibling field is safe UI metadata.
 */
export interface FrozenCrawlerRecoverySubmission {
  readonly body: string;
  readonly clientOperationId: string;
  readonly displayFileName: string;
  readonly expectedVersion: number;
  readonly maxBytes: number;
  readonly policy: Readonly<CrawlerRecoveryPolicy>;
  readonly policyVersion: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function crawlerDefinitiveProblemCode(input: {
  status: number;
  payload: unknown;
  responseRequestId: string | null;
  contentType: string | null;
  cacheControl: string | null;
}): string | null {
  // These statuses are commonly synthesized by intermediaries even when an
  // upstream mutation may still commit. Keep the exact command recoverable.
  if ([408, 425, 429].includes(input.status)) return null;
  if (input.status < 400 || input.status >= 500) return null;
  if (input.contentType?.toLowerCase() !== "application/json") return null;
  const cacheDirectives = input.cacheControl
    ?.split(",")
    .map((directive) => directive.trim().toLowerCase());
  if (!cacheDirectives?.includes("no-store")) return null;
  const outer = exactRecord(input.payload, new Set(["error"]));
  const problem = outer
    ? exactRecord(outer.error, new Set(["code", "message", "requestId"]))
    : null;
  if (
    !problem
    || typeof problem.code !== "string"
    || !/^[a-z][a-z0-9_]{0,99}$/.test(problem.code)
    || typeof problem.message !== "string"
    || problem.message.length === 0
    || problem.message.length > 500
    || typeof problem.requestId !== "string"
    || !/^[A-Za-z0-9._:-]{1,100}$/.test(problem.requestId)
    || input.responseRequestId !== problem.requestId
  ) return null;
  return problem.code;
}

function exactRecord(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  return actual.length === keys.size
    && actual.every((key) => keys.has(key))
    && [...keys].every((key) => Object.prototype.hasOwnProperty.call(record, key))
    ? record
    : null;
}

function safeInteger(value: unknown, positive = false): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && (positive ? value > 0 : value >= 0);
}

function validFileName(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.normalize("NFC") !== value
    || value === "."
    || value === ".."
    || value.endsWith(".")
    || value.endsWith(" ")
    || !value.toLowerCase().endsWith(".pdf")
    || /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value)
    || /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(value)
    || new TextEncoder().encode(value).byteLength > 255
  ) return false;
  const firstComponent = value.split(".", 1)[0].replace(/[ .]+$/gu, "");
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(firstComponent);
}

function validSourceUrl(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || new TextEncoder().encode(value).byteLength > 2_048
    || value.includes("?")
    || value.includes("#")
    || value.includes("\\")
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function parsePolicy(value: unknown): Readonly<CrawlerRecoveryPolicy> | null {
  const record = exactRecord(value, POLICY_KEYS);
  if (
    !record
    || record.acquisitionMode !== "EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1"
    || typeof record.policyVersion !== "string"
    || !POLICY_VERSION_PATTERN.test(record.policyVersion)
    || record.rightsAttestation !== "INDEFINITE_RESEARCH_CUSTODY"
    || record.robotsMode !== "REQUIRE_ALLOW"
    || record.retentionMode !== "INDEFINITE_UNTIL_USER_DELETION"
    || !safeInteger(record.maxResponseBytes, true)
    || record.maxRedirects !== 0
  ) return null;
  return Object.freeze({
    acquisitionMode: "EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1",
    policyVersion: record.policyVersion,
    rightsAttestation: "INDEFINITE_RESEARCH_CUSTODY",
    robotsMode: "REQUIRE_ALLOW",
    retentionMode: "INDEFINITE_UNTIL_USER_DELETION",
    maxResponseBytes: record.maxResponseBytes,
    maxRedirects: 0,
  });
}

function commandMatches(
  body: string,
  submission: Omit<FrozenCrawlerRecoverySubmission, "body">,
): boolean {
  if (new TextEncoder().encode(body).byteLength > MAX_COMMAND_BYTES) return false;
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return false;
  }
  // PaperPilot creates the frozen body with JSON.stringify exactly once. A
  // recovered envelope must retain those same canonical bytes, including no
  // intermediary whitespace or key-order reconstruction.
  if (JSON.stringify(decoded) !== body) return false;
  const command = exactRecord(decoded, COMMAND_KEYS);
  const rights = command ? exactRecord(command.rightsAttestation, RIGHTS_KEYS) : null;
  return Boolean(
    command
    && rights
    && command.schemaVersion === 1
    && command.clientOperationId === submission.clientOperationId
    && command.expectedVersion === submission.expectedVersion
    && command.policyVersion === submission.policyVersion
    && validSourceUrl(command.sourceUrl)
    && command.displayFileName === submission.displayFileName
    && rights.scope === "INDEFINITE_RESEARCH_CUSTODY"
    && rights.userDeclared === true
    && command.robotsMode === "REQUIRE_ALLOW"
    && command.retentionMode === "INDEFINITE_UNTIL_USER_DELETION"
    && command.maxBytes === submission.maxBytes,
  );
}

function validWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

export function crawlerRecoveryStorageKey(workspaceId: string): string {
  if (!validWorkspaceId(workspaceId)) {
    throw new TypeError("A valid crawler recovery workspace is required.");
  }
  return `${STORAGE_KEY_PREFIX}${workspaceId}`;
}

export function serializeCrawlerRecovery(
  workspaceId: string,
  submission: FrozenCrawlerRecoverySubmission,
): string {
  const key = crawlerRecoveryStorageKey(workspaceId);
  void key;
  const policy = parsePolicy(submission.policy);
  if (
    !OPAQUE_ID_PATTERN.test(submission.clientOperationId)
    || !validFileName(submission.displayFileName)
    || !safeInteger(submission.expectedVersion)
    || !safeInteger(submission.maxBytes, true)
    || !POLICY_VERSION_PATTERN.test(submission.policyVersion)
    || !policy
    || policy.policyVersion !== submission.policyVersion
    || submission.maxBytes > policy.maxResponseBytes
    || !commandMatches(submission.body, { ...submission, policy })
  ) throw new TypeError("The crawler recovery submission is invalid.");
  const serialized = JSON.stringify({
    schemaVersion: 1,
    workspaceId,
    body: submission.body,
    clientOperationId: submission.clientOperationId,
    displayFileName: submission.displayFileName,
    expectedVersion: submission.expectedVersion,
    maxBytes: submission.maxBytes,
    policy,
    policyVersion: submission.policyVersion,
  });
  if (new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_BYTES) {
    throw new TypeError("The crawler recovery submission is too large.");
  }
  return serialized;
}

export function parseCrawlerRecovery(
  serialized: string,
  workspaceId: string,
): Readonly<FrozenCrawlerRecoverySubmission> | null {
  if (
    typeof serialized !== "string"
    || new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_BYTES
  ) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    return null;
  }
  const record = exactRecord(decoded, RECOVERY_KEYS);
  if (
    !record
    || record.schemaVersion !== 1
    || record.workspaceId !== workspaceId
    || typeof record.body !== "string"
    || typeof record.clientOperationId !== "string"
    || !OPAQUE_ID_PATTERN.test(record.clientOperationId)
    || !validFileName(record.displayFileName)
    || !safeInteger(record.expectedVersion)
    || !safeInteger(record.maxBytes, true)
    || typeof record.policyVersion !== "string"
    || !POLICY_VERSION_PATTERN.test(record.policyVersion)
  ) return null;
  const policy = parsePolicy(record.policy);
  if (
    !policy
    || policy.policyVersion !== record.policyVersion
    || record.maxBytes > policy.maxResponseBytes
  ) return null;
  const submission: FrozenCrawlerRecoverySubmission = {
    body: record.body,
    clientOperationId: record.clientOperationId,
    displayFileName: record.displayFileName,
    expectedVersion: record.expectedVersion,
    maxBytes: record.maxBytes,
    policy,
    policyVersion: record.policyVersion,
  };
  if (!commandMatches(submission.body, submission)) return null;
  return Object.freeze(submission);
}

export function persistCrawlerRecovery(
  storage: StorageLike,
  workspaceId: string,
  submission: FrozenCrawlerRecoverySubmission,
): boolean {
  try {
    storage.setItem(
      crawlerRecoveryStorageKey(workspaceId),
      serializeCrawlerRecovery(workspaceId, submission),
    );
    return true;
  } catch {
    return false;
  }
}

export function restoreCrawlerRecovery(
  storage: StorageLike,
  workspaceId: string,
): Readonly<FrozenCrawlerRecoverySubmission> | null {
  let key: string;
  try {
    key = crawlerRecoveryStorageKey(workspaceId);
    const serialized = storage.getItem(key);
    if (serialized === null) return null;
    const restored = parseCrawlerRecovery(serialized, workspaceId);
    if (restored) return restored;
    storage.removeItem(key);
  } catch {
    return null;
  }
  return null;
}

export function clearCrawlerRecovery(
  storage: StorageLike,
  workspaceId: string,
): void {
  try {
    storage.removeItem(crawlerRecoveryStorageKey(workspaceId));
  } catch {
    // Storage denial must never strand the in-memory command or sign-out flow.
  }
}
