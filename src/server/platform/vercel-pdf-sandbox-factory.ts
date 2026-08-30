import "server-only";

import { Sandbox } from "@vercel/sandbox";

import type {
  PdfSandboxCreateOptions,
  PdfSandboxSessionFactory,
} from "./pdf-sandbox-lifecycle";

export type VercelDisposablePdfSandboxSession = Sandbox;

export interface VercelSandboxSdk {
  create(
    parameters: Parameters<typeof Sandbox.create>[0],
  ): ReturnType<typeof Sandbox.create>;
}

export async function createVercelPdfSandboxSession(
  options: PdfSandboxCreateOptions,
  sdk: VercelSandboxSdk = Sandbox,
): Promise<VercelDisposablePdfSandboxSession> {
  return sdk.create({
    image: options.image,
    persistent: false,
    timeout: options.timeoutMs,
    resources: { vcpus: options.vcpus },
    networkPolicy: options.networkPolicy,
    tags: { jobAttemptId: options.tags.jobAttemptId },
    signal: options.signal,
  });
}

export const vercelPdfSandboxSessionFactory: PdfSandboxSessionFactory = Object.freeze({
  create: createVercelPdfSandboxSession,
});
