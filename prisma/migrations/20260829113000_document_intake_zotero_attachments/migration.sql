-- CreateEnum
CREATE TYPE "ZoteroFileAccessStatus" AS ENUM ('AVAILABLE', 'UNKNOWN', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ZoteroAttachmentIngestMode" AS ENUM ('DISABLED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ZoteroAttachmentEligibility" AS ENUM ('DOWNLOADABLE', 'INELIGIBLE', 'MALFORMED');

-- CreateEnum
CREATE TYPE "ZoteroAttachmentImportStatus" AS ENUM ('QUEUED', 'DOWNLOADING', 'QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentIntakeStatus" AS ENUM ('RESERVED', 'QUEUED', 'RECEIVING', 'QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentIngressAttemptStatus" AS ENUM ('RECEIVING', 'WRITTEN', 'ADOPTED', 'ABANDONED', 'FAILED');

-- DropForeignKey
ALTER TABLE "DocumentIngestReceipt" DROP CONSTRAINT "DocumentIngestReceipt_organizationId_zoteroLibraryId_fkey";

-- DropForeignKey
ALTER TABLE "DocumentIngestReceipt" DROP CONSTRAINT "DocumentIngestReceipt_organizationId_zoteroObjectId_fkey";

-- DropForeignKey
ALTER TABLE "UploadAttempt" DROP CONSTRAINT "UploadAttempt_organizationId_uploadSessionId_fkey";

-- AlterTable
ALTER TABLE "DocumentIngestReceipt" ADD COLUMN     "ingressAttemptId" TEXT,
ADD COLUMN     "intakeId" TEXT,
ADD COLUMN     "legacyTransportAttestation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "uploadAttemptId" TEXT,
ADD COLUMN     "zoteroAttachmentImportId" TEXT;

-- AlterTable
ALTER TABLE "IntegrationConnection" ADD COLUMN     "credentialGeneration" INTEGER NOT NULL DEFAULT 0;

UPDATE "IntegrationConnection"
SET "credentialGeneration" = 1
WHERE "credentialCiphertext" IS NOT NULL
   OR "credentialFingerprint" IS NOT NULL
   OR "credentialKeyVersion" IS NOT NULL;

ALTER TABLE "IntegrationConnection"
    ADD CONSTRAINT "IntegrationConnection_credential_generation_check"
        CHECK (
            "credentialGeneration" >= 0
            AND ("credentialCiphertext" IS NULL OR "credentialGeneration" > 0)
        );

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "intakeId" TEXT;

-- AlterTable
ALTER TABLE "UploadSession" ADD COLUMN     "intakeId" TEXT;

-- AlterTable
ALTER TABLE "ZoteroLibrary"
    ADD COLUMN "fileAccessStatus" "ZoteroFileAccessStatus" NOT NULL DEFAULT 'UNKNOWN';

UPDATE "ZoteroLibrary"
SET "fileAccessStatus" = CASE
    WHEN NOT "isReadable" THEN 'UNAVAILABLE'::"ZoteroFileAccessStatus"
    WHEN "filesEditable" THEN 'AVAILABLE'::"ZoteroFileAccessStatus"
    ELSE 'UNKNOWN'::"ZoteroFileAccessStatus"
END;

ALTER TABLE "ZoteroLibrary" DROP COLUMN "filesEditable";

-- CreateTable
CREATE TABLE "ZoteroAttachmentPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationConnectionId" TEXT NOT NULL,
    "mode" "ZoteroAttachmentIngestMode" NOT NULL DEFAULT 'DISABLED',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "configuredById" TEXT,
    "configuredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoteroAttachmentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoteroAttachment" (
    "zoteroObjectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "zoteroLibraryId" TEXT NOT NULL,
    "parentKey" VARCHAR(64),
    "linkMode" VARCHAR(32),
    "contentType" VARCHAR(255),
    "fileName" VARCHAR(255),
    "providerMd5" CHAR(32),
    "providerMtime" VARCHAR(32),
    "sourceVersion" VARCHAR(128) NOT NULL,
    "metadataHash" CHAR(64) NOT NULL,
    "eligibility" "ZoteroAttachmentEligibility" NOT NULL,
    "reasonCode" VARCHAR(100),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoteroAttachment_pkey" PRIMARY KEY ("zoteroObjectId")
);

-- CreateTable
CREATE TABLE "ZoteroAttachmentImport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationConnectionId" TEXT NOT NULL,
    "zoteroLibraryId" TEXT NOT NULL,
    "zoteroObjectId" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "requestedById" TEXT,
    "clientOperationId" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "credentialGeneration" INTEGER NOT NULL,
    "sourceVersion" VARCHAR(128) NOT NULL,
    "sourceMetadataHash" CHAR(64) NOT NULL,
    "providerMd5" CHAR(32) NOT NULL,
    "status" "ZoteroAttachmentImportStatus" NOT NULL DEFAULT 'QUEUED',
    "downloadJobId" TEXT,
    "failureCode" VARCHAR(100),
    "retryAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "quarantinedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoteroAttachmentImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentIntake" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" "DocumentIngestSource" NOT NULL,
    "status" "DocumentIntakeStatus" NOT NULL DEFAULT 'RESERVED',
    "documentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "inboxEntryId" TEXT,
    "importBatchId" TEXT,
    "createdById" TEXT,
    "reservedBytes" BIGINT NOT NULL,
    "committedBytes" BIGINT,
    "policyRevision" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(100),
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "quotaReleasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentIngressAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobAttemptId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storageVersion" VARCHAR(128) NOT NULL,
    "status" "DocumentIngressAttemptStatus" NOT NULL DEFAULT 'RECEIVING',
    "maximumSizeBytes" BIGINT NOT NULL,
    "expectedSizeBytes" BIGINT,
    "receivedSizeBytes" BIGINT,
    "providerMd5" CHAR(32),
    "computedMd5" CHAR(32),
    "sha256" CHAR(64),
    "leaseId" VARCHAR(200) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "storedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureCode" VARCHAR(100),
    "cleanupCompletedAt" TIMESTAMP(3),
    "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "cleanupAfter" TIMESTAMP(3),
    "cleanupFailureCode" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentIngressAttempt_pkey" PRIMARY KEY ("id")
);

-- Expand/backfill/contract: every historical browser session receives one
-- deterministic source-neutral reservation before intakeId becomes required.
ALTER TABLE "DocumentIntake"
    ADD CONSTRAINT "DocumentIntake_bytes_check"
        CHECK (
            "reservedBytes" > 0
            AND (
                "committedBytes" IS NULL
                OR ("committedBytes" > 0 AND "committedBytes" <= "reservedBytes")
            )
        ),
    ADD CONSTRAINT "DocumentIntake_policy_revision_check"
        CHECK ("policyRevision" >= 0),
    ADD CONSTRAINT "DocumentIntake_terminal_shape_check"
        CHECK (
            (
                "status" IN ('READY', 'FAILED', 'CANCELLED')
                AND "completedAt" IS NOT NULL
            )
            OR (
                "status" NOT IN ('READY', 'FAILED', 'CANCELLED')
                AND "completedAt" IS NULL
            )
        ),
    ADD CONSTRAINT "DocumentIntake_committed_state_check"
        CHECK (
            "status" NOT IN ('QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION')
            OR "committedBytes" IS NOT NULL
        ),
    ADD CONSTRAINT "DocumentIntake_cancel_shape_check"
        CHECK (
            ("status" = 'CANCEL_REQUESTED' AND "cancelRequestedAt" IS NOT NULL AND "cancelledAt" IS NULL)
            OR ("status" = 'CANCELLED' AND "cancelRequestedAt" IS NOT NULL AND "cancelledAt" IS NOT NULL)
            OR ("status" NOT IN ('CANCEL_REQUESTED', 'CANCELLED') AND "cancelRequestedAt" IS NULL AND "cancelledAt" IS NULL)
        ),
    ADD CONSTRAINT "DocumentIntake_failure_shape_check"
        CHECK (
            ("status" = 'FAILED' AND "failureCode" IS NOT NULL)
            OR "status" IN ('ATTENTION')
            OR ("status" NOT IN ('FAILED', 'ATTENTION') AND "failureCode" IS NULL)
        ),
    ADD CONSTRAINT "DocumentIntake_quota_release_check"
        CHECK ("quotaReleasedAt" IS NULL OR "completedAt" IS NOT NULL);

ALTER TABLE "DocumentIngressAttempt"
    ADD CONSTRAINT "DocumentIngressAttempt_number_check"
        CHECK (
            "attemptNumber" > 0
            AND "maximumSizeBytes" > 0
            AND ("expectedSizeBytes" IS NULL OR ("expectedSizeBytes" > 0 AND "expectedSizeBytes" <= "maximumSizeBytes"))
            AND ("receivedSizeBytes" IS NULL OR ("receivedSizeBytes" > 0 AND "receivedSizeBytes" <= "maximumSizeBytes"))
            AND "cleanupAttemptCount" >= 0
        ),
    ADD CONSTRAINT "DocumentIngressAttempt_digest_check"
        CHECK (
            ("providerMd5" IS NULL OR "providerMd5" ~ '^[0-9a-f]{32}$')
            AND ("computedMd5" IS NULL OR "computedMd5" ~ '^[0-9a-f]{32}$')
            AND ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
        ),
    ADD CONSTRAINT "DocumentIngressAttempt_written_shape_check"
        CHECK (
            "status" NOT IN ('WRITTEN', 'ADOPTED')
            OR (
                "receivedSizeBytes" IS NOT NULL
                AND "computedMd5" IS NOT NULL
                AND "sha256" IS NOT NULL
                AND "storedAt" IS NOT NULL
            )
        ),
    ADD CONSTRAINT "DocumentIngressAttempt_terminal_shape_check"
        CHECK (
            ("status" IN ('ADOPTED', 'ABANDONED', 'FAILED') AND "completedAt" IS NOT NULL)
            OR ("status" IN ('RECEIVING', 'WRITTEN') AND "completedAt" IS NULL)
        ),
    ADD CONSTRAINT "DocumentIngressAttempt_failure_shape_check"
        CHECK (
            ("status" IN ('ABANDONED', 'FAILED') AND "failureCode" IS NOT NULL)
            OR ("status" IN ('RECEIVING', 'WRITTEN', 'ADOPTED') AND "failureCode" IS NULL)
        );

ALTER TABLE "ZoteroAttachmentPolicy"
    ADD CONSTRAINT "ZoteroAttachmentPolicy_revision_check"
        CHECK ("revision" >= 0),
    ADD CONSTRAINT "ZoteroAttachmentPolicy_configuration_check"
        CHECK ("mode" <> 'MANUAL' OR "configuredAt" IS NOT NULL);

ALTER TABLE "ZoteroAttachment"
    ADD CONSTRAINT "ZoteroAttachment_hash_check"
        CHECK (
            "metadataHash" ~ '^[0-9a-f]{64}$'
            AND ("providerMd5" IS NULL OR "providerMd5" ~ '^[0-9a-f]{32}$')
            AND ("providerMtime" IS NULL OR "providerMtime" ~ '^(0|[1-9][0-9]*)$')
        ),
    ADD CONSTRAINT "ZoteroAttachment_projection_shape_check"
        CHECK (
            (
                "eligibility" = 'DOWNLOADABLE'
                AND "linkMode" IN ('imported_file', 'imported_url')
                AND "contentType" = 'application/pdf'
                AND lower(right("fileName", 4)) = '.pdf'
                AND "providerMd5" IS NOT NULL
                AND "reasonCode" IS NULL
            )
            OR (
                "eligibility" IN ('INELIGIBLE', 'MALFORMED')
                AND "reasonCode" IS NOT NULL
            )
        );

ALTER TABLE "ZoteroAttachmentImport"
    ADD CONSTRAINT "ZoteroAttachmentImport_revision_check"
        CHECK ("policyRevision" >= 0 AND "credentialGeneration" > 0),
    ADD CONSTRAINT "ZoteroAttachmentImport_digest_check"
        CHECK (
            "requestHash" ~ '^[0-9a-f]{64}$'
            AND "sourceMetadataHash" ~ '^[0-9a-f]{64}$'
            AND "providerMd5" ~ '^[0-9a-f]{32}$'
        ),
    ADD CONSTRAINT "ZoteroAttachmentImport_terminal_shape_check"
        CHECK (
            ("status" IN ('READY', 'ATTENTION', 'FAILED', 'CANCELLED') AND "completedAt" IS NOT NULL)
            OR ("status" NOT IN ('READY', 'ATTENTION', 'FAILED', 'CANCELLED') AND "completedAt" IS NULL)
        ),
    ADD CONSTRAINT "ZoteroAttachmentImport_failure_shape_check"
        CHECK (
            ("status" = 'FAILED' AND "failureCode" IS NOT NULL)
            OR "status" = 'ATTENTION'
            OR ("status" NOT IN ('FAILED', 'ATTENTION') AND "failureCode" IS NULL)
        ),
    ADD CONSTRAINT "ZoteroAttachmentImport_cancel_shape_check"
        CHECK (
            ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
            OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL)
        );

