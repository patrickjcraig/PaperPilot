import { livenessResponse } from "@/server/operations/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return livenessResponse("GET");
}

export function HEAD(): Response {
  return livenessResponse("HEAD");
}
