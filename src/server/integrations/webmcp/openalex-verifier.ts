import "server-only";

import { createHash } from "node:crypto";

import type { PaperIdentifierType, PaperSource } from "@/generated/prisma/client";
import { reconstructOpenAlexAbstract } from "@/lib/integrations/openalex-adapter";
import type { PaperIdentifier } from "@/lib/types";
import type { ServerManagedWebMcpSnapshot } from "./snapshot-contract";

const OPENALEX_ORIGIN = "https://api.openalex.org";
const OPENALEX_AUTHORITY_VERSION = "works-singleton-v1";
const OPENALEX_MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const OPENALEX_TIMEOUT_MS = 8_000;
const OPENALEX_MAX_REDIRECTS = 2;
const MAX_PROVIDER_TITLE_LENGTH = 2_000;
const MAX_PROVIDER_AUTHOR_LENGTH = 300;
const MAX_PROVIDER_AUTHORS = 500;
const MAX_PROVIDER_VENUE_LENGTH = 1_000;
const MAX_PROVIDER_LANGUAGE_LENGTH = 50;
const MAX_PROVIDER_UPDATED_AT_LENGTH = 100;
const MAX_PROVIDER_ABSTRACT_LENGTH = 200_000;
const OPENALEX_SELECT = [
  "id",
  "ids",
  "doi",
  "title",
  "display_name",
  "publication_year",
  "publication_date",
  "type",
  "language",
  "authorships",
  "primary_location",
  "cited_by_count",
  "abstract_inverted_index",
  "is_retracted",
  "updated_date",
].join(",");

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
const OPENALEX_WORK_PATTERN = /^W\d+$/i;

export interface VerifiedCanonicalIdentifier {
  type: Extract<PaperIdentifierType, "DOI" | "OPENALEX">;
  value: string;
  normalizedValue: string;
  source: Extract<PaperSource, "OPENALEX">;
}

export interface VerifiedCanonicalAuthor {
  position: number;
  displayName: string;
}

export interface OpenAlexVerifiedCanonicalSnapshot {
  schemaVersion: 1;
  kind: "openalex_verified_work";
  authority: "OPENALEX";
  authorityVersion: typeof OPENALEX_AUTHORITY_VERSION;
  retrievedAt: string;
  sourceRecordId: string;
  providerUpdatedAt?: string;
  paper: {
    title: string;
    abstractText: string | null;
    publicationYear: number | null;
    publicationDate: string | null;
    language: string | null;
    workType: string;
    venueName: string | null;
    citationCount: number | null;
    isRetracted: boolean;
    identifiers: VerifiedCanonicalIdentifier[];
    authors: VerifiedCanonicalAuthor[];
  };
  evidenceDigest: string;
}

export type WebMcpCanonicalVerificationResult =
  | { ok: true; verified: OpenAlexVerifiedCanonicalSnapshot }
  | {
      ok: false;
      reason:
        | "unsupported_identifier"
        | "not_configured"
        | "not_found"
        | "provider_unavailable"
        | "provider_response_invalid"
        | "identifier_mismatch"
        | "proposal_mismatch";
    };

export interface WebMcpCanonicalVerifier {
  verify(snapshot: ServerManagedWebMcpSnapshot): Promise<WebMcpCanonicalVerificationResult>;
}

export interface OpenAlexWebMcpVerifierOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

