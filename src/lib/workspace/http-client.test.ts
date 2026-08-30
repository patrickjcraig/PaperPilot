import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  ApproveWebMcpProposalCommand,
  WebMcpDuplicateDecision,
  WorkspaceProjectDto,
} from "./contracts";
import {
  freezeWebMcpApprovalSubmission,
  HttpWorkspaceClient,
  parsePrepareWebMcpApprovalChallengeResponse,
} from "./http-client";
import type {
  EvidenceNote,
  EvidenceNoteRevision,
  InboxEntry,
  Paper,
  WebMcpInboxEntry,
} from "../types";

const proposalDigest = "a".repeat(64);
const verificationDigest = "b".repeat(64);
const openAlexIdentifier = "openalex:W2741809807";
const approvalChallengeId = "C".repeat(43);

function evidenceCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(evidenceCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${evidenceCanonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(evidenceCanonicalJson(value), "utf8").digest("hex");
}

function approvalSubmission(options: {
  operationId?: string;
  expectedVersion?: number;
  decision?: WebMcpDuplicateDecision;
  challengeId?: string;
  evidenceDigest?: string;
} = {}) {
  const command: ApproveWebMcpProposalCommand = {
    schemaVersion: 2,
    clientOperationId: options.operationId ?? "approval:webmcp-one",
    expectedVersion: options.expectedVersion ?? 7,
    inboxEntryId: "inbox:webmcp-one",
    proposalDigest,
    destinationProjectId: "project:one",
    duplicateDecision: options.decision ?? { kind: "create_new" },
    challengeId: options.challengeId ?? approvalChallengeId,
    evidenceDigest: options.evidenceDigest ?? verificationDigest,
  };
  return freezeWebMcpApprovalSubmission(command);
}

function openAlexChallengeResponse() {
  const verifiedEvidence = {
    schemaVersion: 1,
    kind: "openalex_verified_work",
    authority: "OPENALEX",
    authorityVersion: "works-singleton-v1",
    retrievedAt: "2026-08-29T12:00:00.000Z",
    sourceRecordId: "W2741809807",
    providerUpdatedAt: "2026-08-29T11:59:00.000Z",
    paper: {
      title: "A bounded WebMCP proposal",
      abstractText: "Provider-verified evidence.",
      publicationYear: 2026,
      publicationDate: "2026-08-29",
      language: "en",
      workType: "article",
      venueName: "Journal of Verifiable Interfaces",
      citationCount: 4,
      isRetracted: false,
      identifiers: [
        {
          type: "DOI",
          value: "10.5555/paperpilot",
          normalizedValue: "10.5555/paperpilot",
          source: "OPENALEX",
        },
        {
          type: "OPENALEX",
          value: "W2741809807",
          normalizedValue: "w2741809807",
          source: "OPENALEX",
        },
      ],
      authors: [{ position: 0, displayName: "Ada Researcher" }],
    },
  };
  const verifiedEvidenceDigest = evidenceDigest(verifiedEvidence);
  return {
    ok: true,
    outcome: "applied",
    aggregateVersion: 7,
    data: {
      challenge: {
        schemaVersion: 1,
        challengeId: approvalChallengeId,
        expiresAt: "2026-08-29T12:05:00.000Z",
        expectedVersion: 7,
        inboxEntryId: "inbox:webmcp-one",
        proposalDigest,
        destinationProjectId: "project:one",
        duplicateDecision: { kind: "create_new" },
        evidence: {
          authority: "OPENALEX",
          authorityVersion: "works-singleton-v1",
          evidenceDigest: verifiedEvidenceDigest,
          verifiedSnapshot: {
            ...verifiedEvidence,
            evidenceDigest: verifiedEvidenceDigest,
          },
        },
      },
    },
  };
}

function paperFixture(
  id = "paper:canonical",
  identifiers: Paper["identifiers"] = [{ scheme: "doi", value: "10.5555/paperpilot" }],
): Paper {
  return {
    id,
    title: "A bounded WebMCP proposal",
    shortTitle: "A bounded WebMCP proposal",
    authors: ["Ada Researcher"],
    year: 2026,
    venue: "Journal of Verifiable Interfaces",
    type: "journal article",
    abstract: "A metadata-only proposal with explicit review authority.",
    abstractSnippet: "A metadata-only proposal with explicit review authority.",
    whyRead: "",
    relevanceScore: 0,
    relevanceTags: [],
    evidenceStrength: "unassessed",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 0,
    identifiers,
    sourceUrl: "https://repository.example/paper",
    access: {
      isOpenAccess: true,
      hasFullText: false,
      landingPageUrl: "https://repository.example/paper",
      pdfUrl: "https://repository.example/paper.pdf",
      license: "CC-BY-4.0",
    },
    isDemoRecord: false,
  };
}

function webMcpEntryFixture(
  options: {
    duplicate?: boolean;
    status?: WebMcpInboxEntry["status"];
    identifiers?: Paper["identifiers"];
  } = {},
): WebMcpInboxEntry {
  const proposedPaper = paperFixture(
    `webmcp-${"c".repeat(64)}`,
    options.identifiers ?? [{ scheme: "doi", value: "10.5555/paperpilot" }],
  );
  const canonicalPaper = paperFixture();
  return {
    entryKind: "paper",
    id: "inbox:webmcp-one",
    sourceKind: "webmcp",
    paper: proposedPaper,
    provenance: {
      id: `webmcp-provenance-${"c".repeat(64)}`,
      sourceType: "web-source",
      sourceId: "https://repository.example/paper",
      sourceTitle: proposedPaper.title,
      sourceUrl: "https://repository.example/paper",
      providerName: "PaperPilot WebMCP",
      retrievedAt: "2026-08-29T12:00:00.000Z",
      accessMethod: "webmcp",
      excerpt: proposedPaper.abstractSnippet,
    },
    status: options.status ?? "awaiting-review",
    ...(options.duplicate ? {
      duplicateOfPaperId: "paper:canonical",
      duplicateCandidate: {
        id: canonicalPaper.id,
        title: canonicalPaper.title,
        authors: canonicalPaper.authors,
        year: canonicalPaper.year,
        venue: canonicalPaper.venue,
        type: canonicalPaper.type,
        identifiers: canonicalPaper.identifiers,
      },
    } : {}),
    proposalDigest,
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
  };
}

function emptyBootstrap(inboxEntries: unknown[] = [], papers: unknown[] = []) {
  return {
    schemaVersion: 3,
    aggregateVersion: 7,
    workspace: {
      id: "workspace:one",
      name: "Workspace",
      mode: "live",
      role: "member",
    },
    activeProjectId: null,
    projects: [],
    inboxEntries,
    papers,
    notes: [],
    collections: [],
  };
}

function approvalResponse(
  decision: "create_new" | "use_existing" = "create_new",
) {
  const canonicalPaper = paperFixture(
    "paper:canonical",
    decision === "create_new"
      ? [
          { scheme: "doi", value: "10.5555/paperpilot" },
          { scheme: "provider", value: openAlexIdentifier },
        ]
      : [{ scheme: "doi", value: "10.5555/paperpilot" }],
  );
  const entry = {
    ...webMcpEntryFixture({ duplicate: decision === "use_existing", status: "ready" }),
    destinationProjectId: "project:one",
  };
  return {
    ok: true,
    outcome: "applied",
    aggregateVersion: 8,
    data: {
      approval: {
        id: "approval:webmcp-one",
        challengeId: approvalChallengeId,
        inboxEntryId: entry.id,
        proposalDigest,
        destinationProjectId: "project:one",
        decision,
        canonicalPaperId: canonicalPaper.id,
        evidenceDigest: verificationDigest,
        verifiedIdentifiers: decision === "create_new"
          ? [
              {
                scheme: "doi",
                value: "10.5555/paperpilot",
                authority: "openalex",
                evidenceDigest: verificationDigest,
              },
              {
                scheme: "provider",
                value: openAlexIdentifier,
                authority: "openalex",
                evidenceDigest: verificationDigest,
              },
            ]
          : [],
        approvedAt: "2026-08-29T12:01:00.000Z",
      },
      inboxEntry: entry,
      paper: canonicalPaper,
      project: {
        id: "project:one",
        name: "WebMCP review",
        question: "Which metadata can be promoted?",
        description: "",
        type: "literature-review",
        visibility: "private",
        status: "active",
        paperIds: [canonicalPaper.id],
        evidenceNoteIds: [],
        collectionIds: [],
        sourceConnectionIds: [],
        createdAt: "2026-08-29T12:00:00.000Z",
        updatedAt: "2026-08-29T12:01:00.000Z",
      },
      usedExistingPaper: decision === "use_existing",
    },
  };
}

function ordinaryInboxEntryFixture(
  options: {
    status?: InboxEntry["status"];
    destinationProjectId?: string;
    duplicateOfPaperId?: string;
  } = {},
): InboxEntry {
  return {
    entryKind: "paper",
    id: "inbox:ordinary-one",
    sourceKind: "discover",
    paper: paperFixture("provider:proposal-one"),
    provenance: {
      id: "provenance:ordinary-one",
      sourceType: "literature-index",
      sourceId: "W2741809807",
      sourceTitle: "A bounded WebMCP proposal",
      sourceUrl: "https://openalex.org/W2741809807",
      providerName: "OpenAlex",
      retrievedAt: "2026-08-29T12:00:00.000Z",
      accessMethod: "api",
    },
    status: options.status ?? "awaiting-review",
    ...(options.destinationProjectId
      ? { destinationProjectId: options.destinationProjectId }
      : {}),
    ...(options.duplicateOfPaperId
      ? { duplicateOfPaperId: options.duplicateOfPaperId }
      : {}),
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
  };
}

function fileImportResponse() {
  const paper = paperFixture("paper:canonical");
  return {
    ok: true,
    outcome: "applied",
    aggregateVersion: 8,
    data: {
      inboxEntry: ordinaryInboxEntryFixture({
        status: "ready",
        destinationProjectId: "project:one",
      }),
      paper,
      project: {
        id: "project:one",
        name: "Ordinary import",
        question: "Which paper belongs here?",
        description: "",
        type: "literature-review",
        visibility: "private",
        status: "active",
        paperIds: [paper.id],
        evidenceNoteIds: [],
        collectionIds: [],
        sourceConnectionIds: [],
        createdAt: "2026-08-29T12:00:00.000Z",
        updatedAt: "2026-08-29T12:01:00.000Z",
      },
      usedExistingPaper: false,
    },
  };
}

const uploadStatus = {
  inboxEntry: {
    entryKind: "document-upload" as const,
    id: "inbox:one",
    sourceKind: "upload" as const,
    provenance: {
      id: "upload:one",
      sourceType: "uploaded-file" as const,
      sourceId: "upload:one",
      sourceTitle: "paper.pdf",
      providerName: "PaperPilot private quarantine",
      retrievedAt: "2026-08-28T12:00:00.000Z",
      accessMethod: "upload" as const,
    },
    status: "processing" as const,
    upload: {
      id: "upload:one",
      documentId: "document:one",
      fileName: "paper.pdf",
      expectedSizeBytes: 17,
      receivedSizeBytes: 17,
      mediaType: "application/pdf" as const,
      stage: "quarantined" as const,
      extractionStage: "not-started" as const,
      readerAvailable: false,
      expiresAt: "2026-08-28T12:15:00.000Z",
    },
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:01:00.000Z",
  },
  upload: {
    id: "upload:one",
    status: "quarantined" as const,
    expiresAt: "2026-08-28T12:15:00.000Z",
  },
  asset: { status: "quarantined" as const, sizeBytes: 17 },
  document: { id: "document:one", status: "pending" as const },
};

function crawlerDocumentEntryFixture() {
  return {
    entryKind: "crawler-document" as const,
    id: "inbox:crawler-one",
    sourceKind: "crawler" as const,
    provenance: {
      id: "crawler:crawler:one",
      sourceType: "web-source" as const,
      sourceId: "crawler:one",
      sourceTitle: "governed-paper.pdf",
      providerName: "PaperPilot governed crawler",
      retrievedAt: "2026-08-29T12:00:00.000Z",
      accessMethod: "crawler" as const,
    },
    status: "ready" as const,
    crawler: {
      id: "crawler:one",
      documentId: "document:crawler-one",
      fileName: "governed-paper.pdf",
      mediaType: "application/pdf" as const,
      stage: "ready" as const,
      extractionStage: "ready" as const,
      readerAvailable: false,
    },
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:01:00.000Z",
  };
}

const detail: WorkspaceProjectDto = {
  aggregateVersion: 7,
  project: {
    id: "project:one",
    name: "Grounded review",
    question: "Which claims are supported?",
    description: "",
    type: "literature-review",
    visibility: "private",
    status: "active",
    paperIds: [],
    evidenceNoteIds: [],
    collectionIds: [],
    sourceConnectionIds: [],
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
  },
  papers: [],
  notes: [],
  collections: [],
};

function readModelNote(
  id: string,
  revision: EvidenceNoteRevision,
  status: EvidenceNote["status"] = "captured",
): EvidenceNote {
  const timestamp = status === "verified"
    ? "2026-08-28T12:01:00.000Z"
    : "2026-08-28T12:00:00.000Z";
  return {
    id,
    paperId: "paper:one",
    title: "Bounded result",
    kind: "direct-evidence",
    claim: "The result supports the bounded claim.",
    evidence: "A preserved excerpt supports the claim.",
    interpretation: "The result applies within the studied population.",
    confidence: "medium",
    status,
    provenance: {
      id: `provenance:${id}`,
      sourceType: "paper",
      sourceId: "paper:one",
      sourceTitle: "A source paper",
      providerName: "PaperPilot",
      retrievedAt: timestamp,
      accessMethod: "manual",
      locator: { paperId: "paper:one", page: 2 },
      excerpt: "A preserved excerpt supports the claim.",
      version: "reader:one",
    },
    linkedHighlightIds: [],
    collectionIds: ["collection:one"],
    tags: ["result"],
    revision,
    ...(status === "verified" ? { reviewedAt: timestamp } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function revisionDetail(): WorkspaceProjectDto {
  const predecessor = readModelNote("note:one", {
    rootId: "note:one",
    nextId: "note:two",
    number: 1,
    isLatest: false,
  });
  const head = readModelNote("note:two", {
    rootId: "note:one",
    previousId: "note:one",
    number: 2,
    isLatest: true,
  }, "verified");
  return {
    ...detail,
    project: {
      ...detail.project,
      evidenceNoteIds: [head.id],
      collectionIds: ["collection:one"],
    },
    notes: [predecessor, head],
    collections: [{
      id: "collection:one",
      name: "Results",
      description: "Reviewed evidence",
      color: "blue",
      paperIds: [],
      noteIds: [head.id],
      evidenceClaimCount: 1,
      openQuestionCount: 0,
      updatedAt: "2026-08-28T12:01:00.000Z",
    }],
  };
}

function revisionBootstrap(projectDetail = revisionDetail()) {
  return {
    schemaVersion: 3 as const,
    aggregateVersion: projectDetail.aggregateVersion,
    workspace: {
      id: "workspace:one",
      name: "Workspace",
      mode: "live" as const,
      role: "member",
    },
    activeProjectId: projectDetail.project.id,
    projects: [projectDetail.project],
    inboxEntries: [],
    papers: projectDetail.papers,
    notes: projectDetail.notes,
    collections: projectDetail.collections,
  };
}

test("bootstrap requires the authenticated workspace role used by integration controls", async () => {
  const validClient = new HttpWorkspaceClient(undefined, async () => Response.json({
    schemaVersion: 3,
    aggregateVersion: 1,
    workspace: {
      id: "workspace-one",
      name: "Workspace",
      mode: "live",
      role: "member",
    },
    activeProjectId: null,
    projects: [],
    inboxEntries: [],
    papers: [],
    notes: [],
    collections: [],
  }));
  assert.equal((await validClient.bootstrap()).workspace.role, "member");

  const missingRoleClient = new HttpWorkspaceClient(undefined, async () => Response.json({
    workspace: { id: "workspace-one", name: "Workspace", mode: "live" },
  }));
  await assert.rejects(
    missingRoleClient.bootstrap(),
    /could not load the authenticated workspace/i,
  );
});

test("bootstrap admits only closed WebMCP records with server-issued snapshot digests", async (context) => {
  const validEntry = webMcpEntryFixture({ duplicate: true });
  const valid = await new HttpWorkspaceClient(undefined, async () =>
    Response.json(emptyBootstrap([validEntry]))).bootstrap();
  assert.deepEqual(valid.inboxEntries, [validEntry]);

  const cases: Array<[string, (entry: Record<string, unknown>) => void]> = [
    ["missing proposal digest", (entry) => { delete entry.proposalDigest; }],
    ["noncanonical proposal digest", (entry) => { entry.proposalDigest = proposalDigest.toUpperCase(); }],
    ["unexpected lifecycle authority", (entry) => { entry.approvalState = "approved"; }],
    ["overstated PDF custody", (entry) => {
      const paper = entry.paper as Paper;
      paper.access!.hasFullText = true;
    }],
    ["wrong provenance transport", (entry) => {
      (entry.provenance as WebMcpInboxEntry["provenance"]).accessMethod = "api";
    }],
    ["duplicate candidate ID drift", (entry) => {
      (entry.duplicateCandidate as { id: string }).id = "paper:other";
    }],
    ["duplicate candidate authority injection", (entry) => {
      (entry.duplicateCandidate as Record<string, unknown>).access = { hasFullText: true };
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const entry = structuredClone(validEntry) as unknown as Record<string, unknown>;
      mutate(entry);
      await assert.rejects(
        new HttpWorkspaceClient(undefined, async () =>
          Response.json(emptyBootstrap([entry]))).bootstrap(),
        /could not load the authenticated workspace/i,
      );
    });
  }
});

test("WebMCP duplicate previews validate full titles without abusing the 500-character short title", async () => {
  const entry = webMcpEntryFixture({ duplicate: true });
  const longTitle = "A".repeat(1_200);
  entry.duplicateCandidate!.title = longTitle;
  const accepted = await new HttpWorkspaceClient(undefined, async () =>
    Response.json(emptyBootstrap([entry]))).bootstrap();
  assert.equal(
    (accepted.inboxEntries[0] as WebMcpInboxEntry).duplicateCandidate?.title.length,
    1_200,
  );

  entry.duplicateCandidate!.title = "A".repeat(2_001);
  await assert.rejects(
    new HttpWorkspaceClient(undefined, async () =>
      Response.json(emptyBootstrap([entry]))).bootstrap(),
    /could not load the authenticated workspace/i,
  );

  const approval = approvalResponse("use_existing");
  approval.data.paper.title = longTitle;
  approval.data.paper.shortTitle = longTitle.slice(0, 500);
  approval.data.inboxEntry.duplicateCandidate!.title = longTitle;
  const approvalClient = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(approval, { status: 201 }));
  assert.equal((await approvalClient.approveWebMcpProposal(approvalSubmission({
    operationId: "approval:long-candidate-title",
    decision: { kind: "use_existing", canonicalPaperId: "paper:canonical" },
  }))).ok, true);
});

test("bootstrap admits only closed URL-free crawler document entries", async (context) => {
  const validEntry = crawlerDocumentEntryFixture();
  const accepted = await new HttpWorkspaceClient(undefined, async () =>
    Response.json(emptyBootstrap([validEntry]))).bootstrap();
  assert.deepEqual(accepted.inboxEntries, [validEntry]);

  const cases: Array<[string, (entry: Record<string, unknown>) => void]> = [
    ["source URL", (entry) => {
      (entry.provenance as Record<string, unknown>).sourceUrl = "https://private.example.test/paper.pdf";
    }],
    ["storage locator", (entry) => {
      (entry.crawler as Record<string, unknown>).storageKey = "private/object";
    }],
    ["digest", (entry) => {
      (entry.crawler as Record<string, unknown>).sha256 = "a".repeat(64);
    }],
    ["worker identity", (entry) => {
      (entry.crawler as Record<string, unknown>).workerId = "worker-secret";
    }],
    ["crawler identity drift", (entry) => {
      (entry.crawler as Record<string, unknown>).id = "crawler:other";
    }],
    ["impossible Reader authority", (entry) => {
      (entry.crawler as Record<string, unknown>).readerAvailable = true;
    }],
    ["unknown lifecycle stage", (entry) => {
      (entry.crawler as Record<string, unknown>).stage = "downloaded";
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const entry = structuredClone(validEntry) as unknown as Record<string, unknown>;
      mutate(entry);
      await assert.rejects(
        new HttpWorkspaceClient(undefined, async () =>
          Response.json(emptyBootstrap([entry]))).bootstrap(),
        /could not load the authenticated workspace/i,
      );
    });
  }
});

test("bootstrap strictly decodes canonical Paper records", async (context) => {
  const validPaper = paperFixture();
  assert.equal((await new HttpWorkspaceClient(undefined, async () =>
    Response.json(emptyBootstrap([], [validPaper]))).bootstrap()).papers[0]?.id, validPaper.id);

  const cases: Array<[string, (paper: Record<string, unknown>) => void]> = [
    ["open shape", (paper) => { paper.documentId = "document:private"; }],
    ["unknown identifier scheme", (paper) => {
      paper.identifiers = [{ scheme: "pmid", value: "42" }];
    }],
    ["contradictory score", (paper) => { paper.relevanceScore = 100_001; }],
    ["malformed access record", (paper) => {
      paper.access = { isOpenAccess: true, hasFullText: false, objectKey: "secret" };
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const paper = structuredClone(validPaper) as unknown as Record<string, unknown>;
      mutate(paper);
      await assert.rejects(
        new HttpWorkspaceClient(undefined, async () =>
          Response.json(emptyBootstrap([], [paper]))).bootstrap(),
        /could not load the authenticated workspace/i,
      );
    });
  }
});

test("bootstrap rejects malformed revision fields, graphs, and historical head indexes", async (context) => {
  assert.equal((await new HttpWorkspaceClient(undefined, async () =>
    Response.json(revisionBootstrap())).bootstrap()).notes.length, 2);

  const cases: Array<[string, (payload: ReturnType<typeof revisionBootstrap>) => void]> = [
    ["missing revision", (payload) => {
      delete (payload.notes[0] as Partial<EvidenceNote>).revision;
    }],
    ["verified note without reviewedAt", (payload) => {
      delete payload.notes[1]!.reviewedAt;
    }],
    ["non-verified note with reviewedAt", (payload) => {
      payload.notes[0]!.reviewedAt = payload.notes[0]!.updatedAt;
    }],
    ["two heads for one root", (payload) => {
      payload.notes[0]!.revision = {
        rootId: "note:one",
        number: 1,
        isLatest: true,
      };
    }],
    ["no visible head for one root", (payload) => {
      payload.notes[1]!.revision = {
        ...payload.notes[1]!.revision,
        nextId: "note:three",
        isLatest: false,
      };
    }],
    ["historical project index", (payload) => {
      payload.projects[0]!.evidenceNoteIds = ["note:one"];
    }],
    ["historical collection index", (payload) => {
      payload.collections[0]!.noteIds = ["note:one"];
    }],
  ];

  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const payload = structuredClone(revisionBootstrap());
      mutate(payload);
      await assert.rejects(
        new HttpWorkspaceClient(undefined, async () => Response.json(payload)).bootstrap(),
        /could not load the authenticated workspace/i,
      );
    });
  }
});

