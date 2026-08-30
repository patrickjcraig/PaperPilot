import "server-only";

import { createHash } from "node:crypto";
import type {
  InboxEntry,
  ImportSourceKind,
  Paper,
  PaperIdentifier,
  Provenance,
  SourceLocator,
} from "@/lib/types";
import type {
  FileImportResult,
  StageImportResult,
  WorkspaceCommandFailure,
  WorkspaceCommandResult,
} from "@/lib/workspace";
import {
  Prisma,
  type ImportSource,
  type InboxEntryStatus,
  type PaperIdentifierType,
  type PaperSource,
  type ProvenanceKind,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveLiveRetainedAuditPrincipal } from "@/server/audit/retained-principal";
import { HttpProblem } from "@/server/http/problem";
import { WEB_MCP_PROVIDER_NAME } from "@/server/integrations/webmcp/authority";
import {
  isServerManagedWebMcpSnapshot,
  webMcpSnapshotDigest,
  type ServerManagedWebMcpSnapshot,
} from "@/server/integrations/webmcp/snapshot-contract";
import { paperDto, projectDto } from "./service";
import {
  paperInboxEntryDto,
  storedImportSnapshot,
  type InboxEntryForDto,
  type StoredImportSnapshot,
} from "./import-dto";
import { acquireWorkspaceMembershipAuthorityShared } from "./membership-lock";
import {
  inboxEntryVisibleTo,
  projectVisibleTo,
  requireWorkspaceMutationRole,
  workspacePaperVisibleTo,
} from "./project-access";

export const MAX_IMPORT_COMMAND_BYTES = 256 * 1_024;
const MAX_PROVIDER_SNAPSHOT_BYTES = 224 * 1_024;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TRANSACTION_ATTEMPTS = 4;

const PAPER_TYPES = new Set<Paper["type"]>([
  "journal article",
  "conference paper",
  "review",
  "methods paper",
  "application study",
]);
const EVIDENCE_STRENGTHS = new Set<Paper["evidenceStrength"]>([
  "foundational",
  "strong",
  "promising",
  "contextual",
  "unassessed",
]);
const READING_STATUSES = new Set<Paper["readingStatus"]>([
  "unread",
  "queued",
  "reading",
  "reviewed",
]);
const IDENTIFIER_SCHEMES = new Set<PaperIdentifier["scheme"]>([
  "doi",
  "arxiv",
  "isbn",
  "provider",
]);
const IMPORT_SOURCE_KINDS = new Set<ImportSourceKind>([
  "discover",
  "zotero",
  "upload",
  "crawler",
  "webmcp",
  "identifier",
]);
const USER_ASSERTABLE_IMPORT_SOURCE_KINDS = new Set<InboxEntry["sourceKind"]>([
  "discover",
  "identifier",
]);
const PROVENANCE_SOURCE_TYPES = new Set<Provenance["sourceType"]>([
  "paper",
  "figure",
  "citation-library",
  "note-system",
  "evidence-store",
  "literature-index",
  "uploaded-file",
  "web-source",
]);
const PROVENANCE_ACCESS_METHODS = new Set<Provenance["accessMethod"]>([
  "seeded-demo",
  "manual",
  "api",
  "upload",
  "oauth",
  "crawler",
  "mcp",
  "webmcp",
]);
const SERVER_MANAGED_PROVENANCE_ACCESS_METHODS = new Set<Provenance["accessMethod"]>([
  "upload",
  "oauth",
  "crawler",
  "mcp",
  "webmcp",
]);
const FILEABLE_INBOX_STATUSES = new Set<InboxEntryStatus>([
  "PENDING",
  "MATCHED",
  "DUPLICATE",
]);
const SERVER_MANAGED_IMPORT_MESSAGE =
  "This import source requires a server-managed ingestion pipeline.";
const NON_FILEABLE_IMPORT_MESSAGE = "This inbox entry is not eligible to be filed.";
const HIDDEN_IMPORT_TARGET_MESSAGE = "The import target was not found.";
const WEB_MCP_REVIEW_REQUIRED_MESSAGE =
  "WebMCP proposals require a separate reviewed approval before filing.";
const PUBLIC_CANONICAL_METADATA_SOURCES = new Set<PaperSource>([
  "OPENALEX",
  "CROSSREF",
  "PUBMED",
  "ARXIV",
  "SEMANTIC_SCHOLAR",
]);

const PAPER_KEYS = new Set([
  "id", "title", "shortTitle", "authors", "year", "venue", "type",
  "abstract", "abstractSnippet", "whyRead", "relevanceScore", "relevanceTags",
  "evidenceStrength", "readingStatus", "readingProgress", "estimatedMinutes",
  "citationCount", "providerRelevanceScore", "identifiers", "sourceUrl", "access",
  "isRetracted", "providerUpdatedAt", "isDemoRecord",
]);
const ACCESS_KEYS = new Set([
  "isOpenAccess", "hasFullText", "landingPageUrl", "pdfUrl", "license", "version",
]);
const IDENTIFIER_KEYS = new Set(["scheme", "value"]);
const PROVENANCE_KEYS = new Set([
  "id", "sourceType", "sourceId", "sourceTitle", "sourceUrl", "providerName",
  "retrievedAt", "accessMethod", "locator", "excerpt", "version",
]);
const LOCATOR_KEYS = new Set([
  "paperId", "sectionId", "sectionTitle", "page", "pageRange", "paragraphId",
  "figureId", "figureLabel",
]);
const STAGE_COMMAND_KEYS = new Set([
  "clientOperationId", "expectedVersion", "sourceKind", "paper", "provenance",
]);
const FILE_COMMAND_KEYS = new Set([
  "clientOperationId", "expectedVersion", "inboxEntryId", "projectId",
]);

export interface ImportSessionUser {
  id: string;
  name: string;
}

interface ValidatedEnvelope {
  clientOperationId: string;
  expectedVersion: number;
}

interface ValidatedStageImport extends ValidatedEnvelope {
  sourceKind: ImportSourceKind;
  snapshot: StoredImportSnapshot;
}

export interface ServerManagedWebMcpStageCommand extends ValidatedEnvelope {
  snapshot: ServerManagedWebMcpSnapshot;
}

interface StageImportAuthority {
  command: "stageImport" | "stageWebMcpProposal";
  provenanceKind: "DISCOVERY" | "WEB_MCP";
  auditAppliedAction: "import.staged" | "webmcp.proposal.staged";
  auditNoopAction: "import.stage.noop" | "webmcp.proposal.noop";
}

interface ValidatedFileImport extends ValidatedEnvelope {
  inboxEntryId: string;
  projectId: string;
}

