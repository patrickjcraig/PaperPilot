import { requireRequestSession } from "@/server/auth/session";
import { problemResponse, requestIdFrom } from "@/server/http/problem";
import { workspaceBootstrap } from "@/server/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const url = new URL(request.url);
    const requestedWorkspaceId = url.searchParams.get("workspaceId")?.trim() || undefined;
    const data = await workspaceBootstrap(
      { id: session.user.id, name: session.user.name },
      session.session.activeOrganizationId,
      requestedWorkspaceId,
    );
    return Response.json(data, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}

