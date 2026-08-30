import assert from "node:assert/strict";
import test from "node:test";
import { HttpProblem } from "@/server/http/problem";
import {
  MAX_WEB_MCP_PROPOSAL_COMMAND_BYTES,
  parseWebMcpProposalCommand,
} from "./intake-contract";

function validProposal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: "A trustworthy paper",
    authors: ["Ada Lovelace"],
    year: 2025,
    venue: "Journal of Reproducible Results",
    publicationType: "journal article",
    sourcePageUrl: "https://example.org/papers/trustworthy",
    ...overrides,
  };
}

function validCommand(
  proposalOverrides: Record<string, unknown> = {},
  commandOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    clientOperationId: "webmcp-operation:one",
    expectedVersion: 7,
    proposal: validProposal(proposalOverrides),
    ...commandOverrides,
  };
}

function assertValidation(action: () => unknown, message?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof HttpProblem);
    assert.equal(error.status, 400);
    assert.equal(error.code, "validation");
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("normalizes a closed metadata-only WebMCP proposal", () => {
  assert.equal(MAX_WEB_MCP_PROPOSAL_COMMAND_BYTES, 64 * 1_024);

  const parsed = parseWebMcpProposalCommand(validCommand({
    title: "  A trustworthy paper  ",
    authors: ["  Ada Lovelace  ", "Grace Hopper"],
    venue: "  Journal of Reproducible Results  ",
    abstract: "  Evidence with a clear method.  ",
    identifiers: [
      { scheme: "doi", value: "https://doi.org/10.1234/ABC.Def" },
      { scheme: "doi", value: "doi:10.1234/abc.def" },
      { scheme: "arxiv", value: "arXiv:2401.01234v2" },
      { scheme: "arxiv", value: "https://arxiv.org/pdf/2401.01234v2.pdf" },
      { scheme: "isbn", value: "978-1-4028-9462-6" },
      { scheme: "provider", value: "  Provider-Record-42  " },
      { scheme: "provider", value: "provider-record-42" },
    ],
    sourcePageUrl: "https://EXAMPLE.org:443/papers/trustworthy?download=1",
    candidatePdfUrl: "https://CDN.EXAMPLE.org:443/papers/trustworthy.pdf",
    isOpenAccess: true,
    license: "  CC-BY-4.0  ",
    version: "  accepted manuscript  ",
  }));

  assert.deepEqual(parsed, {
    schemaVersion: 1,
    clientOperationId: "webmcp-operation:one",
    expectedVersion: 7,
    proposal: {
      title: "A trustworthy paper",
      authors: ["Ada Lovelace", "Grace Hopper"],
      year: 2025,
      venue: "Journal of Reproducible Results",
      publicationType: "journal article",
      abstract: "Evidence with a clear method.",
      identifiers: [
        { scheme: "doi", value: "10.1234/abc.def" },
        { scheme: "arxiv", value: "2401.01234v2" },
        { scheme: "isbn", value: "9781402894626" },
        { scheme: "provider", value: "Provider-Record-42" },
      ],
      sourcePageUrl: "https://example.org/papers/trustworthy?download=1",
      candidatePdfUrl: "https://cdn.example.org/papers/trustworthy.pdf",
      isOpenAccess: true,
      license: "CC-BY-4.0",
      version: "accepted manuscript",
    },
  });
  assert.deepEqual(Object.keys(parsed), [
    "schemaVersion",
    "clientOperationId",
    "expectedVersion",
    "proposal",
  ]);
  for (const forbidden of [
    "id",
    "organizationId",
    "paper",
    "provenance",
    "custody",
    "storageKey",
  ]) {
    assert.equal(forbidden in parsed.proposal, false);
  }
});

test("accepts the required proposal shape and omits empty optional text", () => {
  const parsed = parseWebMcpProposalCommand(validCommand({
    abstract: "   ",
    identifiers: [],
    license: "   ",
    version: "   ",
  }));

  assert.deepEqual(parsed.proposal, {
    title: "A trustworthy paper",
    authors: ["Ada Lovelace"],
    year: 2025,
    venue: "Journal of Reproducible Results",
    publicationType: "journal article",
    identifiers: [],
    sourcePageUrl: "https://example.org/papers/trustworthy",
  });
});

