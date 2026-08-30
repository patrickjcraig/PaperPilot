import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??=
  "postgresql://paperpilot_runtime:unit@127.0.0.1:5432/paperpilot_library_service_test?sslmode=disable";

const {
  parseZoteroLibrarySelectionCommand,
  sanitizedZoteroAttentionCode,
  sanitizedZoteroSyncErrorCode,
  zoteroCapabilitiesFromScopes,
  zoteroFileAccessStatusFromPermission,
} = await import("./library-service");

test("library selection commands are exact, bounded, and duplicate-free", () => {
  assert.deepEqual(parseZoteroLibrarySelectionCommand({
    clientOperationId: "selection-operation-1",
    expectedSelectionRevision: 7,
    selectedLibraryIds: ["library-1", "library-2"],
  }), {
    clientOperationId: "selection-operation-1",
    expectedSelectionRevision: 7,
    selectedLibraryIds: ["library-1", "library-2"],
  });

  for (const invalid of [
    {
      clientOperationId: "selection-operation-1",
      expectedSelectionRevision: 7,
      selectedLibraryIds: ["library-1"],
      credential: "must-never-be-accepted",
    },
    {
      clientOperationId: "selection-operation-1",
      expectedSelectionRevision: -1,
      selectedLibraryIds: [],
    },
    {
      clientOperationId: "selection-operation-1",
      expectedSelectionRevision: 7,
      selectedLibraryIds: ["library-1", "library-1"],
    },
    {
      clientOperationId: "selection operation with spaces",
      expectedSelectionRevision: 7,
      selectedLibraryIds: [],
    },
  ]) {
    assert.throws(() => parseZoteroLibrarySelectionCommand(invalid));
  }
});

test("connection capabilities are derived only from sanitized effective access", () => {
  assert.deepEqual(zoteroCapabilitiesFromScopes({
    user: { library: true, notes: false, files: false, write: false },
    groups: {
      all: { library: true, notes: true, files: false, write: false },
      malicious: { library: true, files: true },
    },
    credential: "not-a-capability",
  }), {
    personalLibrary: true,
    groupLibraries: true,
    notes: true,
    files: false,
  });

  assert.deepEqual(zoteroCapabilitiesFromScopes("corrupt"), {
    personalLibrary: false,
    groupLibraries: false,
    notes: false,
    files: false,
  });
});

test("file access preserves provider certainty instead of inferring group denial", () => {
  assert.equal(
    zoteroFileAccessStatusFromPermission({ library: true, files: true }),
    "AVAILABLE",
    "personal-library effective file access is available",
  );
  assert.equal(
    zoteroFileAccessStatusFromPermission({ library: true }),
    "UNKNOWN",
    "a readable group with no separate file bit is checked on import",
  );
  assert.equal(
    zoteroFileAccessStatusFromPermission({ library: true, files: false }),
    "UNAVAILABLE",
    "an explicit provider denial remains unavailable",
  );
  assert.equal(
    zoteroFileAccessStatusFromPermission({ library: true, files: true }, false),
    "UNAVAILABLE",
    "lost library access overrides a stale positive file bit",
  );
  assert.equal(
    zoteroFileAccessStatusFromPermission({ library: false, files: true }),
    "UNAVAILABLE",
    "an incoherent file bit never overrides missing library read access",
  );
});

test("public error-code projections are allowlisted and fail closed", () => {
  assert.equal(
    sanitizedZoteroAttentionCode("zotero_authentication_failed"),
    "zotero_authentication_failed",
  );
  assert.equal(sanitizedZoteroAttentionCode("raw-provider-detail"), null);
  assert.equal(sanitizedZoteroAttentionCode(null), null);

  assert.equal(
    sanitizedZoteroSyncErrorCode("stable_version_changed"),
    "stable_version_changed",
  );
  assert.equal(
    sanitizedZoteroSyncErrorCode("remote_revocation_pending"),
    "internal_error",
  );
  assert.equal(sanitizedZoteroSyncErrorCode("raw-provider-detail"), "internal_error");
  assert.equal(sanitizedZoteroSyncErrorCode(null), null);
});
