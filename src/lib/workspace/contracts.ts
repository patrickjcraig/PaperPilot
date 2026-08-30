import type {
  Collection,
  DocumentUploadStage,
  EvidenceNote,
  GroundedEvidenceAnchor,
  GroundedEvidenceBoundary,
  InboxEntry,
  PaperInboxEntry,
  DocumentUploadInboxEntry,
  Paper,
  Provenance,
  ResearchProject,
  WebMcpInboxEntry,
  WorkspaceInboxEntry,
} from "../types";

/**
 * UI-facing read model for the current workspace.
 *
 * This deliberately is not the persistence snapshot: callers receive a
 * transport-neutral aggregate version and a resolved paper library, while
 * storage schema details stay behind WorkspaceClient.
 */
export interface WorkspaceBootstrapDto {
  schemaVersion: 3;
  aggregateVersion: number;
  workspace: {
    id: string;
    name: string;
    mode: "demo" | "live";
    /**
     * Workspace membership role returned by the authenticated bootstrap.
     * Integration controls recognize only owner/admin and fail closed for any
     * present or future role value.
     */
    role: string;
  };
  activeProjectId: string | null;
  projects: ResearchProject[];
  inboxEntries: WorkspaceInboxEntry[];
  papers: Paper[];
  notes: EvidenceNote[];
  collections: Collection[];
}

export interface GetWorkspaceProjectQuery {
  projectId: string;
}

/** A project detail query resolves only the resources linked to that project. */
export interface WorkspaceProjectDto {
  aggregateVersion: number;
  project: ResearchProject;
  papers: Paper[];
  notes: EvidenceNote[];
  collections: Collection[];
}

export interface WorkspaceCommandEnvelope {
  /** Stable across retries; a new user intent must use a new value. */
  clientOperationId: string;
  /** Version returned by the most recent bootstrap/query/command. */
  expectedVersion: number;
}

export type WorkspaceCommandFailureCode =
  | "validation"
  | "not_found"
  | "duplicate"
  | "version_conflict"
  | "idempotency_conflict";

export interface WorkspaceCommandSuccess<T> {
  ok: true;
  outcome: "applied" | "noop" | "replayed";
  aggregateVersion: number;
  data: T;
}

export interface WorkspaceCommandFailure {
  ok: false;
  code: WorkspaceCommandFailureCode;
  aggregateVersion: number;
  message: string;
}

export type WorkspaceCommandResult<T> =
  | WorkspaceCommandSuccess<T>
  | WorkspaceCommandFailure;

export interface CreateProjectCommand extends WorkspaceCommandEnvelope {
  project: Pick<ResearchProject, "name" | "question" | "type" | "visibility">
    & Partial<Pick<ResearchProject, "description">>;
}

export interface CreateProjectResult {
  project: ResearchProject;
  activeProjectId: string;
}

export interface CreateCollectionCommand extends WorkspaceCommandEnvelope {
  projectId: string;
  name: string;
  description: string;
  color: Collection["color"];
}

export interface CreateCollectionResult {
  collection: Collection;
  projectId: string;
}

export interface StageImportCommand extends WorkspaceCommandEnvelope {
  /** WebMCP snapshots can enter only through the server-managed proposal API. */
  sourceKind: "discover" | "identifier";
  paper: Paper;
  provenance: Provenance;
}

export interface StageImportResult<
  TInboxEntry extends PaperInboxEntry = PaperInboxEntry,
> {
  inboxEntry: TInboxEntry;
  duplicatePaperId?: string;
}

/** Result admitted by the browser's generic discover/identifier import path. */
export type OrdinaryStageImportResult = StageImportResult<InboxEntry>;

export interface FileImportCommand extends WorkspaceCommandEnvelope {
  inboxEntryId: string;
  projectId: string;
}

export interface FileImportResult<
  TInboxEntry extends PaperInboxEntry = PaperInboxEntry,
> {
  inboxEntry: TInboxEntry;
  paper: Paper;
  project: ResearchProject;
  usedExistingPaper: boolean;
}


/** Result admitted by the browser's generic filing path. */
export type OrdinaryFileImportResult = FileImportResult<InboxEntry>;

export type WebMcpDuplicateDecision =
  | { kind: "create_new" }
  | { kind: "use_existing"; canonicalPaperId: string };

/**
 * The first step freezes filing intent and asks the server to independently
 * prepare the authority evidence a person must review. Preparation is
 * deliberately not idempotent and therefore carries no clientOperationId.
 */
