import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentUploadFailureCode } from "@/lib/types";
import { parseWebMcpProposalCommand } from "@/server/integrations/webmcp/intake-contract";
import { webMcpProposalSnapshot } from "@/server/integrations/webmcp/intake-service";
import {
  webMcpSnapshotDigest,
  type ServerManagedWebMcpSnapshot,
} from "@/server/integrations/webmcp/snapshot-contract";
import {
  documentUploadFailure,
  documentUploadStage,
  inboxEntryDto,
} from "./import-dto";
import type {
  InboxEntryForDto,
  UploadLifecycleForDto,
} from "./import-dto";

function lifecycle(
  overrides: Partial<{
    status: UploadLifecycleForDto["status"];
    failureCode: string | null;
    assetStatus: UploadLifecycleForDto["asset"]["status"];
    assetRejectionCode: string | null;
    documentStatus: NonNullable<UploadLifecycleForDto["document"]>["status"];
    documentFailureCode: string | null;
  }> = {},
): UploadLifecycleForDto {
  return {
    status: overrides.status ?? "STORED",
    failureCode: overrides.failureCode ?? null,
    asset: {
      status: overrides.assetStatus ?? "QUARANTINED",
      rejectionCode: overrides.assetRejectionCode ?? null,
    },
    document: {
      status: overrides.documentStatus ?? "PENDING",
      failureCode: overrides.documentFailureCode ?? null,
    },
  };
}

test("document upload lifecycle exposes every supported stage without overstating custody", () => {
  const cases: Array<{
    name: string;
    upload: UploadLifecycleForDto;
    expected: ReturnType<typeof documentUploadStage>;
  }> = [
    {
      name: "issued reservation",
      upload: lifecycle({ status: "ISSUED", assetStatus: "UPLOADING" }),
      expected: "awaiting-bytes",
    },
    {
      name: "active transfer",
      upload: lifecycle({ status: "RECEIVING", assetStatus: "UPLOADING" }),
      expected: "receiving",
    },
    {
      name: "stored quarantine",
      upload: lifecycle(),
      expected: "quarantined",
    },
    {
      name: "asset scan",
      upload: lifecycle({ assetStatus: "SCANNING" }),
      expected: "validating",
    },
    {
      name: "document processing",
      upload: lifecycle({ documentStatus: "PROCESSING" }),
      expected: "validating",
    },
    {
      name: "verified asset and document",
      upload: lifecycle({ assetStatus: "READY", documentStatus: "READY" }),
      expected: "ready",
    },
    {
      name: "rejected asset",
      upload: lifecycle({ assetStatus: "REJECTED", assetRejectionCode: "malware_detected" }),
      expected: "failed",
    },
    {
      name: "expired reservation",
      upload: lifecycle({ status: "EXPIRED", assetStatus: "UPLOADING" }),
      expected: "expired",
    },
  ];

  for (const value of cases) {
    assert.equal(documentUploadStage(value.upload), value.expected, value.name);
  }
});

test("document upload lifecycle fails closed for contradictory or one-sided ready state", () => {
  const cases = [
    lifecycle({ status: "ISSUED", assetStatus: "READY", documentStatus: "READY" }),
    lifecycle({ status: "RECEIVING", assetStatus: "SCANNING", documentStatus: "PROCESSING" }),
    lifecycle({ assetStatus: "READY", documentStatus: "PENDING" }),
    lifecycle({ assetStatus: "QUARANTINED", documentStatus: "READY" }),
    lifecycle({ assetStatus: "UPLOADING", documentStatus: "PENDING" }),
  ];

  for (const upload of cases) {
    assert.equal(documentUploadStage(upload), "failed");
  }
});

