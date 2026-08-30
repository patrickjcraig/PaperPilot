import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

import { RunnerFailure } from "./errors.js";

const MAX_ARGUMENT_CHARACTERS = 8 * 1_024;
const MAX_ARGUMENTS = 128;
const MAX_EXECUTABLE_CHARACTERS = 2 * 1_024;

export interface CommandSpec {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  terminationGraceMs?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
}

function validateCommand(spec: CommandSpec): void {
  if (
    typeof spec.executable !== "string"
    || spec.executable.length === 0
    || spec.executable.length > MAX_EXECUTABLE_CHARACTERS
    || spec.executable.includes("\0")
    || !Array.isArray(spec.args)
    || spec.args.length > MAX_ARGUMENTS
    || spec.args.some((argument) =>
      typeof argument !== "string"
      || argument.length > MAX_ARGUMENT_CHARACTERS
      || argument.includes("\0"))
    || (spec.cwd !== undefined && (
      !isAbsolute(spec.cwd) || spec.cwd.length > 4 * 1_024 || spec.cwd.includes("\0")
    ))
    || !Number.isSafeInteger(spec.timeoutMs)
    || spec.timeoutMs < 1
    || spec.timeoutMs > 120_000
    || !Number.isSafeInteger(spec.maxStdoutBytes)
    || spec.maxStdoutBytes < 1
    || spec.maxStdoutBytes > 16 * 1_024 * 1_024
    || !Number.isSafeInteger(spec.maxStderrBytes)
    || spec.maxStderrBytes < 1
    || spec.maxStderrBytes > 4 * 1_024 * 1_024
    || (spec.terminationGraceMs !== undefined && (
      !Number.isSafeInteger(spec.terminationGraceMs)
      || spec.terminationGraceMs < 50
      || spec.terminationGraceMs > 5_000
    ))
  ) {
    throw new RunnerFailure("protocol");
  }
}

function inheritedToolEnvironment(): NodeJS.ProcessEnv {
  const environment = {} as NodeJS.ProcessEnv;
  for (const name of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.unref();
    } catch {
      try { child.kill(signal); } catch { /* The process may already have exited. */ }
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* The process group may already have exited. */ }
  }
}

/** Shell-free, output-bounded execution with whole-tree cancellation. */
export async function runCommand(spec: CommandSpec, signal: AbortSignal): Promise<CommandResult> {
  validateCommand(spec);
  if (signal.aborted) throw new RunnerFailure("aborted");

  const startedAt = performance.now();
  return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, [...spec.args], {
        detached: process.platform !== "win32",
        env: { ...inheritedToolEnvironment(), ...spec.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      });
    } catch {
      rejectPromise(new RunnerFailure("spawn"));
      return;
    }

    let settled = false;
    let cancellation: RunnerFailure["kind"] | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let terminationTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (kind: RunnerFailure["kind"]) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new RunnerFailure(kind));
    };
    const cancel = (kind: RunnerFailure["kind"]) => {
      if (cancellation !== null || settled) return;
      cancellation = kind;
      signalProcessTree(child, "SIGTERM");
      terminationTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        fail(kind);
      }, spec.terminationGraceMs ?? 250);
      // This timer intentionally remains referenced: a direct wrapper exit
      // must not let Node terminate before signal-resistant descendants die.
    };
    const onAbort = () => cancel("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => cancel("timeout"), spec.timeoutMs);
    timeout.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > spec.maxStdoutBytes) {
        cancel("output_limit");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > spec.maxStderrBytes) {
        cancel("output_limit");
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", () => fail("spawn"));
    child.once("close", (exitCode, exitSignal) => {
      if (settled || cancellation !== null) return;
      settled = true;
      cleanup();
      resolvePromise({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    });
  });
}
