import { isAbsolute, resolve } from "node:path";

export const HARD_MAX_BODY_BYTES = 25 * 1_024 * 1_024;
export const HARD_MAX_PAGE_COUNT = 2_000;
export const HARD_MAX_TEXT_BYTES = 4 * 1_024 * 1_024;
export const HARD_MAX_CHUNK_COUNT = 4_096;
export const HARD_MAX_CHUNK_BYTES = 8 * 1_024;
export const HARD_MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024;
export const HARD_MAX_HEADER_BYTES = 16 * 1_024;

const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROUTE_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]{0,255}$/;
const PLACEHOLDER_PATTERN = /(change[-_ ]?me|example|placeholder|replace)/i;

export interface ExtractorConfiguration {
  /** Set by the environment parser; optional only for injected test configs. */
  production?: boolean;
  /** Explicit local-only acknowledgement; never accepted with production. */
  unsafeWindowsDevelopment?: boolean;
  host: string;
  port: number;
  route: string;
  bearerSecret: string;
  policyVersion: string;
  toolchainDigest: string;
  maxBodyBytes: number;
  maxPageCount: number;
  maxTextBytes: number;
  maxChunkCount: number;
  maxChunkBytes: number;
  maxResponseBytes: number;
  bodyIdleTimeoutMs: number;
  bodyAbsoluteTimeoutMs: number;
  extractionTimeoutMs: number;
  readinessTimeoutMs: number;
  readinessCacheMs: number;
  gracefulShutdownMs: number;
  maxConcurrentExtractions: number;
  /** Admit one extraction, close after its terminal response, and require concurrency one. */
  singleUse: boolean;
  maxHeaderBytes: number;
  maxRequestsPerSocket: number;
  tempRoot: string;
}

function canonicalInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error(`${name} must be a canonical integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

function requiredSecret(raw: string | undefined): string {
  if (
    raw === undefined
    || raw.length < 32
    || raw.length > 4 * 1_024
    || !VISIBLE_ASCII_PATTERN.test(raw)
    || PLACEHOLDER_PATTERN.test(raw)
  ) {
    throw new Error(
      "PAPERPILOT_EXTRACTOR_BEARER_SECRET must be a non-placeholder visible-ASCII secret between 32 and 4096 characters.",
    );
  }
  return raw;
}

function requiredIdentifier(raw: string | undefined, name: string): string {
  if (raw === undefined || raw.length > 128 || !SAFE_IDENTIFIER_PATTERN.test(raw)) {
    throw new Error(`${name} must be a bounded opaque identifier.`);
  }
  return raw;
}

function configuredRoute(raw: string | undefined): string {
  const value = raw ?? "/v1/extract-pdf";
  if (
    !ROUTE_PATTERN.test(value)
    || value === "/livez"
    || value === "/readyz"
    || value.includes("//")
    || value.endsWith("/")
  ) {
    throw new Error("PAPERPILOT_EXTRACTOR_ROUTE is invalid.");
  }
  return value;
}

function configuredHost(raw: string | undefined): string {
  const value = raw ?? "127.0.0.1";
  if (
    value.length === 0
    || value.length > 255
    || !/^[A-Za-z0-9.:-]+$/.test(value)
    || value.startsWith("-")
    || value.endsWith("-")
  ) {
    throw new Error("PAPERPILOT_EXTRACTOR_HOST is invalid.");
  }
  return value;
}

function configuredBoolean(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (raw !== "0" && raw !== "1") throw new Error(`${name} must be exactly 0 or 1.`);
  return raw === "1";
}

export function extractorConfigurationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExtractorConfiguration {
  const production = environment.NODE_ENV === "production";
  const unsafeWindowsRaw =
    environment.PAPERPILOT_EXTRACTOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT;
  if (unsafeWindowsRaw !== undefined && unsafeWindowsRaw !== "1") {
    throw new Error(
      "PAPERPILOT_EXTRACTOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT must be omitted or exactly 1.",
    );
  }
  const unsafeWindowsDevelopment = unsafeWindowsRaw === "1";
  if (production && unsafeWindowsDevelopment) {
    throw new Error("The insecure Windows development override is forbidden in production.");
  }
  if (process.platform === "win32" && !unsafeWindowsDevelopment) {
    throw new Error(
      "Windows requires an explicit insecure-development override because private DACLs are not implemented.",
    );
  }

  const maxTextBytes = canonicalInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_MAX_TEXT_BYTES",
    HARD_MAX_TEXT_BYTES,
    1,
    HARD_MAX_TEXT_BYTES,
  );
  const maxChunkCount = canonicalInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_MAX_CHUNKS",
    HARD_MAX_CHUNK_COUNT,
    1,
    HARD_MAX_CHUNK_COUNT,
  );
  const maxChunkBytes = canonicalInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_MAX_CHUNK_BYTES",
    HARD_MAX_CHUNK_BYTES,
    256,
    HARD_MAX_CHUNK_BYTES,
  );
  if (maxChunkBytes > maxTextBytes) {
    throw new Error("The per-chunk byte limit must not exceed the normalized-text limit.");
  }
  const maxResponseBytes = canonicalInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_MAX_RESPONSE_BYTES",
    HARD_MAX_RESPONSE_BYTES,
    64 * 1_024,
    HARD_MAX_RESPONSE_BYTES,
  );
  const requiredResponseBytes = maxTextBytes + maxChunkCount * 160 + 4 * 1_024;
  if (maxResponseBytes < requiredResponseBytes) {
    throw new Error("The response limit is too small for the configured text and chunk limits.");
  }

  const bodyIdleTimeoutMs = canonicalInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_BODY_IDLE_TIMEOUT_MS",
    3_000,
    100,
    60_000,
  );
  const bodyAbsoluteTimeoutMs = canonicalInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_BODY_ABSOLUTE_TIMEOUT_MS",
    5_000,
    bodyIdleTimeoutMs,
    120_000,
  );
  const tempRoot = environment.PAPERPILOT_EXTRACTOR_TEMP_ROOT
    ?? resolve(process.cwd(), ".extractor-tmp");
  if (!isAbsolute(tempRoot) || tempRoot !== resolve(tempRoot)) {
    throw new Error("PAPERPILOT_EXTRACTOR_TEMP_ROOT must be a canonical absolute path.");
  }

  const digest = environment.PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST;
  if (
    digest === undefined
    || !SHA256_PATTERN.test(digest)
    || /^0{64}$/.test(digest)
  ) {
    throw new Error("PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST must be a nonzero lowercase SHA-256 digest.");
  }

  const singleUse = configuredBoolean(
    environment,
    "PAPERPILOT_EXTRACTOR_SINGLE_USE",
    false,
  );
  const maxConcurrentExtractions = canonicalInteger(
    environment,
    "PAPERPILOT_EXTRACTOR_MAX_CONCURRENT",
    2,
    1,
    8,
  );
  if (singleUse && maxConcurrentExtractions !== 1) {
    throw new Error("Single-use extraction requires PAPERPILOT_EXTRACTOR_MAX_CONCURRENT=1.");
  }
  if (production && (!singleUse || maxConcurrentExtractions !== 1)) {
    throw new Error("Production extraction requires single-use mode with concurrency exactly one.");
  }

  return Object.freeze({
    production,
    unsafeWindowsDevelopment,
    host: configuredHost(environment.PAPERPILOT_EXTRACTOR_HOST),
    port: canonicalInteger(environment, "PAPERPILOT_EXTRACTOR_PORT", 4020, 0, 65_535),
    route: configuredRoute(environment.PAPERPILOT_EXTRACTOR_ROUTE),
    bearerSecret: requiredSecret(
      environment.PAPERPILOT_EXTRACTOR_BEARER_SECRET
        ?? environment.PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET,
    ),
    policyVersion: requiredIdentifier(
      environment.PAPERPILOT_EXTRACTOR_POLICY_VERSION
        ?? environment.PAPERPILOT_EXTRACTION_POLICY_VERSION,
      "PAPERPILOT_EXTRACTOR_POLICY_VERSION",
    ),
    toolchainDigest: digest,
    maxBodyBytes: canonicalInteger(
      environment,
      "PAPERPILOT_EXTRACTOR_MAX_BODY_BYTES",
      HARD_MAX_BODY_BYTES,
      1,
      HARD_MAX_BODY_BYTES,
    ),
    maxPageCount: canonicalInteger(
      environment,
      "PAPERPILOT_EXTRACTOR_MAX_PAGES",
      HARD_MAX_PAGE_COUNT,
      1,
      HARD_MAX_PAGE_COUNT,
    ),
    maxTextBytes,
    maxChunkCount,
    maxChunkBytes,
    maxResponseBytes,
    bodyIdleTimeoutMs,
    bodyAbsoluteTimeoutMs,
    extractionTimeoutMs: canonicalInteger(
      environment,
      "PAPERPILOT_EXTRACTOR_EXTRACTION_TIMEOUT_MS",
      45_000,
      100,
      120_000,
    ),
    readinessTimeoutMs: canonicalInteger(
      environment,
      "PAPERPILOT_EXTRACTOR_READINESS_TIMEOUT_MS",
      3_000,
      100,
      30_000,
    ),
    readinessCacheMs: canonicalInteger(
      environment,
      "PAPERPILOT_EXTRACTOR_READINESS_CACHE_MS",
      5_000,
      0,
      60_000,
    ),
    gracefulShutdownMs: canonicalInteger(
      environment,
      "PAPERPILOT_EXTRACTOR_GRACEFUL_SHUTDOWN_MS",
      10_000,
      100,
      60_000,
    ),
    maxConcurrentExtractions,
    singleUse,
    maxHeaderBytes: canonicalInteger(
      environment,
      "PAPERPILOT_EXTRACTOR_MAX_HEADER_BYTES",
      8 * 1_024,
      1_024,
      HARD_MAX_HEADER_BYTES,
    ),
    maxRequestsPerSocket: canonicalInteger(
      environment,
      "PAPERPILOT_EXTRACTOR_MAX_REQUESTS_PER_SOCKET",
      100,
      1,
      1_000,
    ),
    tempRoot,
  });
}