test("document upload failures collapse internal outcomes to fixed public messages", () => {
  const cases: Array<{
    raw: string;
    expected: DocumentUploadFailureCode;
    retryable: boolean;
  }> = [
    { raw: "upload_timed_out", expected: "upload_timed_out", retryable: true },
    { raw: "receive_lease_expired", expected: "upload_timed_out", retryable: true },
    { raw: "malware_detected", expected: "malware_detected", retryable: false },
    { raw: "malware_and_pdf_invalid", expected: "malware_detected", retryable: false },
    { raw: "pdf_invalid", expected: "invalid_pdf_structure", retryable: false },
    { raw: "pdf_policy_violation", expected: "invalid_pdf_structure", retryable: false },
    { raw: "content_hash_mismatch", expected: "integrity_check_failed", retryable: false },
    { raw: "quarantine_object_missing", expected: "integrity_check_failed", retryable: false },
    { raw: "quarantine_object_changed", expected: "integrity_check_failed", retryable: false },
    { raw: "validation_timeout", expected: "validation_unavailable", retryable: true },
    { raw: "validation_service_timeout", expected: "validation_unavailable", retryable: true },
    { raw: "validation_service_signatures_stale", expected: "validation_unavailable", retryable: true },
    { raw: "validation_service_clock_invalid", expected: "validation_unavailable", retryable: true },
    { raw: "validation_dead_letter", expected: "validation_unavailable", retryable: true },
    { raw: "validation_service_content_mismatch", expected: "integrity_check_failed", retryable: false },
    { raw: "validation_service_storage_mismatch", expected: "integrity_check_failed", retryable: false },
    { raw: "validation_input_changed", expected: "integrity_check_failed", retryable: false },
    { raw: "validation_service_invalid_response", expected: "validation_failed", retryable: false },
    { raw: "validation_service_policy_mismatch", expected: "validation_failed", retryable: false },
    { raw: "validation_worker_internal", expected: "validation_unavailable", retryable: true },
  ];

  for (const value of cases) {
    const upload = lifecycle({
      assetStatus: "REJECTED",
      documentStatus: "FAILED",
      documentFailureCode: value.raw,
    });
    const failure = documentUploadFailure(upload);
    assert.equal(failure?.code, value.expected, value.raw);
    assert.equal(failure?.retryable, value.retryable, value.raw);
    assert.ok(failure?.message.length, value.raw);
    assert.equal(failure?.message.includes(value.raw), false, value.raw);
  }

  const unknown = documentUploadFailure(lifecycle({
    assetStatus: "REJECTED",
    documentStatus: "FAILED",
    failureCode: "scanner stderr: /private/bucket/object sha256=secret worker=worker-17",
  }));
  assert.deepEqual(unknown, {
    code: "validation_failed",
    message: "This file could not be verified and remains unavailable.",
    retryable: false,
  });

  const recognizedLowerPriority = documentUploadFailure(lifecycle({
    assetStatus: "REJECTED",
    assetRejectionCode: "malware_detected",
    documentStatus: "FAILED",
    failureCode: `${"x".repeat(1_000)}\u0000raw scanner output`,
  }));
  assert.equal(recognizedLowerPriority?.code, "malware_detected");

  const staleReadyFailure = documentUploadFailure(lifecycle({
    assetStatus: "READY",
    documentStatus: "READY",
    failureCode: "validation_timeout",
    documentFailureCode: "pdf_invalid",
  }));
  assert.equal(staleReadyFailure, undefined);
});

function uploadInboxFixture(upload: UploadLifecycleForDto): InboxEntryForDto {
  const createdAt = new Date("2026-08-28T12:00:00.000Z");
  return {
    id: "inbox-one",
    organizationId: "organization-one",
    importBatchId: null,
    projectId: null,
    workspacePaperId: null,
    documentId: "document-one",
    source: "FILE_UPLOAD",
    sourceKey: "upload-one",
    dedupeKey: "upload-one",
    status: "PENDING",
    proposedTitle: null,
    proposedYear: null,
    sourceUri: null,
    payload: null,
    failureCode: null,
    failureMessage: "raw scanner output at /private/bucket/object",
    createdById: "user-one",
    createdByPrincipalId: null,
    resolvedAt: null,
    createdAt,
    updatedAt: createdAt,
    provenanceRecords: [],
    uploadSession: {
      ...upload,
      id: "upload-one",
      originalFileName: "paper.pdf",
      declaredMimeType: "application/pdf",
      expectedSizeBytes: 17n,
      receivedSizeBytes: 17n,
      expiresAt: new Date("2026-08-28T12:15:00.000Z"),
      documentId: "document-one",
    },
  };
}