test("getProject requests an encoded, private workspace detail resource", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new HttpWorkspaceClient("workspace/one", async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json(detail);
  });

  const result = await client.getProject({ projectId: "project:one" });

  assert.deepEqual(result, detail);
  assert.equal(
    requestedUrl,
    "/api/workspaces/workspace%2Fone/projects/project%3Aone",
  );
  assert.equal(requestedInit?.credentials, "same-origin");
  assert.equal(requestedInit?.cache, "no-store");
});

test("getProject accepts a privacy-bounded leading history and rejects malformed lineage", async (context) => {
  const partial = revisionDetail();
  partial.notes = [{
    ...partial.notes[1]!,
    revision: {
      rootId: "note:one",
      previousId: "private:predecessor",
      number: 2,
      isLatest: true,
    },
  }];
  const partialClient = new HttpWorkspaceClient("workspace:one", async () => Response.json(partial));
  assert.equal((await partialClient.getProject({ projectId: "project:one" }))?.notes.length, 1);

  const cases: Array<[string, (payload: WorkspaceProjectDto) => void]> = [
    ["non-reciprocal adjacency", (payload) => {
      payload.notes[0]!.revision.nextId = "note:other";
    }],
    ["revision number gap", (payload) => {
      payload.notes[1]!.revision.number = 3;
    }],
    ["branch with duplicate head", (payload) => {
      payload.notes.push({
        ...payload.notes[1]!,
        id: "note:branch",
        provenance: { ...payload.notes[1]!.provenance, id: "provenance:branch" },
        revision: {
          rootId: "note:one",
          previousId: "note:one",
          number: 2,
          isLatest: true,
        },
      });
    }],
    ["historical project index", (payload) => {
      payload.project.evidenceNoteIds = ["note:one"];
    }],
    ["historical collection index", (payload) => {
      payload.collections[0]!.noteIds = ["note:one"];
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const payload = structuredClone(revisionDetail());
      mutate(payload);
      const client = new HttpWorkspaceClient("workspace:one", async () => Response.json(payload));
      await assert.rejects(
        client.getProject({ projectId: "project:one" }),
        /could not load this project/i,
      );
    });
  }
});

