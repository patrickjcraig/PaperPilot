-- Tenant-owned relations use (organizationId, id) foreign keys so a child
-- cannot name a resource belonging to another workspace. New constraints are
-- installed before the legacy bare-id constraints are removed; a dirty
-- database therefore fails closed without first weakening referential safety.

-- Parent keys required by the compound foreign keys.
CREATE UNIQUE INDEX "Asset_organizationId_id_key" ON "Asset"("organizationId", "id");
CREATE UNIQUE INDEX "DocumentTextChunk_organizationId_id_key" ON "DocumentTextChunk"("organizationId", "id");
CREATE UNIQUE INDEX "DocumentTextChunk_organizationId_documentId_id_key" ON "DocumentTextChunk"("organizationId", "documentId", "id");
CREATE UNIQUE INDEX "EvidenceNote_organizationId_id_key" ON "EvidenceNote"("organizationId", "id");
CREATE UNIQUE INDEX "EvidenceNote_organizationId_workspacePaperId_id_key" ON "EvidenceNote"("organizationId", "workspacePaperId", "id");
CREATE UNIQUE INDEX "ImportBatch_organizationId_id_key" ON "ImportBatch"("organizationId", "id");
CREATE UNIQUE INDEX "InboxEntry_organizationId_id_key" ON "InboxEntry"("organizationId", "id");
CREATE UNIQUE INDEX "IntegrationConnection_organizationId_id_key" ON "IntegrationConnection"("organizationId", "id");
CREATE UNIQUE INDEX "Job_organizationId_id_key" ON "Job"("organizationId", "id");
CREATE UNIQUE INDEX "ProjectPaper_organizationId_projectId_workspacePaperId_key" ON "ProjectPaper"("organizationId", "projectId", "workspacePaperId");
CREATE UNIQUE INDEX "ProvenanceRecord_organizationId_id_key" ON "ProvenanceRecord"("organizationId", "id");
CREATE UNIQUE INDEX "Team_organizationId_id_key" ON "Team"("organizationId", "id");
CREATE UNIQUE INDEX "ZoteroObject_organizationId_id_key" ON "ZoteroObject"("organizationId", "id");

