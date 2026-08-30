import { collections, papers, researchGoal, seededNotes } from "./data";
import type {
  Collection,
  EvidenceNote,
  InboxEntry,
  Paper,
  PaperIdentifier,
  Provenance,
  ResearchProject,
  SourceLocator,
} from "./types";

export const WORKSPACE_STORAGE_KEY = "paperpilot:workspace:v3";
export const LEGACY_WORKSPACE_STORAGE_KEYS = ["paperpilot:workspace:v2"] as const;

export interface WorkspaceSnapshot {
  version: 3;
  projects: ResearchProject[];
  inboxEntries: InboxEntry[];
  importedPapers: Paper[];
  notes: EvidenceNote[];
  collections: Collection[];
  activeProjectId: string;
}

type WorkspaceStorageReader = Pick<Storage, "getItem">;
type WorkspaceStorageWriter = Pick<Storage, "setItem">;

const PROJECT_TYPES = new Set<ResearchProject["type"]>([
  "evidence-map",
  "literature-review",
  "systematic-review",
]);
const PROJECT_VISIBILITIES = new Set<ResearchProject["visibility"]>(["private", "workspace"]);
const PROJECT_STATUSES = new Set<ResearchProject["status"]>(["active", "archived"]);
const PAPER_TYPES = new Set<Paper["type"]>([
  "journal article",
  "conference paper",
  "review",
  "methods paper",
  "application study",
]);
const EVIDENCE_STRENGTHS = new Set<Paper["evidenceStrength"]>([
  "foundational",
  "strong",
  "promising",
  "contextual",
  "unassessed",
]);
const READING_STATUSES = new Set<Paper["readingStatus"]>([
  "unread",
  "queued",
  "reading",
  "reviewed",
]);
const IDENTIFIER_SCHEMES = new Set<PaperIdentifier["scheme"]>([
  "doi",
  "arxiv",
  "isbn",
  "provider",
]);
const SOURCE_KINDS = new Set<InboxEntry["sourceKind"]>([
  "discover",
  "zotero",
  "upload",
  "crawler",
  "identifier",
]);
const INBOX_STATUSES = new Set<InboxEntry["status"]>([
  "awaiting-review",
  "possible-duplicate",
  "processing",
  "ready",
  "blocked",
]);
const PROVENANCE_SOURCE_TYPES = new Set<Provenance["sourceType"]>([
  "paper",
  "figure",
  "citation-library",
  "note-system",
  "evidence-store",
  "literature-index",
  "uploaded-file",
  "web-source",
]);
const PROVENANCE_ACCESS_METHODS = new Set<Provenance["accessMethod"]>([
  "seeded-demo",
  "manual",
  "api",
  "upload",
  "oauth",
  "crawler",
  "mcp",
  "webmcp",
]);
const NOTE_KINDS = new Set<EvidenceNote["kind"]>([
  "direct-evidence",
  "interpretation",
  "open-question",
]);
const NOTE_STATUSES = new Set<EvidenceNote["status"]>([
  "captured",
  "needs-verification",
  "verified",
]);
const CONFIDENCE_LEVELS = new Set<EvidenceNote["confidence"]>(["high", "medium", "low"]);
const COLLECTION_COLORS = new Set<Collection["color"]>(["blue", "amber", "slate", "teal"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown, fallback: readonly string[] = []): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [...fallback];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function cloneLocator(locator: SourceLocator | undefined): SourceLocator | undefined {
  if (!locator) return undefined;
  return {
    ...locator,
    pageRange: locator.pageRange ? [...locator.pageRange] as [number, number] : undefined,
  };
}

function cloneProvenance(provenance: Provenance): Provenance {
  return {
    ...provenance,
    locator: cloneLocator(provenance.locator),
  };
}

function clonePaper(paper: Paper): Paper {
  return {
    ...paper,
    authors: [...paper.authors],
    relevanceTags: [...paper.relevanceTags],
    identifiers: paper.identifiers.map((identifier) => ({ ...identifier })),
    access: paper.access ? { ...paper.access } : undefined,
  };
}

function cloneProject(project: ResearchProject): ResearchProject {
  return {
    ...project,
    paperIds: [...project.paperIds],
    evidenceNoteIds: [...project.evidenceNoteIds],
    collectionIds: [...project.collectionIds],
    sourceConnectionIds: [...project.sourceConnectionIds],
  };
}

function cloneInboxEntry(entry: InboxEntry): InboxEntry {
  return {
    ...entry,
    paper: clonePaper(entry.paper),
    provenance: cloneProvenance(entry.provenance),
  };
}

function cloneEvidenceNote(note: EvidenceNote): EvidenceNote {
  return {
    ...note,
    provenance: cloneProvenance(note.provenance),
    linkedHighlightIds: [...note.linkedHighlightIds],
    collectionIds: [...note.collectionIds],
    tags: [...note.tags],
  };
}

function cloneCollection(collection: Collection): Collection {
  return {
    ...collection,
    paperIds: [...collection.paperIds],
    noteIds: [...collection.noteIds],
  };
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    version: 3,
    projects: snapshot.projects.map(cloneProject),
    inboxEntries: snapshot.inboxEntries.map(cloneInboxEntry),
    importedPapers: snapshot.importedPapers.map(clonePaper),
    notes: snapshot.notes.map(cloneEvidenceNote),
    collections: snapshot.collections.map(cloneCollection),
    activeProjectId: snapshot.activeProjectId,
  };
}

