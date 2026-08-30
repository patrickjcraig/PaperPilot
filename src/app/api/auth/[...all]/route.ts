import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { HttpProblem, problemResponse, requestIdFrom } from "@/server/http/problem";
import { requestWithinBodyLimit } from "@/server/http/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    return await handlers.POST(await requestWithinBodyLimit(request, 32 * 1024));
  } catch (error) {
    if (error instanceof HttpProblem) return problemResponse(error, requestId);
    throw error;
  }
}
