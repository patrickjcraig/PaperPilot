import "server-only";

import { createHash } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import { CRAWLER_RIGHTS_ATTESTATION_V1 } from "./crawler-command";
import { CrawlerOriginRateLimitError } from "./crawler-rate-limit";
import {
  MAX_WEB_SOURCE_PATH_PREFIX_BYTES,
  MAX_WEB_SOURCE_URL_BYTES,
  canonicalizePublicWebSourceUrl,
  canonicalizeWebSourcePolicyOrigin,
  canonicalizeWebSourcePolicyPathPrefix,
  requirePublicWebSourceAddresses,
  type CanonicalWebSourceUrl,
  type WebSourcePolicyBoundary,
} from "./url-policy";

export const GOVERNED_CRAWLER_USER_AGENT = "PaperPilotCrawler/1.0";
export const GOVERNED_CRAWLER_RIGHTS_GRANT =
  CRAWLER_RIGHTS_ATTESTATION_V1;
export const MAX_GOVERNED_PDF_BYTES = 100 * 1_024 * 1_024;
export const MAX_GOVERNED_REDIRECTS = 3;
export const MAX_GOVERNED_DNS_ANSWERS = 16;
export const MAX_GOVERNED_RESPONSE_HEADER_BYTES = 32 * 1_024;
export const MAX_GOVERNED_RESPONSE_HEADER_COUNT = 64;
export const MAX_GOVERNED_ROBOTS_BYTES = 256 * 1_024;
export const MAX_GOVERNED_FETCH_DEADLINE_MS = 120_000;

const MIN_GOVERNED_FETCH_DEADLINE_MS = 1_000;
const MIN_GOVERNED_PHASE_TIMEOUT_MS = 100;
const ROBOTS_USER_AGENT_TOKEN = /^[A-Za-z_-]{3,64}$/;
const ROBOTS_PATH = "/robots.txt";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RAW_DOT_SEGMENT = /(?:^|\/)(?:\.{1,2})(?:\/|$)/;

export type GovernedCrawlerFetchErrorCode =
  | "crawler_request_invalid"
  | "crawler_url_invalid"
  | "crawler_policy_denied"
  | "crawler_dns_rejected"
  | "crawler_robots_denied"
  | "crawler_redirect_rejected"
  | "crawler_bad_response"
  | "crawler_response_too_large"
  | "crawler_timeout"
  | "crawler_cancelled"
  | "crawler_unavailable";

const ERROR_MESSAGES: Readonly<Record<GovernedCrawlerFetchErrorCode, string>> = {
  crawler_request_invalid: "The governed crawler request is invalid.",
  crawler_url_invalid: "The governed crawler URL is not eligible.",
  crawler_policy_denied: "The governed crawler policy does not permit this resource.",
  crawler_dns_rejected: "The governed crawler could not admit the source network destination.",
  crawler_robots_denied: "The governed crawler is not permitted to retrieve this resource.",
  crawler_redirect_rejected: "The governed crawler rejected the response redirect.",
  crawler_bad_response: "The governed crawler received an ineligible response.",
  crawler_response_too_large: "The governed crawler response exceeds the admitted byte limit.",
  crawler_timeout: "The governed crawler request exceeded its deadline.",
  crawler_cancelled: "The governed crawler request was cancelled.",
  crawler_unavailable: "The governed crawler could not retrieve the resource.",
};

export class GovernedCrawlerFetchError extends Error {
  constructor(
    readonly code: GovernedCrawlerFetchErrorCode,
    readonly retryable: boolean,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "GovernedCrawlerFetchError";
  }
}

export interface GovernedWebSourceAddress {
  address: string;
  family: 4 | 6;
}

export interface GovernedWebSourceResolveInput {
  hostname: string;
  signal: AbortSignal;
}

/**
 * The resolver must return the complete A and AAAA result set for the name.
 * The boundary independently validates every answer and rejects partial or
 * mixed public/private sets.
 */
export type GovernedWebSourceResolver = (
  input: GovernedWebSourceResolveInput,
) => Promise<readonly GovernedWebSourceAddress[]>;

