import assert from "node:assert/strict";
import test from "node:test";

import {
  CRAWLER_ACQUISITION_MODE_V1,
  CRAWLER_RETENTION_MODE_V1,
  CRAWLER_RIGHTS_ATTESTATION_V1,
} from "@/server/integrations/web-source/crawler-command";
import type {
  CrawlerJobFailure,
  CrawlerJobLease,
} from "@/server/integrations/web-source/crawler-jobs";
import type { CrawlerConfiguration } from "@/server/integrations/web-source/crawler-config";
import {
  GovernedCrawlerFetchError,
  GovernedPdfFetcher,
  type GovernedPdfFetchPolicy,
  type GovernedPinnedHttpsResponse,
} from "@/server/integrations/web-source/governed-pdf-fetch";
import { CrawlerOriginRateLimitError } from "@/server/integrations/web-source/crawler-rate-limit";
import type { UploadConfiguration } from "@/server/uploads/config";
process.env.DATABASE_URL ??=
  "postgresql://paperpilot_runtime:test@127.0.0.1:5432/paperpilot?sslmode=disable";

const {
  runGovernedCrawlerWorkerOnce,
  waitForCrawlerOriginRequestRate,
} = await import("./governed-crawler-worker");

const ORIGIN = "https://papers.example.org";
const PDF_URL = `${ORIGIN}/one.pdf`;
const PDF_BYTES = new TextEncoder().encode("%PDF");

function response(input: {
  status?: number;
  bytes?: Uint8Array;
  headers?: ReadonlyArray<readonly [string, string]>;
} = {}): GovernedPinnedHttpsResponse {
  const bytes = input.bytes ?? new Uint8Array();
  return {
    statusCode: input.status ?? 200,
    headers: input.headers ?? [],
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.byteLength > 0) controller.enqueue(bytes);
        controller.close();
      },
    }),
    close() {},
  };
}

const FETCH_POLICY: GovernedPdfFetchPolicy = {
  boundaries: [{ origin: ORIGIN, pathPrefix: "/one.pdf", pathMatch: "exact" }],
  rightsGrant: CRAWLER_RIGHTS_ATTESTATION_V1,
  maximumBytes: 100,
  robotsUserAgent: "PaperPilotCrawler",
  maxRedirects: 0,
  maxDnsAddresses: 8,
  dnsLookupTimeoutMs: 100,
  maxResponseHeaderBytes: 32 * 1_024,
  responseHeaderTimeoutMs: 100,
  responseIdleTimeoutMs: 100,
  absoluteDeadlineMs: 1_000,
};

const RATE_AUTHORITY = {
  ratePolicyVersion: "paperpilot-crawler-origin-rate-v1",
  originRequestsPerMinute: 6,
  originBurst: 1,
};

test("burst one progresses from robots to PDF by waiting for the exact next origin token", async () => {
  let clockMs = Date.parse("2026-08-29T16:00:00.000Z");
  let rateCalls = 0;
  const waits: number[] = [];
  const requestPaths: string[] = [];
  const client = new GovernedPdfFetcher({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    requester: async (request) => {
      requestPaths.push(request.path);
      return request.path === "/robots.txt"
        ? response({ status: 404 })
        : response({
            bytes: PDF_BYTES,
            headers: [
              ["Content-Type", "application/pdf"],
              ["Content-Length", String(PDF_BYTES.byteLength)],
            ],
          });
    },
    beforePinnedRequest: ({ hostname, signal }) =>
      waitForCrawlerOriginRequestRate({
        hostname,
        authority: RATE_AUTHORITY,
        signal,
        now: () => new Date(clockMs),
        requireRate: async () => {
          rateCalls += 1;
          if (rateCalls === 2) {
            throw new CrawlerOriginRateLimitError(
              10,
              new Date(clockMs + 10_000),
            );
          }
        },
        wait: async (milliseconds, waitSignal) => {
          assert.equal(waitSignal.aborted, false);
          waits.push(milliseconds);
          clockMs += milliseconds;
        },
      }),
  });

  const fetched = await client.fetch({ url: PDF_URL, policy: FETCH_POLICY });
  assert.deepEqual(
    new Uint8Array(await new Response(fetched.body).arrayBuffer()),
    PDF_BYTES,
  );
  assert.deepEqual(requestPaths, ["/robots.txt", "/one.pdf"]);
  assert.equal(rateCalls, 3);
  assert.deepEqual(waits, [10_000]);
  assert.equal(fetched.receipt.pinnedConnectionCount, 2);
});

