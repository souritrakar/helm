/**
 * helm's HTTP server.
 *
 * A custom Node server rather than `next start`, because helm runs a
 * long-lived WebSocket carrying a child-process stdio stream, which cannot live
 * in a Next.js route handler (SPEC D5). Owning the `http.Server` lets helm
 * attach the terminal upgrade handler alongside its HTTP surfaces.
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
import type { Duplex } from "node:stream";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

import { ConfigError, loadConfig } from "./src/lib/config";
import { handleInboxHttp } from "./src/lib/inbox-http";
import { createInboxRuntime } from "./src/lib/inbox-runtime";
import { allowedHostsForBind, requireOperator } from "./src/lib/require-operator";
import { paneRun, paneSendKeys, type TerminalViewport } from "./src/lib/herdr";
import { PaneDirectory, type PaneDiscovery } from "./src/lib/panes";
import { parseTerminalInput, requestedViewport, TERMINAL_KEYS } from "./src/lib/request";
import { TerminalBridge } from "./src/lib/terminal-bridge";

const HERDR_KEY_NAMES: Record<(typeof TERMINAL_KEYS)[number], string> = { enter: "enter", escape: "esc", "c-c": "C-c" };
const paneIdSchema = z.string().min(1);

/**
 * Either one-shot text (`herdr pane run`, which appends Enter) or exactly one
 * named key (`herdr pane send-keys`). Both together is ambiguous — the text
 * would silently never be sent — so it is rejected rather than half-honoured.
 */
const INPUT_CONTRACT = `Terminal input must be {paneId, text} for one-shot text, or {paneId, key} where key is one of ${TERMINAL_KEYS.join(", ")}`;

const colsSchema = z.number().int();
const rowsSchema = z.number().int();
const MAX_BODY_BYTES = 1_000_000;

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("terminal.resize"), cols: colsSchema, rows: rowsSchema }),
  z.object({ type: z.literal("terminal.select"), paneId: paneIdSchema }),
  z.object({ type: z.literal("terminal.reconnect") }),
]);

