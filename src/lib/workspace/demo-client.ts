import { papers as demoPapers } from "../data";
import type {
  Collection,
  EvidenceNote,
  InboxEntry,
  Paper,
  ResearchProject,
} from "../types";
import {
  WORKSPACE_STORAGE_KEY,
  findPaperDuplicate,
  loadWorkspaceSnapshot,
  makeId,
  saveWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "../workspace-store";
import type {
  AddNoteToCollectionCommand,
  AddNoteToCollectionResult,
  AddPaperToCollectionCommand,
  AddPaperToCollectionResult,
  CreateEvidenceNoteCommand,
  CreateEvidenceNoteResult,
  CreateCollectionCommand,
  CreateCollectionResult,
  CreateProjectCommand,
  CreateProjectResult,
  FileImportCommand,
  FileImportResult,
  GetWorkspaceProjectQuery,
  StageImportCommand,
  StageImportResult,
  WorkspaceBootstrapDto,
  WorkspaceClient,
  WorkspaceCommandEnvelope,
  WorkspaceCommandFailure,
  WorkspaceCommandFailureCode,
  WorkspaceCommandResult,
  WorkspaceProjectDto,
} from "./contracts";

export const DEMO_WORKSPACE_CLIENT_METADATA_KEY = "paperpilot:workspace-client:v1";

const MAX_OPERATION_RECEIPTS = 100;
const PROJECT_TYPES = new Set<ResearchProject["type"]>([
  "evidence-map",
  "literature-review",
  "systematic-review",
]);
const PROJECT_VISIBILITIES = new Set<ResearchProject["visibility"]>([
  "private",
  "workspace",
]);
const COLLECTION_COLORS = new Set<Collection["color"]>([
  "blue",
  "amber",
  "slate",
  "teal",
]);
const IMPORT_SOURCE_KINDS = new Set<InboxEntry["sourceKind"]>([
  "discover",
  "zotero",
  "upload",
  "crawler",
  "identifier",
]);

export interface DemoWorkspaceStorage extends Pick<Storage, "getItem" | "setItem"> {
  removeItem?(key: string): void;
}

export interface DemoWorkspaceClientOptions {
  now?: () => string;
  idFactory?: (prefix: string) => string;
  workspaceId?: string;
  workspaceName?: string;
}

interface StoredOperationReceipt {
  clientOperationId: string;
  commandName: string;
  commandFingerprint: string;
  aggregateVersion: number;
  originalOutcome: "applied" | "noop";
  data: unknown;
}

interface DemoWorkspaceMetadata {
  version: 1;
  aggregateVersion: number;
  snapshotFingerprint: string;
  receipts: StoredOperationReceipt[];
}

interface WorkspaceState {
  snapshot: WorkspaceSnapshot;
  metadata: DemoWorkspaceMetadata;
}

interface Mutation<T> {
  changed: boolean;
  data: T;
}

class WorkspaceMutationError extends Error {
  constructor(
    readonly code: WorkspaceCommandFailureCode,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const nextValue = value[key];
      if (nextValue !== undefined) result[key] = stableValue(nextValue);
      return result;
    }, {});
}

