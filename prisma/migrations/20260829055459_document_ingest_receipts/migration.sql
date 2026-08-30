-- CreateEnum
CREATE TYPE "DocumentIngestSource" AS ENUM ('BROWSER_UPLOAD', 'ZOTERO_ATTACHMENT', 'CRAWLER', 'WEB_MCP');

-- The nullable phase permits a fail-closed backfill of historical upload
-- attestations before the column becomes mandatory.
ALTER TABLE "DocumentValidationAttestation" ADD COLUMN "ingestReceiptId" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "ingestReceiptId" TEXT;

-- CreateTable
CREATE TABLE "DocumentIngestReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" "DocumentIngestSource" NOT NULL,
    "sourceFingerprint" VARCHAR(512) NOT NULL,
    "assetId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "inboxEntryId" TEXT,
    "importBatchId" TEXT,
    "uploadSessionId" TEXT,
    "integrationConnectionId" TEXT,
    "zoteroLibraryId" TEXT,
    "zoteroObjectId" TEXT,
    "requestedById" TEXT,
    "sourceVersion" VARCHAR(128),
    "sourceEtag" VARCHAR(255),
    "sourceChecksumAlgorithm" VARCHAR(32),
    "sourceChecksum" VARCHAR(128),
    "declaredMimeType" VARCHAR(255) NOT NULL,
    "receivedSizeBytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storageVersion" VARCHAR(128) NOT NULL,
    "storedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentIngestReceipt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DocumentIngestReceipt"
    ADD CONSTRAINT "DocumentIngestReceipt_sha256_check"
        CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "DocumentIngestReceipt_size_check"
        CHECK ("receivedSizeBytes" > 0),
    ADD CONSTRAINT "DocumentIngestReceipt_mime_check"
        CHECK (
            octet_length("declaredMimeType") BETWEEN 1 AND 255
            AND "declaredMimeType" !~ '[[:cntrl:]]'
        ),
    ADD CONSTRAINT "DocumentIngestReceipt_checksum_pair_check"
        CHECK (
            ("sourceChecksumAlgorithm" IS NULL AND "sourceChecksum" IS NULL)
            OR (
                "sourceChecksumAlgorithm" IS NOT NULL
                AND "sourceChecksum" IS NOT NULL
                AND (
                    ("sourceChecksumAlgorithm" = 'sha256' AND "sourceChecksum" ~ '^[0-9a-f]{64}$')
                    OR ("sourceChecksumAlgorithm" = 'md5' AND "sourceChecksum" ~ '^[0-9a-f]{32}$')
                )
            )
        ),
    ADD CONSTRAINT "DocumentIngestReceipt_source_shape_check"
        CHECK (
            (
                "source" = 'BROWSER_UPLOAD'
                AND "uploadSessionId" IS NOT NULL
                AND "integrationConnectionId" IS NULL
                AND "zoteroLibraryId" IS NULL
                AND "zoteroObjectId" IS NULL
            )
            OR (
                "source" = 'ZOTERO_ATTACHMENT'
                AND "uploadSessionId" IS NULL
                AND "integrationConnectionId" IS NOT NULL
                AND "zoteroLibraryId" IS NOT NULL
                AND "zoteroObjectId" IS NOT NULL
            )
            OR (
                "source" IN ('CRAWLER', 'WEB_MCP')
                AND "uploadSessionId" IS NULL
                AND "zoteroLibraryId" IS NULL
                AND "zoteroObjectId" IS NULL
            )
        );

-- CreateIndex
CREATE INDEX "DocumentIngestReceipt_organizationId_source_storedAt_idx" ON "DocumentIngestReceipt"("organizationId", "source", "storedAt");

-- CreateIndex
CREATE INDEX "DocumentIngestReceipt_integrationConnectionId_idx" ON "DocumentIngestReceipt"("integrationConnectionId");

-- CreateIndex
CREATE INDEX "DocumentIngestReceipt_zoteroLibraryId_idx" ON "DocumentIngestReceipt"("zoteroLibraryId");

-- CreateIndex
CREATE INDEX "DocumentIngestReceipt_zoteroObjectId_idx" ON "DocumentIngestReceipt"("zoteroObjectId");

