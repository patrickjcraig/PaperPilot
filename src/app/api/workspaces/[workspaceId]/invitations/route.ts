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
  createWorkspaceInvitation,
  requireWorkspaceCollaborationManager,
} from "@/server/workspaces/collaboration-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId: rawWorkspaceId } = await context.params;
    const workspaceId = validateCollaborationPathId(rawWorkspaceId, "workspaceId");
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
    const result = await createWorkspaceInvitation(
      { id: session.user.id, name: session.user.name, email: session.user.email },
      workspaceId,
      raw,
    );
    return Response.json(result, {
      status: result.outcome === "applied" ? 201 : 200,
      headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