function crawlerInboxFixture(
  importStatus: "QUEUED" | "FETCHING" | "QUARANTINED" | "VALIDATING"
    | "EXTRACTING" | "READY" | "ATTENTION" | "FAILED" | "CANCELLED",
): InboxEntryForDto {
  const createdAt = new Date("2026-08-28T12:00:00.000Z");
  const phase = importStatus === "QUEUED" || importStatus === "FETCHING"
    ? "fetch"
    : importStatus === "QUARANTINED" || importStatus === "VALIDATING"
      ? "validation"
      : importStatus === "EXTRACTING"
        ? "extraction"
        : importStatus === "READY"
          ? "ready"
          : importStatus === "ATTENTION"
            ? "attention"
            : "failed";
  return {
    id: "crawler-inbox-one",
    organizationId: "organization-one",
    importBatchId: "crawler-batch-one",
    projectId: null,
    workspacePaperId: null,
    documentId: "crawler-document-one",
    source: "CRAWLER",
    sourceKey: "crawler-import:crawler-one",
    dedupeKey: "crawler-import:crawler-one",
    status: importStatus === "FAILED" || importStatus === "CANCELLED"
      ? "FAILED"
      : "NEEDS_REVIEW",
    proposedTitle: "governed-paper.pdf",
    proposedYear: null,
    sourceUri: "https://private.example.test/governed-paper.pdf",
    payload: {
      schemaVersion: 1,
      kind: "governed-crawler-import",
      crawlerImportId: "crawler-one",
      importStatus,
      phase,
    },
    failureCode: importStatus === "FAILED" ? "internal_worker_detail" : null,
    failureMessage: "worker=secret storage=/private/bucket sha256=secret",
    createdById: "user-one",
    createdByPrincipalId: "00000000-0000-0000-0000-000000000001",
    resolvedAt: null,
    createdAt,
    updatedAt: createdAt,
    provenanceRecords: [],
    crawlerImport: {
      id: "crawler-one",
      status: importStatus,
      displayFileName: "governed-paper.pdf",
      documentId: "crawler-document-one",
      failureCode: importStatus === "FAILED" ? "internal_worker_detail" : null,
    },
    document: {
      status: importStatus === "EXTRACTING" || importStatus === "READY" || importStatus === "ATTENTION"
        ? "READY"
        : importStatus === "FAILED"
          ? "FAILED"
          : importStatus === "VALIDATING"
            ? "PROCESSING"
            : "PENDING",
      failureCode: importStatus === "FAILED" ? "internal_worker_detail" : null,
      paperId: null,
      workspacePaperId: null,
    },
  };
}

function webMcpInboxFixture(): InboxEntryForDto {
  const createdAt = new Date("2026-08-28T12:00:00.000Z");
  const snapshot = webMcpProposalSnapshot(parseWebMcpProposalCommand({
    schemaVersion: 1,
    clientOperationId: "webmcp-dto-operation",
    expectedVersion: 3,
    proposal: {
      title: "Reviewable research-agent metadata",
      authors: ["Ada Evidence"],
      year: 2026,
      venue: "Journal of Verifiable Research",
      publicationType: "journal article",
      abstract: "Metadata remains distinct from document custody.",
      identifiers: [{ scheme: "doi", value: "10.5555/webmcp.dto" }],
      sourcePageUrl: "https://repository.example.org/papers/webmcp-dto",
      candidatePdfUrl: "https://repository.example.org/papers/webmcp-dto.pdf",
      isOpenAccess: true,
      license: "CC-BY-4.0",
      version: "published-version",
    },
  }), createdAt);
  return {
    id: "webmcp-inbox-one",
    organizationId: "organization-one",
    importBatchId: null,
    projectId: null,
    workspacePaperId: "workspace-paper-one",
    documentId: null,
    source: "WEB_MCP",
    sourceKey: "webmcp-source-one",
    dedupeKey: "webmcp-source-one",
    status: "DUPLICATE",
    proposedTitle: snapshot.paper.title,
    proposedYear: snapshot.paper.year ?? null,
    sourceUri: snapshot.paper.sourceUrl ?? null,
    payload: JSON.parse(JSON.stringify(snapshot)),
    failureCode: null,
    failureMessage: null,
    createdById: "user-one",
    createdByPrincipalId: null,
    resolvedAt: null,
    createdAt,
    updatedAt: createdAt,
    provenanceRecords: [{
      kind: "WEB_MCP",
      paperId: "canonical-paper-one",
      paper: {
        id: "canonical-paper-one",
        title: "Canonical reviewable research-agent metadata",
        publicationYear: 2025,
        venueName: "Trusted Metadata Journal",
        workType: "review",
        authors: [
          { position: 1, displayName: "Linus Provenance" },
          { position: 0, displayName: "Ada Evidence" },
        ],
        identifiers: [
          { type: "OPENALEX", value: "W123456789" },
          { type: "DOI", value: "10.5555/canonical.dto" },
        ],
      },
    }],
  };
}

