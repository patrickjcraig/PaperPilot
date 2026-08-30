import { prisma } from "@/lib/prisma";
import { requireRequestSession } from "@/server/auth/session";
import { requireReaderPdfJsEnabled } from "@/server/documents/reader-pdf-config";
import { parseReaderPdfRequest } from "@/server/documents/reader-pdf-request";
import { getWorkspacePaperPdf } from "@/server/documents/reader-pdf-service";
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
    requireReaderPdfJsEnabled();
    const { workspaceId, paperId } = await context.params;
    const expected = parseReaderPdfRequest(
      new URL(request.url).searchParams,
      request.headers.get("if-match"),
    );
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

    const pdf = await getWorkspacePaperPdf(
      session.user.id,
      membership.organizationId,
      paperId,
      expected,
    );
    const headers = rateLimitHeaders(admittedRateLimit);
    headers.set("Cache-Control", "private, no-store");
    headers.set("Content-Disposition", 'inline; filename="paper.pdf"');
    headers.set("Content-Type", "application/pdf");
    headers.set("ETag", `"${pdf.inputSha256}"`);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-PaperPilot-Document-Id", pdf.documentId);
    headers.set("X-PaperPilot-Document-SHA256", pdf.inputSha256);
    headers.set("X-Request-Id", requestId);
    const body = new Uint8Array(pdf.bytes.byteLength);
    body.set(pdf.bytes);
    return new Response(body.buffer, { headers });
  } catch (error) {
    const response = problemResponse(error, requestId);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    if (admittedRateLimit) {
      rateLimitHeaders(admittedRateLimit).forEach((value, name) => {
        response.headers.set(name, value);
      });
    }
    return response;
  }
}
