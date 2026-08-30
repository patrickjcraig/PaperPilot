import "server-only";

export type ExternalValidationVerdict = "accepted" | "rejected";
export type ExternalMalwareVerdict = "clean" | "infected";
export type ExternalPdfStructuralVerdict = "valid" | "invalid";

export type DocumentValidationRejectionCode =
  | "malware_detected"
  | "pdf_invalid"
  | "pdf_policy_violation"
  | "pdf_resource_limit_exceeded"
  | "malware_and_pdf_invalid";

export type SupportedValidatedPdfVersion =
  | "1.0"
  | "1.1"
  | "1.2"
  | "1.3"
  | "1.4"
  | "1.5"
  | "1.6"
  | "1.7"
  | "2.0";

export interface ExternalDocumentValidationResponse {
  schemaVersion: 1;
  policyVersion: string;
  storageVersion: string;
  toolchainDigest: string;
  verdict: ExternalValidationVerdict;
  rejectionCode: DocumentValidationRejectionCode | null;
  input: {
    sha256: string;
    sizeBytes: string;
  };
  malware: {
    verdict: ExternalMalwareVerdict;
    engine: string;
    engineVersion: string;
    signatureVersion: string;
    signaturePublishedAt: string;
    scannedAt: string;
    detectionCount: number;
    durationMs: number;
  };
  pdf: {
    structuralVerdict: ExternalPdfStructuralVerdict;
    engine: string;
    engineVersion: string;
    pdfVersion: SupportedValidatedPdfVersion | "unknown";
    pageCount: number | null;
    objectCount: number | null;
    revisionCount: number | null;
    warningCount: number;
    checkedAt: string;
    durationMs: number;
  };
  completedAt: string;
  totalDurationMs: number;
}

/**
 * Bounded, provider-neutral evidence shaped for DocumentValidationAttestation
 * persistence. Identifiers for the job, attempt, asset, and document remain
 * the caller's responsibility and are never accepted from the provider.
 */
export interface DocumentValidationAttestation {
  inputSha256: string;
  inputSizeBytes: bigint;
  storageVersion: string;
  policyVersion: string;
  toolchainDigest: string;
  verdict: "ACCEPTED" | "REJECTED";
  rejectionCode: DocumentValidationRejectionCode | null;
  malwareVerdict: "CLEAN" | "INFECTED";
  malwareEngine: string;
  malwareEngineVersion: string;
  signatureVersion: string;
  signaturePublishedAt: Date;
  scannedAt: Date;
  pdfStructuralVerdict: "VALID" | "INVALID";
  pdfEngine: string;
  pdfEngineVersion: string;
  pdfVersion: SupportedValidatedPdfVersion | "unknown";
  pageCount: number | null;
  objectCount: number | null;
  revisionCount: number | null;
  checkedAt: Date;
  result: {
    schemaVersion: 1;
    detectionCount: number;
    warningCount: number;
    malwareDurationMs: number;
    pdfDurationMs: number;
    totalDurationMs: number;
    completedAt: string;
  };
}

export interface DocumentValidationResponseExpectations {
  expectedSha256: string;
  expectedSizeBytes: bigint;
  expectedStorageVersion: string;
  expectedPolicyVersion: string;
  now: Date;
  signatureMaxAgeMs: number;
  futureClockSkewMs: number;
  maxDurationMs: number;
}

export type DocumentValidationContractFailure =
  | "invalid_response"
  | "content_binding_mismatch"
  | "storage_binding_mismatch"
  | "policy_binding_mismatch"
  | "signatures_stale"
  | "clock_invalid";

const CONTRACT_MESSAGES: Record<DocumentValidationContractFailure, string> = {
  invalid_response: "The validation service returned an invalid attestation.",
  content_binding_mismatch:
    "The validation service returned an attestation for different content.",
  storage_binding_mismatch:
    "The validation service returned an attestation for a different storage version.",
  policy_binding_mismatch:
    "The validation service returned an attestation for a different policy.",
  signatures_stale:
    "The validation service did not use a sufficiently fresh signature database.",
  clock_invalid:
    "The validation service returned an invalid attestation timestamp.",
};

export class DocumentValidationContractError extends Error {
  constructor(readonly failure: DocumentValidationContractFailure) {
    super(CONTRACT_MESSAGES[failure]);
    this.name = "DocumentValidationContractError";
  }
}

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "policyVersion",
  "storageVersion",
  "toolchainDigest",
  "verdict",
  "rejectionCode",
  "input",
  "malware",
  "pdf",
  "completedAt",
  "totalDurationMs",
] as const;
const INPUT_KEYS = ["sha256", "sizeBytes"] as const;
const MALWARE_KEYS = [
  "verdict",
  "engine",
  "engineVersion",
  "signatureVersion",
  "signaturePublishedAt",
  "scannedAt",
  "detectionCount",
  "durationMs",
] as const;
const PDF_KEYS = [
  "structuralVerdict",
  "engine",
  "engineVersion",
  "pdfVersion",
  "pageCount",
  "objectCount",
  "revisionCount",
  "warningCount",
  "checkedAt",
  "durationMs",
] as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const CANONICAL_SIZE_PATTERN = /^[1-9]\d{0,15}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SUPPORTED_PDF_VERSIONS = new Set<string>([
  "1.0",
  "1.1",
  "1.2",
  "1.3",
  "1.4",
  "1.5",
  "1.6",
  "1.7",
  "2.0",
]);
const REJECTION_CODES = new Set<string>([
  "malware_detected",
  "pdf_invalid",
  "pdf_policy_violation",
  "pdf_resource_limit_exceeded",
  "malware_and_pdf_invalid",
]);

