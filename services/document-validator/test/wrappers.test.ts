import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { configuredInspectionRunners } from "../src/configured-runners.js";
import { RunnerFailure } from "../src/errors.js";
import { createDocumentValidatorService } from "../src/service.js";
import { canonicalToolTimestamp } from "../wrappers/common.js";
import {
  BEARER_SECRET,
  InjectedPdfRunner,
  PDF_BYTES,
  httpRequest,
  testConfiguration,
} from "./helpers.js";

async function fakeExecutable(source: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "paperpilot-wrapper-test-"));
  const path = join(directory, "tool.mjs");
  await writeFile(path, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function clamEnvironment(scriptPath: string): Record<string, string> {
  return {
    PAPERPILOT_VALIDATOR_CLAM_COMMAND: process.execPath,
    PAPERPILOT_VALIDATOR_CLAM_ARGS_JSON: JSON.stringify([scriptPath, "scan"]),
    PAPERPILOT_VALIDATOR_CLAM_VERSION_ARGS_JSON: JSON.stringify([scriptPath, "version"]),
    PAPERPILOT_VALIDATOR_CLAM_TIMEOUT_MS: "1000",
  };
}

function qpdfEnvironment(scriptPath: string): Record<string, string> {
  return {
    PAPERPILOT_VALIDATOR_QPDF_COMMAND: process.execPath,
    PAPERPILOT_VALIDATOR_QPDF_ARGS_JSON: JSON.stringify([scriptPath]),
    PAPERPILOT_VALIDATOR_QPDF_VERSION_ARGS_JSON: JSON.stringify([scriptPath, "--version"]),
    PAPERPILOT_VALIDATOR_QPDF_COMMAND_TIMEOUT_MS: "1000",
    PAPERPILOT_VALIDATOR_QPDF_MAX_METADATA_BYTES: "65536",
  };
}

describe("stock-tool wrappers", () => {
  it("interprets Clam's zone-less ctime as UTC and rejects ambiguous formats", () => {
    assert.equal(
      canonicalToolTimestamp("Fri Aug 28 16:00:00 2026"),
      "2026-08-28T16:00:00.000Z",
    );
    assert.throws(() => canonicalToolTimestamp("2026-08-28 16:00:00"));
    assert.throws(() => canonicalToolTimestamp("Fri Aug 28 16:00:60 2026"));
  });

  it("normalizes stock Clam exit/version output into the closed malware protocol", async () => {
    const publication = new Date(Date.now() - 60 * 60 * 1_000).toUTCString();
    const fake = await fakeExecutable(`
      const mode = process.argv[2];
      if (mode === 'version') {
        process.stdout.write('ClamAV 1.4.3/27835/${publication}\\n');
      } else if (mode === 'scan') {
        process.stdout.write(process.argv[3] + ': OK\\n');
      } else process.exitCode = 2;
    `);
    const owned = await testConfiguration();
    try {
      const runners = configuredInspectionRunners(owned.configuration, clamEnvironment(fake.path));
      await runners.malwareRunner.ready(new AbortController().signal);
      const file = join(owned.configuration.tempRoot, "input.pdf");
      await writeFile(file, PDF_BYTES, { flag: "wx", mode: 0o600 });
      const result = await runners.malwareRunner.inspect(file, new AbortController().signal);
      assert.deepEqual(result, {
        verdict: "clean",
        engine: "clamav",
        engineVersion: "1.4.3",
        signatureVersion: "27835",
        signaturePublishedAt: new Date(publication).toISOString(),
        detectionCount: 0,
      });
    } finally {
      await owned.removeTempRoot();
      await fake.cleanup();
    }
  });

  it("turns stale Clam definition metadata into HTTP 503 readiness", async () => {
    const stalePublication = new Date(Date.now() - 25 * 60 * 60 * 1_000).toUTCString();
    const fake = await fakeExecutable(`
      if (process.argv[2] === 'version') {
        process.stdout.write('ClamAV 1.4.3/27800/${stalePublication}\\n');
      } else process.exitCode = 2;
    `);
    const owned = await testConfiguration();
    const runners = configuredInspectionRunners(
      owned.configuration,
      clamEnvironment(fake.path),
    );
    await assert.rejects(
      runners.malwareRunner.ready(new AbortController().signal),
      (error: unknown) => error instanceof RunnerFailure,
    );
    const service = createDocumentValidatorService(owned.configuration, {
      malwareRunner: runners.malwareRunner,
      pdfRunner: new InjectedPdfRunner(),
    });
    try {
      const bound = await service.listen();
      const host = bound.address.includes(":") ? `[${bound.address}]` : bound.address;
      const response = await httpRequest({
        baseUrl: `http://${host}:${bound.port}`,
        path: "/readyz",
        headers: { Authorization: `Bearer ${BEARER_SECRET}` },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(response.json(), {
        error: {
          code: "not_ready",
          message: "The document validator is not ready.",
        },
      });
    } finally {
      await service.close();
      await owned.removeTempRoot();
      await fake.cleanup();
    }
  });

  it("combines bounded qpdf checks, page/object metadata, and physical revision evidence", async () => {
    const fake = await fakeExecutable(`
      const args = process.argv.slice(2);
      if (args.includes('--version')) {
        process.stdout.write('qpdf version 12.4.0\\n');
      } else if (args.includes('--check')) {
        process.stdout.write('checking input.pdf\\nFile is not encrypted\\nFile is not linearized\\nNo syntax or stream encoding errors found; the file may still contain errors that qpdf cannot detect\\n');
      } else if (args.includes('--show-npages')) {
        process.stdout.write('2\\n');
      } else if (args.includes('--list-attachments')) {
        process.stdout.write('');
      } else if (args.includes('--json')) {
        process.stdout.write(JSON.stringify({ qpdf: [
          { jsonversion: 2, pdfversion: '1.7', maxobjectid: 2 },
          { 'obj:1 0 R': { value: {} }, 'obj:2 0 R': { value: {} }, trailer: { value: {} } }
        ] }));
      } else process.exitCode = 2;
    `);
    const owned = await testConfiguration();
    try {
      const runners = configuredInspectionRunners(
        owned.configuration,
        qpdfEnvironment(fake.path),
      );
      await runners.pdfRunner.ready(new AbortController().signal);
      const file = join(owned.configuration.tempRoot, "input.pdf");
      const header = Buffer.from("%PDF-1.7\n", "ascii");
      const chunkSize = 256 * 1_024;
      const boundaryPdf = Buffer.concat([
        header,
        Buffer.alloc(chunkSize - 4 - header.byteLength, 0x20),
        Buffer.from("startxref\n0\n%%EOF\n", "ascii"),
      ]);
      await writeFile(file, boundaryPdf, { flag: "wx", mode: 0o600 });
      const result = await runners.pdfRunner.inspect(file, new AbortController().signal);
      assert.deepEqual(result, {
        outcome: "valid",
        engine: "qpdf",
        engineVersion: "12.4.0",
        pdfVersion: "1.7",
        pageCount: 2,
        objectCount: 2,
        revisionCount: 1,
        warningCount: 0,
      });
    } finally {
      await owned.removeTempRoot();
      await fake.cleanup();
    }
  });

  it("rejects qpdf metadata/concurrency configurations above the aggregate memory bound", async () => {
    const owned = await testConfiguration({ PAPERPILOT_VALIDATOR_MAX_CONCURRENT: "64" });
    try {
      assert.throws(() => configuredInspectionRunners(owned.configuration, {
        PAPERPILOT_VALIDATOR_QPDF_MAX_METADATA_BYTES: String(2 * 1_024 * 1_024),
      }));
    } finally {
      await owned.removeTempRoot();
    }
  });
});
