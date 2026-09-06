/**
 * Configuration loading and validation.
 *
 * Bind address and port are config, not constants (SPEC D10), so adding remote
 * access in phase 2 is a config swap rather than a code change. Every input is
 * validated at load time and every failure names the offending variable, the
 * value seen, and what was expected.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

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
  /**
   * helm's own writable state (`~/.local/state/helm` by default).
   *
   * Answered-history and the audit log live here. This is never under
   * `$FM_HOME` — helm must not write there (AGENTS.md hard rule 1).
   */
  readonly helmStateDir: string;
  /** Herdr control socket. Liveness is a doctor concern, not a load concern. */
  readonly herdrSocketPath: string;
  /** Herdr executable, resolved on `PATH` unless an absolute path is given. */
  readonly herdrBin: string;
  readonly port: number;
  readonly bind: string;
  /** Operator-declared, read-only Herdr output subscriptions (SPEC §5.4 tier 1). */
  readonly outputMatches?: readonly OutputMatchConfig[];
  /** Optional firstmate pane to receive relayed human replies. */
  readonly captainPane?: string;
}

export interface OutputMatchConfig {
  readonly id: string;
  readonly paneId: string;
  readonly source: "visible" | "recent" | "recent_unwrapped" | "detection";
  readonly match: { readonly type: "substring" | "regex"; readonly value: string };
  readonly title?: string;
  readonly urgency?: "blocking" | "attention" | "fyi";
}

const outputMatchesSchema = z.array(z.object({
  id: z.string().min(1),
  paneId: z.string().min(1),
  source: z.enum(["visible", "recent", "recent_unwrapped", "detection"]),
  match: z.object({ type: z.enum(["substring", "regex"]), value: z.string().min(1) }),
  title: z.string().min(1).optional(),
  urgency: z.enum(["blocking", "attention", "fyi"]).optional(),
}));

/** The listen endpoint on its own, for callers that need no FM_HOME. */
export interface HelmEndpoint {
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
    helmStateDir: resolveHelmStateDir(env, fmHome),
    herdrSocketPath: resolveHerdrSocketPath(env),
    herdrBin: nonEmpty("HERDR_BIN", env.HERDR_BIN) ?? DEFAULT_HERDR_BIN,
    ...loadEndpoint(env),
    outputMatches: parseOutputMatches(env.HELM_OUTPUT_MATCHES),
    captainPane: nonEmpty("HELM_CAPTAIN_PANE", env.HELM_CAPTAIN_PANE),
  };
}

/**
 * Read and validate just the listen endpoint from `env`.
 *
 * The launcher needs the endpoint for its status line, its readiness probe, and
 * the unit file it generates, in situations where FM_HOME may not be usable.
 * Sharing this with {@link loadConfig} keeps one owner of the defaults.
 *
 * @throws {ConfigError} on any invalid input.
 */
export function loadEndpoint(env: ConfigEnv = process.env): HelmEndpoint {
  return {
    port: parsePort("HELM_PORT", env.HELM_PORT),
    bind: parseBind("HELM_BIND", env.HELM_BIND),
  };
}

function parseOutputMatches(raw: string | undefined): readonly OutputMatchConfig[] {
  if (raw === undefined || raw.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`HELM_OUTPUT_MATCHES must be JSON: ${errorMessage(cause)}`);
  }
  const parsed = outputMatchesSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ConfigError(`HELM_OUTPUT_MATCHES is invalid: ${issues}`);
  }
  return parsed.data;
}

/**
 * `$HELM_STATE_DIR`, or `$XDG_STATE_HOME/helm`, or `$HOME/.local/state/helm`.
 *
 * The directory need not exist yet — the store and audit log create it on first
 * write. An explicit relative path is rejected so a mis-set variable cannot
 * silently write under the process cwd. A path equal to or under `fmHome` is
 * also rejected so answered-history and the audit log can never write under
 * `$FM_HOME` (AGENTS.md hard rule 1).
 */
function resolveHelmStateDir(env: ConfigEnv, fmHome: string): string {
  const explicit = nonEmpty("HELM_STATE_DIR", env.HELM_STATE_DIR);
  const value = explicit ?? join(stateHome(env), "helm");
  if (!isAbsolute(value)) {
    throw new ConfigError(`HELM_STATE_DIR must be an absolute path, got ${JSON.stringify(value)}`);
  }
  const resolvedFmHome = realpathSync(fmHome);
  const resolvedStateDir = resolveExistingPath(value);
  if (isPathInsideOrEqual(resolvedStateDir, resolvedFmHome)) {
    throw new ConfigError(
      `HELM_STATE_DIR ${JSON.stringify(value)} must not be equal to or under FM_HOME ${JSON.stringify(fmHome)}; helm must never write under $FM_HOME`,
    );
  }
  return value;
}

function resolveExistingPath(path: string): string {
  const missing: string[] = [];
  let cursor = resolve(path);
  while (true) {
    try {
      return join(realpathSync(cursor), ...missing.reverse());
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigError(
          `HELM_STATE_DIR ${JSON.stringify(path)} cannot be resolved: ${errorMessage(cause)}`,
        );
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new ConfigError(`HELM_STATE_DIR ${JSON.stringify(path)} cannot be resolved`);
      }
      missing.push(cursor.slice(parent.length + (parent === "/" ? 0 : 1)));
      cursor = parent;
    }
  }
}

/** True when `path` is `parent` or a descendant of `parent`. */
function isPathInsideOrEqual(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `$XDG_STATE_HOME`, or `$HOME/.local/state`.
 *
 * Same empty-means-unset rule as {@link configHome}.
 */
function stateHome(env: ConfigEnv): string {
  const value = env.XDG_STATE_HOME?.trim();
  return value === undefined || value === "" ? join(homedir(), ".local", "state") : value;
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
  const value = explicit ?? join(configHome(env), "herdr", "herdr.sock");
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

/**
 * `$XDG_CONFIG_HOME`, or `$HOME/.config`.
 *
 * The XDG Base Directory spec defines an `XDG_CONFIG_HOME` that is "either not
 * set or empty" as meaning the default, so an exported-but-empty value takes
 * the fallback rather than failing the way a deliberately set variable does.
 */
function configHome(env: ConfigEnv): string {
  const value = env.XDG_CONFIG_HOME?.trim();
  return value === undefined || value === "" ? join(homedir(), ".config") : value;
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
