/**
 * Argv-only process execution.
 *
 * Every external command helm runs goes through this module. One-shot work uses
 * `execFile`; long-lived streams use `spawn`. Both keep the default
 * `shell: false`, so the argument vector reaches the kernel unchanged and
 * adapter-supplied text can never be re-interpreted as shell syntax (SPEC R5,
 * AC 19). No helper here accepts a command string.
 */
import { execFile, spawn } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";

/** Result of one argv exec. Captures everything the audit log needs. */
export interface ExecResult {
  /** The exact argument vector, `argv[0]` first. */
  readonly argv: readonly string[];
  /** Process exit code, or `null` when the process was signalled or never started. */
  readonly exitCode: number | null;
  /** Signal that terminated the process, if any. */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Spawn-level failure (command not found, timeout, output over `maxBuffer`).
   * `null` when the process ran to completion, whatever its exit code.
   */
  readonly error: string | null;
  /**
   * Failure writing `input` to the child's stdin — EPIPE when the child exited
   * before draining it. Captured here rather than left to surface as an
   * unhandled stream `error` event, which would terminate the whole process.
   */
  readonly stdinError: string | null;
}

export interface StreamedProcessExit {
  /** Process exit code, or `null` when the process was signalled or never started. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /**
   * Spawn-level failure (command not found). `null` when the process ran to
   * completion, whatever its exit code.
   */
  readonly error: string | null;
}

/**
 * A long-lived argv child. `stdout`/`stderr` stay open until the process
 * exits; `kill` is the only way the caller stops it.
 */
export interface StreamedProcess {
  readonly argv: readonly string[];
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exit: Promise<StreamedProcessExit>;
  kill(signal?: NodeJS.Signals): void;
}

export interface StreamArgvOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunArgvOptions {
  /** Milliseconds before the child is killed. Default 30000. */
  readonly timeoutMs?: number;
  /** Max bytes captured per stream. Default 32 MiB — fleet snapshots are large. */
  readonly maxBuffer?: number;
  /** Written to the child's stdin, which is then closed. */
  readonly input?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Spawn `file` with `args` and keep its output streams. Never throws: a failed
 * spawn resolves {@link StreamedProcess.exit} with `error` set, the same way
 * {@link runArgv} reports ENOENT inside {@link ExecResult}.
 */
export function streamArgv(
  file: string,
  args: readonly string[],
  options: StreamArgvOptions = {},
): StreamedProcess {
  const argv = [file, ...args];
  const child = spawn(file, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env,
  });
  const stdout = child.stdout ?? endedReadable();
  const stderr = child.stderr ?? endedReadable();
  const exit = new Promise<StreamedProcessExit>((resolve) => {
    child.on("error", (cause: Error) => {
      resolve({ exitCode: null, signal: null, error: `${argv[0]}: ${cause.message}` });
    });
    child.on("close", (code, signal) => {
      resolve({ exitCode: code, signal, error: null });
    });
  });
  return {
    argv,
    stdout,
    stderr,
    exit,
    kill: (signal = "SIGTERM") => {
      child.kill(signal);
    },
  };
}

function endedReadable(): Readable {
  const stream = new PassThrough();
  stream.end();
  return stream;
}

/** Thrown by {@link runArgvOrThrow} when a command fails. Carries the full result. */
export class ExecFailure extends Error {
  readonly result: ExecResult;

  constructor(message: string, result: ExecResult) {
    super(message);
    this.name = "ExecFailure";
    this.result = result;
  }
}

/**
 * Run `file` with `args`. Never throws and never rejects: a nonzero exit and a
 * failed spawn both come back as an {@link ExecResult}, so callers can turn
 * either into an auditable record.
 */
export function runArgv(
  file: string,
  args: readonly string[],
  options: RunArgvOptions = {},
): Promise<ExecResult> {
  const argv = [file, ...args];
  return new Promise<ExecResult>((resolve) => {
    let stdinError: string | null = null;
    const child = execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        // `error.code` is the exit status for a normal nonzero exit and a string
        // errno (ENOENT, …) when the spawn itself failed.
        const rawCode: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        const exitCode = typeof rawCode === "number" ? rawCode : null;
        const signal = error === null ? null : ((error as { signal?: NodeJS.Signals | null }).signal ?? null);
        resolve({
          argv,
          exitCode,
          signal: signal ?? null,
          stdout,
          stderr,
          error: error !== null && exitCode === null ? error.message : null,
          stdinError,
        });
      },
    );
    if (options.input !== undefined) {
      const stdin = child.stdin;
      stdin?.on("error", (cause: Error) => {
        stdinError ??= cause.message;
      });
      stdin?.end(options.input);
    }
  });
}

/**
 * Did the command run to completion with everything the caller asked for?
 *
 * A clean exit is not enough when `input` never reached the child: the work the
 * input described did not happen.
 */
export function succeeded(result: ExecResult): boolean {
  return result.exitCode === 0 && result.stdinError === null;
}

/** Run `file`, throwing {@link ExecFailure} unless it exits 0. */
export async function runArgvOrThrow(
  file: string,
  args: readonly string[],
  options: RunArgvOptions = {},
): Promise<ExecResult> {
  const result = await runArgv(file, args, options);
  if (succeeded(result)) return result;
  throw new ExecFailure(describeFailure(result), result);
}

/** One-line, specific explanation of why an exec failed. */
export function describeFailure(result: ExecResult): string {
  const command = result.argv[0] ?? "(no command)";
  const detail = firstLine(result.stderr) ?? firstLine(result.stdout) ?? "no output";
  const stdin = result.stdinError === null ? "" : ` (stdin: ${result.stdinError})`;
  if (result.error !== null) return `${command}: ${result.error}${stdin}`;
  if (result.signal !== null) return `${command}: killed by ${result.signal}: ${detail}${stdin}`;
  if (result.exitCode === 0) return `${command}: could not write stdin: ${result.stdinError}`;
  return `${command}: exited ${result.exitCode}: ${detail}${stdin}`;
}

function firstLine(text: string): string | null {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? null : line.trim();
}