export interface GovernedPinnedHttpsRequestInput {
  /** The literal, already-admitted socket destination. Never a DNS name. */
  destinationAddress: string;
  destinationFamily: 4 | 6;
  /** Original public DNS name used for TLS certificate validation and SNI. */
  servername: string;
  /** Original authority used for HTTP routing. Port 443 is deliberately omitted. */
  hostHeader: string;
  path: string;
  method: "GET";
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export type GovernedHttpsHeader = readonly [name: string, value: string];

export interface GovernedPinnedHttpsResponse {
  statusCode: number;
  headers: readonly GovernedHttpsHeader[];
  body: ReadableStream<Uint8Array>;
  /** Immediately destroys the socket/body. It must be idempotent. */
  close: () => void;
}

/** A direct native HTTPS request seam. It must never apply ambient proxy state. */
export type GovernedPinnedHttpsRequester = (
  input: GovernedPinnedHttpsRequestInput,
) => Promise<GovernedPinnedHttpsResponse>;

export interface GovernedBeforePinnedRequestInput {
  /** Canonical lowercase public hostname, never a URL or socket address. */
  hostname: string;
  /** The fetcher's linked absolute-deadline and caller-cancellation signal. */
  signal: AbortSignal;
}

/** A fail-closed admission hook called immediately before each pinned request. */
export type GovernedBeforePinnedRequest = (
  input: GovernedBeforePinnedRequestInput,
) => Promise<void>;

export interface GovernedPdfPolicyBoundary extends WebSourcePolicyBoundary {
  /** Crawler jobs use `exact`; broader prefixes require separate trusted policy. */
  pathMatch: "exact" | "prefix";
}

export interface GovernedPdfFetchPolicy {
  /** Deployment-reviewed exact origins and path-prefix boundaries. */
  boundaries: readonly GovernedPdfPolicyBoundary[];
  /** First mode intentionally supports indefinite custody only. */
  rightsGrant: typeof GOVERNED_CRAWLER_RIGHTS_GRANT;
  maximumBytes: number;
  /** Product token only. The HTTP user agent is always `${token}/1.0`. */
  robotsUserAgent: string;
  maxRedirects: number;
  maxDnsAddresses: number;
  dnsLookupTimeoutMs: number;
  maxResponseHeaderBytes: number;
  responseHeaderTimeoutMs: number;
  responseIdleTimeoutMs: number;
  /** One absolute deadline covers DNS, robots, redirects, headers, and body. */
  absoluteDeadlineMs: number;
}

export interface GovernedPdfFetchInput {
  /** One explicit URL; discovery, templating, and query parameters are outside this port. */
  url: string;
  policy: GovernedPdfFetchPolicy;
  signal?: AbortSignal;
}

export interface GovernedPdfFetchReceipt {
  schemaVersion: 1;
  requestedUrlSha256: string;
  finalUrlSha256: string;
  redirectChainSha256: string;
  redirectCount: number;
  robotsCheckCount: number;
  pinnedConnectionCount: number;
  retrievedAt: string;
  contentType: "application/pdf";
  contentEncoding: "identity";
  contentLength: number;
  userAgent: string;
}

export interface GovernedPdfFetchResult {
  /** Deadline-bound and byte-counted. Consumers must completely read or cancel it. */
  body: ReadableStream<Uint8Array>;
  /** Pass directly as `expectedSizeBytes` to quarantine custody. */
  expectedSizeBytes: bigint;
  receipt: GovernedPdfFetchReceipt;
}

export interface GovernedPdfFetcherDependencies {
  resolver?: GovernedWebSourceResolver;
  requester?: GovernedPinnedHttpsRequester;
  beforePinnedRequest?: GovernedBeforePinnedRequest;
  now?: () => Date;
}

interface NormalizedPolicy {
  boundaries: readonly GovernedPdfPolicyBoundary[];
  origins: ReadonlySet<string>;
  maximumBytes: number;
  robotsUserAgent: string;
  requestUserAgent: string;
  maxRedirects: number;
  maxDnsAddresses: number;
  dnsLookupTimeoutMs: number;
  maxResponseHeaderBytes: number;
  responseHeaderTimeoutMs: number;
  responseIdleTimeoutMs: number;
  absoluteDeadlineMs: number;
}

type StopKind = "timeout" | "cancelled";

interface RequestLifecycle {
  signal: AbortSignal;
  stopped: () => StopKind | undefined;
  timeout: () => void;
  dispose: () => void;
}

interface HeaderBag {
  values: ReadonlyMap<string, readonly string[]>;
}

interface FetchAccounting {
  robotsChecks: number;
  connections: number;
}

interface AdmittedResponse {
  response: GovernedPinnedHttpsResponse;
  headers: HeaderBag;
}

function error(
  code: GovernedCrawlerFetchErrorCode,
  retryable = false,
): GovernedCrawlerFetchError {
  return new GovernedCrawlerFetchError(code, retryable);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redirectChainSha256(urls: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("paperpilot:governed-crawler:redirect-chain:v1\0", "utf8");
  for (const value of urls) {
    const encoded = Buffer.from(value, "utf8");
    hash.update(String(encoded.byteLength), "ascii");
    hash.update("\0", "ascii");
    hash.update(encoded);
  }
  return hash.digest("hex");
}

function rawPath(value: string): string {
  const scheme = value.indexOf("://");
  if (scheme < 0) return "";
  const pathStart = value.indexOf("/", scheme + 3);
  if (pathStart < 0) return "/";
  const query = value.indexOf("?", pathStart);
  const fragment = value.indexOf("#", pathStart);
  const endCandidates = [query, fragment].filter((index) => index >= 0);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : value.length;
  return value.slice(pathStart, end);
}

function rawAuthorityContainsCredentials(value: string): boolean {
  const scheme = value.indexOf("://");
  if (scheme < 0) return false;
  const authorityStart = scheme + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const queryStart = value.indexOf("?", authorityStart);
  const fragmentStart = value.indexOf("#", authorityStart);
  const candidates = [pathStart, queryStart, fragmentStart].filter((index) => index >= 0);
  const authorityEnd = candidates.length > 0 ? Math.min(...candidates) : value.length;
  return value.slice(authorityStart, authorityEnd).includes("@");
}

function canonicalFirstModeUrl(value: unknown): CanonicalWebSourceUrl {
  if (
    typeof value !== "string"
    || value.includes("?")
    || value.includes("#")
    || rawAuthorityContainsCredentials(value)
    || RAW_DOT_SEGMENT.test(rawPath(value))
  ) {
    throw error("crawler_url_invalid");
  }
  let canonical: CanonicalWebSourceUrl;
  try {
    canonical = canonicalizePublicWebSourceUrl(value);
  } catch {
    throw error("crawler_url_invalid");
  }
  const parsed = new URL(canonical.url);
  if (
    parsed.port !== ""
    || parsed.search !== ""
    || utf8Bytes(parsed.pathname) > MAX_WEB_SOURCE_PATH_PREFIX_BYTES
    || parsed.pathname.includes("//")
  ) {
    throw error("crawler_url_invalid");
  }
  return canonical;
}

function normalizePolicy(policy: GovernedPdfFetchPolicy): NormalizedPolicy {
  if (
    !policy
    || typeof policy !== "object"
    || policy.rightsGrant !== GOVERNED_CRAWLER_RIGHTS_GRANT
    || !Array.isArray(policy.boundaries)
    || policy.boundaries.length < 1
    || policy.boundaries.length > 32
    || !Number.isSafeInteger(policy.maximumBytes)
    || policy.maximumBytes < 1
    || policy.maximumBytes > MAX_GOVERNED_PDF_BYTES
    || typeof policy.robotsUserAgent !== "string"
    || !ROBOTS_USER_AGENT_TOKEN.test(policy.robotsUserAgent)
    || !Number.isSafeInteger(policy.maxRedirects)
    || policy.maxRedirects < 0
    || policy.maxRedirects > MAX_GOVERNED_REDIRECTS
    || !Number.isSafeInteger(policy.maxDnsAddresses)
    || policy.maxDnsAddresses < 1
    || policy.maxDnsAddresses > MAX_GOVERNED_DNS_ANSWERS
    || !Number.isSafeInteger(policy.dnsLookupTimeoutMs)
    || policy.dnsLookupTimeoutMs < MIN_GOVERNED_PHASE_TIMEOUT_MS
    || policy.dnsLookupTimeoutMs >= policy.absoluteDeadlineMs
    || !Number.isSafeInteger(policy.maxResponseHeaderBytes)
    || policy.maxResponseHeaderBytes < 1_024
    || policy.maxResponseHeaderBytes > 64 * 1_024
    || !Number.isSafeInteger(policy.responseHeaderTimeoutMs)
    || policy.responseHeaderTimeoutMs < MIN_GOVERNED_PHASE_TIMEOUT_MS
    || policy.responseHeaderTimeoutMs >= policy.absoluteDeadlineMs
    || !Number.isSafeInteger(policy.responseIdleTimeoutMs)
    || policy.responseIdleTimeoutMs < MIN_GOVERNED_PHASE_TIMEOUT_MS
    || policy.responseIdleTimeoutMs >= policy.absoluteDeadlineMs
    || !Number.isSafeInteger(policy.absoluteDeadlineMs)
    || policy.absoluteDeadlineMs < MIN_GOVERNED_FETCH_DEADLINE_MS
    || policy.absoluteDeadlineMs > MAX_GOVERNED_FETCH_DEADLINE_MS
  ) throw error("crawler_request_invalid");

  const boundaries: GovernedPdfPolicyBoundary[] = [];
  const origins = new Set<string>();
  const identities = new Set<string>();
  try {
    for (const boundary of policy.boundaries) {
      if (
        !boundary
        || typeof boundary !== "object"
        || typeof boundary.origin !== "string"
        || (boundary.pathMatch !== "exact" && boundary.pathMatch !== "prefix")
        || boundary.origin.includes("?")
        || boundary.origin.includes("#")
        || rawAuthorityContainsCredentials(boundary.origin)
      ) throw new Error("invalid boundary origin");
      const origin = canonicalizeWebSourcePolicyOrigin(boundary.origin);
      if (new URL(origin).port !== "") throw new Error("non-default port");
      const pathPrefix = canonicalizeWebSourcePolicyPathPrefix(boundary.pathPrefix);
      const identity = `${origin}\0${pathPrefix}\0${boundary.pathMatch}`;
      if (identities.has(identity)) throw new Error("duplicate boundary");
      identities.add(identity);
      origins.add(origin);
      boundaries.push({ origin, pathPrefix, pathMatch: boundary.pathMatch });
    }
  } catch {
    throw error("crawler_request_invalid");
  }
  return {
    boundaries,
    origins,
    maximumBytes: policy.maximumBytes,
    robotsUserAgent: policy.robotsUserAgent,
    requestUserAgent: `${policy.robotsUserAgent}/1.0`,
    maxRedirects: policy.maxRedirects,
    maxDnsAddresses: policy.maxDnsAddresses,
    dnsLookupTimeoutMs: policy.dnsLookupTimeoutMs,
    maxResponseHeaderBytes: policy.maxResponseHeaderBytes,
    responseHeaderTimeoutMs: policy.responseHeaderTimeoutMs,
    responseIdleTimeoutMs: policy.responseIdleTimeoutMs,
    absoluteDeadlineMs: policy.absoluteDeadlineMs,
  };
}

function pathMatches(candidate: CanonicalWebSourceUrl, policy: NormalizedPolicy): boolean {
  return policy.boundaries.some((boundary) => {
    if (candidate.origin !== boundary.origin) return false;
    if (boundary.pathMatch === "exact") return candidate.pathname === boundary.pathPrefix;
    if (boundary.pathPrefix === "/") return true;
    return candidate.pathname === boundary.pathPrefix
      || candidate.pathname.startsWith(`${boundary.pathPrefix}/`);
  });
}

function requirePdfPolicy(candidate: CanonicalWebSourceUrl, policy: NormalizedPolicy): void {
  if (!pathMatches(candidate, policy)) throw error("crawler_policy_denied");
}

function createLifecycle(
  externalSignal: AbortSignal | undefined,
  deadlineMs: number,
): RequestLifecycle {
  const controller = new AbortController();
  let stopKind: StopKind | undefined;
  let disposed = false;
  const stop = (kind: StopKind) => {
    if (stopKind !== undefined || disposed) return;
    stopKind = kind;
    controller.abort();
  };
  const onExternalAbort = () => stop("cancelled");
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), deadlineMs);
  return {
    signal: controller.signal,
    stopped: () => stopKind,
    timeout: () => stop("timeout"),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function stoppedError(lifecycle: RequestLifecycle): GovernedCrawlerFetchError | undefined {
  const stopped = lifecycle.stopped();
  if (stopped === "timeout") return error("crawler_timeout", true);
  if (stopped === "cancelled") return error("crawler_cancelled");
  return undefined;
}

async function waitWithLifecycle<T>(
  operation: Promise<T>,
  lifecycle: RequestLifecycle,
): Promise<T> {
  const stopped = stoppedError(lifecycle);
  if (stopped) throw stopped;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(stoppedError(lifecycle) ?? error("crawler_cancelled"));
    };
    lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        lifecycle.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (caught) => {
        if (settled) return;
        settled = true;
        lifecycle.signal.removeEventListener("abort", onAbort);
        reject(stoppedError(lifecycle)
          ?? (caught instanceof CrawlerOriginRateLimitError
            ? caught
            : error("crawler_unavailable", true)));
      },
    );
  });
}

