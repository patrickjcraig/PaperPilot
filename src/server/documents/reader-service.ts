import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { projectVisibleTo } from "@/server/workspaces/project-access";
import {
  authoritativeExtractionPolicyVersion,
  authoritativeExtractionJobState,
  currentExtractionJobPayload,
  extractionChunkIsSound,
  extractionChunkTransitionIsSound,
  extractionGenerationIsSound,
  extractionManifestAdmissionIsSound,
  type ExtractionAuthorityChunk,
  type ExtractionAuthorityGenerationEnvelope,
  type ExtractionManifestAdmission,
} from "./extraction-authority";
import {
  MAX_READER_CURSOR_BYTES,
  ReaderCursorCodec,
  type ReaderCursorClaims,
  type ReaderCursorSubject,
} from "./reader-cursor";
import {
  currentAcceptedValidation,
  type ValidationAuthorityAsset,
  type ValidationAuthorityAttestation,
  type ValidationAuthorityDocument,
} from "./validation-authority";

export const DEFAULT_READER_PAGE_LIMIT = 50;
export const MAX_READER_PAGE_LIMIT = 100;
export const MAX_READER_SERIALIZED_BYTES = 800 * 1_024;

const MAX_OPAQUE_ID_BYTES = 200;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const READER_CURSOR_PATTERN = /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const CANONICAL_LIMIT_PATTERN = /^[1-9]\d*$/;

export interface ReaderPageQuery {
  cursor: string | null;
  limit: number;
}

export interface ReaderDocumentMetadata {
  id: string;
  workspacePaperId: string;
  paperId: string;
  assetId: string;
  inputSha256: string;
  inputSizeBytes: string;
  pageCount: number;
  validationAttestationId: string;
  validationPolicyVersion: string;
  validatedAt: string;
}

export interface ReaderExtractionGenerationMetadata {
  id: string;
  validationAttestationId: string;
  manifestSchemaVersion: 1;
  manifestSha256: string;
  admittedAt: string;
  policyVersion: string;
  toolchainDigest: string;
  engine: "poppler";
  engineVersion: string;
  verdict: "EXTRACTED" | "NO_TEXT";
  pageCount: number;
  chunkCount: number;
  textBytes: number;
  extractedAt: string;
  completedAt: string;
  checkedAt: string;
}

export interface ReaderChunkLocator {
  schemaVersion: 1;
  kind: "pdf-text";
  pageNumber: number;
  paragraphId: string;
}

export interface ReaderTextChunk {
  id: string;
  sequence: number;
  contentHash: string;
  pageNumber: number;
  paragraphId: string;
  text: string;
  locator: ReaderChunkLocator;
}

export type WorkspacePaperReaderDto =
  | {
      schemaVersion: 1;
      state: "unavailable";
    }
  | {
      schemaVersion: 1;
      state: "processing";
      document: ReaderDocumentMetadata;
      extractionPolicyVersion: string;
    }
  | {
      schemaVersion: 1;
      state: "no-text";
      document: ReaderDocumentMetadata;
      generation: ReaderExtractionGenerationMetadata;
    }
  | {
      schemaVersion: 1;
      state: "ready";
      document: ReaderDocumentMetadata;
      generation: ReaderExtractionGenerationMetadata;
      chunks: ReaderTextChunk[];
      nextCursor: string | null;
    };

type SelectedAsset = ValidationAuthorityAsset;

interface SelectedDocument extends ValidationAuthorityDocument {
  assets: Array<{ asset: SelectedAsset }>;
}

type SelectedValidation = ValidationAuthorityAttestation;

interface SelectedExtractionJob {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  payload: Prisma.JsonValue | null;
}

type SelectedGeneration = ExtractionAuthorityGenerationEnvelope & {
  manifestAdmission: ExtractionManifestAdmission | null;
};

interface ReadyReaderMaterial {
  state: "ready-material";
  document: ReaderDocumentMetadata;
  generation: ReaderExtractionGenerationMetadata;
  chunks: ReaderTextChunk[];
  startSequence: number;
  subject: ReaderCursorSubject;
}

function unavailable(): WorkspacePaperReaderDto {
  return { schemaVersion: 1, state: "unavailable" };
}

function paperNotFound(): HttpProblem {
  return new HttpProblem(404, "paper_not_found", "Paper was not found.");
}

function queryInvalid(): HttpProblem {
  return new HttpProblem(400, "validation", "Reader query parameters are invalid.");
}

