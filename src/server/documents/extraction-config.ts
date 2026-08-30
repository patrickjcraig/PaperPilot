import "server-only";

export const DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION = "paperpilot-text-extraction-v1";
export const DEFAULT_DOCUMENT_EXTRACTION_TIMEOUT_MS = 75_000;
export const DEFAULT_DOCUMENT_EXTRACTION_MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024;
export const MIN_DOCUMENT_EXTRACTION_RESPONSE_BYTES = 1_024;
export const MAX_DOCUMENT_EXTRACTION_RESPONSE_BYTES = 8 * 1_024 * 1_024;
export const DEFAULT_DOCUMENT_EXTRACTION_RESULT_MAX_AGE_MS = 15 * 60 * 1_000;
export const DEFAULT_DOCUMENT_EXTRACTION_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const MAX_TIMEOUT_SECONDS = 180;
const MAX_RESULT_AGE_SECONDS = 60 * 60;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 15 * 60;
const MAX_BEARER_SECRET_CHARACTERS = 4 * 1_024;
const MAX_POLICY_VERSION_CHARACTERS = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7E]+$/;
const PLACEHOLDER_PATTERN = /(change[-_ ]?me|example|placeholder|replace)/i;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface DocumentExtractionServiceConfiguration {
  /** Canonical, credential-free endpoint. The client requires this exact final URL. */
  endpoint: string;
  /** Same-origin readiness endpoint checked before a worker consumes an attempt. */
  readinessEndpoint: string;
  bearerSecret: string;
  policyVersion: string;
  /** Independently pinned by the worker; never trusted from the service response alone. */
  expectedToolchainDigest: string;
  timeoutMs: number;
  maxResponseBytes: number;
  resultMaxAgeMs: number;
  futureClockSkewMs: number;
}

function canonicalPositiveInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a canonical positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

function secondsAsMilliseconds(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallbackMilliseconds: number,
  maximumSeconds: number,
): number {
  return canonicalPositiveInteger(
    environment,
    name,
    fallbackMilliseconds / 1_000,
    maximumSeconds,
  ) * 1_000;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}

function canonicalEndpoint(
  rawValue: string | undefined,
  production: boolean,
  variableName: string,
): string {
  if (
    rawValue === undefined
    || rawValue.length === 0
    || rawValue !== rawValue.trim()
    || CONTROL_CHARACTER_PATTERN.test(rawValue)
    || rawValue.includes("?")
    || rawValue.includes("#")
  ) {
    throw new Error(
      `${variableName} must be one absolute credential-free endpoint without query or fragment.`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(rawValue);
  } catch {
    throw new Error(
      `${variableName} must be one absolute credential-free endpoint without query or fragment.`,
    );
  }
  const secure = endpoint.protocol === "https:";
  const allowedDevelopmentHttp = !production
    && endpoint.protocol === "http:"
    && isLoopbackHostname(endpoint.hostname);
  if (
    (!secure && !allowedDevelopmentHttp)
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
  ) {
    throw new Error(
      `${variableName} must use HTTPS in production; only loopback HTTP is allowed outside production, and URL credentials, query, and fragment are forbidden.`,
    );
  }
  return endpoint.toString();
}

function bearerSecret(rawValue: string | undefined): string {
  if (
    rawValue === undefined
    || rawValue.length < 32
    || rawValue.length > MAX_BEARER_SECRET_CHARACTERS
    || rawValue !== rawValue.trim()
    || !VISIBLE_ASCII_PATTERN.test(rawValue)
    || PLACEHOLDER_PATTERN.test(rawValue)
  ) {
    throw new Error(
      "PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET must be a non-placeholder visible-ASCII secret between 32 and 4096 characters.",
    );
  }
  return rawValue;
}

function policyVersion(rawValue: string | undefined): string {
  if (
    rawValue === undefined
    || rawValue.length > MAX_POLICY_VERSION_CHARACTERS
    || !POLICY_VERSION_PATTERN.test(rawValue)
  ) {
    throw new Error(
      "PAPERPILOT_EXTRACTION_POLICY_VERSION must be a bounded opaque policy identifier.",
    );
  }
  return rawValue;
}

export function requireDocumentExtractionToolchainDigest(
  rawValue: string | undefined,
): string {
  if (
    rawValue === undefined
    || !SHA256_PATTERN.test(rawValue)
    || /^0{64}$/.test(rawValue)
  ) {
    throw new Error(
      "PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST must be a nonzero lowercase SHA-256 digest pinned independently from the extractor service.",
    );
  }
  return rawValue;
}

export function documentExtractionServiceConfigurationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DocumentExtractionServiceConfiguration {
  const production = environment.NODE_ENV === "production";
  const endpoint = canonicalEndpoint(
    environment.PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT,
    production,
    "PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT",
  );
  const readinessEndpoint = canonicalEndpoint(
    environment.PAPERPILOT_EXTRACTION_SERVICE_READINESS_ENDPOINT
      ?? new URL("/readyz", endpoint).toString(),
    production,
    "PAPERPILOT_EXTRACTION_SERVICE_READINESS_ENDPOINT",
  );
  if (
    new URL(readinessEndpoint).origin !== new URL(endpoint).origin
    || readinessEndpoint === endpoint
  ) {
    throw new Error(
      "PAPERPILOT_EXTRACTION_SERVICE_READINESS_ENDPOINT must use the extraction endpoint's exact origin and a distinct path.",
    );
  }
  const resultMaxAgeMs = secondsAsMilliseconds(
    environment,
    "PAPERPILOT_EXTRACTION_RESULT_MAX_AGE_SECONDS",
    DEFAULT_DOCUMENT_EXTRACTION_RESULT_MAX_AGE_MS,
    MAX_RESULT_AGE_SECONDS,
  );
  const futureClockSkewMs = secondsAsMilliseconds(
    environment,
    "PAPERPILOT_EXTRACTION_FUTURE_CLOCK_SKEW_SECONDS",
    DEFAULT_DOCUMENT_EXTRACTION_FUTURE_CLOCK_SKEW_MS,
    MAX_FUTURE_CLOCK_SKEW_SECONDS,
  );
  if (futureClockSkewMs >= resultMaxAgeMs) {
    throw new Error(
      "The extraction-service future clock skew must be smaller than the maximum result age.",
    );
  }
  return Object.freeze({
    endpoint,
    readinessEndpoint,
    bearerSecret: bearerSecret(
      environment.PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET,
    ),
    policyVersion: policyVersion(
      environment.PAPERPILOT_EXTRACTION_POLICY_VERSION,
    ),
    expectedToolchainDigest: requireDocumentExtractionToolchainDigest(
      environment.PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST,
    ),
    timeoutMs: secondsAsMilliseconds(
      environment,
      "PAPERPILOT_EXTRACTION_TIMEOUT_SECONDS",
      DEFAULT_DOCUMENT_EXTRACTION_TIMEOUT_MS,
      MAX_TIMEOUT_SECONDS,
    ),
    maxResponseBytes: canonicalPositiveInteger(
      environment,
      "PAPERPILOT_EXTRACTION_MAX_RESPONSE_BYTES",
      DEFAULT_DOCUMENT_EXTRACTION_MAX_RESPONSE_BYTES,
      MAX_DOCUMENT_EXTRACTION_RESPONSE_BYTES,
      MIN_DOCUMENT_EXTRACTION_RESPONSE_BYTES,
    ),
    resultMaxAgeMs,
    futureClockSkewMs,
  });
}