async function waitWithPhaseTimeout<T>(
  operation: Promise<T>,
  lifecycle: RequestLifecycle,
  timeoutMs: number,
): Promise<T> {
  const stopped = stoppedError(lifecycle);
  if (stopped) throw stopped;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitWithLifecycle(operation, lifecycle),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          lifecycle.timeout();
          reject(error("crawler_timeout", true));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function noDnsData(errorValue: unknown): boolean {
  if (!errorValue || typeof errorValue !== "object") return false;
  const code = (errorValue as { code?: unknown }).code;
  return code === "ENODATA" || code === "ENOTFOUND" || code === "DNS_ENODATA";
}

async function resolveFamily(
  hostname: string,
  family: 4 | 6,
): Promise<readonly GovernedWebSourceAddress[]> {
  try {
    const addresses = family === 4
      ? await resolve4(hostname)
      : await resolve6(hostname);
    return addresses.map((address) => ({ address, family }));
  } catch (caught) {
    if (noDnsData(caught)) return [];
    throw caught;
  }
}

export const resolveAllGovernedWebSourceAddresses: GovernedWebSourceResolver =
  async ({ hostname }) => {
    const [ipv4, ipv6] = await Promise.all([
      resolveFamily(hostname, 4),
      resolveFamily(hostname, 6),
    ]);
    return [...ipv4, ...ipv6];
  };

function defaultPinnedHttpsRequest(
  input: GovernedPinnedHttpsRequestInput,
): Promise<GovernedPinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpsRequest({
      protocol: "https:",
      hostname: input.destinationAddress,
      family: input.destinationFamily,
      port: 443,
      servername: input.servername,
      method: input.method,
      path: input.path,
      headers: {
        ...input.headers,
        Host: input.hostHeader,
      },
      agent: false,
      rejectUnauthorized: true,
      signal: input.signal,
    }, (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      const headers: GovernedHttpsHeader[] = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index];
        const value = response.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) headers.push([name, value]);
      }
      resolve({
        statusCode: response.statusCode ?? 0,
        headers,
        body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
        close: () => response.destroy(),
      });
    });
    request.once("error", () => {
      if (settled) return;
      settled = true;
      reject(error("crawler_unavailable", true));
    });
    request.end();
  });
}