function compactHash(value: unknown): string {
  const serialized = JSON.stringify(stableValue(value));
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `v1:${serialized.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

function parseMetadata(serialized: string | null): DemoWorkspaceMetadata | undefined {
  if (!serialized) return undefined;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || !Number.isSafeInteger(parsed.aggregateVersion)
      || (parsed.aggregateVersion as number) < 0
      || typeof parsed.snapshotFingerprint !== "string"
      || !Array.isArray(parsed.receipts)
    ) {
      return undefined;
    }

    const receipts: StoredOperationReceipt[] = [];
    for (const candidate of parsed.receipts) {
      if (
        !isRecord(candidate)
        || typeof candidate.clientOperationId !== "string"
        || typeof candidate.commandName !== "string"
        || typeof candidate.commandFingerprint !== "string"
        || !Number.isSafeInteger(candidate.aggregateVersion)
        || (candidate.aggregateVersion as number) < 0
        || (candidate.originalOutcome !== "applied" && candidate.originalOutcome !== "noop")
        || !("data" in candidate)
      ) {
        return undefined;
      }
      receipts.push({
        clientOperationId: candidate.clientOperationId,
        commandName: candidate.commandName,
        commandFingerprint: candidate.commandFingerprint,
        aggregateVersion: candidate.aggregateVersion as number,
        originalOutcome: candidate.originalOutcome,
        data: candidate.data,
      });
    }

    return {
      version: 1,
      aggregateVersion: parsed.aggregateVersion as number,
      snapshotFingerprint: parsed.snapshotFingerprint,
      receipts: receipts.slice(-MAX_OPERATION_RECEIPTS),
    };
  } catch {
    return undefined;
  }
}

function resolvedPapers(snapshot: WorkspaceSnapshot): Paper[] {
  const byId = new Map<string, Paper>();
  demoPapers.forEach((paper) => byId.set(paper.id, paper));
  snapshot.importedPapers.forEach((paper) => byId.set(paper.id, paper));
  snapshot.inboxEntries.forEach((entry) => {
    if (!byId.has(entry.paper.id)) byId.set(entry.paper.id, entry.paper);
  });
  return [...byId.values()];
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new WorkspaceMutationError("validation", `${label} is required.`);
  return normalized;
}

function failure(
  code: WorkspaceCommandFailureCode,
  aggregateVersion: number,
  message: string,
): WorkspaceCommandFailure {
  return { ok: false, code, aggregateVersion, message };
}

/**
 * Async adapter for the current browser demo.
 *
 * It intentionally exposes the same command surface a future HTTP client can
 * implement. Mutations write one complete v3 snapshot, and a small sidecar
 * stores optimistic-concurrency state plus bounded idempotency receipts.
 */
export class DemoWorkspaceClient implements WorkspaceClient {
  private readonly now: () => string;
  private readonly idFactory: (prefix: string) => string;
  private readonly workspaceId: string;
  private readonly workspaceName: string;

  constructor(
    private readonly storage: DemoWorkspaceStorage,
    options: DemoWorkspaceClientOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? makeId;
    this.workspaceId = options.workspaceId ?? "workspace-demo-local";
    this.workspaceName = options.workspaceName ?? "PaperPilot local workspace";
  }

  async bootstrap(): Promise<WorkspaceBootstrapDto> {
    const { snapshot, metadata } = this.readState();
    return cloneValue({
      schemaVersion: 3,
      aggregateVersion: metadata.aggregateVersion,
      workspace: {
        id: this.workspaceId,
        name: this.workspaceName,
        mode: "demo",
        role: "owner",
      },
      activeProjectId: snapshot.activeProjectId || null,
      projects: snapshot.projects,
      inboxEntries: snapshot.inboxEntries,
      papers: resolvedPapers(snapshot),
      notes: snapshot.notes,
      collections: snapshot.collections,
    });
  }

  async getProject(query: GetWorkspaceProjectQuery): Promise<WorkspaceProjectDto | null> {
    const { snapshot, metadata } = this.readState();
    const project = snapshot.projects.find((candidate) => candidate.id === query.projectId);
    if (!project) return null;

    const paperIds = new Set(project.paperIds);
    const noteIds = new Set(project.evidenceNoteIds);
    const collectionIds = new Set(project.collectionIds);
    return cloneValue({
      aggregateVersion: metadata.aggregateVersion,
      project,
      papers: resolvedPapers(snapshot).filter((paper) => paperIds.has(paper.id)),
      notes: snapshot.notes.filter((note) => noteIds.has(note.id)),
      collections: snapshot.collections.filter((collection) => collectionIds.has(collection.id)),
    });
  }

  async createProject(
    command: CreateProjectCommand,
  ): Promise<WorkspaceCommandResult<CreateProjectResult>> {
    return this.runCommand(
      "createProject",
      command,
      { project: command.project },
      (snapshot) => {
        const name = requireText(command.project.name, "Project name");
        const question = requireText(command.project.question, "Research question");
        if (!PROJECT_TYPES.has(command.project.type)) {
          throw new WorkspaceMutationError("validation", "Project type is invalid.");
        }
        if (!PROJECT_VISIBILITIES.has(command.project.visibility)) {
          throw new WorkspaceMutationError("validation", "Project visibility is invalid.");
        }
        if (snapshot.projects.some((project) => project.name.trim().toLowerCase() === name.toLowerCase())) {
          throw new WorkspaceMutationError("duplicate", "A project with that name already exists.");
        }

        const timestamp = this.now();
        const project: ResearchProject = {
          id: this.idFactory("project"),
          name,
          question,
          description: command.project.description?.trim()
            || "Created in PaperPilot. Add sources and papers to refine this project scope.",
          type: command.project.type,
          visibility: command.project.visibility,
          status: "active",
          paperIds: [],
          evidenceNoteIds: [],
          collectionIds: [],
          sourceConnectionIds: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        snapshot.projects = [project, ...snapshot.projects];
        snapshot.activeProjectId = project.id;
        return {
          changed: true,
          data: { project, activeProjectId: project.id },
        };
      },
    );
  }

  async createCollection(
    command: CreateCollectionCommand,
  ): Promise<WorkspaceCommandResult<CreateCollectionResult>> {
    return this.runCommand(
      "createCollection",
      command,
      {
        projectId: command.projectId,
        name: command.name,
        description: command.description,
        color: command.color,
      },
      (snapshot) => {
        const projectId = requireText(command.projectId, "Project id");
        const name = requireText(command.name, "Collection name");
        const projectIndex = snapshot.projects.findIndex((project) => project.id === projectId);
        if (projectIndex < 0) {
          throw new WorkspaceMutationError("not_found", "Destination project was not found.");
        }
        if (!COLLECTION_COLORS.has(command.color)) {
          throw new WorkspaceMutationError("validation", "Collection color is invalid.");
        }
        const duplicate = snapshot.collections.some((collection) =>
          snapshot.projects[projectIndex].collectionIds.includes(collection.id)
          && collection.name.trim().toLowerCase() === name.toLowerCase()
        );
        if (duplicate) {
          throw new WorkspaceMutationError(
            "duplicate",
            "A collection with that name already exists in this project.",
          );
        }

        const timestamp = this.now();
        const collection: Collection = {
          id: this.idFactory("collection"),
          name,
          description: command.description.trim(),
          color: command.color,
          paperIds: [],
          noteIds: [],
          evidenceClaimCount: 0,
          openQuestionCount: 0,
          updatedAt: timestamp,
        };
        snapshot.collections = [collection, ...snapshot.collections];
        snapshot.projects[projectIndex] = {
          ...snapshot.projects[projectIndex],
          collectionIds: [collection.id, ...snapshot.projects[projectIndex].collectionIds],
          updatedAt: timestamp,
        };
        return { changed: true, data: { collection, projectId } };
      },
    );
  }

  async stageImport(
    command: StageImportCommand,
  ): Promise<WorkspaceCommandResult<StageImportResult>> {
    return this.runCommand(
      "stageImport",
      command,
      {
        sourceKind: command.sourceKind,
        paper: command.paper,
        provenance: command.provenance,
      },
      (snapshot) => {
        if (!IMPORT_SOURCE_KINDS.has(command.sourceKind)) {
          throw new WorkspaceMutationError("validation", "Import source kind is invalid.");
        }
        requireText(command.paper.id, "Paper id");
        requireText(command.paper.title, "Paper title");
        requireText(command.provenance.sourceId, "Provenance source id");
        requireText(command.provenance.providerName, "Provenance provider");

        const existing = snapshot.inboxEntries.find((entry) =>
          entry.provenance.providerName === command.provenance.providerName
          && entry.provenance.sourceId === command.provenance.sourceId,
        );
        if (existing) {
          return {
            changed: false,
            data: {
              inboxEntry: existing,
              duplicatePaperId: existing.duplicateOfPaperId,
            },
          };
        }

        const duplicate = findPaperDuplicate(command.paper, [
          ...demoPapers,
          ...snapshot.importedPapers,
        ]);
        const timestamp = this.now();
        const inboxEntry: InboxEntry = {
          id: this.idFactory("inbox"),
          sourceKind: command.sourceKind,
          paper: cloneValue(command.paper),
          provenance: cloneValue(command.provenance),
          status: duplicate ? "possible-duplicate" : "awaiting-review",
          duplicateOfPaperId: duplicate?.id,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        snapshot.inboxEntries = [inboxEntry, ...snapshot.inboxEntries];
        return {
          changed: true,
          data: { inboxEntry, duplicatePaperId: duplicate?.id },
        };
      },
    );
  }

  async fileImport(
    command: FileImportCommand,
  ): Promise<WorkspaceCommandResult<FileImportResult>> {
    return this.runCommand(
      "fileImport",
      command,
      { inboxEntryId: command.inboxEntryId, projectId: command.projectId },
      (snapshot) => {
        const entryIndex = snapshot.inboxEntries.findIndex(
          (entry) => entry.id === command.inboxEntryId,
        );
        if (entryIndex < 0) {
          throw new WorkspaceMutationError("not_found", "Inbox entry was not found.");
        }
        const projectIndex = snapshot.projects.findIndex(
          (project) => project.id === command.projectId,
        );
        if (projectIndex < 0) {
          throw new WorkspaceMutationError("not_found", "Destination project was not found.");
        }

        const entry = snapshot.inboxEntries[entryIndex];
        const knownPapers = resolvedPapers(snapshot);
        const canonicalPapers = [...demoPapers, ...snapshot.importedPapers];
        const duplicate = entry.duplicateOfPaperId
          ? knownPapers.find((paper) => paper.id === entry.duplicateOfPaperId)
          : findPaperDuplicate(entry.paper, canonicalPapers);
        const canonicalPaper = duplicate ?? entry.paper;
        const project = snapshot.projects[projectIndex];
        const alreadyImported = snapshot.importedPapers.some(
          (paper) => paper.id === canonicalPaper.id,
        );
        const alreadyFiled = project.paperIds.includes(canonicalPaper.id);
        const entryAlreadyReady = entry.status === "ready"
          && entry.destinationProjectId === project.id;

        if (alreadyImported && alreadyFiled && entryAlreadyReady) {
          return {
            changed: false,
            data: {
              inboxEntry: entry,
              paper: canonicalPaper,
              project,
              usedExistingPaper: Boolean(duplicate),
            },
          };
        }

        const timestamp = this.now();
        if (!alreadyImported) {
          snapshot.importedPapers = [...snapshot.importedPapers, cloneValue(canonicalPaper)];
        }
        const updatedEntry: InboxEntry = {
          ...entry,
          status: "ready",
          duplicateOfPaperId: duplicate?.id,
          destinationProjectId: project.id,
          updatedAt: timestamp,
        };
        const updatedProject: ResearchProject = {
          ...project,
          paperIds: alreadyFiled ? project.paperIds : [...project.paperIds, canonicalPaper.id],
          updatedAt: timestamp,
        };
        snapshot.inboxEntries[entryIndex] = updatedEntry;
        snapshot.projects[projectIndex] = updatedProject;
        snapshot.activeProjectId = updatedProject.id;
        return {
          changed: true,
          data: {
            inboxEntry: updatedEntry,
            paper: canonicalPaper,
            project: updatedProject,
            usedExistingPaper: Boolean(duplicate),
          },
        };
      },
    );
  }

  async createEvidenceNote(
    command: CreateEvidenceNoteCommand,
  ): Promise<WorkspaceCommandResult<CreateEvidenceNoteResult>> {
    return this.runCommand(
      "createEvidenceNote",
      command,
      { note: command.note, projectId: command.projectId },
      (snapshot) => {
        const paper = resolvedPapers(snapshot).find(
          (candidate) => candidate.id === command.note.paperId,
        );
        if (!paper) throw new WorkspaceMutationError("not_found", "Evidence paper was not found.");
        const title = requireText(command.note.title, "Evidence note title");
        requireText(command.note.claim, "Evidence claim");
        if (
          command.note.provenance.locator
          && command.note.provenance.locator.paperId !== command.note.paperId
        ) {
          throw new WorkspaceMutationError(
            "validation",
            "Evidence provenance must point to the note's paper.",
          );
        }

        const requestedCollectionIds = [...new Set(command.note.collectionIds)];
        const missingCollectionId = requestedCollectionIds.find((collectionId) =>
          !snapshot.collections.some((collection) => collection.id === collectionId),
        );
        if (missingCollectionId) {
          throw new WorkspaceMutationError(
            "not_found",
            `Evidence collection ${missingCollectionId} was not found.`,
          );
        }

        let linkedProjects = snapshot.projects.filter((project) =>
          project.paperIds.includes(command.note.paperId),
        );
        if (command.projectId) {
          const requestedProject = snapshot.projects.find(
            (project) => project.id === command.projectId,
          );
          if (!requestedProject) {
            throw new WorkspaceMutationError("not_found", "Evidence project was not found.");
          }
          if (!requestedProject.paperIds.includes(command.note.paperId)) {
            throw new WorkspaceMutationError(
              "validation",
              "The evidence paper must be filed in the destination project first.",
            );
          }
          linkedProjects = [requestedProject];
        }

        const timestamp = this.now();
        const noteId = this.idFactory("note");
        const note: EvidenceNote = {
          ...cloneValue(command.note),
          id: noteId,
          title,
          collectionIds: requestedCollectionIds,
          provenance: {
            ...cloneValue(command.note.provenance),
            id: command.note.provenance.id?.trim() || this.idFactory("provenance"),
            retrievedAt: command.note.provenance.retrievedAt?.trim() || timestamp,
          },
          linkedHighlightIds: [...new Set(command.note.linkedHighlightIds)],
          tags: [...new Set(command.note.tags)],
          revision: { rootId: noteId, number: 1, isLatest: true },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        snapshot.notes = [note, ...snapshot.notes];
        snapshot.collections = snapshot.collections.map((collection) =>
          requestedCollectionIds.includes(collection.id)
            ? this.collectionWithNote(collection, note, timestamp)
            : collection,
        );
        const linkedProjectIds = new Set(linkedProjects.map((project) => project.id));
        snapshot.projects = snapshot.projects.map((project) =>
          linkedProjectIds.has(project.id)
            ? {
                ...project,
                evidenceNoteIds: project.evidenceNoteIds.includes(note.id)
                  ? project.evidenceNoteIds
                  : [note.id, ...project.evidenceNoteIds],
                updatedAt: timestamp,
              }
            : project,
        );
        return {
          changed: true,
          data: {
            note,
            linkedProjectIds: [...linkedProjectIds],
            updatedCollectionIds: requestedCollectionIds,
          },
        };
      },
    );
  }

  async addPaperToCollection(
    command: AddPaperToCollectionCommand,
  ): Promise<WorkspaceCommandResult<AddPaperToCollectionResult>> {
    return this.runCommand(
      "addPaperToCollection",
      command,
      { paperId: command.paperId, collectionId: command.collectionId },
      (snapshot) => {
        const paper = resolvedPapers(snapshot).find((candidate) => candidate.id === command.paperId);
        if (!paper) throw new WorkspaceMutationError("not_found", "Paper was not found.");
        const collectionIndex = snapshot.collections.findIndex(
          (collection) => collection.id === command.collectionId,
        );
        if (collectionIndex < 0) {
          throw new WorkspaceMutationError("not_found", "Collection was not found.");
        }
        const collection = snapshot.collections[collectionIndex];
        if (collection.paperIds.includes(paper.id)) {
          return { changed: false, data: { paper, collection } };
        }

        const updatedCollection: Collection = {
          ...collection,
          paperIds: [...collection.paperIds, paper.id],
          updatedAt: this.now(),
        };
        snapshot.collections[collectionIndex] = updatedCollection;
        return { changed: true, data: { paper, collection: updatedCollection } };
      },
    );
  }

  async addNoteToCollection(
    command: AddNoteToCollectionCommand,
  ): Promise<WorkspaceCommandResult<AddNoteToCollectionResult>> {
    return this.runCommand(
      "addNoteToCollection",
      command,
      { noteId: command.noteId, collectionId: command.collectionId },
      (snapshot) => {
        const noteIndex = snapshot.notes.findIndex((note) => note.id === command.noteId);
        if (noteIndex < 0) throw new WorkspaceMutationError("not_found", "Evidence note was not found.");
        const collectionIndex = snapshot.collections.findIndex(
          (collection) => collection.id === command.collectionId,
        );
        if (collectionIndex < 0) {
          throw new WorkspaceMutationError("not_found", "Collection was not found.");
        }

        const note = snapshot.notes[noteIndex];
        const collection = snapshot.collections[collectionIndex];
        const noteAlreadyLinked = note.collectionIds.includes(collection.id);
        const collectionAlreadyLinked = collection.noteIds.includes(note.id);
        if (noteAlreadyLinked && collectionAlreadyLinked) {
          return { changed: false, data: { note, collection } };
        }

        const timestamp = this.now();
        const updatedNote: EvidenceNote = {
          ...note,
          collectionIds: noteAlreadyLinked
            ? note.collectionIds
            : [...note.collectionIds, collection.id],
          updatedAt: timestamp,
        };
        const updatedCollection = collectionAlreadyLinked
          ? { ...collection, updatedAt: timestamp }
          : this.collectionWithNote(collection, note, timestamp);
        snapshot.notes[noteIndex] = updatedNote;
        snapshot.collections[collectionIndex] = updatedCollection;
        return {
          changed: true,
          data: { note: updatedNote, collection: updatedCollection },
        };
      },
    );
  }

  private collectionWithNote(
    collection: Collection,
    note: EvidenceNote,
    timestamp: string,
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
      updatedAt: timestamp,
    };
  }

  private runCommand<T>(
    commandName: string,
    envelope: WorkspaceCommandEnvelope,
    payload: unknown,
    mutate: (snapshot: WorkspaceSnapshot) => Mutation<T>,
  ): WorkspaceCommandResult<T> {
    const { snapshot, metadata } = this.readState();
    const operationId = envelope.clientOperationId.trim();
    if (!operationId || operationId.length > 200) {
      return failure(
        "validation",
        metadata.aggregateVersion,
        "clientOperationId must contain between 1 and 200 characters.",
      );
    }
    if (!Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 0) {
      return failure(
        "validation",
        metadata.aggregateVersion,
        "expectedVersion must be a non-negative integer.",
      );
    }

    const commandFingerprint = compactHash({ commandName, payload });
    const priorReceipt = metadata.receipts.find(
      (receipt) => receipt.clientOperationId === operationId,
    );
    if (priorReceipt) {
      if (
        priorReceipt.commandName !== commandName
        || priorReceipt.commandFingerprint !== commandFingerprint
      ) {
        return failure(
          "idempotency_conflict",
          metadata.aggregateVersion,
          "clientOperationId was already used for a different command.",
        );
      }
      return {
        ok: true,
        outcome: "replayed",
        // Return the current aggregate version so a late retry cannot move the
        // caller's concurrency token backwards after unrelated commands land.
        aggregateVersion: metadata.aggregateVersion,
        data: cloneValue(priorReceipt.data) as T,
      };
    }

    if (envelope.expectedVersion !== metadata.aggregateVersion) {
      return failure(
        "version_conflict",
        metadata.aggregateVersion,
        "Workspace changed since it was loaded. Refresh and retry with a new expected version.",
      );
    }

    let mutation: Mutation<T>;
    try {
      mutation = mutate(snapshot);
    } catch (error) {
      if (error instanceof WorkspaceMutationError) {
        return failure(error.code, metadata.aggregateVersion, error.message);
      }
      throw error;
    }

    const nextAggregateVersion = mutation.changed
      ? metadata.aggregateVersion + 1
      : metadata.aggregateVersion;
    const receipt: StoredOperationReceipt = {
      clientOperationId: operationId,
      commandName,
      commandFingerprint,
      aggregateVersion: nextAggregateVersion,
      originalOutcome: mutation.changed ? "applied" : "noop",
      data: cloneValue(mutation.data),
    };
    const nextMetadata: DemoWorkspaceMetadata = {
      version: 1,
      aggregateVersion: nextAggregateVersion,
      snapshotFingerprint: compactHash(snapshot),
      receipts: [...metadata.receipts, receipt].slice(-MAX_OPERATION_RECEIPTS),
    };

    if (mutation.changed) {
      this.commitSnapshotAndMetadata(snapshot, nextMetadata);
    } else {
      this.storage.setItem(
        DEMO_WORKSPACE_CLIENT_METADATA_KEY,
        JSON.stringify(nextMetadata),
      );
    }

    return {
      ok: true,
      outcome: mutation.changed ? "applied" : "noop",
      aggregateVersion: nextAggregateVersion,
      data: cloneValue(mutation.data),
    };
  }

  private readState(): WorkspaceState {
    const snapshot = loadWorkspaceSnapshot(this.storage);
    const snapshotFingerprint = compactHash(snapshot);
    const storedMetadata = parseMetadata(
      this.storage.getItem(DEMO_WORKSPACE_CLIENT_METADATA_KEY),
    );
    const metadata: DemoWorkspaceMetadata = !storedMetadata
      ? {
          version: 1,
          aggregateVersion: 0,
          snapshotFingerprint,
          receipts: [],
        }
      : storedMetadata.snapshotFingerprint === snapshotFingerprint
        ? storedMetadata
        : {
            version: 1,
            aggregateVersion: storedMetadata.aggregateVersion + 1,
            snapshotFingerprint,
            receipts: [],
          };

    if (
      !storedMetadata
      || storedMetadata.snapshotFingerprint !== metadata.snapshotFingerprint
    ) {
      this.storage.setItem(
        DEMO_WORKSPACE_CLIENT_METADATA_KEY,
        JSON.stringify(metadata),
      );
    }
    return { snapshot, metadata };
  }

  private commitSnapshotAndMetadata(
    snapshot: WorkspaceSnapshot,
    metadata: DemoWorkspaceMetadata,
  ): void {
    const priorSnapshot = this.storage.getItem(WORKSPACE_STORAGE_KEY);
    const priorMetadata = this.storage.getItem(DEMO_WORKSPACE_CLIENT_METADATA_KEY);
    try {
      saveWorkspaceSnapshot(this.storage, snapshot);
      this.storage.setItem(
        DEMO_WORKSPACE_CLIENT_METADATA_KEY,
        JSON.stringify(metadata),
      );
    } catch (error) {
      this.restoreStorageValue(WORKSPACE_STORAGE_KEY, priorSnapshot);
      this.restoreStorageValue(DEMO_WORKSPACE_CLIENT_METADATA_KEY, priorMetadata);
      throw error;
    }
  }

  private restoreStorageValue(key: string, value: string | null): void {
    try {
      if (value === null && this.storage.removeItem) {
        this.storage.removeItem(key);
      } else if (value !== null) {
        this.storage.setItem(key, value);
      }
    } catch {
      // Preserve the original storage error; rollback is best effort in localStorage.
    }
  }
}

export function createDemoWorkspaceClient(
  storage: DemoWorkspaceStorage,
  options?: DemoWorkspaceClientOptions,
): WorkspaceClient {
  return new DemoWorkspaceClient(storage, options);
}
