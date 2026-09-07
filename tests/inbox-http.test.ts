/**
 * SSE /api/events (Last-Event-ID) and POST /api/inbox/:id/respond.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileAuditWriter, createMemoryAuditWriter } from "@/lib/audit";
import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { handleInboxHttp } from "@/lib/inbox-http";
import { createInboxStore, type InboxStore } from "@/lib/inbox-store";
import { auditLogPath } from "@/lib/paths";
import { createResponder } from "@/lib/responder";
import { inboxItemId, type InboxItem } from "@/lib/types";

const CONFIG: HelmConfig = {
  fmHome: "/fixture/firstmate",
  fmBinDir: "/fixture/firstmate/bin",
  fmStateDir: "/fixture/firstmate/state",
  helmStateDir: "/fixture/helm-state",
  herdrSocketPath: "/fixture/herdr.sock",
  herdrBin: "herdr",
  port: DEFAULT_PORT,
  bind: DEFAULT_BIND,
};

let stateDir: string;
let store: InboxStore;
let server: Server;
let baseUrl: string;

function item(naturalKey: string): InboxItem {
  return {
    id: inboxItemId("fake", naturalKey),
    source: "fake",
    kind: "decision",
    urgency: "blocking",
    taskId: "helm-foundation",
    title: naturalKey,
    options: [{ value: "yes", label: "Yes" }],
    allowFreeform: false,
    respond: { channel: "resolve-key", target: "helm-foundation", key: naturalKey },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T00:00:00.000Z",
  };
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<void> {
  server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((cause: unknown) => {
      res.writeHead(500);
      res.end(String(cause));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "helm-http-"));
  store = createInboxStore(stateDir);
  const audit = createMemoryAuditWriter();
  const responder = createResponder({
    config: { ...CONFIG, helmStateDir: stateDir },
    audit,
    exec: {
      resolveKey: async (openItem, answer) => ({
        ok: true,
        channel: "resolve-key",
        argv: ["fm-send.sh", openItem.respond.target ?? "", "--resolve-key", openItem.respond.key ?? "", answer],
        exitCode: 0,
        stdout: "",
        stderr: "",
        at: "2026-09-06T00:00:00.000Z",
      }),
    },
  });

  await listen(async (req, res) => {
    const owned = await handleInboxHttp(req, res, { store, responder });
    if (!owned) {
      res.writeHead(404);
      res.end("not inbox");
    }
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("GET /api/inbox", () => {
  it("lists open items", async () => {
    store.reconcile("fake", [item("k1")]);
    const res = await fetch(`${baseUrl}/api/inbox`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: InboxItem[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(inboxItemId("fake", "k1"));
  });
});

describe("POST /api/inbox/:id/respond", () => {
  it("answers an open item, marks it answered, and returns the result", async () => {
    store.reconcile("fake", [item("k1")]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "yes" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; argv: string[] };
    expect(body.ok).toBe(true);
    expect(body.argv).toEqual([
      "fm-send.sh",
      "helm-foundation",
      "--resolve-key",
      "k1",
      "yes",
    ]);
    expect(store.listOpen()).toHaveLength(0);
    expect(store.isHandled(inboxItemId("fake", "k1"))).toBe(true);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/inbox/fake%3Amissing/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "yes" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/events SSE", () => {
  it("streams a cold snapshot and live upserts", async () => {
    store.reconcile("fake", [item("k1")]);

    const res = await fetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const decoder = new TextDecoder();
    let buffer = "";

    const readUntil = async (predicate: (text: string) => boolean): Promise<string> => {
      while (!predicate(buffer)) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    };

    await readUntil((text) => text.includes("event: item.upsert") && text.includes("fake:k1"));
    expect(buffer).toContain("event: item.upsert");
    expect(buffer).toContain(inboxItemId("fake", "k1"));

    // Live event after subscribe.
    store.reconcile("fake", [item("k1"), item("k2")]);
    await readUntil((text) => text.includes("fake:k2"));
    expect(buffer).toContain("fake:k2");

    await reader.cancel();
  });

  it("resumes from Last-Event-ID", async () => {
    store.reconcile("fake", [item("a")]);
    const lastId = store.lastEventId();
    store.reconcile("fake", [item("a"), item("b")]);

    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { "Last-Event-ID": String(lastId) },
    });
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("fake:b")) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    expect(buffer).toContain(`id: ${lastId + 1}`);
    expect(buffer).toContain("fake:b");
    // Should not replay the pre-cursor upsert of `a` as a new snapshot.
    const upsertCount = buffer.split("event: item.upsert").length - 1;
    expect(upsertCount).toBe(1);
    await reader.cancel();
  });
});

describe("file audit writer (AC 12)", () => {
  it("appends one JSON line per response under helm state, not FM_HOME", async () => {
    const audit = createFileAuditWriter(stateDir);
    const responder = createResponder({
      config: { ...CONFIG, helmStateDir: stateDir },
      audit,
      exec: {
        resolveKey: async (openItem, answer) => ({
          ok: true,
          channel: "resolve-key",
          argv: ["fm-send.sh", openItem.taskId ?? "", "--resolve-key", openItem.respond.key ?? "", answer],
          exitCode: 0,
          stdout: "",
          stderr: "",
          at: "2026-09-06T00:00:00.000Z",
        }),
      },
    });

    await responder.respond(item("audit-me"), { value: "yes" });

    const log = readFileSync(auditLogPath(stateDir), "utf8").trim();
    const entry = JSON.parse(log) as { itemId: string; argv: string[]; exitCode: number };
    expect(entry.itemId).toBe(inboxItemId("fake", "audit-me"));
    expect(entry.exitCode).toBe(0);
    expect(auditLogPath(stateDir).startsWith(stateDir)).toBe(true);
  });
});