function cursorStale(): HttpProblem {
  return new HttpProblem(
    409,
    "reader_cursor_stale",
    "The Reader source changed while this paper was being paginated. Refresh the paper.",
  );
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validOpaqueId(value: string): boolean {
  return utf8Bytes(value) <= MAX_OPAQUE_ID_BYTES && OPAQUE_ID_PATTERN.test(value);
}

function validateBoundedChunks(
  generation: ExtractionAuthorityGenerationEnvelope,
  chunks: ExtractionAuthorityChunk[],
  queryStart: number,
  startSequence: number,
): ReaderTextChunk[] | null {
  const output: ReaderTextChunk[] = [];
  let previous: ExtractionAuthorityChunk | null = null;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (
      !chunk
      || chunk.sequence !== queryStart + index
      || !extractionChunkIsSound(generation, chunk)
      || (previous !== null && !extractionChunkTransitionIsSound(previous, chunk))
      || (
        chunk.sequence === 0
        && chunk.paragraphId !== `p${chunk.pageStart}-p1`
      )
    ) return null;
    previous = chunk;
    if (chunk.sequence < startSequence) continue;
    if (chunk.pageStart === null || chunk.paragraphId === null) return null;
    output.push({
      id: chunk.id,
      sequence: chunk.sequence,
      contentHash: chunk.contentHash,
      pageNumber: chunk.pageStart,
      paragraphId: chunk.paragraphId,
      text: chunk.text,
      locator: {
        schemaVersion: 1,
        kind: "pdf-text",
        pageNumber: chunk.pageStart,
        paragraphId: chunk.paragraphId,
      },
    });
  }
  return output;
}

function documentMetadata(
  document: SelectedDocument,
  asset: SelectedAsset,
  validation: SelectedValidation & { pageCount: number },
): ReaderDocumentMetadata {
  if (!document.workspacePaperId || !document.paperId) throw new Error("Reader document binding failed.");
  return {
    id: document.id,
    workspacePaperId: document.workspacePaperId,
    paperId: document.paperId,
    assetId: asset.id,
    inputSha256: validation.inputSha256,
    inputSizeBytes: validation.inputSizeBytes.toString(),
    pageCount: validation.pageCount,
    validationAttestationId: validation.id,
    validationPolicyVersion: validation.policyVersion,
    validatedAt: validation.checkedAt.toISOString(),
  };
}

function generationMetadata(
  generation: SelectedGeneration,
): ReaderExtractionGenerationMetadata {
  if (generation.verdict !== "EXTRACTED" && generation.verdict !== "NO_TEXT") {
    throw new Error("Reader extraction verdict failed validation.");
  }
  const admission = generation.manifestAdmission;
  if (!admission || admission.schemaVersion !== 1) {
    throw new Error("Reader manifest admission failed validation.");
  }
  return {
    id: generation.id,
    validationAttestationId: generation.validationAttestationId,
    manifestSchemaVersion: 1,
    manifestSha256: admission.manifestSha256,
    admittedAt: admission.admittedAt.toISOString(),
    policyVersion: generation.extractionPolicyVersion,
    toolchainDigest: generation.toolchainDigest,
    engine: "poppler",
    engineVersion: generation.engineVersion,
    verdict: generation.verdict,
    pageCount: generation.pageCount,
    chunkCount: generation.chunkCount,
    textBytes: generation.textBytes,
    extractedAt: generation.extractedAt.toISOString(),
    completedAt: generation.completedAt.toISOString(),
    checkedAt: generation.checkedAt.toISOString(),
  };
}

function boundedReadyPage(input: {
  document: ReaderDocumentMetadata;
  generation: ReaderExtractionGenerationMetadata;
  chunks: ReaderTextChunk[];
  startSequence: number;
  subject: ReaderCursorSubject;
  cursorCodec: ReaderCursorCodec;
}): WorkspacePaperReaderDto {
  const candidate = (count: number): Extract<WorkspacePaperReaderDto, { state: "ready" }> => {
    const end = input.startSequence + count;
    return {
      schemaVersion: 1,
      state: "ready",
      document: input.document,
      generation: input.generation,
      chunks: input.chunks.slice(0, count),
      nextCursor: end < input.generation.chunkCount
        ? input.cursorCodec.issue(input.subject, {
          generationId: input.generation.id,
          nextSequence: end,
        })
        : null,
    };
  };
  const fullPage = candidate(input.chunks.length);
  if (Buffer.byteLength(JSON.stringify(fullPage), "utf8") <= MAX_READER_SERIALIZED_BYTES) {
    return fullPage;
  }

  let lower = 1;
  let upper = input.chunks.length - 1;
  let boundedPage: Extract<WorkspacePaperReaderDto, { state: "ready" }> | null = null;
  while (lower <= upper) {
    const count = Math.floor((lower + upper) / 2);
    const page = candidate(count);
    if (Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_READER_SERIALIZED_BYTES) {
      boundedPage = page;
      lower = count + 1;
    } else {
      upper = count - 1;
    }
  }
  if (!boundedPage) {
    throw new Error("A bounded reader page exceeded its serialized response limit.");
  }
  return boundedPage;
}

