import "server-only";

import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type {
  ZoteroConnectionRequest,
  ZoteroCredentialLookup,
  ZoteroCredentialResolver,
  ZoteroLibraryRef,
} from "./contracts";
import { ZoteroAdapterError, invalidZoteroRequest } from "./errors";
import {
  ZOTERO_API_ORIGIN,
  buildZoteroRequestHeaders,
  normalizeZoteroItemKey,
  normalizeZoteroLibraryId,
} from "./protocol";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_HEADER_BYTES = 32 * 1_024;
const MAX_HEADER_BYTES = 128 * 1_024;
const MAX_HEADER_COUNT = 128;
const MAX_LOCATION_BYTES = 8 * 1_024;
const MAX_CONNECTION_ID_LENGTH = 200;
const MAX_ORGANIZATION_ID_LENGTH = 200;
const MD5_PATTERN = /^[a-f0-9]{32}$/i;
const CANONICAL_UNSIGNED_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const S3_BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/;
const S3_PATH_STYLE_HOST_PATTERNS = [
  /^s3\.amazonaws\.com$/,
  /^s3[.-][a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/,
  /^s3\.dualstack\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/,
] as const;
const PRIVATE_DNS_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "corp",
  "private",
  "in-addr.arpa",
  "ip6.arpa",
] as const;
const DNS_HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type ZoteroAttachmentBlobAllowlistEntry =
  | {
      /** Allow a signed file URL only when its complete origin is this origin. */
      kind: "exact-origin";
      origin: string;
    }
  | {
      /**
       * Support Zotero's legacy `s3.amazonaws.com/<bucket>/...` object URLs
       * without allowing another bucket on the shared S3 origin.
       */
      kind: "s3-path-style";
      origin: string;
      bucket: string;
    };

