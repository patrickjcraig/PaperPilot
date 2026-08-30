import assert from "node:assert/strict";
import test from "node:test";

import {
  CRAWLER_ACQUISITION_MODE_V1,
} from "./crawler-command";
import {
  DEFAULT_CRAWLER_ABSOLUTE_DEADLINE_MS,
  DEFAULT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS,
  DEFAULT_CRAWLER_MAX_DNS_ADDRESSES,
  DEFAULT_CRAWLER_MAX_REDIRECTS,
  DEFAULT_CRAWLER_MAX_RESPONSE_HEADER_BYTES,
  DEFAULT_CRAWLER_ORIGIN_BURST,
  DEFAULT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE,
  DEFAULT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS,
  DEFAULT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS,
  crawlerConfigurationFromEnvironment,
} from "./crawler-config";

const MEBIBYTE = 1_024 * 1_024;

test("local defaults are bounded, immutable, and capped by upload configuration", () => {
  const configuration = crawlerConfigurationFromEnvironment(
    { maxUploadBytes: 5 * MEBIBYTE },
    {},
  );

  assert.deepEqual(configuration, {
    acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
    policyVersion: "paperpilot-crawler-explicit-pdf-v1",
    robotsUserAgent: "PaperPilotCrawler",
    maxRedirects: DEFAULT_CRAWLER_MAX_REDIRECTS,
    maxDnsAddresses: DEFAULT_CRAWLER_MAX_DNS_ADDRESSES,
    dnsLookupTimeoutMs: DEFAULT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS,
    maxResponseBytes: 5 * MEBIBYTE,
    maxResponseHeaderBytes: DEFAULT_CRAWLER_MAX_RESPONSE_HEADER_BYTES,
    responseHeaderTimeoutMs: DEFAULT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS,
    responseIdleTimeoutMs: DEFAULT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS,
    absoluteDeadlineMs: DEFAULT_CRAWLER_ABSOLUTE_DEADLINE_MS,
    ratePolicyVersion: "paperpilot-crawler-origin-rate-v1",
    originRequestsPerMinute: DEFAULT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE,
    originBurst: DEFAULT_CRAWLER_ORIGIN_BURST,
    workerIdentity: "paperpilot-crawler-local",
  });
  assert.equal(Object.isFrozen(configuration), true);

  const largerUpload = crawlerConfigurationFromEnvironment(
    { maxUploadBytes: 100 * MEBIBYTE },
    {},
  );
  assert.equal(largerUpload.maxResponseBytes, 25 * MEBIBYTE);
});

test("production requires explicit policy, robots identity, and worker identity", () => {
  assert.throws(
    () => crawlerConfigurationFromEnvironment(
      { maxUploadBytes: 25 * MEBIBYTE },
      { NODE_ENV: "production" },
    ),
    /PAPERPILOT_CRAWLER_POLICY_VERSION is required/,
  );
  assert.throws(
    () => crawlerConfigurationFromEnvironment(
      { maxUploadBytes: 25 * MEBIBYTE },
      {
        NODE_ENV: "production",
        PAPERPILOT_CRAWLER_POLICY_VERSION: "crawler-policy-prod-v1",
      },
    ),
    /PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT is required/,
  );
  assert.throws(
    () => crawlerConfigurationFromEnvironment(
      { maxUploadBytes: 25 * MEBIBYTE },
      {
        NODE_ENV: "production",
        PAPERPILOT_CRAWLER_POLICY_VERSION: "crawler-policy-prod-v1",
        PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT: "PaperPilotCrawler",
      },
    ),
    /PAPERPILOT_CRAWLER_WORKER_IDENTITY is required/,
  );
  assert.throws(
    () => crawlerConfigurationFromEnvironment(
      { maxUploadBytes: 25 * MEBIBYTE },
      {
        NODE_ENV: "production",
        PAPERPILOT_CRAWLER_POLICY_VERSION: "crawler-policy-prod-v1",
        PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT: "PaperPilotCrawler",
        PAPERPILOT_CRAWLER_WORKER_IDENTITY: "crawler-worker-us-east-1a-01",
      },
    ),
    /PAPERPILOT_CRAWLER_RATE_POLICY_VERSION is required/,
  );

  const configured = crawlerConfigurationFromEnvironment(
    { maxUploadBytes: 25 * MEBIBYTE },
    {
      NODE_ENV: "production",
      PAPERPILOT_CRAWLER_POLICY_VERSION: "crawler-policy-prod-v1",
      PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT: "PaperPilotCrawler",
      PAPERPILOT_CRAWLER_WORKER_IDENTITY: "crawler-worker-us-east-1a-01",
      PAPERPILOT_CRAWLER_RATE_POLICY_VERSION: "crawler-origin-rate-prod-v1",
    },
  );
  assert.equal(configured.policyVersion, "crawler-policy-prod-v1");
  assert.equal(configured.robotsUserAgent, "PaperPilotCrawler");
  assert.equal(configured.workerIdentity, "crawler-worker-us-east-1a-01");
  assert.equal(configured.ratePolicyVersion, "crawler-origin-rate-prod-v1");
});

