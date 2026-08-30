import assert from "node:assert/strict";
import test from "node:test";

import {
  CRAWLER_RETENTION_MODE_V1,
  CRAWLER_RIGHTS_ATTESTATION_V1,
  CRAWLER_ROBOTS_MODE_V1,
  CrawlerCommandValidationError,
  crawlerCommandRequestHash,
  crawlerPublicFailureFromError,
  crawlerSourceUrlFingerprint,
  parseCrawlerAcquisitionCommandV1,
  parseCrawlerAcquisitionCommandV1ForReplay,
  type CrawlerAcquisitionCommandV1,
  type CrawlerCommandAdmissionPolicy,
} from "./crawler-command";

const POLICY: CrawlerCommandAdmissionPolicy = {
  policyVersion: "crawler-policy-2026-08-29",
  maxResponseBytes: 25 * 1_024 * 1_024,
};

function validCommand(
  overrides: Partial<CrawlerAcquisitionCommandV1> = {},
): CrawlerAcquisitionCommandV1 {
  return {
    schemaVersion: 1,
    clientOperationId: "crawler-command-01",
    expectedVersion: 7,
    policyVersion: POLICY.policyVersion,
    sourceUrl: "https://EXAMPLE.org:443/research/Paper.PDF",
    displayFileName: "研究結果—α.pdf",
    rightsAttestation: {
      scope: CRAWLER_RIGHTS_ATTESTATION_V1,
      userDeclared: true,
    },
    robotsMode: CRAWLER_ROBOTS_MODE_V1,
    retentionMode: CRAWLER_RETENTION_MODE_V1,
    maxBytes: POLICY.maxResponseBytes,
    ...overrides,
  };
}

function rejectsCode(
  value: unknown,
  code: CrawlerCommandValidationError["failureCode"],
): CrawlerCommandValidationError {
  let captured: CrawlerCommandValidationError | undefined;
  assert.throws(
    () => parseCrawlerAcquisitionCommandV1(value, POLICY),
    (error: unknown) => {
      assert.ok(error instanceof CrawlerCommandValidationError);
      assert.equal(error.failureCode, code);
      captured = error;
      return true;
    },
  );
  assert.ok(captured);
  return captured;
}

test("the first-mode command canonicalizes one public port-443 PDF and freezes its authority-neutral shape", () => {
  const parsed = parseCrawlerAcquisitionCommandV1(validCommand(), POLICY);

  assert.deepEqual(parsed.command, {
    schemaVersion: 1,
    clientOperationId: "crawler-command-01",
    expectedVersion: 7,
    policyVersion: "crawler-policy-2026-08-29",
    sourceUrl: "https://example.org/research/Paper.PDF",
    displayFileName: "研究結果—α.pdf",
    rightsAttestation: {
      scope: "INDEFINITE_RESEARCH_CUSTODY",
      userDeclared: true,
    },
    robotsMode: "REQUIRE_ALLOW",
    retentionMode: "INDEFINITE_UNTIL_USER_DELETION",
    maxBytes: 25 * 1_024 * 1_024,
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.command), true);
  assert.equal(Object.isFrozen(parsed.command.rightsAttestation), true);
  assert.match(parsed.sourceUrlFingerprint, /^[0-9a-f]{64}$/);
  assert.match(parsed.requestHash, /^[0-9a-f]{64}$/);
  for (const forbidden of [
    "tenantId",
    "organizationId",
    "userId",
    "actorId",
    "status",
    "custodyStatus",
    "documentId",
    "assetId",
  ]) {
    assert.equal(forbidden in parsed.command, false);
  }
});

test("command and rights records are closed and reject authority, status, or custody claims", () => {
  for (const forbidden of [
    "tenantId",
    "organizationId",
    "userId",
    "actorId",
    "status",
    "custodyStatus",
    "documentId",
    "assetId",
  ]) {
    rejectsCode({ ...validCommand(), [forbidden]: "attacker-claim" }, "invalid_command");
  }
  rejectsCode(
    {
      ...validCommand(),
      rightsAttestation: {
        ...validCommand().rightsAttestation,
        grantedByUserId: "attacker-claim",
      },
    },
    "invalid_command",
  );

  for (const missing of Object.keys(validCommand())) {
    const command = { ...validCommand() } as Record<string, unknown>;
    delete command[missing];
    rejectsCode(command, "invalid_command");
  }
  for (const value of [null, [], "command", 1]) {
    rejectsCode(value, "invalid_command");
  }
  rejectsCode({ ...validCommand(), schemaVersion: 2 }, "unsupported_schema");
});