export interface ZoteroAttachmentBinaryAdapterOptions {
  credentialResolver: ZoteroCredentialResolver;
  /** Trusted deployment configuration, never provider-supplied input. */
  blobAllowlist: readonly ZoteroAttachmentBlobAllowlistEntry[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Covers both HTTP hops and complete consumption of the returned stream. */
  timeoutMs?: number;
  /** Application-level cap for the response headers exposed by Fetch. */
  maxHeaderBytes?: number;
}

export interface ZoteroAttachmentBinaryRequest extends ZoteroConnectionRequest {
  library: ZoteroLibraryRef;
  itemKey: string;
  /** Per-command admission limit. The body is also counted while streaming. */
  maximumBytes: number;
  /** Lets a lease-owning worker stop an in-flight provider request. */
  signal?: AbortSignal;
}

export interface ZoteroAttachmentFileHeaders {
  md5: string;
  sizeBytes: number;
  compressed: boolean;
  /** Canonical decimal milliseconds, retained as a string to avoid coercion. */
  modificationTimeMilliseconds: string;
}

export interface ZoteroAttachmentDownloadMeta {
  retrievedAt: string;
  apiStatus: 302;
  blobStatus: 200;
  backoffSeconds?: number;
  retryAfterSeconds?: number;
  retryAt?: string;
}

export interface ZoteroAttachmentBinaryDownload {
  /** A deadline-bound, byte-counted stream. Consumers must read or cancel it. */
  body: ReadableStream<Uint8Array>;
  file: ZoteroAttachmentFileHeaders;
  contentLength: number;
  contentType: "application/pdf";
  /** A normalized MD5 only when the blob response supplied a strong ETag. */
  etagMd5?: string;
  /**
   * Settles only after the stream is completely consumed and its computed MD5
   * agrees with the Zotero-File-MD5 header. MD5 is provider-version evidence,
   * not PaperPilot's custody digest; the intake pipeline still computes SHA-256.
   */
  integrity: Promise<ZoteroAttachmentBodyIntegrity>;
  meta: ZoteroAttachmentDownloadMeta;
}

export interface ZoteroAttachmentBodyIntegrity {
  md5: string;
  sizeBytes: number;
}

interface ExactOriginRule {
  kind: "exact-origin";
  origin: string;
}

interface S3PathStyleRule {
  kind: "s3-path-style";
  origin: string;
  buckets: ReadonlySet<string>;
}

type NormalizedAllowlistRule = ExactOriginRule | S3PathStyleRule;

interface RequestLifecycle {
  controller: AbortController;
  timedOut: () => boolean;
  externallyAborted: () => boolean;
  dispose: () => void;
  setStreamAbort: (abort: (() => void) | undefined) => void;
}

function genericBadResponse(
  message: string,
  providerStatus?: number,
  throttles: Partial<ZoteroAttachmentDownloadMeta> = {},
): ZoteroAdapterError {
  return new ZoteroAdapterError(message, {
    code: "zotero_bad_response",
    status: 502,
    retryable: true,
    providerStatus,
    backoffSeconds: throttles.backoffSeconds,
    retryAfterSeconds: throttles.retryAfterSeconds,
    retryAt: throttles.retryAt,
  });
}

function resourceLimitError(providerStatus?: number): ZoteroAdapterError {
  return new ZoteroAdapterError(
    "The Zotero attachment exceeds this import's byte limit.",
    {
      code: "zotero_response_too_large",
      status: 413,
      retryable: false,
      providerStatus,
    },
  );
}

function requestStoppedError(lifecycle: RequestLifecycle): ZoteroAdapterError {
  if (lifecycle.timedOut()) {
    return new ZoteroAdapterError(
      "The Zotero attachment request exceeded the server timeout.",
      {
        code: "zotero_timeout",
        status: 504,
        retryable: true,
      },
    );
  }
  return new ZoteroAdapterError(
    lifecycle.externallyAborted()
      ? "The Zotero attachment request was cancelled."
      : "PaperPilot could not reach Zotero attachment storage.",
    {
      code: "zotero_unavailable",
      status: 502,
      retryable: true,
    },
  );
}

function normalizeConnectionLookup(
  organizationId: string,
  connectionId: string,
): ZoteroCredentialLookup {
  const normalizedOrganizationId = organizationId.trim();
  const normalizedConnectionId = connectionId.trim();
  if (
    !normalizedOrganizationId
    || normalizedOrganizationId.length > MAX_ORGANIZATION_ID_LENGTH
    || !/^[a-zA-Z0-9._:-]+$/.test(normalizedOrganizationId)
  ) {
    throw invalidZoteroRequest("A valid authorized workspace ID is required.");
  }
  if (
    !normalizedConnectionId
    || normalizedConnectionId.length > MAX_CONNECTION_ID_LENGTH
    || /[\r\n]/.test(normalizedConnectionId)
  ) {
    throw invalidZoteroRequest("A valid Zotero connection ID is required.");
  }
  return {
    organizationId: normalizedOrganizationId,
    connectionId: normalizedConnectionId,
  };
}

function buildAttachmentFileUrl(
  library: ZoteroLibraryRef,
  itemKey: string,
): URL {
  if (library.kind !== "user" && library.kind !== "group") {
    throw invalidZoteroRequest("A Zotero library must be a user or group library.");
  }
  const id = normalizeZoteroLibraryId(library.id);
  const key = normalizeZoteroItemKey(itemKey);
  const librarySegment = library.kind === "user" ? "users" : "groups";
  return new URL(
    `/${librarySegment}/${id}/items/${key}/file`,
    ZOTERO_API_ORIGIN,
  );
}

function normalizeMaximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidZoteroRequest("A positive safe attachment byte limit is required.");
  }
  return value;
}

function utf8UpperBound(value: string): number {
  // Three bytes per UTF-16 code unit is conservative for valid surrogate pairs.
  return value.length * 3;
}

function assertBoundedHeaders(headers: Headers, maximumBytes: number): void {
  let count = 0;
  let bytes = 0;
  headers.forEach((value, name) => {
    count += 1;
    bytes += utf8UpperBound(name) + utf8UpperBound(value) + 4;
  });
  if (count > MAX_HEADER_COUNT || bytes > maximumBytes) {
    throw genericBadResponse("Zotero returned oversized attachment headers.");
  }
}

