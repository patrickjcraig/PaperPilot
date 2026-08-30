import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CommandExtractionRunner,
  type CommandTemplate,
} from "../src/command-protocol.js";
import { RunnerFailure } from "../src/errors.js";

function failure(kind: RunnerFailure["kind"]): (error: unknown) => boolean {
  return (error) => error instanceof RunnerFailure && error.kind === kind;
}

function command(scriptPath: string, mode: string): CommandTemplate {
  return {
    executable: process.execPath,
    args: [scriptPath, mode, "{file}"],
    timeoutMs: 1_000,
    maxStdoutBytes: 4 * 1_024,
    maxStderrBytes: 4 * 1_024,
  };
}

describe("extractor wrapper command protocol", () => {
  it("recognizes only exact explicit deterministic wrapper failure envelopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperpilot-extractor-protocol-"));
    const scriptPath = join(root, "runner.mjs");
    const inputPath = join(root, "input.pdf");
    await writeFile(inputPath, "%PDF-1.7\n", { mode: 0o600, flag: "wx" });
    await writeFile(scriptPath, `
      const mode = process.argv[2];
      const values = {
        unsupported: { schemaVersion: 1, error: { code: "extraction_input_unsupported" } },
        resource: { schemaVersion: 1, error: { code: "extraction_resource_limit" } },
        open: {
          schemaVersion: 1,
          error: { code: "extraction_input_unsupported", privateDiagnostic: "must not pass" },
        },
        unknown: { schemaVersion: 1, error: { code: "other" } },
      };
      if (mode === "malformed") process.stdout.write("{not-json");
      else process.stdout.write(JSON.stringify(values[mode]));
    `, { encoding: "utf8", mode: 0o600, flag: "wx" });

    try {
      const createRunner = (mode: string) => new CommandExtractionRunner({
        probe: command(scriptPath, mode),
        inspect: command(scriptPath, mode),
        limits: {
          maxPageCount: 10,
          maxTextBytes: 4 * 1_024,
          maxChunkCount: 10,
          maxChunkBytes: 1 * 1_024,
        },
      });

      await assert.rejects(
        createRunner("unsupported").inspect(inputPath, new AbortController().signal),
        failure("input_unsupported"),
      );
      await assert.rejects(
        createRunner("resource").inspect(inputPath, new AbortController().signal),
        failure("output_limit"),
      );
      for (const mode of ["malformed", "open", "unknown"] as const) {
        await assert.rejects(
          createRunner(mode).inspect(inputPath, new AbortController().signal),
          failure("protocol"),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
