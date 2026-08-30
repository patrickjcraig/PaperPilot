import "server-only";

import { createHash } from "node:crypto";
import type {
  CaptureGroundedEvidenceCommand,
  CaptureGroundedEvidenceResponse,
  CaptureGroundedEvidenceResult,
  GroundedEvidenceFailureCode,
  GroundedEvidenceSelection,
} from "@/lib/workspace/contracts";
import type { GroundedEvidenceAnchor } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authoritativeExtractionJobState,
  authoritativeExtractionPolicyVersion,
  currentExtractionJobPayload,
  extractionChunkIsSound,
  extractionChunkTransitionIsSound,
  extractionGenerationIsSound,
  extractionManifestAdmissionIsSound,
  type ExtractionAuthorityChunk,
  type ExtractionAuthorityGenerationEnvelope,
  type ExtractionManifestAdmission,
} from "@/server/documents/extraction-authority";
import {
  currentAcceptedValidation,
  type ValidationAuthorityAsset,
  type ValidationAuthorityAttestation,
  type ValidationAuthorityDocument,
} from "@/server/documents/validation-authority";
import { HttpProblem } from "@/server/http/problem";
import { requireWorkspaceMembership } from "./authorization";
import { acquireWorkspaceMembershipAuthorityShared } from "./membership-lock";
import {
  projectVisibleTo,
  requireWorkspaceMutationRole,
} from "./project-access";
import { hydrateGroundedEvidenceResponse } from "./evidence-revision-read";
import { evidenceNoteDto, standaloneEvidenceRevision } from "./service";

export const MAX_GROUNDED_EVIDENCE_COMMAND_BYTES = 128 * 1024;

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^(?!0{64})[0-9a-f]{64}$/;
const PARAGRAPH_ID_PATTERN = /^p[1-9]\d*-p[1-9]\d*$/;
const MAX_SEQUENCE = 4_095;
const MAX_SEQUENCE_SPAN = 99;
const MAX_START_BYTE_OFFSET = 8_191;
const MAX_END_BYTE_OFFSET = 8_192;
const MAX_QUOTE_CHARACTERS = 50_000;
// Public capture is intentionally tighter than the database's 200 kB defense-
// in-depth ceiling so one note remains cheap to render, sync, and replay.
const MAX_QUOTE_BYTES = 50_000;

const COMMAND_KEYS = new Set([
  "clientOperationId",
  "expectedVersion",
  "projectId",
  "collectionIds",
  "note",
  "selection",
]);
const NOTE_KEYS = new Set([
  "kind",
  "title",
  "claim",
  "interpretation",
  "openQuestion",
  "confidence",
  "tags",
]);
const SELECTION_KEYS = new Set([
  "documentId",
  "extractionId",
  "manifestSha256",
  "start",
  "end",
  "expectedQuoteSha256",
]);
const BOUNDARY_KEYS = new Set(["chunkId", "sequence", "byteOffset", "contentHash"]);
const NOTE_KINDS = new Set(["direct-evidence", "interpretation", "open-question"]);
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low", "unspecified"]);

interface SessionUser {
  id: string;
  name: string;
}

interface SelectedDocument extends ValidationAuthorityDocument {
  assets: Array<{ asset: ValidationAuthorityAsset }>;
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

interface GroundingChunk extends ExtractionAuthorityChunk {
  pageStart: number;
  pageEnd: number;
  paragraphId: string;
}

interface ReconstructedGrounding {
  quoteText: string;
  quoteSha256: string;
  pageStart: number;
  pageEnd: number;
  paragraphStartId: string;
  paragraphEndId: string;
}

/**
 * The complete server-authoritative result of resolving one Reader selection.
 * Revision commands consume this boundary as well as first-time capture so a
 * re-anchor cannot drift onto a weaker source-validation path.
 */
export interface ResolvedGroundedEvidenceSelection {
  document: SelectedDocument;
  generation: SelectedGeneration;
  chunks: readonly GroundingChunk[];
  firstChunk: GroundingChunk;
  lastChunk: GroundingChunk;
  reconstruction: ReconstructedGrounding;
}

function invalid(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function asRecord(
  value: unknown,
  label: string,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).find((key) => !allowed.has(key));
  if (unsupported) invalid(`${label} contains an unsupported field: ${unsupported}.`);
  return record;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") invalid(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    invalid(`${label} must contain 1 to ${maximum.toLocaleString()} characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${label} must be text when provided.`);
  const normalized = value.trim();
  if (normalized.length > maximum) {
    invalid(`${label} may contain at most ${maximum.toLocaleString()} characters.`);
  }
  return normalized || undefined;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    invalid(`${label} must be a valid opaque identifier.`);
  }
  return value;
}

function digestValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function stringList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
  identifiers = false,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    invalid(`${label} must be an array containing at most ${maximumItems} values.`);
  }
  const normalized = value.map((entry, index) => identifiers
    ? opaqueId(entry, `${label}[${index}]`)
    : requiredText(entry, `${label}[${index}]`, maximumLength));
  if (new Set(normalized).size !== normalized.length) {
    invalid(`${label} must not contain duplicate values.`);
  }
  return normalized;
}

function boundary(
  value: unknown,
  label: "selection.start" | "selection.end",
  offsetMaximum: number,
) {
  const record = asRecord(value, label, BOUNDARY_KEYS);
  return {
    chunkId: opaqueId(record.chunkId, `${label}.chunkId`),
    sequence: boundedInteger(record.sequence, `${label}.sequence`, 0, MAX_SEQUENCE),
    byteOffset: boundedInteger(record.byteOffset, `${label}.byteOffset`, 0, offsetMaximum),
    contentHash: digestValue(record.contentHash, `${label}.contentHash`),
  };
}

export function validateCaptureGroundedEvidenceCommand(
  raw: unknown,
): CaptureGroundedEvidenceCommand {
  const record = asRecord(raw, "Grounded evidence command", COMMAND_KEYS);
  const note = asRecord(record.note, "note", NOTE_KEYS);
  const selection = asRecord(record.selection, "selection", SELECTION_KEYS);
  const kind = note.kind;
  const confidence = note.confidence;
  if (typeof kind !== "string" || !NOTE_KINDS.has(kind)) invalid("note.kind is invalid.");
  if (typeof confidence !== "string" || !CONFIDENCE_LEVELS.has(confidence)) {
    invalid("note.confidence is invalid.");
  }
  const expectedVersion = boundedInteger(
    record.expectedVersion,
    "expectedVersion",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const start = boundary(selection.start, "selection.start", MAX_START_BYTE_OFFSET);
  const end = boundary(selection.end, "selection.end", MAX_END_BYTE_OFFSET);
  if (end.byteOffset < 1) invalid("selection.end.byteOffset must be at least 1.");
  if (end.sequence < start.sequence || end.sequence - start.sequence > MAX_SEQUENCE_SPAN) {
    invalid("selection must cover one ordered range of at most 100 contiguous chunks.");
  }
  if (start.sequence === end.sequence) {
    if (start.chunkId !== end.chunkId || start.contentHash !== end.contentHash) {
      invalid("A single-chunk selection must use one exact chunk identity.");
    }
    if (end.byteOffset <= start.byteOffset) {
      invalid("A grounded evidence selection cannot be empty.");
    }
  }
  return {
    clientOperationId: requiredText(record.clientOperationId, "clientOperationId", 200),
    expectedVersion,
    projectId: opaqueId(record.projectId, "projectId"),
    collectionIds: stringList(record.collectionIds, "collectionIds", 50, 200, true),
    note: {
      kind: kind as CaptureGroundedEvidenceCommand["note"]["kind"],
      title: requiredText(note.title, "note.title", 200),
      claim: requiredText(note.claim, "note.claim", 20_000),
      interpretation: requiredText(note.interpretation, "note.interpretation", 20_000),
      openQuestion: optionalText(note.openQuestion, "note.openQuestion", 10_000),
      confidence: confidence as CaptureGroundedEvidenceCommand["note"]["confidence"],
      tags: stringList(note.tags, "note.tags", 50, 100),
    },
    selection: {
      documentId: opaqueId(selection.documentId, "selection.documentId"),
      extractionId: opaqueId(selection.extractionId, "selection.extractionId"),
      manifestSha256: digestValue(selection.manifestSha256, "selection.manifestSha256"),
      start,
      end,
      expectedQuoteSha256: digestValue(
        selection.expectedQuoteSha256,
        "selection.expectedQuoteSha256",
      ),
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandHash(paperId: string, command: CaptureGroundedEvidenceCommand): string {
  return sha256(stableJson({
    command: "captureGroundedEvidence",
    paperId,
    projectId: command.projectId,
    collectionIds: command.collectionIds,
    note: command.note,
    selection: command.selection,
  }));
}

function failure(
  code: GroundedEvidenceFailureCode,
  aggregateVersion: number,
  message: string,
): CaptureGroundedEvidenceResponse {
  return { ok: false, code, aggregateVersion, message };
}

function replayed(
  response: unknown,
  aggregateVersion: number,
): CaptureGroundedEvidenceResponse | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const candidate = response as { ok?: unknown; data?: CaptureGroundedEvidenceResult };
  if (candidate.ok !== true || !candidate.data?.note?.id || !candidate.data.grounding) return null;
  return { ok: true, outcome: "replayed", aggregateVersion, data: candidate.data };
}

async function lockOperation(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  operationId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${operationId}`}, 0))::text
  `;
}

async function saveReceipt(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    operationId: string;
    hash: string;
    result: CaptureGroundedEvidenceResponse;
  },
): Promise<void> {
  await transaction.idempotencyRecord.create({
    data: {
      organizationId: input.workspaceId,
      actorUserId: input.userId,
      key: input.operationId,
      command: "captureGroundedEvidence",
      requestHash: input.hash,
      response: JSON.parse(JSON.stringify(input.result)) as Prisma.InputJsonValue,
      status: "COMPLETED",
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    },
  });
}

async function bumpRevision(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  expectedVersion: number,
): Promise<boolean> {
  const bumped = await transaction.organization.updateMany({
    where: { id: workspaceId, revision: expectedVersion },
    data: { revision: { increment: 1 } },
  });
  return bumped.count === 1;
}

async function currentGroundingGeneration(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  workspacePaperId: string,
  paperId: string,
  selection: GroundedEvidenceSelection,
): Promise<{ document: SelectedDocument; generation: SelectedGeneration } | null> {
  const policyVersion = authoritativeExtractionPolicyVersion();
  const document = await transaction.document.findFirst({
    where: {
      organizationId: workspaceId,
      workspacePaperId,
      paperId,
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
  if (!document || document.id !== selection.documentId || !asset) return null;

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
      jobAttempt: {
        select: {
          id: true,
          jobId: true,
          status: true,
          attemptNumber: true,
        },
      },
    },
  }) as SelectedValidation | null;
  if (!validation || !currentAcceptedValidation(validation, document, asset, { requireLinkedPaper: true })) {
    return null;
  }

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
  if (!extractionJob) return null;
  const jobPayload = currentExtractionJobPayload(
    extractionJob.payload,
    validation,
    policyVersion,
  );
  if (
    !jobPayload
    || authoritativeExtractionJobState(
      extractionJob.status,
      extractionJob.attempts,
      extractionJob.maxAttempts,
    ) !== "succeeded"
  ) return null;

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
    || generation.id !== selection.extractionId
    || generation.verdict !== "EXTRACTED"
    || generation.validationAttestationId !== validation.id
    || generation.jobId !== extractionJob.id
    || generation.toolchainDigest !== jobPayload.toolchainDigest
    || !extractionGenerationIsSound(generation, validation, policyVersion)
    || !generation.manifestAdmission
    || generation.manifestAdmission.schemaVersion !== 1
    || generation.manifestAdmission.manifestSha256 !== selection.manifestSha256
    || !extractionManifestAdmissionIsSound(
      generation.manifestAdmission,
      generation,
      workspaceId,
    )
  ) return null;
  return { document, generation };
}

function exactUtf8Slice(text: string, start: number, end: number): string {
  const source = Buffer.from(text, "utf8");
  if (start < 0 || end <= start || end > source.length) {
    throw new HttpProblem(409, "selection_conflict", "The Reader selection is no longer valid.");
  }
  const selected = source.subarray(start, end);
  const decoded = selected.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(selected)) {
    throw new HttpProblem(
      409,
      "selection_conflict",
      "The Reader selection splits a UTF-8 character boundary.",
    );
  }
  return decoded;
}

