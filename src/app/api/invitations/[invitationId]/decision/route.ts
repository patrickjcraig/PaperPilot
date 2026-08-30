import { requireRequestSession } from "@/server/auth/session";
import { problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeAuthenticatedMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import {
  applyCollaborationIdempotencyHeader,
  validateCollaborationPathId,
} from "@/server/workspaces/collaboration-contract";
import {
  decideWorkspaceInvitation,
} from "@/server/workspaces/collaboration-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ invitationId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { invitationId: rawInvitationId } = await context.params;
    const invitationId = validateCollaborationPathId(rawInvitationId, "invitationId");
    const rateLimit = await consumeAuthenticatedMutationRateLimit({
      request,
      userId: session.user.id,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);
    const raw = applyCollaborationIdempotencyHeader(
      request,
      await readJsonObject(request, 8 * 1_024),
    );
    const result = await decideWorkspaceInvitation(
      { id: session.user.id, name: session.user.name, email: session.user.email },
      invitationId,
      raw,
    );
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
