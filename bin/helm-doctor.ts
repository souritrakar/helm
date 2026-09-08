#!/usr/bin/env node
import { ConfigError, loadConfig } from "../src/lib/config";
import { launchDoctor } from "../src/lib/launch";

/**
 * The launcher passes the pid its pidfile vouches for when helm is running, so
 * doctor can tell helm's own listener from a foreign one holding the endpoint.
 */
function parsePortOwner(argv: readonly string[]): number | undefined {
  const index = argv.indexOf("--port-owner");
  if (index === -1) return undefined;
  const raw = argv[index + 1];
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    console.error("helm doctor: --port-owner needs a process id");
    process.exit(2);
  }
  return Number(raw);
}

async function main(): Promise<void> {
  const portOwnerPid = parsePortOwner(process.argv.slice(2));
  let config;
  try {
    config = loadConfig();
  } catch (cause) {
    console.error(`helm doctor: ${cause instanceof ConfigError ? cause.message : String(cause)}`);
    process.exitCode = 1;
    return;
  }
  const result = await launchDoctor(config, { portOwnerPid });
  console.log(`helm doctor: Node ${result.node}; pnpm ${result.pnpm ?? "unavailable"}`);
  console.log(`helm doctor: Herdr protocol ${result.herdr.protocol ?? "unavailable"} (minimum ${result.herdr.minProtocol})`);
  console.log(`helm doctor: linger=${result.linger}`);
  if (result.ok) {
    const endpoint = `${config.bind}:${config.port}`;
    console.log(
      result.portHeldByHelm
        ? `helm doctor: healthy (${endpoint} held by the running helm instance, pid ${String(portOwnerPid)})`
        : `helm doctor: healthy (${endpoint} available)`,
    );
  }
  else {
    for (const problem of result.problems) console.error(`helm doctor: FAIL: ${problem}`);
    process.exitCode = 1;
  }
}
void main();
