import {
  collections as seededCollections,
  paperFigures,
  paperHighlights,
  papers,
  paperSections,
  seededNotes,
} from "../data";
import type { Collection, EvidenceNote, Paper, Provenance, ResearchToolKind } from "../types";
import type {
  CitationLibraryListRequest,
  CitationLibraryListResponse,
  CitationLibraryProvider,
  CitationLibrarySaveRequest,
  CitationLibrarySaveResponse,
  EvidenceQueryRequest,
  EvidenceQueryResponse,
  EvidenceRecord,
  EvidenceSaveRequest,
  EvidenceSaveResponse,
  EvidenceStore,
  LiteratureSearchHit,
  LiteratureSearchProvider,
  LiteratureSearchRequest,
  LiteratureSearchResponse,
  NotesListRequest,
  NotesListResponse,
  NotesProvider,
  NotesSaveRequest,
  NotesSaveResponse,
  PaperSourceProvider,
  PaperSourceRequest,
  PaperSourceResponse,
  ProviderDescriptor,
  ProviderResponseMeta,
  ResearchToolRegistration,
  ResearchToolRegistry,
} from "./contracts";

const MOCK_TIME = "2026-08-28T12:00:00.000Z";
let requestSequence = 0;
let entitySequence = 0;

function nextRequestId(prefix: string, supplied?: string): string {
  requestSequence += 1;
  return supplied ?? `${prefix}-${requestSequence.toString().padStart(4, "0")}`;
}

function nextEntityId(prefix: string): string {
  entitySequence += 1;
  return `${prefix}-demo-${entitySequence.toString().padStart(4, "0")}`;
}

