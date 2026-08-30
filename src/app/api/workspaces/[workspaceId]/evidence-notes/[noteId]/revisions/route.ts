import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import {
  MAX_EVIDENCE_REVISION_COMMAND_BYTES,
  type GroundedEvidenceRevisionResponse,
} from "@/server/workspaces/evidence-revision-command";
import { reviseWorkspaceGroundedEvidence } from "@/server/workspaces/evidence-revision-service";
import { applyEvidenceIdempotencyHeader } from "@/server/workspaces/evidence-service";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

interface RouteContext {
  params: Promise<{ workspaceId: string; noteId: string }>;
}

function commandStatus(result: GroundedEvidenceRevisionResponse): number {
  if (result.ok) return result.outcome === "applied" ? 201 : 200;
  if (result.code === "not_found") return 404;
  return 409;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId, noteId } = await context.params;
    if (!OPAQUE_ID_PATTERN.test(workspaceId) || !OPAQUE_ID_PATTERN.test(noteId)) {
      throw new HttpProblem(404, "evidence_not_found", "Evidence note was not found.");
    }

    // Membership and mutation authority precede quota consumption. A viewer or
    // guessed tenant ID must not spend another workspace's shared budget.
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
      await readJsonObject(request, MAX_EVIDENCE_REVISION_COMMAND_BYTES),
    );
    const result = await reviseWorkspaceGroundedEvidence(
      { id: session.user.id, name: session.user.name },
      membership.organizationId,
      noteId,
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
