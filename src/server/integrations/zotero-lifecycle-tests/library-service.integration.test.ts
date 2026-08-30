import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { createCredentialProtector } from "@/server/integrations/credential-protection";
import type { ZoteroGroup, ZoteroReadOnlyClient } from "../zotero/contracts";
import {
  discoverZoteroLibraries,
  listZoteroConnections,
  selectZoteroLibraries,
} from "../zotero/library-service";
import { ZoteroAdapterError } from "../zotero/errors";
import { toZoteroVersion } from "../zotero/protocol";

after(async () => {
  await prisma.$disconnect();
});

function group(id: string, name: string): ZoteroGroup {
  return {
    id,
    version: toZoteroVersion("1"),
    name,
    type: "Private",
    libraryReading: "members",
    libraryEditing: "admins",
    fileEditing: "none",
    data: {
      id: Number(id),
      version: 1,
      name,
      type: "Private",
      libraryReading: "members",
      libraryEditing: "admins",
      fileEditing: "none",
    },
  };
}

function problem(code: string) {
  return (error: unknown) => error instanceof HttpProblem && error.code === code;
}

test("discovery preserves intent while selection is atomic, replay-safe, and tenant-bound", async () => {
  const suffix = randomUUID();
  const ownerId = `zotero-library-owner-${suffix}`;
  const workspaceId = `zotero-library-workspace-${suffix}`;
  const connectionId = `zotero-library-connection-${suffix}`;
  const protector = createCredentialProtector({
    activeVersion: "library-test-v1",
    encryptionKeys: { "library-test-v1": randomBytes(32) },
    fingerprintKey: randomBytes(32),
  });
  const protectedCredential = protector.protect("zotero-library-test-key", {
    organizationId: workspaceId,
    provider: "ZOTERO",
    subjectId: connectionId,
  });

  await prisma.user.create({
    data: {
      id: ownerId,
      name: "Zotero Library Owner",
      email: `${ownerId}@example.test`,
    },
  });
  await prisma.organization.create({
    data: { id: workspaceId, name: "Zotero Library Workspace", slug: workspaceId },
  });
  await prisma.member.create({
    data: { organizationId: workspaceId, userId: ownerId, role: "owner" },
  });
  await prisma.integrationConnection.create({
    data: {
      id: connectionId,
      organizationId: workspaceId,
      provider: "ZOTERO",
      authType: "OAUTH1",
      status: "CONNECTED",
      externalAccountId: "12345",
      credentialCiphertext: Uint8Array.from(protectedCredential.ciphertext),
      credentialFingerprint: protectedCredential.fingerprint,
      credentialKeyVersion: protectedCredential.keyVersion,
      credentialGeneration: 1,
      createdById: ownerId,
    },
  });
  const [retained, accessLost] = await Promise.all([
    prisma.zoteroLibrary.create({
      data: {
        organizationId: workspaceId,
        integrationConnectionId: connectionId,
        libraryType: "GROUP",
        zoteroLibraryId: "77",
        name: "Stale retained name",
        isReadable: true,
        syncEnabled: true,
      },
    }),
    prisma.zoteroLibrary.create({
      data: {
        organizationId: workspaceId,
        integrationConnectionId: connectionId,
        libraryType: "GROUP",
        zoteroLibraryId: "88",
        name: "Temporarily unavailable",
        isReadable: true,
        syncEnabled: true,
      },
    }),
  ]);

  let identityCalls = 0;
  let groupCalls = 0;
  const provider: Pick<ZoteroReadOnlyClient, "getCurrentIdentity" | "listUserGroups"> = {
    async getCurrentIdentity(request) {
      identityCalls += 1;
      assert.deepEqual(request, { organizationId: workspaceId, connectionId });
      return {
        outcome: "data",
        data: {
          userId: "12345",
          username: "library-owner",
          displayName: "Library Owner",
          access: {
            user: { library: true, notes: false, files: true, write: false },
            groups: {
              all: { library: true, notes: true, write: false },
              "77": { library: true, notes: false, write: false },
            },
          },
        },
        meta: {
          retrievedAt: "2026-08-28T20:00:00.000Z",
          providerStatus: 200,
        },
      };
    },
    async listUserGroups(request) {
      groupCalls += 1;
      assert.deepEqual(request, {
        organizationId: workspaceId,
        connectionId,
        userId: "12345",
        start: 0,
        limit: 100,
      });
      return {
        outcome: "data",
        data: [group("77", "Methods Lab"), group("99", "Open Synthesis")],
        meta: {
          retrievedAt: "2026-08-28T20:00:00.000Z",
          providerStatus: 200,
          totalResults: 2,
        },
      };
    },
  };

  try {
    const discoveredAt = new Date("2026-08-28T20:00:00.000Z");
    const discovered = await discoverZoteroLibraries({
      userId: ownerId,
      workspaceId,
      connectionId,
      requestId: "discover-libraries-request",
    }, {
      database: prisma,
      credentialProtector: protector,
      providerClientFactory({ accessToken }) {
        assert.equal(accessToken, "zotero-library-test-key");
        return provider;
      },
      now: () => discoveredAt,
    });
    assert.equal(identityCalls, 1);
    assert.equal(groupCalls, 1);
    assert.equal(discovered.discovered, true);
    assert.deepEqual(
      discovered.libraries.map((library) => ({
        type: library.type,
        providerId: library.zoteroLibraryId,
        readable: library.isReadable,
        fileAccessStatus: library.fileAccessStatus,
        selected: library.syncEnabled,
        name: library.name,
      })),
      [
        {
          type: "USER",
          providerId: "12345",
          readable: true,
          fileAccessStatus: "AVAILABLE",
          selected: false,
          name: "My Library",
        },
        {
          type: "GROUP",
          providerId: "77",
          readable: true,
          fileAccessStatus: "UNKNOWN",
          selected: true,
          name: "Methods Lab",
        },
        {
          type: "GROUP",
          providerId: "88",
          readable: false,
          fileAccessStatus: "UNAVAILABLE",
          selected: true,
          name: "Temporarily unavailable",
        },
        {
          type: "GROUP",
          providerId: "99",
          readable: true,
          fileAccessStatus: "UNKNOWN",
          selected: false,
          name: "Open Synthesis",
        },
      ],
    );
    const lostRow = await prisma.zoteroLibrary.findUniqueOrThrow({
      where: { id: accessLost.id },
    });
    assert.equal(lostRow.isReadable, false);
    assert.equal(lostRow.fileAccessStatus, "UNAVAILABLE");
    assert.equal(lostRow.syncEnabled, true, "permission loss must not erase user intent");
    assert.equal(lostRow.accessLostAt?.toISOString(), discoveredAt.toISOString());
    const retainedRow = await prisma.zoteroLibrary.findUniqueOrThrow({
      where: { id: retained.id },
    });
    assert.equal(retainedRow.isReadable, true);
    assert.equal(retainedRow.fileAccessStatus, "UNKNOWN");
    assert.equal(retainedRow.syncEnabled, true);
    assert.equal(retainedRow.name, "Methods Lab");

    await prisma.zoteroSyncRun.create({
      data: {
        organizationId: workspaceId,
        zoteroLibraryId: retained.id,
        status: "FAILED",
        fromVersion: "2",
        toVersion: "3",
        objectsRead: 8,
        objectsWritten: 2,
        objectsDeleted: 1,
        errorCode: "provider-detail-that-must-not-cross-the-dto",
        startedAt: new Date("2026-08-28T20:01:00.000Z"),
        completedAt: new Date("2026-08-28T20:01:02.000Z"),
      },
    });
    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastErrorCode: "provider-detail-that-must-not-cross-the-dto" },
    });
    const listed = await listZoteroConnections(ownerId, workspaceId, prisma);
    assert.equal(listed.connections[0].attentionCode, null);
    assert.deepEqual(listed.connections[0].capabilities, {
      personalLibrary: true,
      groupLibraries: true,
      notes: true,
      files: true,
    });
    assert.equal(
      listed.connections[0].libraries.find((library) => library.id === retained.id)
        ?.lastSyncRun?.errorCode,
      "internal_error",
    );
    const serialized = JSON.stringify(listed);
    assert.equal(serialized.includes("zotero-library-test-key"), false);
    assert.equal(serialized.includes("credentialCiphertext"), false);
    assert.equal(serialized.includes("provider-detail-that-must-not-cross-the-dto"), false);

    await assert.rejects(
      selectZoteroLibraries({
        userId: ownerId,
        workspaceId,
        connectionId,
        command: {
          clientOperationId: "select-unreadable-library",
          expectedSelectionRevision: 0,
          selectedLibraryIds: [accessLost.id],
        },
      }, { database: prisma, now: () => discoveredAt }),
      problem("zotero_library_unreadable"),
    );

    const refreshedLibraries = await prisma.zoteroLibrary.findMany({
      where: { integrationConnectionId: connectionId },
    });
    const addedGroup = refreshedLibraries.find((library) => library.zoteroLibraryId === "99");
    assert.ok(addedGroup);
    const selectionCommand = {
      clientOperationId: "select-readable-libraries",
      expectedSelectionRevision: 0,
      selectedLibraryIds: [retained.id, addedGroup.id],
    };
    const applied = await selectZoteroLibraries({
      userId: ownerId,
      workspaceId,
      connectionId,
      requestId: "selection-request",
      command: selectionCommand,
    }, { database: prisma, now: () => discoveredAt });
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.selectionRevision, 1);
    assert.deepEqual(
      applied.libraries.filter((library) => library.syncEnabled).map((library) => library.id),
      [retained.id, addedGroup.id],
    );

    const replayed = await selectZoteroLibraries({
      userId: ownerId,
      workspaceId,
      connectionId,
      command: selectionCommand,
    }, { database: prisma, now: () => discoveredAt });
    assert.equal(replayed.outcome, "replayed");
    assert.equal(replayed.selectionRevision, 1);
    assert.deepEqual(replayed.libraries, applied.libraries);

    await assert.rejects(
      selectZoteroLibraries({
        userId: ownerId,
        workspaceId,
        connectionId,
        command: {
          ...selectionCommand,
          selectedLibraryIds: [retained.id],
        },
      }, { database: prisma, now: () => discoveredAt }),
      problem("idempotency_conflict"),
    );
    const noop = await selectZoteroLibraries({
      userId: ownerId,
      workspaceId,
      connectionId,
      command: {
        clientOperationId: "select-readable-libraries-noop",
        expectedSelectionRevision: 1,
        selectedLibraryIds: [retained.id, addedGroup.id],
      },
    }, { database: prisma, now: () => discoveredAt });
    assert.equal(noop.outcome, "noop");
    assert.equal(noop.selectionRevision, 1);

    await assert.rejects(
      selectZoteroLibraries({
        userId: ownerId,
        workspaceId,
        connectionId,
        command: {
          clientOperationId: "select-stale-revision",
          expectedSelectionRevision: 0,
          selectedLibraryIds: [retained.id],
        },
      }, { database: prisma, now: () => discoveredAt }),
      problem("zotero_selection_conflict"),
    );
    await assert.rejects(
      selectZoteroLibraries({
        userId: ownerId,
        workspaceId,
        connectionId,
        command: {
          clientOperationId: "select-foreign-library",
          expectedSelectionRevision: 1,
          selectedLibraryIds: ["foreign-library-id"],
        },
      }, { database: prisma, now: () => discoveredAt }),
      problem("zotero_library_invalid"),
    );

    const concurrentCommand = {
      clientOperationId: "select-concurrent-retry",
      expectedSelectionRevision: 1,
      selectedLibraryIds: [retained.id],
    };
    const concurrentResults = await Promise.all(
      Array.from({ length: 8 }, () => selectZoteroLibraries({
        userId: ownerId,
        workspaceId,
        connectionId,
        command: concurrentCommand,
      }, { database: prisma, now: () => discoveredAt })),
    );
    assert.equal(
      concurrentResults.filter((result) => result.outcome === "applied").length,
      1,
    );
    assert.equal(
      concurrentResults.filter((result) => result.outcome === "replayed").length,
      7,
    );
    assert.equal(new Set(concurrentResults.map((result) => result.selectionRevision)).size, 1);
    assert.equal(concurrentResults[0].selectionRevision, 2);

    const receipt = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        organizationId_key: {
          organizationId: workspaceId,
          key: selectionCommand.clientOperationId,
        },
      },
    });
    assert.equal(receipt.actorUserId, ownerId);
    assert.equal(receipt.command, "selectZoteroLibraries:v1");
    assert.equal(receipt.status, "COMPLETED");
    assert.match(receipt.requestHash, /^[a-f0-9]{64}$/);
    const audits = await prisma.auditEvent.findMany({
      where: { organizationId: workspaceId },
    });
    assert.ok(audits.some((audit) => audit.action === "zotero.libraries.discovered"));
    assert.ok(audits.some((audit) => audit.action === "zotero.libraries.selection_updated"));

    let providerRequestStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      providerRequestStarted = resolve;
    });
    let rejectOldCredential!: () => void;
    const waitForCredentialRotation = new Promise<void>((resolve) => {
      rejectOldCredential = resolve;
    });
    const staleDiscovery = discoverZoteroLibraries({
      userId: ownerId,
      workspaceId,
      connectionId,
    }, {
      database: prisma,
      credentialProtector: protector,
      providerClientFactory() {
        return {
          async getCurrentIdentity() {
            providerRequestStarted();
            await waitForCredentialRotation;
            throw new ZoteroAdapterError("The old key was rejected.", {
              code: "zotero_authentication_failed",
              status: 401,
              retryable: false,
            });
          },
          async listUserGroups() {
            assert.fail("group listing must not follow a failed identity request");
          },
        };
      },
      now: () => new Date("2026-08-28T20:02:00.000Z"),
    });
    await providerStarted;
    const replacementCredential = protector.protect("zotero-library-test-key", {
      organizationId: workspaceId,
      provider: "ZOTERO",
      subjectId: connectionId,
    });
    assert.equal(
      replacementCredential.fingerprint,
      protectedCredential.fingerprint,
      "rewrapping the same provider key intentionally preserves its fingerprint",
    );
    assert.notDeepEqual(
      replacementCredential.ciphertext,
      protectedCredential.ciphertext,
      "the protected credential tuple still changes when ciphertext is rewrapped",
    );
    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: {
        status: "CONNECTED",
        lastErrorCode: null,
        credentialCiphertext: Uint8Array.from(replacementCredential.ciphertext),
        credentialFingerprint: replacementCredential.fingerprint,
        credentialKeyVersion: replacementCredential.keyVersion,
        credentialGeneration: { increment: 1 },
      },
    });
    rejectOldCredential();
    await assert.rejects(staleDiscovery, problem("zotero_authentication_failed"));
    const afterStaleFailure = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    assert.equal(afterStaleFailure.status, "CONNECTED");
    assert.equal(afterStaleFailure.lastErrorCode, null);
    assert.equal(
      afterStaleFailure.credentialGeneration,
      2,
      "a stale discovery result is fenced even when fingerprint and key version are unchanged",
    );
    assert.equal(
      afterStaleFailure.credentialFingerprint,
      replacementCredential.fingerprint,
      "an old request cannot degrade or overwrite a concurrently rotated credential",
    );
  } finally {
    await prisma.auditEvent.deleteMany({ where: { organizationId: workspaceId } });
    await prisma.organization.delete({ where: { id: workspaceId } });
    await prisma.user.delete({ where: { id: ownerId } });
  }
});
