import type {
  CrawlerDocumentFailureCode,
  CrawlerDocumentInboxEntry,
  CrawlerDocumentStage,
  DocumentUploadFailureCode,
  DocumentUploadInboxEntry,
  InboxEntry,
  Paper,
  PaperInboxEntry,
  PaperIdentifier,
  Provenance,
  WebMcpDuplicateCandidate,
  WebMcpInboxEntry,
  WorkspaceInboxEntry,
} from "@/lib/types";
import type {
  AssetStatus,
  CrawlerImportStatus,
  DocumentStatus,
  InboxEntry as DatabaseInboxEntry,
  ProvenanceKind,
  UploadSessionStatus,
} from "@/generated/prisma/client";
import { crawlerInboxLifecyclePayload } from "@/server/documents/intake-lifecycle";
import {
  isServerManagedWebMcpSnapshot,
  webMcpSnapshotDigest,
} from "@/server/integrations/webmcp/snapshot-contract";
import type { WorkspacePaperReaderDto } from "@/lib/workspace";
import type { DocumentExtractionLifecycle } from "@/server/documents/extraction-authority";

export interface StoredImportSnapshot {
  paper: Paper;
  provenance: Provenance;
}

export interface UploadLifecycleForDto {
  status: UploadSessionStatus;
  failureCode: string | null;
  asset: {
    status: AssetStatus;
    rejectionCode: string | null;
  };
  document: {
    status: DocumentStatus;
    failureCode: string | null;
    paperId?: string | null;
    workspacePaperId?: string | null;
  } | null;
}

export interface CrawlerLifecycleForDto {
  id: string;
  status: CrawlerImportStatus;
  displayFileName: string;
  documentId: string;
  failureCode: string | null;
}

/** Reader-service result already authorized for this paper and user. */
export interface InboxReaderAuthority {
  paperId: string;
  documentId?: string;
  state: WorkspacePaperReaderDto["state"];
}

export function inboxReaderAuthority(
  paperId: string,
  reader: WorkspacePaperReaderDto,
): InboxReaderAuthority {
  return {
    paperId,
    state: reader.state,
    ...(reader.state === "unavailable" ? {} : { documentId: reader.document.id }),
  };
}

/** Project an already-visible document's compact extraction lifecycle. */
export function inboxReaderAuthorityFromLifecycle(
  paperId: string,
  lifecycle: DocumentExtractionLifecycle,
): InboxReaderAuthority {
  const state: InboxReaderAuthority["state"] = lifecycle.state === "ready"
    ? "ready"
    : lifecycle.state === "no-text"
      ? "no-text"
      : lifecycle.state === "queued" || lifecycle.state === "extracting"
        ? "processing"
        : "unavailable";
  return {
    paperId,
    state,
    ...(state === "unavailable" ? {} : { documentId: lifecycle.documentId }),
  };
}

