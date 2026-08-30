import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RunnerFailure } from "../src/errors.js";
import { runCommand } from "../src/process-runner.js";

async function fakeScript(source: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "paperpilot-process-test-"));
  const path = join(directory, "fake.mjs");
  await writeFile(path, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function failureKind(kind: RunnerFailure["kind"]): (error: unknown) => boolean {
  return (error) => error instanceof RunnerFailure && error.kind === kind;
}

async function waitUntil(action: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await action()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the process condition.");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("bounded subprocess runner", () => {
  it("enforces a wall-clock timeout and terminates a non-cooperating child", async () => {
    const fake = await fakeScript("setInterval(() => {}, 1000);\n");
    try {
      const startedAt = Date.now();
      await assert.rejects(runCommand({
        executable: process.execPath,
        args: [fake.path],
        timeoutMs: 100,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      }, new AbortController().signal), failureKind("timeout"));
      assert.ok(Date.now() - startedAt < 3_000);
    } finally {
      await fake.cleanup();
    }
  });

  it("kills commands that exceed bounded output", async () => {
    const fake = await fakeScript("process.stdout.write('x'.repeat(4096));\n");
    try {
      await assert.rejects(runCommand({
        executable: process.execPath,
        args: [fake.path],
        timeoutMs: 2_000,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
      }, new AbortController().signal), failureKind("output_limit"));
    } finally {
      await fake.cleanup();
    }
  });

  it("does not inherit PaperPilot secrets into tool processes", async () => {
    const variable = "PAPERPILOT_VALIDATOR_BEARER_SECRET";
    const previous = process.env[variable];
    process.env[variable] = "must-not-enter-the-tool";
    const fake = await fakeScript(
      `process.stdout.write(process.env.${variable} === undefined ? 'absent' : 'present');\n`,
    );
    try {
      const result = await runCommand({
        executable: process.execPath,
        args: [fake.path],
        timeoutMs: 2_000,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
      }, new AbortController().signal);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.toString("utf8"), "absent");
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
      await fake.cleanup();
    }
  });

  it("reaps a nested wrapper's non-cooperating scanner descendant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperpilot-process-tree-test-"));
    const survivorPath = join(directory, "survivor.mjs");
    const scannerPath = join(directory, "scanner.mjs");
    const wrapperPath = join(directory, "wrapper.mjs");
    const pidPath = join(directory, "grandchild.pid");
    const runnerUrl = new URL("../src/process-runner.js", import.meta.url).href;
    await writeFile(survivorPath, `
      import { writeFile } from 'node:fs/promises';
      await writeFile(process.argv[2], String(process.pid), 'utf8');
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(scannerPath, `
      import { spawn } from 'node:child_process';
      spawn(process.execPath, [${JSON.stringify(survivorPath)}, ${JSON.stringify(pidPath)}], {
        stdio: 'ignore',
        windowsHide: true,
      });
      process.once('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(wrapperPath, `
      import { runCommand } from ${JSON.stringify(runnerUrl)};
      const controller = new AbortController();
      process.once('SIGTERM', () => controller.abort());
      process.once('SIGINT', () => controller.abort());
      try {
        await runCommand({
          executable: process.execPath,
          args: [${JSON.stringify(scannerPath)}],
          timeoutMs: 10000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          terminationGraceMs: 250,
        }, controller.signal);
      } catch {
        process.exitCode = 70;
      }
    `, { encoding: "utf8", mode: 0o600, flag: "wx" });

    let grandchildPid: number | null = null;
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
          grandchildPid = Number(await readFile(pidPath, "utf8"));
          return Number.isSafeInteger(grandchildPid) && grandchildPid > 0;
        } catch {
          return false;
        }
      }, 2_000);
      await assert.rejects(result, failureKind("timeout"));
      await waitUntil(() => grandchildPid !== null && !processIsAlive(grandchildPid), 2_000);
    } finally {
      if (grandchildPid !== null && processIsAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // It may have exited between the liveness check and cleanup.
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
