import { requireRequestSession } from "@/server/auth/session";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import {
  listZoteroAttachments,
  parseZoteroAttachmentListQuery,
} from "@/server/integrations/zotero/attachment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

interface RouteContext {
  params: Promise<{ workspaceId: string; connectionId: string }>;
}

function requireOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpProblem(400, "validation", `${label} is invalid.`);
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const { workspaceId, connectionId } = await context.params;
    requireOpaqueId(workspaceId, "workspaceId");
    requireOpaqueId(connectionId, "connectionId");
    const query = parseZoteroAttachmentListQuery(new URL(request.url).searchParams);
    const result = await listZoteroAttachments({
      userId: session.user.id,
      workspaceId,
      connectionId,
      query,
    });
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
