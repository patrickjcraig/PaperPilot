import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { uploadConfigurationFromEnvironment } from "@/server/uploads/config";
import { withOpenLocalQuarantineObject } from "@/server/uploads/storage";
import { workspacePaperVisibleTo } from "@/server/workspaces/project-access";
import {
  readerPdfGenerationChanged,
  type ReaderPdfRequestIdentity,
} from "./reader-pdf-request";
import {
  currentAcceptedValidation,
  type ValidationAuthorityAsset,
  type ValidationAuthorityAttestation,
  type ValidationAuthorityDocument,
} from "./validation-authority";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type SelectedAsset = ValidationAuthorityAsset;
type SelectedValidation = ValidationAuthorityAttestation;

interface SelectedDocument extends ValidationAuthorityDocument {
  assets: Array<{ asset: SelectedAsset }>;
}

export interface WorkspacePaperPdf {
  bytes: Buffer;
  documentId: string;
  inputSha256: string;
}

interface ReaderPdfAuthority extends ReaderPdfRequestIdentity {
  assetId: string;
  inputSizeBytes: bigint;
  storageKey: string;
}

function validOpaqueId(value: string): boolean {
  return OPAQUE_ID_PATTERN.test(value) && Buffer.byteLength(value, "utf8") <= 200;
}

function paperNotFound(): HttpProblem {
  return new HttpProblem(404, "paper_not_found", "Paper was not found.");
}

async function resolveReaderPdfAuthority(
  userId: string,
  workspaceId: string,
  paperId: string,
  expected: ReaderPdfRequestIdentity,
): Promise<ReaderPdfAuthority> {
  if (!validOpaqueId(userId) || !validOpaqueId(workspaceId) || !validOpaqueId(paperId)) {
    throw paperNotFound();
  }

  return prisma.$transaction(async (transaction) => {
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId } },
      select: { id: true },
    });
    if (!membership) throw paperNotFound();

    const workspacePaper = await transaction.workspacePaper.findFirst({
      where: {
        paperId,
        ...workspacePaperVisibleTo(userId, workspaceId),
      },
      select: { id: true, paperId: true },
    });
    if (!workspacePaper) throw paperNotFound();

    const document = await transaction.document.findFirst({
      where: {
        organizationId: workspaceId,
        workspacePaperId: workspacePaper.id,
        paperId: workspacePaper.paperId,
        kind: "PAPER_PDF",
        status: "READY",
        archivedAt: null,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        workspacePaperId: true,
        paperId: true,
        kind: true,
        status: true,
        mimeType: true,
        pageCount: true,
        contentHash: true,
        validatedAt: true,
        validationPolicyVersion: true,
        failureCode: true,
        archivedAt: true,
        assets: {
          where: { role: "ORIGINAL" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 2,
          select: {
            asset: {
              select: {
                id: true,
                storageProvider: true,
                objectKey: true,
                physicalLocator: true,
                status: true,
                mimeType: true,
                sizeBytes: true,
                sha256: true,
                scannedAt: true,
                validatedAt: true,
                validationPolicyVersion: true,
                rejectedReason: true,
                rejectionCode: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    }) as SelectedDocument | null;
    if (!document || document.id !== expected.documentId) throw readerPdfGenerationChanged(412);

    const asset = document.assets.length === 1 ? document.assets[0]?.asset : undefined;
    if (!asset || asset.status !== "READY" || asset.deletedAt !== null) {
      throw readerPdfGenerationChanged(409);
    }

    const validation = await transaction.documentValidationAttestation.findFirst({
      where: {
        organizationId: workspaceId,
        documentId: document.id,
        assetId: asset.id,
      },
      orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        jobId: true,
        jobAttemptId: true,
        documentId: true,
        assetId: true,
        inputSha256: true,
        inputSizeBytes: true,
        storageVersion: true,
        policyVersion: true,
        toolchainDigest: true,
        verdict: true,
        rejectionCode: true,
        malwareVerdict: true,
        signaturePublishedAt: true,
        scannedAt: true,
        pdfStructuralVerdict: true,
        pageCount: true,
        objectCount: true,
        revisionCount: true,
        checkedAt: true,
        result: true,
        job: {
          select: {
            id: true,
            type: true,
            status: true,
            documentId: true,
            assetId: true,
            attempts: true,
          },
        },
        jobAttempt: {
          select: { id: true, jobId: true, status: true, attemptNumber: true },
        },
      },
    }) as SelectedValidation | null;
    if (validation?.inputSha256 !== expected.inputSha256) throw readerPdfGenerationChanged(412);
    if (!validation || !currentAcceptedValidation(validation, document, asset, { requireLinkedPaper: true })) {
      throw readerPdfGenerationChanged(409);
    }

    return {
      documentId: document.id,
      inputSha256: validation.inputSha256,
      inputSizeBytes: validation.inputSizeBytes,
      assetId: asset.id,
      storageKey: asset.objectKey,
    };
  }, { isolationLevel: "RepeatableRead" });
}

function sameAuthority(left: ReaderPdfAuthority, right: ReaderPdfAuthority): boolean {
  return left.documentId === right.documentId
    && left.inputSha256 === right.inputSha256
    && left.inputSizeBytes === right.inputSizeBytes
    && left.assetId === right.assetId
    && left.storageKey === right.storageKey;
}

export async function getWorkspacePaperPdf(
  userId: string,
  workspaceId: string,
  paperId: string,
  expected: ReaderPdfRequestIdentity,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<WorkspacePaperPdf> {
  const authority = await resolveReaderPdfAuthority(userId, workspaceId, paperId, expected);
  const configuration = uploadConfigurationFromEnvironment(environment);
  const bytes = await withOpenLocalQuarantineObject(
    configuration,
    authority.storageKey,
    { organizationId: workspaceId, assetId: authority.assetId },
    async (object) => {
      if (object.sizeBytes !== authority.inputSizeBytes) throw readerPdfGenerationChanged(409);
      const content = await object.handle.readFile();
      if (
        BigInt(content.byteLength) !== authority.inputSizeBytes
        || createHash("sha256").update(content).digest("hex") !== authority.inputSha256
      ) throw readerPdfGenerationChanged(409);
      return content;
    },
  );

  const confirmed = await resolveReaderPdfAuthority(userId, workspaceId, paperId, expected);
  if (!sameAuthority(authority, confirmed)) throw readerPdfGenerationChanged(412);
  return {
    bytes,
    documentId: confirmed.documentId,
    inputSha256: confirmed.inputSha256,
  };
}
