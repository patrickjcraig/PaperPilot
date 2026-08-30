import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { WorkspaceCommandResult } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import {
  DocumentValidationServiceError,
  type DocumentValidationFetch,
  type StreamingDocumentValidationRequestInit,
} from "@/server/documents/validation-client";
import type { DocumentValidationServiceConfiguration } from "@/server/documents/validation-config";
import type { ExternalDocumentValidationResponse } from "@/server/documents/validation-contract";
import {
  createWorkspaceUploadSession,
  storeWorkspaceUploadContent,
} from "@/server/uploads/service";
import { runDocumentValidationWorkerOnce as runDocumentValidationWorkerOnceWithExtractionPin } from "./document-validation-worker";

const ENDPOINT = "https://validator.paperpilot.test/v1/document-validation";
const READINESS_ENDPOINT = "https://validator.paperpilot.test/readyz";
const SECRET = "validation-service-secret-with-more-than-32-characters";
const POLICY_VERSION = "paperpilot-document-validation-v1";
const STORAGE_VERSION = "local-quarantine-v2";
const VALIDATION_NOW = new Date("2026-08-28T16:00:00.000Z");
const EXTRACTION_TOOLCHAIN_DIGEST = "e".repeat(64);

function runDocumentValidationWorkerOnce(
  options: Omit<
    NonNullable<Parameters<typeof runDocumentValidationWorkerOnceWithExtractionPin>[0]>,
    "extractionExpectedToolchainDigest"
  > = {},
) {
  return runDocumentValidationWorkerOnceWithExtractionPin({
    ...options,
    extractionExpectedToolchainDigest: EXTRACTION_TOOLCHAIN_DIGEST,
  });
}

after(async () => {
  await prisma.$disconnect();
});

function assertSuccess<T>(
  result: WorkspaceCommandResult<T>,
): asserts result is Extract<WorkspaceCommandResult<T>, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function pdfRequest(bytes: Uint8Array): Request {
  return new Request("https://paperpilot.test/upload", {
    method: "PUT",
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
    },
    body: new Uint8Array(bytes).buffer,
  });
}

function configuration(): DocumentValidationServiceConfiguration {
  return {
    endpoint: ENDPOINT,
    readinessEndpoint: READINESS_ENDPOINT,
    bearerSecret: SECRET,
    policyVersion: POLICY_VERSION,
    timeoutMs: 30_000,
    maxResponseBytes: 16 * 1_024,
    signatureMaxAgeMs: 24 * 60 * 60 * 1_000,
    futureClockSkewMs: 5 * 60 * 1_000,
  };
}

async function readRequestBody(
  stream: StreamingDocumentValidationRequestInit["body"],
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseAt(value: unknown): Response {
  const response = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  Object.defineProperty(response, "url", { configurable: true, value: ENDPOINT });
  Object.defineProperty(response, "redirected", { configurable: true, value: false });
  return response;
}

function readinessResponse(status = 204): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: READINESS_ENDPOINT,
  });
  Object.defineProperty(response, "redirected", {
    configurable: true,
    value: false,
  });
  return response;
}

function acceptedResponse(input: {
  sha256: string;
  sizeBytes: number;
}): ExternalDocumentValidationResponse {
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    storageVersion: STORAGE_VERSION,
    toolchainDigest: "b".repeat(64),
    verdict: "accepted",
    rejectionCode: null,
    input: { sha256: input.sha256, sizeBytes: String(input.sizeBytes) },
    malware: {
      verdict: "clean",
      engine: "clamav",
      engineVersion: "1.5.4",
      signatureVersion: "27712",
      signaturePublishedAt: "2026-08-28T10:00:00.000Z",
      scannedAt: "2026-08-28T15:59:00.000Z",
      detectionCount: 0,
      durationMs: 100,
    },
    pdf: {
      structuralVerdict: "valid",
      engine: "qpdf+poppler",
      engineVersion: "12.4.1+26.05.0",
      pdfVersion: "1.7",
      pageCount: 1,
      objectCount: 1,
      revisionCount: 1,
      warningCount: 0,
      checkedAt: "2026-08-28T15:59:10.000Z",
      durationMs: 200,
    },
    completedAt: "2026-08-28T15:59:20.000Z",
    totalDurationMs: 350,
  };
}

function objectPath(root: string, storageKey: string): string {
  const parts = storageKey.split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], STORAGE_VERSION);
  return path.join(
    root,
    "tenants",
    parts[1],
    "assets",
    parts[2],
    `${parts[3]}.quarantine`,
  );
}

