ALTER TABLE "UploadAttempt"
    ADD COLUMN "cleanupCompletedAt" TIMESTAMP(3),
    ADD COLUMN "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "cleanupAfter" TIMESTAMP(3),
    ADD COLUMN "cleanupFailureCode" TEXT,
    ADD CONSTRAINT "UploadAttempt_cleanup_attempt_check"
        CHECK ("cleanupAttemptCount" >= 0),
    ADD CONSTRAINT "UploadAttempt_cleanup_lifecycle_check"
        CHECK (
            (
                "status" IN ('FAILED', 'ABANDONED')
                AND (
                    "cleanupCompletedAt" IS NOT NULL
                    OR "cleanupAfter" IS NOT NULL
                )
            )
            OR (
                "status" NOT IN ('FAILED', 'ABANDONED')
                AND "cleanupCompletedAt" IS NULL
                AND "cleanupAfter" IS NULL
                AND "cleanupAttemptCount" = 0
                AND "cleanupFailureCode" IS NULL
            )
        );

UPDATE "UploadAttempt"
SET "cleanupAfter" = CURRENT_TIMESTAMP
WHERE "status" IN ('FAILED', 'ABANDONED');

CREATE INDEX "UploadAttempt_status_cleanupAfter_idx"
    ON "UploadAttempt"("status", "cleanupAfter");
