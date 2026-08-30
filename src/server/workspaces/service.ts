import "server-only";

import { createHash } from "node:crypto";
import type {
  Collection,
  EvidenceNote,
  EvidenceNoteRevision,
  Paper,
  PaperIdentifier,
  PaperType,
  ResearchProject,
} from "@/lib/types";
import type {
  CreateProjectCommand,
  CreateProjectResult,
  WorkspaceBootstrapDto,
  WorkspaceCommandResult,
  WorkspaceProjectDto,
} from "@/lib/workspace";
import type {
  EvidenceNote as DatabaseEvidenceNote,
  Paper as DatabasePaper,
  PaperAuthor,
  PaperIdentifier as DatabasePaperIdentifier,
  Prisma,
  Project,
  ProjectPaper,
  WorkspacePaper,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getDocumentExtractionLifecycles,
  type DocumentExtractionLifecycle,
} from "@/server/documents/extraction-authority";
import { HttpProblem } from "@/server/http/problem";
import {
  requireWorkspaceMembership,
  resolveWorkspaceMembership,
} from "./authorization";
import {
  documentUploadStage,
  inboxEntryDto,
  inboxReaderAuthorityFromLifecycle,
  type InboxReaderAuthority,
} from "./import-dto";
import { acquireWorkspaceMembershipAuthorityShared } from "./membership-lock";
import {
  evidenceVisibleTo,
  inboxEntryVisibleTo,
  projectVisibleTo,
  requireWorkspaceMutationRole,
} from "./project-access";

const PROJECT_TYPE_TO_DATABASE = {
  "evidence-map": "EVIDENCE_MAP",
  "literature-review": "LITERATURE_REVIEW",
  "systematic-review": "SYSTEMATIC_REVIEW",
} as const;

const PROJECT_TYPE_FROM_DATABASE = {
  EVIDENCE_MAP: "evidence-map",
  LITERATURE_REVIEW: "literature-review",
  SYSTEMATIC_REVIEW: "systematic-review",
} as const;

const PROJECT_VISIBILITY_TO_DATABASE = {
  private: "PRIVATE",
  workspace: "WORKSPACE",
} as const;

const PROJECT_VISIBILITY_FROM_DATABASE = {
  PRIVATE: "private",
  WORKSPACE: "workspace",
} as const;

export type ProjectWithRelations = Project & {
  papers: (ProjectPaper & { workspacePaper: Pick<WorkspacePaper, "paperId"> })[];
  evidenceNotes: EvidenceRevisionNode[];
  evidenceMemberships: {
    evidenceNoteId: string;
    evidenceNote: EvidenceRevisionNode;
  }[];
  collections: { id: string }[];
};

export type PaperWithRelations = DatabasePaper & {
  authors: PaperAuthor[];
  identifiers: DatabasePaperIdentifier[];
};

export type EvidenceNoteWithRelations = Prisma.EvidenceNoteGetPayload<{
  include: {
    workspacePaper: { select: { paperId: true } };
    provenanceRecords: true;
    collectionMemberships: { select: { collectionId: true } };
    projectMemberships: {
      include: {
        project: { select: { visibility: true; createdById: true } };
      };
    };
    project: { select: { visibility: true; createdById: true } };
    textAnchor: true;
  };
}>;

interface SessionUser {
  id: string;
  name: string;
}

export type EvidenceRevisionNode = Pick<DatabaseEvidenceNote, "id" | "supersedesId">;

/**
 * Derive immutable lineage from a bounded set of already-authorized rows.
 * Missing predecessors intentionally start a new visible root: the read model
 * never fetches or exposes an inaccessible private note merely to complete a
 * chain. Callers that need the globally exact root (for command responses)
 * must pass every authorized node from that chain.
 */
