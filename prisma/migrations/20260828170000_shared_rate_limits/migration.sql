-- Better Auth 1.7.2 database-backed rate-limit storage. lastRequest is an
-- epoch-millisecond integer and must remain BIGINT for adapter compatibility.
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RateLimit_key_key" ON "RateLimit"("key");
CREATE INDEX "RateLimit_lastRequest_idx" ON "RateLimit"("lastRequest");

-- Durable state for application-level fixed-window quotas and token buckets.
-- Bucket keys are HMAC-derived, so raw user, workspace, and IP identifiers are
-- never retained here.
CREATE TABLE "RateLimitBucket" (
    "key" VARCHAR(191) NOT NULL,
    "policy" VARCHAR(100) NOT NULL,
    "state" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");
