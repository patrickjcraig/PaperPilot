CREATE TYPE "UploadAttemptStatus" AS ENUM (
    'RECEIVING',
    'WRITTEN',
    'COMMITTED',
    'FAILED',
    'ABANDONED'
);

CREATE TYPE "ValidationVerdict" AS ENUM ('ACCEPTED', 'REJECTED');
CREATE TYPE "MalwareVerdict" AS ENUM ('CLEAN', 'INFECTED');
CREATE TYPE "PdfStructuralVerdict" AS ENUM ('VALID', 'INVALID');

ALTER TABLE "Job"
    ADD COLUMN "leaseId" TEXT,
    ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "JobAttempt"
    ADD COLUMN "leaseId" TEXT;

ALTER TABLE "Asset"
    ADD COLUMN "validatedAt" TIMESTAMP(3),
    ADD COLUMN "validationPolicyVersion" TEXT;

ALTER TABLE "Document"
    ADD COLUMN "validatedAt" TIMESTAMP(3),
    ADD COLUMN "validationPolicyVersion" TEXT,
    ADD COLUMN "failureCode" TEXT;

CREATE TABLE "UploadAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "uploadSessionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "UploadAttemptStatus" NOT NULL DEFAULT 'RECEIVING',
    "expectedSizeBytes" BIGINT NOT NULL,
    "receivedSizeBytes" BIGINT,
    "sha256" CHAR(64),
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "storedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UploadAttempt_number_check" CHECK ("attemptNumber" > 0),
    CONSTRAINT "UploadAttempt_expected_size_check" CHECK ("expectedSizeBytes" > 0),
    CONSTRAINT "UploadAttempt_received_size_check" CHECK (
        "receivedSizeBytes" IS NULL
        OR (
            "receivedSizeBytes" >= 0
            AND "receivedSizeBytes" <= "expectedSizeBytes"
        )
    ),
    CONSTRAINT "UploadAttempt_sha256_check" CHECK (
        "sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "UploadAttempt_lifecycle_check" CHECK (
        (
            "status" = 'RECEIVING'
            AND "receivedSizeBytes" IS NULL
            AND "sha256" IS NULL
            AND "storedAt" IS NULL
            AND "completedAt" IS NULL
            AND "failureCode" IS NULL
        )
        OR (
            "status" = 'WRITTEN'
            AND "receivedSizeBytes" = "expectedSizeBytes"
            AND "sha256" IS NOT NULL
            AND "storedAt" IS NOT NULL
            AND "completedAt" IS NULL
            AND "failureCode" IS NULL
        )
        OR (
            "status" = 'COMMITTED'
            AND "receivedSizeBytes" = "expectedSizeBytes"
            AND "sha256" IS NOT NULL
            AND "storedAt" IS NOT NULL
            AND "completedAt" IS NOT NULL
            AND "failureCode" IS NULL
        )
        OR (
            "status" IN ('FAILED', 'ABANDONED')
            AND "completedAt" IS NOT NULL
            AND "failureCode" IS NOT NULL
        )
    )
);

CREATE TABLE "DocumentValidationAttestation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobAttemptId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "inputSha256" CHAR(64) NOT NULL,
    "inputSizeBytes" BIGINT NOT NULL,
    "storageVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "toolchainDigest" CHAR(64) NOT NULL,
    "verdict" "ValidationVerdict" NOT NULL,
    "rejectionCode" TEXT,
    "malwareVerdict" "MalwareVerdict" NOT NULL,
    "malwareEngine" TEXT NOT NULL,
    "malwareEngineVersion" TEXT NOT NULL,
    "signatureVersion" TEXT NOT NULL,
    "signaturePublishedAt" TIMESTAMP(3) NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "pdfStructuralVerdict" "PdfStructuralVerdict" NOT NULL,
    "pdfEngine" TEXT NOT NULL,
    "pdfEngineVersion" TEXT NOT NULL,
    "pdfVersion" TEXT NOT NULL,
    "pageCount" INTEGER,
    "objectCount" INTEGER,
    "revisionCount" INTEGER,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentValidationAttestation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentValidationAttestation_size_check" CHECK (
        "inputSizeBytes" > 0
    ),
    CONSTRAINT "DocumentValidationAttestation_sha_check" CHECK (
        "inputSha256" ~ '^[0-9a-f]{64}$'
        AND "toolchainDigest" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "DocumentValidationAttestation_counts_check" CHECK (
        ("pageCount" IS NULL OR "pageCount" > 0)
        AND ("objectCount" IS NULL OR "objectCount" >= 0)
        AND ("revisionCount" IS NULL OR "revisionCount" > 0)
    ),
    CONSTRAINT "DocumentValidationAttestation_verdict_check" CHECK (
        (
            "verdict" = 'ACCEPTED'
            AND "rejectionCode" IS NULL
            AND "malwareVerdict" = 'CLEAN'
            AND "pdfStructuralVerdict" = 'VALID'
            AND "pageCount" IS NOT NULL
        )
        OR (
            "verdict" = 'REJECTED'
            AND "rejectionCode" IS NOT NULL
        )
    )
);