test("getProject keeps hidden and missing projects non-enumerating", async () => {
  const client = new HttpWorkspaceClient(
    "workspace-one",
    async () => new Response(null, { status: 404 }),
  );

  assert.equal(await client.getProject({ projectId: "private-project" }), null);
});

test("getProject surfaces a safe server problem message", async () => {
  const client = new HttpWorkspaceClient(
    "workspace-one",
    async () => Response.json(
      { error: { message: "Workspace access expired." } },
      { status: 401 },
    ),
  );

  await assert.rejects(
    client.getProject({ projectId: "project-one" }),
    /Workspace access expired\./,
  );
});

test("createCollection posts an idempotent workspace command to the encoded collection resource", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new HttpWorkspaceClient("workspace/one", async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json({
      ok: true,
      outcome: "applied",
      aggregateVersion: 8,
      data: {
        projectId: "project:one",
        collection: {
          id: "collection:one",
          name: "Outcomes",
          description: "Primary outcomes",
          color: "teal",
          paperIds: [],
          noteIds: [],
          evidenceClaimCount: 0,
          openQuestionCount: 0,
          updatedAt: "2026-08-28T12:00:00.000Z",
        },
      },
    }, { status: 201 });
  });
  const command = {
    clientOperationId: "create-collection-operation",
    expectedVersion: 7,
    projectId: "project:one",
    name: "Outcomes",
    description: "Primary outcomes",
    color: "teal" as const,
  };

  const result = await client.createCollection(command);

  assert.equal(result.ok, true);
  assert.equal(requestedUrl, "/api/workspaces/workspace%2Fone/collections");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(new Headers(requestedInit?.headers).get("Idempotency-Key"), command.clientOperationId);
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), command);
});