export const requestPinnedGovernedHttps: GovernedPinnedHttpsRequester =
  defaultPinnedHttpsRequest;

function normalizeAddresses(
  records: readonly GovernedWebSourceAddress[],
  maximumAnswers: number,
): readonly GovernedWebSourceAddress[] {
  if (!Array.isArray(records) || records.length < 1 || records.length > maximumAnswers) {
    throw error("crawler_dns_rejected");
  }
  const unique = new Map<string, GovernedWebSourceAddress>();
  for (const record of records) {
    if (
      !record
      || typeof record !== "object"
      || (record.family !== 4 && record.family !== 6)
      || typeof record.address !== "string"
      || record.address.length > 64
      || isIP(record.address) !== record.family
    ) throw error("crawler_dns_rejected");
    const key = `${record.family}:${record.address}`;
    unique.set(key, { address: record.address, family: record.family });
  }
  const normalized = [...unique.values()].sort((left, right) =>
    left.family - right.family || (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
  try {
    requirePublicWebSourceAddresses(normalized.map(({ address }) => address));
  } catch {
    throw error("crawler_dns_rejected");
  }
  return normalized;
}

function parseHeaders(
  response: GovernedPinnedHttpsResponse,
  maximumHeaderBytes: number,
): HeaderBag {
  if (
    !Number.isInteger(response.statusCode)
    || response.statusCode < 100
    || response.statusCode > 599
    || !Array.isArray(response.headers)
    || response.headers.length > MAX_GOVERNED_RESPONSE_HEADER_COUNT
    || !(response.body instanceof ReadableStream)
    || response.body.locked
    || typeof response.close !== "function"
  ) throw error("crawler_bad_response", true);

  let byteCount = 0;
  const values = new Map<string, string[]>();
  for (const header of response.headers) {
    if (
      !Array.isArray(header)
      || header.length !== 2
      || typeof header[0] !== "string"
      || typeof header[1] !== "string"
      || !HEADER_NAME.test(header[0])
      || /[\u0000-\u001f\u007f]/.test(header[1])
    ) throw error("crawler_bad_response", true);
    byteCount += utf8Bytes(header[0]) + utf8Bytes(header[1]) + 4;
    if (byteCount > maximumHeaderBytes) {
      throw error("crawler_bad_response", true);
    }
    const name = header[0].toLowerCase();
    const entries = values.get(name) ?? [];
    entries.push(header[1]);
    values.set(name, entries);
  }
  return { values };
}

function singleHeader(
  headers: HeaderBag,
  name: string,
  required: boolean,
): string | undefined {
  const values = headers.values.get(name);
  if (!values || values.length === 0) {
    if (required) throw error("crawler_bad_response", true);
    return undefined;
  }
  if (values.length !== 1) throw error("crawler_bad_response", true);
  return values[0];
}

function requireIdentityEncoding(headers: HeaderBag): void {
  const encoding = singleHeader(headers, "content-encoding", false);
  if (encoding !== undefined && encoding !== "identity") {
    throw error("crawler_bad_response", true);
  }
}

function canonicalContentLength(
  headers: HeaderBag,
  required: boolean,
): number | undefined {
  const raw = singleHeader(headers, "content-length", required);
  if (raw === undefined) return undefined;
  if (!CANONICAL_UNSIGNED_INTEGER.test(raw)) throw error("crawler_bad_response", true);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw error("crawler_bad_response", true);
  return parsed;
}

function disposeUnlockedResponse(response: GovernedPinnedHttpsResponse): void {
  try {
    void response.body.cancel("PaperPilot governed crawler response discarded")
      .catch(() => undefined);
  } catch {
    // The socket close below is the authoritative cleanup path.
  }
  try {
    response.close();
  } catch {
    // Cleanup is best effort after the response has already been rejected.
  }
}

async function readFromBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  lifecycle: RequestLifecycle,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return waitWithPhaseTimeout(reader.read(), lifecycle, idleTimeoutMs);
}

async function readBoundedBody(input: {
  response: GovernedPinnedHttpsResponse;
  maximumBytes: number;
  expectedBytes?: number;
  lifecycle: RequestLifecycle;
  idleTimeoutMs: number;
  limitCode: GovernedCrawlerFetchErrorCode;
}): Promise<Uint8Array> {
  const reader = input.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readFromBody(
        reader,
        input.lifecycle,
        input.idleTimeoutMs,
      );
      if (done) break;
      if (!(value instanceof Uint8Array)) throw error("crawler_bad_response", true);
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > input.maximumBytes) throw error(input.limitCode);
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy);
    }
    if (input.expectedBytes !== undefined && total !== input.expectedBytes) {
      throw error("crawler_bad_response", true);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (caught) {
    void reader.cancel("PaperPilot governed crawler bounded read stopped").catch(() => undefined);
    throw stoppedError(input.lifecycle)
      ?? (caught instanceof GovernedCrawlerFetchError
        ? caught
        : error("crawler_unavailable", true));
  } finally {
    try {
      input.response.close();
    } catch {
      // The response has no further authority after its bounded read.
    }
  }
}

