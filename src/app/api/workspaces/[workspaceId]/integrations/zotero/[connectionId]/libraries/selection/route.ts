import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import {
  readJsonObject,
  requireTrustedMutationRequest,
} from "@/server/http/request";
import {
  parseZoteroLibrarySelectionCommand,
  selectZoteroLibraries,
} from "@/server/integrations/zotero/library-service";
import { requireWorkspaceIntegrationRole } from "@/server/integrations/zotero/oauth-service";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string; connectionId: string }>;
}

const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;
const MAX_SELECTION_BODY_BYTES = 128 * 1_024;

function requireOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId, connectionId } = await context.params;
    requireOpaqueId(workspaceId, "workspaceId");
    requireOpaqueId(connectionId, "connectionId");
    const command = parseZoteroLibrarySelectionCommand(
      await readJsonObject(request, MAX_SELECTION_BODY_BYTES),
    );
    const headerOperationId = request.headers.get("idempotency-key")?.trim();
    if (headerOperationId && headerOperationId !== command.clientOperationId) {
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

    const result = await selectZoteroLibraries({
      userId: session.user.id,
      workspaceId,
      connectionId,
      requestId,
      command,
    });
    return Response.json(result, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
