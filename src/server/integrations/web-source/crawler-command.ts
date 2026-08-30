import "server-only";

import { createHash } from "node:crypto";

import { HttpProblem } from "@/server/http/problem";
import {
  MAX_UPLOAD_DISPLAY_FILENAME_BYTES,
  normalizeUploadDisplayFilename,
} from "@/server/uploads/validation";
import {
  canonicalizePublicWebSourceUrl,
  WebSourceUrlPolicyError,
} from "./url-policy";

/** The deliberately narrow remote-acquisition mode described in the ROADMAP. */
export const CRAWLER_ACQUISITION_MODE_V1 =
  "EXPLICIT_SINGLE_QUERY_FREE_HTTPS_PDF_V1" as const;
export const CRAWLER_RIGHTS_ATTESTATION_V1 =
  "INDEFINITE_RESEARCH_CUSTODY" as const;
export const CRAWLER_ROBOTS_MODE_V1 = "REQUIRE_ALLOW" as const;
export const CRAWLER_RETENTION_MODE_V1 =
  "INDEFINITE_UNTIL_USER_DELETION" as const;
export const MAX_CRAWLER_ACQUISITION_COMMAND_BYTES = 16 * 1_024;

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
const RIGHTS_ATTESTATION_KEYS = new Set(["scope", "userDeclared"]);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_FINGERPRINT_DOMAIN =
  "paperpilot:crawler:source-url:explicit-single-pdf:v1\u0000";
const COMMAND_HASH_DOMAIN =
  "paperpilot:crawler:acquisition-command:explicit-single-pdf:v1\u0000";

export interface CrawlerRightsAttestationV1 {
  scope: typeof CRAWLER_RIGHTS_ATTESTATION_V1;
  /** An affirmative declaration from the authenticated human, never inferred. */
  userDeclared: true;
}

/**
 * A closed client command. Authenticated organization/user authority is supplied
 * by the server call site and is intentionally impossible to claim in this body.
 */
export interface CrawlerAcquisitionCommandV1 {
  schemaVersion: 1;
  clientOperationId: string;
  expectedVersion: number;
  policyVersion: string;
  sourceUrl: string;
  displayFileName: string;
  rightsAttestation: CrawlerRightsAttestationV1;
  robotsMode: typeof CRAWLER_ROBOTS_MODE_V1;
  retentionMode: typeof CRAWLER_RETENTION_MODE_V1;
  maxBytes: number;
}

/** Minimum server-owned policy needed to admit and bind a crawler command. */
export interface CrawlerCommandAdmissionPolicy {
  policyVersion: string;
  maxResponseBytes: number;
}

export interface ParsedCrawlerAcquisitionCommandV1 {
  command: Readonly<CrawlerAcquisitionCommandV1>;
  /** Domain-separated digest; the raw canonical URL must remain server-private. */
  sourceUrlFingerprint: string;
  /** Domain-separated digest of the complete canonical schema-v1 command. */
  requestHash: string;
}

export type CrawlerCommandFailureCode =
  | "invalid_command"
  | "unsupported_schema"
  | "invalid_operation_id"
  | "invalid_workspace_version"
  | "policy_version_conflict"
  | "invalid_source_url"
  | "source_query_forbidden"
  | "source_fragment_forbidden"
  | "source_port_forbidden"
  | "source_pdf_required"
  | "invalid_display_filename"
  | "rights_attestation_required"
  | "robots_allowance_required"
  | "indefinite_retention_required"
  | "invalid_max_bytes";

export class CrawlerCommandValidationError extends HttpProblem {
  constructor(
    readonly failureCode: CrawlerCommandFailureCode,
    message: string,
  ) {
    super(400, "invalid_crawler_command", message);
    this.name = "CrawlerCommandValidationError";
  }
}

/** A credential- and URL-free failure shape safe for public command responses. */
export interface CrawlerPublicFailureDto {
  schemaVersion: 1;
  code: CrawlerCommandFailureCode | "internal_error";
  message: string;
  retryable: boolean;
}

function invalid(code: CrawlerCommandFailureCode, message: string): never {
  throw new CrawlerCommandValidationError(code, message);
}

function exactRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("invalid_command", "The crawler command shape is not supported.");
  }
  const record = value as Record<string, unknown>;
  const suppliedKeys = Object.keys(record);
  if (
    suppliedKeys.some((key) => !allowedKeys.has(key))
    || [...allowedKeys].some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key),
    )
  ) {
    invalid("invalid_command", "The crawler command shape is not supported.");
  }
  return record;
}