function collectionById(collectionId: string) {
  return collections.find((collection) => collection.id === collectionId);
}

function noteIdsForCollections(collectionIds: readonly string[]): string[] {
  const selectedIds = new Set(collectionIds);
  return seededNotes
    .filter((note) => note.collectionIds.some((collectionId) => selectedIds.has(collectionId)))
    .map((note) => note.id);
}

function demoInboxProvenance(
  sourceKind: "upload" | "zotero" | "crawler",
  paper: Paper,
): Provenance {
  const sourceLabels = {
    upload: "PDF upload preview",
    zotero: "Zotero import preview",
    crawler: "Crawler capture preview",
  } as const;
  const sourceTypes = {
    upload: "uploaded-file",
    zotero: "citation-library",
    crawler: "web-source",
  } as const;

  return {
    id: `provenance-demo-${sourceKind}-${paper.id}`,
    sourceType: sourceTypes[sourceKind],
    sourceId: `demo:${sourceKind}:${paper.id}`,
    sourceTitle: `${sourceLabels[sourceKind]} — ${paper.shortTitle}`,
    providerName: `PaperPilot ${sourceLabels[sourceKind]} (demo only)`,
    retrievedAt: researchGoal.updatedAt,
    accessMethod: "seeded-demo",
    version: "workspace-seed-1",
  };
}

export function createInitialWorkspaceSnapshot(): WorkspaceSnapshot {
  const packagingCollection = collectionById("collection-advanced-packaging");
  const reviewCollection = collectionById("collection-literature-review");
  const packagingCollectionIds = packagingCollection ? [packagingCollection.id] : [];
  const reviewCollectionIds = reviewCollection ? [reviewCollection.id] : [];

  const projects: ResearchProject[] = [
    {
      id: "project-demo-advanced-packaging",
      name: "Advanced Packaging Inspection",
      question:
        "Which acquisition geometries and reconstruction methods best expose buried defects in advanced semiconductor packages?",
      description: researchGoal.description,
      type: "evidence-map",
      visibility: "private",
      status: "active",
      paperIds: [...(packagingCollection?.paperIds ?? [])],
      evidenceNoteIds: noteIdsForCollections(packagingCollectionIds),
      collectionIds: packagingCollectionIds,
      sourceConnectionIds: [],
      createdAt: researchGoal.createdAt,
      updatedAt: researchGoal.updatedAt,
    },
    {
      id: "project-demo-reconstruction-review",
      name: "Limited-Angle Reconstruction Review",
      question:
        "Where do limited-angle reconstruction methods remain reliable, and which experiments expose their failure modes?",
      description:
        "A source-linked review of iterative and learned reconstruction methods, their baselines, and the limits created by missing-angle geometry.",
      type: "literature-review",
      visibility: "workspace",
      status: "active",
      paperIds: [...(reviewCollection?.paperIds ?? [])],
      evidenceNoteIds: noteIdsForCollections(reviewCollectionIds),
      collectionIds: reviewCollectionIds,
      sourceConnectionIds: [],
      createdAt: researchGoal.createdAt,
      updatedAt: researchGoal.updatedAt,
    },
  ];

  const importedPaperIds = new Set(projects.flatMap((project) => project.paperIds));
  const importedPapers = papers.filter((paper) => importedPaperIds.has(paper.id)).map(clonePaper);
  const uploadPaper = papers.find((paper) => paper.id === "patel-2024-uncertainty-ct") ?? papers[0];
  const zoteroPaper = papers.find((paper) => paper.id === "chen-2024-laminography") ?? papers[0];
  const crawlerPaper = papers.find((paper) => paper.id === "silva-2022-artifact-aware") ?? papers[0];
  const duplicate = findPaperDuplicate(zoteroPaper, importedPapers);

  const inboxEntries: InboxEntry[] = [
    {
      id: "inbox-demo-upload-patel-2024",
      sourceKind: "upload",
      paper: clonePaper(uploadPaper),
      provenance: demoInboxProvenance("upload", uploadPaper),
      status: "awaiting-review",
      createdAt: researchGoal.updatedAt,
      updatedAt: researchGoal.updatedAt,
    },
    {
      id: "inbox-demo-zotero-chen-2024",
      sourceKind: "zotero",
      paper: clonePaper(zoteroPaper),
      provenance: demoInboxProvenance("zotero", zoteroPaper),
      status: "possible-duplicate",
      duplicateOfPaperId: duplicate?.id,
      createdAt: researchGoal.updatedAt,
      updatedAt: researchGoal.updatedAt,
    },
    {
      id: "inbox-demo-crawler-silva-2022",
      sourceKind: "crawler",
      paper: clonePaper(crawlerPaper),
      provenance: demoInboxProvenance("crawler", crawlerPaper),
      status: "awaiting-review",
      createdAt: researchGoal.updatedAt,
      updatedAt: researchGoal.updatedAt,
    },
  ];

  return cloneSnapshot({
    version: 3,
    projects,
    inboxEntries,
    importedPapers,
    notes: seededNotes,
    collections,
    activeProjectId: projects[0]?.id ?? "",
  });
}

