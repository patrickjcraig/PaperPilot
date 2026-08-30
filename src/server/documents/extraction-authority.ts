import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION } from "./extraction-config";
import {
  MAX_EXTRACTED_CHUNK_BYTES,
  MAX_EXTRACTED_CHUNK_COUNT,
  MAX_EXTRACTED_TEXT_BYTES,
} from "./extraction-contract";
import {
  currentAcceptedValidation,
  type ValidationAuthorityAttestation,
} from "./validation-authority";

const MAX_OPAQUE_ID_BYTES = 200;
const MAX_DURATION_MS = 180_000;
const MAX_JOB_ATTEMPTS = 1_000_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PARAGRAPH_ID_PATTERN = /^p([1-9]\d*)-p([1-9]\d*)$/;
const PROHIBITED_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

export type DocumentExtractionLifecycleState =
  | "unavailable"
  | "not-started"
  | "queued"
  | "extracting"
  | "ready"
  | "no-text"
  | "failed";

export interface DocumentExtractionLifecycle {
  documentId: string;
  state: DocumentExtractionLifecycleState;
  /** Present only for the current, fully admitted ready/no-text generation. */
  extractionId?: string;
  manifestSha256?: string;
}

export interface CurrentExtractionJobPayload {
  schemaVersion: 1;
  source: "accepted-document-validation";
  validationAttestationId: string;
  policyVersion: string;
  storageVersion: string;
  toolchainDigest: string;
}

export interface ExtractionAuthorityChunk {
  id: string;
  sequence: number;
  pageStart: number | null;
  pageEnd: number | null;
  sectionId: string | null;
  sectionTitle: string | null;
  paragraphId: string | null;
  charStart: number | null;
  charEnd: number | null;
  text: string;
  contentHash: string;
  locator: Prisma.JsonValue | null;
}

export interface ExtractionAuthorityGeneration {
  id: string;
  jobId: string;
  jobAttemptId: string;
  validationAttestationId: string;
  assetId: string;
  documentId: string;
  inputSha256: string;
  inputSizeBytes: bigint;
  storageVersion: string;
  extractionPolicyVersion: string;
  toolchainDigest: string;
  verdict: string;
  engine: string;
  engineVersion: string;
  pageCount: number;
  chunkCount: number;
  textBytes: number;
  extractedAt: Date;
  completedAt: Date;
  durationMs: number;
  totalDurationMs: number;
  checkedAt: Date;
  result: Prisma.JsonValue | null;
  job: {
    id: string;
    type: string;
    status: string;
    documentId: string | null;
    assetId: string | null;
  };
  jobAttempt: {
    id: string;
    jobId: string;
    status: string;
  };
  chunks: ExtractionAuthorityChunk[];
}

export type ExtractionAuthorityGenerationEnvelope = Omit<
  ExtractionAuthorityGeneration,
  "chunks"
>;

