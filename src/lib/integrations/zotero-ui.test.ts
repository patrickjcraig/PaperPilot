import assert from "node:assert/strict";
import test from "node:test";
import {
  isZoteroAttachmentImportCurrent,
  isWorkspaceIntegrationManager,
  parseZoteroAttachmentImportResponse,
  parseZoteroAttachmentListResponse,
  parseZoteroAttachmentPolicyResponse,
  parseZoteroAttachmentPolicyUpdateResponse,
  parseZoteroConnectionsResponse,
  parseZoteroLibraryDiscoveryResponse,
  parseZoteroLibrarySelectionResponse,
  parseZoteroOAuthStartResponse,
  parseZoteroSyncRunsResponse,
  trustedZoteroAuthorizationUrl,
  zoteroAttachmentImportsRoute,
  zoteroAttachmentPolicyRoute,
  zoteroAttachmentsRoute,
  zoteroCallbackConsumption,
  zoteroConnectionsRoute,
  zoteroDisconnectRoute,
  zoteroLibraryDiscoveryRoute,
  zoteroLibrarySelectionRoute,
  zoteroOAuthStartRoute,
  zoteroSyncRunsRoute,
} from "./zotero-ui";

function attachmentImport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "attachment-import-1",
    status: "VALIDATING",
    documentId: "document-1",
    assetId: "asset-1",
    intakeId: "intake-1",
    inboxEntryId: "inbox-1",
    downloadJobId: "job-1",
    sourceVersion: "73",
    providerMd5: "0123456789abcdef0123456789abcdef",
    failureCode: null,
    createdAt: "2026-08-29T16:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function attachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ATTACHMENT1",
    libraryId: "library-1",
    parentKey: "PARENT1",
    linkMode: "imported_file",
    contentType: "application/pdf",
    fileName: "Trial protocol.pdf",
    providerMd5: "0123456789abcdef0123456789abcdef",
    providerMtime: "1788019200000",
    sourceVersion: "73",
    metadataHash: "a".repeat(64),
    eligibility: "DOWNLOADABLE",
    reasonCode: null,
    isDeleted: false,
    updatedAt: "2026-08-29T15:59:00.000Z",
    latestImport: attachmentImport(),
    ...overrides,
  };
}

function syncRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sync-run-1",
    status: "SUCCEEDED",
    fromVersion: "40",
    toVersion: "42",
    objectsRead: 12,
    objectsWritten: 3,
    objectsDeleted: 1,
    backoffUntil: null,
    errorCode: null,
    startedAt: "2026-08-28T18:00:00.000Z",
    completedAt: "2026-08-28T18:00:03.000Z",
    ...overrides,
  };
}

function library(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "library-1",
    type: "USER",
    zoteroLibraryId: "123",
    name: "My Library",
    isReadable: true,
    isWritable: false,
    fileAccessStatus: "AVAILABLE",
    syncEnabled: true,
    lastSyncedAt: "2026-08-28T18:00:03.000Z",
    lastSyncedVersion: "42",
    lastSyncRun: syncRun(),
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "connection-1",
    status: "CONNECTED",
    displayName: "Researcher Library",
    lastVerifiedAt: "2026-08-28T18:00:00.000Z",
    attentionCode: null,
    providerBackoffUntil: null,
    selectionRevision: 2,
    librariesConfiguredAt: "2026-08-28T17:55:00.000Z",
    capabilities: {
      personalLibrary: true,
      groupLibraries: false,
      notes: false,
      files: false,
    },
    libraries: [library()],
    ...overrides,
  };
}

