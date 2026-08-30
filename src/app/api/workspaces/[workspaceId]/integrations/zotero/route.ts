import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { listZoteroConnections } from "@/server/integrations/zotero/oauth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string }>;
}

const OPAQUE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const { workspaceId } = await context.params;
    if (!OPAQUE_ID_PATTERN.test(workspaceId)) {
      throw new HttpProblem(400, "validation", "workspaceId is invalid.");
    }

    const result = await listZoteroConnections(session.user.id, workspaceId);
    return Response.json(result, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