export function readerExtractionPolicyVersion(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return authoritativeExtractionPolicyVersion(environment);
}

export function readerCursorCodec(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReaderCursorCodec {
  const secret = environment.PAPERPILOT_READER_CURSOR_SECRET
    ?? environment.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "PAPERPILOT_READER_CURSOR_SECRET or BETTER_AUTH_SECRET is required for Reader pagination.",
    );
  }
  return new ReaderCursorCodec({ secret });
}

export function parseReaderPageQuery(searchParams: URLSearchParams): ReaderPageQuery {
  const keys = [...searchParams.keys()];
  if (
    keys.some((key) => key !== "cursor" && key !== "limit")
    || searchParams.getAll("cursor").length > 1
    || searchParams.getAll("limit").length > 1
  ) throw queryInvalid();
  const rawCursor = searchParams.get("cursor");
  const rawLimit = searchParams.get("limit");
  if (
    rawCursor !== null
    && (
      Buffer.byteLength(rawCursor, "utf8") > MAX_READER_CURSOR_BYTES
      || !READER_CURSOR_PATTERN.test(rawCursor)
    )
  ) throw queryInvalid();
  if (rawLimit !== null && !CANONICAL_LIMIT_PATTERN.test(rawLimit)) throw queryInvalid();
  const limit = rawLimit === null ? DEFAULT_READER_PAGE_LIMIT : Number(rawLimit);
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_READER_PAGE_LIMIT
  ) throw queryInvalid();
  return { cursor: rawCursor, limit };
}

