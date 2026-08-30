import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { applyIdempotencyHeader } from "@/server/workspaces/import-service";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";
import {
  createWorkspaceUploadSession,
  MAX_UPLOAD_SESSION_COMMAND_BYTES,
} from "@/server/uploads/service";

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
    const { workspaceId } = await context.params;
    if (!workspaceId || workspaceId.length > 200) {
      throw new HttpProblem(400, "validation", "workspaceId is invalid.");
    }
    // Authorization precedes quota charging so a caller cannot drain another
    // tenant's budget by guessing its workspace identifier.
    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceMutationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);
    const body = applyIdempotencyHeader(
      request,
      await readJsonObject(request, MAX_UPLOAD_SESSION_COMMAND_BYTES),
    );
    const result = await createWorkspaceUploadSession(
      { id: session.user.id, name: session.user.name },
      workspaceId,
      body,
    );
    const status = result.ok
      ? result.outcome === "applied" ? 201 : 200
      : result.code === "validation" ? 400
        : result.code === "not_found" ? 404
          : 409;
    return Response.json(result, {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
