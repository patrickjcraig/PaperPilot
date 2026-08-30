import "server-only";

import type { Organization, Member, User } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpProblem } from "@/server/http/problem";

export type WorkspaceMembership = Member & { organization: Organization };

function personalSlug(userId: string): string {
  return `personal-${userId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

export async function ensurePersonalWorkspace(
  user: Pick<User, "id" | "name">,
): Promise<WorkspaceMembership> {
  return prisma.$transaction(async (transaction) => {
    const organization = await transaction.organization.upsert({
      where: { personalOwnerId: user.id },
      update: {},
      create: {
        name: `${user.name.trim() || "My"} research workspace`,
        slug: personalSlug(user.id),
        kind: "PERSONAL",
        personalOwnerId: user.id,
      },
    });

    const member = await transaction.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: user.id,
        },
      },
      update: {},
      create: {
        organizationId: organization.id,
        userId: user.id,
        role: "owner",
      },
    });

    return { ...member, organization };
  });
}

export async function requireWorkspaceMembership(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMembership> {
  const membership = await prisma.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: workspaceId,
        userId,
      },
    },
    include: { organization: true },
  });

  if (!membership) {
    // Use the same response for a missing workspace and a non-member so callers
    // cannot enumerate another tenant's identifiers.
    throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
  }
  return membership;
}

export async function resolveWorkspaceMembership(
  user: Pick<User, "id" | "name">,
  requestedWorkspaceId?: string,
  activeOrganizationId?: string | null,
): Promise<WorkspaceMembership> {
  if (requestedWorkspaceId) {
    return requireWorkspaceMembership(user.id, requestedWorkspaceId);
  }

  if (activeOrganizationId) {
    const activeMembership = await prisma.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: activeOrganizationId,
          userId: user.id,
        },
      },
      include: { organization: true },
    });
    if (activeMembership) return activeMembership;
  }

  return ensurePersonalWorkspace(user);
}