-- CreateIndex
CREATE INDEX "DocumentIngestReceipt_requestedById_idx" ON "DocumentIngestReceipt"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_source_sourceFingerpri_key" ON "DocumentIngestReceipt"("organizationId", "source", "sourceFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_id_key" ON "DocumentIngestReceipt"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_assetId_key" ON "DocumentIngestReceipt"("organizationId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_documentId_key" ON "DocumentIngestReceipt"("organizationId", "documentId");

CREATE UNIQUE INDEX "DocumentIngestReceipt_target_binding_key" ON "DocumentIngestReceipt"("organizationId", "documentId", "assetId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_inboxEntryId_key" ON "DocumentIngestReceipt"("organizationId", "inboxEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestReceipt_organizationId_uploadSessionId_key" ON "DocumentIngestReceipt"("organizationId", "uploadSessionId");

-- CreateIndex
CREATE INDEX "DocumentValidationAttestation_ingestReceiptId_idx" ON "DocumentValidationAttestation"("ingestReceiptId");

-- CreateIndex
CREATE INDEX "Job_ingestReceiptId_idx" ON "Job"("ingestReceiptId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_documentId_assetId_ingestReceiptId_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "ingestReceiptId") REFERENCES "DocumentIngestReceipt"("organizationId", "documentId", "assetId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_assetId_fkey" FOREIGN KEY ("organizationId", "assetId") REFERENCES "Asset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_inboxEntryId_fkey" FOREIGN KEY ("organizationId", "inboxEntryId") REFERENCES "InboxEntry"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_importBatchId_fkey" FOREIGN KEY ("organizationId", "importBatchId") REFERENCES "ImportBatch"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_uploadSessionId_fkey" FOREIGN KEY ("organizationId", "uploadSessionId") REFERENCES "UploadSession"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_integrationConnection_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId") REFERENCES "IntegrationConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_zoteroLibraryId_fkey" FOREIGN KEY ("organizationId", "zoteroLibraryId") REFERENCES "ZoteroLibrary"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_organizationId_zoteroObjectId_fkey" FOREIGN KEY ("organizationId", "zoteroObjectId") REFERENCES "ZoteroObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DocumentIngestReceipt" ADD CONSTRAINT "DocumentIngestReceipt_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill one deterministic immutable receipt for every completed browser
-- upload before validation authority moves away from UploadSession.
INSERT INTO "DocumentIngestReceipt" (
    "id",
    "organizationId",
    "source",
    "sourceFingerprint",
    "assetId",
    "documentId",
    "inboxEntryId",
    "importBatchId",
    "uploadSessionId",
    "requestedById",
    "sourceVersion",
    "sourceChecksumAlgorithm",
    "sourceChecksum",
    "declaredMimeType",
    "receivedSizeBytes",
    "sha256",
    "storageVersion",
    "storedAt",
    "metadata",
    "createdAt"
)
SELECT
    upload."id",
    upload."organizationId",
    'BROWSER_UPLOAD'::"DocumentIngestSource",
    'upload-session:' || upload."id",
    upload."assetId",
    upload."documentId",
    upload."inboxEntryId",
    inbox."importBatchId",
    upload."id",
    upload."createdById",
    upload."id",
    'sha256',
    upload."sha256",
    upload."declaredMimeType",
    upload."receivedSizeBytes",
    upload."sha256",
    'local-quarantine-v2',
    upload."storedAt",
    jsonb_build_object(
        'schemaVersion', 1,
        'transport', 'authenticated-browser-upload',
        'publicAccess', false,
        'backfilled', true
    ),
    upload."storedAt"
FROM "UploadSession" AS upload
JOIN "InboxEntry" AS inbox
  ON inbox."organizationId" = upload."organizationId"
 AND inbox."id" = upload."inboxEntryId"
JOIN "Asset" AS asset
  ON asset."organizationId" = upload."organizationId"
 AND asset."id" = upload."assetId"
JOIN "Document" AS document
  ON document."organizationId" = upload."organizationId"
 AND document."id" = upload."documentId"
JOIN "DocumentAsset" AS original
  ON original."organizationId" = upload."organizationId"
 AND original."documentId" = upload."documentId"
 AND original."assetId" = upload."assetId"
 AND original."role" = 'ORIGINAL'
WHERE upload."status" = 'STORED'
  AND upload."documentId" IS NOT NULL
  AND upload."inboxEntryId" IS NOT NULL
  AND upload."receivedSizeBytes" IS NOT NULL
  AND upload."sha256" IS NOT NULL
  AND upload."storedAt" IS NOT NULL
  AND asset."sizeBytes" = upload."receivedSizeBytes"
  AND asset."sha256" = upload."sha256"
  AND document."contentHash" = upload."sha256";

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "UploadSession" AS upload
        LEFT JOIN "DocumentIngestReceipt" AS receipt
          ON receipt."organizationId" = upload."organizationId"
         AND receipt."uploadSessionId" = upload."id"
        WHERE upload."status" = 'STORED'
          AND receipt."id" IS NULL
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_historical_upload_backfill_check',
            MESSAGE = 'A historical stored upload does not have a complete immutable custody graph.';
    END IF;
END;
$$;

-- Bind and upgrade every historical validation job to the generic authority.
UPDATE "Job" AS job
SET
    "ingestReceiptId" = receipt."id",
    "dedupeKey" = 'document-ingest:' || receipt."id" || ':'
        || COALESCE(job."payload"->>'policyVersion', 'paperpilot-document-validation-v1'),
    "payload" = jsonb_build_object(
        'schemaVersion', 2,
        'source', 'document-ingest',
        'ingestReceiptId', receipt."id",
        'policyVersion', COALESCE(job."payload"->>'policyVersion', 'paperpilot-document-validation-v1'),
        'storageVersion', COALESCE(job."payload"->>'storageVersion', receipt."storageVersion")
    )
FROM "DocumentIngestReceipt" AS receipt
WHERE job."type" = 'DOCUMENT_VALIDATE'
  AND receipt."organizationId" = job."organizationId"
  AND receipt."documentId" = job."documentId"
  AND receipt."assetId" = job."assetId";

UPDATE "DocumentValidationAttestation" AS attestation
SET "ingestReceiptId" = receipt."id"
FROM "DocumentIngestReceipt" AS receipt
WHERE receipt."organizationId" = attestation."organizationId"
  AND receipt."documentId" = attestation."documentId"
  AND receipt."assetId" = attestation."assetId";

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "Job"
        WHERE "type" = 'DOCUMENT_VALIDATE'
          AND (
              "ingestReceiptId" IS NULL
              OR "documentId" IS NULL
              OR "assetId" IS NULL
              OR "payload"->>'source' IS DISTINCT FROM 'document-ingest'
              OR "payload"->>'ingestReceiptId' IS DISTINCT FROM "ingestReceiptId"
          )
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'Job_document_validation_ingest_backfill_check',
            MESSAGE = 'A historical validation job could not be bound to an ingest receipt.';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM "DocumentValidationAttestation"
        WHERE "ingestReceiptId" IS NULL
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentValidationAttestation_ingest_backfill_check',
            MESSAGE = 'A historical validation attestation could not be bound to an ingest receipt.';
    END IF;
END;
$$;

ALTER TABLE "DocumentValidationAttestation"
    ALTER COLUMN "ingestReceiptId" SET NOT NULL;

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_document_validation_ingest_authority_check"
        CHECK (
            "type" <> 'DOCUMENT_VALIDATE'
            OR (
                "documentId" IS NOT NULL
                AND "assetId" IS NOT NULL
                AND "ingestReceiptId" IS NOT NULL
                AND "payload"->>'source' = 'document-ingest'
                AND "payload"->>'ingestReceiptId' = "ingestReceiptId"
                AND "payload"->>'schemaVersion' = '2'
            )
        );

-- Receipt insertion independently verifies the immutable target. Later Asset
-- and Document lifecycle status changes are allowed, but their byte identity is
-- rechecked again by validation claim and completion.
CREATE FUNCTION "DocumentIngestReceipt_validate_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "Asset" AS asset
        JOIN "Document" AS document
          ON document."organizationId" = NEW."organizationId"
         AND document."id" = NEW."documentId"
        JOIN "DocumentAsset" AS original
          ON original."organizationId" = NEW."organizationId"
         AND original."documentId" = NEW."documentId"
         AND original."assetId" = NEW."assetId"
         AND original."role" = 'ORIGINAL'
        WHERE asset."organizationId" = NEW."organizationId"
          AND asset."id" = NEW."assetId"
          AND asset."sha256" = NEW."sha256"
          AND asset."sizeBytes" = NEW."receivedSizeBytes"
          AND document."contentHash" = NEW."sha256"
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'DocumentIngestReceipt_target_identity_check',
            MESSAGE = 'The ingest receipt does not match the immutable document asset identity.';
    END IF;

    IF NEW."source" = 'BROWSER_UPLOAD' AND NOT EXISTS (
        SELECT 1
        FROM "UploadSession" AS upload
        WHERE upload."organizationId" = NEW."organizationId"
          AND upload."id" = NEW."uploadSessionId"
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
    RETURN NEW;
END;
$$;

CREATE TRIGGER "DocumentIngestReceipt_validate_insert_trigger"
BEFORE INSERT ON "DocumentIngestReceipt"
FOR EACH ROW
EXECUTE FUNCTION "DocumentIngestReceipt_validate_insert"();

CREATE FUNCTION "DocumentIngestReceipt_immutable_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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
BEFORE UPDATE ON "DocumentIngestReceipt"
FOR EACH ROW
EXECUTE FUNCTION "DocumentIngestReceipt_immutable_update"();

-- AddForeignKey
ALTER TABLE "DocumentValidationAttestation" ADD CONSTRAINT "DocumentValidationAttestation_ingest_target_fkey" FOREIGN KEY ("organizationId", "documentId", "assetId", "ingestReceiptId") REFERENCES "DocumentIngestReceipt"("organizationId", "documentId", "assetId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
