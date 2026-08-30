import "server-only";

import type {
  ZoteroCollection,
  ZoteroCollectionBatchRequest,
  ZoteroConnectionRequest,
  ZoteroConditionalResponse,
  ZoteroCredentialLookup,
  ZoteroCredentialResolver,
  ZoteroDeletedObjects,
  ZoteroGroup,
  ZoteroIdentity,
  ZoteroIdentityAccess,
  ZoteroItem,
  ZoteroItemBatchRequest,
  ZoteroLibraryVersionRequest,
  ZoteroListItemsRequest,
  ZoteroListUserGroupsRequest,
  ZoteroPermissionSet,
  ZoteroReadOnlyClient,
  ZoteroResponse,
  ZoteroResponseMeta,
  ZoteroVersionManifest,
} from "./contracts";
import { ZoteroAdapterError, invalidZoteroResponse } from "./errors";
import {
  assertZoteroApiUrl,
  assertZoteroGroupNextPageUrl,
  buildZoteroCurrentIdentityUrl,
  buildZoteroLibraryCollectionBatchUrl,
  buildZoteroLibraryCollectionVersionsUrl,
  buildZoteroLibraryDeletedUrl,
  buildZoteroLibraryItemBatchUrl,
  buildZoteroLibraryItemsUrl,
  buildZoteroLibraryItemVersionsUrl,
  buildZoteroRequestHeaders,
  buildZoteroUserGroupsUrl,
  normalizeZoteroCollectionKeys,
  normalizeZoteroItemKeys,
  parseZoteroResponseHeaders,
  toZoteroVersion,
} from "./protocol";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CONNECTION_ID_LENGTH = 200;
const MAX_ORGANIZATION_ID_LENGTH = 200;

export interface ZoteroReadOnlyAdapterOptions {
  credentialResolver: ZoteroCredentialResolver;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new Error("invalid-content-length");
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) {
      throw new Error("response-too-large");
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizePermissions(value: unknown): ZoteroPermissionSet | undefined {
  if (!isRecord(value)) return undefined;
  const permissions: ZoteroPermissionSet = {};
  for (const key of ["library", "files", "notes", "write"] as const) {
    if (typeof value[key] === "boolean") permissions[key] = value[key];
  }
  return permissions;
}

function sanitizeIdentityAccess(value: unknown): ZoteroIdentityAccess {
  if (!isRecord(value)) return {};
  const access: ZoteroIdentityAccess = {};
  const user = sanitizePermissions(value.user);
  if (user) access.user = user;

  if (isRecord(value.groups)) {
    const groups: NonNullable<ZoteroIdentityAccess["groups"]> = {};
    for (const [groupId, rawPermissions] of Object.entries(value.groups)) {
      if (groupId !== "all" && !/^[1-9][0-9]*$/.test(groupId)) continue;
      const permissions = sanitizePermissions(rawPermissions);
      if (permissions) groups[groupId] = permissions;
    }
    access.groups = groups;
  }
  return access;
}

function parseIdentity(value: unknown, providerStatus: number): ZoteroIdentity {
  if (!isRecord(value)) {
    throw invalidZoteroResponse(
      "Zotero returned an unexpected key identity response.",
      providerStatus,
    );
  }

  const rawUserId = value.userID;
  const userId =
    typeof rawUserId === "number" && Number.isSafeInteger(rawUserId) && rawUserId > 0
      ? String(rawUserId)
      : typeof rawUserId === "string" && /^[1-9][0-9]*$/.test(rawUserId)
        ? rawUserId
        : undefined;

  if (!userId) {
    throw invalidZoteroResponse(
      "Zotero returned a key identity without a valid user ID.",
      providerStatus,
    );
  }

  return {
    userId,
    username: optionalString(value.username),
    displayName: optionalString(value.displayName),
    access: sanitizeIdentityAccess(value.access),
  };
}

function parseProviderId(
  value: unknown,
  label: string,
  providerStatus: number,
): string {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    return value;
  }
  throw invalidZoteroResponse(
    `Zotero returned ${label} without a valid numeric ID.`,
    providerStatus,
  );
}

