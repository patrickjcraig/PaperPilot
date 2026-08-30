import "server-only";

import type { UploadConfiguration } from "@/server/uploads/config";
import { CRAWLER_ACQUISITION_MODE_V1 } from "./crawler-command";

// The first durable mode binds one exact path and one exact URL digest. A
// useful redirect requires a separately reviewed destination scope, so this
// mode must remain redirect-free instead of advertising an unusable allowance.
export const MAX_CRAWLER_REDIRECTS = 0;
export const DEFAULT_CRAWLER_MAX_REDIRECTS = 0;
export const DEFAULT_CRAWLER_MAX_DNS_ADDRESSES = 8;
export const MAX_CRAWLER_DNS_ADDRESSES = 16;
export const DEFAULT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS = 3_000;
export const MAX_CRAWLER_DNS_LOOKUP_TIMEOUT_MS = 10_000;
export const DEFAULT_CRAWLER_MAX_RESPONSE_BYTES = 25 * 1_024 * 1_024;
export const DEFAULT_CRAWLER_MAX_RESPONSE_HEADER_BYTES = 32 * 1_024;
export const MAX_CRAWLER_RESPONSE_HEADER_BYTES = 64 * 1_024;
export const DEFAULT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS = 5_000;
export const MAX_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS = 15_000;
export const DEFAULT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS = 10_000;
export const MAX_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_CRAWLER_ABSOLUTE_DEADLINE_MS = 60_000;
export const MAX_CRAWLER_ABSOLUTE_DEADLINE_MS = 120_000;
export const DEFAULT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE = 6;
export const MAX_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE = 600;
export const DEFAULT_CRAWLER_ORIGIN_BURST = 1;
export const MAX_CRAWLER_ORIGIN_BURST = 60;

const MIN_CRAWLER_TIMEOUT_MS = 100;
const MIN_CRAWLER_ABSOLUTE_DEADLINE_MS = 1_000;
const MIN_CRAWLER_RESPONSE_HEADER_BYTES = 1_024;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// RFC 9309 product-token: ASCII letters, underscore, and hyphen only.
const ROBOTS_USER_AGENT_PATTERN = /^[A-Za-z_-]{3,64}$/;
const WORKER_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_POLICY_VERSION = "paperpilot-crawler-explicit-pdf-v1";
const LOCAL_RATE_POLICY_VERSION = "paperpilot-crawler-origin-rate-v1";
const LOCAL_ROBOTS_USER_AGENT = "PaperPilotCrawler";
const LOCAL_WORKER_IDENTITY = "paperpilot-crawler-local";

export interface CrawlerConfiguration {
  acquisitionMode: typeof CRAWLER_ACQUISITION_MODE_V1;
  policyVersion: string;
  robotsUserAgent: string;
  maxRedirects: number;
  maxDnsAddresses: number;
  dnsLookupTimeoutMs: number;
  maxResponseBytes: number;
  maxResponseHeaderBytes: number;
  responseHeaderTimeoutMs: number;
  responseIdleTimeoutMs: number;
  absoluteDeadlineMs: number;
  ratePolicyVersion: string;
  originRequestsPerMinute: number;
  originBurst: number;
  workerIdentity: string;
}

type UploadByteLimit = Pick<UploadConfiguration, "maxUploadBytes">;

function configuredText(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
  required: boolean,
  pattern: RegExp,
): string {
  const raw = environment[name];
  if (raw === undefined) {
    if (required) throw new Error(`${name} is required in production.`);
    return fallback;
  }
  if (raw !== raw.trim() || !pattern.test(raw)) {
    throw new Error(`${name} is invalid.`);
  }
  return raw;
}

function boundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be a canonical non-negative integer.`);
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validateUploadLimit(upload: UploadByteLimit): number {
  if (
    !upload
    || typeof upload !== "object"
    || !Number.isSafeInteger(upload.maxUploadBytes)
    || upload.maxUploadBytes <= 0
  ) {
    throw new Error("The crawler requires a valid upload byte limit.");
  }
  return upload.maxUploadBytes;
}

/**
 * Resolve the bounded first-mode crawler policy without reading storage or
 * enabling any network activity. The upload limit is a mandatory caller input.
 */
export function crawlerConfigurationFromEnvironment(
  upload: UploadByteLimit,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<CrawlerConfiguration> {
  const uploadMaxBytes = validateUploadLimit(upload);
  const production = environment.NODE_ENV === "production";
  const policyVersion = configuredText(
    environment,
    "PAPERPILOT_CRAWLER_POLICY_VERSION",
    LOCAL_POLICY_VERSION,
    production,
    POLICY_VERSION_PATTERN,
  );
  const robotsUserAgent = configuredText(
    environment,
    "PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT",
    LOCAL_ROBOTS_USER_AGENT,
    production,
    ROBOTS_USER_AGENT_PATTERN,
  );
  const workerIdentity = configuredText(
    environment,
    "PAPERPILOT_CRAWLER_WORKER_IDENTITY",
    LOCAL_WORKER_IDENTITY,
    production,
    WORKER_IDENTITY_PATTERN,
  );
  const ratePolicyVersion = configuredText(
    environment,
    "PAPERPILOT_CRAWLER_RATE_POLICY_VERSION",
    LOCAL_RATE_POLICY_VERSION,
    production,
    POLICY_VERSION_PATTERN,
  );

  const maxRedirects = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_MAX_REDIRECTS",
    DEFAULT_CRAWLER_MAX_REDIRECTS,
    0,
    MAX_CRAWLER_REDIRECTS,
  );
  const maxDnsAddresses = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_MAX_DNS_ADDRESSES",
    DEFAULT_CRAWLER_MAX_DNS_ADDRESSES,
    1,
    MAX_CRAWLER_DNS_ADDRESSES,
  );
  const dnsLookupTimeoutMs = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS",
    DEFAULT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS,
    MIN_CRAWLER_TIMEOUT_MS,
    MAX_CRAWLER_DNS_LOOKUP_TIMEOUT_MS,
  );
  const maxResponseBytes = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_MAX_RESPONSE_BYTES",
    Math.min(DEFAULT_CRAWLER_MAX_RESPONSE_BYTES, uploadMaxBytes),
    1,
    uploadMaxBytes,
  );
  const maxResponseHeaderBytes = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_MAX_RESPONSE_HEADER_BYTES",
    DEFAULT_CRAWLER_MAX_RESPONSE_HEADER_BYTES,
    MIN_CRAWLER_RESPONSE_HEADER_BYTES,
    MAX_CRAWLER_RESPONSE_HEADER_BYTES,
  );
  const responseHeaderTimeoutMs = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS",
    DEFAULT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS,
    MIN_CRAWLER_TIMEOUT_MS,
    MAX_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS,
  );
  const responseIdleTimeoutMs = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS",
    DEFAULT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS,
    MIN_CRAWLER_TIMEOUT_MS,
    MAX_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS,
  );
  const absoluteDeadlineMs = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_ABSOLUTE_DEADLINE_MS",
    DEFAULT_CRAWLER_ABSOLUTE_DEADLINE_MS,
    MIN_CRAWLER_ABSOLUTE_DEADLINE_MS,
    MAX_CRAWLER_ABSOLUTE_DEADLINE_MS,
  );
  const originRequestsPerMinute = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE",
    DEFAULT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE,
    1,
    MAX_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE,
  );
  const originBurst = boundedInteger(
    environment,
    "PAPERPILOT_CRAWLER_ORIGIN_BURST",
    DEFAULT_CRAWLER_ORIGIN_BURST,
    1,
    MAX_CRAWLER_ORIGIN_BURST,
  );

  if (
    dnsLookupTimeoutMs >= absoluteDeadlineMs
    || responseHeaderTimeoutMs >= absoluteDeadlineMs
    || responseIdleTimeoutMs >= absoluteDeadlineMs
    || dnsLookupTimeoutMs + responseHeaderTimeoutMs >= absoluteDeadlineMs
  ) {
    throw new Error(
      "Crawler DNS, header, and idle timeouts must fit inside the absolute deadline.",
    );
  }
  if (originBurst > originRequestsPerMinute) {
    throw new Error(
      "PAPERPILOT_CRAWLER_ORIGIN_BURST cannot exceed the per-minute origin budget.",
    );
  }

  return Object.freeze({
    acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
    policyVersion,
    robotsUserAgent,
    maxRedirects,
    maxDnsAddresses,
    dnsLookupTimeoutMs,
    maxResponseBytes,
    maxResponseHeaderBytes,
    responseHeaderTimeoutMs,
    responseIdleTimeoutMs,
    absoluteDeadlineMs,
    ratePolicyVersion,
    originRequestsPerMinute,
    originBurst,
    workerIdentity,
  });
}