export async function getWorkspacePaperReader(
  userId: string,
  workspaceId: string,
  paperId: string,
  searchParams: URLSearchParams = new URLSearchParams(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<WorkspacePaperReaderDto> {
  if (!validOpaqueId(userId) || !validOpaqueId(workspaceId) || !validOpaqueId(paperId)) {
    throw paperNotFound();
  }
  const query = parseReaderPageQuery(searchParams);
  const policyVersion = readerExtractionPolicyVersion(environment);
  const cursorCodec = readerCursorCodec(environment);

  const resolution = await prisma.$transaction(async (
    transaction,
  ): Promise<WorkspacePaperReaderDto | ReadyReaderMaterial> => {
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId } },
      select: { id: true },
    });
    if (!membership) throw paperNotFound();

    const workspacePaper = await transaction.workspacePaper.findFirst({
      where: {
        organizationId: workspaceId,
        paperId,
        OR: [
          { projectPapers: { none: {} } },
          { projectPapers: { some: { project: projectVisibleTo(userId) } } },
        ],
      },
      select: { id: true, paperId: true },
    });
    if (!workspacePaper) throw paperNotFound();
    const subject: ReaderCursorSubject = { userId, workspaceId, paperId };
    const cursorClaims: ReaderCursorClaims | null = query.cursor === null
      ? null
      : cursorCodec.verify(query.cursor, subject);

    const document = await transaction.document.findFirst({
      where: {
        organizationId: workspaceId,
        workspacePaperId: workspacePaper.id,
        paperId: workspacePaper.paperId,
        kind: "PAPER_PDF",
        status: "READY",
        archivedAt: null,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      },
    }) as SelectedDocument | null;
    const asset = document?.assets.length === 1 ? document.assets[0]?.asset : undefined;
    if (!document || !asset || asset.status !== "READY" || asset.deletedAt !== null) {
      if (cursorClaims) throw cursorStale();
      return unavailable();
    }

    const validation = await transaction.documentValidationAttestation.findFirst({
      where: {
        organizationId: workspaceId,
        documentId: document.id,
        assetId: asset.id,
      },
      orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
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
        jobAttempt: { select: { id: true, jobId: true, status: true, attemptNumber: true } },
      },
    }) as SelectedValidation | null;
    if (
      !validation
      || !currentAcceptedValidation(validation, document, asset, { requireLinkedPaper: true })
    ) {
      if (cursorClaims) throw cursorStale();
      return unavailable();
    }
    const authoritativeDocument = documentMetadata(document, asset, validation);

    const extractionJob = await transaction.job.findFirst({
      where: {
        organizationId: workspaceId,
        documentId: document.id,
        assetId: asset.id,
        type: "TEXT_EXTRACTION",
        payload: { path: ["policyVersion"], equals: policyVersion },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        payload: true,
      },
    }) as SelectedExtractionJob | null;
    const extractionJobPayload = extractionJob
      ? currentExtractionJobPayload(extractionJob.payload, validation, policyVersion)
      : null;
    if (!extractionJob || !extractionJobPayload || !validOpaqueId(extractionJob.id)) {
      if (cursorClaims) throw cursorStale();
      return unavailable();
    }
    const extractionJobState = authoritativeExtractionJobState(
      extractionJob.status,
      extractionJob.attempts,
      extractionJob.maxAttempts,
    );
    if (extractionJobState === "queued" || extractionJobState === "extracting") {
      if (cursorClaims) throw cursorStale();
      return {
        schemaVersion: 1,
        state: "processing",
        document: authoritativeDocument,
        extractionPolicyVersion: policyVersion,
      };
    }
    if (extractionJobState !== "succeeded") {
      if (cursorClaims) throw cursorStale();
      return unavailable();
    }

    const generation = await transaction.documentTextExtraction.findFirst({
      where: {
        organizationId: workspaceId,
        documentId: document.id,
        assetId: asset.id,
        jobId: extractionJob.id,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
        job: { select: { id: true, type: true, status: true, documentId: true, assetId: true } },
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
    }) as SelectedGeneration | null;
    if (
      !generation
      || generation.validationAttestationId !== validation.id
      || generation.jobId !== extractionJob.id
      || generation.toolchainDigest !== extractionJobPayload.toolchainDigest
      || !extractionGenerationIsSound(generation, validation, policyVersion)
      || !generation.manifestAdmission
      || !extractionManifestAdmissionIsSound(
        generation.manifestAdmission,
        generation,
        workspaceId,
      )
    ) {
      if (cursorClaims && (!generation || generation.id !== cursorClaims.generationId)) {
        throw cursorStale();
      }
      return unavailable();
    }
    const authoritativeGeneration = generationMetadata(generation);
    if (generation.verdict === "NO_TEXT") {
      if (cursorClaims) throw cursorStale();
      return {
        schemaVersion: 1,
        state: "no-text",
        document: authoritativeDocument,
        generation: authoritativeGeneration,
      };
    }
    if (generation.verdict !== "EXTRACTED") return unavailable();
    if (cursorClaims && cursorClaims.generationId !== generation.id) {
      throw cursorStale();
    }
    const startSequence = cursorClaims?.nextSequence ?? 0;
    if (startSequence < 0 || startSequence >= generation.chunkCount) {
      throw queryInvalid();
    }
    const requestedCount = Math.min(query.limit, generation.chunkCount - startSequence);
    const predecessorCount = startSequence === 0 ? 0 : 1;
    const queryStart = startSequence - predecessorCount;
    const selectedChunks = await transaction.documentTextChunk.findMany({
      where: {
        organizationId: workspaceId,
        documentId: generation.documentId,
        extractionId: generation.id,
        sequence: { gte: queryStart },
      },
      orderBy: { sequence: "asc" },
      take: requestedCount + predecessorCount,
      select: {
        id: true,
        sequence: true,
        pageStart: true,
        pageEnd: true,
        sectionId: true,
        sectionTitle: true,
        paragraphId: true,
        charStart: true,
        charEnd: true,
        text: true,
        contentHash: true,
        locator: true,
      },
    });
    if (selectedChunks.length !== requestedCount + predecessorCount) {
      return unavailable();
    }
    const chunks = validateBoundedChunks(
      generation,
      selectedChunks,
      queryStart,
      startSequence,
    );
    if (chunks === null || chunks.length !== requestedCount) return unavailable();
    return {
      state: "ready-material",
      document: authoritativeDocument,
      generation: authoritativeGeneration,
      chunks,
      startSequence,
      subject,
    } satisfies ReadyReaderMaterial;
  }, { isolationLevel: "RepeatableRead" });

  if (resolution.state !== "ready-material") return resolution;
  return boundedReadyPage({
    document: resolution.document,
    generation: resolution.generation,
    chunks: resolution.chunks,
    startSequence: resolution.startSequence,
    subject: resolution.subject,
    cursorCodec,
  });
}