-- Install the compound constraints while every legacy constraint is still in
-- place. Optional and history-bearing references are restrictive; cascades are
-- reserved for mandatory association rows.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_teamId_fkey" FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "ProjectPaper" ADD CONSTRAINT "ProjectPaper_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ProjectPaper" ADD CONSTRAINT "ProjectPaper_organizationId_workspacePaperId_fkey" FOREIGN KEY ("organizationId", "workspacePaperId") REFERENCES "WorkspacePaper"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_organizationId_integrationConnectionId_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId") REFERENCES "IntegrationConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "InboxEntry" ADD CONSTRAINT "InboxEntry_organizationId_importBatchId_fkey" FOREIGN KEY ("organizationId", "importBatchId") REFERENCES "ImportBatch"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "InboxEntry" ADD CONSTRAINT "InboxEntry_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "InboxEntry" ADD CONSTRAINT "InboxEntry_organizationId_workspacePaperId_fkey" FOREIGN KEY ("organizationId", "workspacePaperId") REFERENCES "WorkspacePaper"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_organizationId_workspacePaperId_fkey" FOREIGN KEY ("organizationId", "workspacePaperId") REFERENCES "WorkspacePaper"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_organizationId_inboxEntryId_fkey" FOREIGN KEY ("organizationId", "inboxEntryId") REFERENCES "InboxEntry"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_organizationId_evidenceNoteId_fkey" FOREIGN KEY ("organizationId", "evidenceNoteId") REFERENCES "EvidenceNote"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_organizationId_zoteroObjectId_fkey" FOREIGN KEY ("organizationId", "zoteroObjectId") REFERENCES "ZoteroObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_organizationId_integrationConnectionId_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId") REFERENCES "IntegrationConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_organizationId_supersedesId_fkey" FOREIGN KEY ("organizationId", "supersedesId") REFERENCES "ProvenanceRecord"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_organizationId_workspacePaperId_fkey" FOREIGN KEY ("organizationId", "workspacePaperId") REFERENCES "WorkspacePaper"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_organizationId_documentChunkId_fkey" FOREIGN KEY ("organizationId", "documentChunkId") REFERENCES "DocumentTextChunk"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_organizationId_supersedesId_fkey" FOREIGN KEY ("organizationId", "supersedesId") REFERENCES "EvidenceNote"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Collection" ADD CONSTRAINT "Collection_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_organizationId_parentId_fkey" FOREIGN KEY ("organizationId", "parentId") REFERENCES "Collection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "CollectionPaper" ADD CONSTRAINT "CollectionPaper_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CollectionPaper" ADD CONSTRAINT "CollectionPaper_organizationId_workspacePaperId_fkey" FOREIGN KEY ("organizationId", "workspacePaperId") REFERENCES "WorkspacePaper"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "CollectionEvidenceNote" ADD CONSTRAINT "CollectionEvidenceNote_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "CollectionEvidenceNote" ADD CONSTRAINT "CollectionEvidenceNote_organizationId_evidenceNoteId_fkey" FOREIGN KEY ("organizationId", "evidenceNoteId") REFERENCES "EvidenceNote"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "ZoteroLibrary" ADD CONSTRAINT "ZoteroLibrary_organizationId_integrationConnectionId_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId") REFERENCES "IntegrationConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_organizationId_zoteroLibraryId_fkey" FOREIGN KEY ("organizationId", "zoteroLibraryId") REFERENCES "ZoteroLibrary"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_organizationId_workspacePaperId_fkey" FOREIGN KEY ("organizationId", "workspacePaperId") REFERENCES "WorkspacePaper"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "ZoteroSyncRun" ADD CONSTRAINT "ZoteroSyncRun_organizationId_zoteroLibraryId_fkey" FOREIGN KEY ("organizationId", "zoteroLibraryId") REFERENCES "ZoteroLibrary"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_integrationConnectionId_fkey" FOREIGN KEY ("organizationId", "integrationConnectionId") REFERENCES "IntegrationConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_zoteroLibraryId_fkey" FOREIGN KEY ("organizationId", "zoteroLibraryId") REFERENCES "ZoteroLibrary"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_organizationId_jobId_fkey" FOREIGN KEY ("organizationId", "jobId") REFERENCES "Job"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_workspacePaperId_fkey" FOREIGN KEY ("organizationId", "workspacePaperId") REFERENCES "WorkspacePaper"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_organizationId_assetId_fkey" FOREIGN KEY ("organizationId", "assetId") REFERENCES "Asset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "DocumentTextChunk" ADD CONSTRAINT "DocumentTextChunk_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Remove the weaker single-column foreign keys only after every compound
-- replacement above has been installed successfully.
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_teamId_fkey";
ALTER TABLE "ProjectPaper" DROP CONSTRAINT "ProjectPaper_projectId_fkey";
ALTER TABLE "ProjectPaper" DROP CONSTRAINT "ProjectPaper_workspacePaperId_fkey";
ALTER TABLE "ImportBatch" DROP CONSTRAINT "ImportBatch_integrationConnectionId_fkey";
ALTER TABLE "InboxEntry" DROP CONSTRAINT "InboxEntry_importBatchId_fkey";
ALTER TABLE "InboxEntry" DROP CONSTRAINT "InboxEntry_projectId_fkey";
ALTER TABLE "InboxEntry" DROP CONSTRAINT "InboxEntry_workspacePaperId_fkey";
ALTER TABLE "ProvenanceRecord" DROP CONSTRAINT "ProvenanceRecord_workspacePaperId_fkey";
ALTER TABLE "ProvenanceRecord" DROP CONSTRAINT "ProvenanceRecord_inboxEntryId_fkey";
ALTER TABLE "ProvenanceRecord" DROP CONSTRAINT "ProvenanceRecord_evidenceNoteId_fkey";
ALTER TABLE "ProvenanceRecord" DROP CONSTRAINT "ProvenanceRecord_documentId_fkey";
ALTER TABLE "ProvenanceRecord" DROP CONSTRAINT "ProvenanceRecord_zoteroObjectId_fkey";
ALTER TABLE "ProvenanceRecord" DROP CONSTRAINT "ProvenanceRecord_integrationConnectionId_fkey";
ALTER TABLE "ProvenanceRecord" DROP CONSTRAINT "ProvenanceRecord_supersedesId_fkey";
ALTER TABLE "EvidenceNote" DROP CONSTRAINT "EvidenceNote_workspacePaperId_fkey";
ALTER TABLE "EvidenceNote" DROP CONSTRAINT "EvidenceNote_projectId_fkey";
ALTER TABLE "EvidenceNote" DROP CONSTRAINT "EvidenceNote_documentId_fkey";
ALTER TABLE "EvidenceNote" DROP CONSTRAINT "EvidenceNote_documentChunkId_fkey";
ALTER TABLE "EvidenceNote" DROP CONSTRAINT "EvidenceNote_supersedesId_fkey";
ALTER TABLE "Collection" DROP CONSTRAINT "Collection_projectId_fkey";
ALTER TABLE "Collection" DROP CONSTRAINT "Collection_parentId_fkey";
ALTER TABLE "CollectionPaper" DROP CONSTRAINT "CollectionPaper_collectionId_fkey";
ALTER TABLE "CollectionPaper" DROP CONSTRAINT "CollectionPaper_workspacePaperId_fkey";
ALTER TABLE "CollectionEvidenceNote" DROP CONSTRAINT "CollectionEvidenceNote_collectionId_fkey";
ALTER TABLE "CollectionEvidenceNote" DROP CONSTRAINT "CollectionEvidenceNote_evidenceNoteId_fkey";
ALTER TABLE "ZoteroLibrary" DROP CONSTRAINT "ZoteroLibrary_integrationConnectionId_fkey";
ALTER TABLE "ZoteroObject" DROP CONSTRAINT "ZoteroObject_zoteroLibraryId_fkey";
ALTER TABLE "ZoteroObject" DROP CONSTRAINT "ZoteroObject_workspacePaperId_fkey";
ALTER TABLE "ZoteroObject" DROP CONSTRAINT "ZoteroObject_collectionId_fkey";
ALTER TABLE "ZoteroObject" DROP CONSTRAINT "ZoteroObject_documentId_fkey";
ALTER TABLE "ZoteroSyncRun" DROP CONSTRAINT "ZoteroSyncRun_zoteroLibraryId_fkey";
ALTER TABLE "Job" DROP CONSTRAINT "Job_integrationConnectionId_fkey";
ALTER TABLE "Job" DROP CONSTRAINT "Job_zoteroLibraryId_fkey";
ALTER TABLE "Job" DROP CONSTRAINT "Job_documentId_fkey";
ALTER TABLE "JobAttempt" DROP CONSTRAINT "JobAttempt_jobId_fkey";
ALTER TABLE "Document" DROP CONSTRAINT "Document_workspacePaperId_fkey";
ALTER TABLE "DocumentAsset" DROP CONSTRAINT "DocumentAsset_documentId_fkey";
ALTER TABLE "DocumentAsset" DROP CONSTRAINT "DocumentAsset_assetId_fkey";
ALTER TABLE "DocumentTextChunk" DROP CONSTRAINT "DocumentTextChunk_documentId_fkey";
