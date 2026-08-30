import "server-only";

import { createHash } from "node:crypto";

import type {
  WorkspaceCommandFailure,
  WorkspaceCommandResult,
} from "@/lib/workspace";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { acquireWorkspaceMembershipAuthorityShared } from "@/server/workspaces/membership-lock";
import {
  projectVisibleTo,
  requireWorkspaceMutationRole,
} from "@/server/workspaces/project-access";
import { crawlerInboxLifecyclePayload } from "./intake-lifecycle";
import { currentAcceptedValidation } from "./validation-authority";

export const MAX_DOCUMENT_PAPER_LINK_COMMAND_BYTES = 8 * 1_024;

const COMMAND_NAME = "linkValidatedDocumentToWorkspacePaper";
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TRANSACTION_ATTEMPTS = 4;
const COMMAND_KEYS = new Set([
  "clientOperationId",
  "expectedVersion",
  "paperId",
]);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

const LINK_TARGET_NOT_FOUND_MESSAGE = "Document link target was not found.";
const DOCUMENT_NOT_LINKABLE_MESSAGE =
  "The document is not a current validated PDF source.";
const DOCUMENT_LINK_CONFLICT_MESSAGE =
  "The document or paper already has an active PDF link.";

interface SessionUser {
  id: string;
  name: string;
}

export interface LinkValidatedDocumentCommand {
  clientOperationId: string;
  expectedVersion: number;
  paperId: string;
}

export interface LinkValidatedDocumentResult {
  paperId: string;
  documentId: string;
}

function validation(message: string): never {
  throw new HttpProblem(400, "validation", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    validation(`${label} is invalid.`);
  }
  return value;
}

export function validateLinkValidatedDocumentCommand(
  value: unknown,
): LinkValidatedDocumentCommand {
  if (!isRecord(value)) validation("A document link command object is required.");
  const unsupported = Object.keys(value).find((key) => !COMMAND_KEYS.has(key));
  if (unsupported) {
    validation(`Document link command contains an unsupported field: ${unsupported}.`);
  }
  if (Object.keys(value).length !== COMMAND_KEYS.size) {
    validation("Document link command must contain exactly the required fields.");
  }
  if (
    typeof value.expectedVersion !== "number"
    || !Number.isSafeInteger(value.expectedVersion)
    || value.expectedVersion < 0
  ) {
    validation("expectedVersion must be a non-negative integer.");
  }
  return {
    clientOperationId: requireOpaqueId(value.clientOperationId, "clientOperationId"),
    expectedVersion: value.expectedVersion,
    paperId: requireOpaqueId(value.paperId, "paperId"),
  };
}

export function applyDocumentPaperLinkIdempotencyHeader(
  request: Request,
  body: unknown,
): unknown {
  const headerOperationId = request.headers.get("idempotency-key")?.trim();
  if (!headerOperationId) return body;
  if (!OPAQUE_ID_PATTERN.test(headerOperationId)) {
    validation("Idempotency-Key is invalid.");
  }
  if (
    !isRecord(body)
    || typeof body.clientOperationId !== "string"
    || body.clientOperationId !== headerOperationId
  ) {
    throw new HttpProblem(
      400,
      "idempotency_mismatch",
      "Idempotency-Key must match clientOperationId.",
    );
  }
  return body;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
): WorkspaceCommandResult<LinkValidatedDocumentResult> | null {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.data)) {
    return null;
  }
  if (
    typeof response.data.paperId !== "string"
    || !OPAQUE_ID_PATTERN.test(response.data.paperId)
    || typeof response.data.documentId !== "string"
    || !OPAQUE_ID_PATTERN.test(response.data.documentId)
  ) {
    return null;
  }
  return {
    ok: true,
    outcome: "replayed",
    aggregateVersion,
    data: {
      paperId: response.data.paperId,
      documentId: response.data.documentId,
    },
  };
}

function retryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2002" || error.code === "P2034");
}