function requireParserPolicy(
  policy: CrawlerCommandAdmissionPolicy,
): CrawlerCommandAdmissionPolicy {
  if (
    !policy
    || typeof policy !== "object"
    || !POLICY_VERSION_PATTERN.test(policy.policyVersion)
    || !Number.isSafeInteger(policy.maxResponseBytes)
    || policy.maxResponseBytes <= 0
  ) {
    throw new Error("Crawler command admission policy is invalid.");
  }
  return policy;
}

function clientOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    invalid(
      "invalid_operation_id",
      "clientOperationId must be a valid opaque identifier.",
    );
  }
  return value;
}

function expectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(
      "invalid_workspace_version",
      "expectedVersion must be a non-negative safe integer.",
    );
  }
  return value;
}

function parsedPolicyVersion(value: unknown): string {
  if (
    typeof value !== "string"
    || !POLICY_VERSION_PATTERN.test(value)
  ) {
    invalid(
      "policy_version_conflict",
      "The crawler policy version is no longer current.",
    );
  }
  return value;
}

function policyVersion(value: unknown, expected: string): string {
  const parsed = parsedPolicyVersion(value);
  if (parsed !== expected) {
    invalid(
      "policy_version_conflict",
      "The crawler policy version is no longer current.",
    );
  }
  return parsed;
}

function sourceUrl(value: unknown): string {
  if (typeof value !== "string") {
    invalid("invalid_source_url", "The crawler source URL is not eligible.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid("invalid_source_url", "The crawler source URL is not eligible.");
  }
  if (value.includes("?")) {
    invalid(
      "source_query_forbidden",
      "Crawler source URLs cannot contain a query.",
    );
  }
  if (value.includes("#")) {
    invalid(
      "source_fragment_forbidden",
      "Crawler source URLs cannot contain a fragment.",
    );
  }
  if (parsed.port !== "") {
    invalid(
      "source_port_forbidden",
      "Crawler source URLs must use HTTPS port 443.",
    );
  }

  let canonical: ReturnType<typeof canonicalizePublicWebSourceUrl>;
  try {
    canonical = canonicalizePublicWebSourceUrl(value);
  } catch (error) {
    if (error instanceof WebSourceUrlPolicyError) {
      invalid("invalid_source_url", "The crawler source URL is not eligible.");
    }
    throw error;
  }
  if (!canonical.pathname.toLowerCase().endsWith(".pdf")) {
    invalid(
      "source_pdf_required",
      "The crawler source must identify one explicit PDF path.",
    );
  }
  return canonical.url;
}

function displayFileName(value: unknown): string {
  let normalized: string;
  try {
    normalized = normalizeUploadDisplayFilename(value);
  } catch {
    invalid(
      "invalid_display_filename",
      "The crawler display filename is invalid.",
    );
  }
  if (
    Buffer.byteLength(normalized, "utf8") > MAX_UPLOAD_DISPLAY_FILENAME_BYTES
    || !normalized.toLowerCase().endsWith(".pdf")
  ) {
    invalid(
      "invalid_display_filename",
      "The crawler display filename is invalid.",
    );
  }
  return normalized;
}

function rightsAttestation(value: unknown): CrawlerRightsAttestationV1 {
  const record = exactRecord(value, RIGHTS_ATTESTATION_KEYS);
  if (
    record.scope !== CRAWLER_RIGHTS_ATTESTATION_V1
    || record.userDeclared !== true
  ) {
    invalid(
      "rights_attestation_required",
      "An affirmative indefinite-research-custody rights declaration is required.",
    );
  }
  return Object.freeze({
    scope: CRAWLER_RIGHTS_ATTESTATION_V1,
    userDeclared: true,
  });
}

function maxBytes(value: unknown, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum
  ) {
    invalid(
      "invalid_max_bytes",
      "maxBytes must be a positive integer within the configured upload limit.",
    );
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftCodePoints[index] !== rightCodePoints[index]) {
      return leftCodePoints[index] - rightCodePoints[index];
    }
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Canonical crawler command numbers must be safe integers.");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Crawler commands contain only canonical JSON values.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function crawlerSourceUrlFingerprint(canonicalSourceUrl: string): string {
  let canonical: string;
  try {
    canonical = sourceUrl(canonicalSourceUrl);
  } catch {
    throw new TypeError("A canonical first-mode crawler source URL is required.");
  }
  if (canonical !== canonicalSourceUrl) {
    throw new TypeError("A canonical first-mode crawler source URL is required.");
  }
  return sha256(`${SOURCE_FINGERPRINT_DOMAIN}${canonical}`);
}