function contentLocation(
  responseUrl: CanonicalWebSourceUrl,
  headers: HeaderBag,
): CanonicalWebSourceUrl {
  let raw: string;
  try {
    raw = singleHeader(headers, "location", true) ?? "";
  } catch {
    throw error("crawler_redirect_rejected");
  }
  if (
    raw.length === 0
    || raw !== raw.trim()
    || utf8Bytes(raw) > MAX_WEB_SOURCE_URL_BYTES
    || /[\u0000-\u001f\u007f\\?#]/.test(raw)
  ) throw error("crawler_redirect_rejected");
  let resolved: string;
  try {
    resolved = new URL(raw, responseUrl.url).href;
  } catch {
    throw error("crawler_redirect_rejected");
  }
  try {
    return canonicalFirstModeUrl(resolved);
  } catch {
    throw error("crawler_redirect_rejected");
  }
}

async function admittedPinnedRequest(input: {
  candidate: CanonicalWebSourceUrl;
  accept: string;
  resolver: GovernedWebSourceResolver;
  requester: GovernedPinnedHttpsRequester;
  beforePinnedRequest?: GovernedBeforePinnedRequest;
  lifecycle: RequestLifecycle;
  accounting: FetchAccounting;
  policy: NormalizedPolicy;
}): Promise<AdmittedResponse> {
  const stoppedBeforeResolution = stoppedError(input.lifecycle);
  if (stoppedBeforeResolution) throw stoppedBeforeResolution;
  let records: readonly GovernedWebSourceAddress[];
  try {
    records = await waitWithPhaseTimeout(input.resolver({
      hostname: input.candidate.hostname,
      signal: input.lifecycle.signal,
    }), input.lifecycle, input.policy.dnsLookupTimeoutMs);
  } catch (caught) {
    const stopped = stoppedError(input.lifecycle);
    if (stopped) throw stopped;
    if (caught instanceof GovernedCrawlerFetchError && caught.code === "crawler_dns_rejected") {
      throw caught;
    }
    throw error("crawler_dns_rejected", true);
  }
  const selected = normalizeAddresses(records, input.policy.maxDnsAddresses)[0];
  if (!selected) throw error("crawler_dns_rejected");

  const stoppedBeforeRequest = stoppedError(input.lifecycle);
  if (stoppedBeforeRequest) throw stoppedBeforeRequest;
  if (input.beforePinnedRequest) {
    try {
      await waitWithLifecycle(
        input.beforePinnedRequest({
          hostname: input.candidate.hostname,
          signal: input.lifecycle.signal,
        }),
        input.lifecycle,
      );
    } catch (caught) {
      if (caught instanceof CrawlerOriginRateLimitError) throw caught;
      const stopped = stoppedError(input.lifecycle);
      if (stopped) throw stopped;
      throw error("crawler_unavailable", true);
    }
  }

  const stoppedAfterAdmission = stoppedError(input.lifecycle);
  if (stoppedAfterAdmission) throw stoppedAfterAdmission;
  let response: GovernedPinnedHttpsResponse;
  try {
    response = await waitWithPhaseTimeout(input.requester({
      destinationAddress: selected.address,
      destinationFamily: selected.family,
      servername: input.candidate.hostname,
      hostHeader: input.candidate.hostname,
      path: input.candidate.pathname,
      method: "GET",
      headers: {
        Accept: input.accept,
        "Accept-Encoding": "identity",
        "User-Agent": input.policy.requestUserAgent,
        Connection: "close",
      },
      signal: input.lifecycle.signal,
    }), input.lifecycle, input.policy.responseHeaderTimeoutMs);
    input.accounting.connections += 1;
  } catch (caught) {
    const stopped = stoppedError(input.lifecycle);
    if (stopped) throw stopped;
    if (caught instanceof GovernedCrawlerFetchError) throw caught;
    throw error("crawler_unavailable", true);
  }

  try {
    return {
      response,
      headers: parseHeaders(response, input.policy.maxResponseHeaderBytes),
    };
  } catch (caught) {
    disposeUnlockedResponse(response);
    throw caught;
  }
}

interface RobotsRule {
  allow: boolean;
  /** RFC 9309 comparison units after percent-encoding normalization. */
  tokens: readonly string[];
  terminal: boolean;
  precedence: number;
}

interface RobotsGroup {
  agents: readonly string[];
  rules: readonly RobotsRule[];
}

function isAsciiUnreservedOctet(octet: number): boolean {
  return (
    (octet >= 0x41 && octet <= 0x5a)
    || (octet >= 0x61 && octet <= 0x7a)
    || (octet >= 0x30 && octet <= 0x39)
    || octet === 0x2d
    || octet === 0x2e
    || octet === 0x5f
    || octet === 0x7e
  );
}

function percentToken(octet: number): string {
  return `%${octet.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * RFC 9309 compares URI paths as octets: encoded ASCII unreserved octets are
 * decoded, while reserved and non-ASCII octets remain canonical `%HH` units.
 * A raw `*` is a rule metacharacter only when requested by the caller.
 */
function normalizedRobotsTokens(
  value: string,
  ruleWildcards: boolean,
): readonly string[] {
  const tokens: string[] = [];
  for (let offset = 0; offset < value.length;) {
    const current = value[offset];
    if (ruleWildcards && current === "*") {
      tokens.push("*");
      offset += 1;
      continue;
    }
    const encoded = value.slice(offset, offset + 3);
    if (current === "%" && /^%[0-9A-Fa-f]{2}$/.test(encoded)) {
      const octet = Number.parseInt(encoded.slice(1), 16);
      tokens.push(isAsciiUnreservedOctet(octet)
        ? String.fromCharCode(octet)
        : percentToken(octet));
      offset += 3;
      continue;
    }
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (codePoint > 0x7f) {
      for (const octet of Buffer.from(character, "utf8")) {
        tokens.push(percentToken(octet));
      }
    } else if (current === "%") {
      // Invalid raw percent encoding represents a literal percent octet.
      tokens.push("%25");
    } else {
      tokens.push(character);
    }
    offset += character.length;
  }
  return tokens;
}

function robotsRule(patternValue: string, allow: boolean): RobotsRule | undefined {
  const pattern = patternValue.trim();
  if (
    pattern.length === 0
    || utf8Bytes(pattern) > MAX_WEB_SOURCE_PATH_PREFIX_BYTES
    || /[\u0000-\u001f\u007f]/.test(pattern)
    || !pattern.startsWith("/")
  ) return undefined;
  const terminal = pattern.endsWith("$");
  const comparisonPattern = terminal ? pattern.slice(0, -1) : pattern;
  const tokens = normalizedRobotsTokens(comparisonPattern, true);
  return {
    allow,
    tokens,
    terminal,
    precedence: tokens.filter((token) => token !== "*").length,
  };
}

function parseRobots(content: string): readonly RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  const finish = () => {
    if (agents.length > 0) groups.push({ agents: [...agents], rules: [...rules] });
    agents = [];
    rules = [];
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0]?.trim() ?? "";
    if (line.length === 0) {
      if (rules.length > 0) finish();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (rules.length > 0) finish();
      if (value.length > 0 && value.length <= 256) agents.push(value.toLowerCase());
      continue;
    }
    if ((field === "allow" || field === "disallow") && agents.length > 0) {
      const parsed = robotsRule(value, field === "allow");
      if (parsed) rules.push(parsed);
    }
  }
  finish();
  return groups;
}

function robotsPatternMatches(
  pathname: string,
  rule: RobotsRule,
): boolean {
  const pathTokens = normalizedRobotsTokens(pathname, false);
  const patternTokens = rule.tokens;
  let pathIndex = 0;
  let patternIndex = 0;
  let lastStar = -1;
  let starPathIndex = -1;
  while (pathIndex < pathTokens.length) {
    if (patternIndex === patternTokens.length) return !rule.terminal;
    if (patternTokens[patternIndex] === "*") {
      lastStar = patternIndex;
      starPathIndex = pathIndex;
      patternIndex += 1;
      continue;
    }
    if (patternTokens[patternIndex] === pathTokens[pathIndex]) {
      patternIndex += 1;
      pathIndex += 1;
      continue;
    }
    if (lastStar < 0) return false;
    patternIndex = lastStar + 1;
    starPathIndex += 1;
    pathIndex = starPathIndex;
  }
  while (patternTokens[patternIndex] === "*") patternIndex += 1;
  return patternIndex === patternTokens.length;
}

export function governedRobotsAllows(
  robotsText: string,
  pathname: string,
  robotsUserAgent = GOVERNED_CRAWLER_USER_AGENT.split("/", 1)[0]
    ?? "PaperPilotCrawler",
): boolean {
  const groups = parseRobots(robotsText);
  const crawlerNames = new Set([
    robotsUserAgent.toLowerCase(),
    `${robotsUserAgent}/1.0`.toLowerCase(),
  ]);
  const specific = groups.filter((group) =>
    group.agents.some((agent) => crawlerNames.has(agent)));
  const selected = specific.length > 0
    ? specific
    : groups.filter((group) => group.agents.includes("*"));
  const matching = selected
    .flatMap((group) => group.rules)
    .filter((rule) => robotsPatternMatches(pathname, rule));
  if (matching.length === 0) return true;
  matching.sort((left, right) =>
    right.precedence - left.precedence || Number(right.allow) - Number(left.allow));
  return matching[0]?.allow ?? true;
}

async function robotsAllows(input: {
  candidate: CanonicalWebSourceUrl;
  policy: NormalizedPolicy;
  resolver: GovernedWebSourceResolver;
  requester: GovernedPinnedHttpsRequester;
  beforePinnedRequest?: GovernedBeforePinnedRequest;
  lifecycle: RequestLifecycle;
  accounting: FetchAccounting;
}): Promise<boolean> {
  input.accounting.robotsChecks += 1;
  let robotsUrl = canonicalFirstModeUrl(`${input.candidate.origin}${ROBOTS_PATH}`);
  let redirects = 0;
  while (true) {
    if (!input.policy.origins.has(robotsUrl.origin) || robotsUrl.pathname !== ROBOTS_PATH) {
      throw error("crawler_robots_denied");
    }
    const admitted = await admittedPinnedRequest({
      candidate: robotsUrl,
      accept: "text/plain",
      resolver: input.resolver,
      requester: input.requester,
      beforePinnedRequest: input.beforePinnedRequest,
      lifecycle: input.lifecycle,
      accounting: input.accounting,
      policy: input.policy,
    });
    const { response, headers } = admitted;
    if (REDIRECT_STATUSES.has(response.statusCode)) {
      if (redirects >= input.policy.maxRedirects) {
        disposeUnlockedResponse(response);
        throw error("crawler_robots_denied");
      }
      let next: CanonicalWebSourceUrl;
      try {
        next = contentLocation(robotsUrl, headers);
      } catch {
        disposeUnlockedResponse(response);
        throw error("crawler_robots_denied");
      }
      disposeUnlockedResponse(response);
      if (!input.policy.origins.has(next.origin) || next.pathname !== ROBOTS_PATH) {
        throw error("crawler_robots_denied");
      }
      robotsUrl = next;
      redirects += 1;
      continue;
    }
    if (response.statusCode === 404 || response.statusCode === 410) {
      disposeUnlockedResponse(response);
      return true;
    }
    if (response.statusCode !== 200) {
      disposeUnlockedResponse(response);
      throw error("crawler_robots_denied", response.statusCode >= 500);
    }
    try {
      requireIdentityEncoding(headers);
      const contentLength = canonicalContentLength(headers, false);
      if (contentLength !== undefined && contentLength > MAX_GOVERNED_ROBOTS_BYTES) {
        throw error("crawler_robots_denied");
      }
      const bytes = await readBoundedBody({
        response,
        maximumBytes: MAX_GOVERNED_ROBOTS_BYTES,
        expectedBytes: contentLength,
        lifecycle: input.lifecycle,
        idleTimeoutMs: input.policy.responseIdleTimeoutMs,
        limitCode: "crawler_robots_denied",
      });
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw error("crawler_robots_denied");
      }
      return governedRobotsAllows(
        text,
        input.candidate.pathname,
        input.policy.robotsUserAgent,
      );
    } catch (caught) {
      disposeUnlockedResponse(response);
      if (caught instanceof GovernedCrawlerFetchError) {
        if (caught.code === "crawler_timeout" || caught.code === "crawler_cancelled") {
          throw caught;
        }
      }
      throw error("crawler_robots_denied");
    }
  }
}

function boundedPdfBody(input: {
  response: GovernedPinnedHttpsResponse;
  expectedBytes: number;
  maximumBytes: number;
  lifecycle: RequestLifecycle;
  idleTimeoutMs: number;
}): ReadableStream<Uint8Array> {
  const reader = input.response.body.getReader();
  let observed = 0;
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    input.lifecycle.dispose();
    try {
      input.response.close();
    } catch {
      // The body has no authority after completion, cancellation, or rejection.
    }
  };
  const stopReader = (reason: string) => {
    void reader.cancel(reason).catch(() => undefined);
    cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await readFromBody(
          reader,
          input.lifecycle,
          input.idleTimeoutMs,
        );
        if (done) {
          if (observed !== input.expectedBytes) {
            throw error("crawler_bad_response", true);
          }
          cleanup();
          controller.close();
          return;
        }
        if (!(value instanceof Uint8Array)) throw error("crawler_bad_response", true);
        if (value.byteLength === 0) return;
        observed += value.byteLength;
        if (observed > input.maximumBytes || observed > input.expectedBytes) {
          throw error("crawler_response_too_large");
        }
        const copy = new Uint8Array(value.byteLength);
        copy.set(value);
        controller.enqueue(copy);
      } catch (caught) {
        const failure = stoppedError(input.lifecycle)
          ?? (caught instanceof GovernedCrawlerFetchError
            ? caught
            : error("crawler_unavailable", true));
        stopReader("PaperPilot governed crawler PDF stream stopped");
        controller.error(failure);
      }
    },
    cancel() {
      stopReader("PaperPilot governed crawler PDF stream cancelled by its consumer");
    },
  });
}

function checkedNow(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    throw error("crawler_request_invalid");
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw error("crawler_request_invalid");
  }
  return value.toISOString();
}

export class GovernedPdfFetcher {
  private readonly resolver: GovernedWebSourceResolver;
  private readonly requester: GovernedPinnedHttpsRequester;
  private readonly beforePinnedRequest: GovernedBeforePinnedRequest | undefined;
  private readonly now: () => Date;

  constructor(dependencies: GovernedPdfFetcherDependencies = {}) {
    this.resolver = dependencies.resolver ?? resolveAllGovernedWebSourceAddresses;
    this.requester = dependencies.requester ?? requestPinnedGovernedHttps;
    this.beforePinnedRequest = dependencies.beforePinnedRequest;
    this.now = dependencies.now ?? (() => new Date());
  }

  async fetch(input: GovernedPdfFetchInput): Promise<GovernedPdfFetchResult> {
    let policy: NormalizedPolicy;
    let initial: CanonicalWebSourceUrl;
    try {
      policy = normalizePolicy(input.policy);
      initial = canonicalFirstModeUrl(input.url);
      requirePdfPolicy(initial, policy);
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
        throw error("crawler_request_invalid");
      }
    } catch (caught) {
      if (caught instanceof GovernedCrawlerFetchError) throw caught;
      throw error("crawler_request_invalid");
    }

    const lifecycle = createLifecycle(input.signal, policy.absoluteDeadlineMs);
    const accounting: FetchAccounting = { robotsChecks: 0, connections: 0 };
    const redirectChain = [initial.url];
    let candidate = initial;
    let redirects = 0;
    try {
      const alreadyStopped = stoppedError(lifecycle);
      if (alreadyStopped) throw alreadyStopped;
      while (true) {
        requirePdfPolicy(candidate, policy);
        if (!await robotsAllows({
          candidate,
          policy,
          resolver: this.resolver,
          requester: this.requester,
          beforePinnedRequest: this.beforePinnedRequest,
          lifecycle,
          accounting,
        })) throw error("crawler_robots_denied");

        const admitted = await admittedPinnedRequest({
          candidate,
          accept: "application/pdf",
          resolver: this.resolver,
          requester: this.requester,
          beforePinnedRequest: this.beforePinnedRequest,
          lifecycle,
          accounting,
          policy,
        });
        const { response, headers } = admitted;
        if (REDIRECT_STATUSES.has(response.statusCode)) {
          if (redirects >= policy.maxRedirects) {
            disposeUnlockedResponse(response);
            throw error("crawler_redirect_rejected");
          }
          let next: CanonicalWebSourceUrl;
          try {
            next = contentLocation(candidate, headers);
          } catch {
            disposeUnlockedResponse(response);
            throw error("crawler_redirect_rejected");
          }
          disposeUnlockedResponse(response);
          try {
            requirePdfPolicy(next, policy);
          } catch {
            throw error("crawler_redirect_rejected");
          }
          redirects += 1;
          candidate = next;
          redirectChain.push(next.url);
          continue;
        }
        if (response.statusCode !== 200) {
          disposeUnlockedResponse(response);
          throw error("crawler_bad_response", response.statusCode >= 500);
        }

        try {
          const contentType = singleHeader(headers, "content-type", true);
          if (contentType !== "application/pdf") throw error("crawler_bad_response");
          requireIdentityEncoding(headers);
          if (headers.values.has("transfer-encoding")) throw error("crawler_bad_response");
          const contentLength = canonicalContentLength(headers, true);
          if (contentLength === undefined || contentLength < 1) {
            throw error("crawler_bad_response");
          }
          if (contentLength > policy.maximumBytes) {
            throw error("crawler_response_too_large");
          }
          const receipt: GovernedPdfFetchReceipt = {
            schemaVersion: 1,
            requestedUrlSha256: sha256(initial.url),
            finalUrlSha256: sha256(candidate.url),
            redirectChainSha256: redirectChainSha256(redirectChain),
            redirectCount: redirects,
            robotsCheckCount: accounting.robotsChecks,
            pinnedConnectionCount: accounting.connections,
            retrievedAt: checkedNow(this.now),
            contentType: "application/pdf",
            contentEncoding: "identity",
            contentLength,
            userAgent: policy.requestUserAgent,
          };
          return {
            body: boundedPdfBody({
              response,
              expectedBytes: contentLength,
              maximumBytes: policy.maximumBytes,
              lifecycle,
              idleTimeoutMs: policy.responseIdleTimeoutMs,
            }),
            expectedSizeBytes: BigInt(contentLength),
            receipt,
          };
        } catch (caught) {
          disposeUnlockedResponse(response);
          throw caught;
        }
      }
    } catch (caught) {
      lifecycle.dispose();
      const stopped = stoppedError(lifecycle);
      if (stopped) throw stopped;
      if (caught instanceof GovernedCrawlerFetchError) throw caught;
      if (caught instanceof CrawlerOriginRateLimitError) throw caught;
      throw error("crawler_unavailable", true);
    }
  }
}

/** Convenience entry point for callers that do not need custom network seams. */
export function fetchGovernedPdf(
  input: GovernedPdfFetchInput,
  dependencies: GovernedPdfFetcherDependencies = {},
): Promise<GovernedPdfFetchResult> {
  return new GovernedPdfFetcher(dependencies).fetch(input);
}