test("generic staging admits only a strictly decoded ordinary Inbox entry", async () => {
  let requestedBody: unknown;
  const command = {
    clientOperationId: "stage:ordinary-one",
    expectedVersion: 7,
    sourceKind: "discover" as const,
    paper: paperFixture("provider:proposal-one"),
    provenance: ordinaryInboxEntryFixture().provenance,
    injectedWebMcpAuthority: { proposalDigest },
  };
  const client = new HttpWorkspaceClient("workspace:one", async (_input, init) => {
    requestedBody = JSON.parse(String(init?.body));
    return Response.json({
      ok: true,
      outcome: "applied",
      aggregateVersion: 8,
      data: { inboxEntry: ordinaryInboxEntryFixture() },
    }, { status: 201 });
  });

  const result = await client.stageImport(command);
  assert.equal(result.ok && result.data.inboxEntry.sourceKind, "discover");
  assert.deepEqual(requestedBody, {
    clientOperationId: command.clientOperationId,
    expectedVersion: command.expectedVersion,
    sourceKind: command.sourceKind,
    paper: command.paper,
    provenance: command.provenance,
  });
});

test("generic staging and filing reject WebMCP records, including a disguised source kind", async (context) => {
  const stageCommand = {
    clientOperationId: "stage:hostile-webmcp",
    expectedVersion: 7,
    sourceKind: "discover" as const,
    paper: paperFixture("provider:proposal-one"),
    provenance: ordinaryInboxEntryFixture().provenance,
  };
  const webMcpEntry = webMcpEntryFixture();
  const disguised = structuredClone(webMcpEntry) as unknown as Record<string, unknown>;
  disguised.sourceKind = "discover";
  delete disguised.proposalDigest;

  for (const [name, inboxEntry] of [
    ["explicit WebMCP", webMcpEntry],
    ["disguised WebMCP provenance", disguised],
  ] as const) {
    await context.test(name, async () => {
      const client = new HttpWorkspaceClient("workspace:one", async () => Response.json({
        ok: true,
        outcome: "applied",
        aggregateVersion: 8,
        data: { inboxEntry },
      }, { status: 201 }));
      await assert.rejects(client.stageImport(stageCommand), /invalid import response/i);
    });
  }

  const hostileFile = fileImportResponse();
  hostileFile.data.inboxEntry = {
    ...webMcpEntryFixture({ status: "ready" }),
    destinationProjectId: "project:one",
  } as unknown as InboxEntry;
  const filingClient = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(hostileFile, { status: 201 }));
  await assert.rejects(filingClient.fileImport({
    clientOperationId: "file:hostile-webmcp",
    expectedVersion: 7,
    inboxEntryId: "inbox:webmcp-one",
    projectId: "project:one",
  }), /invalid filing response/i);
});

test("generic filing strictly binds the ordinary Inbox entry, project, and canonical paper", async () => {
  const client = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(fileImportResponse(), { status: 201 }));
  const result = await client.fileImport({
    clientOperationId: "file:ordinary-one",
    expectedVersion: 7,
    inboxEntryId: "inbox:ordinary-one",
    projectId: "project:one",
  });
  assert.equal(result.ok && result.data.inboxEntry.sourceKind, "discover");

  const open = fileImportResponse();
  (open.data as unknown as Record<string, unknown>).proposalDigest = proposalDigest;
  const rejectingClient = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(open, { status: 201 }));
  await assert.rejects(rejectingClient.fileImport({
    clientOperationId: "file:ordinary-open",
    expectedVersion: 7,
    inboxEntryId: "inbox:ordinary-one",
    projectId: "project:one",
  }), /invalid filing response/i);
});

