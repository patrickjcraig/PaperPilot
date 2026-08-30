import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  deleteCrawlerCustody,
} from "@/server/integrations/web-source/crawler-custody-deletion";
import {
  MAX_CRAWLER_CUSTODY_DELETION_COMMAND_BYTES,
} from "@/server/integrations/web-source/crawler-deletion-command";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

interface RouteContext {
  params: Promise<{ workspaceId: string; crawlerImportId: string }>;
}

function requireOpaquePathId(value: string, label: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
  return value;
}

/**
 * Explicit destructive command; physical proof is completed asynchronously by
 * the governed crawler worker's custody-deletion reconciliation pass.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const parameters = await context.params;
    const workspaceId = requireOpaquePathId(parameters.workspaceId, "workspaceId");
    const crawlerImportId = requireOpaquePathId(
      parameters.crawlerImportId,
      "crawlerImportId",
    );

    // Authorization precedes shared quota consumption so guessed workspace IDs
    // cannot drain another tenant's mutation budget.
    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceMutationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);

    const command = await readJsonObject(
      request,
      MAX_CRAWLER_CUSTODY_DELETION_COMMAND_BYTES,
    );
    const headerOperationId = request.headers.get("idempotency-key")?.trim();
    if (
      !headerOperationId
      || typeof command.clientOperationId !== "string"
      || headerOperationId !== command.clientOperationId
    ) {
      throw new HttpProblem(
        400,
        "idempotency_mismatch",
        "Idempotency-Key must be present and match clientOperationId.",
      );
    }
    const result = await deleteCrawlerCustody({
      userId: session.user.id,
      workspaceId,
      crawlerImportId,
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