INSERT INTO "DocumentIntake" (
    "id",
    "organizationId",
    "source",
    "status",
    "documentId",
    "assetId",
    "inboxEntryId",
    "importBatchId",
    "createdById",
    "reservedBytes",
    "committedBytes",
    "policyRevision",
    "failureCode",
    "completedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    upload."id",
    upload."organizationId",
    'BROWSER_UPLOAD'::"DocumentIngestSource",
    CASE
        WHEN upload."status" IN ('REJECTED', 'EXPIRED') THEN 'FAILED'::"DocumentIntakeStatus"
        WHEN upload."status" = 'RECEIVING' THEN 'RECEIVING'::"DocumentIntakeStatus"
        WHEN upload."status" = 'ISSUED' THEN 'RESERVED'::"DocumentIntakeStatus"
        WHEN document."status" = 'READY' THEN 'READY'::"DocumentIntakeStatus"
        WHEN document."status" = 'FAILED' THEN 'FAILED'::"DocumentIntakeStatus"
        WHEN asset."status" = 'SCANNING' THEN 'VALIDATING'::"DocumentIntakeStatus"
        WHEN asset."status" = 'READY' AND document."status" = 'PROCESSING' THEN 'EXTRACTING'::"DocumentIntakeStatus"
        ELSE 'QUARANTINED'::"DocumentIntakeStatus"
    END,
    upload."documentId",
    upload."assetId",
    upload."inboxEntryId",
    inbox."importBatchId",
    upload."createdById",
    upload."expectedSizeBytes",
    CASE WHEN upload."status" = 'STORED' THEN upload."receivedSizeBytes" ELSE NULL END,
    0,
    CASE
        WHEN upload."status" IN ('REJECTED', 'EXPIRED') OR document."status" = 'FAILED'
            THEN COALESCE(upload."failureCode", document."failureCode", asset."rejectionCode", 'historical_intake_failed')
        ELSE NULL
    END,
    CASE
        WHEN upload."status" IN ('REJECTED', 'EXPIRED') OR document."status" IN ('READY', 'FAILED')
            THEN COALESCE(upload."rejectedAt", upload."storedAt", upload."updatedAt")
        ELSE NULL
    END,
    upload."createdAt",
    upload."updatedAt"
FROM "UploadSession" AS upload
JOIN "Document" AS document
  ON document."organizationId" = upload."organizationId"
 AND document."id" = upload."documentId"
JOIN "Asset" AS asset
  ON asset."organizationId" = upload."organizationId"
 AND asset."id" = upload."assetId"
JOIN "InboxEntry" AS inbox
  ON inbox."organizationId" = upload."organizationId"
 AND inbox."id" = upload."inboxEntryId";

UPDATE "UploadSession"
SET "intakeId" = "id";

ALTER TABLE "DocumentIngestReceipt"
    DISABLE TRIGGER "DocumentIngestReceipt_immutable_update_trigger";

UPDATE "DocumentIngestReceipt" AS receipt
SET
    "intakeId" = upload."id",
    "legacyTransportAttestation" = true
FROM "UploadSession" AS upload
WHERE receipt."organizationId" = upload."organizationId"
  AND receipt."uploadSessionId" = upload."id"
  AND receipt."documentId" = upload."documentId"
  AND receipt."assetId" = upload."assetId";

ALTER TABLE "DocumentIngestReceipt"
    ENABLE TRIGGER "DocumentIngestReceipt_immutable_update_trigger";

UPDATE "Job" AS job
SET "intakeId" = intake."id"
FROM "DocumentIntake" AS intake
WHERE job."organizationId" = intake."organizationId"
  AND job."documentId" = intake."documentId"
  AND job."assetId" = intake."assetId";

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "UploadSession" AS upload
        LEFT JOIN "DocumentIntake" AS intake
          ON intake."organizationId" = upload."organizationId"
         AND intake."id" = upload."intakeId"
         AND intake."documentId" = upload."documentId"
         AND intake."assetId" = upload."assetId"
         AND intake."inboxEntryId" = upload."inboxEntryId"
        WHERE upload."documentId" IS NULL
           OR upload."inboxEntryId" IS NULL
           OR upload."intakeId" IS NULL
           OR intake."id" IS NULL
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'UploadSession_intake_backfill_check',
            MESSAGE = 'A historical upload session could not be bound to an exact intake target.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "DocumentIngestReceipt" AS receipt
        LEFT JOIN "DocumentIntake" AS intake
          ON intake."organizationId" = receipt."organizationId"
         AND intake."id" = receipt."intakeId"
         AND intake."documentId" = receipt."documentId"
         AND intake."assetId" = receipt."assetId"
        WHERE receipt."intakeId" IS NULL OR intake."id" IS NULL
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_intake_backfill_check',
            MESSAGE = 'A historical ingest receipt could not be bound to an exact intake target.';
    END IF;
END;
$$;

ALTER TABLE "UploadSession"
    ALTER COLUMN "intakeId" SET NOT NULL,
    ALTER COLUMN "documentId" SET NOT NULL,
    ALTER COLUMN "inboxEntryId" SET NOT NULL;

ALTER TABLE "DocumentIngestReceipt"
    ALTER COLUMN "intakeId" SET NOT NULL,
    DROP CONSTRAINT "DocumentIngestReceipt_source_shape_check",
    ADD CONSTRAINT "DocumentIngestReceipt_source_shape_check"
        CHECK (
            (
                "source" = 'BROWSER_UPLOAD'
                AND "uploadSessionId" IS NOT NULL
                AND (
                    ("uploadAttemptId" IS NOT NULL AND NOT "legacyTransportAttestation")
                    OR ("uploadAttemptId" IS NULL AND "legacyTransportAttestation")
                )
                AND "ingressAttemptId" IS NULL
                AND "integrationConnectionId" IS NULL
                AND "zoteroLibraryId" IS NULL
                AND "zoteroObjectId" IS NULL
                AND "zoteroAttachmentImportId" IS NULL
            )
            OR (
                "source" = 'ZOTERO_ATTACHMENT'
                AND "uploadSessionId" IS NULL
                AND "uploadAttemptId" IS NULL
                AND "ingressAttemptId" IS NOT NULL
                AND "integrationConnectionId" IS NOT NULL
                AND "zoteroLibraryId" IS NOT NULL
                AND "zoteroObjectId" IS NOT NULL
                AND "zoteroAttachmentImportId" IS NOT NULL
                AND NOT "legacyTransportAttestation"
            )
            OR (
                "source" IN ('CRAWLER', 'WEB_MCP')
                AND "uploadSessionId" IS NULL
                AND "uploadAttemptId" IS NULL
                AND "ingressAttemptId" IS NOT NULL
                AND "zoteroLibraryId" IS NULL
                AND "zoteroObjectId" IS NULL
                AND "zoteroAttachmentImportId" IS NULL
                AND NOT "legacyTransportAttestation"
            )
        );

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentPolicy_integrationConnectionId_key" ON "ZoteroAttachmentPolicy"("integrationConnectionId");

-- CreateIndex
CREATE INDEX "ZoteroAttachmentPolicy_organizationId_mode_idx" ON "ZoteroAttachmentPolicy"("organizationId", "mode");

-- CreateIndex
CREATE INDEX "ZoteroAttachmentPolicy_configuredById_idx" ON "ZoteroAttachmentPolicy"("configuredById");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentPolicy_organizationId_id_key" ON "ZoteroAttachmentPolicy"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentPolicy_connection_binding_key" ON "ZoteroAttachmentPolicy"("organizationId", "integrationConnectionId");

-- CreateIndex
CREATE INDEX "ZoteroAttachment_organizationId_eligibility_isDeleted_idx" ON "ZoteroAttachment"("organizationId", "eligibility", "isDeleted");

-- CreateIndex
CREATE INDEX "ZoteroAttachment_organizationId_zoteroLibraryId_parentKey_idx" ON "ZoteroAttachment"("organizationId", "zoteroLibraryId", "parentKey");

-- CreateIndex
CREATE INDEX "ZoteroAttachment_organizationId_providerMd5_idx" ON "ZoteroAttachment"("organizationId", "providerMd5");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachment_library_object_binding_key" ON "ZoteroAttachment"("organizationId", "zoteroLibraryId", "zoteroObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentImport_intakeId_key" ON "ZoteroAttachmentImport"("intakeId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentImport_downloadJobId_key" ON "ZoteroAttachmentImport"("downloadJobId");

-- CreateIndex
CREATE INDEX "ZoteroAttachmentImport_organizationId_status_createdAt_idx" ON "ZoteroAttachmentImport"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ZoteroAttachmentImport_organizationId_zoteroLibraryId_zoter_idx" ON "ZoteroAttachmentImport"("organizationId", "zoteroLibraryId", "zoteroObjectId");

-- CreateIndex
CREATE INDEX "ZoteroAttachmentImport_organizationId_integrationConnection_idx" ON "ZoteroAttachmentImport"("organizationId", "integrationConnectionId", "credentialGeneration");

-- CreateIndex
CREATE INDEX "ZoteroAttachmentImport_requestedById_idx" ON "ZoteroAttachmentImport"("requestedById");

-- CreateIndex
CREATE INDEX "ZoteroAttachmentImport_retryAt_idx" ON "ZoteroAttachmentImport"("retryAt");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentImport_organizationId_id_key" ON "ZoteroAttachmentImport"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentImport_idempotency_key" ON "ZoteroAttachmentImport"("organizationId", "clientOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentImport_intake_binding_key" ON "ZoteroAttachmentImport"("organizationId", "documentId", "assetId", "intakeId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentImport_download_job_binding_key" ON "ZoteroAttachmentImport"("organizationId", "integrationConnectionId", "zoteroLibraryId", "documentId", "assetId", "intakeId", "downloadJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentImport_target_binding_key" ON "ZoteroAttachmentImport"("organizationId", "integrationConnectionId", "zoteroLibraryId", "zoteroObjectId", "documentId", "assetId", "intakeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroAttachmentImport_source_generation_key" ON "ZoteroAttachmentImport"("organizationId", "zoteroObjectId", "sourceVersion", "providerMd5");

-- CreateIndex
CREATE INDEX "DocumentIntake_organizationId_status_createdAt_idx" ON "DocumentIntake"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentIntake_organizationId_createdById_status_idx" ON "DocumentIntake"("organizationId", "createdById", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIntake_organizationId_id_key" ON "DocumentIntake"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIntake_organizationId_documentId_key" ON "DocumentIntake"("organizationId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIntake_organizationId_assetId_key" ON "DocumentIntake"("organizationId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIntake_organizationId_inboxEntryId_key" ON "DocumentIntake"("organizationId", "inboxEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIntake_target_binding_key" ON "DocumentIntake"("organizationId", "documentId", "assetId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngressAttempt_jobAttemptId_key" ON "DocumentIngressAttempt"("jobAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngressAttempt_storageKey_key" ON "DocumentIngressAttempt"("storageKey");

-- CreateIndex
CREATE INDEX "DocumentIngressAttempt_status_leaseExpiresAt_idx" ON "DocumentIngressAttempt"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "DocumentIngressAttempt_status_cleanupAfter_idx" ON "DocumentIngressAttempt"("status", "cleanupAfter");

-- CreateIndex
CREATE INDEX "DocumentIngressAttempt_organizationId_intakeId_idx" ON "DocumentIngressAttempt"("organizationId", "intakeId");

-- CreateIndex
CREATE INDEX "DocumentIngressAttempt_organizationId_assetId_idx" ON "DocumentIngressAttempt"("organizationId", "assetId");

-- CreateIndex
CREATE INDEX "DocumentIngressAttempt_organizationId_jobId_idx" ON "DocumentIngressAttempt"("organizationId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngressAttempt_organizationId_id_key" ON "DocumentIngressAttempt"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngressAttempt_intakeId_attemptNumber_key" ON "DocumentIngressAttempt"("intakeId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngressAttempt_job_attempt_binding_key" ON "DocumentIngressAttempt"("organizationId", "jobId", "jobAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngressAttempt_organizationId_intakeId_id_key" ON "DocumentIngressAttempt"("organizationId", "intakeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngressAttempt_target_binding_key" ON "DocumentIngressAttempt"("organizationId", "documentId", "assetId", "intakeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_intakeId_key" ON "DocumentIngestReceipt"("organizationId", "intakeId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_intake_binding_key" ON "DocumentIngestReceipt"("organizationId", "documentId", "assetId", "intakeId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_upload_attempt_binding_key" ON "DocumentIngestReceipt"("organizationId", "uploadSessionId", "assetId", "uploadAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_ingressAttemptId_key" ON "DocumentIngestReceipt"("organizationId", "ingressAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_ingress_attempt_binding_key" ON "DocumentIngestReceipt"("organizationId", "documentId", "assetId", "intakeId", "ingressAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_zotero_import_binding_key" ON "DocumentIngestReceipt"("organizationId", "integrationConnectionId", "zoteroLibraryId", "zoteroObjectId", "documentId", "assetId", "intakeId", "zoteroAttachmentImportId");

-- CreateIndex
CREATE INDEX "Job_intakeId_idx" ON "Job"("intakeId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_intake_target_binding_key" ON "Job"("organizationId", "documentId", "assetId", "intakeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Job_zotero_download_target_binding_key" ON "Job"("organizationId", "integrationConnectionId", "zoteroLibraryId", "documentId", "assetId", "intakeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UploadAttempt_transport_binding_key" ON "UploadAttempt"("organizationId", "uploadSessionId", "assetId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_organizationId_intakeId_key" ON "UploadSession"("organizationId", "intakeId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_intake_binding_key" ON "UploadSession"("organizationId", "documentId", "assetId", "intakeId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_asset_binding_key" ON "UploadSession"("organizationId", "id", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroLibrary_connection_binding_key" ON "ZoteroLibrary"("organizationId", "integrationConnectionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroObject_library_binding_key" ON "ZoteroObject"("organizationId", "zoteroLibraryId", "id");

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentPolicy" ADD CONSTRAINT "ZoteroAttachmentPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentPolicy" ADD CONSTRAINT "ZoteroAttachmentPolicy_organizationId_integrationConnectio_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId") REFERENCES "IntegrationConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentPolicy" ADD CONSTRAINT "ZoteroAttachmentPolicy_configuredById_fkey" FOREIGN KEY ("configuredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroAttachment" ADD CONSTRAINT "ZoteroAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroAttachment" ADD CONSTRAINT "ZoteroAttachment_organizationId_zoteroLibraryId_fkey" FOREIGN KEY ("organizationId", "zoteroLibraryId") REFERENCES "ZoteroLibrary"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ZoteroAttachment" ADD CONSTRAINT "ZoteroAttachment_organizationId_zoteroLibraryId_zoteroObje_fkey" FOREIGN KEY ("organizationId", "zoteroLibraryId", "zoteroObjectId") REFERENCES "ZoteroObject"("organizationId", "zoteroLibraryId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentImport" ADD CONSTRAINT "ZoteroAttachmentImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentImport" ADD CONSTRAINT "ZoteroAttachmentImport_connection_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId") REFERENCES "IntegrationConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentImport" ADD CONSTRAINT "ZoteroAttachmentImport_library_connection_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId", "zoteroLibraryId") REFERENCES "ZoteroLibrary"("organizationId", "integrationConnectionId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentImport" ADD CONSTRAINT "ZoteroAttachmentImport_organizationId_zoteroLibraryId_zote_fkey" FOREIGN KEY ("organizationId", "zoteroLibraryId", "zoteroObjectId") REFERENCES "ZoteroAttachment"("organizationId", "zoteroLibraryId", "zoteroObjectId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentImport" ADD CONSTRAINT "ZoteroAttachmentImport_intake_target_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "intakeId") REFERENCES "DocumentIntake"("organizationId", "documentId", "assetId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentImport" ADD CONSTRAINT "ZoteroAttachmentImport_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroAttachmentImport" ADD CONSTRAINT "ZoteroAttachmentImport_download_job_target_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId", "zoteroLibraryId", "documentId", "assetId", "intakeId", "downloadJobId") REFERENCES "Job"("organizationId", "integrationConnectionId", "zoteroLibraryId", "documentId", "assetId", "intakeId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_documentId_assetId_intakeId_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "intakeId") REFERENCES "DocumentIntake"("organizationId", "documentId", "assetId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIntake" ADD CONSTRAINT "DocumentIntake_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentIntake" ADD CONSTRAINT "DocumentIntake_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIntake" ADD CONSTRAINT "DocumentIntake_organizationId_assetId_fkey" FOREIGN KEY ("organizationId", "assetId") REFERENCES "Asset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIntake" ADD CONSTRAINT "DocumentIntake_organizationId_inboxEntryId_fkey" FOREIGN KEY ("organizationId", "inboxEntryId") REFERENCES "InboxEntry"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIntake" ADD CONSTRAINT "DocumentIntake_organizationId_importBatchId_fkey" FOREIGN KEY ("organizationId", "importBatchId") REFERENCES "ImportBatch"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIntake" ADD CONSTRAINT "DocumentIntake_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentIngressAttempt" ADD CONSTRAINT "DocumentIngressAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentIngressAttempt" ADD CONSTRAINT "DocumentIngressAttempt_intake_target_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "intakeId") REFERENCES "DocumentIntake"("organizationId", "documentId", "assetId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngressAttempt" ADD CONSTRAINT "DocumentIngressAttempt_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngressAttempt" ADD CONSTRAINT "DocumentIngressAttempt_organizationId_assetId_fkey" FOREIGN KEY ("organizationId", "assetId") REFERENCES "Asset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngressAttempt" ADD CONSTRAINT "DocumentIngressAttempt_job_intake_target_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "intakeId", "jobId") REFERENCES "Job"("organizationId", "documentId", "assetId", "intakeId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngressAttempt" ADD CONSTRAINT "DocumentIngressAttempt_organizationId_jobId_jobAttemptId_fkey" FOREIGN KEY ("organizationId", "jobId", "jobAttemptId") REFERENCES "JobAttempt"("organizationId", "jobId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_organizationId_documentId_assetId_intakeId_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "intakeId") REFERENCES "DocumentIntake"("organizationId", "documentId", "assetId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "UploadAttempt" ADD CONSTRAINT "UploadAttempt_session_asset_fkey" FOREIGN KEY ("organizationId", "uploadSessionId", "assetId") REFERENCES "UploadSession"("organizationId", "id", "assetId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_intake_target_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "intakeId") REFERENCES "DocumentIntake"("organizationId", "documentId", "assetId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_upload_attempt_fkey" FOREIGN KEY ("organizationId", "uploadSessionId", "assetId", "uploadAttemptId") REFERENCES "UploadAttempt"("organizationId", "uploadSessionId", "assetId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_ingress_attempt_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "intakeId", "ingressAttemptId") REFERENCES "DocumentIngressAttempt"("organizationId", "documentId", "assetId", "intakeId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_zotero_library_connection_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId", "zoteroLibraryId") REFERENCES "ZoteroLibrary"("organizationId", "integrationConnectionId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_zotero_object_library_fkey" FOREIGN KEY ("organizationId", "zoteroLibraryId", "zoteroObjectId") REFERENCES "ZoteroObject"("organizationId", "zoteroLibraryId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_zotero_import_target_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId", "zoteroLibraryId", "zoteroObjectId", "documentId", "assetId", "intakeId", "zoteroAttachmentImportId") REFERENCES "ZoteroAttachmentImport"("organizationId", "integrationConnectionId", "zoteroLibraryId", "zoteroObjectId", "documentId", "assetId", "intakeId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Job"
    DROP CONSTRAINT "Job_document_validation_ingest_authority_check",
    ADD CONSTRAINT "Job_document_validation_ingest_authority_check"
        CHECK (
            "type" <> 'DOCUMENT_VALIDATE'
            OR (
                "documentId" IS NOT NULL
                AND "assetId" IS NOT NULL
                AND "intakeId" IS NOT NULL
                AND "ingestReceiptId" IS NOT NULL
                AND "payload"->>'source' = 'document-ingest'
                AND "payload"->>'ingestReceiptId' = "ingestReceiptId"
                AND "payload"->>'schemaVersion' = '2'
            )
        ),
    ADD CONSTRAINT "Job_document_download_intake_authority_check"
        CHECK (
            "type" <> 'DOCUMENT_DOWNLOAD'
            OR (
                "documentId" IS NOT NULL
                AND "assetId" IS NOT NULL
                AND "intakeId" IS NOT NULL
            )
        );

CREATE FUNCTION "IntegrationConnection_credential_generation_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    credential_changed BOOLEAN;
BEGIN
    credential_changed := ROW(
        NEW."credentialCiphertext",
        NEW."credentialFingerprint",
        NEW."credentialKeyVersion",
        NEW."credentialExpiresAt"
    ) IS DISTINCT FROM ROW(
        OLD."credentialCiphertext",
        OLD."credentialFingerprint",
        OLD."credentialKeyVersion",
        OLD."credentialExpiresAt"
    );

    IF credential_changed AND NEW."credentialGeneration" <> OLD."credentialGeneration" + 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'IntegrationConnection_credential_generation_guard',
            MESSAGE = 'Credential replacement or erasure must advance the credential generation exactly once.';
    END IF;
    IF NOT credential_changed AND NEW."credentialGeneration" <> OLD."credentialGeneration" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'IntegrationConnection_credential_generation_guard',
            MESSAGE = 'Credential generation cannot change without a credential tuple change.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "IntegrationConnection_credential_generation_guard_trigger"
BEFORE UPDATE ON "IntegrationConnection"
FOR EACH ROW
EXECUTE FUNCTION "IntegrationConnection_credential_generation_guard"();

CREATE FUNCTION "DocumentIntake_update_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(
        NEW."id",
        NEW."organizationId",
        NEW."source",
        NEW."documentId",
        NEW."assetId",
        NEW."inboxEntryId",
        NEW."importBatchId",
        NEW."reservedBytes",
        NEW."policyRevision",
        NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id",
        OLD."organizationId",
        OLD."source",
        OLD."documentId",
        OLD."assetId",
        OLD."inboxEntryId",
        OLD."importBatchId",
        OLD."reservedBytes",
        OLD."policyRevision",
        OLD."createdAt"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIntake_immutable_authority_check',
            MESSAGE = 'Document intake identity, target, reservation, and policy are immutable.';
    END IF;

    IF NEW."createdById" IS DISTINCT FROM OLD."createdById"
       AND NOT (OLD."createdById" IS NOT NULL AND NEW."createdById" IS NULL)
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIntake_creator_immutability_check',
            MESSAGE = 'A document intake creator may only be erased by user deletion.';
    END IF;

    IF OLD."committedBytes" IS NOT NULL
       AND NEW."committedBytes" IS DISTINCT FROM OLD."committedBytes"
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIntake_committed_bytes_immutable_check',
            MESSAGE = 'Committed intake bytes are immutable once recorded.';
    END IF;

    IF OLD."quotaReleasedAt" IS NOT NULL
       AND NEW."quotaReleasedAt" IS DISTINCT FROM OLD."quotaReleasedAt"
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIntake_quota_release_immutable_check',
            MESSAGE = 'A released quota charge cannot be reinstated or rewritten.';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'RESERVED' AND NEW."status" IN ('QUEUED', 'RECEIVING', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'))
        OR (OLD."status" = 'QUEUED' AND NEW."status" IN ('RECEIVING', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'))
        OR (OLD."status" = 'RECEIVING' AND NEW."status" IN ('QUARANTINED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'))
        OR (OLD."status" = 'QUARANTINED' AND NEW."status" IN ('VALIDATING', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'))
        OR (OLD."status" = 'VALIDATING' AND NEW."status" IN ('EXTRACTING', 'ATTENTION', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'))
        OR (OLD."status" = 'EXTRACTING' AND NEW."status" IN ('READY', 'ATTENTION', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'))
        OR (OLD."status" = 'ATTENTION' AND NEW."status" IN ('VALIDATING', 'EXTRACTING', 'READY', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'))
        OR (OLD."status" = 'CANCEL_REQUESTED' AND NEW."status" IN ('CANCELLED', 'FAILED'))
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIntake_status_transition_check',
            MESSAGE = 'The document intake status transition is not allowed.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentIntake_update_guard_trigger"
BEFORE UPDATE ON "DocumentIntake"
FOR EACH ROW
EXECUTE FUNCTION "DocumentIntake_update_guard"();

CREATE FUNCTION "DocumentIntake_transport_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."source" = 'BROWSER_UPLOAD' AND NOT EXISTS (
        SELECT 1
        FROM "UploadSession" AS upload
        WHERE upload."organizationId" = NEW."organizationId"
          AND upload."intakeId" = NEW."id"
          AND upload."documentId" = NEW."documentId"
          AND upload."assetId" = NEW."assetId"
          AND upload."inboxEntryId" IS NOT DISTINCT FROM NEW."inboxEntryId"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIntake_browser_transport_check',
            MESSAGE = 'A browser intake must have one exact upload transport.';
    END IF;

    IF NEW."source" = 'ZOTERO_ATTACHMENT' AND NOT EXISTS (
        SELECT 1
        FROM "ZoteroAttachmentImport" AS import
        WHERE import."organizationId" = NEW."organizationId"
          AND import."intakeId" = NEW."id"
          AND import."documentId" = NEW."documentId"
          AND import."assetId" = NEW."assetId"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIntake_zotero_transport_check',
            MESSAGE = 'A Zotero intake must have one exact attachment import command.';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "DocumentIntake_transport_guard_trigger"
AFTER INSERT OR UPDATE ON "DocumentIntake"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "DocumentIntake_transport_guard"();

CREATE FUNCTION "UploadSession_intake_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "DocumentIntake" AS intake
        WHERE intake."organizationId" = NEW."organizationId"
          AND intake."id" = NEW."intakeId"
          AND intake."source" = 'BROWSER_UPLOAD'
          AND intake."documentId" = NEW."documentId"
          AND intake."assetId" = NEW."assetId"
          AND intake."inboxEntryId" = NEW."inboxEntryId"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'UploadSession_intake_authority_check',
            MESSAGE = 'The upload session does not match its browser intake authority.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "UploadSession_intake_guard_trigger"
BEFORE INSERT OR UPDATE OF "organizationId", "intakeId", "documentId", "assetId", "inboxEntryId"
ON "UploadSession"
FOR EACH ROW
EXECUTE FUNCTION "UploadSession_intake_guard"();

CREATE FUNCTION "DocumentIngressAttempt_update_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(
        NEW."id", NEW."organizationId", NEW."intakeId", NEW."documentId",
        NEW."assetId", NEW."jobId", NEW."jobAttemptId", NEW."attemptNumber",
        NEW."storageKey", NEW."storageVersion", NEW."maximumSizeBytes",
        NEW."expectedSizeBytes", NEW."providerMd5", NEW."leaseId", NEW."createdAt"
    ) IS DISTINCT FROM ROW(
        OLD."id", OLD."organizationId", OLD."intakeId", OLD."documentId",
        OLD."assetId", OLD."jobId", OLD."jobAttemptId", OLD."attemptNumber",
        OLD."storageKey", OLD."storageVersion", OLD."maximumSizeBytes",
        OLD."expectedSizeBytes", OLD."providerMd5", OLD."leaseId", OLD."createdAt"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngressAttempt_immutable_authority_check',
            MESSAGE = 'Document ingress attempt identity and admission fields are immutable.';
    END IF;

    IF OLD."status" IN ('WRITTEN', 'ADOPTED') AND ROW(
        NEW."receivedSizeBytes", NEW."computedMd5", NEW."sha256", NEW."storedAt"
    ) IS DISTINCT FROM ROW(
        OLD."receivedSizeBytes", OLD."computedMd5", OLD."sha256", OLD."storedAt"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngressAttempt_written_identity_check',
            MESSAGE = 'Written ingress byte identity is immutable.';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'RECEIVING' AND NEW."status" IN ('WRITTEN', 'FAILED', 'ABANDONED'))
        OR (OLD."status" = 'WRITTEN' AND NEW."status" IN ('ADOPTED', 'FAILED', 'ABANDONED'))
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngressAttempt_status_transition_check',
            MESSAGE = 'The ingress attempt status transition is not allowed.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentIngressAttempt_update_guard_trigger"
BEFORE UPDATE ON "DocumentIngressAttempt"
FOR EACH ROW
EXECUTE FUNCTION "DocumentIngressAttempt_update_guard"();

CREATE FUNCTION "ZoteroAttachmentPolicy_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "IntegrationConnection" AS connection
        WHERE connection."organizationId" = NEW."organizationId"
          AND connection."id" = NEW."integrationConnectionId"
          AND connection."provider" = 'ZOTERO'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'ZoteroAttachmentPolicy_zotero_connection_check',
            MESSAGE = 'Attachment policy is only valid for a Zotero connection.';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW."id", NEW."organizationId", NEW."integrationConnectionId", NEW."createdAt")
           IS DISTINCT FROM ROW(OLD."id", OLD."organizationId", OLD."integrationConnectionId", OLD."createdAt")
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentPolicy_identity_check',
                MESSAGE = 'Attachment policy identity is immutable.';
        END IF;
        IF ROW(NEW."mode", NEW."configuredById", NEW."configuredAt")
           IS DISTINCT FROM ROW(OLD."mode", OLD."configuredById", OLD."configuredAt")
           AND NEW."revision" <> OLD."revision" + 1
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentPolicy_revision_guard',
                MESSAGE = 'A policy change must advance its revision exactly once.';
        END IF;
        IF ROW(NEW."mode", NEW."configuredById", NEW."configuredAt")
           IS NOT DISTINCT FROM ROW(OLD."mode", OLD."configuredById", OLD."configuredAt")
           AND NEW."revision" <> OLD."revision"
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentPolicy_revision_guard',
                MESSAGE = 'Policy revision cannot change without a policy change.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ZoteroAttachmentPolicy_guard_trigger"
BEFORE INSERT OR UPDATE ON "ZoteroAttachmentPolicy"
FOR EACH ROW
EXECUTE FUNCTION "ZoteroAttachmentPolicy_guard"();

CREATE FUNCTION "ZoteroAttachmentImport_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "ZoteroAttachment" AS attachment
        JOIN "ZoteroAttachmentPolicy" AS policy
          ON policy."organizationId" = NEW."organizationId"
         AND policy."integrationConnectionId" = NEW."integrationConnectionId"
        JOIN "IntegrationConnection" AS connection
          ON connection."organizationId" = NEW."organizationId"
         AND connection."id" = NEW."integrationConnectionId"
        JOIN "DocumentIntake" AS intake
          ON intake."organizationId" = NEW."organizationId"
         AND intake."id" = NEW."intakeId"
         AND intake."documentId" = NEW."documentId"
         AND intake."assetId" = NEW."assetId"
        WHERE attachment."organizationId" = NEW."organizationId"
          AND attachment."zoteroLibraryId" = NEW."zoteroLibraryId"
          AND attachment."zoteroObjectId" = NEW."zoteroObjectId"
          AND attachment."eligibility" = 'DOWNLOADABLE'
          AND NOT attachment."isDeleted"
          AND attachment."sourceVersion" = NEW."sourceVersion"
          AND attachment."metadataHash" = NEW."sourceMetadataHash"
          AND attachment."providerMd5" = NEW."providerMd5"
          AND policy."mode" = 'MANUAL'
          AND policy."revision" = NEW."policyRevision"
          AND connection."provider" = 'ZOTERO'
          AND connection."status" = 'CONNECTED'
          AND connection."credentialGeneration" = NEW."credentialGeneration"
          AND intake."source" = 'ZOTERO_ATTACHMENT'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'ZoteroAttachmentImport_admission_check',
            MESSAGE = 'The Zotero attachment import no longer matches current explicit admission authority.';
    END IF;

    IF NEW."downloadJobId" IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM "Job" AS job
        WHERE job."organizationId" = NEW."organizationId"
          AND job."id" = NEW."downloadJobId"
          AND job."type" = 'DOCUMENT_DOWNLOAD'
          AND job."integrationConnectionId" = NEW."integrationConnectionId"
          AND job."zoteroLibraryId" = NEW."zoteroLibraryId"
          AND job."documentId" = NEW."documentId"
          AND job."assetId" = NEW."assetId"
          AND job."intakeId" = NEW."intakeId"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'ZoteroAttachmentImport_download_job_check',
            MESSAGE = 'The attachment import download job does not match its exact target.';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF ROW(
            NEW."id", NEW."organizationId", NEW."integrationConnectionId",
            NEW."zoteroLibraryId", NEW."zoteroObjectId", NEW."intakeId",
            NEW."documentId", NEW."assetId", NEW."clientOperationId",
            NEW."requestHash", NEW."policyRevision", NEW."credentialGeneration",
            NEW."sourceVersion", NEW."sourceMetadataHash", NEW."providerMd5",
            NEW."createdAt"
        ) IS DISTINCT FROM ROW(
            OLD."id", OLD."organizationId", OLD."integrationConnectionId",
            OLD."zoteroLibraryId", OLD."zoteroObjectId", OLD."intakeId",
            OLD."documentId", OLD."assetId", OLD."clientOperationId",
            OLD."requestHash", OLD."policyRevision", OLD."credentialGeneration",
            OLD."sourceVersion", OLD."sourceMetadataHash", OLD."providerMd5",
            OLD."createdAt"
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentImport_immutable_authority_check',
                MESSAGE = 'Zotero attachment import admission fields are immutable.';
        END IF;
        IF NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
           AND NOT (OLD."requestedById" IS NOT NULL AND NEW."requestedById" IS NULL)
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentImport_requester_check',
                MESSAGE = 'The import requester may only be erased by user deletion.';
        END IF;
        IF OLD."downloadJobId" IS NOT NULL
           AND NEW."downloadJobId" IS DISTINCT FROM OLD."downloadJobId"
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentImport_download_job_immutable_check',
                MESSAGE = 'The attachment import download job is immutable once assigned.';
        END IF;
        IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
            (OLD."status" = 'QUEUED' AND NEW."status" IN ('DOWNLOADING', 'FAILED', 'CANCELLED'))
            OR (OLD."status" = 'DOWNLOADING' AND NEW."status" IN ('QUARANTINED', 'FAILED', 'CANCELLED'))
            OR (OLD."status" = 'QUARANTINED' AND NEW."status" IN ('VALIDATING', 'FAILED', 'CANCELLED'))
            OR (OLD."status" = 'VALIDATING' AND NEW."status" IN ('EXTRACTING', 'ATTENTION', 'FAILED', 'CANCELLED'))
            OR (OLD."status" = 'EXTRACTING' AND NEW."status" IN ('READY', 'ATTENTION', 'FAILED', 'CANCELLED'))
            OR (OLD."status" = 'ATTENTION' AND NEW."status" IN ('VALIDATING', 'EXTRACTING', 'FAILED', 'CANCELLED'))
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentImport_status_transition_check',
                MESSAGE = 'The attachment import status transition is not allowed.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ZoteroAttachmentImport_guard_trigger"
BEFORE INSERT OR UPDATE ON "ZoteroAttachmentImport"
FOR EACH ROW
EXECUTE FUNCTION "ZoteroAttachmentImport_guard"();

-- Replace the generic custody validator so every source is bound to one exact
-- reserved intake and, for new rows, to one exact physical receive attempt.
CREATE OR REPLACE FUNCTION "DocumentIngestReceipt_validate_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."legacyTransportAttestation" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_legacy_transport_insert_check',
            MESSAGE = 'Legacy transport attestations cannot be created after migration.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM "DocumentIntake" AS intake
        JOIN "Asset" AS asset
          ON asset."organizationId" = NEW."organizationId"
         AND asset."id" = NEW."assetId"
        JOIN "Document" AS document
          ON document."organizationId" = NEW."organizationId"
         AND document."id" = NEW."documentId"
        JOIN "DocumentAsset" AS original
          ON original."organizationId" = NEW."organizationId"
         AND original."documentId" = NEW."documentId"
         AND original."assetId" = NEW."assetId"
         AND original."role" = 'ORIGINAL'
        WHERE intake."organizationId" = NEW."organizationId"
          AND intake."id" = NEW."intakeId"
          AND intake."source" = NEW."source"
          AND intake."documentId" = NEW."documentId"
          AND intake."assetId" = NEW."assetId"
          AND intake."inboxEntryId" IS NOT DISTINCT FROM NEW."inboxEntryId"
          AND intake."importBatchId" IS NOT DISTINCT FROM NEW."importBatchId"
          AND intake."committedBytes" = NEW."receivedSizeBytes"
          AND intake."status" IN ('QUARANTINED', 'VALIDATING', 'EXTRACTING', 'READY', 'ATTENTION')
          AND asset."sha256" = NEW."sha256"
          AND asset."sizeBytes" = NEW."receivedSizeBytes"
          AND document."contentHash" = NEW."sha256"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_target_identity_check',
            MESSAGE = 'The ingest receipt does not match its intake and immutable document asset identity.';
    END IF;

    IF NEW."source" = 'BROWSER_UPLOAD' THEN
        IF NOT EXISTS (
            SELECT 1
            FROM "UploadSession" AS upload
            WHERE upload."organizationId" = NEW."organizationId"
              AND upload."id" = NEW."uploadSessionId"
              AND upload."intakeId" = NEW."intakeId"
              AND upload."status" = 'STORED'
              AND upload."documentId" = NEW."documentId"
              AND upload."assetId" = NEW."assetId"
              AND upload."inboxEntryId" IS NOT DISTINCT FROM NEW."inboxEntryId"
              AND upload."receivedSizeBytes" = NEW."receivedSizeBytes"
              AND upload."sha256" = NEW."sha256"
              AND upload."storedAt" = NEW."storedAt"
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentIngestReceipt_browser_transport_check',
                MESSAGE = 'The browser ingest receipt does not match a completed upload transport.';
        END IF;

        IF NEW."uploadAttemptId" IS NULL THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentIngestReceipt_browser_attempt_check',
                MESSAGE = 'A new browser ingest receipt requires an exact committed upload attempt.';
        ELSIF NOT EXISTS (
            SELECT 1
            FROM "UploadAttempt" AS attempt
            JOIN "Asset" AS asset
              ON asset."organizationId" = NEW."organizationId"
             AND asset."id" = NEW."assetId"
            WHERE attempt."organizationId" = NEW."organizationId"
              AND attempt."id" = NEW."uploadAttemptId"
              AND attempt."uploadSessionId" = NEW."uploadSessionId"
              AND attempt."assetId" = NEW."assetId"
              AND attempt."status" = 'COMMITTED'
              AND attempt."receivedSizeBytes" = NEW."receivedSizeBytes"
              AND attempt."sha256" = NEW."sha256"
              AND attempt."storedAt" = NEW."storedAt"
              AND attempt."storageKey" = asset."objectKey"
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentIngestReceipt_browser_attempt_check',
                MESSAGE = 'The browser ingest receipt does not match its committed physical attempt.';
        END IF;
    ELSE
        IF NOT EXISTS (
            SELECT 1
            FROM "DocumentIngressAttempt" AS attempt
            WHERE attempt."organizationId" = NEW."organizationId"
              AND attempt."id" = NEW."ingressAttemptId"
              AND attempt."intakeId" = NEW."intakeId"
              AND attempt."documentId" = NEW."documentId"
              AND attempt."assetId" = NEW."assetId"
              AND attempt."status" IN ('WRITTEN', 'ADOPTED')
              AND attempt."receivedSizeBytes" = NEW."receivedSizeBytes"
              AND attempt."sha256" = NEW."sha256"
              AND attempt."storageVersion" = NEW."storageVersion"
              AND attempt."storedAt" = NEW."storedAt"
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'DocumentIngestReceipt_ingress_attempt_check',
                MESSAGE = 'The ingest receipt does not match its written physical receive attempt.';
        END IF;
    END IF;

    IF NEW."source" = 'ZOTERO_ATTACHMENT' AND NOT EXISTS (
        SELECT 1
        FROM "ZoteroAttachmentImport" AS import
        JOIN "DocumentIngressAttempt" AS attempt
          ON attempt."organizationId" = NEW."organizationId"
         AND attempt."id" = NEW."ingressAttemptId"
        WHERE import."organizationId" = NEW."organizationId"
          AND import."id" = NEW."zoteroAttachmentImportId"
          AND import."integrationConnectionId" = NEW."integrationConnectionId"
          AND import."zoteroLibraryId" = NEW."zoteroLibraryId"
          AND import."zoteroObjectId" = NEW."zoteroObjectId"
          AND import."intakeId" = NEW."intakeId"
          AND import."documentId" = NEW."documentId"
          AND import."assetId" = NEW."assetId"
          AND import."sourceVersion" = NEW."sourceVersion"
          AND import."providerMd5" = NEW."sourceChecksum"
          AND NEW."sourceChecksumAlgorithm" = 'md5'
          AND attempt."providerMd5" = import."providerMd5"
          AND attempt."computedMd5" = import."providerMd5"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_zotero_import_check',
            MESSAGE = 'The Zotero receipt does not match its authorized import generation and provider digest.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER "DocumentIngestReceipt_immutable_update_trigger"
ON "DocumentIngestReceipt";

CREATE OR REPLACE FUNCTION "DocumentIngestReceipt_immutable_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_immutable_check',
            MESSAGE = 'Document ingest receipts cannot be deleted.';
    END IF;

    IF (to_jsonb(NEW) - 'requestedById') IS DISTINCT FROM (to_jsonb(OLD) - 'requestedById')
       OR (
           NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
           AND NEW."requestedById" IS NOT NULL
       )
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_immutable_check',
            MESSAGE = 'Document ingest receipts are immutable custody records.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentIngestReceipt_immutable_update_trigger"
BEFORE UPDATE OR DELETE ON "DocumentIngestReceipt"
FOR EACH ROW
EXECUTE FUNCTION "DocumentIngestReceipt_immutable_update"();
