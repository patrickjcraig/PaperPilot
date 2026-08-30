import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import {
  readJsonObject,
  requireTrustedMutationRequest,
} from "@/server/http/request";
import { requireWorkspaceIntegrationRole } from "@/server/integrations/zotero/oauth-service";
import { queueSelectedZoteroSyncs } from "@/server/integrations/zotero/sync-jobs";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1_024;
const OPAQUE_ID = /^[a-zA-Z0-9._:-]{1,200}$/;

interface RouteContext {
  params: Promise<{ workspaceId: string; connectionId: string }>;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new HttpProblem(400, "validation", label + " is invalid.");
  }
  return value;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId, connectionId } = await context.params;
    opaqueId(workspaceId, "workspaceId");
    opaqueId(connectionId, "connectionId");
    const body = await readJsonObject(request, MAX_BODY_BYTES);
    if (
      Object.keys(body).length !== 1
      || !Object.hasOwn(body, "clientOperationId")
    ) {
      throw new HttpProblem(
        400,
        "validation",
        "A Zotero sync request must contain only clientOperationId.",
      );
    }
    const clientOperationId = opaqueId(
      body.clientOperationId,
      "clientOperationId",
    );
    const headerOperationId = request.headers.get("idempotency-key")?.trim();
    if (headerOperationId && headerOperationId !== clientOperationId) {
      throw new HttpProblem(
        400,
        "idempotency_mismatch",
        "Idempotency-Key must match clientOperationId.",
      );
    }

    const membership = await requireWorkspaceMembership(
      session.user.id,
      workspaceId,
    );
    requireWorkspaceIntegrationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) {
      return rateLimitExceededResponse(rateLimit, requestId);
    }

    const result = await queueSelectedZoteroSyncs({
      userId: session.user.id,
      workspaceId,
      connectionId,
      clientOperationId,
    });
    return Response.json(result, {
      status: result.outcome === "queued" ? 202 : 200,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
