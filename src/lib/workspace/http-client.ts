"use client";

import type {
  AddNoteToCollectionCommand,
  AddNoteToCollectionResult,
  AddPaperToCollectionCommand,
  AddPaperToCollectionResult,
  ApproveWebMcpProposalCommand,
  ApproveWebMcpProposalResponse,
  CaptureGroundedEvidenceCommand,
  CaptureGroundedEvidenceResponse,
  CreateEvidenceRevisionCommand,
  CreateEvidenceRevisionResponse,
  CreateEvidenceNoteCommand,
  CreateEvidenceNoteResult,
  CreateCollectionCommand,
  CreateCollectionResult,
  CreateProjectCommand,
  CreateProjectResult,
  CreateUploadSessionCommand,
  CreateUploadSessionResult,
  FileImportCommand,
  FrozenWebMcpApprovalSubmission,
  GetWorkspaceProjectQuery,
  LinkValidatedDocumentCommand,
  LinkValidatedDocumentResult,
  OrdinaryFileImportResult,
  OrdinaryStageImportResult,
  PrepareWebMcpApprovalChallengeCommand,
  PrepareWebMcpApprovalChallengeResponse,
  ReaderDocumentMetadata,
  ReaderExtractionGenerationMetadata,
  ReaderPageOptions,
  ReaderTextChunk,
  StageImportCommand,
  VerifiedWebMcpIdentifier,
  WorkspaceBootstrapDto,
  WorkspaceCommandResult,
  WorkspaceProjectDto,
  UploadStatusDto,
  UploadTransferOptions,
  UploadWorkspaceClient,
  WebMcpApprovalEvidenceDossier,
  WebMcpExistingCanonicalVerifiedSnapshot,
  WebMcpHumanReviewVerifiedSnapshot,
  WebMcpOpenAlexVerifiedSnapshot,
  WebMcpVerifiedAuthoritySnapshot,
  WorkspacePaperReaderDto,
} from "./contracts";
import type {
  CrawlerDocumentInboxEntry,
  EvidenceNote,
  EvidenceNoteRevision,
  GroundedEvidenceAnchor,
  GroundedEvidenceBoundary,
  GroundedEvidenceSourceState,
  NoteStatus,
  InboxEntry,
  Paper,
  Provenance,
  WebMcpDuplicateCandidate,
  WebMcpInboxEntry,
  WorkspaceInboxEntry,
} from "../types";

interface ApiProblem {
  error?: { code?: string; message?: string; requestId?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const problem = payload as ApiProblem;
  const message = problem.error?.message;
  if (
    typeof message !== "string"
    || message.length < 1
    || message.length > 500
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(message)
  ) return fallback;
  return message;
}

function safeHeader(value: string | null, pattern: RegExp): string | undefined {
  const normalized = value?.trim();
  return normalized && pattern.test(normalized) ? normalized : undefined;
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WEB_MCP_CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OPENALEX_WORK_ID_PATTERN = /^W\d+$/;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/;
const READER_CURSOR_PATTERN = /^r1\.[A-Za-z0-9_-]{1,450}\.[A-Za-z0-9_-]{43}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROHIBITED_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const MAX_READER_PAGE_COUNT = 2_000;
const MAX_READER_CHUNK_COUNT = 4_096;
const MAX_READER_TEXT_BYTES = 4 * 1_024 * 1_024;
const MAX_READER_CHUNK_BYTES = 8 * 1_024;
const MAX_READER_INPUT_BYTES = 25n * 1_024n * 1_024n;
const MAX_READER_CURSOR_BYTES = 512;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function isBoundedFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isOpaqueReaderCursor(value: unknown): value is string {
  return typeof value === "string"
    && READER_CURSOR_PATTERN.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_READER_CURSOR_BYTES;
}

export class WorkspaceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly requestId: string | undefined,
    readonly retryAfterSeconds: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceHttpError";
  }
}

function uploadStatusDto(value: unknown): UploadStatusDto | null {
  if (!isRecord(value) || !isRecord(value.upload) || !isRecord(value.asset)
      || !isRecord(value.document) || !isRecord(value.inboxEntry)
      || !isRecord(value.inboxEntry.upload)) return null;
  const uploadStatuses = new Set([
    "awaiting-bytes",
    "receiving",
    "quarantined",
    "validating",
    "ready",
    "failed",
    "expired",
  ]);
  const assetStatuses = new Set([
    "uploading",
    "quarantined",
    "scanning",
    "ready",
    "rejected",
    "deleted",
  ]);
  const documentStatuses = new Set([
    "pending",
    "processing",
    "ready",
    "failed",
    "archived",
  ]);
  const extractionStatuses = new Set([
    "not-started",
    "queued",
    "extracting",
    "ready",
    "no-text",
    "failed",
  ]);
  const uploadStatus = String(value.upload.status);
  const assetStatus = String(value.asset.status);
  const documentStatus = String(value.document.status);
  const extractionStatus = String(value.inboxEntry.upload.extractionStage);
  const linkedPaperId = value.inboxEntry.upload.linkedPaperId;
  const readerAvailable = value.inboxEntry.upload.readerAvailable;
  const inboxStatus = uploadStatus === "ready"
    ? "ready"
    : uploadStatus === "failed" || uploadStatus === "expired"
      ? "blocked"
      : "processing";
  if (
    typeof value.upload.id !== "string"
    || !uploadStatuses.has(uploadStatus)
    || typeof value.upload.expiresAt !== "string"
    || !assetStatuses.has(assetStatus)
    || typeof value.document.id !== "string"
    || !documentStatuses.has(documentStatus)
    || value.inboxEntry.entryKind !== "document-upload"
    || value.inboxEntry.status !== inboxStatus
    || value.inboxEntry.upload.id !== value.upload.id
    || value.inboxEntry.upload.documentId !== value.document.id
    || value.inboxEntry.upload.stage !== uploadStatus
    || !extractionStatuses.has(extractionStatus)
    || typeof readerAvailable !== "boolean"
    || (linkedPaperId !== undefined
      && (typeof linkedPaperId !== "string" || !OPAQUE_ID_PATTERN.test(linkedPaperId)))
    || (value.asset.sizeBytes !== undefined
      && (typeof value.asset.sizeBytes !== "number"
        || !Number.isSafeInteger(value.asset.sizeBytes)
        || value.asset.sizeBytes < 0))
  ) return null;

  const extractionCoherent = linkedPaperId === undefined
    ? readerAvailable === false
    : uploadStatus === "ready"
      && readerAvailable === (extractionStatus === "ready");
  if (!extractionCoherent) return null;

  const coherent = (() => {
    switch (uploadStatus) {
      case "awaiting-bytes":
      case "receiving":
        return assetStatus === "uploading" && documentStatus === "pending";
      case "quarantined":
        return assetStatus === "quarantined" && documentStatus === "pending";
      case "validating":
        return assetStatus !== "rejected"
          && assetStatus !== "deleted"
          && documentStatus !== "failed"
          && documentStatus !== "archived"
          && (assetStatus === "scanning" || documentStatus === "processing");
      case "ready":
        return assetStatus === "ready" && documentStatus === "ready";
      case "failed":
      case "expired":
        return true;
      default:
        return false;
    }
  })();
  if (!coherent) return null;
  return value as unknown as UploadStatusDto;
}

function readerDocumentMetadata(value: unknown): ReaderDocumentMetadata | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "workspacePaperId",
    "paperId",
    "assetId",
    "inputSha256",
    "inputSizeBytes",
    "pageCount",
    "validationAttestationId",
    "validationPolicyVersion",
    "validatedAt",
  ])) return null;
  if (
    typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || typeof value.workspacePaperId !== "string" || !OPAQUE_ID_PATTERN.test(value.workspacePaperId)
    || typeof value.paperId !== "string" || !OPAQUE_ID_PATTERN.test(value.paperId)
    || typeof value.assetId !== "string" || !OPAQUE_ID_PATTERN.test(value.assetId)
    || typeof value.inputSha256 !== "string" || !SHA256_PATTERN.test(value.inputSha256)
    || /^0{64}$/.test(value.inputSha256)
    || typeof value.inputSizeBytes !== "string" || !/^[1-9]\d{0,19}$/.test(value.inputSizeBytes)
    || BigInt(value.inputSizeBytes) > MAX_READER_INPUT_BYTES
    || !isBoundedInteger(value.pageCount, 1, MAX_READER_PAGE_COUNT)
    || typeof value.validationAttestationId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.validationAttestationId)
    || typeof value.validationPolicyVersion !== "string"
    || !SAFE_VALUE_PATTERN.test(value.validationPolicyVersion)
    || !isCanonicalTimestamp(value.validatedAt)
  ) return null;
  return value as unknown as ReaderDocumentMetadata;
}

function readerGenerationMetadata(
  value: unknown,
): ReaderExtractionGenerationMetadata | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "validationAttestationId",
    "policyVersion",
    "toolchainDigest",
    "engine",
    "engineVersion",
    "verdict",
    "pageCount",
    "chunkCount",
    "textBytes",
    "extractedAt",
    "completedAt",
    "checkedAt",
    "manifestSha256",
    "manifestSchemaVersion",
    "manifestAdmittedAt",
  ])) return null;
  if (
    typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || typeof value.validationAttestationId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.validationAttestationId)
    || typeof value.policyVersion !== "string" || !SAFE_VALUE_PATTERN.test(value.policyVersion)
    || typeof value.toolchainDigest !== "string" || !SHA256_PATTERN.test(value.toolchainDigest)
    || /^0{64}$/.test(value.toolchainDigest)
    || value.engine !== "poppler"
    || typeof value.engineVersion !== "string" || !SAFE_VALUE_PATTERN.test(value.engineVersion)
    || (value.verdict !== "EXTRACTED" && value.verdict !== "NO_TEXT")
    || !isBoundedInteger(value.pageCount, 1, MAX_READER_PAGE_COUNT)
    || !isBoundedInteger(value.chunkCount, 0, MAX_READER_CHUNK_COUNT)
    || !isBoundedInteger(value.textBytes, 0, MAX_READER_TEXT_BYTES)
    || !isCanonicalTimestamp(value.extractedAt)
    || !isCanonicalTimestamp(value.completedAt)
    || !isCanonicalTimestamp(value.checkedAt)
    || typeof value.manifestSha256 !== "string" || !SHA256_PATTERN.test(value.manifestSha256)
    || value.manifestSchemaVersion !== 1
    || !isCanonicalTimestamp(value.manifestAdmittedAt)
    || value.extractedAt > value.completedAt
    || value.completedAt > value.checkedAt
  ) return null;
  return value as unknown as ReaderExtractionGenerationMetadata;
}

function readerChunk(value: unknown): ReaderTextChunk | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "sequence",
    "pageNumber",
    "paragraphId",
    "text",
    "contentHash",
    "locator",
  ]) || !isRecord(value.locator) || !hasExactKeys(value.locator, [
    "schemaVersion",
    "kind",
    "pageNumber",
    "paragraphId",
  ])) return null;
  if (
    typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || !isBoundedInteger(value.sequence, 0, MAX_READER_CHUNK_COUNT - 1)
    || !isBoundedInteger(value.pageNumber, 1, MAX_READER_PAGE_COUNT)
    || typeof value.paragraphId !== "string" || !/^p[1-9]\d*-p[1-9]\d*$/.test(value.paragraphId)
    || typeof value.text !== "string" || value.text.length < 1
    || value.text !== value.text.trim()
    || value.text !== value.text.normalize("NFC")
    || PROHIBITED_TEXT_PATTERN.test(value.text)
    || /\p{Zs}/u.test(value.text.replaceAll(" ", ""))
    || value.text.includes("  ")
    || new TextEncoder().encode(value.text).byteLength > MAX_READER_CHUNK_BYTES
    || typeof value.contentHash !== "string" || !SHA256_PATTERN.test(value.contentHash)
    || value.locator.schemaVersion !== 1
    || value.locator.kind !== "pdf-text"
    || value.locator.pageNumber !== value.pageNumber
    || value.locator.paragraphId !== value.paragraphId
  ) return null;
  return value as unknown as ReaderTextChunk;
}

const GROUNDED_FAILURE_CODES = new Set([
  "validation",
  "not_found",
  "duplicate",
  "version_conflict",
  "idempotency_conflict",
  "selection_conflict",
]);

function groundedBoundary(value: unknown): GroundedEvidenceBoundary | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "chunkId", "sequence", "byteOffset", "contentHash",
  ])) return null;
  if (
    typeof value.chunkId !== "string" || !OPAQUE_ID_PATTERN.test(value.chunkId)
    || !isBoundedInteger(value.sequence, 0, MAX_READER_CHUNK_COUNT - 1)
    || !isBoundedInteger(value.byteOffset, 0, MAX_READER_CHUNK_BYTES)
    || typeof value.contentHash !== "string" || !SHA256_PATTERN.test(value.contentHash)
  ) return null;
  return value as unknown as GroundedEvidenceBoundary;
}

function groundedEvidenceAnchor(
  value: unknown,
  expectedState?: GroundedEvidenceSourceState,
): GroundedEvidenceAnchor | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "state",
    "documentId",
    "extractionId",
    "manifestSha256",
    "start",
    "end",
    "quoteSha256",
    "pageStart",
    "pageEnd",
    "paragraphStartId",
    "paragraphEndId",
  ])) return null;
  const start = groundedBoundary(value.start);
  const end = groundedBoundary(value.end);
  if (
    value.schemaVersion !== 1
    || (value.state !== "current" && value.state !== "superseded" && value.state !== "unresolvable")
    || (expectedState !== undefined && value.state !== expectedState)
    || typeof value.documentId !== "string" || !OPAQUE_ID_PATTERN.test(value.documentId)
    || typeof value.extractionId !== "string" || !OPAQUE_ID_PATTERN.test(value.extractionId)
    || typeof value.manifestSha256 !== "string" || !SHA256_PATTERN.test(value.manifestSha256)
    || !start
    || !end
    || start.sequence > end.sequence
    || (start.sequence === end.sequence && start.byteOffset >= end.byteOffset)
    || typeof value.quoteSha256 !== "string" || !SHA256_PATTERN.test(value.quoteSha256)
    || !isBoundedInteger(value.pageStart, 1, MAX_READER_PAGE_COUNT)
    || !isBoundedInteger(value.pageEnd, value.pageStart as number, MAX_READER_PAGE_COUNT)
    || typeof value.paragraphStartId !== "string"
    || !/^p[1-9]\d*-p[1-9]\d*$/.test(value.paragraphStartId)
    || typeof value.paragraphEndId !== "string"
    || !/^p[1-9]\d*-p[1-9]\d*$/.test(value.paragraphEndId)
  ) return null;
  return value as unknown as GroundedEvidenceAnchor;
}