test("isolated validation worker streams the bound object and promotes only an accepted attestation", async () => {
  const suffix = randomUUID();
  const quarantineRoot = await mkdtemp(path.join(os.tmpdir(), "paperpilot-worker-"));
  const previousRoot = process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT;
  const previousEndpoint = process.env.PAPERPILOT_VALIDATION_SERVICE_ENDPOINT;
  const previousSecret = process.env.PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET;
  const previousPolicy = process.env.PAPERPILOT_VALIDATION_POLICY_VERSION;
  process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT = quarantineRoot;
  const user = { id: `worker-user-${suffix}`, name: "Worker Owner" };
  const workspaceId = `worker-workspace-${suffix}`;
  const bytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

  try {
    await prisma.user.create({
      data: {
        id: user.id,
        name: user.name,
        email: `worker-${suffix}@example.test`,
        emailVerified: true,
      },
    });
    await prisma.organization.create({
      data: { id: workspaceId, name: "Worker integration", slug: `worker-${suffix}` },
    });
    await prisma.member.create({
      data: { organizationId: workspaceId, userId: user.id, role: "owner" },
    });
    const created = await createWorkspaceUploadSession(user, workspaceId, {
      clientOperationId: `worker-upload-${suffix}`,
      expectedVersion: 0,
      fileName: "Worker evidence.pdf",
      sizeBytes: bytes.byteLength,
      declaredMimeType: "application/pdf",
    });
    assertSuccess(created);
    await storeWorkspaceUploadContent(
      user,
      workspaceId,
      created.data.upload.id,
      pdfRequest(bytes),
    );

    delete process.env.PAPERPILOT_VALIDATION_SERVICE_ENDPOINT;
    delete process.env.PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET;
    delete process.env.PAPERPILOT_VALIDATION_POLICY_VERSION;
    await assert.rejects(
      runDocumentValidationWorkerOnce({
        workerId: `preflight-${suffix}`,
        uploadConfiguration: { quarantineRoot },
      }),
      /PAPERPILOT_VALIDATION_SERVICE_ENDPOINT/,
    );
    const stillQueued = await prisma.job.findFirstOrThrow({
      where: { organizationId: workspaceId, type: "DOCUMENT_VALIDATE" },
    });
    assert.equal(stillQueued.status, "QUEUED");
    assert.equal(stillQueued.attempts, 0, "invalid startup configuration must not burn a lease");

    await assert.rejects(
      runDocumentValidationWorkerOnce({
        workerId: `bad-readiness-auth-${suffix}`,
        validationConfiguration: configuration(),
        uploadConfiguration: { quarantineRoot },
        clientDependencies: {
          readinessFetch: async () => readinessResponse(401),
          fetch: async () => {
            throw new Error("Validation must not run after readiness authentication fails.");
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentValidationServiceError);
        assert.equal(error.code, "validation_service_configuration_error");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    const queuedAfterBadReadinessAuth = await prisma.job.findFirstOrThrow({
      where: { organizationId: workspaceId, type: "DOCUMENT_VALIDATE" },
    });
    assert.equal(queuedAfterBadReadinessAuth.status, "QUEUED");
    assert.equal(
      queuedAfterBadReadinessAuth.attempts,
      0,
      "readiness authentication failure must not consume a durable attempt",
    );

    let validatorCalledDuringOutage = false;
    const outage = await runDocumentValidationWorkerOnce({
      workerId: `outage-${suffix}`,
      validationConfiguration: configuration(),
      uploadConfiguration: { quarantineRoot },
      clientDependencies: {
        readinessFetch: async (url, init) => {
          assert.equal(url, READINESS_ENDPOINT);
          assert.equal(init.method, "GET");
          return readinessResponse(503);
        },
        fetch: async () => {
          validatorCalledDuringOutage = true;
          throw new Error("Validation must not run during a readiness outage.");
        },
      },
    });
    assert.equal(outage.kind, "service-unavailable");
    assert.equal(validatorCalledDuringOutage, false);
    const queuedAfterOutage = await prisma.job.findFirstOrThrow({
      where: { organizationId: workspaceId, type: "DOCUMENT_VALIDATE" },
    });
    assert.equal(queuedAfterOutage.status, "QUEUED");
    assert.equal(
      queuedAfterOutage.attempts,
      0,
      "a known validator outage must not consume a durable attempt",
    );

    let streamedBytes: Uint8Array | null = null;
    const validator: DocumentValidationFetch = async (url, init) => {
      assert.equal(url, ENDPOINT);
      assert.equal(init.headers instanceof Headers, true);
      const headers = init.headers as Headers;
      assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
      assert.equal(headers.get("x-paperpilot-content-sha256"), expectedSha256);
      assert.equal(headers.get("x-paperpilot-storage-version"), STORAGE_VERSION);
      streamedBytes = await readRequestBody(init.body);
      return responseAt(acceptedResponse({
        sha256: expectedSha256,
        sizeBytes: bytes.byteLength,
      }));
    };
    const result = await runDocumentValidationWorkerOnce({
      workerId: `worker-${suffix}`,
      validationConfiguration: configuration(),
      uploadConfiguration: { quarantineRoot },
      clientDependencies: {
        readinessFetch: async (url, init) => {
          assert.equal(url, READINESS_ENDPOINT);
          assert.equal(init.method, "GET");
          const headers = new Headers(init.headers);
          assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
          return readinessResponse();
        },
        fetch: validator,
        clock: () => VALIDATION_NOW,
      },
    });
    assert.equal(result.kind, "accepted");
    assert.deepEqual(streamedBytes, bytes);

    const promoted = await prisma.uploadSession.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: workspaceId,
          id: created.data.upload.id,
        },
      },
      include: { asset: true, document: true, inboxEntry: true },
    });
    assert.equal(promoted.asset.status, "READY");
    assert.equal(promoted.asset.sha256, expectedSha256);
    assert.equal(promoted.asset.validatedAt?.toISOString(), "2026-08-28T15:59:10.000Z");
    assert.equal(promoted.document?.status, "READY");
    assert.equal(promoted.document?.pageCount, 1);
    assert.equal(promoted.inboxEntry?.status, "NEEDS_REVIEW");
    assert.equal(await prisma.documentValidationAttestation.count({
      where: { organizationId: workspaceId, assetId: promoted.assetId },
    }), 1);

    const second = await createWorkspaceUploadSession(user, workspaceId, {
      clientOperationId: `worker-tamper-${suffix}`,
      expectedVersion: 1,
      fileName: "Tampered evidence.pdf",
      sizeBytes: bytes.byteLength,
      declaredMimeType: "application/pdf",
    });
    assertSuccess(second);
    await storeWorkspaceUploadContent(
      user,
      workspaceId,
      second.data.upload.id,
      pdfRequest(bytes),
    );
    const tampered = await prisma.uploadSession.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: workspaceId,
          id: second.data.upload.id,
        },
      },
      include: { asset: true },
    });
    const tamperedPath = objectPath(quarantineRoot, tampered.asset.objectKey);
    await chmod(tamperedPath, 0o600);
    const changed = new Uint8Array(bytes);
    changed[10] ^= 1;
    await writeFile(tamperedPath, changed);
    await chmod(tamperedPath, 0o400);

    let validatorCalled = false;
    const tamperResult = await runDocumentValidationWorkerOnce({
      workerId: `worker-tamper-${suffix}`,
      validationConfiguration: configuration(),
      uploadConfiguration: { quarantineRoot },
      clientDependencies: {
        readinessFetch: async () => readinessResponse(),
        fetch: async () => {
          validatorCalled = true;
          throw new Error("The validator must not receive a locally mismatched object.");
        },
        clock: () => VALIDATION_NOW,
      },
    });
    assert.equal(tamperResult.kind, "dead-letter");
    assert.equal(validatorCalled, false);
    const rejected = await prisma.uploadSession.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: workspaceId,
          id: second.data.upload.id,
        },
      },
      include: { asset: true, document: true, inboxEntry: true },
    });
    assert.equal(rejected.asset.status, "REJECTED");
    assert.equal(rejected.asset.rejectionCode, "integrity_check_failed");
    assert.equal(rejected.document?.status, "FAILED");
    assert.equal(rejected.document?.failureCode, "integrity_check_failed");
    assert.equal(rejected.inboxEntry?.status, "FAILED");
    assert.equal(await prisma.documentValidationAttestation.count({
      where: { organizationId: workspaceId, assetId: rejected.assetId },
    }), 0);
  } finally {
    if (previousRoot === undefined) delete process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT;
    else process.env.PAPERPILOT_UPLOAD_QUARANTINE_ROOT = previousRoot;
    if (previousEndpoint === undefined) delete process.env.PAPERPILOT_VALIDATION_SERVICE_ENDPOINT;
    else process.env.PAPERPILOT_VALIDATION_SERVICE_ENDPOINT = previousEndpoint;
    if (previousSecret === undefined) delete process.env.PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET;
    else process.env.PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET = previousSecret;
    if (previousPolicy === undefined) delete process.env.PAPERPILOT_VALIDATION_POLICY_VERSION;
    else process.env.PAPERPILOT_VALIDATION_POLICY_VERSION = previousPolicy;
    await prisma.$transaction(async (transaction) => {
      await transaction.auditEvent.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.provenanceRecord.deleteMany({ where: { organizationId: workspaceId } });
      await transaction.organization.deleteMany({ where: { id: workspaceId } });
    });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await rm(quarantineRoot, { recursive: true, force: true });
  }
});
