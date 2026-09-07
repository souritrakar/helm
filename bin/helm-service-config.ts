#!/usr/bin/env node
/**
 * Print `<bind> <port> <fm-home>` from the fully validated configuration.
 *
 * `install-service` templates all three into the generated unit, so it must be
 * the loader that accepts or rejects them: a unit built from values the loader
 * would refuse fails at every start under `Restart=always`.
 */
import { ConfigError, loadConfig } from "../src/lib/config";

try {
  const config = loadConfig();
  requireUnitSafe("FM_HOME", config.fmHome);
  requireUnitSafe("HELM_BIND", config.bind);
  process.stdout.write(`${config.bind} ${config.port} ${config.fmHome}\n`);
} catch (cause) {
  console.error(`helm: ${cause instanceof ConfigError ? cause.message : String(cause)}`);
  process.exitCode = 1;
}

function requireUnitSafe(label: string, value: string) {
  if (/[\p{Cc}"'\\]/u.test(value)) {
    throw new ConfigError(`${label} contains systemd unit syntax requiring escaping`);
  }
}
