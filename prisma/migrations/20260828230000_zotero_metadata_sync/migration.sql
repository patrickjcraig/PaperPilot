-- Provider throttles and an optimistic, explicit library-selection revision are
-- durable connection state. They contain no provider credential material.
ALTER TABLE "IntegrationConnection"
  ADD COLUMN "providerBackoffUntil" TIMESTAMP(3),
  ADD COLUMN "zoteroLibrariesConfiguredAt" TIMESTAMP(3),
  ADD COLUMN "zoteroSelectionRevision" INTEGER NOT NULL DEFAULT 0;

-- Provider readability is not user intent. Preserve the old permission-derived
-- bit long enough to backfill readability, then force an explicit selection.
ALTER TABLE "ZoteroLibrary"
  ADD COLUMN "accessLostAt" TIMESTAMP(3),
  ADD COLUMN "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "isReadable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastDiscoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "syncEnabled" SET DEFAULT false;

UPDATE "ZoteroLibrary"
SET
  "isReadable" = "syncEnabled",
  "syncEnabled" = false;

-- Zotero keys are scoped by object kind as well as library.
DROP INDEX "ZoteroObject_zoteroLibraryId_zoteroKey_key";
CREATE UNIQUE INDEX "ZoteroObject_zoteroLibraryId_objectType_zoteroKey_key"
  ON "ZoteroObject"("zoteroLibraryId", "objectType", "zoteroKey");

CREATE UNIQUE INDEX "ZoteroSyncRun_organizationId_id_key"
  ON "ZoteroSyncRun"("organizationId", "id");

-- A worker may fill this table over many provider requests, but it cannot make
-- the rows authoritative until the provider version and fenced lease agree.
CREATE TABLE "ZoteroSyncStage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "zoteroSyncRunId" TEXT NOT NULL,
  "zoteroLibraryId" TEXT NOT NULL,
  "objectType" "ZoteroObjectType" NOT NULL,
  "zoteroKey" TEXT NOT NULL,
  "parentKey" TEXT,
  "version" TEXT NOT NULL,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "contentHash" TEXT,
  "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ZoteroSyncStage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ZoteroSyncStage_organizationId_zoteroLibraryId_idx"
  ON "ZoteroSyncStage"("organizationId", "zoteroLibraryId");
CREATE INDEX "ZoteroSyncStage_zoteroSyncRunId_isDeleted_idx"
  ON "ZoteroSyncStage"("zoteroSyncRunId", "isDeleted");
CREATE UNIQUE INDEX "ZoteroSyncStage_zoteroSyncRunId_objectType_zoteroKey_key"
  ON "ZoteroSyncStage"("zoteroSyncRunId", "objectType", "zoteroKey");
CREATE UNIQUE INDEX "ZoteroSyncStage_organizationId_id_key"
  ON "ZoteroSyncStage"("organizationId", "id");

ALTER TABLE "ZoteroSyncStage"
  ADD CONSTRAINT "ZoteroSyncStage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ZoteroSyncStage"
  ADD CONSTRAINT "ZoteroSyncStage_organizationId_zoteroSyncRunId_fkey"
  FOREIGN KEY ("organizationId", "zoteroSyncRunId")
  REFERENCES "ZoteroSyncRun"("organizationId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ZoteroSyncStage"
  ADD CONSTRAINT "ZoteroSyncStage_organizationId_zoteroLibraryId_fkey"
  FOREIGN KEY ("organizationId", "zoteroLibraryId")
  REFERENCES "ZoteroLibrary"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "IntegrationConnection"
  ADD CONSTRAINT "IntegrationConnection_zoteroSelectionRevision_check"
  CHECK ("zoteroSelectionRevision" >= 0);

ALTER TABLE "ZoteroObject"
  ADD CONSTRAINT "ZoteroObject_key_version_check"
  CHECK (
    "zoteroKey" ~ '^[A-Z0-9]{8}$'
    AND "version" ~ '^(0|[1-9][0-9]*)$'
  );

ALTER TABLE "ZoteroSyncStage"
  ADD CONSTRAINT "ZoteroSyncStage_key_version_digest_check"
  CHECK (
    "zoteroKey" ~ '^[A-Z0-9]{8}$'
    AND "version" ~ '^(0|[1-9][0-9]*)$'
    AND ("contentHash" IS NULL OR "contentHash" ~ '^[a-f0-9]{64}$')
    AND (
      ("isDeleted" = true AND "data" IS NULL)
      OR ("isDeleted" = false AND "data" IS NOT NULL AND "contentHash" IS NOT NULL)
    )
  );

ALTER TABLE "ZoteroSyncRun"
  ADD CONSTRAINT "ZoteroSyncRun_version_counts_check"
  CHECK (
    ("fromVersion" IS NULL OR "fromVersion" ~ '^(0|[1-9][0-9]*)$')
    AND ("toVersion" IS NULL OR "toVersion" ~ '^(0|[1-9][0-9]*)$')
    AND "objectsRead" >= 0
    AND "objectsWritten" >= 0
    AND "objectsDeleted" >= 0
    AND "conflicts" >= 0
  );

ALTER TABLE "ZoteroLibrary"
  ADD CONSTRAINT "ZoteroLibrary_version_check"
  CHECK (
    ("lastSyncedVersion" IS NULL OR "lastSyncedVersion" ~ '^(0|[1-9][0-9]*)$')
    AND ("lastItemVersion" IS NULL OR "lastItemVersion" ~ '^(0|[1-9][0-9]*)$')
    AND ("lastCollectionVersion" IS NULL OR "lastCollectionVersion" ~ '^(0|[1-9][0-9]*)$')
    AND ("lastDeletionVersion" IS NULL OR "lastDeletionVersion" ~ '^(0|[1-9][0-9]*)$')
    AND ("lastFulltextVersion" IS NULL OR "lastFulltextVersion" ~ '^(0|[1-9][0-9]*)$')
  );

