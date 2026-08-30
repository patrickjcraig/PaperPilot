import {
  applyDocumentPaperLinkIdempotencyHeader,
  linkValidatedDocumentToWorkspacePaper,
  MAX_DOCUMENT_PAPER_LINK_COMMAND_BYTES,
} from "@/server/documents/document-paper-link";
import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
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
  params: Promise<{ workspaceId: string; documentId: string }>;
}

function commandStatus(result: {
  ok: boolean;
  outcome?: string;
  code?: string;
}): number {
  if (result.ok) return result.outcome === "applied" ? 201 : 200;
  if (result.code === "validation") return 400;
  if (result.code === "not_found") return 404;
  return 409;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId, documentId } = await context.params;
    if (
      !OPAQUE_ID_PATTERN.test(workspaceId)
      || !OPAQUE_ID_PATTERN.test(documentId)
    ) {
      throw new HttpProblem(
        404,
        "document_link_target_not_found",
        "Document link target was not found.",
      );
    }

    // Authorize before consuming the shared tenant mutation budget. The
    // command repeats this check inside its serializable transaction.
    const membership = await requireWorkspaceMembership(
      session.user.id,
      workspaceId,
    );
    requireWorkspaceMutationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId,
    });
    if (!rateLimit.allowed) {
      return rateLimitExceededResponse(rateLimit, requestId);
    }

    const body = applyDocumentPaperLinkIdempotencyHeader(
      request,
      await readJsonObject(request, MAX_DOCUMENT_PAPER_LINK_COMMAND_BYTES),
    );
    const result = await linkValidatedDocumentToWorkspacePaper(
      { id: session.user.id, name: session.user.name },
      workspaceId,
      documentId,
      body,
    );
    return Response.json(result, {
      status: commandStatus(result),
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