function authorizationUrl(overrides: Record<string, string> = {}): string {
  const url = new URL("https://www.zotero.org/oauth/authorize");
  const values = {
    oauth_token: "temporary-request-token",
    name: "PaperPilot inbound metadata",
    library_access: "1",
    notes_access: "0",
    write_access: "0",
    all_groups: "none",
    ...overrides,
  };
  Object.entries(values).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

test("authorization responses are pinned to Zotero and the requested read-only profile", () => {
  const parsed = parseZoteroOAuthStartResponse({
    authorizationUrl: authorizationUrl(),
    expiresAt: "2026-08-28T19:00:00.000Z",
    scopeProfile: "personal_metadata",
  }, "personal_metadata");
  assert.equal(parsed.scopeProfile, "personal_metadata");
  assert.equal(new URL(parsed.authorizationUrl).origin, "https://www.zotero.org");

  assert.throws(() => trustedZoteroAuthorizationUrl(
    authorizationUrl().replace("www.zotero.org", "www.zotero.org.evil.example"),
  ));
  assert.throws(() => trustedZoteroAuthorizationUrl(
    authorizationUrl({ write_access: "1" }),
  ));
  assert.throws(() => parseZoteroOAuthStartResponse({
    authorizationUrl: authorizationUrl({ notes_access: "1" }),
    expiresAt: "2026-08-28T19:00:00.000Z",
    scopeProfile: "personal_metadata",
  }, "personal_metadata"));
});

test("workspace and connection route segments are encoded and bounded", () => {
  assert.equal(
    zoteroConnectionsRoute("workspace/one"),
    "/api/workspaces/workspace%2Fone/integrations/zotero",
  );
  assert.equal(
    zoteroOAuthStartRoute("workspace one"),
    "/api/workspaces/workspace%20one/integrations/zotero/oauth/start",
  );
  assert.equal(
    zoteroDisconnectRoute("workspace/one", "connection/two"),
    "/api/workspaces/workspace%2Fone/integrations/zotero/connection%2Ftwo",
  );
  assert.equal(
    zoteroLibrarySelectionRoute("workspace one", "connection/two"),
    "/api/workspaces/workspace%20one/integrations/zotero/connection%2Ftwo/libraries/selection",
  );
  assert.equal(
    zoteroLibraryDiscoveryRoute("workspace one", "connection/two"),
    "/api/workspaces/workspace%20one/integrations/zotero/connection%2Ftwo/libraries/discover",
  );
  assert.equal(
    zoteroSyncRunsRoute("workspace one", "connection/two"),
    "/api/workspaces/workspace%20one/integrations/zotero/connection%2Ftwo/sync-runs",
  );
  assert.equal(
    zoteroAttachmentPolicyRoute("workspace one", "connection/two"),
    "/api/workspaces/workspace%20one/integrations/zotero/connection%2Ftwo/attachment-policy",
  );
  assert.equal(
    zoteroAttachmentsRoute("workspace one", "connection/two", {
      after: "ATTACHMENT1",
      limit: 25,
      libraryId: "library-1",
      eligibility: "DOWNLOADABLE",
      includeDeleted: false,
    }),
    "/api/workspaces/workspace%20one/integrations/zotero/connection%2Ftwo/attachments?after=ATTACHMENT1&limit=25&libraryId=library-1&eligibility=DOWNLOADABLE&includeDeleted=false",
  );
  assert.equal(
    zoteroAttachmentImportsRoute("workspace one", "connection/two", "ATTACHMENT/1"),
    "/api/workspaces/workspace%20one/integrations/zotero/connection%2Ftwo/attachments/ATTACHMENT%2F1/imports",
  );
  assert.throws(() => zoteroAttachmentsRoute("workspace", "connection", { limit: 101 }));
  assert.throws(() => zoteroAttachmentsRoute("workspace", "connection", { after: "cursor/one" }));
  assert.throws(() => zoteroConnectionsRoute(""));
});

test("attachment policy, list, and import responses remain closed and credential-free", () => {
  assert.deepEqual(parseZoteroAttachmentPolicyResponse({
    mode: "DISABLED",
    revision: 0,
    configuredAt: null,
  }), {
    mode: "DISABLED",
    revision: 0,
    configuredAt: null,
  });
  assert.deepEqual(parseZoteroAttachmentPolicyUpdateResponse({
    outcome: "applied",
    mode: "MANUAL",
    revision: 1,
    configuredAt: "2026-08-29T15:55:00.000Z",
  }), {
    outcome: "applied",
    mode: "MANUAL",
    revision: 1,
    configuredAt: "2026-08-29T15:55:00.000Z",
  });

  const listed = parseZoteroAttachmentListResponse({
    attachments: [attachment()],
    nextCursor: "ATTACHMENT1",
  });
  assert.equal(listed.attachments[0].latestImport?.status, "VALIDATING");
  assert.equal(listed.attachments[0].providerMd5, "0123456789abcdef0123456789abcdef");
  assert.equal(isZoteroAttachmentImportCurrent(listed.attachments[0]), true);
  assert.equal(isZoteroAttachmentImportCurrent({
    ...listed.attachments[0],
    sourceVersion: "74",
  }), false);
  assert.equal(isZoteroAttachmentImportCurrent({
    ...listed.attachments[0],
    providerMd5: "fedcba9876543210fedcba9876543210",
  }), false);

  const queued = parseZoteroAttachmentImportResponse({
    outcome: "applied",
    import: attachmentImport({
      status: "FAILED",
      failureCode: "attachment_integrity_failed",
      completedAt: "2026-08-29T16:01:00.000Z",
    }),
  });
  assert.equal(queued.import.failureCode, "attachment_integrity_failed");

  assert.throws(() => parseZoteroAttachmentPolicyResponse({
    mode: "MANUAL",
    revision: 0,
    configuredAt: null,
  }));
  assert.throws(() => parseZoteroAttachmentListResponse({
    attachments: [attachment({ signedUrl: "https://private.example/file" })],
    nextCursor: null,
  }));
  assert.throws(() => parseZoteroAttachmentListResponse({
    attachments: [attachment({ providerMd5: "ABCDEF" })],
    nextCursor: null,
  }));
  assert.throws(() => parseZoteroAttachmentImportResponse({
    outcome: "applied",
    import: attachmentImport({
      status: "FAILED",
      failureCode: "raw_provider_error",
      completedAt: "2026-08-29T16:01:00.000Z",
    }),
  }));
});

test("connection parsing returns strict credential-free selection and sync summaries", () => {
  const parsed = parseZoteroConnectionsResponse({
    connections: [connection()],
  });

  assert.deepEqual(parsed.connections[0], {
    id: "connection-1",
    status: "CONNECTED",
    displayName: "Researcher Library",
    lastVerifiedAt: "2026-08-28T18:00:00.000Z",
    attentionCode: null,
    providerBackoffUntil: null,
    selectionRevision: 2,
    librariesConfiguredAt: "2026-08-28T17:55:00.000Z",
    capabilities: {
      personalLibrary: true,
      groupLibraries: false,
      notes: false,
      files: false,
    },
    libraries: [{
      id: "library-1",
      type: "USER",
      zoteroLibraryId: "123",
      name: "My Library",
      isReadable: true,
      isWritable: false,
      fileAccessStatus: "AVAILABLE",
      syncEnabled: true,
      lastSyncedAt: "2026-08-28T18:00:03.000Z",
      lastSyncedVersion: "42",
      lastSyncRun: syncRun(),
    }],
  });
  assert.throws(() => parseZoteroConnectionsResponse({
    connections: [connection({ credentialCiphertext: "must-never-cross-the-contract" })],
  }));
  assert.throws(() => parseZoteroConnectionsResponse({
    connections: [connection({ effectiveScopes: { user: { library: true } } })],
  }));
  assert.throws(() => parseZoteroConnectionsResponse({
    connections: [connection({ attentionCode: "provider-secret-shaped-error" })],
  }));
  const accessLost = parseZoteroConnectionsResponse({
    connections: [connection({
      libraries: [library({
        isReadable: false,
        fileAccessStatus: "UNAVAILABLE",
        syncEnabled: true,
      })],
    })],
  });
  assert.equal(accessLost.connections[0].libraries[0].isReadable, false);
  assert.equal(accessLost.connections[0].libraries[0].syncEnabled, true);
  assert.throws(() => parseZoteroConnectionsResponse({
    connections: [connection({
      libraries: [library({ isReadable: false, fileAccessStatus: "AVAILABLE" })],
    })],
  }));
  assert.throws(() => parseZoteroConnectionsResponse({
    connections: [connection({
      libraries: [library({ fileAccessStatus: "ASSUMED" })],
    })],
  }));
  assert.throws(
    () => parseZoteroConnectionsResponse({
      connections: [connection({ libraries: [library({ isWritable: true })] })],
    }),
    /unsupported write access/,
  );
  assert.throws(() => parseZoteroConnectionsResponse({
    connections: [connection(), connection()],
  }));
});

test("selection, discovery, and sync mutation responses are closed unions", () => {
  const selected = parseZoteroLibrarySelectionResponse({
    outcome: "applied",
    selectionRevision: 3,
    libraries: [library({ syncEnabled: false })],
  });
  assert.equal(selected.selectionRevision, 3);
  assert.equal(selected.libraries[0].syncEnabled, false);

  const discovered = parseZoteroLibraryDiscoveryResponse({
    discovered: true,
    libraries: [library({ type: "GROUP", fileAccessStatus: "UNKNOWN" })],
  });
  assert.equal(discovered.discovered, true);
  assert.equal(discovered.libraries[0].fileAccessStatus, "UNKNOWN");

  const sync = parseZoteroSyncRunsResponse({
    outcome: "queued",
    queuedCount: 1,
    coalescedCount: 0,
    runs: [syncRun({ status: "QUEUED", startedAt: null, completedAt: null })],
  });
  assert.equal(sync.runs[0].status, "QUEUED");

  assert.throws(() => parseZoteroLibrarySelectionResponse({
    outcome: "applied",
    selectionRevision: 3,
    libraries: [library()],
    credential: "forbidden",
  }));
  assert.throws(() => parseZoteroLibraryDiscoveryResponse({
    discovered: false,
    libraries: [],
  }));
  assert.throws(() => parseZoteroSyncRunsResponse({
    outcome: "queued",
    queuedCount: 1,
    coalescedCount: 0,
    runs: [syncRun({ status: "BACKING_OFF", backoffUntil: null })],
  }));
  assert.throws(() => parseZoteroSyncRunsResponse({
    outcome: "queued",
    queuedCount: 1,
    coalescedCount: 0,
    runs: [syncRun({ status: "FAILED", errorCode: "raw-provider-message" })],
  }));
  assert.throws(() => parseZoteroSyncRunsResponse({
    outcome: "queued",
    queuedCount: 2,
    coalescedCount: 0,
    runs: [syncRun(), syncRun()],
  }));
});

test("callback consumption scrubs only the Zotero result and preserves sources hash", () => {
  assert.deepEqual(
    zoteroCallbackConsumption("https://paperpilot.test/app?tab=recent&zotero=connected#sources"),
    {
      hadParameter: true,
      result: "connected",
      replacement: "/app?tab=recent#sources",
    },
  );
  assert.deepEqual(
    zoteroCallbackConsumption("https://paperpilot.test/app?zotero=failed&zotero=connected#sources"),
    {
      hadParameter: true,
      result: null,
      replacement: "/app#sources",
    },
  );
});

test("integration management fails closed to owner and admin roles", () => {
  assert.equal(isWorkspaceIntegrationManager("owner"), true);
  assert.equal(isWorkspaceIntegrationManager("admin"), true);
  assert.equal(isWorkspaceIntegrationManager("member"), false);
  assert.equal(isWorkspaceIntegrationManager("viewer"), false);
  assert.equal(isWorkspaceIntegrationManager("unexpected-role"), false);
});