test("prepareWebMcpApprovalChallenge posts exact schema-v1 intent without an idempotency key", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new HttpWorkspaceClient("workspace/one", async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json(openAlexChallengeResponse(), { status: 201 });
  });
  const command = {
    schemaVersion: 1 as const,
    expectedVersion: 7,
    inboxEntryId: "inbox:webmcp-one",
    proposalDigest,
    destinationProjectId: "project:one",
    duplicateDecision: { kind: "create_new" as const },
  };

  const result = await client.prepareWebMcpApprovalChallenge(command);

  assert.equal(result.ok, true);
  assert.equal(requestedUrl,
    "/api/workspaces/workspace%2Fone/integrations/webmcp/proposals/inbox%3Awebmcp-one/approval-challenges");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(requestedInit?.credentials, "same-origin");
  assert.equal(new Headers(requestedInit?.headers).has("Idempotency-Key"), false);
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    schemaVersion: 1,
    expectedVersion: command.expectedVersion,
    inboxEntryId: command.inboxEntryId,
    proposalDigest: command.proposalDigest,
    destinationProjectId: command.destinationProjectId,
    duplicateDecision: command.duplicateDecision,
  });
});

test("preparation decoder accepts only a closed authority dossier bound to the exact intent", async (context) => {
  const command = {
    schemaVersion: 1 as const,
    expectedVersion: 7,
    inboxEntryId: "inbox:webmcp-one",
    proposalDigest,
    destinationProjectId: "project:one",
    duplicateDecision: { kind: "create_new" as const },
  };
  assert.ok(await parsePrepareWebMcpApprovalChallengeResponse(
    openAlexChallengeResponse(),
    command,
  ));

  const cases: Array<[string, (payload: ReturnType<typeof openAlexChallengeResponse>) => void]> = [
    ["open challenge shape", (payload) => {
      (payload.data.challenge as Record<string, unknown>).providerToken = "secret";
    }],
    ["noncanonical expiry", (payload) => {
      payload.data.challenge.expiresAt = "2026-08-29T12:05:00Z";
    }],
    ["intent drift", (payload) => {
      payload.data.challenge.destinationProjectId = "project:other";
    }],
    ["outer evidence digest drift", (payload) => {
      payload.data.challenge.evidence.evidenceDigest = "d".repeat(64);
    }],
    ["authority drift", (payload) => {
      payload.data.challenge.evidence.authority = "HUMAN_REVIEW";
    }],
    ["open verified snapshot", (payload) => {
      (payload.data.challenge.evidence.verifiedSnapshot as Record<string, unknown>)
        .providerResponse = "unreviewed";
    }],
    ["OpenAlex work normalization drift", (payload) => {
      payload.data.challenge.evidence.verifiedSnapshot.paper.identifiers[1]!.normalizedValue
        = "W2741809807";
    }],
    ["snapshot content changed without a new digest", (payload) => {
      payload.data.challenge.evidence.verifiedSnapshot.paper.title = "Altered after verification";
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const payload = structuredClone(openAlexChallengeResponse());
      mutate(payload);
      assert.equal(await parsePrepareWebMcpApprovalChallengeResponse(payload, command), null);
    });
  }
});

test("preparation decoder admits the two non-provider authority variants without opening their shapes", async () => {
  const createCommand = {
    schemaVersion: 1 as const,
    expectedVersion: 7,
    inboxEntryId: "inbox:webmcp-one",
    proposalDigest,
    destinationProjectId: "project:one",
    duplicateDecision: { kind: "create_new" as const },
  };
  const human = openAlexChallengeResponse();
  const humanEvidence = {
    schemaVersion: 1,
    kind: "human_review_identifier_free",
    authority: "HUMAN_REVIEW",
    authorityVersion: "human-review-v1",
    proposalDigest,
  };
  const humanEvidenceDigest = evidenceDigest(humanEvidence);
  human.data.challenge.evidence = {
    authority: "HUMAN_REVIEW",
    authorityVersion: "human-review-v1",
    evidenceDigest: humanEvidenceDigest,
    verifiedSnapshot: {
      ...humanEvidence,
      evidenceDigest: humanEvidenceDigest,
    },
  } as unknown as typeof human.data.challenge.evidence;
  assert.ok(await parsePrepareWebMcpApprovalChallengeResponse(human, createCommand));

  const existingCommand = {
    ...createCommand,
    duplicateDecision: {
      kind: "use_existing" as const,
      canonicalPaperId: "paper:canonical",
    },
  };
  const existing = openAlexChallengeResponse();
  existing.data.challenge.duplicateDecision = existingCommand.duplicateDecision;
  const existingEvidence = {
    schemaVersion: 1,
    kind: "existing_canonical",
    authority: "EXISTING_CANONICAL",
    authorityVersion: "existing-canonical-v1",
    proposalDigest,
    canonicalPaperId: "paper:canonical",
  };
  const existingEvidenceDigest = evidenceDigest(existingEvidence);
  existing.data.challenge.evidence = {
    authority: "EXISTING_CANONICAL",
    authorityVersion: "existing-canonical-v1",
    evidenceDigest: existingEvidenceDigest,
    verifiedSnapshot: {
      ...existingEvidence,
      evidenceDigest: existingEvidenceDigest,
    },
  } as unknown as typeof existing.data.challenge.evidence;
  assert.ok(await parsePrepareWebMcpApprovalChallengeResponse(existing, existingCommand));
});

test("preparation rejects a closed failure transported with the wrong HTTP status", async () => {
  const client = new HttpWorkspaceClient("workspace:one", async () => Response.json({
    ok: false,
    code: "version_conflict",
    aggregateVersion: 8,
    message: "Refresh before preparing evidence.",
  }, { status: 400 }));
  await assert.rejects(client.prepareWebMcpApprovalChallenge({
    schemaVersion: 1,
    expectedVersion: 7,
    inboxEntryId: "inbox:webmcp-one",
    proposalDigest,
    destinationProjectId: "project:one",
    duplicateDecision: { kind: "create_new" },
  }), /could not prepare WebMCP authority evidence/i);
});

test("approveWebMcpProposal sends the frozen schema-v2 bytes and strictly decodes success", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new HttpWorkspaceClient("workspace/one", async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json(approvalResponse(), { status: 201 });
  });
  const submission = approvalSubmission({ operationId: "approve:webmcp-one" });

  const result = await client.approveWebMcpProposal(submission);

  assert.equal(result.ok, true);
  assert.equal(requestedUrl,
    "/api/workspaces/workspace%2Fone/integrations/webmcp/proposals/inbox%3Awebmcp-one/approval");
  assert.equal(new Headers(requestedInit?.headers).get("Idempotency-Key"),
    submission.command.clientOperationId);
  assert.equal(requestedInit?.body, submission.serializedBody);
  assert.deepEqual(JSON.parse(submission.serializedBody), submission.command);
});

