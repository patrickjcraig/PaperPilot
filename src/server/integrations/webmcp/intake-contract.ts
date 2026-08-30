import "server-only";

import type { Paper, PaperIdentifier } from "@/lib/types";
import { HttpProblem } from "@/server/http/problem";
import { canonicalizePublicWebSourceUrl } from "../web-source/url-policy";

export const MAX_WEB_MCP_PROPOSAL_COMMAND_BYTES = 64 * 1_024;

const MAX_TITLE_LENGTH = 2_000;
const MAX_AUTHOR_LENGTH = 300;
const MAX_AUTHORS = 200;
const MAX_VENUE_LENGTH = 1_000;
const MAX_ABSTRACT_LENGTH = 40_000;
const MAX_IDENTIFIERS = 32;
const MAX_IDENTIFIER_VALUE_LENGTH = 1_024;
const MAX_LICENSE_LENGTH = 500;
const MAX_VERSION_LENGTH = 200;

const COMMAND_KEYS = new Set([
  "schemaVersion",
  "clientOperationId",
  "expectedVersion",
  "proposal",
]);
const PROPOSAL_KEYS = new Set([
  "title",
  "authors",
  "year",
  "venue",
  "publicationType",
  "abstract",
  "identifiers",
  "sourcePageUrl",
  "candidatePdfUrl",
  "isOpenAccess",
  "license",
  "version",
]);
const IDENTIFIER_KEYS = new Set(["scheme", "value"]);
const PAPER_TYPES = new Set<Paper["type"]>([
  "journal article",
  "conference paper",
  "review",
  "methods paper",
  "application study",
]);
const IDENTIFIER_SCHEMES = new Set<PaperIdentifier["scheme"]>([
  "doi",
  "arxiv",
  "isbn",
  "provider",
]);
const SECRET_QUERY_KEY_PATTERN =
  /token|secret|signature|credential|authorization|password|session|api[_-]?key/i;

export interface WebMcpProposal {
  title: string;
  authors: string[];
  year: number;
  venue: string;
  publicationType: Paper["type"];
  abstract?: string;
  identifiers?: PaperIdentifier[];
  sourcePageUrl: string;
  candidatePdfUrl?: string;
  isOpenAccess?: boolean;
  license?: string;
  version?: string;
}

export interface WebMcpProposalCommand {
  schemaVersion: 1;
  clientOperationId: string;
  expectedVersion: number;
  proposal: WebMcpProposal;
}

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
  if (unexpected) {
    validation(`${label} contains an unsupported field: ${unexpected}.`);
  }
  return record;
}

function requireExactKeys(
  record: Record<string, unknown>,
  label: string,
  expectedKeys: ReadonlySet<string>,
): void {
  const missing = [...expectedKeys].find(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (missing) validation(`${label} is missing required field: ${missing}.`);
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") validation(`${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    validation(
      `${label} must contain 1 to ${maximum.toLocaleString()} characters.`,
    );
  }
  return normalized;
}