function parseProviderVersion(
  value: unknown,
  label: string,
  providerStatus: number,
) {
  try {
    if (typeof value !== "number" && typeof value !== "string") throw new Error();
    return toZoteroVersion(value);
  } catch {
    throw invalidZoteroResponse(
      `Zotero returned ${label} without a valid version.`,
      providerStatus,
    );
  }
}

function parseProviderObjectKey(
  value: unknown,
  label: string,
  providerStatus: number,
): string {
  if (typeof value !== "string" || !/^[A-Z0-9]{8}$/.test(value)) {
    throw invalidZoteroResponse(
      `Zotero returned ${label} without a valid key.`,
      providerStatus,
    );
  }
  return value;
}

function parseGroup(value: unknown, providerStatus: number): ZoteroGroup {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw invalidZoteroResponse(
      "Zotero returned a group with an unexpected response shape.",
      providerStatus,
    );
  }

  const id = parseProviderId(value.id, "a group", providerStatus);
  const dataId = parseProviderId(value.data.id, "group data", providerStatus);
  const version = parseProviderVersion(value.version, "a group", providerStatus);
  const dataVersion = parseProviderVersion(
    value.data.version,
    "group data",
    providerStatus,
  );
  if (id !== dataId || version !== dataVersion) {
    throw invalidZoteroResponse(
      "Zotero returned inconsistent group identity metadata.",
      providerStatus,
    );
  }

  const name = optionalString(value.data.name);
  const type = value.data.type;
  const libraryReading = value.data.libraryReading;
  const libraryEditing = value.data.libraryEditing;
  const fileEditing = value.data.fileEditing;
  if (
    !name ||
    (type !== "PublicOpen" && type !== "PublicClosed" && type !== "Private") ||
    (libraryReading !== "all" && libraryReading !== "members") ||
    (libraryEditing !== "members" && libraryEditing !== "admins") ||
    (fileEditing !== "members" && fileEditing !== "admins" && fileEditing !== "none")
  ) {
    throw invalidZoteroResponse(
      "Zotero returned a group without valid name or permission metadata.",
      providerStatus,
    );
  }

  return {
    id,
    version,
    name,
    type,
    libraryReading,
    libraryEditing,
    fileEditing,
    data: value.data,
    links: isRecord(value.links) ? value.links : undefined,
    meta: isRecord(value.meta) ? value.meta : undefined,
  };
}

function parseGroupPage(value: unknown, providerStatus: number): ZoteroGroup[] {
  if (!Array.isArray(value)) {
    throw invalidZoteroResponse(
      "Zotero returned an unexpected group page response.",
      providerStatus,
    );
  }
  const groups = value.map((group) => parseGroup(group, providerStatus));
  if (new Set(groups.map((group) => group.id)).size !== groups.length) {
    throw invalidZoteroResponse(
      "Zotero returned duplicate groups in one page.",
      providerStatus,
    );
  }
  return groups;
}

function parseItem(value: unknown, providerStatus: number): ZoteroItem {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw invalidZoteroResponse(
      "Zotero returned an item with an unexpected response shape.",
      providerStatus,
    );
  }

  const key = parseProviderObjectKey(value.key, "an item", providerStatus);
  const dataKey = parseProviderObjectKey(value.data.key, "item data", providerStatus);
  const version = parseProviderVersion(value.version, "an item", providerStatus);
  const dataVersion = parseProviderVersion(
    value.data.version,
    "item data",
    providerStatus,
  );
  if (key !== dataKey || version !== dataVersion) {
    throw invalidZoteroResponse(
      "Zotero returned inconsistent item identity metadata.",
      providerStatus,
    );
  }

  return {
    key,
    version,
    data: value.data,
    library: isRecord(value.library) ? value.library : undefined,
    links: isRecord(value.links) ? value.links : undefined,
    meta: isRecord(value.meta) ? value.meta : undefined,
  };
}

