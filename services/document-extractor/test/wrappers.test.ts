import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { configuredExtractionRunner } from "../src/configured-runner.js";
import { RunnerFailure } from "../src/errors.js";
import { PDF_BYTES, testConfiguration } from "./helpers.js";

async function fakeExecutable(source: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "paperpilot-poppler-test-"));
  const path = join(directory, "poppler.mjs");
  await writeFile(path, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function environment(
  scriptPath: string,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    PAPERPILOT_EXTRACTOR_PDFTOTEXT_COMMAND: process.execPath,
    PAPERPILOT_EXTRACTOR_PDFTOTEXT_ARGS_JSON: JSON.stringify([scriptPath, "text"]),
    PAPERPILOT_EXTRACTOR_PDFTOTEXT_VERSION_ARGS_JSON: JSON.stringify([scriptPath, "text-version"]),
    PAPERPILOT_EXTRACTOR_PDFINFO_COMMAND: process.execPath,
    PAPERPILOT_EXTRACTOR_PDFINFO_ARGS_JSON: JSON.stringify([scriptPath, "info"]),
    PAPERPILOT_EXTRACTOR_PDFINFO_VERSION_ARGS_JSON: JSON.stringify([scriptPath, "info-version"]),
    PAPERPILOT_EXTRACTOR_POPPLER_COMMAND_TIMEOUT_MS: "1000",
    ...overrides,
  };
}

function fakeSource(textAction: string, info = "Pages: 2\nEncrypted: no\n"): string {
  return `
    const mode = process.argv[2];
    if (mode === 'text-version') process.stderr.write('pdftotext version 25.06.0\\n');
    else if (mode === 'info-version') process.stderr.write('pdfinfo version 25.06.0\\n');
    else if (mode === 'info') process.stdout.write(${JSON.stringify(info)});
    else if (mode === 'text') { ${textAction} }
    else process.exitCode = 2;
  `;
}

async function inputFile(root: string): Promise<string> {
  const path = join(root, "input.pdf");
  await writeFile(path, PDF_BYTES, { mode: 0o600, flag: "wx" });
  return path;
}

function runnerFailure(kind?: RunnerFailure["kind"]): (error: unknown) => boolean {
  return (error) => error instanceof RunnerFailure && (kind === undefined || error.kind === kind);
}

