import "server-only";

import { createHash } from "node:crypto";
import type {
  EvidenceNote,
  Provenance,
  SourceLocator,
} from "@/lib/types";
import type {
  AddNoteToCollectionCommand,
  AddNoteToCollectionResult,
  AddPaperToCollectionCommand,
  AddPaperToCollectionResult,
  CreateEvidenceNoteCommand,
  CreateEvidenceNoteResult,
  EvidenceNoteDraft,
  WorkspaceCommandFailure,
  WorkspaceCommandResult,
} from "@/lib/workspace";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { requireWorkspaceMembership } from "./authorization";
import { acquireWorkspaceMembershipAuthorityShared } from "./membership-lock";
import {
  evidenceVisibleTo,
  projectVisibleTo,
  requireWorkspaceMutationRole,
} from "./project-access";
import {
  collectionDto,
  deriveEvidenceRevisionLineage,
  evidenceNoteDto,
  paperDto,
  standaloneEvidenceRevision,
} from "./service";
import { evidenceRevisionChain } from "./evidence-revision-read";

export const MAX_EVIDENCE_COMMAND_BYTES = 128 * 1024;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const OPAQUE_ID = /^[a-zA-Z0-9._:-]{1,200}$/;

const CREATE_COMMAND_KEYS = new Set(["clientOperationId", "expectedVersion", "note", "projectId"]);
const NOTE_KEYS = new Set([
  "paperId", "title", "kind", "claim", "evidence", "interpretation", "openQuestion",
  "confidence", "status", "provenance", "linkedHighlightIds", "collectionIds", "tags",
]);
const PROVENANCE_KEYS = new Set([
  "id", "sourceType", "sourceId", "sourceTitle", "sourceUrl", "providerName",
  "retrievedAt", "accessMethod", "locator", "excerpt", "version",
]);
const LOCATOR_KEYS = new Set([
  "paperId", "sectionId", "sectionTitle", "page", "pageRange", "paragraphId",
  "figureId", "figureLabel",
]);
const COLLECTION_COMMAND_KEYS = new Set([
  "clientOperationId", "expectedVersion", "paperId", "collectionId",
]);
const NOTE_COLLECTION_COMMAND_KEYS = new Set([
  "clientOperationId", "expectedVersion", "noteId", "collectionId",
]);

const NOTE_KINDS = new Set<EvidenceNote["kind"]>([
  "direct-evidence", "interpretation", "open-question",
]);
const CONFIDENCE_LEVELS = new Set<EvidenceNote["confidence"]>([
  "high", "medium", "low", "unspecified",
]);
const WRITABLE_STATUSES = new Set<EvidenceNote["status"]>(["captured", "needs-verification"]);
const SOURCE_TYPES = new Set<Provenance["sourceType"]>([
  "paper", "figure", "citation-library", "note-system", "evidence-store",
  "literature-index", "uploaded-file", "web-source",
]);
const ACCESS_METHODS = new Set<Provenance["accessMethod"]>([
  "seeded-demo", "manual", "api", "upload", "oauth", "crawler", "mcp", "webmcp",
]);

interface SessionUser {
  id: string;
  name: string;
}

interface ValidatedEnvelope {
  clientOperationId: string;
  expectedVersion: number;
}

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function asRecord(value: unknown, label: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return validation(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) validation(`${label} contains an unsupported field: ${unknown}.`);
  return record;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") validation(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    validation(`${label} must contain 1 to ${maximum.toLocaleString()} characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") validation(`${label} must be text when provided.`);
  const normalized = value.trim();
  if (normalized.length > maximum) {
    validation(`${label} may contain at most ${maximum.toLocaleString()} characters.`);
  }
  return normalized || undefined;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    validation(`${label} must be a valid opaque identifier.`);
  }
  return value;
}

function optionalOpaqueId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : opaqueId(value, label);
}

function envelope(record: Record<string, unknown>): ValidatedEnvelope {
  const clientOperationId = requiredText(record.clientOperationId, "clientOperationId", 200);
  if (!Number.isSafeInteger(record.expectedVersion) || Number(record.expectedVersion) < 0) {
    validation("expectedVersion must be a non-negative safe integer.");
  }
  return { clientOperationId, expectedVersion: Number(record.expectedVersion) };
}