export function deriveEvidenceRevisionLineage(
  nodes: readonly EvidenceRevisionNode[],
): ReadonlyMap<string, EvidenceNoteRevision> {
  const byId = new Map<string, EvidenceRevisionNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new Error(`Duplicate evidence revision node: ${node.id}`);
    }
    byId.set(node.id, node);
  }

  const successorByPredecessor = new Map<string, string>();
  for (const node of nodes) {
    if (!node.supersedesId || !byId.has(node.supersedesId)) continue;
    if (successorByPredecessor.has(node.supersedesId)) {
      throw new Error(`Evidence revision chain branches at: ${node.supersedesId}`);
    }
    successorByPredecessor.set(node.supersedesId, node.id);
  }

  const result = new Map<string, EvidenceNoteRevision>();
  const visibleRoots = nodes.filter(
    (node) => !node.supersedesId || !byId.has(node.supersedesId),
  );
  for (const root of visibleRoots) {
    let current: EvidenceRevisionNode | undefined = root;
    let number = 1;
    while (current && !result.has(current.id)) {
      const previousId = current.supersedesId && byId.has(current.supersedesId)
        ? current.supersedesId
        : undefined;
      const nextId = successorByPredecessor.get(current.id);
      result.set(current.id, {
        rootId: root.id,
        ...(previousId ? { previousId } : {}),
        ...(nextId ? { nextId } : {}),
        number,
        isLatest: nextId === undefined,
      });
      current = nextId ? byId.get(nextId) : undefined;
      number += 1;
    }
  }

  // Insert-only database constraints make cycles unreachable. Fail loudly if
  // imported or test data violates that invariant instead of publishing a
  // plausible but false logical identity.
  if (result.size !== byId.size) {
    throw new Error("Evidence revision lineage contains a cycle or disconnected successor graph.");
  }
  return result;
}

/** Safe only for a root row that was just inserted in the current transaction. */
export function standaloneEvidenceRevision(id: string): EvidenceNoteRevision {
  return { rootId: id, number: 1, isLatest: true };
}

function latestRevisionIds(nodes: readonly EvidenceRevisionNode[]): Set<string> {
  return new Set(
    [...deriveEvidenceRevisionLineage(nodes).entries()]
      .filter(([, revision]) => revision.isLatest)
      .map(([id]) => id),
  );
}

export function projectDto(project: ProjectWithRelations): ResearchProject {
  const evidenceNodes = [
    ...new Map([
      ...project.evidenceMemberships.map((membership) => [
        membership.evidenceNoteId,
        membership.evidenceNote,
      ] as const),
      ...project.evidenceNotes.map((note) => [note.id, note] as const),
    ]).values(),
  ];
  const headIds = latestRevisionIds(evidenceNodes);
  const evidenceNoteIds = evidenceNodes
    .map((note) => note.id)
    .filter((id) => headIds.has(id));
  return {
    id: project.id,
    name: project.name,
    question: project.researchQuestion ?? "",
    description: project.description ?? "",
    type: PROJECT_TYPE_FROM_DATABASE[project.type],
    visibility: PROJECT_VISIBILITY_FROM_DATABASE[project.visibility],
    status: project.status === "ARCHIVED" ? "archived" : "active",
    paperIds: project.papers.map((entry) => entry.workspacePaper.paperId),
    evidenceNoteIds,
    collectionIds: project.collections.map((collection) => collection.id),
    sourceConnectionIds: [],
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function paperType(value: string | null): PaperType {
  const normalized = value?.toLowerCase();
  if (normalized === "conference paper") return "conference paper";
  if (normalized === "review") return "review";
  if (normalized === "methods paper") return "methods paper";
  if (normalized === "application study") return "application study";
  return "journal article";
}

function paperIdentifier(identifier: DatabasePaperIdentifier): PaperIdentifier {
  switch (identifier.type) {
    case "DOI":
      return { scheme: "doi", value: identifier.value };
    case "ARXIV":
      return { scheme: "arxiv", value: identifier.value };
    case "ISBN":
      return { scheme: "isbn", value: identifier.value };
    default:
      return { scheme: "provider", value: `${identifier.type.toLowerCase()}:${identifier.value}` };
  }
}

export function paperDto(paper: PaperWithRelations): Paper {
  const abstract = paper.abstractText ?? "";
  const sourceUrl = paper.identifiers.find((identifier) => identifier.type === "URL")?.value;
  return {
    id: paper.id,
    title: paper.title,
    shortTitle: paper.title.length > 78 ? `${paper.title.slice(0, 75)}…` : paper.title,
    authors: [...paper.authors]
      .sort((left, right) => left.position - right.position)
      .map((author) => author.displayName),
    year: paper.publicationYear ?? 0,
    venue: paper.venueName ?? "Venue unavailable",
    type: paperType(paper.workType),
    abstract,
    abstractSnippet: abstract.length > 320 ? `${abstract.slice(0, 317)}…` : abstract,
    whyRead: "Saved to this workspace with source provenance.",
    relevanceScore: 0,
    relevanceTags: [],
    evidenceStrength: "unassessed",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 15,
    citationCount: paper.citationCount ?? undefined,
    identifiers: paper.identifiers.map(paperIdentifier),
    sourceUrl,
    isRetracted: paper.isRetracted,
    isDemoRecord: false,
  };
}

const EVIDENCE_SOURCE_TYPES = new Set([
  "paper", "figure", "citation-library", "note-system", "evidence-store",
  "literature-index", "uploaded-file", "web-source",
]);
const EVIDENCE_ACCESS_METHODS = new Set([
  "seeded-demo", "manual", "api", "upload", "oauth", "crawler", "mcp", "webmcp",
]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string =>
    typeof entry === "string" && entry.length > 0 && entry.length <= 200,
  ))];
}

