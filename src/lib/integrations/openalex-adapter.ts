import { randomUUID } from "node:crypto";

import type {
  LiteratureSearchHit,
  LiteratureSearchProvider,
  LiteratureSearchRequest,
  LiteratureSearchResponse,
  ProviderDescriptor,
} from "./contracts";
import type { Paper, PaperType, Provenance } from "../types";
import { safeRequestId } from "../http/request-id";

const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const OPENALEX_TIMEOUT_MS = 12_000;
const OPENALEX_MAX_URL_BYTES = 4_094;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;

const OPENALEX_SELECT_FIELDS = [
  "id",
  "ids",
  "doi",
  "title",
  "publication_year",
  "publication_date",
  "type",
  "language",
  "authorships",
  "primary_location",
  "best_oa_location",
  "open_access",
  "has_fulltext",
  "cited_by_count",
  "abstract_inverted_index",
  "topics",
  "keywords",
  "is_retracted",
  "relevance_score",
  "updated_date",
].join(",");

const PAPER_TYPE_TO_OPENALEX: Readonly<Partial<Record<PaperType, string>>> = {
  "journal article": "article",
  "conference paper": "conference-paper",
  review: "review",
};

const DEFAULT_OPENALEX_TYPES = ["article", "conference-paper", "review"] as const;

export type OpenAlexProviderErrorCode =
  | "openalex_invalid_request"
  | "openalex_not_configured"
  | "openalex_authentication_failed"
  | "openalex_rate_limited"
  | "openalex_timeout"
  | "openalex_unavailable"
  | "openalex_bad_response";

export interface OpenAlexProviderErrorOptions {
  code: OpenAlexProviderErrorCode;
  status: number;
  retryable: boolean;
  requestId?: string;
  providerStatus?: number;
  retryAfterSeconds?: number;
  retryAt?: string;
}

/** A normalized provider failure that the API route can safely return to clients. */
export class OpenAlexProviderError extends Error {
  readonly code: OpenAlexProviderErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly providerStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly retryAt?: string;

  constructor(message: string, options: OpenAlexProviderErrorOptions) {
    super(message);
    this.name = "OpenAlexProviderError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.requestId = options.requestId;
    this.providerStatus = options.providerStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.retryAt = options.retryAt;
  }
}

export interface OpenAlexAdapterOptions {
  apiKey?: string;
  allowAnonymous?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  retryDelayMs?: number;
}

interface OpenAlexResponseEnvelope {
  meta: Record<string, unknown>;
  results: Record<string, unknown>[];
}

interface NormalizedWork {
  paper: Paper;
  provenance: Provenance;
  providerScore: number;
  matchedTerms: string[];
  missingAbstract: boolean;
  missingYear: boolean;
}

class OpenAlexTimeoutError extends Error {
  constructor() {
    super("The OpenAlex request exceeded the interactive timeout.");
    this.name = "OpenAlexTimeoutError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function truncateText(value: string, maximumLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`;
}

const URL_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const MAX_PROVIDER_URL_LENGTH = 8_192;

/**
 * Normalize untrusted provider links before they reach a browser-facing DTO.
 * HTTPS wins across candidates; HTTP is retained only when no valid HTTPS
 * candidate exists. Relative URLs and executable/non-web schemes are rejected.
 */
export function normalizeProviderUrlCandidates(
  values: ReadonlyArray<unknown>,
): string | undefined {
  const candidates: Array<{ protocol: "https:" | "http:"; value: string }> = [];

  for (const value of values) {
    if (typeof value !== "string") continue;
    const cleaned = value.replace(URL_CONTROL_CHARACTERS, "").trim();
    if (!cleaned || cleaned.length > MAX_PROVIDER_URL_LENGTH) continue;

    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      if (!parsed.hostname) continue;
      parsed.username = "";
      parsed.password = "";
      candidates.push({
        protocol: parsed.protocol,
        value: parsed.toString(),
      });
    } catch {
      // Provider URLs are optional metadata. Invalid candidates are omitted.
    }
  }

