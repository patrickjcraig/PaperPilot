import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PdfSandboxLifecycleError,
  withDisposablePdfSandbox,
  type DisposablePdfSandboxSession,
  type PdfSandboxCreateOptions,
  type PdfSandboxSessionFactory,
} from "./pdf-sandbox-lifecycle";

const INPUT = Object.freeze({
  jobAttemptId: "attempt-1",
  image: `paperpilot-pdf-tools@sha256:${"a".repeat(64)}`,
  timeoutMs: 15 * 60 * 1_000,
  vcpus: 2 as const,
});

function fixture(options: {
  persistent?: boolean;
  stopFails?: boolean;
  sandboxId?: string;
  denyFails?: boolean;
  abortAfterCreate?: AbortController;
} = {}): {
  factory: PdfSandboxSessionFactory;
  created: PdfSandboxCreateOptions[];
  networkTransitions: string[];
  stopped: string[];
} {
  const created: PdfSandboxCreateOptions[] = [];
  const networkTransitions: string[] = [];
  const stopped: string[] = [];
  return {
    created,
    networkTransitions,
    stopped,
    factory: {
      async create(createOptions) {
        created.push(createOptions);
        options.abortAfterCreate?.abort(new Error("cancelled after create"));
        const session: DisposablePdfSandboxSession = {
          name: options.sandboxId ?? "sandbox-1",
          persistent: options.persistent ?? false,
          async update(parameters) {
            assert.deepEqual(parameters, { networkPolicy: "deny-all" });
            networkTransitions.push("deny-all");
            if (options.denyFails) throw new Error("provider air-gap failed");
          },
          async stop() {
            stopped.push(session.name);
            if (options.stopFails) throw new Error("provider cleanup failed");
          },
        };
        return session;
      },
    },
  };
}

describe("disposable PDF Sandbox lifecycle", () => {
  it("always requests persistence off and stops after success", async () => {
    const state = fixture();
    const result = await withDisposablePdfSandbox(
      state.factory,
      INPUT,
      async () => undefined,
      async () => "receipt-1",
    );

    assert.deepEqual(result, { sandboxId: "sandbox-1", value: "receipt-1" });
    assert.equal(state.created.length, 1);
    assert.equal(state.created[0]?.persistent, false);
    assert.equal(state.created[0]?.networkPolicy, "deny-all");
    assert.deepEqual(state.created[0]?.tags, {
      jobAttemptId: INPUT.jobAttemptId,
    });
    assert.deepEqual(state.networkTransitions, ["deny-all"]);
    assert.deepEqual(state.stopped, ["sandbox-1"]);
  });

  it("stops after the processing callback throws and preserves that cause", async () => {
    const state = fixture();
    const failure = new Error("processing rejected");

    await assert.rejects(
      withDisposablePdfSandbox(
        state.factory,
        INPUT,
        async () => undefined,
        async () => {
          throw failure;
        },
      ),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(state.stopped, ["sandbox-1"]);
  });

  it("surfaces unconfirmed cleanup even when processing also fails", async () => {
    const state = fixture({ stopFails: true });
    const failure = new Error("processing rejected");

    await assert.rejects(
      withDisposablePdfSandbox(
        state.factory,
        INPUT,
        async () => undefined,
        async () => {
          throw failure;
        },
      ),
      (error: unknown) =>
        error instanceof PdfSandboxLifecycleError
        && error.code === "sandbox_stop_failed"
        && error.cause === failure,
    );
    assert.deepEqual(state.stopped, ["sandbox-1"]);
  });

  it("stops and rejects a provider session that is unexpectedly persistent", async () => {
    const state = fixture({ persistent: true });
    let invoked = false;

    await assert.rejects(
      withDisposablePdfSandbox(
        state.factory,
        INPUT,
        async () => {
          invoked = true;
        },
        async () => undefined,
      ),
      (error: unknown) =>
        error instanceof PdfSandboxLifecycleError
        && error.code === "persistent_sandbox_rejected",
    );
    assert.equal(invoked, false);
    assert.deepEqual(state.stopped, ["sandbox-1"]);
  });

  it("fails a successful attempt when termination cannot be confirmed", async () => {
    const state = fixture({ stopFails: true });
    await assert.rejects(
      withDisposablePdfSandbox(
        state.factory,
        INPUT,
        async () => undefined,
        async () => "receipt",
      ),
      (error: unknown) =>
        error instanceof PdfSandboxLifecycleError
        && error.code === "sandbox_stop_failed",
    );
  });

  it("stops and rejects a malformed provider session", async () => {
    const state = fixture({ sandboxId: "not/a/sandbox" });
    let invoked = false;

    await assert.rejects(
      withDisposablePdfSandbox(
        state.factory,
        INPUT,
        async () => {
          invoked = true;
        },
        async () => undefined,
      ),
      (error: unknown) =>
        error instanceof PdfSandboxLifecycleError
        && error.code === "invalid_provider_session",
    );
    assert.equal(invoked, false);
    assert.deepEqual(state.stopped, ["not/a/sandbox"]);
  });

  it("rejects unpinned images before creating a Sandbox", async () => {
    const state = fixture();
    await assert.rejects(
      withDisposablePdfSandbox(
        state.factory,
        { ...INPUT, image: "paperpilot-pdf-tools:latest" },
        async () => undefined,
        async () => undefined,
      ),
      (error: unknown) =>
        error instanceof PdfSandboxLifecycleError
        && error.code === "invalid_launch_contract",
    );
    assert.equal(state.created.length, 0);
  });

  it("never begins preparation when cancellation wins after create", async () => {
    const controller = new AbortController();
    const state = fixture({ abortAfterCreate: controller });
    let invoked = false;

    await assert.rejects(
      withDisposablePdfSandbox(
        state.factory,
        { ...INPUT, signal: controller.signal },
        async () => {
          invoked = true;
        },
        async () => undefined,
      ),
      (error: unknown) => error === controller.signal.reason,
    );
    assert.equal(invoked, false);
    assert.deepEqual(state.networkTransitions, ["deny-all"]);
    assert.deepEqual(state.stopped, ["sandbox-1"]);
  });

  it("never begins offline processing unless the deny-all transition succeeds", async () => {
    const state = fixture({ denyFails: true });
    let processed = false;

    await assert.rejects(
      withDisposablePdfSandbox(
        state.factory,
        INPUT,
        async () => undefined,
        async () => {
          processed = true;
        },
      ),
      (error: unknown) =>
        error instanceof PdfSandboxLifecycleError
        && error.code === "sandbox_air_gap_failed",
    );
    assert.equal(processed, false);
    assert.deepEqual(state.networkTransitions, ["deny-all", "deny-all"]);
    assert.deepEqual(state.stopped, ["sandbox-1"]);
  });
});
