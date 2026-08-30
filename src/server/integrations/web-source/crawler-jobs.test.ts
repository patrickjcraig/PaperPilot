import assert from "node:assert/strict";
import test from "node:test";

import {
  CRAWLER_ACQUISITION_MODE_V1,
  CRAWLER_RETENTION_MODE_V1,
  CRAWLER_RIGHTS_ATTESTATION_V1,
} from "./crawler-command";
import type { CrawlerJobLease } from "./crawler-jobs";
import { GovernedCrawlerFetchError } from "./governed-pdf-fetch";
import { CrawlerOriginRateLimitError } from "./crawler-rate-limit";

process.env.DATABASE_URL ??=
  "postgresql://paperpilot_runtime:test@127.0.0.1:5432/paperpilot?sslmode=disable";

const {
  crawlerJobDedupeKey,
  crawlerFailureDisposition,
  crawlerJobFailureFromUnknown,
  crawlerJobPayload,
  crawlerLeaseSupportsConfiguration,
  crawlerReceiptSourceFingerprint,
  parseCrawlerJobPayload,
} = await import("./crawler-jobs");

const IMPORT_ID = "crawler-import-id";

const EXECUTION_AUTHORITY: Pick<
  CrawlerJobLease,
  "governance" | "fetchPolicy" | "rateAuthority"
> = {
  governance: {
    acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
    policyVersion: "paperpilot-crawler-explicit-pdf-v1",
    rightsGrant: CRAWLER_RIGHTS_ATTESTATION_V1,
    rightsAttestationVersion: "paperpilot-crawler-rights-v1",
    rightsAttestedAt: new Date("2026-08-29T16:00:00.000Z"),
    robotsPolicy: "RESPECT_RFC9309",
    robotsPolicyVersion: "rfc9309-paperpilot-v1",
    retentionPolicy: CRAWLER_RETENTION_MODE_V1,
    retentionPolicyVersion: "paperpilot-crawler-retention-v1",
    policyRevision: 1,
  },
  fetchPolicy: {
    boundaries: [{
      origin: "https://papers.example.org",
      pathPrefix: "/one.pdf",
      pathMatch: "exact",
    }],
    rightsGrant: CRAWLER_RIGHTS_ATTESTATION_V1,
    maximumBytes: 1_000,
    robotsUserAgent: "PaperPilotCrawler",
    maxRedirects: 0,
    maxDnsAddresses: 8,
    dnsLookupTimeoutMs: 3_000,
    maxResponseHeaderBytes: 32 * 1_024,
    responseHeaderTimeoutMs: 5_000,
    responseIdleTimeoutMs: 10_000,
    absoluteDeadlineMs: 60_000,
  },
  rateAuthority: {
    ratePolicyVersion: "paperpilot-crawler-origin-rate-v1",
    originRequestsPerMinute: 6,
    originBurst: 1,
  },
};

const DEPLOYED_CONFIGURATION = {
  acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
  policyVersion: "paperpilot-crawler-explicit-pdf-v1",
  robotsUserAgent: "PaperPilotCrawler",
  ratePolicyVersion: "paperpilot-crawler-origin-rate-v1",
};

test("crawler job payload is closed and carries no URL or policy authority", () => {
  const payload = crawlerJobPayload(IMPORT_ID);
  assert.deepEqual(payload, { schemaVersion: 1, crawlerImportId: IMPORT_ID });
  assert.deepEqual(parseCrawlerJobPayload(payload), payload);
  assert.equal(parseCrawlerJobPayload({
    ...payload,
    sourceUrl: "https://private.example/paper.pdf",
  }), null);
  assert.equal(parseCrawlerJobPayload({
    ...payload,
    policyVersion: "attacker-policy",
  }), null);
  assert.equal(parseCrawlerJobPayload({ schemaVersion: 2, crawlerImportId: IMPORT_ID }), null);
  assert.equal(crawlerJobDedupeKey(IMPORT_ID), `crawler-import:${IMPORT_ID}:v1`);
});

test("crawler receipt fingerprint is attempt-specific and never the URL digest", () => {
  assert.equal(
    crawlerReceiptSourceFingerprint(IMPORT_ID),
    `crawler-import:${IMPORT_ID}`,
  );
  assert.equal(crawlerReceiptSourceFingerprint(IMPORT_ID).includes("https://"), false);
});

test("deployment support checks contract identities but frozen row values own numeric execution", () => {
  assert.equal(
    crawlerLeaseSupportsConfiguration(EXECUTION_AUTHORITY, DEPLOYED_CONFIGURATION),
    true,
  );
  assert.equal(crawlerLeaseSupportsConfiguration(EXECUTION_AUTHORITY, {
    ...DEPLOYED_CONFIGURATION,
    policyVersion: "new-policy",
  }), false);
  assert.equal(crawlerLeaseSupportsConfiguration(EXECUTION_AUTHORITY, {
    ...DEPLOYED_CONFIGURATION,
    robotsUserAgent: "AnotherCrawler",
  }), false);
  assert.equal(crawlerLeaseSupportsConfiguration(EXECUTION_AUTHORITY, {
    ...DEPLOYED_CONFIGURATION,
    ratePolicyVersion: "new-rate-policy",
  }), false);

  const changedFrozenNumbers = {
    ...EXECUTION_AUTHORITY,
    fetchPolicy: {
      ...EXECUTION_AUTHORITY.fetchPolicy,
      maxRedirects: 3,
      absoluteDeadlineMs: 120_000,
    },
    rateAuthority: {
      ...EXECUTION_AUTHORITY.rateAuthority,
      originRequestsPerMinute: 60,
      originBurst: 2,
    },
  };
  assert.equal(
    crawlerLeaseSupportsConfiguration(changedFrozenNumbers, DEPLOYED_CONFIGURATION),
    true,
  );
});

test("failure mapping preserves safe fetch codes and exact origin retry authority", () => {
  assert.deepEqual(
    crawlerJobFailureFromUnknown(
      new GovernedCrawlerFetchError("crawler_dns_rejected", true),
    ),
    { code: "crawler_dns_rejected", retryable: true },
  );
  const retryAt = new Date("2026-08-29T16:01:17.000Z");
  const rateFailure = crawlerJobFailureFromUnknown(
    new CrawlerOriginRateLimitError(77, retryAt),
  );
  assert.deepEqual(rateFailure, {
    code: "crawler_origin_rate_limited",
    retryable: true,
    retryAt,
  });
  assert.equal(rateFailure.retryAt, retryAt);
  assert.deepEqual(crawlerJobFailureFromUnknown(new Error(
    "https://private.invalid/secret.pdf",
  )), {
    code: "crawler_worker_internal",
    retryable: true,
  });
});

test("terminal failure keeps FETCHING and RETRYING on one cleanup-pending instant", () => {
  const now = new Date("2026-08-29T16:00:00.000Z");
  const terminal = crawlerFailureDisposition({
    failure: { code: "crawler_robots_denied", retryable: false },
    attemptNumber: 1,
    maximumAttempts: 5,
    now,
  });
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.retryAt, now);

  const exactRateRetry = new Date("2026-08-29T16:00:17.000Z");
  const retrying = crawlerFailureDisposition({
    failure: {
      code: "crawler_origin_rate_limited",
      retryable: true,
      retryAt: exactRateRetry,
    },
    attemptNumber: 1,
    maximumAttempts: 5,
    now,
  });
  assert.equal(retrying.terminal, false);
  assert.equal(retrying.retryAt, exactRateRetry);
});
