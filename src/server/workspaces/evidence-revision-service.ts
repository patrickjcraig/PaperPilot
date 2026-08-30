import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { GroundedEvidenceSelection } from "@/lib/workspace/contracts";
import { HttpProblem } from "@/server/http/problem";
import { requireWorkspaceMembership } from "./authorization";
import { acquireWorkspaceMembershipAuthorityShared } from "./membership-lock";
import {
  type GroundedEvidenceRevisionCommand,
  type GroundedEvidenceRevisionFailureCode,
  type GroundedEvidenceRevisionResponse,
  type GroundedEvidenceRevisionResult,
  validateGroundedEvidenceRevisionCommand,
} from "./evidence-revision-command";
import {
  evidenceRevisionChain,
  hydrateGroundedEvidenceResponse,
} from "./evidence-revision-read";
import {
  resolveCurrentGroundedEvidenceSelection,
  type ResolvedGroundedEvidenceSelection,
} from "./grounded-evidence-service";
import {
  evidenceVisibleTo,
  projectVisibleTo,
  requireWorkspaceMutationRole,
} from "./project-access";

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVISION_COMMAND = "reviseGroundedEvidence";
const EVIDENCE_SOURCE_TYPES = new Set([
  "paper", "figure", "citation-library", "note-system", "evidence-store",
  "literature-index", "uploaded-file", "web-source",
]);
const EVIDENCE_ACCESS_METHODS = new Set([
  "seeded-demo", "manual", "api", "upload", "oauth", "crawler", "mcp", "webmcp",
]);

interface SessionUser {
  id: string;
  name: string;
}

interface StableRevisionReceipt {
  schemaVersion: 1;
  predecessorId: string;
  successorId: string;
  linkedProjectIds: string[];
  updatedCollectionIds: string[];
}

interface SuccessfulExecution {
  kind: "success";
  outcome: "applied" | "replayed";
  aggregateVersion: number;
  receipt: StableRevisionReceipt;
}

type ExecutionResult = SuccessfulExecution | Exclude<GroundedEvidenceRevisionResponse, { ok: true }>;

function opaqueId(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(404, "evidence_not_found", "Evidence note was not found.");
  }
  return value;
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandHash(noteId: string, command: GroundedEvidenceRevisionCommand): string {
  return sha256(stableJson({
    command: REVISION_COMMAND,
    noteId,
    action: command.action,
    selection: command.action === "reanchor" ? command.selection : undefined,
  }));
}

function failure(
  code: GroundedEvidenceRevisionFailureCode,
  aggregateVersion: number,
  message: string,
): Exclude<GroundedEvidenceRevisionResponse, { ok: true }> {
  return { ok: false, code, aggregateVersion, message };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  const entries = value.filter((entry): entry is string =>
    typeof entry === "string" && OPAQUE_ID_PATTERN.test(entry),
  );
  return entries.length === value.length && new Set(entries).size === entries.length
    ? entries
    : null;
}

function stableReceipt(value: unknown): StableRevisionReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => ![
      "schemaVersion",
      "predecessorId",
      "successorId",
      "linkedProjectIds",
      "updatedCollectionIds",
    ].includes(key))
    || record.schemaVersion !== 1
    || typeof record.predecessorId !== "string"
    || !OPAQUE_ID_PATTERN.test(record.predecessorId)
    || typeof record.successorId !== "string"
    || !OPAQUE_ID_PATTERN.test(record.successorId)
  ) return null;
  const linkedProjectIds = stringArray(record.linkedProjectIds);
  const updatedCollectionIds = stringArray(record.updatedCollectionIds);
  if (!linkedProjectIds || !updatedCollectionIds) return null;
  return {
    schemaVersion: 1,
    predecessorId: record.predecessorId,
    successorId: record.successorId,
    linkedProjectIds,
    updatedCollectionIds,
  };
}

async function lockOperation(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  operationId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${operationId}`}, 0))::text
  `;
}

async function lockPredecessor(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  noteId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:evidence-revision:${noteId}`}, 0))::text
  `;
}

async function bumpRevision(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  expectedVersion: number,
): Promise<boolean> {
  const bumped = await transaction.organization.updateMany({
    where: { id: workspaceId, revision: expectedVersion },
    data: { revision: { increment: 1 } },
  });
  return bumped.count === 1;
}