test("an origin-token wait remains bounded by the fetch absolute deadline", async () => {
  const client = new GovernedPdfFetcher({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    requester: async () => response({ status: 404 }),
    beforePinnedRequest: ({ hostname, signal }) =>
      waitForCrawlerOriginRequestRate({
        hostname,
        authority: RATE_AUTHORITY,
        signal,
        requireRate: async () => {
          throw new CrawlerOriginRateLimitError(
            60,
            new Date(Date.now() + 60_000),
          );
        },
      }),
  });
  const started = Date.now();
  await assert.rejects(
    client.fetch({ url: PDF_URL, policy: FETCH_POLICY }),
    (caught: unknown) => {
      assert.ok(caught instanceof GovernedCrawlerFetchError);
      assert.equal(caught.code, "crawler_timeout");
      return true;
    },
  );
  assert.ok(Date.now() - started < 2_000);
});

const UPLOAD_CONFIGURATION: UploadConfiguration = {
  quarantineRoot: "E:\\paperpilot-test-quarantine",
  maxUploadBytes: 1_000,
  sessionTtlMs: 60_000,
  leaseTtlMs: 20_000,
  streamIdleTimeoutMs: 1_000,
  streamAbsoluteTimeoutMs: 5_000,
  maxConcurrentUploadsPerUser: 1,
  maxConcurrentUploadsPerWorkspace: 1,
  maxRetainedBytesPerWorkspace: 10_000,
};

const CRAWLER_CONFIGURATION: Readonly<CrawlerConfiguration> = {
  acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
  policyVersion: "deployed-policy-v2",
  robotsUserAgent: "PaperPilotCrawler",
  maxRedirects: 0,
  maxDnsAddresses: 8,
  dnsLookupTimeoutMs: 100,
  maxResponseBytes: 1_000,
  maxResponseHeaderBytes: 32 * 1_024,
  responseHeaderTimeoutMs: 100,
  responseIdleTimeoutMs: 100,
  absoluteDeadlineMs: 1_000,
  ratePolicyVersion: "paperpilot-crawler-origin-rate-v1",
  originRequestsPerMinute: 6,
  originBurst: 1,
  workerIdentity: "crawler-test",
};

const LEASE: CrawlerJobLease = {
  organizationId: "organization-id",
  crawlerImportId: "crawler-import-id",
  jobId: "job-id",
  jobAttemptId: "job-attempt-id",
  ingressAttemptId: "ingress-attempt-id",
  attemptNumber: 1,
  workerId: "crawler-test-worker",
  leaseId: "lease-id",
  leaseExpiresAt: new Date("2026-08-29T16:10:00.000Z"),
  intakeId: "intake-id",
  documentId: "document-id",
  assetId: "asset-id",
  inboxEntryId: "inbox-id",
  importBatchId: "batch-id",
  requestedById: "user-id",
  requestedByPrincipalId: "00000000-0000-4000-8000-000000000001",
  canonicalSourceUrl: PDF_URL,
  sourceUrlFingerprint: "a".repeat(64),
  displayFileName: "one.pdf",
  maximumBytes: 100,
  storageVersion: "local-quarantine-v2",
  storageAuthorityGeneration: "a".repeat(64),
  storageKey: "quarantine/organization-id/asset-id/attempts/ingress-attempt-id/document.pdf",
  governance: {
    acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
    policyVersion: "frozen-policy-v1",
    rightsGrant: CRAWLER_RIGHTS_ATTESTATION_V1,
    rightsAttestationVersion: "paperpilot-crawler-rights-v1",
    rightsAttestedAt: new Date("2026-08-29T16:00:00.000Z"),
    robotsPolicy: "RESPECT_RFC9309",
    robotsPolicyVersion: "rfc9309-paperpilot-v1",
    retentionPolicy: CRAWLER_RETENTION_MODE_V1,
    retentionPolicyVersion: "paperpilot-crawler-retention-v1",
    policyRevision: 1,
  },
  fetchPolicy: FETCH_POLICY,
  rateAuthority: RATE_AUTHORITY,
};

test("worker reconciles custody deletion before cleanup or new crawler claims", async () => {
  let cleanupCalled = false;
  let claimCalled = false;
  const result = await runGovernedCrawlerWorkerOnce({
    uploadConfiguration: UPLOAD_CONFIGURATION,
    crawlerConfiguration: CRAWLER_CONFIGURATION,
    dependencies: {
      reconcileCustodyDeletion: async () => ({
        outcome: "deleted",
        crawlerImportId: LEASE.crawlerImportId,
        deletionProofDigest: "f".repeat(64),
      }),
      reconcileCleanup: async () => {
        cleanupCalled = true;
        return { outcome: "idle" };
      },
      claim: async () => {
        claimCalled = true;
        return null;
      },
    },
  });
  assert.deepEqual(result, {
    kind: "custody-deleted",
    crawlerImportId: LEASE.crawlerImportId,
  });
  assert.equal(cleanupCalled, false);
  assert.equal(claimCalled, false);
});

