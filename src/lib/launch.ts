/** Runtime checks for the service launcher, using helm's existing seams. */
import { createServer } from "node:net";

import type { HelmConfig, HelmEndpoint } from "./config";
import { runArgv } from "./exec";
import { herdrDoctor, type HerdrDoctorResult } from "./herdr";
import { belongsToProcessGroup, listenerPids } from "./listener";

export interface LaunchDoctorResult {
  readonly ok: boolean;
  readonly herdr: HerdrDoctorResult;
  readonly node: string;
  readonly pnpm: string | null;
  readonly linger: "yes" | "no" | "unknown";
  /** The configured endpoint is in use, and the proven listener is helm itself. */
  readonly portHeldByHelm: boolean;
  readonly problems: readonly string[];
}

/** What the launcher knows about the running instance and doctor cannot observe. */
export interface LaunchDoctorOptions {
  /**
   * pid of the helm instance the launcher's pidfile vouches for, when one runs.
   * doctor is the operator diagnostic as well as the pre-start gate, so an
   * endpoint that instance holds is healthy while a foreign holder is not.
   */
  readonly portOwnerPid?: number;
}

/** Why the configured endpoint could not be bound, or that it could. */
export type PortProbe = { readonly available: true } | { readonly available: false; readonly code: string };

/**
 * Probe the configured TCP endpoint without keeping it reserved.
 *
 * The failure code is carried out rather than collapsed, because "in use",
 * "permission denied", and "not an address of this host" need different fixes.
 */
export async function probePort(bind: string, port: number): Promise<PortProbe> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (cause: NodeJS.ErrnoException) =>
      resolve({ available: false, code: cause.code ?? "UNKNOWN" }),
    );
    server.listen(port, bind, () => server.close(() => resolve({ available: true })));
  });
}

/** Name who holds the endpoint, so a drifted port never reads as helm's own. */
export function describeForeignListener(
  endpoint: HelmEndpoint,
  owner: number,
  listeners: readonly number[],
): string {
  const address = `${endpoint.bind}:${endpoint.port}`;
  return listeners.length === 0
    ? `${address} is already in use, and helm could not identify the listener; it cannot confirm that the running helm instance (pid ${String(owner)}) holds it`
    : `${address} is already in use by pid ${listeners.map(String).join(" and ")}, not by the running helm instance (pid ${String(owner)})`;
}

/**
 * Say that a free endpoint is not the one the instance serves.
 *
 * The instance may simply not have bound yet, so this names both causes rather
 * than declaring the running server broken.
 */
export function describeUnboundEndpoint(endpoint: HelmEndpoint, owner: number): string {
  return `${endpoint.bind}:${endpoint.port} is not bound by the running helm instance (pid ${String(owner)}); the instance may still be starting, or HELM_BIND and HELM_PORT may differ from the endpoint it bound`;
}

/** Name the specific reason the endpoint is unusable, never just "in use". */
export function describePortProblem(endpoint: HelmEndpoint, code: string): string {
  const address = `${endpoint.bind}:${endpoint.port}`;
  switch (code) {
    case "EADDRINUSE":
      return `${address} is already in use`;
    case "EACCES":
      return `${address} cannot be bound: permission denied; helm does not run privileged, so choose a port above 1023`;
    case "EADDRNOTAVAIL":
      return `${address} cannot be bound: ${endpoint.bind} is not an address of this host`;
    default:
      return `${address} cannot be bound: ${code}`;
  }
}

/** Gather every launch prerequisite; this function is strictly read-only. */
export async function launchDoctor(
  config: HelmConfig,
  options: LaunchDoctorOptions = {},
): Promise<LaunchDoctorResult> {
  const [herdr, pnpmResult, lingerResult, portProbe] = await Promise.all([
    herdrDoctor(config),
    runArgv("pnpm", ["--version"]),
    runArgv("loginctl", ["show-user", String(process.getuid?.() ?? ""), "-p", "Linger", "--value"]),
    probePort(config.bind, config.port),
  ]);
  const problems = [...herdr.problems];
  const node = process.versions.node;
  if (!versionAtLeast(node, 24)) problems.push(`Node ${node} is too old; helm requires Node 24 or newer`);

  const pnpm = pnpmResult.exitCode === 0 ? pnpmResult.stdout.trim() : null;
  if (pnpm === null) problems.push("pnpm is missing or not runnable; helm requires pnpm 9 or newer");
  else if (!versionAtLeast(pnpm, 9)) problems.push(`pnpm ${pnpm} is too old; helm requires pnpm 9 or newer`);
  let portHeldByHelm = false;
  const owner = options.portOwnerPid;
  if (!portProbe.available) {
    if (portProbe.code !== "EADDRINUSE" || owner === undefined) {
      problems.push(describePortProblem(config, portProbe.code));
    } else {
      const listeners = listenerPids(config.port);
      portHeldByHelm = listeners.some((pid) => belongsToProcessGroup(pid, owner));
      if (!portHeldByHelm) problems.push(describeForeignListener(config, owner, listeners));
    }
  } else if (owner !== undefined) {
    problems.push(describeUnboundEndpoint(config, owner));
  }
  const linger = lingerResult.exitCode === 0 ? normalizeLinger(lingerResult.stdout) : "unknown";

  return { ok: problems.length === 0, herdr, node, pnpm, linger, portHeldByHelm, problems };
}

export function versionAtLeast(version: string, minimumMajor: number): boolean {
  const match = /^(\d+)/.exec(version.trim());
  return match !== null && Number(match[1]) >= minimumMajor;
}

function normalizeLinger(value: string): "yes" | "no" | "unknown" {
  const normalized = value.trim().toLowerCase();
  return normalized === "yes" ? "yes" : normalized === "no" ? "no" : "unknown";
}