function evidenceKind(kind: DatabaseEvidenceNote["kind"]): EvidenceNote["kind"] {
  if (kind === "QUESTION") return "open-question";
  if (kind === "QUOTE" || kind === "RESULT") return "direct-evidence";
  return "interpretation";
}

function evidenceStatus(
  status: DatabaseEvidenceNote["status"],
): EvidenceNote["status"] | undefined {
  if (status === "CAPTURED") return "captured";
  if (status === "NEEDS_VERIFICATION") return "needs-verification";
  if (status === "VERIFIED") return "verified";
  return undefined;
}

/**
 * Map only genuinely structured evidence rows. Legacy flattened records stay
 * out of the live claim layer until an explicit migration can classify them.
 */
export function evidenceNoteDto(
  note: EvidenceNoteWithRelations,
  context: {
    revision: EvidenceNoteRevision;
    sourceAuthority?: DocumentExtractionLifecycle;
  },
): EvidenceNote | null {
  const status = evidenceStatus(note.status);
  if (
    !status
    || !note.title
    || note.claim === null
    || note.evidence === null
    || note.interpretation === null
    || (status === "verified") !== (note.verifiedAt !== null)
    || (note.textAnchor !== null && note.textAnchor.schemaVersion !== 1)
  ) {
    return null;
  }
  const provenanceRecord = note.provenanceRecords.find(
    (record) => record.kind === "USER_ASSERTION",
  );
  const payload = recordValue(provenanceRecord?.payload);
  const payloadProvenance = recordValue(payload?.provenance);
  const sourceType = payloadProvenance?.sourceType;
  const accessMethod = payloadProvenance?.accessMethod;
  const sourceTitle = payloadProvenance?.sourceTitle;
  if (
    !provenanceRecord
    || !payloadProvenance
    || typeof sourceType !== "string"
    || !EVIDENCE_SOURCE_TYPES.has(sourceType)
    || typeof accessMethod !== "string"
    || !EVIDENCE_ACCESS_METHODS.has(accessMethod)
    || typeof sourceTitle !== "string"
    || sourceTitle.length < 1
  ) {
    return null;
  }

  const locator = {
    paperId: note.workspacePaper.paperId,
    sectionId: note.sectionId ?? undefined,
    sectionTitle: note.sectionTitle ?? undefined,
    page: note.pageStart && (!note.pageEnd || note.pageEnd === note.pageStart)
      ? note.pageStart
      : undefined,
    pageRange: note.pageStart && note.pageEnd && note.pageEnd !== note.pageStart
      ? [note.pageStart, note.pageEnd] as [number, number]
      : undefined,
    paragraphId: note.paragraphId ?? undefined,
    figureId: note.figureId ?? undefined,
    figureLabel: note.figureLabel ?? undefined,
  };
  const sourceId = provenanceRecord.sourceRecordId
    ?? (typeof payloadProvenance.sourceId === "string" ? payloadProvenance.sourceId : undefined);
  const providerName = provenanceRecord.sourceProvider
    ?? (typeof payloadProvenance.providerName === "string" ? payloadProvenance.providerName : undefined);
  if (!sourceId || !providerName) return null;

  const grounding = note.textAnchor
    ? {
      schemaVersion: 1 as const,
      state: !context.sourceAuthority?.extractionId
        ? "unresolvable" as const
        : context.sourceAuthority.extractionId === note.textAnchor.extractionId
          && context.sourceAuthority.manifestSha256 === note.textAnchor.manifestSha256
          ? "current" as const
          : context.sourceAuthority.extractionId === note.textAnchor.extractionId
            ? "unresolvable" as const
            : "superseded" as const,
      documentId: note.textAnchor.documentId,
      extractionId: note.textAnchor.extractionId,
      manifestSha256: note.textAnchor.manifestSha256,
      start: {
        chunkId: note.textAnchor.startChunkId,
        sequence: note.textAnchor.startSequence,
        byteOffset: note.textAnchor.startByteOffset,
        contentHash: note.textAnchor.startContentHash,
      },
      end: {
        chunkId: note.textAnchor.endChunkId,
        sequence: note.textAnchor.endSequence,
        byteOffset: note.textAnchor.endByteOffset,
        contentHash: note.textAnchor.endContentHash,
      },
      quoteSha256: note.textAnchor.quoteSha256,
      pageStart: note.textAnchor.pageStart,
      pageEnd: note.textAnchor.pageEnd,
      paragraphStartId: note.textAnchor.paragraphStartId,
      paragraphEndId: note.textAnchor.paragraphEndId,
    }
    : undefined;

  return {
    id: note.id,
    paperId: note.workspacePaper.paperId,
    title: note.title,
    kind: evidenceKind(note.kind),
    claim: note.claim,
    evidence: note.evidence,
    interpretation: note.interpretation,
    openQuestion: note.openQuestion ?? undefined,
    confidence: note.confidence === "HIGH"
      ? "high"
      : note.confidence === "LOW"
        ? "low"
        : note.confidence === "UNSPECIFIED"
          ? "unspecified"
          : "medium",
    status,
    provenance: {
      id: provenanceRecord.id,
      sourceType: sourceType as EvidenceNote["provenance"]["sourceType"],
      sourceId,
      sourceTitle,
      sourceUrl: provenanceRecord.sourceUri ?? undefined,
      providerName,
      retrievedAt: (provenanceRecord.retrievedAt ?? provenanceRecord.createdAt).toISOString(),
      accessMethod: accessMethod as EvidenceNote["provenance"]["accessMethod"],
      locator,
      excerpt: note.evidence,
      version: typeof payloadProvenance.version === "string"
        ? payloadProvenance.version
        : undefined,
    },
    linkedHighlightIds: jsonStringArray(note.linkedHighlightIds),
    collectionIds: note.collectionMemberships.map((membership) => membership.collectionId),
    tags: jsonStringArray(note.tags),
    grounding,
    revision: context.revision,
    reviewedAt: note.status === "VERIFIED" && note.verifiedAt
      ? note.verifiedAt.toISOString()
      : undefined,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

function evidenceRecordVisibleTo(note: EvidenceNoteWithRelations, userId: string): boolean {
  if (note.projectMemberships.length > 0) {
    return note.projectMemberships.some(({ project }) =>
      project.visibility === "WORKSPACE" || project.createdById === userId,
    );
  }
  return !note.project
    || note.project.visibility === "WORKSPACE"
    || note.project.createdById === userId;
}

export function collectionDto(collection: {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  updatedAt: Date;
  paperMemberships: { workspacePaper: { paperId: string } }[];
  evidenceMemberships: {
    evidenceNoteId: string;
    evidenceNote: {
      supersedesId: string | null;
      kind: string;
      openQuestion?: string | null;
    };
  }[];
}): Collection {
  const allowedColors = new Set<Collection["color"]>(["blue", "amber", "slate", "teal"]);
  const color = allowedColors.has(collection.color as Collection["color"])
    ? collection.color as Collection["color"]
    : "slate";
  const evidenceNodes = collection.evidenceMemberships.map((membership) => ({
    id: membership.evidenceNoteId,
    supersedesId: membership.evidenceNote.supersedesId,
  }));
  const headIds = latestRevisionIds(evidenceNodes);
  const activeEvidenceMemberships = collection.evidenceMemberships.filter(
    (membership) => headIds.has(membership.evidenceNoteId),
  );
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description ?? "",
    color,
    paperIds: collection.paperMemberships.map((entry) => entry.workspacePaper.paperId),
    noteIds: activeEvidenceMemberships.map((entry) => entry.evidenceNoteId),
    evidenceClaimCount: activeEvidenceMemberships.filter(
      (entry) => entry.evidenceNote.kind !== "QUESTION",
    ).length,
    openQuestionCount: activeEvidenceMemberships.filter(
      (entry) => entry.evidenceNote.kind === "QUESTION",
    ).length,
    updatedAt: collection.updatedAt.toISOString(),
  };
}

export async function workspaceProject(
  user: SessionUser,
  workspaceId: string,
  projectId: string,
): Promise<WorkspaceProjectDto | null> {
  await requireWorkspaceMembership(user.id, workspaceId);

  const snapshot = await prisma.$transaction(async (transaction) => {
    const membership = await transaction.member.findUnique({
      where: {
        organizationId_userId: { organizationId: workspaceId, userId: user.id },
      },
      include: { organization: true },
    });
    if (!membership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }

    const project = await transaction.project.findFirst({
      where: {
        id: projectId,
        organizationId: workspaceId,
        ...projectVisibleTo(user.id),
      },
      include: {
        papers: {
          where: {
            organizationId: workspaceId,
            workspacePaper: { organizationId: workspaceId },
          },
          include: {
            workspacePaper: {
              include: { paper: { include: { authors: true, identifiers: true } } },
            },
          },
        },
        evidenceNotes: {
          where: { organizationId: workspaceId },
          select: { id: true, supersedesId: true },
        },
        evidenceMemberships: {
          where: { organizationId: workspaceId },
          select: {
            evidenceNoteId: true,
            evidenceNote: { select: { id: true, supersedesId: true } },
          },
        },
        collections: { where: { organizationId: workspaceId }, select: { id: true } },
      },
    });
    if (!project) return null;

    const collections = await transaction.collection.findMany({
      where: { organizationId: workspaceId, projectId: project.id },
      orderBy: [{ position: "asc" }, { updatedAt: "desc" }],
      include: {
        paperMemberships: {
          where: { organizationId: workspaceId, workspacePaper: { organizationId: workspaceId } },
          include: { workspacePaper: { select: { paperId: true } } },
        },
        evidenceMemberships: {
          where: {
            organizationId: workspaceId,
            evidenceNote: { organizationId: workspaceId, ...evidenceVisibleTo(user.id) },
          },
          include: {
            evidenceNote: {
              select: { supersedesId: true, kind: true, openQuestion: true },
            },
          },
        },
      },
    });

    const notes = await transaction.evidenceNote.findMany({
      where: {
        organizationId: workspaceId,
        OR: [
          { projectId: project.id },
          {
            projectMemberships: {
              some: { organizationId: workspaceId, projectId: project.id },
            },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      include: {
        workspacePaper: { select: { paperId: true } },
        provenanceRecords: {
          where: { organizationId: workspaceId },
          orderBy: { createdAt: "asc" },
        },
        collectionMemberships: {
          where: {
            organizationId: workspaceId,
            collection: {
              organizationId: workspaceId,
              OR: [
                { projectId: null },
                { project: { organizationId: workspaceId, ...projectVisibleTo(user.id) } },
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
      },
    });

    return {
      aggregateVersion: membership.organization.revision,
      project: projectDto(project),
      papers: project.papers.map((entry) => paperDto(entry.workspacePaper.paper)),
      notes,
      collections: collections.map(collectionDto),
    };
  });
  if (!snapshot) return null;
  const authorityByDocumentId = await getDocumentExtractionLifecycles(
    workspaceId,
    snapshot.notes.flatMap((note) => note.textAnchor ? [note.textAnchor.documentId] : []),
  );
  const lineage = deriveEvidenceRevisionLineage(snapshot.notes);
  return {
    ...snapshot,
    notes: snapshot.notes
      .map((note) => evidenceNoteDto(
        note,
        {
          revision: lineage.get(note.id)!,
          sourceAuthority: note.textAnchor
            ? authorityByDocumentId.get(note.textAnchor.documentId)
            : undefined,
        },
      ))
      .filter((note): note is EvidenceNote => Boolean(note)),
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

function requestHash(command: string, payload: unknown): string {
  return createHash("sha256").update(stableJson({ command, payload })).digest("hex");
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return slug || "research-project";
}

function validateCreateProject(command: CreateProjectCommand): CreateProjectCommand {
  const operationId = command.clientOperationId.trim();
  const name = command.project.name.trim();
  const question = command.project.question.trim();
  const description = command.project.description?.trim() ?? "";
  if (!operationId || operationId.length > 200) {
    throw new HttpProblem(400, "validation", "clientOperationId must contain 1 to 200 characters.");
  }
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) {
    throw new HttpProblem(400, "validation", "expectedVersion must be a non-negative integer.");
  }
  if (!name || name.length > 120) {
    throw new HttpProblem(400, "validation", "Project name must contain 1 to 120 characters.");
  }
  if (!question || question.length > 2_000) {
    throw new HttpProblem(400, "validation", "Research question must contain 1 to 2,000 characters.");
  }
  if (description.length > 5_000) {
    throw new HttpProblem(400, "validation", "Project description may contain at most 5,000 characters.");
  }
  if (!(command.project.type in PROJECT_TYPE_TO_DATABASE)) {
    throw new HttpProblem(400, "validation", "Project type is invalid.");
  }
  if (!(command.project.visibility in PROJECT_VISIBILITY_TO_DATABASE)) {
    throw new HttpProblem(400, "validation", "Project visibility is invalid.");
  }
  return {
    ...command,
    clientOperationId: operationId,
    project: { ...command.project, name, question, description },
  };
}

export async function workspaceBootstrap(
  user: SessionUser,
  activeOrganizationId?: string | null,
  requestedWorkspaceId?: string,
): Promise<WorkspaceBootstrapDto & { workspace: WorkspaceBootstrapDto["workspace"] & { role: string } }> {
  const membership = await resolveWorkspaceMembership(
    user,
    requestedWorkspaceId,
    activeOrganizationId,
  );
  const organizationId = membership.organizationId;
  const visibleProject = projectVisibleTo(user.id);
  const { organization, projects, workspacePapers, inboxEntries, notes, collections } = await prisma.$transaction(
    async (transaction) => {
      // Prisma's local PGlite server intentionally exposes one physical
      // connection. Keep this consistent bootstrap read sequential so local
      // requests queue cleanly while retaining one transaction snapshot.
      const organization = await transaction.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      const projects = await transaction.project.findMany({
        where: { organizationId, ...visibleProject },
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        include: {
          papers: {
            where: { organizationId, workspacePaper: { organizationId } },
            include: { workspacePaper: { select: { paperId: true } } },
          },
          evidenceNotes: {
            where: { organizationId },
            select: { id: true, supersedesId: true },
          },
          evidenceMemberships: {
            where: { organizationId },
            select: {
              evidenceNoteId: true,
              evidenceNote: { select: { id: true, supersedesId: true } },
            },
          },
          collections: { where: { organizationId }, select: { id: true } },
        },
      });
      const workspacePapers = await transaction.workspacePaper.findMany({
        where: {
          organizationId,
          OR: [
            { projectPapers: { none: {} } },
            {
              projectPapers: {
                some: {
                  organizationId,
                  project: { organizationId, ...visibleProject },
                },
              },
            },
          ],
        },
        include: { paper: { include: { authors: true, identifiers: true } } },
      });
      const inboxEntries = await transaction.inboxEntry.findMany({
        where: inboxEntryVisibleTo(user.id, organizationId),
        orderBy: { createdAt: "desc" },
        include: {
          provenanceRecords: {
            where: { organizationId },
            select: {
              kind: true,
              paperId: true,
              paper: {
                select: {
                  id: true,
                  title: true,
                  publicationYear: true,
                  venueName: true,
                  workType: true,
                  authors: { select: { position: true, displayName: true } },
                  identifiers: { select: { type: true, value: true } },
                },
              },
            },
          },
          uploadSession: {
            select: {
              id: true,
              status: true,
              originalFileName: true,
              declaredMimeType: true,
              expectedSizeBytes: true,
              receivedSizeBytes: true,
              expiresAt: true,
              failureCode: true,
              documentId: true,
              asset: {
                select: {
                  status: true,
                  rejectionCode: true,
                },
              },
              document: {
                select: {
                  status: true,
                  failureCode: true,
                  paperId: true,
                  workspacePaperId: true,
                },
              },
            },
          },
          crawlerImport: {
            select: {
              id: true,
              status: true,
              displayFileName: true,
              documentId: true,
              failureCode: true,
            },
          },
          document: {
            select: {
              status: true,
              failureCode: true,
              paperId: true,
              workspacePaperId: true,
            },
          },
        },
      });
      const notes = await transaction.evidenceNote.findMany({
        where: { organizationId, ...evidenceVisibleTo(user.id) },
        orderBy: { createdAt: "desc" },
        include: {
          workspacePaper: { select: { paperId: true } },
          provenanceRecords: {
            where: { organizationId },
            orderBy: { createdAt: "asc" },
          },
          collectionMemberships: {
            where: {
              organizationId,
              collection: {
                organizationId,
                OR: [
                  { projectId: null },
                  { project: { organizationId, ...visibleProject } },
                ],
              },
            },
            select: { collectionId: true },
          },
          projectMemberships: {
            where: { organizationId },
            include: { project: { select: { visibility: true, createdById: true } } },
          },
          project: { select: { visibility: true, createdById: true } },
          textAnchor: true,
        },
      });
      const collections = await transaction.collection.findMany({
        where: {
          organizationId,
          OR: [
            { projectId: null },
            { project: { organizationId, ...visibleProject } },
          ],
        },
        include: {
          paperMemberships: {
            where: { organizationId, workspacePaper: { organizationId } },
            include: { workspacePaper: { select: { paperId: true } } },
          },
          evidenceMemberships: {
            where: {
              organizationId,
              evidenceNote: { organizationId, ...evidenceVisibleTo(user.id) },
            },
            include: {
              evidenceNote: {
                select: { supersedesId: true, kind: true, openQuestion: true },
              },
            },
          },
        },
      });
      return { organization, projects, workspacePapers, inboxEntries, notes, collections };
    },
  );

  const readyDocumentIds = [...new Set(inboxEntries.flatMap((entry) => {
    const upload = entry.uploadSession;
    if (
      upload
      && upload.documentId
      && upload.document
      && documentUploadStage(upload) === "ready"
    ) return [upload.documentId];
    if (
      entry.source === "CRAWLER"
      && entry.crawlerImport
      && entry.document?.status === "READY"
      && entry.documentId === entry.crawlerImport.documentId
    ) return [entry.crawlerImport.documentId];
    return [];
  }))];
  const authorityDocumentIds = [...new Set([
    ...readyDocumentIds,
    ...notes.flatMap((note) => note.textAnchor ? [note.textAnchor.documentId] : []),
  ])];
  const documentExtractionByDocumentId = await getDocumentExtractionLifecycles(
    organizationId,
    authorityDocumentIds,
  );
  const visibleNotes = notes.filter((note) => evidenceRecordVisibleTo(note, user.id));
  const lineage = deriveEvidenceRevisionLineage(visibleNotes);
  const noteDtos = visibleNotes
    .map((note) => evidenceNoteDto(
      note,
      {
        revision: lineage.get(note.id)!,
        sourceAuthority: note.textAnchor
          ? documentExtractionByDocumentId.get(note.textAnchor.documentId)
          : undefined,
      },
    ))
    .filter((note): note is EvidenceNote => Boolean(note));
  const inboxDtos = inboxEntries.flatMap((entry) => {
    const document = entry.source === "CRAWLER"
      ? entry.document
      : entry.uploadSession?.document;
    const documentId = entry.source === "CRAWLER"
      ? entry.crawlerImport?.documentId
      : entry.uploadSession?.documentId;
    const linkedPaperId = document?.paperId && document.workspacePaperId
      ? document.paperId
      : undefined;
    const lifecycle = document?.status === "READY"
      ? documentExtractionByDocumentId.get(documentId ?? "")
      : undefined;
    const readerAuthority: InboxReaderAuthority | undefined = linkedPaperId && lifecycle
      ? inboxReaderAuthorityFromLifecycle(linkedPaperId, lifecycle)
      : undefined;
    const dto = inboxEntryDto(
      entry,
      readerAuthority,
      !linkedPaperId ? lifecycle : undefined,
    );
    return dto ? [dto] : [];
  });

  return {
    schemaVersion: 3,
    aggregateVersion: organization.revision,
    workspace: {
      id: organization.id,
      name: organization.name,
      mode: "live",
      role: membership.role,
    },
    activeProjectId: projects[0]?.id ?? null,
    projects: projects.map(projectDto),
    inboxEntries: inboxDtos,
    papers: workspacePapers.map((entry) => paperDto(entry.paper)),
    notes: noteDtos,
    collections: collections.map(collectionDto),
  };
}

function replayedProjectResult(
  response: unknown,
  revision: number,
): WorkspaceCommandResult<CreateProjectResult> | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const candidate = response as { data?: CreateProjectResult };
  if (!candidate.data?.project?.id) return null;
  return {
    ok: true,
    outcome: "replayed",
    aggregateVersion: revision,
    data: candidate.data,
  };
}

export async function createWorkspaceProject(
  user: SessionUser,
  workspaceId: string,
  rawCommand: CreateProjectCommand,
): Promise<WorkspaceCommandResult<CreateProjectResult>> {
  const command = validateCreateProject(rawCommand);
  const payload = { project: command.project };
  const hash = requestHash("createProject", payload);
  const initialMembership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(initialMembership.role);

  return prisma.$transaction(async (transaction) => {
    // An operation ID is the command's durable retry identity. Serialize it
    // before checking the receipt so simultaneous submits converge on one
    // applied command and all other callers receive the committed replay.
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${workspaceId}:${command.clientOperationId}`}, 0)
      )::text
    `;

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
      if (prior.actorUserId !== user.id || prior.command !== "createProject" || prior.requestHash !== hash) {
        return {
          ok: false,
          code: "idempotency_conflict",
          aggregateVersion: membership.organization.revision,
          message: "clientOperationId was already used for a different command.",
        };
      }
      const replay = replayedProjectResult(prior.response, membership.organization.revision);
      if (replay) return replay;
      return {
        ok: false,
        code: "version_conflict",
        aggregateVersion: membership.organization.revision,
        message: "The prior command is still being resolved. Refresh before retrying.",
      };
    }

    const duplicate = await transaction.project.findFirst({
      where: {
        organizationId: workspaceId,
        name: { equals: command.project.name, mode: "insensitive" },
        ...projectVisibleTo(user.id),
      },
      select: { id: true },
    });
    if (duplicate) {
      return {
        ok: false,
        code: "duplicate",
        aggregateVersion: membership.organization.revision,
        message: "A project with that name already exists in this workspace.",
      };
    }

    const bumped = await transaction.organization.updateMany({
      where: { id: workspaceId, revision: command.expectedVersion },
      data: { revision: { increment: 1 } },
    });
    if (bumped.count !== 1) {
      const current = await transaction.organization.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { revision: true },
      });
      return {
        ok: false,
        code: "version_conflict",
        aggregateVersion: current.revision,
        message: "Workspace changed since it was loaded. Refresh before retrying.",
      };
    }

    await transaction.idempotencyRecord.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        key: command.clientOperationId,
        command: "createProject",
        requestHash: hash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
      },
    });

    const project = await transaction.project.create({
      data: {
        organizationId: workspaceId,
        name: command.project.name,
        slug: `${slugify(command.project.name)}-${crypto.randomUUID().slice(0, 8)}`,
        description: command.project.description || null,
        researchQuestion: command.project.question,
        type: PROJECT_TYPE_TO_DATABASE[command.project.type],
        visibility: PROJECT_VISIBILITY_TO_DATABASE[command.project.visibility],
        createdById: user.id,
      },
      include: {
        papers: { include: { workspacePaper: { select: { paperId: true } } } },
        evidenceNotes: { select: { id: true, supersedesId: true } },
        evidenceMemberships: {
          select: {
            evidenceNoteId: true,
            evidenceNote: { select: { id: true, supersedesId: true } },
          },
        },
        collections: { select: { id: true } },
      },
    });

    const result: WorkspaceCommandResult<CreateProjectResult> = {
      ok: true,
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      data: {
        project: projectDto(project),
        activeProjectId: project.id,
      },
    };
    await transaction.idempotencyRecord.update({
      where: {
        organizationId_key: {
          organizationId: workspaceId,
          key: command.clientOperationId,
        },
      },
      data: {
        status: "COMPLETED",
        response: result as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        action: "project.created",
        entityType: "project",
        entityId: project.id,
        requestId: command.clientOperationId,
        metadata: { projectType: command.project.type, visibility: command.project.visibility },
      },
    });
    return result;
  });
}
