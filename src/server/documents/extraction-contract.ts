import "server-only";

export const MAX_EXTRACTED_PAGE_COUNT = 2_000;
export const MAX_EXTRACTED_CHUNK_COUNT = 4_096;
export const MAX_EXTRACTED_TEXT_BYTES = 4 * 1_024 * 1_024;
export const MAX_EXTRACTED_CHUNK_BYTES = 8 * 1_024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/;
const ENGINE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;
const PARAGRAPH_ID_PATTERN = /^p([1-9]\d*)-p([1-9]\d*)$/;
const PROHIBITED_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

export type ExternalTextExtractionVerdict = "extracted" | "no_text";

export interface ExternalDocumentExtractionResponse {
  schemaVersion: 1;
  policyVersion: string;
  storageVersion: string;
  toolchainDigest: string;
  verdict: ExternalTextExtractionVerdict;
  input: {
    sha256: string;
    sizeBytes: string;
  };
  extraction: {
    engine: "poppler";
    engineVersion: string;
    pageCount: number;
    chunkCount: number;
    textBytes: number;
    extractedAt: string;
    durationMs: number;
  };
  chunks: Array<{
    sequence: number;
    pageNumber: number;
    paragraphId: string;
    text: string;
  }>;
  completedAt: string;
  totalDurationMs: number;
}

export interface ExtractedDocumentTextChunk {
  sequence: number;
  pageNumber: number;
  paragraphId: string;
  text: string;
}

export interface DocumentTextExtractionAttestation {
  inputSha256: string;
  inputSizeBytes: bigint;
  storageVersion: string;
  policyVersion: string;
  toolchainDigest: string;
  verdict: "EXTRACTED" | "NO_TEXT";
  engine: "poppler";
  engineVersion: string;
  pageCount: number;
  chunkCount: number;
  textBytes: number;
  extractedAt: Date;
  completedAt: Date;
  durationMs: number;
  totalDurationMs: number;
  chunks: readonly ExtractedDocumentTextChunk[];
}

export interface DocumentExtractionExpectations {
  inputSha256: string;
  inputSizeBytes: bigint;
  storageVersion: string;
  policyVersion: string;
  toolchainDigest: string;
  expectedEngineVersion: string;
  now: Date;
  maxDurationMs: number;
  resultMaxAgeMs: number;
  futureClockSkewMs: number;
}

export type DocumentExtractionContractFailure =
  | "invalid_response"
  | "input_mismatch"
  | "policy_mismatch"
  | "toolchain_mismatch"
  | "engine_mismatch"
  | "result_stale"
  | "clock_invalid";

export class DocumentExtractionContractError extends Error {
  readonly failure: DocumentExtractionContractFailure;

  constructor(failure: DocumentExtractionContractFailure) {
    super("The extraction service returned an invalid response.");
    this.name = "DocumentExtractionContractError";
    this.failure = failure;
  }
}

function invalid(failure: DocumentExtractionContractFailure = "invalid_response"): never {
  throw new DocumentExtractionContractError(failure);
}

function closedRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expected = new Set(expectedKeys);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) invalid();
  return record;
}

function safeIdentifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_PATTERN.test(value)) invalid();
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) invalid();
  return value;
}

function canonicalTimestamp(value: unknown): Date {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid();
  return parsed;
}

function canonicalInputSize(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL_DECIMAL_PATTERN.test(value)) invalid();
  try {
    return BigInt(value);
  } catch {
    invalid();
  }
}

function extractedText(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.normalize("NFC")
    || value !== value.trim()
    || PROHIBITED_TEXT_PATTERN.test(value)
    || /\p{Zs}/u.test(value.replaceAll(" ", ""))
    || value.includes("  ")
    || Buffer.byteLength(value, "utf8") > MAX_EXTRACTED_CHUNK_BYTES
  ) invalid();
  return value;
}

