/**
 * helm's HTTP server.
 *
 * A custom Node server rather than `next start`, because a later lane runs a
 * long-lived WebSocket carrying a child-process stdio stream, which cannot live
 * in a Next.js route handler (SPEC D5). Owning the `http.Server` from day one
 * means that lane attaches an upgrade handler instead of re-architecting.
 *
 * Lane C also serves SSE `/api/events` and `POST /api/inbox/:id/respond` here
 * so the event stream stays long-lived with `Last-Event-ID` resume. Lane G
 * serves `GET`/`POST /api/inbox/visibility` on the same server.
 *
 * The bind address and port come from config (SPEC D10), so phase-2 remote
 * access is a config swap.
 *
 * Run with `pnpm dev` (development) or `pnpm start` (production, after
 * `pnpm build`). This file is not processed by the Next.js compiler.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

import { ConfigError, loadConfig } from "./src/lib/config";
import { handleInboxHttp } from "./src/lib/inbox-http";
import { createInboxRuntime } from "./src/lib/inbox-runtime";
import { allowedHostsForBind } from "./src/lib/require-operator";
import { paneRun, paneSendKeys } from "./src/lib/herdr";
import { PaneDirectory, type PaneDiscovery } from "./src/lib/panes";
import { TerminalBridge } from "./src/lib/terminal-bridge";

const inputSchema = z.object({ paneId: z.string().min(1), text: z.string().min(1).max(100_000), key: z.string().min(1).max(128).optional() });
const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("terminal.resize"), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) }),
  z.object({ type: z.literal("terminal.select"), paneId: z.string().min(1) }),
  z.object({ type: z.literal("terminal.reconnect") }),
]);

async function main(): Promise<void> {
  const config = loadConfig();
  const dev = process.env.NODE_ENV !== "production";
  const allowedHosts = allowedHostsForBind(config.bind, config.port);

  const inbox = createInboxRuntime(config);
  await inbox.start();

  const app = next({ dev, hostname: config.bind, port: config.port });
  const handle = app.getRequestHandler();
  await app.prepare();

  let discovery: PaneDiscovery = { panes: [], defaultPaneId: null };
  const clients = new Set<{ socket: WebSocket; bridge: TerminalBridge; selectedPaneId: string }>();
  const broadcastPanes = (): void => {
    for (const client of clients) {
      if (!discovery.panes.some((pane) => pane.id === client.selectedPaneId) && discovery.defaultPaneId !== null) {
        client.selectedPaneId = discovery.defaultPaneId;
        client.bridge.select(discovery.defaultPaneId);
      }
      sendJson(client.socket, { type: "terminal.panes", panes: discovery.panes, selectedPaneId: client.selectedPaneId });
    }
  };
  const directory = new PaneDirectory(config, (nextDiscovery) => { discovery = nextDiscovery; broadcastPanes(); }, (error) => console.error(`helm pane discovery: ${error}`));
  await directory.start();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "POST" && req.url === "/api/term/input") {
          await handleInput(req, res, config, () => new Set(discovery.panes.map((pane) => pane.id)));
          return;
        }
        const owned = await handleInboxHttp(req, res, {
          store: inbox.store,
          responder: inbox.responder,
          allowedHosts,
          visibility: inbox.visibility,
        });
        if (!owned) {
          await handle(req, res);
        }
      } catch (cause) {
        console.error("helm: request failed", cause);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("internal error\n");
        } else {
          res.end();
        }
      }
    })();
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    // Next owns development HMR upgrades (and future framework upgrades); only
    // consume helm's explicit terminal endpoint.
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/api/term") return;
    websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit("connection", websocket));
  });
  websocketServer.on("connection", (socket) => {
    const selectedPaneId = discovery.defaultPaneId;
    if (selectedPaneId === null) { sendJson(socket, { type: "terminal.status", status: "closed", reason: "No Herdr panes are available", reconnect: true }); return; }
    const bridge = new TerminalBridge({ cfg: config, target: selectedPaneId, viewport: { cols: 80, rows: 24 }, client: { send: (data) => { if (socket.readyState === WebSocket.OPEN) socket.send(data); } } });
    const client = { socket, bridge, selectedPaneId };
    clients.add(client);
    sendJson(socket, { type: "terminal.panes", panes: discovery.panes, selectedPaneId });
    bridge.start();
    socket.on("message", (raw) => {
      let message: z.infer<typeof clientMessageSchema>;
      try { message = clientMessageSchema.parse(JSON.parse(raw.toString())); } catch { sendJson(socket, { type: "terminal.status", status: "closed", reason: "Invalid terminal message", reconnect: false }); return; }
      if (message.type === "terminal.resize") bridge.resize(message);
      if (message.type === "terminal.reconnect") bridge.reconnect();
      if (message.type === "terminal.select") {
        if (!discovery.panes.some((pane) => pane.id === message.paneId)) { sendJson(socket, { type: "terminal.status", status: "closed", reason: "Unknown pane", reconnect: false }); return; }
        client.selectedPaneId = message.paneId; bridge.select(message.paneId); broadcastPanes();
      }
    });
    socket.on("close", () => { clients.delete(client); bridge.close(); });
    socket.on("error", () => undefined);
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
    inbox.stop();
    directory.close();
    for (const client of clients) client.bridge.close();
    websocketServer.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleInput(req: IncomingMessage, res: ServerResponse, config: ReturnType<typeof loadConfig>, knownPaneIds: () => ReadonlySet<string>): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const input = inputSchema.parse(body);
    if (!knownPaneIds().has(input.paneId)) { respondJson(res, 404, { error: "Unknown pane" }); return; }
    const result = input.key === undefined ? await paneRun(config, input.paneId, [input.text]) : await paneSendKeys(config, input.paneId, [input.key]);
    if (result.exitCode !== 0 || result.stdinError !== null) { respondJson(res, 502, { error: result.stderr.trim() || result.error || "Herdr rejected terminal input" }); return; }
    respondJson(res, 200, { ok: true });
  } catch (cause) { respondJson(res, 400, { error: cause instanceof Error ? cause.message : "Invalid terminal input" }); }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => { let body = ""; req.setEncoding("utf8"); req.on("data", (chunk: string) => { body += chunk; if (body.length > 1_000_000) reject(new Error("Request body is too large")); }); req.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Request body must be JSON")); } }); req.on("error", reject); });
}
function respondJson(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
function sendJson(socket: WebSocket, value: unknown): void { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }

main().catch((cause: unknown) => {
  if (cause instanceof ConfigError) {
    console.error(`helm: ${cause.message}`);
    process.exit(2);
  }
  console.error(cause);
  process.exit(1);
});