function createPaperProvenance(paper: Paper, providerName: string): Provenance {
  return {
    id: `prov-${paper.id}-${providerName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
    sourceType: "literature-index",
    sourceId: paper.id,
    sourceTitle: paper.title,
    sourceUrl: paper.sourceUrl,
    providerName,
    retrievedAt: MOCK_TIME,
    accessMethod: "seeded-demo",
    locator: { paperId: paper.id },
    version: "demo-corpus-1.0",
  };
}

function responseMeta(
  descriptor: ProviderDescriptor,
  requestId: string,
  provenance: Provenance[],
  notices: string[] = [],
): ProviderResponseMeta {
  return {
    requestId,
    provider: descriptor,
    retrievedAt: MOCK_TIME,
    provenance,
    notices,
  };
}

function cloneCollection(collection: Collection): Collection {
  return {
    ...collection,
    paperIds: [...collection.paperIds],
    noteIds: [...collection.noteIds],
  };
}

function cloneNote(note: EvidenceNote): EvidenceNote {
  return {
    ...note,
    linkedHighlightIds: [...note.linkedHighlightIds],
    collectionIds: [...note.collectionIds],
    tags: [...note.tags],
    provenance: {
      ...note.provenance,
      locator: note.provenance.locator ? { ...note.provenance.locator } : undefined,
    },
  };
}

function tokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLocaleLowerCase()
        .split(/[^a-z0-9μ-]+/)
        .filter((token) => token.length > 2),
    ),
  );
}

export class MockLiteratureSearchProvider implements LiteratureSearchProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "mock-literature-search",
    displayName: "PaperPilot demo literature index",
    description: "Searches the six bundled demo records without a network request.",
    transport: "mock",
    isMock: true,
    capabilities: ["search-papers", "filter-metadata", "return-provenance"],
  };

  constructor(private readonly corpus: readonly Paper[] = papers) {}

  async search(request: LiteratureSearchRequest): Promise<LiteratureSearchResponse> {
    const requestId = nextRequestId("lit", request.requestId);
    const queryTokens = tokens(request.query);
    const filtered = this.corpus.filter((paper) => {
      const filters = request.filters;
      if (filters?.yearFrom && paper.year < filters.yearFrom) return false;
      if (filters?.yearTo && paper.year > filters.yearTo) return false;
      if (filters?.paperTypes?.length && !filters.paperTypes.includes(paper.type)) return false;
      if (
        filters?.evidenceStrength?.length &&
        !filters.evidenceStrength.includes(paper.evidenceStrength)
      ) {
        return false;
      }
      if (
        filters?.tags?.length &&
        !filters.tags.some((tag) =>
          paper.relevanceTags.some((paperTag) =>
            paperTag.toLocaleLowerCase().includes(tag.toLocaleLowerCase()),
          ),
        )
      ) {
        return false;
      }
      return true;
    });

    const ranked = filtered
      .map((paper) => {
        const haystack = tokens(
          [
            paper.title,
            paper.abstract,
            paper.whyRead,
            paper.relevanceTags.join(" "),
          ].join(" "),
        );
        const matchedTerms = queryTokens.filter((token) => haystack.includes(token));
        const lexicalBoost = queryTokens.length ? (matchedTerms.length / queryTokens.length) * 8 : 0;
        return {
          paper,
          matchedTerms,
          score: Math.min(100, Math.round((paper.relevanceScore + lexicalBoost) * 10) / 10),
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit ?? 10);

    const results: LiteratureSearchHit[] = ranked.map((result, index) => ({
      ...result,
      rank: index + 1,
      provenance: createPaperProvenance(result.paper, this.descriptor.displayName),
    }));
    const provenance = results.map((result) => result.provenance);

    return {
      ...responseMeta(this.descriptor, requestId, provenance, [
        "Demo records are illustrative and were not retrieved from a live index.",
      ]),
      query: request.query,
      results,
      total: results.length,
    };
  }
}

export class MockPaperSourceProvider implements PaperSourceProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "mock-paper-source",
    displayName: "PaperPilot demo paper source",
    description: "Returns bundled sections, figures, highlights, and precise locators.",
    transport: "mock",
    isMock: true,
    capabilities: ["read-paper", "read-sections", "read-figures", "return-provenance"],
  };

  async getPaper(request: PaperSourceRequest): Promise<PaperSourceResponse> {
    const requestId = nextRequestId("source", request.requestId);
    const paper = papers.find((candidate) => candidate.id === request.paperId);
    if (!paper) throw new Error(`Paper source could not resolve paper "${request.paperId}".`);

    let sections = paperSections.filter((section) => section.paperId === request.paperId);
    if (request.sectionIds?.length) {
      sections = sections.filter((section) => request.sectionIds?.includes(section.id));
    }
    const sectionIds = new Set(sections.map((section) => section.id));
    const figures =
      request.includeFigures === false
        ? []
        : paperFigures.filter(
            (figure) => figure.paperId === request.paperId && sectionIds.has(figure.sectionId),
          );
    const highlights =
      request.includeHighlights === false
        ? []
        : paperHighlights.filter(
            (highlight) =>
              highlight.paperId === request.paperId && sectionIds.has(highlight.sectionId),
          );
    const provenance = [
      createPaperProvenance(paper, this.descriptor.displayName),
      ...highlights.map((highlight) => highlight.provenance),
    ];

    return {
      ...responseMeta(this.descriptor, requestId, provenance, [
        sections.length
          ? "Paper content is bundled demo copy with inspectable section and page locators."
          : "This demo record has metadata only; full seeded content is available for the selected paper.",
      ]),
      paper,
      sections,
      figures,
      highlights,
    };
  }
}

export class MockCitationLibraryProvider implements CitationLibraryProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "mock-citation-library",
    displayName: "PaperPilot demo citation library",
    description: "Stores paper-to-collection links in memory for the current browser session.",
    transport: "mock",
    isMock: true,
    capabilities: ["list-collections", "save-paper", "return-provenance"],
  };

  private readonly libraryCollections: Collection[];

  constructor(initialCollections: readonly Collection[] = seededCollections) {
    this.libraryCollections = initialCollections.map(cloneCollection);
  }

  async listCollections(
    request: CitationLibraryListRequest = {},
  ): Promise<CitationLibraryListResponse> {
    const requestId = nextRequestId("library-list", request.requestId);
    const provenance: Provenance = {
      id: "prov-demo-citation-library",
      sourceType: "citation-library",
      sourceId: this.descriptor.id,
      sourceTitle: "PaperPilot demo collections",
      providerName: this.descriptor.displayName,
      retrievedAt: MOCK_TIME,
      accessMethod: "seeded-demo",
      version: "session-memory",
    };
    return {
      ...responseMeta(this.descriptor, requestId, [provenance]),
      collections: this.libraryCollections.map(cloneCollection),
    };
  }

  async savePaper(request: CitationLibrarySaveRequest): Promise<CitationLibrarySaveResponse> {
    const requestId = nextRequestId("library-save", request.requestId);
    const collection = this.libraryCollections.find(
      (candidate) => candidate.id === request.collectionId,
    );
    if (!collection) throw new Error(`Collection "${request.collectionId}" was not found.`);
    const paper = papers.find((candidate) => candidate.id === request.paperId);
    if (!paper) throw new Error(`Paper "${request.paperId}" was not found.`);
    const added = !collection.paperIds.includes(paper.id);
    if (added) {
      collection.paperIds.push(paper.id);
      collection.updatedAt = MOCK_TIME;
    }
    const provenance = createPaperProvenance(paper, this.descriptor.displayName);
    provenance.sourceType = "citation-library";

    return {
      ...responseMeta(this.descriptor, requestId, [provenance]),
      collection: cloneCollection(collection),
      paper,
      added,
    };
  }
}

export class MockNotesProvider implements NotesProvider {
  readonly descriptor: ProviderDescriptor = {
    id: "mock-notes",
    displayName: "PaperPilot demo notes",
    description: "Stores structured claim/evidence/interpretation notes in memory.",
    transport: "mock",
    isMock: true,
    capabilities: ["list-notes", "save-structured-note", "return-provenance"],
  };

  private readonly notes: EvidenceNote[];

  constructor(initialNotes: readonly EvidenceNote[] = seededNotes) {
    this.notes = initialNotes.map(cloneNote);
  }

  async listNotes(request: NotesListRequest = {}): Promise<NotesListResponse> {
    const requestId = nextRequestId("notes-list", request.requestId);
    const notes = this.notes.filter((note) => {
      if (request.paperId && note.paperId !== request.paperId) return false;
      if (request.collectionId && !note.collectionIds.includes(request.collectionId)) return false;
      if (request.kinds?.length && !request.kinds.includes(note.kind)) return false;
      return true;
    });
    return {
      ...responseMeta(
        this.descriptor,
        requestId,
        notes.map((note) => note.provenance),
      ),
      notes: notes.map(cloneNote),
    };
  }

  async saveNote(request: NotesSaveRequest): Promise<NotesSaveResponse> {
    const requestId = nextRequestId("notes-save", request.requestId);
    const existingIndex = request.note.id
      ? this.notes.findIndex((note) => note.id === request.note.id)
      : -1;
    const created = existingIndex < 0;
    const original = existingIndex >= 0 ? this.notes[existingIndex] : undefined;
    const note: EvidenceNote = {
      ...request.note,
      id: request.note.id ?? nextEntityId("note"),
      createdAt: request.note.createdAt ?? original?.createdAt ?? MOCK_TIME,
      updatedAt: MOCK_TIME,
    };
    if (existingIndex >= 0) this.notes[existingIndex] = cloneNote(note);
    else this.notes.unshift(cloneNote(note));

    return {
      ...responseMeta(this.descriptor, requestId, [note.provenance]),
      note: cloneNote(note),
      created,
    };
  }
}

function noteToEvidenceRecord(note: EvidenceNote): EvidenceRecord {
  return {
    id: `evidence-${note.id}`,
    noteId: note.id,
    paperId: note.paperId,
    claim: note.claim,
    evidence: note.evidence,
    interpretation: note.interpretation,
    openQuestion: note.openQuestion,
    confidence: note.confidence,
    kind: note.kind,
    provenance: note.provenance,
    storedAt: note.updatedAt,
  };
}

export class MockEvidenceStore implements EvidenceStore {
  readonly descriptor: ProviderDescriptor = {
    id: "mock-evidence-store",
    displayName: "PaperPilot demo evidence store",
    description: "Keeps attributable evidence records in memory for the demo.",
    transport: "mock",
    isMock: true,
    capabilities: ["query-evidence", "save-evidence", "return-provenance"],
  };

  private readonly records: EvidenceRecord[];

  constructor(initialNotes: readonly EvidenceNote[] = seededNotes) {
    this.records = initialNotes.map(noteToEvidenceRecord);
  }

  async queryEvidence(request: EvidenceQueryRequest = {}): Promise<EvidenceQueryResponse> {
    const requestId = nextRequestId("evidence-query", request.requestId);
    const searchText = request.text?.trim().toLocaleLowerCase();
    const collectionNoteIds = request.collectionId
      ? new Set(
          seededCollections.find((collection) => collection.id === request.collectionId)?.noteIds ??
            [],
        )
      : undefined;
    const records = this.records.filter((record) => {
      if (request.paperId && record.paperId !== request.paperId) return false;
      if (collectionNoteIds && !collectionNoteIds.has(record.noteId)) return false;
      if (request.kinds?.length && !request.kinds.includes(record.kind)) return false;
      if (request.confidence?.length && !request.confidence.includes(record.confidence)) return false;
      if (
        searchText &&
        ![record.claim, record.evidence, record.interpretation, record.openQuestion ?? ""]
          .join(" ")
          .toLocaleLowerCase()
          .includes(searchText)
      ) {
        return false;
      }
      return true;
    });

    return {
      ...responseMeta(
        this.descriptor,
        requestId,
        records.map((record) => record.provenance),
      ),
      records: records.map((record) => ({ ...record })),
      total: records.length,
    };
  }

  async saveEvidence(request: EvidenceSaveRequest): Promise<EvidenceSaveResponse> {
    const requestId = nextRequestId("evidence-save", request.requestId);
    const record = noteToEvidenceRecord(request.note);
    const existingIndex = this.records.findIndex((candidate) => candidate.noteId === record.noteId);
    const created = existingIndex < 0;
    if (existingIndex >= 0) this.records[existingIndex] = record;
    else this.records.unshift(record);

    return {
      ...responseMeta(this.descriptor, requestId, [record.provenance]),
      record: { ...record },
      created,
    };
  }
}

const governanceByKind: Record<ResearchToolKind, ResearchToolRegistration["governance"]> = {
  "literature-search": {
    readScopes: ["paper:metadata", "paper:abstract"],
    writeScopes: [],
    requiresWriteConfirmation: false,
    returnsProvenance: true,
  },
  "paper-source": {
    readScopes: ["paper:content", "paper:figures", "paper:locators"],
    writeScopes: [],
    requiresWriteConfirmation: false,
    returnsProvenance: true,
  },
  "citation-library": {
    readScopes: ["library:collections"],
    writeScopes: ["library:items"],
    requiresWriteConfirmation: true,
    returnsProvenance: true,
  },
  notes: {
    readScopes: ["notes:structured"],
    writeScopes: ["notes:structured"],
    requiresWriteConfirmation: true,
    returnsProvenance: true,
  },
  "evidence-store": {
    readScopes: ["evidence:records"],
    writeScopes: ["evidence:records"],
    requiresWriteConfirmation: true,
    returnsProvenance: true,
  },
};

export class MockResearchToolRegistry implements ResearchToolRegistry {
  constructor(
    private readonly literatureSearch: LiteratureSearchProvider =
      new MockLiteratureSearchProvider(),
    private readonly paperSource: PaperSourceProvider = new MockPaperSourceProvider(),
    private readonly citationLibrary: CitationLibraryProvider =
      new MockCitationLibraryProvider(),
    private readonly notes: NotesProvider = new MockNotesProvider(),
    private readonly evidenceStore: EvidenceStore = new MockEvidenceStore(),
  ) {}

  listTools(): readonly ResearchToolRegistration[] {
    return [
      this.registration("literature-search", this.literatureSearch.descriptor),
      this.registration("paper-source", this.paperSource.descriptor),
      this.registration("citation-library", this.citationLibrary.descriptor),
      this.registration("notes", this.notes.descriptor),
      this.registration("evidence-store", this.evidenceStore.descriptor),
    ];
  }

  getLiteratureSearchProvider(providerId?: string): LiteratureSearchProvider {
    this.assertProvider(providerId, this.literatureSearch.descriptor);
    return this.literatureSearch;
  }

  getPaperSourceProvider(providerId?: string): PaperSourceProvider {
    this.assertProvider(providerId, this.paperSource.descriptor);
    return this.paperSource;
  }

  getCitationLibraryProvider(providerId?: string): CitationLibraryProvider {
    this.assertProvider(providerId, this.citationLibrary.descriptor);
    return this.citationLibrary;
  }

  getNotesProvider(providerId?: string): NotesProvider {
    this.assertProvider(providerId, this.notes.descriptor);
    return this.notes;
  }

  getEvidenceStore(providerId?: string): EvidenceStore {
    this.assertProvider(providerId, this.evidenceStore.descriptor);
    return this.evidenceStore;
  }

  private registration(
    kind: ResearchToolKind,
    descriptor: ProviderDescriptor,
  ): ResearchToolRegistration {
    return { id: descriptor.id, kind, descriptor, governance: governanceByKind[kind] };
  }

  private assertProvider(providerId: string | undefined, descriptor: ProviderDescriptor): void {
    if (providerId && providerId !== descriptor.id) {
      throw new Error(`Provider "${providerId}" is not registered for this capability.`);
    }
  }
}

/**
 * Replace these mock instances with narrowly scoped MCP/WebMCP adapters in the
 * composition root. A real adapter should validate the remote payload against
 * the request/response contract, translate remote citations into `Provenance`,
 * and surface approval before writes. UI components should continue to depend
 * only on `ResearchToolRegistry`, never on a raw server or browser session.
 */
export const mockResearchToolRegistry: ResearchToolRegistry = new MockResearchToolRegistry();

export const mockResearchTools = {
  literatureSearch: mockResearchToolRegistry.getLiteratureSearchProvider(),
  paperSource: mockResearchToolRegistry.getPaperSourceProvider(),
  citationLibrary: mockResearchToolRegistry.getCitationLibraryProvider(),
  notes: mockResearchToolRegistry.getNotesProvider(),
  evidenceStore: mockResearchToolRegistry.getEvidenceStore(),
} as const;