export interface PrepareWebMcpApprovalChallengeCommand {
  schemaVersion: 1;
  expectedVersion: number;
  inboxEntryId: string;
  proposalDigest: string;
  destinationProjectId: string;
  duplicateDecision: WebMcpDuplicateDecision;
}

export interface WebMcpOpenAlexVerifiedIdentifier {
  type: "DOI" | "OPENALEX";
  value: string;
  normalizedValue: string;
  source: "OPENALEX";
}

export interface WebMcpOpenAlexVerifiedAuthor {
  position: number;
  displayName: string;
}

export interface WebMcpOpenAlexVerifiedSnapshot {
  schemaVersion: 1;
  kind: "openalex_verified_work";
  authority: "OPENALEX";
  authorityVersion: "works-singleton-v1";
  retrievedAt: string;
  sourceRecordId: string;
  providerUpdatedAt?: string;
  paper: {
    title: string;
    abstractText: string | null;
    publicationYear: number | null;
    publicationDate: string | null;
    language: string | null;
    workType: string;
    venueName: string | null;
    citationCount: number | null;
    isRetracted: boolean;
    identifiers: WebMcpOpenAlexVerifiedIdentifier[];
    authors: WebMcpOpenAlexVerifiedAuthor[];
  };
  evidenceDigest: string;
}

export interface WebMcpHumanReviewVerifiedSnapshot {
  schemaVersion: 1;
  kind: "human_review_identifier_free";
  authority: "HUMAN_REVIEW";
  authorityVersion: "human-review-v1";
  proposalDigest: string;
  evidenceDigest: string;
}

export interface WebMcpExistingCanonicalVerifiedSnapshot {
  schemaVersion: 1;
  kind: "existing_canonical";
  authority: "EXISTING_CANONICAL";
  authorityVersion: "existing-canonical-v1";
  proposalDigest: string;
  canonicalPaperId: string;
  evidenceDigest: string;
}

export type WebMcpVerifiedAuthoritySnapshot =
  | WebMcpOpenAlexVerifiedSnapshot
  | WebMcpHumanReviewVerifiedSnapshot
  | WebMcpExistingCanonicalVerifiedSnapshot;

export interface WebMcpApprovalEvidenceDossier {
  schemaVersion: 1;
  challengeId: string;
  expiresAt: string;
  expectedVersion: number;
  inboxEntryId: string;
  proposalDigest: string;
  destinationProjectId: string;
  duplicateDecision: WebMcpDuplicateDecision;
  evidence: {
    authority: WebMcpVerifiedAuthoritySnapshot["authority"];
    authorityVersion: string;
    evidenceDigest: string;
    verifiedSnapshot: WebMcpVerifiedAuthoritySnapshot;
  };
}

export interface PrepareWebMcpApprovalChallengeResult {
  challenge: WebMcpApprovalEvidenceDossier;
}

export type PrepareWebMcpApprovalChallengeResponse = WorkspaceCommandResult<
  PrepareWebMcpApprovalChallengeResult
>;

/** Final consent, bound to the exact immutable evidence dossier shown. */
export interface ApproveWebMcpProposalCommand extends WorkspaceCommandEnvelope {
  schemaVersion: 2;
  inboxEntryId: string;
  proposalDigest: string;
  destinationProjectId: string;
  duplicateDecision: WebMcpDuplicateDecision;
  challengeId: string;
  evidenceDigest: string;
}

/**
 * The frozen JSON body is a first-class part of an approval attempt. An
 * unknown-outcome retry must reuse this string, not reconstruct the command.
 */
export interface FrozenWebMcpApprovalSubmission {
  command: ApproveWebMcpProposalCommand;
  serializedBody: string;
}

export interface VerifiedWebMcpIdentifier {
  scheme: "doi" | "provider";
  value: string;
  authority: "openalex";
  evidenceDigest: string;
}

export interface WebMcpProposalApproval {
  id: string;
  challengeId: string;
  inboxEntryId: string;
  proposalDigest: string;
  destinationProjectId: string;
  decision: WebMcpDuplicateDecision["kind"];
  canonicalPaperId: string;
  evidenceDigest: string;
  verifiedIdentifiers: VerifiedWebMcpIdentifier[];
  approvedAt: string;
}

export interface ApproveWebMcpProposalResult {
  approval: WebMcpProposalApproval;
  inboxEntry: WebMcpInboxEntry;
  paper: Paper;
  project: ResearchProject;
  usedExistingPaper: boolean;
}

export type ApproveWebMcpProposalResponse = WorkspaceCommandResult<
  ApproveWebMcpProposalResult