function normalizeIdentifier(value: unknown): PaperIdentifier | undefined {
  if (!isRecord(value)) return undefined;
  const scheme = requiredString(value.scheme) as PaperIdentifier["scheme"] | undefined;
  const identifierValue = requiredString(value.value);
  if (!scheme || !IDENTIFIER_SCHEMES.has(scheme) || !identifierValue) return undefined;
  return { scheme, value: identifierValue };
}

function normalizePaper(value: unknown): Paper | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  const title = requiredString(value.title);
  if (!id || !title) return undefined;

  const identifiers = Array.isArray(value.identifiers)
    ? value.identifiers.map(normalizeIdentifier)
    : [];
  if (identifiers.some((identifier) => !identifier)) return undefined;

  const type = PAPER_TYPES.has(value.type as Paper["type"])
    ? value.type as Paper["type"]
    : "journal article";
  const evidenceStrength = EVIDENCE_STRENGTHS.has(value.evidenceStrength as Paper["evidenceStrength"])
    ? value.evidenceStrength as Paper["evidenceStrength"]
    : "unassessed";
  const readingStatus = READING_STATUSES.has(value.readingStatus as Paper["readingStatus"])
    ? value.readingStatus as Paper["readingStatus"]
    : "unread";
  const access = isRecord(value.access)
    ? {
        isOpenAccess: value.access.isOpenAccess === true,
        hasFullText: value.access.hasFullText === true,
        landingPageUrl: optionalString(value.access.landingPageUrl),
        pdfUrl: optionalString(value.access.pdfUrl),
        license: optionalString(value.access.license),
        version: optionalString(value.access.version),
      }
    : undefined;

  return {
    id,
    title,
    shortTitle: optionalString(value.shortTitle) ?? title,
    authors: stringArray(value.authors),
    year: finiteNumber(value.year, 0),
    venue: typeof value.venue === "string" ? value.venue : "",
    type,
    abstract: typeof value.abstract === "string" ? value.abstract : "",
    abstractSnippet: typeof value.abstractSnippet === "string" ? value.abstractSnippet : "",
    whyRead:
      typeof value.whyRead === "string"
        ? value.whyRead
        : "Imported record; review its metadata and source before relying on it.",
    relevanceScore: finiteNumber(value.relevanceScore, 0),
    relevanceTags: stringArray(value.relevanceTags),
    evidenceStrength,
    readingStatus,
    readingProgress: finiteNumber(value.readingProgress, 0),
    estimatedMinutes: finiteNumber(value.estimatedMinutes, 0),
    citationCount:
      typeof value.citationCount === "number" && Number.isFinite(value.citationCount)
        ? value.citationCount
        : undefined,
    providerRelevanceScore:
      typeof value.providerRelevanceScore === "number" && Number.isFinite(value.providerRelevanceScore)
        ? value.providerRelevanceScore
        : undefined,
    identifiers: identifiers as PaperIdentifier[],
    sourceUrl: optionalString(value.sourceUrl),
    access,
    isRetracted: typeof value.isRetracted === "boolean" ? value.isRetracted : undefined,
    providerUpdatedAt: optionalString(value.providerUpdatedAt),
    isDemoRecord: typeof value.isDemoRecord === "boolean" ? value.isDemoRecord : false,
  };
}

