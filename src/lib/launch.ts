/** Runtime checks for the service launcher, using helm's existing seams. */
import { createServer } from "node:net";

import type { HelmConfig } from "./config";
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

/** Probe the configured TCP endpoint without keeping it reserved. */
export async function portIsAvailable(bind: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, bind, () => server.close(() => resolve(true)));
  });
}

/** Gather every launch prerequisite; this function is strictly read-only. */
export async function launchDoctor(config: HelmConfig): Promise<LaunchDoctorResult> {
  const [herdr, pnpmResult, lingerResult, portAvailable] = await Promise.all([
    herdrDoctor(config),
    runArgv("pnpm", ["--version"]),
    runArgv("loginctl", ["show-user", String(process.getuid?.() ?? ""), "-p", "Linger", "--value"]),
    portIsAvailable(config.bind, config.port),
  ]);
  const problems = [...herdr.problems];
  const node = process.versions.node;
  if (!versionAtLeast(node, 24)) problems.push(`Node ${node} is too old; helm requires Node 24 or newer`);

  const pnpm = pnpmResult.exitCode === 0 ? pnpmResult.stdout.trim() : null;
  if (pnpm === null) problems.push("pnpm is missing or not runnable; helm requires pnpm 9 or newer");
  else if (!versionAtLeast(pnpm, 9)) problems.push(`pnpm ${pnpm} is too old; helm requires pnpm 9 or newer`);
  if (!portAvailable) problems.push(`${config.bind}:${config.port} is already in use`);
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
