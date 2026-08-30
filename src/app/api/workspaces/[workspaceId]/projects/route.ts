import type { CreateProjectCommand } from "@/lib/workspace";
import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { readJsonObject, requireTrustedMutationRequest } from "@/server/http/request";
import {
  consumeWorkspaceMutationRateLimit,
  rateLimitExceededResponse,
} from "@/server/rate-limit";
import { requireWorkspaceMembership } from "@/server/workspaces/authorization";
import { requireWorkspaceMutationRole } from "@/server/workspaces/project-access";
import { createWorkspaceProject } from "@/server/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

const COMMAND_KEYS = new Set(["clientOperationId", "expectedVersion", "project"]);
const PROJECT_KEYS = new Set(["name", "question", "description", "type", "visibility"]);

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  location: string,
): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey) {
    throw new HttpProblem(400, "validation", `Unknown ${location} field “${unknownKey}”.`);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    requireTrustedMutationRequest(request);
    const session = await requireRequestSession(request);
    const { workspaceId } = await context.params;
    if (!workspaceId || workspaceId.length > 200) {
      throw new HttpProblem(400, "validation", "workspaceId is invalid.");
    }
    const membership = await requireWorkspaceMembership(session.user.id, workspaceId);
    requireWorkspaceMutationRole(membership.role);
    const rateLimit = await consumeWorkspaceMutationRateLimit({
      request,
      userId: session.user.id,
      workspaceId: membership.organizationId,
    });
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit, requestId);
    const body = await readJsonObject(request, 32 * 1024);
    rejectUnknownKeys(body, COMMAND_KEYS, "command");
    const headerOperationId = request.headers.get("idempotency-key")?.trim();
    if (body.clientOperationId !== undefined && typeof body.clientOperationId !== "string") {
      throw new HttpProblem(400, "validation", "clientOperationId must be a string.");
    }
    const bodyOperationId = body.clientOperationId?.trim();
    if (headerOperationId && bodyOperationId && headerOperationId !== bodyOperationId) {
      throw new HttpProblem(
        400,
        "idempotency_mismatch",
        "Idempotency-Key must match clientOperationId.",
      );
    }
    if (!bodyOperationId && !headerOperationId) {
      throw new HttpProblem(400, "validation", "clientOperationId is required.");
    }
    if (!body.project || typeof body.project !== "object" || Array.isArray(body.project)) {
      throw new HttpProblem(400, "validation", "A project command is required.");
    }
    const project = body.project as Record<string, unknown>;
    rejectUnknownKeys(project, PROJECT_KEYS, "project");
    if (
      typeof project.name !== "string"
      || typeof project.question !== "string"
      || typeof project.type !== "string"
      || typeof project.visibility !== "string"
      || (project.description !== undefined && typeof project.description !== "string")
      || typeof body.expectedVersion !== "number"
    ) {
      throw new HttpProblem(400, "validation", "Project fields have invalid types.");
    }
    const command = {
      clientOperationId: bodyOperationId || headerOperationId || "",
      expectedVersion: body.expectedVersion,
      project: {
        name: project.name,
        question: project.question,
        description: project.description,
        type: project.type,
        visibility: project.visibility,
      },
    } as unknown as CreateProjectCommand;

    const result = await createWorkspaceProject(
      { id: session.user.id, name: session.user.name },
      workspaceId,
      command,
    );
    const status = result.ok
      ? result.outcome === "replayed" ? 200 : 201
      : result.code === "validation" ? 400 : 409;
    return Response.json(result, {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