function jsonInput(value: Prisma.JsonValue | null): Prisma.InputJsonValue | undefined {
  return value === null
    ? undefined
    : JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function recordValue(value: Prisma.JsonValue | null): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function groundingPayload(
  selection: GroundedEvidenceSelection,
  resolved: ResolvedGroundedEvidenceSelection,
): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify({
    schemaVersion: 1,
    state: "current",
    documentId: selection.documentId,
    extractionId: selection.extractionId,
    manifestSha256: selection.manifestSha256,
    start: selection.start,
    end: selection.end,
    quoteSha256: resolved.reconstruction.quoteSha256,
    pageStart: resolved.reconstruction.pageStart,
    pageEnd: resolved.reconstruction.pageEnd,
    paragraphStartId: resolved.reconstruction.paragraphStartId,
    paragraphEndId: resolved.reconstruction.paragraphEndId,
  })) as Prisma.InputJsonObject;
}

function anchorSelection(
  anchor: {
    documentId: string;
    extractionId: string;
    manifestSha256: string;
    startChunkId: string;
    startSequence: number;
    startByteOffset: number;
    startContentHash: string;
    endChunkId: string;
    endSequence: number;
    endByteOffset: number;
    endContentHash: string;
    quoteSha256: string;
  },
): GroundedEvidenceSelection {
  return {
    documentId: anchor.documentId,
    extractionId: anchor.extractionId,
    manifestSha256: anchor.manifestSha256,
    start: {
      chunkId: anchor.startChunkId,
      sequence: anchor.startSequence,
      byteOffset: anchor.startByteOffset,
      contentHash: anchor.startContentHash,
    },
    end: {
      chunkId: anchor.endChunkId,
      sequence: anchor.endSequence,
      byteOffset: anchor.endByteOffset,
      contentHash: anchor.endContentHash,
    },
    expectedQuoteSha256: anchor.quoteSha256,
  };
}

function transactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034");
}

async function currentAggregateVersion(workspaceId: string): Promise<number> {
  return (await prisma.organization.findUnique({
    where: { id: workspaceId },
    select: { revision: true },
  }))?.revision ?? 0;
}

