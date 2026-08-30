import "server-only";

import type { EvidenceNote } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getDocumentExtractionLifecycles } from "@/server/documents/extraction-authority";
import {
  deriveEvidenceRevisionLineage,
  evidenceNoteDto,
  type EvidenceRevisionNode,
  type EvidenceNoteWithRelations,
} from "./service";
import { evidenceVisibleTo, projectVisibleTo } from "./project-access";

const MAX_EVIDENCE_REVISION_DEPTH = 1_000;

export interface HydratedGroundedEvidenceResponse {
  note: EvidenceNote;
  linkedProjectIds: string[];
  updatedCollectionIds: string[];
}

export function evidenceRevisionInclude(workspaceId: string, userId: string) {
  return {
    workspacePaper: { select: { paperId: true } },
    provenanceRecords: {
      where: { organizationId: workspaceId },
      orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    },
    collectionMemberships: {
      where: {
        organizationId: workspaceId,
        collection: {
          organizationId: workspaceId,
          OR: [
            { projectId: null },
            { project: { organizationId: workspaceId, ...projectVisibleTo(userId) } },
          ],
        },
      },
      select: { collectionId: true },
    },
    projectMemberships: {
      where: {
        organizationId: workspaceId,
        project: { organizationId: workspaceId, ...projectVisibleTo(userId) },
      },
      include: { project: { select: { visibility: true, createdById: true } } },
    },
    project: { select: { visibility: true, createdById: true } },
    textAnchor: true,
  } satisfies Prisma.EvidenceNoteInclude;
}

/** Load exactly one non-branching revision chain, without project-wide scans. */
export async function evidenceRevisionChain(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  noteId: string,
): Promise<EvidenceRevisionNode[]> {
  const rows = await transaction.$queryRaw<Array<EvidenceRevisionNode & {
    depth: number;
    hasSuccessor: boolean;
  }>>`
    WITH RECURSIVE ancestors AS (
      SELECT note."id", note."supersedesId", 1 AS depth, ARRAY[note."id"]::text[] AS path
      FROM "EvidenceNote" AS note
      WHERE note."organizationId" = ${workspaceId}
        AND note."id" = ${noteId}
      UNION ALL
      SELECT predecessor."id", predecessor."supersedesId", current.depth + 1,
             current.path || predecessor."id"
      FROM "EvidenceNote" AS predecessor
      JOIN ancestors AS current
        ON current."supersedesId" = predecessor."id"
      WHERE predecessor."organizationId" = ${workspaceId}
        AND current.depth < ${MAX_EVIDENCE_REVISION_DEPTH}
        AND NOT predecessor."id" = ANY(current.path)
    ), chain_root AS (
      SELECT ancestor."id", ancestor."supersedesId"
      FROM ancestors AS ancestor
      WHERE ancestor."supersedesId" IS NULL
      LIMIT 1
    ), descendants AS (
      SELECT root."id", root."supersedesId", 1 AS depth, ARRAY[root."id"]::text[] AS path
      FROM chain_root AS root
      UNION ALL
      SELECT successor."id", successor."supersedesId", current.depth + 1,
             current.path || successor."id"
      FROM "EvidenceNote" AS successor
      JOIN descendants AS current
        ON successor."supersedesId" = current."id"
      WHERE successor."organizationId" = ${workspaceId}
        AND current.depth < ${MAX_EVIDENCE_REVISION_DEPTH}
        AND NOT successor."id" = ANY(current.path)
    )
    SELECT descendant."id", descendant."supersedesId", descendant.depth,
           EXISTS (
             SELECT 1
             FROM "EvidenceNote" AS successor
             WHERE successor."organizationId" = ${workspaceId}
               AND successor."supersedesId" = descendant."id"
           ) AS "hasSuccessor"
    FROM descendants AS descendant
    ORDER BY descendant.depth ASC
  `;
  if (rows.length < 1) {
    throw new Error("Evidence revision lineage has no bounded root.");
  }
  const last = rows.at(-1);
  if (!last || last.hasSuccessor) {
    throw new Error(
      `Evidence revision lineage exceeds the ${MAX_EVIDENCE_REVISION_DEPTH}-revision safety bound.`,
    );
  }
  return rows.map(({ id, supersedesId }) => ({ id, supersedesId }));
}

