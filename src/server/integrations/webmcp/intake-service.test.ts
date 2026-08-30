import assert from "node:assert/strict";
import test from "node:test";

import type { WebMcpProposalCommand } from "./intake-contract";
import { webMcpProposalSnapshot } from "./intake-service";
import {
  canonicalWebMcpSnapshotJson,
  decodeServerManagedWebMcpSnapshot,
  isServerManagedWebMcpSnapshot,
  verifyWebMcpSnapshotDigest,
  WEB_MCP_SNAPSHOT_SCHEMA_VERSION,
  webMcpSnapshotDigest,
  type HistoricalServerManagedWebMcpSnapshotV1,
  type ServerManagedWebMcpSnapshot,
} from "./snapshot-contract";

const HISTORICAL_V1_GOLDEN_DIGEST =
  "f176390321e54e2884a960b286c1ce25c25353d6d7bddd72c80a03c9fa4d515d";
const CURRENT_V2_GOLDEN_DIGEST =
  "799bb977cd16ec8add3171698837e9b59fe58598c3aac0ca4f55b4dbbf5c3d67";

function command(): WebMcpProposalCommand {
  return {
    schemaVersion: 1,
    clientOperationId: "webmcp-proposal-one",
    expectedVersion: 7,
    proposal: {
      title: "Source-grounded research agents",
      authors: ["Ada Evidence", "Linus Provenance"],
      year: 2026,
      venue: "Journal of Verifiable Research",
      publicationType: "journal article",
      abstract: "A metadata proposal remains separate from physical document custody.",
      identifiers: [{ scheme: "doi", value: "10.5555/webmcp.2026" }],
      sourcePageUrl: "https://repository.example.org/papers/webmcp-2026",
      candidatePdfUrl: "https://repository.example.org/papers/webmcp-2026.pdf",
      isOpenAccess: true,
      license: "CC-BY-4.0",
      version: "published-version",
    },
  };
}

function reverseObjectPropertyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectPropertyOrder);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectPropertyOrder(entry)]),
  );
}

test("WebMCP snapshots derive source authority while retaining metadata-only custody", () => {
  const fixedTime = new Date("2026-08-29T12:34:56.000Z");
  const first = webMcpProposalSnapshot(command(), fixedTime);
  const second = webMcpProposalSnapshot(command(), fixedTime);

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, WEB_MCP_SNAPSHOT_SCHEMA_VERSION);
  assert.match(first.paper.id, /^webmcp-[a-f0-9]{64}$/);
  assert.equal(first.paper.sourceUrl, command().proposal.sourcePageUrl);
  assert.equal(first.paper.access?.landingPageUrl, command().proposal.sourcePageUrl);
  assert.equal(first.paper.access?.pdfUrl, command().proposal.candidatePdfUrl);
  assert.equal(first.paper.access?.hasFullText, false);
  assert.equal(first.paper.isDemoRecord, false);
  assert.equal(first.provenance.id, `webmcp-provenance-${first.paper.id.slice("webmcp-".length)}`);
  assert.equal(first.provenance.sourceType, "web-source");
  assert.equal(first.provenance.sourceId, command().proposal.sourcePageUrl);
  assert.equal(first.provenance.sourceUrl, command().proposal.sourcePageUrl);
  assert.equal(first.provenance.providerName, "PaperPilot WebMCP");
  assert.equal(first.provenance.retrievedAt, fixedTime.toISOString());
  assert.equal(first.provenance.accessMethod, "webmcp");
  assert.equal(Object.hasOwn(first, "documentId"), false);
  assert.equal(Object.hasOwn(first, "assetId"), false);
  assert.equal(Object.hasOwn(first, "storageKey"), false);
  assert.equal(Object.hasOwn(first, "sha256"), false);
  assert.equal(isServerManagedWebMcpSnapshot(first), true);
});

