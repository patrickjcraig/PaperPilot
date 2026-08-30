import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";
import { acquireWorkspaceMembershipAuthorityShared } from "./membership-lock";

export interface WorkspaceActivationResult {
  schemaVersion: 1;
  workspaceId: string;
}

/**
 * Repoint one live session while holding the user's workspace membership
 * authority. READ COMMITTED is intentional: if revocation already owns the
 * exclusive advisory lock, the membership read after our wait must see the
 * committed deletion rather than a snapshot taken before that wait.
 */
export async function activateWorkspaceForSession(
  userId: string,
  sessionId: string,
  workspaceId: string,
): Promise<WorkspaceActivationResult> {
  return prisma.$transaction(async (transaction) => {
    await acquireWorkspaceMembershipAuthorityShared(transaction, workspaceId, userId);
    const membership = await transaction.member.findUnique({
      where: { organizationId_userId: { organizationId: workspaceId, userId } },
      select: { id: true },
    });
    if (!membership) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }

    const updated = await transaction.session.updateMany({
      where: {
        id: sessionId,
        userId,
        expiresAt: { gt: new Date() },
      },
      data: { activeOrganizationId: workspaceId, activeTeamId: null },
    });
    if (updated.count !== 1) {
      throw new HttpProblem(401, "authentication_required", "Sign in to access this workspace.");
    }
    return { schemaVersion: 1, workspaceId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

