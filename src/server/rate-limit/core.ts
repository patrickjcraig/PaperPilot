import { createHmac } from "node:crypto";

export const RATE_LIMIT_KEY_VERSION = "v1" as const;

const MAX_POLICY_NAME_LENGTH = 100;
const MAX_SUBJECT_IDENTIFIER_LENGTH = 1_000;
const MAX_LIMIT = 1_000_000_000;
const MAX_WINDOW_SECONDS = 365 * 24 * 60 * 60;
const POLICY_NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const FLOAT_TOLERANCE = 1e-9;

export type RateLimitScope = "user" | "workspace" | "ip" | "origin";

export interface RateLimitSubject {
  scope: RateLimitScope;
  identifier: string;
}

export interface FixedWindowRateLimitPolicy {
  name: string;
  algorithm: "fixed-window";
  limit: number;
  windowSeconds: number;
}

export interface TokenBucketRateLimitPolicy {
  name: string;
  algorithm: "token-bucket";
  capacity: number;
  refillTokens: number;
  refillIntervalSeconds: number;
}

export type RateLimitPolicy = FixedWindowRateLimitPolicy | TokenBucketRateLimitPolicy;

export interface RateLimitBoundary {
  policy: RateLimitPolicy;
  subject: RateLimitSubject;
  cost?: number;
}

export interface FixedWindowRateLimitState {
  algorithm: "fixed-window";
  count: number;
  windowStartedAtMs: number;
}

export interface TokenBucketRateLimitState {
  algorithm: "token-bucket";
  tokens: number;
  lastRefillAtMs: number;
}

export type StoredRateLimitState = FixedWindowRateLimitState | TokenBucketRateLimitState;

export interface NormalizedRateLimitBoundary extends RateLimitBoundary {
  cost: number;
  key: string;
}

export interface RateLimitEvaluation {
  allowed: boolean;
  key: string;
  policy: RateLimitPolicy;
  scope: RateLimitScope;
  limit: number;
  remaining: number;
  retryAfterSeconds: number | null;
  retryAtMs: number | null;
  resetAtMs: number;
  expiresAtMs: number;
  nextState: StoredRateLimitState;
}

