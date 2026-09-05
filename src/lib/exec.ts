/**
 * Argv-only process execution.
 *
 * Every external command helm runs goes through this module. `execFile` is used
 * with the default `shell: false`, so the argument vector reaches the kernel
 * unchanged and adapter-supplied text can never be re-interpreted as shell
 * syntax (SPEC R5, AC 19). No helper here accepts a command string.
 */
import { execFile } from "node:child_process";

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
        });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** Run `file`, throwing {@link ExecFailure} unless it exits 0. */
export async function runArgvOrThrow(
  file: string,
  args: readonly string[],
  options: RunArgvOptions = {},
): Promise<ExecResult> {
  const result = await runArgv(file, args, options);
  if (result.exitCode === 0) return result;
  throw new ExecFailure(describeFailure(result), result);
}

/** One-line, specific explanation of why an exec failed. */
export function describeFailure(result: ExecResult): string {
  const command = result.argv[0] ?? "(no command)";
  const detail = firstLine(result.stderr) ?? firstLine(result.stdout) ?? "no output";
  if (result.error !== null) return `${command}: ${result.error}`;
  if (result.signal !== null) return `${command}: killed by ${result.signal}: ${detail}`;
  return `${command}: exited ${result.exitCode}: ${detail}`;
}

function firstLine(text: string): string | null {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? null : line.trim();
}
