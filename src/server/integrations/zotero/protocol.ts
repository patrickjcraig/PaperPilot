import {
  ZOTERO_API_VERSION,
  ZOTERO_MAX_KEY_BATCH_SIZE,
  ZOTERO_MAX_PAGE_SIZE,
  type ZoteroCollectionBatchRequest,
  type ZoteroItemBatchRequest,
  type ZoteroLibraryRef,
  type ZoteroLibraryVersionRequest,
  type ZoteroListItemsRequest,
  type ZoteroListUserGroupsRequest,
  type ZoteroResponseMeta,
  type ZoteroVersion,
} from "./contracts";
import {
  ZoteroAdapterError,
  invalidZoteroRequest,
  invalidZoteroResponse,
} from "./errors";

export const ZOTERO_API_ORIGIN = "https://api.zotero.org";

const ZOTERO_OBJECT_KEY_PATTERN = /^[A-Z0-9]{8}$/;
const ZOTERO_LIBRARY_ID_PATTERN = /^[1-9][0-9]*$/;
const ZOTERO_VERSION_PATTERN = /^(0|[1-9][0-9]*)$/;
const GROUP_PAGE_QUERY_KEYS = new Set(["format", "limit", "start"]);

function parseUnsignedIntegerHeader(
  headers: Headers,
  name: string,
): number | undefined {
  const rawValue = headers.get(name);
  if (rawValue === null) return undefined;

  if (!/^(0|[1-9][0-9]*)$/.test(rawValue.trim())) {
    throw invalidZoteroResponse(`Zotero returned an invalid ${name} header.`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    throw invalidZoteroResponse(`Zotero returned an unsafe ${name} header value.`);
  }

  return value;
}

function parseRetryAfter(
  value: string | null,
  now: Date,
): { seconds?: number; retryAt?: string } {
  if (value === null) return {};

  const trimmed = value.trim();
  if (/^(0|[1-9][0-9]*)$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) {
      throw invalidZoteroResponse("Zotero returned an unsafe Retry-After header value.");
    }
    const retryAt = new Date(now.getTime() + seconds * 1_000);
    if (Number.isNaN(retryAt.getTime())) {
      throw invalidZoteroResponse("Zotero returned an out-of-range Retry-After header.");
    }
    return {
      seconds,
      retryAt: retryAt.toISOString(),
    };
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    throw invalidZoteroResponse("Zotero returned an invalid Retry-After header.");
  }

  const seconds = Math.max(0, Math.ceil((timestamp - now.getTime()) / 1_000));
  const retryAt = new Date(now.getTime() + seconds * 1_000);
  if (Number.isNaN(retryAt.getTime())) {
    throw invalidZoteroResponse("Zotero returned an out-of-range Retry-After header.");
  }
  return {
    seconds,
    retryAt: retryAt.toISOString(),
  };
}

function splitLinkHeader(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  let inAngleBrackets = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") {
      inQuotes = !inQuotes;
    } else if (!inQuotes && character === "<") {
      inAngleBrackets = true;
    } else if (!inQuotes && character === ">") {
      inAngleBrackets = false;
    } else if (!inQuotes && !inAngleBrackets && character === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parseLinkRelations(parameters: string): string[] {
  const relationMatch = parameters.match(
    /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i,
  );
  const value = relationMatch?.[1] ?? relationMatch?.[2];
  return value
    ? value
        .split(/\s+/)
        .map((relation) => relation.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

/**
 * Accepts only URLs that resolve to Zotero's exact HTTPS API origin. This is
 * used for provider-supplied Link headers before a caller may retain a next URL.
 */
export function assertZoteroApiUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value, ZOTERO_API_ORIGIN);
  } catch {
    throw invalidZoteroResponse("Zotero returned a malformed pagination URL.");
  }

  if (
    url.origin !== ZOTERO_API_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw invalidZoteroResponse(
      "Zotero returned a pagination URL outside the trusted API origin.",
    );
  }

  return url;
}

function getSingleSearchParameter(
  url: URL,
  name: string,
): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw invalidZoteroResponse(
      `Zotero returned duplicate ${name} pagination parameters.`,
    );
  }
  return values[0];
}

function parsePageInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalidZoteroResponse(
      `Zotero returned an invalid ${name} pagination parameter.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidZoteroResponse(
      `Zotero returned an unsafe ${name} pagination parameter.`,
    );
  }
  return parsed;
}

/**
 * Link headers are provider-controlled input. Group discovery follows only a
 * same-endpoint next link whose offset advances by exactly the requested page.
 */
export function assertZoteroGroupNextPageUrl(
  currentPageUrl: string | URL,
  nextPageUrl: string | URL,
): string {
  const current = assertZoteroApiUrl(currentPageUrl);
  const next = assertZoteroApiUrl(nextPageUrl);
  if (next.pathname !== current.pathname) {
    throw invalidZoteroResponse(
      "Zotero returned a group next link for a different endpoint.",
    );
  }

  for (const key of next.searchParams.keys()) {
    if (!GROUP_PAGE_QUERY_KEYS.has(key)) {
      throw invalidZoteroResponse(
        "Zotero returned an unexpected group pagination parameter.",
      );
    }
  }

  const currentLimit = parsePageInteger(
    getSingleSearchParameter(current, "limit"),
    "limit",
  );
  const currentStart = parsePageInteger(
    getSingleSearchParameter(current, "start"),
    "start",
  );
  const nextLimit = parsePageInteger(
    getSingleSearchParameter(next, "limit"),
    "limit",
  );
  const nextStart = parsePageInteger(
    getSingleSearchParameter(next, "start"),
    "start",
  );
  const format = getSingleSearchParameter(next, "format");
  if (
    currentLimit < 1 ||
    currentLimit > ZOTERO_MAX_PAGE_SIZE ||
    nextLimit !== currentLimit ||
    (format !== undefined && format !== "json") ||
    nextStart !== currentStart + currentLimit
  ) {
    throw invalidZoteroResponse(
      "Zotero returned an inconsistent group next link.",
    );
  }

  return next.toString();
}

export function parseZoteroNextLink(value: string | null): string | undefined {
  if (!value) return undefined;

  let nextPageUrl: string | undefined;
  for (const part of splitLinkHeader(value)) {
    const match = part.match(/^<([^>]*)>(.*)$/);
    if (!match) continue;
    if (!parseLinkRelations(match[2]).includes("next")) continue;
    if (nextPageUrl !== undefined) {
      throw invalidZoteroResponse(
        "Zotero returned more than one next pagination link.",
      );
    }
    nextPageUrl = assertZoteroApiUrl(match[1]).toString();
  }

  return nextPageUrl;
}

export function toZoteroVersion(value: string | number): ZoteroVersion {
  const normalized = typeof value === "number" ? String(value) : value.trim();
  if (
    !ZOTERO_VERSION_PATTERN.test(normalized) ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    throw invalidZoteroRequest("A Zotero version must be a non-negative decimal integer.");
  }

  return normalized as ZoteroVersion;
}

export function parseZoteroResponseHeaders(
  headers: Headers,
  now: Date,
  providerStatus = 200,
): Omit<ZoteroResponseMeta, "retrievedAt"> {
  const rawVersion = headers.get("last-modified-version")?.trim();
  let libraryVersion: ZoteroVersion | undefined;
  if (rawVersion !== undefined) {
    if (!ZOTERO_VERSION_PATTERN.test(rawVersion)) {
      throw invalidZoteroResponse(
        "Zotero returned an invalid Last-Modified-Version header.",
        providerStatus,
      );
    }
    libraryVersion = rawVersion as ZoteroVersion;
  }

  const backoffSeconds = parseUnsignedIntegerHeader(headers, "backoff");
  const retry = parseRetryAfter(headers.get("retry-after"), now);
  const totalResults = parseUnsignedIntegerHeader(headers, "total-results");
  const nextPageUrl = parseZoteroNextLink(headers.get("link"));

  return {
    providerStatus,
    libraryVersion,
    backoffSeconds,
    retryAfterSeconds: retry.seconds,
    retryAt: retry.retryAt,
    totalResults,
    nextPageUrl,
  };
}

export function normalizeZoteroLibraryId(value: string): string {
  const id = value.trim();
  if (!ZOTERO_LIBRARY_ID_PATTERN.test(id)) {
    throw invalidZoteroRequest("A Zotero library ID must be a positive decimal integer.");
  }
  return id;
}

function normalizeLibraryRef(library: ZoteroLibraryRef): ZoteroLibraryRef {
  const id = normalizeZoteroLibraryId(library.id);
  if (library.kind !== "user" && library.kind !== "group") {
    throw invalidZoteroRequest("A Zotero library must be a user or group library.");
  }
  return { kind: library.kind, id };
}

export function normalizeZoteroObjectKey(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!ZOTERO_OBJECT_KEY_PATTERN.test(normalized)) {
    throw invalidZoteroRequest("A Zotero object key must contain exactly 8 letters or digits.");
  }
  return normalized;
}

export const normalizeZoteroItemKey = normalizeZoteroObjectKey;
export const normalizeZoteroCollectionKey = normalizeZoteroObjectKey;

export function normalizeZoteroItemKeys(keys: readonly string[]): string[] {
  if (keys.length > ZOTERO_MAX_KEY_BATCH_SIZE) {
    throw invalidZoteroRequest(
      `A Zotero key request may contain at most ${ZOTERO_MAX_KEY_BATCH_SIZE} item keys.`,
    );
  }

  const normalized = keys.map(normalizeZoteroObjectKey);
  if (new Set(normalized).size !== normalized.length) {
    throw invalidZoteroRequest("A Zotero key request must not contain duplicate item keys.");
  }
  return normalized;
}

export function normalizeZoteroCollectionKeys(keys: readonly string[]): string[] {
  if (keys.length > ZOTERO_MAX_KEY_BATCH_SIZE) {
    throw invalidZoteroRequest(
      `A Zotero key request may contain at most ${ZOTERO_MAX_KEY_BATCH_SIZE} collection keys.`,
    );
  }

  const normalized = keys.map(normalizeZoteroObjectKey);
  if (new Set(normalized).size !== normalized.length) {
    throw invalidZoteroRequest(
      "A Zotero key request must not contain duplicate collection keys.",
    );
  }
  return normalized;
}

export function chunkZoteroItemKeys(keys: readonly string[]): string[][] {
  const normalized = keys.map(normalizeZoteroObjectKey);
  const unique = Array.from(new Set(normalized));
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += ZOTERO_MAX_KEY_BATCH_SIZE) {
    batches.push(unique.slice(index, index + ZOTERO_MAX_KEY_BATCH_SIZE));
  }
  return batches;
}

export function chunkZoteroCollectionKeys(keys: readonly string[]): string[][] {
  const normalized = keys.map(normalizeZoteroObjectKey);
  const unique = Array.from(new Set(normalized));
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += ZOTERO_MAX_KEY_BATCH_SIZE) {
    batches.push(unique.slice(index, index + ZOTERO_MAX_KEY_BATCH_SIZE));
  }
  return batches;
}

export function buildZoteroCurrentIdentityUrl(): URL {
  return new URL("/keys/current", ZOTERO_API_ORIGIN);
}

function buildLibraryResourceUrl(
  library: ZoteroLibraryRef,
  resource: "items" | "collections" | "deleted",
): URL {
  const normalized = normalizeLibraryRef(library);
  const librarySegment = normalized.kind === "user" ? "users" : "groups";
  return new URL(
    `/${librarySegment}/${normalized.id}/${resource}`,
    ZOTERO_API_ORIGIN,
  );
}

function normalizePageBounds(
  startValue: number | undefined,
  limitValue: number | undefined,
): { start: number; limit: number } {
  const limit = limitValue ?? ZOTERO_MAX_PAGE_SIZE;
  const start = startValue ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > ZOTERO_MAX_PAGE_SIZE) {
    throw invalidZoteroRequest(
      `A Zotero page limit must be an integer between 1 and ${ZOTERO_MAX_PAGE_SIZE}.`,
    );
  }
  if (!Number.isSafeInteger(start) || start < 0) {
    throw invalidZoteroRequest("A Zotero page start must be a non-negative safe integer.");
  }
  return { start, limit };
}

export function buildZoteroUserGroupsUrl(
  request: Pick<ZoteroListUserGroupsRequest, "userId" | "start" | "limit">,
): URL {
  const userId = normalizeZoteroLibraryId(request.userId);
  const { start, limit } = normalizePageBounds(request.start, request.limit);
  const url = new URL(`/users/${userId}/groups`, ZOTERO_API_ORIGIN);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("start", String(start));
  return assertZoteroApiUrl(url);
}

export function buildZoteroLibraryItemVersionsUrl(
  request: Pick<ZoteroLibraryVersionRequest, "library" | "sinceVersion">,
): URL {
  const url = buildLibraryResourceUrl(request.library, "items");
  url.searchParams.set("format", "versions");
  url.searchParams.set("since", toZoteroVersion(request.sinceVersion));
  url.searchParams.set("includeTrashed", "1");
  return assertZoteroApiUrl(url);
}

export function buildZoteroLibraryCollectionVersionsUrl(
  request: Pick<ZoteroLibraryVersionRequest, "library" | "sinceVersion">,
): URL {
  const url = buildLibraryResourceUrl(request.library, "collections");
  url.searchParams.set("format", "versions");
  url.searchParams.set("since", toZoteroVersion(request.sinceVersion));
  return assertZoteroApiUrl(url);
}

export function buildZoteroLibraryItemBatchUrl(
  request: Pick<ZoteroItemBatchRequest, "library" | "itemKeys">,
): URL {
  const keys = normalizeZoteroItemKeys(request.itemKeys);
  if (keys.length === 0) {
    throw invalidZoteroRequest("A Zotero key request must contain at least one item key.");
  }
  const url = buildLibraryResourceUrl(request.library, "items");
  url.searchParams.set("format", "json");
  url.searchParams.set("includeTrashed", "1");
  url.searchParams.set("itemKey", keys.join(","));
  url.searchParams.set("limit", String(keys.length));
  return assertZoteroApiUrl(url);
}

export function buildZoteroLibraryCollectionBatchUrl(
  request: Pick<ZoteroCollectionBatchRequest, "library" | "collectionKeys">,
): URL {
  const keys = normalizeZoteroCollectionKeys(request.collectionKeys);
  if (keys.length === 0) {
    throw invalidZoteroRequest(
      "A Zotero key request must contain at least one collection key.",
    );
  }
  const url = buildLibraryResourceUrl(request.library, "collections");
  url.searchParams.set("format", "json");
  url.searchParams.set("collectionKey", keys.join(","));
  url.searchParams.set("limit", String(keys.length));
  return assertZoteroApiUrl(url);
}

export function buildZoteroLibraryDeletedUrl(
  request: Pick<ZoteroLibraryVersionRequest, "library" | "sinceVersion">,
): URL {
  const url = buildLibraryResourceUrl(request.library, "deleted");
  url.searchParams.set("since", toZoteroVersion(request.sinceVersion));
  return assertZoteroApiUrl(url);
}

export function buildZoteroLibraryItemsUrl(
  request: Pick<
    ZoteroListItemsRequest,
    "library" | "sinceVersion" | "start" | "limit" | "itemKeys"
  >,
): URL {
  const url = buildLibraryResourceUrl(request.library, "items");
  const { start, limit } = normalizePageBounds(request.start, request.limit);

  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("start", String(start));
  if (request.sinceVersion !== undefined) {
    url.searchParams.set("since", toZoteroVersion(request.sinceVersion));
  }
  if (request.itemKeys !== undefined) {
    const keys = normalizeZoteroItemKeys(request.itemKeys);
    if (keys.length === 0) {
      throw invalidZoteroRequest("A Zotero key request must contain at least one item key.");
    }
    url.searchParams.set("itemKey", keys.join(","));
  }

  return assertZoteroApiUrl(url);
}

export function buildZoteroRequestHeaders(
  accessToken: string,
  options: { ifModifiedSinceVersion?: ZoteroVersion } = {},
): Headers {
  const token = accessToken.trim();
  if (!token || /[\r\n]/.test(token)) {
    throw new ZoteroAdapterError("The resolved Zotero credential is invalid.", {
      code: "zotero_credential_unavailable",
      status: 503,
      retryable: false,
    });
  }

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Zotero-API-Version": ZOTERO_API_VERSION,
  });
  if (options.ifModifiedSinceVersion !== undefined) {
    headers.set(
      "If-Modified-Since-Version",
      toZoteroVersion(options.ifModifiedSinceVersion),
    );
  }
  return headers;
}
