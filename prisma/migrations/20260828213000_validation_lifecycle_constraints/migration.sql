ALTER TABLE "Asset"
    ADD CONSTRAINT "Asset_ready_validation_check"
        CHECK (
            "status" <> 'READY'
            OR (
                "scannedAt" IS NOT NULL
                AND "validatedAt" IS NOT NULL
                AND "validationPolicyVersion" IS NOT NULL
                AND "rejectionCode" IS NULL
                AND "rejectedReason" IS NULL
            )
        ),
    ADD CONSTRAINT "Asset_deleted_lifecycle_check"
        CHECK (
            (
                "status" = 'DELETED'
                AND "deletedAt" IS NOT NULL
            )
            OR (
                "status" <> 'DELETED'
                AND "deletedAt" IS NULL
            )
        );

ALTER TABLE "Document"
    ADD CONSTRAINT "Document_ready_validation_check"
        CHECK (
            "status" <> 'READY'
            OR (
                "validatedAt" IS NOT NULL
                AND "validationPolicyVersion" IS NOT NULL
                AND "failureCode" IS NULL
            )
        ),
    ADD CONSTRAINT "Document_failure_code_check"
        CHECK (
            (
                "status" = 'FAILED'
                AND "failureCode" IS NOT NULL
            )
            OR (
                "status" <> 'FAILED'
                AND "failureCode" IS NULL
            )
        );