const EVIDENCE_KINDS = new Set(["direct-evidence", "interpretation", "open-question"]);
const EVIDENCE_CONFIDENCE = new Set(["high", "medium", "low", "unspecified"]);
const EVIDENCE_STATUSES = new Set(["captured", "needs-verification", "verified"]);
const PROVENANCE_SOURCE_TYPES = new Set([
  "paper",
  "figure",
  "citation-library",
  "note-system",
  "evidence-store",
  "literature-index",
  "uploaded-file",
  "web-source",
]);
const PROVENANCE_ACCESS_METHODS = new Set([
  "seeded-demo",
  "manual",
  "api",
  "upload",
  "oauth",
  "crawler",
  "mcp",
  "webmcp",
]);

function boundedSafeText(
  value: unknown,
  maximum: number,
  options: { allowEmpty?: boolean } = {},
): value is string {
  return typeof value === "string"
    && (options.allowEmpty || value.trim().length > 0)
    && value.length <= maximum
    && !PROHIBITED_TEXT_PATTERN.test(value);
}

function exactStringList(value: unknown, maximumItems: number, maximumItemLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => boundedSafeText(item, maximumItemLength) && item === item.trim())
    && new Set(value).size === value.length;
}

function evidenceNoteRevision(value: unknown, noteId: string): EvidenceNoteRevision | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "rootId", "number", "isLatest",
  ], ["previousId", "nextId"])) return null;
  if (
    typeof value.rootId !== "string" || !OPAQUE_ID_PATTERN.test(value.rootId)
    || !isBoundedInteger(value.number, 1)
    || typeof value.isLatest !== "boolean"
    || (value.previousId !== undefined
      && (typeof value.previousId !== "string" || !OPAQUE_ID_PATTERN.test(value.previousId)))
    || (value.nextId !== undefined
      && (typeof value.nextId !== "string" || !OPAQUE_ID_PATTERN.test(value.nextId)))
    || (value.number === 1 && (value.rootId !== noteId || value.previousId !== undefined))
    || (value.number > 1 && value.previousId === undefined)
    || (value.isLatest && value.nextId !== undefined)
    || (!value.isLatest && value.nextId === undefined)
  ) return null;
  return value as unknown as EvidenceNoteRevision;
}

function groundedEvidenceNote(
  value: unknown,
  grounding: GroundedEvidenceAnchor,
  options: {
    allowAnyRevision?: boolean;
    allowSupersededRoot?: boolean;
    expectedPaperId?: string;
    expectedStatus: NoteStatus;
    expectedPredecessorId?: string;
  },
): EvidenceNote | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "id",
    "paperId",
    "title",
    "kind",
    "claim",
    "evidence",
    "interpretation",
    "confidence",
    "status",
    "provenance",
    "linkedHighlightIds",
    "collectionIds",
    "tags",
    "revision",
    "createdAt",
    "updatedAt",
  ], ["openQuestion", "grounding", "reviewedAt"])) return null;

  const revision = typeof value.id === "string"
    ? evidenceNoteRevision(value.revision, value.id)
    : null;

  if (
    typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || typeof value.paperId !== "string" || !OPAQUE_ID_PATTERN.test(value.paperId)
    || (options.expectedPaperId !== undefined && value.paperId !== options.expectedPaperId)
    || !boundedSafeText(value.title, 200)
    || typeof value.kind !== "string" || !EVIDENCE_KINDS.has(value.kind)
    || !boundedSafeText(value.claim, 20_000)
    || !boundedSafeText(value.evidence, 50_000)
    || !boundedSafeText(value.interpretation, 20_000)
    || (value.openQuestion !== undefined && !boundedSafeText(value.openQuestion, 10_000, { allowEmpty: true }))
    || typeof value.confidence !== "string" || !EVIDENCE_CONFIDENCE.has(value.confidence)
    || value.status !== options.expectedStatus
    || typeof value.status !== "string" || !EVIDENCE_STATUSES.has(value.status)
    || !exactStringList(value.linkedHighlightIds, 1_000, 200)
    || !value.linkedHighlightIds.every((id) => OPAQUE_ID_PATTERN.test(id))
    || !exactStringList(value.collectionIds, 1_000, 200)
    || !value.collectionIds.every((id) => OPAQUE_ID_PATTERN.test(id))
    || !exactStringList(value.tags, 50, 100)
    || !revision
    || (!options.allowAnyRevision
      && options.expectedPredecessorId !== undefined
      && (revision.previousId !== options.expectedPredecessorId
        || revision.number < 2))
    || (!options.allowAnyRevision
      && options.expectedPredecessorId === undefined
      && (revision.number !== 1 || (!options.allowSupersededRoot && !revision.isLatest)))
    || (value.status === "verified" && !isCanonicalTimestamp(value.reviewedAt))
    || (value.status !== "verified" && value.reviewedAt !== undefined)
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || value.createdAt > value.updatedAt
    || (typeof value.reviewedAt === "string"
      && (value.reviewedAt < value.createdAt || value.reviewedAt > value.updatedAt))
  ) return null;

  if (value.grounding !== undefined) {
    const nestedGrounding = groundedEvidenceAnchor(value.grounding, grounding.state);
    if (!nestedGrounding || JSON.stringify(nestedGrounding) !== JSON.stringify(grounding)) return null;
  }

  const provenance = value.provenance;
  if (!isRecord(provenance) || !hasRequiredAndOptionalKeys(provenance, [
    "id",
    "sourceType",
    "sourceId",
    "sourceTitle",
    "providerName",
    "retrievedAt",
    "accessMethod",
    "locator",
    "excerpt",
    "version",
  ], ["sourceUrl"])) return null;
  if (
    typeof provenance.id !== "string" || !OPAQUE_ID_PATTERN.test(provenance.id)
    || provenance.sourceType !== "uploaded-file"
    || typeof provenance.sourceType !== "string" || !PROVENANCE_SOURCE_TYPES.has(provenance.sourceType)
    || provenance.sourceId !== grounding.extractionId
    || !boundedSafeText(provenance.sourceTitle, 2_000)
    || provenance.providerName !== "PaperPilot Reader"
    || !isCanonicalTimestamp(provenance.retrievedAt)
    || provenance.accessMethod !== "upload"
    || typeof provenance.accessMethod !== "string" || !PROVENANCE_ACCESS_METHODS.has(provenance.accessMethod)
    || provenance.excerpt !== value.evidence
    || provenance.version !== `manifest:${grounding.manifestSha256}`
    || (provenance.sourceUrl !== undefined && !boundedSafeText(provenance.sourceUrl, 2_048))
  ) return null;

  const locator = provenance.locator;
  if (!isRecord(locator) || !hasRequiredAndOptionalKeys(locator, [
    "paperId",
    "paragraphId",
  ], ["sectionId", "sectionTitle", "page", "pageRange", "figureId", "figureLabel"])) return null;
  if (
    locator.paperId !== value.paperId
    || locator.paragraphId !== grounding.paragraphStartId
    || (locator.sectionId !== undefined && !boundedSafeText(locator.sectionId, 200))
    || (locator.sectionTitle !== undefined && !boundedSafeText(locator.sectionTitle, 500))
    || (locator.figureId !== undefined && !boundedSafeText(locator.figureId, 200))
    || (locator.figureLabel !== undefined && !boundedSafeText(locator.figureLabel, 200))
  ) return null;
  if (grounding.pageStart === grounding.pageEnd) {
    if (locator.page !== grounding.pageStart || locator.pageRange !== undefined) return null;
  } else if (
    locator.page !== undefined
    || !Array.isArray(locator.pageRange)
    || locator.pageRange.length !== 2
    || locator.pageRange[0] !== grounding.pageStart
    || locator.pageRange[1] !== grounding.pageEnd
  ) return null;

  return { ...value, grounding, revision } as unknown as EvidenceNote;
}

function evidenceNoteProvenance(value: unknown, paperId: string): boolean {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "id",
    "sourceType",
    "sourceId",
    "sourceTitle",
    "providerName",
    "retrievedAt",
    "accessMethod",
  ], ["sourceUrl", "locator", "excerpt", "version"])) return false;
  if (
    typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || typeof value.sourceType !== "string" || !PROVENANCE_SOURCE_TYPES.has(value.sourceType)
    || !boundedSafeText(value.sourceId, 2_000)
    || !boundedSafeText(value.sourceTitle, 2_000)
    || !boundedSafeText(value.providerName, 500)
    || !isCanonicalTimestamp(value.retrievedAt)
    || typeof value.accessMethod !== "string" || !PROVENANCE_ACCESS_METHODS.has(value.accessMethod)
    || (value.sourceUrl !== undefined && !boundedSafeText(value.sourceUrl, 2_048))
    || (value.excerpt !== undefined && !boundedSafeText(value.excerpt, 50_000, { allowEmpty: true }))
    || (value.version !== undefined && !boundedSafeText(value.version, 1_000, { allowEmpty: true }))
  ) return false;
  if (value.locator === undefined) return true;
  if (!isRecord(value.locator) || !hasRequiredAndOptionalKeys(value.locator, [
    "paperId",
  ], ["sectionId", "sectionTitle", "page", "pageRange", "paragraphId", "figureId", "figureLabel"])) {
    return false;
  }
  const locator = value.locator;
  return locator.paperId === paperId
    && (locator.sectionId === undefined || boundedSafeText(locator.sectionId, 200))
    && (locator.sectionTitle === undefined || boundedSafeText(locator.sectionTitle, 500))
    && (locator.page === undefined || isBoundedInteger(locator.page, 1, MAX_READER_PAGE_COUNT))
    && (locator.pageRange === undefined
      || (Array.isArray(locator.pageRange)
        && locator.pageRange.length === 2
        && isBoundedInteger(locator.pageRange[0], 1, MAX_READER_PAGE_COUNT)
        && isBoundedInteger(locator.pageRange[1], locator.pageRange[0], MAX_READER_PAGE_COUNT)))
    && (locator.paragraphId === undefined || boundedSafeText(locator.paragraphId, 200))
    && (locator.figureId === undefined || boundedSafeText(locator.figureId, 200))
    && (locator.figureLabel === undefined || boundedSafeText(locator.figureLabel, 200));
}

/** Parse note-local fields before validating their cross-note revision graph. */
function evidenceNoteReadModel(value: unknown): EvidenceNote | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "id",
    "paperId",
    "title",
    "kind",
    "claim",
    "evidence",
    "interpretation",
    "confidence",
    "status",
    "provenance",
    "linkedHighlightIds",
    "collectionIds",
    "tags",
    "revision",
    "createdAt",
    "updatedAt",
  ], ["openQuestion", "grounding", "reviewedAt"])) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const paperId = typeof value.paperId === "string" ? value.paperId : "";
  const revision = evidenceNoteRevision(value.revision, id);
  const status = typeof value.status === "string" && EVIDENCE_STATUSES.has(value.status)
    ? value.status as NoteStatus
    : null;
  if (
    !OPAQUE_ID_PATTERN.test(id)
    || !OPAQUE_ID_PATTERN.test(paperId)
    || !boundedSafeText(value.title, 200)
    || typeof value.kind !== "string" || !EVIDENCE_KINDS.has(value.kind)
    || !boundedSafeText(value.claim, 20_000)
    || !boundedSafeText(value.evidence, 50_000)
    || !boundedSafeText(value.interpretation, 20_000)
    || (value.openQuestion !== undefined
      && !boundedSafeText(value.openQuestion, 10_000, { allowEmpty: true }))
    || typeof value.confidence !== "string" || !EVIDENCE_CONFIDENCE.has(value.confidence)
    || !status
    || !exactStringList(value.linkedHighlightIds, 1_000, 200)
    || !value.linkedHighlightIds.every((entry) => OPAQUE_ID_PATTERN.test(entry))
    || !exactStringList(value.collectionIds, 1_000, 200)
    || !value.collectionIds.every((entry) => OPAQUE_ID_PATTERN.test(entry))
    || !exactStringList(value.tags, 50, 100)
    || !revision
    || (status === "verified" && !isCanonicalTimestamp(value.reviewedAt))
    || (status !== "verified" && value.reviewedAt !== undefined)
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || value.createdAt > value.updatedAt
    || (typeof value.reviewedAt === "string"
      && (value.reviewedAt < value.createdAt || value.reviewedAt > value.updatedAt))
  ) return null;

  if (value.grounding !== undefined) {
    const grounding = groundedEvidenceAnchor(value.grounding);
    if (!grounding) return null;
    return groundedEvidenceNote(value, grounding, {
      allowAnyRevision: true,
      expectedStatus: status,
    });
  }
  if (!evidenceNoteProvenance(value.provenance, paperId)) return null;
  return { ...value, revision } as unknown as EvidenceNote;
}

function evidenceNoteReadModelList(value: unknown): EvidenceNote[] | null {
  if (!Array.isArray(value)) return null;
  const notes = value.map(evidenceNoteReadModel);
  if (notes.some((note) => note === null)) return null;
  const parsed = notes as EvidenceNote[];
  const byId = new Map<string, EvidenceNote>();
  for (const note of parsed) {
    if (byId.has(note.id)) return null;
    byId.set(note.id, note);
  }

  const chains = new Map<string, EvidenceNote[]>();
  for (const note of parsed) {
    const chain = chains.get(note.revision.rootId) ?? [];
    chain.push(note);
    chains.set(note.revision.rootId, chain);
  }
  for (const chain of chains.values()) {
    chain.sort((left, right) => left.revision.number - right.revision.number);
    if (chain.filter((note) => note.revision.isLatest).length !== 1) return null;
    for (let index = 0; index < chain.length; index += 1) {
      const note = chain[index]!;
      const previous = chain[index - 1];
      const next = chain[index + 1];
      if (
        (previous && note.revision.number !== previous.revision.number + 1)
        || (previous && note.revision.previousId !== previous.id)
        || (previous && previous.revision.nextId !== note.id)
        || (!previous && note.revision.number > 1
          && note.revision.previousId !== undefined
          && byId.has(note.revision.previousId))
        || (next && note.revision.isLatest)
        || (!next && !note.revision.isLatest)
      ) return null;
    }
  }
  return parsed;
}