test("rejects missing and unsupported top-level command fields", () => {
  for (const key of [
    "schemaVersion",
    "clientOperationId",
    "expectedVersion",
    "proposal",
  ]) {
    const command = validCommand();
    delete command[key];
    assertValidation(
      () => parseWebMcpProposalCommand(command),
      /missing required field/,
    );
  }

  for (const key of [
    "organizationId",
    "workspaceId",
    "projectId",
    "actorUserId",
    "sourceKind",
  ]) {
    assertValidation(
      () => parseWebMcpProposalCommand({ ...validCommand(), [key]: "forged" }),
      /unsupported field/,
    );
  }
  assertValidation(() => parseWebMcpProposalCommand(null), /must be an object/);
  assertValidation(() => parseWebMcpProposalCommand([]), /must be an object/);
});

test("rejects authority, custody, lifecycle, and provenance injection", () => {
  for (const key of [
    "organizationId",
    "workspaceId",
    "projectId",
    "actorUserId",
    "sourceKind",
    "provenance",
    "accessMethod",
    "retrievedAt",
    "custody",
    "storageKey",
    "sha256",
    "documentId",
    "assetId",
    "intakeId",
    "ingestReceiptId",
    "status",
  ]) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({ [key]: "forged" })),
      /unsupported field/,
    );
  }
});

test("enforces envelope schema, operation-id, and version bounds", () => {
  for (const schemaVersion of [0, 2, "1", null]) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({}, { schemaVersion })),
      /schemaVersion/,
    );
  }
  for (const clientOperationId of ["", "   ", "x".repeat(201), 42, null]) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({}, { clientOperationId })),
      /clientOperationId/,
    );
  }
  for (const expectedVersion of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "7",
    null,
  ]) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({}, { expectedVersion })),
      /expectedVersion/,
    );
  }

  assert.equal(
    parseWebMcpProposalCommand(validCommand({}, {
      clientOperationId: `  ${"x".repeat(200)}  `,
      expectedVersion: Number.MAX_SAFE_INTEGER,
    })).clientOperationId.length,
    200,
  );
});

test("enforces required proposal string and array bounds", () => {
  for (const title of ["", "   ", "x".repeat(2_001), 7, null]) {
    assertValidation(() => parseWebMcpProposalCommand(validCommand({ title })));
  }
  for (const authors of [
    [],
    Array.from({ length: 201 }, () => "Author"),
    [""],
    ["x".repeat(301)],
    "Ada Lovelace",
    null,
  ]) {
    assertValidation(() => parseWebMcpProposalCommand(validCommand({ authors })));
  }
  for (const venue of ["", "   ", "x".repeat(1_001), 7, null]) {
    assertValidation(() => parseWebMcpProposalCommand(validCommand({ venue })));
  }

  const maximum = parseWebMcpProposalCommand(validCommand({
    title: "x".repeat(2_000),
    authors: Array.from({ length: 200 }, () => "x".repeat(300)),
    venue: "x".repeat(1_000),
  }));
  assert.equal(maximum.proposal.title.length, 2_000);
  assert.equal(maximum.proposal.authors.length, 200);
  assert.equal(maximum.proposal.venue.length, 1_000);
});

test("enforces publication year and Paper publication type", () => {
  const maximumYear = new Date().getUTCFullYear() + 5;
  for (const year of [-1, 1.5, maximumYear + 1, "2025", null]) {
    assertValidation(() => parseWebMcpProposalCommand(validCommand({ year })));
  }
  for (const publicationType of [
    "book",
    "Journal Article",
    "",
    7,
    null,
  ]) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({ publicationType })),
      /publicationType/,
    );
  }

  for (const publicationType of [
    "journal article",
    "conference paper",
    "review",
    "methods paper",
    "application study",
  ]) {
    assert.equal(
      parseWebMcpProposalCommand(validCommand({ publicationType })).proposal.publicationType,
      publicationType,
    );
  }
  assert.equal(parseWebMcpProposalCommand(validCommand({ year: 0 })).proposal.year, 0);
  assert.equal(
    parseWebMcpProposalCommand(validCommand({ year: maximumYear })).proposal.year,
    maximumYear,
  );
});

test("enforces optional scalar size and type bounds", () => {
  for (const [field, value] of [
    ["abstract", "x".repeat(40_001)],
    ["license", "x".repeat(501)],
    ["version", "x".repeat(201)],
    ["abstract", 7],
    ["license", false],
    ["version", null],
    ["isOpenAccess", "true"],
    ["isOpenAccess", null],
  ] as const) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({ [field]: value })),
    );
  }

  const parsed = parseWebMcpProposalCommand(validCommand({
    abstract: "x".repeat(40_000),
    license: "x".repeat(500),
    version: "x".repeat(200),
    isOpenAccess: false,
  }));
  assert.equal(parsed.proposal.abstract?.length, 40_000);
  assert.equal(parsed.proposal.license?.length, 500);
  assert.equal(parsed.proposal.version?.length, 200);
  assert.equal(parsed.proposal.isOpenAccess, false);
});

