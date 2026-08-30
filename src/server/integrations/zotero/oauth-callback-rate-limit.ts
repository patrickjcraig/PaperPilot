import "server-only";

import type { RateLimitConsumption, TokenBucketRateLimitPolicy } from "@/server/rate-limit/core";
import { clientIpForRateLimit } from "@/server/rate-limit/routes";
import { consumeRateLimits } from "@/server/rate-limit/store";

const DEFAULT_CALLBACKS_PER_MINUTE = 120;
const MAX_CALLBACKS_PER_MINUTE = 1_000_000;

function callbackCapacity(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const configured = environment.PAPERPILOT_ZOTERO_CALLBACK_IP_PER_MINUTE?.trim();
  if (!configured) return DEFAULT_CALLBACKS_PER_MINUTE;
  const value = Number(configured);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CALLBACKS_PER_MINUTE
  ) {
    throw new Error(
      "PAPERPILOT_ZOTERO_CALLBACK_IP_PER_MINUTE must be a positive bounded integer.",
    );
  }
  return value;
}

export function zoteroOAuthCallbackIpPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TokenBucketRateLimitPolicy {
  const capacity = callbackCapacity(environment);
  return {
    name: "zotero-oauth-callback.ip.burst",
    algorithm: "token-bucket",
    capacity,
    refillTokens: capacity,
    refillIntervalSeconds: 60,
  };
}

/** Cheap pre-session callback flood boundary; tenant quotas are checked later. */
export async function consumeZoteroOAuthCallbackIpRateLimit(
  request: Request,
): Promise<RateLimitConsumption> {
  const ip = clientIpForRateLimit(request);
  if (!ip) {
    return { allowed: true, evaluatedAtMs: Date.now(), evaluations: [] };
  }
  return consumeRateLimits([{
    policy: zoteroOAuthCallbackIpPolicy(),
    subject: { scope: "ip", identifier: ip },
  }]);
}