const PAPER_TYPES = new Set([
  "journal article",
  "conference paper",
  "review",
  "methods paper",
  "application study",
]);
const EVIDENCE_STRENGTHS = new Set([
  "foundational", "strong", "promising", "contextual", "unassessed",
]);
const READING_STATUSES = new Set(["unread", "queued", "reading", "reviewed"]);
const PAPER_IDENTIFIER_SCHEMES = new Set(["doi", "arxiv", "isbn", "provider"]);
const IMPORT_SOURCE_KINDS = new Set([
  "discover", "zotero", "upload", "crawler", "webmcp", "identifier",
]);
const INBOX_ENTRY_STATUSES = new Set([
  "awaiting-review", "possible-duplicate", "processing", "ready", "blocked",
]);
const UPLOAD_STAGES = new Set([
  "awaiting-bytes", "receiving", "quarantined", "validating", "ready", "failed", "expired",
]);
const EXTRACTION_STAGES = new Set([
  "not-started", "queued", "extracting", "ready", "no-text", "failed",
]);
const UPLOAD_FAILURE_CODES = new Set([
  "invalid_pdf_envelope",
  "pdf_trailing_data",
  "size_mismatch",
  "upload_too_large",
  "upload_aborted",
  "upload_timed_out",
  "storage_unavailable",
  "storage_finalize_failed",
  "session_expired",
  "malware_detected",
  "invalid_pdf_structure",
  "integrity_check_failed",
  "validation_unavailable",
  "validation_failed",
  "file_unavailable",
  "upload_failed",
]);
const CRAWLER_DOCUMENT_STAGES = new Set([
  "queued", "fetching", "quarantined", "validating", "extracting",
  "ready", "attention", "failed", "cancelled",
]);
const CRAWLER_DOCUMENT_FAILURE_CODES = new Set([
  "crawler_attention", "crawler_failed", "crawler_cancelled",
]);

function paperReadModel(value: unknown): Paper | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "id", "title", "shortTitle", "authors", "year", "venue", "type",
    "abstract", "abstractSnippet", "whyRead", "relevanceScore", "relevanceTags",
    "evidenceStrength", "readingStatus", "readingProgress", "estimatedMinutes",
    "identifiers", "isDemoRecord",
  ], [
    "citationCount", "providerRelevanceScore", "sourceUrl", "access",
    "isRetracted", "providerUpdatedAt",
  ])) return null;
  if (
    typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || !boundedSafeText(value.title, 2_000)
    || !boundedSafeText(value.shortTitle, 500)
    || !exactStringList(value.authors, 200, 300)
    || !isBoundedInteger(value.year, 0, new Date().getUTCFullYear() + 5)
    || !boundedSafeText(value.venue, 1_000)
    || typeof value.type !== "string" || !PAPER_TYPES.has(value.type)
    || !boundedSafeText(value.abstract, 150_000, { allowEmpty: true })
    || !boundedSafeText(value.abstractSnippet, 5_000, { allowEmpty: true })
    || !boundedSafeText(value.whyRead, 10_000, { allowEmpty: true })
    || !isBoundedFiniteNumber(value.relevanceScore, 0, 100_000)
    || !exactStringList(value.relevanceTags, 50, 120)
    || typeof value.evidenceStrength !== "string" || !EVIDENCE_STRENGTHS.has(value.evidenceStrength)
    || typeof value.readingStatus !== "string" || !READING_STATUSES.has(value.readingStatus)
    || !isBoundedFiniteNumber(value.readingProgress, 0, 100)
    || !isBoundedInteger(value.estimatedMinutes, 0, 100_000)
    || (value.citationCount !== undefined
      && !isBoundedInteger(value.citationCount, 0, 2_000_000_000))
    || (value.providerRelevanceScore !== undefined
      && !isBoundedFiniteNumber(value.providerRelevanceScore, -1_000_000_000, 1_000_000_000))
    || (value.sourceUrl !== undefined && !boundedSafeText(value.sourceUrl, 2_048))
    || (value.isRetracted !== undefined && typeof value.isRetracted !== "boolean")
    || (value.providerUpdatedAt !== undefined && !isCanonicalTimestamp(value.providerUpdatedAt))
    || typeof value.isDemoRecord !== "boolean"
    || !Array.isArray(value.identifiers)
    || value.identifiers.length > 32
  ) return null;

  const identifiers = value.identifiers as unknown[];
  if (!identifiers.every((identifier) =>
    isRecord(identifier)
      && hasExactKeys(identifier, ["scheme", "value"])
      && typeof identifier.scheme === "string"
      && PAPER_IDENTIFIER_SCHEMES.has(identifier.scheme)
      && boundedSafeText(identifier.value, 1_024)
      && identifier.value === identifier.value.trim())) return null;
  const identifierKeys = identifiers.map((identifier) => {
    const record = identifier as Record<string, unknown>;
    return `${record.scheme}:${record.value}`;
  });
  if (new Set(identifierKeys).size !== identifierKeys.length) return null;

  if (value.access !== undefined) {
    if (!isRecord(value.access) || !hasRequiredAndOptionalKeys(value.access, [
      "isOpenAccess", "hasFullText",
    ], ["landingPageUrl", "pdfUrl", "license", "version"])) return null;
    if (
      typeof value.access.isOpenAccess !== "boolean"
      || typeof value.access.hasFullText !== "boolean"
      || (value.access.landingPageUrl !== undefined
        && !boundedSafeText(value.access.landingPageUrl, 2_048))
      || (value.access.pdfUrl !== undefined && !boundedSafeText(value.access.pdfUrl, 2_048))
      || (value.access.license !== undefined
        && !boundedSafeText(value.access.license, 500, { allowEmpty: true }))
      || (value.access.version !== undefined
        && !boundedSafeText(value.access.version, 200, { allowEmpty: true }))
    ) return null;
  }
  return value as unknown as Paper;
}

function webMcpDuplicateCandidateReadModel(value: unknown): WebMcpDuplicateCandidate | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "title", "authors", "year", "venue", "type", "identifiers",
  ])) return null;
  if (
    typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || !boundedSafeText(value.title, 2_000) || value.title !== value.title.trim()
    || !Array.isArray(value.authors) || value.authors.length > 200
    || !value.authors.every((author) =>
      boundedSafeText(author, 300) && author === author.trim())
    || !isBoundedInteger(value.year, 0, new Date().getUTCFullYear() + 5)
    || !boundedSafeText(value.venue, 1_000) || value.venue !== value.venue.trim()
    || typeof value.type !== "string" || !PAPER_TYPES.has(value.type)
    || !Array.isArray(value.identifiers) || value.identifiers.length > 32
    || !value.identifiers.every((identifier) =>
      isRecord(identifier)
        && hasExactKeys(identifier, ["scheme", "value"])
        && typeof identifier.scheme === "string"
        && PAPER_IDENTIFIER_SCHEMES.has(identifier.scheme)
        && boundedSafeText(identifier.value, 1_024)
        && identifier.value === identifier.value.trim())
  ) return null;
  const identifierKeys = value.identifiers.map((identifier) => {
    const record = identifier as Record<string, unknown>;
    return `${String(record.scheme).toLowerCase()}:${String(record.value).toLowerCase()}`;
  });
  if (new Set(identifierKeys).size !== identifierKeys.length) return null;
  return value as unknown as WebMcpDuplicateCandidate;
}

function provenanceReadModel(value: unknown, paperId?: string): Provenance | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "id", "sourceType", "sourceId", "sourceTitle", "providerName",
    "retrievedAt", "accessMethod",
  ], ["sourceUrl", "locator", "excerpt", "version"])) return null;
  if (
    typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || typeof value.sourceType !== "string" || !PROVENANCE_SOURCE_TYPES.has(value.sourceType)
    || !boundedSafeText(value.sourceId, 2_048)
    || !boundedSafeText(value.sourceTitle, 2_000)
    || !boundedSafeText(value.providerName, 300)
    || !isCanonicalTimestamp(value.retrievedAt)
    || typeof value.accessMethod !== "string" || !PROVENANCE_ACCESS_METHODS.has(value.accessMethod)
    || (value.sourceUrl !== undefined && !boundedSafeText(value.sourceUrl, 2_048))
    || (value.excerpt !== undefined
      && !boundedSafeText(value.excerpt, 40_000, { allowEmpty: true }))
    || (value.version !== undefined
      && !boundedSafeText(value.version, 500, { allowEmpty: true }))
  ) return null;
  if (value.locator !== undefined) {
    if (!isRecord(value.locator) || !hasRequiredAndOptionalKeys(value.locator, [
      "paperId",
    ], ["sectionId", "sectionTitle", "page", "pageRange", "paragraphId", "figureId", "figureLabel"])) {
      return null;
    }
    const locator = value.locator;
    if (
      typeof locator.paperId !== "string" || !OPAQUE_ID_PATTERN.test(locator.paperId)
      || (paperId !== undefined && locator.paperId !== paperId)
      || (locator.sectionId !== undefined && !boundedSafeText(locator.sectionId, 512))
      || (locator.sectionTitle !== undefined && !boundedSafeText(locator.sectionTitle, 1_000))
      || (locator.page !== undefined && !isBoundedInteger(locator.page, 1, 1_000_000))
      || (locator.pageRange !== undefined
        && (!Array.isArray(locator.pageRange)
          || locator.pageRange.length !== 2
          || !isBoundedInteger(locator.pageRange[0], 1, 1_000_000)
          || !isBoundedInteger(locator.pageRange[1], locator.pageRange[0], 1_000_000)))
      || (locator.paragraphId !== undefined && !boundedSafeText(locator.paragraphId, 512))
      || (locator.figureId !== undefined && !boundedSafeText(locator.figureId, 512))
      || (locator.figureLabel !== undefined && !boundedSafeText(locator.figureLabel, 500))
    ) return null;
  }
  return value as unknown as Provenance;
}

function paperInboxEntryReadModel(value: unknown): InboxEntry | WebMcpInboxEntry | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "entryKind", "id", "sourceKind", "paper", "provenance", "status",
    "createdAt", "updatedAt",
  ], ["duplicateOfPaperId", "destinationProjectId", "proposalDigest", "duplicateCandidate"])) return null;
  const paper = paperReadModel(value.paper);
  const provenance = provenanceReadModel(value.provenance, paper?.id);
  if (
    value.entryKind !== "paper"
    || typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || typeof value.sourceKind !== "string" || !IMPORT_SOURCE_KINDS.has(value.sourceKind)
    || value.sourceKind === "upload"
    || !paper
    || !provenance
    || typeof value.status !== "string" || !INBOX_ENTRY_STATUSES.has(value.status)
    || (value.duplicateOfPaperId !== undefined
      && (typeof value.duplicateOfPaperId !== "string"
        || !OPAQUE_ID_PATTERN.test(value.duplicateOfPaperId)))
    || (value.destinationProjectId !== undefined
      && (typeof value.destinationProjectId !== "string"
        || !OPAQUE_ID_PATTERN.test(value.destinationProjectId)))
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || value.createdAt > value.updatedAt
  ) return null;

  if (value.sourceKind === "webmcp") {
    const duplicateCandidate = value.duplicateCandidate === undefined
      ? undefined
      : webMcpDuplicateCandidateReadModel(value.duplicateCandidate);
    if (
      duplicateCandidate === null
      ||
      typeof value.proposalDigest !== "string" || !SHA256_PATTERN.test(value.proposalDigest)
      || provenance.sourceType !== "web-source"
      || provenance.accessMethod !== "webmcp"
      || provenance.providerName !== "PaperPilot WebMCP"
      || provenance.sourceUrl !== provenance.sourceId
      || paper.sourceUrl !== provenance.sourceId
      || !paper.access
      || paper.access.hasFullText !== false
      || (value.duplicateOfPaperId === undefined) !== (duplicateCandidate === undefined)
      || (duplicateCandidate !== undefined && duplicateCandidate.id !== value.duplicateOfPaperId)
    ) return null;
    return {
      ...value,
      paper,
      provenance,
      ...(duplicateCandidate ? { duplicateCandidate } : {}),
    } as unknown as WebMcpInboxEntry;
  }
  if (Object.hasOwn(value, "proposalDigest") || Object.hasOwn(value, "duplicateCandidate")) return null;
  return { ...value, paper, provenance } as unknown as InboxEntry;
}