>;

export interface CreateUploadSessionCommand extends WorkspaceCommandEnvelope {
  fileName: string;
  sizeBytes: number;
  declaredMimeType: "application/pdf";
}

export interface CreateUploadSessionResult {
  inboxEntry: DocumentUploadInboxEntry;
  upload: {
    id: string;
    status: "awaiting-bytes";
    expiresAt: string;
    maxBytes: number;
    contentUrl: string;
  };
}

export interface UploadStatusDto {
  inboxEntry: DocumentUploadInboxEntry;
  upload: {
    id: string;
    status: DocumentUploadStage;
    expiresAt: string;
  };
  asset: {
    status: "uploading" | "quarantined" | "scanning" | "ready" | "rejected" | "deleted";
    sizeBytes?: number;
  };
  document: {
    id: string;
    status: "pending" | "processing" | "ready" | "failed" | "archived";
  };
}

export interface LinkValidatedDocumentCommand extends WorkspaceCommandEnvelope {
  paperId: string;
}

export interface LinkValidatedDocumentResult {
  paperId: string;
  documentId: string;
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
  manifestSha256: string;
  manifestSchemaVersion: 1;
  manifestAdmittedAt: string;
}

export interface ReaderChunkLocator {
  schemaVersion: 1;
  kind: "pdf-text";
  pageNumber: number;
  paragraphId: string;
}

/** A verbatim, server-attested text unit. Client code must not synthesize it. */
export interface ReaderTextChunk {
  id: string;
  sequence: number;
  pageNumber: number;
  paragraphId: string;
  text: string;
  contentHash: string;
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

interface ReaderPageOptionsBase {
  /** A server-enforced value from 1 through 100. */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * The first Reader page always begins at sequence zero. Continuations retain
 * the server cursor as an opaque capability and carry the expected sequence
 * separately so the browser can validate the returned page without decoding
 * or trusting cursor internals.
 */
export type ReaderPageOptions = ReaderPageOptionsBase & (
  | {
      cursor?: undefined;
      expectedSequence?: 0;
    }
  | {
      /** Opaque canonical cursor returned by the previous page. */
      cursor: string;
      /** Sequence expected for the first chunk in the continuation page. */
      expectedSequence: number;
    }
);

export interface UploadTransferProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface UploadTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadTransferProgress) => void;
}

export type EvidenceProvenanceDraft = Omit<Provenance, "id" | "retrievedAt"> & {
  id?: string;
  retrievedAt?: string;
};

export type EvidenceNoteDraft = Omit<
  EvidenceNote,
  "id" | "createdAt" | "updatedAt" | "provenance" | "grounding" | "revision" | "reviewedAt"
> & {
  provenance: EvidenceProvenanceDraft;
};

export interface CreateEvidenceNoteCommand extends WorkspaceCommandEnvelope {
  note: EvidenceNoteDraft;
  /** Explicit visible project that already contains the evidence paper. */
  projectId: string;
}

export interface CreateEvidenceNoteResult {
  note: EvidenceNote;
  linkedProjectIds: string[];
  updatedCollectionIds: string[];
}

export type GroundedEvidenceConfidence = EvidenceNote["confidence"];

export interface GroundedEvidenceNoteDraft {
  kind: EvidenceNote["kind"];
  title: string;
  claim: string;
  interpretation: string;
  openQuestion?: string;
  confidence: GroundedEvidenceConfidence;
  tags: string[];
}

export interface GroundedEvidenceSelection {
  documentId: string;
  extractionId: string;
  manifestSha256: string;
  start: GroundedEvidenceBoundary;
  end: GroundedEvidenceBoundary;
  expectedQuoteSha256: string;
}

export interface CaptureGroundedEvidenceCommand extends WorkspaceCommandEnvelope {
  projectId: string;
  collectionIds: string[];
  note: GroundedEvidenceNoteDraft;
  selection: GroundedEvidenceSelection;
}

export type GroundedEvidenceFailureCode =
  | WorkspaceCommandFailureCode
  | "selection_conflict";

export interface CaptureGroundedEvidenceResult {
  note: EvidenceNote;
  linkedProjectIds: string[];
  updatedCollectionIds: string[];
  /** Current when first applied; replay reflects the source state at replay time. */
  grounding: GroundedEvidenceAnchor;
}

export type CaptureGroundedEvidenceResponse =
  | {
      ok: true;
      outcome: "applied" | "replayed";
      aggregateVersion: number;
      data: CaptureGroundedEvidenceResult;
    }
  | {
      ok: false;
      code: GroundedEvidenceFailureCode;
      aggregateVersion: number;
      message: string;
    };