export interface RateLimitConsumption {
  allowed: boolean;
  evaluatedAtMs: number;
  evaluations: RateLimitEvaluation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: number, name: string, maximum = MAX_LIMIT): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}.`);
  }
}

export function assertRateLimitPolicy(policy: RateLimitPolicy): void {
  if (
    !POLICY_NAME_PATTERN.test(policy.name)
    || policy.name.length > MAX_POLICY_NAME_LENGTH
  ) {
    throw new TypeError(
      `Rate-limit policy names must match ${POLICY_NAME_PATTERN} and contain at most ${MAX_POLICY_NAME_LENGTH} characters.`,
    );
  }

  if (policy.algorithm === "fixed-window") {
    positiveSafeInteger(policy.limit, `${policy.name}.limit`);
    positiveSafeInteger(
      policy.windowSeconds,
      `${policy.name}.windowSeconds`,
      MAX_WINDOW_SECONDS,
    );
    return;
  }

  positiveSafeInteger(policy.capacity, `${policy.name}.capacity`);
  positiveSafeInteger(policy.refillTokens, `${policy.name}.refillTokens`);
  positiveSafeInteger(
    policy.refillIntervalSeconds,
    `${policy.name}.refillIntervalSeconds`,
    MAX_WINDOW_SECONDS,
  );
}

export function rateLimitPolicyLimit(policy: RateLimitPolicy): number {
  return policy.algorithm === "fixed-window" ? policy.limit : policy.capacity;
}

export function rateLimitBucketKey(
  policy: RateLimitPolicy,
  subject: RateLimitSubject,
  secret: string,
): string {
  assertRateLimitPolicy(policy);
  if (!new Set<RateLimitScope>(["user", "workspace", "ip", "origin"]).has(subject.scope)) {
    throw new TypeError("Rate-limit subjects must use a supported scope.");
  }
  if (
    !subject.identifier.trim()
    || subject.identifier.length > MAX_SUBJECT_IDENTIFIER_LENGTH
  ) {
    throw new TypeError(
      `Rate-limit subject identifiers must contain 1–${MAX_SUBJECT_IDENTIFIER_LENGTH} characters.`,
    );
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("The rate-limit key secret must contain at least 32 bytes.");
  }

  const digest = createHmac("sha256", secret)
    .update("paperpilot-rate-limit\0", "utf8")
    .update(RATE_LIMIT_KEY_VERSION, "utf8")
    .update("\0", "utf8")
    .update(policy.name, "utf8")
    .update("\0", "utf8")
    .update(subject.scope, "utf8")
    .update("\0", "utf8")
    .update(subject.identifier, "utf8")
    .digest("base64url");

  return `${RATE_LIMIT_KEY_VERSION}:${policy.name}:${subject.scope}:${digest}`;
}

export function normalizeRateLimitBoundary(
  boundary: RateLimitBoundary,
  secret: string,
): NormalizedRateLimitBoundary {
  assertRateLimitPolicy(boundary.policy);
  const cost = boundary.cost ?? 1;
  positiveSafeInteger(cost, `${boundary.policy.name}.cost`);
  const limit = rateLimitPolicyLimit(boundary.policy);
  if (cost > limit) {
    throw new TypeError(`${boundary.policy.name}.cost must not exceed its limit of ${limit}.`);
  }

  return {
    ...boundary,
    cost,
    key: rateLimitBucketKey(boundary.policy, boundary.subject, secret),
  };
}

export function parseStoredRateLimitState(value: unknown): StoredRateLimitState | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.algorithm === "fixed-window"
    && Number.isSafeInteger(value.count)
    && (value.count as number) >= 0
    && Number.isSafeInteger(value.windowStartedAtMs)
    && (value.windowStartedAtMs as number) >= 0
  ) {
    return {
      algorithm: "fixed-window",
      count: value.count as number,
      windowStartedAtMs: value.windowStartedAtMs as number,
    };
  }
  if (
    value.algorithm === "token-bucket"
    && typeof value.tokens === "number"
    && Number.isFinite(value.tokens)
    && value.tokens >= 0
    && Number.isSafeInteger(value.lastRefillAtMs)
    && (value.lastRefillAtMs as number) >= 0
  ) {
    return {
      algorithm: "token-bucket",
      tokens: value.tokens,
      lastRefillAtMs: value.lastRefillAtMs as number,
    };
  }
  return undefined;
}

function roundedTokens(value: number, capacity: number): number {
  return Math.max(0, Math.min(capacity, Number(value.toFixed(12))));
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000));
}

function evaluateFixedWindow(
  boundary: NormalizedRateLimitBoundary & { policy: FixedWindowRateLimitPolicy },
  storedState: StoredRateLimitState | undefined,
  nowMs: number,
): RateLimitEvaluation {
  const windowMs = boundary.policy.windowSeconds * 1_000;
  let windowStartedAtMs = nowMs;
  let count = 0;

  if (
    storedState?.algorithm === "fixed-window"
    && storedState.windowStartedAtMs <= nowMs
    && nowMs < storedState.windowStartedAtMs + windowMs
  ) {
    windowStartedAtMs = storedState.windowStartedAtMs;
    count = storedState.count;
  }

  const resetAtMs = windowStartedAtMs + windowMs;
  const allowed = count + boundary.cost <= boundary.policy.limit;
  const nextCount = allowed ? count + boundary.cost : count;
  const retryAfter = allowed ? null : retrySeconds(resetAtMs - nowMs);

  return {
    allowed,
    key: boundary.key,
    policy: boundary.policy,
    scope: boundary.subject.scope,
    limit: boundary.policy.limit,
    remaining: Math.max(0, boundary.policy.limit - nextCount),
    retryAfterSeconds: retryAfter,
    retryAtMs: retryAfter === null ? null : nowMs + retryAfter * 1_000,
    resetAtMs,
    expiresAtMs: resetAtMs,
    nextState: {
      algorithm: "fixed-window",
      count: nextCount,
      windowStartedAtMs,
    },
  };
}

function evaluateTokenBucket(
  boundary: NormalizedRateLimitBoundary & { policy: TokenBucketRateLimitPolicy },
  storedState: StoredRateLimitState | undefined,
  nowMs: number,
): RateLimitEvaluation {
  const refillIntervalMs = boundary.policy.refillIntervalSeconds * 1_000;
  const tokensPerMs = boundary.policy.refillTokens / refillIntervalMs;
  let availableTokens = boundary.policy.capacity;

  if (
    storedState?.algorithm === "token-bucket"
    && storedState.lastRefillAtMs <= nowMs
  ) {
    const elapsedMs = nowMs - storedState.lastRefillAtMs;
    availableTokens = roundedTokens(
      storedState.tokens + elapsedMs * tokensPerMs,
      boundary.policy.capacity,
    );
  }

  const allowed = availableTokens + FLOAT_TOLERANCE >= boundary.cost;
  const nextTokens = roundedTokens(
    allowed ? availableTokens - boundary.cost : availableTokens,
    boundary.policy.capacity,
  );
  const missingForRequest = Math.max(0, boundary.cost - availableTokens);
  const retryAfter = allowed
    ? null
    : retrySeconds(missingForRequest / tokensPerMs);
  const millisecondsUntilFull = Math.max(
    1,
    Math.ceil((boundary.policy.capacity - nextTokens) / tokensPerMs),
  );
  const resetAtMs = nowMs + millisecondsUntilFull;

  return {
    allowed,
    key: boundary.key,
    policy: boundary.policy,
    scope: boundary.subject.scope,
    limit: boundary.policy.capacity,
    remaining: Math.max(0, Math.floor(nextTokens + FLOAT_TOLERANCE)),
    retryAfterSeconds: retryAfter,
    retryAtMs: retryAfter === null ? null : nowMs + retryAfter * 1_000,
    resetAtMs,
    expiresAtMs: resetAtMs,
    nextState: {
      algorithm: "token-bucket",
      tokens: nextTokens,
      lastRefillAtMs: nowMs,
    },
  };
}

export function evaluateRateLimitBoundary(
  boundary: NormalizedRateLimitBoundary,
  storedState: StoredRateLimitState | undefined,
  nowMs: number,
): RateLimitEvaluation {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("Rate-limit evaluation time must be a non-negative epoch millisecond.");
  }
  if (boundary.policy.algorithm === "fixed-window") {
    return evaluateFixedWindow(
      boundary as NormalizedRateLimitBoundary & { policy: FixedWindowRateLimitPolicy },
      storedState,
      nowMs,
    );
  }
  return evaluateTokenBucket(
    boundary as NormalizedRateLimitBoundary & { policy: TokenBucketRateLimitPolicy },
    storedState,
    nowMs,
  );
}

export function bindingRateLimitEvaluation(
  consumption: RateLimitConsumption,
): RateLimitEvaluation | undefined {
  const violations = consumption.evaluations.filter((evaluation) => !evaluation.allowed);
  if (violations.length > 0) {
    return violations.reduce((binding, candidate) =>
      (candidate.retryAfterSeconds ?? 0) > (binding.retryAfterSeconds ?? 0)
        ? candidate
        : binding
    );
  }

  return consumption.evaluations.reduce<RateLimitEvaluation | undefined>((binding, candidate) => {
    if (!binding) return candidate;
    const candidateRatio = candidate.remaining / candidate.limit;
    const bindingRatio = binding.remaining / binding.limit;
    if (candidateRatio !== bindingRatio) return candidateRatio < bindingRatio ? candidate : binding;
    return candidate.resetAtMs < binding.resetAtMs ? candidate : binding;
  }, undefined);
}

export function rateLimitHeaders(consumption: RateLimitConsumption): Headers {
  const headers = new Headers();
  const binding = bindingRateLimitEvaluation(consumption);
  if (!binding) return headers;

  headers.set("RateLimit-Limit", String(binding.limit));
  headers.set("RateLimit-Remaining", String(binding.remaining));
  headers.set(
    "RateLimit-Reset",
    String(Math.max(0, Math.ceil((binding.resetAtMs - consumption.evaluatedAtMs) / 1_000))),
  );
  headers.set("RateLimit-Policy", `"${binding.policy.name}";scope="${binding.scope}"`);
  if (!consumption.allowed) {
    headers.set("Retry-After", String(binding.retryAfterSeconds ?? 1));
  }
  return headers;
}

export function rateLimitExceededResponse(
  consumption: RateLimitConsumption,
  requestId: string,
): Response {
  if (consumption.allowed) {
    throw new TypeError("An allowed rate-limit result cannot produce a 429 response.");
  }
  const binding = bindingRateLimitEvaluation(consumption);
  const retryAfterSeconds = binding?.retryAfterSeconds ?? 1;
  const headers = rateLimitHeaders(consumption);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Request-Id", requestId);

  return Response.json(
    {
      error: {
        code: "rate_limit_exceeded",
        message: "This request budget is temporarily exhausted. Try again after the retry delay.",
        requestId,
        retryAfterSeconds,
        retryAt: new Date(consumption.evaluatedAtMs + retryAfterSeconds * 1_000).toISOString(),
        policy: binding?.policy.name,
        scope: binding?.scope,
      },
    },
    { status: 429, headers },
  );
}