function parseItemPage(value: unknown, providerStatus: number): ZoteroItem[] {
  if (!Array.isArray(value)) {
    throw invalidZoteroResponse(
      "Zotero returned an unexpected item page response.",
      providerStatus,
    );
  }
  const items = value.map((item) => parseItem(item, providerStatus));
  if (new Set(items.map((item) => item.key)).size !== items.length) {
    throw invalidZoteroResponse(
      "Zotero returned duplicate items in one response.",
      providerStatus,
    );
  }
  return items;
}

function parseCollection(
  value: unknown,
  providerStatus: number,
): ZoteroCollection {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw invalidZoteroResponse(
      "Zotero returned a collection with an unexpected response shape.",
      providerStatus,
    );
  }
  const key = parseProviderObjectKey(value.key, "a collection", providerStatus);
  const dataKey = parseProviderObjectKey(
    value.data.key,
    "collection data",
    providerStatus,
  );
  const version = parseProviderVersion(value.version, "a collection", providerStatus);
  const dataVersion = parseProviderVersion(
    value.data.version,
    "collection data",
    providerStatus,
  );
  if (key !== dataKey || version !== dataVersion) {
    throw invalidZoteroResponse(
      "Zotero returned inconsistent collection identity metadata.",
      providerStatus,
    );
  }
  return {
    key,
    version,
    data: value.data,
    library: isRecord(value.library) ? value.library : undefined,
    links: isRecord(value.links) ? value.links : undefined,
    meta: isRecord(value.meta) ? value.meta : undefined,
  };
}

function parseCollectionPage(
  value: unknown,
  providerStatus: number,
): ZoteroCollection[] {
  if (!Array.isArray(value)) {
    throw invalidZoteroResponse(
      "Zotero returned an unexpected collection response.",
      providerStatus,
    );
  }
  const collections = value.map((entry) => parseCollection(entry, providerStatus));
  if (new Set(collections.map((entry) => entry.key)).size !== collections.length) {
    throw invalidZoteroResponse(
      "Zotero returned duplicate collections in one response.",
      providerStatus,
    );
  }
  return collections;
}

function parseVersionManifest(
  value: unknown,
  providerStatus: number,
): ZoteroVersionManifest {
  if (!isRecord(value)) {
    throw invalidZoteroResponse(
      "Zotero returned an unexpected version manifest.",
      providerStatus,
    );
  }
  const manifest: Record<string, ReturnType<typeof toZoteroVersion>> = {};
  for (const [key, rawVersion] of Object.entries(value)) {
    const parsedKey = parseProviderObjectKey(key, "a manifest entry", providerStatus);
    manifest[parsedKey] = parseProviderVersion(
      rawVersion,
      "a manifest entry",
      providerStatus,
    );
  }
  return manifest;
}

function parseDeletedKeyArray(
  value: unknown,
  label: string,
  providerStatus: number,
): string[] {
  if (!Array.isArray(value)) {
    throw invalidZoteroResponse(
      `Zotero returned an invalid ${label} deletion list.`,
      providerStatus,
    );
  }
  const keys = value.map((key) =>
    parseProviderObjectKey(key, `a deleted ${label} object`, providerStatus));
  if (new Set(keys).size !== keys.length) {
    throw invalidZoteroResponse(
      `Zotero returned duplicate ${label} deletions.`,
      providerStatus,
    );
  }
  return keys;
}

function parseDeletedTags(value: unknown, providerStatus: number): string[] {
  if (!Array.isArray(value)) {
    throw invalidZoteroResponse(
      "Zotero returned an invalid tag deletion list.",
      providerStatus,
    );
  }
  const tags = value.map((tag) => {
    if (typeof tag !== "string" || !tag) {
      throw invalidZoteroResponse(
        "Zotero returned an invalid deleted tag.",
        providerStatus,
      );
    }
    return tag;
  });
  if (new Set(tags).size !== tags.length) {
    throw invalidZoteroResponse(
      "Zotero returned duplicate tag deletions.",
      providerStatus,
    );
  }
  return tags;
}

