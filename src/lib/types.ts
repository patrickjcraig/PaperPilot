/**
 * Core domain types for PaperPilot.
 *
 * Keep these types independent from React and from any particular integration
 * transport. The UI, seeded demo, and MCP/WebMCP adapters all speak this same
 * small domain language.
 */

export type ISODateTime = string;

export type ResearchGoalStatus = "active" | "paused" | "complete";

export interface ResearchGoal {
  id: string;
  title: string;
  query: string;
  description: string;
  status: ResearchGoalStatus;
  topicTags: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type PaperType =
  | "journal article"
  | "conference paper"
  | "review"
  | "methods paper"
  | "application study";

export type EvidenceStrength =
  | "foundational"
  | "strong"
  | "promising"
  | "contextual"
  | "unassessed";

export type ReadingStatus = "unread" | "queued" | "reading" | "reviewed";

export interface PaperIdentifier {
  scheme: "doi" | "arxiv" | "isbn" | "provider";
  value: string;
}

export interface Paper {
  id: string;
  title: string;
  shortTitle: string;
  authors: string[];
  year: number;
  venue: string;
  type: PaperType;
  abstract: string;
  abstractSnippet: string;
  whyRead: string;
  relevanceScore: number;
  relevanceTags: string[];
  evidenceStrength: EvidenceStrength;
  readingStatus: ReadingStatus;
  readingProgress: number;
  estimatedMinutes: number;
  citationCount?: number;
  providerRelevanceScore?: number;
  identifiers: PaperIdentifier[];
  sourceUrl?: string;
  access?: {
    isOpenAccess: boolean;
    hasFullText: boolean;
    landingPageUrl?: string;
    pdfUrl?: string;
    license?: string;
    version?: string;
  };
  isRetracted?: boolean;
  providerUpdatedAt?: ISODateTime;
  /** All bundled citations are illustrative demo records, not live search results. */
  isDemoRecord: boolean;
}

export type PaperSectionKind =
  | "abstract"
  | "introduction"
  | "related-work"
  | "methods"
  | "results"
  | "discussion"
  | "limitations"
  | "conclusion";

export interface PaperParagraph {
  id: string;
  page: number;
  text: string;
  highlightIds?: string[];
}

export interface PaperSection {
  id: string;
  paperId: string;
  order: number;
  number?: string;
  title: string;
  kind: PaperSectionKind;
  pageStart: number;
  pageEnd: number;
  readingMinutes: number;
  progress: number;
  summaryLabel?: string;
  paragraphs: PaperParagraph[];
  figureIds: string[];
}

export interface PaperFigure {
  id: string;
  paperId: string;
  sectionId: string;
  label: string;
  title: string;
  caption: string;
  page: number;
  altText: string;
  visualKind: "comparison" | "diagram" | "chart" | "reconstruction";
  findings: string[];
  evidenceStrength: EvidenceStrength;
}

export type HighlightRole = "central-claim" | "method" | "result" | "limitation" | "definition";

export interface SourceLocator {
  paperId: string;
  sectionId?: string;
  sectionTitle?: string;
  page?: number;
  pageRange?: [number, number];
  paragraphId?: string;
  figureId?: string;
  figureLabel?: string;
}

export type ProvenanceSourceType =
  | "paper"
  | "figure"
  | "citation-library"
  | "note-system"
  | "evidence-store"
  | "literature-index"
  | "uploaded-file"
  | "web-source";

export type ProvenanceAccessMethod =
  | "seeded-demo"
  | "manual"
  | "api"
  | "upload"
  | "oauth"
  | "crawler"
  | "mcp"
  | "webmcp";

/**
 * An attributable record that can travel with every retrieved or saved item.
 * A real provider can add its stable identifier and URL without changing the UI.
 */
export interface Provenance {
  id: string;
  sourceType: ProvenanceSourceType;
  sourceId: string;
  sourceTitle: string;
  sourceUrl?: string;
  providerName: string;
  retrievedAt: ISODateTime;
  accessMethod: ProvenanceAccessMethod;
  locator?: SourceLocator;
  excerpt?: string;
  version?: string;
}

export interface PaperHighlight {
  id: string;
  paperId: string;
  sectionId: string;
  paragraphId: string;
  page: number;
  text: string;
  role: HighlightRole;
  marginLabel: string;
  provenance: Provenance;
}

export type ReadingStage = 1 | 2 | 3 | 4;

export interface GuidedReadingPrompt {
  id: string;
  stage: ReadingStage;
  stageTitle: string;
  stageEyebrow: string;
  question: string;
  rationale: string;
  cues: string[];
  responsePlaceholder: string;
  grounding: SourceLocator;
  suggestedHighlightIds: string[];
}

export type ConfidenceLevel = "high" | "medium" | "low" | "unspecified";

export type EvidenceNoteKind = "direct-evidence" | "interpretation" | "open-question";

export type NoteStatus = "captured" | "needs-verification" | "verified";

export interface GroundedEvidenceBoundary {
  chunkId: string;
  sequence: number;
  /** Canonical UTF-8 byte offset; start is inclusive and end is exclusive. */
  byteOffset: number;
  contentHash: string;
}

export type GroundedEvidenceSourceState = "current" | "superseded" | "unresolvable";

/** Server-derived custody for an excerpt reconstructed from admitted Reader chunks. */
export interface GroundedEvidenceAnchor {
  schemaVersion: 1;
  state: GroundedEvidenceSourceState;
  documentId: string;
  extractionId: string;
  manifestSha256: string;
  start: GroundedEvidenceBoundary;
  end: GroundedEvidenceBoundary;
  quoteSha256: string;
  pageStart: number;
  pageEnd: number;
  paragraphStartId: string;
  paragraphEndId: string;
}

/**
 * Immutable revision lineage for one structured evidence assertion. The root
 * ID is the stable logical identity of the chain visible in this read model;
 * previous/next IDs allow history navigation without conflating revision
 * currency with researcher review status.
 */
export interface EvidenceNoteRevision {
  rootId: string;
  previousId?: string;
  nextId?: string;
  number: number;
  isLatest: boolean;
}

/** A structured reading note; claim and interpretation remain visibly distinct. */
export interface EvidenceNote {
  id: string;
  paperId: string;
  title: string;
  kind: EvidenceNoteKind;
  claim: string;
  evidence: string;
  interpretation: string;
  openQuestion?: string;
  confidence: ConfidenceLevel;
  status: NoteStatus;
  provenance: Provenance;
  linkedHighlightIds: string[];
  collectionIds: string[];
  tags: string[];
  /** Present only when the source excerpt was reconstructed by the server. */
  grounding?: GroundedEvidenceAnchor;
  /** Immutable correction/review history; every live and demo note supplies it. */
  revision: EvidenceNoteRevision;
  /** Explicit researcher-review time; present exactly when this revision is verified. */
  reviewedAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  color: "blue" | "amber" | "slate" | "teal";
  paperIds: string[];
  noteIds: string[];
  evidenceClaimCount: number;
  openQuestionCount: number;
  updatedAt: ISODateTime;
}

export type ProjectType = "evidence-map" | "literature-review" | "systematic-review";
export type ProjectVisibility = "private" | "workspace";
export type ProjectStatus = "active" | "archived";

/** A durable research question and its working set. Collections remain nested filing views. */
export interface ResearchProject {
  id: string;
  name: string;
  question: string;
  description: string;
  type: ProjectType;
  visibility: ProjectVisibility;
  status: ProjectStatus;
  paperIds: string[];
  evidenceNoteIds: string[];
  collectionIds: string[];
  sourceConnectionIds: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type ImportSourceKind =
  | "discover"
  | "zotero"
  | "upload"
  | "crawler"
  | "webmcp"
  | "identifier";
export type InboxEntryStatus =
  | "awaiting-review"
  | "possible-duplicate"
  | "processing"
  | "ready"
  | "blocked";

/**
 * A staged acquisition record. Keeping the provider snapshot and provenance together
 * lets every future source use the same review-and-commit lifecycle.
 */
interface PaperInboxEntryBase {
  /** Omitted by legacy/demo snapshots; live APIs always return it. */
  entryKind?: "paper";
  id: string;
  paper: Paper;
  provenance: Provenance;
  status: InboxEntryStatus;
  duplicateOfPaperId?: string;
  destinationProjectId?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Paper-shaped entries that can be asserted through generic import flows. */
export interface InboxEntry extends PaperInboxEntryBase {
  sourceKind: Exclude<ImportSourceKind, "webmcp">;
}

/** Deliberately excludes access, custody, workspace, project, and document data. */
export type WebMcpDuplicateCandidate = Pick<
  Paper,
  "id" | "title" | "authors" | "year" | "venue" | "type" | "identifiers"
>;

/**
 * A server-managed WebMCP proposal. The digest is computed from the exact
 * authoritative snapshot stored by PaperPilot; browsers must echo it during
 * approval and must never try to reconstruct it from rendered metadata.
 */
export interface WebMcpInboxEntry extends PaperInboxEntryBase {
  entryKind: "paper";
  sourceKind: "webmcp";
  proposalDigest: string;
  duplicateCandidate?: WebMcpDuplicateCandidate;
}

export type DocumentUploadStage =
  | "awaiting-bytes"
  | "receiving"
  | "quarantined"
  | "validating"
  | "ready"
  | "failed"
  | "expired";

/**
 * Durable text-extraction state for a validated upload.
 *
 * This is intentionally independent from DocumentUploadStage: validation may
 * remain `ready` while the linked document moves through extraction.
 */
export type DocumentTextExtractionStage =
  | "not-started"
  | "queued"
  | "extracting"
  | "ready"
  | "no-text"
  | "failed";

export type DocumentUploadFailureCode =
  | "invalid_pdf_envelope"
  | "pdf_trailing_data"
  | "size_mismatch"
  | "upload_too_large"
  | "upload_aborted"
  | "upload_timed_out"
  | "storage_unavailable"
  | "storage_finalize_failed"
  | "session_expired"
  | "malware_detected"
  | "invalid_pdf_structure"
  | "integrity_check_failed"
  | "validation_unavailable"
  | "validation_failed"
  | "file_unavailable"
  | "upload_failed";

/**
 * A PDF that has not produced trustworthy scholarly metadata yet.
 *
 * It intentionally has no Paper-shaped fallback: a filename is display-only
 * custody metadata, never a title/authors/year assertion.
 */
export interface DocumentUploadInboxEntry {
  entryKind: "document-upload";
  id: string;
  sourceKind: "upload";
  provenance: Provenance;
  status: "processing" | "ready" | "blocked";
  /** Uploads cannot target a project until verified metadata becomes a paper entry. */
  destinationProjectId?: never;
  upload: {
    id: string;
    documentId: string;
    fileName: string;
    expectedSizeBytes: number;
    receivedSizeBytes?: number;
    mediaType: "application/pdf";
    stage: DocumentUploadStage;
    /** Present only after this validated document has been linked explicitly. */
    linkedPaperId?: string;
    extractionStage: DocumentTextExtractionStage;
    /** Server-derived convenience flag; true only for a linked, ready extraction. */
    readerAvailable: boolean;
    expiresAt: ISODateTime;
  };
  failure?: {
    code: DocumentUploadFailureCode;
    message: string;
    retryable: boolean;
    requestId?: string;
  };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type CrawlerDocumentStage =
  | "queued"
  | "fetching"
  | "quarantined"
  | "validating"
  | "extracting"
  | "ready"
  | "attention"
  | "failed"
  | "cancelled";

export type CrawlerDocumentFailureCode =
  | "crawler_attention"
  | "crawler_failed"
  | "crawler_cancelled";

/**
 * A governed crawler acquisition that has entered PaperPilot's document
 * pipeline. This read model deliberately carries no URL, digest, storage
 * locator, network receipt, or worker identity. The opaque crawler ID is the
 * only source handle available to the browser.
 */
export interface CrawlerDocumentInboxEntry {
  entryKind: "crawler-document";
  id: string;
  sourceKind: "crawler";
  provenance: Provenance;
  status: "processing" | "ready" | "blocked";
  destinationProjectId?: never;
  crawler: {
    id: string;
    documentId: string;
    fileName: string;
    mediaType: "application/pdf";
    stage: CrawlerDocumentStage;
    /** Present only after this validated document has been linked explicitly. */
    linkedPaperId?: string;
    extractionStage: DocumentTextExtractionStage;
    /** Server-derived convenience flag; true only for a linked, ready extraction. */
    readerAvailable: boolean;
  };
  failure?: {
    code: CrawlerDocumentFailureCode;
    message: string;
    retryable: boolean;
  };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type PaperInboxEntry = InboxEntry | WebMcpInboxEntry;
export type DocumentInboxEntry = DocumentUploadInboxEntry | CrawlerDocumentInboxEntry;
export type WorkspaceInboxEntry = PaperInboxEntry | DocumentInboxEntry;

export function isDocumentUploadInboxEntry(
  entry: WorkspaceInboxEntry,
): entry is DocumentUploadInboxEntry {
  return entry.entryKind === "document-upload";
}

export function isCrawlerDocumentInboxEntry(
  entry: WorkspaceInboxEntry,
): entry is CrawlerDocumentInboxEntry {
  return entry.entryKind === "crawler-document";
}

export function isDocumentInboxEntry(
  entry: WorkspaceInboxEntry,
): entry is DocumentInboxEntry {
  return entry.entryKind === "document-upload"
    || entry.entryKind === "crawler-document";
}

export function isWebMcpInboxEntry(
  entry: WorkspaceInboxEntry,
): entry is WebMcpInboxEntry {
  return entry.entryKind !== "document-upload"
    && entry.sourceKind === "webmcp"
    && "proposalDigest" in entry;
}

export type ActivityType =
  | "paper-opened"
  | "note-saved"
  | "evidence-linked"
  | "collection-updated"
  | "question-flagged";

export interface ResearchActivity {
  id: string;
  type: ActivityType;
  title: string;
  detail: string;
  occurredAt: ISODateTime;
  paperId?: string;
  noteId?: string;
  collectionId?: string;
  locator?: SourceLocator;
}

export interface DashboardMetric {
  id: "papers-reviewed" | "evidence-notes" | "open-questions";
  label: string;
  value: number;
  detail: string;
  trend?: string;
}

export type ResearchToolKind =
  | "literature-search"
  | "paper-source"
  | "citation-library"
  | "notes"
  | "evidence-store";

export type ToolConnectionStatus = "demo-ready" | "not-connected" | "attention";

export interface ConnectedResearchTool {
  id: string;
  name: string;
  kind: ResearchToolKind;
  status: ToolConnectionStatus;
  statusLabel: string;
  description: string;
  transport: "mock" | "mcp" | "webmcp";
  lastCheckedAt?: ISODateTime;
}