test("unknown-outcome retry preserves the operation ID and entire schema-v2 body byte-for-byte", async () => {
  const bodies: BodyInit[] = [];
  const operationKeys: Array<string | null> = [];
  let attempt = 0;
  const client = new HttpWorkspaceClient(
    "workspace:one",
    async (_input, init) => {
      attempt += 1;
      bodies.push(init!.body!);
      operationKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
      if (attempt === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      const replay = approvalResponse();
      replay.outcome = "replayed";
      return Response.json(replay, { status: 200 });
    },
    undefined,
    5,
  );
  const submission = approvalSubmission({ operationId: "approval:unknown-retry" });

  await assert.rejects(client.approveWebMcpProposal(submission),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
  const result = await client.approveWebMcpProposal(submission);

  assert.equal(result.ok && result.outcome, "replayed");
  assert.deepEqual(operationKeys, [
    submission.command.clientOperationId,
    submission.command.clientOperationId,
  ]);
  assert.equal(bodies[0], submission.serializedBody);
  assert.equal(bodies[1], submission.serializedBody);
  assert.equal(bodies[0], bodies[1]);
});

test("frozen approval submission rejects open commands and body reconstruction drift", async () => {
  const open = {
    ...approvalSubmission().command,
    injectedAuthority: "browser-claim",
  };
  assert.throws(
    () => freezeWebMcpApprovalSubmission(open as unknown as ApproveWebMcpProposalCommand),
    /exact schema-v2/i,
  );

  const submission = approvalSubmission();
  const client = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(approvalResponse(), { status: 201 }));
  await assert.rejects(client.approveWebMcpProposal({
    ...submission,
    serializedBody: `${submission.serializedBody} `,
  }), /does not match its exact command/i);
});

test("approveWebMcpProposal binds use-existing approval to the selected canonical paper", async () => {
  const client = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(approvalResponse("use_existing"), { status: 201 }));
  const result = await client.approveWebMcpProposal(approvalSubmission({
    operationId: "approve:webmcp-existing",
    decision: { kind: "use_existing", canonicalPaperId: "paper:canonical" },
  }));
  assert.equal(result.ok && result.data.usedExistingPaper, true);

  const drifted = approvalResponse("use_existing");
  drifted.data.approval.canonicalPaperId = "paper:other";
  const rejectingClient = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(drifted, { status: 201 }));
  await assert.rejects(
    rejectingClient.approveWebMcpProposal(approvalSubmission({
      operationId: "approve:webmcp-existing-drift",
      decision: { kind: "use_existing", canonicalPaperId: "paper:canonical" },
    })),
    /invalid WebMCP approval response/i,
  );
});

test("approval decisions are inseparable from the returned duplicate authority", async (context) => {
  const createWithDuplicate = approvalResponse();
  const duplicateEntry = webMcpEntryFixture({ duplicate: true, status: "ready" });
  createWithDuplicate.data.inboxEntry.duplicateOfPaperId = duplicateEntry.duplicateOfPaperId;
  createWithDuplicate.data.inboxEntry.duplicateCandidate = duplicateEntry.duplicateCandidate;

  const useWithoutCandidate = approvalResponse("use_existing");
  delete useWithoutCandidate.data.inboxEntry.duplicateCandidate;

  const useWithCandidateDrift = approvalResponse("use_existing");
  useWithCandidateDrift.data.inboxEntry.duplicateCandidate!.title = "Different canonical metadata";

  const useWithDuplicateIdDrift = approvalResponse("use_existing");
  useWithDuplicateIdDrift.data.inboxEntry.duplicateOfPaperId = "paper:other";
  useWithDuplicateIdDrift.data.inboxEntry.duplicateCandidate!.id = "paper:other";

  const cases = [
    ["create-new response retains a duplicate", createWithDuplicate, { kind: "create_new" as const }],
    ["use-existing response omits the candidate", useWithoutCandidate, {
      kind: "use_existing" as const,
      canonicalPaperId: "paper:canonical",
    }],
    ["use-existing candidate metadata drifts", useWithCandidateDrift, {
      kind: "use_existing" as const,
      canonicalPaperId: "paper:canonical",
    }],
    ["use-existing duplicate ID drifts", useWithDuplicateIdDrift, {
      kind: "use_existing" as const,
      canonicalPaperId: "paper:canonical",
    }],
  ] as const;
  for (const [name, payload, duplicateDecision] of cases) {
    await context.test(name, async () => {
      const client = new HttpWorkspaceClient("workspace:one", async () =>
        Response.json(payload, { status: 201 }));
      await assert.rejects(client.approveWebMcpProposal(approvalSubmission({
        operationId: `approval:${name.replaceAll(" ", "-")}`,
        decision: duplicateDecision,
      })), /invalid WebMCP approval response/i);
    });
  }
});

test("create-new approval closes the staged, verified, and canonical OpenAlex identifier sets", async (context) => {
  const identifierFree = approvalResponse();
  identifierFree.data.inboxEntry.paper.identifiers = [];
  identifierFree.data.paper.identifiers = [];
  identifierFree.data.approval.verifiedIdentifiers = [];
  const identifierFreeClient = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(identifierFree, { status: 201 }));
  assert.equal((await identifierFreeClient.approveWebMcpProposal(approvalSubmission({
    operationId: "approval:identifier-free",
  }))).ok, true);

  const providerClaim = approvalResponse();
  providerClaim.data.inboxEntry.paper.identifiers = [{
    scheme: "provider",
    value: "https://openalex.org/W2741809807",
  }];
  const providerClaimClient = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(providerClaim, { status: 201 }));
  assert.equal((await providerClaimClient.approveWebMcpProposal(approvalSubmission({
    operationId: "approval:provider-claim",
  }))).ok, true);

  const cases: Array<[string, (payload: ReturnType<typeof approvalResponse>) => void]> = [
    ["identifier-free proposal receives identifiers", (payload) => {
      payload.data.inboxEntry.paper.identifiers = [];
    }],
    ["unsupported-only proposal receives identifiers", (payload) => {
      payload.data.inboxEntry.paper.identifiers = [{ scheme: "arxiv", value: "2608.00001" }];
    }],
    ["verified OpenAlex work is missing", (payload) => {
      payload.data.approval.verifiedIdentifiers = payload.data.approval.verifiedIdentifiers
        .filter((identifier) => identifier.scheme !== "provider");
      payload.data.paper.identifiers = payload.data.paper.identifiers
        .filter((identifier) => identifier.scheme !== "provider");
    }],
    ["multiple OpenAlex works are returned", (payload) => {
      payload.data.approval.verifiedIdentifiers.push({
        scheme: "provider",
        value: "openalex:W999",
        authority: "openalex",
        evidenceDigest: verificationDigest,
      });
      payload.data.paper.identifiers.push({ scheme: "provider", value: "openalex:W999" });
    }],
    ["OpenAlex work uses a noncanonical form", (payload) => {
      payload.data.approval.verifiedIdentifiers[1]!.value = "openalex:w2741809807";
      payload.data.paper.identifiers[1]!.value = "openalex:w2741809807";
    }],
    ["staged DOI disagrees", (payload) => {
      payload.data.inboxEntry.paper.identifiers = [{ scheme: "doi", value: "10.5555/other" }];
    }],
    ["staged OpenAlex work disagrees", (payload) => {
      payload.data.inboxEntry.paper.identifiers = [{ scheme: "provider", value: "openalex:W999" }];
    }],
    ["verification evidence digests disagree", (payload) => {
      payload.data.approval.verifiedIdentifiers[1]!.evidenceDigest = "c".repeat(64);
    }],
    ["canonical identifier set has an extra assertion", (payload) => {
      payload.data.paper.identifiers.push({ scheme: "arxiv", value: "2608.00001" });
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const payload = approvalResponse();
      mutate(payload);
      const client = new HttpWorkspaceClient("workspace:one", async () =>
        Response.json(payload, { status: 201 }));
      await assert.rejects(client.approveWebMcpProposal(approvalSubmission({
        operationId: `identifier:${name.replaceAll(" ", "-")}`,
      })), /invalid WebMCP approval response/i);
    });
  }
});

