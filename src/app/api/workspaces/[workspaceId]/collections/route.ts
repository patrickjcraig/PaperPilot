import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import {
  applyCollectionIdempotencyHeader,
} from "@/server/workspaces/collection-command";
import { createWorkspaceCollection } from "@/server/workspaces/collection-service";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";

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

    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceMutationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId: membership.organizationId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);

    const rawBody = await readJsonObject(request, 16 * 1_024);
    const command = applyCollectionIdempotencyHeader(request, rawBody);
    const result = await createWorkspaceCollection(
      { id: session.user.id, name: session.user.name },
      workspaceId,
      command,
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
