import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { HttpProblem } from "@/server/http/problem";

const MUTATING_WORKSPACE_ROLES = new Set(["owner", "admin", "member"]);

/** Private projects belong only to their creator until explicit ACLs land. */
export function projectVisibleTo(userId: string): Prisma.ProjectWhereInput {
  return {
    OR: [
      { visibility: "WORKSPACE" },
      { visibility: "PRIVATE", createdById: userId },
    ],
  };
}

/**
 * An unprojected paper is workspace-visible. Once it belongs to projects, a
 * caller must be able to see at least one of those projects.
 */
export function workspacePaperVisibleTo(
  userId: string,
  organizationId: string,
): Prisma.WorkspacePaperWhereInput {
  const visibleProject = projectVisibleTo(userId);
  return {
    organizationId,
    OR: [
      { projectPapers: { none: {} } },
      {
        projectPapers: {
          some: {
            organizationId,
            project: { organizationId, ...visibleProject },
          },
        },
      },
    ],
  };
}

/**
 * Inbox rows inherit both their direct project and their linked paper's
 * project visibility. Keeping this predicate shared prevents bootstrap and
 * direct status reads from disagreeing about a private row.
 */
export function inboxEntryVisibleTo(
  userId: string,
  organizationId: string,
): Prisma.InboxEntryWhereInput {
  const visibleProject = projectVisibleTo(userId);
  return {
    organizationId,
    AND: [
      {
        OR: [
          { projectId: null },
          { project: { organizationId, ...visibleProject } },
        ],
      },
      {
        OR: [
          { workspacePaperId: null },
          {
            workspacePaper: workspacePaperVisibleTo(userId, organizationId),
          },
        ],
      },
    ],
  };
}

/**
 * Evidence follows every linked project's visibility. Legacy notes without a
 * join edge fall back to their original optional project relation.
 */
export function evidenceVisibleTo(userId: string): Prisma.EvidenceNoteWhereInput {
  const visibleProject = projectVisibleTo(userId);
  return {
    OR: [
      { projectMemberships: { some: { project: visibleProject } } },
      {
        AND: [
          { projectMemberships: { none: {} } },
          {
            OR: [
              { projectId: null },
              { project: visibleProject },
            ],
          },
        ],
      },
    ],
  };
}

/** Fail closed for unknown/custom read-only organization roles. */
export function requireWorkspaceMutationRole(role: string): void {
  if (!MUTATING_WORKSPACE_ROLES.has(role)) {
    throw new HttpProblem(403, "workspace_forbidden", "This workspace role cannot make changes.");
  }
}