test("operation identity and expected workspace version are strict", () => {
  for (const clientOperationId of [
    "",
    " leading",
    "trailing ",
    "contains space",
    "x".repeat(201),
    "opaque/id",
  ]) {
    rejectsCode(
      { ...validCommand(), clientOperationId },
      "invalid_operation_id",
    );
  }
  for (const expectedVersion of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "7"]) {
    rejectsCode(
      { ...validCommand(), expectedVersion } as unknown,
      "invalid_workspace_version",
    );
  }
});

test("the source is exactly one query-free public HTTPS PDF on port 443", () => {
  const cases: Array<[string, CrawlerCommandValidationError["failureCode"]]> = [
    ["https://example.org/paper.pdf?download=1", "source_query_forbidden"],
    ["https://example.org/paper.pdf?", "source_query_forbidden"],
    ["https://example.org/paper.pdf#page=2", "source_fragment_forbidden"],
    ["https://example.org/paper.pdf#", "source_fragment_forbidden"],
    ["https://example.org:8443/paper.pdf", "source_port_forbidden"],
    ["https://user:secret@example.org/paper.pdf", "invalid_source_url"],
    ["http://example.org/paper.pdf", "invalid_source_url"],
    ["https://localhost/paper.pdf", "invalid_source_url"],
    ["https://repository.local/paper.pdf", "invalid_source_url"],
    ["https://service.internal/paper.pdf", "invalid_source_url"],
    ["https://127.0.0.1/paper.pdf", "invalid_source_url"],
    ["https://[::1]/paper.pdf", "invalid_source_url"],
    ["https://singlelabel/paper.pdf", "invalid_source_url"],
    ["https://example.org/article.html", "source_pdf_required"],
    ["https://example.org/paper.pdf/attachment", "source_pdf_required"],
  ];
  for (const [sourceUrl, code] of cases) {
    rejectsCode({ ...validCommand(), sourceUrl }, code);
  }
});

test("Unicode display filenames normalize safely while controls and path-like names fail closed", () => {
  const decomposed = parseCrawlerAcquisitionCommandV1(
    validCommand({ displayFileName: "Cafe\u0301.pdf" }),
    POLICY,
  );
  assert.equal(decomposed.command.displayFileName, "Café.pdf");
  assert.equal(
    parseCrawlerAcquisitionCommandV1(
      validCommand({ displayFileName: "査読済み.PDF" }),
      POLICY,
    ).command.displayFileName,
    "査読済み.PDF",
  );

  for (const displayFileName of [
    "paper\n.pdf",
    "paper\u0000.pdf",
    "paper\u202Efdp.pdf",
    "paper\u2066.pdf",
    "../paper.pdf",
    "folder\\paper.pdf",
    "CON.pdf",
    "paper.pdf ",
    "paper.txt",
    `${"界".repeat(85)}.pdf`,
  ]) {
    rejectsCode(
      { ...validCommand(), displayFileName },
      "invalid_display_filename",
    );
  }
});

test("rights, robots, retention, policy revision, and byte bounds cannot drift", () => {
  rejectsCode(
    {
      ...validCommand(),
      rightsAttestation: {
        scope: "TEMPORARY_RESEARCH_ACCESS",
        userDeclared: true,
      },
    },
    "rights_attestation_required",
  );
  rejectsCode(
    {
      ...validCommand(),
      rightsAttestation: {
        scope: CRAWLER_RIGHTS_ATTESTATION_V1,
        userDeclared: false,
      },
    },
    "rights_attestation_required",
  );
  rejectsCode(
    { ...validCommand(), robotsMode: "IGNORE_ROBOTS" } as unknown,
    "robots_allowance_required",
  );
  rejectsCode(
    { ...validCommand(), retentionMode: "DELETE_AFTER_30_DAYS" } as unknown,
    "indefinite_retention_required",
  );
  rejectsCode(
    { ...validCommand(), policyVersion: "crawler-policy-stale" },
    "policy_version_conflict",
  );
  for (const maxBytes of [0, -1, 1.5, POLICY.maxResponseBytes + 1, "1024"]) {
    rejectsCode(
      { ...validCommand(), maxBytes } as unknown,
      "invalid_max_bytes",
    );
  }
  assert.equal(
    parseCrawlerAcquisitionCommandV1(validCommand({ maxBytes: 1 }), POLICY)
      .command.maxBytes,
    1,
  );
});

