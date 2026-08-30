import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { HttpProblem } from "@/server/http/problem";

export interface LiveRetainedAuditPrincipal {
  id: string;
}

/**
 * Resolve the one live retained identity for an organization member and hold a
 * share lock through the caller's transaction. Account deletion must update
 * this row in order to pseudonymize it, so the lock closes the race between a
 * human authority write and account erasure.
 *
 * Callers must invoke this only from their serializable mutation transaction,
 * after their organization revision compare-and-swap has succeeded. A first
 * writer race is intentionally surfaced as Prisma P2002/P2034 so the caller's
 * transaction retry restarts from a clean snapshot.
 */
export async function resolveLiveRetainedAuditPrincipal(
  transaction: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
): Promise<LiveRetainedAuditPrincipal> {
  const existing = await transaction.retainedAuditPrincipal.findUnique({
    where: {
      organizationId_liveUserId: { organizationId, liveUserId: userId },
    },
    select: { id: true },
  });
  const principal = existing ?? await transaction.retainedAuditPrincipal.create({
    data: { organizationId, liveUserId: userId },
    select: { id: true },
  });

  const locked = await transaction.$queryRaw<Array<{
    id: string;
    liveUserId: string | null;
    pseudonymizedAt: Date | null;
  }>>(Prisma.sql`
    SELECT "id", "liveUserId", "pseudonymizedAt"
    FROM "public"."RetainedAuditPrincipal"
    WHERE "organizationId" = ${organizationId}
      AND "id" = ${principal.id}::uuid
    FOR SHARE
  `);
  const live = locked[0];
  if (
    locked.length !== 1
    || !live
    || live.liveUserId !== userId
    || live.pseudonymizedAt !== null
  ) {
    throw new HttpProblem(
      409,
      "retained_actor_not_live",
      "The account can no longer authorize retained workspace activity.",
    );
  }
  return { id: live.id };
}
