import "server-only";

import { Prisma } from "@/generated/prisma/client";

const MEMBERSHIP_AUTHORITY_LOCK_DOMAIN = "paperpilot:workspace-membership-authority:v1";

/**
 * One stable PostgreSQL advisory-lock namespace for a user's authority inside
 * one workspace. The separator is safe because application IDs are bounded
 * opaque values; the domain prefix prevents collisions with command locks.
 */
export function workspaceMembershipAuthorityLockKey(
  workspaceId: string,
  userId: string,
): string {
  return `${MEMBERSHIP_AUTHORITY_LOCK_DOMAIN}\u001f${workspaceId}\u001f${userId}`;
}

/**
 * Hold a shared authority lease through the caller's transaction. Existing
 * workspace mutation services should acquire this before accepting a Member
 * row as authorization and retain it until their write commits.
 */
export async function acquireWorkspaceMembershipAuthorityShared(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const key = workspaceMembershipAuthorityLockKey(workspaceId, userId);
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))::text
  `);

  // At READ COMMITTED the authoritative Member query that follows gets a new
  // statement snapshot after the advisory wait. REPEATABLE READ and
  // SERIALIZABLE instead freeze their snapshot at the first SELECT above. If
  // an exclusive holder changed or removed the Member while this transaction
  // waited, a plain re-read could therefore still see stale authority.
  //
  // A locking read closes that gap without weakening callers' isolation: on
  // a fresh snapshot it protects the current role through commit, while on a
  // stale snapshot PostgreSQL aborts with a serialization failure because the
  // row changed after the snapshot began. Callers still perform the
  // authoritative typed Member re-read immediately after this helper.
  await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Member"
    WHERE "organizationId" = ${workspaceId}
      AND "userId" = ${userId}
    FOR SHARE
  `);
}

/**
 * Hold an exclusive authority lease through the caller's transaction. Every
 * PaperPilot membership creation, role change, and removal must acquire this
 * before it changes the corresponding Member row.
 */
export async function acquireWorkspaceMembershipAuthorityExclusive(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const key = workspaceMembershipAuthorityLockKey(workspaceId, userId);
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text
  `);
}
