import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  getZoteroAttachmentPolicy,
  parseZoteroAttachmentPolicyCommand,
  updateZoteroAttachmentPolicy,
} from "@/server/integrations/zotero/attachment-service";
import { requireWorkspaceIntegrationRole } from "@/server/integrations/zotero/oauth-service";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_POLICY_BODY_BYTES = 4 * 1_024;

interface RouteContext {
  params: Promise<{ workspaceId: string; connectionId: string }>;
}

function requireOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
}

function response(value: unknown, requestId: string): Response {
  return Response.json(value, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Request-Id": requestId,
    },
  });
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const { workspaceId, connectionId } = await context.params;
    requireOpaqueId(workspaceId, "workspaceId");
    requireOpaqueId(connectionId, "connectionId");
    return response(await getZoteroAttachmentPolicy({
      userId: session.user.id,
      workspaceId,
      connectionId,
    }), requestId);
  } catch (error) {
    return problemResponse(error, requestId);
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId, connectionId } = await context.params;
    requireOpaqueId(workspaceId, "workspaceId");
    requireOpaqueId(connectionId, "connectionId");
    const command = parseZoteroAttachmentPolicyCommand(
      await readJsonObject(request, MAX_POLICY_BODY_BYTES),
    );

    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceIntegrationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);

    return response(await updateZoteroAttachmentPolicy({
      userId: session.user.id,
      workspaceId,
      connectionId,
      command,
      requestId,
    }), requestId);
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
