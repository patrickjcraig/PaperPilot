import "server-only";

import type { BetterAuthOptions } from "better-auth";
import { getIP } from "@better-auth/core/utils/ip";
import {
  type FixedWindowRateLimitPolicy,
  type RateLimitBoundary,
  type RateLimitConsumption,
  type TokenBucketRateLimitPolicy,
} from "./core";
import { paperPilotIpAddressConfig } from "./auth-config";

const MAX_CONFIGURED_LIMIT = 1_000_000_000;

function positiveIntegerEnvironment(
  name: string,
  fallback: number,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = environment[name]?.trim();
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CONFIGURED_LIMIT) {
    throw new Error(`${name} must be a positive integer no greater than ${MAX_CONFIGURED_LIMIT}.`);
  }
  return value;
}

function tokenPolicy(
  name: string,
  capacityEnvironment: string,
  defaultCapacity: number,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TokenBucketRateLimitPolicy {
  const capacity = positiveIntegerEnvironment(
    capacityEnvironment,
    defaultCapacity,
    environment,
  );
  return {
    name,
    algorithm: "token-bucket",
    capacity,
    refillTokens: capacity,
    refillIntervalSeconds: 60,
  };
}

function dailyPolicy(
  name: string,
  limitEnvironment: string,
  defaultLimit: number,
): FixedWindowRateLimitPolicy {
  return {
    name,
    algorithm: "fixed-window",
    limit: positiveIntegerEnvironment(limitEnvironment, defaultLimit),
    windowSeconds: 24 * 60 * 60,
  };
}

/**
 * Reader budgets are request-admission limits rather than provider-spend
 * limits, so they intentionally use burst buckets without a daily ceiling.
 * The environment argument keeps policy validation deterministic in tests;
 * production policies are still fixed once this module is loaded.
 */
export function readerReadRateLimitPolicies(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return {
    readerIpBurst: tokenPolicy(
      "reader.ip.burst",
      "PAPERPILOT_READER_IP_PER_MINUTE",
      600,
      environment,
    ),
    readerUserBurst: tokenPolicy(
      "reader.user.burst",
      "PAPERPILOT_READER_USER_PER_MINUTE",
      60,
      environment,
    ),
    readerWorkspaceBurst: tokenPolicy(
      "reader.workspace.burst",
      "PAPERPILOT_READER_WORKSPACE_PER_MINUTE",
      300,
      environment,
    ),
  } as const;
}

const readerPolicies = readerReadRateLimitPolicies();

/**
 * Initial production budgets. Every value can be tightened or expanded per
 * deployment without a code change. Daily windows begin with the subject's
 * first request rather than at a shared UTC boundary, avoiding a reset spike.
 */
export const routeRateLimitPolicies = {
  discoverIpBurst: tokenPolicy(
    "discover.ip.burst",
    "PAPERPILOT_DISCOVER_IP_PER_MINUTE",
    60,
  ),
  discoverUserBurst: tokenPolicy(
    "discover.user.burst",
    "PAPERPILOT_DISCOVER_USER_PER_MINUTE",
    30,
  ),
  discoverUserDaily: dailyPolicy(
    "discover.user.daily",
    "PAPERPILOT_DISCOVER_USER_PER_DAY",
    250,
  ),
  discoverWorkspaceDaily: dailyPolicy(
    "discover.workspace.daily",
    "PAPERPILOT_DISCOVER_WORKSPACE_PER_DAY",
    1_000,
  ),
  workspaceIpBurst: tokenPolicy(
    "workspace-write.ip.burst",
    "PAPERPILOT_WORKSPACE_WRITE_IP_PER_MINUTE",
    180,
  ),
  workspaceUserBurst: tokenPolicy(
    "workspace-write.user.burst",
    "PAPERPILOT_WORKSPACE_WRITE_USER_PER_MINUTE",
    90,
  ),
  workspaceBurst: tokenPolicy(
    "workspace-write.workspace.burst",
    "PAPERPILOT_WORKSPACE_WRITE_PER_MINUTE",
    300,
  ),
  ...readerPolicies,
} as const;

const ipResolutionOptions = {
  advanced: { ipAddress: paperPilotIpAddressConfig },
} satisfies BetterAuthOptions;

export function clientIpForRateLimit(request: Request): string | null {
  return getIP(request, ipResolutionOptions);
}

export interface DiscoverRateLimitInput {
  request: Request;
  userId?: string | null;
  workspaceId?: string | null;
}

export function discoverRateLimitBoundaries(input: DiscoverRateLimitInput): RateLimitBoundary[] {
  const boundaries: RateLimitBoundary[] = [];
  const ip = clientIpForRateLimit(input.request);
  if (ip) {
    boundaries.push({
      policy: routeRateLimitPolicies.discoverIpBurst,
      subject: { scope: "ip", identifier: ip },
    });
  }
  if (input.userId) {
    boundaries.push(
      {
        policy: routeRateLimitPolicies.discoverUserBurst,
        subject: { scope: "user", identifier: input.userId },
      },
      {
        policy: routeRateLimitPolicies.discoverUserDaily,
        subject: { scope: "user", identifier: input.userId },
      },
    );
  }
  if (input.workspaceId) {
    boundaries.push({
      policy: routeRateLimitPolicies.discoverWorkspaceDaily,
      subject: { scope: "workspace", identifier: input.workspaceId },
    });
  }
  return boundaries;
}

export async function consumeDiscoverRateLimit(
  input: DiscoverRateLimitInput,
): Promise<RateLimitConsumption> {
  const [{ prisma }, { consumeRateLimits }] = await Promise.all([
    import("@/lib/prisma"),
    import("./store"),
  ]);
  let workspaceId = input.workspaceId;
  if (input.userId) {
    const activeMembership = workspaceId
      ? await prisma.member.findUnique({
          where: {
            organizationId_userId: {
              organizationId: workspaceId,
              userId: input.userId,
            },
          },
          select: { organizationId: true },
        })
      : null;
    workspaceId = activeMembership?.organizationId;
    if (!workspaceId) {
      workspaceId = (await prisma.organization.findUnique({
        where: { personalOwnerId: input.userId },
        select: { id: true },
      }))?.id;
    }
  }
  return consumeRateLimits(discoverRateLimitBoundaries({ ...input, workspaceId }));
}

export interface WorkspaceMutationRateLimitInput {
  request: Request;
  userId: string;
  workspaceId: string;
}

export interface AuthenticatedMutationRateLimitInput {
  request: Request;
  userId: string;
}

/**
 * Mutation admission for authenticated commands that are not yet members of
 * a workspace (for example, deciding an invitation). It deliberately omits a
 * tenant boundary so a former invitee cannot drain that tenant's shared budget.
 */
export function authenticatedMutationRateLimitBoundaries(
  input: AuthenticatedMutationRateLimitInput,
): RateLimitBoundary[] {
  const boundaries: RateLimitBoundary[] = [{
    policy: routeRateLimitPolicies.workspaceUserBurst,
    subject: { scope: "user", identifier: input.userId },
  }];
  const ip = clientIpForRateLimit(input.request);
  if (ip) {
    boundaries.push({
      policy: routeRateLimitPolicies.workspaceIpBurst,
      subject: { scope: "ip", identifier: ip },
    });
  }
  return boundaries;
}

export async function consumeAuthenticatedMutationRateLimit(
  input: AuthenticatedMutationRateLimitInput,
): Promise<RateLimitConsumption> {
  const { consumeRateLimits } = await import("./store");
  return consumeRateLimits(authenticatedMutationRateLimitBoundaries(input));
}

export function workspaceMutationRateLimitBoundaries(
  input: WorkspaceMutationRateLimitInput,
): RateLimitBoundary[] {
  const boundaries: RateLimitBoundary[] = [
    {
      policy: routeRateLimitPolicies.workspaceUserBurst,
      subject: { scope: "user", identifier: input.userId },
    },
    {
      policy: routeRateLimitPolicies.workspaceBurst,
      subject: { scope: "workspace", identifier: input.workspaceId },
    },
  ];
  const ip = clientIpForRateLimit(input.request);
  if (ip) {
    boundaries.push({
      policy: routeRateLimitPolicies.workspaceIpBurst,
      subject: { scope: "ip", identifier: ip },
    });
  }
  return boundaries;
}

export async function consumeWorkspaceMutationRateLimit(
  input: WorkspaceMutationRateLimitInput,
): Promise<RateLimitConsumption> {
  const { consumeRateLimits } = await import("./store");
  return consumeRateLimits(workspaceMutationRateLimitBoundaries(input));
}

export interface ReaderReadRateLimitInput {
  request: Request;
  userId: string;
  /** Must be the canonical organization ID returned by a membership check. */
  workspaceId: string;
}

interface TrustedReaderRateLimitSubjects {
  userId: string;
  workspaceId: string;
  trustedClientIp: string | null;
}

/** @internal Pure subject composition after trusted IP resolution. */
export function readerReadRateLimitBoundariesForTrustedSubjects(
  input: TrustedReaderRateLimitSubjects,
): RateLimitBoundary[] {
  const boundaries: RateLimitBoundary[] = [
    {
      policy: routeRateLimitPolicies.readerUserBurst,
      subject: { scope: "user", identifier: input.userId },
    },
    {
      policy: routeRateLimitPolicies.readerWorkspaceBurst,
      subject: { scope: "workspace", identifier: input.workspaceId },
    },
  ];
  if (input.trustedClientIp) {
    boundaries.push({
      policy: routeRateLimitPolicies.readerIpBurst,
      subject: { scope: "ip", identifier: input.trustedClientIp },
    });
  }
  return boundaries;
}

/**
 * Construct Reader admission boundaries from authenticated, authorized
 * identities. Callers must verify workspace membership before invoking this
 * helper so an attacker cannot drain a guessed tenant's shared budget.
 */
export function readerReadRateLimitBoundaries(
  input: ReaderReadRateLimitInput,
): RateLimitBoundary[] {
  return readerReadRateLimitBoundariesForTrustedSubjects({
    userId: input.userId,
    workspaceId: input.workspaceId,
    trustedClientIp: clientIpForRateLimit(input.request),
  });
}

/** Atomically consume all configured Reader user/workspace/trusted-IP scopes. */
export async function consumeReaderReadRateLimit(
  input: ReaderReadRateLimitInput,
): Promise<RateLimitConsumption> {
  const { consumeRateLimits } = await import("./store");
  return consumeRateLimits(readerReadRateLimitBoundaries(input));
}
