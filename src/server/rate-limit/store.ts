import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  evaluateRateLimitBoundary,
  normalizeRateLimitBoundary,
  parseStoredRateLimitState,
  type RateLimitBoundary,
  type RateLimitConsumption,
} from "./core";

const PRUNE_INTERVAL_MS = 5 * 60 * 1_000;

let nextPruneAtMs = 0;

export interface ConsumeRateLimitsOptions {
  now?: Date;
  secret?: string;
}

export function applicationRateLimitSecret(): string {
  const secret = (
    process.env.PAPERPILOT_RATE_LIMIT_SECRET
    ?? process.env.BETTER_AUTH_SECRET
    ?? ""
  ).trim();
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "PAPERPILOT_RATE_LIMIT_SECRET or BETTER_AUTH_SECRET must contain at least 32 bytes.",
    );
  }
  return secret;
}

async function pruneExpiredBuckets(now: Date): Promise<void> {
  const nowMs = now.getTime();
  if (nowMs < nextPruneAtMs) return;
  nextPruneAtMs = nowMs + PRUNE_INTERVAL_MS;
  await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lte: now } } });
}

/**
 * Atomically checks and consumes every supplied boundary.
 *
 * PostgreSQL transaction-scoped advisory locks are acquired in deterministic
 * key order before rows are read. That protects both existing and not-yet-
 * created buckets across every application instance. If any boundary denies
 * the request, none of the otherwise-available boundaries are consumed.
 */
export async function consumeRateLimits(
  boundaries: readonly RateLimitBoundary[],
  options: ConsumeRateLimitsOptions = {},
): Promise<RateLimitConsumption> {
  const configuredNowMs = options.now?.getTime();
  if (
    configuredNowMs !== undefined
    && (!Number.isSafeInteger(configuredNowMs) || configuredNowMs < 0)
  ) {
    throw new TypeError("Rate-limit time must be a valid non-negative Date.");
  }
  if (boundaries.length === 0) {
    return {
      allowed: true,
      evaluatedAtMs: configuredNowMs ?? Date.now(),
      evaluations: [],
    };
  }

  const secret = options.secret ?? applicationRateLimitSecret();
  const normalized = boundaries.map((boundary) => normalizeRateLimitBoundary(boundary, secret));
  const uniqueKeys = new Set(normalized.map((boundary) => boundary.key));
  if (uniqueKeys.size !== normalized.length) {
    throw new TypeError("A rate-limit request must not contain duplicate policy/subject boundaries.");
  }
  const sortedKeys = Array.from(uniqueKeys).sort();

  const consumption = await prisma.$transaction(async (transaction) => {
    for (const key of sortedKeys) {
      await transaction.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "locked"
      `;
    }

    // Production decisions use one authoritative PostgreSQL clock so skew
    // between application instances cannot refill or reset a shared bucket
    // early. Tests may inject a deterministic time explicitly.
    const nowMs = configuredNowMs ?? Number((await transaction.$queryRaw<
      Array<{ epochMilliseconds: bigint }>
    >`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "epochMilliseconds"
    `)[0]?.epochMilliseconds);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("PostgreSQL returned an invalid rate-limit clock value.");
    }

    const storedRows = await transaction.rateLimitBucket.findMany({
      where: { key: { in: sortedKeys } },
      select: { key: true, state: true },
    });
    const storedByKey = new Map(storedRows.map((row) => [row.key, row.state]));
    const evaluations = normalized.map((boundary) =>
      evaluateRateLimitBoundary(
        boundary,
        parseStoredRateLimitState(storedByKey.get(boundary.key)),
        nowMs,
      )
    );
    const allowed = evaluations.every((evaluation) => evaluation.allowed);

    if (allowed) {
      for (const evaluation of evaluations) {
        const state = evaluation.nextState as unknown as Prisma.InputJsonValue;
        const expiresAt = new Date(evaluation.expiresAtMs);
        await transaction.rateLimitBucket.upsert({
          where: { key: evaluation.key },
          create: {
            key: evaluation.key,
            policy: evaluation.policy.name,
            state,
            expiresAt,
          },
          update: {
            policy: evaluation.policy.name,
            state,
            expiresAt,
          },
        });
      }
    }

    return { allowed, evaluatedAtMs: nowMs, evaluations };
  });

  await pruneExpiredBuckets(new Date(consumption.evaluatedAtMs));
  return consumption;
}

export async function deleteExpiredRateLimitBuckets(now = new Date()): Promise<number> {
  const result = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lte: now } } });
  nextPruneAtMs = Math.max(nextPruneAtMs, now.getTime() + PRUNE_INTERVAL_MS);
  return result.count;
}
