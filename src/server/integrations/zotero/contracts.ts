export const ZOTERO_API_VERSION = "3" as const;
export const ZOTERO_MAX_PAGE_SIZE = 100;
export const ZOTERO_MAX_KEY_BATCH_SIZE = 50;

declare const zoteroVersionBrand: unique symbol;

/**
 * Zotero library versions are monotonic decimal values, but are intentionally
 * represented as strings so a future provider value cannot lose precision in
 * JavaScript before it is persisted as a synchronization cursor.
 */
export type ZoteroVersion = string & { readonly [zoteroVersionBrand]: true };

export type ZoteroLibraryKind = "user" | "group";

export interface ZoteroLibraryRef {
  kind: ZoteroLibraryKind;
  /** The numeric Zotero userID or group ID, represented without coercion. */
  id: string;
}

export interface ZoteroCredentialLookup {
  /** Authorized workspace ID, derived from the server session/membership. */
  organizationId: string;
  /** Opaque PaperPilot connection identifier. It is never sent to Zotero. */
  connectionId: string;
}

export interface ZoteroResolvedCredential {
  /**
   * A Zotero OAuth 1.0a access token (also called an API key by Zotero).
   * Resolvers must return it only at request time; callers must not serialize it.
   */
  accessToken: string;
}

/** Injected secret-store boundary. The adapter never owns credential persistence. */
export type ZoteroCredentialResolver = (
  lookup: ZoteroCredentialLookup,
) => Promise<ZoteroResolvedCredential | null>;

export interface ZoteroPermissionSet {
  library?: boolean;
  files?: boolean;
  notes?: boolean;
  write?: boolean;
}

export interface ZoteroIdentityAccess {
  user?: ZoteroPermissionSet;
  groups?: {
    all?: ZoteroPermissionSet;
    [groupId: string]: ZoteroPermissionSet | undefined;
  };
}

/** Sanitized /keys/current data. The provider's `key` field is never returned. */
export interface ZoteroIdentity {
  userId: string;
  username?: string;
  displayName?: string;
  access: ZoteroIdentityAccess;
}

export interface ZoteroResponseMeta {
  retrievedAt: string;
  providerStatus: number;
  libraryVersion?: ZoteroVersion;
  totalResults?: number;
  /** Provider-wide pause requested by Zotero's Backoff header. */
  backoffSeconds?: number;
  /** Request-specific delay requested by Retry-After. */
  retryAfterSeconds?: number;
  retryAt?: string;
  /** Present only after strict validation against https://api.zotero.org. */
  nextPageUrl?: string;
}

export interface ZoteroResponse<T> {
  outcome: "data";
  data: T;
  meta: ZoteroResponseMeta;
}

/** A conditional Zotero GET can return 304 without a representation body. */
export interface ZoteroNotModifiedResponse {
  outcome: "not_modified";
  data: null;
  meta: ZoteroResponseMeta & { providerStatus: 304 };
}

export type ZoteroConditionalResponse<T> =
  | ZoteroResponse<T>
  | ZoteroNotModifiedResponse;

export type ZoteroGroupType = "PublicOpen" | "PublicClosed" | "Private";
export type ZoteroGroupLibraryReading = "all" | "members";
export type ZoteroGroupEditing = "members" | "admins";
export type ZoteroGroupFileEditing = ZoteroGroupEditing | "none";

/** Provider group metadata returned by /users/{userID}/groups. */
export interface ZoteroGroup {
  id: string;
  version: ZoteroVersion;
  name: string;
  type: ZoteroGroupType;
  libraryReading: ZoteroGroupLibraryReading;
  libraryEditing: ZoteroGroupEditing;
  fileEditing: ZoteroGroupFileEditing;
  data: Readonly<Record<string, unknown>>;
  links?: Readonly<Record<string, unknown>>;
  meta?: Readonly<Record<string, unknown>>;
}

export interface ZoteroItem {
  key: string;
  version: ZoteroVersion;
  data: Readonly<Record<string, unknown>>;
  library?: Readonly<Record<string, unknown>>;
  links?: Readonly<Record<string, unknown>>;
  meta?: Readonly<Record<string, unknown>>;
}

export interface ZoteroCollection {
  key: string;
  version: ZoteroVersion;
  data: Readonly<Record<string, unknown>>;
  library?: Readonly<Record<string, unknown>>;
  links?: Readonly<Record<string, unknown>>;
  meta?: Readonly<Record<string, unknown>>;
}

/** Object-key to object-version map returned by format=versions. */
export type ZoteroVersionManifest = Readonly<Record<string, ZoteroVersion>>;

export interface ZoteroDeletedObjects {
  collections: readonly string[];
  items: readonly string[];
  searches: readonly string[];
  tags: readonly string[];
}

export interface ZoteroConnectionRequest {
  /** Server-authorized workspace context; never copy this from public JSON. */
  organizationId: string;
  connectionId: string;
}

export interface ZoteroListItemsRequest extends ZoteroConnectionRequest {
  library: ZoteroLibraryRef;
  sinceVersion?: ZoteroVersion;
  start?: number;
  limit?: number;
  /** Zotero item keys. A single provider request accepts at most 50. */
  itemKeys?: readonly string[];
}

export interface ZoteroListUserGroupsRequest extends ZoteroConnectionRequest {
  /** Numeric Zotero userID returned by OAuth and /keys/current. */
  userId: string;
  start?: number;
  limit?: number;
}

export interface ZoteroLibraryVersionRequest extends ZoteroConnectionRequest {
  library: ZoteroLibraryRef;
  /** Last durably committed library version, or 0 for the initial pass. */
  sinceVersion: ZoteroVersion;
  /** Enables a bodyless 304 response for an unchanged library. */
  ifModifiedSinceVersion?: ZoteroVersion;
}

export interface ZoteroItemBatchRequest extends ZoteroConnectionRequest {
  library: ZoteroLibraryRef;
  /** One to fifty Zotero item keys. */
  itemKeys: readonly string[];
}

export interface ZoteroCollectionBatchRequest extends ZoteroConnectionRequest {
  library: ZoteroLibraryRef;
  /** One to fifty Zotero collection keys. */
  collectionKeys: readonly string[];
}

export interface ZoteroReadOnlyClient {
  getCurrentIdentity(
    request: ZoteroConnectionRequest,
  ): Promise<ZoteroResponse<ZoteroIdentity>>;
  listLibraryItems(
    request: ZoteroListItemsRequest,
  ): Promise<ZoteroResponse<ZoteroItem[]>>;
  listUserGroups(
    request: ZoteroListUserGroupsRequest,
  ): Promise<ZoteroResponse<ZoteroGroup[]>>;
  listLibraryItemVersions(
    request: ZoteroLibraryVersionRequest,
  ): Promise<ZoteroConditionalResponse<ZoteroVersionManifest>>;
  listLibraryCollectionVersions(
    request: ZoteroLibraryVersionRequest,
  ): Promise<ZoteroConditionalResponse<ZoteroVersionManifest>>;
  getLibraryItemsByKeys(
    request: ZoteroItemBatchRequest,
  ): Promise<ZoteroResponse<ZoteroItem[]>>;
  getLibraryCollectionsByKeys(
    request: ZoteroCollectionBatchRequest,
  ): Promise<ZoteroResponse<ZoteroCollection[]>>;
  getLibraryDeletions(
    request: ZoteroLibraryVersionRequest,
  ): Promise<ZoteroConditionalResponse<ZoteroDeletedObjects>>;
}
