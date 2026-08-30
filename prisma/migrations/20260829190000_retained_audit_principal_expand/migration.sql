-- Expand phase for tenant-scoped retained audit identities.
--
-- This migration is intentionally backward compatible: legacy live-User
-- actor columns stay in place while application nodes begin dual-writing the
-- random principal. A later contract migration may remove live-User authority
-- only after every retained row has been backfilled and verified.

CREATE TABLE "RetainedAuditPrincipal" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "liveUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pseudonymizedAt" TIMESTAMP(3),

    CONSTRAINT "RetainedAuditPrincipal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RetainedAuditPrincipal_state_check" CHECK (
        ("liveUserId" IS NOT NULL AND "pseudonymizedAt" IS NULL)
        OR
        ("liveUserId" IS NULL AND "pseudonymizedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "RetainedAuditPrincipal_organizationId_id_key"
    ON "RetainedAuditPrincipal"("organizationId", "id");
CREATE UNIQUE INDEX "RetainedAuditPrincipal_organizationId_liveUserId_key"
    ON "RetainedAuditPrincipal"("organizationId", "liveUserId");
CREATE INDEX "RetainedAuditPrincipal_liveUserId_idx"
    ON "RetainedAuditPrincipal"("liveUserId");

ALTER TABLE "RetainedAuditPrincipal"
    ADD CONSTRAINT "RetainedAuditPrincipal_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "RetainedAuditPrincipal"
    ADD CONSTRAINT "RetainedAuditPrincipal_liveUserId_fkey"
    FOREIGN KEY ("liveUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "InboxEntry" ADD COLUMN "createdByPrincipalId" UUID;
ALTER TABLE "ProvenanceRecord" ADD COLUMN "actorPrincipalId" UUID;
ALTER TABLE "WebMcpProposalApproval" ADD COLUMN "approvedByPrincipalId" UUID;
ALTER TABLE "AuditEvent" ADD COLUMN "actorPrincipalId" UUID;

CREATE INDEX "InboxEntry_createdByPrincipalId_idx"
    ON "InboxEntry"("createdByPrincipalId");
CREATE INDEX "ProvenanceRecord_actorPrincipalId_idx"
    ON "ProvenanceRecord"("actorPrincipalId");
CREATE INDEX "WebMcpProposalApproval_approvedByPrincipalId_idx"
    ON "WebMcpProposalApproval"("approvedByPrincipalId");
CREATE INDEX "AuditEvent_actorPrincipalId_idx"
    ON "AuditEvent"("actorPrincipalId");

ALTER TABLE "InboxEntry"
    ADD CONSTRAINT "InboxEntry_retained_creator_fkey"
    FOREIGN KEY ("organizationId", "createdByPrincipalId")
    REFERENCES "RetainedAuditPrincipal"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ProvenanceRecord"
    ADD CONSTRAINT "ProvenanceRecord_retained_actor_fkey"
    FOREIGN KEY ("organizationId", "actorPrincipalId")
    REFERENCES "RetainedAuditPrincipal"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "WebMcpProposalApproval"
    ADD CONSTRAINT "WebMcpApproval_retained_actor_fkey"
    FOREIGN KEY ("organizationId", "approvedByPrincipalId")
    REFERENCES "RetainedAuditPrincipal"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "AuditEvent"
    ADD CONSTRAINT "AuditEvent_retained_actor_fkey"
    FOREIGN KEY ("organizationId", "actorPrincipalId")
    REFERENCES "RetainedAuditPrincipal"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION public."RetainedAuditPrincipal_immutability_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Retained audit principal identity is immutable.';
  END IF;

  -- The only legal mutation is the FK-driven, one-way account detachment.
  -- The database stamps the event so callers cannot forge erasure timing.
  IF OLD."liveUserId" IS NOT NULL
     AND NEW."liveUserId" IS NULL
     AND OLD."pseudonymizedAt" IS NULL
     AND NEW."pseudonymizedAt" IS NULL THEN
    NEW."pseudonymizedAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Retained audit principal cannot be rebound or rewritten.';
END;
$function$;

CREATE TRIGGER "RetainedAuditPrincipal_immutability_guard_trigger"
BEFORE UPDATE ON "RetainedAuditPrincipal"
FOR EACH ROW
EXECUTE FUNCTION public."RetainedAuditPrincipal_immutability_guard"();