test("every deployment bound accepts canonical values inside its closed range", () => {
  const configuration = crawlerConfigurationFromEnvironment(
    { maxUploadBytes: 20_000_000 },
    {
      PAPERPILOT_CRAWLER_POLICY_VERSION: "policy-v1.2:blue",
      PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT: "PaperPilotCrawler_Second",
      PAPERPILOT_CRAWLER_WORKER_IDENTITY: "worker:us-east-1:42",
      PAPERPILOT_CRAWLER_RATE_POLICY_VERSION: "origin-rate-v2",
      PAPERPILOT_CRAWLER_MAX_REDIRECTS: "0",
      PAPERPILOT_CRAWLER_MAX_DNS_ADDRESSES: "16",
      PAPERPILOT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS: "10000",
      PAPERPILOT_CRAWLER_MAX_RESPONSE_BYTES: "20000000",
      PAPERPILOT_CRAWLER_MAX_RESPONSE_HEADER_BYTES: "65536",
      PAPERPILOT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS: "15000",
      PAPERPILOT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS: "30000",
      PAPERPILOT_CRAWLER_ABSOLUTE_DEADLINE_MS: "120000",
      PAPERPILOT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE: "600",
      PAPERPILOT_CRAWLER_ORIGIN_BURST: "60",
    },
  );

  assert.deepEqual(configuration, {
    acquisitionMode: CRAWLER_ACQUISITION_MODE_V1,
    policyVersion: "policy-v1.2:blue",
    robotsUserAgent: "PaperPilotCrawler_Second",
    maxRedirects: 0,
    maxDnsAddresses: 16,
    dnsLookupTimeoutMs: 10_000,
    maxResponseBytes: 20_000_000,
    maxResponseHeaderBytes: 65_536,
    responseHeaderTimeoutMs: 15_000,
    responseIdleTimeoutMs: 30_000,
    absoluteDeadlineMs: 120_000,
    ratePolicyVersion: "origin-rate-v2",
    originRequestsPerMinute: 600,
    originBurst: 60,
    workerIdentity: "worker:us-east-1:42",
  });
});

test("numeric environment values reject noncanonical syntax and out-of-range limits", () => {
  const cases: Array<[string, string]> = [
    ["PAPERPILOT_CRAWLER_MAX_REDIRECTS", "1"],
    ["PAPERPILOT_CRAWLER_MAX_REDIRECTS", "4"],
    ["PAPERPILOT_CRAWLER_MAX_REDIRECTS", "-1"],
    ["PAPERPILOT_CRAWLER_MAX_REDIRECTS", "01"],
    ["PAPERPILOT_CRAWLER_MAX_REDIRECTS", "1.5"],
    ["PAPERPILOT_CRAWLER_MAX_DNS_ADDRESSES", "0"],
    ["PAPERPILOT_CRAWLER_MAX_DNS_ADDRESSES", "17"],
    ["PAPERPILOT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS", "99"],
    ["PAPERPILOT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS", "10001"],
    ["PAPERPILOT_CRAWLER_MAX_RESPONSE_BYTES", "0"],
    ["PAPERPILOT_CRAWLER_MAX_RESPONSE_BYTES", `${2 * MEBIBYTE + 1}`],
    ["PAPERPILOT_CRAWLER_MAX_RESPONSE_HEADER_BYTES", "1023"],
    ["PAPERPILOT_CRAWLER_MAX_RESPONSE_HEADER_BYTES", "65537"],
    ["PAPERPILOT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS", "99"],
    ["PAPERPILOT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS", "15001"],
    ["PAPERPILOT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS", "99"],
    ["PAPERPILOT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS", "30001"],
    ["PAPERPILOT_CRAWLER_ABSOLUTE_DEADLINE_MS", "999"],
    ["PAPERPILOT_CRAWLER_ABSOLUTE_DEADLINE_MS", "120001"],
    ["PAPERPILOT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE", "0"],
    ["PAPERPILOT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE", "601"],
    ["PAPERPILOT_CRAWLER_ORIGIN_BURST", "0"],
    ["PAPERPILOT_CRAWLER_ORIGIN_BURST", "61"],
  ];

  for (const [name, value] of cases) {
    assert.throws(
      () => crawlerConfigurationFromEnvironment(
        { maxUploadBytes: 2 * MEBIBYTE },
        { [name]: value },
      ),
      new RegExp(name),
      `${name}=${value}`,
    );
  }
});

