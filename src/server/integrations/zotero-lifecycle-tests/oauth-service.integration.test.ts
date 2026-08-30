import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createCredentialProtector } from "@/server/integrations/credential-protection";
import type { ZoteroIdentity } from "../zotero/contracts";
import {
  ZoteroOAuthCallbackError,
  ZoteroOAuthCriticalAuditError,
  ZoteroOAuthLifecycleService,
  cleanupZoteroOAuthAttempts,
  disconnectZoteroConnection,
  listZoteroConnections,
  retryPendingZoteroRevocations,
} from "../zotero/oauth-service";
import { ZoteroOAuthStateCodec } from "../zotero/oauth-state";

after(async () => {
  await prisma.$disconnect();
});

const CALLBACK_URL = new URL(
  "https://paperpilot.test/api/integrations/zotero/oauth/callback",
);

interface DatabaseFixture {
  workspaceId: string;
  ownerId: string;
  secondOwnerId: string;
  cleanup(): Promise<void>;
}

async function databaseFixture(label: string): Promise<DatabaseFixture> {
  const suffix = randomUUID();
  const ownerId = `${label}-owner-${suffix}`;
  const secondOwnerId = `${label}-second-${suffix}`;
  const workspaceId = `${label}-workspace-${suffix}`;
  await prisma.user.createMany({
    data: [
      { id: ownerId, name: "OAuth Owner", email: `${ownerId}@example.test` },
      { id: secondOwnerId, name: "OAuth Second", email: `${secondOwnerId}@example.test` },
    ],
  });
  await prisma.organization.create({
    data: {
      id: workspaceId,
      name: "OAuth lifecycle workspace",
      slug: workspaceId,
    },
  });
  await prisma.member.createMany({
    data: [
      { organizationId: workspaceId, userId: ownerId, role: "owner" },
      { organizationId: workspaceId, userId: secondOwnerId, role: "owner" },
    ],
  });
  return {
    workspaceId,
    ownerId,
    secondOwnerId,
    async cleanup() {
      await prisma.auditEvent.deleteMany({ where: { organizationId: workspaceId } });
      await prisma.organization.delete({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, secondOwnerId] } } });
    },
  };
}

interface LifecycleHarness {
  service: ZoteroOAuthLifecycleService;
  protector: ReturnType<typeof createCredentialProtector>;
  callbacks: URL[];
  exchangeCalls: number;
  verifiedTokens: string[];
  revokedTokens: string[];
  nowMs(value?: number): number;
  identity(value?: ZoteroIdentity): ZoteroIdentity;
  issueState(userId: string, workspaceId: string): string;
  revocationSucceeds(value?: boolean): boolean;
  revocationHandler(
    value?: ((accessToken: string) => Promise<boolean>) | null,
  ): ((accessToken: string) => Promise<boolean>) | null;
  afterVerify(
    value?: (() => Promise<void>) | null,
  ): (() => Promise<void>) | null;
}

function lifecycleHarness(
  label: string,
  options: {
    encryptionKey?: Uint8Array;
    fingerprintKey?: Uint8Array;
    accessTokenForRequest?: (requestToken: string) => string;
    database?: PrismaClient;
  } = {},
): LifecycleHarness {
  let clock = Math.floor(Date.now() / 1_000) * 1_000;
  let temporarySequence = 0;
  let idSequence = 0;
  let exchangeCalls = 0;
  let currentIdentity: ZoteroIdentity = {
    userId: "12345",
    username: "effective-user",
    displayName: "Effective Zotero User",
    access: {
      // Zotero personal-library access implicitly includes stored-file access.
      user: { library: true, files: true, notes: false, write: false },
      groups: {
        // /keys/current does not serialize a separate files bit for groups.
        all: { library: true, notes: false, write: false },
        "77": { library: true, notes: true, write: false },
        "88": { library: false, notes: false, write: false },
      },
    },
  };
  const callbacks: URL[] = [];
  const temporarySecrets = new Map<string, string>();
  const verifiedTokens: string[] = [];
  const revokedTokens: string[] = [];
  let revokeSucceeds = true;
  let customRevocationHandler: ((accessToken: string) => Promise<boolean>) | null = null;
  let afterVerifyHandler: (() => Promise<void>) | null = null;
  const protector = createCredentialProtector({
    activeVersion: "integration-v1",
    encryptionKeys: { "integration-v1": options.encryptionKey ?? randomBytes(32) },
    fingerprintKey: options.fingerprintKey ?? randomBytes(32),
  });
  const stateSecret = `${label}:state-secret:${"s".repeat(48)}`;
  const stateCodec = new ZoteroOAuthStateCodec({
    secret: stateSecret,
    clock: () => clock,
    nonce: () => `nonce_${label}_${temporarySequence}_${"n".repeat(32)}`,
  });

  const service = new ZoteroOAuthLifecycleService({
    database: options.database ?? prisma,
    credentialProtector: protector,
    stateCodec,
    stateHashSecret: stateSecret,
    callbackUrl: CALLBACK_URL,
    now: () => new Date(clock),
    id: () => `${label}-oauth-id-${idSequence += 1}-${randomUUID()}`,
    oauthClient: {
      async requestTemporaryCredentials(callback) {
        callbacks.push(new URL(callback.toString()));
        temporarySequence += 1;
        const requestToken = `${label}-request-token-${temporarySequence}`;
        const requestTokenSecret = `${label}-temporary-secret-${temporarySequence}`;
        temporarySecrets.set(requestToken, requestTokenSecret);
        return { requestToken, requestTokenSecret };
      },
      async exchangeAccessToken(input) {
        exchangeCalls += 1;
        assert.equal(temporarySecrets.get(input.requestToken), input.requestTokenSecret);
        assert.match(input.verifier, /^verifier-/);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
          accessToken:
            options.accessTokenForRequest?.(input.requestToken) ??
            `${label}-access-key-${input.requestToken}`,
          userId: "12345",
        };
      },
    },
    async verifyAccessToken({ accessToken }) {
      verifiedTokens.push(accessToken);
      const identity = structuredClone(currentIdentity);
      if (afterVerifyHandler) await afterVerifyHandler();
      return identity;
    },
    async revokeAccessToken(accessToken) {
      revokedTokens.push(accessToken);
      if (customRevocationHandler) return customRevocationHandler(accessToken);
      return revokeSucceeds;
    },
  });

  return {
    service,
    protector,
    callbacks,
    get exchangeCalls() {
      return exchangeCalls;
    },
    verifiedTokens,
    revokedTokens,
    nowMs(value?: number) {
      if (value !== undefined) clock = value;
      return clock;
    },
    identity(value?: ZoteroIdentity) {
      if (value) currentIdentity = structuredClone(value);
      return structuredClone(currentIdentity);
    },
    issueState(userId: string, workspaceId: string) {
      return stateCodec.issue({ userId, organizationId: workspaceId }).token;
    },
    revocationSucceeds(value?: boolean) {
      if (value !== undefined) revokeSucceeds = value;
      return revokeSucceeds;
    },
    revocationHandler(value) {
      if (value !== undefined) customRevocationHandler = value;
      return customRevocationHandler;
    },
    afterVerify(value) {
      if (value !== undefined) afterVerifyHandler = value;
      return afterVerifyHandler;
    },
  };
}

