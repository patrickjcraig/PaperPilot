import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RunnerFailure } from "../src/errors.js";
import { runCommand } from "../src/process-runner.js";

function failure(kind: RunnerFailure["kind"]): (error: unknown) => boolean {
  return (error) => error instanceof RunnerFailure && error.kind === kind;
}

async function script(source: string): Promise<{ path: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "paperpilot-extractor-process-"));
  const path = join(directory, "tool.mjs");
  await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function waitUntil(action: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await action()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process state.");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("extractor subprocess runner", () => {
  it("enforces timeout, caller abort, and output ceilings", async () => {
    const hanging = await script("setInterval(() => {}, 1000);\n");
    const noisy = await script("process.stdout.write('x'.repeat(4096));\n");
    try {
      await assert.rejects(runCommand({
        executable: process.execPath,
        args: [hanging.path],
        timeoutMs: 100,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      }, new AbortController().signal), failure("timeout"));

      const controller = new AbortController();
      const aborted = runCommand({
        executable: process.execPath,
        args: [hanging.path],
        timeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      }, controller.signal);
      controller.abort();
      await assert.rejects(aborted, failure("aborted"));

      await assert.rejects(runCommand({
        executable: process.execPath,
        args: [noisy.path],
        timeoutMs: 2_000,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
      }, new AbortController().signal), failure("output_limit"));
    } finally {
      await hanging.cleanup();
      await noisy.cleanup();
    }
  });

  it("reaps a wrapper's signal-resistant Poppler descendant after its leader exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperpilot-extractor-tree-"));
    const survivorPath = join(directory, "survivor.mjs");
    const popplerPath = join(directory, "poppler.mjs");
    const wrapperPath = join(directory, "wrapper.mjs");
    const pidPath = join(directory, "survivor.pid");
    const runnerUrl = new URL("../src/process-runner.js", import.meta.url).href;
    await writeFile(survivorPath, `
      import { writeFile } from 'node:fs/promises';
      await writeFile(process.argv[2], String(process.pid), 'utf8');
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(popplerPath, `
      import { spawn } from 'node:child_process';
      spawn(process.execPath, [${JSON.stringify(survivorPath)}, ${JSON.stringify(pidPath)}], {
        stdio: 'ignore', windowsHide: true,
      });
      process.once('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(wrapperPath, `
      import { runCommand } from ${JSON.stringify(runnerUrl)};
      const controller = new AbortController();
      process.once('SIGTERM', () => controller.abort());
      try {
        await runCommand({ executable: process.execPath, args: [${JSON.stringify(popplerPath)}],
          timeoutMs: 10000, maxStdoutBytes: 1024, maxStderrBytes: 1024,
          terminationGraceMs: 250 }, controller.signal);
      } catch { process.exitCode = 70; }
    `, { encoding: "utf8", flag: "wx", mode: 0o600 });

    let pid: number | null = null;
    try {
      const result = runCommand({
        executable: process.execPath,
        args: [wrapperPath],
        timeoutMs: 750,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        terminationGraceMs: 1_200,
      }, new AbortController().signal);
      await waitUntil(async () => {
        try {
          pid = Number(await readFile(pidPath, "utf8"));
          return Number.isSafeInteger(pid) && pid > 0;
        } catch { return false; }
      }, 2_000);
      await assert.rejects(result, failure("timeout"));
      await waitUntil(() => pid !== null && !alive(pid), 2_000);
    } finally {
      if (pid !== null && alive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* It may have just exited. */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