function parseDeletedObjects(
  value: unknown,
  providerStatus: number,
): ZoteroDeletedObjects {
  if (!isRecord(value)) {
    throw invalidZoteroResponse(
      "Zotero returned an unexpected deletion manifest.",
      providerStatus,
    );
  }
  return {
    collections: parseDeletedKeyArray(value.collections, "collection", providerStatus),
    items: parseDeletedKeyArray(value.items, "item", providerStatus),
    searches: parseDeletedKeyArray(value.searches, "search", providerStatus),
    tags: parseDeletedTags(value.tags, providerStatus),
  };
}

function normalizedConnectionLookup(
  organizationId: string,
  connectionId: string,
): ZoteroCredentialLookup {
  const normalizedOrganizationId = organizationId.trim();
  const normalized = connectionId.trim();
  if (
    !normalizedOrganizationId
    || normalizedOrganizationId.length > MAX_ORGANIZATION_ID_LENGTH
    || !/^[a-zA-Z0-9._:-]+$/.test(normalizedOrganizationId)
  ) {
    throw new ZoteroAdapterError("A valid authorized workspace ID is required.", {
      code: "zotero_invalid_request",
      status: 400,
      retryable: false,
    });
  }
  if (!normalized || normalized.length > MAX_CONNECTION_ID_LENGTH || /[\r\n]/.test(normalized)) {
    throw new ZoteroAdapterError("A valid Zotero connection ID is required.", {
      code: "zotero_invalid_request",
      status: 400,
      retryable: false,
    });
  }
  return { organizationId: normalizedOrganizationId, connectionId: normalized };
}

/**
 * Read-only Zotero Web API v3 adapter. It has no write methods and receives a
 * fresh token through the injected resolver for each outbound request.
 */
