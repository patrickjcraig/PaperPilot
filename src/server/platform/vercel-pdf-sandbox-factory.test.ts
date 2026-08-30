import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Sandbox as MockSandbox } from "@vercel/sandbox-mock";

import type { PdfSandboxCreateOptions } from "./pdf-sandbox-lifecycle";
import { createVercelPdfSandboxSession } from "./vercel-pdf-sandbox-factory";

const OPTIONS: PdfSandboxCreateOptions = Object.freeze({
  image: `paperpilot-pdf-tools@sha256:${"a".repeat(64)}`,
  persistent: false,
  timeoutMs: 15 * 60 * 1_000,
  vcpus: 2,
  networkPolicy: "deny-all",
  tags: Object.freeze({ jobAttemptId: "attempt-1" }),
});

describe("Vercel PDF Sandbox factory", () => {
  it("returns the native Workflow-serializable Sandbox with safe launch defaults", async () => {
    let observed: Parameters<typeof MockSandbox.create>[0];
    const sandbox = await createVercelPdfSandboxSession(OPTIONS, {
      async create(parameters) {
        observed = parameters;
        return MockSandbox.create(parameters);
      },
    });
    try {
      assert.equal(sandbox.persistent, false);
      assert.equal(observed?.image, OPTIONS.image);
      assert.equal(observed?.persistent, false);
      assert.equal(observed?.timeout, OPTIONS.timeoutMs);
      assert.deepEqual(observed?.resources, { vcpus: OPTIONS.vcpus });
      assert.equal(observed?.networkPolicy, "deny-all");
      assert.deepEqual(observed?.tags, OPTIONS.tags);

      const constructor = sandbox.constructor as unknown as Record<symbol, unknown>;
      const workflowSerialize = constructor[Symbol.for("workflow-serialize")];
      assert.equal(typeof workflowSerialize, "function");
      if (typeof workflowSerialize !== "function") {
        throw new TypeError("The native Sandbox serializer is unavailable.");
      }
      assert.doesNotThrow(() => workflowSerialize(sandbox));
    } finally {
      await sandbox.stop();
    }
  });
});