  return candidates.find((candidate) => candidate.protocol === "https:")?.value
    ?? candidates.find((candidate) => candidate.protocol === "http:")?.value;
}

/**
 * OpenAlex returns abstracts as token -> position arrays. Reconstruct defensively,
 * ignoring malformed entries and bounding work so a provider payload cannot cause
 * unbounded allocation in the interactive search route.
 */
export function reconstructOpenAlexAbstract(value: unknown): string {
  if (!isRecord(value)) return "";

  const positionedWords: Array<{ position: number; word: string }> = [];
  const maximumPositions = 20_000;

  for (const [word, rawPositions] of Object.entries(value)) {
    if (!word || word.length > 500 || !Array.isArray(rawPositions)) continue;

    for (const rawPosition of rawPositions) {
      if (
        positionedWords.length >= maximumPositions ||
        !Number.isInteger(rawPosition) ||
        rawPosition < 0 ||
        rawPosition > 100_000
      ) {
        continue;
      }

      positionedWords.push({ position: rawPosition, word });
    }

    if (positionedWords.length >= maximumPositions) break;
  }

  positionedWords.sort((left, right) => left.position - right.position);

  const wordsByPosition = new Map<number, string>();
  for (const item of positionedWords) {
    if (!wordsByPosition.has(item.position)) wordsByPosition.set(item.position, item.word);
  }

  return Array.from(wordsByPosition.values()).join(" ").replace(/\s+/g, " ").trim();
}

function getNestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = parent[key];
  return isRecord(value) ? value : undefined;
}

function getNestedString(parent: Record<string, unknown> | undefined, key: string): string | undefined {
  return parent ? asString(parent[key]) : undefined;
}

function getDisplayNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => (isRecord(item) ? asString(item.display_name) : undefined))
    .filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const key = value.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}

function normalizeDoi(value: unknown): string | undefined {
  const doi = asString(value);
  if (!doi) return undefined;
  return doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

function normalizePaperType(value: unknown): PaperType | undefined {
  switch (asString(value)) {
    case "article":
      return "journal article";
    case "conference-paper":
      return "conference paper";
    case "review":
      return "review";
    default:
      return undefined;
  }
}

function extractAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return uniqueStrings(
    value
      .map((authorship) => {
        if (!isRecord(authorship)) return undefined;
        const author = getNestedRecord(authorship, "author");
        return getNestedString(author, "display_name") ?? asString(authorship.raw_author_name);
      })
      .filter((author): author is string => Boolean(author)),
  );
}

function extractMatchedTerms(query: string, title: string, abstract: string): string[] {
  const searchableText = `${title} ${abstract}`.toLocaleLowerCase();
  const tokens = query.toLocaleLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];

  return uniqueStrings(tokens.filter((token) => searchableText.includes(token))).slice(0, 12);
}

function safeProviderMessage(value: unknown): string | undefined {
  const message = asString(value);
  return message ? truncateText(message, 280) : undefined;
}

function parseRetryAfterSeconds(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now.getTime()) / 1_000));

  return undefined;
}