export class ZoteroReadOnlyAdapter implements ZoteroReadOnlyClient {
  private readonly credentialResolver: ZoteroCredentialResolver;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: ZoteroReadOnlyAdapterOptions) {
    this.credentialResolver = options.credentialResolver;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new Error("Zotero adapter timeout or response-size configuration is invalid.");
    }
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async getCurrentIdentity(
    request: ZoteroConnectionRequest,
  ): Promise<ZoteroResponse<ZoteroIdentity>> {
    let response: Awaited<ReturnType<ZoteroReadOnlyAdapter["getJson"]>>;
    try {
      response = await this.getJson(
        request.organizationId,
        request.connectionId,
        buildZoteroCurrentIdentityUrl(),
      );
    } catch (error) {
      // Zotero uses 403 both for invalid keys and for library ACL failures.
      // On /keys/current there is no library ACL involved, so 403 is an
      // authentication failure for the connection itself.
      if (
        error instanceof ZoteroAdapterError
        && error.providerStatus === 403
      ) {
        throw new ZoteroAdapterError(
          "The Zotero connection is no longer authorized.",
          {
            code: "zotero_authentication_failed",
            status: 401,
            retryable: false,
            providerStatus: error.providerStatus,
            backoffSeconds: error.backoffSeconds,
            retryAfterSeconds: error.retryAfterSeconds,
            retryAt: error.retryAt,
            cause: error,
          },
        );
      }
      throw error;
    }
    return {
      outcome: "data",
      data: parseIdentity(response.body, response.meta.providerStatus),
      meta: response.meta,
    };
  }

  async listLibraryItems(
    request: ZoteroListItemsRequest,
  ): Promise<ZoteroResponse<ZoteroItem[]>> {
    const response = await this.getJson(
      request.organizationId,
      request.connectionId,
      buildZoteroLibraryItemsUrl(request),
    );
    return {
      outcome: "data",
      data: parseItemPage(response.body, response.meta.providerStatus),
      meta: response.meta,
    };
  }

  async listUserGroups(
    request: ZoteroListUserGroupsRequest,
  ): Promise<ZoteroResponse<ZoteroGroup[]>> {
    const url = buildZoteroUserGroupsUrl(request);
    const response = await this.getJson(
      request.organizationId,
      request.connectionId,
      url,
    );
    const groups = parseGroupPage(response.body, response.meta.providerStatus);
    const limit = request.limit ?? 100;
    const start = request.start ?? 0;
    const totalResults = response.meta.totalResults;
    if (
      groups.length > limit ||
      totalResults === undefined ||
      totalResults < start + groups.length
    ) {
      throw invalidZoteroResponse(
        "Zotero returned inconsistent group pagination metadata.",
        response.meta.providerStatus,
        response.meta,
      );
    }
    const hasMoreResults = start + groups.length < totalResults;
    if (hasMoreResults !== (response.meta.nextPageUrl !== undefined)) {
      throw invalidZoteroResponse(
        "Zotero returned an incomplete group pagination chain.",
        response.meta.providerStatus,
        response.meta,
      );
    }
    if (response.meta.nextPageUrl !== undefined) {
      assertZoteroGroupNextPageUrl(url, response.meta.nextPageUrl);
      if (groups.length !== limit) {
        throw invalidZoteroResponse(
          "Zotero returned a short group page with a next link.",
          response.meta.providerStatus,
          response.meta,
        );
      }
      const nextStart = Number(new URL(response.meta.nextPageUrl).searchParams.get("start"));
      if (nextStart >= totalResults) {
        throw invalidZoteroResponse(
          "Zotero returned a group next link beyond the result set.",
          response.meta.providerStatus,
          response.meta,
        );
      }
    }
    return { outcome: "data", data: groups, meta: response.meta };
  }

  async listLibraryItemVersions(
    request: ZoteroLibraryVersionRequest,
  ): Promise<ZoteroConditionalResponse<ZoteroVersionManifest>> {
    const response = await this.getConditionalJson(
      request,
      buildZoteroLibraryItemVersionsUrl(request),
    );
    if (response.outcome === "not_modified") return response;
    this.requireLibraryVersion(response.meta);
    return {
      outcome: "data",
      data: parseVersionManifest(response.body, response.meta.providerStatus),
      meta: response.meta,
    };
  }

  async listLibraryCollectionVersions(
    request: ZoteroLibraryVersionRequest,
  ): Promise<ZoteroConditionalResponse<ZoteroVersionManifest>> {
    const response = await this.getConditionalJson(
      request,
      buildZoteroLibraryCollectionVersionsUrl(request),
    );
    if (response.outcome === "not_modified") return response;
    this.requireLibraryVersion(response.meta);
    return {
      outcome: "data",
      data: parseVersionManifest(response.body, response.meta.providerStatus),
      meta: response.meta,
    };
  }

  async getLibraryItemsByKeys(
    request: ZoteroItemBatchRequest,
  ): Promise<ZoteroResponse<ZoteroItem[]>> {
    const requestedKeys = normalizeZoteroItemKeys(request.itemKeys);
    const response = await this.getJson(
      request.organizationId,
      request.connectionId,
      buildZoteroLibraryItemBatchUrl(request),
    );
    this.requireLibraryVersion(response.meta);
    const items = parseItemPage(response.body, response.meta.providerStatus);
    const requested = new Set(requestedKeys);
    if (items.length > requested.size || items.some((item) => !requested.has(item.key))) {
      throw invalidZoteroResponse(
        "Zotero returned an item outside the requested key batch.",
        response.meta.providerStatus,
        response.meta,
      );
    }
    return {
      outcome: "data",
      data: items,
      meta: response.meta,
    };
  }

  async getLibraryCollectionsByKeys(
    request: ZoteroCollectionBatchRequest,
  ): Promise<ZoteroResponse<ZoteroCollection[]>> {
    const requestedKeys = normalizeZoteroCollectionKeys(request.collectionKeys);
    const response = await this.getJson(
      request.organizationId,
      request.connectionId,
      buildZoteroLibraryCollectionBatchUrl(request),
    );
    this.requireLibraryVersion(response.meta);
    const collections = parseCollectionPage(
      response.body,
      response.meta.providerStatus,
    );
    const requested = new Set(requestedKeys);
    if (
      collections.length > requested.size ||
      collections.some((collection) => !requested.has(collection.key))
    ) {
      throw invalidZoteroResponse(
        "Zotero returned a collection outside the requested key batch.",
        response.meta.providerStatus,
        response.meta,
      );
    }
    return {
      outcome: "data",
      data: collections,
      meta: response.meta,
    };
  }

  async getLibraryDeletions(
    request: ZoteroLibraryVersionRequest,
  ): Promise<ZoteroConditionalResponse<ZoteroDeletedObjects>> {
    const response = await this.getConditionalJson(
      request,
      buildZoteroLibraryDeletedUrl(request),
    );
    if (response.outcome === "not_modified") return response;
    this.requireLibraryVersion(response.meta);
    return {
      outcome: "data",
      data: parseDeletedObjects(response.body, response.meta.providerStatus),
      meta: response.meta,
    };
  }

  private requireLibraryVersion(meta: ZoteroResponseMeta): void {
    if (meta.libraryVersion === undefined) {
      throw invalidZoteroResponse(
        "Zotero omitted Last-Modified-Version from a library response.",
        meta.providerStatus,
        meta,
      );
    }
  }

  private async getConditionalJson(
    request: ZoteroLibraryVersionRequest,
    url: URL,
  ): Promise<
    | { outcome: "data"; body: unknown; meta: ZoteroResponseMeta }
    | { outcome: "not_modified"; data: null; meta: ZoteroResponseMeta & { providerStatus: 304 } }
  > {
    return this.requestJson(
      request.organizationId,
      request.connectionId,
      url,
      request.ifModifiedSinceVersion,
    );
  }

  private async getJson(
    organizationId: string,
    connectionId: string,
    url: URL,
  ): Promise<{ body: unknown; meta: ZoteroResponseMeta }> {
    const response = await this.requestJson(organizationId, connectionId, url);
    if (response.outcome === "not_modified") {
      throw invalidZoteroResponse(
        "Zotero returned 304 for an unconditional request.",
        response.meta.providerStatus,
        response.meta,
      );
    }
    return { body: response.body, meta: response.meta };
  }

  private async requestJson(
    organizationId: string,
    connectionId: string,
    url: URL,
    ifModifiedSinceVersion?: ZoteroLibraryVersionRequest["ifModifiedSinceVersion"],
  ): Promise<
    | { outcome: "data"; body: unknown; meta: ZoteroResponseMeta }
    | { outcome: "not_modified"; data: null; meta: ZoteroResponseMeta & { providerStatus: 304 } }
  > {
    const lookup = normalizedConnectionLookup(organizationId, connectionId);
    let credential;
    try {
      credential = await this.credentialResolver(lookup);
    } catch (cause) {
      throw new ZoteroAdapterError("The Zotero credential store is unavailable.", {
        code: "zotero_credential_unavailable",
        status: 503,
        retryable: true,
        cause,
      });
    }

    if (!credential) {
      throw new ZoteroAdapterError("No Zotero credential is available for this connection.", {
        code: "zotero_credential_unavailable",
        status: 503,
        retryable: false,
      });
    }

    const headers = buildZoteroRequestHeaders(credential.accessToken, {
      ifModifiedSinceVersion,
    });
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    let responseMeta: ZoteroResponseMeta | undefined;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (response.redirected) {
        throw new Error("unexpected-redirect");
      }
      if (response.url) {
        const finalUrl = assertZoteroApiUrl(response.url);
        if (finalUrl.toString() !== url.toString()) {
          throw new Error("unexpected-response-url");
        }
      }
    } catch (cause) {
      clearTimeout(timeout);
      throw new ZoteroAdapterError(
        timedOut
          ? "The Zotero request exceeded the server timeout."
          : "PaperPilot could not reach the Zotero API.",
        {
          code: timedOut ? "zotero_timeout" : "zotero_unavailable",
          status: timedOut ? 504 : 502,
          retryable: true,
          cause,
        },
      );
    }
    try {
      const responseTime = this.now();
      let parsedHeaders: Omit<ZoteroResponseMeta, "retrievedAt">;
      try {
        parsedHeaders = parseZoteroResponseHeaders(
          response.headers,
          responseTime,
          response.status,
        );
      } catch (error) {
        if (error instanceof ZoteroAdapterError) {
          throw new ZoteroAdapterError(error.message, {
            code: error.code,
            status: error.status,
            retryable: error.retryable,
            providerStatus: response.status,
            backoffSeconds: error.backoffSeconds,
            retryAfterSeconds: error.retryAfterSeconds,
            retryAt: error.retryAt,
            cause: error,
          });
        }
        throw error;
      }

      const meta: ZoteroResponseMeta = {
        ...parsedHeaders,
        retrievedAt: responseTime.toISOString(),
      };
      responseMeta = meta;

      if (response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        if (ifModifiedSinceVersion === undefined) {
          throw invalidZoteroResponse(
            "Zotero returned 304 for a request without a version precondition.",
            response.status,
            meta,
          );
        }
        return {
          outcome: "not_modified",
          data: null,
          meta: { ...meta, providerStatus: 304 },
        };
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw this.normalizeHttpError(response, meta);
      }

      const bytes = await readBoundedBody(response, this.maxResponseBytes);
      let serialized: string;
      try {
        serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("invalid-utf8");
      }
      let body: unknown;
      try {
        body = JSON.parse(serialized) as unknown;
      } catch {
        throw new Error("invalid-json");
      }
      return { outcome: "data", body, meta };
    } catch (cause) {
      if (cause instanceof ZoteroAdapterError) throw cause;
      const responseTooLarge = cause instanceof Error
        && cause.message === "response-too-large";
      throw new ZoteroAdapterError(timedOut
        ? "The Zotero request exceeded the server timeout."
        : responseTooLarge
          ? "Zotero returned more data than this synchronization pass can admit."
        : "Zotero returned an invalid or oversized JSON response.", {
        code: timedOut
          ? "zotero_timeout"
          : responseTooLarge
            ? "zotero_response_too_large"
            : "zotero_bad_response",
        status: timedOut ? 504 : responseTooLarge ? 413 : 502,
        retryable: !responseTooLarge,
        providerStatus: response.status,
        backoffSeconds: responseMeta?.backoffSeconds,
        retryAfterSeconds: responseMeta?.retryAfterSeconds,
        retryAt: responseMeta?.retryAt,
        cause,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeHttpError(
    response: Response,
    meta: ZoteroResponseMeta,
  ): ZoteroAdapterError {
    const shared = {
      providerStatus: response.status,
      backoffSeconds: meta.backoffSeconds,
      retryAfterSeconds: meta.retryAfterSeconds ?? meta.backoffSeconds,
      retryAt:
        meta.retryAt ??
        (meta.backoffSeconds === undefined
          ? undefined
          : new Date(this.now().getTime() + meta.backoffSeconds * 1_000).toISOString()),
    };

    switch (response.status) {
      case 400:
        return new ZoteroAdapterError("Zotero rejected the read request.", {
          code: "zotero_invalid_request",
          status: 400,
          retryable: false,
          ...shared,
        });
      case 401:
        return new ZoteroAdapterError("The Zotero connection is no longer authorized.", {
          code: "zotero_authentication_failed",
          status: 401,
          retryable: false,
          ...shared,
        });
      case 403:
        return new ZoteroAdapterError("The Zotero key cannot read this library.", {
          code: "zotero_forbidden",
          status: 403,
          retryable: false,
          ...shared,
        });
      case 404:
        return new ZoteroAdapterError("The requested Zotero resource was not found.", {
          code: "zotero_not_found",
          status: 404,
          retryable: false,
          ...shared,
        });
      case 429:
        return new ZoteroAdapterError("Zotero is rate limiting this connection.", {
          code: "zotero_rate_limited",
          status: 429,
          retryable: true,
          ...shared,
        });
      default:
        return new ZoteroAdapterError("Zotero is temporarily unavailable.", {
          code: "zotero_unavailable",
          status: response.status >= 500 ? 503 : 502,
          retryable: response.status >= 500,
          ...shared,
        });
    }
  }
}