function documentUploadInboxEntryReadModel(value: unknown): WorkspaceInboxEntry | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "entryKind", "id", "sourceKind", "provenance", "status", "upload",
    "createdAt", "updatedAt",
  ], ["failure"])) return null;
  if (!isRecord(value.upload)) return null;
  const upload = value.upload;
  if (!hasRequiredAndOptionalKeys(upload, [
    "id", "documentId", "fileName", "expectedSizeBytes", "mediaType", "stage",
    "extractionStage", "readerAvailable", "expiresAt",
  ], ["receivedSizeBytes", "linkedPaperId"])) return null;
  const provenance = provenanceReadModel(value.provenance);
  const stage = typeof upload.stage === "string" ? upload.stage : "";
  const extractionStage = typeof upload.extractionStage === "string" ? upload.extractionStage : "";
  const expectedStatus = stage === "ready"
    ? "ready"
    : stage === "failed" || stage === "expired"
      ? "blocked"
      : "processing";
  if (
    value.entryKind !== "document-upload"
    || value.sourceKind !== "upload"
    || typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || !provenance
    || provenance.sourceType !== "uploaded-file"
    || provenance.accessMethod !== "upload"
    || provenance.providerName !== "PaperPilot private quarantine"
    || value.status !== expectedStatus
    || typeof upload.id !== "string" || !OPAQUE_ID_PATTERN.test(upload.id)
    || typeof upload.documentId !== "string" || !OPAQUE_ID_PATTERN.test(upload.documentId)
    || !boundedSafeText(upload.fileName, 1_024)
    || !isBoundedInteger(upload.expectedSizeBytes, 1, Number(MAX_READER_INPUT_BYTES))
    || (upload.receivedSizeBytes !== undefined
      && (!isBoundedInteger(upload.receivedSizeBytes, 0, upload.expectedSizeBytes)
        || stage === "awaiting-bytes" && upload.receivedSizeBytes !== 0))
    || upload.mediaType !== "application/pdf"
    || !UPLOAD_STAGES.has(stage)
    || !EXTRACTION_STAGES.has(extractionStage)
    || typeof upload.readerAvailable !== "boolean"
    || (upload.linkedPaperId !== undefined
      && (typeof upload.linkedPaperId !== "string" || !OPAQUE_ID_PATTERN.test(upload.linkedPaperId)))
    || upload.readerAvailable !== (upload.linkedPaperId !== undefined
      && stage === "ready" && extractionStage === "ready")
    || !isCanonicalTimestamp(upload.expiresAt)
    || provenance.sourceId !== upload.id
    || provenance.sourceTitle !== upload.fileName
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || value.createdAt > value.updatedAt
    || provenance.retrievedAt !== value.createdAt
  ) return null;

  const shouldHaveFailure = stage === "failed" || stage === "expired";
  if (shouldHaveFailure !== (value.failure !== undefined)) return null;
  if (value.failure !== undefined) {
    if (!isRecord(value.failure) || !hasRequiredAndOptionalKeys(value.failure, [
      "code", "message", "retryable",
    ], ["requestId"])) return null;
    if (
      typeof value.failure.code !== "string" || !UPLOAD_FAILURE_CODES.has(value.failure.code)
      || !boundedSafeText(value.failure.message, 500)
      || typeof value.failure.retryable !== "boolean"
      || (value.failure.requestId !== undefined
        && (typeof value.failure.requestId !== "string"
          || !OPAQUE_ID_PATTERN.test(value.failure.requestId)))
    ) return null;
  }
  return { ...value, provenance } as unknown as WorkspaceInboxEntry;
}

function crawlerDocumentInboxEntryReadModel(value: unknown): CrawlerDocumentInboxEntry | null {
  if (!isRecord(value) || !hasRequiredAndOptionalKeys(value, [
    "entryKind", "id", "sourceKind", "provenance", "status", "crawler",
    "createdAt", "updatedAt",
  ], ["failure"]) || !isRecord(value.crawler)) return null;
  const crawler = value.crawler;
  if (!hasRequiredAndOptionalKeys(crawler, [
    "id", "documentId", "fileName", "mediaType", "stage",
    "extractionStage", "readerAvailable",
  ], ["linkedPaperId"])) return null;
  const provenance = provenanceReadModel(value.provenance);
  const stage = typeof crawler.stage === "string" ? crawler.stage : "";
  const extractionStage = typeof crawler.extractionStage === "string"
    ? crawler.extractionStage
    : "";
  const expectedStatus = stage === "ready"
    ? "ready"
    : stage === "attention" || stage === "failed" || stage === "cancelled"
      ? "blocked"
      : "processing";
  if (
    value.entryKind !== "crawler-document"
    || value.sourceKind !== "crawler"
    || typeof value.id !== "string" || !OPAQUE_ID_PATTERN.test(value.id)
    || !provenance
    || provenance.sourceType !== "web-source"
    || provenance.accessMethod !== "crawler"
    || provenance.providerName !== "PaperPilot governed crawler"
    || provenance.sourceUrl !== undefined
    || value.status !== expectedStatus
    || typeof crawler.id !== "string" || !OPAQUE_ID_PATTERN.test(crawler.id)
    || typeof crawler.documentId !== "string" || !OPAQUE_ID_PATTERN.test(crawler.documentId)
    || !boundedSafeText(crawler.fileName, 255)
    || crawler.mediaType !== "application/pdf"
    || !CRAWLER_DOCUMENT_STAGES.has(stage)
    || !EXTRACTION_STAGES.has(extractionStage)
    || typeof crawler.readerAvailable !== "boolean"
    || (crawler.linkedPaperId !== undefined
      && (typeof crawler.linkedPaperId !== "string"
        || !OPAQUE_ID_PATTERN.test(crawler.linkedPaperId)))
    || crawler.readerAvailable !== (crawler.linkedPaperId !== undefined
      && stage === "ready" && extractionStage === "ready")
    || provenance.id !== `crawler:${crawler.id}`
    || provenance.sourceId !== crawler.id
    || provenance.sourceTitle !== crawler.fileName
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || value.createdAt > value.updatedAt
    || provenance.retrievedAt !== value.createdAt
  ) return null;

  const shouldHaveFailure = stage === "attention"
    || stage === "failed"
    || stage === "cancelled";
  if (shouldHaveFailure !== (value.failure !== undefined)) return null;
  if (value.failure !== undefined) {
    if (!isRecord(value.failure) || !hasExactKeys(value.failure, [
      "code", "message", "retryable",
    ])
      || typeof value.failure.code !== "string"
      || !CRAWLER_DOCUMENT_FAILURE_CODES.has(value.failure.code)
      || !boundedSafeText(value.failure.message, 500)
      || typeof value.failure.retryable !== "boolean"
    ) return null;
    const expectedFailureCode = stage === "attention"
      ? "crawler_attention"
      : stage === "failed"
        ? "crawler_failed"
        : "crawler_cancelled";
    if (value.failure.code !== expectedFailureCode) return null;
  }
  return { ...value, provenance } as unknown as CrawlerDocumentInboxEntry;
}

function workspaceInboxEntryReadModel(value: unknown): WorkspaceInboxEntry | null {
  if (!isRecord(value)) return null;
  if (value.entryKind === "document-upload") {
    return documentUploadInboxEntryReadModel(value);
  }
  if (value.entryKind === "crawler-document") {
    return crawlerDocumentInboxEntryReadModel(value);
  }
  return paperInboxEntryReadModel(value);
}

function workspaceInboxEntryReadModelList(value: unknown): WorkspaceInboxEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map(workspaceInboxEntryReadModel);
  if (entries.some((entry) => entry === null)) return null;
  const parsed = entries as WorkspaceInboxEntry[];
  return new Set(parsed.map((entry) => entry.id)).size === parsed.length ? parsed : null;
}

function paperReadModelList(value: unknown): Paper[] | null {
  if (!Array.isArray(value)) return null;
  const papers = value.map(paperReadModel);
  if (papers.some((paper) => paper === null)) return null;
  const parsed = papers as Paper[];
  return new Set(parsed.map((paper) => paper.id)).size === parsed.length ? parsed : null;
}

const PROJECT_TYPES = new Set(["evidence-map", "literature-review", "systematic-review"]);
const PROJECT_VISIBILITIES = new Set(["private", "workspace"]);
const PROJECT_STATUSES = new Set(["active", "archived"]);
const COLLECTION_COLORS = new Set(["blue", "amber", "slate", "teal"]);

function idList(value: unknown, maximumItems = 100_000): value is string[] {
  return exactStringList(value, maximumItems, 200)
    && value.every((entry) => OPAQUE_ID_PATTERN.test(entry));
}

function researchProjectReadModel(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "name", "question", "description", "type", "visibility", "status",
    "paperIds", "evidenceNoteIds", "collectionIds", "sourceConnectionIds",
    "createdAt", "updatedAt",
  ])
    && typeof value.id === "string" && OPAQUE_ID_PATTERN.test(value.id)
    && boundedSafeText(value.name, 500)
    && boundedSafeText(value.question, 20_000, { allowEmpty: true })
    && boundedSafeText(value.description, 20_000, { allowEmpty: true })
    && typeof value.type === "string" && PROJECT_TYPES.has(value.type)
    && typeof value.visibility === "string" && PROJECT_VISIBILITIES.has(value.visibility)
    && typeof value.status === "string" && PROJECT_STATUSES.has(value.status)
    && idList(value.paperIds)
    && idList(value.evidenceNoteIds)
    && idList(value.collectionIds)
    && idList(value.sourceConnectionIds)
    && isCanonicalTimestamp(value.createdAt)
    && isCanonicalTimestamp(value.updatedAt)
    && value.createdAt <= value.updatedAt;
}

function collectionReadModel(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "name", "description", "color", "paperIds", "noteIds",
    "evidenceClaimCount", "openQuestionCount", "updatedAt",
  ])
    && typeof value.id === "string" && OPAQUE_ID_PATTERN.test(value.id)
    && boundedSafeText(value.name, 500)
    && boundedSafeText(value.description, 20_000, { allowEmpty: true })
    && typeof value.color === "string" && COLLECTION_COLORS.has(value.color)
    && idList(value.paperIds)
    && idList(value.noteIds)
    && isBoundedInteger(value.evidenceClaimCount, 0)
    && isBoundedInteger(value.openQuestionCount, 0)
    && isCanonicalTimestamp(value.updatedAt);
}

function evidenceHeadIndexesAreCoherent(
  projects: readonly Record<string, unknown>[],
  collections: readonly Record<string, unknown>[],
  notes: readonly EvidenceNote[],
): boolean {
  const byId = new Map(notes.map((note) => [note.id, note]));
  return projects.every((project) =>
    (project.evidenceNoteIds as string[]).every((id) => byId.get(id)?.revision.isLatest === true))
    && collections.every((collection) =>
      (collection.noteIds as string[]).every((id) => byId.get(id)?.revision.isLatest === true));
}

function parseWorkspaceBootstrap(value: unknown): WorkspaceBootstrapDto | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "aggregateVersion", "workspace", "activeProjectId",
    "projects", "inboxEntries", "papers", "notes", "collections",
  ]) || value.schemaVersion !== 3 || !isBoundedInteger(value.aggregateVersion, 0)
    || !isRecord(value.workspace) || !hasExactKeys(value.workspace, ["id", "name", "mode", "role"])
    || typeof value.workspace.id !== "string" || !OPAQUE_ID_PATTERN.test(value.workspace.id)
    || !boundedSafeText(value.workspace.name, 500)
    || (value.workspace.mode !== "demo" && value.workspace.mode !== "live")
    || !boundedSafeText(value.workspace.role, 100)
    || !Array.isArray(value.projects) || !value.projects.every(researchProjectReadModel)
    || new Set(value.projects.map((project) => (project as Record<string, unknown>).id)).size
      !== value.projects.length
    || !Array.isArray(value.collections) || !value.collections.every(collectionReadModel)
    || new Set(value.collections.map((collection) => (collection as Record<string, unknown>).id)).size
      !== value.collections.length
  ) return null;
  const inboxEntries = workspaceInboxEntryReadModelList(value.inboxEntries);
  const papers = paperReadModelList(value.papers);
  const notes = evidenceNoteReadModelList(value.notes);
  if (!inboxEntries || !papers || !notes) return null;
  const projects = value.projects as Record<string, unknown>[];
  const collections = value.collections as Record<string, unknown>[];
  const paperIds = new Set(papers.map((paper) => paper.id));
  if (
    (value.activeProjectId !== null
      && (typeof value.activeProjectId !== "string"
        || !projects.some((project) => project.id === value.activeProjectId)))
    || !evidenceHeadIndexesAreCoherent(projects, collections, notes)
    || projects.some((project) =>
      (project.paperIds as string[]).some((paperId) => !paperIds.has(paperId)))
    || collections.some((collection) =>
      (collection.paperIds as string[]).some((paperId) => !paperIds.has(paperId)))
  ) return null;
  return { ...value, inboxEntries, papers, notes } as unknown as WorkspaceBootstrapDto;
}

function parseWorkspaceProject(
  value: unknown,
  expectedProjectId: string,
): WorkspaceProjectDto | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "aggregateVersion", "project", "papers", "notes", "collections",
  ]) || !isBoundedInteger(value.aggregateVersion, 0)
    || !researchProjectReadModel(value.project)
    || (value.project as Record<string, unknown>).id !== expectedProjectId
    || !Array.isArray(value.collections) || !value.collections.every(collectionReadModel)
    || new Set(value.collections.map((collection) => (collection as Record<string, unknown>).id)).size
      !== value.collections.length
  ) return null;
  const papers = paperReadModelList(value.papers);
  const notes = evidenceNoteReadModelList(value.notes);
  const project = value.project as Record<string, unknown>;
  const collections = value.collections as Record<string, unknown>[];
  const paperIds = new Set(papers?.map((paper) => paper.id));
  if (
    !papers
    || !notes
    || !evidenceHeadIndexesAreCoherent([project], collections, notes)
    || (project.paperIds as string[]).some((paperId) => !paperIds.has(paperId))
    || collections.some((collection) =>
      (collection.paperIds as string[]).some((paperId) => !paperIds.has(paperId)))
  ) return null;
  return { ...value, papers, notes } as unknown as WorkspaceProjectDto;
}

const WORKSPACE_COMMAND_FAILURE_CODES = new Set([
  "validation", "not_found", "duplicate", "version_conflict", "idempotency_conflict",
]);
const VERIFIED_WEB_MCP_IDENTIFIER_SCHEMES = new Set(["doi", "provider"]);
const DOI_IDENTIFIER_PATTERN = /^10\.\d{4,9}\/\S+$/;
const OPENALEX_IDENTIFIER_PATTERN = /^openalex:W\d+$/;