test("snapshot digest compatibility is golden for historical v1 and current v2", () => {
  const current = webMcpProposalSnapshot(
    command(),
    new Date("2026-08-29T12:34:56.000Z"),
  );
  const historicalV1: HistoricalServerManagedWebMcpSnapshotV1 = {
    paper: current.paper,
    provenance: current.provenance,
  };

  assert.deepEqual(decodeServerManagedWebMcpSnapshot(historicalV1), {
    schemaVersion: 1,
    snapshot: historicalV1,
  });
  assert.deepEqual(decodeServerManagedWebMcpSnapshot(current), {
    schemaVersion: WEB_MCP_SNAPSHOT_SCHEMA_VERSION,
    snapshot: current,
  });
  assert.equal(webMcpSnapshotDigest(historicalV1), HISTORICAL_V1_GOLDEN_DIGEST);
  assert.equal(webMcpSnapshotDigest(current), CURRENT_V2_GOLDEN_DIGEST);
  assert.notEqual(CURRENT_V2_GOLDEN_DIGEST, HISTORICAL_V1_GOLDEN_DIGEST);
  assert.equal(
    verifyWebMcpSnapshotDigest(historicalV1, HISTORICAL_V1_GOLDEN_DIGEST),
    true,
  );
  assert.equal(verifyWebMcpSnapshotDigest(current, CURRENT_V2_GOLDEN_DIGEST), true);
  assert.equal(verifyWebMcpSnapshotDigest(current, HISTORICAL_V1_GOLDEN_DIGEST), false);

  const reorderedHistorical = reverseObjectPropertyOrder(
    historicalV1,
  ) as HistoricalServerManagedWebMcpSnapshotV1;
  const reorderedCurrent = reverseObjectPropertyOrder(
    current,
  ) as ServerManagedWebMcpSnapshot;
  assert.equal(webMcpSnapshotDigest(reorderedHistorical), HISTORICAL_V1_GOLDEN_DIGEST);
  assert.equal(webMcpSnapshotDigest(reorderedCurrent), CURRENT_V2_GOLDEN_DIGEST);
});

test("canonical JSON orders object keys by Unicode code point", () => {
  const reverseCodePointOrder = {
    "\u{10000}": "astral",
    "\uE000": "bmp-private-use",
    "\u00E9": "precomposed",
    "e\u0301": "decomposed",
    A: "ascii",
  };
  assert.equal(
    canonicalWebMcpSnapshotJson(reverseCodePointOrder),
    "{\"A\":\"ascii\",\"e\u0301\":\"decomposed\",\"\u00E9\":\"precomposed\",\"\uE000\":\"bmp-private-use\",\"\u{10000}\":\"astral\"}",
  );
  assert.equal(
    canonicalWebMcpSnapshotJson(reverseObjectPropertyOrder(reverseCodePointOrder)),
    canonicalWebMcpSnapshotJson(reverseCodePointOrder),
  );
});

test("a candidate PDF URL never becomes a full-text or Reader assertion", () => {
  const value = command();
  value.proposal.abstract = undefined;
  value.proposal.isOpenAccess = undefined;
  value.proposal.license = undefined;
  value.proposal.version = undefined;

  const snapshot = webMcpProposalSnapshot(value, new Date(0));
  assert.deepEqual(snapshot.paper.access, {
    isOpenAccess: false,
    hasFullText: false,
    landingPageUrl: value.proposal.sourcePageUrl,
    pdfUrl: value.proposal.candidatePdfUrl,
  });
  assert.equal(snapshot.paper.abstract, "");
  assert.equal(snapshot.provenance.excerpt, undefined);
  assert.equal(snapshot.provenance.version, undefined);
  assert.equal(isServerManagedWebMcpSnapshot(snapshot), true);
});

test("WebMCP snapshot decoding rejects source, custody, and open-shape drift", () => {
  const snapshot = webMcpProposalSnapshot(command(), new Date("2026-08-29T12:34:56.000Z"));
  const variants: unknown[] = [
    { ...snapshot, documentId: "forged-document" },
    { ...snapshot, schemaVersion: 1 },
    { ...snapshot, schemaVersion: 3 },
    { ...snapshot, schemaVersion: undefined },
    { ...snapshot, paper: { ...snapshot.paper, unexpected: true } },
    { ...snapshot, paper: { ...snapshot.paper, authors: "not-an-array" } },
    { ...snapshot, paper: { ...snapshot.paper, sourceUrl: "https://other.example.org/paper" } },
    {
      ...snapshot,
      paper: {
        ...snapshot.paper,
        access: { ...snapshot.paper.access, hasFullText: true },
      },
    },
    { ...snapshot, provenance: { ...snapshot.provenance, accessMethod: "upload" } },
    { ...snapshot, provenance: { ...snapshot.provenance, providerName: "OpenAlex" } },
    { ...snapshot, provenance: { ...snapshot.provenance, retrievedAt: "not-a-date" } },
  ];
  for (const value of variants) assert.equal(isServerManagedWebMcpSnapshot(value), false);
  assert.equal(verifyWebMcpSnapshotDigest(snapshot, "A".repeat(64)), false);
  assert.throws(
    () => webMcpSnapshotDigest({ ...snapshot, schemaVersion: 3 } as never),
    /retained schema version/,
  );
});
