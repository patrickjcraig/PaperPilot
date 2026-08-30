import type {
  Collection,
  EvidenceNote,
  Paper,
  ResearchProject,
} from "../types";
import type {
  AddNoteToCollectionResult,
  AddPaperToCollectionResult,
  CreateCollectionResult,
  CreateEvidenceNoteResult,
  CreateEvidenceRevisionResult,
} from "./contracts";

/**
 * The live shell keeps a small client-side projection so a successful command
 * is visible immediately. These helpers deliberately merge server-owned
 * entities by id and make replayed command responses safe to apply again.
 */
export interface WorkspaceUiState {
  aggregateVersion: number;
  projects: ResearchProject[];
  papers: Paper[];
  notes: EvidenceNote[];
  collections: Collection[];
}

function upsertFirst<T extends { id: string }>(items: T[], item: T): T[] {
  return [item, ...items.filter((candidate) => candidate.id !== item.id)];
}

function replaceLogicalHead(
  ids: string[],
  predecessorId: string,
  successorId: string,
): string[] {
  const replaced = ids.map((id) => id === predecessorId ? successorId : id);
  if (!replaced.includes(successorId)) replaced.unshift(successorId);
  return [...new Set(replaced)];
}

function collectionWithNewNote(
  collection: Collection,
  note: EvidenceNote,
): Collection {
  if (collection.noteIds.includes(note.id)) return collection;
  return {
    ...collection,
    noteIds: [note.id, ...collection.noteIds],
    evidenceClaimCount: note.kind === "open-question"
      ? collection.evidenceClaimCount
      : collection.evidenceClaimCount + 1,
    openQuestionCount: note.openQuestion
      ? collection.openQuestionCount + 1
      : collection.openQuestionCount,
    updatedAt: note.updatedAt,
  };
}

export function applyCreatedCollection<T extends WorkspaceUiState>(
  state: T,
  aggregateVersion: number,
  data: CreateCollectionResult,
): T {
  return {
    ...state,
    aggregateVersion,
    collections: upsertFirst(state.collections, data.collection),
    projects: state.projects.map((project) =>
      project.id === data.projectId
        ? {
            ...project,
            collectionIds: project.collectionIds.includes(data.collection.id)
              ? project.collectionIds
              : [data.collection.id, ...project.collectionIds],
            updatedAt: data.collection.updatedAt,
          }
        : project),
  };
}

export function applyCreatedEvidenceNote<T extends WorkspaceUiState>(
  state: T,
  aggregateVersion: number,
  data: CreateEvidenceNoteResult,
): T {
  const updatedCollectionIds = new Set(data.updatedCollectionIds);
  return {
    ...state,
    aggregateVersion,
    notes: upsertFirst(state.notes, data.note),
    collections: state.collections.map((collection) =>
      updatedCollectionIds.has(collection.id)
        ? collectionWithNewNote(collection, data.note)
        : collection),
    projects: state.projects.map((project) =>
      data.linkedProjectIds.includes(project.id)
        ? {
            ...project,
            evidenceNoteIds: project.evidenceNoteIds.includes(data.note.id)
              ? project.evidenceNoteIds
              : [data.note.id, ...project.evidenceNoteIds],
            updatedAt: data.note.updatedAt,
          }
        : project),
  };
}

/**
 * Install one immutable successor without treating it as another logical
 * evidence record. Head indexes advance; collection counts remain stable.
 */