test("WebMCP Inbox DTO uses database source authority and preserves metadata-only custody", () => {
  const fixture = webMcpInboxFixture();
  const dto = inboxEntryDto(fixture);
  assert.ok(dto && dto.entryKind === "paper");
  assert.equal(dto.sourceKind, "webmcp");
  assert.equal(dto.status, "possible-duplicate");
  assert.equal(dto.duplicateOfPaperId, "canonical-paper-one");
  assert.ok("proposalDigest" in dto);
  assert.equal(
    dto.proposalDigest,
    webMcpSnapshotDigest(fixture.payload as unknown as ServerManagedWebMcpSnapshot),
  );
  assert.deepEqual(dto.duplicateCandidate, {
    id: "canonical-paper-one",
    title: "Canonical reviewable research-agent metadata",
    authors: ["Ada Evidence", "Linus Provenance"],
    year: 2025,
    venue: "Trusted Metadata Journal",
    type: "review",
    identifiers: [
      { scheme: "provider", value: "openalex:W123456789" },
      { scheme: "doi", value: "10.5555/canonical.dto" },
    ],
  });
  assert.equal(Object.hasOwn(dto.duplicateCandidate ?? {}, "access"), false);
  assert.equal(dto.provenance.accessMethod, "webmcp");
  assert.equal(dto.paper.access?.hasFullText, false);
  assert.equal(dto.paper.access?.pdfUrl, "https://repository.example.org/papers/webmcp-dto.pdf");
});

test("WebMCP Inbox DTO keeps the retained unversioned v1 payload readable", () => {
  const fixture = webMcpInboxFixture();
  const historicalPayload = JSON.parse(JSON.stringify(fixture.payload));
  delete historicalPayload.schemaVersion;
  fixture.payload = historicalPayload;

  const dto = inboxEntryDto(fixture);
  assert.ok(dto && dto.entryKind === "paper" && dto.sourceKind === "webmcp");
  assert.equal(
    dto.proposalDigest,
    webMcpSnapshotDigest(
      historicalPayload as unknown as ServerManagedWebMcpSnapshot,
    ),
  );
  assert.equal(dto.paper.title, "Reviewable research-agent metadata");
  assert.equal(dto.paper.access?.hasFullText, false);
});

test("WebMCP Inbox DTO fails closed when stored source or custody authority drifts", () => {
  const custodyDrift = webMcpInboxFixture();
  const custodyPayload = JSON.parse(JSON.stringify(custodyDrift.payload));
  custodyPayload.paper.access.hasFullText = true;
  custodyDrift.payload = custodyPayload;
  assert.equal(inboxEntryDto(custodyDrift), null);

  const provenanceDrift = webMcpInboxFixture();
  const provenancePayload = JSON.parse(JSON.stringify(provenanceDrift.payload));
  provenancePayload.provenance.accessMethod = "upload";
  provenanceDrift.payload = provenancePayload;
  assert.equal(inboxEntryDto(provenanceDrift), null);

  const openShapeDrift = webMcpInboxFixture();
  const openPayload = JSON.parse(JSON.stringify(openShapeDrift.payload));
  openPayload.paper.storageKey = "private/object.pdf";
  openShapeDrift.payload = openPayload;
  assert.equal(inboxEntryDto(openShapeDrift), null);
});

test("ready uploads stay document-only in the Inbox bootstrap DTO", () => {
  const dto = inboxEntryDto(uploadInboxFixture(lifecycle({
    assetStatus: "READY",
    documentStatus: "READY",
  })));

  assert.ok(dto && dto.entryKind === "document-upload");
  assert.equal(dto.status, "ready");
  assert.equal(dto.upload.stage, "ready");
  assert.equal(dto.upload.extractionStage, "not-started");
  assert.equal(dto.upload.readerAvailable, false);
  assert.equal(dto.upload.linkedPaperId, undefined);
  assert.equal(dto.upload.documentId, "document-one");
  assert.equal(Object.hasOwn(dto, "paper"), false);
  assert.equal(Object.hasOwn(dto, "destinationProjectId"), false);
  assert.equal(Object.hasOwn(dto, "failure"), false);
});