export interface ExtractionManifestAdmission {
  extractionId: string;
  organizationId: string;
  documentId: string;
  schemaVersion: number;
  verdict: string;
  pageCount: number;
  chunkCount: number;
  textBytes: number;
  manifestSha256: string;
  admittedAt: Date;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validOpaqueId(value: string): boolean {
  return utf8Bytes(value) <= MAX_OPAQUE_ID_BYTES && OPAQUE_ID_PATTERN.test(value);
}

function validDigest(value: string): boolean {
  return SHA256_PATTERN.test(value) && !/^0{64}$/.test(value);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function record(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

/** The current extraction policy used by both unlinked authority and Reader. */
export function authoritativeExtractionPolicyVersion(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment.PAPERPILOT_EXTRACTION_POLICY_VERSION
    ?? DOCUMENT_TEXT_EXTRACTION_POLICY_VERSION;
  if (!POLICY_VERSION_PATTERN.test(value)) {
    throw new Error("PAPERPILOT_EXTRACTION_POLICY_VERSION is invalid for extraction authority.");
  }
  return value;
}

/** Validate the exact immutable binding carried by a current extraction job. */
export function currentExtractionJobPayload(
  value: Prisma.JsonValue | null,
  validation: ValidationAuthorityAttestation,
  policyVersion: string,
): CurrentExtractionJobPayload | null {
  const payload = record(value);
  if (
    !payload
    || !exactKeys(payload, [
      "schemaVersion",
      "source",
      "validationAttestationId",
      "policyVersion",
      "storageVersion",
      "toolchainDigest",
    ])
    || payload.schemaVersion !== 1
    || payload.source !== "accepted-document-validation"
    || payload.validationAttestationId !== validation.id
    || payload.policyVersion !== policyVersion
    || payload.storageVersion !== validation.storageVersion
    || typeof payload.toolchainDigest !== "string"
    || !validDigest(payload.toolchainDigest)
  ) return null;
  return {
    schemaVersion: 1,
    source: "accepted-document-validation",
    validationAttestationId: validation.id,
    policyVersion,
    storageVersion: validation.storageVersion,
    toolchainDigest: payload.toolchainDigest,
  };
}

function extractionResultIsSound(generation: ExtractionAuthorityGenerationEnvelope): boolean {
  const result = record(generation.result);
  return result !== null
    && exactKeys(result, [
      "schemaVersion",
      "engine",
      "engineVersion",
      "extractedAt",
      "completedAt",
      "durationMs",
      "totalDurationMs",
    ])
    && result.schemaVersion === 1
    && result.engine === "poppler"
    && result.engineVersion === generation.engineVersion
    && result.extractedAt === generation.extractedAt.toISOString()
    && result.completedAt === generation.completedAt.toISOString()
    && result.durationMs === generation.durationMs
    && result.totalDurationMs === generation.totalDurationMs;
}

function locatorIsSound(
  value: Prisma.JsonValue | null,
  pageNumber: number,
  paragraphId: string,
): boolean {
  const locator = record(value);
  return locator !== null
    && exactKeys(locator, ["schemaVersion", "kind", "pageNumber", "paragraphId"])
    && locator.schemaVersion === 1
    && locator.kind === "pdf-text"
    && locator.pageNumber === pageNumber
    && locator.paragraphId === paragraphId;
}

/** Validate the immutable generation envelope independently from its chunks. */
export function extractionGenerationIsSound(
  generation: ExtractionAuthorityGenerationEnvelope,
  validation: ValidationAuthorityAttestation & { pageCount: number },
  policyVersion: string,
): boolean {
  return generation.validationAttestationId === validation.id
    && validOpaqueId(generation.id)
    && validOpaqueId(generation.jobId)
    && validOpaqueId(generation.jobAttemptId)
    && validOpaqueId(generation.validationAttestationId)
    && generation.documentId === validation.documentId
    && generation.assetId === validation.assetId
    && generation.inputSha256 === validation.inputSha256
    && generation.inputSizeBytes === validation.inputSizeBytes
    && generation.storageVersion === validation.storageVersion
    && generation.extractionPolicyVersion === policyVersion
    && validDigest(generation.toolchainDigest)
    && generation.engine === "poppler"
    && SAFE_VALUE_PATTERN.test(generation.engineVersion)
    && generation.pageCount === validation.pageCount
    && boundedInteger(generation.chunkCount, 0, MAX_EXTRACTED_CHUNK_COUNT)
    && boundedInteger(generation.textBytes, 0, MAX_EXTRACTED_TEXT_BYTES)
    && validDate(generation.extractedAt)
    && validDate(generation.completedAt)
    && validDate(generation.checkedAt)
    && validation.checkedAt <= generation.extractedAt
    && generation.extractedAt <= generation.completedAt
    && generation.completedAt <= generation.checkedAt
    && boundedInteger(generation.durationMs, 0, MAX_DURATION_MS)
    && boundedInteger(generation.totalDurationMs, generation.durationMs, MAX_DURATION_MS)
    && generation.job.id === generation.jobId
    && generation.job.type === "TEXT_EXTRACTION"
    && generation.job.status === "SUCCEEDED"
    && generation.job.documentId === generation.documentId
    && generation.job.assetId === generation.assetId
    && generation.jobAttempt.id === generation.jobAttemptId
    && generation.jobAttempt.jobId === generation.jobId
    && generation.jobAttempt.status === "SUCCEEDED"
    && extractionResultIsSound(generation);
}

/** Validate the compact PostgreSQL-created proof for one immutable generation. */
export function extractionManifestAdmissionIsSound(
  admission: ExtractionManifestAdmission,
  generation: ExtractionAuthorityGenerationEnvelope,
  organizationId: string,
): boolean {
  return admission.organizationId === organizationId
    && admission.documentId === generation.documentId
    && admission.extractionId === generation.id
    && admission.schemaVersion === 1
    && admission.verdict === generation.verdict
    && admission.pageCount === generation.pageCount
    && admission.chunkCount === generation.chunkCount
    && admission.textBytes === generation.textBytes
    && validDigest(admission.manifestSha256)
    && validDate(admission.admittedAt);
}

function paragraphIdentity(chunk: ExtractionAuthorityChunk): {
  page: number;
  ordinal: number;
} | null {
  if (typeof chunk.paragraphId !== "string" || chunk.paragraphId.length > 64) return null;
  const paragraph = PARAGRAPH_ID_PATTERN.exec(chunk.paragraphId);
  const page = Number(paragraph?.[1]);
  const ordinal = Number(paragraph?.[2]);
  if (
    !paragraph
    || !Number.isSafeInteger(page)
    || !Number.isSafeInteger(ordinal)
    || page !== chunk.pageStart
    || ordinal < 1
    || ordinal > MAX_EXTRACTED_CHUNK_COUNT
  ) return null;
  return { page, ordinal };
}

/** Validate one bounded chunk independently from the rest of the manifest. */
export function extractionChunkIsSound(
  generation: ExtractionAuthorityGenerationEnvelope,
  chunk: ExtractionAuthorityChunk,
): boolean {
  if (
    !boundedInteger(chunk.sequence, 0, generation.chunkCount - 1)
    || !validOpaqueId(chunk.id)
    || !boundedInteger(chunk.pageStart, 1, generation.pageCount)
    || chunk.pageEnd !== chunk.pageStart
    || chunk.sectionId !== null
    || chunk.sectionTitle !== null
    || chunk.charStart !== null
    || chunk.charEnd !== null
  ) return false;
  const paragraph = paragraphIdentity(chunk);
  if (!paragraph) return false;
  const chunkBytes = utf8Bytes(chunk.text);
  return chunk.text.length > 0
    && chunk.text === chunk.text.normalize("NFC")
    && chunk.text === chunk.text.trim()
    && !PROHIBITED_TEXT_PATTERN.test(chunk.text)
    && !/\p{Zs}/u.test(chunk.text.replaceAll(" ", ""))
    && !chunk.text.includes("  ")
    && chunkBytes >= 1
    && chunkBytes <= MAX_EXTRACTED_CHUNK_BYTES
    && createHash("sha256").update(chunk.text, "utf8").digest("hex") === chunk.contentHash
    && locatorIsSound(chunk.locator, chunk.pageStart, chunk.paragraphId as string);
}

/** Validate exact sequence, page, and paragraph continuity for adjacent chunks. */
export function extractionChunkTransitionIsSound(
  previous: ExtractionAuthorityChunk,
  current: ExtractionAuthorityChunk,
): boolean {
  const previousParagraph = paragraphIdentity(previous);
  const currentParagraph = paragraphIdentity(current);
  if (!previousParagraph || !currentParagraph) return false;
  return current.sequence === previous.sequence + 1
    && currentParagraph.page >= previousParagraph.page
    && (
      currentParagraph.page === previousParagraph.page
        ? currentParagraph.ordinal === previousParagraph.ordinal
          || currentParagraph.ordinal === previousParagraph.ordinal + 1
        : currentParagraph.ordinal === 1
    );
}

/** Validate every authoritative chunk and the manifest's exact byte total. */
export function extractionChunksAreSound(
  generation: ExtractionAuthorityGeneration,
): boolean {
  if (generation.chunks.length !== generation.chunkCount) return false;
  if (generation.verdict === "NO_TEXT") {
    return generation.chunkCount === 0 && generation.textBytes === 0;
  }
  if (generation.verdict !== "EXTRACTED" || generation.chunkCount < 1 || generation.textBytes < 1) {
    return false;
  }

  let measuredTextBytes = 0;
  let previousChunk: ExtractionAuthorityChunk | null = null;
  for (let index = 0; index < generation.chunks.length; index += 1) {
    const chunk = generation.chunks[index];
    if (!chunk || chunk.sequence !== index || !extractionChunkIsSound(generation, chunk)) {
      return false;
    }
    const paragraph = paragraphIdentity(chunk);
    if (!paragraph) return false;
    if (
      (index === 0 && paragraph.ordinal !== 1)
      || (previousChunk !== null && !extractionChunkTransitionIsSound(previousChunk, chunk))
    ) return false;
    const chunkBytes = utf8Bytes(chunk.text);
    measuredTextBytes += chunkBytes;
    if (measuredTextBytes > MAX_EXTRACTED_TEXT_BYTES) return false;
    previousChunk = chunk;
  }
  return measuredTextBytes === generation.textBytes;
}

export type ExtractionJobAuthorityState = "queued" | "extracting" | "succeeded" | "failed";

/** Classify a durable extraction job with the same counter rules for every projection. */
export function authoritativeExtractionJobState(
  status: string,
  attempts: number,
  maxAttempts: number,
): ExtractionJobAuthorityState {
  if (
    !boundedInteger(attempts, 0, MAX_JOB_ATTEMPTS)
    || !boundedInteger(maxAttempts, 1, MAX_JOB_ATTEMPTS)
  ) return "failed";
  if (status === "QUEUED") return attempts < maxAttempts ? "queued" : "failed";
  if (status === "RETRYING") {
    return attempts >= 1 && attempts < maxAttempts ? "queued" : "failed";
  }
  if (status === "RUNNING") {
    return attempts >= 1 && attempts <= maxAttempts ? "extracting" : "failed";
  }
  if (status === "SUCCEEDED") {
    return attempts >= 1 && attempts <= maxAttempts ? "succeeded" : "failed";
  }
  return "failed";
}

/**
 * Resolve document-scoped extraction state without granting paper visibility.
 * Callers must first authorize the containing Inbox row. All requested IDs are
 * organization-bound and evaluated by one relational read snapshot.
 */
export async function getDocumentExtractionLifecycles(
  organizationId: string,
  documentIds: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Map<string, DocumentExtractionLifecycle>> {
  const uniqueDocumentIds = [...new Set(documentIds)];
  const output = new Map<string, DocumentExtractionLifecycle>(
    uniqueDocumentIds.map((documentId) => [
      documentId,
      { documentId, state: "unavailable" },
    ]),
  );
  if (uniqueDocumentIds.length === 0) return output;
  const policyVersion = authoritativeExtractionPolicyVersion(environment);
  // Keep the integrity validators importable in non-database unit tests. The
  // database client is needed only by this authorized projection boundary.
  const { prisma } = await import("@/lib/prisma");

  const documents = await prisma.document.findMany({
      where: { organizationId, id: { in: uniqueDocumentIds } },
      select: {
        id: true,
        workspacePaperId: true,
        paperId: true,
        kind: true,
        status: true,
        mimeType: true,
        pageCount: true,
        contentHash: true,
        validatedAt: true,
        validationPolicyVersion: true,
        failureCode: true,
        archivedAt: true,
        assets: {
          where: { role: "ORIGINAL" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 2,
          select: {
            asset: {
              select: {
                id: true,
                storageProvider: true,
                objectKey: true,
                physicalLocator: true,
                status: true,
                mimeType: true,
                sizeBytes: true,
                sha256: true,
                scannedAt: true,
                validatedAt: true,
                validationPolicyVersion: true,
                rejectedReason: true,
                rejectionCode: true,
                deletedAt: true,
              },
            },
          },
        },
        validationAttestations: {
          orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            id: true,
            jobId: true,
            jobAttemptId: true,
            documentId: true,
            assetId: true,
            inputSha256: true,
            inputSizeBytes: true,
            storageVersion: true,
            policyVersion: true,
            toolchainDigest: true,
            verdict: true,
            rejectionCode: true,
            malwareVerdict: true,
            signaturePublishedAt: true,
            scannedAt: true,
            pdfStructuralVerdict: true,
            pageCount: true,
            objectCount: true,
            revisionCount: true,
            checkedAt: true,
            result: true,
            job: {
              select: {
                id: true,
                type: true,
                status: true,
                documentId: true,
                assetId: true,
                attempts: true,
              },
            },
            jobAttempt: {
              select: {
                id: true,
                jobId: true,
                status: true,
                attemptNumber: true,
              },
            },
          },
        },
        jobs: {
          where: {
            type: "TEXT_EXTRACTION",
            payload: { path: ["policyVersion"], equals: policyVersion },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            id: true,
            type: true,
            status: true,
            attempts: true,
            maxAttempts: true,
            payload: true,
            documentId: true,
            assetId: true,
            textExtractions: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 1,
              select: {
                id: true,
                jobId: true,
                jobAttemptId: true,
                validationAttestationId: true,
                assetId: true,
                documentId: true,
                inputSha256: true,
                inputSizeBytes: true,
                storageVersion: true,
                extractionPolicyVersion: true,
                toolchainDigest: true,
                verdict: true,
                engine: true,
                engineVersion: true,
                pageCount: true,
                chunkCount: true,
                textBytes: true,
                extractedAt: true,
                completedAt: true,
                durationMs: true,
                totalDurationMs: true,
                checkedAt: true,
                result: true,
                job: {
                  select: {
                    id: true,
                    type: true,
                    status: true,
                    documentId: true,
                    assetId: true,
                  },
                },
                jobAttempt: { select: { id: true, jobId: true, status: true } },
                manifestAdmission: {
                  select: {
                    extractionId: true,
                    organizationId: true,
                    documentId: true,
                    schemaVersion: true,
                    verdict: true,
                    pageCount: true,
                    chunkCount: true,
                    textBytes: true,
                    manifestSha256: true,
                    admittedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });

  for (const document of documents) {
    const asset = document.assets.length === 1 ? document.assets[0]?.asset : undefined;
    const validation = document.validationAttestations[0];
    if (!asset || !validation || !currentAcceptedValidation(validation, document, asset)) {
      continue;
    }
    const job = document.jobs[0];
    if (!job) {
      output.set(document.id, { documentId: document.id, state: "not-started" });
      continue;
    }
    const payload = currentExtractionJobPayload(job.payload, validation, policyVersion);
    const jobState = authoritativeExtractionJobState(
      job.status,
      job.attempts,
      job.maxAttempts,
    );
    if (
      !payload
      || !validOpaqueId(job.id)
      || job.type !== "TEXT_EXTRACTION"
      || job.documentId !== document.id
      || job.assetId !== asset.id
      || jobState === "failed"
    ) {
      output.set(document.id, { documentId: document.id, state: "failed" });
      continue;
    }
    if (jobState === "queued") {
      output.set(document.id, { documentId: document.id, state: "queued" });
      continue;
    }
    if (jobState === "extracting") {
      output.set(document.id, { documentId: document.id, state: "extracting" });
      continue;
    }
    if (jobState !== "succeeded") {
      output.set(document.id, { documentId: document.id, state: "failed" });
      continue;
    }
    const generation = job.textExtractions[0];
    if (
      !generation
      || generation.validationAttestationId !== validation.id
      || generation.jobId !== job.id
      || generation.toolchainDigest !== payload.toolchainDigest
      || !extractionGenerationIsSound(generation, validation, policyVersion)
      || !generation.manifestAdmission
      || !extractionManifestAdmissionIsSound(
        generation.manifestAdmission,
        generation,
        organizationId,
      )
    ) {
      output.set(document.id, { documentId: document.id, state: "failed" });
      continue;
    }
    output.set(document.id, {
      documentId: document.id,
      state: generation.verdict === "NO_TEXT" ? "no-text" : "ready",
      extractionId: generation.id,
      manifestSha256: generation.manifestAdmission.manifestSha256,
    });
  }
  return output;
}
