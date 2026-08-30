import "server-only";

import type { EvidenceNote } from "@/lib/types";
import type { GroundedEvidenceSelection } from "@/lib/workspace/contracts";
import { HttpProblem } from "@/server/http/problem";

export const MAX_EVIDENCE_REVISION_COMMAND_BYTES = 128 * 1024;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^(?!0{64})[0-9a-f]{64}$/;
const MAX_SEQUENCE = 4_095;
const MAX_SEQUENCE_SPAN = 99;
const MAX_START_BYTE_OFFSET = 8_191;
const MAX_END_BYTE_OFFSET = 8_192;
const ENVELOPE_KEYS = new Set(["clientOperationId", "expectedVersion", "action"]);
const REANCHOR_KEYS = new Set([
  "clientOperationId",
  "expectedVersion",
  "action",
  "selection",
]);
const SELECTION_KEYS = new Set([
  "documentId",
  "extractionId",
  "manifestSha256",
  "start",
  "end",
  "expectedQuoteSha256",
]);
const BOUNDARY_KEYS = new Set(["chunkId", "sequence", "byteOffset", "contentHash"]);

export interface VerifyGroundedEvidenceCommand {
  clientOperationId: string;
  expectedVersion: number;
  action: "verify";
}

export interface ReanchorGroundedEvidenceCommand {
  clientOperationId: string;
  expectedVersion: number;
  action: "reanchor";
  selection: GroundedEvidenceSelection;
}

export type GroundedEvidenceRevisionCommand =
  | VerifyGroundedEvidenceCommand
  | ReanchorGroundedEvidenceCommand;

export type GroundedEvidenceRevisionFailureCode =
  | "not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "selection_conflict"
  | "revision_conflict";

export interface GroundedEvidenceRevisionResult {
  predecessorId: string;
  note: EvidenceNote;
  linkedProjectIds: string[];
  updatedCollectionIds: string[];
}

export type GroundedEvidenceRevisionResponse =
  | {
    ok: true;
    outcome: "applied" | "replayed";
    aggregateVersion: number;
    data: GroundedEvidenceRevisionResult;
  }
  | {
    ok: false;
    code: GroundedEvidenceRevisionFailureCode;
    aggregateVersion: number;
    message: string;
  };

function invalid(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function asRecord(
  value: unknown,
  label: string,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).find((key) => !allowed.has(key));
  if (unsupported) invalid(`${label} contains an unsupported field: ${unsupported}.`);
  return record;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") invalid(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    invalid(`${label} must contain 1 to ${maximum.toLocaleString()} characters.`);
  }
  return normalized;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    invalid(`${label} must be a valid opaque identifier.`);
  }
  return value;
}

function digestValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function selectionBoundary(
  value: unknown,
  label: "selection.start" | "selection.end",
  maximumOffset: number,
) {
  const record = asRecord(value, label, BOUNDARY_KEYS);
  return {
    chunkId: opaqueId(record.chunkId, `${label}.chunkId`),
    sequence: boundedInteger(record.sequence, `${label}.sequence`, 0, MAX_SEQUENCE),
    byteOffset: boundedInteger(record.byteOffset, `${label}.byteOffset`, 0, maximumOffset),
    contentHash: digestValue(record.contentHash, `${label}.contentHash`),
  };
}

function groundedSelection(value: unknown): GroundedEvidenceSelection {
  const record = asRecord(value, "selection", SELECTION_KEYS);
  const start = selectionBoundary(record.start, "selection.start", MAX_START_BYTE_OFFSET);
  const end = selectionBoundary(record.end, "selection.end", MAX_END_BYTE_OFFSET);
  if (end.byteOffset < 1) invalid("selection.end.byteOffset must be at least 1.");
  if (end.sequence < start.sequence || end.sequence - start.sequence > MAX_SEQUENCE_SPAN) {
    invalid("selection must cover one ordered range of at most 100 contiguous chunks.");
  }
  if (start.sequence === end.sequence) {
    if (start.chunkId !== end.chunkId || start.contentHash !== end.contentHash) {
      invalid("A single-chunk selection must use one exact chunk identity.");
    }
    if (end.byteOffset <= start.byteOffset) {
      invalid("A grounded evidence selection cannot be empty.");
    }
  }
  return {
    documentId: opaqueId(record.documentId, "selection.documentId"),
    extractionId: opaqueId(record.extractionId, "selection.extractionId"),
    manifestSha256: digestValue(record.manifestSha256, "selection.manifestSha256"),
    start,
    end,
    expectedQuoteSha256: digestValue(
      record.expectedQuoteSha256,
      "selection.expectedQuoteSha256",
    ),
  };
}

/** Strictly parse the closed, action-discriminated successor command. */
export function validateGroundedEvidenceRevisionCommand(
  raw: unknown,
): GroundedEvidenceRevisionCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("Grounded evidence revision command must be an object.");
  }
  const action = (raw as Record<string, unknown>).action;
  if (action !== "verify" && action !== "reanchor") {
    invalid("action must be verify or reanchor.");
  }
  const record = asRecord(
    raw,
    "Grounded evidence revision command",
    action === "verify" ? ENVELOPE_KEYS : REANCHOR_KEYS,
  );
  const clientOperationId = requiredText(record.clientOperationId, "clientOperationId", 200);
  const expectedVersion = boundedInteger(
    record.expectedVersion,
    "expectedVersion",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (action === "verify") {
    return { clientOperationId, expectedVersion, action };
  }
  return {
    clientOperationId,
    expectedVersion,
    action,
    selection: groundedSelection(record.selection),
  };
}