test("upload Inbox DTO exposes paper links and readiness only from Reader authority", () => {
  const upload = lifecycle({
    assetStatus: "READY",
    documentStatus: "READY",
  });
  assert.ok(upload.document);
  upload.document.paperId = "paper-one";
  upload.document.workspacePaperId = "workspace-paper-one";

  const withoutAuthority = inboxEntryDto(uploadInboxFixture(upload));
  assert.ok(withoutAuthority && withoutAuthority.entryKind === "document-upload");
  assert.equal(withoutAuthority.upload.linkedPaperId, undefined);
  assert.equal(withoutAuthority.upload.extractionStage, "not-started");
  assert.equal(withoutAuthority.upload.readerAvailable, false);

  const dto = inboxEntryDto(
    uploadInboxFixture(upload),
    {
      paperId: "paper-one",
      documentId: "document-one",
      state: "ready",
    },
    { documentId: "document-one", state: "failed" },
  );
  assert.ok(dto && dto.entryKind === "document-upload");
  assert.equal(dto.upload.linkedPaperId, "paper-one");
  assert.equal(dto.upload.extractionStage, "ready");
  assert.equal(dto.upload.readerAvailable, true);

  upload.document.paperId = null;
  upload.document.workspacePaperId = null;
  const unlinked = inboxEntryDto(uploadInboxFixture(upload), {
    paperId: "paper-one",
    documentId: "document-one",
    state: "ready",
  });
  assert.ok(unlinked && unlinked.entryKind === "document-upload");
  assert.equal(unlinked.upload.linkedPaperId, undefined);
  assert.equal(unlinked.upload.extractionStage, "not-started");
  assert.equal(unlinked.upload.readerAvailable, false);
});

test("unlinked uploads preserve authoritative independent extraction lifecycle", () => {
  const cases = [
    { state: "unavailable" as const, expected: "failed" },
    { state: "not-started" as const, expected: "not-started" },
    { state: "queued" as const, expected: "queued" },
    { state: "extracting" as const, expected: "extracting" },
    { state: "ready" as const, expected: "ready" },
    { state: "no-text" as const, expected: "no-text" },
    { state: "failed" as const, expected: "failed" },
  ];
  for (const value of cases) {
    const dto = inboxEntryDto(
      uploadInboxFixture(lifecycle({ assetStatus: "READY", documentStatus: "READY" })),
      undefined,
      { documentId: "document-one", state: value.state },
    );
    assert.ok(dto && dto.entryKind === "document-upload");
    assert.equal(dto.upload.linkedPaperId, undefined);
    assert.equal(dto.upload.extractionStage, value.expected);
    assert.equal(dto.upload.readerAvailable, false);
  }

  const mismatched = inboxEntryDto(
    uploadInboxFixture(lifecycle({ assetStatus: "READY", documentStatus: "READY" })),
    undefined,
    { documentId: "document-other", state: "ready" },
  );
  assert.ok(mismatched && mismatched.entryKind === "document-upload");
  assert.equal(mismatched.upload.extractionStage, "not-started");
  assert.equal(mismatched.upload.readerAvailable, false);

  const validating = inboxEntryDto(
    uploadInboxFixture(lifecycle({ assetStatus: "SCANNING", documentStatus: "PROCESSING" })),
    undefined,
    { documentId: "document-one", state: "ready" },
  );
  assert.ok(validating && validating.entryKind === "document-upload");
  assert.equal(validating.upload.extractionStage, "not-started");
  assert.equal(validating.upload.readerAvailable, false);
});

test("upload Inbox DTO maps only the closed Reader state and rejects document drift", () => {
  const cases = [
    { state: "processing" as const, documentId: "document-one", expected: "queued", available: false },
    { state: "no-text" as const, documentId: "document-one", expected: "no-text", available: false },
    { state: "ready" as const, documentId: "document-one", expected: "ready", available: true },
    { state: "unavailable" as const, documentId: undefined, expected: "failed", available: false },
    { state: "ready" as const, documentId: "document-other", expected: "failed", available: false },
  ];
  for (const value of cases) {
    const upload = lifecycle({ assetStatus: "READY", documentStatus: "READY" });
    assert.ok(upload.document);
    upload.document.paperId = "paper-one";
    upload.document.workspacePaperId = "workspace-paper-one";
    const dto = inboxEntryDto(uploadInboxFixture(upload), {
      paperId: "paper-one",
      state: value.state,
      ...(value.documentId ? { documentId: value.documentId } : {}),
    });
    assert.ok(dto && dto.entryKind === "document-upload");
    assert.equal(dto.upload.extractionStage, value.expected);
    assert.equal(dto.upload.readerAvailable, value.available);
  }
});

