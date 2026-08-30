import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceNoteRevision } from "@/lib/types";
import type { EvidenceNoteWithRelations, ProjectWithRelations } from "./service";

process.env.DATABASE_URL ??= "postgresql://paperpilot_runtime:unit@127.0.0.1:1/paperpilot_unit?sslmode=disable";

const {
  collectionDto,
  deriveEvidenceRevisionLineage,
  evidenceNoteDto,
  projectDto,
} = await import("./service");

test("visible evidence lineage is bounded, ordered, and does not leak an unavailable predecessor", () => {
  const full = deriveEvidenceRevisionLineage([
    { id: "revision-3", supersedesId: "revision-2" },
    { id: "revision-1", supersedesId: null },
    { id: "revision-2", supersedesId: "revision-1" },
  ]);

  assert.deepEqual(full.get("revision-1"), {
    rootId: "revision-1",
    nextId: "revision-2",
    number: 1,
    isLatest: false,
  });
  assert.deepEqual(full.get("revision-2"), {
    rootId: "revision-1",
    previousId: "revision-1",
    nextId: "revision-3",
    number: 2,
    isLatest: false,
  });
  assert.deepEqual(full.get("revision-3"), {
    rootId: "revision-1",
    previousId: "revision-2",
    number: 3,
    isLatest: true,
  });

  const privatePredecessorOmitted = deriveEvidenceRevisionLineage([
    { id: "revision-2", supersedesId: "private-revision-1" },
    { id: "revision-3", supersedesId: "revision-2" },
  ]);
  assert.deepEqual(privatePredecessorOmitted.get("revision-2"), {
    rootId: "revision-2",
    nextId: "revision-3",
    number: 1,
    isLatest: false,
  });
  assert.equal(
    JSON.stringify([...privatePredecessorOmitted.values()]).includes("private-revision-1"),
    false,
  );
});

test("lineage rejects duplicate, branching, and cyclic inputs instead of inventing history", () => {
  assert.throws(
    () => deriveEvidenceRevisionLineage([
      { id: "same", supersedesId: null },
      { id: "same", supersedesId: null },
    ]),
    /Duplicate evidence revision node/,
  );
  assert.throws(
    () => deriveEvidenceRevisionLineage([
      { id: "root", supersedesId: null },
      { id: "left", supersedesId: "root" },
      { id: "right", supersedesId: "root" },
    ]),
    /branches/,
  );
  assert.throws(
    () => deriveEvidenceRevisionLineage([
      { id: "one", supersedesId: "two" },
      { id: "two", supersedesId: "one" },
    ]),
    /cycle or disconnected successor graph/,
  );
});

test("project active note IDs contain each revision head once while history remains derivable", () => {
  const project = {
    id: "project-1",
    organizationId: "workspace-1",
    name: "Evidence review",
    slug: "evidence-review",
    description: null,
    researchQuestion: "What changed?",
    type: "LITERATURE_REVIEW",
    visibility: "WORKSPACE",
    status: "ACTIVE",
    createdById: "user-1",
    createdAt: new Date("2026-08-28T10:00:00.000Z"),
    updatedAt: new Date("2026-08-28T11:00:00.000Z"),
    archivedAt: null,
    papers: [],
    evidenceNotes: [
      { id: "revision-1", supersedesId: null },
      { id: "revision-2", supersedesId: "revision-1" },
      { id: "revision-3", supersedesId: "revision-2" },
    ],
    evidenceMemberships: [
      {
        evidenceNoteId: "revision-1",
        evidenceNote: { id: "revision-1", supersedesId: null },
      },
      {
        evidenceNoteId: "revision-3",
        evidenceNote: { id: "revision-3", supersedesId: "revision-2" },
      },
    ],
    collections: [],
  } satisfies ProjectWithRelations;

  assert.deepEqual(projectDto(project).evidenceNoteIds, ["revision-3"]);
  assert.equal(deriveEvidenceRevisionLineage(project.evidenceNotes).size, 3);
});

test("collection note IDs and counts use only immutable revision heads", () => {
  const collection = collectionDto({
    id: "collection-1",
    name: "Key evidence",
    description: null,
    color: "blue",
    updatedAt: new Date("2026-08-28T11:00:00.000Z"),
    paperMemberships: [],
    evidenceMemberships: [
      {
        evidenceNoteId: "revision-1",
        evidenceNote: { supersedesId: null, kind: "RESULT", openQuestion: null },
      },
      {
        evidenceNoteId: "revision-2",
        evidenceNote: { supersedesId: "revision-1", kind: "QUESTION", openQuestion: "Why?" },
      },
      {
        evidenceNoteId: "other-root",
        evidenceNote: { supersedesId: null, kind: "METHOD", openQuestion: null },
      },
    ],
  });

  assert.deepEqual(collection.noteIds, ["revision-2", "other-root"]);
  assert.equal(collection.evidenceClaimCount, 1);
  assert.equal(collection.openQuestionCount, 1);
});

