-- Each ZoteroAttachmentImport is an immutable command attempt. The original
-- global source-generation key made a FAILED or CANCELLED attempt permanently
-- reserve that provider generation, even after credential rotation, policy
-- fencing, or another terminal source-authority failure.
DROP INDEX "ZoteroAttachmentImport_source_generation_key";

-- Prisma cannot express a partial index predicate. Keep a schema-visible
-- non-unique lookup index for the command query and enforce the business
-- invariant below directly in PostgreSQL.
CREATE INDEX "ZoteroAttachmentImport_source_generation_idx"
ON "ZoteroAttachmentImport"(
    "organizationId",
    "zoteroObjectId",
    "sourceVersion",
    "providerMd5"
);

-- There may be only one active, attention-requiring, or successful import for
-- an exact source generation. FAILED and CANCELLED attempts remain immutable
-- history but release the generation so a new explicit command can retry it.
-- READY and ATTENTION deliberately remain inside this uniqueness boundary.
CREATE UNIQUE INDEX "ZoteroAttachmentImport_live_source_generation_key"
ON "ZoteroAttachmentImport"(
    "organizationId",
    "zoteroObjectId",
    "sourceVersion",
    "providerMd5"
)
WHERE "status" NOT IN ('FAILED', 'CANCELLED');
