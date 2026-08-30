import assert from "node:assert/strict";
import { test } from "node:test";
import { betterAuthRateLimitConfig } from "./auth-config";
import {
  evaluateRateLimitBoundary,
  normalizeRateLimitBoundary,
  rateLimitBucketKey,
  rateLimitExceededResponse,
  rateLimitHeaders,
  type FixedWindowRateLimitPolicy,
  type RateLimitConsumption,
  type TokenBucketRateLimitPolicy,
} from "./core";

const secret = "rate-limit-test-secret-that-is-longer-than-32-bytes";

const fixedPolicy: FixedWindowRateLimitPolicy = {
  name: "test.fixed",
  algorithm: "fixed-window",
  limit: 3,
  windowSeconds: 10,
};

test("Better Auth uses durable database storage with explicit production-safe defaults", () => {
  assert.equal(betterAuthRateLimitConfig.enabled, true);
  assert.equal(betterAuthRateLimitConfig.storage, "database");
  assert.equal(betterAuthRateLimitConfig.window, 60);
  assert.equal(betterAuthRateLimitConfig.max, 300);
});

test("bucket keys are domain-separated HMACs and never retain raw subject identifiers", () => {
  const userIdentifier = "user-secret-identity@example.test";
  const userKey = rateLimitBucketKey(
    fixedPolicy,
    { scope: "user", identifier: userIdentifier },
    secret,
  );
  const workspaceKey = rateLimitBucketKey(
    fixedPolicy,
    { scope: "workspace", identifier: userIdentifier },
    secret,
  );

  assert.match(userKey, /^v1:test\.fixed:user:[A-Za-z0-9_-]{43}$/);
  assert.ok(!userKey.includes(userIdentifier));
  assert.notEqual(userKey, workspaceKey);
});

test("fixed windows enforce the exact boundary and reset at the window edge", () => {
  const boundary = normalizeRateLimitBoundary({
    policy: fixedPolicy,
    subject: { scope: "user", identifier: "fixed-user" },
  }, secret);
  const startedAt = 2_000_000_000_000;

  const first = evaluateRateLimitBoundary(boundary, undefined, startedAt);
  const second = evaluateRateLimitBoundary(boundary, first.nextState, startedAt + 1);
  const third = evaluateRateLimitBoundary(boundary, second.nextState, startedAt + 2);
  const rejected = evaluateRateLimitBoundary(boundary, third.nextState, startedAt + 3);
  const reset = evaluateRateLimitBoundary(
    boundary,
    third.nextState,
    startedAt + fixedPolicy.windowSeconds * 1_000,
  );

  assert.deepEqual(
    [first.allowed, second.allowed, third.allowed, rejected.allowed, reset.allowed],
    [true, true, true, false, true],
  );
  assert.equal(third.remaining, 0);
  assert.equal(rejected.remaining, 0);
  assert.equal(rejected.retryAfterSeconds, 10);
  assert.equal(reset.remaining, 2);
  assert.deepEqual(reset.nextState, {
    algorithm: "fixed-window",
    count: 1,
    windowStartedAtMs: startedAt + fixedPolicy.windowSeconds * 1_000,
  });
});

test("token buckets refill continuously and report an actionable retry delay", () => {
  const policy: TokenBucketRateLimitPolicy = {
    name: "test.token",
    algorithm: "token-bucket",
    capacity: 2,
    refillTokens: 1,
    refillIntervalSeconds: 10,
  };
  const initialBoundary = normalizeRateLimitBoundary({
    policy,
    subject: { scope: "ip", identifier: "192.0.2.25" },
    cost: 2,
  }, secret);
  const singleTokenBoundary = normalizeRateLimitBoundary({
    policy,
    subject: { scope: "ip", identifier: "192.0.2.25" },
  }, secret);
  const startedAt = 2_000_000_000_000;

  const drained = evaluateRateLimitBoundary(initialBoundary, undefined, startedAt);
  const rejected = evaluateRateLimitBoundary(
    singleTokenBoundary,
    drained.nextState,
    startedAt + 1_000,
  );
  const refilled = evaluateRateLimitBoundary(
    singleTokenBoundary,
    drained.nextState,
    startedAt + 10_000,
  );

  assert.equal(drained.allowed, true);
  assert.equal(drained.remaining, 0);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterSeconds, 9);
  assert.equal(refilled.allowed, true);
  assert.equal(refilled.remaining, 0);
});

test("429 responses include conventional quota and Retry-After metadata", async () => {
  const boundary = normalizeRateLimitBoundary({
    policy: { ...fixedPolicy, limit: 1 },
    subject: { scope: "workspace", identifier: "workspace-429" },
  }, secret);
  const now = 2_000_000_000_000;
  const first = evaluateRateLimitBoundary(boundary, undefined, now);
  const rejected = evaluateRateLimitBoundary(boundary, first.nextState, now + 1_000);
  const consumption: RateLimitConsumption = {
    allowed: false,
    evaluatedAtMs: now + 1_000,
    evaluations: [rejected],
  };

  const headers = rateLimitHeaders(consumption);
  assert.equal(headers.get("RateLimit-Limit"), "1");
  assert.equal(headers.get("RateLimit-Remaining"), "0");
  assert.equal(headers.get("RateLimit-Reset"), "9");
  assert.equal(headers.get("Retry-After"), "9");

  const response = rateLimitExceededResponse(consumption, "request-429");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "9");
  assert.equal(response.headers.get("X-Request-Id"), "request-429");
  assert.deepEqual(await response.json(), {
    error: {
      code: "rate_limit_exceeded",
      message: "This request budget is temporarily exhausted. Try again after the retry delay.",
      requestId: "request-429",
      retryAfterSeconds: 9,
      retryAt: new Date(now + 10_000).toISOString(),
      policy: "test.fixed",
      scope: "workspace",
    },
  });
});
