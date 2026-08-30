import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  HttpWorkspaceClient,
  parseCreateEvidenceRevisionResponse,
} from "./http-client";
import type { EvidenceNote } from "../types";

const quote = "The replacement result supports this bounded claim.";
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function responseFor(action: "verify" | "reanchor") {
  const current = action === "reanchor";
  const manifestSha256 = (current ? "a" : "b").repeat(64);
  const grounding = {
    schemaVersion: 1 as const,
    state: current ? "current" as const : "superseded" as const,
    documentId: "document:one",
    extractionId: current ? "extraction:new" : "extraction:old",
    manifestSha256,
    start: {
      chunkId: "chunk:one",
      sequence: 0,
      byteOffset: 0,
      contentHash: "c".repeat(64),
    },
    end: {
      chunkId: "chunk:one",
      sequence: 0,
      byteOffset: Buffer.byteLength(quote, "utf8"),
      contentHash: "c".repeat(64),
    },
    quoteSha256: digest(quote),
    pageStart: 2,
    pageEnd: 2,
    paragraphStartId: "p2-p1",
    paragraphEndId: "p2-p1",
  };
  return {
    ok: true as const,
    outcome: "applied" as const,
    aggregateVersion: 12,
    data: {
      predecessorId: "note:one",
      note: {
        id: "note:two",
        paperId: "paper:one",
        title: "Bounded result",
        kind: "direct-evidence" as const,
        claim: "The result supports the project claim.",
        evidence: quote,
        interpretation: "The result applies within the stated population.",
        confidence: "medium" as const,
        status: action === "verify" ? "verified" as const : "captured" as const,
        provenance: {
          id: "provenance:two",
          sourceType: "uploaded-file" as const,
          sourceId: grounding.extractionId,
          sourceTitle: "A source paper",
          providerName: "PaperPilot Reader",
          retrievedAt: "2026-08-28T12:00:00.000Z",
          accessMethod: "upload" as const,
          locator: {
            paperId: "paper:one",
            page: 2,
            paragraphId: "p2-p1",
          },
          excerpt: quote,
          version: `manifest:${manifestSha256}`,
        },
        linkedHighlightIds: [],
        collectionIds: ["collection:one"],
        tags: ["result"],
        grounding,
        revision: {
          rootId: "note:one",
          previousId: "note:one",
          number: 2,
          isLatest: true,
        },
        ...(action === "verify" ? { reviewedAt: "2026-08-28T12:00:00.000Z" } : {}),
        createdAt: "2026-08-28T12:00:00.000Z",
        updatedAt: "2026-08-28T12:00:00.000Z",
      },
      linkedProjectIds: ["project:one"],
      updatedCollectionIds: ["collection:one"],
    },
  };
}

test("revision parser admits verified stale custody and current re-anchors as separate states", () => {
  const verified = parseCreateEvidenceRevisionResponse(
    responseFor("verify"),
    "verify",
    "note:one",
  );
  const reanchored = parseCreateEvidenceRevisionResponse(
    responseFor("reanchor"),
    "reanchor",
    "note:one",
  );

  assert.equal(verified?.ok, true);
  if (verified?.ok) {
    assert.equal(verified.data.note.status, "verified");
    assert.equal(verified.data.note.grounding?.state, "superseded");
    assert.equal(verified.data.note.revision.previousId, "note:one");
  }
  assert.equal(reanchored?.ok, true);
  if (reanchored?.ok) {
    assert.equal(reanchored.data.note.status, "captured");
    assert.equal(reanchored.data.note.grounding?.state, "current");
  }
});

test("revision parser rejects open fields, lineage drift, and review drift", () => {
  const open = responseFor("verify");
  Object.assign(open.data, { diagnostic: "closed boundary" });
  assert.equal(parseCreateEvidenceRevisionResponse(open, "verify", "note:one"), null);

  const lineage = responseFor("verify");
  lineage.data.note.revision.previousId = "note:other";
  assert.equal(parseCreateEvidenceRevisionResponse(lineage, "verify", "note:one"), null);

  const review = responseFor("verify");
  delete (review.data.note as { reviewedAt?: string }).reviewedAt;
  assert.equal(parseCreateEvidenceRevisionResponse(review, "verify", "note:one"), null);

});

test("revision parser reserves a non-head successor for durable replay", () => {
  const applied = responseFor("reanchor");
  (applied.data.note.grounding as { state: string }).state = "superseded";
  applied.data.note.revision.isLatest = false;
  Object.assign(applied.data.note.revision, { nextId: "note:three" });
  assert.equal(
    parseCreateEvidenceRevisionResponse(applied, "reanchor", "note:one"),
    null,
  );

  const replayed = structuredClone(applied);
  (replayed as { outcome: string }).outcome = "replayed";
  const parsed = parseCreateEvidenceRevisionResponse(
    replayed,
    "reanchor",
    "note:one",
  );
  assert.equal(parsed?.ok, true);
  if (!parsed?.ok) return;
  assert.equal(parsed.data.note.grounding?.state, "superseded");
  assert.equal(parsed.data.note.revision.isLatest, false);
  assert.equal(parsed.data.note.revision.nextId, "note:three");
});

