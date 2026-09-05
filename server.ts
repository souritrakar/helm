/**
 * helm's HTTP server.
 *
 * A custom Node server rather than `next start`, because a later lane runs a
 * long-lived WebSocket carrying a child-process stdio stream, which cannot live
 * in a Next.js route handler (SPEC D5). Owning the `http.Server` from day one
 * means that lane attaches an upgrade handler instead of re-architecting.
 *
 * The bind address and port come from config (SPEC D10), so phase-2 remote
 * access is a config swap.
 *
 * Run with `pnpm dev` (development) or `pnpm start` (production, after
 * `pnpm build`). This file is not processed by the Next.js compiler.
 */
import { createServer } from "node:http";
import next from "next";

import { ConfigError, loadConfig } from "./src/lib/config";

async function main(): Promise<void> {
  const config = loadConfig();
  const dev = process.env.NODE_ENV !== "production";

  const app = next({ dev, hostname: config.bind, port: config.port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  server.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code === "EADDRINUSE") {
      console.error(`helm: ${config.bind}:${config.port} is already in use`);
      process.exit(1);
    }
    throw cause;
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.bind, resolve);
  });
  console.log(`helm listening on http://${config.bind}:${config.port} (FM_HOME=${config.fmHome})`);

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((cause: unknown) => {
  if (cause instanceof ConfigError) {
    console.error(`helm: ${cause.message}`);
    process.exit(2);
  }
  console.error(cause);
  process.exit(1);
});
