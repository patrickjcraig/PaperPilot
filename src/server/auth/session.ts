import "server-only";

import { headers } from "next/headers";
import {
  auth,
  productionIdentityVerificationRequired,
  type PaperPilotSession,
} from "@/lib/auth";
import { HttpProblem } from "@/server/http/problem";

export async function sessionForRequest(request: Request): Promise<PaperPilotSession | null> {
  return auth.api.getSession({ headers: request.headers });
}

export async function requireRequestSession(request: Request): Promise<PaperPilotSession> {
  const session = await sessionForRequest(request);
  if (!session) {
    throw new HttpProblem(401, "authentication_required", "Sign in to access this workspace.");
  }
  if (productionIdentityVerificationRequired && !session.user.emailVerified) {
    throw new HttpProblem(403, "email_verification_required", "Verify this account before continuing.");
  }
  return session;
}

export async function serverSession(): Promise<PaperPilotSession | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (productionIdentityVerificationRequired && session && !session.user.emailVerified) {
    return null;
  }
  return session;
}