function parseCanonicalUnsignedInteger(
  value: string | null,
  headerName: string,
  required: boolean,
): number | undefined {
  if (value === null) {
    if (!required) return undefined;
    throw genericBadResponse(`Zotero omitted the ${headerName} header.`);
  }
  const normalized = value.trim();
  if (!CANONICAL_UNSIGNED_INTEGER_PATTERN.test(normalized)) {
    throw genericBadResponse(`Zotero returned an invalid ${headerName} header.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw genericBadResponse(`Zotero returned an unsafe ${headerName} header.`);
  }
  return parsed;
}

function parseCanonicalUnsignedIntegerString(
  value: string | null,
  headerName: string,
): string {
  if (value === null) {
    throw genericBadResponse(`Zotero omitted the ${headerName} header.`);
  }
  const normalized = value.trim();
  if (!CANONICAL_UNSIGNED_INTEGER_PATTERN.test(normalized)) {
    throw genericBadResponse(`Zotero returned an invalid ${headerName} header.`);
  }
  // Dates currently fit safely in a Number, but preserve the canonical string.
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw genericBadResponse(`Zotero returned an unsafe ${headerName} header.`);
  }
  return normalized;
}

function parseRetryAfter(
  value: string | null,
  now: Date,
): { retryAfterSeconds?: number; retryAt?: string } {
  if (value === null) return {};
  const normalized = value.trim();
  if (CANONICAL_UNSIGNED_INTEGER_PATTERN.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isSafeInteger(seconds)) {
      throw genericBadResponse("Zotero returned an unsafe Retry-After header.");
    }
    const retryAt = new Date(now.getTime() + seconds * 1_000);
    if (Number.isNaN(retryAt.getTime())) {
      throw genericBadResponse("Zotero returned an out-of-range Retry-After header.");
    }
    return { retryAfterSeconds: seconds, retryAt: retryAt.toISOString() };
  }
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    throw genericBadResponse("Zotero returned an invalid Retry-After header.");
  }
  const seconds = Math.max(0, Math.ceil((timestamp - now.getTime()) / 1_000));
  const retryAt = new Date(now.getTime() + seconds * 1_000);
  if (Number.isNaN(retryAt.getTime())) {
    throw genericBadResponse("Zotero returned an out-of-range Retry-After header.");
  }
  return { retryAfterSeconds: seconds, retryAt: retryAt.toISOString() };
}

function parseThrottles(
  headers: Headers,
  now: Date,
): Pick<
  ZoteroAttachmentDownloadMeta,
  "backoffSeconds" | "retryAfterSeconds" | "retryAt"
> {
  const backoffSeconds = parseCanonicalUnsignedInteger(
    headers.get("backoff"),
    "Backoff",
    false,
  );
  let backoffAt: string | undefined;
  if (backoffSeconds !== undefined) {
    const deadline = new Date(now.getTime() + backoffSeconds * 1_000);
    if (Number.isNaN(deadline.getTime())) {
      throw genericBadResponse("Zotero returned an out-of-range Backoff header.");
    }
    backoffAt = deadline.toISOString();
  }
  const retry = parseRetryAfter(headers.get("retry-after"), now);
  return {
    backoffSeconds,
    ...retry,
    retryAt: retry.retryAt ?? backoffAt,
  };
}

function parseFileHeaders(headers: Headers): ZoteroAttachmentFileHeaders {
  const rawMd5 = headers.get("zotero-file-md5");
  if (rawMd5 === null || !MD5_PATTERN.test(rawMd5.trim())) {
    throw genericBadResponse("Zotero returned an invalid Zotero-File-MD5 header.");
  }
  const sizeBytes = parseCanonicalUnsignedInteger(
    headers.get("zotero-file-size"),
    "Zotero-File-Size",
    true,
  );
  if (sizeBytes === undefined) {
    throw genericBadResponse("Zotero omitted the Zotero-File-Size header.");
  }
  const compressedValue = headers.get("zotero-file-compressed")?.trim();
  if (compressedValue !== "Yes" && compressedValue !== "No") {
    throw genericBadResponse(
      "Zotero returned an invalid Zotero-File-Compressed header.",
    );
  }
  return {
    md5: rawMd5.trim().toLowerCase(),
    sizeBytes,
    compressed: compressedValue === "Yes",
    modificationTimeMilliseconds: parseCanonicalUnsignedIntegerString(
      headers.get("zotero-file-modification-time"),
      "Zotero-File-Modification-Time",
    ),
  };
}

/** Parse a strong, quoted MD5 ETag. Weak or non-MD5 validators fail closed. */
export function parseStrongZoteroAttachmentEtag(
  value: string | null,
): string | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  const match = normalized.match(/^"([a-f0-9]{32})"$/i);
  if (!match?.[1]) {
    throw genericBadResponse("Attachment storage returned an invalid strong ETag.");
  }
  return match[1].toLowerCase();
}

function parseContentLength(headers: Headers): number {
  const value = parseCanonicalUnsignedInteger(
    headers.get("content-length"),
    "Content-Length",
    true,
  );
  if (value === undefined) {
    throw genericBadResponse("Attachment storage omitted Content-Length.");
  }
  return value;
}

function parseContentType(headers: Headers): string | undefined {
  const raw = headers.get("content-type");
  if (raw === null) return undefined;
  const normalized = raw.trim();
  if (
    !normalized
    || normalized.length > 255
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;.*)?$/.test(
      normalized,
    )
  ) {
    throw genericBadResponse("Attachment storage returned an invalid Content-Type.");
  }
  return normalized;
}

function canonicalOrigin(value: string): { origin: string; hostname: string } {
  if (
    value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.includes("\\")
    || !/^https:\/\/[^/?#]+\/?$/i.test(value)
  ) {
    throw new Error("A Zotero attachment blob origin is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A Zotero attachment blob origin is invalid.");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || !url.hostname
  ) {
    throw new Error(
      "A Zotero attachment blob allowlist entry must be an exact default-port HTTPS origin.",
    );
  }
  const hostname = url.hostname.toLowerCase();
  const ipCandidate = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (
    isIP(ipCandidate) !== 0
    || !DNS_HOSTNAME_PATTERN.test(hostname)
    || PRIVATE_DNS_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
  ) {
    throw new Error(
      "A Zotero attachment blob origin must use a public DNS hostname.",
    );
  }
  return { origin: url.origin, hostname };
}

function validS3Bucket(bucket: string): boolean {
  return (
    bucket.length >= 3
    && bucket.length <= 63
    && S3_BUCKET_PATTERN.test(bucket)
    && !bucket.includes("..")
    && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  );
}

function isS3PathStyleHostname(hostname: string): boolean {
  return S3_PATH_STYLE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function normalizeAllowlist(
  entries: readonly ZoteroAttachmentBlobAllowlistEntry[],
): ReadonlyMap<string, NormalizedAllowlistRule> {
  if (entries.length < 1 || entries.length > 32) {
    throw new Error("At least one bounded Zotero attachment blob origin is required.");
  }
  const exactOrigins = new Set<string>();
  const pathStyleBuckets = new Map<string, Set<string>>();
  for (const entry of entries) {
    const normalized = canonicalOrigin(entry.origin);
    if (entry.kind === "exact-origin") {
      if (isS3PathStyleHostname(normalized.hostname)) {
        throw new Error(
          "A shared S3 origin requires an explicit path-style bucket rule.",
        );
      }
      if (exactOrigins.has(normalized.origin)) {
        throw new Error("Zotero attachment blob origins must not be duplicated.");
      }
      exactOrigins.add(normalized.origin);
      continue;
    }
    if (entry.kind !== "s3-path-style") {
      throw new Error("A Zotero attachment blob allowlist entry is invalid.");
    }
    if (
      !isS3PathStyleHostname(normalized.hostname)
      || !validS3Bucket(entry.bucket)
    ) {
      throw new Error("A legacy Zotero S3 path-style rule is invalid.");
    }
    const buckets = pathStyleBuckets.get(normalized.origin) ?? new Set<string>();
    if (buckets.has(entry.bucket)) {
      throw new Error("Zotero attachment blob bucket rules must not be duplicated.");
    }
    buckets.add(entry.bucket);
    pathStyleBuckets.set(normalized.origin, buckets);
  }
  for (const origin of exactOrigins) {
    if (pathStyleBuckets.has(origin)) {
      throw new Error(
        "An exact-origin rule must not bypass a path-style bucket rule on the same origin.",
      );
    }
  }
  const rules = new Map<string, NormalizedAllowlistRule>();
  for (const origin of exactOrigins) {
    rules.set(origin, { kind: "exact-origin", origin });
  }
  for (const [origin, buckets] of pathStyleBuckets) {
    rules.set(origin, {
      kind: "s3-path-style",
      origin,
      buckets: new Set(buckets),
    });
  }
  return rules;
}

function rawPathFromAbsoluteHttpsUrl(value: string): string {
  const authorityStart = value.indexOf("//") + 2;
  const pathStart = value.indexOf("/", authorityStart);
  if (pathStart === -1) return "/";
  const queryStart = value.indexOf("?", pathStart);
  const fragmentStart = value.indexOf("#", pathStart);
  const candidates = [queryStart, fragmentStart].filter((index) => index !== -1);
  const pathEnd = candidates.length === 0 ? value.length : Math.min(...candidates);
  return value.slice(pathStart, pathEnd);
}

function assertSafeRawBlobPath(rawPath: string): void {
  if (
    rawPath === "/"
    || rawPath.includes("\\")
    || /%(?:2f|5c)/i.test(rawPath)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(rawPath)
    || /%(?![0-9a-f]{2})/i.test(rawPath)
  ) {
    throw genericBadResponse("Zotero returned an unsafe attachment location.");
  }
  const segments = rawPath.split("/");
  if (
    segments.some((segment) => /^(?:(?:\.)|(?:%2e)){1,2}$/i.test(segment))
  ) {
    throw genericBadResponse("Zotero returned an ambiguous attachment path.");
  }
}

function assertAllowedBlobLocation(
  value: string,
  allowlist: ReadonlyMap<string, NormalizedAllowlistRule>,
): URL {
  if (
    !value
    || value !== value.trim()
    || value.length > MAX_LOCATION_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.includes(",")
    || value.includes("\\")
  ) {
    throw genericBadResponse("Zotero returned an invalid attachment location.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw genericBadResponse("Zotero returned a malformed attachment location.");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.hash !== ""
  ) {
    throw genericBadResponse("Zotero returned an unsafe attachment location.");
  }
  const rule = allowlist.get(url.origin);
  if (!rule) {
    throw genericBadResponse("Zotero returned an untrusted attachment origin.");
  }
  const rawPath = rawPathFromAbsoluteHttpsUrl(value);
  if (rawPath.startsWith("//")) {
    throw genericBadResponse("Zotero returned an ambiguous attachment path.");
  }
  assertSafeRawBlobPath(rawPath);
  if (rule.kind === "s3-path-style") {
    const firstSegment = rawPath.split("/")[1];
    if (!firstSegment || !rule.buckets.has(firstSegment)) {
      throw genericBadResponse("Zotero returned an untrusted attachment bucket.");
    }
    if (rawPath.length <= firstSegment.length + 2) {
      throw genericBadResponse("Zotero returned an incomplete attachment object path.");
    }
  }
  return url;
}

function createLifecycle(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): RequestLifecycle {
  const controller = new AbortController();
  let timeoutReached = false;
  let externalAbortReached = false;
  let disposed = false;
  let streamAbort: (() => void) | undefined;
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
    streamAbort?.();
  }, timeoutMs);
  const onExternalAbort = () => {
    externalAbortReached = true;
    controller.abort();
    streamAbort?.();
  };
  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  return {
    controller,
    timedOut: () => timeoutReached,
    externallyAborted: () => externalAbortReached,
    setStreamAbort: (abort) => {
      streamAbort = abort;
      if (abort && controller.signal.aborted) abort();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      streamAbort = undefined;
    },
  };
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function assertFetchResponseIdentity(response: Response, expectedUrl: URL): void {
  if (response.redirected) {
    throw genericBadResponse("An attachment request followed an unexpected redirect.");
  }
  if (!response.url) {
    throw genericBadResponse("Attachment storage omitted the final response URL.");
  }
  let actual: URL;
  try {
    actual = new URL(response.url);
  } catch {
    throw genericBadResponse("Attachment storage returned an invalid final URL.");
  }
  if (actual.toString() !== expectedUrl.toString()) {
    throw genericBadResponse("Attachment storage changed the requested URL.");
  }
}

function normalizeApiHttpError(
  status: number,
  throttles: Pick<
    ZoteroAttachmentDownloadMeta,
    "backoffSeconds" | "retryAfterSeconds" | "retryAt"
  >,
): ZoteroAdapterError {
  const shared = {
    providerStatus: status,
    backoffSeconds: throttles.backoffSeconds,
    retryAfterSeconds: throttles.retryAfterSeconds ?? throttles.backoffSeconds,
    retryAt: throttles.retryAt,
  };
  switch (status) {
    case 400:
      return new ZoteroAdapterError("Zotero rejected the attachment request.", {
        code: "zotero_invalid_request",
        status: 400,
        retryable: false,
        ...shared,
      });
    case 401:
      return new ZoteroAdapterError(
        "The Zotero connection is no longer authorized.",
        {
          code: "zotero_authentication_failed",
          status: 401,
          retryable: false,
          ...shared,
        },
      );
    case 403:
      return new ZoteroAdapterError(
        "The Zotero key cannot read this attachment file.",
        {
          code: "zotero_forbidden",
          status: 403,
          retryable: false,
          ...shared,
        },
      );
    case 404:
      return new ZoteroAdapterError(
        "The requested Zotero attachment file was not found.",
        {
          code: "zotero_not_found",
          status: 404,
          retryable: false,
          ...shared,
        },
      );
    case 429:
      return new ZoteroAdapterError("Zotero rate-limited the attachment request.", {
        code: "zotero_rate_limited",
        status: 429,
        retryable: true,
        ...shared,
      });
    default:
      return new ZoteroAdapterError(
        "Zotero attachment storage is temporarily unavailable.",
        {
          code: "zotero_unavailable",
          status: 502,
          retryable: true,
          ...shared,
        },
      );
  }
}

function normalizeBlobHttpError(status: number): ZoteroAdapterError {
  return new ZoteroAdapterError(
    "Zotero attachment storage did not return the requested file.",
    {
      code: status === 429 ? "zotero_rate_limited" : "zotero_unavailable",
      status: status === 429 ? 429 : 502,
      retryable: true,
      providerStatus: status,
    },
  );
}

function wrapVerifiedBody(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  maximumBytes: number,
  expectedMd5: string,
  lifecycle: RequestLifecycle,
): {
  body: ReadableStream<Uint8Array>;
  integrity: Promise<ZoteroAttachmentBodyIntegrity>;
} {
  const reader = source.getReader();
  const md5 = createHash("md5");
  let received = 0;
  let finished = false;
  let integritySettled = false;
  let resolveIntegrity: (value: ZoteroAttachmentBodyIntegrity) => void = () => {};
  let rejectIntegrity: (reason: ZoteroAdapterError) => void = () => {};
  const integrity = new Promise<ZoteroAttachmentBodyIntegrity>((resolve, reject) => {
    resolveIntegrity = resolve;
    rejectIntegrity = reject;
  });
  // A caller may rely solely on stream rejection. Retain the awaitable promise
  // without creating an unhandled rejection when it is intentionally ignored.
  void integrity.catch(() => undefined);
  const settleIntegrityError = (error: ZoteroAdapterError) => {
    if (integritySettled) return;
    integritySettled = true;
    rejectIntegrity(error);
  };
  const settleIntegritySuccess = (computedMd5: string) => {
    if (integritySettled) return;
    integritySettled = true;
    resolveIntegrity({ md5: computedMd5, sizeBytes: received });
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    lifecycle.setStreamAbort(undefined);
    lifecycle.dispose();
    try {
      reader.releaseLock();
    } catch {
      // A pending read retains the lock until its rejection settles.
    }
  };
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller;
    },
    async pull(controller) {
      if (finished) return;
      try {
        const next = await reader.read();
        if (next.done) {
          if (received !== expectedBytes) {
            const error = genericBadResponse(
              "Attachment storage returned a truncated file.",
            );
            settleIntegrityError(error);
            controller.error(error);
          } else {
            const computedMd5 = md5.digest("hex");
            if (computedMd5 !== expectedMd5) {
              const error = genericBadResponse(
                "Attachment storage returned bytes with an inconsistent MD5.",
                200,
              );
              settleIntegrityError(error);
              controller.error(error);
            } else {
              settleIntegritySuccess(computedMd5);
              controller.close();
            }
          }
          finish();
          return;
        }
        if (!next.value) return;
        received += next.value.byteLength;
        if (received > maximumBytes || received > expectedBytes) {
          await reader.cancel().catch(() => undefined);
          const error = received > maximumBytes
            ? resourceLimitError(200)
            : genericBadResponse(
                "Attachment storage returned more bytes than declared.",
                200,
              );
          settleIntegrityError(error);
          controller.error(error);
          finish();
          return;
        }
        md5.update(next.value);
        controller.enqueue(next.value);
      } catch {
        if (!finished) {
          const error = requestStoppedError(lifecycle);
          settleIntegrityError(error);
          controller.error(error);
        }
        finish();
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
      settleIntegrityError(requestStoppedError(lifecycle));
      finish();
    },
  });
  lifecycle.setStreamAbort(() => {
    if (finished) return;
    void reader.cancel().catch(() => undefined);
    const error = requestStoppedError(lifecycle);
    settleIntegrityError(error);
    outputController?.error(error);
    finish();
  });
  return { body: output, integrity };
}

function assertLifecycleActive(lifecycle: RequestLifecycle): void {
  if (lifecycle.controller.signal.aborted) {
    throw requestStoppedError(lifecycle);
  }
}

/**
 * Two-hop, read-only Zotero attachment client. It authenticates only the exact
 * API endpoint and treats the signed blob location as an ephemeral secret.
 * This is PaperPilot's PDF transport boundary: compressed Zotero objects and
 * non-PDF media are rejected. A missing final ETag is tolerated only because
 * complete stream consumption computes and verifies the body MD5 against the
 * authenticated 302 metadata; callers should also await `integrity`.
 */
export class ZoteroAttachmentBinaryAdapter {
  private readonly credentialResolver: ZoteroCredentialResolver;
  private readonly allowlist: ReadonlyMap<string, NormalizedAllowlistRule>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxHeaderBytes: number;

  constructor(options: ZoteroAttachmentBinaryAdapterOptions) {
    this.credentialResolver = options.credentialResolver;
    this.allowlist = normalizeAllowlist(options.blobAllowlist);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
    if (
      !Number.isSafeInteger(this.timeoutMs)
      || this.timeoutMs < 1
      || this.timeoutMs > MAX_TIMEOUT_MS
      || !Number.isSafeInteger(this.maxHeaderBytes)
      || this.maxHeaderBytes < 128
      || this.maxHeaderBytes > MAX_HEADER_BYTES
    ) {
      throw new Error(
        "Zotero attachment timeout or header-size configuration is invalid.",
      );
    }
  }

  async downloadAttachment(
    request: ZoteroAttachmentBinaryRequest,
  ): Promise<ZoteroAttachmentBinaryDownload> {
    const lookup = normalizeConnectionLookup(
      request.organizationId,
      request.connectionId,
    );
    const maximumBytes = normalizeMaximumBytes(request.maximumBytes);
    const apiUrl = buildAttachmentFileUrl(request.library, request.itemKey);
    let credential;
    try {
      credential = await this.credentialResolver(lookup);
    } catch {
      throw new ZoteroAdapterError("The Zotero credential store is unavailable.", {
        code: "zotero_credential_unavailable",
        status: 503,
        retryable: true,
      });
    }
    if (!credential) {
      throw new ZoteroAdapterError(
        "No Zotero credential is available for this connection.",
        {
          code: "zotero_credential_unavailable",
          status: 503,
          retryable: false,
        },
      );
    }

    const lifecycle = createLifecycle(this.timeoutMs, request.signal);
    let streamOwnsLifecycle = false;
    try {
      assertLifecycleActive(lifecycle);
      const apiHeaders = buildZoteroRequestHeaders(credential.accessToken);
      apiHeaders.set("Accept", "application/octet-stream");
      apiHeaders.set("Accept-Encoding", "identity");
      let apiResponse: Response;
      try {
        apiResponse = await this.fetchImpl(apiUrl, {
          method: "GET",
          headers: apiHeaders,
          signal: lifecycle.controller.signal,
          redirect: "manual",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch {
        throw requestStoppedError(lifecycle);
      }
      try {
        assertLifecycleActive(lifecycle);
        assertFetchResponseIdentity(apiResponse, apiUrl);
        assertBoundedHeaders(apiResponse.headers, this.maxHeaderBytes);
        const responseTime = this.now();
        const throttles = parseThrottles(apiResponse.headers, responseTime);
        if (apiResponse.status !== 302) {
          throw normalizeApiHttpError(apiResponse.status, throttles);
        }
        const file = parseFileHeaders(apiResponse.headers);
        if (file.compressed) {
          throw genericBadResponse(
            "PaperPilot cannot ingest a compressed Zotero attachment as a PDF.",
            apiResponse.status,
            throttles,
          );
        }
        if (file.sizeBytes > maximumBytes) {
          throw resourceLimitError(apiResponse.status);
        }
        const rawLocation = apiResponse.headers.get("location");
        if (rawLocation === null) {
          throw genericBadResponse(
            "Zotero omitted the attachment storage location.",
            apiResponse.status,
            throttles,
          );
        }
        const blobUrl = assertAllowedBlobLocation(rawLocation, this.allowlist);
        await cancelBody(apiResponse);
        assertLifecycleActive(lifecycle);

        const blobHeaders = new Headers({
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
        });
        let blobResponse: Response;
        try {
          blobResponse = await this.fetchImpl(blobUrl, {
            method: "GET",
            headers: blobHeaders,
            signal: lifecycle.controller.signal,
            redirect: "manual",
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
        } catch {
          throw requestStoppedError(lifecycle);
        }
        try {
          assertLifecycleActive(lifecycle);
          assertFetchResponseIdentity(blobResponse, blobUrl);
          assertBoundedHeaders(blobResponse.headers, this.maxHeaderBytes);
          if (blobResponse.status !== 200) {
            throw normalizeBlobHttpError(blobResponse.status);
          }
          const contentEncoding = blobResponse.headers.get("content-encoding");
          if (
            contentEncoding !== null
            && contentEncoding.trim().toLowerCase() !== "identity"
          ) {
            throw genericBadResponse(
              "Attachment storage returned a transformed response body.",
              blobResponse.status,
            );
          }
          const contentLength = parseContentLength(blobResponse.headers);
          if (contentLength > maximumBytes) {
            throw resourceLimitError(blobResponse.status);
          }
          if (contentLength !== file.sizeBytes) {
            throw genericBadResponse(
              "Attachment storage returned an inconsistent file size.",
              blobResponse.status,
            );
          }
          const etagMd5 = parseStrongZoteroAttachmentEtag(
            blobResponse.headers.get("etag"),
          );
          if (etagMd5 !== undefined && etagMd5 !== file.md5) {
            throw genericBadResponse(
              "Attachment storage returned an inconsistent file validator.",
              blobResponse.status,
            );
          }
          const contentType = parseContentType(blobResponse.headers);
          if (contentType !== "application/pdf") {
            throw genericBadResponse(
              "Attachment storage did not return an exact PDF media type.",
              blobResponse.status,
            );
          }
          if (!blobResponse.body) {
            throw genericBadResponse(
              "Attachment storage omitted the file response body.",
              blobResponse.status,
            );
          }
          const verified = wrapVerifiedBody(
            blobResponse.body,
            contentLength,
            maximumBytes,
            file.md5,
            lifecycle,
          );
          streamOwnsLifecycle = true;
          return {
            body: verified.body,
            file,
            contentLength,
            contentType,
            etagMd5,
            integrity: verified.integrity,
            meta: {
              retrievedAt: responseTime.toISOString(),
              apiStatus: 302,
              blobStatus: 200,
              ...throttles,
            },
          };
        } catch (error) {
          await cancelBody(blobResponse);
          throw error;
        }
      } catch (error) {
        await cancelBody(apiResponse);
        throw error;
      }
    } catch (error) {
      if (error instanceof ZoteroAdapterError) throw error;
      throw genericBadResponse("Zotero returned an invalid attachment response.");
    } finally {
      if (!streamOwnsLifecycle) lifecycle.dispose();
    }
  }
}
