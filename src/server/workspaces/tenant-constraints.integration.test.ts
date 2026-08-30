import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

after(async () => {
  await prisma.$disconnect();
});

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

async function rejectsCrossTenantWrite(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, isForeignKeyViolation);
}

test("compound foreign keys reject cross-tenant import and research graph links", async () => {
  const suffix = randomUUID();
  const organizationA = await prisma.organization.create({
    data: {
      id: `tenant-constraint-org-a-${suffix}`,
      name: "Tenant constraint A",
      slug: `tenant-constraint-a-${suffix}`,
    },
  });
  const organizationB = await prisma.organization.create({
    data: {
      id: `tenant-constraint-org-b-${suffix}`,
      name: "Tenant constraint B",
      slug: `tenant-constraint-b-${suffix}`,
    },
  });

  const paperIds = [`tenant-constraint-paper-a-${suffix}`, `tenant-constraint-paper-b-${suffix}`];
  let zoteroLibraryIds: string[] = [];
  let documentIds: string[] = [];

  try {
    const [paperA, paperB] = await Promise.all([
      prisma.paper.create({
        data: { id: paperIds[0], title: "Tenant constraint paper A" },
      }),
      prisma.paper.create({
        data: { id: paperIds[1], title: "Tenant constraint paper B" },
      }),
    ]);
    const [workspacePaperA, workspacePaperB] = await Promise.all([
      prisma.workspacePaper.create({
        data: {
          id: `tenant-constraint-workspace-paper-a-${suffix}`,
          organizationId: organizationA.id,
          paperId: paperA.id,
        },
      }),
      prisma.workspacePaper.create({
        data: {
          id: `tenant-constraint-workspace-paper-b-${suffix}`,
          organizationId: organizationB.id,
          paperId: paperB.id,
        },
      }),
    ]);
    const [projectA, projectB] = await Promise.all([
      prisma.project.create({
        data: {
          id: `tenant-constraint-project-a-${suffix}`,
          organizationId: organizationA.id,
          name: "Tenant project A",
          slug: `tenant-project-a-${suffix}`,
        },
      }),
      prisma.project.create({
        data: {
          id: `tenant-constraint-project-b-${suffix}`,
          organizationId: organizationB.id,
          name: "Tenant project B",
          slug: `tenant-project-b-${suffix}`,
        },
      }),
    ]);
    const [integrationA, integrationB] = await Promise.all([
      prisma.integrationConnection.create({
        data: {
          id: `tenant-constraint-integration-a-${suffix}`,
          organizationId: organizationA.id,
          provider: "ZOTERO",
          authType: "OAUTH1",
        },
      }),
      prisma.integrationConnection.create({
        data: {
          id: `tenant-constraint-integration-b-${suffix}`,
          organizationId: organizationB.id,
          provider: "ZOTERO",
          authType: "OAUTH1",
        },
      }),
    ]);
    const [libraryA, libraryB] = await Promise.all([
      prisma.zoteroLibrary.create({
        data: {
          id: `tenant-constraint-library-a-${suffix}`,
          organizationId: organizationA.id,
          integrationConnectionId: integrationA.id,
          libraryType: "USER",
          zoteroLibraryId: "1000001",
        },
      }),
      prisma.zoteroLibrary.create({
        data: {
          id: `tenant-constraint-library-b-${suffix}`,
          organizationId: organizationB.id,
          integrationConnectionId: integrationB.id,
          libraryType: "USER",
          zoteroLibraryId: "2000002",
        },
      }),
    ]);
    zoteroLibraryIds = [libraryA.id, libraryB.id];

    const documentB = await prisma.document.create({
      data: {
        id: `tenant-constraint-document-b-${suffix}`,
        organizationId: organizationB.id,
        workspacePaperId: workspacePaperB.id,
        kind: "PAPER_PDF",
      },
    });
    documentIds = [documentB.id];

    // A valid same-tenant association proves the new key is not over-broad.
    await prisma.projectPaper.create({
      data: {
        id: `tenant-constraint-valid-project-paper-${suffix}`,
        organizationId: organizationA.id,
        projectId: projectA.id,
        workspacePaperId: workspacePaperA.id,
      },
    });

    await rejectsCrossTenantWrite(prisma.projectPaper.create({
      data: {
        id: `tenant-constraint-invalid-project-paper-${suffix}`,
        organizationId: organizationA.id,
        projectId: projectA.id,
        workspacePaperId: workspacePaperB.id,
      },
    }));

    await rejectsCrossTenantWrite(prisma.inboxEntry.create({
      data: {
        id: `tenant-constraint-invalid-inbox-${suffix}`,
        organizationId: organizationA.id,
        projectId: projectB.id,
        source: "MANUAL",
      },
    }));

    await rejectsCrossTenantWrite(prisma.zoteroLibrary.create({
      data: {
        id: `tenant-constraint-invalid-library-${suffix}`,
        organizationId: organizationA.id,
        integrationConnectionId: integrationB.id,
        libraryType: "USER",
        zoteroLibraryId: "3000003",
      },
    }));

    await rejectsCrossTenantWrite(prisma.zoteroObject.create({
      data: {
        id: `tenant-constraint-invalid-object-${suffix}`,
        organizationId: organizationA.id,
        zoteroLibraryId: libraryB.id,
        objectType: "ITEM",
        zoteroKey: "AB12CD34",
        version: "1",
      },
    }));

    await rejectsCrossTenantWrite(prisma.job.create({
      data: {
        id: `tenant-constraint-invalid-job-${suffix}`,
        organizationId: organizationA.id,
        type: "ZOTERO_SYNC",
        integrationConnectionId: integrationB.id,
      },
    }));

    await rejectsCrossTenantWrite(prisma.document.create({
      data: {
        id: `tenant-constraint-invalid-document-${suffix}`,
        organizationId: organizationA.id,
        workspacePaperId: workspacePaperB.id,
        kind: "PAPER_PDF",
      },
    }));

    assert.equal(await prisma.projectPaper.count({
      where: { organizationId: organizationA.id },
    }), 1);
    assert.equal(await prisma.inboxEntry.count({
      where: { organizationId: organizationA.id },
    }), 0);
    assert.equal(await prisma.zoteroObject.count({
      where: { organizationId: organizationA.id },
    }), 0);
    assert.equal(await prisma.job.count({
      where: { organizationId: organizationA.id },
    }), 0);
    assert.equal(await prisma.document.count({
      where: { organizationId: organizationA.id },
    }), 0);
  } finally {
    if (zoteroLibraryIds.length > 0) {
      await prisma.zoteroLibrary.deleteMany({ where: { id: { in: zoteroLibraryIds } } });
    }
    if (documentIds.length > 0) {
      await prisma.document.deleteMany({ where: { id: { in: documentIds } } });
    }
    await prisma.organization.deleteMany({
      where: { id: { in: [organizationA.id, organizationB.id] } },
    });
    await prisma.paper.deleteMany({ where: { id: { in: paperIds } } });
  }
});
