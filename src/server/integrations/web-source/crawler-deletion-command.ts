import "server-only";

import { createHash } from "node:crypto";

import { HttpProblem } from "@/server/http/problem";

export const MAX_CRAWLER_CUSTODY_DELETION_COMMAND_BYTES = 4 * 1_024;

const COMMAND_KEYS = new Set([
  "schemaVersion",
  "clientOperationId",
  "expectedVersion",
  "crawlerImportId",
  "confirmDeletion",
]);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REQUEST_HASH_DOMAIN = "paperpilot:crawler:custody-deletion-command:v1\u0000";

export interface CrawlerCustodyDeletionCommandV1 {
  schemaVersion: 1;
  clientOperationId: string;
  expectedVersion: number;
  crawlerImportId: string;
  confirmDeletion: true;
}

export interface ParsedCrawlerCustodyDeletionCommandV1 {
  command: Readonly<CrawlerCustodyDeletionCommandV1>;
  requestHash: string;
}

function invalid(message: string): never {
  throw new HttpProblem(400, "invalid_crawler_deletion_command", message);
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function canonicalJson(command: CrawlerCustodyDeletionCommandV1): string {
  return JSON.stringify({
    clientOperationId: command.clientOperationId,
    confirmDeletion: command.confirmDeletion,
    crawlerImportId: command.crawlerImportId,
    expectedVersion: command.expectedVersion,
    schemaVersion: command.schemaVersion,
  });
}

export function crawlerCustodyDeletionRequestHash(
  command: CrawlerCustodyDeletionCommandV1,
): string {
  return createHash("sha256")
    .update(`${REQUEST_HASH_DOMAIN}${canonicalJson(command)}`, "utf8")
    .digest("hex");
}

/**
 * Parse the deliberately small destructive command. The target is repeated in
 * the body so an idempotency key can never be replayed through a different URL.
 */
export function parseCrawlerCustodyDeletionCommandV1(
  value: unknown,
  expectedCrawlerImportId: string,
): ParsedCrawlerCustodyDeletionCommandV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("The crawler deletion command shape is not supported.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== COMMAND_KEYS.size
    || keys.some((key) => !COMMAND_KEYS.has(key))
    || [...COMMAND_KEYS].some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key),
    )
  ) {
    invalid("The crawler deletion command shape is not supported.");
  }
  if (record.schemaVersion !== 1) {
    invalid("Crawler deletion schemaVersion must be exactly 1.");
  }
  const crawlerImportId = opaqueId(record.crawlerImportId, "crawlerImportId");
  if (
    !OPAQUE_ID_PATTERN.test(expectedCrawlerImportId)
    || crawlerImportId !== expectedCrawlerImportId
  ) {
    invalid("crawlerImportId must match the requested crawler record.");
  }
  if (
    typeof record.expectedVersion !== "number"
    || !Number.isSafeInteger(record.expectedVersion)
    || record.expectedVersion < 0
  ) {
    invalid("expectedVersion must be a non-negative safe integer.");
  }
  if (record.confirmDeletion !== true) {
    invalid("An explicit crawler custody deletion confirmation is required.");
  }
  const command = Object.freeze<CrawlerCustodyDeletionCommandV1>({
    schemaVersion: 1,
    clientOperationId: opaqueId(record.clientOperationId, "clientOperationId"),
    expectedVersion: record.expectedVersion,
    crawlerImportId,
    confirmDeletion: true,
  });
  return Object.freeze({
    command,
    requestHash: crawlerCustodyDeletionRequestHash(command),
  });
}