function normalizedDoiClaim(value: string): string | null {
  const normalized = value
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  return DOI_IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

function normalizedOpenAlexClaim(value: string): string | null {
  const workId = value
    .replace(/^https?:\/\/(?:www\.)?openalex\.org\//i, "")
    .replace(/^openalex:\s*/i, "")
    .trim()
    .toUpperCase();
  const normalized = `openalex:${workId}`;
  return OPENALEX_IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

function duplicateCandidateMatchesCanonical(
  candidate: WebMcpDuplicateCandidate,
  paper: Paper,
): boolean {
  const candidateIdentifiers = candidate.identifiers
    .map((identifier) => `${identifier.scheme}:${identifier.value}`)
    .sort();
  const canonicalIdentifiers = paper.identifiers
    .map((identifier) => `${identifier.scheme}:${identifier.value}`)
    .sort();
  return candidate.id === paper.id
    && candidate.title === paper.title
    && candidate.year === paper.year
    && candidate.venue === paper.venue
    && candidate.type === paper.type
    && JSON.stringify(candidate.authors) === JSON.stringify(paper.authors)
    && JSON.stringify(candidateIdentifiers) === JSON.stringify(canonicalIdentifiers);
}

function createNewIdentifierAuthorityIsCoherent(
  staged: WebMcpInboxEntry,
  canonical: Paper,
  verified: readonly VerifiedWebMcpIdentifier[],
): boolean {
  const stagedIdentifiers = staged.paper.identifiers;
  if (stagedIdentifiers.length === 0) {
    return verified.length === 0 && canonical.identifiers.length === 0;
  }

  const stagedDois = new Set<string>();
  const stagedOpenAlex = new Set<string>();
  for (const identifier of stagedIdentifiers) {
    if (identifier.scheme === "doi") {
      const doi = normalizedDoiClaim(identifier.value);
      if (!doi) return false;
      stagedDois.add(doi);
    } else if (identifier.scheme === "provider") {
      const openAlex = normalizedOpenAlexClaim(identifier.value);
      if (openAlex) stagedOpenAlex.add(openAlex);
    }
  }
  if (stagedDois.size === 0 && stagedOpenAlex.size === 0) return false;
  if (stagedDois.size > 1 || stagedOpenAlex.size > 1) return false;

  const verifiedDois = verified.filter((identifier) => identifier.scheme === "doi");
  const verifiedOpenAlex = verified.filter((identifier) => identifier.scheme === "provider");
  if (
    verifiedDois.length > 1
    || verifiedOpenAlex.length !== 1
    || !OPENALEX_IDENTIFIER_PATTERN.test(verifiedOpenAlex[0]!.value)
    || (verifiedDois[0] !== undefined
      && normalizedDoiClaim(verifiedDois[0].value) !== verifiedDois[0].value)
    || new Set(verified.map((identifier) => identifier.evidenceDigest)).size !== 1
  ) return false;

  const verifiedDoi = verifiedDois[0]?.value;
  const verifiedOpenAlexValue = verifiedOpenAlex[0]!.value;
  if (
    [...stagedDois].some((doi) => doi !== verifiedDoi)
    || [...stagedOpenAlex].some((openAlex) => openAlex !== verifiedOpenAlexValue)
  ) return false;

  const verifiedKeys = verified.map((identifier) => `${identifier.scheme}:${identifier.value}`);
  const canonicalKeys = canonical.identifiers.map(
    (identifier) => `${identifier.scheme}:${identifier.value}`,
  );
  return canonicalKeys.length === verifiedKeys.length
    && canonicalKeys.every((key) => verifiedKeys.includes(key));
}

function workspaceCommandFailure(
  value: unknown,
): Extract<WorkspaceCommandResult<never>, { ok: false }> | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "ok", "code", "aggregateVersion", "message",
  ])) return null;
  if (
    value.ok !== false
    || typeof value.code !== "string" || !WORKSPACE_COMMAND_FAILURE_CODES.has(value.code)
    || !isBoundedInteger(value.aggregateVersion, 0)
    || !boundedSafeText(value.message, 500)
  ) return null;
  return value as unknown as Extract<WorkspaceCommandResult<never>, { ok: false }>;
}

function workspaceCommandFailureMatchesStatus(
  failure: Extract<WorkspaceCommandResult<never>, { ok: false }>,
  status: number,
): boolean {
  switch (failure.code) {
    case "validation": return status === 400;
    case "not_found": return status === 404;
    case "duplicate":
    case "version_conflict":
    case "idempotency_conflict":
      return status === 409;
  }
}

function webMcpDuplicateDecision(
  value: unknown,
): PrepareWebMcpApprovalChallengeCommand["duplicateDecision"] | null {
  if (!isRecord(value)) return null;
  if (value.kind === "create_new" && hasExactKeys(value, ["kind"])) {
    return { kind: "create_new" };
  }
  if (
    value.kind === "use_existing"
    && hasExactKeys(value, ["kind", "canonicalPaperId"])
    && typeof value.canonicalPaperId === "string"
    && OPAQUE_ID_PATTERN.test(value.canonicalPaperId)
  ) {
    return { kind: "use_existing", canonicalPaperId: value.canonicalPaperId };
  }
  return null;
}

function webMcpDecisionsMatch(
  left: PrepareWebMcpApprovalChallengeCommand["duplicateDecision"],
  right: PrepareWebMcpApprovalChallengeCommand["duplicateDecision"],
): boolean {
  return left.kind === right.kind
    && (left.kind === "create_new"
      || (right.kind === "use_existing"
        && left.canonicalPaperId === right.canonicalPaperId));
}

function canonicalPublicationDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function webMcpOpenAlexSnapshot(value: unknown): WebMcpOpenAlexVerifiedSnapshot | null {
  if (
    !isRecord(value)
    || !hasRequiredAndOptionalKeys(value, [
      "schemaVersion", "kind", "authority", "authorityVersion", "retrievedAt",
      "sourceRecordId", "paper", "evidenceDigest",
    ], ["providerUpdatedAt"])
    || value.schemaVersion !== 1
    || value.kind !== "openalex_verified_work"
    || value.authority !== "OPENALEX"
    || value.authorityVersion !== "works-singleton-v1"
    || !isCanonicalTimestamp(value.retrievedAt)
    || typeof value.sourceRecordId !== "string"
    || !OPENALEX_WORK_ID_PATTERN.test(value.sourceRecordId)
    || (value.providerUpdatedAt !== undefined
      && !isCanonicalTimestamp(value.providerUpdatedAt))
    || typeof value.evidenceDigest !== "string"
    || !SHA256_PATTERN.test(value.evidenceDigest)
    || !isRecord(value.paper)
    || !hasExactKeys(value.paper, [
      "title", "abstractText", "publicationYear", "publicationDate", "language",
      "workType", "venueName", "citationCount", "isRetracted", "identifiers", "authors",
    ])
  ) return null;

  const paper = value.paper;
  if (
    !boundedSafeText(paper.title, 2_000)
    || (paper.abstractText !== null && !boundedSafeText(paper.abstractText, 200_000))
    || (paper.publicationYear !== null
      && !isBoundedInteger(paper.publicationYear, 0, 3_000))
    || (paper.publicationDate !== null && !canonicalPublicationDate(paper.publicationDate))
    || (paper.language !== null && !boundedSafeText(paper.language, 50))
    || !boundedSafeText(paper.workType, 100)
    || (paper.venueName !== null && !boundedSafeText(paper.venueName, 1_000))
    || (paper.citationCount !== null && !isBoundedInteger(paper.citationCount, 0))
    || typeof paper.isRetracted !== "boolean"
    || !Array.isArray(paper.identifiers)
    || paper.identifiers.length < 1
    || paper.identifiers.length > 2
    || !Array.isArray(paper.authors)
    || paper.authors.length > 500
  ) return null;

  let openAlexIdentifierCount = 0;
  const identifierKeys = new Set<string>();
  for (const identifier of paper.identifiers) {
    if (
      !isRecord(identifier)
      || !hasExactKeys(identifier, ["type", "value", "normalizedValue", "source"])
      || identifier.source !== "OPENALEX"
      || !boundedSafeText(identifier.value, 1_024)
      || !boundedSafeText(identifier.normalizedValue, 1_024)
    ) return null;
    if (identifier.type === "DOI") {
      const normalized = normalizedDoiClaim(identifier.value);
      if (!normalized || identifier.normalizedValue !== normalized) return null;
    } else if (identifier.type === "OPENALEX") {
      if (
        !OPENALEX_WORK_ID_PATTERN.test(identifier.value)
        || identifier.value !== value.sourceRecordId
        || identifier.normalizedValue !== identifier.value.toLowerCase()
      ) return null;
      openAlexIdentifierCount += 1;
    } else {
      return null;
    }
    const key = `${identifier.type}:${identifier.normalizedValue}`;
    if (identifierKeys.has(key)) return null;
    identifierKeys.add(key);
  }
  if (openAlexIdentifierCount !== 1) return null;

  for (let index = 0; index < paper.authors.length; index += 1) {
    const author = paper.authors[index];
    if (
      !isRecord(author)
      || !hasExactKeys(author, ["position", "displayName"])
      || author.position !== index
      || !boundedSafeText(author.displayName, 300)
    ) return null;
  }
  return value as unknown as WebMcpOpenAlexVerifiedSnapshot;
}

function webMcpVerifiedAuthoritySnapshot(
  value: unknown,
  command: PrepareWebMcpApprovalChallengeCommand,
): WebMcpVerifiedAuthoritySnapshot | null {
  const openAlex = webMcpOpenAlexSnapshot(value);
  if (openAlex) return openAlex;
  if (!isRecord(value)) return null;
  if (
    hasExactKeys(value, [
      "schemaVersion", "kind", "authority", "authorityVersion", "proposalDigest",
      "evidenceDigest",
    ])
    && value.schemaVersion === 1
    && value.kind === "human_review_identifier_free"
    && value.authority === "HUMAN_REVIEW"
    && value.authorityVersion === "human-review-v1"
    && value.proposalDigest === command.proposalDigest
    && typeof value.evidenceDigest === "string"
    && SHA256_PATTERN.test(value.evidenceDigest)
    && command.duplicateDecision.kind === "create_new"
  ) return value as unknown as WebMcpHumanReviewVerifiedSnapshot;
  if (
    hasExactKeys(value, [
      "schemaVersion", "kind", "authority", "authorityVersion", "proposalDigest",
      "canonicalPaperId", "evidenceDigest",
    ])
    && value.schemaVersion === 1
    && value.kind === "existing_canonical"
    && value.authority === "EXISTING_CANONICAL"
    && value.authorityVersion === "existing-canonical-v1"
    && value.proposalDigest === command.proposalDigest
    && typeof value.canonicalPaperId === "string"
    && OPAQUE_ID_PATTERN.test(value.canonicalPaperId)
    && command.duplicateDecision.kind === "use_existing"
    && value.canonicalPaperId === command.duplicateDecision.canonicalPaperId
    && typeof value.evidenceDigest === "string"
    && SHA256_PATTERN.test(value.evidenceDigest)
  ) return value as unknown as WebMcpExistingCanonicalVerifiedSnapshot;
  return null;
}

function webMcpEvidenceCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(webMcpEvidenceCanonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${webMcpEvidenceCanonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function webMcpEvidenceDigest(value: unknown): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(webMcpEvidenceCanonicalJson(value)),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** Decode a closed challenge and bind every returned intent field to the request. */
export async function parsePrepareWebMcpApprovalChallengeResponse(
  value: unknown,
  command: PrepareWebMcpApprovalChallengeCommand,
): Promise<PrepareWebMcpApprovalChallengeResponse | null> {
  const failure = workspaceCommandFailure(value);
  if (failure) return failure;
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["ok", "outcome", "aggregateVersion", "data"])
    || value.ok !== true
    || value.outcome !== "applied"
    || value.aggregateVersion !== command.expectedVersion
    || !isRecord(value.data)
    || !hasExactKeys(value.data, ["challenge"])
    || !isRecord(value.data.challenge)
    || !hasExactKeys(value.data.challenge, [
      "schemaVersion", "challengeId", "expiresAt", "expectedVersion", "inboxEntryId",
      "proposalDigest", "destinationProjectId", "duplicateDecision", "evidence",
    ])
  ) return null;
  const challenge = value.data.challenge;
  const decision = webMcpDuplicateDecision(challenge.duplicateDecision);
  if (
    challenge.schemaVersion !== 1
    || typeof challenge.challengeId !== "string"
    || !WEB_MCP_CHALLENGE_ID_PATTERN.test(challenge.challengeId)
    || !isCanonicalTimestamp(challenge.expiresAt)
    || challenge.expectedVersion !== command.expectedVersion
    || challenge.inboxEntryId !== command.inboxEntryId
    || challenge.proposalDigest !== command.proposalDigest
    || challenge.destinationProjectId !== command.destinationProjectId
    || !decision
    || !webMcpDecisionsMatch(decision, command.duplicateDecision)
    || !isRecord(challenge.evidence)
    || !hasExactKeys(challenge.evidence, [
      "authority", "authorityVersion", "evidenceDigest", "verifiedSnapshot",
    ])
    || typeof challenge.evidence.evidenceDigest !== "string"
    || !SHA256_PATTERN.test(challenge.evidence.evidenceDigest)
  ) return null;
  const snapshot = webMcpVerifiedAuthoritySnapshot(
    challenge.evidence.verifiedSnapshot,
    command,
  );
  if (
    !snapshot
    || challenge.evidence.authority !== snapshot.authority
    || challenge.evidence.authorityVersion !== snapshot.authorityVersion
    || challenge.evidence.evidenceDigest !== snapshot.evidenceDigest
    || (snapshot.authority === "OPENALEX" && decision.kind !== "create_new")
  ) return null;
  const { evidenceDigest, ...evidenceWithoutDigest } = snapshot;
  if (await webMcpEvidenceDigest(evidenceWithoutDigest) !== evidenceDigest) return null;
  return {
    ok: true,
    outcome: "applied",
    aggregateVersion: value.aggregateVersion,
    data: {
      challenge: {
        schemaVersion: 1,
        challengeId: challenge.challengeId,
        expiresAt: challenge.expiresAt,
        expectedVersion: challenge.expectedVersion,
        inboxEntryId: challenge.inboxEntryId,
        proposalDigest: challenge.proposalDigest,
        destinationProjectId: challenge.destinationProjectId,
        duplicateDecision: decision,
        evidence: {
          authority: snapshot.authority,
          authorityVersion: snapshot.authorityVersion,
          evidenceDigest: snapshot.evidenceDigest,
          verifiedSnapshot: snapshot,
        },
      } satisfies WebMcpApprovalEvidenceDossier,
    },
  };
}