function normalizeLocator(value: unknown, paperId: string): SourceLocator | undefined {
  if (!isRecord(value)) return undefined;
  const pageRange = Array.isArray(value.pageRange)
    && value.pageRange.length === 2
    && value.pageRange.every((page) => typeof page === "number" && Number.isFinite(page))
      ? [value.pageRange[0], value.pageRange[1]] as [number, number]
      : undefined;
  return {
    paperId: optionalString(value.paperId) ?? paperId,
    sectionId: optionalString(value.sectionId),
    sectionTitle: optionalString(value.sectionTitle),
    page: typeof value.page === "number" && Number.isFinite(value.page) ? value.page : undefined,
    pageRange,
    paragraphId: optionalString(value.paragraphId),
    figureId: optionalString(value.figureId),
    figureLabel: optionalString(value.figureLabel),
  };
}

function normalizeProvenance(
  value: unknown,
  paper: Paper,
  fallbackTimestamp: string,
): Provenance {
  if (!isRecord(value)) {
    return {
      id: `provenance-migrated-${paper.id}`,
      sourceType: "paper",
      sourceId: paper.id,
      sourceTitle: paper.title,
      providerName: "PaperPilot migrated browser workspace",
      retrievedAt: fallbackTimestamp,
      accessMethod: "manual",
      version: "workspace-migration",
    };
  }

  const sourceType = PROVENANCE_SOURCE_TYPES.has(value.sourceType as Provenance["sourceType"])
    ? value.sourceType as Provenance["sourceType"]
    : "paper";
  const accessMethod = PROVENANCE_ACCESS_METHODS.has(value.accessMethod as Provenance["accessMethod"])
    ? value.accessMethod as Provenance["accessMethod"]
    : "manual";

  return {
    id: optionalString(value.id) ?? `provenance-migrated-${paper.id}`,
    sourceType,
    sourceId: optionalString(value.sourceId) ?? paper.id,
    sourceTitle: optionalString(value.sourceTitle) ?? paper.title,
    sourceUrl: optionalString(value.sourceUrl),
    providerName: optionalString(value.providerName) ?? "PaperPilot migrated browser workspace",
    retrievedAt: optionalString(value.retrievedAt) ?? fallbackTimestamp,
    accessMethod,
    locator: normalizeLocator(value.locator, paper.id),
    excerpt: optionalString(value.excerpt),
    version: optionalString(value.version),
  };
}

function normalizeProject(value: unknown): ResearchProject | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  const name = requiredString(value.name);
  if (!id || !name) return undefined;

  return {
    id,
    name,
    question: typeof value.question === "string" ? value.question : name,
    description: typeof value.description === "string" ? value.description : "",
    type: PROJECT_TYPES.has(value.type as ResearchProject["type"])
      ? value.type as ResearchProject["type"]
      : "literature-review",
    visibility: PROJECT_VISIBILITIES.has(value.visibility as ResearchProject["visibility"])
      ? value.visibility as ResearchProject["visibility"]
      : "private",
    status: PROJECT_STATUSES.has(value.status as ResearchProject["status"])
      ? value.status as ResearchProject["status"]
      : "active",
    paperIds: unique(stringArray(value.paperIds)),
    evidenceNoteIds: unique(stringArray(value.evidenceNoteIds)),
    collectionIds: unique(stringArray(value.collectionIds)),
    sourceConnectionIds: unique(stringArray(value.sourceConnectionIds)),
    createdAt: optionalString(value.createdAt) ?? researchGoal.createdAt,
    updatedAt: optionalString(value.updatedAt) ?? researchGoal.updatedAt,
  };
}

