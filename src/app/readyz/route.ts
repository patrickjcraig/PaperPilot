import { readinessResponse } from "@/server/operations/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return readinessResponse({ method: "GET" });
}

export function HEAD(): Promise<Response> {
  return readinessResponse({ method: "HEAD" });
}
