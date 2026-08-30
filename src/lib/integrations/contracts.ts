import type {
  Collection,
  ConfidenceLevel,
  EvidenceNote,
  EvidenceNoteKind,
  ISODateTime,
  Paper,
  PaperFigure,
  PaperHighlight,
  PaperSection,
  Provenance,
  ResearchToolKind,
} from "../types";

export type IntegrationTransport = "mock" | "http-api" | "mcp" | "webmcp";

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  description: string;
  transport: IntegrationTransport;
  isMock: boolean;
  capabilities: string[];
}

export interface ProviderResponseMeta {
  requestId: string;
  provider: ProviderDescriptor;
  retrievedAt: ISODateTime;
  provenance: Provenance[];
  notices: string[];
}

export interface LiteratureSearchFilters {
  yearFrom?: number;
  yearTo?: number;
  paperTypes?: Paper["type"][];
  evidenceStrength?: Paper["evidenceStrength"][];
  tags?: string[];
}

export interface LiteratureSearchRequest {
  requestId?: string;
  query: string;
  researchGoalId?: string;
  filters?: LiteratureSearchFilters;
  limit?: number;
}

export interface LiteratureSearchHit {
  paper: Paper;
  rank: number;
  score: number;
  matchedTerms: string[];
  provenance: Provenance;
}

export interface LiteratureSearchResponse extends ProviderResponseMeta {
  query: string;
  results: LiteratureSearchHit[];
  total: number;
}

export interface LiteratureSearchProvider {
  readonly descriptor: ProviderDescriptor;
  search(request: LiteratureSearchRequest): Promise<LiteratureSearchResponse>;
}

export interface PaperSourceRequest {
  requestId?: string;
  paperId: string;
  sectionIds?: string[];
  includeFigures?: boolean;
  includeHighlights?: boolean;
}

export interface PaperSourceResponse extends ProviderResponseMeta {
  paper: Paper;
  sections: PaperSection[];
  figures: PaperFigure[];
  highlights: PaperHighlight[];
}

export interface PaperSourceProvider {
  readonly descriptor: ProviderDescriptor;
  getPaper(request: PaperSourceRequest): Promise<PaperSourceResponse>;
}

export interface CitationLibraryListRequest {
  requestId?: string;
}

export interface CitationLibraryListResponse extends ProviderResponseMeta {
  collections: Collection[];
}

export interface CitationLibrarySaveRequest {
  requestId?: string;
  collectionId: string;
  paperId: string;
  /** UI-generated idempotency key; a remote adapter should forward or persist it. */
  clientOperationId?: string;
}

export interface CitationLibrarySaveResponse extends ProviderResponseMeta {
  collection: Collection;
  paper: Paper;
  added: boolean;
}

export interface CitationLibraryProvider {
  readonly descriptor: ProviderDescriptor;
  listCollections(request?: CitationLibraryListRequest): Promise<CitationLibraryListResponse>;
  savePaper(request: CitationLibrarySaveRequest): Promise<CitationLibrarySaveResponse>;
}

export interface NotesListRequest {
  requestId?: string;
  paperId?: string;
  collectionId?: string;
  kinds?: EvidenceNoteKind[];
}

export interface NotesListResponse extends ProviderResponseMeta {
  notes: EvidenceNote[];
}

export type EvidenceNoteDraft = Omit<
  EvidenceNote,
  "id" | "createdAt" | "updatedAt" | "provenance"
> & {
  id?: string;
  createdAt?: ISODateTime;
  provenance: Provenance;
};

export interface NotesSaveRequest {
  requestId?: string;
  note: EvidenceNoteDraft;
  clientOperationId?: string;
}

export interface NotesSaveResponse extends ProviderResponseMeta {
  note: EvidenceNote;
  created: boolean;
}

export interface NotesProvider {
  readonly descriptor: ProviderDescriptor;
  listNotes(request?: NotesListRequest): Promise<NotesListResponse>;
  saveNote(request: NotesSaveRequest): Promise<NotesSaveResponse>;
}

export interface EvidenceRecord {
  id: string;
  noteId: string;
  paperId: string;
  claim: string;
  evidence: string;
  interpretation: string;
  openQuestion?: string;
  confidence: ConfidenceLevel;
  kind: EvidenceNoteKind;
  provenance: Provenance;
  storedAt: ISODateTime;
}

export interface EvidenceQueryRequest {
  requestId?: string;
  paperId?: string;
  collectionId?: string;
  kinds?: EvidenceNoteKind[];
  confidence?: ConfidenceLevel[];
  text?: string;
}

export interface EvidenceQueryResponse extends ProviderResponseMeta {
  records: EvidenceRecord[];
  total: number;
}

export interface EvidenceSaveRequest {
  requestId?: string;
  note: EvidenceNote;
  clientOperationId?: string;
}

export interface EvidenceSaveResponse extends ProviderResponseMeta {
  record: EvidenceRecord;
  created: boolean;
}

export interface EvidenceStore {
  readonly descriptor: ProviderDescriptor;
  queryEvidence(request?: EvidenceQueryRequest): Promise<EvidenceQueryResponse>;
  saveEvidence(request: EvidenceSaveRequest): Promise<EvidenceSaveResponse>;
}

export interface ToolGovernancePolicy {
  readScopes: string[];
  writeScopes: string[];
  requiresWriteConfirmation: boolean;
  returnsProvenance: boolean;
}

export interface ResearchToolRegistration {
  id: string;
  kind: ResearchToolKind;
  descriptor: ProviderDescriptor;
  governance: ToolGovernancePolicy;
}

/**
 * A registry exposes only known, typed capabilities. It intentionally has no
 * generic `execute(name, arbitraryInput)` escape hatch: external systems remain
 * governed tools rather than unrestricted model or UI access.
 */
export interface ResearchToolRegistry {
  listTools(): readonly ResearchToolRegistration[];
  getLiteratureSearchProvider(providerId?: string): LiteratureSearchProvider;
  getPaperSourceProvider(providerId?: string): PaperSourceProvider;
  getCitationLibraryProvider(providerId?: string): CitationLibraryProvider;
  getNotesProvider(providerId?: string): NotesProvider;
  getEvidenceStore(providerId?: string): EvidenceStore;
}