function getRetryMetadata(headers: Headers, now: Date): {
  retryAfterSeconds?: number;
  retryAt?: string;
} {
  const retryAfter = parseRetryAfterSeconds(headers.get("retry-after"), now);
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  const retryAfterSeconds =
    retryAfter ?? (Number.isFinite(resetSeconds) && resetSeconds >= 0 ? Math.ceil(resetSeconds) : undefined);

  return {
    retryAfterSeconds,
    retryAt:
      retryAfterSeconds === undefined
        ? undefined
        : new Date(now.getTime() + retryAfterSeconds * 1_000).toISOString(),
  };
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

function parseEnvelope(value: unknown, requestId: string): OpenAlexResponseEnvelope {
  if (!isRecord(value) || !isRecord(value.meta) || !Array.isArray(value.results)) {
    throw new OpenAlexProviderError("OpenAlex returned an unexpected response shape.", {
      code: "openalex_bad_response",
      status: 502,
      retryable: true,
      requestId,
    });
  }

  const results = value.results.filter(isRecord);
  if (results.length !== value.results.length || asFiniteNumber(value.meta.count) === undefined) {
    throw new OpenAlexProviderError("OpenAlex returned incomplete search metadata.", {
      code: "openalex_bad_response",
      status: 502,
      retryable: true,
      requestId,
    });
  }

  return { meta: value.meta, results };
}

export class OpenAlexLiteratureSearchProvider implements LiteratureSearchProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "openalex",
    displayName: "OpenAlex",
    description: "Live scholarly work search over the curated OpenAlex core corpus.",
    transport: "http-api",
    isMock: false,
    capabilities: [
      "search-papers",
      "filter-metadata",
      "return-provenance",
      "return-open-access-links",
    ],
  };

  private readonly apiKey?: string;
  private readonly allowAnonymous: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;

  constructor(options: OpenAlexAdapterOptions = {}) {
    this.apiKey = options.apiKey?.trim() || process.env.OPENALEX_API_KEY?.trim() || undefined;
    this.allowAnonymous =
      options.allowAnonymous ?? process.env.OPENALEX_ALLOW_ANONYMOUS?.trim().toLowerCase() === "true";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  }

  async search(request: LiteratureSearchRequest): Promise<LiteratureSearchResponse> {
    const fallbackRequestId = `oa-${randomUUID()}`;
    const requestId = safeRequestId(request.requestId, fallbackRequestId);
    const query = request.query.trim();

    if (!query) {
      throw new OpenAlexProviderError("Enter a search query before running live discovery.", {
        code: "openalex_invalid_request",
        status: 400,
        retryable: false,
        requestId,
      });
    }

    if (!this.apiKey && !this.allowAnonymous) {
      throw new OpenAlexProviderError(
        "Live discovery is not configured. Set OPENALEX_API_KEY on the server or explicitly enable anonymous development access.",
        {
          code: "openalex_not_configured",
          status: 503,
          retryable: false,
          requestId,
        },
      );
    }

    const notices = this.buildNotices(request);
    const url = this.buildRequestUrl(request, requestId);
    const headers = new Headers({ Accept: "application/json" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);

    const response = await this.fetchWithRetry(url, headers, requestId);
    if (!response.ok) throw await this.normalizeHttpError(response, requestId);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OpenAlexProviderError("OpenAlex returned a response that was not valid JSON.", {
        code: "openalex_bad_response",
        status: 502,
        retryable: true,
        requestId,
        providerStatus: response.status,
      });
    }

    const envelope = parseEnvelope(payload, requestId);
    const retrievedAt = this.now().toISOString();
    const normalized = envelope.results
      .map((work) => this.normalizeWork(work, query, requestId, retrievedAt))
      .filter((work): work is NormalizedWork => Boolean(work));

    const topProviderScore = normalized.reduce(
      (current, work) => Math.max(current, Math.max(0, work.providerScore)),
      0,
    );

    const results: LiteratureSearchHit[] = normalized.map((work, index) => {
      const relativeScore =
        topProviderScore > 0
          ? Math.max(1, Math.min(100, Math.round((Math.max(0, work.providerScore) / topProviderScore) * 100)))
          : Math.max(1, Math.round(((normalized.length - index) / Math.max(1, normalized.length)) * 100));

      return {
        paper: { ...work.paper, relevanceScore: relativeScore },
        rank: index + 1,
        score: work.providerScore,
        matchedTerms: work.matchedTerms,
        provenance: work.provenance,
      };
    });

    const missingAbstractCount = normalized.filter((work) => work.missingAbstract).length;
    const missingYearCount = normalized.filter((work) => work.missingYear).length;
    const retractedCount = normalized.filter((work) => work.paper.isRetracted).length;
    const skippedCount = envelope.results.length - normalized.length;

    if (missingAbstractCount > 0) {
      notices.push(
        `${missingAbstractCount} result${missingAbstractCount === 1 ? " does" : "s do"} not include an abstract in OpenAlex.`,
      );
    }
    if (missingYearCount > 0) {
      notices.push(
        `${missingYearCount} result${missingYearCount === 1 ? " has" : "s have"} no publication year in OpenAlex.`,
      );
    }
    if (retractedCount > 0) {
      notices.push(
        `${retractedCount} result${retractedCount === 1 ? " is" : "s are"} marked as retracted by OpenAlex.`,
      );
    }
    if (skippedCount > 0) {
      notices.push(
        `${skippedCount} provider record${skippedCount === 1 ? " was" : "s were"} omitted because its work type could not be represented safely.`,
      );
    }

    const remainingCredits = Number(response.headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(remainingCredits) && remainingCredits <= 100) {
      notices.push(`OpenAlex reports ${Math.max(0, remainingCredits)} search credits remaining today.`);
    }

    return {
      requestId,
      provider: this.descriptor,
      retrievedAt,
      provenance: results.map((result) => result.provenance),
      notices,
      query,
      results,
      total: asFiniteNumber(envelope.meta.count) ?? 0,
    };
  }

  private buildNotices(request: LiteratureSearchRequest): string[] {
    const notices = [
      "Live results came from the curated OpenAlex core corpus.",
      "Match scores are normalized within this result page; OpenAlex relevance is not an evidence-quality assessment.",
      "Evidence strength is unassessed for live OpenAlex records.",
    ];

    if (!this.apiKey && this.allowAnonymous) {
      notices.push("This request used OpenAlex anonymous access, which has a smaller daily budget.");
    }
    if (request.filters?.evidenceStrength?.length) {
      notices.push("OpenAlex does not provide evidence-strength filtering, so that filter was not applied.");
    }
    if (request.filters?.tags?.length) {
      notices.push("PaperPilot tag filtering has no faithful OpenAlex equivalent, so that filter was not applied.");
    }

    return notices;
  }

  private buildRequestUrl(request: LiteratureSearchRequest, requestId: string): URL {
    const params = new URLSearchParams({
      search: request.query.trim(),
      corpus: "core",
      sort: "relevance_score:desc",
      page: "1",
      per_page: String(Math.min(MAX_RESULT_LIMIT, Math.max(1, request.limit ?? DEFAULT_RESULT_LIMIT))),
      select: OPENALEX_SELECT_FIELDS,
    });

    const filterParts: string[] = [];
    const { yearFrom, yearTo, paperTypes } = request.filters ?? {};

    if (yearFrom !== undefined) filterParts.push(`from_publication_date:${yearFrom}-01-01`);
    if (yearTo !== undefined) filterParts.push(`to_publication_date:${yearTo}-12-31`);
    if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
      throw new OpenAlexProviderError("The starting publication year must not be after the ending year.", {
        code: "openalex_invalid_request",
        status: 400,
        retryable: false,
        requestId,
      });
    }

    const requestedTypes = paperTypes?.length
      ? paperTypes.map((paperType) => {
          const mappedType = PAPER_TYPE_TO_OPENALEX[paperType];
          if (!mappedType) {
            throw new OpenAlexProviderError(
              `OpenAlex Discover cannot faithfully map the paper type “${paperType}”. Use journal article, conference paper, or review.`,
              {
                code: "openalex_invalid_request",
                status: 400,
                retryable: false,
                requestId,
              },
            );
          }
          return mappedType;
        })
      : [...DEFAULT_OPENALEX_TYPES];

    filterParts.push(`type:${uniqueStrings(requestedTypes).join("|")}`);
    params.set("filter", filterParts.join(","));

    const url = new URL(OPENALEX_WORKS_URL);
    url.search = params.toString();

    if (new TextEncoder().encode(url.toString()).length > OPENALEX_MAX_URL_BYTES) {
      throw new OpenAlexProviderError(
        "This search is too long for OpenAlex. Shorten the query or split a large Boolean search into smaller searches.",
        {
          code: "openalex_invalid_request",
          status: 400,
          retryable: false,
          requestId,
        },
      );
    }

    return url;
  }

  private async fetchWithRetry(url: URL, headers: Headers, requestId: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchOnce(url, headers);
        if (response.status >= 500 && attempt === 0) {
          await response.body?.cancel().catch(() => undefined);
          await delay(this.retryDelayMs);
          continue;
        }
        return response;
      } catch (error) {
        if (attempt === 0) {
          await delay(this.retryDelayMs);
          continue;
        }

        if (error instanceof OpenAlexTimeoutError) {
          throw new OpenAlexProviderError(
            "OpenAlex did not respond within 12 seconds. Try the live search again shortly.",
            {
              code: "openalex_timeout",
              status: 504,
              retryable: true,
              requestId,
            },
          );
        }

        throw new OpenAlexProviderError(
          "PaperPilot could not reach OpenAlex. Check connectivity and try again shortly.",
          {
            code: "openalex_unavailable",
            status: 502,
            retryable: true,
            requestId,
          },
        );
      }
    }

    throw new OpenAlexProviderError("OpenAlex search could not be completed.", {
      code: "openalex_unavailable",
      status: 502,
      retryable: true,
      requestId,
    });
  }

  private async fetchOnce(url: URL, headers: Headers): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, OPENALEX_TIMEOUT_MS);

    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
        cache: "no-store",
      });
    } catch (error) {
      if (timedOut) throw new OpenAlexTimeoutError();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async normalizeHttpError(response: Response, requestId: string): Promise<OpenAlexProviderError> {
    let providerMessage: string | undefined;
    try {
      const payload: unknown = await response.json();
      providerMessage = isRecord(payload) ? safeProviderMessage(payload.message) : undefined;
    } catch {
      providerMessage = undefined;
    }

    if (response.status === 400) {
      return new OpenAlexProviderError(
        providerMessage
          ? `OpenAlex rejected this search: ${providerMessage}`
          : "OpenAlex rejected this search. Check the query syntax and supported filters.",
        {
          code: "openalex_invalid_request",
          status: 400,
          retryable: false,
          requestId,
          providerStatus: response.status,
        },
      );
    }

    if (response.status === 401 || response.status === 403) {
      return new OpenAlexProviderError(
        "OpenAlex rejected the server credentials. Check OPENALEX_API_KEY before retrying live discovery.",
        {
          code: "openalex_authentication_failed",
          status: 503,
          retryable: false,
          requestId,
          providerStatus: response.status,
        },
      );
    }

    if (response.status === 429) {
      const now = this.now();
      const retry = getRetryMetadata(response.headers, now);
      const remaining = Number(response.headers.get("x-ratelimit-remaining"));
      const message =
        Number.isFinite(remaining) && remaining <= 0
          ? "The OpenAlex daily search budget is exhausted. Live discovery can resume after the provider reset."
          : "OpenAlex is rate limiting live discovery. Wait until the suggested retry time before searching again.";

      return new OpenAlexProviderError(message, {
        code: "openalex_rate_limited",
        status: 429,
        retryable: true,
        requestId,
        providerStatus: response.status,
        ...retry,
      });
    }

    const retry = getRetryMetadata(response.headers, this.now());
    return new OpenAlexProviderError(
      response.status >= 500
        ? "OpenAlex is temporarily unavailable after one retry. Try live discovery again shortly."
        : "OpenAlex returned an unexpected response while running live discovery.",
      {
        code: "openalex_unavailable",
        status: 502,
        retryable: response.status >= 500,
        requestId,
        providerStatus: response.status,
        ...retry,
      },
    );
  }

  private normalizeWork(
    work: Record<string, unknown>,
    query: string,
    requestId: string,
    retrievedAt: string,
  ): NormalizedWork | undefined {
    const sourceId = asString(work.id);
    const paperType = normalizePaperType(work.type);
    if (!sourceId || !paperType) return undefined;

    const openAlexId = sourceId.split("/").filter(Boolean).at(-1) ?? sourceId;
    const paperId = `openalex:${openAlexId}`;
    const title = asString(work.title) ?? "Untitled work";
    const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
    const abstractSnippet = abstract ? truncateText(abstract, 280) : "Abstract unavailable in OpenAlex.";
    const publicationDate = asString(work.publication_date);
    const publicationYear =
      asFiniteNumber(work.publication_year) ??
      (publicationDate ? Number.parseInt(publicationDate.slice(0, 4), 10) : undefined);
    const year = Number.isInteger(publicationYear) ? (publicationYear as number) : 0;
    const authors = extractAuthors(work.authorships);
    const primaryLocation = getNestedRecord(work, "primary_location");
    const bestOpenAccessLocation = getNestedRecord(work, "best_oa_location");
    const openAccess = getNestedRecord(work, "open_access");
    const primarySource = primaryLocation ? getNestedRecord(primaryLocation, "source") : undefined;
    const venue =
      getNestedString(primarySource, "display_name") ??
      getNestedString(primaryLocation, "raw_source_name") ??
      "Venue unavailable";
    const doi = normalizeDoi(work.doi) ?? normalizeDoi(getNestedRecord(work, "ids")?.doi);
    const isOpenAccess = asBoolean(openAccess?.is_oa) ?? asBoolean(bestOpenAccessLocation?.is_oa) ?? false;
    const landingPageUrl = normalizeProviderUrlCandidates([
      getNestedString(bestOpenAccessLocation, "landing_page_url"),
      getNestedString(openAccess, "oa_url"),
      getNestedString(primaryLocation, "landing_page_url"),
      doi ? `https://doi.org/${doi}` : undefined,
      sourceId,
    ]);
    const pdfUrl = normalizeProviderUrlCandidates([
      getNestedString(bestOpenAccessLocation, "pdf_url"),
      asBoolean(primaryLocation?.is_oa) ? getNestedString(primaryLocation, "pdf_url") : undefined,
    ]);
    const selectedLocation = bestOpenAccessLocation ?? primaryLocation;
    const hasFullText = asBoolean(work.has_fulltext) ?? Boolean(pdfUrl || (isOpenAccess && landingPageUrl));
    const providerScore = asFiniteNumber(work.relevance_score) ?? 0;
    const providerUpdatedAt = asString(work.updated_date);
    const isRetracted = asBoolean(work.is_retracted) ?? false;
    const relevanceTags = uniqueStrings([
      ...getDisplayNames(work.keywords),
      ...getDisplayNames(work.topics),
    ]).slice(0, 5);
    const whyRead = isRetracted
      ? "OpenAlex marks this record as retracted. It matched the query, but should not be relied on as current evidence."
      : "Matched your search across OpenAlex title, abstract, or full-text metadata. Review the source before using it as evidence.";

    const identifiers: Paper["identifiers"] = [{ scheme: "provider", value: sourceId }];
    if (doi) identifiers.unshift({ scheme: "doi", value: doi });

    const paper: Paper = {
      id: paperId,
      title,
      shortTitle: truncateText(title, 76),
      authors,
      year,
      venue,
      type: paperType,
      abstract,
      abstractSnippet,
      whyRead,
      relevanceScore: 0,
      relevanceTags,
      evidenceStrength: "unassessed",
      readingStatus: "unread",
      readingProgress: 0,
      estimatedMinutes: 0,
      citationCount: asFiniteNumber(work.cited_by_count),
      providerRelevanceScore: providerScore,
      identifiers,
      sourceUrl: landingPageUrl,
      access: {
        isOpenAccess,
        hasFullText,
        landingPageUrl,
        pdfUrl,
        license: getNestedString(selectedLocation, "license"),
        version: getNestedString(selectedLocation, "version"),
      },
      isRetracted,
      providerUpdatedAt,
      isDemoRecord: false,
    };

    const provenance: Provenance = {
      id: `prov-openalex-${openAlexId}-${requestId}`,
      sourceType: "literature-index",
      sourceId,
      sourceTitle: title,
      sourceUrl: normalizeProviderUrlCandidates([sourceId]),
      providerName: this.descriptor.displayName,
      retrievedAt,
      accessMethod: "api",
      excerpt: abstract ? abstractSnippet : undefined,
      version: providerUpdatedAt,
    };

    return {
      paper,
      provenance,
      providerScore,
      matchedTerms: extractMatchedTerms(query, title, abstract),
      missingAbstract: !abstract,
      missingYear: year === 0,
    };
  }
}
