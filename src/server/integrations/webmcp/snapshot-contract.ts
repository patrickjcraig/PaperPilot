import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Paper, PaperIdentifier, Provenance } from "@/lib/types";

/**
 * Historical rows predate an explicit field. Their exact `{ paper,
 * provenance }` envelope is permanently interpreted as snapshot schema v1.
 * New rows must always carry the explicit current version.
 */
export const WEB_MCP_SNAPSHOT_SCHEMA_VERSION = 2 as const;

/** The NUL terminator prevents the JSON payload from extending the domain. */
export const WEB_MCP_SNAPSHOT_V2_DIGEST_DOMAIN =
  "paperpilot:webmcp:staging-snapshot:v2\0";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TITLE_LENGTH = 2_000;
const MAX_AUTHOR_LENGTH = 300;
const MAX_AUTHORS = 200;
const MAX_VENUE_LENGTH = 1_000;
const MAX_ABSTRACT_LENGTH = 40_000;
const MAX_IDENTIFIERS = 32;
const MAX_IDENTIFIER_VALUE_LENGTH = 1_024;
const MAX_LICENSE_LENGTH = 500;
const MAX_VERSION_LENGTH = 200;
const MAX_RETAINED_URL_BYTES = 2_048;
const MAX_RETAINED_ORIGIN_BYTES = 255;
const RETAINED_WEB_MCP_PROVIDER_NAME_V1 = "PaperPilot WebMCP";

const SNAPSHOT_V1_KEYS = new Set(["paper", "provenance"]);
const SNAPSHOT_V2_KEYS = new Set(["schemaVersion", "paper", "provenance"]);
const PAPER_KEYS = new Set([
  "id", "title", "shortTitle", "authors", "year", "venue", "type",
  "abstract", "abstractSnippet", "whyRead", "relevanceScore", "relevanceTags",
  "evidenceStrength", "readingStatus", "readingProgress", "estimatedMinutes",
  "identifiers", "sourceUrl", "access", "isDemoRecord",
]);
const ACCESS_REQUIRED_KEYS = new Set([
  "isOpenAccess", "hasFullText", "landingPageUrl",
]);
const ACCESS_OPTIONAL_KEYS = new Set(["pdfUrl", "license", "version"]);
const PROVENANCE_REQUIRED_KEYS = new Set([
  "id", "sourceType", "sourceId", "sourceTitle", "sourceUrl", "providerName",
  "retrievedAt", "accessMethod",
]);
const PROVENANCE_OPTIONAL_KEYS = new Set(["excerpt", "version"]);
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
const PUBLIC_DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BLOCKED_DNS_SUFFIXES = [
  ".arpa",
  ".corp",
  ".example",
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localdomain",
  ".localhost",
  ".onion",
  ".test",
] as const;
const ENCODED_CONTROL_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const ENCODED_PATH_SEPARATOR_PATTERN = /%(?:2f|5c)/i;
const ENCODED_DOT_PATTERN = /%2e/i;
const SECRET_QUERY_KEY_PATTERN =
  /token|secret|signature|credential|authorization|password|session|api[_-]?key/i;

/** The exact unversioned wire shape emitted before explicit versioning. */
export interface HistoricalServerManagedWebMcpSnapshotV1 {
  paper: Paper;
  provenance: Provenance;
}

/** The current retained staging envelope. */
export interface ServerManagedWebMcpSnapshotV2 {
  schemaVersion: typeof WEB_MCP_SNAPSHOT_SCHEMA_VERSION;
  paper: Paper;
  provenance: Provenance;
}

export type ServerManagedWebMcpSnapshot =
  | HistoricalServerManagedWebMcpSnapshotV1
  | ServerManagedWebMcpSnapshotV2;

