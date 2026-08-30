import { isAbsolute, resolve } from "node:path";

export const HARD_MAX_BODY_BYTES = 100 * 1_024 * 1_024;
export const HARD_MAX_ATTESTATION_BYTES = 16 * 1_024;
export const HARD_MAX_HEADER_BYTES = 16 * 1_024;

const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROUTE_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]{0,255}$/;
const PLACEHOLDER_PATTERN = /(change[-_ ]?me|example|placeholder|replace)/i;

export interface ValidatorConfiguration {
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
  maxAttestationBytes: number;
  bodyIdleTimeoutMs: number;
  bodyAbsoluteTimeoutMs: number;
  validationTimeoutMs: number;
  readinessTimeoutMs: number;
  readinessCacheMs: number;
  gracefulShutdownMs: number;
  maxConcurrentValidations: number;
  maxPageCount: number;
  maxObjectCount: number;
  maxRevisionCount: number;
  signatureReadinessMaxAgeMs: number;
  signatureFutureClockSkewMs: number;
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
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be a canonical integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

function requiredVisibleSecret(raw: string | undefined): string {
  if (
    raw === undefined
    || raw.length < 32
    || raw.length > 4 * 1_024
    || !VISIBLE_ASCII_PATTERN.test(raw)
    || PLACEHOLDER_PATTERN.test(raw)
  ) {
    throw new Error(
      "PAPERPILOT_VALIDATOR_BEARER_SECRET must contain 32-4096 visible ASCII characters.",
    );
  }
  return raw;
}

function requiredIdentifier(
  raw: string | undefined,
  name: string,
  maximumCharacters: number,
): string {
  if (
    raw === undefined
    || raw.length > maximumCharacters
    || !SAFE_IDENTIFIER_PATTERN.test(raw)
  ) {
    throw new Error(`${name} must be a bounded opaque identifier.`);
  }
  return raw;
}

function route(raw: string | undefined): string {
  const value = raw ?? "/v1/validate-pdf";
  if (
    !ROUTE_PATTERN.test(value)
    || value === "/livez"
    || value === "/readyz"
    || value.includes("//")
    || value.endsWith("/")
  ) {
    throw new Error("PAPERPILOT_VALIDATOR_ROUTE is invalid.");
  }
  return value;
}

function host(raw: string | undefined): string {
  const value = raw ?? "127.0.0.1";
  if (
    value.length === 0
    || value.length > 255
    || !/^[A-Za-z0-9.:-]+$/.test(value)
    || value.startsWith("-")
    || value.endsWith("-")
  ) {
    throw new Error("PAPERPILOT_VALIDATOR_HOST is invalid.");
  }
  return value;
}

export function validatorConfigurationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ValidatorConfiguration {
  const production = environment.NODE_ENV === "production";
  const unsafeWindowsRaw =
    environment.PAPERPILOT_VALIDATOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT;
  if (unsafeWindowsRaw !== undefined && unsafeWindowsRaw !== "1") {
    throw new Error(
      "PAPERPILOT_VALIDATOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT must be omitted or exactly 1.",
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
  const bearerSecret = requiredVisibleSecret(
    environment.PAPERPILOT_VALIDATOR_BEARER_SECRET
      ?? environment.PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET,
  );
  const tempRootRaw = environment.PAPERPILOT_VALIDATOR_TEMP_ROOT
    ?? resolve(process.cwd(), ".validator-tmp");
  if (!isAbsolute(tempRootRaw) || tempRootRaw !== resolve(tempRootRaw)) {
    throw new Error("PAPERPILOT_VALIDATOR_TEMP_ROOT must be a canonical absolute path.");
  }
  const maxBodyBytes = canonicalInteger(
    environment,
    "PAPERPILOT_VALIDATOR_MAX_BODY_BYTES",
    25 * 1_024 * 1_024,
    1,
    HARD_MAX_BODY_BYTES,
  );
  const bodyIdleTimeoutMs = canonicalInteger(
    environment,
    "PAPERPILOT_VALIDATOR_BODY_IDLE_TIMEOUT_MS",
    3_000,
    100,
    60_000,
  );
  const bodyAbsoluteTimeoutMs = canonicalInteger(
    environment,
    "PAPERPILOT_VALIDATOR_BODY_ABSOLUTE_TIMEOUT_MS",
    5_000,
    bodyIdleTimeoutMs,
    120_000,
  );
  const validationTimeoutMs = canonicalInteger(
    environment,
    "PAPERPILOT_VALIDATOR_VALIDATION_TIMEOUT_MS",
    20_000,
    100,
    120_000,
  );
  // The worker accepts definitions up to 24h old. Readiness uses a 23h
  // default so a ready instance has margin for queueing and scan time.
  const signatureReadinessMaxAgeMs = canonicalInteger(
    environment,
    "PAPERPILOT_VALIDATOR_SIGNATURE_READINESS_MAX_AGE_MS",
    23 * 60 * 60 * 1_000,
    60_000,
    7 * 24 * 60 * 60 * 1_000,
  );
  const signatureFutureClockSkewMs = canonicalInteger(
    environment,
    "PAPERPILOT_VALIDATOR_SIGNATURE_FUTURE_CLOCK_SKEW_MS",
    5 * 60 * 1_000,
    0,
    60 * 60 * 1_000,
  );
  if (signatureFutureClockSkewMs >= signatureReadinessMaxAgeMs) {
    throw new Error("The signature future-clock skew must be smaller than the readiness age.");
  }
  return Object.freeze({
    production,
    unsafeWindowsDevelopment,
    host: host(environment.PAPERPILOT_VALIDATOR_HOST),
    port: canonicalInteger(environment, "PAPERPILOT_VALIDATOR_PORT", 4010, 0, 65_535),
    route: route(environment.PAPERPILOT_VALIDATOR_ROUTE),
    bearerSecret,
    policyVersion: requiredIdentifier(
      environment.PAPERPILOT_VALIDATOR_POLICY_VERSION
        ?? environment.PAPERPILOT_VALIDATION_POLICY_VERSION,
      "PAPERPILOT_VALIDATOR_POLICY_VERSION",
      128,
    ),
    toolchainDigest: (() => {
      const digest = environment.PAPERPILOT_VALIDATOR_TOOLCHAIN_DIGEST;
      if (digest === undefined || !SHA256_PATTERN.test(digest)) {
        throw new Error("PAPERPILOT_VALIDATOR_TOOLCHAIN_DIGEST must be a lowercase SHA-256 digest.");
      }
      return digest;
    })(),
    maxBodyBytes,
    maxAttestationBytes: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_MAX_ATTESTATION_BYTES",
      HARD_MAX_ATTESTATION_BYTES,
      1_024,
      HARD_MAX_ATTESTATION_BYTES,
    ),
    bodyIdleTimeoutMs,
    bodyAbsoluteTimeoutMs,
    validationTimeoutMs,
    readinessTimeoutMs: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_READINESS_TIMEOUT_MS",
      3_000,
      100,
      30_000,
    ),
    readinessCacheMs: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_READINESS_CACHE_MS",
      5_000,
      0,
      60_000,
    ),
    gracefulShutdownMs: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_GRACEFUL_SHUTDOWN_MS",
      10_000,
      100,
      60_000,
    ),
    maxConcurrentValidations: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_MAX_CONCURRENT",
      2,
      1,
      64,
    ),
    maxPageCount: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_MAX_PAGE_COUNT",
      100_000,
      1,
      100_000,
    ),
    maxObjectCount: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_MAX_OBJECT_COUNT",
      10_000_000,
      1,
      10_000_000,
    ),
    maxRevisionCount: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_MAX_REVISION_COUNT",
      10_000,
      1,
      10_000,
    ),
    signatureReadinessMaxAgeMs,
    signatureFutureClockSkewMs,
    maxHeaderBytes: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_MAX_HEADER_BYTES",
      8 * 1_024,
      1_024,
      HARD_MAX_HEADER_BYTES,
    ),
    maxRequestsPerSocket: canonicalInteger(
      environment,
      "PAPERPILOT_VALIDATOR_MAX_REQUESTS_PER_SOCKET",
      100,
      1,
      1_000,
    ),
    tempRoot: tempRootRaw,
  });
}
