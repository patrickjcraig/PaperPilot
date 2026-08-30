-- Preserve the domain-level verification state instead of collapsing it into
-- either captured or verified evidence.
ALTER TYPE "EvidenceStatus" ADD VALUE IF NOT EXISTS 'NEEDS_VERIFICATION';

-- New structured fields remain nullable so pre-existing legacy notes stay
-- readable without pretending their flattened `text` column has a known
-- claim/evidence/interpretation meaning. All new application writes require
-- the structured fields at the service boundary.
ALTER TABLE "EvidenceNote"
    ADD COLUMN "title" TEXT,
    ADD COLUMN "claim" TEXT,
    ADD COLUMN "evidence" TEXT,
    ADD COLUMN "interpretation" TEXT,
    ADD COLUMN "openQuestion" TEXT,
    ADD COLUMN "linkedHighlightIds" JSONB,
    ADD COLUMN "tags" JSONB;

CREATE TABLE "ProjectEvidenceNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "evidenceNoteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectEvidenceNote_pkey" PRIMARY KEY ("id")
);

-- Carry the old one-project association into the new many-project edge. The
-- deterministic identifier makes the backfill safe to inspect and reproduce.
INSERT INTO "ProjectEvidenceNote" (
    "id",
    "organizationId",
    "projectId",
    "evidenceNoteId"
)
SELECT
    CONCAT('legacy_', MD5("organizationId" || ':' || "projectId" || ':' || "id")),
    "organizationId",
    "projectId",
    "id"
FROM "EvidenceNote"
WHERE "projectId" IS NOT NULL;

CREATE UNIQUE INDEX "ProjectEvidenceNote_projectId_evidenceNoteId_key"
    ON "ProjectEvidenceNote"("projectId", "evidenceNoteId");
CREATE UNIQUE INDEX "ProjectEvidenceNote_organizationId_projectId_evidenceNoteId_key"
    ON "ProjectEvidenceNote"("organizationId", "projectId", "evidenceNoteId");
CREATE INDEX "ProjectEvidenceNote_organizationId_projectId_idx"
    ON "ProjectEvidenceNote"("organizationId", "projectId");
CREATE INDEX "ProjectEvidenceNote_organizationId_evidenceNoteId_idx"
    ON "ProjectEvidenceNote"("organizationId", "evidenceNoteId");

ALTER TABLE "ProjectEvidenceNote"
    ADD CONSTRAINT "ProjectEvidenceNote_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectEvidenceNote"
    ADD CONSTRAINT "ProjectEvidenceNote_organizationId_projectId_fkey"
    FOREIGN KEY ("organizationId", "projectId")
    REFERENCES "Project"("organizationId", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "ProjectEvidenceNote"
    ADD CONSTRAINT "ProjectEvidenceNote_organizationId_evidenceNoteId_fkey"
    FOREIGN KEY ("organizationId", "evidenceNoteId")
    REFERENCES "EvidenceNote"("organizationId", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
