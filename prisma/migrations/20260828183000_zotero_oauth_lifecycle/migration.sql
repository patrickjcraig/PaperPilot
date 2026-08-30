CREATE TYPE "ZoteroOAuthAttemptStatus" AS ENUM (
    'PENDING',
    'CLAIMED',
    'SUCCEEDED',
    'FAILED',
    'EXPIRED'
);

CREATE TABLE "ZoteroOAuthAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ZoteroOAuthAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "stateTokenHash" CHAR(64) NOT NULL,
    "stateNonceHash" CHAR(64) NOT NULL,
    "requestTokenHash" CHAR(64) NOT NULL,
    "requestTokenSecretCiphertext" BYTEA,
    "requestTokenSecretKeyVersion" TEXT,
    "callbackUrlHash" CHAR(64) NOT NULL,
    "requestedScopes" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "integrationConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoteroOAuthAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ZoteroOAuthAttempt_valid_lifetime_check"
        CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "ZoteroOAuthAttempt_secret_lifecycle_check"
        CHECK (
            ("status" = 'PENDING'
                AND "requestTokenSecretCiphertext" IS NOT NULL
                AND "requestTokenSecretKeyVersion" IS NOT NULL)
            OR
            ("status" <> 'PENDING'
                AND "requestTokenSecretCiphertext" IS NULL
                AND "requestTokenSecretKeyVersion" IS NULL)
        )
);

DROP INDEX "IntegrationConnection_organizationId_credentialFingerprint_key";

CREATE UNIQUE INDEX "IntegrationConnection_organizationId_provider_credentialFingerprint_key"
    ON "IntegrationConnection"("organizationId", "provider", "credentialFingerprint");

ALTER TABLE "IntegrationConnection"
    ADD CONSTRAINT "IntegrationConnection_credential_envelope_check"
    CHECK (
        ("credentialCiphertext" IS NULL
            AND "credentialFingerprint" IS NULL
            AND "credentialKeyVersion" IS NULL)
        OR
        ("credentialCiphertext" IS NOT NULL
            AND "credentialFingerprint" IS NOT NULL
            AND "credentialKeyVersion" IS NOT NULL)
    );

CREATE UNIQUE INDEX "ZoteroOAuthAttempt_stateTokenHash_key"
    ON "ZoteroOAuthAttempt"("stateTokenHash");
CREATE UNIQUE INDEX "ZoteroOAuthAttempt_organizationId_id_key"
    ON "ZoteroOAuthAttempt"("organizationId", "id");
CREATE UNIQUE INDEX "ZoteroOAuthAttempt_organizationId_stateNonceHash_key"
    ON "ZoteroOAuthAttempt"("organizationId", "stateNonceHash");
CREATE UNIQUE INDEX "ZoteroOAuthAttempt_organizationId_requestTokenHash_key"
    ON "ZoteroOAuthAttempt"("organizationId", "requestTokenHash");
CREATE INDEX "ZoteroOAuthAttempt_organizationId_userId_status_idx"
    ON "ZoteroOAuthAttempt"("organizationId", "userId", "status");
CREATE INDEX "ZoteroOAuthAttempt_status_expiresAt_idx"
    ON "ZoteroOAuthAttempt"("status", "expiresAt");
CREATE INDEX "ZoteroOAuthAttempt_integrationConnectionId_idx"
    ON "ZoteroOAuthAttempt"("integrationConnectionId");

ALTER TABLE "ZoteroOAuthAttempt"
    ADD CONSTRAINT "ZoteroOAuthAttempt_organizationId_userId_fkey"
    FOREIGN KEY ("organizationId", "userId")
    REFERENCES "Member"("organizationId", "userId")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "ZoteroOAuthAttempt"
    ADD CONSTRAINT "ZoteroOAuthAttempt_organizationId_integrationConnectionId_fkey"
    FOREIGN KEY ("organizationId", "integrationConnectionId")
    REFERENCES "IntegrationConnection"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