test("worker rejects an unsupported frozen policy before any network request", async () => {
  let fetched = false;
  let capturedFailure: CrawlerJobFailure | undefined;
  const result = await runGovernedCrawlerWorkerOnce({
    workerId: LEASE.workerId,
    leaseTtlMs: 10_000,
    uploadConfiguration: UPLOAD_CONFIGURATION,
    crawlerConfiguration: CRAWLER_CONFIGURATION,
    dependencies: {
      reconcileCustodyDeletion: async () => ({ outcome: "idle" }),
      reconcileCleanup: async () => ({ outcome: "idle" }),
      claim: async () => LEASE,
      fetchPdf: async () => {
        fetched = true;
        throw new Error("network must remain closed");
      },
      fail: async ({ failure }) => {
        capturedFailure = failure;
        return {
          outcome: "cleanup-required",
          ingressAttemptId: LEASE.ingressAttemptId,
          terminal: true,
          retryAt: new Date("2026-08-29T16:00:00.000Z"),
        };
      },
      cleanupAttempt: async () => ({
        outcome: "dead-letter",
        jobId: LEASE.jobId,
        ingressAttemptId: LEASE.ingressAttemptId,
      }),
    },
  });

  assert.equal(fetched, false);
  assert.deepEqual(capturedFailure, { code: "policy_changed", retryable: false });
  assert.deepEqual(result, {
    kind: "dead-letter",
    jobId: LEASE.jobId,
    crawlerImportId: LEASE.crawlerImportId,
  });
});

test("worker parses bounded identity and canonical lease TTL environment controls", async () => {
  let claimedWorkerId: string | undefined;
  let claimedLeaseTtl: number | undefined;
  const result = await runGovernedCrawlerWorkerOnce({
    uploadConfiguration: UPLOAD_CONFIGURATION,
    crawlerConfiguration: CRAWLER_CONFIGURATION,
    environment: {
      PAPERPILOT_CRAWLER_WORKER_ID: "env-crawler-worker",
      PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS: "15000",
    },
    dependencies: {
      reconcileCustodyDeletion: async () => ({ outcome: "idle" }),
      reconcileCleanup: async () => ({ outcome: "idle" }),
      claim: async ({ workerId, leaseTtlMs }) => {
        claimedWorkerId = workerId;
        claimedLeaseTtl = leaseTtlMs;
        return null;
      },
    },
  });
  assert.deepEqual(result, { kind: "idle" });
  assert.equal(claimedWorkerId, "env-crawler-worker");
  assert.equal(claimedLeaseTtl, 15_000);

  await assert.rejects(runGovernedCrawlerWorkerOnce({
    uploadConfiguration: UPLOAD_CONFIGURATION,
    crawlerConfiguration: CRAWLER_CONFIGURATION,
    environment: {
      PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS: "015000",
    },
  }), /canonical integer/);
  await assert.rejects(runGovernedCrawlerWorkerOnce({
    uploadConfiguration: UPLOAD_CONFIGURATION,
    crawlerConfiguration: CRAWLER_CONFIGURATION,
    environment: {
      PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS: "1000000",
    },
  }), /lease configuration/);
  await assert.rejects(runGovernedCrawlerWorkerOnce({
    uploadConfiguration: UPLOAD_CONFIGURATION,
    crawlerConfiguration: CRAWLER_CONFIGURATION,
    environment: {
      PAPERPILOT_CRAWLER_WORKER_ID: "bad\nworker",
      PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS: "15000",
    },
  }), /WORKER_ID/);
  for (const workerId of [
    "bad\tworker",
    "bad worker",
    "bad/worker",
    "bad\u001bworker",
    "bad\u202Eworker",
    "\u0000worker",
  ]) {
    await assert.rejects(runGovernedCrawlerWorkerOnce({
      uploadConfiguration: UPLOAD_CONFIGURATION,
      crawlerConfiguration: CRAWLER_CONFIGURATION,
      environment: {
        PAPERPILOT_CRAWLER_WORKER_ID: workerId,
        PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS: "15000",
      },
    }), /WORKER_ID/);
  }
});
