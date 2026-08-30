import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";
import { storeWorkspaceUploadContent } from "@/server/uploads/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string; uploadSessionId: string }>;
}

export async function PUT(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId, uploadSessionId } = await context.params;
    if (!workspaceId || workspaceId.length > 200 || !uploadSessionId || uploadSessionId.length > 200) {
      throw new HttpProblem(400, "validation", "Upload route identifiers are invalid.");
    }
    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceMutationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);
    const result = await storeWorkspaceUploadContent(
      { id: session.user.id, name: session.user.name },
      workspaceId,
      uploadSessionId,
      request,
    );
    return Response.json(result, {
      status: new Set(["quarantined", "validating"]).has(result.upload.status)
        ? 202
        : 200,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
