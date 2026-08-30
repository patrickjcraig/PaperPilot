import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { validatorConfigurationFromEnvironment } from "../src/config.js";
import { BEARER_SECRET, POLICY_VERSION, TOOLCHAIN_DIGEST } from "./helpers.js";

async function withTempRoot(
  action: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "paperpilot-validator-config-"));
  try {
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function environment(root: string): Record<string, string> {
  return {
    PAPERPILOT_VALIDATOR_BEARER_SECRET: BEARER_SECRET,
    PAPERPILOT_VALIDATOR_POLICY_VERSION: POLICY_VERSION,
    PAPERPILOT_VALIDATOR_TOOLCHAIN_DIGEST: TOOLCHAIN_DIGEST,
    PAPERPILOT_VALIDATOR_TEMP_ROOT: root,
    ...(process.platform === "win32"
      ? { PAPERPILOT_VALIDATOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT: "1" }
      : {}),
  };
}

describe("validator configuration", () => {
  it("uses bounded defaults with end-to-end deadline and signature-freshness margin", async () => {
    await withTempRoot((root) => {
      const value = validatorConfigurationFromEnvironment(environment(root));
      assert.equal(value.route, "/v1/validate-pdf");
      assert.equal(value.maxAttestationBytes, 16 * 1_024);
      assert.equal(value.bodyIdleTimeoutMs, 3_000);
      assert.equal(value.bodyAbsoluteTimeoutMs, 5_000);
      assert.equal(value.validationTimeoutMs, 20_000);
      assert.ok(value.bodyAbsoluteTimeoutMs + value.validationTimeoutMs < 30_000);
      assert.equal(value.signatureReadinessMaxAgeMs, 23 * 60 * 60 * 1_000);
      assert.equal(value.signatureFutureClockSkewMs, 5 * 60 * 1_000);
      assert.equal(value.production, false);
      assert.equal(value.unsafeWindowsDevelopment, process.platform === "win32");
    });
  });

  it("refuses the insecure Windows acknowledgement in production", async () => {
    await withTempRoot((root) => {
      const productionEnvironment = {
        ...environment(root),
        NODE_ENV: "production",
      };
      if (process.platform === "win32") {
        assert.throws(() => validatorConfigurationFromEnvironment(productionEnvironment));
      } else {
        const value = validatorConfigurationFromEnvironment(productionEnvironment);
        assert.equal(value.production, true);
        assert.equal(value.unsafeWindowsDevelopment, false);
      }
    });
  });

  it("fails closed on Windows unless insecure local development is explicit", async () => {
    await withTempRoot((root) => {
      if (process.platform !== "win32") return;
      const input = environment(root);
      delete input.PAPERPILOT_VALIDATOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT;
      assert.throws(() => validatorConfigurationFromEnvironment(input));
      assert.throws(() => validatorConfigurationFromEnvironment({
        ...input,
        PAPERPILOT_VALIDATOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT: "true",
      }));
    });
  });

  it("rejects short, whitespace, and placeholder bearer secrets like the worker", async () => {
    await withTempRoot((root) => {
      for (const secret of [
        "short",
        "x".repeat(31),
        ` ${"x".repeat(40)}`,
        "change-me".padEnd(40, "x"),
        "this-is-an-example-secret".padEnd(40, "x"),
        "replace_this_validator_secret".padEnd(40, "x"),
        "placeholder".padEnd(40, "x"),
      ]) {
        assert.throws(() => validatorConfigurationFromEnvironment({
          ...environment(root),
          PAPERPILOT_VALIDATOR_BEARER_SECRET: secret,
        }));
      }
    });
  });

  it("rejects attempts to expand compiled boundaries or weaken canonical syntax", async () => {
    await withTempRoot((root) => {
      for (const override of [
        { PAPERPILOT_VALIDATOR_MAX_ATTESTATION_BYTES: "1023" },
        { PAPERPILOT_VALIDATOR_MAX_ATTESTATION_BYTES: "16385" },
        { PAPERPILOT_VALIDATOR_MAX_BODY_BYTES: "01" },
        { PAPERPILOT_VALIDATOR_PORT: "65536" },
        { PAPERPILOT_VALIDATOR_HOST: "127.0.0.1\r\nX-Bad: true" },
        { PAPERPILOT_VALIDATOR_ROUTE: "/v1/validate-pdf?fast=true" },
        { PAPERPILOT_VALIDATOR_TOOLCHAIN_DIGEST: "B".repeat(64) },
        { PAPERPILOT_VALIDATOR_SIGNATURE_FUTURE_CLOCK_SKEW_MS: "3600001" },
        {
          PAPERPILOT_VALIDATOR_SIGNATURE_READINESS_MAX_AGE_MS: "60000",
          PAPERPILOT_VALIDATOR_SIGNATURE_FUTURE_CLOCK_SKEW_MS: "60000",
        },
      ]) {
        assert.throws(() => validatorConfigurationFromEnvironment({
          ...environment(root),
          ...override,
        }));
      }
    });
  });
});