test("revision client sends the idempotent exact route and verifies a re-anchor selection", async () => {
  const payload = responseFor("reanchor");
  (payload.data.note.grounding as { state: string }).state = "superseded";
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const client = new HttpWorkspaceClient("workspace:one", (async (url, init) => {
    observedUrl = String(url);
    observedInit = init;
    return new Response(JSON.stringify(payload), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
  const grounding = payload.data.note.grounding;
  const predecessor: EvidenceNote = {
    ...payload.data.note,
    id: "note:one",
    status: "captured",
    reviewedAt: undefined,
    revision: {
      rootId: "note:one",
      nextId: undefined,
      number: 1,
      isLatest: true,
    },
  };
  const result = await client.createEvidenceRevision("note:one", {
    clientOperationId: "operation:one",
    expectedVersion: 11,
    action: "reanchor",
    selection: {
      documentId: grounding.documentId,
      extractionId: grounding.extractionId,
      manifestSha256: grounding.manifestSha256,
      start: grounding.start,
      end: grounding.end,
      expectedQuoteSha256: grounding.quoteSha256,
    },
  }, predecessor);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.note.grounding?.state, "superseded");
  assert.equal(observedUrl, "/api/workspaces/workspace%3Aone/evidence-notes/note%3Aone/revisions");
  assert.equal(new Headers(observedInit?.headers).get("Idempotency-Key"), "operation:one");
  assert.equal(JSON.parse(String(observedInit?.body)).action, "reanchor");
});

test("revision client permits source-state projection during review but rejects semantic drift", async () => {
  const payload = responseFor("verify");
  const predecessor: EvidenceNote = {
    ...payload.data.note,
    id: "note:one",
    status: "captured",
    reviewedAt: undefined,
    grounding: { ...payload.data.note.grounding, state: "current" },
    revision: {
      rootId: "note:one",
      number: 1,
      isLatest: true,
    },
  };
  const validClient = new HttpWorkspaceClient("workspace:one", (async () =>
    new Response(JSON.stringify(payload), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch);
  const valid = await validClient.createEvidenceRevision("note:one", {
    clientOperationId: "operation:review",
    expectedVersion: 11,
    action: "verify",
  }, predecessor);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.data.note.grounding?.state, "superseded");

  const drift = responseFor("verify");
  drift.data.note.claim = "A silently changed claim.";
  const invalidClient = new HttpWorkspaceClient("workspace:one", (async () =>
    new Response(JSON.stringify(drift), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch);
  await assert.rejects(
    invalidClient.createEvidenceRevision("note:one", {
      clientOperationId: "operation:review-drift",
      expectedVersion: 11,
      action: "verify",
    }, predecessor),
    /incoherent evidence successor/u,
  );
});

test("revision client recovers a durable A-to-B replay after local history already knows C", async () => {
  const payload = responseFor("verify");
  (payload as { outcome: string }).outcome = "replayed";
  payload.data.note.revision.isLatest = false;
  Object.assign(payload.data.note.revision, { nextId: "note:three" });
  payload.data.note.collectionIds = ["collection:new"];
  payload.data.updatedCollectionIds = ["collection:new"];
  const predecessor: EvidenceNote = {
    ...payload.data.note,
    id: "note:one",
    status: "captured",
    reviewedAt: undefined,
    collectionIds: ["collection:old"],
    revision: {
      rootId: "note:one",
      nextId: "note:two",
      number: 1,
      isLatest: false,
    },
  };
  const client = new HttpWorkspaceClient("workspace:one", (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch);

  const replay = await client.createEvidenceRevision("note:one", {
    clientOperationId: "operation:durable-review",
    expectedVersion: 13,
    action: "verify",
  }, predecessor);

  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.outcome, "replayed");
  assert.equal(replay.data.note.revision.isLatest, false);
  assert.equal(replay.data.note.revision.nextId, "note:three");
  assert.deepEqual(replay.data.note.collectionIds, ["collection:new"]);
});

test("revision client keeps applied responses strict about the local head and memberships", async () => {
  const appliedToHistorical = responseFor("verify");
  const historicalPredecessor: EvidenceNote = {
    ...appliedToHistorical.data.note,
    id: "note:one",
    status: "captured",
    reviewedAt: undefined,
    revision: {
      rootId: "note:one",
      nextId: "note:two",
      number: 1,
      isLatest: false,
    },
  };
  const historicalClient = new HttpWorkspaceClient("workspace:one", (async () =>
    Response.json(appliedToHistorical, { status: 201 })) as typeof fetch);
  await assert.rejects(
    historicalClient.createEvidenceRevision("note:one", {
      clientOperationId: "operation:invalid-applied-history",
      expectedVersion: 11,
      action: "verify",
    }, historicalPredecessor),
    /incoherent evidence successor/u,
  );

  const appliedWithMembershipDrift = responseFor("verify");
  appliedWithMembershipDrift.data.note.collectionIds = ["collection:new"];
  appliedWithMembershipDrift.data.updatedCollectionIds = ["collection:new"];
  const headPredecessor: EvidenceNote = {
    ...appliedWithMembershipDrift.data.note,
    id: "note:one",
    status: "captured",
    reviewedAt: undefined,
    collectionIds: ["collection:old"],
    revision: {
      rootId: "note:one",
      number: 1,
      isLatest: true,
    },
  };
  const membershipClient = new HttpWorkspaceClient("workspace:one", (async () =>
    Response.json(appliedWithMembershipDrift, { status: 201 })) as typeof fetch);
  await assert.rejects(
    membershipClient.createEvidenceRevision("note:one", {
      clientOperationId: "operation:invalid-applied-membership",
      expectedVersion: 11,
      action: "verify",
    }, headPredecessor),
    /incoherent evidence successor/u,
  );
});