test("approval outcome is bound to HTTP status and the command-relative aggregate version", async (context) => {
  const invalidCases: Array<[
    string,
    number,
    (payload: ReturnType<typeof approvalResponse>) => void,
  ]> = [
    ["applied over 200", 200, () => {}],
    ["applied skips a version", 201, (payload) => { payload.aggregateVersion = 9; }],
    ["replayed over 201", 201, (payload) => { payload.outcome = "replayed"; }],
    ["replayed predates application", 200, (payload) => {
      payload.outcome = "replayed";
      payload.aggregateVersion = 7;
    }],
  ];
  for (const [name, status, mutate] of invalidCases) {
    await context.test(name, async () => {
      const payload = approvalResponse();
      mutate(payload);
      const client = new HttpWorkspaceClient("workspace:one", async () =>
        Response.json(payload, { status }));
      await assert.rejects(client.approveWebMcpProposal(approvalSubmission({
        operationId: `transport:${name.replaceAll(" ", "-")}`,
      })), /invalid WebMCP approval response/i);
    });
  }

  const replay = approvalResponse();
  replay.outcome = "replayed";
  replay.aggregateVersion = 11;
  const replayClient = new HttpWorkspaceClient("workspace:one", async () =>
    Response.json(replay, { status: 200 }));
  const replayed = await replayClient.approveWebMcpProposal(approvalSubmission({
    operationId: "transport:valid-replay",
  }));
  assert.equal(replayed.ok && replayed.outcome, "replayed");
});

test("approval fetch aborts after a bounded deadline with an unknown outcome", async () => {
  let observedSignal: AbortSignal | null | undefined;
  const client = new HttpWorkspaceClient(
    "workspace:one",
    async (_input, init) => {
      observedSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new DOMException(
          "The request was aborted.",
          "AbortError",
        )), {
          once: true,
        });
      });
    },
    undefined,
    5,
  );
  const operationId = "approval:timeout";
  await assert.rejects(client.approveWebMcpProposal(approvalSubmission({ operationId })),
    (error: unknown) => error instanceof DOMException
    && error.name === "TimeoutError"
    && error.message.includes(operationId)
    && /same operation key/i.test(error.message));
  assert.equal(observedSignal?.aborted, true);
});

test("approval deadline remains active when headers arrive but the JSON body stalls", async () => {
  let observedSignal: AbortSignal | null | undefined;
  const operationId = "approval:stalled-body";
  const client = new HttpWorkspaceClient(
    "workspace:one",
    async (_input, init) => {
      observedSignal = init?.signal;
      return {
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => await new Promise<unknown>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
            once: true,
          });
        }),
      } as Response;
    },
    undefined,
    5,
  );
  await assert.rejects(client.approveWebMcpProposal(approvalSubmission({ operationId })),
    (error: unknown) => error instanceof DOMException
    && error.name === "TimeoutError"
    && error.message.includes(operationId));
  assert.equal(observedSignal?.aborted, true);
});

test("approveWebMcpProposal rejects malformed, open, and incoherent success payloads", async (context) => {
  const cases: Array<[string, (payload: ReturnType<typeof approvalResponse>) => void]> = [
    ["open approval shape", (payload) => {
      (payload.data.approval as Record<string, unknown>).approvedById = "private:user";
    }],
    ["missing challenge binding", (payload) => {
      delete (payload.data.approval as Partial<typeof payload.data.approval>).challengeId;
    }],
    ["challenge binding drift", (payload) => {
      payload.data.approval.challengeId = "D".repeat(43);
    }],
    ["evidence binding drift", (payload) => {
      payload.data.approval.evidenceDigest = "d".repeat(64);
      for (const identifier of payload.data.approval.verifiedIdentifiers) {
        identifier.evidenceDigest = "d".repeat(64);
      }
    }],
    ["unsupported no-op outcome", (payload) => { payload.outcome = "noop"; }],
    ["digest drift", (payload) => { payload.data.inboxEntry.proposalDigest = "d".repeat(64); }],
    ["custody overstatement", (payload) => {
      payload.data.inboxEntry.paper.access!.hasFullText = true;
    }],
    ["unverified canonical identifier", (payload) => {
      payload.data.approval.verifiedIdentifiers = [];
    }],
    ["untrusted verification authority", (payload) => {
      payload.data.approval.verifiedIdentifiers[0]!.authority = "human_review";
    }],
    ["project filing drift", (payload) => { payload.data.project.paperIds = []; }],
    ["canonical paper drift", (payload) => { payload.data.paper.id = "paper:other"; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const payload = approvalResponse();
      mutate(payload);
      const client = new HttpWorkspaceClient("workspace:one", async () =>
        Response.json(payload, { status: 201 }));
      await assert.rejects(
        client.approveWebMcpProposal(approvalSubmission({
          operationId: `approval:${name.replaceAll(" ", "-")}`,
        })),
        /invalid WebMCP approval response/i,
      );
    });
  }
});

test("approveWebMcpProposal accepts a closed workspace failure without trusting extra fields", async () => {
  const client = new HttpWorkspaceClient("workspace:one", async () => Response.json({
    ok: false,
    code: "version_conflict",
    aggregateVersion: 9,
    message: "Refresh before approving this proposal.",
  }, { status: 409 }));
  assert.deepEqual(await client.approveWebMcpProposal(approvalSubmission({
    operationId: "approval:stale",
  })), {
    ok: false,
    code: "version_conflict",
    aggregateVersion: 9,
    message: "Refresh before approving this proposal.",
  });
});

test("approval rejects a failure body transported as HTTP success", async () => {
  const client = new HttpWorkspaceClient("workspace:one", async () => Response.json({
    ok: false,
    code: "version_conflict",
    aggregateVersion: 9,
    message: "Refresh before approving this proposal.",
  }, { status: 200 }));
  await assert.rejects(client.approveWebMcpProposal(approvalSubmission({
    operationId: "approval:false-success",
  })), /invalid WebMCP approval response/i);
});

test("createUploadSession uses the versioned JSON reservation endpoint", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new HttpWorkspaceClient("workspace/one", async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json({
      ok: true,
      outcome: "applied",
      aggregateVersion: 8,
      data: {
        inboxEntry: {
          ...uploadStatus.inboxEntry,
          upload: { ...uploadStatus.inboxEntry.upload, stage: "awaiting-bytes" },
        },
        upload: {
          id: "upload:one",
          status: "awaiting-bytes",
          expiresAt: "2026-08-28T12:15:00.000Z",
          maxBytes: 26_214_400,
          contentUrl: "/api/workspaces/workspace%2Fone/uploads/upload%3Aone/content",
        },
      },
    }, { status: 201 });
  });
  const command = {
    clientOperationId: "upload-operation",
    expectedVersion: 7,
    fileName: "paper.pdf",
    sizeBytes: 17,
    declaredMimeType: "application/pdf" as const,
  };

  const result = await client.createUploadSession(command);

  assert.equal(result.ok, true);
  assert.equal(requestedUrl, "/api/workspaces/workspace%2Fone/uploads");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(requestedInit?.credentials, "same-origin");
  assert.equal(new Headers(requestedInit?.headers).get("Idempotency-Key"), command.clientOperationId);
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), command);
});

