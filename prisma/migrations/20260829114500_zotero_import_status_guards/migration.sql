-- Status and cleanup updates must remain possible after an admitted Zotero
-- source generation is later tombstoned, disconnected, or superseded. Current
-- admission is therefore checked only on INSERT; immutable fields preserve the
-- exact authority snapshot on every later lifecycle update.
CREATE OR REPLACE FUNCTION "ZoteroAttachmentImport_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NOT EXISTS (
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
            MESSAGE = 'The Zotero attachment import does not match current explicit admission authority.';
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

-- A configured user's deletion may erase configuredById without changing the
-- policy decision. All actual policy changes still advance revision exactly.
CREATE OR REPLACE FUNCTION "ZoteroAttachmentPolicy_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    policy_changed BOOLEAN;
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

        policy_changed :=
            NEW."mode" IS DISTINCT FROM OLD."mode"
            OR NEW."configuredAt" IS DISTINCT FROM OLD."configuredAt"
            OR (
                NEW."configuredById" IS DISTINCT FROM OLD."configuredById"
                AND NOT (OLD."configuredById" IS NOT NULL AND NEW."configuredById" IS NULL)
            );

        IF policy_changed AND NEW."revision" <> OLD."revision" + 1 THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentPolicy_revision_guard',
                MESSAGE = 'A policy change must advance its revision exactly once.';
        END IF;
        IF NOT policy_changed AND NEW."revision" <> OLD."revision" THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                CONSTRAINT = 'ZoteroAttachmentPolicy_revision_guard',
                MESSAGE = 'Policy revision cannot change without a policy change.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Receipt rows are immutable during their lifetime, while explicit tenant
-- erasure and test teardown must still be able to follow the schema's declared
-- ON DELETE CASCADE/RESTRICT graph. Keep the mutation guard on UPDATE only.
DROP TRIGGER "DocumentIngestReceipt_immutable_update_trigger"
ON "DocumentIngestReceipt";

CREATE TRIGGER "DocumentIngestReceipt_immutable_update_trigger"
BEFORE UPDATE ON "DocumentIngestReceipt"
FOR EACH ROW
EXECUTE FUNCTION "DocumentIngestReceipt_immutable_update"();