function exactWebMcpApprovalCommand(
  value: unknown,
): ApproveWebMcpProposalCommand | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion", "clientOperationId", "expectedVersion", "inboxEntryId",
      "proposalDigest", "destinationProjectId", "duplicateDecision", "challengeId",
      "evidenceDigest",
    ])
    || value.schemaVersion !== 2
    || typeof value.clientOperationId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.clientOperationId)
    || !isBoundedInteger(value.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1)
    || typeof value.inboxEntryId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.inboxEntryId)
    || typeof value.proposalDigest !== "string"
    || !SHA256_PATTERN.test(value.proposalDigest)
    || typeof value.destinationProjectId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.destinationProjectId)
    || typeof value.challengeId !== "string"
    || !WEB_MCP_CHALLENGE_ID_PATTERN.test(value.challengeId)
    || typeof value.evidenceDigest !== "string"
    || !SHA256_PATTERN.test(value.evidenceDigest)
  ) return null;
  const decision = webMcpDuplicateDecision(value.duplicateDecision);
  if (!decision) return null;
  return {
    schemaVersion: 2,
    clientOperationId: value.clientOperationId,
    expectedVersion: value.expectedVersion,
    inboxEntryId: value.inboxEntryId,
    proposalDigest: value.proposalDigest,
    destinationProjectId: value.destinationProjectId,
    duplicateDecision: decision,
    challengeId: value.challengeId,
    evidenceDigest: value.evidenceDigest,
  };
}

/** Create the one immutable byte sequence used by every final-consent retry. */
export function freezeWebMcpApprovalSubmission(
  value: ApproveWebMcpProposalCommand,
): FrozenWebMcpApprovalSubmission {
  const command = exactWebMcpApprovalCommand(value);
  if (!command) {
    throw new TypeError("A WebMCP approval requires an exact schema-v2 evidence-bound command.");
  }
  const frozenDecision = Object.freeze({ ...command.duplicateDecision });
  const frozenCommand = Object.freeze({
    ...command,
    duplicateDecision: frozenDecision,
  }) as ApproveWebMcpProposalCommand;
  return Object.freeze({
    command: frozenCommand,
    serializedBody: JSON.stringify(frozenCommand),
  });
}

export function parseOrdinaryStageImportResponse(
  value: unknown,
  command: StageImportCommand,
): WorkspaceCommandResult<OrdinaryStageImportResult> | null {
  const failure = workspaceCommandFailure(value);
  if (failure) return failure;
  if (!isRecord(value) || !hasExactKeys(value, [
    "ok", "outcome", "aggregateVersion", "data",
  ])
    || value.ok !== true
    || (value.outcome !== "applied" && value.outcome !== "noop" && value.outcome !== "replayed")
    || !isBoundedInteger(value.aggregateVersion, 0)
    || !isRecord(value.data)
    || !hasRequiredAndOptionalKeys(value.data, ["inboxEntry"], ["duplicatePaperId"])) return null;
  const inboxEntry = paperInboxEntryReadModel(value.data.inboxEntry);
  const duplicatePaperId = value.data.duplicatePaperId;
  if (
    !inboxEntry
    || inboxEntry.sourceKind === "webmcp"
    || inboxEntry.sourceKind === "upload"
    || inboxEntry.sourceKind !== command.sourceKind
    || (inboxEntry.status !== "awaiting-review"
      && inboxEntry.status !== "possible-duplicate"
      && inboxEntry.status !== "ready")
    || inboxEntry.provenance.sourceType === "uploaded-file"
    || inboxEntry.provenance.accessMethod === "upload"
    || inboxEntry.provenance.accessMethod === "oauth"
    || inboxEntry.provenance.accessMethod === "crawler"
    || inboxEntry.provenance.accessMethod === "mcp"
    || inboxEntry.provenance.accessMethod === "webmcp"
    || inboxEntry.provenance.providerName === "PaperPilot WebMCP"
    || (duplicatePaperId !== undefined
      && (typeof duplicatePaperId !== "string" || !OPAQUE_ID_PATTERN.test(duplicatePaperId)))
    || inboxEntry.duplicateOfPaperId !== duplicatePaperId
  ) return null;
  return {
    ok: true,
    outcome: value.outcome,
    aggregateVersion: value.aggregateVersion,
    data: {
      inboxEntry,
      ...(duplicatePaperId ? { duplicatePaperId } : {}),
    },
  };
}

export function parseOrdinaryFileImportResponse(
  value: unknown,
  command: FileImportCommand,
): WorkspaceCommandResult<OrdinaryFileImportResult> | null {
  const failure = workspaceCommandFailure(value);
  if (failure) return failure;
  if (!isRecord(value) || !hasExactKeys(value, [
    "ok", "outcome", "aggregateVersion", "data",
  ])
    || value.ok !== true
    || (value.outcome !== "applied" && value.outcome !== "noop" && value.outcome !== "replayed")
    || !isBoundedInteger(value.aggregateVersion, 0)
    || !isRecord(value.data)
    || !hasExactKeys(value.data, [
      "inboxEntry", "paper", "project", "usedExistingPaper",
    ])) return null;
  const inboxEntry = paperInboxEntryReadModel(value.data.inboxEntry);
  const paper = paperReadModel(value.data.paper);
  const project = researchProjectReadModel(value.data.project)
    ? value.data.project as unknown as WorkspaceProjectDto["project"]
    : null;
  if (
    !inboxEntry
    || inboxEntry.sourceKind === "webmcp"
    || inboxEntry.sourceKind === "upload"
    || inboxEntry.id !== command.inboxEntryId
    || inboxEntry.status !== "ready"
    || inboxEntry.destinationProjectId !== command.projectId
    || inboxEntry.provenance.accessMethod === "webmcp"
    || inboxEntry.provenance.providerName === "PaperPilot WebMCP"
    || !paper
    || !project
    || project.id !== command.projectId
    || !project.paperIds.includes(paper.id)
    || typeof value.data.usedExistingPaper !== "boolean"
    || (inboxEntry.duplicateOfPaperId !== undefined
      && inboxEntry.duplicateOfPaperId !== paper.id)
  ) return null;
  return {
    ok: true,
    outcome: value.outcome,
    aggregateVersion: value.aggregateVersion,
    data: {
      inboxEntry,
      paper,
      project,
      usedExistingPaper: value.data.usedExistingPaper,
    },
  };
}

/** Decode the complete approval result before UI state can treat it as filed. */
export function parseApproveWebMcpProposalResponse(
  value: unknown,
): ApproveWebMcpProposalResponse | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok === false) {
    if (!hasExactKeys(value, ["ok", "code", "aggregateVersion", "message"])) return null;
    if (
      typeof value.code !== "string" || !WORKSPACE_COMMAND_FAILURE_CODES.has(value.code)
      || !isBoundedInteger(value.aggregateVersion, 0)
      || !boundedSafeText(value.message, 500)
    ) return null;
    return value as unknown as ApproveWebMcpProposalResponse;
  }
  if (!hasExactKeys(value, ["ok", "outcome", "aggregateVersion", "data"])
    || (value.outcome !== "applied" && value.outcome !== "replayed")
    || !isBoundedInteger(value.aggregateVersion, 0)
    || !isRecord(value.data)
    || !hasExactKeys(value.data, [
      "approval", "inboxEntry", "paper", "project", "usedExistingPaper",
    ])
    || !isRecord(value.data.approval)
    || !hasExactKeys(value.data.approval, [
      "id", "challengeId", "inboxEntryId", "proposalDigest", "destinationProjectId",
      "decision", "canonicalPaperId", "evidenceDigest", "verifiedIdentifiers", "approvedAt",
    ])) return null;

  const approval = value.data.approval;
  const inboxEntry = paperInboxEntryReadModel(value.data.inboxEntry);
  const paper = paperReadModel(value.data.paper);
  const project = researchProjectReadModel(value.data.project)
    ? value.data.project as unknown as WorkspaceProjectDto["project"]
    : null;
  if (
    typeof approval.id !== "string" || !OPAQUE_ID_PATTERN.test(approval.id)
    || typeof approval.challengeId !== "string"
    || !WEB_MCP_CHALLENGE_ID_PATTERN.test(approval.challengeId)
    || typeof approval.inboxEntryId !== "string" || !OPAQUE_ID_PATTERN.test(approval.inboxEntryId)
    || typeof approval.proposalDigest !== "string" || !SHA256_PATTERN.test(approval.proposalDigest)
    || typeof approval.destinationProjectId !== "string"
    || !OPAQUE_ID_PATTERN.test(approval.destinationProjectId)
    || (approval.decision !== "create_new" && approval.decision !== "use_existing")
    || typeof approval.canonicalPaperId !== "string"
    || !OPAQUE_ID_PATTERN.test(approval.canonicalPaperId)
    || typeof approval.evidenceDigest !== "string"
    || !SHA256_PATTERN.test(approval.evidenceDigest)
    || !Array.isArray(approval.verifiedIdentifiers)
    || approval.verifiedIdentifiers.length > 32
    || !isCanonicalTimestamp(approval.approvedAt)
    || !inboxEntry || inboxEntry.sourceKind !== "webmcp" || !("proposalDigest" in inboxEntry)
    || !paper
    || !project
    || typeof value.data.usedExistingPaper !== "boolean"
    || value.data.usedExistingPaper !== (approval.decision === "use_existing")
    || inboxEntry.id !== approval.inboxEntryId
    || inboxEntry.proposalDigest !== approval.proposalDigest
    || inboxEntry.destinationProjectId !== approval.destinationProjectId
    || inboxEntry.status !== "ready"
    || paper.id !== approval.canonicalPaperId
    || project.id !== approval.destinationProjectId
    || !project.paperIds.includes(paper.id)
  ) return null;

  const verifiedIdentifiers = approval.verifiedIdentifiers as unknown[];
  if (!verifiedIdentifiers.every((identifier) =>
    isRecord(identifier)
      && hasExactKeys(identifier, ["scheme", "value", "authority", "evidenceDigest"])
      && typeof identifier.scheme === "string"
      && VERIFIED_WEB_MCP_IDENTIFIER_SCHEMES.has(identifier.scheme)
      && boundedSafeText(identifier.value, 1_024)
      && identifier.value === identifier.value.trim()
      && identifier.authority === "openalex"
      && typeof identifier.evidenceDigest === "string"
      && SHA256_PATTERN.test(identifier.evidenceDigest)
      && identifier.evidenceDigest === approval.evidenceDigest)) return null;
  const verifiedKeys = verifiedIdentifiers.map((identifier) => {
    const record = identifier as Record<string, unknown>;
    return `${record.scheme}:${record.value}`;
  });
  if (new Set(verifiedKeys).size !== verifiedKeys.length) return null;
  const parsedVerifiedIdentifiers = verifiedIdentifiers as VerifiedWebMcpIdentifier[];
  if (approval.decision === "create_new") {
    if (
      inboxEntry.duplicateOfPaperId !== undefined
      || inboxEntry.duplicateCandidate !== undefined
      || !createNewIdentifierAuthorityIsCoherent(
        inboxEntry,
        paper,
        parsedVerifiedIdentifiers,
      )
    ) return null;
  } else {
    if (
      verifiedKeys.length !== 0
      || inboxEntry.duplicateOfPaperId !== approval.canonicalPaperId
      || !inboxEntry.duplicateCandidate
      || !duplicateCandidateMatchesCanonical(inboxEntry.duplicateCandidate, paper)
    ) return null;
  }

  return {
    ok: true,
    outcome: value.outcome,
    aggregateVersion: value.aggregateVersion,
    data: {
      approval: approval as unknown as Extract<ApproveWebMcpProposalResponse, { ok: true }>["data"]["approval"],
      inboxEntry,
      paper,
      project,
      usedExistingPaper: value.data.usedExistingPaper,
    },
  };
}

export function parseCaptureGroundedEvidenceResponse(
  value: unknown,
  expectedPaperId?: string,
): CaptureGroundedEvidenceResponse | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok === false) {
    if (!hasExactKeys(value, ["ok", "code", "aggregateVersion", "message"])) return null;
    if (
      typeof value.code !== "string" || !GROUNDED_FAILURE_CODES.has(value.code)
      || !isBoundedInteger(value.aggregateVersion, 0)
      || typeof value.message !== "string" || !value.message.trim() || value.message.length > 500
    ) return null;
    return value as unknown as CaptureGroundedEvidenceResponse;
  }
  if (!hasExactKeys(value, ["ok", "outcome", "aggregateVersion", "data"])) return null;
  if (
    (value.outcome !== "applied" && value.outcome !== "replayed")
    || !isBoundedInteger(value.aggregateVersion, 0)
    || !isRecord(value.data)
    || !hasExactKeys(value.data, ["note", "linkedProjectIds", "updatedCollectionIds", "grounding"])
    || !Array.isArray(value.data.linkedProjectIds)
    || !value.data.linkedProjectIds.every((id) => typeof id === "string" && OPAQUE_ID_PATTERN.test(id))
    || new Set(value.data.linkedProjectIds).size !== value.data.linkedProjectIds.length
    || !Array.isArray(value.data.updatedCollectionIds)
    || !value.data.updatedCollectionIds.every((id) => typeof id === "string" && OPAQUE_ID_PATTERN.test(id))
    || new Set(value.data.updatedCollectionIds).size !== value.data.updatedCollectionIds.length
  ) return null;
  const linkedProjectIds = value.data.linkedProjectIds as string[];
  const updatedCollectionIds = value.data.updatedCollectionIds as string[];
  const grounding = groundedEvidenceAnchor(
    value.data.grounding,
    value.outcome === "applied" ? "current" : undefined,
  );
  if (!grounding) return null;
  const note = groundedEvidenceNote(value.data.note, grounding, {
    expectedPaperId,
    expectedStatus: "captured",
    allowSupersededRoot: value.outcome === "replayed",
  });
  if (
    !note
    || !note.grounding
    || JSON.stringify(note.grounding) !== JSON.stringify(grounding)
  ) return null;
  if (
    note.collectionIds.length !== updatedCollectionIds.length
    || !note.collectionIds.every((id) => updatedCollectionIds.includes(id))
  ) return null;
  return {
    ok: true,
    outcome: value.outcome,
    aggregateVersion: value.aggregateVersion,
    data: {
      note,
      linkedProjectIds: [...linkedProjectIds],
      updatedCollectionIds: [...updatedCollectionIds],
      grounding,
    },
  };
}

const EVIDENCE_REVISION_FAILURE_CODES = new Set([
  "not_found",
  "version_conflict",
  "idempotency_conflict",
  "selection_conflict",
  "revision_conflict",
]);

