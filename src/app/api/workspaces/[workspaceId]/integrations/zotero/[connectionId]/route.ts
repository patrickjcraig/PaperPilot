import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { requireTrustedMutationRequest } from "@/server/http/request";
import { credentialProtectorFromEnvironment } from "@/server/integrations/credential-protection";
import { requireEmptyZoteroMutationBody } from "@/server/integrations/zotero/oauth-http-request";
import {
  disconnectZoteroConnection,
  requireWorkspaceIntegrationRole,
  revokeZoteroAccessToken,
} from "@/server/integrations/zotero/oauth-service";
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

function requireOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    requireEmptyZoteroMutationBody(request);
    const session = await requireRequestSession(request);
    const { workspaceId, connectionId } = await context.params;
    requireOpaqueId(workspaceId, "workspaceId");
    requireOpaqueId(connectionId, "connectionId");

    // Do not let an unaffiliated caller consume another tenant's shared write
    // budget. The service repeats this authorization around local erasure.
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

    let credentialProtector;
    try {
      credentialProtector = credentialProtectorFromEnvironment();
    } catch {
      // Local ciphertext erasure must not depend on currently readable keys.
      credentialProtector = undefined;
    }
    const result = await disconnectZoteroConnection(
      {
        userId: session.user.id,
        workspaceId,
        connectionId,
        requestId,
      },
      {
        credentialProtector,
        revokeAccessToken: (accessToken) => revokeZoteroAccessToken(accessToken),
      },
    );
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