function structuredNote(
  id: string,
  status: "CAPTURED" | "VERIFIED",
  verifiedAt: Date | null,
): EvidenceNoteWithRelations {
  const now = new Date("2026-08-28T12:00:00.000Z");
  return {
    id,
    organizationId: "workspace-1",
    workspacePaperId: "workspace-paper-1",
    projectId: "project-1",
    documentId: null,
    documentChunkId: null,
    createdById: "user-1",
    supersedesId: null,
    kind: "RESULT",
    status,
    confidence: "HIGH",
    title: "Result",
    claim: "The intervention improved recall.",
    evidence: "Recall improved by 14 percent.",
    interpretation: "The observed effect supports the claim.",
    openQuestion: null,
    linkedHighlightIds: [],
    tags: [],
    quote: "Recall improved by 14 percent.",
    text: "The intervention improved recall.",
    pageStart: 4,
    pageEnd: 4,
    sectionId: "results",
    sectionTitle: "Results",
    paragraphId: "p-4",
    figureId: null,
    figureLabel: null,
    verifiedAt,
    groundingVersion: null,
    createdAt: now,
    updatedAt: now,
    workspacePaper: { paperId: "paper-1" },
    provenanceRecords: [{
      id: `provenance-${id}`,
      organizationId: "workspace-1",
      kind: "USER_ASSERTION",
      paperId: "paper-1",
      workspacePaperId: "workspace-paper-1",
      inboxEntryId: null,
      evidenceNoteId: id,
      documentId: null,
      zoteroObjectId: null,
      integrationConnectionId: null,
      actorUserId: "user-1",
      actorPrincipalId: null,
      supersedesId: null,
      sourceProvider: "PaperPilot",
      sourceRecordId: `source-${id}`,
      sourceUri: null,
      retrievedAt: now,
      payloadDigest: null,
      payload: {
        provenance: {
          sourceType: "paper",
          sourceTitle: "A study",
          providerName: "PaperPilot",
          accessMethod: "manual",
        },
      },
      createdAt: now,
    }],
    collectionMemberships: [],
    projectMemberships: [{
      id: `membership-${id}`,
      organizationId: "workspace-1",
      projectId: "project-1",
      evidenceNoteId: id,
      createdAt: now,
      project: { visibility: "WORKSPACE", createdById: "user-1" },
    }],
    project: { visibility: "WORKSPACE", createdById: "user-1" },
    textAnchor: null,
  };
}

test("verified review state and revision supersession remain independent", () => {
  const revisions = deriveEvidenceRevisionLineage([
    { id: "verified-1", supersedesId: null },
    { id: "captured-2", supersedesId: "verified-1" },
  ]);
  const reviewedAt = new Date("2026-08-28T12:30:00.000Z");
  const verifiedRevision = evidenceNoteDto(
    structuredNote("verified-1", "VERIFIED", reviewedAt),
    { revision: revisions.get("verified-1") as EvidenceNoteRevision },
  );
  const capturedHead = evidenceNoteDto(
    {
      ...structuredNote("captured-2", "CAPTURED", null),
      supersedesId: "verified-1",
    },
    { revision: revisions.get("captured-2") as EvidenceNoteRevision },
  );

  assert.equal(verifiedRevision?.status, "verified");
  assert.equal(verifiedRevision?.reviewedAt, reviewedAt.toISOString());
  assert.equal(verifiedRevision?.revision.isLatest, false);
  assert.equal(verifiedRevision?.revision.nextId, "captured-2");
  assert.equal(capturedHead?.status, "captured");
  assert.equal(capturedHead?.reviewedAt, undefined);
  assert.equal(capturedHead?.revision.isLatest, true);
  assert.equal(capturedHead?.revision.previousId, "verified-1");
});

test("contradictory review status and timestamp combinations fail closed", () => {
  assert.equal(evidenceNoteDto(
    structuredNote("verified-without-time", "VERIFIED", null),
    { revision: { rootId: "verified-without-time", number: 1, isLatest: true } },
  ), null);
  assert.equal(evidenceNoteDto(
    structuredNote("captured-with-time", "CAPTURED", new Date("2026-08-28T12:30:00.000Z")),
    { revision: { rootId: "captured-with-time", number: 1, isLatest: true } },
  ), null);
});
