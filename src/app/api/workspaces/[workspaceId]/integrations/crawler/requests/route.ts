import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  MAX_CRAWLER_ACQUISITION_COMMAND_BYTES,
} from "@/server/integrations/web-source/crawler-command";
import {
  listCrawlerRequests,
  queueCrawlerRequest,
} from "@/server/integrations/web-source/crawler-service";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

function requireWorkspaceId(value: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", "workspaceId is invalid.");
  }
  return value;
}

function listLimit(request: Request): number | undefined {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "limit") || url.searchParams.getAll("limit").length > 1) {
    throw new HttpProblem(400, "validation", "Crawler request query is invalid.");
  }
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  if (!/^[1-9]\d{0,2}$/.test(raw)) {
    throw new HttpProblem(400, "validation", "Crawler request limit is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 100) {
    throw new HttpProblem(400, "validation", "Crawler request limit is invalid.");
  }
  return value;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const { workspaceId: rawWorkspaceId } = await context.params;
    const workspaceId = requireWorkspaceId(rawWorkspaceId);
    const result = await listCrawlerRequests({
      userId: session.user.id,
      workspaceId,
      limit: listLimit(request),
    });
    return Response.json(result, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId: rawWorkspaceId } = await context.params;
    const workspaceId = requireWorkspaceId(rawWorkspaceId);

    // Authorization precedes shared quota consumption so guessed tenant IDs
    // cannot drain another workspace's request budget.
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
      MAX_CRAWLER_ACQUISITION_COMMAND_BYTES,
    );
    const headerOperationId = request.headers.get("idempotency-key")?.trim();
    if (
      headerOperationId
      && (
        typeof command.clientOperationId !== "string"
        || headerOperationId !== command.clientOperationId
      )
    ) {
      throw new HttpProblem(
        400,
        "idempotency_mismatch",
        "Idempotency-Key must match clientOperationId.",
      );
    }
    const result = await queueCrawlerRequest({
      userId: session.user.id,
      workspaceId,
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
