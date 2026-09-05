/**
 * Configuration loading and validation.
 *
 * Bind address and port are config, not constants (SPEC D10), so adding remote
 * access in phase 2 is a config swap rather than a code change. Every input is
 * validated at load time and every failure names the offending variable, the
 * value seen, and what was expected.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Thrown when the environment cannot produce a usable configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface HelmConfig {
  /** firstmate's operational home. helm only ever reads under it. */
  readonly fmHome: string;
  /** `$FM_HOME/bin` — where the `fm-*.sh` seams live. */
  readonly fmBinDir: string;
  /** `$FM_HOME/state` — the task state directory the decision fold scans. */
  readonly fmStateDir: string;
  /** Herdr control socket. Liveness is a doctor concern, not a load concern. */
  readonly herdrSocketPath: string;
  /** Herdr executable, resolved on `PATH` unless an absolute path is given. */
  readonly herdrBin: string;
  readonly port: number;
  readonly bind: string;
}

export const DEFAULT_PORT = 7333;
export const DEFAULT_BIND = "127.0.0.1";
export const DEFAULT_HERDR_BIN = "herdr";

/** The subset of an environment the loader reads. */
export type ConfigEnv = Readonly<Partial<Record<string, string>>>;

/**
 * Read and validate configuration from `env`.
 *
 * @throws {ConfigError} on any missing or invalid input.
 */
export function loadConfig(env: ConfigEnv = process.env): HelmConfig {
  const fmHome = requireReadableDir("FM_HOME", env.FM_HOME);
  const fmBinDir = requireReadableDir("FM_HOME/bin", join(fmHome, "bin"));
  const fmStateDir = requireReadableDir("FM_HOME/state", join(fmHome, "state"));

  return {
    fmHome,
    fmBinDir,
    fmStateDir,
    herdrSocketPath: resolveHerdrSocketPath(env),
    herdrBin: nonEmpty("HERDR_BIN", env.HERDR_BIN) ?? DEFAULT_HERDR_BIN,
    port: parsePort("HELM_PORT", env.HELM_PORT),
    bind: parseBind("HELM_BIND", env.HELM_BIND),
  };
}

function requireReadableDir(label: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${label} is not set; helm needs firstmate's operational home to read from`);
  }
  if (!isAbsolute(value)) {
    throw new ConfigError(`${label} must be an absolute path, got ${JSON.stringify(value)}`);
  }
  let stats;
  try {
    stats = statSync(value);
  } catch (cause) {
    throw new ConfigError(`${label} ${JSON.stringify(value)} cannot be read: ${errorMessage(cause)}`);
  }
  if (!stats.isDirectory()) {
    throw new ConfigError(`${label} ${JSON.stringify(value)} is not a directory`);
  }
  try {
    // X_OK as well as R_OK: a directory must be searchable to reach its files.
    accessSync(value, constants.R_OK | constants.X_OK);
  } catch (cause) {
    throw new ConfigError(`${label} ${JSON.stringify(value)} is not readable: ${errorMessage(cause)}`);
  }
  return value;
}

function resolveHerdrSocketPath(env: ConfigEnv): string {
  const explicit = nonEmpty("HERDR_SOCKET_PATH", env.HERDR_SOCKET_PATH);
  const value = explicit ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr", "herdr.sock");
  if (!isAbsolute(value)) {
    throw new ConfigError(`HERDR_SOCKET_PATH must be an absolute path, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parsePort(label: string, raw: string | undefined): number {
  const value = nonEmpty(label, raw);
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${label} must be a whole number, got ${JSON.stringify(value)}`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`${label} must be between 1 and 65535, got ${port}`);
  }
  return port;
}

function parseBind(label: string, raw: string | undefined): string {
  const value = nonEmpty(label, raw);
  if (value === undefined) return DEFAULT_BIND;
  if (/\s/.test(value)) {
    throw new ConfigError(`${label} must not contain whitespace, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonEmpty(label: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new ConfigError(`${label} is set but empty; unset it to take the default`);
  }
  return trimmed;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
