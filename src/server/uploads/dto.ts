import "server-only";

import type { UploadStatusDto } from "@/lib/workspace";
import type { Prisma } from "@/generated/prisma/client";
import type { DocumentExtractionLifecycle } from "@/server/documents/extraction-authority";
import { HttpProblem } from "@/server/http/problem";
import {
  documentUploadStage,
  inboxEntryDto,
  type InboxReaderAuthority,
} from "@/server/workspaces/import-dto";

export const uploadStatusInclude = {
  asset: true,
  document: true,
  inboxEntry: {
    include: {
      provenanceRecords: {
        select: { kind: true, paperId: true },
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
    },
  },
} satisfies Prisma.UploadSessionInclude;

export type UploadSessionForStatus = Prisma.UploadSessionGetPayload<{
  include: typeof uploadStatusInclude;
}>;

function assetStatus(status: UploadSessionForStatus["asset"]["status"]): UploadStatusDto["asset"]["status"] {
  switch (status) {
    case "UPLOADING": return "uploading";
    case "QUARANTINED": return "quarantined";
    case "SCANNING": return "scanning";
    case "READY": return "ready";
    case "REJECTED": return "rejected";
    case "DELETED": return "deleted";
  }
}

function documentStatus(
  status: NonNullable<UploadSessionForStatus["document"]>["status"],
): UploadStatusDto["document"]["status"] {
  switch (status) {
    case "PENDING": return "pending";
    case "PROCESSING": return "processing";
    case "READY": return "ready";
    case "FAILED": return "failed";
    case "ARCHIVED": return "archived";
  }
}

export function uploadStatusDto(
  session: UploadSessionForStatus,
  readerAuthority?: InboxReaderAuthority,
  documentExtractionAuthority?: DocumentExtractionLifecycle,
): UploadStatusDto {
  if (!session.document || !session.inboxEntry) {
    throw new HttpProblem(500, "invalid_upload_state", "Stored upload state is invalid.");
  }
  const inboxEntry = inboxEntryDto(
    session.inboxEntry,
    readerAuthority,
    documentExtractionAuthority,
  );
  if (!inboxEntry || inboxEntry.entryKind !== "document-upload") {
    throw new HttpProblem(500, "invalid_upload_state", "Stored upload state is invalid.");
  }
  if (session.asset.sizeBytes !== null && session.asset.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpProblem(500, "invalid_upload_state", "Stored upload state is invalid.");
  }
  const stage = documentUploadStage({
    status: session.status,
    failureCode: session.failureCode,
    asset: {
      status: session.asset.status,
      rejectionCode: session.asset.rejectionCode,
    },
    document: {
      status: session.document.status,
      failureCode: session.document.failureCode,
    },
  });
  return {
    inboxEntry,
    upload: {
      id: session.id,
      status: stage,
      expiresAt: session.expiresAt.toISOString(),
    },
    asset: {
      status: assetStatus(session.asset.status),
      sizeBytes: session.asset.sizeBytes === null ? undefined : Number(session.asset.sizeBytes),
    },
    document: {
      id: session.document.id,
      status: documentStatus(session.document.status),
    },
  };
}
