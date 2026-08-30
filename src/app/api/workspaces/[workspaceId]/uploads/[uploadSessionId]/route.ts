import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { getWorkspaceUploadStatus } from "@/server/uploads/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string; uploadSessionId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const { workspaceId, uploadSessionId } = await context.params;
    if (!workspaceId || workspaceId.length > 200 || !uploadSessionId || uploadSessionId.length > 200) {
      throw new HttpProblem(400, "validation", "Upload route identifiers are invalid.");
    }
    const result = await getWorkspaceUploadStatus(
      session.user.id,
      workspaceId,
      uploadSessionId,
    );
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