export type CreateEvidenceRevisionCommand =
  | (WorkspaceCommandEnvelope & { action: "verify" })
  | (WorkspaceCommandEnvelope & {
      action: "reanchor";
      selection: GroundedEvidenceSelection;
    });

export type EvidenceRevisionFailureCode =
  | "not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "selection_conflict"
  | "revision_conflict";

export interface CreateEvidenceRevisionResult {
  predecessorId: string;
  note: EvidenceNote;
  linkedProjectIds: string[];
  updatedCollectionIds: string[];
}

export type CreateEvidenceRevisionResponse =
  | {
      ok: true;
      outcome: "applied" | "replayed";
      aggregateVersion: number;
      data: CreateEvidenceRevisionResult;
    }
  | {
      ok: false;
      code: EvidenceRevisionFailureCode;
      aggregateVersion: number;
      message: string;
    };

export interface AddPaperToCollectionCommand extends WorkspaceCommandEnvelope {
  paperId: string;
  collectionId: string;
}

export interface AddPaperToCollectionResult {
  paper: Paper;
  collection: Collection;
}

export interface AddNoteToCollectionCommand extends WorkspaceCommandEnvelope {
  noteId: string;
  collectionId: string;
}

export interface AddNoteToCollectionResult {
  note: EvidenceNote;
  collection: Collection;
}

export interface WorkspaceClient {
  bootstrap(): Promise<WorkspaceBootstrapDto>;
  getProject(query: GetWorkspaceProjectQuery): Promise<WorkspaceProjectDto | null>;
  createProject(
    command: CreateProjectCommand,
  ): Promise<WorkspaceCommandResult<CreateProjectResult>>;
  createCollection(
    command: CreateCollectionCommand,
  ): Promise<WorkspaceCommandResult<CreateCollectionResult>>;
  stageImport(
    command: StageImportCommand,
  ): Promise<WorkspaceCommandResult<StageImportResult>>;
  fileImport(
    command: FileImportCommand,
  ): Promise<WorkspaceCommandResult<FileImportResult>>;
  createEvidenceNote(
    command: CreateEvidenceNoteCommand,
  ): Promise<WorkspaceCommandResult<CreateEvidenceNoteResult>>;
  addPaperToCollection(
    command: AddPaperToCollectionCommand,
  ): Promise<WorkspaceCommandResult<AddPaperToCollectionResult>>;
  addNoteToCollection(
    command: AddNoteToCollectionCommand,
  ): Promise<WorkspaceCommandResult<AddNoteToCollectionResult>>;
}

/** Byte transfer remains absent from DemoWorkspaceClient by construction. */
export interface UploadWorkspaceClient extends WorkspaceClient {
  stageImport(
    command: StageImportCommand,
  ): Promise<WorkspaceCommandResult<OrdinaryStageImportResult>>;
  fileImport(
    command: FileImportCommand,
  ): Promise<WorkspaceCommandResult<OrdinaryFileImportResult>>;
  prepareWebMcpApprovalChallenge(
    command: PrepareWebMcpApprovalChallengeCommand,
  ): Promise<PrepareWebMcpApprovalChallengeResponse>;
  approveWebMcpProposal(
    submission: FrozenWebMcpApprovalSubmission,
  ): Promise<ApproveWebMcpProposalResponse>;
  captureGroundedEvidence(
    paperId: string,
    command: CaptureGroundedEvidenceCommand,
  ): Promise<CaptureGroundedEvidenceResponse>;
  createEvidenceRevision(
    noteId: string,
    command: CreateEvidenceRevisionCommand,
    predecessor: EvidenceNote,
  ): Promise<CreateEvidenceRevisionResponse>;
  createUploadSession(
    command: CreateUploadSessionCommand,
  ): Promise<WorkspaceCommandResult<CreateUploadSessionResult>>;
  uploadContent(
    uploadId: string,
    file: File,
    options?: UploadTransferOptions,
  ): Promise<UploadStatusDto>;
  getUploadStatus(uploadId: string, signal?: AbortSignal): Promise<UploadStatusDto>;
  linkValidatedDocument(
    documentId: string,
    command: LinkValidatedDocumentCommand,
  ): Promise<WorkspaceCommandResult<LinkValidatedDocumentResult>>;
  getPaperReader(
    paperId: string,
    options?: ReaderPageOptions,
  ): Promise<WorkspacePaperReaderDto>;
}
