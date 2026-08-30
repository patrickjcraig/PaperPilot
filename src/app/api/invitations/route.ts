import { requireRequestSession } from "@/server/auth/session";
import { problemResponse, requestIdFrom } from "@/server/http/problem";
import { listInvitationInbox } from "@/server/workspaces/collaboration-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const session = await requireRequestSession(request);
    const result = await listInvitationInbox({
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
