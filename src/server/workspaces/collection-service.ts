import "server-only";

import { createHash } from "node:crypto";
import type {
  CreateCollectionResult,
  WorkspaceCommandFailure,
  WorkspaceCommandResult,
} from "@/lib/workspace";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { validateCreateCollectionCommand } from "./collection-command";
import { acquireWorkspaceMembershipAuthorityShared } from "./membership-lock";
import { collectionDto } from "./service";
import { projectVisibleTo, requireWorkspaceMutationRole } from "./project-access";

const COMMAND_NAME = "createCollection";
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface SessionUser {
  id: string;
  name: string;
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

function requestHash(payload: unknown): string {
  return createHash("sha256")
    .update(stableJson({ command: COMMAND_NAME, payload }))
    .digest("hex");
}

function failure(
  code: WorkspaceCommandFailure["code"],
  aggregateVersion: number,
  message: string,
): WorkspaceCommandFailure {
  return { ok: false, code, aggregateVersion, message };
}

function replayedResult(
  response: unknown,
  aggregateVersion: number,
): WorkspaceCommandResult<CreateCollectionResult> | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const candidate = response as { ok?: unknown; data?: CreateCollectionResult };
  if (
    candidate.ok !== true
    || !candidate.data?.collection?.id
    || typeof candidate.data.projectId !== "string"
  ) {
    return null;
  }
  return {
    ok: true,
    outcome: "replayed",
    aggregateVersion,
    data: candidate.data,
  };
}

export async function createWorkspaceCollection(
  user: SessionUser,
  workspaceId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<CreateCollectionResult>> {
  const command = validateCreateCollectionCommand(rawCommand);
  const hash = requestHash({
    projectId: command.projectId,
    name: command.name,
    description: command.description,
    color: command.color,
  });

  return prisma.$transaction(async (transaction) => {
    // Serialize identical operation IDs before reading their receipt. This
    // turns concurrent browser retries into one applied command plus exact
    // replays instead of exposing a transient workspace-version conflict.
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
      if (
        prior.actorUserId !== user.id
        || prior.command !== COMMAND_NAME
        || prior.requestHash !== hash
      ) {
        return failure(
          "idempotency_conflict",
          membership.organization.revision,
          "clientOperationId was already used for a different command.",
        );
      }
      return replayedResult(prior.response, membership.organization.revision)
        ?? failure(
          "version_conflict",
          membership.organization.revision,
          "The prior command is still being resolved. Refresh before retrying.",
        );
    }

    const project = await transaction.project.findFirst({
      where: {
        id: command.projectId,
        organizationId: workspaceId,
        ...projectVisibleTo(user.id),
      },
      select: { id: true },
    });
    if (!project) {
      return failure(
        "not_found",
        membership.organization.revision,
        "Destination project was not found.",
      );
    }

    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    // PostgreSQL treats NULLs as distinct in ordinary unique constraints. The
    // root collection parent is NULL, so enforce case-insensitive sibling-name
    // uniqueness in the same transaction protected by the workspace revision CAS.
    const duplicate = await transaction.collection.findFirst({
      where: {
        organizationId: workspaceId,
        projectId: project.id,
        parentId: null,
        name: { equals: command.name, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (duplicate) {
      return failure(
        "duplicate",
        membership.organization.revision,
        "A collection with that name already exists in this project.",
      );
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
      return failure(
        "version_conflict",
        current.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const collection = await transaction.collection.create({
      data: {
        organizationId: workspaceId,
        projectId: project.id,
        parentId: null,
        name: command.name,
        description: command.description || null,
        color: command.color,
        createdById: user.id,
      },
      include: {
        paperMemberships: {
          where: { organizationId: workspaceId },
          include: { workspacePaper: { select: { paperId: true } } },
        },
        evidenceMemberships: {
          where: { organizationId: workspaceId },
          include: {
            evidenceNote: { select: { kind: true, openQuestion: true, supersedesId: true } },
          },
        },
      },
    });
    const result: WorkspaceCommandResult<CreateCollectionResult> = {
      ok: true,
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      data: {
        collection: collectionDto(collection),
        projectId: project.id,
      },
    };

    await transaction.idempotencyRecord.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        key: command.clientOperationId,
        command: COMMAND_NAME,
        requestHash: hash,
        response: result as unknown as Prisma.InputJsonValue,
        status: "COMPLETED",
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        action: "collection.created",
        entityType: "collection",
        entityId: collection.id,
        requestId: command.clientOperationId,
        metadata: {
          projectId: project.id,
          color: command.color,
        },
      },
    });
    return result;
  });
}