async function executeRevision(
  user: SessionUser,
  workspaceId: string,
  predecessorId: string,
  command: GroundedEvidenceRevisionCommand,
  hash: string,
): Promise<ExecutionResult> {
  return prisma.$transaction(async (transaction) => {
    await lockOperation(transaction, workspaceId, command.clientOperationId);
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

    // Resolve visibility before replaying a receipt so a later project ACL
    // change cannot turn idempotency storage into a stale data oracle.
    const predecessor = await transaction.evidenceNote.findFirst({
      where: {
        id: predecessorId,
        organizationId: workspaceId,
        groundingVersion: 1,
        textAnchor: { isNot: null },
        projectId: { not: null },
        project: { organizationId: workspaceId, ...projectVisibleTo(user.id) },
        ...evidenceVisibleTo(user.id),
      },
      include: {
        workspacePaper: { include: { paper: { select: { title: true } } } },
        projectMemberships: {
          where: { organizationId: workspaceId },
          select: { projectId: true },
        },
        collectionMemberships: {
          where: { organizationId: workspaceId },
          select: { collectionId: true, position: true },
        },
        provenanceRecords: {
          where: { organizationId: workspaceId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        },
        textAnchor: true,
      },
    });
    if (!predecessor?.projectId || !predecessor.textAnchor) {
      return failure("not_found", membership.organization.revision, "Evidence note was not found.");
    }

    const explicitProjectPaper = await transaction.projectPaper.findUnique({
      where: {
        projectId_workspacePaperId: {
          projectId: predecessor.projectId,
          workspacePaperId: predecessor.workspacePaperId,
        },
      },
      select: { organizationId: true },
    });
    if (explicitProjectPaper?.organizationId !== workspaceId) {
      return failure("not_found", membership.organization.revision, "Evidence note was not found.");
    }

    const prior = await transaction.idempotencyRecord.findUnique({
      where: {
        organizationId_key: {
          organizationId: workspaceId,
          key: command.clientOperationId,
        },
      },
    });
    if (prior) {
      if (
        prior.actorUserId !== user.id
        || prior.command !== REVISION_COMMAND
        || prior.requestHash !== hash
      ) {
        return failure(
          "idempotency_conflict",
          membership.organization.revision,
          "clientOperationId was already used for a different command.",
        );
      }
      const receipt = stableReceipt(prior.response);
      if (!receipt || receipt.predecessorId !== predecessor.id) {
        return failure(
          "idempotency_conflict",
          membership.organization.revision,
          "The evidence revision receipt could not be replayed safely.",
        );
      }
      return {
        kind: "success",
        outcome: "replayed",
        aggregateVersion: membership.organization.revision,
        receipt,
      };
    }

    await lockPredecessor(transaction, workspaceId, predecessor.id);
    const existingSuccessor = await transaction.evidenceNote.findFirst({
      where: { organizationId: workspaceId, supersedesId: predecessor.id },
      select: { id: true },
    });
    if (existingSuccessor) {
      return failure(
        "revision_conflict",
        membership.organization.revision,
        "This evidence note already has a successor. Refresh its revision history.",
      );
    }

    if (command.action === "verify" && predecessor.status !== "CAPTURED") {
      return failure(
        "revision_conflict",
        membership.organization.revision,
        "Only a captured evidence revision can be verified.",
      );
    }

    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const visibleProjectCandidates = [...new Set([
      predecessor.projectId,
      ...predecessor.projectMemberships.map(({ projectId }) => projectId),
    ])];
    const visibleProjects = await transaction.project.findMany({
      where: {
        organizationId: workspaceId,
        id: { in: visibleProjectCandidates },
        ...projectVisibleTo(user.id),
        papers: {
          some: {
            organizationId: workspaceId,
            workspacePaperId: predecessor.workspacePaperId,
          },
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const linkedProjectIds = visibleProjects.map(({ id }) => id);
    if (!linkedProjectIds.includes(predecessor.projectId)) {
      return failure("not_found", membership.organization.revision, "Evidence note was not found.");
    }

    const visibleCollections = predecessor.collectionMemberships.length
      ? await transaction.collection.findMany({
        where: {
          organizationId: workspaceId,
          id: { in: predecessor.collectionMemberships.map(({ collectionId }) => collectionId) },
          OR: [
            { projectId: null },
            {
              project: {
                organizationId: workspaceId,
                ...projectVisibleTo(user.id),
                papers: {
                  some: {
                    organizationId: workspaceId,
                    workspacePaperId: predecessor.workspacePaperId,
                  },
                },
              },
            },
          ],
        },
        select: { id: true },
        orderBy: { id: "asc" },
      })
      : [];
    const updatedCollectionIds = visibleCollections.map(({ id }) => id);
    const collectionPositionById = new Map(
      predecessor.collectionMemberships.map(({ collectionId, position }) => [
        collectionId,
        position,
      ] as const),
    );

    let resolvedSelection: ResolvedGroundedEvidenceSelection | undefined;
    let selection = anchorSelection(predecessor.textAnchor);
    if (command.action === "reanchor") {
      selection = command.selection;
      try {
        resolvedSelection = await resolveCurrentGroundedEvidenceSelection(
          transaction,
          workspaceId,
          predecessor.workspacePaperId,
          predecessor.workspacePaper.paperId,
          command.selection,
        );
      } catch (error) {
        if (error instanceof HttpProblem && error.code === "selection_conflict") {
          return failure("selection_conflict", membership.organization.revision, error.message);
        }
        throw error;
      }
    }

    if (!await bumpRevision(transaction, workspaceId, command.expectedVersion)) {
      const current = await transaction.organization.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { revision: true },
      });
      return failure(
        "version_conflict",
        current.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const now = new Date();
    const createdAt = new Date(Math.max(
      now.getTime(),
      predecessor.createdAt.getTime() + 1,
    ));
    const anchor = predecessor.textAnchor;
    const reconstruction = resolvedSelection?.reconstruction;
    const firstChunk = resolvedSelection?.firstChunk;
    const newDocumentId = resolvedSelection?.document.id ?? anchor.documentId;
    const newExtractionId = resolvedSelection?.generation.id ?? anchor.extractionId;
    const quoteText = reconstruction?.quoteText ?? anchor.quoteText;
    const quoteSha256 = reconstruction?.quoteSha256 ?? anchor.quoteSha256;
    const pageStart = reconstruction?.pageStart ?? anchor.pageStart;
    const pageEnd = reconstruction?.pageEnd ?? anchor.pageEnd;
    const paragraphStartId = reconstruction?.paragraphStartId ?? anchor.paragraphStartId;
    const paragraphEndId = reconstruction?.paragraphEndId ?? anchor.paragraphEndId;
    const successor = await transaction.evidenceNote.create({
      data: {
        organizationId: workspaceId,
        workspacePaperId: predecessor.workspacePaperId,
        projectId: predecessor.projectId,
        documentId: newDocumentId,
        documentChunkId: firstChunk?.id ?? anchor.startChunkId,
        createdById: user.id,
        supersedesId: predecessor.id,
        kind: predecessor.kind,
        status: command.action === "verify" ? "VERIFIED" : "CAPTURED",
        confidence: predecessor.confidence,
        title: predecessor.title,
        claim: predecessor.claim,
        evidence: quoteText,
        interpretation: predecessor.interpretation,
        openQuestion: predecessor.openQuestion,
        linkedHighlightIds: command.action === "verify"
          ? jsonInput(predecessor.linkedHighlightIds)
          : [],
        tags: jsonInput(predecessor.tags),
        quote: quoteText,
        text: predecessor.claim ?? predecessor.text,
        pageStart,
        pageEnd,
        sectionId: command.action === "reanchor"
          ? firstChunk?.sectionId ?? null
          : predecessor.sectionId,
        sectionTitle: command.action === "reanchor"
          ? firstChunk?.sectionTitle ?? null
          : predecessor.sectionTitle,
        paragraphId: paragraphStartId,
        figureId: command.action === "verify" ? predecessor.figureId : null,
        figureLabel: command.action === "verify" ? predecessor.figureLabel : null,
        verifiedAt: command.action === "verify" ? createdAt : null,
        groundingVersion: 1,
        createdAt,
      },
    });

    await transaction.projectEvidenceNote.createMany({
      data: linkedProjectIds.map((projectId) => ({
        organizationId: workspaceId,
        projectId,
        evidenceNoteId: successor.id,
      })),
    });
    if (updatedCollectionIds.length) {
      await transaction.collectionEvidenceNote.createMany({
        data: updatedCollectionIds.map((collectionId) => ({
          organizationId: workspaceId,
          collectionId,
          evidenceNoteId: successor.id,
          position: collectionPositionById.get(collectionId) ?? null,
        })),
      });
    }

    await transaction.evidenceTextAnchor.create({
      data: {
        organizationId: workspaceId,
        evidenceNoteId: successor.id,
        workspacePaperId: predecessor.workspacePaperId,
        documentId: newDocumentId,
        extractionId: newExtractionId,
        schemaVersion: 1,
        manifestSha256: selection.manifestSha256,
        startChunkId: firstChunk?.id ?? anchor.startChunkId,
        endChunkId: resolvedSelection?.lastChunk.id ?? anchor.endChunkId,
        startSequence: firstChunk?.sequence ?? anchor.startSequence,
        endSequence: resolvedSelection?.lastChunk.sequence ?? anchor.endSequence,
        startByteOffset: selection.start.byteOffset,
        endByteOffset: selection.end.byteOffset,
        startContentHash: firstChunk?.contentHash ?? anchor.startContentHash,
        endContentHash: resolvedSelection?.lastChunk.contentHash ?? anchor.endContentHash,
        quoteText,
        quoteSha256,
        pageStart,
        pageEnd,
        paragraphStartId,
        paragraphEndId,
      },
    });

    const priorAssertion = predecessor.provenanceRecords.find(
      ({ kind }) => kind === "USER_ASSERTION",
    );
    const priorExtraction = predecessor.provenanceRecords.find(
      ({ kind }) => kind === "EXTRACTION",
    );
    const previousPayload = recordValue(priorAssertion?.payload ?? null);
    const previousExtractionPayload = recordValue(priorExtraction?.payload ?? null);
    const previousProvenance = recordValue(
      (previousPayload?.provenance as Prisma.JsonValue | undefined) ?? null,
    );
    const previousGrounding = recordValue(
      (previousPayload?.grounding as Prisma.JsonValue | undefined) ?? null,
    );
    const isVerify = command.action === "verify";
    // Verification reviews an existing immutable source capture; it is not a
    // new retrieval. Preserve the predecessor's effective retrieval times so
    // the correction records cannot misrepresent review time as source time.
    const assertionRetrievedAt = isVerify
      ? priorAssertion?.retrievedAt ?? priorAssertion?.createdAt ?? predecessor.createdAt
      : now;
    const extractionRetrievedAt = isVerify
      ? priorExtraction?.retrievedAt ?? priorExtraction?.createdAt ?? assertionRetrievedAt
      : now;
    const sourceType = typeof previousProvenance?.sourceType === "string"
      && EVIDENCE_SOURCE_TYPES.has(previousProvenance.sourceType)
      ? previousProvenance.sourceType
      : "paper";
    const accessMethod = typeof previousProvenance?.accessMethod === "string"
      && EVIDENCE_ACCESS_METHODS.has(previousProvenance.accessMethod)
      ? previousProvenance.accessMethod
      : "api";
    const sourceTitle = typeof previousProvenance?.sourceTitle === "string"
      && previousProvenance.sourceTitle.length > 0
      && previousProvenance.sourceTitle.length <= 2_000
      ? previousProvenance.sourceTitle
      : predecessor.workspacePaper.paper.title;
    const locator = pageStart === pageEnd
      ? { paperId: predecessor.workspacePaper.paperId, page: pageStart, paragraphId: paragraphStartId }
      : {
        paperId: predecessor.workspacePaper.paperId,
        pageRange: [pageStart, pageEnd],
        paragraphId: paragraphStartId,
      };
    const revision = {
      action: command.action,
      predecessorEvidenceNoteId: predecessor.id,
    };
    const revisionGrounding = resolvedSelection
      ? groundingPayload(selection, resolvedSelection)
      : previousGrounding
        ? JSON.parse(JSON.stringify(previousGrounding)) as Prisma.InputJsonObject
        : JSON.parse(JSON.stringify({
          schemaVersion: 1,
          documentId: anchor.documentId,
          extractionId: anchor.extractionId,
          manifestSha256: anchor.manifestSha256,
          start: selection.start,
          end: selection.end,
          quoteSha256,
          pageStart,
          pageEnd,
          paragraphStartId,
          paragraphEndId,
        })) as Prisma.InputJsonObject;
    const assertionPayload = JSON.parse(JSON.stringify(
      isVerify && previousPayload
        ? { ...previousPayload, revision }
        : {
          schemaVersion: 2,
          provenance: {
            sourceType,
            sourceId: newExtractionId,
            sourceTitle,
            providerName: "PaperPilot Reader",
            retrievedAt: assertionRetrievedAt.toISOString(),
            accessMethod,
            locator,
            excerpt: quoteText,
            version: `manifest:${selection.manifestSha256}`,
          },
          revision,
          grounding: revisionGrounding,
        },
    )) as Prisma.InputJsonObject;
    const extractionPayload = JSON.parse(JSON.stringify(
      isVerify && previousExtractionPayload
        ? { ...previousExtractionPayload, revision }
        : {
          schemaVersion: 1,
          documentId: newDocumentId,
          extractionId: newExtractionId,
          manifestSha256: selection.manifestSha256,
          start: selection.start,
          end: selection.end,
          quoteSha256,
          revision,
        },
    )) as Prisma.InputJsonObject;
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "USER_ASSERTION",
        paperId: predecessor.workspacePaper.paperId,
        workspacePaperId: predecessor.workspacePaperId,
        evidenceNoteId: successor.id,
        documentId: newDocumentId,
        actorUserId: user.id,
        supersedesId: priorAssertion?.id,
        sourceProvider: isVerify ? priorAssertion?.sourceProvider : "PaperPilot Reader",
        sourceRecordId: isVerify ? priorAssertion?.sourceRecordId : newExtractionId,
        sourceUri: priorAssertion?.sourceUri,
        retrievedAt: assertionRetrievedAt,
        payloadDigest: sha256(stableJson(assertionPayload)),
        payload: assertionPayload,
      },
    });
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "EXTRACTION",
        paperId: predecessor.workspacePaper.paperId,
        workspacePaperId: predecessor.workspacePaperId,
        evidenceNoteId: successor.id,
        documentId: newDocumentId,
        actorUserId: user.id,
        supersedesId: priorExtraction?.id,
        sourceProvider: isVerify ? priorExtraction?.sourceProvider : "PaperPilot Reader",
        sourceRecordId: isVerify ? priorExtraction?.sourceRecordId : newExtractionId,
        sourceUri: priorExtraction?.sourceUri,
        retrievedAt: extractionRetrievedAt,
        payloadDigest: sha256(stableJson(extractionPayload)),
        payload: extractionPayload,
      },
    });

    if (updatedCollectionIds.length) {
      await transaction.collection.updateMany({
        where: { organizationId: workspaceId, id: { in: updatedCollectionIds } },
        data: { updatedAt: now },
      });
    }

    // Force lineage derivation before commit. This detects any impossible
    // disconnected/branching state before we publish the successor receipt.
    const lineage = await evidenceRevisionChain(transaction, workspaceId, successor.id);
    if (!lineage.some(({ id }) => id === successor.id)) {
      throw new Error("The new evidence successor was absent from its revision chain.");
    }

    const receipt: StableRevisionReceipt = {
      schemaVersion: 1,
      predecessorId: predecessor.id,
      successorId: successor.id,
      linkedProjectIds,
      updatedCollectionIds,
    };
    await transaction.idempotencyRecord.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        key: command.clientOperationId,
        command: REVISION_COMMAND,
        requestHash: hash,
        response: JSON.parse(JSON.stringify(receipt)) as Prisma.InputJsonValue,
        status: "COMPLETED",
        completedAt: now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        action: command.action === "verify"
          ? "evidence.grounded-verified"
          : "evidence.grounded-reanchored",
        entityType: "evidence_note",
        entityId: successor.id,
        requestId: command.clientOperationId,
        metadata: {
          predecessorId: predecessor.id,
          paperId: predecessor.workspacePaper.paperId,
          projectId: predecessor.projectId,
          documentId: newDocumentId,
          extractionId: newExtractionId,
          manifestSha256: selection.manifestSha256,
          quoteSha256,
          collectionCount: updatedCollectionIds.length,
          projectCount: linkedProjectIds.length,
        },
      },
    });
    return {
      kind: "success",
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      receipt,
    };
  }, { isolationLevel: "Serializable" });
}