function normalizeInboxEntry(value: unknown): InboxEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  const paper = normalizePaper(value.paper);
  if (!id || !paper) return undefined;

  const updatedAt = optionalString(value.updatedAt) ?? researchGoal.updatedAt;
  return {
    id,
    sourceKind: SOURCE_KINDS.has(value.sourceKind as InboxEntry["sourceKind"])
      ? value.sourceKind as InboxEntry["sourceKind"]
      : "identifier",
    paper,
    provenance: normalizeProvenance(value.provenance, paper, updatedAt),
    status: INBOX_STATUSES.has(value.status as InboxEntry["status"])
      ? value.status as InboxEntry["status"]
      : "awaiting-review",
    duplicateOfPaperId: optionalString(value.duplicateOfPaperId),
    destinationProjectId: optionalString(value.destinationProjectId),
    createdAt: optionalString(value.createdAt) ?? updatedAt,
    updatedAt,
  };
}

function normalizeEvidenceNote(
  value: unknown,
  knownPapers: ReadonlyMap<string, Paper>,
): EvidenceNote | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  const paperId = requiredString(value.paperId);
  const title = requiredString(value.title);
  if (!id || !paperId || !title) return undefined;
  const paper = knownPapers.get(paperId);
  if (!paper) return undefined;
  const updatedAt = optionalString(value.updatedAt) ?? researchGoal.updatedAt;
  const status = NOTE_STATUSES.has(value.status as EvidenceNote["status"])
    ? value.status as EvidenceNote["status"]
    : "captured";
  const revisionValue = isRecord(value.revision) ? value.revision : undefined;
  const revisionRootId = revisionValue ? requiredString(revisionValue.rootId) : undefined;
  const revisionNumber = revisionValue?.number;
  const revisionIsLatest = revisionValue?.isLatest;
  const previousId = revisionValue ? optionalString(revisionValue.previousId) : undefined;
  const nextId = revisionValue ? optionalString(revisionValue.nextId) : undefined;
  const validRevision = Boolean(
    revisionRootId
    && typeof revisionNumber === "number"
    && Number.isSafeInteger(revisionNumber)
    && revisionNumber >= 1
    && typeof revisionIsLatest === "boolean"
    && (revisionNumber !== 1 || (revisionRootId === id && previousId === undefined))
    && (revisionNumber === 1 || previousId !== undefined)
    && (revisionIsLatest ? nextId === undefined : nextId !== undefined),
  );

  return {
    id,
    paperId,
    title,
    kind: NOTE_KINDS.has(value.kind as EvidenceNote["kind"])
      ? value.kind as EvidenceNote["kind"]
      : "interpretation",
    claim: typeof value.claim === "string" ? value.claim : "",
    evidence: typeof value.evidence === "string" ? value.evidence : "",
    interpretation: typeof value.interpretation === "string" ? value.interpretation : "",
    openQuestion: optionalString(value.openQuestion),
    confidence: CONFIDENCE_LEVELS.has(value.confidence as EvidenceNote["confidence"])
      ? value.confidence as EvidenceNote["confidence"]
      : "low",
    status,
    provenance: normalizeProvenance(value.provenance, paper, updatedAt),
    linkedHighlightIds: unique(stringArray(value.linkedHighlightIds)),
    collectionIds: unique(stringArray(value.collectionIds)),
    tags: unique(stringArray(value.tags)),
    revision: validRevision
      ? {
          rootId: revisionRootId!,
          previousId,
          nextId,
          number: revisionNumber as number,
          isLatest: revisionIsLatest as boolean,
        }
      : { rootId: id, number: 1, isLatest: true },
    reviewedAt: status === "verified"
      ? optionalString(value.reviewedAt) ?? updatedAt
      : undefined,
    createdAt: optionalString(value.createdAt) ?? updatedAt,
    updatedAt,
  };
}

function normalizeCollection(value: unknown): Collection | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredString(value.id);
  const name = requiredString(value.name);
  if (!id || !name) return undefined;

  return {
    id,
    name,
    description: typeof value.description === "string" ? value.description : "",
    color: COLLECTION_COLORS.has(value.color as Collection["color"])
      ? value.color as Collection["color"]
      : "slate",
    paperIds: unique(stringArray(value.paperIds)),
    noteIds: unique(stringArray(value.noteIds)),
    evidenceClaimCount: Math.max(0, finiteNumber(value.evidenceClaimCount, 0)),
    openQuestionCount: Math.max(0, finiteNumber(value.openQuestionCount, 0)),
    updatedAt: optionalString(value.updatedAt) ?? researchGoal.updatedAt,
  };
}

