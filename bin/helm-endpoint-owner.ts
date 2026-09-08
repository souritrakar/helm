#!/usr/bin/env node
import { ConfigError, loadEndpoint } from "../src/lib/config";
import { belongsToProcessGroup, listenerPids } from "../src/lib/listener";

const owner = Number(process.argv[2]);

async function main() {
  if (!Number.isSafeInteger(owner) || owner < 1) throw new ConfigError("helm listener owner must be a positive pid");
  const endpoint = loadEndpoint();
  process.exitCode = (await listenerPids(endpoint)).some((pid) => belongsToProcessGroup(pid, owner)) ? 0 : 1;
}

void main().catch((cause) => {
  console.error(`helm: ${cause instanceof ConfigError ? cause.message : String(cause)}`);
  process.exitCode = 1;
});
