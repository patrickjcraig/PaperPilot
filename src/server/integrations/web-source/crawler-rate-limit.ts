import "server-only";

import { createHash } from "node:crypto";

import type { RateLimitConsumption } from "@/server/rate-limit/core";

const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_REQUESTS_PER_MINUTE = 600;
const MAX_BURST = 60;

export interface CrawlerOriginRateAuthority {
  ratePolicyVersion: string;
  originRequestsPerMinute: number;
  originBurst: number;
}

export class CrawlerOriginRateLimitError extends Error {
  readonly code = "crawler_origin_rate_limited" as const;
  readonly retryable = true;

  constructor(
    readonly retryAfterSeconds: number,
    readonly retryAt: Date,
  ) {
    super("The crawler origin request budget is temporarily exhausted.");
    this.name = "CrawlerOriginRateLimitError";
  }
}

function requireAuthority(
  authority: CrawlerOriginRateAuthority,
): CrawlerOriginRateAuthority {
  if (
    !authority
    || typeof authority !== "object"
    || !POLICY_VERSION_PATTERN.test(authority.ratePolicyVersion)
    || !Number.isSafeInteger(authority.originRequestsPerMinute)
    || authority.originRequestsPerMinute < 1
    || authority.originRequestsPerMinute > MAX_REQUESTS_PER_MINUTE
    || !Number.isSafeInteger(authority.originBurst)
    || authority.originBurst < 1
    || authority.originBurst > MAX_BURST
    || authority.originBurst > authority.originRequestsPerMinute
  ) {
    throw new TypeError("Crawler origin rate authority is invalid.");
  }
  return authority;
}

function requireHostname(value: string): string {
  const normalized = value.toLowerCase();
  if (value !== normalized || !HOSTNAME_PATTERN.test(normalized)) {
    throw new TypeError("Crawler origin hostname is invalid.");
  }
  return normalized;
}

function policyName(version: string): string {
  const digest = createHash("sha256")
    .update("paperpilot:crawler-origin-rate-policy:v1\0", "utf8")
    .update(version, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `crawler-origin:${digest}`;
}

export async function consumeCrawlerOriginRequestRate(
  input: {
    hostname: string;
    authority: CrawlerOriginRateAuthority;
  },
): Promise<RateLimitConsumption> {
  const authority = requireAuthority(input.authority);
  const hostname = requireHostname(input.hostname);
  const { consumeRateLimits } = await import("@/server/rate-limit/store");
  return consumeRateLimits([{
    policy: {
      name: policyName(authority.ratePolicyVersion),
      algorithm: "token-bucket",
      capacity: authority.originBurst,
      refillTokens: authority.originRequestsPerMinute,
      refillIntervalSeconds: 60,
    },
    subject: { scope: "origin", identifier: hostname },
  }]);
}

export async function requireCrawlerOriginRequestRate(
  input: {
    hostname: string;
    authority: CrawlerOriginRateAuthority;
  },
): Promise<void> {
  const consumption = await consumeCrawlerOriginRequestRate(input);
  if (consumption.allowed) return;
  const violation = consumption.evaluations.find((evaluation) => !evaluation.allowed);
  const retryAfterSeconds = violation?.retryAfterSeconds ?? 1;
  throw new CrawlerOriginRateLimitError(
    retryAfterSeconds,
    new Date(consumption.evaluatedAtMs + retryAfterSeconds * 1_000),
  );
}