const MAX_DETECTION_COUNT = 128;
const MAX_PAGE_COUNT = 100_000;
const MAX_OBJECT_COUNT = 10_000_000;
const MAX_REVISION_COUNT = 10_000;
const MAX_WARNING_COUNT = 10_000;

function invalid(failure: DocumentValidationContractFailure = "invalid_response"): never {
  throw new DocumentValidationContractError(failure);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length
    || expected.some((key) => !Object.hasOwn(value, key))
  ) {
    invalid();
  }
}

function safeIdentifier(value: unknown, maximumCharacters: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumCharacters
    || !SAFE_IDENTIFIER_PATTERN.test(value)
  ) {
    return invalid();
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    return invalid();
  }
  return value;
}

function nullableBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return value === null ? null : boundedInteger(value, minimum, maximum);
}

function canonicalTimestamp(value: unknown): Date {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return invalid();
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    return invalid();
  }
  return date;
}

function assertExpectations(
  expectations: DocumentValidationResponseExpectations,
): void {
  if (
    !SHA256_PATTERN.test(expectations.expectedSha256)
    || typeof expectations.expectedSizeBytes !== "bigint"
    || expectations.expectedSizeBytes <= 0n
    || expectations.expectedSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)
    || safeIdentifier(expectations.expectedStorageVersion, 256)
      !== expectations.expectedStorageVersion
    || safeIdentifier(expectations.expectedPolicyVersion, 128)
      !== expectations.expectedPolicyVersion
    || !(expectations.now instanceof Date)
    || !Number.isFinite(expectations.now.getTime())
    || !Number.isSafeInteger(expectations.signatureMaxAgeMs)
    || expectations.signatureMaxAgeMs <= 0
    || !Number.isSafeInteger(expectations.futureClockSkewMs)
    || expectations.futureClockSkewMs < 0
    || expectations.futureClockSkewMs >= expectations.signatureMaxAgeMs
    || !Number.isSafeInteger(expectations.maxDurationMs)
    || expectations.maxDurationMs <= 0
  ) {
    invalid();
  }
}

function rejectionCode(value: unknown): DocumentValidationRejectionCode | null {
  if (value === null) return null;
  if (typeof value !== "string" || !REJECTION_CODES.has(value)) {
    return invalid();
  }
  return value as DocumentValidationRejectionCode;
}

