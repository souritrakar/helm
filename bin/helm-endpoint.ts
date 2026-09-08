#!/usr/bin/env node
/** Print the validated listen endpoint as `<bind> <port>`, for bin/helm. */
import { ConfigError, loadEndpoint } from "../src/lib/config";

try {
  const endpoint = loadEndpoint();
  process.stdout.write(`${endpoint.bind} ${endpoint.port}\n`);
} catch (cause) {
  console.error(`helm: ${cause instanceof ConfigError ? cause.message : String(cause)}`);
  process.exitCode = 1;
}