export async function reviseWorkspaceGroundedEvidence(
  user: SessionUser,
  workspaceId: string,
  predecessorIdValue: string,
  rawCommand: unknown,
): Promise<GroundedEvidenceRevisionResponse> {
  const predecessorId = opaqueId(predecessorIdValue);
  const command = validateGroundedEvidenceRevisionCommand(rawCommand);
  const hash = commandHash(predecessorId, command);

  const initialMembership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(initialMembership.role);

  let execution: ExecutionResult;
  try {
    execution = await executeRevision(user, workspaceId, predecessorId, command, hash);
  } catch (error) {
    if (!transactionConflict(error)) throw error;
    // A serialization abort may be the same idempotent operation committing
    // concurrently. Retry once so it can replay its stable receipt.
    try {
      execution = await executeRevision(user, workspaceId, predecessorId, command, hash);
    } catch (retryError) {
      if (!transactionConflict(retryError)) throw retryError;
      return failure(
        "revision_conflict",
        await currentAggregateVersion(workspaceId),
        "This evidence note changed concurrently. Refresh its revision history.",
      );
    }
  }
  if (!("kind" in execution)) return execution;

  const hydrated = await hydrateGroundedEvidenceResponse(
    user.id,
    workspaceId,
    execution.receipt.successorId,
  );
  if (!hydrated) {
    if (execution.outcome === "replayed") {
      return failure(
        "not_found",
        execution.aggregateVersion,
        "Evidence note was not found.",
      );
    }
    throw new Error("The committed evidence successor could not be mapped to the read model.");
  }
  const data: GroundedEvidenceRevisionResult = {
    predecessorId: execution.receipt.predecessorId,
    note: hydrated.note,
    linkedProjectIds: hydrated.linkedProjectIds,
    updatedCollectionIds: hydrated.updatedCollectionIds,
  };
  return {
    ok: true,
    outcome: execution.outcome,
    aggregateVersion: execution.aggregateVersion,
    data,
  };
}