export function parseExternalDocumentValidationResponse(
  rawValue: unknown,
  expectations: DocumentValidationResponseExpectations,
): DocumentValidationAttestation {
  assertExpectations(expectations);
  const response = record(rawValue);
  exactKeys(response, TOP_LEVEL_KEYS);
  if (response.schemaVersion !== 1) invalid();

  const policy = safeIdentifier(response.policyVersion, 128);
  if (policy !== expectations.expectedPolicyVersion) {
    invalid("policy_binding_mismatch");
  }
  const storageVersion = safeIdentifier(response.storageVersion, 256);
  if (storageVersion !== expectations.expectedStorageVersion) {
    invalid("storage_binding_mismatch");
  }
  if (
    typeof response.toolchainDigest !== "string"
    || !SHA256_PATTERN.test(response.toolchainDigest)
  ) {
    invalid();
  }
  if (response.verdict !== "accepted" && response.verdict !== "rejected") {
    invalid();
  }
  const normalizedRejectionCode = rejectionCode(response.rejectionCode);

  const input = record(response.input);
  exactKeys(input, INPUT_KEYS);
  if (typeof input.sha256 !== "string" || !SHA256_PATTERN.test(input.sha256)) {
    invalid();
  }
  if (typeof input.sizeBytes !== "string" || !CANONICAL_SIZE_PATTERN.test(input.sizeBytes)) {
    invalid();
  }
  const inputSizeBytes = BigInt(input.sizeBytes);
  if (
    inputSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)
    || input.sha256 !== expectations.expectedSha256
    || inputSizeBytes !== expectations.expectedSizeBytes
  ) {
    invalid("content_binding_mismatch");
  }

  const malware = record(response.malware);
  exactKeys(malware, MALWARE_KEYS);
  if (malware.verdict !== "clean" && malware.verdict !== "infected") invalid();
  const malwareEngine = safeIdentifier(malware.engine, 64);
  const malwareEngineVersion = safeIdentifier(malware.engineVersion, 128);
  const signatureVersion = safeIdentifier(malware.signatureVersion, 128);
  const signaturePublishedAt = canonicalTimestamp(malware.signaturePublishedAt);
  const scannedAt = canonicalTimestamp(malware.scannedAt);
  const detectionCount = boundedInteger(
    malware.detectionCount,
    0,
    MAX_DETECTION_COUNT,
  );
  const malwareDurationMs = boundedInteger(
    malware.durationMs,
    0,
    expectations.maxDurationMs,
  );
  if (
    (malware.verdict === "clean" && detectionCount !== 0)
    || (malware.verdict === "infected" && detectionCount < 1)
  ) {
    invalid();
  }

  const pdf = record(response.pdf);
  exactKeys(pdf, PDF_KEYS);
  if (pdf.structuralVerdict !== "valid" && pdf.structuralVerdict !== "invalid") {
    invalid();
  }
  const pdfEngine = safeIdentifier(pdf.engine, 64);
  const pdfEngineVersion = safeIdentifier(pdf.engineVersion, 128);
  if (
    typeof pdf.pdfVersion !== "string"
    || (pdf.pdfVersion !== "unknown" && !SUPPORTED_PDF_VERSIONS.has(pdf.pdfVersion))
  ) {
    invalid();
  }
  const pageCount = nullableBoundedInteger(pdf.pageCount, 1, MAX_PAGE_COUNT);
  const objectCount = nullableBoundedInteger(pdf.objectCount, 1, MAX_OBJECT_COUNT);
  const revisionCount = nullableBoundedInteger(
    pdf.revisionCount,
    1,
    MAX_REVISION_COUNT,
  );
  const warningCount = boundedInteger(pdf.warningCount, 0, MAX_WARNING_COUNT);
  const checkedAt = canonicalTimestamp(pdf.checkedAt);
  const pdfDurationMs = boundedInteger(
    pdf.durationMs,
    0,
    expectations.maxDurationMs,
  );
  const pdfStructurallyValid = pdf.structuralVerdict === "valid";
  if (
    pdfStructurallyValid
    && (
      pdf.pdfVersion === "unknown"
      || pageCount === null
      || objectCount === null
      || revisionCount === null
      || warningCount !== 0
    )
  ) {
    invalid();
  }

  const completedAt = canonicalTimestamp(response.completedAt);
  const totalDurationMs = boundedInteger(
    response.totalDurationMs,
    0,
    expectations.maxDurationMs,
  );
  if (
    totalDurationMs < malwareDurationMs
    || totalDurationMs < pdfDurationMs
    || signaturePublishedAt.getTime() > scannedAt.getTime()
    || scannedAt.getTime() > checkedAt.getTime()
    || scannedAt.getTime() > completedAt.getTime()
    || checkedAt.getTime() > completedAt.getTime()
  ) {
    invalid();
  }

  const nowMs = expectations.now.getTime();
  const latestAllowedTimestamp = nowMs + expectations.futureClockSkewMs;
  if (
    signaturePublishedAt.getTime() > latestAllowedTimestamp
    || scannedAt.getTime() > latestAllowedTimestamp
    || checkedAt.getTime() > latestAllowedTimestamp
    || completedAt.getTime() > latestAllowedTimestamp
  ) {
    invalid("clock_invalid");
  }
  if (nowMs - signaturePublishedAt.getTime() > expectations.signatureMaxAgeMs) {
    invalid("signatures_stale");
  }

  const clean = malware.verdict === "clean";
  const accepted = response.verdict === "accepted";
  if (accepted) {
    if (!clean || !pdfStructurallyValid || normalizedRejectionCode !== null) invalid();
  } else {
    if (normalizedRejectionCode === null) invalid();
    if (
      (clean && pdfStructurallyValid
        && normalizedRejectionCode !== "pdf_policy_violation")
      || (clean && !pdfStructurallyValid
        && normalizedRejectionCode !== "pdf_invalid"
        && normalizedRejectionCode !== "pdf_resource_limit_exceeded")
      || (!clean && pdfStructurallyValid
        && normalizedRejectionCode !== "malware_detected")
      || (!clean && !pdfStructurallyValid
        && normalizedRejectionCode !== "malware_and_pdf_invalid")
    ) {
      invalid();
    }
  }

  return {
    inputSha256: input.sha256,
    inputSizeBytes,
    storageVersion,
    policyVersion: policy,
    toolchainDigest: response.toolchainDigest,
    verdict: accepted ? "ACCEPTED" : "REJECTED",
    rejectionCode: normalizedRejectionCode,
    malwareVerdict: clean ? "CLEAN" : "INFECTED",
    malwareEngine,
    malwareEngineVersion,
    signatureVersion,
    signaturePublishedAt,
    scannedAt,
    pdfStructuralVerdict: pdfStructurallyValid ? "VALID" : "INVALID",
    pdfEngine,
    pdfEngineVersion,
    pdfVersion: pdf.pdfVersion as SupportedValidatedPdfVersion | "unknown",
    pageCount,
    objectCount,
    revisionCount,
    checkedAt,
    result: {
      schemaVersion: 1,
      detectionCount,
      warningCount,
      malwareDurationMs,
      pdfDurationMs,
      totalDurationMs,
      completedAt: completedAt.toISOString(),
    },
  };
}
