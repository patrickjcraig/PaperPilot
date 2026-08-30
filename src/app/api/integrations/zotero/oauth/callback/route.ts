import { requireRequestSession } from "@/server/auth/session";
import { requestIdFrom } from "@/server/http/problem";
import {
  parseZoteroOAuthCallbackRequest,
  zoteroOAuthCallbackRedirect,
  zoteroOAuthUnavailableCallbackRedirect,
} from "@/server/integrations/zotero/oauth-callback-request";
import { consumeZoteroOAuthCallbackIpRateLimit } from "@/server/integrations/zotero/oauth-callback-rate-limit";
import {
  zoteroOAuthConfigurationFromEnvironment,
  zoteroOAuthResultRedirect,
} from "@/server/integrations/zotero/oauth-config";
import {
  ZoteroOAuthCriticalAuditError,
  createZoteroOAuthLifecycleFromEnvironment,
  requireWorkspaceIntegrationRole,
  workspaceIdForZoteroOAuthState,
} from "@/server/integrations/zotero/oauth-service";
import { consumeWorkspaceMutationRateLimit } from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prevent framework-generated HEAD handling from consuming a one-time callback. */
export function HEAD(request: Request): Response {
  return new Response(null, {
    status: 405,
    headers: {
      Allow: "GET",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Request-Id": requestIdFrom(request),
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);

  let configuration: ReturnType<typeof zoteroOAuthConfigurationFromEnvironment>;
  try {
    configuration = zoteroOAuthConfigurationFromEnvironment();
  } catch {
    return zoteroOAuthUnavailableCallbackRedirect(requestId);
  }

  const failureRedirect = zoteroOAuthResultRedirect(
    configuration,
    "failed",
  );
  try {
    const ipRateLimit = await consumeZoteroOAuthCallbackIpRateLimit(request);
    if (!ipRateLimit.allowed) {
      return zoteroOAuthCallbackRedirect(failureRedirect, requestId);
    }
    const parameters = parseZoteroOAuthCallbackRequest(request);
    const session = await requireRequestSession(request);
    const workspaceId = await workspaceIdForZoteroOAuthState(
      parameters.state,
      session.user.id,
      configuration.stateSecret,
    );
    if (!workspaceId) throw new Error("invalid-state");
    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceIntegrationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) {
      return zoteroOAuthCallbackRedirect(failureRedirect, requestId);
    }
    const { service } = createZoteroOAuthLifecycleFromEnvironment();
    await service.complete({
      userId: session.user.id,
      state: parameters.state,
      requestToken: parameters.requestToken,
      verifier: parameters.verifier,
      requestId,
    });
    return zoteroOAuthCallbackRedirect(
      zoteroOAuthResultRedirect(configuration, "connected"),
      requestId,
    );
  } catch (error) {
    if (error instanceof ZoteroOAuthCriticalAuditError) {
      console.error("CRITICAL Zotero OAuth cleanup audit persistence failed", {
        requestId,
        code: error.code,
      });
    }
    return zoteroOAuthCallbackRedirect(failureRedirect, requestId);
  }
}
