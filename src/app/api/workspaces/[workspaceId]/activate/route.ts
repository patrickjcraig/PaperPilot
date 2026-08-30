import { requireRequestSession } from "@/server/auth/session";
import { problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { activateWorkspaceForSession } from "@/server/workspaces/activation-service";
import { validateCollaborationPathId } from "@/server/workspaces/collaboration-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

function requireActivationCommand(value: Record<string, unknown>): void {
  if (Object.keys(value).length !== 1 || value.schemaVersion !== 1) {
    throw new TypeError("Workspace activation command is invalid.");
  }
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId: rawWorkspaceId } = await context.params;
    const workspaceId = validateCollaborationPathId(rawWorkspaceId, "workspaceId");
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);
    requireActivationCommand(await readJsonObject(request, 1_024));
    const result = await activateWorkspaceForSession(
      session.user.id,
      session.session.id,
      workspaceId,
    );
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}

