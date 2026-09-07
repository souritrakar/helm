/**
 * HTTP handlers for the inbox event stream and respond endpoint.
 *
 * Served from the custom Node server (SPEC D5): SSE needs a long-lived
 * connection with `Last-Event-ID` resume, which does not belong in a Next.js
 * route handler. Compression and proxy buffering are disabled on the stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  HistoryPersistError,
  type InboxStore,
  type InboxStoreEvent,
  parseWireEventId,
} from "./inbox-store";
import { requireOperator } from "./require-operator";
import type { Responder } from "./responder";
import type { InboxItem, RespondAction } from "./types";

export interface InboxHttpDeps {
  readonly store: InboxStore;
  readonly responder: Responder;
  /** Host allowlist for requireOperator (bind + loopback). */
  readonly allowedHosts: readonly string[];
}

const RESPOND_PATH = /^\/api\/inbox\/([^/]+)\/respond\/?$/;

/** Ids currently inside `responder.respond` — blocks double-dispatch races. */
const respondInFlight = new Set<string>();

/**
 * Try to handle an inbox HTTP request.
 *
 * Returns true when this module owned the request (including 4xx/5xx it wrote).
 * Returns false when the request should fall through to Next.js.
 */
export async function handleInboxHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InboxHttpDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  if (pathname === "/api/events" && (req.method === "GET" || req.method === "HEAD")) {
    if (req.method === "HEAD") {
      res.writeHead(200, sseHeaders());
      res.end();
      return true;
    }
    handleSse(req, res, deps.store);
    return true;
  }

  const respondMatch = RESPOND_PATH.exec(pathname);
  if (respondMatch !== null && req.method === "POST") {
    let id: string;
    try {
      id = decodeURIComponent(respondMatch[1] ?? "");
    } catch {
      json(res, 400, { ok: false, error: "inbox item id is not a valid URI component" });
      return true;
    }
    await handleRespond(req, res, deps, id);
    return true;
  }

  if (pathname === "/api/inbox" && req.method === "GET") {
    json(res, 200, { items: deps.store.listOpen() });
    return true;
  }

  return false;
}

function handleSse(req: IncomingMessage, res: ServerResponse, store: InboxStore): void {
  res.writeHead(200, sseHeaders());

  const lastEventIdHeader = req.headers["last-event-id"];
  const lastEventId =
    typeof lastEventIdHeader === "string" && lastEventIdHeader.trim() !== ""
      ? lastEventIdHeader.trim()
      : null;

  if (
    lastEventId !== null &&
    parseWireEventId(lastEventId) !== null &&
    store.canResumeFrom(lastEventId)
  ) {
    for (const event of store.eventsSince(lastEventId)) {
      writeSse(res, store, event);
    }
  } else {
    // Cold connect, missing/mismatched epoch, or non-resumable cursor: full
    // snapshot with begin/end so the client drops phantom cards.
    for (const event of store.captureSnapshot()) {
      writeSse(res, store, event);
    }
  }

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(": heartbeat\n\n");
  }, 15_000);

  const unsubscribe = store.subscribe((event) => {
    writeSse(res, store, event);
  });

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

async function handleRespond(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InboxHttpDeps,
  id: string,
): Promise<void> {
  const gate = requireOperator(req, { mutate: true, allowedHosts: deps.allowedHosts });
  if (!gate.allow) {
    json(res, 403, { ok: false, error: gate.reason });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (cause) {
    json(res, 400, { ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    return;
  }

  const action = parseRespondAction(body);
  if (action === null) {
    json(res, 400, { ok: false, error: "body must include a non-empty string value and/or text" });
    return;
  }

  const item = deps.store.get(id);
  if (item === undefined || item.state !== "open") {
    if (deps.store.isHandled(id)) {
      json(res, 409, { ok: false, error: `item ${id} was already answered or dismissed` });
      return;
    }
    json(res, 404, { ok: false, error: `item ${id} is not open` });
    return;
  }

  const contractError = validateRespondContract(item, action);
  if (contractError !== null) {
    json(res, 400, { ok: false, error: contractError });
    return;
  }

  if (respondInFlight.has(id)) {
    json(res, 409, { ok: false, error: `item ${id} already has a response in flight` });
    return;
  }
  respondInFlight.add(id);
  try {
    // The shared Responder is the only response path today; InboxAdapter.respond
    // remains reserved for a future adapter-owned response contract.
    const result = await deps.responder.respond(item, action);
    if (result.ok) {
      try {
        deps.store.markAnswered(id);
      } catch (cause) {
        if (cause instanceof HistoryPersistError) {
          json(res, 500, {
            ok: false,
            delivered: true,
            error: cause.message,
            result,
          });
          return;
        }
        throw cause;
      }
    }
    if (result.ok && result.auditError !== undefined) {
      json(res, 500, {
        ok: false,
        delivered: true,
        error: `answer delivered but audit persist failed: ${result.auditError}`,
        result,
      });
      return;
    }
    json(res, result.ok ? 200 : 502, result);
  } finally {
    respondInFlight.delete(id);
  }
}

/**
 * Enforce the card's answer contract at the API (captain decisions
 * `freeform-not-enforced`, `empty-options-value-bypass`, `both-value-and-text-drops-text`).
 */
export function validateRespondContract(item: InboxItem, action: RespondAction): string | null {
  if (action.value !== undefined && action.text !== undefined) {
    return "send either value or text, not both";
  }
  if (action.text !== undefined && !item.allowFreeform) {
    return `item ${item.id} does not allow freeform text; choose one of the declared options`;
  }
  if (action.value !== undefined) {
    if (item.options.length === 0) {
      return `item ${item.id} has no options; send freeform text with allowFreeform, not value`;
    }
    const allowed = item.options.some((option) => option.value === action.value);
    if (!allowed) {
      return `value ${JSON.stringify(action.value)} is not among the options for item ${item.id}`;
    }
  }
  return null;
}

/**
 * Parse a respond body while retaining the presence of both fields. This lets
 * the contract reject a supplied blank field alongside a valid answer.
 */
function parseRespondAction(body: unknown): RespondAction | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const value = typeof record.value === "string" ? record.value : undefined;
  const text = typeof record.text === "string" ? record.text : undefined;
  if (value !== undefined && text !== undefined) return { value, text };
  if (value !== undefined && value.trim() !== "") return { value };
  if (text !== undefined && text.trim() !== "") return { text };
  return null;
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

function writeSse(res: ServerResponse, store: InboxStore, event: InboxStoreEvent): void {
  if (res.writableEnded) return;
  const lines: string[] = [];
  if (event.id > 0) {
    lines.push(`id: ${store.wireId(event)}`);
  }
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event.data)}`);
  res.write(`${lines.join("\n")}\n\n`);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const max = 64 * 1024;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch (cause) {
        reject(new Error(`invalid JSON body: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    });
    req.on("error", reject);
  });
}