test("requires closed identifiers, normalizes supported schemes, and enforces bounds", () => {
  assertValidation(
    () => parseWebMcpProposalCommand(validCommand({ identifiers: "doi:10.1234/test" })),
  );
  assertValidation(
    () => parseWebMcpProposalCommand(validCommand({
      identifiers: Array.from(
        { length: 33 },
        (_, index) => ({ scheme: "provider", value: `record-${index}` }),
      ),
    })),
  );
  for (const identifier of [
    { scheme: "pmid", value: "123" },
    { scheme: "provider", value: "" },
    { scheme: "provider", value: "x".repeat(1_025) },
    { scheme: "doi", value: "not-a-doi" },
    { scheme: "arxiv", value: "not-an-arxiv-id" },
    { scheme: "isbn", value: "123" },
    { scheme: "doi" },
    { value: "10.1234/test" },
    { scheme: "doi", value: "10.1234/test", source: "agent" },
    null,
  ]) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({ identifiers: [identifier] })),
    );
  }

  assert.deepEqual(
    parseWebMcpProposalCommand(validCommand({
      identifiers: [
        { scheme: "doi", value: "DOI:10.5555/ABC" },
        { scheme: "arxiv", value: "hep-th/9901001v2" },
        { scheme: "isbn", value: "0-306-40615-2" },
        { scheme: "provider", value: "  Source-ID  " },
      ],
    })).proposal.identifiers,
    [
      { scheme: "doi", value: "10.5555/abc" },
      { scheme: "arxiv", value: "hep-th/9901001v2" },
      { scheme: "isbn", value: "0306406152" },
      { scheme: "provider", value: "Source-ID" },
    ],
  );
});

test("canonicalizes eligible public source and candidate URLs", () => {
  const parsed = parseWebMcpProposalCommand(validCommand({
    sourcePageUrl: "https://PAPERS.EXAMPLE.ORG:443/library/item?download=1",
    candidatePdfUrl: "https://FILES.EXAMPLE.ORG:443/library/item.pdf?download=1",
  }));
  assert.equal(
    parsed.proposal.sourcePageUrl,
    "https://papers.example.org/library/item?download=1",
  );
  assert.equal(
    parsed.proposal.candidatePdfUrl,
    "https://files.example.org/library/item.pdf?download=1",
  );
});

test("rejects malformed, HTTP, credentialed, fragmented, and private URLs", () => {
  for (const sourcePageUrl of [
    "",
    " https://example.org/paper ",
    "not-a-url",
    "http://example.org/paper",
    "https://user:password@example.org/paper",
    "https://example.org/paper#abstract",
    "https://localhost/paper",
    "https://papers.internal/paper",
    "https://127.0.0.1/paper",
    "https://[::1]/paper",
    7,
    null,
  ]) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({ sourcePageUrl })),
      /sourcePageUrl/,
    );
  }

  for (const candidatePdfUrl of [
    "http://example.org/paper.pdf",
    "https://user:password@example.org/paper.pdf",
    "https://localhost/paper.pdf",
    "https://10.0.0.1/paper.pdf",
    7,
    null,
  ]) {
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({ candidatePdfUrl })),
      /candidatePdfUrl/,
    );
  }
});

test("rejects secret-bearing query keys on source and candidate URLs", () => {
  for (const queryKey of [
    "token",
    "refreshToken",
    "secret",
    "X-Amz-Signature",
    "credential",
    "authorization",
    "password",
    "session",
    "api_key",
    "api-key",
    "ApiKey",
  ]) {
    const sourcePageUrl = `https://example.org/paper?${encodeURIComponent(queryKey)}=hidden`;
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({ sourcePageUrl })),
      /credential-bearing query keys/,
    );
    assertValidation(
      () => parseWebMcpProposalCommand(validCommand({ candidatePdfUrl: sourcePageUrl })),
      /credential-bearing query keys/,
    );
  }
  assertValidation(
    () => parseWebMcpProposalCommand(validCommand({
      sourcePageUrl: "https://example.org/paper?api%5Fkey=hidden",
    })),
    /credential-bearing query keys/,
  );
});
