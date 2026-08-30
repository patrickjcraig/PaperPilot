import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  parseQueueZoteroAttachmentImportCommand,
  queueZoteroAttachmentImport,
} from "@/server/integrations/zotero/attachment-service";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_IMPORT_BODY_BYTES = 8 * 1_024;

interface RouteContext {
  params: Promise<{
    workspaceId: string;
    connectionId: string;
    attachmentId: string;
  }>;
}

function requireOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId, connectionId, attachmentId } = await context.params;
    requireOpaqueId(workspaceId, "workspaceId");
    requireOpaqueId(connectionId, "connectionId");
    requireOpaqueId(attachmentId, "attachmentId");
    const command = parseQueueZoteroAttachmentImportCommand(
      await readJsonObject(request, MAX_IMPORT_BODY_BYTES),
    );
    const headerOperationId = request.headers.get("idempotency-key")?.trim();
    if (headerOperationId && headerOperationId !== command.clientOperationId) {
      throw new HttpProblem(
        400,
        "idempotency_mismatch",
        "Idempotency-Key must match clientOperationId.",
      );
    }

    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceMutationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);

    const result = await queueZoteroAttachmentImport({
      userId: session.user.id,
      workspaceId,
      connectionId,
      attachmentId,
      command,
      requestId,
    });
    return Response.json(result, {
      status: result.outcome === "applied" ? 202 : 200,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
