import { requireRequestSession } from "@/server/auth/session";
import { problemResponse, requestIdFrom } from "@/server/http/problem";
import { consumeReaderReadRateLimit, rateLimitExceededResponse } from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { validateCollaborationPathId } from "@/server/workspaces/collaboration-contract";
import { getWorkspaceCollaborators } from "@/server/workspaces/collaboration-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const { workspaceId: rawWorkspaceId } = await context.params;
    const workspaceId = validateCollaborationPathId(rawWorkspaceId, "workspaceId");
    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    const rateLimit = await consumeReaderReadRateLimit({
      request,
      userId: session.user.id,
      workspaceId: membership.organizationId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);
    const result = await getWorkspaceCollaborators(
      { id: session.user.id, name: session.user.name, email: session.user.email },
      workspaceId,
    );
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