test("upload Inbox DTO ignores stored diagnostic text and emits only safe failure fields", () => {
  const dto = inboxEntryDto(uploadInboxFixture(lifecycle({
    assetStatus: "REJECTED",
    assetRejectionCode: "malware_detected",
    documentStatus: "FAILED",
  })));

  assert.ok(dto && dto.entryKind === "document-upload");
  assert.deepEqual(dto.failure, {
    code: "malware_detected",
    message: "This file did not pass malware screening and remains unavailable.",
    retryable: false,
  });
  const serialized = JSON.stringify(dto);
  assert.equal(serialized.includes("raw scanner output"), false);
  assert.equal(serialized.includes("/private/bucket/object"), false);
  assert.equal(serialized.includes("sha256"), false);
  assert.equal(serialized.includes("worker"), false);
});

test("crawler document DTO projects a closed URL-free pipeline lifecycle", () => {
  const cases = [
    ["QUEUED", "queued", "processing"],
    ["FETCHING", "fetching", "processing"],
    ["QUARANTINED", "quarantined", "processing"],
    ["VALIDATING", "validating", "processing"],
    ["EXTRACTING", "extracting", "processing"],
    ["READY", "ready", "ready"],
    ["ATTENTION", "attention", "blocked"],
    ["FAILED", "failed", "blocked"],
    ["CANCELLED", "cancelled", "blocked"],
  ] as const;
  for (const [storedStatus, expectedStage, expectedStatus] of cases) {
    const fixture = crawlerInboxFixture(storedStatus);
    const dto = inboxEntryDto(
      fixture,
      undefined,
      fixture.document?.status === "READY"
        ? { documentId: "crawler-document-one", state: storedStatus === "READY" ? "ready" : "extracting" }
        : undefined,
    );
    assert.ok(dto && dto.entryKind === "crawler-document", storedStatus);
    assert.equal(dto.crawler.stage, expectedStage, storedStatus);
    assert.equal(dto.status, expectedStatus, storedStatus);
    assert.equal(dto.crawler.documentId, "crawler-document-one");
    assert.equal(dto.crawler.fileName, "governed-paper.pdf");
    assert.equal(dto.provenance.sourceId, "crawler-one");
    assert.equal(dto.provenance.sourceUrl, undefined);
    assert.equal(Object.hasOwn(dto, "paper"), false);
    assert.equal(Object.hasOwn(dto, "destinationProjectId"), false);
    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes("private.example.test"), false);
    assert.equal(serialized.includes("/private/bucket"), false);
    assert.equal(serialized.includes("sha256"), false);
    assert.equal(serialized.includes("worker=secret"), false);
  }
});

test("ready crawler documents expose explicit links only through Reader authority", () => {
  const fixture = crawlerInboxFixture("READY");
  assert.ok(fixture.document);
  fixture.status = "IMPORTED";
  fixture.document.paperId = "paper-one";
  fixture.document.workspacePaperId = "workspace-paper-one";

  const withoutAuthority = inboxEntryDto(fixture);
  assert.ok(withoutAuthority && withoutAuthority.entryKind === "crawler-document");
  assert.equal(withoutAuthority.crawler.linkedPaperId, undefined);
  assert.equal(withoutAuthority.crawler.readerAvailable, false);

  const linked = inboxEntryDto(fixture, {
    paperId: "paper-one",
    documentId: "crawler-document-one",
    state: "ready",
  });
  assert.ok(linked && linked.entryKind === "crawler-document");
  assert.equal(linked.crawler.linkedPaperId, "paper-one");
  assert.equal(linked.crawler.extractionStage, "ready");
  assert.equal(linked.crawler.readerAvailable, true);
});

test("crawler document DTO fails closed on lifecycle identity, phase, and document drift", () => {
  const fixtures = [
    (() => {
      const value = crawlerInboxFixture("READY");
      value.payload = { ...(value.payload as object), sourceUrl: "https://private.example.test/paper.pdf" };
      return value;
    })(),
    (() => {
      const value = crawlerInboxFixture("READY");
      value.payload = { ...(value.payload as object), phase: "fetch" };
      return value;
    })(),
    (() => {
      const value = crawlerInboxFixture("READY");
      value.documentId = "other-document";
      return value;
    })(),
  ];
  for (const fixture of fixtures) {
    assert.equal(inboxEntryDto(fixture), null);
  }
});