test("uploadContent sends the untouched File as raw PDF and reports transfer progress", async () => {
  class FakeXhr {
    method = "";
    url = "";
    async = false;
    withCredentials = false;
    responseType: XMLHttpRequestResponseType = "";
    response: unknown = uploadStatus;
    responseText = "";
    status = 202;
    sentBody?: Document | XMLHttpRequestBodyInit | null;
    readonly requestHeaders = new Headers();
    readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;

    open(method: string, url: string, async: boolean) {
      this.method = method;
      this.url = url;
      this.async = async;
    }
    setRequestHeader(name: string, value: string) {
      this.requestHeaders.set(name, value);
    }
    getResponseHeader(name: string) {
      return name.toLowerCase() === "x-request-id" ? "upload-request-1" : null;
    }
    abort() {
      this.onabort?.();
    }
    send(body?: Document | XMLHttpRequestBodyInit | null) {
      this.sentBody = body;
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: 17, total: 17, lengthComputable: true } as ProgressEvent);
        this.onload?.();
      });
    }
  }

  const xhr = new FakeXhr();
  const client = new HttpWorkspaceClient(
    "workspace/one",
    async () => { throw new Error("fetch is not used for byte transfer"); },
    () => xhr as unknown as XMLHttpRequest,
  );
  const file = new File(["%PDF-1.7\n%%EOF"], "paper.pdf", { type: "application/pdf" });
  const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];

  const result = await client.uploadContent("upload:one", file, {
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(result, uploadStatus);
  assert.equal(xhr.method, "PUT");
  assert.equal(xhr.url, "/api/workspaces/workspace%2Fone/uploads/upload%3Aone/content");
  assert.equal(xhr.async, true);
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.requestHeaders.get("Content-Type"), "application/pdf");
  assert.equal(xhr.requestHeaders.get("Accept"), "application/json");
  assert.equal(xhr.sentBody, file, "the File must not be wrapped, encoded, or converted");
  assert.deepEqual(progress, [{ loadedBytes: 17, totalBytes: 17 }]);
});

test("getUploadStatus validates the credential-free upload read model", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new HttpWorkspaceClient("workspace/one", async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Response.json(uploadStatus);
  });

  assert.deepEqual(await client.getUploadStatus("upload:one"), uploadStatus);
  assert.equal(requestedUrl, "/api/workspaces/workspace%2Fone/uploads/upload%3Aone");
  assert.equal(requestedInit?.credentials, "same-origin");
  assert.equal(requestedInit?.cache, "no-store");
});

test("getUploadStatus accepts all seven upload stages and downstream states", async () => {
  const cases = [
    {
      stage: "awaiting-bytes",
      inboxStatus: "processing",
      assetStatus: "uploading",
      documentStatus: "pending",
    },
    {
      stage: "receiving",
      inboxStatus: "processing",
      assetStatus: "uploading",
      documentStatus: "pending",
    },
    {
      stage: "quarantined",
      inboxStatus: "processing",
      assetStatus: "quarantined",
      documentStatus: "pending",
    },
    {
      stage: "validating",
      inboxStatus: "processing",
      assetStatus: "scanning",
      documentStatus: "pending",
    },
    {
      stage: "validating",
      inboxStatus: "processing",
      assetStatus: "quarantined",
      documentStatus: "processing",
    },
    {
      stage: "ready",
      inboxStatus: "ready",
      assetStatus: "ready",
      documentStatus: "ready",
    },
    {
      stage: "failed",
      inboxStatus: "blocked",
      assetStatus: "deleted",
      documentStatus: "ready",
    },
    {
      stage: "failed",
      inboxStatus: "blocked",
      assetStatus: "ready",
      documentStatus: "archived",
    },
    {
      stage: "expired",
      inboxStatus: "blocked",
      assetStatus: "uploading",
      documentStatus: "pending",
    },
  ] as const;

  for (const value of cases) {
    const response = {
      ...uploadStatus,
      inboxEntry: {
        ...uploadStatus.inboxEntry,
        status: value.inboxStatus,
        upload: { ...uploadStatus.inboxEntry.upload, stage: value.stage },
      },
      upload: { ...uploadStatus.upload, status: value.stage },
      asset: { ...uploadStatus.asset, status: value.assetStatus },
      document: { ...uploadStatus.document, status: value.documentStatus },
    };
    const client = new HttpWorkspaceClient(
      "workspace/one",
      async () => Response.json(response),
    );

    assert.deepEqual(await client.getUploadStatus("upload:one"), response);
  }
});

test("getUploadStatus keeps extraction independent from linking and derives Reader readiness", async () => {
  const extractionStages = [
    "not-started",
    "queued",
    "extracting",
    "ready",
    "no-text",
    "failed",
  ] as const;

  for (const extractionStage of extractionStages) {
    const unlinked = {
      ...uploadStatus,
      inboxEntry: {
        ...uploadStatus.inboxEntry,
        status: "ready" as const,
        upload: {
          ...uploadStatus.inboxEntry.upload,
          stage: "ready" as const,
          extractionStage,
          readerAvailable: false,
        },
      },
      upload: { ...uploadStatus.upload, status: "ready" as const },
      asset: { ...uploadStatus.asset, status: "ready" as const },
      document: { ...uploadStatus.document, status: "ready" as const },
    };
    const unlinkedClient = new HttpWorkspaceClient(
      "workspace-one",
      async () => Response.json(unlinked),
    );
    assert.deepEqual(await unlinkedClient.getUploadStatus("upload:one"), unlinked);

    const linked = {
      ...unlinked,
      inboxEntry: {
        ...unlinked.inboxEntry,
        upload: {
          ...unlinked.inboxEntry.upload,
          linkedPaperId: "paper:one",
          readerAvailable: extractionStage === "ready",
        },
      },
    };
    const linkedClient = new HttpWorkspaceClient(
      "workspace-one",
      async () => Response.json(linked),
    );
    assert.deepEqual(await linkedClient.getUploadStatus("upload:one"), linked);
  }
});

test("getUploadStatus rejects contradictory top-level and Inbox upload stages", async () => {
  const client = new HttpWorkspaceClient("workspace/one", async () => Response.json({
    ...uploadStatus,
    inboxEntry: {
      ...uploadStatus.inboxEntry,
      upload: { ...uploadStatus.inboxEntry.upload, stage: "validating" },
    },
  }));

  await assert.rejects(
    client.getUploadStatus("upload:one"),
    /could not confirm the upload state/i,
  );
});

test("getUploadStatus rejects unknown enums and impossible nonterminal combinations", async () => {
  const responses: unknown[] = [
    {
      ...uploadStatus,
      inboxEntry: {
        ...uploadStatus.inboxEntry,
        upload: { ...uploadStatus.inboxEntry.upload, stage: "scanned" },
      },
      upload: { ...uploadStatus.upload, status: "scanned" },
    },
    {
      ...uploadStatus,
      inboxEntry: {
        ...uploadStatus.inboxEntry,
        upload: { ...uploadStatus.inboxEntry.upload, stage: "scanned" },
      },
    },
    {
      ...uploadStatus,
      asset: { ...uploadStatus.asset, status: "infected" },
    },
    {
      ...uploadStatus,
      document: { ...uploadStatus.document, status: "verified" },
    },
    {
      ...uploadStatus,
      inboxEntry: {
        ...uploadStatus.inboxEntry,
        status: "ready",
        upload: { ...uploadStatus.inboxEntry.upload, stage: "ready" },
      },
      upload: { ...uploadStatus.upload, status: "ready" },
    },
    {
      ...uploadStatus,
      inboxEntry: {
        ...uploadStatus.inboxEntry,
        upload: { ...uploadStatus.inboxEntry.upload, id: "upload:other" },
      },
    },
    {
      ...uploadStatus,
      document: { ...uploadStatus.document, id: "document:other" },
    },
    {
      ...uploadStatus,
      inboxEntry: { ...uploadStatus.inboxEntry, status: "ready" },
    },
    { ...uploadStatus, asset: { ...uploadStatus.asset, sizeBytes: -1 } },
    { ...uploadStatus, asset: { ...uploadStatus.asset, sizeBytes: 1.5 } },
    { ...uploadStatus, asset: { ...uploadStatus.asset, sizeBytes: Number.MAX_SAFE_INTEGER + 1 } },
    { ...uploadStatus, asset: { ...uploadStatus.asset, sizeBytes: "17" } },
  ];

  for (const response of responses) {
    const client = new HttpWorkspaceClient(
      "workspace-one",
      async () => Response.json(response),
    );
    await assert.rejects(
      client.getUploadStatus("upload:one"),
      /could not confirm the upload state/i,
    );
  }
});
