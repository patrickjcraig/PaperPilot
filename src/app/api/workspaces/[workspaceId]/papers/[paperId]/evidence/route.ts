import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { applyEvidenceIdempotencyHeader } from "@/server/workspaces/evidence-service";
import {
  captureWorkspaceGroundedEvidence,
  MAX_GROUNDED_EVIDENCE_COMMAND_BYTES,
} from "@/server/workspaces/grounded-evidence-service";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

interface RouteContext {
  params: Promise<{ workspaceId: string; paperId: string }>;
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
    const { workspaceId, paperId } = await context.params;
    if (!OPAQUE_ID_PATTERN.test(workspaceId) || !OPAQUE_ID_PATTERN.test(paperId)) {
      throw new HttpProblem(404, "paper_not_found", "Paper was not found.");
    }

    // Resolve membership before consuming a tenant quota. Otherwise a caller
    // could burn arbitrary workspace buckets merely by guessing identifiers.
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
      await readJsonObject(request, MAX_GROUNDED_EVIDENCE_COMMAND_BYTES),
    );
    const result = await captureWorkspaceGroundedEvidence(
      { id: session.user.id, name: session.user.name },
      membership.organizationId,
      paperId,
      command,
    );
    return Response.json(result, {
      status: commandStatus(result),
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
