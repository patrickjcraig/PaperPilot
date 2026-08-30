import { requireRequestSession } from "@/server/auth/session";
import {
  getWorkspacePaperReader,
  parseReaderPageQuery,
} from "@/server/documents/reader-service";
import { prisma } from "@/lib/prisma";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import {
  consumeReaderReadRateLimit,
  rateLimitExceededResponse,
  rateLimitHeaders,
  type RateLimitConsumption,
} from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ workspaceId: string; paperId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  let admittedRateLimit: RateLimitConsumption | undefined;
  try {
    const session = await requireRequestSession(request);
    const { workspaceId, paperId } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    parseReaderPageQuery(searchParams);
    const membership = await prisma.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: workspaceId,
          userId: session.user.id,
        },
      },
      select: { organizationId: true },
    });
    if (!membership) {
      throw new HttpProblem(404, "paper_not_found", "Paper was not found.");
    }
    admittedRateLimit = await consumeReaderReadRateLimit({
      request,
      userId: session.user.id,
      workspaceId: membership.organizationId,
    });
    if (!admittedRateLimit.allowed) {
      return rateLimitExceededResponse(admittedRateLimit, requestId);
    }
    const result = await getWorkspacePaperReader(
      session.user.id,
      membership.organizationId,
      paperId,
      searchParams,
    );
    const headers = rateLimitHeaders(admittedRateLimit);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Request-Id", requestId);
    return Response.json(result, {
      headers,
    });
  } catch (error) {
    const response = problemResponse(error, requestId);
    response.headers.set("Cache-Control", "private, no-store");
    if (admittedRateLimit) {
      rateLimitHeaders(admittedRateLimit).forEach((value, name) => {
        response.headers.set(name, value);
      });
    }
    return response;
  }
}