interface TerminalClientState {
  readonly socket: WebSocket;
  bridge: TerminalBridge | null;
  selectedPaneId: string | null;
  viewport: TerminalViewport;
}

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
  const clients = new Set<TerminalClientState>();

  const attach = (client: TerminalClientState, paneId: string): void => {
    client.selectedPaneId = paneId;
    if (client.bridge === null) {
      client.bridge = new TerminalBridge({ cfg: config, target: paneId, viewport: client.viewport, client: { send: (data) => { if (client.socket.readyState === WebSocket.OPEN) client.socket.send(data); } } });
      client.bridge.start();
      return;
    }
    client.bridge.select(paneId);
  };
  const detach = (client: TerminalClientState): void => {
    client.bridge?.close();
    client.bridge = null;
    client.selectedPaneId = null;
    sendJson(client.socket, { type: "terminal.status", status: "closed", reason: "No Herdr panes are available", reconnect: true });
  };
  const settle = (client: TerminalClientState): void => {
    // A viewer whose pane vanished follows the default when one exists, and
    // otherwise waits in a pane-closed state for an explicit reconnect.
    if (client.selectedPaneId !== null && discovery.panes.some((pane) => pane.id === client.selectedPaneId)) return;
    if (discovery.defaultPaneId !== null) attach(client, discovery.defaultPaneId);
    else if (client.selectedPaneId !== null || client.bridge !== null) detach(client);
  };
  const broadcastPanes = (): void => {
    for (const client of clients) {
      settle(client);
      sendJson(client.socket, { type: "terminal.panes", panes: discovery.panes, selectedPaneId: client.selectedPaneId });
    }
  };
  const broadcastNotice = (message: string): void => {
    for (const client of clients) sendJson(client.socket, { type: "terminal.notice", message });
  };
  const directory = new PaneDirectory(config, (nextDiscovery) => { discovery = nextDiscovery; broadcastPanes(); }, (error) => {
    // Discovery is degraded, not dead: the last-known pane list stands and the
    // directory keeps retrying, so this is a notice rather than a teardown.
    console.error(`helm pane discovery: ${error}`);
    broadcastNotice(`Pane discovery is degraded: ${error}`);
  });
  await directory.start();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "POST" && req.url === "/api/term/input") {
          await handleInput(req, res, config, allowedHosts, () => new Set(discovery.panes.map((pane) => pane.id)));
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
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/api/term") {
      // Next attaches its own `upgrade` listener to this server on the first
      // request it handles, and owns everything under `/_next` (development
      // HMR). Nothing else has an owner, so close it rather than leaving a
      // half-open socket to sit until its TCP timeout.
      if (!pathname.startsWith("/_next/")) socket.destroy();
      return;
    }
    if (!requireOperator(request, { allowedHosts }).allow) { rejectUpgrade(socket, 403, "Forbidden"); return; }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit("connection", websocket, request));
  });
  websocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const client: TerminalClientState = { socket, bridge: null, selectedPaneId: null, viewport: requestedViewport(request.url) };
    clients.add(client);
    // Registered before any bridge exists: a viewer that connects while no pane
    // is available must still receive the pane list and reconnect when one
    // appears, rather than holding a socket nothing ever speaks to.
    socket.on("message", (raw) => {
      let message: z.infer<typeof clientMessageSchema>;
      try { message = clientMessageSchema.parse(JSON.parse(raw.toString())); } catch { sendJson(socket, { type: "terminal.notice", message: "Invalid terminal message" }); return; }
      if (message.type === "terminal.resize") {
        client.viewport = clampViewport({ cols: message.cols, rows: message.rows });
        client.bridge?.resize(client.viewport);
      }
      if (message.type === "terminal.reconnect") {
        if (client.bridge !== null) client.bridge.reconnect();
        else if (discovery.defaultPaneId !== null) attach(client, discovery.defaultPaneId);
        else detach(client);
      }
      if (message.type === "terminal.select") {
        if (!discovery.panes.some((pane) => pane.id === message.paneId)) { sendJson(socket, { type: "terminal.notice", message: "Unknown pane" }); return; }
        attach(client, message.paneId); broadcastPanes();
      }
    });
    socket.on("close", () => { clients.delete(client); client.bridge?.close(); client.bridge = null; });
    socket.on("error", () => undefined);
    settle(client);
    sendJson(socket, { type: "terminal.panes", panes: discovery.panes, selectedPaneId: client.selectedPaneId });
    if (client.bridge === null) sendJson(socket, { type: "terminal.status", status: "closed", reason: "No Herdr panes are available", reconnect: true });
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

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    inbox.stop();
    directory.close();
    for (const client of clients) {
      client.bridge?.close();
      client.socket.terminate();
    }
    websocketServer.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function clampViewport(viewport: TerminalViewport): TerminalViewport {
  return {
    cols: Math.min(500, Math.max(2, viewport.cols)),
    rows: Math.min(300, Math.max(2, viewport.rows)),
  };
}

async function handleInput(req: IncomingMessage, res: ServerResponse, config: ReturnType<typeof loadConfig>, allowedHosts: readonly string[], knownPaneIds: () => ReadonlySet<string>): Promise<void> {
  const gate = requireOperator(req, { mutate: true, allowedHosts });
  if (!gate.allow) { respondJson(res, 403, { error: "Terminal input is refused" }); return; }
  try {
    const body = await readJsonBody(req);
    const input = parseTerminalInput(body);
    if (!knownPaneIds().has(input.paneId)) { respondJson(res, 404, { error: "Unknown pane" }); return; }
    const result = "key" in input
      ? await paneSendKeys(config, input.paneId, [HERDR_KEY_NAMES[input.key]])
      : await paneRun(config, input.paneId, [input.text]);
    if (result.exitCode !== 0 || result.stdinError !== null) { respondJson(res, 502, { error: result.stderr.trim() || result.error || "Herdr rejected terminal input" }); return; }
    respondJson(res, 200, { ok: true });
  } catch (cause) { respondJson(res, 400, { error: cause instanceof z.ZodError ? INPUT_CONTRACT : cause instanceof Error ? cause.message : "Invalid terminal input" }); }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let overflowed = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      // Stop buffering once the limit is passed, rather than only rejecting: a
      // client that keeps streaming would otherwise keep growing `body` after
      // the 400 was sent. The stream is still drained so the 400 is delivered.
      if (overflowed) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) { overflowed = true; body = ""; reject(new Error("Request body is too large")); }
    });
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Request body must be JSON")); } });
    req.on("error", reject);
  });
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