CREATE INDEX "Job_status_leaseExpiresAt_idx"
    ON "Job"("status", "leaseExpiresAt");

CREATE UNIQUE INDEX "JobAttempt_jobId_leaseId_key"
    ON "JobAttempt"("jobId", "leaseId");

CREATE UNIQUE INDEX "JobAttempt_organizationId_id_key"
    ON "JobAttempt"("organizationId", "id");

CREATE UNIQUE INDEX "UploadSession_organizationId_assetId_key"
    ON "UploadSession"("organizationId", "assetId");

CREATE UNIQUE INDEX "UploadAttempt_storageKey_key"
    ON "UploadAttempt"("storageKey");
CREATE UNIQUE INDEX "UploadAttempt_organizationId_id_key"
    ON "UploadAttempt"("organizationId", "id");
CREATE UNIQUE INDEX "UploadAttempt_uploadSessionId_attemptNumber_key"
    ON "UploadAttempt"("uploadSessionId", "attemptNumber");
CREATE INDEX "UploadAttempt_status_leaseExpiresAt_idx"
    ON "UploadAttempt"("status", "leaseExpiresAt");
CREATE INDEX "UploadAttempt_organizationId_uploadSessionId_idx"
    ON "UploadAttempt"("organizationId", "uploadSessionId");
CREATE INDEX "UploadAttempt_organizationId_assetId_idx"
    ON "UploadAttempt"("organizationId", "assetId");

CREATE UNIQUE INDEX "DocumentValidationAttestation_jobAttemptId_key"
    ON "DocumentValidationAttestation"("jobAttemptId");
CREATE UNIQUE INDEX "DocumentValidationAttestation_organizationId_id_key"
    ON "DocumentValidationAttestation"("organizationId", "id");
CREATE UNIQUE INDEX "DocumentValidationAttestation_organizationId_jobAttemptId_key"
    ON "DocumentValidationAttestation"("organizationId", "jobAttemptId");
CREATE UNIQUE INDEX "DocumentValidationAttestation_asset_identity_key"
    ON "DocumentValidationAttestation"(
        "assetId",
        "inputSha256",
        "storageVersion",
        "policyVersion",
        "toolchainDigest"
    );
CREATE INDEX "DocumentValidationAttestation_organizationId_verdict_createdAt_idx"
    ON "DocumentValidationAttestation"("organizationId", "verdict", "createdAt");
CREATE INDEX "DocumentValidationAttestation_jobId_idx"
    ON "DocumentValidationAttestation"("jobId");
CREATE INDEX "DocumentValidationAttestation_assetId_idx"
    ON "DocumentValidationAttestation"("assetId");
CREATE INDEX "DocumentValidationAttestation_documentId_idx"
    ON "DocumentValidationAttestation"("documentId");

CREATE UNIQUE INDEX "DocumentAsset_one_original_per_document"
    ON "DocumentAsset"("organizationId", "documentId")
    WHERE "role" = 'ORIGINAL';

CREATE INDEX "Job_claim_document_validate_idx"
    ON "Job"("runAfter", "priority" DESC, "createdAt", "id")
    WHERE "type" = 'DOCUMENT_VALIDATE'
      AND "status" IN ('QUEUED', 'RETRYING');

CREATE INDEX "Job_expired_lease_idx"
    ON "Job"("leaseExpiresAt")
    WHERE "status" = 'RUNNING';

CREATE INDEX "UploadSession_expired_receiving_idx"
    ON "UploadSession"("claimExpiresAt")
    WHERE "status" = 'RECEIVING';