function optionalString(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    validation(`${label} must be text when provided.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    validation(`${label} may contain at most ${maximum.toLocaleString()} characters.`);
  }
  return normalized || undefined;
}

function requiredNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    validation(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function normalizeDoi(value: string): string {
  const normalized = value
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(normalized)) {
    validation("DOI identifiers must use a valid 10.<registrant>/<suffix> form.");
  }
  return normalized;
}

function normalizeArxiv(value: string): string {
  const normalized = value
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/^arxiv:\s*/i, "")
    .trim()
    .toLowerCase();
  if (
    !/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(normalized)
    && !/^[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?$/.test(normalized)
  ) {
    validation("arXiv identifiers must use a valid arXiv identifier form.");
  }
  return normalized;
}

function normalizeIsbn(value: string): string {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^(?:\d{9}[\dX]|\d{13})$/.test(normalized)) {
    validation("ISBN identifiers must contain a valid 10- or 13-character identifier.");
  }
  return normalized;
}

function normalizeIdentifier(value: unknown, index: number): PaperIdentifier {
  const label = `proposal.identifiers[${index}]`;
  const record = exactRecord(value, label, IDENTIFIER_KEYS);
  requireExactKeys(record, label, IDENTIFIER_KEYS);
  const scheme = record.scheme;
  if (
    typeof scheme !== "string"
    || !IDENTIFIER_SCHEMES.has(scheme as PaperIdentifier["scheme"])
  ) {
    validation(`${label}.scheme is invalid.`);
  }
  const rawValue = requiredString(
    record.value,
    `${label}.value`,
    MAX_IDENTIFIER_VALUE_LENGTH,
  );
  const normalizedValue = scheme === "doi"
    ? normalizeDoi(rawValue)
    : scheme === "arxiv"
      ? normalizeArxiv(rawValue)
      : scheme === "isbn"
        ? normalizeIsbn(rawValue)
        : rawValue;
  return {
    scheme: scheme as PaperIdentifier["scheme"],
    value: normalizedValue,
  };
}

function normalizeIdentifiers(value: unknown): PaperIdentifier[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_IDENTIFIERS) {
    validation(
      `proposal.identifiers must be an array containing at most ${MAX_IDENTIFIERS} identifiers.`,
    );
  }
  const identifiers = value.map(normalizeIdentifier);
  return identifiers.filter((identifier, index, all) =>
    all.findIndex((candidate) =>
      candidate.scheme === identifier.scheme
      && candidate.value.toLowerCase() === identifier.value.toLowerCase(),
    ) === index,
  );
}

function canonicalPublicUrl(value: unknown, label: string): string {
  let canonical: string;
  try {
    canonical = canonicalizePublicWebSourceUrl(value).url;
  } catch {
    return validation(`${label} must be an eligible public HTTPS URL.`);
  }
  const secretKey = [...new URL(canonical).searchParams.keys()].find((key) =>
    SECRET_QUERY_KEY_PATTERN.test(key),
  );
  if (secretKey) {
    validation(`${label} must not contain credential-bearing query keys.`);
  }
  return canonical;
}

function optionalCanonicalPublicUrl(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  return canonicalPublicUrl(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") validation(`${label} must be a boolean when provided.`);
  return value;
}

function normalizeProposal(value: unknown): WebMcpProposal {
  const record = exactRecord(value, "proposal", PROPOSAL_KEYS);

  if (!Array.isArray(record.authors) || record.authors.length < 1 || record.authors.length > MAX_AUTHORS) {
    validation(
      `proposal.authors must be an array containing 1 to ${MAX_AUTHORS} names.`,
    );
  }
  const authors = record.authors.map((author, index) =>
    requiredString(author, `proposal.authors[${index}]`, MAX_AUTHOR_LENGTH),
  );

  const year = requiredNonnegativeSafeInteger(record.year, "proposal.year");
  const maximumYear = new Date().getUTCFullYear() + 5;
  if (year > maximumYear) {
    validation(`proposal.year must be an integer between 0 and ${maximumYear}.`);
  }

  if (
    typeof record.publicationType !== "string"
    || !PAPER_TYPES.has(record.publicationType as Paper["type"])
  ) {
    validation("proposal.publicationType is invalid.");
  }

  const abstract = optionalString(
    record.abstract,
    "proposal.abstract",
    MAX_ABSTRACT_LENGTH,
  );
  const identifiers = normalizeIdentifiers(record.identifiers);
  const candidatePdfUrl = optionalCanonicalPublicUrl(
    record.candidatePdfUrl,
    "proposal.candidatePdfUrl",
  );
  const isOpenAccess = optionalBoolean(
    record.isOpenAccess,
    "proposal.isOpenAccess",
  );
  const license = optionalString(
    record.license,
    "proposal.license",
    MAX_LICENSE_LENGTH,
  );
  const version = optionalString(
    record.version,
    "proposal.version",
    MAX_VERSION_LENGTH,
  );

  return {
    title: requiredString(record.title, "proposal.title", MAX_TITLE_LENGTH),
    authors,
    year,
    venue: requiredString(record.venue, "proposal.venue", MAX_VENUE_LENGTH),
    publicationType: record.publicationType as Paper["type"],
    ...(abstract === undefined ? {} : { abstract }),
    ...(identifiers === undefined ? {} : { identifiers }),
    sourcePageUrl: canonicalPublicUrl(record.sourcePageUrl, "proposal.sourcePageUrl"),
    ...(candidatePdfUrl === undefined ? {} : { candidatePdfUrl }),
    ...(isOpenAccess === undefined ? {} : { isOpenAccess }),
    ...(license === undefined ? {} : { license }),
    ...(version === undefined ? {} : { version }),
  };
}

/**
 * Accepts only source metadata. Organization, actor, custody, storage, document,
 * provenance, and lifecycle authority must be supplied by authenticated server
 * code after this boundary.
 */
export function parseWebMcpProposalCommand(value: unknown): WebMcpProposalCommand {
  const record = exactRecord(value, "WebMcpProposalCommand", COMMAND_KEYS);
  requireExactKeys(record, "WebMcpProposalCommand", COMMAND_KEYS);
  if (record.schemaVersion !== 1) {
    validation("schemaVersion must be exactly 1.");
  }
  return {
    schemaVersion: 1,
    clientOperationId: requiredString(
      record.clientOperationId,
      "clientOperationId",
      200,
    ),
    expectedVersion: requiredNonnegativeSafeInteger(
      record.expectedVersion,
      "expectedVersion",
    ),
    proposal: normalizeProposal(record.proposal),
  };
}