/**
 * Rehydrate an idempotent response from current authorized state. Lineage and
 * source-currentness are projections, so neither may be trusted from an old
 * receipt after later successors or extraction generations are admitted.
 */
export async function hydrateGroundedEvidenceResponse(
  userId: string,
  workspaceId: string,
  noteId: string,
): Promise<HydratedGroundedEvidenceResponse | null> {
  const snapshot = await prisma.$transaction(async (transaction) => {
    const note = await transaction.evidenceNote.findFirst({
      where: {
        id: noteId,
        organizationId: workspaceId,
        groundingVersion: 1,
        textAnchor: { isNot: null },
        projectId: { not: null },
        project: { organizationId: workspaceId, ...projectVisibleTo(userId) },
        ...evidenceVisibleTo(userId),
      },
      include: evidenceRevisionInclude(workspaceId, userId),
    });
    if (!note?.projectId || !note.documentId) return null;

    const projectPaper = await transaction.projectPaper.findUnique({
      where: {
        projectId_workspacePaperId: {
          projectId: note.projectId,
          workspacePaperId: note.workspacePaperId,
        },
      },
      select: { organizationId: true },
    });
    if (projectPaper?.organizationId !== workspaceId) return null;

    // Keep interactive-transaction reads ordered. The local Prisma pg adapter
    // exposes one physical connection; overlapping client.query calls can let
    // a query escape the transaction boundary and poison the next isolation
    // setup (`SET TRANSACTION ... must be called before any query`).
    const nodes = await evidenceRevisionChain(transaction, workspaceId, note.id);
    const linkedProjects = await transaction.projectEvidenceNote.findMany({
      where: {
        organizationId: workspaceId,
        evidenceNoteId: note.id,
        project: {
          organizationId: workspaceId,
          ...projectVisibleTo(userId),
          papers: {
            some: {
              organizationId: workspaceId,
              workspacePaperId: note.workspacePaperId,
            },
          },
        },
      },
      select: { projectId: true },
      orderBy: { projectId: "asc" },
    });
    const linkedCollections = await transaction.collectionEvidenceNote.findMany({
      where: {
        organizationId: workspaceId,
        evidenceNoteId: note.id,
        collection: {
          organizationId: workspaceId,
          OR: [
            { projectId: null },
            {
              project: {
                organizationId: workspaceId,
                ...projectVisibleTo(userId),
                papers: {
                  some: {
                    organizationId: workspaceId,
                    workspacePaperId: note.workspacePaperId,
                  },
                },
              },
            },
          ],
        },
      },
      select: { collectionId: true },
      orderBy: { collectionId: "asc" },
    });
    return {
      note,
      documentId: note.documentId,
      nodes,
      linkedProjects,
      linkedCollections,
    };
  }, { isolationLevel: "RepeatableRead" });
  if (!snapshot) return null;

  const sourceAuthorities = await getDocumentExtractionLifecycles(
    workspaceId,
    [snapshot.documentId],
  );
  const lineage = deriveEvidenceRevisionLineage(snapshot.nodes).get(snapshot.note.id);
  if (!lineage) return null;
  const mapped = evidenceNoteDto(snapshot.note as EvidenceNoteWithRelations, {
    revision: lineage,
    sourceAuthority: sourceAuthorities.get(snapshot.documentId),
  });
  if (!mapped) return null;
  const updatedCollectionIds = snapshot.linkedCollections.map(({ collectionId }) => collectionId);
  // Grounded evidence always has one canonical project relation in addition
  // to its filing join rows. The authorization snapshot already proved that
  // project is visible and still contains the paper, so it must remain in the
  // response even if an auxiliary ProjectEvidenceNote edge was later removed.
  const linkedProjectIds = [...new Set([
    snapshot.note.projectId!,
    ...snapshot.linkedProjects.map(({ projectId }) => projectId),
  ])].sort();
  return {
    note: { ...mapped, collectionIds: updatedCollectionIds },
    linkedProjectIds,
    updatedCollectionIds,
  };
}

export async function hydrateGroundedEvidenceNoteForResponse(
  userId: string,
  workspaceId: string,
  noteId: string,
): Promise<EvidenceNote | null> {
  return (await hydrateGroundedEvidenceResponse(userId, workspaceId, noteId))?.note ?? null;
}
