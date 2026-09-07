#!/usr/bin/env node
import { ConfigError, loadHelmStateDir } from "../src/lib/config";

try {
  process.stdout.write(`${loadHelmStateDir()}\n`);
} catch (cause) {
  console.error(`helm: ${cause instanceof ConfigError ? cause.message : String(cause)}`);
  process.exitCode = 1;
}
