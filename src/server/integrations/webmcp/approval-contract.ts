import "server-only";

import { HttpProblem } from "@/server/http/problem";

export const MAX_WEB_MCP_APPROVAL_COMMAND_BYTES = 16 * 1_024;
export const MAX_WEB_MCP_APPROVAL_PREPARATION_COMMAND_BYTES = 16 * 1_024;

const INTENT_KEYS = [
  "expectedVersion",
  "inboxEntryId",
  "proposalDigest",
  "destinationProjectId",
  "duplicateDecision",
] as const;
const PREPARATION_COMMAND_KEYS = new Set([
  "schemaVersion",
  ...INTENT_KEYS,
]);
const HISTORICAL_APPROVAL_COMMAND_KEYS = new Set([
  "schemaVersion",
  "clientOperationId",
  ...INTENT_KEYS,
]);
const APPROVAL_COMMAND_KEYS = new Set([
  "schemaVersion",
  "clientOperationId",
  ...INTENT_KEYS,
  "challengeId",
  "evidenceDigest",
]);
const CREATE_NEW_KEYS = new Set(["kind"]);
const USE_EXISTING_KEYS = new Set(["kind", "canonicalPaperId"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type WebMcpDuplicateDecision =
  | { kind: "create_new" }
  | { kind: "use_existing"; canonicalPaperId: string };

export interface WebMcpApprovalIntent {
  expectedVersion: number;
  inboxEntryId: string;
  proposalDigest: string;
  destinationProjectId: string;
  duplicateDecision: WebMcpDuplicateDecision;
}

/**
 * The first step freezes the reviewer intent before any provider evidence is
 * displayed. It deliberately has no idempotency key: retrying preparation may
 * mint another independent, short-lived review capability.
 */
export interface WebMcpApprovalPreparationCommand extends WebMcpApprovalIntent {
  schemaVersion: 1;
}

/**
 * Retained only so a completed pre-cutover operation can return its stored
 * response. A v1 command can never perform a new approval after cutover.
 */
export interface HistoricalWebMcpApprovalCommandV1 extends WebMcpApprovalIntent {
  schemaVersion: 1;
  clientOperationId: string;
}

/** Final human consent, bound to the exact provider dossier shown in step 1. */
export interface WebMcpApprovalCommand extends WebMcpApprovalIntent {
  schemaVersion: 2;
  clientOperationId: string;
  challengeId: string;
  evidenceDigest: string;
}

export type ParsedWebMcpApprovalCommand =
  | HistoricalWebMcpApprovalCommandV1
  | WebMcpApprovalCommand;

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function exactRecord(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return validation(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unexpected) validation(`${label} contains an unsupported field: ${unexpected}.`);
  const missing = [...allowedKeys].find(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (missing) validation(`${label} is missing required field: ${missing}.`);
  return record;
}

function requiredString(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string") validation(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    validation(`${label} must contain 1 to ${maximum.toLocaleString()} characters.`);
  }
  return normalized;
}

function sha256(value: unknown, label: string): string {
  const digest = requiredString(value, label, 64);
  if (!SHA256_PATTERN.test(digest)) {
    validation(`${label} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    validation(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function duplicateDecision(value: unknown): WebMcpDuplicateDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return validation("duplicateDecision must be an object.");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "create_new") {
    exactRecord(value, "duplicateDecision", CREATE_NEW_KEYS);
    return { kind };
  }
  if (kind === "use_existing") {
    const record = exactRecord(value, "duplicateDecision", USE_EXISTING_KEYS);
    return {
      kind,
      canonicalPaperId: requiredString(
        record.canonicalPaperId,
        "duplicateDecision.canonicalPaperId",
      ),
    };
  }
  return validation("duplicateDecision.kind must be create_new or use_existing.");
}

function approvalIntent(
  record: Record<string, unknown>,
  routeInboxEntryId: string,
): WebMcpApprovalIntent {
  const inboxEntryId = requiredString(record.inboxEntryId, "inboxEntryId");
  if (inboxEntryId !== routeInboxEntryId) {
    validation("The route inbox entry must match the command inboxEntryId.");
  }
  return {
    expectedVersion: nonnegativeSafeInteger(record.expectedVersion, "expectedVersion"),
    inboxEntryId,
    proposalDigest: sha256(record.proposalDigest, "proposalDigest"),
    destinationProjectId: requiredString(
      record.destinationProjectId,
      "destinationProjectId",
    ),
    duplicateDecision: duplicateDecision(record.duplicateDecision),
  };
}

export function parseWebMcpApprovalPreparationCommand(
  value: unknown,
  routeInboxEntryId: string,
): WebMcpApprovalPreparationCommand {
  const record = exactRecord(
    value,
    "WebMcpApprovalPreparationCommand",
    PREPARATION_COMMAND_KEYS,
  );
  if (record.schemaVersion !== 1) {
    validation("WebMcpApprovalPreparationCommand.schemaVersion must be exactly 1.");
  }
  return {
    schemaVersion: 1,
    ...approvalIntent(record, routeInboxEntryId),
  };
}

/**
 * Decode final consent. Historical v1 is decoded only for an exact completed
 * idempotency replay; the service rejects every new or unresolved v1 command.
 */
export function parseWebMcpApprovalCommand(
  value: unknown,
  routeInboxEntryId: string,
): ParsedWebMcpApprovalCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    validation("WebMcpApprovalCommand must be an object.");
  }
  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  if (schemaVersion === 1) {
    const record = exactRecord(
      value,
      "HistoricalWebMcpApprovalCommandV1",
      HISTORICAL_APPROVAL_COMMAND_KEYS,
    );
    return {
      schemaVersion: 1,
      clientOperationId: requiredString(record.clientOperationId, "clientOperationId"),
      ...approvalIntent(record, routeInboxEntryId),
    };
  }
  if (schemaVersion !== 2) {
    validation("WebMcpApprovalCommand.schemaVersion must be exactly 2.");
  }
  const record = exactRecord(value, "WebMcpApprovalCommand", APPROVAL_COMMAND_KEYS);
  const challengeId = requiredString(record.challengeId, "challengeId", 43);
  if (!CHALLENGE_ID_PATTERN.test(challengeId)) {
    validation("challengeId must be a 256-bit base64url review capability.");
  }
  return {
    schemaVersion: 2,
    clientOperationId: requiredString(record.clientOperationId, "clientOperationId"),
    ...approvalIntent(record, routeInboxEntryId),
    challengeId,
    evidenceDigest: sha256(record.evidenceDigest, "evidenceDigest"),
  };
}
