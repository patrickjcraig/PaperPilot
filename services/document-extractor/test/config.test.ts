import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  HARD_MAX_BODY_BYTES,
  HARD_MAX_CHUNK_BYTES,
  HARD_MAX_CHUNK_COUNT,
  HARD_MAX_PAGE_COUNT,
  HARD_MAX_RESPONSE_BYTES,
  HARD_MAX_TEXT_BYTES,
  extractorConfigurationFromEnvironment,
} from "../src/config.js";
import { BEARER_SECRET, POLICY_VERSION, TOOLCHAIN_DIGEST } from "./helpers.js";

async function withRoot(action: (root: string) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "paperpilot-extractor-config-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function environment(root: string): Record<string, string> {
  return {
    PAPERPILOT_EXTRACTOR_BEARER_SECRET: BEARER_SECRET,
    PAPERPILOT_EXTRACTOR_POLICY_VERSION: POLICY_VERSION,
    PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST: TOOLCHAIN_DIGEST,
    PAPERPILOT_EXTRACTOR_TEMP_ROOT: root,
    ...(process.platform === "win32"
      ? { PAPERPILOT_EXTRACTOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT: "1" }
      : {}),
  };
}

describe("extractor configuration", () => {
  it("uses the compiled custody, text, response, concurrency, and deadline caps", async () => {
    await withRoot((root) => {
      const value = extractorConfigurationFromEnvironment(environment(root));
      assert.equal(value.route, "/v1/extract-pdf");
      assert.equal(value.maxBodyBytes, HARD_MAX_BODY_BYTES);
      assert.equal(value.maxPageCount, HARD_MAX_PAGE_COUNT);
      assert.equal(value.maxTextBytes, HARD_MAX_TEXT_BYTES);
      assert.equal(value.maxChunkCount, HARD_MAX_CHUNK_COUNT);
      assert.equal(value.maxChunkBytes, HARD_MAX_CHUNK_BYTES);
      assert.equal(value.maxResponseBytes, HARD_MAX_RESPONSE_BYTES);
      assert.equal(value.singleUse, false);
      assert.ok(value.bodyAbsoluteTimeoutMs + value.extractionTimeoutMs < 60_000);
    });
  });

  it("requires a canonical single-use flag and enforces its concurrency-one hard cap", async () => {
    await withRoot((root) => {
      assert.throws(() => extractorConfigurationFromEnvironment({
        ...environment(root),
        PAPERPILOT_EXTRACTOR_SINGLE_USE: "true",
      }));
      assert.throws(() => extractorConfigurationFromEnvironment({
        ...environment(root),
        PAPERPILOT_EXTRACTOR_SINGLE_USE: "1",
        PAPERPILOT_EXTRACTOR_MAX_CONCURRENT: "2",
      }));
      const value = extractorConfigurationFromEnvironment({
        ...environment(root),
        PAPERPILOT_EXTRACTOR_SINGLE_USE: "1",
        PAPERPILOT_EXTRACTOR_MAX_CONCURRENT: "1",
      });
      assert.equal(value.singleUse, true);
      assert.equal(value.maxConcurrentExtractions, 1);
    });
  });

  it("fails production closed unless single-use concurrency one is explicit", async () => {
    await withRoot((root) => {
      if (process.platform === "win32") return;
      assert.throws(() => extractorConfigurationFromEnvironment({
        ...environment(root),
        NODE_ENV: "production",
      }));
      const value = extractorConfigurationFromEnvironment({
        ...environment(root),
        NODE_ENV: "production",
        PAPERPILOT_EXTRACTOR_SINGLE_USE: "1",
        PAPERPILOT_EXTRACTOR_MAX_CONCURRENT: "1",
      });
      assert.equal(value.production, true);
      assert.equal(value.singleUse, true);
    });
  });

  it("rejects placeholders, hard-cap expansion, and inconsistent response memory", async () => {
    await withRoot((root) => {
      for (const overrides of [
        { PAPERPILOT_EXTRACTOR_BEARER_SECRET: "change-me".padEnd(40, "x") },
        { PAPERPILOT_EXTRACTOR_BEARER_SECRET: ` ${"x".repeat(40)}` },
        { PAPERPILOT_EXTRACTOR_MAX_BODY_BYTES: String(HARD_MAX_BODY_BYTES + 1) },
        { PAPERPILOT_EXTRACTOR_MAX_PAGES: "2001" },
        { PAPERPILOT_EXTRACTOR_MAX_TEXT_BYTES: String(HARD_MAX_TEXT_BYTES + 1) },
        { PAPERPILOT_EXTRACTOR_MAX_CHUNKS: "4097" },
        { PAPERPILOT_EXTRACTOR_MAX_CHUNK_BYTES: "8193" },
        { PAPERPILOT_EXTRACTOR_MAX_RESPONSE_BYTES: "65536" },
        { PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST: "C".repeat(64) },
        { PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST: "0".repeat(64) },
      ]) {
        assert.throws(() => extractorConfigurationFromEnvironment({
          ...environment(root),
          ...overrides,
        }));
      }
    });
  });

  it("fails closed on Windows without the explicit non-production acknowledgement", async () => {
    await withRoot((root) => {
      if (process.platform !== "win32") return;
      const input = environment(root);
      delete input.PAPERPILOT_EXTRACTOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT;
      assert.throws(() => extractorConfigurationFromEnvironment(input));
      assert.throws(() => extractorConfigurationFromEnvironment({
        ...environment(root),
        NODE_ENV: "production",
      }));
    });
  });
});
