import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import {
  applyEvidenceIdempotencyHeader,
  createWorkspaceEvidenceNote,
  MAX_EVIDENCE_COMMAND_BYTES,
} from "@/server/workspaces/evidence-service";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

function commandStatus(result: { ok: boolean; outcome?: string; code?: string }): number {
  if (result.ok) return result.outcome === "applied" ? 201 : 200;
  if (result.code === "validation") return 400;
  if (result.code === "not_found") return 404;
  return 409;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId } = await context.params;
    if (!workspaceId || workspaceId.length > 200) {
      throw new HttpProblem(404, "workspace_not_found", "Workspace was not found.");
    }
    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceMutationRole(membership.role);
    const limit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId: membership.organizationId,
    });
    if (!limit.allowed) return rateLimitExceededResponse(limit, requestId);
    const command = applyEvidenceIdempotencyHeader(
      request,
      await readJsonObject(request, MAX_EVIDENCE_COMMAND_BYTES),
    );
    const result = await createWorkspaceEvidenceNote(
      { id: session.user.id, name: session.user.name },
      workspaceId,
      command,
    );
    return Response.json(result, {
      status: commandStatus(result),
      headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