const VERIFIED_SNAPSHOT_KEYS = new Set([
  "schemaVersion", "kind", "authority", "authorityVersion", "retrievedAt",
  "sourceRecordId", "providerUpdatedAt", "paper", "evidenceDigest",
]);
const VERIFIED_PAPER_KEYS = new Set([
  "title", "abstractText", "publicationYear", "publicationDate", "language",
  "workType", "venueName", "citationCount", "isRetracted", "identifiers", "authors",
]);
const VERIFIED_IDENTIFIER_KEYS = new Set([
  "type", "value", "normalizedValue", "source",
]);
const VERIFIED_AUTHOR_KEYS = new Set(["position", "displayName"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  const candidate = stringValue(value);
  return candidate && candidate.length <= maximum ? candidate : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonicalIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function webMcpVerificationEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

/**
 * Re-decode verifier output at the persistence boundary. Injected verifiers
 * and future adapters cannot smuggle open JSON or self-asserted identifiers
 * into canonical state merely by satisfying a TypeScript interface.
 */
export function isOpenAlexVerifiedCanonicalSnapshot(
  value: unknown,
): value is OpenAlexVerifiedCanonicalSnapshot {
  if (!isRecord(value) || !exactKeys(value, VERIFIED_SNAPSHOT_KEYS)) return false;
  if (
    value.schemaVersion !== 1
    || value.kind !== "openalex_verified_work"
    || value.authority !== "OPENALEX"
    || value.authorityVersion !== OPENALEX_AUTHORITY_VERSION
    || !canonicalIsoDateTime(value.retrievedAt)
    || !normalizeOpenAlexWork(value.sourceRecordId)
    || (value.providerUpdatedAt !== undefined
      && (!boundedString(value.providerUpdatedAt, MAX_PROVIDER_UPDATED_AT_LENGTH)
        || !canonicalIsoDateTime(value.providerUpdatedAt)))
    || typeof value.evidenceDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(value.evidenceDigest)
    || !isRecord(value.paper)
    || !exactKeys(value.paper, VERIFIED_PAPER_KEYS)
  ) return false;

  const paper = value.paper;
  if (
    !boundedString(paper.title, MAX_PROVIDER_TITLE_LENGTH)
    || (paper.abstractText !== null
      && !boundedString(paper.abstractText, MAX_PROVIDER_ABSTRACT_LENGTH))
    || (paper.publicationYear !== null
      && (typeof paper.publicationYear !== "number"
        || !Number.isSafeInteger(paper.publicationYear)
        || paper.publicationYear < 0
        || paper.publicationYear > 3_000))
    || (paper.publicationDate !== null && publicationDate(paper.publicationDate) === null)
    || (paper.language !== null
      && !boundedString(paper.language, MAX_PROVIDER_LANGUAGE_LENGTH))
    || !boundedString(paper.workType, 100)
    || (paper.venueName !== null
      && !boundedString(paper.venueName, MAX_PROVIDER_VENUE_LENGTH))
    || (paper.citationCount !== null
      && (typeof paper.citationCount !== "number"
        || !Number.isSafeInteger(paper.citationCount)
        || paper.citationCount < 0))
    || typeof paper.isRetracted !== "boolean"
    || !Array.isArray(paper.identifiers)
    || paper.identifiers.length < 1
    || paper.identifiers.length > 2
    || !Array.isArray(paper.authors)
    || paper.authors.length > MAX_PROVIDER_AUTHORS
  ) return false;

  let openAlexCount = 0;
  const identifierKeys = new Set<string>();
  for (const identifier of paper.identifiers) {
    if (!isRecord(identifier) || !exactKeys(identifier, VERIFIED_IDENTIFIER_KEYS)) return false;
    if (identifier.source !== "OPENALEX") return false;
    if (identifier.type === "DOI") {
      const normalized = normalizeDoi(identifier.value);
      if (!normalized || identifier.normalizedValue !== normalized) return false;
    } else if (identifier.type === "OPENALEX") {
      const normalized = normalizeOpenAlexWork(identifier.value);
      if (
        !normalized
        || normalized !== value.sourceRecordId
        || identifier.normalizedValue !== normalized.toLowerCase()
      ) return false;
      openAlexCount += 1;
    } else {
      return false;
    }
    const key = `${identifier.type}:${identifier.normalizedValue}`;
    if (identifierKeys.has(key)) return false;
    identifierKeys.add(key);
  }
  if (openAlexCount !== 1) return false;
  for (let index = 0; index < paper.authors.length; index += 1) {
    const author = paper.authors[index];
    if (
      !isRecord(author)
      || !exactKeys(author, VERIFIED_AUTHOR_KEYS)
      || author.position !== index
      || !boundedString(author.displayName, MAX_PROVIDER_AUTHOR_LENGTH)
    ) return false;
  }
  const { evidenceDigest, ...evidence } = value;
  return evidenceDigest === webMcpVerificationEvidenceDigest(evidence);
}

function normalizeDoi(value: unknown): string | undefined {
  const normalized = stringValue(value)
    ?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  return normalized && DOI_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeOpenAlexWork(value: unknown): string | undefined {
  const normalized = stringValue(value)
    ?.replace(/^https?:\/\/(?:www\.)?openalex\.org\//i, "")
    .replace(/^openalex:\s*/i, "")
    .trim()
    .toUpperCase();
  return normalized && OPENALEX_WORK_PATTERN.test(normalized) ? normalized : undefined;
}

function supportedClaims(identifiers: PaperIdentifier[]): {
  doi: string[];
  openAlex: string[];
} {
  const doi: string[] = [];
  const openAlex: string[] = [];
  for (const identifier of identifiers) {
    if (identifier.scheme === "doi") {
      const value = normalizeDoi(identifier.value);
      if (value && !doi.includes(value)) doi.push(value);
    } else if (identifier.scheme === "provider") {
      const value = normalizeOpenAlexWork(identifier.value);
      if (value && !openAlex.includes(value)) openAlex.push(value);
    }
  }
  return { doi, openAlex };
}

function exactOpenAlexUrl(lookup: string): URL {
  const url = new URL(`${OPENALEX_ORIGIN}/works/${encodeURIComponent(lookup)}`);
  url.searchParams.set("select", OPENALEX_SELECT);
  return url;
}

function validatedRedirect(current: URL, location: string): URL | null {
  let candidate: URL;
  try {
    candidate = new URL(location, current);
  } catch {
    return null;
  }
  if (
    candidate.origin !== OPENALEX_ORIGIN
    || candidate.username
    || candidate.password
    || candidate.hash
    || !/^\/works\/(?:W\d+|[^/]+)$/i.test(candidate.pathname)
    || [...candidate.searchParams.keys()].some((key) => key !== "select")
    || (
      candidate.searchParams.has("select")
      && candidate.searchParams.get("select") !== OPENALEX_SELECT
    )
  ) return null;
  candidate.search = "";
  candidate.searchParams.set("select", OPENALEX_SELECT);
  return candidate;
}

function discardResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // A locked or already-consumed body has nothing left for this caller to do.
  }
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    discardResponseBody(response);
    return undefined;
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
      discardResponseBody(response);
      return undefined;
    }
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > OPENALEX_MAX_RESPONSE_BYTES) {
      discardResponseBody(response);
      return undefined;
    }
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const requestCancellation = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancellation is best-effort and must never extend the absolute deadline.
    }
  };
  signal.addEventListener("abort", requestCancellation, { once: true });
  try {
    while (true) {
      if (signal.aborted) return undefined;
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      total += next.value.byteLength;
      if (total > OPENALEX_MAX_RESPONSE_BYTES) {
        requestCancellation();
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", requestCancellation);
    if (!completed) requestCancellation();
    try {
      reader.releaseLock();
    } catch {
      // The body can already be released or cancelled by the fetch implementation.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function providerAuthors(value: unknown): VerifiedCanonicalAuthor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const author = nestedRecord(entry, "author");
    const displayName = boundedString(author?.display_name, MAX_PROVIDER_AUTHOR_LENGTH)
      ?? boundedString(entry.raw_author_name, MAX_PROVIDER_AUTHOR_LENGTH);
    return displayName ? [displayName] : [];
  }).slice(0, MAX_PROVIDER_AUTHORS).map((displayName, position) => ({
    position,
    displayName,
  }));
}

function providerType(value: unknown): string {
  const normalized = boundedString(value, 80)?.toLowerCase();
  switch (normalized) {
    case "review": return "review";
    case "conference-paper": return "conference paper";
    case "methods-article": return "methods paper";
    case "article": return "journal article";
    default: return normalized ? `openalex:${normalized}` : "openalex:unknown";
  }
}

function publicationDate(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate;
}

function normalizedWords(value: string): string[] {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function titleCoherent(proposed: string, verified: string): boolean {
  const left = new Set(normalizedWords(proposed));
  const right = new Set(normalizedWords(verified));
  if (left.size === 0 || right.size === 0) return false;
  const intersection = [...left].filter((word) => right.has(word)).length;
  return (2 * intersection) / (left.size + right.size) >= 0.72;
}

function authorCoherent(proposed: string[], verified: VerifiedCanonicalAuthor[]): boolean {
  if (verified.length === 0) return false;
  const proposedNames = proposed.map(normalizedWords).filter((value) => value.length > 0);
  const verifiedNames = verified.map((author) => normalizedWords(author.displayName));
  return proposedNames.some((left) => verifiedNames.some((right) => {
    const leftFull = left.join(" ");
    const rightFull = right.join(" ");
    return leftFull === rightFull || left.at(-1) === right.at(-1);
  }));
}

function normalizedVerifiedWork(
  value: unknown,
  claims: ReturnType<typeof supportedClaims>,
  proposal: ServerManagedWebMcpSnapshot,
  retrievedAt: string,
): WebMcpCanonicalVerificationResult {
  if (!isRecord(value)) return { ok: false, reason: "provider_response_invalid" };
  const sourceRecordId = normalizeOpenAlexWork(value.id);
  const ids = nestedRecord(value, "ids");
  const doi = normalizeDoi(value.doi) ?? normalizeDoi(ids?.doi);
  const title = boundedString(value.title, MAX_PROVIDER_TITLE_LENGTH)
    ?? boundedString(value.display_name, MAX_PROVIDER_TITLE_LENGTH);
  const year = finiteInteger(value.publication_year);
  const authors = providerAuthors(value.authorships);
  if (
    !sourceRecordId
    || !title
    || typeof value.is_retracted !== "boolean"
  ) return { ok: false, reason: "provider_response_invalid" };
  if (
    claims.doi.some((claim) => claim !== doi)
    || claims.openAlex.some((claim) => claim !== sourceRecordId)
  ) return { ok: false, reason: "identifier_mismatch" };
  if (
    !titleCoherent(proposal.paper.title, title)
    || (proposal.paper.year > 0 && (year === undefined || Math.abs(year - proposal.paper.year) > 1))
    || (proposal.paper.authors.length > 0 && !authorCoherent(proposal.paper.authors, authors))
  ) return { ok: false, reason: "proposal_mismatch" };

  const primaryLocation = nestedRecord(value, "primary_location");
  const primarySource = primaryLocation ? nestedRecord(primaryLocation, "source") : undefined;
  const identifiers: VerifiedCanonicalIdentifier[] = [];
  if (doi) {
    identifiers.push({
      type: "DOI",
      value: doi,
      normalizedValue: doi,
      source: "OPENALEX",
    });
  }
  identifiers.push({
    type: "OPENALEX",
    value: sourceRecordId,
    normalizedValue: sourceRecordId.toLowerCase(),
    source: "OPENALEX",
  });
  const abstractText = reconstructOpenAlexAbstract(value.abstract_inverted_index) || null;
  if (abstractText && abstractText.length > MAX_PROVIDER_ABSTRACT_LENGTH) {
    return { ok: false, reason: "provider_response_invalid" };
  }
  const providerUpdatedAtCandidate = boundedString(
    value.updated_date,
    MAX_PROVIDER_UPDATED_AT_LENGTH,
  );
  const providerUpdatedAt = canonicalIsoDateTime(providerUpdatedAtCandidate)
    ? providerUpdatedAtCandidate
    : undefined;
  const base = {
    schemaVersion: 1 as const,
    kind: "openalex_verified_work" as const,
    authority: "OPENALEX" as const,
    authorityVersion: OPENALEX_AUTHORITY_VERSION as typeof OPENALEX_AUTHORITY_VERSION,
    retrievedAt,
    sourceRecordId,
    ...(providerUpdatedAt
      ? { providerUpdatedAt }
      : {}),
    paper: {
      title,
      abstractText,
      publicationYear: year ?? null,
      publicationDate: publicationDate(value.publication_date),
      language: boundedString(value.language, MAX_PROVIDER_LANGUAGE_LENGTH) ?? null,
      workType: providerType(value.type),
      venueName: boundedString(primarySource?.display_name, MAX_PROVIDER_VENUE_LENGTH)
        ?? boundedString(primaryLocation?.raw_source_name, MAX_PROVIDER_VENUE_LENGTH)
        ?? null,
      citationCount: finiteInteger(value.cited_by_count) ?? null,
      isRetracted: value.is_retracted,
      identifiers,
      authors,
    },
  };
  return {
    ok: true,
    verified: {
      ...base,
      evidenceDigest: webMcpVerificationEvidenceDigest(base),
    },
  };
}

/**
 * Exact singleton verification only: never search, fuzzily resolve, or trust
 * an agent-provided identifier as canonical state without a matching work.
 */
export class OpenAlexWebMcpVerifier implements WebMcpCanonicalVerifier {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: OpenAlexWebMcpVerifierOptions = {}) {
    this.apiKey = options.apiKey?.trim() || process.env.OPENALEX_API_KEY?.trim();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? OPENALEX_TIMEOUT_MS;
  }

  async verify(snapshot: ServerManagedWebMcpSnapshot): Promise<WebMcpCanonicalVerificationResult> {
    const claims = supportedClaims(snapshot.paper.identifiers);
    if (snapshot.paper.identifiers.length > 0 && claims.doi.length === 0 && claims.openAlex.length === 0) {
      return { ok: false, reason: "unsupported_identifier" };
    }
    const lookup = claims.doi[0]
      ? `doi:${claims.doi[0]}`
      : claims.openAlex[0];
    if (!lookup) return { ok: false, reason: "unsupported_identifier" };
    if (!this.apiKey) return { ok: false, reason: "not_configured" };

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operation = this.verifyRequest(snapshot, claims, lookup, controller.signal);
    try {
      return await Promise.race([
        operation,
        new Promise<WebMcpCanonicalVerificationResult>((resolve) => {
          timeout = setTimeout(() => {
            controller.abort();
            resolve({ ok: false, reason: "provider_unavailable" });
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async verifyRequest(
    snapshot: ServerManagedWebMcpSnapshot,
    claims: ReturnType<typeof supportedClaims>,
    lookup: string,
    signal: AbortSignal,
  ): Promise<WebMcpCanonicalVerificationResult> {
    let url = exactOpenAlexUrl(lookup);
    for (let redirectCount = 0; redirectCount <= OPENALEX_MAX_REDIRECTS; redirectCount += 1) {
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${this.apiKey}`,
              "User-Agent": "PaperPilot-WebMCP-Verifier/1.0",
            },
            redirect: "manual",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal,
          });
        } catch {
          return { ok: false, reason: "provider_unavailable" };
        }
        if (response.url && response.url !== url.toString()) {
          discardResponseBody(response);
          return { ok: false, reason: "provider_unavailable" };
        }
        if ([301, 302, 307, 308].includes(response.status)) {
          if (redirectCount === OPENALEX_MAX_REDIRECTS) {
            discardResponseBody(response);
            return { ok: false, reason: "provider_unavailable" };
          }
          const redirected = validatedRedirect(url, response.headers.get("location") ?? "");
          discardResponseBody(response);
          if (!redirected) return { ok: false, reason: "provider_unavailable" };
          url = redirected;
          continue;
        }
        if (response.status === 404) {
          discardResponseBody(response);
          return { ok: false, reason: "not_found" };
        }
        if (!response.ok) {
          discardResponseBody(response);
          return { ok: false, reason: "provider_unavailable" };
        }
        const value = await boundedJson(response, signal);
        if (value === undefined) return { ok: false, reason: "provider_response_invalid" };
        return normalizedVerifiedWork(
          value,
          claims,
          snapshot,
          this.now().toISOString(),
        );
    }
    return { ok: false, reason: "provider_unavailable" };
  }
}
