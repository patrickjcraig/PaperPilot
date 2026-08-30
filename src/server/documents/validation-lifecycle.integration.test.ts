import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

after(async () => {
  await prisma.$disconnect();
});

function isCheckConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2039"
    && error.message.includes("Code: `23514`");
}

async function rejectsCheckConstraint(
  name: string,
  operation: Promise<unknown>,
): Promise<void> {
  await assert.rejects(operation, isCheckConstraintViolation, name);
}

test("PostgreSQL rejects invalid asset and document validation lifecycle writes", async () => {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      id: `validation-lifecycle-org-${suffix}`,
      name: "Validation lifecycle constraints",
      slug: `validation-lifecycle-${suffix}`,
    },
  });
  const now = new Date();
  const policyVersion = "document-validation-v1";

  try {
    // Generic, non-terminal records do not need upload-validation metadata.
    const asset = await prisma.asset.create({
      data: {
        id: `validation-lifecycle-asset-${suffix}`,
        organizationId: organization.id,
        storageProvider: "LOCAL",
        objectKey: `generic/${suffix}`,
      },
    });
    const document = await prisma.document.create({
      data: {
        id: `validation-lifecycle-document-${suffix}`,
        organizationId: organization.id,
        kind: "OTHER",
      },
    });
    assert.equal(asset.status, "UPLOADING");
    assert.equal(document.status, "PENDING");

    const invalidAssetWrites = [
      [
        "READY asset without scannedAt",
        prisma.asset.update({
          where: { id: asset.id },
          data: {
            status: "READY",
            scannedAt: null,
            validatedAt: now,
            validationPolicyVersion: policyVersion,
            rejectionCode: null,
            rejectedReason: null,
          },
        }),
      ],
      [
        "READY asset without validatedAt",
        prisma.asset.update({
          where: { id: asset.id },
          data: {
            status: "READY",
            scannedAt: now,
            validatedAt: null,
            validationPolicyVersion: policyVersion,
            rejectionCode: null,
            rejectedReason: null,
          },
        }),
      ],
      [
        "READY asset without validationPolicyVersion",
        prisma.asset.update({
          where: { id: asset.id },
          data: {
            status: "READY",
            scannedAt: now,
            validatedAt: now,
            validationPolicyVersion: null,
            rejectionCode: null,
            rejectedReason: null,
          },
        }),
      ],
      [
        "READY asset retaining rejectionCode",
        prisma.asset.update({
          where: { id: asset.id },
          data: {
            status: "READY",
            scannedAt: now,
            validatedAt: now,
            validationPolicyVersion: policyVersion,
            rejectionCode: "stale_rejection",
            rejectedReason: null,
          },
        }),
      ],
      [
        "READY asset retaining rejectedReason",
        prisma.asset.update({
          where: { id: asset.id },
          data: {
            status: "READY",
            scannedAt: now,
            validatedAt: now,
            validationPolicyVersion: policyVersion,
            rejectionCode: null,
            rejectedReason: "stale rejection detail",
          },
        }),
      ],
      [
        "REJECTED asset without rejectionCode",
        prisma.asset.update({
          where: { id: asset.id },
          data: { status: "REJECTED", rejectionCode: null },
        }),
      ],
      [
        "DELETED asset without deletedAt",
        prisma.asset.update({
          where: { id: asset.id },
          data: { status: "DELETED", deletedAt: null },
        }),
      ],
      [
        "non-DELETED asset retaining deletedAt",
        prisma.asset.update({
          where: { id: asset.id },
          data: { status: "UPLOADING", deletedAt: now },
        }),
      ],
    ] as const;

    for (const [name, operation] of invalidAssetWrites) {
      await rejectsCheckConstraint(name, operation);
    }

    const readyAsset = await prisma.asset.update({
      where: { id: asset.id },
      data: {
        status: "READY",
        scannedAt: now,
        validatedAt: now,
        validationPolicyVersion: policyVersion,
        rejectionCode: null,
        rejectedReason: null,
      },
    });
    assert.equal(readyAsset.status, "READY");

    const rejectedAsset = await prisma.asset.create({
      data: {
        id: `validation-lifecycle-rejected-asset-${suffix}`,
        organizationId: organization.id,
        storageProvider: "LOCAL",
        objectKey: `rejected/${suffix}`,
        status: "REJECTED",
        scannedAt: now,
        validatedAt: now,
        validationPolicyVersion: policyVersion,
        rejectionCode: "pdf_invalid",
        rejectedReason: "The PDF was structurally invalid.",
      },
    });
    assert.equal(rejectedAsset.status, "REJECTED");

    const deletedAsset = await prisma.asset.create({
      data: {
        id: `validation-lifecycle-deleted-asset-${suffix}`,
        organizationId: organization.id,
        storageProvider: "LOCAL",
        objectKey: `deleted/${suffix}`,
        status: "DELETED",
        deletedAt: now,
      },
    });
    assert.equal(deletedAsset.status, "DELETED");

    const invalidDocumentWrites = [
      [
        "READY document without validatedAt",
        prisma.document.update({
          where: { id: document.id },
          data: {
            status: "READY",
            validatedAt: null,
            validationPolicyVersion: policyVersion,
            failureCode: null,
          },
        }),
      ],
      [
        "READY document without validationPolicyVersion",
        prisma.document.update({
          where: { id: document.id },
          data: {
            status: "READY",
            validatedAt: now,
            validationPolicyVersion: null,
            failureCode: null,
          },
        }),
      ],
      [
        "READY document retaining failureCode",
        prisma.document.update({
          where: { id: document.id },
          data: {
            status: "READY",
            validatedAt: now,
            validationPolicyVersion: policyVersion,
            failureCode: "stale_failure",
          },
        }),
      ],
      [
        "FAILED document without failureCode",
        prisma.document.update({
          where: { id: document.id },
          data: { status: "FAILED", failureCode: null },
        }),
      ],
      [
        "non-FAILED document retaining failureCode",
        prisma.document.update({
          where: { id: document.id },
          data: { status: "PROCESSING", failureCode: "stale_failure" },
        }),
      ],
    ] as const;

    for (const [name, operation] of invalidDocumentWrites) {
      await rejectsCheckConstraint(name, operation);
    }

    const readyDocument = await prisma.document.update({
      where: { id: document.id },
      data: {
        status: "READY",
        validatedAt: now,
        validationPolicyVersion: policyVersion,
        failureCode: null,
      },
    });
    assert.equal(readyDocument.status, "READY");

    // Rejected documents retain their validation attestation summary.
    const failedDocument = await prisma.document.create({
      data: {
        id: `validation-lifecycle-failed-document-${suffix}`,
        organizationId: organization.id,
        kind: "PAPER_PDF",
        status: "FAILED",
        validatedAt: now,
        validationPolicyVersion: policyVersion,
        failureCode: "pdf_invalid",
      },
    });
    assert.equal(failedDocument.status, "FAILED");
    assert.equal(failedDocument.validatedAt?.getTime(), now.getTime());
  } finally {
    await prisma.organization.deleteMany({ where: { id: organization.id } });
  }
});