export function parseExternalDocumentExtractionResponse(
  value: unknown,
  expectations: DocumentExtractionExpectations,
): DocumentTextExtractionAttestation {
  if (
    !SHA256_PATTERN.test(expectations.inputSha256)
    || expectations.inputSizeBytes < 1n
    || !SAFE_IDENTIFIER_PATTERN.test(expectations.storageVersion)
    || !SAFE_IDENTIFIER_PATTERN.test(expectations.policyVersion)
    || !SHA256_PATTERN.test(expectations.toolchainDigest)
    || /^0{64}$/.test(expectations.toolchainDigest)
    || !ENGINE_VERSION_PATTERN.test(expectations.expectedEngineVersion)
    || !(expectations.now instanceof Date)
    || !Number.isFinite(expectations.now.getTime())
    || !Number.isSafeInteger(expectations.maxDurationMs)
    || expectations.maxDurationMs < 1
    || !Number.isSafeInteger(expectations.resultMaxAgeMs)
    || expectations.resultMaxAgeMs < 1
    || !Number.isSafeInteger(expectations.futureClockSkewMs)
    || expectations.futureClockSkewMs < 0
    || expectations.futureClockSkewMs >= expectations.resultMaxAgeMs
  ) {
    throw new TypeError("Document extraction response expectations are invalid.");
  }

  const response = closedRecord(value, [
    "schemaVersion",
    "policyVersion",
    "storageVersion",
    "toolchainDigest",
    "verdict",
    "input",
    "extraction",
    "chunks",
    "completedAt",
    "totalDurationMs",
  ]);
  if (response.schemaVersion !== 1) invalid();

  const policyVersion = safeIdentifier(response.policyVersion);
  const storageVersion = safeIdentifier(response.storageVersion);
  if (policyVersion !== expectations.policyVersion) invalid("policy_mismatch");
  if (storageVersion !== expectations.storageVersion) invalid("input_mismatch");
  if (typeof response.toolchainDigest !== "string"
    || !SHA256_PATTERN.test(response.toolchainDigest)) invalid();
  if (response.toolchainDigest !== expectations.toolchainDigest) {
    invalid("toolchain_mismatch");
  }
  if (response.verdict !== "extracted" && response.verdict !== "no_text") invalid();

  const input = closedRecord(response.input, ["sha256", "sizeBytes"]);
  const inputSizeBytes = canonicalInputSize(input.sizeBytes);
  if (
    input.sha256 !== expectations.inputSha256
    || inputSizeBytes !== expectations.inputSizeBytes
  ) invalid("input_mismatch");

  const extraction = closedRecord(response.extraction, [
    "engine",
    "engineVersion",
    "pageCount",
    "chunkCount",
    "textBytes",
    "extractedAt",
    "durationMs",
  ]);
  if (extraction.engine !== "poppler") invalid("engine_mismatch");
  const engineVersion = safeIdentifier(extraction.engineVersion);
  if (!ENGINE_VERSION_PATTERN.test(engineVersion)) invalid();
  if (engineVersion !== expectations.expectedEngineVersion) {
    invalid("engine_mismatch");
  }
  const pageCount = boundedInteger(extraction.pageCount, 1, MAX_EXTRACTED_PAGE_COUNT);
  const chunkCount = boundedInteger(extraction.chunkCount, 0, MAX_EXTRACTED_CHUNK_COUNT);
  const textBytes = boundedInteger(extraction.textBytes, 0, MAX_EXTRACTED_TEXT_BYTES);
  const extractedAt = canonicalTimestamp(extraction.extractedAt);
  const durationMs = boundedInteger(extraction.durationMs, 0, expectations.maxDurationMs);
  const completedAt = canonicalTimestamp(response.completedAt);
  const totalDurationMs = boundedInteger(response.totalDurationMs, 0, expectations.maxDurationMs);
  if (extractedAt > completedAt || totalDurationMs < durationMs) invalid();

  if (!Array.isArray(response.chunks) || response.chunks.length !== chunkCount) invalid();
  const chunks: ExtractedDocumentTextChunk[] = [];
  let measuredTextBytes = 0;
  let previousPage = 0;
  let previousParagraph = 0;
  for (let index = 0; index < response.chunks.length; index += 1) {
    const chunk = closedRecord(response.chunks[index], [
      "sequence",
      "pageNumber",
      "paragraphId",
      "text",
    ]);
    const sequence = boundedInteger(chunk.sequence, 0, MAX_EXTRACTED_CHUNK_COUNT - 1);
    if (sequence !== index) invalid();
    const pageNumber = boundedInteger(chunk.pageNumber, 1, pageCount);
    if (pageNumber < previousPage) invalid();
    if (typeof chunk.paragraphId !== "string") invalid();
    const paragraphMatch = PARAGRAPH_ID_PATTERN.exec(chunk.paragraphId);
    if (!paragraphMatch) invalid();
    const paragraphPage = Number(paragraphMatch[1]);
    const paragraphOrdinal = Number(paragraphMatch[2]);
    if (
      !Number.isSafeInteger(paragraphPage)
      || !Number.isSafeInteger(paragraphOrdinal)
      || paragraphPage !== pageNumber
      || (pageNumber !== previousPage && paragraphOrdinal !== 1)
      || (pageNumber === previousPage
        && paragraphOrdinal !== previousParagraph
        && paragraphOrdinal !== previousParagraph + 1)
    ) invalid();
    const text = extractedText(chunk.text);
    measuredTextBytes += Buffer.byteLength(text, "utf8");
    if (measuredTextBytes > MAX_EXTRACTED_TEXT_BYTES) invalid();
    chunks.push({ sequence, pageNumber, paragraphId: chunk.paragraphId, text });
    previousPage = pageNumber;
    previousParagraph = paragraphOrdinal;
  }
  if (measuredTextBytes !== textBytes) invalid();

  const extracted = response.verdict === "extracted";
  if (
    (extracted && (chunkCount === 0 || textBytes === 0))
    || (!extracted && (chunkCount !== 0 || textBytes !== 0 || chunks.length !== 0))
  ) invalid();

  const nowMs = expectations.now.getTime();
  if (
    extractedAt.getTime() > nowMs + expectations.futureClockSkewMs
    || completedAt.getTime() > nowMs + expectations.futureClockSkewMs
  ) invalid("clock_invalid");
  if (nowMs - completedAt.getTime() > expectations.resultMaxAgeMs) {
    invalid("result_stale");
  }

  return Object.freeze({
    inputSha256: expectations.inputSha256,
    inputSizeBytes,
    storageVersion,
    policyVersion,
    toolchainDigest: expectations.toolchainDigest,
    verdict: extracted ? "EXTRACTED" : "NO_TEXT",
    engine: "poppler",
    engineVersion,
    pageCount,
    chunkCount,
    textBytes,
    extractedAt,
    completedAt,
    durationMs,
    totalDurationMs,
    chunks: Object.freeze(chunks.map((chunk) => Object.freeze({ ...chunk }))),
  });
}
