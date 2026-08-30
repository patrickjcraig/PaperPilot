import "server-only";

const SHA256_IMAGE_PATTERN = /@sha256:[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface PdfSandboxLaunchInput {
  jobAttemptId: string;
  image: string;
  timeoutMs: number;
  vcpus: 1 | 2 | 3 | 4;
  signal?: AbortSignal;
}

export interface PdfSandboxCreateOptions {
  image: string;
  persistent: false;
  timeoutMs: number;
  vcpus: 1 | 2 | 3 | 4;
  networkPolicy: "deny-all";
  tags: Readonly<{ jobAttemptId: string }>;
  signal?: AbortSignal;
}

export interface DisposablePdfSandboxSession {
  /** Native provider name retained by Workflow's supported serializer. */
  readonly name: string;
  readonly persistent: boolean;
  update(
    parameters: { networkPolicy: "deny-all" },
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  stop(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface PdfSandboxSessionFactory {
  create(options: PdfSandboxCreateOptions): Promise<DisposablePdfSandboxSession>;
}

export type PdfSandboxLifecycleErrorCode =
  | "invalid_launch_contract"
  | "invalid_provider_session"
  | "persistent_sandbox_rejected"
  | "sandbox_air_gap_failed"
  | "sandbox_stop_failed";

export class PdfSandboxLifecycleError extends Error {
  constructor(
    readonly code: PdfSandboxLifecycleErrorCode,
    cause?: unknown,
  ) {
    super(
      "The disposable PDF processing boundary failed safely.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "PdfSandboxLifecycleError";
  }
}

function assertLaunchInput(input: PdfSandboxLaunchInput): void {
  if (
    !input
    || typeof input !== "object"
    || !OPAQUE_ID_PATTERN.test(input.jobAttemptId)
    || Buffer.byteLength(input.jobAttemptId, "utf8") > 200
    || typeof input.image !== "string"
    || !SHA256_IMAGE_PATTERN.test(input.image)
    || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 1_000
    || input.timeoutMs > 45 * 60 * 1_000
    || ![1, 2, 3, 4].includes(input.vcpus)
  ) {
    throw new PdfSandboxLifecycleError("invalid_launch_contract");
  }
}

/**
 * Create exactly one non-persistent Sandbox for one PDF job attempt and stop it
 * on ordinary terminal paths. The Sandbox starts with deny-all egress. A
 * storage-staging callback may ask the separately reviewed credential broker
 * to install one exact, short-lived firewall transform; this lifecycle then
 * restores deny-all before the offline processing callback can run. Durable
 * cancellation reconciliation remains an outer Workflow responsibility.
 */
export async function withDisposablePdfSandbox<T>(
  factory: PdfSandboxSessionFactory,
  input: PdfSandboxLaunchInput,
  stageFromPrivateStorage: (
    session: DisposablePdfSandboxSession,
  ) => Promise<void>,
  processOffline: (
    session: DisposablePdfSandboxSession,
  ) => Promise<T>,
): Promise<{ sandboxId: string; value: T }> {
  assertLaunchInput(input);
  input.signal?.throwIfAborted();

  const session = await factory.create({
    image: input.image,
    persistent: false,
    timeoutMs: input.timeoutMs,
    vcpus: input.vcpus,
    networkPolicy: "deny-all",
    tags: { jobAttemptId: input.jobAttemptId },
    signal: input.signal,
  });

  if (
    !session
    || typeof session !== "object"
    || typeof session.stop !== "function"
  ) {
    throw new PdfSandboxLifecycleError("invalid_provider_session");
  }

  let airGapConfirmed = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    input.signal?.throwIfAborted();
    if (
      typeof session.name !== "string"
      || !OPAQUE_ID_PATTERN.test(session.name)
      || Buffer.byteLength(session.name, "utf8") > 200
      || typeof session.update !== "function"
      || typeof session.persistent !== "boolean"
    ) {
      throw new PdfSandboxLifecycleError("invalid_provider_session");
    }
    if (session.persistent) {
      throw new PdfSandboxLifecycleError("persistent_sandbox_rejected");
    }
    await stageFromPrivateStorage(session);
    input.signal?.throwIfAborted();
    try {
      await session.update(
        { networkPolicy: "deny-all" },
        { signal: input.signal },
      );
      airGapConfirmed = true;
    } catch (error) {
      throw new PdfSandboxLifecycleError("sandbox_air_gap_failed", error);
    }
    input.signal?.throwIfAborted();
    const value = await processOffline(session);
    return { sandboxId: session.name, value };
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    if (!airGapConfirmed) {
      try {
        await session.update({ networkPolicy: "deny-all" });
      } catch {
        // A confirmed stop below is sufficient. If stop is also unconfirmed,
        // the fixed cleanup error wins and durable reconciliation takes over.
      }
    }
    try {
      await session.stop();
    } catch (stopError) {
      throw new PdfSandboxLifecycleError(
        "sandbox_stop_failed",
        operationFailed ? operationError : stopError,
      );
    }
  }
}
