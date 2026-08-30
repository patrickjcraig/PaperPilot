ALTER TYPE "JobType" ADD VALUE 'DOCUMENT_VALIDATE';

CREATE TYPE "UploadSessionStatus" AS ENUM (
    'ISSUED',
    'RECEIVING',
    'STORED',
    'REJECTED',
    'EXPIRED'
);

ALTER TABLE "InboxEntry"
    ADD COLUMN "documentId" TEXT;

ALTER TABLE "Job"
    ADD COLUMN "assetId" TEXT;

ALTER TABLE "Asset"
    ADD COLUMN "physicalLocator" TEXT,
    ADD COLUMN "rejectionCode" TEXT;

CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT,
    "assetId" TEXT NOT NULL,
    "documentId" TEXT,
    "inboxEntryId" TEXT,
    "clientOperationId" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" "UploadSessionStatus" NOT NULL DEFAULT 'ISSUED',
    "originalFileName" TEXT NOT NULL,
    "declaredMimeType" TEXT NOT NULL,
    "expectedSizeBytes" BIGINT NOT NULL,
    "receivedSizeBytes" BIGINT,
    "sha256" CHAR(64),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "claimId" TEXT,
    "storedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UploadSession_expected_size_check"
        CHECK ("expectedSizeBytes" > 0),
    CONSTRAINT "UploadSession_received_size_check"
        CHECK (
            "receivedSizeBytes" IS NULL
            OR ("receivedSizeBytes" >= 0 AND "receivedSizeBytes" <= "expectedSizeBytes")
        ),
    CONSTRAINT "UploadSession_attempt_count_check"
        CHECK ("attemptCount" >= 0),
    CONSTRAINT "UploadSession_sha256_check"
        CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "UploadSession_claim_lifecycle_check"
        CHECK (
            ("status" = 'RECEIVING'
                AND "claimedAt" IS NOT NULL
                AND "claimExpiresAt" IS NOT NULL
                AND "claimId" IS NOT NULL)
            OR
            ("status" <> 'RECEIVING'
                AND "claimedAt" IS NULL
                AND "claimExpiresAt" IS NULL
                AND "claimId" IS NULL)
        ),
    CONSTRAINT "UploadSession_terminal_lifecycle_check"
        CHECK (
            ("status" = 'STORED'
                AND "receivedSizeBytes" = "expectedSizeBytes"
                AND "sha256" IS NOT NULL
                AND "storedAt" IS NOT NULL
                AND "documentId" IS NOT NULL
                AND "inboxEntryId" IS NOT NULL
                AND "rejectedAt" IS NULL
                AND "failureCode" IS NULL)
            OR
            ("status" IN ('REJECTED', 'EXPIRED')
                AND "storedAt" IS NULL
                AND "rejectedAt" IS NOT NULL
                AND "failureCode" IS NOT NULL)
            OR
            ("status" IN ('ISSUED', 'RECEIVING')
                AND "storedAt" IS NULL
                AND "rejectedAt" IS NULL
                AND "failureCode" IS NULL)
        )
);

CREATE UNIQUE INDEX "Asset_physicalLocator_key"
    ON "Asset"("physicalLocator");
CREATE INDEX "InboxEntry_documentId_idx"
    ON "InboxEntry"("documentId");
CREATE INDEX "Job_assetId_idx"
    ON "Job"("assetId");
CREATE UNIQUE INDEX "UploadSession_organizationId_clientOperationId_key"
    ON "UploadSession"("organizationId", "clientOperationId");
CREATE UNIQUE INDEX "UploadSession_organizationId_id_key"
    ON "UploadSession"("organizationId", "id");
CREATE UNIQUE INDEX "UploadSession_organizationId_documentId_key"
    ON "UploadSession"("organizationId", "documentId");
CREATE UNIQUE INDEX "UploadSession_organizationId_inboxEntryId_key"
    ON "UploadSession"("organizationId", "inboxEntryId");
CREATE INDEX "UploadSession_organizationId_status_expiresAt_idx"
    ON "UploadSession"("organizationId", "status", "expiresAt");
CREATE INDEX "UploadSession_organizationId_createdById_status_idx"
    ON "UploadSession"("organizationId", "createdById", "status");
CREATE INDEX "UploadSession_assetId_idx"
    ON "UploadSession"("assetId");

ALTER TABLE "InboxEntry"
    ADD CONSTRAINT "InboxEntry_organizationId_documentId_fkey"
    FOREIGN KEY ("organizationId", "documentId")
    REFERENCES "Document"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_organizationId_assetId_fkey"
    FOREIGN KEY ("organizationId", "assetId")
    REFERENCES "Asset"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_organizationId_fkey"
    FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_createdById_fkey"
    FOREIGN KEY ("createdById")
    REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_organizationId_assetId_fkey"
    FOREIGN KEY ("organizationId", "assetId")
    REFERENCES "Asset"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_organizationId_documentId_fkey"
    FOREIGN KEY ("organizationId", "documentId")
    REFERENCES "Document"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_organizationId_inboxEntryId_fkey"
    FOREIGN KEY ("organizationId", "inboxEntryId")
    REFERENCES "InboxEntry"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Asset"
    ADD CONSTRAINT "Asset_size_bytes_check"
        CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0),
    ADD CONSTRAINT "Asset_sha256_check"
        CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "Asset_rejection_code_check"
        CHECK (
            ("status" = 'REJECTED' AND "rejectionCode" IS NOT NULL)
            OR ("status" <> 'REJECTED')
        );
