import { requireRequestSession } from "@/server/auth/session";
import { problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import {
  applyCollaborationIdempotencyHeader,
  validateCollaborationPathId,
} from "@/server/workspaces/collaboration-contract";
import {
  requireWorkspaceCollaborationManager,
  updateWorkspaceMemberRole,
} from "@/server/workspaces/collaboration-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string; memberId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const params = await context.params;
    const workspaceId = validateCollaborationPathId(params.workspaceId, "workspaceId");
    const memberId = validateCollaborationPathId(params.memberId, "memberId");
    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceCollaborationManager(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId: membership.organizationId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);
    const raw = applyCollaborationIdempotencyHeader(
      request,
      await readJsonObject(request, 8 * 1_024),
    );
    const result = await updateWorkspaceMemberRole(
      { id: session.user.id, name: session.user.name, email: session.user.email },
      workspaceId,
      memberId,
      raw,
    );
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