export function reconstructGroundedEvidenceQuote(
  chunks: readonly GroundingChunk[],
  selection: GroundedEvidenceSelection,
): ReconstructedGrounding {
  const expectedCount = selection.end.sequence - selection.start.sequence + 1;
  if (chunks.length !== expectedCount || expectedCount < 1 || expectedCount > 100) {
    throw new HttpProblem(409, "selection_conflict", "The Reader selection is no longer available.");
  }
  const excerpts: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk || chunk.sequence !== selection.start.sequence + index) {
      throw new HttpProblem(409, "selection_conflict", "The Reader selection is not contiguous.");
    }
    const byteLength = Buffer.byteLength(chunk.text, "utf8");
    const start = index === 0 ? selection.start.byteOffset : 0;
    const end = index === chunks.length - 1 ? selection.end.byteOffset : byteLength;
    excerpts.push(exactUtf8Slice(chunk.text, start, end));
  }
  const quoteText = excerpts.join("\n\n");
  const quoteBytes = Buffer.byteLength(quoteText, "utf8");
  if (
    quoteText.length < 1
    || quoteText.length > MAX_QUOTE_CHARACTERS
    || quoteBytes < 1
    || quoteBytes > MAX_QUOTE_BYTES
  ) {
    throw new HttpProblem(409, "selection_conflict", "The Reader selection is too large to capture.");
  }
  const quoteSha256 = sha256(Buffer.from(quoteText, "utf8"));
  if (quoteSha256 !== selection.expectedQuoteSha256) {
    throw new HttpProblem(
      409,
      "selection_conflict",
      "The Reader selection changed before it could be captured.",
    );
  }
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (
    !first
    || !last
    || first.pageStart < 1
    || last.pageEnd < first.pageStart
    || !PARAGRAPH_ID_PATTERN.test(first.paragraphId)
    || !PARAGRAPH_ID_PATTERN.test(last.paragraphId)
  ) {
    throw new HttpProblem(409, "selection_conflict", "The Reader locators are no longer valid.");
  }
  return {
    quoteText,
    quoteSha256,
    pageStart: first.pageStart,
    pageEnd: last.pageEnd,
    paragraphStartId: first.paragraphId,
    paragraphEndId: last.paragraphId,
  };
}