CREATE INDEX "UploadSession_expired_issued_idx"
    ON "UploadSession"("expiresAt")
    WHERE "status" = 'ISSUED';

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_attempt_budget_check"
        CHECK (
            "attempts" >= 0
            AND "maxAttempts" > 0
            AND "attempts" <= "maxAttempts"
        ),
    ADD CONSTRAINT "Job_document_validate_target_check"
        CHECK (
            "type" <> 'DOCUMENT_VALIDATE'
            OR (
                "documentId" IS NOT NULL
                AND "assetId" IS NOT NULL
                AND "dedupeKey" IS NOT NULL
            )
        ),
    ADD CONSTRAINT "Job_lease_lifecycle_check"
        CHECK (
            (
                "status" = 'RUNNING'
                AND "lockedAt" IS NOT NULL
                AND "lockedBy" IS NOT NULL
                AND "leaseId" IS NOT NULL
                AND "leaseExpiresAt" IS NOT NULL
                AND "leaseExpiresAt" > "lockedAt"
            )
            OR
            (
                "status" <> 'RUNNING'
                AND "lockedAt" IS NULL
                AND "lockedBy" IS NULL
                AND "leaseId" IS NULL
                AND "leaseExpiresAt" IS NULL
            )
        ),
    ADD CONSTRAINT "Job_completion_lifecycle_check"
        CHECK (
            (
                "status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER')
                AND "completedAt" IS NOT NULL
            )
            OR
            (
                "status" IN ('QUEUED', 'RUNNING', 'RETRYING')
                AND "completedAt" IS NULL
            )
        ),
    ADD CONSTRAINT "Job_lease_value_bounds_check"
        CHECK (
            ("leaseId" IS NULL OR char_length("leaseId") BETWEEN 1 AND 100)
            AND ("lockedBy" IS NULL OR char_length("lockedBy") BETWEEN 1 AND 200)
        );

ALTER TABLE "UploadAttempt"
    ADD CONSTRAINT "UploadAttempt_organizationId_fkey"
        FOREIGN KEY ("organizationId")
        REFERENCES "Organization"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "UploadAttempt_organizationId_uploadSessionId_fkey"
        FOREIGN KEY ("organizationId", "uploadSessionId")
        REFERENCES "UploadSession"("organizationId", "id")
        ON DELETE RESTRICT ON UPDATE NO ACTION,
    ADD CONSTRAINT "UploadAttempt_organizationId_assetId_fkey"
        FOREIGN KEY ("organizationId", "assetId")
        REFERENCES "Asset"("organizationId", "id")
        ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "DocumentValidationAttestation"
    ADD CONSTRAINT "DocumentValidationAttestation_organizationId_fkey"
        FOREIGN KEY ("organizationId")
        REFERENCES "Organization"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "DocumentValidationAttestation_organizationId_jobId_fkey"
        FOREIGN KEY ("organizationId", "jobId")
        REFERENCES "Job"("organizationId", "id")
        ON DELETE RESTRICT ON UPDATE NO ACTION,
    ADD CONSTRAINT "DocumentValidationAttestation_organizationId_jobAttemptId_fkey"
        FOREIGN KEY ("organizationId", "jobAttemptId")
        REFERENCES "JobAttempt"("organizationId", "id")
        ON DELETE RESTRICT ON UPDATE NO ACTION,
    ADD CONSTRAINT "DocumentValidationAttestation_organizationId_assetId_fkey"
        FOREIGN KEY ("organizationId", "assetId")
        REFERENCES "Asset"("organizationId", "id")
        ON DELETE RESTRICT ON UPDATE NO ACTION,
    ADD CONSTRAINT "DocumentValidationAttestation_organizationId_documentId_fkey"
        FOREIGN KEY ("organizationId", "documentId")
        REFERENCES "Document"("organizationId", "id")
        ON DELETE RESTRICT ON UPDATE NO ACTION;

UPDATE "Document"
SET "failureCode" = 'legacy_document_failure'
WHERE "status" = 'FAILED' AND "failureCode" IS NULL;

ALTER TABLE "JobAttempt"
    ADD CONSTRAINT "JobAttempt_number_check"
        CHECK ("attemptNumber" > 0),
    ADD CONSTRAINT "JobAttempt_status_check"
        CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER')),
    ADD CONSTRAINT "JobAttempt_lifecycle_check"
        CHECK (
            (
                "status" = 'RUNNING'
                AND "workerId" IS NOT NULL
                AND "leaseId" IS NOT NULL
                AND "completedAt" IS NULL
            )
            OR
            (
                "status" <> 'RUNNING'
                AND "completedAt" IS NOT NULL
            )
        ),
    ADD CONSTRAINT "JobAttempt_lease_value_bounds_check"
        CHECK (
            ("leaseId" IS NULL OR char_length("leaseId") BETWEEN 1 AND 100)
            AND ("workerId" IS NULL OR char_length("workerId") BETWEEN 1 AND 200)
        );