function callbackInput(harness: LifecycleHarness, index = -1) {
  const callback = harness.callbacks.at(index);
  assert.ok(callback);
  const state = callback.searchParams.get("state");
  assert.ok(state);
  return {
    state,
    requestToken: callback.pathname.includes("never")
      ? "never"
      : undefined,
  };
}

function requestTokenFor(label: string, sequence: number): string {
  return `${label}-request-token-${sequence}`;
}

function databaseErrorNames(error: unknown, name: string): boolean {
  return error instanceof Error && error.message.includes(name);
}

test("one atomic callback wins, persists only encrypted effective access, and replays stay inert", async () => {
  const fixture = await databaseFixture("zotero-success");
  const harness = lifecycleHarness("zotero-success");
  try {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
      requestId: "oauth-start-request",
    });
    const { state } = callbackInput(harness);
    const input = {
      userId: fixture.ownerId,
      state,
      requestToken: requestTokenFor("zotero-success", 1),
      verifier: "verifier-success",
      requestId: "oauth-callback-request",
    };

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => harness.service.complete(input)),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof harness.service.complete>>> =>
        result.status === "fulfilled",
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(
      results.filter(
        (result) => result.status === "rejected" && result.reason instanceof ZoteroOAuthCallbackError,
      ).length,
      11,
    );
    assert.equal(harness.exchangeCalls, 1, "only the winning claim may contact the token endpoint");

    const completed = fulfilled[0].value;
    const attempt = await prisma.zoteroOAuthAttempt.findFirstOrThrow({
      where: { organizationId: fixture.workspaceId },
    });
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(attempt.requestTokenSecretCiphertext, null);
    assert.equal(attempt.requestTokenSecretKeyVersion, null);
    assert.equal(attempt.integrationConnectionId, completed.connectionId);
    for (const digest of [
      attempt.stateTokenHash,
      attempt.stateNonceHash,
      attempt.requestTokenHash,
      attempt.callbackUrlHash,
    ]) {
      assert.match(digest, /^[a-f0-9]{64}$/);
    }
    assert.notEqual(attempt.stateTokenHash, state);
    assert.notEqual(attempt.requestTokenHash, input.requestToken);

    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: fixture.workspaceId,
          id: completed.connectionId,
        },
      },
      include: { zoteroLibraries: { orderBy: { zoteroLibraryId: "asc" } } },
    });
    assert.equal(connection.status, "CONNECTED");
    assert.deepEqual(connection.scopes, harness.identity().access);
    assert.deepEqual(connection.configuration, {
      requestedScopes: {
        profile: "personal_group_metadata_notes",
        libraryAccess: true,
        notesAccess: true,
        writeAccess: false,
        allGroups: "read",
      },
    });
    assert.ok(connection.credentialCiphertext);
    assert.ok(connection.credentialKeyVersion);
    assert.equal(connection.credentialGeneration, 1);
    assert.equal(
      harness.protector.reveal(
        connection.credentialCiphertext,
        connection.credentialKeyVersion,
        {
          organizationId: fixture.workspaceId,
          provider: "ZOTERO",
          subjectId: connection.id,
        },
      ),
      harness.verifiedTokens[0],
    );
    assert.equal(connection.zoteroLibraries.some((library) => library.zoteroLibraryId === "all"), false);
    assert.deepEqual(
      connection.zoteroLibraries.map((library) => [library.libraryType, library.zoteroLibraryId]),
      [["USER", "12345"], ["GROUP", "77"]],
    );
    assert.equal(
      connection.zoteroLibraries.find((library) => library.libraryType === "USER")?.fileAccessStatus,
      "AVAILABLE",
      "official personal-library access includes the stored-file capability",
    );
    assert.equal(
      connection.zoteroLibraries.find((library) => library.libraryType === "GROUP")?.fileAccessStatus,
      "UNKNOWN",
      "group /keys/current permissions defer the file-access check until import",
    );
    assert.equal(
      connection.zoteroLibraries.every((library) => library.isReadable),
      true,
      "OAuth establishes provider readability independently of user selection",
    );
    assert.equal(
      connection.zoteroLibraries.every((library) => !library.syncEnabled),
      true,
      "new OAuth libraries require an explicit post-discovery selection",
    );

    const listed = await listZoteroConnections(fixture.ownerId, fixture.workspaceId);
    assert.equal(listed.connections.length, 1);
    assert.equal(listed.connections[0].id, connection.id);
    const serializedList = JSON.stringify(listed);
    for (const forbidden of [
      harness.verifiedTokens[0],
      "credentialCiphertext",
      "credentialFingerprint",
      "credentialKeyVersion",
      "configuration",
    ]) {
      assert.equal(serializedList.includes(forbidden), false);
    }

    await assert.rejects(() => harness.service.complete(input), ZoteroOAuthCallbackError);
    assert.equal(harness.exchangeCalls, 1);
    assert.equal(
      (await prisma.zoteroOAuthAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      "SUCCEEDED",
      "a replay must not demote the winning attempt",
    );

    const auditText = JSON.stringify(await prisma.auditEvent.findMany({
      where: { organizationId: fixture.workspaceId },
    }));
    for (const secret of [state, input.requestToken, "temporary-secret", harness.verifiedTokens[0]]) {
      assert.equal(auditText.includes(secret), false);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a lost COMMIT acknowledgement reconciles the live key instead of revoking it", async () => {
  const fixture = await databaseFixture("zotero-ambiguous-commit");
  let injectedCommitAcknowledgementLoss = false;
  const ambiguousDatabase = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return async (...arguments_: unknown[]) => {
          const transaction = target.$transaction.bind(target) as unknown as (
            ...input: unknown[]
          ) => Promise<unknown>;
          const result = await transaction(...arguments_);
          if (
            !injectedCommitAcknowledgementLoss &&
            typeof result === "object" &&
            result !== null &&
            "connectionId" in result
          ) {
            injectedCommitAcknowledgementLoss = true;
            throw new Error("simulated lost COMMIT acknowledgement");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
  const harness = lifecycleHarness("zotero-ambiguous-commit", {
    database: ambiguousDatabase,
  });
  try {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const completed = await harness.service.complete({
      userId: fixture.ownerId,
      state: callbackInput(harness).state,
      requestToken: requestTokenFor("zotero-ambiguous-commit", 1),
      verifier: "verifier-ambiguous-commit",
    });
    assert.equal(injectedCommitAcknowledgementLoss, true);
    assert.deepEqual(harness.revokedTokens, []);
    const attempt = await prisma.zoteroOAuthAttempt.findFirstOrThrow({
      where: { organizationId: fixture.workspaceId },
    });
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(attempt.integrationConnectionId, completed.connectionId);
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: completed.connectionId },
    });
    assert.equal(connection.status, "CONNECTED");
    assert.equal(
      connection.credentialFingerprint,
      harness.protector.fingerprint(harness.verifiedTokens[0]),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("wrong actors do not consume attempts while wrong tokens, expiry, and provider failures do", async () => {
  const fixture = await databaseFixture("zotero-failure");
  const harness = lifecycleHarness("zotero-failure");
  try {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const firstState = callbackInput(harness).state;
    assert.equal(
      await harness.service.workspaceIdForState(firstState, fixture.secondOwnerId),
      null,
    );
    assert.equal(
      await harness.service.workspaceIdForState(firstState, fixture.ownerId),
      fixture.workspaceId,
    );
    await assert.rejects(
      () => harness.service.complete({
        userId: fixture.secondOwnerId,
        state: firstState,
        requestToken: requestTokenFor("zotero-failure", 1),
        verifier: "verifier-wrong-user",
      }),
      ZoteroOAuthCallbackError,
    );
    let attempt = await prisma.zoteroOAuthAttempt.findFirstOrThrow({
      where: { organizationId: fixture.workspaceId },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(attempt.status, "PENDING");
    assert.ok(attempt.requestTokenSecretCiphertext);
    const otherWorkspaceState = harness.issueState(
      fixture.ownerId,
      `different-workspace-${randomUUID()}`,
    );
    assert.equal(
      await harness.service.workspaceIdForState(otherWorkspaceState, fixture.ownerId),
      null,
      "a valid state signed for another workspace cannot select this tenant's attempt",
    );

    await assert.rejects(
      () => harness.service.complete({
        userId: fixture.ownerId,
        state: firstState,
        requestToken: "wrong-request-token",
        verifier: "verifier-wrong-token",
      }),
      ZoteroOAuthCallbackError,
    );
    attempt = await prisma.zoteroOAuthAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    assert.equal(attempt.status, "FAILED");
    assert.equal(attempt.requestTokenSecretCiphertext, null);
    assert.equal(harness.exchangeCalls, 0);

    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const expiredState = callbackInput(harness).state;
    harness.nowMs(harness.nowMs() + 10 * 60 * 1_000);
    await assert.rejects(
      () => harness.service.complete({
        userId: fixture.ownerId,
        state: expiredState,
        requestToken: requestTokenFor("zotero-failure", 2),
        verifier: "verifier-expired",
      }),
      ZoteroOAuthCallbackError,
    );
    const expired = await prisma.zoteroOAuthAttempt.findFirstOrThrow({
      where: { organizationId: fixture.workspaceId, status: "EXPIRED" },
    });
    assert.equal(expired.requestTokenSecretCiphertext, null);
    assert.equal(expired.failureCode, "oauth_attempt_expired");

    harness.nowMs(Math.floor(Date.now() / 1_000) * 1_000);
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const mismatchState = callbackInput(harness).state;
    harness.identity({
      userId: "99999",
      access: { user: { library: true } },
    });
    await assert.rejects(
      () => harness.service.complete({
        userId: fixture.ownerId,
        state: mismatchState,
        requestToken: requestTokenFor("zotero-failure", 3),
        verifier: "verifier-provider-mismatch",
      }),
      ZoteroOAuthCallbackError,
    );
    const failed = await prisma.zoteroOAuthAttempt.findFirstOrThrow({
      where: {
        organizationId: fixture.workspaceId,
        requestTokenHash: { not: expired.requestTokenHash },
        status: "FAILED",
        claimedAt: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(failed.requestTokenSecretCiphertext, null);

    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const overprivilegedState = callbackInput(harness).state;
    harness.identity({
      userId: "12345",
      access: { user: { library: true, write: true } },
    });
    await assert.rejects(
      () => harness.service.complete({
        userId: fixture.ownerId,
        state: overprivilegedState,
        requestToken: requestTokenFor("zotero-failure", 4),
        verifier: "verifier-provider-overprivileged",
      }),
      ZoteroOAuthCallbackError,
    );
    const overprivileged = await prisma.zoteroOAuthAttempt.findFirstOrThrow({
      where: { organizationId: fixture.workspaceId },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(overprivileged.status, "FAILED");
    assert.equal(overprivileged.requestTokenSecretCiphertext, null);

    const incoherentFileAccess: ZoteroIdentity[] = [
      {
        userId: "12345",
        access: { user: { library: false, files: true, write: false } },
      },
      {
        userId: "12345",
        access: {
          user: { library: true, files: true, write: false },
          groups: { "77": { library: false, files: true, write: false } },
        },
      },
    ];
    for (const [index, identity] of incoherentFileAccess.entries()) {
      await harness.service.start({
        userId: fixture.ownerId,
        workspaceId: fixture.workspaceId,
        scopeProfile: "personal_group_metadata_notes",
      });
      harness.identity(identity);
      await assert.rejects(
        () => harness.service.complete({
          userId: fixture.ownerId,
          state: callbackInput(harness).state,
          requestToken: requestTokenFor("zotero-failure", 5 + index),
          verifier: `verifier-provider-files-${index}`,
        }),
        ZoteroOAuthCallbackError,
      );
    }
    assert.equal(
      await prisma.zoteroOAuthAttempt.count({
        where: {
          organizationId: fixture.workspaceId,
          status: "FAILED",
          claimedAt: { not: null },
        },
      }),
      4,
      "identity mismatch, write access, and both incoherent file-access variants are consumed",
    );
    assert.equal(
      await prisma.integrationConnection.count({ where: { organizationId: fixture.workspaceId } }),
      0,
    );
    assert.deepEqual(
      harness.revokedTokens,
      [],
      "an exchanged-but-unattributed provider key is never auto-revoked",
    );
    assert.equal(
      await prisma.auditEvent.count({
        where: {
          organizationId: fixture.workspaceId,
          action: "zotero.credential_persistence_uncertain",
        },
      }),
      4,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("start-time hygiene expires abandoned secrets and bounded retention removes old terminal attempts", async () => {
  const fixture = await databaseFixture("zotero-cleanup");
  const harness = lifecycleHarness("zotero-cleanup");
  try {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const abandoned = await prisma.zoteroOAuthAttempt.findFirstOrThrow({
      where: { organizationId: fixture.workspaceId, status: "PENDING" },
    });
    assert.ok(abandoned.requestTokenSecretCiphertext);

    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const crashAfterClaim = await prisma.zoteroOAuthAttempt.findFirstOrThrow({
      where: {
        organizationId: fixture.workspaceId,
        status: "PENDING",
        id: { not: abandoned.id },
      },
      orderBy: { createdAt: "desc" },
    });
    await prisma.zoteroOAuthAttempt.update({
      where: { id: crashAfterClaim.id },
      data: {
        status: "CLAIMED",
        claimedAt: new Date(harness.nowMs()),
        requestTokenSecretCiphertext: null,
        requestTokenSecretKeyVersion: null,
      },
    });

    harness.nowMs(harness.nowMs() + 11 * 60 * 1_000);
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const expired = await prisma.zoteroOAuthAttempt.findUniqueOrThrow({
      where: { id: abandoned.id },
    });
    assert.equal(expired.status, "EXPIRED");
    assert.equal(expired.requestTokenSecretCiphertext, null);
    assert.equal(expired.requestTokenSecretKeyVersion, null);
    assert.equal(
      (await prisma.zoteroOAuthAttempt.findUniqueOrThrow({
        where: { id: crashAfterClaim.id },
      })).status,
      "CLAIMED",
      "a callback claimed near expiry keeps its separate processing lease",
    );

    harness.nowMs(harness.nowMs() + 5 * 60 * 1_000);
    const staleClaimCleanup = await cleanupZoteroOAuthAttempts(
      prisma,
      new Date(harness.nowMs()),
      fixture.workspaceId,
    );
    assert.equal(staleClaimCleanup.expired, 1);
    assert.equal(
      (await prisma.zoteroOAuthAttempt.findUniqueOrThrow({
        where: { id: crashAfterClaim.id },
      })).status,
      "EXPIRED",
    );

    const oldCompletion = new Date(
      harness.nowMs() - 31 * 24 * 60 * 60 * 1_000,
    );
    await prisma.zoteroOAuthAttempt.update({
      where: { id: abandoned.id },
      data: { completedAt: oldCompletion },
    });
    const cleaned = await cleanupZoteroOAuthAttempts(
      prisma,
      new Date(harness.nowMs()),
      fixture.workspaceId,
    );
    assert.equal(cleaned.deleted, 1);
    assert.equal(
      await prisma.zoteroOAuthAttempt.findUnique({ where: { id: abandoned.id } }),
      null,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("database constraints reject partial envelopes, invalid lifetimes, and cross-tenant links", async () => {
  const fixture = await databaseFixture("zotero-constraints");
  const otherWorkspaceId = `zotero-other-${randomUUID()}`;
  try {
    await prisma.organization.create({
      data: {
        id: otherWorkspaceId,
        name: "Other OAuth tenant",
        slug: otherWorkspaceId,
      },
    });
    const foreignConnection = await prisma.integrationConnection.create({
      data: {
        organizationId: otherWorkspaceId,
        provider: "ZOTERO",
        authType: "OAUTH1",
        status: "PENDING",
      },
    });

    await assert.rejects(
      () => prisma.integrationConnection.create({
        data: {
          organizationId: fixture.workspaceId,
          provider: "ZOTERO",
          authType: "OAUTH1",
          status: "CONNECTED",
          credentialCiphertext: Uint8Array.from([1, 2, 3]),
          credentialGeneration: 1,
        },
      }),
      (error: unknown) =>
        databaseErrorNames(error, "IntegrationConnection_credential_envelope_check"),
    );

    await assert.rejects(
      () => prisma.integrationConnection.create({
        data: {
          organizationId: fixture.workspaceId,
          provider: "ZOTERO",
          authType: "OAUTH1",
          status: "CONNECTED",
          credentialCiphertext: Uint8Array.from([1, 2, 3]),
          credentialFingerprint: `generation-zero-${randomUUID()}`,
          credentialKeyVersion: "integration-v1",
        },
      }),
      (error: unknown) =>
        databaseErrorNames(error, "IntegrationConnection_credential_generation_check"),
    );

    const baseAttempt = {
      organizationId: fixture.workspaceId,
      userId: fixture.ownerId,
      stateTokenHash: "a".repeat(64),
      stateNonceHash: "b".repeat(64),
      requestTokenHash: "c".repeat(64),
      callbackUrlHash: "d".repeat(64),
      requestTokenSecretCiphertext: Uint8Array.from([1, 2, 3]),
      requestTokenSecretKeyVersion: "integration-v1",
      requestedScopes: { profile: "personal_metadata" },
    } as const;
    await assert.rejects(
      () => prisma.zoteroOAuthAttempt.create({
        data: {
          ...baseAttempt,
          expiresAt: new Date(0),
        },
      }),
      (error: unknown) =>
        databaseErrorNames(error, "ZoteroOAuthAttempt_valid_lifetime_check"),
    );

    await assert.rejects(
      () => prisma.zoteroOAuthAttempt.create({
        data: {
          ...baseAttempt,
          stateTokenHash: "e".repeat(64),
          stateNonceHash: "f".repeat(64),
          requestTokenHash: "0".repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
          integrationConnectionId: foreignConnection.id,
        },
      }),
      (error: unknown) =>
        databaseErrorNames(
          error,
          "ZoteroOAuthAttempt_organizationId_integrationConnectionId_fkey",
        ),
    );
  } finally {
    await prisma.integrationConnection.deleteMany({
      where: { organizationId: otherWorkspaceId },
    });
    await prisma.organization.deleteMany({ where: { id: otherWorkspaceId } });
    await fixture.cleanup();
  }
});

test("disconnect erases local ciphertext before bounded best-effort revocation", async () => {
  const fixture = await databaseFixture("zotero-disconnect");
  const harness = lifecycleHarness("zotero-disconnect");
  try {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const state = callbackInput(harness).state;
    const completed = await harness.service.complete({
      userId: fixture.ownerId,
      state,
      requestToken: requestTokenFor("zotero-disconnect", 1),
      verifier: "verifier-disconnect",
    });
    const selectedLibrary = await prisma.zoteroLibrary.findFirstOrThrow({
      where: {
        integrationConnectionId: completed.connectionId,
        libraryType: "GROUP",
        zoteroLibraryId: "77",
      },
    });
    await prisma.zoteroLibrary.update({
      where: { id: selectedLibrary.id },
      data: { syncEnabled: true },
    });
    const missingSelectedLibrary = await prisma.zoteroLibrary.create({
      data: {
        organizationId: fixture.workspaceId,
        integrationConnectionId: completed.connectionId,
        libraryType: "GROUP",
        zoteroLibraryId: "999",
        name: "Former group",
        isReadable: true,
        syncEnabled: true,
      },
    });
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const reconnectState = callbackInput(harness).state;
    const reconnected = await harness.service.complete({
      userId: fixture.ownerId,
      state: reconnectState,
      requestToken: requestTokenFor("zotero-disconnect", 2),
      verifier: "verifier-reconnect",
    });
    assert.equal(reconnected.connectionId, completed.connectionId);
    const reconnectedConnection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: reconnected.connectionId },
      select: { credentialGeneration: true },
    });
    assert.equal(
      reconnectedConnection.credentialGeneration,
      2,
      "reconnecting with a replacement credential advances the generation",
    );
    assert.deepEqual(
      harness.revokedTokens,
      [harness.verifiedTokens[0]],
      "reauthorization revokes the superseded remote key after commit",
    );
    const reconnectedLibraries = await prisma.zoteroLibrary.findMany({
      where: { integrationConnectionId: reconnected.connectionId },
    });
    assert.equal(
      reconnectedLibraries.find((library) => library.id === selectedLibrary.id)?.syncEnabled,
      true,
      "reauthorization retains an existing readable selection",
    );
    const missingAfterReconnect = reconnectedLibraries.find(
      (library) => library.id === missingSelectedLibrary.id,
    );
    assert.equal(missingAfterReconnect?.isReadable, false);
    assert.equal(
      missingAfterReconnect?.syncEnabled,
      true,
      "reauthorization records permission loss without erasing selection intent",
    );
    assert.ok(missingAfterReconnect?.accessLostAt);
    const result = await harness.service.disconnect({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      connectionId: reconnected.connectionId,
      requestId: "disconnect-request",
    });
    assert.deepEqual(result, {
      disconnected: true,
      remoteRevocationAttempted: true,
    });
    assert.deepEqual(harness.revokedTokens, harness.verifiedTokens);
    assert.deepEqual(
      await harness.service.disconnect({
        userId: fixture.ownerId,
        workspaceId: fixture.workspaceId,
        connectionId: reconnected.connectionId,
        requestId: "disconnect-replay-request",
      }),
      { disconnected: true, remoteRevocationAttempted: false },
      "repeating an already-erased disconnect must not manufacture a new credential generation",
    );

    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: completed.connectionId },
      include: { zoteroLibraries: true },
    });
    assert.equal(connection.status, "DISCONNECTED");
    assert.equal(connection.credentialCiphertext, null);
    assert.equal(connection.credentialFingerprint, null);
    assert.equal(connection.credentialKeyVersion, null);
    assert.equal(
      connection.credentialGeneration,
      3,
      "credential erasure advances the reconnect generation once more",
    );
    assert.ok(connection.revokedAt);
    assert.equal(connection.zoteroLibraries.every((library) => !library.syncEnabled), true);

    const corruptConnection = await prisma.integrationConnection.create({
      data: {
        id: `corrupt-zotero-${randomUUID()}`,
        organizationId: fixture.workspaceId,
        provider: "ZOTERO",
        authType: "OAUTH1",
        status: "CONNECTED",
        externalAccountId: "98765",
        credentialCiphertext: Uint8Array.from([1, 2, 3]),
        credentialFingerprint: `corrupt-${randomUUID()}`,
        credentialKeyVersion: "integration-v1",
        credentialGeneration: 1,
      },
    });
    assert.deepEqual(
      await harness.service.disconnect({
        userId: fixture.ownerId,
        workspaceId: fixture.workspaceId,
        connectionId: corruptConnection.id,
      }),
      { disconnected: true, remoteRevocationAttempted: false },
    );
    const erasedCorruptConnection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: corruptConnection.id },
    });
    assert.equal(erasedCorruptConnection.credentialCiphertext, null);
    assert.equal(erasedCorruptConnection.credentialGeneration, 2);
    assert.equal(
      erasedCorruptConnection.lastErrorCode,
      "remote_revocation_unconfirmed",
      "lost remote revocation handles remain visible for manual follow-up",
    );

    const configlessConnectionId = `configless-zotero-${randomUUID()}`;
    const configlessEnvelope = harness.protector.protect(
      "still-active-remote-key",
      {
        organizationId: fixture.workspaceId,
        provider: "ZOTERO",
        subjectId: configlessConnectionId,
      },
    );
    await prisma.integrationConnection.create({
      data: {
        id: configlessConnectionId,
        organizationId: fixture.workspaceId,
        provider: "ZOTERO",
        authType: "OAUTH1",
        status: "CONNECTED",
        externalAccountId: "87654",
        credentialCiphertext: Uint8Array.from(configlessEnvelope.ciphertext),
        credentialFingerprint: configlessEnvelope.fingerprint,
        credentialKeyVersion: configlessEnvelope.keyVersion,
        credentialGeneration: 1,
      },
    });
    assert.deepEqual(
      await disconnectZoteroConnection(
        {
          userId: fixture.ownerId,
          workspaceId: fixture.workspaceId,
          connectionId: configlessConnectionId,
        },
        { database: prisma },
      ),
      { disconnected: true, remoteRevocationAttempted: false },
    );
    const configlessErased = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: configlessConnectionId },
    });
    assert.equal(configlessErased.credentialCiphertext, null);
    assert.equal(configlessErased.credentialGeneration, 2);
    assert.equal(configlessErased.lastErrorCode, "remote_revocation_unconfirmed");
  } finally {
    await fixture.cleanup();
  }
});

test("fingerprint-key rotation never revokes an unchanged provider key", async () => {
  const fixture = await databaseFixture("zotero-fingerprint-rotation");
  const encryptionKey = randomBytes(32);
  const fixedAccessToken = "unchanged-zotero-provider-key";
  const oldHarness = lifecycleHarness("zotero-fingerprint-old", {
    encryptionKey,
    fingerprintKey: randomBytes(32),
    accessTokenForRequest: () => fixedAccessToken,
  });
  const newHarness = lifecycleHarness("zotero-fingerprint-new", {
    encryptionKey,
    fingerprintKey: randomBytes(32),
    accessTokenForRequest: () => fixedAccessToken,
  });
  try {
    await oldHarness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const first = await oldHarness.service.complete({
      userId: fixture.ownerId,
      state: callbackInput(oldHarness).state,
      requestToken: requestTokenFor("zotero-fingerprint-old", 1),
      verifier: "verifier-old-fingerprint",
    });
    const firstConnection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    const oldFingerprint = firstConnection.credentialFingerprint;
    assert.equal(firstConnection.credentialGeneration, 1);

    await newHarness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const reconnected = await newHarness.service.complete({
      userId: fixture.ownerId,
      state: callbackInput(newHarness).state,
      requestToken: requestTokenFor("zotero-fingerprint-new", 1),
      verifier: "verifier-new-fingerprint",
    });
    assert.equal(reconnected.connectionId, first.connectionId);
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    assert.notEqual(connection.credentialFingerprint, oldFingerprint);
    assert.equal(connection.credentialGeneration, 2);
    assert.deepEqual(newHarness.revokedTokens, []);
    assert.equal(JSON.stringify(connection.configuration).includes("pendingRevocations"), false);
    assert.equal(connection.status, "CONNECTED");
  } finally {
    await fixture.cleanup();
  }
});

test("post-exchange role loss cannot revoke a same key live in another workspace after fingerprint rotation", async () => {
  const liveFixture = await databaseFixture("zotero-live-key-workspace");
  const failingFixture = await databaseFixture("zotero-failed-reconnect-workspace");
  const encryptionKey = randomBytes(32);
  const sameProviderKey = "cross-workspace-zotero-provider-key";
  const oldHarness = lifecycleHarness("zotero-live-key-old-fingerprint", {
    encryptionKey,
    fingerprintKey: randomBytes(32),
    accessTokenForRequest: () => sameProviderKey,
  });
  const newHarness = lifecycleHarness("zotero-live-key-new-fingerprint", {
    encryptionKey,
    fingerprintKey: randomBytes(32),
    accessTokenForRequest: () => sameProviderKey,
  });
  try {
    await oldHarness.service.start({
      userId: liveFixture.ownerId,
      workspaceId: liveFixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const live = await oldHarness.service.complete({
      userId: liveFixture.ownerId,
      state: callbackInput(oldHarness).state,
      requestToken: requestTokenFor("zotero-live-key-old-fingerprint", 1),
      verifier: "verifier-live-key",
    });
    const liveBefore = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: live.connectionId },
    });
    assert.notEqual(
      liveBefore.credentialFingerprint,
      newHarness.protector.fingerprint(sameProviderKey),
      "the guard must not rely on a fingerprint generated by the rotated key",
    );

    await newHarness.service.start({
      userId: failingFixture.ownerId,
      workspaceId: failingFixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    newHarness.afterVerify(async () => {
      await prisma.member.update({
        where: {
          organizationId_userId: {
            organizationId: failingFixture.workspaceId,
            userId: failingFixture.ownerId,
          },
        },
        data: { role: "member" },
      });
    });
    await assert.rejects(
      () => newHarness.service.complete({
        userId: failingFixture.ownerId,
        state: callbackInput(newHarness).state,
        requestToken: requestTokenFor("zotero-live-key-new-fingerprint", 1),
        verifier: "verifier-role-loss",
      }),
      ZoteroOAuthCallbackError,
    );
    assert.deepEqual(
      newHarness.revokedTokens,
      [],
      "the unpersisted cleanup must not delete a provider key used elsewhere",
    );
    assert.equal(
      await prisma.integrationConnection.count({
        where: { organizationId: failingFixture.workspaceId },
      }),
      0,
    );
    assert.equal(
      (await prisma.zoteroOAuthAttempt.findFirstOrThrow({
        where: { organizationId: failingFixture.workspaceId },
      })).status,
      "FAILED",
    );
    const liveAfter = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: live.connectionId },
    });
    assert.equal(liveAfter.status, "CONNECTED");
    assert.equal(
      newHarness.protector.reveal(
        liveAfter.credentialCiphertext!,
        liveAfter.credentialKeyVersion!,
        {
          organizationId: liveFixture.workspaceId,
          provider: "ZOTERO",
          subjectId: liveAfter.id,
        },
      ),
      sameProviderKey,
    );
    assert.equal(
      await prisma.auditEvent.count({
        where: {
          organizationId: failingFixture.workspaceId,
          action: "zotero.credential_persistence_uncertain",
        },
      }),
      1,
    );
  } finally {
    newHarness.afterVerify(null);
    await failingFixture.cleanup();
    await liveFixture.cleanup();
  }
});

test("a concurrent cross-workspace same-key commit cannot be raced by failed-callback cleanup", async () => {
  const failingFixture = await databaseFixture("zotero-concurrent-failing");
  const liveFixture = await databaseFixture("zotero-concurrent-live");
  const sameProviderKey = "concurrently-shared-zotero-key";
  const harness = lifecycleHarness("zotero-concurrent-same-key", {
    accessTokenForRequest: () => sameProviderKey,
  });
  try {
    await harness.service.start({
      userId: failingFixture.ownerId,
      workspaceId: failingFixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const failingInput = {
      userId: failingFixture.ownerId,
      state: callbackInput(harness).state,
      requestToken: requestTokenFor("zotero-concurrent-same-key", 1),
      verifier: "verifier-concurrent-failing",
    };
    await harness.service.start({
      userId: liveFixture.ownerId,
      workspaceId: liveFixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    const liveInput = {
      userId: liveFixture.ownerId,
      state: callbackInput(harness).state,
      requestToken: requestTokenFor("zotero-concurrent-same-key", 2),
      verifier: "verifier-concurrent-live",
    };

    let announceFailingVerify!: () => void;
    const failingVerifyReached = new Promise<void>((resolve) => {
      announceFailingVerify = resolve;
    });
    let releaseFailingVerify!: () => void;
    const failingVerifyRelease = new Promise<void>((resolve) => {
      releaseFailingVerify = resolve;
    });
    let verifyCalls = 0;
    harness.afterVerify(async () => {
      verifyCalls += 1;
      if (verifyCalls !== 1) return;
      announceFailingVerify();
      await failingVerifyRelease;
      await prisma.member.update({
        where: {
          organizationId_userId: {
            organizationId: failingFixture.workspaceId,
            userId: failingFixture.ownerId,
          },
        },
        data: { role: "member" },
      });
    });

    const failingCompletion = harness.service.complete(failingInput);
    await failingVerifyReached;
    let live: Awaited<ReturnType<typeof harness.service.complete>>;
    try {
      live = await harness.service.complete(liveInput);
    } finally {
      releaseFailingVerify();
    }
    await assert.rejects(failingCompletion, ZoteroOAuthCallbackError);

    assert.deepEqual(
      harness.revokedTokens,
      [],
      "failed callback cleanup must never race DELETE against a concurrent live commit",
    );
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: live.connectionId },
    });
    assert.equal(connection.organizationId, liveFixture.workspaceId);
    assert.equal(connection.status, "CONNECTED");
    assert.equal(
      harness.protector.reveal(
        connection.credentialCiphertext!,
        connection.credentialKeyVersion!,
        {
          organizationId: liveFixture.workspaceId,
          provider: "ZOTERO",
          subjectId: connection.id,
        },
      ),
      sameProviderKey,
    );
    assert.equal(
      await prisma.integrationConnection.count({
        where: { organizationId: failingFixture.workspaceId },
      }),
      0,
    );
    assert.equal(
      await prisma.auditEvent.count({
        where: {
          organizationId: failingFixture.workspaceId,
          action: "zotero.credential_persistence_uncertain",
        },
      }),
      1,
    );
  } finally {
    harness.afterVerify(null);
    await failingFixture.cleanup();
    await liveFixture.cleanup();
  }
});

test("manual-cleanup audit persistence is retried and never swallowed", async () => {
  const fixture = await databaseFixture("zotero-critical-audit");
  let criticalAuditAttempts = 0;
  const auditDelegate = new Proxy(prisma.auditEvent, {
    get(target, property, receiver) {
      if (property === "create") {
        return async (
          args: Parameters<typeof prisma.auditEvent.create>[0],
        ) => {
          if (args.data.action === "zotero.credential_persistence_uncertain") {
            criticalAuditAttempts += 1;
            throw new Error("simulated audit database failure");
          }
          return prisma.auditEvent.create(args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const failingAuditDatabase = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "auditEvent") return auditDelegate;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
  const harness = lifecycleHarness("zotero-critical-audit", {
    database: failingAuditDatabase,
  });
  try {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    harness.afterVerify(async () => {
      await prisma.member.update({
        where: {
          organizationId_userId: {
            organizationId: fixture.workspaceId,
            userId: fixture.ownerId,
          },
        },
        data: { role: "member" },
      });
    });
    await assert.rejects(
      () => harness.service.complete({
        userId: fixture.ownerId,
        state: callbackInput(harness).state,
        requestToken: requestTokenFor("zotero-critical-audit", 1),
        verifier: "verifier-critical-audit",
      }),
      (error: unknown) =>
        error instanceof ZoteroOAuthCriticalAuditError &&
        error.code === "zotero_oauth_critical_audit_failed" &&
        !error.message.includes(harness.verifiedTokens[0]),
    );
    assert.equal(criticalAuditAttempts, 3);
    assert.deepEqual(harness.revokedTokens, []);
  } finally {
    harness.afterVerify(null);
    await fixture.cleanup();
  }
});

test("confirming a newer revocation never clears an older unrecoverable warning", async () => {
  const fixture = await databaseFixture("zotero-warning-ownership");
  const harness = lifecycleHarness("zotero-warning-ownership");
  async function connect(sequence: number) {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    return harness.service.complete({
      userId: fixture.ownerId,
      state: callbackInput(harness).state,
      requestToken: requestTokenFor("zotero-warning-ownership", sequence),
      verifier: `verifier-warning-${sequence}`,
    });
  }

  try {
    const first = await connect(1);
    const connectionBefore = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    await prisma.integrationConnection.update({
      where: { id: first.connectionId },
      data: {
        status: "DEGRADED",
        lastErrorCode: "previous_key_revocation_unconfirmed",
        configuration: {
          ...(connectionBefore.configuration as Record<string, unknown>),
          unreadablePendingRevocations: [{ opaqueEnvelope: true }],
        },
      },
    });

    await connect(2);
    const connectionAfter = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    assert.equal(connectionAfter.status, "DEGRADED");
    assert.equal(
      connectionAfter.lastErrorCode,
      "previous_key_revocation_unconfirmed",
    );
    assert.equal(
      JSON.stringify(connectionAfter.configuration).includes(
        "unreadablePendingRevocations",
      ),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("mixed disconnect and superseded queues clear the final warning regardless of reason", async () => {
  const fixture = await databaseFixture("zotero-mixed-revocations");
  const harness = lifecycleHarness("zotero-mixed-revocations");
  async function connect(sequence: number) {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    return harness.service.complete({
      userId: fixture.ownerId,
      state: callbackInput(harness).state,
      requestToken: requestTokenFor("zotero-mixed-revocations", sequence),
      verifier: `verifier-mixed-${sequence}`,
    });
  }

  try {
    const first = await connect(1);
    harness.revocationSucceeds(false);
    await harness.service.disconnect({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      connectionId: first.connectionId,
    });
    await connect(2);
    await connect(3);

    let retrySucceeds = false;
    const retry = () => retryPendingZoteroRevocations(
      {
        organizationId: fixture.workspaceId,
        credentialProtector: harness.protector,
        revokeAccessToken: async (token) => {
          harness.revokedTokens.push(token);
          return retrySucceeds;
        },
        limit: 1,
      },
      prisma,
    );
    await retry();
    assert.equal(
      (await prisma.integrationConnection.findUniqueOrThrow({
        where: { id: first.connectionId },
      })).lastErrorCode,
      "remote_revocation_unconfirmed",
    );

    retrySucceeds = true;
    assert.deepEqual(await retry(), { attempted: 1, confirmed: 1 });
    assert.deepEqual(await retry(), { attempted: 1, confirmed: 1 });
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    assert.equal(connection.status, "CONNECTED");
    assert.equal(connection.lastErrorCode, null);
    assert.equal(JSON.stringify(connection.configuration).includes("pendingRevocations"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("a leased revocation cannot delete a concurrently reinstalled provider key", async () => {
  const fixture = await databaseFixture("zotero-reinstall-race");
  const tokenA = "zotero-provider-key-a";
  const tokenB = "zotero-provider-key-b";
  const harness = lifecycleHarness("zotero-reinstall-race", {
    accessTokenForRequest: (requestToken) =>
      requestToken.endsWith("-2") ? tokenB : tokenA,
  });
  async function start(sequence: number) {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    return {
      userId: fixture.ownerId,
      state: callbackInput(harness).state,
      requestToken: requestTokenFor("zotero-reinstall-race", sequence),
      verifier: `verifier-reinstall-${sequence}`,
    };
  }

  try {
    const first = await harness.service.complete(await start(1));
    let announceFirstDelete!: () => void;
    const firstDeleteStarted = new Promise<void>((resolve) => {
      announceFirstDelete = resolve;
    });
    let finishFirstDelete!: (value: boolean) => void;
    const firstDeleteResult = new Promise<boolean>((resolve) => {
      finishFirstDelete = resolve;
    });
    let deleteCalls = 0;
    harness.revocationHandler(async () => {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        announceFirstDelete();
        return firstDeleteResult;
      }
      return true;
    });

    const secondCompletion = harness.service.complete(await start(2));
    await firstDeleteStarted;
    await assert.rejects(
      async () => harness.service.complete(await start(3)),
      ZoteroOAuthCallbackError,
      "a callback cannot install a key already claimed by the revocation worker",
    );
    finishFirstDelete(true);
    const second = await secondCompletion;
    assert.equal(second.connectionId, first.connectionId);

    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    assert.equal(connection.status, "CONNECTED");
    assert.equal(
      harness.protector.reveal(
        connection.credentialCiphertext!,
        connection.credentialKeyVersion!,
        {
          organizationId: fixture.workspaceId,
          provider: "ZOTERO",
          subjectId: connection.id,
        },
      ),
      tokenB,
    );
    assert.deepEqual(
      harness.revokedTokens,
      [tokenA],
      "only the leased outbox worker deletes; failed persistence never issues a duplicate DELETE",
    );
  } finally {
    harness.revocationHandler(null);
    await fixture.cleanup();
  }
});

test("failed superseded-key revocation remains durable and is retried from its outbox", async () => {
  const fixture = await databaseFixture("zotero-orphan-marker");
  const harness = lifecycleHarness("zotero-orphan-marker");
  async function connect(sequence: number) {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    return harness.service.complete({
      userId: fixture.ownerId,
      state: callbackInput(harness).state,
      requestToken: requestTokenFor("zotero-orphan-marker", sequence),
      verifier: `verifier-orphan-${sequence}`,
    });
  }

  try {
    const first = await connect(1);
    harness.revocationSucceeds(false);
    const second = await connect(2);
    assert.equal(second.connectionId, first.connectionId);
    let connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    assert.equal(connection.status, "DEGRADED");
    assert.equal(connection.lastErrorCode, "previous_key_revocation_unconfirmed");
    assert.equal(JSON.stringify(connection.configuration).includes("pendingRevocations"), true);
    assert.equal(
      JSON.stringify(connection.configuration).includes(harness.verifiedTokens[0]),
      false,
      "the durable revocation handle remains encrypted",
    );
    assert.equal(await prisma.auditEvent.count({
      where: {
        organizationId: fixture.workspaceId,
        action: "zotero.remote_revocation_unconfirmed",
      },
    }), 1);

    harness.revocationSucceeds(true);
    const third = await connect(3);
    assert.equal(third.connectionId, first.connectionId);
    connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    assert.equal(connection.status, "CONNECTED");
    assert.equal(connection.lastErrorCode, null);
    assert.equal(JSON.stringify(connection.configuration).includes("pendingRevocations"), false);
    assert.equal(
      (await listZoteroConnections(fixture.ownerId, fixture.workspaceId)).connections[0].status,
      "CONNECTED",
    );
    assert.deepEqual(harness.revokedTokens, [
      harness.verifiedTokens[0],
      harness.verifiedTokens[0],
      harness.verifiedTokens[1],
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("a delayed disconnect revocation failure degrades a concurrently reconnected row", async () => {
  const fixture = await databaseFixture("zotero-disconnect-race");
  const harness = lifecycleHarness("zotero-disconnect-race");
  async function connect(sequence: number) {
    await harness.service.start({
      userId: fixture.ownerId,
      workspaceId: fixture.workspaceId,
      scopeProfile: "personal_group_metadata_notes",
    });
    return harness.service.complete({
      userId: fixture.ownerId,
      state: callbackInput(harness).state,
      requestToken: requestTokenFor("zotero-disconnect-race", sequence),
      verifier: `verifier-race-${sequence}`,
    });
  }

  try {
    const first = await connect(1);
    let announceRevocation!: () => void;
    const revocationStarted = new Promise<void>((resolve) => {
      announceRevocation = resolve;
    });
    let finishRevocation!: (revoked: boolean) => void;
    const revocationResult = new Promise<boolean>((resolve) => {
      finishRevocation = resolve;
    });
    const disconnecting = disconnectZoteroConnection(
      {
        userId: fixture.ownerId,
        workspaceId: fixture.workspaceId,
        connectionId: first.connectionId,
      },
      {
        database: prisma,
        credentialProtector: harness.protector,
        revokeAccessToken: async () => {
          announceRevocation();
          return revocationResult;
        },
      },
    );
    await revocationStarted;
    assert.equal(
      (await prisma.integrationConnection.findUniqueOrThrow({
        where: { id: first.connectionId },
      })).status,
      "DISCONNECTED",
      "local erasure commits before the remote call resolves",
    );

    const reconnected = await connect(2);
    assert.equal(reconnected.connectionId, first.connectionId);
    finishRevocation(false);
    await disconnecting;

    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: first.connectionId },
    });
    assert.equal(connection.status, "DEGRADED");
    assert.equal(connection.lastErrorCode, "remote_revocation_unconfirmed");
  } finally {
    await fixture.cleanup();
  }
});
