#!/usr/bin/env node
import { ConfigError, loadConfig } from "../src/lib/config";

try {
  process.stdout.write(`${loadConfig().helmStateDir}\n`);
} catch (cause) {
  console.error(`helm: ${cause instanceof ConfigError ? cause.message : String(cause)}`);
  process.exitCode = 1;
}
