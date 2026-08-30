import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import {
  readJsonObject,
  requireTrustedMutationRequest,
} from "@/server/http/request";
import {
  createZoteroOAuthLifecycleFromEnvironment,
  parseZoteroOAuthScopeProfile,
  requireWorkspaceIntegrationRole,
} from "@/server/integrations/zotero/oauth-service";
import { ZoteroOAuthError } from "@/server/integrations/zotero/oauth";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

const MAX_START_BODY_BYTES = 16 * 1024;
const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;
const START_BODY_KEYS = new Set(["scopeProfile"]);

function requireOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
}

function rejectUnknownFields(body: Record<string, unknown>): void {
  const unknownField = Object.keys(body).find(
    (field) => !START_BODY_KEYS.has(field),
  );
  if (unknownField) {
    throw new HttpProblem(
      400,
      "validation",
      `Unknown Zotero OAuth field “${unknownField}”.`,
    );
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId } = await context.params;
    requireOpaqueId(workspaceId, "workspaceId");
    const body = await readJsonObject(request, MAX_START_BODY_BYTES);
    rejectUnknownFields(body);
    const scopeProfile = parseZoteroOAuthScopeProfile(body.scopeProfile);

    // Resolve tenant authorization before charging the shared workspace bucket.
    // The lifecycle service checks again after the limit is consumed so a role
    // change cannot create an OAuth attempt through a stale authorization.
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

    const { service } = createZoteroOAuthLifecycleFromEnvironment();
    const result = await service.start({
      userId: session.user.id,
      workspaceId,
      scopeProfile,
      requestId,
    });

    return Response.json(result, {
      status: 201,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    if (error instanceof ZoteroOAuthError) {
      return problemResponse(
        new HttpProblem(error.status, error.code, error.message),
        requestId,
      );
    }
    return problemResponse(error, requestId);
  }
}