async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!retryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) {
        if (retryableTransactionError(error)) {
          throw new HttpProblem(
            409,
            "concurrent_document_link_conflict",
            "The document link changed concurrently. Refresh before retrying.",
          );
        }
        throw error;
      }
    }
  }
  throw new HttpProblem(
    409,
    "concurrent_document_link_conflict",
    "The document link could not be resolved safely.",
  );
}

export async function linkValidatedDocumentToWorkspacePaper(
  user: SessionUser,
  workspaceId: string,
  documentId: string,
  rawCommand: unknown,
): Promise<WorkspaceCommandResult<LinkValidatedDocumentResult>> {
  const command = validateLinkValidatedDocumentCommand(rawCommand);
  if (!OPAQUE_ID_PATTERN.test(workspaceId)) {
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }
  const initialMembership = await requireWorkspaceMembership(user.id, workspaceId);
  requireWorkspaceMutationRole(initialMembership.role);
  if (!OPAQUE_ID_PATTERN.test(documentId)) {
    return failure(
      "not_found",
      initialMembership.organization.revision,
      LINK_TARGET_NOT_FOUND_MESSAGE,
    );
  }
  const requestHash = digest({
    command: COMMAND_NAME,
    documentId,
    paperId: command.paperId,
  });

  return withTransactionRetry(() => prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`document-paper-link:${workspaceId}:${command.clientOperationId}`},
          0
        )
      )::text
    `;

    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, user.id);
    const membership = await transaction.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: workspaceId,
          userId: user.id,
        },
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
        || prior.requestHash !== requestHash
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

    if (membership.organization.revision !== command.expectedVersion) {
      return failure(
        "version_conflict",
        membership.organization.revision,
        "Workspace changed since it was loaded. Refresh before retrying.",
      );
    }

    const visibleProject = projectVisibleTo(user.id);
    const document = await transaction.document.findFirst({
      where: { id: documentId, organizationId: workspaceId },
      include: {
        assets: {
          where: { organizationId: workspaceId, role: "ORIGINAL" },
          include: { asset: true },
        },
        inboxEntries: {
          where: {
            organizationId: workspaceId,
            source: { in: ["FILE_UPLOAD", "CRAWLER"] },
          },
        },
        documentIntake: {
          include: {
            uploadSession: {
              select: {
                id: true,
                status: true,
                intakeId: true,
                documentId: true,
                assetId: true,
                inboxEntryId: true,
              },
            },
            crawlerImport: {
              select: {
                id: true,
                status: true,
                intakeId: true,
                documentId: true,
                assetId: true,
                inboxEntryId: true,
                importBatchId: true,
              },
            },
          },
        },
        ingestReceipt: {
          select: {
            id: true,
            source: true,
            intakeId: true,
            documentId: true,
            assetId: true,
            inboxEntryId: true,
            importBatchId: true,
            uploadSessionId: true,
            uploadAttemptId: true,
            ingressAttemptId: true,
            crawlerImportId: true,
            declaredMimeType: true,
          },
        },
      },
    });
    const workspacePaper = await transaction.workspacePaper.findFirst({
      where: {
        organizationId: workspaceId,
        paperId: command.paperId,
        OR: [
          { projectPapers: { none: {} } },
          {
            projectPapers: {
              some: {
                organizationId: workspaceId,
                project: { organizationId: workspaceId, ...visibleProject },
              },
            },
          },
        ],
      },
      select: { id: true, paperId: true },
    });
    if (!document || !workspacePaper) {
      return failure(
        "not_found",
        membership.organization.revision,
        LINK_TARGET_NOT_FOUND_MESSAGE,
      );
    }

    if (document.paperId !== null || document.workspacePaperId !== null) {
      return failure(
        "duplicate",
        membership.organization.revision,
        DOCUMENT_LINK_CONFLICT_MESSAGE,
      );
    }
    const activePaperDocument = await transaction.document.findFirst({
      where: {
        organizationId: workspaceId,
        id: { not: document.id },
        kind: "PAPER_PDF",
        status: { not: "ARCHIVED" },
        OR: [
          { paperId: workspacePaper.paperId },
          { workspacePaperId: workspacePaper.id },
        ],
      },
      select: { id: true },
    });
    if (activePaperDocument) {
      return failure(
        "duplicate",
        membership.organization.revision,
        DOCUMENT_LINK_CONFLICT_MESSAGE,
      );
    }

    const original = document.assets.length === 1 ? document.assets[0] : undefined;
    const inboxEntry = document.inboxEntries.length === 1
      ? document.inboxEntries[0]
      : undefined;
    const intake = document.documentIntake;
    const receipt = document.ingestReceipt;
    if (
      !original
      || !inboxEntry
      || inboxEntry.status !== "NEEDS_REVIEW"
      || inboxEntry.workspacePaperId !== null
      || inboxEntry.resolvedAt !== null
    ) {
      return failure(
        "validation",
        membership.organization.revision,
        DOCUMENT_NOT_LINKABLE_MESSAGE,
      );
    }

    const commonSourceAuthority = intake
      && receipt
      && intake.organizationId === workspaceId
      && intake.documentId === document.id
      && intake.assetId === original.asset.id
      && intake.inboxEntryId === inboxEntry.id
      && receipt.intakeId === intake.id
      && receipt.documentId === document.id
      && receipt.assetId === original.asset.id
      && receipt.inboxEntryId === inboxEntry.id
      && receipt.declaredMimeType === "application/pdf";
    const browserUpload = intake?.uploadSession;
    const crawlerImport = intake?.crawlerImport;
    const browserUploadAuthority = commonSourceAuthority
      && inboxEntry.source === "FILE_UPLOAD"
      && intake.source === "BROWSER_UPLOAD"
      && (intake.status === "EXTRACTING" || intake.status === "READY" || intake.status === "ATTENTION")
      && receipt.source === "BROWSER_UPLOAD"
      && receipt.importBatchId === null
      && receipt.crawlerImportId === null
      && receipt.ingressAttemptId === null
      && receipt.uploadSessionId !== null
      && receipt.uploadAttemptId !== null
      && browserUpload?.id === receipt.uploadSessionId
      && browserUpload.status === "STORED"
      && browserUpload.intakeId === intake.id
      && browserUpload.documentId === document.id
      && browserUpload.assetId === original.asset.id
      && browserUpload.inboxEntryId === inboxEntry.id
      && crawlerImport === null;
    const crawlerPayload = crawlerImport
      ? crawlerInboxLifecyclePayload(inboxEntry.payload, crawlerImport.id)
      : null;
    const crawlerAuthority = commonSourceAuthority
      && inboxEntry.source === "CRAWLER"
      && intake.source === "CRAWLER"
      && intake.status === "READY"
      && receipt.source === "CRAWLER"
      && receipt.uploadSessionId === null
      && receipt.uploadAttemptId === null
      && receipt.ingressAttemptId !== null
      && receipt.crawlerImportId === crawlerImport?.id
      && receipt.importBatchId === crawlerImport?.importBatchId
      && inboxEntry.importBatchId === crawlerImport?.importBatchId
      && crawlerImport?.status === "READY"
      && crawlerImport.intakeId === intake.id
      && crawlerImport.documentId === document.id
      && crawlerImport.assetId === original.asset.id
      && crawlerImport.inboxEntryId === inboxEntry.id
      && crawlerPayload?.importStatus === "READY"
      && crawlerPayload.phase === "ready"
      && browserUpload === null;
    if (!browserUploadAuthority && !crawlerAuthority) {
      return failure(
        "validation",
        membership.organization.revision,
        DOCUMENT_NOT_LINKABLE_MESSAGE,
      );
    }

    const validationAttestation = await transaction.documentValidationAttestation.findFirst({
      where: {
        organizationId: workspaceId,
        documentId: document.id,
        assetId: original.asset.id,
      },
      include: { job: true, jobAttempt: true },
      orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    if (
      !validationAttestation
      || validationAttestation.ingestReceiptId !== receipt?.id
      || !currentAcceptedValidation(validationAttestation, document, original.asset)
    ) {
      return failure(
        "validation",
        membership.organization.revision,
        DOCUMENT_NOT_LINKABLE_MESSAGE,
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

    await transaction.document.update({
      where: {
        organizationId_id: {
          organizationId: workspaceId,
          id: document.id,
        },
      },
      data: {
        paperId: workspacePaper.paperId,
        workspacePaperId: workspacePaper.id,
      },
    });
    const now = new Date();
    await transaction.inboxEntry.update({
      where: {
        organizationId_id: {
          organizationId: workspaceId,
          id: inboxEntry.id,
        },
      },
      data: {
        workspacePaperId: workspacePaper.id,
        status: "IMPORTED",
        resolvedAt: now,
        failureCode: null,
        failureMessage: null,
      },
    });

    const sourceAuthority = crawlerAuthority
      ? {
          kind: "crawler" as const,
          provider: "PaperPilot governed crawler document link",
          sourceRecordId: crawlerImport!.id,
          payload: {
            schemaVersion: 1,
            source: "governed-crawler-document",
            crawlerImportId: crawlerImport!.id,
            validationAttestationId: validationAttestation.id,
            inputSha256: validationAttestation.inputSha256,
            inputSizeBytes: validationAttestation.inputSizeBytes.toString(),
            storageVersion: validationAttestation.storageVersion,
            validationPolicyVersion: validationAttestation.policyVersion,
          } as const,
        }
      : {
          kind: "upload" as const,
          provider: "PaperPilot validated document link",
          sourceRecordId: validationAttestation.id,
          payload: {
            schemaVersion: 1,
            source: "validated-file-upload",
            assetId: original.asset.id,
            validationAttestationId: validationAttestation.id,
            inputSha256: validationAttestation.inputSha256,
            inputSizeBytes: validationAttestation.inputSizeBytes.toString(),
            storageVersion: validationAttestation.storageVersion,
            validationPolicyVersion: validationAttestation.policyVersion,
          } as const,
        };
    const provenancePayload = sourceAuthority.payload;
    await transaction.provenanceRecord.create({
      data: {
        organizationId: workspaceId,
        kind: "IMPORT",
        paperId: workspacePaper.paperId,
        workspacePaperId: workspacePaper.id,
        inboxEntryId: inboxEntry.id,
        documentId: document.id,
        actorUserId: user.id,
        sourceProvider: sourceAuthority.provider,
        sourceRecordId: sourceAuthority.sourceRecordId,
        retrievedAt: now,
        payloadDigest: digest(provenancePayload),
        payload: provenancePayload,
      },
    });

    const result: WorkspaceCommandResult<LinkValidatedDocumentResult> = {
      ok: true,
      outcome: "applied",
      aggregateVersion: command.expectedVersion + 1,
      data: {
        paperId: workspacePaper.paperId,
        documentId: document.id,
      },
    };
    await transaction.idempotencyRecord.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        key: command.clientOperationId,
        command: COMMAND_NAME,
        requestHash,
        response: result as unknown as Prisma.InputJsonValue,
        status: "COMPLETED",
        completedAt: now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
    await transaction.auditEvent.create({
      data: {
        organizationId: workspaceId,
        actorUserId: user.id,
        action: "document.paper.linked",
        entityType: "document",
        entityId: document.id,
        requestId: command.clientOperationId,
        metadata: {
          source: sourceAuthority.kind,
          paperId: workspacePaper.paperId,
          workspacePaperId: workspacePaper.id,
          inboxEntryId: inboxEntry.id,
          assetId: original.asset.id,
          validationAttestationId: validationAttestation.id,
          ...(crawlerAuthority ? { crawlerImportId: crawlerImport!.id } : {}),
        },
      },
    });
    return result;
  }, { isolationLevel: "Serializable" }));
}
