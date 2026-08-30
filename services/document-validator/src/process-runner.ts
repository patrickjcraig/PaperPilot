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
      !isAbsolute(spec.cwd)
      || spec.cwd.length > 4 * 1_024
      || spec.cwd.includes("\0")
    ))
    || !Number.isSafeInteger(spec.timeoutMs)
    || spec.timeoutMs < 1
    || spec.timeoutMs > 120_000
    || !Number.isSafeInteger(spec.maxStdoutBytes)
    || spec.maxStdoutBytes < 1
    || spec.maxStdoutBytes > 32 * 1_024 * 1_024
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
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // Windows has no Node API for a graceful process-tree signal. Start the
    // tree kill before the wrapper PID can disappear; killing only the wrapper
    // first can orphan its scanner child.
    try {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.unref();
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process tree may already have exited.
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between the close check and this signal.
    }
  }
}

/**
 * Runs one configured executable without a shell. Cancellation first signals
 * the entire POSIX process group, then escalates to SIGKILL. On Windows it
 * escalates through taskkill /T /F. Raw command output is returned only to the
 * bounded protocol decoder and is never logged here.
 */
export async function runCommand(
  spec: CommandSpec,
  signal: AbortSignal,
): Promise<CommandResult> {
  validateCommand(spec);
  if (signal.aborted) throw new RunnerFailure("aborted");

  const startedAt = performance.now();
  return new Promise<CommandResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      const environment = {
        ...inheritedToolEnvironment(),
        ...spec.environment,
      };
      child = spawn(spec.executable, [...spec.args], {
        detached: process.platform !== "win32",
        env: environment as NodeJS.ProcessEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      });
    } catch {
      reject(new RunnerFailure("spawn"));
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
    const finishFailure = (kind: RunnerFailure["kind"]) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RunnerFailure(kind));
    };
    const cancel = (kind: RunnerFailure["kind"]) => {
      if (cancellation !== null || settled) return;
      cancellation = kind;
      signalProcessTree(child, "SIGTERM");
      // Do not settle merely because the direct child exits. A wrapper can
      // exit after forwarding SIGTERM while a detached scanner descendant
      // ignores it. Keep the original process-group id reserved for the grace
      // interval, force-kill the whole group, and only then reject.
      terminationTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        finishFailure(kind);
      }, spec.terminationGraceMs ?? 250);
      // Keep the wrapper alive until escalation. An unresolved Promise and an
      // unref'ed timer do not keep Node alive after the direct child closes.
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
    child.once("error", () => finishFailure("spawn"));
    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      if (cancellation !== null) {
        // The cancellation timer owns settlement so its SIGKILL still reaches
        // descendants even when this direct process has already closed.
        return;
      }
      settled = true;
      cleanup();
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    });
  });
}