export type InboxEntryForDto = DatabaseInboxEntry & {
  provenanceRecords: Array<{
    kind: ProvenanceKind;
    paperId: string | null;
    paper?: {
      id: string;
      title: string;
      publicationYear: number | null;
      venueName: string | null;
      workType: string | null;
      authors: Array<{ position: number; displayName: string }>;
      identifiers: Array<{
        type: string;
        value: string;
      }>;
    } | null;
  }>;
  uploadSession?: UploadLifecycleForDto & {
    id: string;
    status: UploadSessionStatus;
    originalFileName: string;
    declaredMimeType: string;
    expectedSizeBytes: bigint;
    receivedSizeBytes: bigint | null;
    expiresAt: Date;
    failureCode: string | null;
    documentId: string | null;
  } | null;
  crawlerImport?: CrawlerLifecycleForDto | null;
  document?: {
    status: DocumentStatus;
    failureCode: string | null;
    paperId: string | null;
    workspacePaperId: string | null;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Import snapshots are written only after strict command validation. This
 * guard keeps a legacy or manually-corrupted row from breaking an entire
 * workspace bootstrap while retaining the exact normalized provider record.
 */
export function storedImportSnapshot(value: unknown): StoredImportSnapshot | null {
  if (!isRecord(value) || !isRecord(value.paper) || !isRecord(value.provenance)) {
    return null;
  }
  if (
    typeof value.paper.id !== "string"
    || typeof value.paper.title !== "string"
    || typeof value.provenance.sourceId !== "string"
    || typeof value.provenance.providerName !== "string"
  ) {
    return null;
  }
  return value as unknown as StoredImportSnapshot;
}

function inboxStatus(status: DatabaseInboxEntry["status"]): InboxEntry["status"] {
  switch (status) {
    case "PENDING":
      return "awaiting-review";
    case "MATCHED":
    case "DUPLICATE":
      return "possible-duplicate";
    case "IMPORTED":
      return "ready";
    case "NEEDS_REVIEW":
      return "processing";
    case "REJECTED":
    case "FAILED":
      return "blocked";
  }
}

const UPLOAD_FAILURE_MESSAGES: Record<
  DocumentUploadFailureCode,
  { message: string; retryable: boolean }
> = {
  invalid_pdf_envelope: {
    message: "This file was not recognized as a supported PDF.",
    retryable: false,
  },
  pdf_trailing_data: {
    message: "This file has unsupported data after the PDF trailer.",
    retryable: false,
  },
  size_mismatch: {
    message: "The transfer did not match the selected file. Select it again.",
    retryable: true,
  },
  upload_too_large: {
    message: "The selected file exceeds this workspace's upload limit.",
    retryable: false,
  },
  upload_aborted: {
    message: "The transfer was interrupted before it completed.",
    retryable: true,
  },
  upload_timed_out: {
    message: "The transfer stopped making progress before it completed.",
    retryable: true,
  },
  storage_unavailable: {
    message: "Private quarantine storage is temporarily unavailable.",
    retryable: true,
  },
  storage_finalize_failed: {
    message: "The transfer could not be committed to private quarantine.",
    retryable: true,
  },
  session_expired: {
    message: "This upload session expired before the transfer completed.",
    retryable: true,
  },
  malware_detected: {
    message: "This file did not pass malware screening and remains unavailable.",
    retryable: false,
  },
  invalid_pdf_structure: {
    message: "This PDF did not pass structural validation and remains unavailable.",
    retryable: false,
  },
  integrity_check_failed: {
    message: "This file no longer matches its recorded upload and cannot be used.",
    retryable: false,
  },
  validation_unavailable: {
    message: "Document validation could not be completed. The file remains unavailable.",
    retryable: true,
  },
  validation_failed: {
    message: "This file could not be verified and remains unavailable.",
    retryable: false,
  },
  file_unavailable: {
    message: "This uploaded file is no longer available.",
    retryable: false,
  },
  upload_failed: {
    message: "This file could not be accepted into private quarantine.",
    retryable: false,
  },
};

const UPLOAD_FAILURE_ALIASES: Record<string, DocumentUploadFailureCode> = {
  invalid_pdf_envelope: "invalid_pdf_envelope",
  pdf_trailing_data: "pdf_trailing_data",
  size_mismatch: "size_mismatch",
  content_length_mismatch: "size_mismatch",
  upload_too_large: "upload_too_large",
  upload_aborted: "upload_aborted",
  upload_timed_out: "upload_timed_out",
  receive_lease_expired: "upload_timed_out",
  storage_unavailable: "storage_unavailable",
  storage_finalize_failed: "storage_finalize_failed",
  session_expired: "session_expired",
  malware_detected: "malware_detected",
  virus_detected: "malware_detected",
  malware_and_pdf_invalid: "malware_detected",
  invalid_pdf_structure: "invalid_pdf_structure",
  pdf_invalid: "invalid_pdf_structure",
  pdf_policy_violation: "invalid_pdf_structure",
  pdf_resource_limit_exceeded: "invalid_pdf_structure",
  integrity_check_failed: "integrity_check_failed",
  content_hash_mismatch: "integrity_check_failed",
  content_size_mismatch: "integrity_check_failed",
  source_version_changed: "integrity_check_failed",
  object_integrity_mismatch: "integrity_check_failed",
  object_missing: "integrity_check_failed",
  quarantine_object_missing: "integrity_check_failed",
  quarantine_object_changed: "integrity_check_failed",
  validation_unavailable: "validation_unavailable",
  validation_service_unavailable: "validation_unavailable",
  validation_timeout: "validation_unavailable",
  signatures_stale: "validation_unavailable",
  validation_stream_unavailable: "validation_unavailable",
  validation_request_aborted: "validation_unavailable",
  validation_service_timeout: "validation_unavailable",
  validation_service_signatures_stale: "validation_unavailable",
  validation_service_clock_invalid: "validation_unavailable",
  validation_dead_letter: "validation_unavailable",
  worker_lease_expired: "validation_unavailable",
  validation_failed: "validation_failed",
  validation_request_invalid: "validation_failed",
  validation_service_configuration_error: "validation_failed",
  validation_service_redirected: "validation_failed",
  validation_service_endpoint_mismatch: "validation_failed",
  validation_service_response_too_large: "validation_failed",
  validation_service_invalid_response: "validation_failed",
  validation_service_policy_mismatch: "validation_failed",
  validation_service_content_mismatch: "integrity_check_failed",
  validation_service_storage_mismatch: "integrity_check_failed",
  validation_input_changed: "integrity_check_failed",
  validation_object_missing: "integrity_check_failed",
  validation_response_invalid: "validation_failed",
  validation_attestation_stale: "validation_unavailable",
  validation_worker_internal: "validation_unavailable",
  file_unavailable: "file_unavailable",
  asset_deleted: "file_unavailable",
  document_archived: "file_unavailable",
  upload_failed: "upload_failed",
};

export function documentUploadStage(
  upload: UploadLifecycleForDto,
): DocumentUploadInboxEntry["upload"]["stage"] {
  if (upload.status === "EXPIRED") return "expired";
  if (
    upload.status === "REJECTED"
    || upload.asset.status === "REJECTED"
    || upload.asset.status === "DELETED"
    || upload.document?.status === "FAILED"
    || upload.document?.status === "ARCHIVED"
  ) {
    return "failed";
  }

  if (upload.status === "ISSUED") {
    return upload.asset.status === "UPLOADING" && upload.document?.status === "PENDING"
      ? "awaiting-bytes"
      : "failed";
  }
  if (upload.status === "RECEIVING") {
    return upload.asset.status === "UPLOADING" && upload.document?.status === "PENDING"
      ? "receiving"
      : "failed";
  }
  if (upload.status === "STORED") {
    if (upload.asset.status === "READY" && upload.document?.status === "READY") {
      return "ready";
    }
    if (
      upload.asset.status === "SCANNING"
      || upload.document?.status === "PROCESSING"
    ) {
      return "validating";
    }
    if (
      upload.asset.status === "QUARANTINED"
      && upload.document?.status === "PENDING"
    ) {
      return "quarantined";
    }
  }
  return "failed";
}

export function documentUploadFailure(
  upload: UploadLifecycleForDto,
  inboxFailureCode: string | null = null,
): DocumentUploadInboxEntry["failure"] | undefined {
  const stage = documentUploadStage(upload);
  if (stage !== "failed" && stage !== "expired") return undefined;

  const code = [
    upload.failureCode,
    upload.document?.failureCode,
    upload.asset.rejectionCode,
    inboxFailureCode,
  ].flatMap((candidate) => candidate ? [UPLOAD_FAILURE_ALIASES[candidate]] : [])
    .find((candidate): candidate is DocumentUploadFailureCode => candidate !== undefined)
    ?? (stage === "expired"
      ? "session_expired"
      : upload.asset.status === "DELETED" || upload.document?.status === "ARCHIVED"
        ? "file_unavailable"
        : upload.status === "STORED"
          ? "validation_failed"
          : "upload_failed");
  return { code, ...UPLOAD_FAILURE_MESSAGES[code] };
}

function uploadInboxEntryDto(
  entry: InboxEntryForDto,
  readerAuthority?: InboxReaderAuthority,
  documentExtractionAuthority?: DocumentExtractionLifecycle,
): DocumentUploadInboxEntry | null {
  const upload = entry.uploadSession;
  if (
    entry.source !== "FILE_UPLOAD"
    || !upload
    || !upload.documentId
    || !upload.document
    || upload.declaredMimeType !== "application/pdf"
    || upload.expectedSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)
    || (upload.receivedSizeBytes !== null && upload.receivedSizeBytes > BigInt(Number.MAX_SAFE_INTEGER))
  ) {
    return null;
  }

  const stage = documentUploadStage(upload);
  const failure = documentUploadFailure(upload, entry.failureCode);
  const storedLinkedPaperId = upload.document.paperId && upload.document.workspacePaperId
    ? upload.document.paperId
    : undefined;
  const authorityMatchesPaper = storedLinkedPaperId !== undefined
    && readerAuthority?.paperId === storedLinkedPaperId;
  const authorityMatchesDocument = readerAuthority?.state === "unavailable"
    || readerAuthority?.documentId === upload.documentId;
  const linkedPaperId = authorityMatchesPaper ? storedLinkedPaperId : undefined;
  const documentAuthorityMatches = storedLinkedPaperId === undefined
    && stage === "ready"
    && documentExtractionAuthority?.documentId === upload.documentId;
  const documentExtractionStage: DocumentUploadInboxEntry["upload"]["extractionStage"] =
    documentExtractionAuthority?.state === "unavailable"
      ? "failed"
      : documentExtractionAuthority?.state ?? "not-started";
  const extractionStage: DocumentUploadInboxEntry["upload"]["extractionStage"] =
    storedLinkedPaperId === undefined
      ? documentAuthorityMatches ? documentExtractionStage : "not-started"
      : !authorityMatchesPaper
        ? "not-started"
      : !authorityMatchesDocument || readerAuthority.state === "unavailable"
        ? "failed"
        : readerAuthority.state === "ready"
          ? "ready"
          : readerAuthority.state === "no-text"
            ? "no-text"
            : "queued";
  const now = entry.createdAt.toISOString();
  return {
    entryKind: "document-upload",
    id: entry.id,
    sourceKind: "upload",
    provenance: {
      id: `upload:${upload.id}`,
      sourceType: "uploaded-file",
      sourceId: upload.id,
      sourceTitle: upload.originalFileName,
      providerName: "PaperPilot private quarantine",
      retrievedAt: now,
      accessMethod: "upload",
    },
    status: stage === "ready"
      ? "ready"
      : stage === "failed" || stage === "expired"
        ? "blocked"
        : "processing",
    upload: {
      id: upload.id,
      documentId: upload.documentId,
      fileName: upload.originalFileName,
      expectedSizeBytes: Number(upload.expectedSizeBytes),
      receivedSizeBytes: upload.receivedSizeBytes === null
        ? undefined
        : Number(upload.receivedSizeBytes),
      mediaType: "application/pdf",
      stage,
      extractionStage,
      readerAvailable: linkedPaperId !== undefined
        && authorityMatchesDocument
        && readerAuthority?.state === "ready",
      ...(linkedPaperId ? { linkedPaperId } : {}),
      expiresAt: upload.expiresAt.toISOString(),
    },
    ...(failure ? { failure } : {}),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

const CRAWLER_STAGE_BY_STATUS: Readonly<Record<CrawlerImportStatus, CrawlerDocumentStage>> = {
  QUEUED: "queued",
  FETCHING: "fetching",
  QUARANTINED: "quarantined",
  VALIDATING: "validating",
  EXTRACTING: "extracting",
  READY: "ready",
  ATTENTION: "attention",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

const CRAWLER_PHASE_BY_STATUS: Readonly<Record<CrawlerImportStatus, string>> = {
  QUEUED: "fetch",
  FETCHING: "fetch",
  QUARANTINED: "validation",
  VALIDATING: "validation",
  EXTRACTING: "extraction",
  READY: "ready",
  ATTENTION: "attention",
  FAILED: "failed",
  CANCELLED: "failed",
};

const CRAWLER_FAILURE_MESSAGES: Readonly<Record<
  CrawlerDocumentFailureCode,
  { message: string; retryable: boolean }
>> = {
  crawler_attention: {
    message: "Text extraction needs attention before this document can be used in Reader.",
    retryable: true,
  },
  crawler_failed: {
    message: "This governed document acquisition could not be completed.",
    retryable: false,
  },
  crawler_cancelled: {
    message: "This governed document acquisition was cancelled.",
    retryable: false,
  },
};

function crawlerFailure(
  status: CrawlerImportStatus,
): CrawlerDocumentInboxEntry["failure"] | undefined {
  const code: CrawlerDocumentFailureCode | undefined = status === "ATTENTION"
    ? "crawler_attention"
    : status === "FAILED"
      ? "crawler_failed"
      : status === "CANCELLED"
        ? "crawler_cancelled"
        : undefined;
  return code ? { code, ...CRAWLER_FAILURE_MESSAGES[code] } : undefined;
}

function crawlerInboxStatusIsCoherent(
  status: DatabaseInboxEntry["status"],
  crawlerStatus: CrawlerImportStatus,
  linked: boolean,
): boolean {
  if (linked) return crawlerStatus === "READY" && status === "IMPORTED";
  if (crawlerStatus === "QUEUED" || crawlerStatus === "FETCHING") {
    return status === "NEEDS_REVIEW";
  }
  if (crawlerStatus === "FAILED" || crawlerStatus === "CANCELLED") {
    return status === "FAILED" || status === "REJECTED";
  }
  return status === "NEEDS_REVIEW";
}

function crawlerDocumentInboxEntryDto(
  entry: InboxEntryForDto,
  readerAuthority?: InboxReaderAuthority,
  documentExtractionAuthority?: DocumentExtractionLifecycle,
): CrawlerDocumentInboxEntry | null {
  const crawler = entry.crawlerImport;
  const document = entry.document;
  if (
    entry.source !== "CRAWLER"
    || !crawler
    || !document
    || entry.documentId !== crawler.documentId
    || crawler.displayFileName.length < 1
    || Buffer.byteLength(crawler.displayFileName, "utf8") > 255
  ) return null;

  const lifecycle = crawlerInboxLifecyclePayload(entry.payload, crawler.id);
  if (
    !lifecycle
    || lifecycle.importStatus !== crawler.status
    || lifecycle.phase !== CRAWLER_PHASE_BY_STATUS[crawler.status]
  ) return null;

  const stage = CRAWLER_STAGE_BY_STATUS[crawler.status];
  const storedLinkedPaperId = document.paperId && document.workspacePaperId
    ? document.paperId
    : undefined;
  if (!crawlerInboxStatusIsCoherent(entry.status, crawler.status, storedLinkedPaperId !== undefined)) {
    return null;
  }
  const authorityMatchesPaper = storedLinkedPaperId !== undefined
    && readerAuthority?.paperId === storedLinkedPaperId;
  const authorityMatchesDocument = readerAuthority?.state === "unavailable"
    || readerAuthority?.documentId === crawler.documentId;
  const linkedPaperId = authorityMatchesPaper ? storedLinkedPaperId : undefined;
  const documentAuthorityMatches = storedLinkedPaperId === undefined
    && document.status === "READY"
    && documentExtractionAuthority?.documentId === crawler.documentId;
  const documentExtractionStage: CrawlerDocumentInboxEntry["crawler"]["extractionStage"] =
    documentExtractionAuthority?.state === "unavailable"
      ? "failed"
      : documentExtractionAuthority?.state ?? "not-started";
  const extractionStage: CrawlerDocumentInboxEntry["crawler"]["extractionStage"] =
    storedLinkedPaperId === undefined
      ? documentAuthorityMatches ? documentExtractionStage : "not-started"
      : !authorityMatchesPaper
        ? "not-started"
        : !authorityMatchesDocument || readerAuthority.state === "unavailable"
          ? "failed"
          : readerAuthority.state === "ready"
            ? "ready"
            : readerAuthority.state === "no-text"
              ? "no-text"
              : "queued";
  const failure = crawlerFailure(crawler.status);
  const createdAt = entry.createdAt.toISOString();
  return {
    entryKind: "crawler-document",
    id: entry.id,
    sourceKind: "crawler",
    provenance: {
      id: `crawler:${crawler.id}`,
      sourceType: "web-source",
      sourceId: crawler.id,
      sourceTitle: crawler.displayFileName,
      providerName: "PaperPilot governed crawler",
      retrievedAt: createdAt,
      accessMethod: "crawler",
    },
    status: stage === "ready"
      ? "ready"
      : stage === "attention" || stage === "failed" || stage === "cancelled"
        ? "blocked"
        : "processing",
    crawler: {
      id: crawler.id,
      documentId: crawler.documentId,
      fileName: crawler.displayFileName,
      mediaType: "application/pdf",
      stage,
      extractionStage,
      readerAvailable: linkedPaperId !== undefined
        && authorityMatchesDocument
        && readerAuthority?.state === "ready",
      ...(linkedPaperId ? { linkedPaperId } : {}),
    },
    ...(failure ? { failure } : {}),
    createdAt,
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export function inboxEntryDto(
  entry: InboxEntryForDto,
  readerAuthority?: InboxReaderAuthority,
  documentExtractionAuthority?: DocumentExtractionLifecycle,
): WorkspaceInboxEntry | null {
  if (entry.source === "FILE_UPLOAD") {
    return uploadInboxEntryDto(entry, readerAuthority, documentExtractionAuthority);
  }
  if (entry.source === "CRAWLER") {
    return crawlerDocumentInboxEntryDto(
      entry,
      readerAuthority,
      documentExtractionAuthority,
    );
  }
  const snapshot = storedImportSnapshot(entry.payload);
  if (!snapshot) return null;
  if (entry.source === "WEB_MCP" && !isServerManagedWebMcpSnapshot(entry.payload)) return null;

  // A DISCOVERY row is linked to a canonical paper only when staging found a
  // possible duplicate. IMPORT provenance is deliberately ignored here: every
  // successfully filed entry has one, but that does not make it a duplicate.
  const duplicateRecord = entry.provenanceRecords.find(
    (record) => (record.kind === "DISCOVERY" || record.kind === "WEB_MCP") && record.paperId,
  );
  const duplicateOfPaperId = duplicateRecord?.paperId ?? undefined;

  const webMcpSnapshot = entry.source === "WEB_MCP"
    && isServerManagedWebMcpSnapshot(entry.payload)
    ? entry.payload
    : undefined;
  const duplicatePaper = duplicateRecord?.paper;
  const duplicateCandidate: WebMcpDuplicateCandidate | undefined =
    duplicateOfPaperId
    && duplicatePaper?.id === duplicateOfPaperId
      ? {
          id: duplicatePaper.id,
          title: duplicatePaper.title,
          authors: [...duplicatePaper.authors]
            .sort((left, right) => left.position - right.position)
            .map((author) => author.displayName),
          year: duplicatePaper.publicationYear ?? 0,
          venue: duplicatePaper.venueName ?? "Venue unavailable",
          type: duplicatePaper.workType === "conference paper"
            ? "conference paper"
            : duplicatePaper.workType === "review"
              ? "review"
              : duplicatePaper.workType === "methods paper"
                ? "methods paper"
                : duplicatePaper.workType === "application study"
                  ? "application study"
                  : "journal article",
          identifiers: duplicatePaper.identifiers.map((identifier): PaperIdentifier => {
            if (identifier.type === "DOI") return { scheme: "doi", value: identifier.value };
            if (identifier.type === "ARXIV") return { scheme: "arxiv", value: identifier.value };
            if (identifier.type === "ISBN") return { scheme: "isbn", value: identifier.value };
            return {
              scheme: "provider",
              value: `${identifier.type.toLowerCase()}:${identifier.value}`,
            };
          }),
        }
      : undefined;

  const sourceKind: PaperInboxEntry["sourceKind"] = entry.source === "ZOTERO"
    ? "zotero"
    : entry.source === "WEB_MCP"
      ? "webmcp"
      : entry.source === "DOI_URL"
          ? "identifier"
          : "discover";
  const dto = {
    entryKind: "paper" as const,
    id: entry.id,
    sourceKind,
    paper: snapshot.paper,
    provenance: snapshot.provenance,
    status: inboxStatus(entry.status),
    duplicateOfPaperId,
    destinationProjectId: entry.projectId ?? undefined,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
  if (sourceKind !== "webmcp") return dto as InboxEntry;
  if (!webMcpSnapshot) return null;
  return {
    ...dto,
    sourceKind: "webmcp",
    proposalDigest: webMcpSnapshotDigest(webMcpSnapshot),
    ...(duplicateCandidate ? { duplicateCandidate } : {}),
  } satisfies WebMcpInboxEntry;
}

/** Connector/import commands deal only in normalized paper-shaped entries. */
export function paperInboxEntryDto(entry: InboxEntryForDto): PaperInboxEntry | null {
  const dto = inboxEntryDto(entry);
  return dto?.entryKind === "paper" ? dto : null;
}