function stringList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength = 200,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    validation(`${label} must be an array containing at most ${maximumItems} values.`);
  }
  return [...new Set(value.map((entry, index) =>
    requiredText(entry, `${label}[${index}]`, maximumLength),
  ))];
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100_000) {
    validation(`${label} must be an integer between 1 and 100,000.`);
  }
  return Number(value);
}

function sourceUrl(value: unknown): string | undefined {
  const candidate = optionalText(value, "note.provenance.sourceUrl", 2_048);
  if (!candidate) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return validation("note.provenance.sourceUrl must be an absolute HTTP or HTTPS URL.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
  ) {
    validation("note.provenance.sourceUrl must be HTTP(S) and contain no embedded credentials.");
  }
  return parsed.toString();
}

function isoDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const candidate = requiredText(value, label, 100);
  const milliseconds = Date.parse(candidate);
  if (!Number.isFinite(milliseconds) || milliseconds > Date.now() + 5 * 60 * 1_000) {
    validation(`${label} must be a valid, non-future ISO-8601 timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

function locator(value: unknown, paperId: string): SourceLocator | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, "note.provenance.locator", LOCATOR_KEYS);
  const locatorPaperId = opaqueId(record.paperId, "note.provenance.locator.paperId");
  if (locatorPaperId !== paperId) {
    validation("Evidence provenance must point to the evidence note's paper.");
  }
  const page = record.page === undefined
    ? undefined
    : positiveInteger(record.page, "note.provenance.locator.page");
  let pageRange: [number, number] | undefined;
  if (record.pageRange !== undefined) {
    if (!Array.isArray(record.pageRange) || record.pageRange.length !== 2) {
      validation("note.provenance.locator.pageRange must contain exactly two page numbers.");
    }
    const start = positiveInteger(record.pageRange[0], "note.provenance.locator.pageRange[0]");
    const end = positiveInteger(record.pageRange[1], "note.provenance.locator.pageRange[1]");
    if (end < start) validation("note.provenance.locator.pageRange must be ordered.");
    pageRange = [start, end];
  }
  if (page !== undefined && pageRange !== undefined) {
    validation("Evidence provenance must use either page or pageRange, not both.");
  }
  return {
    paperId,
    sectionId: optionalText(record.sectionId, "note.provenance.locator.sectionId", 200),
    sectionTitle: optionalText(record.sectionTitle, "note.provenance.locator.sectionTitle", 500),
    page,
    pageRange,
    paragraphId: optionalText(record.paragraphId, "note.provenance.locator.paragraphId", 200),
    figureId: optionalText(record.figureId, "note.provenance.locator.figureId", 200),
    figureLabel: optionalText(record.figureLabel, "note.provenance.locator.figureLabel", 500),
  };
}

function normalizeProvenance(
  value: unknown,
  paperId: string,
  evidence: string,
): EvidenceNoteDraft["provenance"] {
  const record = asRecord(value, "note.provenance", PROVENANCE_KEYS);
  const sourceType = record.sourceType;
  const accessMethod = record.accessMethod;
  if (typeof sourceType !== "string" || !SOURCE_TYPES.has(sourceType as Provenance["sourceType"])) {
    validation("note.provenance.sourceType is invalid.");
  }
  if (typeof accessMethod !== "string" || !ACCESS_METHODS.has(accessMethod as Provenance["accessMethod"])) {
    validation("note.provenance.accessMethod is invalid.");
  }
  const excerpt = optionalText(record.excerpt, "note.provenance.excerpt", 50_000);
  if (excerpt !== undefined && excerpt !== evidence) {
    validation("note.provenance.excerpt must match the direct evidence field.");
  }
  return {
    id: optionalOpaqueId(record.id, "note.provenance.id"),
    sourceType: sourceType as Provenance["sourceType"],
    sourceId: requiredText(record.sourceId, "note.provenance.sourceId", 1_000),
    sourceTitle: requiredText(record.sourceTitle, "note.provenance.sourceTitle", 2_000),
    sourceUrl: sourceUrl(record.sourceUrl),
    providerName: requiredText(record.providerName, "note.provenance.providerName", 200),
    retrievedAt: isoDate(record.retrievedAt, "note.provenance.retrievedAt"),
    accessMethod: accessMethod as Provenance["accessMethod"],
    locator: locator(record.locator, paperId),
    excerpt: evidence,
    version: optionalText(record.version, "note.provenance.version", 200),
  };
}

export function validateCreateEvidenceNoteCommand(raw: unknown): CreateEvidenceNoteCommand {
  const record = asRecord(raw, "Evidence command", CREATE_COMMAND_KEYS);
  const commandEnvelope = envelope(record);
  const note = asRecord(record.note, "note", NOTE_KEYS);
  const paperId = opaqueId(note.paperId, "note.paperId");
  const kind = note.kind;
  const confidence = note.confidence;
  const status = note.status;
  if (typeof kind !== "string" || !NOTE_KINDS.has(kind as EvidenceNote["kind"])) {
    validation("note.kind is invalid.");
  }
  if (typeof confidence !== "string" || !CONFIDENCE_LEVELS.has(confidence as EvidenceNote["confidence"])) {
    validation("note.confidence is invalid.");
  }
  if (typeof status !== "string" || !WRITABLE_STATUSES.has(status as EvidenceNote["status"])) {
    validation("New evidence status must be captured or needs-verification.");
  }
  const directEvidence = requiredText(note.evidence, "note.evidence", 50_000);
  const normalized: EvidenceNoteDraft = {
    paperId,
    title: requiredText(note.title, "note.title", 200),
    kind: kind as EvidenceNote["kind"],
    claim: requiredText(note.claim, "note.claim", 20_000),
    evidence: directEvidence,
    interpretation: requiredText(note.interpretation, "note.interpretation", 20_000),
    openQuestion: optionalText(note.openQuestion, "note.openQuestion", 10_000),
    confidence: confidence as EvidenceNote["confidence"],
    status: status as EvidenceNote["status"],
    provenance: normalizeProvenance(note.provenance, paperId, directEvidence),
    linkedHighlightIds: stringList(note.linkedHighlightIds, "note.linkedHighlightIds", 100),
    collectionIds: stringList(note.collectionIds, "note.collectionIds", 50),
    tags: stringList(note.tags, "note.tags", 50, 100),
  };
  return {
    ...commandEnvelope,
    note: normalized,
    projectId: opaqueId(record.projectId, "projectId"),
  };
}

export function validatePaperCollectionCommand(
  raw: unknown,
  routeCollectionId: string,
): AddPaperToCollectionCommand {
  const record = asRecord(raw, "Collection paper command", COLLECTION_COMMAND_KEYS);
  const command = {
    ...envelope(record),
    paperId: opaqueId(record.paperId, "paperId"),
    collectionId: opaqueId(record.collectionId, "collectionId"),
  };
  if (command.collectionId !== routeCollectionId) {
    validation("collectionId must match the route collection.");
  }
  return command;
}

export function validateNoteCollectionCommand(
  raw: unknown,
  routeCollectionId: string,
): AddNoteToCollectionCommand {
  const record = asRecord(raw, "Collection evidence command", NOTE_COLLECTION_COMMAND_KEYS);
  const command = {
    ...envelope(record),
    noteId: opaqueId(record.noteId, "noteId"),
    collectionId: opaqueId(record.collectionId, "collectionId"),
  };
  if (command.collectionId !== routeCollectionId) {
    validation("collectionId must match the route collection.");
  }
  return command;
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

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function failure(
  code: WorkspaceCommandFailure["code"],
  aggregateVersion: number,
  message: string,
): WorkspaceCommandFailure {
  return { ok: false, code, aggregateVersion, message };
}

function replayed<T>(response: unknown, aggregateVersion: number): WorkspaceCommandResult<T> | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const candidate = response as { ok?: unknown; data?: T };
  if (candidate.ok !== true || candidate.data === undefined) return null;
  return { ok: true, outcome: "replayed", aggregateVersion, data: candidate.data };
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

async function lockEvidenceRevision(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  noteId: string,
): Promise<void> {
  // Share the successor command's lock namespace. A collection edge can only
  // be admitted while the requested note is still the global chain head.
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${workspaceId}:evidence-revision:${noteId}`}, 0)
    )::text
  `;
}

async function commandMembership(
  transaction: Prisma.TransactionClient,
  userId: string,
  workspaceId: string,
) {
  await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
  const membership = await transaction.member.findUnique({
    where: { organizationId_userId: { organizationId: workspaceId, userId } },
    include: { organization: true },
  });
  if (!membership) throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  requireWorkspaceMutationRole(membership.role);
  return membership;
}

async function priorResult<T>(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    operationId: string;
    command: string;
    hash: string;
    revision: number;
  },
): Promise<WorkspaceCommandResult<T> | undefined> {
  const prior = await transaction.idempotencyRecord.findUnique({
    where: {
      organizationId_key: {
        organizationId: input.workspaceId,
        key: input.operationId,
      },
    },
  });
  if (!prior) return undefined;
  if (
    prior.actorUserId !== input.userId
    || prior.command !== input.command
    || prior.requestHash !== input.hash
  ) {
    return failure(
      "idempotency_conflict",
      input.revision,
      "clientOperationId was already used for a different command.",
    );
  }
  return replayed<T>(prior.response, input.revision)
    ?? failure(
      "version_conflict",
      input.revision,
      "The prior command is still being resolved. Refresh before retrying.",
    );
}

async function saveReceipt<T>(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    operationId: string;
    command: string;
    hash: string;
    result: WorkspaceCommandResult<T>;
  },
): Promise<void> {
  await transaction.idempotencyRecord.create({
    data: {
      organizationId: input.workspaceId,
      actorUserId: input.userId,
      key: input.operationId,
      command: input.command,
      requestHash: input.hash,
      response: JSON.parse(JSON.stringify(input.result)) as Prisma.InputJsonValue,
      status: "COMPLETED",
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    },
  });
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

function collectionInclude(workspaceId: string, userId: string) {
  return {
    project: { select: { id: true, visibility: true, createdById: true } },
    paperMemberships: {
      where: { organizationId: workspaceId, workspacePaper: { organizationId: workspaceId } },
      include: { workspacePaper: { select: { paperId: true } } },
    },
    evidenceMemberships: {
      where: {
        organizationId: workspaceId,
        evidenceNote: { organizationId: workspaceId, ...evidenceVisibleTo(userId) },
      },
      include: {
        evidenceNote: { select: { kind: true, openQuestion: true, supersedesId: true } },
      },
    },
  } as const;
}

function evidenceInclude(workspaceId: string, userId: string) {
  return {
    workspacePaper: { select: { paperId: true } },
    provenanceRecords: {
      where: { organizationId: workspaceId },
      orderBy: { createdAt: "asc" as const },
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

function projectIsVisible(
  project: { visibility: string; createdById: string | null } | null,
  userId: string,
): boolean {
  return !project || project.visibility === "WORKSPACE" || project.createdById === userId;
}

async function visibleCollection(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  collectionId: string,
  userId: string,
) {
  const collection = await transaction.collection.findFirst({
    where: { id: collectionId, organizationId: workspaceId },
    include: collectionInclude(workspaceId, userId),
  });
  return collection && projectIsVisible(collection.project, userId) ? collection : null;
}

function locatorColumns(locatorValue: SourceLocator | undefined) {
  const range = locatorValue?.pageRange;
  return {
    pageStart: locatorValue?.page ?? range?.[0],
    pageEnd: locatorValue?.page ?? range?.[1],
    sectionId: locatorValue?.sectionId,
    sectionTitle: locatorValue?.sectionTitle,
    paragraphId: locatorValue?.paragraphId,
    figureId: locatorValue?.figureId,
    figureLabel: locatorValue?.figureLabel,
  };
}

const DATABASE_KIND = {
  "direct-evidence": "QUOTE",
  interpretation: "NOTE",
  "open-question": "QUESTION",
} as const;
const DATABASE_STATUS = {
  captured: "CAPTURED",
  "needs-verification": "NEEDS_VERIFICATION",
} as const;
const DATABASE_CONFIDENCE = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  unspecified: "UNSPECIFIED",
} as const;

export function applyEvidenceIdempotencyHeader(request: Request, body: unknown): unknown {
  const headerValue = request.headers.get("idempotency-key")?.trim();
  if (!headerValue) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    validation("A workspace command object is required.");
  }
  const command = body as Record<string, unknown>;
  if (
    command.clientOperationId !== undefined
    && command.clientOperationId !== headerValue
  ) {
    validation("Idempotency-Key must match clientOperationId.");
  }
  return { ...command, clientOperationId: headerValue };
}

export async function createWorkspaceEvidenceNote(
  user: SessionUser,
  workspaceId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<CreateEvidenceNoteResult>> {
  const command = validateCreateEvidenceNoteCommand(rawCommand);
  const hash = digest({ command: "createEvidenceNote", note: command.note, projectId: command.projectId });
  const initialMembership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(initialMembership.role);

  return prisma.$transaction(async (transaction) => {
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    const membership = await commandMembership(transaction, user.id, workspaceId);
    const prior = await priorResult<CreateEvidenceNoteResult>(transaction, {
      workspaceId,
      userId: user.id,
      operationId: command.clientOperationId,
      command: "createEvidenceNote",
      hash,
      revision: membership.organization.revision,
    });
    if (prior) return prior;
    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const workspacePaper = await transaction.workspacePaper.findUnique({
      where: {
        organizationId_paperId: {
          organizationId: workspaceId,
          paperId: command.note.paperId,
        },
      },
      select: { id: true, paperId: true },
    });
    if (!workspacePaper) {
      return failure("not_found", membership.organization.revision, "Evidence paper was not found.");
    }

    const project = await transaction.project.findFirst({
      where: { id: command.projectId, organizationId: workspaceId, ...projectVisibleTo(user.id) },
      select: { id: true },
    });
    if (!project) {
      return failure("not_found", membership.organization.revision, "Evidence project was not found.");
    }
    const filed = await transaction.projectPaper.findFirst({
      where: {
        organizationId: workspaceId,
        projectId: project.id,
        workspacePaperId: workspacePaper.id,
      },
      select: { id: true },
    });
    if (!filed) {
      return failure(
        "validation",
        membership.organization.revision,
        "The evidence paper must be filed in the destination project first.",
      );
    }
    const linkedProjectIds = [project.id];

    const requestedCollectionIds = command.note.collectionIds;
    for (const collectionId of requestedCollectionIds) {
      const collection = await visibleCollection(transaction, workspaceId, collectionId, user.id);
      if (!collection) {
        return failure("not_found", membership.organization.revision, "Evidence collection was not found.");
      }
      if (collection.projectId && !linkedProjectIds.includes(collection.projectId)) {
        return failure(
          "validation",
          membership.organization.revision,
          "Evidence can only be filed in a collection belonging to a linked project.",
        );
      }
    }

    if (!await bumpRevision(transaction, workspaceId, command.expectedVersion)) {
      const current = await transaction.organization.findUniqueOrThrow({
        where: { id: workspaceId }, select: { revision: true },
      });
      return failure(
        "version_conflict",
        current.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const retrievedAt = command.note.provenance.retrievedAt
      ? new Date(command.note.provenance.retrievedAt)
      : new Date();
    const provenancePayload = JSON.parse(JSON.stringify({
      schemaVersion: 1,
      provenance: {
        ...command.note.provenance,
        id: undefined,
        retrievedAt: retrievedAt.toISOString(),
      },
    })) as Prisma.InputJsonObject;
    const createdBase = await transaction.evidenceNote.create({
      data: {
        organizationId: workspaceId,
        workspacePaperId: workspacePaper.id,
        projectId: command.projectId,
        createdById: user.id,
        kind: DATABASE_KIND[command.note.kind],
        status: DATABASE_STATUS[command.note.status as keyof typeof DATABASE_STATUS],
        confidence: DATABASE_CONFIDENCE[command.note.confidence],
        title: command.note.title,
        claim: command.note.claim,
        evidence: command.note.evidence,
        interpretation: command.note.interpretation,
        openQuestion: command.note.openQuestion ?? null,
        linkedHighlightIds: command.note.linkedHighlightIds,
        tags: command.note.tags,
        // Legacy columns remain populated for backward-compatible exports, but
        // the structured columns above are authoritative.
        quote: command.note.evidence,
        text: command.note.claim,
        ...locatorColumns(command.note.provenance.locator),
      },
    });
    if (linkedProjectIds.length) {
      await transaction.projectEvidenceNote.createMany({
        data: linkedProjectIds.map((projectId) => ({
          organizationId: workspaceId,
          projectId,
          evidenceNoteId: createdBase.id,
        })),
      });
    }
    if (requestedCollectionIds.length) {
      await transaction.collectionEvidenceNote.createMany({
        data: requestedCollectionIds.map((collectionId) => ({
          organizationId: workspaceId,
          collectionId,
          evidenceNoteId: createdBase.id,
        })),
      });
    }
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "USER_ASSERTION",
        paperId: workspacePaper.paperId,
        workspacePaperId: workspacePaper.id,
        evidenceNoteId: createdBase.id,
        actorUserId: user.id,
        sourceProvider: command.note.provenance.providerName,
        sourceRecordId: command.note.provenance.sourceId,
        sourceUri: command.note.provenance.sourceUrl,
        retrievedAt,
        payloadDigest: digest(provenancePayload),
        payload: provenancePayload,
      },
    });
    const created = await transaction.evidenceNote.findUniqueOrThrow({
      where: { id: createdBase.id },
      include: evidenceInclude(workspaceId, user.id),
    });
    const note = evidenceNoteDto(created, {
      revision: standaloneEvidenceRevision(created.id),
    });
    if (!note) throw new Error("New structured evidence could not be mapped.");
    if (requestedCollectionIds.length) {
      await transaction.collection.updateMany({
        where: { organizationId: workspaceId, id: { in: requestedCollectionIds } },
        data: { updatedAt: new Date() },
      });
    }
    const result: WorkspaceCommandResult<CreateEvidenceNoteResult> = {
      ok: true,
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      data: {
        note,
        linkedProjectIds,
        updatedCollectionIds: requestedCollectionIds,
      },
    };
    await saveReceipt(transaction, {
      workspaceId,
      userId: user.id,
      operationId: command.clientOperationId,
      command: "createEvidenceNote",
      hash,
      result,
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        action: "evidence.created",
        entityType: "evidence_note",
        entityId: note.id,
        requestId: command.clientOperationId,
        metadata: {
          paperId: command.note.paperId,
          kind: command.note.kind,
          linkedProjectCount: linkedProjectIds.length,
          collectionCount: requestedCollectionIds.length,
          hasLocator: Boolean(command.note.provenance.locator),
        },
      },
    });
    return result;
  });
}

export async function addWorkspacePaperToCollection(
  user: SessionUser,
  workspaceId: string,
  routeCollectionId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<AddPaperToCollectionResult>> {
  const command = validatePaperCollectionCommand(rawCommand, routeCollectionId);
  const hash = digest({ command: "addPaperToCollection", paperId: command.paperId, collectionId: command.collectionId });
  const initialMembership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(initialMembership.role);

  return prisma.$transaction(async (transaction) => {
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    const membership = await commandMembership(transaction, user.id, workspaceId);
    const prior = await priorResult<AddPaperToCollectionResult>(transaction, {
      workspaceId, userId: user.id, operationId: command.clientOperationId,
      command: "addPaperToCollection", hash, revision: membership.organization.revision,
    });
    if (prior) return prior;
    if (membership.organization.revision !== command.expectedVersion) {
      return failure("version_conflict", membership.organization.revision, "Workspace changed since it was loaded. Refresh before retrying.");
    }

    const collection = await visibleCollection(transaction, workspaceId, command.collectionId, user.id);
    const workspacePaper = await transaction.workspacePaper.findUnique({
      where: { organizationId_paperId: { organizationId: workspaceId, paperId: command.paperId } },
      include: { paper: { include: { authors: true, identifiers: true } } },
    });
    if (!collection || !workspacePaper) {
      return failure("not_found", membership.organization.revision, "Collection resource was not found.");
    }
    if (collection.projectId) {
      const filed = await transaction.projectPaper.findFirst({
        where: {
          organizationId: workspaceId,
          projectId: collection.projectId,
          workspacePaperId: workspacePaper.id,
        },
        select: { id: true },
      });
      if (!filed) {
        return failure("validation", membership.organization.revision, "The paper must be filed in the collection's project first.");
      }
    }

    const existing = await transaction.collectionPaper.findUnique({
      where: {
        collectionId_workspacePaperId: {
          collectionId: collection.id,
          workspacePaperId: workspacePaper.id,
        },
      },
    });
    const aggregateVersion = existing
      ? command.expectedVersion
      : command.expectedVersion + 1;
    if (!existing) {
      if (!await bumpRevision(transaction, workspaceId, command.expectedVersion)) {
        const current = await transaction.organization.findUniqueOrThrow({ where: { id: workspaceId }, select: { revision: true } });
        return failure("version_conflict", current.revision, "Workspace changed since it was loaded. Refresh before retrying.");
      }
      await transaction.collectionPaper.create({
        data: {
          organizationId: workspaceId,
          collectionId: collection.id,
          workspacePaperId: workspacePaper.id,
        },
      });
      await transaction.collection.update({
        where: { id: collection.id },
        data: { updatedAt: new Date() },
      });
    }
    const updatedCollection = await transaction.collection.findUniqueOrThrow({
      where: { id: collection.id },
      include: collectionInclude(workspaceId, user.id),
    });
    const result: WorkspaceCommandResult<AddPaperToCollectionResult> = {
      ok: true,
      outcome: existing ? "noop" : "applied",
      aggregateVersion,
      data: {
        paper: paperDto(workspacePaper.paper),
        collection: collectionDto(updatedCollection),
      },
    };
    await saveReceipt(transaction, {
      workspaceId, userId: user.id, operationId: command.clientOperationId,
      command: "addPaperToCollection", hash, result,
    });
    if (!existing) {
      await transaction.auditEvent.create({
        data: {
          organizationId: workspaceId,
          actorUserId: user.id,
          action: "collection.paper_added",
          entityType: "collection",
          entityId: collection.id,
          requestId: command.clientOperationId,
          metadata: { paperId: command.paperId },
        },
      });
    }
    return result;
  });
}

export async function addWorkspaceNoteToCollection(
  user: SessionUser,
  workspaceId: string,
  routeCollectionId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<AddNoteToCollectionResult>> {
  const command = validateNoteCollectionCommand(rawCommand, routeCollectionId);
  const hash = digest({ command: "addNoteToCollection", noteId: command.noteId, collectionId: command.collectionId });
  const initialMembership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(initialMembership.role);

  return prisma.$transaction(async (transaction) => {
    await lockOperation(transaction, workspaceId, command.clientOperationId);
    const membership = await commandMembership(transaction, user.id, workspaceId);
    await lockEvidenceRevision(transaction, workspaceId, command.noteId);

    const collection = await visibleCollection(transaction, workspaceId, command.collectionId, user.id);
    const storedNote = await transaction.evidenceNote.findFirst({
      where: {
        id: command.noteId,
        organizationId: workspaceId,
        revisions: { none: {} },
        ...evidenceVisibleTo(user.id),
      },
      include: evidenceInclude(workspaceId, user.id),
    });
    if (!collection || !storedNote) {
      return failure("not_found", membership.organization.revision, "Collection resource was not found.");
    }
    const completeRevisionChain = await evidenceRevisionChain(
      transaction,
      workspaceId,
      storedNote.id,
    );
    const visibleRevisionNodes = await transaction.evidenceNote.findMany({
      where: {
        organizationId: workspaceId,
        id: { in: completeRevisionChain.map(({ id }) => id) },
        ...evidenceVisibleTo(user.id),
      },
      select: { id: true, supersedesId: true },
    });
    const revisionLineage = deriveEvidenceRevisionLineage(
      visibleRevisionNodes,
    );
    const storedRevision = revisionLineage.get(storedNote.id);
    if (!storedRevision) {
      throw new Error("Structured evidence revision lineage could not be derived.");
    }
    const noteBefore = evidenceNoteDto(storedNote, { revision: storedRevision });
    if (!noteBefore) {
      return failure("not_found", membership.organization.revision, "Collection resource was not found.");
    }
    if (
      collection.projectId
      && storedNote.projectId !== collection.projectId
      && !storedNote.projectMemberships.some((membership) => membership.projectId === collection.projectId)
    ) {
      return failure("validation", membership.organization.revision, "The evidence note must be linked to the collection's project first.");
    }
    // Receipts contain an old read-model snapshot. Re-authorize the requested
    // head first, then rebuild a visibility-safe projection instead of
    // replaying predecessor IDs that may no longer be visible to this actor.
    const prior = await priorResult<AddNoteToCollectionResult>(transaction, {
      workspaceId, userId: user.id, operationId: command.clientOperationId,
      command: "addNoteToCollection", hash, revision: membership.organization.revision,
    });
    if (prior) {
      if (!prior.ok) return prior;
      return {
        ok: true,
        outcome: "replayed",
        aggregateVersion: prior.aggregateVersion,
        data: {
          note: noteBefore,
          collection: collectionDto(collection),
        },
      };
    }
    if (membership.organization.revision !== command.expectedVersion) {
      return failure("version_conflict", membership.organization.revision, "Workspace changed since it was loaded. Refresh before retrying.");
    }

    const existing = await transaction.collectionEvidenceNote.findUnique({
      where: {
        collectionId_evidenceNoteId: {
          collectionId: collection.id,
          evidenceNoteId: storedNote.id,
        },
      },
    });
    const aggregateVersion = existing
      ? command.expectedVersion
      : command.expectedVersion + 1;
    if (!existing) {
      if (!await bumpRevision(transaction, workspaceId, command.expectedVersion)) {
        const current = await transaction.organization.findUniqueOrThrow({ where: { id: workspaceId }, select: { revision: true } });
        return failure("version_conflict", current.revision, "Workspace changed since it was loaded. Refresh before retrying.");
      }
      await transaction.collectionEvidenceNote.create({
        data: {
          organizationId: workspaceId,
          collectionId: collection.id,
          evidenceNoteId: storedNote.id,
        },
      });
      const linkedAt = new Date();
      await transaction.collection.update({
        where: { id: collection.id },
        data: { updatedAt: linkedAt },
      });
    }
    // This transaction can run over a single physical connection in local and
    // constrained deployments, so keep its dependent response reads ordered.
    const updatedStoredNote = await transaction.evidenceNote.findFirstOrThrow({
      where: {
        id: storedNote.id,
        organizationId: workspaceId,
        revisions: { none: {} },
        ...evidenceVisibleTo(user.id),
      },
      include: evidenceInclude(workspaceId, user.id),
    });
    const updatedCollection = await transaction.collection.findUniqueOrThrow({
      where: { id: collection.id },
      include: collectionInclude(workspaceId, user.id),
    });
    const note = evidenceNoteDto(updatedStoredNote, { revision: storedRevision });
    if (!note) throw new Error("Structured evidence could not be mapped after collection filing.");
    const result: WorkspaceCommandResult<AddNoteToCollectionResult> = {
      ok: true,
      outcome: existing ? "noop" : "applied",
      aggregateVersion,
      data: { note, collection: collectionDto(updatedCollection) },
    };
    await saveReceipt(transaction, {
      workspaceId, userId: user.id, operationId: command.clientOperationId,
      command: "addNoteToCollection", hash, result,
    });
    if (!existing) {
      await transaction.auditEvent.create({
        data: {
          organizationId: workspaceId,
          actorUserId: user.id,
          action: "collection.evidence_added",
          entityType: "collection",
          entityId: collection.id,
          requestId: command.clientOperationId,
          metadata: { evidenceNoteId: storedNote.id },
        },
      });
    }
    return result;
  });
}
