#!/usr/bin/env node
import { ConfigError, loadConfig } from "../src/lib/config";
import { launchDoctor } from "../src/lib/launch";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (cause) {
    console.error(`helm doctor: ${cause instanceof ConfigError ? cause.message : String(cause)}`);
    process.exitCode = 1;
    return;
  }
  const result = await launchDoctor(config);
  console.log(`helm doctor: Node ${result.node}; pnpm ${result.pnpm ?? "unavailable"}`);
  console.log(`helm doctor: Herdr protocol ${result.herdr.protocol ?? "unavailable"} (minimum ${result.herdr.minProtocol})`);
  console.log(`helm doctor: linger=${result.linger}`);
  if (result.ok) console.log(`helm doctor: healthy (${config.bind}:${config.port} available)`);
  else {
    for (const problem of result.problems) console.error(`helm doctor: FAIL: ${problem}`);
    process.exitCode = 1;
  }
}
void main();