interface IdentifierCandidate {
  type: PaperIdentifierType;
  value: string;
  normalizedValue: string;
  source: PaperSource;
}

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function asRecord(
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
  return record;
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") validation(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    validation(`${label} must contain 1 to ${max.toLocaleString()} characters.`);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") validation(`${label} must be text when provided.`);
  const normalized = value.trim();
  if (normalized.length > max) validation(`${label} may contain at most ${max.toLocaleString()} characters.`);
  return normalized || undefined;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") validation(`${label} must be a boolean.`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requiredBoolean(value, label);
}

function finiteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  options: { optional?: boolean; integer?: boolean } = {},
): number | undefined {
  if (value === undefined && options.optional) return undefined;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
    || (options.integer && !Number.isSafeInteger(value))
  ) {
    validation(`${label} must be ${options.integer ? "an integer" : "a finite number"} between ${minimum} and ${maximum}.`);
  }
  return value;
}

function urlString(value: unknown, label: string): string | undefined {
  const candidate = optionalString(value, label, 2_048);
  if (!candidate) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return validation(`${label} must be a valid HTTP or HTTPS URL.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
  ) {
    validation(`${label} must be an HTTP or HTTPS URL without embedded credentials.`);
  }
  return url.toString();
}

function isoDateTime(value: unknown, label: string): string {
  const candidate = requiredString(value, label, 100);
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) validation(`${label} must be an ISO-8601 date and time.`);
  return new Date(timestamp).toISOString();
}

function optionalIsoDateTime(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return isoDateTime(value, label);
}

function normalizeDoi(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/i.test(normalized)) {
    validation("DOI identifiers must use a valid 10.<registrant>/<suffix> form.");
  }
  return normalized;
}

function normalizeArxiv(value: string): string {
  return value.trim().replace(/^arxiv:\s*/i, "").toLowerCase();
}

function normalizeIsbn(value: string): string {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^(?:\d{9}[\dX]|\d{13})$/.test(normalized)) {
    validation("ISBN identifiers must contain a valid 10- or 13-character identifier.");
  }
  return normalized;
}

function normalizeIdentifier(identifier: unknown, index: number): PaperIdentifier {
  const record = asRecord(identifier, `paper.identifiers[${index}]`, IDENTIFIER_KEYS);
  const scheme = record.scheme;
  if (typeof scheme !== "string" || !IDENTIFIER_SCHEMES.has(scheme as PaperIdentifier["scheme"])) {
    validation(`paper.identifiers[${index}].scheme is invalid.`);
  }
  const rawValue = requiredString(record.value, `paper.identifiers[${index}].value`, 1_024);
  const value = scheme === "doi"
    ? normalizeDoi(rawValue)
    : scheme === "arxiv"
      ? normalizeArxiv(rawValue)
      : scheme === "isbn"
        ? normalizeIsbn(rawValue)
        : rawValue;
  return { scheme: scheme as PaperIdentifier["scheme"], value };
}

function normalizePaper(value: unknown): Paper {
  const record = asRecord(value, "paper", PAPER_KEYS);
  const id = requiredString(record.id, "paper.id", 512);
  const title = requiredString(record.title, "paper.title", 2_000);
  const shortTitle = requiredString(record.shortTitle, "paper.shortTitle", 500);
  if (!Array.isArray(record.authors) || record.authors.length > 200) {
    validation("paper.authors must be an array containing at most 200 names.");
  }
  const authors = record.authors.map((author, index) =>
    requiredString(author, `paper.authors[${index}]`, 300),
  );
  if (!Array.isArray(record.relevanceTags) || record.relevanceTags.length > 50) {
    validation("paper.relevanceTags must be an array containing at most 50 tags.");
  }
  const relevanceTags = record.relevanceTags.map((tag, index) =>
    requiredString(tag, `paper.relevanceTags[${index}]`, 120),
  );
  if (!Array.isArray(record.identifiers) || record.identifiers.length > 32) {
    validation("paper.identifiers must be an array containing at most 32 identifiers.");
  }
  const identifiers = record.identifiers.map(normalizeIdentifier);
  const uniqueIdentifiers = identifiers.filter((identifier, index, all) =>
    all.findIndex((candidate) =>
      candidate.scheme === identifier.scheme
      && candidate.value.toLowerCase() === identifier.value.toLowerCase(),
    ) === index,
  );
  if (typeof record.type !== "string" || !PAPER_TYPES.has(record.type as Paper["type"])) {
    validation("paper.type is invalid.");
  }
  if (
    typeof record.evidenceStrength !== "string"
    || !EVIDENCE_STRENGTHS.has(record.evidenceStrength as Paper["evidenceStrength"])
  ) {
    validation("paper.evidenceStrength is invalid.");
  }
  if (
    typeof record.readingStatus !== "string"
    || !READING_STATUSES.has(record.readingStatus as Paper["readingStatus"])
  ) {
    validation("paper.readingStatus is invalid.");
  }

  let access: Paper["access"];
  if (record.access !== undefined) {
    const accessRecord = asRecord(record.access, "paper.access", ACCESS_KEYS);
    access = {
      isOpenAccess: requiredBoolean(accessRecord.isOpenAccess, "paper.access.isOpenAccess"),
      hasFullText: requiredBoolean(accessRecord.hasFullText, "paper.access.hasFullText"),
      landingPageUrl: urlString(accessRecord.landingPageUrl, "paper.access.landingPageUrl"),
      pdfUrl: urlString(accessRecord.pdfUrl, "paper.access.pdfUrl"),
      license: optionalString(accessRecord.license, "paper.access.license", 500),
      version: optionalString(accessRecord.version, "paper.access.version", 200),
    };
  }

  return {
    id,
    title,
    shortTitle,
    authors,
    year: finiteNumber(record.year, "paper.year", 0, new Date().getUTCFullYear() + 5, { integer: true })!,
    venue: requiredString(record.venue, "paper.venue", 1_000),
    type: record.type as Paper["type"],
    abstract: optionalString(record.abstract, "paper.abstract", 150_000) ?? "",
    abstractSnippet: optionalString(record.abstractSnippet, "paper.abstractSnippet", 5_000) ?? "",
    whyRead: optionalString(record.whyRead, "paper.whyRead", 10_000) ?? "",
    relevanceScore: finiteNumber(record.relevanceScore, "paper.relevanceScore", 0, 100_000)!,
    relevanceTags,
    evidenceStrength: record.evidenceStrength as Paper["evidenceStrength"],
    readingStatus: record.readingStatus as Paper["readingStatus"],
    readingProgress: finiteNumber(record.readingProgress, "paper.readingProgress", 0, 100)!,
    estimatedMinutes: finiteNumber(record.estimatedMinutes, "paper.estimatedMinutes", 0, 100_000, { integer: true })!,
    citationCount: finiteNumber(record.citationCount, "paper.citationCount", 0, 2_000_000_000, { optional: true, integer: true }),
    providerRelevanceScore: finiteNumber(record.providerRelevanceScore, "paper.providerRelevanceScore", -1_000_000_000, 1_000_000_000, { optional: true }),
    identifiers: uniqueIdentifiers,
    sourceUrl: urlString(record.sourceUrl, "paper.sourceUrl"),
    access,
    isRetracted: optionalBoolean(record.isRetracted, "paper.isRetracted"),
    providerUpdatedAt: optionalIsoDateTime(record.providerUpdatedAt, "paper.providerUpdatedAt"),
    isDemoRecord: requiredBoolean(record.isDemoRecord, "paper.isDemoRecord"),
  };
}

function normalizeLocator(value: unknown, paperId: string): SourceLocator | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, "provenance.locator", LOCATOR_KEYS);
  const locatorPaperId = requiredString(record.paperId, "provenance.locator.paperId", 512);
  if (locatorPaperId !== paperId) {
    validation("provenance.locator.paperId must match paper.id.");
  }
  let pageRange: [number, number] | undefined;
  if (record.pageRange !== undefined) {
    if (!Array.isArray(record.pageRange) || record.pageRange.length !== 2) {
      validation("provenance.locator.pageRange must contain exactly two page numbers.");
    }
    const first = finiteNumber(record.pageRange[0], "provenance.locator.pageRange[0]", 1, 1_000_000, { integer: true })!;
    const last = finiteNumber(record.pageRange[1], "provenance.locator.pageRange[1]", first, 1_000_000, { integer: true })!;
    pageRange = [first, last];
  }
  return {
    paperId: locatorPaperId,
    sectionId: optionalString(record.sectionId, "provenance.locator.sectionId", 512),
    sectionTitle: optionalString(record.sectionTitle, "provenance.locator.sectionTitle", 1_000),
    page: finiteNumber(record.page, "provenance.locator.page", 1, 1_000_000, { optional: true, integer: true }),
    pageRange,
    paragraphId: optionalString(record.paragraphId, "provenance.locator.paragraphId", 512),
    figureId: optionalString(record.figureId, "provenance.locator.figureId", 512),
    figureLabel: optionalString(record.figureLabel, "provenance.locator.figureLabel", 500),
  };
}

function normalizeProvenance(value: unknown, paper: Paper): Provenance {
  const record = asRecord(value, "provenance", PROVENANCE_KEYS);
  if (
    typeof record.sourceType !== "string"
    || !PROVENANCE_SOURCE_TYPES.has(record.sourceType as Provenance["sourceType"])
  ) {
    validation("provenance.sourceType is invalid.");
  }
  if (
    typeof record.accessMethod !== "string"
    || !PROVENANCE_ACCESS_METHODS.has(record.accessMethod as Provenance["accessMethod"])
  ) {
    validation("provenance.accessMethod is invalid.");
  }
  return {
    id: requiredString(record.id, "provenance.id", 512),
    sourceType: record.sourceType as Provenance["sourceType"],
    sourceId: requiredString(record.sourceId, "provenance.sourceId", 1_024),
    sourceTitle: requiredString(record.sourceTitle, "provenance.sourceTitle", 2_000),
    sourceUrl: urlString(record.sourceUrl, "provenance.sourceUrl"),
    providerName: requiredString(record.providerName, "provenance.providerName", 300),
    retrievedAt: isoDateTime(record.retrievedAt, "provenance.retrievedAt"),
    accessMethod: record.accessMethod as Provenance["accessMethod"],
    locator: normalizeLocator(record.locator, paper.id),
    excerpt: optionalString(record.excerpt, "provenance.excerpt", 40_000),
    version: optionalString(record.version, "provenance.version", 500),
  };
}

function validateEnvelope(record: Record<string, unknown>): ValidatedEnvelope {
  return {
    clientOperationId: requiredString(record.clientOperationId, "clientOperationId", 200),
    expectedVersion: finiteNumber(record.expectedVersion, "expectedVersion", 0, Number.MAX_SAFE_INTEGER, { integer: true })!,
  };
}

function validateStageImport(value: unknown): ValidatedStageImport {
  const record = asRecord(value, "StageImportCommand", STAGE_COMMAND_KEYS);
  const envelope = validateEnvelope(record);
  if (
    typeof record.sourceKind !== "string"
    || !IMPORT_SOURCE_KINDS.has(record.sourceKind as ImportSourceKind)
  ) {
    validation("sourceKind is invalid.");
  }
  if (!USER_ASSERTABLE_IMPORT_SOURCE_KINDS.has(record.sourceKind as InboxEntry["sourceKind"])) {
    validation(SERVER_MANAGED_IMPORT_MESSAGE);
  }
  const paper = normalizePaper(record.paper);
  const provenance = normalizeProvenance(record.provenance, paper);
  if (
    provenance.sourceType === "uploaded-file"
    || SERVER_MANAGED_PROVENANCE_ACCESS_METHODS.has(provenance.accessMethod)
  ) {
    validation(SERVER_MANAGED_IMPORT_MESSAGE);
  }
  const snapshot = { paper, provenance };
  if (Buffer.byteLength(stableJson(snapshot), "utf8") > MAX_PROVIDER_SNAPSHOT_BYTES) {
    throw new HttpProblem(413, "payload_too_large", "The normalized provider snapshot is too large.");
  }
  return { ...envelope, sourceKind: record.sourceKind as InboxEntry["sourceKind"], snapshot };
}

function validateFileImport(value: unknown, routeInboxEntryId: string): ValidatedFileImport {
  const record = asRecord(value, "FileImportCommand", FILE_COMMAND_KEYS);
  const envelope = validateEnvelope(record);
  const inboxEntryId = requiredString(record.inboxEntryId, "inboxEntryId", 200);
  const projectId = requiredString(record.projectId, "projectId", 200);
  if (inboxEntryId !== routeInboxEntryId) {
    validation("The route inbox entry must match FileImportCommand.inboxEntryId.");
  }
  return { ...envelope, inboxEntryId, projectId };
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

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function requestHash(command: string, payload: unknown): string {
  return digest({ command, payload });
}

function failure(
  code: WorkspaceCommandFailure["code"],
  aggregateVersion: number,
  message: string,
): WorkspaceCommandFailure {
  return { ok: false, code, aggregateVersion, message };
}

function importSource(sourceKind: ImportSourceKind, provenance: Provenance): ImportSource {
  if (sourceKind === "zotero") return "ZOTERO";
  if (sourceKind === "upload") return "FILE_UPLOAD";
  if (sourceKind === "crawler") {
    return provenance.accessMethod === "mcp" || provenance.accessMethod === "webmcp"
      ? "WEB_MCP"
      : "CRAWLER";
  }
  if (sourceKind === "webmcp") return "WEB_MCP";
  if (sourceKind === "identifier") return "DOI_URL";
  return provenance.providerName.toLowerCase().includes("openalex") ? "OPENALEX" : "OTHER";
}

function paperSource(sourceKind: ImportSourceKind, provenance: Provenance): PaperSource {
  if (sourceKind === "zotero") return "ZOTERO";
  if (sourceKind === "upload") return "UPLOAD";
  if (sourceKind === "webmcp") return "WEB_MCP";
  if (
    sourceKind === "crawler"
    && (provenance.accessMethod === "mcp" || provenance.accessMethod === "webmcp")
  ) return "WEB_MCP";
  const provider = provenance.providerName.toLowerCase();
  if (provider.includes("openalex")) return "OPENALEX";
  if (provider.includes("semantic scholar")) return "SEMANTIC_SCHOLAR";
  if (provider.includes("crossref")) return "CROSSREF";
  if (provider.includes("pubmed")) return "PUBMED";
  if (provider.includes("arxiv")) return "ARXIV";
  if (sourceKind === "crawler") return "CRAWLER";
  return "OTHER";
}

function providerType(providerName: string, value: string): PaperIdentifierType {
  const provider = `${providerName} ${value}`.toLowerCase();
  if (provider.includes("openalex")) return "OPENALEX";
  if (provider.includes("semantic scholar") || provider.includes("semanticscholar")) return "SEMANTIC_SCHOLAR";
  if (/\bpmcid\b/.test(provider)) return "PMCID";
  if (/\bpmid\b/.test(provider) || provider.includes("pubmed")) return "PMID";
  if (provider.includes("arxiv")) return "ARXIV";
  return "OTHER";
}

function normalizeProviderIdentifier(type: PaperIdentifierType, value: string, providerName: string): string {
  let normalized = value.trim().toLowerCase();
  if (type === "OPENALEX") {
    normalized = normalized
      .replace(/^https?:\/\/openalex\.org\//, "")
      .replace(/^openalex:/, "");
  } else if (type === "SEMANTIC_SCHOLAR") {
    normalized = normalized.replace(/^semanticscholar:/, "").replace(/^semantic-scholar:/, "");
  } else if (type === "ARXIV") {
    normalized = normalizeArxiv(normalized);
  } else if (type === "OTHER") {
    const provider = providerName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    normalized = `${provider}:${normalized}`;
  }
  return normalized;
}

function identifierCandidates(
  sourceKind: ImportSourceKind,
  snapshot: StoredImportSnapshot,
): IdentifierCandidate[] {
  const source = paperSource(sourceKind, snapshot.provenance);
  const candidates: IdentifierCandidate[] = snapshot.paper.identifiers.map((identifier) => {
    if (identifier.scheme === "doi") {
      const value = normalizeDoi(identifier.value);
      return { type: "DOI", value, normalizedValue: value, source };
    }
    if (identifier.scheme === "arxiv") {
      const value = normalizeArxiv(identifier.value);
      return { type: "ARXIV", value, normalizedValue: value, source };
    }
    if (identifier.scheme === "isbn") {
      const value = normalizeIsbn(identifier.value);
      return { type: "ISBN", value, normalizedValue: value, source };
    }
    const type = providerType(snapshot.provenance.providerName, identifier.value);
    const normalizedValue = normalizeProviderIdentifier(
      type,
      identifier.value,
      snapshot.provenance.providerName,
    );
    return { type, value: type === "OTHER" ? normalizedValue : normalizedValue, normalizedValue, source };
  });
  const providerIdentifierType = providerType(
    snapshot.provenance.providerName,
    snapshot.provenance.sourceId,
  );
  const providerValue = normalizeProviderIdentifier(
    providerIdentifierType,
    snapshot.provenance.sourceId,
    snapshot.provenance.providerName,
  );
  candidates.push({
    type: providerIdentifierType,
    value: providerValue,
    normalizedValue: providerValue,
    source,
  });
  if (snapshot.paper.sourceUrl) {
    candidates.push({
      type: "URL",
      value: snapshot.paper.sourceUrl,
      normalizedValue: snapshot.paper.sourceUrl.toLowerCase(),
      source,
    });
  }
  return candidates.filter((candidate, index, all) =>
    all.findIndex((entry) =>
      entry.type === candidate.type && entry.normalizedValue === candidate.normalizedValue,
    ) === index,
  );
}

function dedupeCandidate(candidates: IdentifierCandidate[]): IdentifierCandidate {
  return candidates.find((candidate) => candidate.type === "DOI")
    ?? candidates.find((candidate) => candidate.type !== "URL")
    ?? candidates[0];
}

function inboxInclude() {
  return {
    provenanceRecords: {
      select: {
        kind: true,
        paperId: true,
        documentId: true,
        paper: {
          select: {
            id: true,
            title: true,
            publicationYear: true,
            venueName: true,
            workType: true,
            authors: { select: { position: true, displayName: true } },
            identifiers: { select: { type: true, value: true } },
          },
        },
      },
    },
  } as const;
}

function replayedResult<T>(response: unknown, aggregateVersion: number): WorkspaceCommandResult<T> | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const candidate = response as { ok?: unknown; data?: T };
  if (candidate.ok !== true || candidate.data === undefined) return null;
  return {
    ok: true,
    outcome: "replayed",
    aggregateVersion,
    data: candidate.data,
  };
}

async function saveCompletedReceipt(
  transaction: Prisma.TransactionClient,
  input: {
    organizationId: string;
    userId: string;
    operationId: string;
    command: string;
    hash: string;
    response: WorkspaceCommandResult<unknown>;
  },
): Promise<void> {
  await transaction.idempotencyRecord.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.userId,
      key: input.operationId,
      command: input.command,
      requestHash: input.hash,
      response: input.response as unknown as Prisma.InputJsonValue,
      status: "COMPLETED",
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    },
  });
}

function retryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034");
}

async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!retryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) {
        if (retryableTransactionError(error)) {
          throw new HttpProblem(
            409,
            "concurrent_import_conflict",
            "Another import resolved the same scholarly identifier. Refresh and retry.",
          );
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 8));
    }
  }
  throw new HttpProblem(409, "concurrent_import_conflict", "Import could not be resolved safely.");
}

export function applyIdempotencyHeader(request: Request, body: unknown): unknown {
  const headerOperationId = request.headers.get("idempotency-key")?.trim();
  if (!headerOperationId) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    validation("An import command object is required.");
  }
  const record = body as Record<string, unknown>;
  if (
    record.clientOperationId !== undefined
    && record.clientOperationId !== headerOperationId
  ) {
    throw new HttpProblem(
      400,
      "idempotency_mismatch",
      "Idempotency-Key must match clientOperationId.",
    );
  }
  return { ...record, clientOperationId: headerOperationId };
}

const USER_STAGE_AUTHORITY: StageImportAuthority = {
  command: "stageImport",
  provenanceKind: "DISCOVERY",
  auditAppliedAction: "import.staged",
  auditNoopAction: "import.stage.noop",
};

const WEB_MCP_STAGE_AUTHORITY: StageImportAuthority = {
  command: "stageWebMcpProposal",
  provenanceKind: "WEB_MCP",
  auditAppliedAction: "webmcp.proposal.staged",
  auditNoopAction: "webmcp.proposal.noop",
};

function validateServerManagedWebMcpStage(
  value: ServerManagedWebMcpStageCommand,
): ValidatedStageImport {
  const envelope = validateEnvelope(value as unknown as Record<string, unknown>);
  const snapshot = storedImportSnapshot(value.snapshot);
  if (
    !snapshot
    || !isServerManagedWebMcpSnapshot(value.snapshot)
    || snapshot.provenance.sourceType !== "web-source"
    || snapshot.provenance.accessMethod !== "webmcp"
    || snapshot.provenance.providerName !== WEB_MCP_PROVIDER_NAME
    || !snapshot.provenance.sourceUrl
    || snapshot.provenance.sourceId !== snapshot.provenance.sourceUrl
    || snapshot.paper.sourceUrl !== snapshot.provenance.sourceUrl
    || snapshot.paper.isDemoRecord !== false
    || snapshot.paper.access?.hasFullText !== false
  ) {
    validation("The WebMCP proposal does not satisfy the server-managed metadata boundary.");
  }
  if (Buffer.byteLength(stableJson(snapshot), "utf8") > MAX_PROVIDER_SNAPSHOT_BYTES) {
    throw new HttpProblem(413, "payload_too_large", "The normalized provider snapshot is too large.");
  }
  return { ...envelope, sourceKind: "webmcp", snapshot };
}

async function stageValidatedWorkspaceImport(
  user: ImportSessionUser,
  workspaceId: string,
  command: ValidatedStageImport,
  authority: StageImportAuthority,
): Promise<WorkspaceCommandResult<StageImportResult>> {
  const commandPayload = authority.command === "stageWebMcpProposal"
    ? {
        sourceKind: command.sourceKind,
        paper: command.snapshot.paper,
        provenance: {
          ...command.snapshot.provenance,
          // The server observes this time separately on every HTTP retry. It
          // is stored on first application but is not part of client intent.
          retrievedAt: undefined,
        },
      }
    : { sourceKind: command.sourceKind, ...command.snapshot };
  const hash = requestHash(authority.command, commandPayload);
  const intentDigest = digest(commandPayload);
  const source = importSource(command.sourceKind, command.snapshot.provenance);
  const candidates = identifierCandidates(command.sourceKind, command.snapshot);
  const primaryCandidate = dedupeCandidate(candidates);
  const webMcpSourceIdentity = authority.command === "stageWebMcpProposal"
    ? `webmcp:url:${digest(command.snapshot.provenance.sourceId)}`
    : null;
  const sourceKey = webMcpSourceIdentity ?? `${command.snapshot.provenance.providerName.trim().toLowerCase()}:${primaryCandidate.type}:${normalizeProviderIdentifier(
    primaryCandidate.type,
    command.snapshot.provenance.sourceId,
    command.snapshot.provenance.providerName,
  )}`;
  const dedupeKey = webMcpSourceIdentity ?? `${primaryCandidate.type}:${primaryCandidate.normalizedValue}`;
  const snapshotDigest = authority.command === "stageWebMcpProposal"
    ? webMcpSnapshotDigest(command.snapshot as ServerManagedWebMcpSnapshot)
    : digest(command.snapshot);

  return withTransactionRetry(() => prisma.$transaction(async (transaction) => {
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, user.id);
    const membership = await transaction.member.findUnique({
      where: {
        organizationId_userId: { organizationId: workspaceId, userId: user.id },
      },
      include: { organization: true },
    });
    if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    requireWorkspaceMutationRole(membership.role);

    const prior = await transaction.idempotencyRecord.findUnique({
      where: { organizationId_key: { organizationId: workspaceId, key: command.clientOperationId } },
    });
    if (prior) {
      if (
        prior.actorUserId !== user.id
        || prior.command !== authority.command
        || prior.requestHash !== hash
      ) {
        return failure(
          "idempotency_conflict",
          membership.organization.revision,
          "clientOperationId was already used for a different command.",
        );
      }
      return replayedResult<StageImportResult>(prior.response, membership.organization.revision)
        ?? failure(
          "version_conflict",
          membership.organization.revision,
          "The prior command is still being resolved. Refresh before retrying.",
        );
    }

    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const existing = await transaction.inboxEntry.findFirst({
      where: {
        organizationId: workspaceId,
        source,
        OR: [{ sourceKey }, { dedupeKey }],
      },
      include: inboxInclude(),
    });
    if (existing) {
      const visibleExisting = await transaction.inboxEntry.findFirst({
        where: {
          id: existing.id,
          ...inboxEntryVisibleTo(user.id, workspaceId),
        },
        include: inboxInclude(),
      });
      if (!visibleExisting) {
        return failure("not_found", membership.organization.revision, HIDDEN_IMPORT_TARGET_MESSAGE);
      }
      if (authority.command === "stageWebMcpProposal") {
        const existingSnapshot = storedImportSnapshot(visibleExisting.payload);
        const existingIntentDigest = existingSnapshot
          ? digest({
              sourceKind: "webmcp",
              paper: existingSnapshot.paper,
              provenance: {
                ...existingSnapshot.provenance,
                retrievedAt: undefined,
              },
            })
          : null;
        if (existingIntentDigest !== intentDigest) {
          return failure(
            "duplicate",
            membership.organization.revision,
            "This WebMCP source already has a different staged proposal that requires review.",
          );
        }
      }
      const dto = paperInboxEntryDto(visibleExisting);
      if (!dto) throw new HttpProblem(500, "invalid_import_snapshot", "Stored import snapshot is invalid.");
      const result: WorkspaceCommandResult<StageImportResult> = {
        ok: true,
        outcome: "noop",
        aggregateVersion: membership.organization.revision,
        data: { inboxEntry: dto, duplicatePaperId: dto.duplicateOfPaperId },
      };
      await saveCompletedReceipt(transaction, {
        organizationId: workspaceId,
        userId: user.id,
        operationId: command.clientOperationId,
        command: authority.command,
        hash,
        response: result,
      });
      const retainedPrincipal = authority.command === "stageWebMcpProposal"
        ? await resolveLiveRetainedAuditPrincipal(transaction, workspaceId, user.id)
        : null;
      await transaction.auditEvent.create({
        data: {
          organizationId: workspaceId,
          actorUserId: user.id,
          ...(retainedPrincipal ? { actorPrincipalId: retainedPrincipal.id } : {}),
          action: authority.auditNoopAction,
          entityType: "inbox-entry",
          entityId: visibleExisting.id,
          requestId: command.clientOperationId,
          metadata: { source, snapshotDigest },
        },
      });
      return result;
    }

    const identifierMatches = await transaction.paperIdentifier.findMany({
      where: {
        OR: candidates.map((candidate) => ({
          type: candidate.type,
          normalizedValue: candidate.normalizedValue,
        })),
      },
      select: { paperId: true, type: true, normalizedValue: true },
    });
    const rankedMatch = candidates
      .map((candidate) => identifierMatches.find((identifier) =>
        identifier.type === candidate.type
        && identifier.normalizedValue === candidate.normalizedValue,
      ))
      .find(Boolean);
    let duplicatePaperId = rankedMatch?.paperId;
    const anyDuplicateWorkspacePaper = duplicatePaperId
      ? await transaction.workspacePaper.findUnique({
          where: {
            organizationId_paperId: { organizationId: workspaceId, paperId: duplicatePaperId },
          },
          select: { id: true },
        })
      : null;
    const duplicateWorkspacePaper = anyDuplicateWorkspacePaper
      ? await transaction.workspacePaper.findFirst({
          where: {
            id: anyDuplicateWorkspacePaper.id,
            ...workspacePaperVisibleTo(user.id, workspaceId),
          },
          select: { id: true },
        })
      : null;
    if (anyDuplicateWorkspacePaper && !duplicateWorkspacePaper) {
      return failure("not_found", membership.organization.revision, HIDDEN_IMPORT_TARGET_MESSAGE);
    }
    if (duplicatePaperId && !anyDuplicateWorkspacePaper) {
      const globalCandidate = await transaction.paper.findUnique({
        where: { id: duplicatePaperId },
        select: { primarySource: true },
      });
      if (
        !globalCandidate?.primarySource
        || !PUBLIC_CANONICAL_METADATA_SOURCES.has(globalCandidate.primarySource)
      ) {
        // A guessed global identifier must not reveal metadata canonized by a
        // different tenant's upload/manual/WebMCP activity. The identifier
        // collision remains for a later privileged reconciliation workflow.
        duplicatePaperId = undefined;
      }
    }

    const bumped = await transaction.organization.updateMany({
      where: { id: workspaceId, revision: command.expectedVersion },
      data: { revision: { increment: 1 } },
    });
    if (bumped.count !== 1) {
      const current = await transaction.organization.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { revision: true },
      });
      return failure(
        "version_conflict",
        current.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const retainedPrincipal = authority.command === "stageWebMcpProposal"
      ? await resolveLiveRetainedAuditPrincipal(transaction, workspaceId, user.id)
      : null;

    const entry = await transaction.inboxEntry.create({
      data: {
        organizationId: workspaceId,
        workspacePaperId: duplicateWorkspacePaper?.id,
        source,
        sourceKey,
        dedupeKey,
        status: duplicatePaperId ? "DUPLICATE" : "PENDING",
        proposedTitle: command.snapshot.paper.title,
        proposedYear: command.snapshot.paper.year || null,
        sourceUri: command.snapshot.provenance.sourceUrl ?? command.snapshot.paper.sourceUrl,
        payload: command.snapshot as unknown as Prisma.InputJsonValue,
        createdById: user.id,
        ...(retainedPrincipal ? { createdByPrincipalId: retainedPrincipal.id } : {}),
      },
    });
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: authority.provenanceKind as ProvenanceKind,
        paperId: duplicatePaperId,
        workspacePaperId: duplicateWorkspacePaper?.id,
        inboxEntryId: entry.id,
        actorUserId: user.id,
        ...(retainedPrincipal ? { actorPrincipalId: retainedPrincipal.id } : {}),
        sourceProvider: command.snapshot.provenance.providerName,
        sourceRecordId: command.snapshot.provenance.sourceId,
        sourceUri: command.snapshot.provenance.sourceUrl,
        retrievedAt: new Date(command.snapshot.provenance.retrievedAt),
        payloadDigest: snapshotDigest,
        payload: command.snapshot as unknown as Prisma.InputJsonValue,
      },
    });
    const hydrated = await transaction.inboxEntry.findFirstOrThrow({
      where: { id: entry.id, organizationId: workspaceId },
      include: inboxInclude(),
    });
    const dto = paperInboxEntryDto(hydrated);
    if (!dto) throw new HttpProblem(500, "invalid_import_snapshot", "Stored import snapshot is invalid.");
    const result: WorkspaceCommandResult<StageImportResult> = {
      ok: true,
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      data: { inboxEntry: dto, duplicatePaperId },
    };
    await saveCompletedReceipt(transaction, {
      organizationId: workspaceId,
      userId: user.id,
      operationId: command.clientOperationId,
      command: authority.command,
      hash,
      response: result,
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        ...(retainedPrincipal ? { actorPrincipalId: retainedPrincipal.id } : {}),
        action: authority.auditAppliedAction,
        entityType: "inbox-entry",
        entityId: entry.id,
        requestId: command.clientOperationId,
        metadata: {
          source,
          snapshotDigest,
          possibleDuplicate: Boolean(duplicatePaperId),
        },
      },
    });
    return result;
  }, { isolationLevel: "Serializable" }));
}

export async function stageWorkspaceImport(
  user: ImportSessionUser,
  workspaceId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<StageImportResult>> {
  return stageValidatedWorkspaceImport(
    user,
    workspaceId,
    validateStageImport(rawCommand),
    USER_STAGE_AUTHORITY,
  );
}

/**
 * Server-only WebMCP metadata admission. Callers cannot select a source,
 * provenance kind, audit action, or custody method through this boundary.
 */
export async function stageServerManagedWebMcpProposal(
  user: ImportSessionUser,
  workspaceId: string,
  command: ServerManagedWebMcpStageCommand,
): Promise<WorkspaceCommandResult<StageImportResult>> {
  return stageValidatedWorkspaceImport(
    user,
    workspaceId,
    validateServerManagedWebMcpStage(command),
    WEB_MCP_STAGE_AUTHORITY,
  );
}

export async function fileWorkspaceImport(
  user: ImportSessionUser,
  workspaceId: string,
  routeInboxEntryId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<FileImportResult>> {
  const command = validateFileImport(rawCommand, routeInboxEntryId);
  const hash = requestHash("fileImport", {
    inboxEntryId: command.inboxEntryId,
    projectId: command.projectId,
  });

  return withTransactionRetry(() => prisma.$transaction(async (transaction) => {
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, user.id);
    const membership = await transaction.member.findUnique({
      where: {
        organizationId_userId: { organizationId: workspaceId, userId: user.id },
      },
      include: { organization: true },
    });
    if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    requireWorkspaceMutationRole(membership.role);

    const prior = await transaction.idempotencyRecord.findUnique({
      where: { organizationId_key: { organizationId: workspaceId, key: command.clientOperationId } },
    });
    if (prior) {
      if (prior.actorUserId !== user.id || prior.command !== "fileImport" || prior.requestHash !== hash) {
        return failure(
          "idempotency_conflict",
          membership.organization.revision,
          "clientOperationId was already used for a different command.",
        );
      }
      return replayedResult<FileImportResult>(prior.response, membership.organization.revision)
        ?? failure(
          "version_conflict",
          membership.organization.revision,
          "The prior command is still being resolved. Refresh before retrying.",
        );
    }

    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const entry = await transaction.inboxEntry.findFirst({
      where: {
        id: command.inboxEntryId,
        ...inboxEntryVisibleTo(user.id, workspaceId),
      },
      include: inboxInclude(),
    });
    const project = await transaction.project.findFirst({
      where: {
        id: command.projectId,
        organizationId: workspaceId,
        ...projectVisibleTo(user.id),
      },
      include: {
        papers: {
          where: {
            organizationId: workspaceId,
            workspacePaper: { organizationId: workspaceId },
          },
          include: { workspacePaper: { select: { paperId: true } } },
        },
        evidenceNotes: {
          where: { organizationId: workspaceId },
          select: { id: true, supersedesId: true },
        },
        evidenceMemberships: {
          where: { organizationId: workspaceId },
          select: {
            evidenceNoteId: true,
            evidenceNote: { select: { id: true, supersedesId: true } },
          },
        },
        collections: { where: { organizationId: workspaceId }, select: { id: true } },
      },
    });
    if (!entry) {
      return failure("not_found", membership.organization.revision, "Inbox entry was not found.");
    }
    if (!project) {
      return failure("not_found", membership.organization.revision, "Destination project was not found.");
    }

    if (
      entry.source === "FILE_UPLOAD"
      || entry.documentId !== null
      || entry.provenanceRecords.some((record) => record.documentId !== null)
    ) {
      return failure("validation", membership.organization.revision, NON_FILEABLE_IMPORT_MESSAGE);
    }

    if (entry.status === "IMPORTED" && entry.workspacePaperId) {
      const existingMembership = await transaction.projectPaper.findFirst({
        where: {
          organizationId: workspaceId,
          projectId: project.id,
          workspacePaperId: entry.workspacePaperId,
        },
      });
      if (existingMembership) {
        const workspacePaper = await transaction.workspacePaper.findFirstOrThrow({
          where: { id: entry.workspacePaperId, organizationId: workspaceId },
          include: { paper: { include: { authors: true, identifiers: true } } },
        });
        const dto = paperInboxEntryDto(entry);
        if (!dto) throw new HttpProblem(500, "invalid_import_snapshot", "Stored import snapshot is invalid.");
        const result: WorkspaceCommandResult<FileImportResult> = {
          ok: true,
          outcome: "noop",
          aggregateVersion: membership.organization.revision,
          data: {
            inboxEntry: dto,
            paper: paperDto(workspacePaper.paper),
            project: projectDto(project),
            usedExistingPaper: true,
          },
        };
        await saveCompletedReceipt(transaction, {
          organizationId: workspaceId,
          userId: user.id,
          operationId: command.clientOperationId,
          command: "fileImport",
          hash,
          response: result,
        });
        await transaction.auditEvent.create({
          data: {
            organizationId: workspaceId,
            actorUserId: user.id,
            action: "import.file.noop",
            entityType: "inbox-entry",
            entityId: entry.id,
            requestId: command.clientOperationId,
            metadata: { projectId: project.id, workspacePaperId: workspacePaper.id },
          },
        });
        return result;
      }
    }

    if (!FILEABLE_INBOX_STATUSES.has(entry.status)) {
      return failure("validation", membership.organization.revision, NON_FILEABLE_IMPORT_MESSAGE);
    }

    const snapshot = storedImportSnapshot(entry.payload);
    if (!snapshot) throw new HttpProblem(500, "invalid_import_snapshot", "Stored import snapshot is invalid.");

    const sourceKind = paperInboxEntryDto(entry)?.sourceKind;
    if (!sourceKind) throw new HttpProblem(500, "invalid_import_snapshot", "Stored import snapshot is invalid.");
    if (sourceKind === "webmcp") {
      return failure(
        "validation",
        membership.organization.revision,
        WEB_MCP_REVIEW_REQUIRED_MESSAGE,
      );
    }
    const candidates = identifierCandidates(sourceKind, snapshot);
    const matchingIdentifiers = await transaction.paperIdentifier.findMany({
      where: {
        OR: candidates.map((candidate) => ({
          type: candidate.type,
          normalizedValue: candidate.normalizedValue,
        })),
      },
      select: { paperId: true },
    });
    const discoveryPaperId = entry.provenanceRecords.find(
      (record) => (record.kind === "DISCOVERY" || record.kind === "WEB_MCP") && record.paperId,
    )?.paperId;
    const canonicalPaperIds = new Set([
      ...matchingIdentifiers.map((identifier) => identifier.paperId),
      ...(discoveryPaperId ? [discoveryPaperId] : []),
    ]);
    if (canonicalPaperIds.size > 1) {
      return failure(
        "duplicate",
        membership.organization.revision,
        "The provider identifiers resolve to more than one canonical paper and require review.",
      );
    }
    const canonicalPaperId = canonicalPaperIds.values().next().value as string | undefined;
    const existingCanonicalPaper = canonicalPaperId
      ? await transaction.paper.findUnique({
          where: { id: canonicalPaperId },
          include: { authors: true, identifiers: true },
        })
      : null;
    const priorWorkspacePaper = canonicalPaperId
      ? await transaction.workspacePaper.findUnique({
          where: {
            organizationId_paperId: { organizationId: workspaceId, paperId: canonicalPaperId },
          },
          select: { id: true },
        })
      : null;
    if (priorWorkspacePaper) {
      const visiblePriorWorkspacePaper = await transaction.workspacePaper.findFirst({
        where: {
          id: priorWorkspacePaper.id,
          ...workspacePaperVisibleTo(user.id, workspaceId),
        },
        select: { id: true },
      });
      if (!visiblePriorWorkspacePaper) {
        return failure("not_found", membership.organization.revision, HIDDEN_IMPORT_TARGET_MESSAGE);
      }
    }

    const bumped = await transaction.organization.updateMany({
      where: { id: workspaceId, revision: command.expectedVersion },
      data: { revision: { increment: 1 } },
    });
    if (bumped.count !== 1) {
      const current = await transaction.organization.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { revision: true },
      });
      return failure(
        "version_conflict",
        current.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const canonicalPaper = existingCanonicalPaper ?? await transaction.paper.create({
      data: {
        title: snapshot.paper.title,
        abstractText: snapshot.paper.abstract || null,
        publicationYear: snapshot.paper.year || null,
        workType: snapshot.paper.type,
        venueName: snapshot.paper.venue || null,
        citationCount: snapshot.paper.citationCount,
        isRetracted: snapshot.paper.isRetracted ?? false,
        primarySource: paperSource(sourceKind, snapshot.provenance),
        metadata: snapshot as unknown as Prisma.InputJsonValue,
        identifiers: {
          create: candidates.map((candidate) => ({
            type: candidate.type,
            value: candidate.value,
            normalizedValue: candidate.normalizedValue,
            source: candidate.source,
          })),
        },
        authors: {
          create: snapshot.paper.authors.map((displayName, position) => ({
            position,
            displayName,
          })),
        },
      },
      include: { authors: true, identifiers: true },
    });
    if (existingCanonicalPaper) {
      const existingKeys = new Set(existingCanonicalPaper.identifiers.map(
        (identifier) => `${identifier.type}:${identifier.normalizedValue}`,
      ));
      const missing = candidates.filter(
        (candidate) => !existingKeys.has(`${candidate.type}:${candidate.normalizedValue}`),
      );
      if (missing.length > 0) {
        await transaction.paperIdentifier.createMany({
          data: missing.map((candidate) => ({
            paperId: canonicalPaper.id,
            type: candidate.type,
            value: candidate.value,
            normalizedValue: candidate.normalizedValue,
            source: candidate.source,
          })),
        });
      }
    }

    const workspacePaper = await transaction.workspacePaper.upsert({
      where: {
        organizationId_paperId: { organizationId: workspaceId, paperId: canonicalPaper.id },
      },
      update: { status: "SAVED" },
      create: {
        organizationId: workspaceId,
        paperId: canonicalPaper.id,
        status: "SAVED",
        addedById: user.id,
      },
    });
    await transaction.projectPaper.upsert({
      where: {
        organizationId: workspaceId,
        projectId_workspacePaperId: {
          projectId: project.id,
          workspacePaperId: workspacePaper.id,
        },
      },
      update: {},
      create: {
        organizationId: workspaceId,
        projectId: project.id,
        workspacePaperId: workspacePaper.id,
        addedById: user.id,
      },
    });
    const updatedEntry = await transaction.inboxEntry.update({
      where: { id: entry.id, organizationId: workspaceId },
      data: {
        projectId: project.id,
        workspacePaperId: workspacePaper.id,
        status: "IMPORTED",
        resolvedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
    });
    const snapshotDigest = digest(snapshot);
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "IMPORT",
        paperId: canonicalPaper.id,
        workspacePaperId: workspacePaper.id,
        inboxEntryId: entry.id,
        actorUserId: user.id,
        sourceProvider: snapshot.provenance.providerName,
        sourceRecordId: snapshot.provenance.sourceId,
        sourceUri: snapshot.provenance.sourceUrl,
        retrievedAt: new Date(snapshot.provenance.retrievedAt),
        payloadDigest: snapshotDigest,
        payload: {
          projectId: project.id,
          sourceSnapshotDigest: snapshotDigest,
        },
      },
    });

    // Prisma's local PGlite server exposes one physical connection. Keep
    // transaction reads sequential so local development and CI do not overlap
    // queries on that connection.
    const hydratedEntry = await transaction.inboxEntry.findFirstOrThrow({
      where: { id: updatedEntry.id, organizationId: workspaceId },
      include: inboxInclude(),
    });
    const hydratedPaper = await transaction.paper.findUniqueOrThrow({
      where: { id: canonicalPaper.id },
      include: { authors: true, identifiers: true },
    });
    const hydratedProject = await transaction.project.findFirstOrThrow({
      where: {
        id: project.id,
        organizationId: workspaceId,
        ...projectVisibleTo(user.id),
      },
      include: {
        papers: {
          where: {
            organizationId: workspaceId,
            workspacePaper: { organizationId: workspaceId },
          },
          include: { workspacePaper: { select: { paperId: true } } },
        },
        evidenceNotes: {
          where: { organizationId: workspaceId },
          select: { id: true, supersedesId: true },
        },
        evidenceMemberships: {
          where: { organizationId: workspaceId },
          select: {
            evidenceNoteId: true,
            evidenceNote: { select: { id: true, supersedesId: true } },
          },
        },
        collections: { where: { organizationId: workspaceId }, select: { id: true } },
      },
    });
    const entryDto = paperInboxEntryDto(hydratedEntry);
    if (!entryDto) throw new HttpProblem(500, "invalid_import_snapshot", "Stored import snapshot is invalid.");
    const result: WorkspaceCommandResult<FileImportResult> = {
      ok: true,
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      data: {
        inboxEntry: entryDto,
        paper: paperDto(hydratedPaper),
        project: projectDto(hydratedProject),
        usedExistingPaper: Boolean(existingCanonicalPaper || priorWorkspacePaper),
      },
    };
    await saveCompletedReceipt(transaction, {
      organizationId: workspaceId,
      userId: user.id,
      operationId: command.clientOperationId,
      command: "fileImport",
      hash,
      response: result,
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        action: "import.filed",
        entityType: "inbox-entry",
        entityId: entry.id,
        requestId: command.clientOperationId,
        metadata: {
          projectId: project.id,
          paperId: canonicalPaper.id,
          workspacePaperId: workspacePaper.id,
          usedExistingPaper: Boolean(existingCanonicalPaper || priorWorkspacePaper),
          snapshotDigest,
        },
      },
    });
    return result;
  }, { isolationLevel: "Serializable" }));
}

export type { InboxEntryForDto };