test("timeouts must fit coherently inside the absolute acquisition deadline", () => {
  for (const environment of [
    {
      PAPERPILOT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS: "1000",
      PAPERPILOT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS: "1000",
      PAPERPILOT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS: "100",
      PAPERPILOT_CRAWLER_ABSOLUTE_DEADLINE_MS: "2000",
    },
    {
      PAPERPILOT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS: "100",
      PAPERPILOT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS: "100",
      PAPERPILOT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS: "1000",
      PAPERPILOT_CRAWLER_ABSOLUTE_DEADLINE_MS: "1000",
    },
  ]) {
    assert.throws(
      () => crawlerConfigurationFromEnvironment(
        { maxUploadBytes: MEBIBYTE },
        environment,
      ),
      /must fit inside the absolute deadline/,
    );
  }
});

test("policy, robots user agent, and worker identity are bounded non-secret tokens", () => {
  const cases: Array<[string, string]> = [
    ["PAPERPILOT_CRAWLER_POLICY_VERSION", ""],
    ["PAPERPILOT_CRAWLER_POLICY_VERSION", " policy-v1"],
    ["PAPERPILOT_CRAWLER_POLICY_VERSION", "policy version"],
    ["PAPERPILOT_CRAWLER_POLICY_VERSION", "x".repeat(129)],
    ["PAPERPILOT_CRAWLER_RATE_POLICY_VERSION", "bad rate"],
    ["PAPERPILOT_CRAWLER_RATE_POLICY_VERSION", "x".repeat(129)],
    ["PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT", "Bot".repeat(30)],
    ["PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT", "PaperPilot Crawler"],
    ["PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT", "PaperPilotCrawler2"],
    ["PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT", "PaperPilot.Crawler"],
    ["PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT", "PaperPilotCrawler\nSecret"],
    ["PAPERPILOT_CRAWLER_WORKER_IDENTITY", ""],
    ["PAPERPILOT_CRAWLER_WORKER_IDENTITY", "worker identity"],
    ["PAPERPILOT_CRAWLER_WORKER_IDENTITY", "worker/one"],
    ["PAPERPILOT_CRAWLER_WORKER_IDENTITY", "x".repeat(129)],
  ];
  for (const [name, value] of cases) {
    assert.throws(
      () => crawlerConfigurationFromEnvironment(
        { maxUploadBytes: MEBIBYTE },
        { [name]: value },
      ),
      new RegExp(name),
      `${name} invalid token`,
    );
  }
});

test("origin burst cannot exceed the frozen per-minute request budget", () => {
  assert.throws(
    () => crawlerConfigurationFromEnvironment(
      { maxUploadBytes: MEBIBYTE },
      {
        PAPERPILOT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE: "2",
        PAPERPILOT_CRAWLER_ORIGIN_BURST: "3",
      },
    ),
    /cannot exceed the per-minute origin budget/,
  );
});

test("invalid upload configuration fails before a crawler policy can be constructed", () => {
  for (const maxUploadBytes of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => crawlerConfigurationFromEnvironment({ maxUploadBytes }, {}),
      /valid upload byte limit/,
    );
  }
});