export function parseCreateEvidenceRevisionResponse(
  value: unknown,
  action: CreateEvidenceRevisionCommand["action"],
  expectedPredecessorId?: string,
): CreateEvidenceRevisionResponse | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok === false) {
    if (!hasExactKeys(value, ["ok", "code", "aggregateVersion", "message"])) return null;
    if (
      typeof value.code !== "string" || !EVIDENCE_REVISION_FAILURE_CODES.has(value.code)
      || !isBoundedInteger(value.aggregateVersion, 0)
      || !boundedSafeText(value.message, 500)
    ) return null;
    return value as unknown as CreateEvidenceRevisionResponse;
  }
  if (
    !hasExactKeys(value, ["ok", "outcome", "aggregateVersion", "data"])
    || (value.outcome !== "applied" && value.outcome !== "replayed")
    || !isBoundedInteger(value.aggregateVersion, 0)
    || !isRecord(value.data)
    || !hasExactKeys(value.data, [
      "predecessorId", "note", "linkedProjectIds", "updatedCollectionIds",
    ])
    || typeof value.data.predecessorId !== "string"
    || !OPAQUE_ID_PATTERN.test(value.data.predecessorId)
    || (expectedPredecessorId !== undefined && value.data.predecessorId !== expectedPredecessorId)
    || !Array.isArray(value.data.linkedProjectIds)
    || !value.data.linkedProjectIds.every((id) => typeof id === "string" && OPAQUE_ID_PATTERN.test(id))
    || new Set(value.data.linkedProjectIds).size !== value.data.linkedProjectIds.length
    || !Array.isArray(value.data.updatedCollectionIds)
    || !value.data.updatedCollectionIds.every((id) => typeof id === "string" && OPAQUE_ID_PATTERN.test(id))
    || new Set(value.data.updatedCollectionIds).size !== value.data.updatedCollectionIds.length
    || !isRecord(value.data.note)
  ) return null;
  const grounding = groundedEvidenceAnchor(
    value.data.note.grounding,
    undefined,
  );
  if (!grounding) return null;
  const note = groundedEvidenceNote(value.data.note, grounding, {
    expectedStatus: action === "verify" ? "verified" : "captured",
    expectedPredecessorId: value.data.predecessorId,
  });
  if (
    !note
    || note.id === value.data.predecessorId
    || (value.outcome === "applied" && !note.revision.isLatest)
  ) return null;
  const linkedProjectIds = value.data.linkedProjectIds as string[];
  const updatedCollectionIds = value.data.updatedCollectionIds as string[];
  if (
    note.collectionIds.length !== updatedCollectionIds.length
    || !note.collectionIds.every((id) => updatedCollectionIds.includes(id))
  ) return null;
  return {
    ok: true,
    outcome: value.outcome,
    aggregateVersion: value.aggregateVersion,
    data: {
      predecessorId: value.data.predecessorId,
      note,
      linkedProjectIds: [...linkedProjectIds],
      updatedCollectionIds: [...updatedCollectionIds],
    },
  };
}

/** Parse the server's closed Reader union without creating fallback text. */
export function parseWorkspacePaperReader(
  value: unknown,
  expectedSequence = 0,
): WorkspacePaperReaderDto | null {
  if (!isBoundedInteger(expectedSequence, 0, MAX_READER_CHUNK_COUNT - 1)) return null;
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.state !== "string") {
    return null;
  }
  if (value.state === "unavailable") {
    return hasExactKeys(value, ["schemaVersion", "state"])
      ? { schemaVersion: 1, state: "unavailable" }
      : null;
  }
  const document = readerDocumentMetadata(value.document);
  if (!document) return null;
  if (value.state === "processing") {
    if (
      !hasExactKeys(value, ["schemaVersion", "state", "document", "extractionPolicyVersion"])
      || typeof value.extractionPolicyVersion !== "string"
      || !SAFE_VALUE_PATTERN.test(value.extractionPolicyVersion)
    ) return null;
    return {
      schemaVersion: 1,
      state: "processing",
      document,
      extractionPolicyVersion: value.extractionPolicyVersion,
    };
  }
  const generation = readerGenerationMetadata(value.generation);
  if (
    !generation
    || generation.validationAttestationId !== document.validationAttestationId
    || generation.pageCount !== document.pageCount
    || document.validatedAt > generation.extractedAt
  ) return null;
  if (value.state === "no-text") {
    if (
      !hasExactKeys(value, ["schemaVersion", "state", "document", "generation"])
      || generation.verdict !== "NO_TEXT"
      || generation.chunkCount !== 0
      || generation.textBytes !== 0
    ) return null;
    return { schemaVersion: 1, state: "no-text", document, generation };
  }
  if (value.state !== "ready" || !hasExactKeys(value, [
    "schemaVersion",
    "state",
    "document",
    "generation",
    "chunks",
    "nextCursor",
  ])
    || generation.verdict !== "EXTRACTED"
    || generation.chunkCount < 1
    || generation.textBytes < 1
    || !Array.isArray(value.chunks)
    || value.chunks.length < 1
    || value.chunks.length > 100
  ) return null;
  const chunks = value.chunks.map(readerChunk);
  if (chunks.some((chunk) => chunk === null)) return null;
  const parsedChunks = chunks as ReaderTextChunk[];
  for (let index = 0; index < parsedChunks.length; index += 1) {
    const chunk = parsedChunks[index];
    if (
      !chunk
      || chunk.pageNumber > document.pageCount
      || chunk.sequence >= generation.chunkCount
      || chunk.sequence !== expectedSequence + index
      || new TextEncoder().encode(chunk.text).byteLength > generation.textBytes
    ) return null;
  }
  if (value.nextCursor === null) {
    if (parsedChunks.at(-1)!.sequence !== generation.chunkCount - 1) return null;
  } else if (
    !isOpaqueReaderCursor(value.nextCursor)
    || parsedChunks.at(-1)!.sequence >= generation.chunkCount - 1
  ) return null;
  return {
    schemaVersion: 1,
    state: "ready",
    document,
    generation,
    chunks: parsedChunks,
    nextCursor: value.nextCursor as string | null,
  };
}

type XhrFactory = () => XMLHttpRequest;
const DEFAULT_WEB_MCP_APPROVAL_TIMEOUT_MS = 15_000;
const MAX_WEB_MCP_APPROVAL_TIMEOUT_MS = 30_000;

export class HttpWorkspaceClient implements UploadWorkspaceClient {
  private workspaceId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly xhrFactory: XhrFactory;
  private readonly webMcpApprovalTimeoutMs: number;

  constructor(
    initialWorkspaceId?: string,
    fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
    xhrFactory: XhrFactory = () => new XMLHttpRequest(),
    webMcpApprovalTimeoutMs = DEFAULT_WEB_MCP_APPROVAL_TIMEOUT_MS,
  ) {
    this.workspaceId = initialWorkspaceId;
    this.fetchImpl = fetchImpl;
    this.xhrFactory = xhrFactory;
    this.webMcpApprovalTimeoutMs = Number.isSafeInteger(webMcpApprovalTimeoutMs)
      && webMcpApprovalTimeoutMs > 0
      ? Math.min(webMcpApprovalTimeoutMs, MAX_WEB_MCP_APPROVAL_TIMEOUT_MS)
      : DEFAULT_WEB_MCP_APPROVAL_TIMEOUT_MS;
  }