export function applyEvidenceNoteRevision<T extends WorkspaceUiState>(
  state: T,
  aggregateVersion: number,
  data: CreateEvidenceRevisionResult,
): T {
  const knownHead = state.notes.find((note) =>
    note.revision.rootId === data.note.revision.rootId
    && note.revision.isLatest,
  );
  const responseCanAdvanceHead = data.note.revision.isLatest
    && (
      (knownHead?.id === data.predecessorId
        && knownHead.revision.number + 1 === data.note.revision.number)
      || knownHead?.id === data.note.id
    );

  // A response can be serialized while B is the head, delayed in transit, and
  // arrive after a refresh has already installed C. Never let that stale
  // `isLatest` projection create a second head or lower the aggregate. The
  // caller may refresh, but this merge helper remains safe on its own.
  if (data.note.revision.isLatest && !responseCanAdvanceHead) {
    return state;
  }

  const updatedCollectionIds = new Set(data.updatedCollectionIds);
  const predecessor = state.notes.find((note) => note.id === data.predecessorId);
  const predecessorWithSuccessor = predecessor
    ? {
        ...predecessor,
        revision: {
          ...predecessor.revision,
          nextId: data.note.id,
          isLatest: false,
        },
      }
    : undefined;
  const notesWithPredecessor = predecessorWithSuccessor
    ? state.notes.map((note) => note.id === predecessorWithSuccessor.id
        ? predecessorWithSuccessor
        : note)
    : state.notes;

  return {
    ...state,
    aggregateVersion: Math.max(state.aggregateVersion, aggregateVersion),
    notes: upsertFirst(notesWithPredecessor, data.note),
    collections: state.collections.map((collection) =>
      updatedCollectionIds.has(collection.id)
        ? {
            ...collection,
            noteIds: data.note.revision.isLatest
              ? replaceLogicalHead(
                  collection.noteIds,
                  data.predecessorId,
                  data.note.id,
                )
              : collection.noteIds,
            updatedAt: data.note.revision.isLatest
              ? data.note.updatedAt
              : collection.updatedAt,
          }
        : collection),
    projects: state.projects.map((project) =>
      data.linkedProjectIds.includes(project.id)
        ? {
            ...project,
            evidenceNoteIds: data.note.revision.isLatest
              ? replaceLogicalHead(
                  project.evidenceNoteIds,
                  data.predecessorId,
                  data.note.id,
                )
              : project.evidenceNoteIds,
            updatedAt: data.note.revision.isLatest
              ? data.note.updatedAt
              : project.updatedAt,
          }
        : project),
  };
}

/** A non-head replay cannot reveal its unknown latest successor by inference. */
export function evidenceRevisionNeedsRefresh<T extends WorkspaceUiState>(
  state: T,
  data: CreateEvidenceRevisionResult,
): boolean {
  const knownHead = state.notes.find((note) =>
    note.revision.rootId === data.note.revision.rootId
    && note.revision.isLatest,
  );
  if (data.note.revision.isLatest) {
    if (!knownHead) return true;
    const directAdvance = knownHead.id === data.predecessorId
      && knownHead.revision.number + 1 === data.note.revision.number;
    const alreadyInstalled = knownHead.id === data.note.id
      && knownHead.revision.number === data.note.revision.number;
    if (!directAdvance && !alreadyInstalled) return true;

    const projectsCanAdvance = data.linkedProjectIds.every((projectId) => {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      return project?.evidenceNoteIds.includes(data.predecessorId)
        || project?.evidenceNoteIds.includes(data.note.id);
    });
    const collectionsCanAdvance = data.updatedCollectionIds.every((collectionId) => {
      const collection = state.collections.find((candidate) => candidate.id === collectionId);
      return collection?.noteIds.includes(data.predecessorId)
        || collection?.noteIds.includes(data.note.id);
    });
    return !projectsCanAdvance || !collectionsCanAdvance;
  }
  if (!knownHead || knownHead.revision.number <= data.note.revision.number) return true;
  const projectsCurrent = data.linkedProjectIds.every((projectId) =>
    state.projects.find((project) => project.id === projectId)
      ?.evidenceNoteIds.includes(knownHead.id),
  );
  const collectionsCurrent = data.updatedCollectionIds.every((collectionId) =>
    state.collections.find((collection) => collection.id === collectionId)
      ?.noteIds.includes(knownHead.id),
  );
  return !projectsCurrent || !collectionsCurrent;
}

export function applyPaperCollectionLink<T extends WorkspaceUiState>(
  state: T,
  aggregateVersion: number,
  data: AddPaperToCollectionResult,
): T {
  return {
    ...state,
    aggregateVersion,
    papers: upsertFirst(state.papers, data.paper),
    collections: upsertFirst(state.collections, data.collection),
  };
}

export function applyNoteCollectionLink<T extends WorkspaceUiState>(
  state: T,
  aggregateVersion: number,
  data: AddNoteToCollectionResult,
): T {
  return {
    ...state,
    aggregateVersion,
    notes: upsertFirst(state.notes, data.note),
    collections: upsertFirst(state.collections, data.collection),
  };
}