describe("bounded Poppler wrapper", () => {
  it("extracts deterministic page-local chunks and reports matching tool versions", async () => {
    const fake = await fakeExecutable(fakeSource(
      "process.stdout.write('First line\\ncontinues\\n\\nSecond paragraph\\fPage two\\f');",
    ));
    const owned = await testConfiguration();
    try {
      const runner = configuredExtractionRunner(owned.configuration, environment(fake.path));
      assert.deepEqual(await runner.ready(new AbortController().signal), {
        engine: "poppler",
        engineVersion: "25.06.0",
      });
      const result = await runner.inspect(
        await inputFile(owned.configuration.tempRoot),
        new AbortController().signal,
      );
      assert.deepEqual(result, {
        outcome: "extracted",
        engine: "poppler",
        engineVersion: "25.06.0",
        pageCount: 2,
        chunkCount: 3,
        textBytes: Buffer.byteLength("First line continuesSecond paragraphPage two"),
        chunks: [
          { sequence: 0, pageNumber: 1, paragraphId: "p1-p1", text: "First line continues" },
          { sequence: 1, pageNumber: 1, paragraphId: "p1-p2", text: "Second paragraph" },
          { sequence: 2, pageNumber: 2, paragraphId: "p2-p1", text: "Page two" },
        ],
      });
    } finally {
      await owned.removeTempRoot();
      await fake.cleanup();
    }
  });

  it("returns no_text for image-only pages without inventing chunks", async () => {
    const fake = await fakeExecutable(fakeSource("process.stdout.write('\\f\\f');"));
    const owned = await testConfiguration();
    try {
      const result = await configuredExtractionRunner(
        owned.configuration,
        environment(fake.path),
      ).inspect(await inputFile(owned.configuration.tempRoot), new AbortController().signal);
      assert.deepEqual(result, {
        outcome: "no_text",
        engine: "poppler",
        engineVersion: "25.06.0",
        pageCount: 2,
        chunkCount: 0,
        textBytes: 0,
        chunks: [],
      });
    } finally {
      await owned.removeTempRoot();
      await fake.cleanup();
    }
  });

  it("fails closed for encryption, malformed UTF-8, page mismatch, and version mismatch", async () => {
    const cases = [
      {
        source: fakeSource("process.stdout.write('text');", "Pages: 1\nEncrypted: yes\n"),
        failure: "input_unsupported",
      },
      {
        source: fakeSource(
          "process.stdout.write(Buffer.from([0xc3, 0x28]));",
          "Pages: 1\nEncrypted: no\n",
        ),
        failure: "tool",
      },
      {
        source: fakeSource(
          "process.stdout.write('one\\ftwo\\f');",
          "Pages: 1\nEncrypted: no\n",
        ),
        failure: "tool",
      },
      {
        source: `
        const mode = process.argv[2];
        if (mode === 'text-version') process.stderr.write('pdftotext version 25.06.0\\n');
        else if (mode === 'info-version') process.stderr.write('pdfinfo version 24.01.0\\n');
      `,
        failure: "tool",
      },
    ] as const;
    for (const testCase of cases) {
      const fake = await fakeExecutable(testCase.source);
      const owned = await testConfiguration();
      try {
        const runner = configuredExtractionRunner(owned.configuration, environment(fake.path));
        const file = await inputFile(owned.configuration.tempRoot);
        await assert.rejects(
          runner.inspect(file, new AbortController().signal),
          runnerFailure(testCase.failure),
        );
      } finally {
        await owned.removeTempRoot();
        await fake.cleanup();
      }
    }
  });

  it("kills Poppler and rejects page, raw-output, normalized-text, and chunk bombs", async () => {
    const cases = [
      {
        source: fakeSource("process.stdout.write('text');", "Pages: 2001\nEncrypted: no\n"),
        config: {},
        environment: {},
        failure: "output_limit",
      },
      {
        source: fakeSource("process.stdout.write('x'.repeat(2048));", "Pages: 1\nEncrypted: no\n"),
        config: {
          PAPERPILOT_EXTRACTOR_MAX_TEXT_BYTES: "1024",
          PAPERPILOT_EXTRACTOR_MAX_CHUNK_BYTES: "256",
          PAPERPILOT_EXTRACTOR_MAX_CHUNKS: "10",
          PAPERPILOT_EXTRACTOR_MAX_RESPONSE_BYTES: "65536",
        },
        environment: { PAPERPILOT_EXTRACTOR_POPPLER_MAX_RAW_TEXT_BYTES: "1024" },
        failure: "output_limit",
      },
      {
        source: fakeSource(
          `process.stdout.write(Array.from({length: 11}, (_, i) => 'p' + i).join('\\n\\n'));`,
          "Pages: 1\nEncrypted: no\n",
        ),
        config: {
          PAPERPILOT_EXTRACTOR_MAX_TEXT_BYTES: "1024",
          PAPERPILOT_EXTRACTOR_MAX_CHUNK_BYTES: "256",
          PAPERPILOT_EXTRACTOR_MAX_CHUNKS: "10",
          PAPERPILOT_EXTRACTOR_MAX_RESPONSE_BYTES: "65536",
        },
        environment: { PAPERPILOT_EXTRACTOR_POPPLER_MAX_RAW_TEXT_BYTES: "1024" },
        failure: "output_limit",
      },
      {
        source: fakeSource("setInterval(() => {}, 1000);", "Pages: 1\nEncrypted: no\n"),
        config: {},
        environment: { PAPERPILOT_EXTRACTOR_POPPLER_COMMAND_TIMEOUT_MS: "100" },
        failure: "tool",
      },
    ] as const;

    for (const testCase of cases) {
      const fake = await fakeExecutable(testCase.source);
      const owned = await testConfiguration(testCase.config);
      try {
        const runner = configuredExtractionRunner(owned.configuration, environment(
          fake.path,
          testCase.environment,
        ));
        await assert.rejects(
          runner.inspect(
            await inputFile(owned.configuration.tempRoot),
            new AbortController().signal,
          ),
          runnerFailure(testCase.failure),
        );
      } finally {
        await owned.removeTempRoot();
        await fake.cleanup();
      }
    }
  });
});