test("a closed historical command can be hashed for replay before current-policy admission", () => {
  const historical = validCommand({
    policyVersion: "crawler-policy-historical-v1",
    maxBytes: POLICY.maxResponseBytes + 1,
  });
  const replayCandidate = parseCrawlerAcquisitionCommandV1ForReplay(historical);
  assert.equal(replayCandidate.command.policyVersion, "crawler-policy-historical-v1");
  assert.equal(replayCandidate.command.maxBytes, POLICY.maxResponseBytes + 1);
  assert.equal(
    replayCandidate.requestHash,
    crawlerCommandRequestHash(replayCandidate.command),
  );
  assert.throws(
    () => parseCrawlerAcquisitionCommandV1(historical, POLICY),
    (error: unknown) =>
      error instanceof CrawlerCommandValidationError
      && error.failureCode === "policy_version_conflict",
  );
  assert.throws(
    () => parseCrawlerAcquisitionCommandV1ForReplay({
      ...historical,
      policyVersion: "invalid policy",
    }),
    (error: unknown) =>
      error instanceof CrawlerCommandValidationError
      && error.failureCode === "policy_version_conflict",
  );
  assert.throws(
    () => parseCrawlerAcquisitionCommandV1ForReplay({
      ...historical,
      maxBytes: Number.MAX_SAFE_INTEGER + 1,
    }),
    (error: unknown) =>
      error instanceof CrawlerCommandValidationError
      && error.failureCode === "invalid_max_bytes",
  );
});

test("URL fingerprints and full-command hashes are deterministic and domain-separated", () => {
  const first = parseCrawlerAcquisitionCommandV1(validCommand(), POLICY);
  const equivalent = parseCrawlerAcquisitionCommandV1(
    validCommand({ sourceUrl: "https://example.org/research/Paper.PDF" }),
    POLICY,
  );
  const differentOperation = parseCrawlerAcquisitionCommandV1(
    validCommand({ clientOperationId: "crawler-command-02" }),
    POLICY,
  );
  const differentSource = parseCrawlerAcquisitionCommandV1(
    validCommand({ sourceUrl: "https://example.org/research/Other.PDF" }),
    POLICY,
  );

  assert.equal(first.sourceUrlFingerprint, equivalent.sourceUrlFingerprint);
  assert.equal(first.requestHash, equivalent.requestHash);
  assert.equal(first.sourceUrlFingerprint, differentOperation.sourceUrlFingerprint);
  assert.notEqual(first.requestHash, differentOperation.requestHash);
  assert.notEqual(first.sourceUrlFingerprint, differentSource.sourceUrlFingerprint);
  assert.notEqual(first.requestHash, differentSource.requestHash);
  assert.notEqual(first.sourceUrlFingerprint, first.requestHash);
  assert.equal(
    crawlerSourceUrlFingerprint(first.command.sourceUrl),
    first.sourceUrlFingerprint,
  );
  assert.equal(crawlerCommandRequestHash(first.command), first.requestHash);
  assert.throws(
    () => crawlerSourceUrlFingerprint("https://EXAMPLE.org:443/research/Paper.PDF"),
    /canonical first-mode crawler source URL/,
  );
});

test("public validation failures never echo URLs, credentials, or unknown error details", () => {
  const rawUrl = "https://leaked-user:SUPER_SECRET@example.org/private/paper.pdf";
  let error: unknown;
  try {
    parseCrawlerAcquisitionCommandV1(
      { ...validCommand(), sourceUrl: rawUrl, secretToken: "TOKEN_VALUE" },
      POLICY,
    );
  } catch (caught) {
    error = caught;
  }
  const publicFailure = crawlerPublicFailureFromError(error);
  const serialized = JSON.stringify(publicFailure);
  assert.deepEqual(publicFailure, {
    schemaVersion: 1,
    code: "invalid_command",
    message: "The crawler command shape is not supported.",
    retryable: false,
  });
  for (const secret of [
    rawUrl,
    "leaked-user",
    "SUPER_SECRET",
    "example.org",
    "secretToken",
    "TOKEN_VALUE",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const internal = JSON.stringify(
    crawlerPublicFailureFromError(new Error(`fetch failed for ${rawUrl}`)),
  );
  assert.equal(internal.includes(rawUrl), false);
  assert.equal(internal.includes("SUPER_SECRET"), false);
  assert.deepEqual(JSON.parse(internal), {
    schemaVersion: 1,
    code: "internal_error",
    message: "PaperPilot could not validate the crawler command.",
    retryable: false,
  });
});

test("invalid server-owned admission policy fails as configuration, not public input", () => {
  for (const policy of [
    { policyVersion: "", maxResponseBytes: 1 },
    { policyVersion: "policy version", maxResponseBytes: 1 },
    { policyVersion: "policy-v1", maxResponseBytes: 0 },
    { policyVersion: "policy-v1", maxResponseBytes: 1.5 },
  ]) {
    assert.throws(
      () => parseCrawlerAcquisitionCommandV1(validCommand(), policy),
      /admission policy is invalid/,
    );
  }
});