export function crawlerCommandRequestHash(
  command: Readonly<CrawlerAcquisitionCommandV1>,
): string {
  return sha256(`${COMMAND_HASH_DOMAIN}${canonicalJson(command)}`);
}

/**
 * Parse and freeze the only enabled remote acquisition command. Tenant, user,
 * storage, lifecycle, and status authority remain authenticated server inputs.
 */
function parseCrawlerAcquisitionCommandShapeV1(
  value: unknown,
  policy: {
    expectedVersion?: string;
    maximumBytes: number;
  },
): ParsedCrawlerAcquisitionCommandV1 {
  const record = exactRecord(value, COMMAND_KEYS);
  if (record.schemaVersion !== 1) {
    invalid("unsupported_schema", "Crawler command schemaVersion must be exactly 1.");
  }
  const canonicalSourceUrl = sourceUrl(record.sourceUrl);
  const command = Object.freeze<CrawlerAcquisitionCommandV1>({
    schemaVersion: 1,
    clientOperationId: clientOperationId(record.clientOperationId),
    expectedVersion: expectedVersion(record.expectedVersion),
    policyVersion: policy.expectedVersion === undefined
      ? parsedPolicyVersion(record.policyVersion)
      : policyVersion(record.policyVersion, policy.expectedVersion),
    sourceUrl: canonicalSourceUrl,
    displayFileName: displayFileName(record.displayFileName),
    rightsAttestation: rightsAttestation(record.rightsAttestation),
    robotsMode: record.robotsMode === CRAWLER_ROBOTS_MODE_V1
      ? CRAWLER_ROBOTS_MODE_V1
      : invalid(
        "robots_allowance_required",
        "The first crawler mode requires an affirmative robots allowance.",
      ),
    retentionMode: record.retentionMode === CRAWLER_RETENTION_MODE_V1
      ? CRAWLER_RETENTION_MODE_V1
      : invalid(
        "indefinite_retention_required",
        "The first crawler mode requires indefinite retention until user deletion.",
      ),
    maxBytes: maxBytes(record.maxBytes, policy.maximumBytes),
  });

  const sourceUrlFingerprint = crawlerSourceUrlFingerprint(command.sourceUrl);
  const requestHash = crawlerCommandRequestHash(command);
  if (!SHA256_PATTERN.test(sourceUrlFingerprint) || !SHA256_PATTERN.test(requestHash)) {
    throw new Error("Crawler command hashing failed closed.");
  }
  return Object.freeze({ command, sourceUrlFingerprint, requestHash });
}

export function parseCrawlerAcquisitionCommandV1(
  value: unknown,
  admissionPolicy: CrawlerCommandAdmissionPolicy,
): ParsedCrawlerAcquisitionCommandV1 {
  const policy = requireParserPolicy(admissionPolicy);
  return parseCrawlerAcquisitionCommandShapeV1(value, {
    expectedVersion: policy.policyVersion,
    maximumBytes: policy.maxResponseBytes,
  });
}

/**
 * Decode and hash a closed historical schema-v1 command before an authenticated
 * idempotency lookup. This deliberately does not admit new work: callers must
 * apply `parseCrawlerAcquisitionCommandV1` with the current policy whenever no
 * matching completed operation exists.
 */
export function parseCrawlerAcquisitionCommandV1ForReplay(
  value: unknown,
): ParsedCrawlerAcquisitionCommandV1 {
  return parseCrawlerAcquisitionCommandShapeV1(value, {
    maximumBytes: Number.MAX_SAFE_INTEGER,
  });
}

/** Convert every error to a closed DTO without serializing attacker input. */
export function crawlerPublicFailureFromError(
  error: unknown,
): CrawlerPublicFailureDto {
  if (error instanceof CrawlerCommandValidationError) {
    return {
      schemaVersion: 1,
      code: error.failureCode,
      message: error.message,
      retryable: false,
    };
  }
  return {
    schemaVersion: 1,
    code: "internal_error",
    message: "PaperPilot could not validate the crawler command.",
    retryable: false,
  };
}
