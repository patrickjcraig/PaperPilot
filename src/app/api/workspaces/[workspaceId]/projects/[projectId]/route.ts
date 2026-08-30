import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { workspaceProject } from "@/server/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string; projectId: string }>;
}

function validOpaqueId(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && /^[a-zA-Z0-9._:-]+$/.test(value);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const { workspaceId, projectId } = await context.params;
    if (!validOpaqueId(workspaceId) || !validOpaqueId(projectId)) {
      throw new HttpProblem(404, "project_not_found", "Project was not found.");
    }

    const project = await workspaceProject(
      { id: session.user.id, name: session.user.name },
      workspaceId,
      projectId,
    );
    if (!project) {
      throw new HttpProblem(404, "project_not_found", "Project was not found.");
    }
    return Response.json(project, {
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