export type DecodedServerManagedWebMcpSnapshot =
  | {
      schemaVersion: 1;
      snapshot: HistoricalServerManagedWebMcpSnapshotV1;
    }
  | {
      schemaVersion: typeof WEB_MCP_SNAPSHOT_SCHEMA_VERSION;
      snapshot: ServerManagedWebMcpSnapshotV2;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value);
  const allowed = new Set([...required, ...optional]);
  return keys.every((key) => allowed.has(key) && value[key] !== undefined)
    && [...required].every((key) => keys.includes(key));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Locale-independent lexicographic order over Unicode code points. JavaScript
 * relational string comparison is UTF-16-code-unit based, so it cannot supply
 * this ordering for supplementary-plane characters.
 */
export function compareUnicodeCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex);
    const rightPoint = right.codePointAt(rightIndex);
    if (leftPoint === undefined || rightPoint === undefined) break;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0;
  return leftIndex === left.length ? -1 : 1;
}

/**
 * Canonical JSON used by every retained WebMCP snapshot digest. Undefined
 * object members are omitted to preserve the historical v1 encoding; strict
 * decoders reject them before a snapshot can reach this function.
 */
export function canonicalWebMcpSnapshotJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) =>
      entry === undefined ? "null" : canonicalWebMcpSnapshotJson(entry)
    ).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalWebMcpSnapshotJson(entry)}`
      )
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("WebMCP canonical JSON supports JSON values only.");
  }
  return encoded;
}

function requiredCanonicalText(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && value === value.trim();
}

function optionalCanonicalText(
  value: unknown,
  maximumLength: number,
): value is string {
  return requiredCanonicalText(value, maximumLength);
}

function isCanonicalIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Frozen URL rules for retained v1/v2 snapshots; do not call a live parser. */
function isRetainedPublicUrl(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_RETAINED_URL_BYTES
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
    || ENCODED_CONTROL_PATTERN.test(value)
    || ENCODED_PATH_SEPARATOR_PATTERN.test(value)
    || ENCODED_DOT_PATTERN.test(value)
  ) return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || Boolean(parsed.username || parsed.password || parsed.hash)
    || hostname === "localhost"
    || hostname.endsWith(".")
    || isIP(hostname) !== 0
    || !PUBLIC_DNS_NAME_PATTERN.test(hostname)
    || BLOCKED_DNS_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    )
    || Buffer.byteLength(parsed.origin, "utf8") > MAX_RETAINED_ORIGIN_BYTES
    || [...parsed.searchParams.keys()].some((key) =>
      SECRET_QUERY_KEY_PATTERN.test(key)
    )
  ) return false;
  parsed.hostname = hostname;
  return parsed.href === value;
}

function isNormalizedIdentifier(value: unknown): value is PaperIdentifier {
  if (!isRecord(value) || !hasExactKeys(value, IDENTIFIER_KEYS)) return false;
  const scheme = value.scheme;
  const identifier = value.value;
  if (
    typeof scheme !== "string"
    || !IDENTIFIER_SCHEMES.has(scheme as PaperIdentifier["scheme"])
    || !requiredCanonicalText(identifier, MAX_IDENTIFIER_VALUE_LENGTH)
  ) return false;

  switch (scheme as PaperIdentifier["scheme"]) {
    case "doi":
      return identifier === identifier.toLowerCase()
        && /^10\.\d{4,9}\/\S+$/.test(identifier);
    case "arxiv":
      return identifier === identifier.toLowerCase()
        && (
          /^\d{4}\.\d{4,5}(?:v\d+)?$/.test(identifier)
          || /^[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?$/.test(identifier)
        );
    case "isbn":
      return identifier === identifier.toUpperCase()
        && /^(?:\d{9}[\dX]|\d{13})$/.test(identifier);
    case "provider":
      return true;
  }
}

function hasNormalizedIdentifiers(value: unknown): value is PaperIdentifier[] {
  if (!Array.isArray(value) || value.length > MAX_IDENTIFIERS) return false;
  if (value.some((identifier) => !isNormalizedIdentifier(identifier))) return false;
  const identities = value.map(
    (identifier) => `${identifier.scheme}\0${identifier.value.toLowerCase()}`,
  );
  return new Set(identities).size === identities.length;
}

function codePointPrefix(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

/**
 * Frozen body decoder for the snapshot shape originally emitted as v1. V2
 * intentionally reuses this body and changes only its explicit envelope and
 * digest domain. A future body change must add a new decoder, not edit this
 * interpretation of retained rows.
 */
function hasRetainedV1SnapshotBody(value: Record<string, unknown>): boolean {
  if (!isRecord(value.paper) || !isRecord(value.provenance)) return false;
  const paper = value.paper;
  const provenance = value.provenance;
  if (!isRecord(paper.access)) return false;
  const access = paper.access;
  if (
    !hasExactKeys(paper, PAPER_KEYS)
    || !hasExactKeys(access, ACCESS_REQUIRED_KEYS, ACCESS_OPTIONAL_KEYS)
    || !hasExactKeys(
      provenance,
      PROVENANCE_REQUIRED_KEYS,
      PROVENANCE_OPTIONAL_KEYS,
    )
    || !requiredCanonicalText(paper.title, MAX_TITLE_LENGTH)
    || !Array.isArray(paper.authors)
    || paper.authors.length < 1
    || paper.authors.length > MAX_AUTHORS
    || paper.authors.some(
      (author) => !requiredCanonicalText(author, MAX_AUTHOR_LENGTH),
    )
    || typeof paper.year !== "number"
    || !Number.isSafeInteger(paper.year)
    || paper.year < 0
    || !requiredCanonicalText(paper.venue, MAX_VENUE_LENGTH)
    || typeof paper.type !== "string"
    || !PAPER_TYPES.has(paper.type as Paper["type"])
    || typeof paper.abstract !== "string"
    || paper.abstract.length > MAX_ABSTRACT_LENGTH
    || (paper.abstract.length > 0 && paper.abstract !== paper.abstract.trim())
    || !hasNormalizedIdentifiers(paper.identifiers)
    || !isRetainedPublicUrl(paper.sourceUrl)
    || typeof access.isOpenAccess !== "boolean"
    || access.hasFullText !== false
    || access.landingPageUrl !== paper.sourceUrl
    || (hasOwn(access, "pdfUrl") && !isRetainedPublicUrl(access.pdfUrl))
    || (
      hasOwn(access, "license")
      && !optionalCanonicalText(access.license, MAX_LICENSE_LENGTH)
    )
    || (
      hasOwn(access, "version")
      && !optionalCanonicalText(access.version, MAX_VERSION_LENGTH)
    )
    || provenance.sourceType !== "web-source"
    || provenance.sourceId !== paper.sourceUrl
    || provenance.sourceUrl !== paper.sourceUrl
    || provenance.sourceTitle !== paper.title
    || provenance.providerName !== RETAINED_WEB_MCP_PROVIDER_NAME_V1
    || provenance.accessMethod !== "webmcp"
    || !isCanonicalIsoDateTime(provenance.retrievedAt)
    || hasOwn(access, "version") !== hasOwn(provenance, "version")
    || provenance.version !== access.version
  ) return false;

  const sourceDigest = sha256(paper.sourceUrl);
  const expectedSnippet = codePointPrefix(paper.abstract, 5_000);
  const hasExcerpt = hasOwn(provenance, "excerpt");
  return paper.id === `webmcp-${sourceDigest}`
    && paper.shortTitle === codePointPrefix(paper.title, 500)
    && paper.abstractSnippet === expectedSnippet
    && paper.whyRead === ""
    && paper.relevanceScore === 0
    && Array.isArray(paper.relevanceTags)
    && paper.relevanceTags.length === 0
    && paper.evidenceStrength === "unassessed"
    && paper.readingStatus === "unread"
    && paper.readingProgress === 0
    && paper.estimatedMinutes === 0
    && paper.isDemoRecord === false
    && provenance.id === `webmcp-provenance-${sourceDigest}`
    && hasExcerpt === (expectedSnippet.length > 0)
    && provenance.excerpt === (expectedSnippet || undefined);
}

function decodeSnapshotV1(
  value: Record<string, unknown>,
): HistoricalServerManagedWebMcpSnapshotV1 | null {
  return hasExactKeys(value, SNAPSHOT_V1_KEYS)
    && hasRetainedV1SnapshotBody(value)
    ? value as unknown as HistoricalServerManagedWebMcpSnapshotV1
    : null;
}

function decodeSnapshotV2(
  value: Record<string, unknown>,
): ServerManagedWebMcpSnapshotV2 | null {
  return hasExactKeys(value, SNAPSHOT_V2_KEYS)
    && value.schemaVersion === WEB_MCP_SNAPSHOT_SCHEMA_VERSION
    && hasRetainedV1SnapshotBody(value)
    ? value as unknown as ServerManagedWebMcpSnapshotV2
    : null;
}

/**
 * Decode by the retained wire version. An absent version means only the exact
 * historical v1 envelope; an explicit v1, malformed version, or unknown future
 * version is rejected so no payload can be guessed into a digest contract.
 */
export function decodeServerManagedWebMcpSnapshot(
  value: unknown,
): DecodedServerManagedWebMcpSnapshot | null {
  try {
    if (!isRecord(value)) return null;
    if (!hasOwn(value, "schemaVersion")) {
      const snapshot = decodeSnapshotV1(value);
      return snapshot ? { schemaVersion: 1, snapshot } : null;
    }
    if (value.schemaVersion !== WEB_MCP_SNAPSHOT_SCHEMA_VERSION) return null;
    const snapshot = decodeSnapshotV2(value);
    return snapshot
      ? { schemaVersion: WEB_MCP_SNAPSHOT_SCHEMA_VERSION, snapshot }
      : null;
  } catch {
    return null;
  }
}

export function isServerManagedWebMcpSnapshot(
  value: unknown,
): value is ServerManagedWebMcpSnapshot {
  return decodeServerManagedWebMcpSnapshot(value) !== null;
}

function digestDecodedSnapshot(
  decoded: DecodedServerManagedWebMcpSnapshot,
): string {
  switch (decoded.schemaVersion) {
    case 1:
      // Historical v1 rows used an unprefixed SHA-256. Their closed key set is
      // ASCII, so code-point ordering is byte-for-byte compatible with the
      // former locale sort while removing locale dependence from verification.
      return sha256(canonicalWebMcpSnapshotJson(decoded.snapshot));
    case WEB_MCP_SNAPSHOT_SCHEMA_VERSION:
      return sha256(
        WEB_MCP_SNAPSHOT_V2_DIGEST_DOMAIN
        + canonicalWebMcpSnapshotJson(decoded.snapshot),
      );
  }
}

/**
 * One version-aware digest authority for staging, retained provenance, read
 * DTOs, review commands, and approval records. Invalid/unknown snapshots throw
 * closed instead of being assigned a guessed digest version.
 */
export function webMcpSnapshotDigest(
  snapshot: ServerManagedWebMcpSnapshot,
): string {
  const decoded = decodeServerManagedWebMcpSnapshot(snapshot);
  if (!decoded) {
    throw new TypeError("The WebMCP snapshot does not match a retained schema version.");
  }
  return digestDecodedSnapshot(decoded);
}

/** Closed verification for callers that have not decoded persisted JSON yet. */
export function verifyWebMcpSnapshotDigest(
  value: unknown,
  expectedDigest: unknown,
): value is ServerManagedWebMcpSnapshot {
  if (typeof expectedDigest !== "string" || !SHA256_PATTERN.test(expectedDigest)) {
    return false;
  }
  const decoded = decodeServerManagedWebMcpSnapshot(value);
  return decoded !== null && digestDecodedSnapshot(decoded) === expectedDigest;
}