  async bootstrap(): Promise<WorkspaceBootstrapDto> {
    const response = await this.fetchImpl("/api/workspaces/current/bootstrap", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const payload: unknown = await response.json().catch(() => undefined);
    const bootstrap = parseWorkspaceBootstrap(payload);
    if (!response.ok || !bootstrap) {
      throw new Error(apiMessage(payload, "PaperPilot could not load the authenticated workspace."));
    }
    this.workspaceId = bootstrap.workspace.id;
    return bootstrap;
  }

  async getProject(query: GetWorkspaceProjectQuery): Promise<WorkspaceProjectDto | null> {
    const workspaceId = this.requireWorkspaceId();
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(query.projectId)}`,
      { credentials: "same-origin", cache: "no-store" },
    );
    if (response.status === 404) return null;
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(apiMessage(payload, "PaperPilot could not load this project."));
    }
    const project = parseWorkspaceProject(payload, query.projectId);
    if (!project) {
      throw new Error(apiMessage(payload, "PaperPilot could not load this project."));
    }
    return project;
  }

  createProject(
    command: CreateProjectCommand,
  ): Promise<WorkspaceCommandResult<CreateProjectResult>> {
    return this.postCommand("projects", command);
  }

  createCollection(
    command: CreateCollectionCommand,
  ): Promise<WorkspaceCommandResult<CreateCollectionResult>> {
    return this.postCommand("collections", command);
  }

  async stageImport(
    command: StageImportCommand,
  ): Promise<WorkspaceCommandResult<OrdinaryStageImportResult>> {
    if (
      (command.sourceKind !== "discover" && command.sourceKind !== "identifier")
      || !OPAQUE_ID_PATTERN.test(command.clientOperationId)
      || !isBoundedInteger(command.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1)
    ) throw new TypeError("A generic import requires an ordinary source and exact command envelope.");
    const workspaceId = this.requireWorkspaceId();
    const requestBody: StageImportCommand = {
      clientOperationId: command.clientOperationId,
      expectedVersion: command.expectedVersion,
      sourceKind: command.sourceKind,
      paper: command.paper,
      provenance: command.provenance,
    };
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/imports`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": command.clientOperationId,
        },
        body: JSON.stringify(requestBody),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = parseOrdinaryStageImportResponse(payload, command);
    if (parsed?.ok) {
      const versionMatches = parsed.outcome === "applied"
        ? response.status === 201 && parsed.aggregateVersion === command.expectedVersion + 1
        : parsed.outcome === "noop"
          ? response.status === 200 && parsed.aggregateVersion === command.expectedVersion
          : response.status === 200 && parsed.aggregateVersion >= command.expectedVersion;
      if (versionMatches) return parsed;
    } else if (parsed && !response.ok) {
      return parsed;
    }
    if (!response.ok) {
      throw this.httpError(
        response.status,
        response.headers,
        payload,
        "PaperPilot could not stage this paper.",
      );
    }
    throw new Error(apiMessage(payload, "PaperPilot received an invalid import response."));
  }

  async fileImport(
    command: FileImportCommand,
  ): Promise<WorkspaceCommandResult<OrdinaryFileImportResult>> {
    if (
      !OPAQUE_ID_PATTERN.test(command.clientOperationId)
      || !isBoundedInteger(command.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1)
      || !OPAQUE_ID_PATTERN.test(command.inboxEntryId)
      || !OPAQUE_ID_PATTERN.test(command.projectId)
    ) throw new TypeError("Generic filing requires an exact ordinary import command.");
    const workspaceId = this.requireWorkspaceId();
    const requestBody: FileImportCommand = {
      clientOperationId: command.clientOperationId,
      expectedVersion: command.expectedVersion,
      inboxEntryId: command.inboxEntryId,
      projectId: command.projectId,
    };
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/imports/${encodeURIComponent(command.inboxEntryId)}/file`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": command.clientOperationId,
        },
        body: JSON.stringify(requestBody),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = parseOrdinaryFileImportResponse(payload, command);
    if (parsed?.ok) {
      const versionMatches = parsed.outcome === "applied"
        ? response.status === 201 && parsed.aggregateVersion === command.expectedVersion + 1
        : parsed.outcome === "noop"
          ? response.status === 200 && parsed.aggregateVersion === command.expectedVersion
          : response.status === 200 && parsed.aggregateVersion >= command.expectedVersion;
      if (versionMatches) return parsed;
    } else if (parsed && !response.ok) {
      return parsed;
    }
    if (!response.ok) {
      throw this.httpError(
        response.status,
        response.headers,
        payload,
        "PaperPilot could not file this paper.",
      );
    }
    throw new Error(apiMessage(payload, "PaperPilot received an invalid filing response."));
  }

  async prepareWebMcpApprovalChallenge(
    command: PrepareWebMcpApprovalChallengeCommand,
  ): Promise<PrepareWebMcpApprovalChallengeResponse> {
    const workspaceId = this.requireWorkspaceId();
    if (
      command.schemaVersion !== 1
      || !isRecord(command)
      || !hasExactKeys(command, [
        "schemaVersion", "expectedVersion", "inboxEntryId", "proposalDigest",
        "destinationProjectId", "duplicateDecision",
      ])
      || !isBoundedInteger(command.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1)
      || typeof command.inboxEntryId !== "string"
      || !OPAQUE_ID_PATTERN.test(command.inboxEntryId)
      || typeof command.proposalDigest !== "string"
      || !SHA256_PATTERN.test(command.proposalDigest)
      || typeof command.destinationProjectId !== "string"
      || !OPAQUE_ID_PATTERN.test(command.destinationProjectId)
      || !webMcpDuplicateDecision(command.duplicateDecision)
    ) {
      throw new TypeError("WebMCP evidence preparation requires an exact schema-v1 intent.");
    }
    const decision = webMcpDuplicateDecision(command.duplicateDecision)!;
    const requestBody: PrepareWebMcpApprovalChallengeCommand = {
      schemaVersion: 1,
      expectedVersion: command.expectedVersion,
      inboxEntryId: command.inboxEntryId,
      proposalDigest: command.proposalDigest,
      destinationProjectId: command.destinationProjectId,
      duplicateDecision: decision,
    };
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/webmcp/proposals/${encodeURIComponent(command.inboxEntryId)}/approval-challenges`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = await parsePrepareWebMcpApprovalChallengeResponse(payload, requestBody);
    if (parsed?.ok && response.status === 201) return parsed;
    if (parsed && !parsed.ok && workspaceCommandFailureMatchesStatus(parsed, response.status)) {
      return parsed;
    }
    if (!response.ok) {
      throw this.httpError(
        response.status,
        response.headers,
        payload,
        "PaperPilot could not prepare WebMCP authority evidence.",
      );
    }
    throw new Error(apiMessage(
      payload,
      "PaperPilot received an invalid WebMCP evidence challenge.",
    ));
  }

  async approveWebMcpProposal(
    submission: FrozenWebMcpApprovalSubmission,
  ): Promise<ApproveWebMcpProposalResponse> {
    const workspaceId = this.requireWorkspaceId();
    if (
      !isRecord(submission)
      || !hasExactKeys(submission, ["command", "serializedBody"])
      || typeof submission.serializedBody !== "string"
      || submission.serializedBody.length > 16 * 1_024
    ) {
      throw new TypeError("A WebMCP approval requires one frozen schema-v2 submission.");
    }
    const command = exactWebMcpApprovalCommand(submission.command);
    if (!command || submission.serializedBody !== JSON.stringify(command)) {
      throw new TypeError("The frozen WebMCP approval body does not match its exact command.");
    }
    const timeoutController = new AbortController();
    const timeoutId = globalThis.setTimeout(() => {
      timeoutController.abort(new DOMException(
        `PaperPilot could not confirm whether the WebMCP approval completed. Retry with the same operation key: ${command.clientOperationId}.`,
        "TimeoutError",
      ));
    }, this.webMcpApprovalTimeoutMs);
    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetchImpl(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/webmcp/proposals/${encodeURIComponent(command.inboxEntryId)}/approval`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": command.clientOperationId,
          },
          // Never reconstruct this body on retry. The same operation key and
          // the exact same bytes are the only safe reconciliation mechanism
          // after a timeout or broken response stream.
          body: submission.serializedBody,
          signal: timeoutController.signal,
        },
      );
      try {
        payload = await response.json();
      } catch {
        if (timeoutController.signal.aborted) throw timeoutController.signal.reason;
        payload = undefined;
      }
    } catch (error) {
      if (timeoutController.signal.aborted) throw timeoutController.signal.reason;
      throw error;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
    const parsed = parseApproveWebMcpProposalResponse(payload);
    if (parsed?.ok) {
      const approval = parsed.data.approval;
      const matchesDecision = command.duplicateDecision.kind === "create_new"
        ? approval.decision === "create_new" && !parsed.data.usedExistingPaper
        : approval.decision === "use_existing"
          && parsed.data.usedExistingPaper
          && approval.canonicalPaperId === command.duplicateDecision.canonicalPaperId;
      const nextVersion = command.expectedVersion + 1;
      const transportMatchesOutcome = parsed.outcome === "applied"
        ? response.status === 201 && parsed.aggregateVersion === nextVersion
        : response.status === 200 && parsed.aggregateVersion >= nextVersion;
      if (
        approval.inboxEntryId === command.inboxEntryId
        && approval.challengeId === command.challengeId
        && approval.proposalDigest === command.proposalDigest
        && approval.destinationProjectId === command.destinationProjectId
        && approval.evidenceDigest === command.evidenceDigest
        && matchesDecision
        && transportMatchesOutcome
      ) return parsed;
    } else if (
      parsed
      && !parsed.ok
      && workspaceCommandFailureMatchesStatus(parsed, response.status)
    ) {
      return parsed;
    }
    if (!response.ok) {
      throw this.httpError(
        response.status,
        response.headers,
        payload,
        "PaperPilot could not approve this WebMCP proposal.",
      );
    }
    throw new Error(apiMessage(
      payload,
      "PaperPilot received an invalid WebMCP approval response.",
    ));
  }

  createUploadSession(
    command: CreateUploadSessionCommand,
  ): Promise<WorkspaceCommandResult<CreateUploadSessionResult>> {
    return this.postCommand("uploads", command);
  }

  linkValidatedDocument(
    documentId: string,
    command: LinkValidatedDocumentCommand,
  ): Promise<WorkspaceCommandResult<LinkValidatedDocumentResult>> {
    return this.postCommand(
      `documents/${encodeURIComponent(documentId)}/link`,
      command,
    );
  }

  async getPaperReader(
    paperId: string,
    options: ReaderPageOptions = {},
  ): Promise<WorkspacePaperReaderDto> {
    const workspaceId = this.requireWorkspaceId();
    const expectedSequence = options.cursor === undefined ? 0 : options.expectedSequence;
    if (
      (options.cursor === undefined
        && options.expectedSequence !== undefined
        && options.expectedSequence !== 0)
      || (options.cursor !== undefined
        && (!isOpaqueReaderCursor(options.cursor)
          || !isBoundedInteger(expectedSequence, 1, MAX_READER_CHUNK_COUNT - 1)))
    ) {
      throw new TypeError("A Reader continuation requires its opaque cursor and expected sequence.");
    }
    const parameters = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor !== undefined) parameters.set("cursor", options.cursor);
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/papers/${encodeURIComponent(paperId)}/reader?${parameters}`,
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: options.signal,
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = parseWorkspacePaperReader(
      payload,
      expectedSequence,
    );
    if (!response.ok || !parsed || (parsed.state !== "unavailable" && parsed.document.paperId !== paperId)) {
      throw this.httpError(
        response.status,
        response.headers,
        payload,
        "PaperPilot could not load a trustworthy Reader response.",
      );
    }
    return parsed;
  }

  async getUploadStatus(uploadId: string, signal?: AbortSignal): Promise<UploadStatusDto> {
    const workspaceId = this.requireWorkspaceId();
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}`,
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = uploadStatusDto(payload);
    if (!response.ok || !parsed) {
      throw this.httpError(response.status, response.headers, payload, "PaperPilot could not confirm the upload state.");
    }
    return parsed;
  }

  uploadContent(
    uploadId: string,
    file: File,
    options: UploadTransferOptions = {},
  ): Promise<UploadStatusDto> {
    const workspaceId = this.requireWorkspaceId();
    const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}/content`;

    return new Promise((resolve, reject) => {
      const xhr = this.xhrFactory();
      let settled = false;
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const abort = () => {
        xhr.abort();
        finish(() => reject(new DOMException("The upload was cancelled.", "AbortError")));
      };

      xhr.open("PUT", url, true);
      xhr.withCredentials = true;
      xhr.responseType = "json";
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("Content-Type", "application/pdf");
      xhr.upload.onprogress = (event) => {
        if (!settled && options.onProgress) {
          options.onProgress({
            loadedBytes: event.loaded,
            totalBytes: event.lengthComputable ? event.total : file.size,
          });
        }
      };
      xhr.onload = () => {
        const payload: unknown = xhr.response ?? (() => {
          try { return JSON.parse(xhr.responseText); } catch { return undefined; }
        })();
        const parsed = uploadStatusDto(payload);
        if (xhr.status >= 200 && xhr.status < 300 && parsed) {
          finish(() => resolve(parsed));
          return;
        }
        const headers = new Headers();
        const requestId = xhr.getResponseHeader("X-Request-Id");
        const retryAfter = xhr.getResponseHeader("Retry-After");
        if (requestId) headers.set("X-Request-Id", requestId);
        if (retryAfter) headers.set("Retry-After", retryAfter);
        finish(() => reject(this.httpError(
          xhr.status,
          headers,
          payload,
          "PaperPilot could not transfer this PDF.",
        )));
      };
      xhr.onerror = () => finish(() => reject(new Error(
        "PaperPilot could not confirm whether the PDF transfer completed.",
      )));
      xhr.ontimeout = () => finish(() => reject(new Error(
        "PaperPilot could not confirm whether the PDF transfer completed.",
      )));
      xhr.onabort = () => finish(() => reject(new DOMException(
        "The upload was cancelled.",
        "AbortError",
      )));

      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      xhr.send(file);
    });
  }

  createEvidenceNote(
    command: CreateEvidenceNoteCommand,
  ): Promise<WorkspaceCommandResult<CreateEvidenceNoteResult>> {
    return this.postCommand("evidence-notes", command);
  }

  async captureGroundedEvidence(
    paperId: string,
    command: CaptureGroundedEvidenceCommand,
  ): Promise<CaptureGroundedEvidenceResponse> {
    const workspaceId = this.requireWorkspaceId();
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/papers/${encodeURIComponent(paperId)}/evidence`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": command.clientOperationId,
        },
        body: JSON.stringify(command),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = parseCaptureGroundedEvidenceResponse(payload, paperId);
    if (parsed?.ok) {
      const grounding = parsed.data.grounding;
      const requestedCollections = new Set(command.collectionIds);
      const responseCollections = new Set(parsed.data.updatedCollectionIds);
      const matchesCommand = parsed.data.linkedProjectIds.includes(command.projectId)
        && requestedCollections.size === command.collectionIds.length
        && responseCollections.size === requestedCollections.size
        && [...requestedCollections].every((id) => responseCollections.has(id))
        && grounding.documentId === command.selection.documentId
        && grounding.extractionId === command.selection.extractionId
        && grounding.manifestSha256 === command.selection.manifestSha256
        && grounding.quoteSha256 === command.selection.expectedQuoteSha256
        && JSON.stringify(grounding.start) === JSON.stringify(command.selection.start)
        && JSON.stringify(grounding.end) === JSON.stringify(command.selection.end);
      if (matchesCommand) return parsed;
    } else if (parsed) {
      return parsed;
    }
    if (!response.ok) {
      throw this.httpError(
        response.status,
        response.headers,
        payload,
        "PaperPilot could not save this grounded evidence.",
      );
    }
    throw new Error(apiMessage(payload, "PaperPilot received an invalid grounded-evidence response."));
  }

  async createEvidenceRevision(
    noteId: string,
    command: CreateEvidenceRevisionCommand,
    predecessor: EvidenceNote,
  ): Promise<CreateEvidenceRevisionResponse> {
    const workspaceId = this.requireWorkspaceId();
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/evidence-notes/${encodeURIComponent(noteId)}/revisions`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": command.clientOperationId,
        },
        body: JSON.stringify(command),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = parseCreateEvidenceRevisionResponse(payload, command.action, noteId);
    if (parsed?.ok) {
      const successor = parsed.data.note;
      const sameStringSet = (left: readonly string[], right: readonly string[]) =>
        left.length === right.length && left.every((item) => right.includes(item));
      const durableReplay = parsed.outcome === "replayed";
      const semanticFieldsPreserved = predecessor.id === noteId
        && (durableReplay || predecessor.revision.isLatest)
        && (durableReplay || successor.revision.isLatest)
        && successor.paperId === predecessor.paperId
        && successor.title === predecessor.title
        && successor.kind === predecessor.kind
        && successor.claim === predecessor.claim
        && successor.interpretation === predecessor.interpretation
        && successor.openQuestion === predecessor.openQuestion
        && successor.confidence === predecessor.confidence
        && JSON.stringify(successor.tags) === JSON.stringify(predecessor.tags)
        && JSON.stringify(successor.linkedHighlightIds) === JSON.stringify(predecessor.linkedHighlightIds)
        && (durableReplay || sameStringSet(successor.collectionIds, predecessor.collectionIds))
        && successor.revision.rootId === predecessor.revision.rootId
        && successor.revision.number === predecessor.revision.number + 1;
      if (!semanticFieldsPreserved) {
        throw new Error("PaperPilot received an incoherent evidence successor.");
      }
      if (command.action === "verify") {
        const previousGrounding = predecessor.grounding;
        const grounding = successor.grounding;
        const sameAnchor = previousGrounding && grounding
          && JSON.stringify({ ...grounding, state: undefined })
            === JSON.stringify({ ...previousGrounding, state: undefined });
        if (successor.evidence === predecessor.evidence && sameAnchor) return parsed;
        throw new Error("PaperPilot received a reviewed revision with changed source evidence.");
      }
      const grounding = successor.grounding;
      const selection = command.selection;
      const matchesSelection = grounding
        && grounding.documentId === selection.documentId
        && grounding.extractionId === selection.extractionId
        && grounding.manifestSha256 === selection.manifestSha256
        && grounding.quoteSha256 === selection.expectedQuoteSha256
        && JSON.stringify(grounding.start) === JSON.stringify(selection.start)
        && JSON.stringify(grounding.end) === JSON.stringify(selection.end);
      if (matchesSelection) return parsed;
    } else if (parsed) {
      return parsed;
    }
    if (!response.ok) {
      throw this.httpError(
        response.status,
        response.headers,
        payload,
        command.action === "verify"
          ? "PaperPilot could not mark this evidence reviewed."
          : "PaperPilot could not re-anchor this evidence.",
      );
    }
    throw new Error(apiMessage(
      payload,
      "PaperPilot received an invalid evidence-revision response.",
    ));
  }

  addPaperToCollection(
    command: AddPaperToCollectionCommand,
  ): Promise<WorkspaceCommandResult<AddPaperToCollectionResult>> {
    return this.postCommand(
      `collections/${encodeURIComponent(command.collectionId)}/papers`,
      command,
    );
  }

  addNoteToCollection(
    command: AddNoteToCollectionCommand,
  ): Promise<WorkspaceCommandResult<AddNoteToCollectionResult>> {
    return this.postCommand(
      `collections/${encodeURIComponent(command.collectionId)}/notes`,
      command,
    );
  }

  private async postCommand<T>(
    path: string,
    command: { clientOperationId: string },
  ): Promise<WorkspaceCommandResult<T>> {
    const workspaceId = this.requireWorkspaceId();
    const response = await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/${path}`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": command.clientOperationId,
        },
        body: JSON.stringify(command),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (isRecord(payload) && typeof payload.ok === "boolean") {
      return payload as unknown as WorkspaceCommandResult<T>;
    }
    throw new Error(apiMessage(payload, "PaperPilot could not complete the workspace command."));
  }

  private requireWorkspaceId(): string {
    if (!this.workspaceId) {
      throw new Error("Load the authenticated workspace before sending a command.");
    }
    return this.workspaceId;
  }


  private httpError(
    status: number,
    headers: Headers,
    payload: unknown,
    fallback: string,
  ): WorkspaceHttpError {
    const problem = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const code = typeof problem?.code === "string" && /^[a-z0-9_]{1,80}$/.test(problem.code)
      ? problem.code
      : undefined;
    const requestId = safeHeader(
      headers.get("X-Request-Id") ?? (typeof problem?.requestId === "string" ? problem.requestId : null),
      /^[a-zA-Z0-9._:-]{1,100}$/,
    );
    const retryAfterValue = headers.get("Retry-After")?.trim();
    const retryAfterSeconds = retryAfterValue && /^\d{1,9}$/.test(retryAfterValue)
      ? Number(retryAfterValue)
      : undefined;
    return new WorkspaceHttpError(
      status,
      code,
      requestId,
      retryAfterSeconds,
      apiMessage(payload, fallback),
    );
  }
}

export function createHttpWorkspaceClient(workspaceId?: string): UploadWorkspaceClient {
  return new HttpWorkspaceClient(workspaceId);
}