export async function resolveCurrentGroundedEvidenceSelection(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  workspacePaperId: string,
  paperId: string,
  selection: GroundedEvidenceSelection,
): Promise<ResolvedGroundedEvidenceSelection> {
  const source = await currentGroundingGeneration(
    transaction,
    workspaceId,
    workspacePaperId,
    paperId,
    selection,
  );
  if (!source) {
    throw new HttpProblem(
      409,
      "selection_conflict",
      "The Reader source changed. Refresh the paper and select the excerpt again.",
    );
  }

  const chunks = await transaction.documentTextChunk.findMany({
    where: {
      organizationId: workspaceId,
      documentId: source.document.id,
      extractionId: source.generation.id,
      sequence: {
        gte: selection.start.sequence,
        lte: selection.end.sequence,
      },
    },
    orderBy: { sequence: "asc" },
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
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  let previous: ExtractionAuthorityChunk | null = null;
  const chunksAreSound = chunks.every((chunk) => {
    const sound = extractionChunkIsSound(source.generation, chunk)
      && (previous === null || extractionChunkTransitionIsSound(previous, chunk));
    previous = chunk;
    return sound;
  });
  if (
    !chunksAreSound
    || chunks.length !== selection.end.sequence - selection.start.sequence + 1
    || !first
    || !last
    || first.id !== selection.start.chunkId
    || first.sequence !== selection.start.sequence
    || first.contentHash !== selection.start.contentHash
    || last.id !== selection.end.chunkId
    || last.sequence !== selection.end.sequence
    || last.contentHash !== selection.end.contentHash
    || first.pageStart === null
    || first.pageEnd === null
    || first.paragraphId === null
    || last.pageStart === null
    || last.pageEnd === null
    || last.paragraphId === null
  ) {
    throw new HttpProblem(
      409,
      "selection_conflict",
      "The Reader selection no longer matches its admitted text chunks.",
    );
  }

  return {
    document: source.document,
    generation: source.generation,
    chunks: chunks as GroundingChunk[],
    firstChunk: first as GroundingChunk,
    lastChunk: last as GroundingChunk,
    reconstruction: reconstructGroundedEvidenceQuote(chunks as GroundingChunk[], selection),
  };
}

const DATABASE_KIND = {
  "direct-evidence": "QUOTE",
  interpretation: "NOTE",
  "open-question": "QUESTION",
} as const;
const DATABASE_CONFIDENCE = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  unspecified: "UNSPECIFIED",
} as const;

function createdEvidenceInclude(
  workspaceId: string,
  userId: string,
) {
  return {
    workspacePaper: { select: { paperId: true } },
    provenanceRecords: {
      where: { organizationId: workspaceId },
      orderBy: { createdAt: "asc" as const },
    },
    collectionMemberships: {
      where: {
        organizationId: workspaceId,
        collection: {
          organizationId: workspaceId,
          OR: [
            { projectId: null },
            { project: { organizationId: workspaceId, ...projectVisibleTo(userId) } },
          ],
        },
      },
      select: { collectionId: true },
    },
    projectMemberships: {
      where: { organizationId: workspaceId },
      include: { project: { select: { visibility: true, createdById: true } } },
    },
    project: { select: { visibility: true, createdById: true } },
    textAnchor: true,
  } satisfies Prisma.EvidenceNoteInclude;
}

function groundingDto(
  selection: GroundedEvidenceSelection,
  reconstruction: ReconstructedGrounding,
): GroundedEvidenceAnchor & { state: "current" } {
  return {
    schemaVersion: 1,
    state: "current",
    documentId: selection.documentId,
    extractionId: selection.extractionId,
    manifestSha256: selection.manifestSha256,
    start: selection.start,
    end: selection.end,
    quoteSha256: reconstruction.quoteSha256,
    pageStart: reconstruction.pageStart,
    pageEnd: reconstruction.pageEnd,
    paragraphStartId: reconstruction.paragraphStartId,
    paragraphEndId: reconstruction.paragraphEndId,
  };
}

export async function captureWorkspaceGroundedEvidence(
  user: SessionUser,
  workspaceId: string,
  paperIdValue: string,
  rawCommand: unknown,
): Promise<CaptureGroundedEvidenceResponse> {
  const paperId = opaqueId(paperIdValue, "paperId");
  const command = validateCaptureGroundedEvidenceCommand(rawCommand);
  const hash = commandHash(paperId, command);

  // The HTTP route performs this preflight before quota consumption. Repeat it
  // at the service boundary for non-route callers, then recheck transactionally
  // to close membership-revocation races.
  const initialMembership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(initialMembership.role);

  const result = await prisma.$transaction(async (transaction) => {
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, user.id);
    const membership = await transaction.member.findUnique({
      where: {
        organizationId_userId: { organizationId: workspaceId, userId: user.id },
      },
      include: { organization: true },
    });
    if (!membership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    requireWorkspaceMutationRole(membership.role);

    const prior = await transaction.idempotencyRecord.findUnique({
      where: {
        organizationId_key: {
          organizationId: workspaceId,
          key: command.clientOperationId,
        },
      },
    });
    if (prior) {
      if (
        prior.actorUserId !== user.id
        || prior.command !== "captureGroundedEvidence"
        || prior.requestHash !== hash
      ) {
        return failure(
          "idempotency_conflict",
          membership.organization.revision,
          "clientOperationId was already used for a different command.",
        );
      }
      return replayed(prior.response, membership.organization.revision)
        ?? failure(
          "idempotency_conflict",
          membership.organization.revision,
          "The grounded evidence receipt could not be replayed safely.",
        );
    }
    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    // The destination project is the visibility boundary. Requiring the paper
    // to be filed there prevents an otherwise hidden paper from being exposed
    // through a projectless evidence row.
    const project = await transaction.project.findFirst({
      where: {
        id: command.projectId,
        organizationId: workspaceId,
        ...projectVisibleTo(user.id),
        papers: {
          some: {
            organizationId: workspaceId,
            workspacePaper: { organizationId: workspaceId, paperId },
          },
        },
      },
      select: { id: true },
    });
    if (!project) {
      return failure(
        "not_found",
        membership.organization.revision,
        "The evidence destination was not found.",
      );
    }
    const workspacePaper = await transaction.workspacePaper.findUnique({
      where: {
        organizationId_paperId: { organizationId: workspaceId, paperId },
      },
      select: {
        id: true,
        paperId: true,
        paper: { select: { title: true } },
      },
    });
    if (!workspacePaper) {
      return failure("not_found", membership.organization.revision, "Paper was not found.");
    }

    if (command.collectionIds.length) {
      const visibleCollections = await transaction.collection.findMany({
        where: {
          organizationId: workspaceId,
          id: { in: command.collectionIds },
          OR: [
            { projectId: null },
            { projectId: project.id },
          ],
        },
        select: { id: true },
      });
      if (visibleCollections.length !== command.collectionIds.length) {
        return failure(
          "not_found",
          membership.organization.revision,
          "One or more evidence collections were not found.",
        );
      }
    }

    let resolvedSelection: ResolvedGroundedEvidenceSelection;
    try {
      resolvedSelection = await resolveCurrentGroundedEvidenceSelection(
        transaction,
        workspaceId,
        workspacePaper.id,
        workspacePaper.paperId,
        command.selection,
      );
    } catch (error) {
      if (error instanceof HttpProblem && error.code === "selection_conflict") {
        return failure("selection_conflict", membership.organization.revision, error.message);
      }
      throw error;
    }
    const source = {
      document: resolvedSelection.document,
      generation: resolvedSelection.generation,
    };
    const first = resolvedSelection.firstChunk;
    const last = resolvedSelection.lastChunk;
    const reconstruction = resolvedSelection.reconstruction;

    if (!await bumpRevision(transaction, workspaceId, command.expectedVersion)) {
      const current = await transaction.organization.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { revision: true },
      });
      return failure(
        "version_conflict",
        current.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const now = new Date();
    const createdBase = await transaction.evidenceNote.create({
      data: {
        organizationId: workspaceId,
        workspacePaperId: workspacePaper.id,
        projectId: project.id,
        documentId: source.document.id,
        documentChunkId: first.id,
        createdById: user.id,
        kind: DATABASE_KIND[command.note.kind],
        // Source custody and researcher review are separate axes. The immutable
        // anchor is current immediately; the research note remains captured
        // until an explicit review successor marks it verified.
        status: "CAPTURED",
        confidence: DATABASE_CONFIDENCE[command.note.confidence],
        title: command.note.title,
        claim: command.note.claim,
        evidence: reconstruction.quoteText,
        interpretation: command.note.interpretation,
        openQuestion: command.note.openQuestion ?? null,
        linkedHighlightIds: [],
        tags: command.note.tags,
        quote: reconstruction.quoteText,
        text: command.note.claim,
        pageStart: reconstruction.pageStart,
        pageEnd: reconstruction.pageEnd,
        paragraphId: reconstruction.paragraphStartId,
        verifiedAt: null,
        groundingVersion: 1,
      },
    });
    await transaction.projectEvidenceNote.create({
      data: {
        organizationId: workspaceId,
        projectId: project.id,
        evidenceNoteId: createdBase.id,
      },
    });
    if (command.collectionIds.length) {
      await transaction.collectionEvidenceNote.createMany({
        data: command.collectionIds.map((collectionId) => ({
          organizationId: workspaceId,
          collectionId,
          evidenceNoteId: createdBase.id,
        })),
      });
    }
    await transaction.evidenceTextAnchor.create({
      data: {
        organizationId: workspaceId,
        evidenceNoteId: createdBase.id,
        workspacePaperId: workspacePaper.id,
        documentId: source.document.id,
        extractionId: source.generation.id,
        schemaVersion: 1,
        manifestSha256: command.selection.manifestSha256,
        startChunkId: first.id,
        endChunkId: last.id,
        startSequence: first.sequence,
        endSequence: last.sequence,
        startByteOffset: command.selection.start.byteOffset,
        endByteOffset: command.selection.end.byteOffset,
        startContentHash: first.contentHash,
        endContentHash: last.contentHash,
        quoteText: reconstruction.quoteText,
        quoteSha256: reconstruction.quoteSha256,
        pageStart: reconstruction.pageStart,
        pageEnd: reconstruction.pageEnd,
        paragraphStartId: reconstruction.paragraphStartId,
        paragraphEndId: reconstruction.paragraphEndId,
      },
    });

    const locator = reconstruction.pageStart === reconstruction.pageEnd
      ? { paperId, page: reconstruction.pageStart, paragraphId: reconstruction.paragraphStartId }
      : {
        paperId,
        pageRange: [reconstruction.pageStart, reconstruction.pageEnd],
        paragraphId: reconstruction.paragraphStartId,
      };
    const provenancePayload = JSON.parse(JSON.stringify({
      schemaVersion: 2,
      provenance: {
        sourceType: "uploaded-file",
        sourceId: source.generation.id,
        sourceTitle: workspacePaper.paper.title,
        providerName: "PaperPilot Reader",
        retrievedAt: now.toISOString(),
        accessMethod: "upload",
        locator,
        excerpt: reconstruction.quoteText,
        version: `manifest:${command.selection.manifestSha256}`,
      },
      grounding: groundingDto(command.selection, reconstruction),
    })) as Prisma.InputJsonObject;
    const extractionPayload = JSON.parse(JSON.stringify({
      schemaVersion: 1,
      documentId: source.document.id,
      extractionId: source.generation.id,
      manifestSha256: command.selection.manifestSha256,
      start: command.selection.start,
      end: command.selection.end,
      quoteSha256: reconstruction.quoteSha256,
    })) as Prisma.InputJsonObject;
    await transaction.provenanceRecord.createMany({
      data: [
        {
          organizationId: workspaceId,
          kind: "USER_ASSERTION",
          paperId,
          workspacePaperId: workspacePaper.id,
          evidenceNoteId: createdBase.id,
          documentId: source.document.id,
          actorUserId: user.id,
          sourceProvider: "PaperPilot Reader",
          sourceRecordId: source.generation.id,
          retrievedAt: now,
          payloadDigest: sha256(stableJson(provenancePayload)),
          payload: provenancePayload,
        },
        {
          organizationId: workspaceId,
          kind: "EXTRACTION",
          paperId,
          workspacePaperId: workspacePaper.id,
          evidenceNoteId: createdBase.id,
          documentId: source.document.id,
          actorUserId: user.id,
          sourceProvider: "PaperPilot Reader",
          sourceRecordId: source.generation.id,
          retrievedAt: now,
          payloadDigest: sha256(stableJson(extractionPayload)),
          payload: extractionPayload,
        },
      ],
    });

    if (command.collectionIds.length) {
      await transaction.collection.updateMany({
        where: { organizationId: workspaceId, id: { in: command.collectionIds } },
        data: { updatedAt: now },
      });
    }
    const created = await transaction.evidenceNote.findUniqueOrThrow({
      where: { id: createdBase.id },
      include: createdEvidenceInclude(workspaceId, user.id),
    });
    const mapped = evidenceNoteDto(created, {
      revision: standaloneEvidenceRevision(created.id),
      sourceAuthority: {
        documentId: source.document.id,
        state: "ready",
        extractionId: source.generation.id,
        manifestSha256: command.selection.manifestSha256,
      },
    });
    if (!mapped) throw new Error("Grounded evidence could not be mapped to the workspace read model.");
    const grounding = groundingDto(command.selection, reconstruction);
    const result: CaptureGroundedEvidenceResponse = {
      ok: true,
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      data: {
        note: { ...mapped, grounding },
        linkedProjectIds: [project.id],
        updatedCollectionIds: command.collectionIds,
        grounding,
      },
    };
    await saveReceipt(transaction, {
      workspaceId,
      userId: user.id,
      operationId: command.clientOperationId,
      hash,
      result,
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        action: "evidence.grounded-captured",
        entityType: "evidence_note",
        entityId: mapped.id,
        requestId: command.clientOperationId,
        metadata: {
          paperId,
          projectId: project.id,
          documentId: source.document.id,
          extractionId: source.generation.id,
          manifestSha256: command.selection.manifestSha256,
          quoteSha256: reconstruction.quoteSha256,
          startSequence: command.selection.start.sequence,
          endSequence: command.selection.end.sequence,
          quoteBytes: Buffer.byteLength(reconstruction.quoteText, "utf8"),
          collectionCount: command.collectionIds.length,
        },
      },
    });
    return result;
  }, { isolationLevel: "Serializable" });

  if (result.ok && result.outcome === "replayed") {
    const hydrated = await hydrateGroundedEvidenceResponse(
      user.id,
      workspaceId,
      result.data.note.id,
    );
    if (!hydrated?.note.grounding) {
      return failure(
        "not_found",
        result.aggregateVersion,
        "Grounded evidence was not found.",
      );
    }
    return {
      ...result,
      data: {
        ...result.data,
        note: hydrated.note,
        linkedProjectIds: hydrated.linkedProjectIds,
        updatedCollectionIds: hydrated.updatedCollectionIds,
        grounding: hydrated.note.grounding,
      },
    };
  }
  return result;
}