function normalizeArray<T>(
  value: unknown,
  normalizer: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map(normalizer);
  return normalized.some((item) => !item) ? undefined : normalized as T[];
}

export function loadWorkspaceSnapshot(storage: WorkspaceStorageReader): WorkspaceSnapshot {
  const initial = createInitialWorkspaceSnapshot();
  try {
    const serialized = storage.getItem(WORKSPACE_STORAGE_KEY)
      ?? LEGACY_WORKSPACE_STORAGE_KEYS
        .map((key) => storage.getItem(key))
        .find((candidate): candidate is string => Boolean(candidate));
    if (!serialized) return initial;
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) return initial;
    if (
      "version" in parsed
      && (typeof parsed.version !== "number" || parsed.version > 3)
    ) {
      return initial;
    }

    const projects = "projects" in parsed
      ? normalizeArray(parsed.projects, normalizeProject)
      : initial.projects;
    const inboxEntries = "inboxEntries" in parsed
      ? normalizeArray(parsed.inboxEntries, normalizeInboxEntry)
      : initial.inboxEntries;
    const importedPapers = "importedPapers" in parsed
      ? normalizeArray(parsed.importedPapers, normalizePaper)
      : initial.importedPapers;
    if (!projects || !inboxEntries || !importedPapers) return initial;

    const knownPapers = new Map<string, Paper>();
    papers.forEach((paper) => knownPapers.set(paper.id, paper));
    importedPapers.forEach((paper) => knownPapers.set(paper.id, paper));
    inboxEntries.forEach((entry) => knownPapers.set(entry.paper.id, entry.paper));
    const notes = "notes" in parsed
      ? normalizeArray(parsed.notes, (value) => normalizeEvidenceNote(value, knownPapers))
      : initial.notes;
    const normalizedCollections = "collections" in parsed
      ? normalizeArray(parsed.collections, normalizeCollection)
      : initial.collections;

    if (!notes || !normalizedCollections) return initial;
    const requestedActiveProjectId = optionalString(parsed.activeProjectId);
    const activeProjectId = projects.some((project) => project.id === requestedActiveProjectId)
      ? requestedActiveProjectId ?? ""
      : projects[0]?.id ?? "";

    return cloneSnapshot({
      version: 3,
      projects,
      inboxEntries,
      importedPapers,
      notes,
      collections: normalizedCollections,
      activeProjectId,
    });
  } catch {
    return initial;
  }
}

export function saveWorkspaceSnapshot(
  storage: WorkspaceStorageWriter,
  snapshot: WorkspaceSnapshot,
): void {
  storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(cloneSnapshot(snapshot)));
}

function normalizeDoi(value: string): string {
  let normalized = value.trim().toLocaleLowerCase();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original text when a provider returns malformed URL encoding.
  }
  return normalized
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .replace(/\s+/g, "")
    .replace(/[.,;]+$/, "");
}

function identifierKey(identifier: PaperIdentifier): string | undefined {
  const value = identifier.value.trim().toLocaleLowerCase();
  if (!value || (identifier.scheme !== "doi" && identifier.scheme !== "provider")) {
    return undefined;
  }
  if (identifier.scheme === "doi") return `doi:${normalizeDoi(value)}`;
  return `provider:${value.replace(/\/$/, "")}`;
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function findPaperDuplicate(
  candidate: Paper,
  existingPapers: readonly Paper[],
): Paper | undefined {
  const candidateIdentifiers = new Set(
    candidate.identifiers
      .map(identifierKey)
      .filter((key): key is string => Boolean(key)),
  );

  if (candidateIdentifiers.size) {
    const identifierMatch = existingPapers.find((paper) =>
      paper.identifiers.some((identifier) => {
        const key = identifierKey(identifier);
        return key ? candidateIdentifiers.has(key) : false;
      }));
    if (identifierMatch) return identifierMatch;
  }

  const candidateTitle = normalizeTitle(candidate.title);
  if (!candidateTitle) return undefined;
  return existingPapers.find((paper) => normalizeTitle(paper.title) === candidateTitle);
}

export function makeId(prefix: string): string {
  const safePrefix = prefix
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
  const randomPart = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${safePrefix}-${randomPart}`;
}
