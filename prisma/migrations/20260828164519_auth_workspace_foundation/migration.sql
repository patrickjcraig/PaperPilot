-- CreateEnum
CREATE TYPE "PaperIdentifierType" AS ENUM ('DOI', 'OPENALEX', 'PMID', 'PMCID', 'ARXIV', 'SEMANTIC_SCHOLAR', 'MAG', 'ISBN', 'ISSN', 'URL', 'OTHER');

-- CreateEnum
CREATE TYPE "PaperSource" AS ENUM ('OPENALEX', 'CROSSREF', 'PUBMED', 'ARXIV', 'SEMANTIC_SCHOLAR', 'ZOTERO', 'UPLOAD', 'CRAWLER', 'WEB_MCP', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkspacePaperStatus" AS ENUM ('INBOX', 'SAVED', 'READING', 'READ', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('FILE_UPLOAD', 'ZOTERO', 'OPENALEX', 'DOI_URL', 'CRAWLER', 'WEB_MCP', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InboxEntryStatus" AS ENUM ('PENDING', 'MATCHED', 'IMPORTED', 'DUPLICATE', 'NEEDS_REVIEW', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProvenanceKind" AS ENUM ('DISCOVERY', 'IMPORT', 'METADATA', 'EXTRACTION', 'USER_ASSERTION', 'ZOTERO_SYNC', 'CRAWL', 'WEB_MCP', 'SYSTEM');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('CLAIM', 'METHOD', 'RESULT', 'LIMITATION', 'QUOTE', 'QUESTION', 'NOTE');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('CAPTURED', 'VERIFIED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "EvidenceConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('ZOTERO', 'OPENALEX', 'CROSSREF', 'PUBMED', 'ARXIV', 'SEMANTIC_SCHOLAR', 'WEB_CRAWLER', 'WEB_MCP', 'OBJECT_STORAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "IntegrationAuthType" AS ENUM ('OAUTH1', 'OAUTH2', 'API_KEY', 'SERVICE_ACCOUNT', 'NONE');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('PENDING', 'CONNECTED', 'DEGRADED', 'REVOKED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ZoteroLibraryType" AS ENUM ('USER', 'GROUP');

-- CreateEnum
CREATE TYPE "ZoteroObjectType" AS ENUM ('ITEM', 'COLLECTION', 'SAVED_SEARCH', 'FULLTEXT', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('PULL', 'PUSH', 'BIDIRECTIONAL');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'BACKING_OFF');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('IMPORT_RESOLVE', 'METADATA_REFRESH', 'DOCUMENT_DOWNLOAD', 'VIRUS_SCAN', 'TEXT_EXTRACTION', 'ZOTERO_SYNC', 'CRAWL', 'WEB_MCP_IMPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('PAPER_PDF', 'SUPPLEMENT', 'HTML_SNAPSHOT', 'DATASET', 'NOTE', 'EXPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssetStorageProvider" AS ENUM ('LOCAL', 'S3', 'CLOUDFLARE_R2', 'GOOGLE_CLOUD_STORAGE', 'AZURE_BLOB', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('UPLOADING', 'QUARANTINED', 'SCANNING', 'READY', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "DocumentAssetRole" AS ENUM ('ORIGINAL', 'NORMALIZED', 'THUMBNAIL', 'PREVIEW', 'EXTRACTED_TEXT', 'SUPPLEMENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "activeOrganizationId" TEXT,
    "activeTeamId" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "teamId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviterId" TEXT NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "membershipKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationRole" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paper" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "abstractText" TEXT,
    "publicationYear" INTEGER,
    "publicationDate" DATE,
    "language" TEXT,
    "workType" TEXT,
    "venueName" TEXT,
    "citationCount" INTEGER,
    "isRetracted" BOOLEAN NOT NULL DEFAULT false,
    "primarySource" "PaperSource",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Paper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperIdentifier" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "type" "PaperIdentifierType" NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "source" "PaperSource",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperAuthor" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "givenName" TEXT,
    "familyName" TEXT,
    "orcid" TEXT,
    "isCorresponding" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PaperAuthor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspacePaper" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "status" "WorkspacePaperStatus" NOT NULL DEFAULT 'SAVED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "addedById" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspacePaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "researchQuestion" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectPaper" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspacePaperId" TEXT NOT NULL,
    "addedById" TEXT,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectPaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'QUEUED',
    "label" TEXT,
    "integrationConnectionId" TEXT,
    "requestedById" TEXT,
    "externalRequestId" TEXT,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "projectId" TEXT,
    "workspacePaperId" TEXT,
    "source" "ImportSource" NOT NULL,
    "sourceKey" TEXT,
    "dedupeKey" TEXT,
    "status" "InboxEntryStatus" NOT NULL DEFAULT 'PENDING',
    "proposedTitle" TEXT,
    "proposedYear" INTEGER,
    "sourceUri" TEXT,
    "payload" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvenanceRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "ProvenanceKind" NOT NULL,
    "paperId" TEXT,
    "workspacePaperId" TEXT,
    "inboxEntryId" TEXT,
    "evidenceNoteId" TEXT,
    "documentId" TEXT,
    "zoteroObjectId" TEXT,
    "integrationConnectionId" TEXT,
    "actorUserId" TEXT,
    "supersedesId" TEXT,
    "sourceProvider" TEXT,
    "sourceRecordId" TEXT,
    "sourceUri" TEXT,
    "retrievedAt" TIMESTAMP(3),
    "payloadDigest" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspacePaperId" TEXT NOT NULL,
    "projectId" TEXT,
    "documentId" TEXT,
    "documentChunkId" TEXT,
    "createdById" TEXT,
    "supersedesId" TEXT,
    "kind" "EvidenceKind" NOT NULL,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'CAPTURED',
    "confidence" "EvidenceConfidence" NOT NULL DEFAULT 'UNSPECIFIED',
    "quote" TEXT,
    "text" TEXT NOT NULL,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "sectionId" TEXT,
    "sectionTitle" TEXT,
    "paragraphId" TEXT,
    "figureId" TEXT,
    "figureLabel" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionPaper" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "workspacePaperId" TEXT NOT NULL,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionPaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionEvidenceNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "evidenceNoteId" TEXT NOT NULL,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionEvidenceNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "authType" "IntegrationAuthType" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'PENDING',
    "displayName" TEXT,
    "externalAccountId" TEXT,
    "scopes" JSONB,
    "configuration" JSONB,
    "credentialCiphertext" BYTEA,
    "credentialFingerprint" TEXT,
    "credentialKeyVersion" TEXT,
    "credentialExpiresAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoteroLibrary" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationConnectionId" TEXT NOT NULL,
    "libraryType" "ZoteroLibraryType" NOT NULL,
    "zoteroLibraryId" TEXT NOT NULL,
    "name" TEXT,
    "isWritable" BOOLEAN NOT NULL DEFAULT false,
    "filesEditable" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedVersion" TEXT,
    "lastItemVersion" TEXT,
    "lastCollectionVersion" TEXT,
    "lastDeletionVersion" TEXT,
    "lastFulltextVersion" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoteroLibrary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoteroObject" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "zoteroLibraryId" TEXT NOT NULL,
    "objectType" "ZoteroObjectType" NOT NULL,
    "zoteroKey" TEXT NOT NULL,
    "parentKey" TEXT,
    "version" TEXT NOT NULL,
    "paperId" TEXT,
    "workspacePaperId" TEXT,
    "collectionId" TEXT,
    "documentId" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "data" JSONB,
    "zoteroModifiedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoteroObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoteroSyncRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "zoteroLibraryId" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL DEFAULT 'PULL',
    "status" "SyncRunStatus" NOT NULL DEFAULT 'QUEUED',
    "fromVersion" TEXT,
    "toVersion" TEXT,
    "requestId" TEXT,
    "objectsRead" INTEGER NOT NULL DEFAULT 0,
    "objectsWritten" INTEGER NOT NULL DEFAULT 0,
    "objectsDeleted" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "backoffUntil" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoteroSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "integrationConnectionId" TEXT,
    "zoteroLibraryId" TEXT,
    "documentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL,
    "workerId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "result" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "requestId" TEXT,
    "ipAddressHash" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "paperId" TEXT,
    "workspacePaperId" TEXT,
    "kind" "DocumentKind" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT,
    "sourceUri" TEXT,
    "sourceFingerprint" TEXT,
    "mimeType" TEXT,
    "language" TEXT,
    "pageCount" INTEGER,
    "contentHash" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "storageProvider" "AssetStorageProvider" NOT NULL,
    "bucket" TEXT,
    "objectKey" TEXT NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "originalFileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "etag" TEXT,
    "createdById" TEXT,
    "scannedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" "DocumentAssetRole" NOT NULL DEFAULT 'ORIGINAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTextChunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "sectionId" TEXT,
    "sectionTitle" TEXT,
    "paragraphId" TEXT,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "locator" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTextChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_activeOrganizationId_idx" ON "Session"("activeOrganizationId");

-- CreateIndex
CREATE INDEX "Session_activeTeamId_idx" ON "Session"("activeTeamId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Account_providerId_idx" ON "Account"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_issuer_accountId_key" ON "Account"("issuer", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "Verification_expiresAt_idx" ON "Verification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Member_userId_idx" ON "Member"("userId");

-- CreateIndex
CREATE INDEX "Member_organizationId_role_idx" ON "Member"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Member_organizationId_userId_key" ON "Member"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_idx" ON "Invitation"("organizationId");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE INDEX "Invitation_inviterId_idx" ON "Invitation"("inviterId");

-- CreateIndex
CREATE INDEX "Invitation_teamId_idx" ON "Invitation"("teamId");

-- CreateIndex
CREATE INDEX "Invitation_status_expiresAt_idx" ON "Invitation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Team_organizationId_idx" ON "Team"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_name_key" ON "Team"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_membershipKey_key" ON "TeamMember"("membershipKey");

-- CreateIndex
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");

-- CreateIndex
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- CreateIndex
CREATE INDEX "OrganizationRole_organizationId_idx" ON "OrganizationRole"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationRole_role_idx" ON "OrganizationRole"("role");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationRole_organizationId_role_key" ON "OrganizationRole"("organizationId", "role");

-- CreateIndex
CREATE INDEX "Paper_publicationYear_idx" ON "Paper"("publicationYear");

-- CreateIndex
CREATE INDEX "Paper_primarySource_idx" ON "Paper"("primarySource");

-- CreateIndex
CREATE INDEX "Paper_isRetracted_idx" ON "Paper"("isRetracted");

-- CreateIndex
CREATE INDEX "PaperIdentifier_paperId_idx" ON "PaperIdentifier"("paperId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperIdentifier_type_normalizedValue_key" ON "PaperIdentifier"("type", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "PaperIdentifier_paperId_type_normalizedValue_key" ON "PaperIdentifier"("paperId", "type", "normalizedValue");

-- CreateIndex
CREATE INDEX "PaperAuthor_paperId_idx" ON "PaperAuthor"("paperId");

-- CreateIndex
CREATE INDEX "PaperAuthor_orcid_idx" ON "PaperAuthor"("orcid");

-- CreateIndex
CREATE UNIQUE INDEX "PaperAuthor_paperId_position_key" ON "PaperAuthor"("paperId", "position");

-- CreateIndex
CREATE INDEX "WorkspacePaper_organizationId_status_idx" ON "WorkspacePaper"("organizationId", "status");

-- CreateIndex
CREATE INDEX "WorkspacePaper_paperId_idx" ON "WorkspacePaper"("paperId");

-- CreateIndex
CREATE INDEX "WorkspacePaper_addedById_idx" ON "WorkspacePaper"("addedById");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspacePaper_organizationId_paperId_key" ON "WorkspacePaper"("organizationId", "paperId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspacePaper_organizationId_id_key" ON "WorkspacePaper"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Project_organizationId_status_idx" ON "Project"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Project_createdById_idx" ON "Project"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_slug_key" ON "Project"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_id_key" ON "Project"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ProjectPaper_organizationId_projectId_idx" ON "ProjectPaper"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "ProjectPaper_organizationId_workspacePaperId_idx" ON "ProjectPaper"("organizationId", "workspacePaperId");

-- CreateIndex
CREATE INDEX "ProjectPaper_addedById_idx" ON "ProjectPaper"("addedById");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectPaper_projectId_workspacePaperId_key" ON "ProjectPaper"("projectId", "workspacePaperId");

-- CreateIndex
CREATE INDEX "ImportBatch_organizationId_status_createdAt_idx" ON "ImportBatch"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ImportBatch_integrationConnectionId_idx" ON "ImportBatch"("integrationConnectionId");

-- CreateIndex
CREATE INDEX "ImportBatch_requestedById_idx" ON "ImportBatch"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_organizationId_externalRequestId_key" ON "ImportBatch"("organizationId", "externalRequestId");

-- CreateIndex
CREATE INDEX "InboxEntry_organizationId_status_createdAt_idx" ON "InboxEntry"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "InboxEntry_importBatchId_idx" ON "InboxEntry"("importBatchId");

-- CreateIndex
CREATE INDEX "InboxEntry_projectId_idx" ON "InboxEntry"("projectId");

-- CreateIndex
CREATE INDEX "InboxEntry_workspacePaperId_idx" ON "InboxEntry"("workspacePaperId");

-- CreateIndex
CREATE INDEX "InboxEntry_createdById_idx" ON "InboxEntry"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "InboxEntry_organizationId_source_sourceKey_key" ON "InboxEntry"("organizationId", "source", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "InboxEntry_organizationId_source_dedupeKey_key" ON "InboxEntry"("organizationId", "source", "dedupeKey");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_organizationId_createdAt_idx" ON "ProvenanceRecord"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_paperId_idx" ON "ProvenanceRecord"("paperId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_workspacePaperId_idx" ON "ProvenanceRecord"("workspacePaperId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_inboxEntryId_idx" ON "ProvenanceRecord"("inboxEntryId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_evidenceNoteId_idx" ON "ProvenanceRecord"("evidenceNoteId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_documentId_idx" ON "ProvenanceRecord"("documentId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_zoteroObjectId_idx" ON "ProvenanceRecord"("zoteroObjectId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_integrationConnectionId_idx" ON "ProvenanceRecord"("integrationConnectionId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_actorUserId_idx" ON "ProvenanceRecord"("actorUserId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_supersedesId_idx" ON "ProvenanceRecord"("supersedesId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_sourceProvider_sourceRecordId_idx" ON "ProvenanceRecord"("sourceProvider", "sourceRecordId");

-- CreateIndex
CREATE INDEX "ProvenanceRecord_payloadDigest_idx" ON "ProvenanceRecord"("payloadDigest");

-- CreateIndex
CREATE INDEX "EvidenceNote_organizationId_workspacePaperId_idx" ON "EvidenceNote"("organizationId", "workspacePaperId");

-- CreateIndex
CREATE INDEX "EvidenceNote_organizationId_projectId_idx" ON "EvidenceNote"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "EvidenceNote_documentId_idx" ON "EvidenceNote"("documentId");

-- CreateIndex
CREATE INDEX "EvidenceNote_documentChunkId_idx" ON "EvidenceNote"("documentChunkId");

-- CreateIndex
CREATE INDEX "EvidenceNote_createdById_idx" ON "EvidenceNote"("createdById");

-- CreateIndex
CREATE INDEX "EvidenceNote_supersedesId_idx" ON "EvidenceNote"("supersedesId");

-- CreateIndex
CREATE INDEX "EvidenceNote_status_idx" ON "EvidenceNote"("status");

-- CreateIndex
CREATE INDEX "Collection_organizationId_projectId_idx" ON "Collection"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "Collection_parentId_idx" ON "Collection"("parentId");

-- CreateIndex
CREATE INDEX "Collection_createdById_idx" ON "Collection"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_organizationId_projectId_parentId_name_key" ON "Collection"("organizationId", "projectId", "parentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_organizationId_id_key" ON "Collection"("organizationId", "id");

-- CreateIndex
CREATE INDEX "CollectionPaper_organizationId_collectionId_idx" ON "CollectionPaper"("organizationId", "collectionId");

-- CreateIndex
CREATE INDEX "CollectionPaper_organizationId_workspacePaperId_idx" ON "CollectionPaper"("organizationId", "workspacePaperId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionPaper_collectionId_workspacePaperId_key" ON "CollectionPaper"("collectionId", "workspacePaperId");

-- CreateIndex
CREATE INDEX "CollectionEvidenceNote_organizationId_collectionId_idx" ON "CollectionEvidenceNote"("organizationId", "collectionId");

-- CreateIndex
CREATE INDEX "CollectionEvidenceNote_organizationId_evidenceNoteId_idx" ON "CollectionEvidenceNote"("organizationId", "evidenceNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionEvidenceNote_collectionId_evidenceNoteId_key" ON "CollectionEvidenceNote"("collectionId", "evidenceNoteId");

-- CreateIndex
CREATE INDEX "IntegrationConnection_organizationId_provider_status_idx" ON "IntegrationConnection"("organizationId", "provider", "status");

-- CreateIndex
CREATE INDEX "IntegrationConnection_createdById_idx" ON "IntegrationConnection"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_organizationId_provider_externalAccou_key" ON "IntegrationConnection"("organizationId", "provider", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_organizationId_credentialFingerprint_key" ON "IntegrationConnection"("organizationId", "credentialFingerprint");

-- CreateIndex
CREATE INDEX "ZoteroLibrary_organizationId_syncEnabled_idx" ON "ZoteroLibrary"("organizationId", "syncEnabled");

-- CreateIndex
CREATE INDEX "ZoteroLibrary_integrationConnectionId_idx" ON "ZoteroLibrary"("integrationConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroLibrary_integrationConnectionId_libraryType_zoteroLib_key" ON "ZoteroLibrary"("integrationConnectionId", "libraryType", "zoteroLibraryId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroLibrary_organizationId_id_key" ON "ZoteroLibrary"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ZoteroObject_organizationId_objectType_isDeleted_idx" ON "ZoteroObject"("organizationId", "objectType", "isDeleted");

-- CreateIndex
CREATE INDEX "ZoteroObject_zoteroLibraryId_version_idx" ON "ZoteroObject"("zoteroLibraryId", "version");

-- CreateIndex
CREATE INDEX "ZoteroObject_paperId_idx" ON "ZoteroObject"("paperId");

-- CreateIndex
CREATE INDEX "ZoteroObject_workspacePaperId_idx" ON "ZoteroObject"("workspacePaperId");

-- CreateIndex
CREATE INDEX "ZoteroObject_collectionId_idx" ON "ZoteroObject"("collectionId");

-- CreateIndex
CREATE INDEX "ZoteroObject_documentId_idx" ON "ZoteroObject"("documentId");

-- CreateIndex
CREATE INDEX "ZoteroObject_parentKey_idx" ON "ZoteroObject"("parentKey");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroObject_zoteroLibraryId_zoteroKey_key" ON "ZoteroObject"("zoteroLibraryId", "zoteroKey");

-- CreateIndex
CREATE INDEX "ZoteroSyncRun_organizationId_status_createdAt_idx" ON "ZoteroSyncRun"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ZoteroSyncRun_zoteroLibraryId_startedAt_idx" ON "ZoteroSyncRun"("zoteroLibraryId", "startedAt");

-- CreateIndex
CREATE INDEX "ZoteroSyncRun_backoffUntil_idx" ON "ZoteroSyncRun"("backoffUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ZoteroSyncRun_zoteroLibraryId_requestId_key" ON "ZoteroSyncRun"("zoteroLibraryId", "requestId");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_priority_idx" ON "Job"("status", "runAfter", "priority");

-- CreateIndex
CREATE INDEX "Job_organizationId_status_idx" ON "Job"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Job_integrationConnectionId_idx" ON "Job"("integrationConnectionId");

-- CreateIndex
CREATE INDEX "Job_zoteroLibraryId_idx" ON "Job"("zoteroLibraryId");

-- CreateIndex
CREATE INDEX "Job_documentId_idx" ON "Job"("documentId");

-- CreateIndex
CREATE INDEX "Job_createdById_idx" ON "Job"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Job_organizationId_type_dedupeKey_key" ON "Job"("organizationId", "type", "dedupeKey");

-- CreateIndex
CREATE INDEX "JobAttempt_organizationId_status_idx" ON "JobAttempt"("organizationId", "status");

-- CreateIndex
CREATE INDEX "JobAttempt_workerId_idx" ON "JobAttempt"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAttempt_jobId_attemptNumber_key" ON "JobAttempt"("jobId", "attemptNumber");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_action_createdAt_idx" ON "AuditEvent"("organizationId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_idx" ON "AuditEvent"("actorUserId");

-- CreateIndex
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent"("requestId");

-- CreateIndex
CREATE INDEX "Document_organizationId_status_idx" ON "Document"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Document_paperId_idx" ON "Document"("paperId");

-- CreateIndex
CREATE INDEX "Document_workspacePaperId_idx" ON "Document"("workspacePaperId");

-- CreateIndex
CREATE INDEX "Document_contentHash_idx" ON "Document"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "Document_organizationId_sourceFingerprint_key" ON "Document"("organizationId", "sourceFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Document_organizationId_id_key" ON "Document"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Asset_organizationId_status_idx" ON "Asset"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Asset_organizationId_sha256_idx" ON "Asset"("organizationId", "sha256");

-- CreateIndex
CREATE INDEX "Asset_createdById_idx" ON "Asset"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_organizationId_storageProvider_bucket_objectKey_key" ON "Asset"("organizationId", "storageProvider", "bucket", "objectKey");

-- CreateIndex
CREATE INDEX "DocumentAsset_organizationId_documentId_idx" ON "DocumentAsset"("organizationId", "documentId");

-- CreateIndex
CREATE INDEX "DocumentAsset_organizationId_assetId_idx" ON "DocumentAsset"("organizationId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAsset_documentId_assetId_role_key" ON "DocumentAsset"("documentId", "assetId", "role");

-- CreateIndex
CREATE INDEX "DocumentTextChunk_organizationId_documentId_idx" ON "DocumentTextChunk"("organizationId", "documentId");

-- CreateIndex
CREATE INDEX "DocumentTextChunk_contentHash_idx" ON "DocumentTextChunk"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTextChunk_documentId_sequence_key" ON "DocumentTextChunk"("documentId", "sequence");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_activeOrganizationId_fkey" FOREIGN KEY ("activeOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_activeTeamId_fkey" FOREIGN KEY ("activeTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationRole" ADD CONSTRAINT "OrganizationRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperIdentifier" ADD CONSTRAINT "PaperIdentifier_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperAuthor" ADD CONSTRAINT "PaperAuthor_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspacePaper" ADD CONSTRAINT "WorkspacePaper_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspacePaper" ADD CONSTRAINT "WorkspacePaper_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspacePaper" ADD CONSTRAINT "WorkspacePaper_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectPaper" ADD CONSTRAINT "ProjectPaper_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectPaper" ADD CONSTRAINT "ProjectPaper_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectPaper" ADD CONSTRAINT "ProjectPaper_workspacePaperId_fkey" FOREIGN KEY ("workspacePaperId") REFERENCES "WorkspacePaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectPaper" ADD CONSTRAINT "ProjectPaper_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_integrationConnectionId_fkey" FOREIGN KEY ("integrationConnectionId") REFERENCES "IntegrationConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxEntry" ADD CONSTRAINT "InboxEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxEntry" ADD CONSTRAINT "InboxEntry_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxEntry" ADD CONSTRAINT "InboxEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxEntry" ADD CONSTRAINT "InboxEntry_workspacePaperId_fkey" FOREIGN KEY ("workspacePaperId") REFERENCES "WorkspacePaper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxEntry" ADD CONSTRAINT "InboxEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_workspacePaperId_fkey" FOREIGN KEY ("workspacePaperId") REFERENCES "WorkspacePaper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_inboxEntryId_fkey" FOREIGN KEY ("inboxEntryId") REFERENCES "InboxEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_evidenceNoteId_fkey" FOREIGN KEY ("evidenceNoteId") REFERENCES "EvidenceNote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_zoteroObjectId_fkey" FOREIGN KEY ("zoteroObjectId") REFERENCES "ZoteroObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_integrationConnectionId_fkey" FOREIGN KEY ("integrationConnectionId") REFERENCES "IntegrationConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvenanceRecord" ADD CONSTRAINT "ProvenanceRecord_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "ProvenanceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_workspacePaperId_fkey" FOREIGN KEY ("workspacePaperId") REFERENCES "WorkspacePaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_documentChunkId_fkey" FOREIGN KEY ("documentChunkId") REFERENCES "DocumentTextChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceNote" ADD CONSTRAINT "EvidenceNote_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "EvidenceNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionPaper" ADD CONSTRAINT "CollectionPaper_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionPaper" ADD CONSTRAINT "CollectionPaper_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionPaper" ADD CONSTRAINT "CollectionPaper_workspacePaperId_fkey" FOREIGN KEY ("workspacePaperId") REFERENCES "WorkspacePaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionEvidenceNote" ADD CONSTRAINT "CollectionEvidenceNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionEvidenceNote" ADD CONSTRAINT "CollectionEvidenceNote_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionEvidenceNote" ADD CONSTRAINT "CollectionEvidenceNote_evidenceNoteId_fkey" FOREIGN KEY ("evidenceNoteId") REFERENCES "EvidenceNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroLibrary" ADD CONSTRAINT "ZoteroLibrary_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroLibrary" ADD CONSTRAINT "ZoteroLibrary_integrationConnectionId_fkey" FOREIGN KEY ("integrationConnectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_zoteroLibraryId_fkey" FOREIGN KEY ("zoteroLibraryId") REFERENCES "ZoteroLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_workspacePaperId_fkey" FOREIGN KEY ("workspacePaperId") REFERENCES "WorkspacePaper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroObject" ADD CONSTRAINT "ZoteroObject_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroSyncRun" ADD CONSTRAINT "ZoteroSyncRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoteroSyncRun" ADD CONSTRAINT "ZoteroSyncRun_zoteroLibraryId_fkey" FOREIGN KEY ("zoteroLibraryId") REFERENCES "ZoteroLibrary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_integrationConnectionId_fkey" FOREIGN KEY ("integrationConnectionId") REFERENCES "IntegrationConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_zoteroLibraryId_fkey" FOREIGN KEY ("zoteroLibraryId") REFERENCES "ZoteroLibrary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_workspacePaperId_fkey" FOREIGN KEY ("workspacePaperId") REFERENCES "WorkspacePaper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAsset" ADD CONSTRAINT "DocumentAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTextChunk" ADD CONSTRAINT "DocumentTextChunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTextChunk" ADD CONSTRAINT "DocumentTextChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
