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
  process.stdout.write(`${config.bind} ${config.port} ${config.fmHome}\n`);
} catch (cause) {
  console.error(`helm: ${cause instanceof ConfigError ? cause.message : String(cause)}`);
  process.exitCode = 1;
}
