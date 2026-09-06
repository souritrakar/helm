/** Runtime checks for the service launcher, using helm's existing seams. */
import { createServer } from "node:net";

import type { HelmConfig, HelmEndpoint } from "./config";
import { runArgv } from "./exec";
import { herdrDoctor, type HerdrDoctorResult } from "./herdr";

export interface LaunchDoctorResult {
  readonly ok: boolean;
  readonly herdr: HerdrDoctorResult;
  readonly node: string;
  readonly pnpm: string | null;
  readonly linger: "yes" | "no" | "unknown";
  readonly problems: readonly string[];
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

export async function portIsAvailable(bind: string, port: number): Promise<boolean> {
  return (await probePort(bind, port)).available;
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
export async function launchDoctor(config: HelmConfig): Promise<LaunchDoctorResult> {
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
  if (!portProbe.available) problems.push(describePortProblem(config, portProbe.code));
  const linger = lingerResult.exitCode === 0 ? normalizeLinger(lingerResult.stdout) : "unknown";

  return { ok: problems.length === 0, herdr, node, pnpm, linger, problems };
}

export function versionAtLeast(version: string, minimumMajor: number): boolean {
  const match = /^(\d+)/.exec(version.trim());
  return match !== null && Number(match[1]) >= minimumMajor;
}

function normalizeLinger(value: string): "yes" | "no" | "unknown" {
  const normalized = value.trim().toLowerCase();
  return normalized === "yes" ? "yes" : normalized === "no" ? "no" : "unknown";
}
