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
import { InboxVisibility } from "@/lib/inbox-visibility";
import { auditLogPath } from "@/lib/paths";
import { createResponder, type Responder } from "@/lib/responder";
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
let responder: Responder;
let visibility: InboxVisibility;

function item(naturalKey: string): InboxItem {
  return {
    id: inboxItemId("fake", naturalKey),
    source: "fake",
    kind: "status-decision",
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
  responder = createResponder({
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
  visibility = new InboxVisibility();

  await listen(async (req, res) => {
    const owned = await handleInboxHttp(req, res, {
      store,
      responder,
      allowedHosts: [`127.0.0.1:${addressPort(server)}`, `localhost:${addressPort(server)}`],
      visibility,
    });
    if (!owned) {
      res.writeHead(404);
      res.end("not inbox");
    }
  });
});

function addressPort(s: Server): number {
  const address = s.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return address.port;
}

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

describe("POST /api/inbox/:id/dismiss", () => {
  const post = (id: string) =>
    fetch(`${baseUrl}/api/inbox/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

  it("closes the card on the operator's board and calls no firstmate seam", async () => {
    store.reconcile("fake", [item("k1")]);
    const id = inboxItemId("fake", "k1");

    const res = await post(id);

    expect(res.status).toBe(200);
    expect(store.listOpen()).toHaveLength(0);
    expect(store.isHandled(id)).toBe(true);
    expect(store.listHandled()).toMatchObject([{ id, state: "dismissed" }]);
    // A dismissal is not an answer: nothing was delivered, so nothing is recorded.
    expect(store.listHandled()[0]?.answer).toBeUndefined();
  });

  it("refuses a second dismissal of the same card", async () => {
    store.reconcile("fake", [item("k1")]);
    const id = inboxItemId("fake", "k1");
    await post(id);

    const res = await post(id);

    expect(res.status).toBe(409);
  });

  it("answers 404 for a card that is not open", async () => {
    const res = await post(inboxItemId("fake", "never-existed"));

    expect(res.status).toBe(404);
  });

  it("emits an upsert then a retract, so a live client moves the card between tabs", async () => {
    store.reconcile("fake", [item("k1")]);
    const seen: string[] = [];
    store.subscribe((event) => seen.push(event.type));

    await post(inboxItemId("fake", "k1"));

    expect(seen).toEqual(["item.upsert", "item.retract"]);
  });
});

describe("inbox visibility signal", () => {
  it("accepts presence only from a minted, operator-gated helm session", async () => {
    const session = await fetch(`${baseUrl}/api/inbox/visibility`);
    expect(session.status).toBe(200);
    const { token } = await session.json() as { token: string };

    const rejected = await fetch(`${baseUrl}/api/inbox/visibility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sequence: 0, active: true, itemIds: ["fake:visible"] }),
    });
    expect(rejected.status).toBe(403);

    const accepted = await fetch(`${baseUrl}/api/inbox/visibility`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Helm-Visibility-Session": token,
      },
      body: JSON.stringify({ sequence: 1, active: true, itemIds: ["fake:visible"] }),
    });
    expect(accepted.status).toBe(200);
    expect(visibility.itemIsVisible("fake:visible")).toBe(true);
    expect(store.listOpen()).toEqual([]);
  });

  it("ignores an older presence report after a newer focused report", async () => {
    const session = await fetch(`${baseUrl}/api/inbox/visibility`);
    const { token } = await session.json() as { token: string };
    const headers = {
      "Content-Type": "application/json",
      "X-Helm-Visibility-Session": token,
    };

    const focused = await fetch(`${baseUrl}/api/inbox/visibility`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sequence: 2, active: true, itemIds: ["fake:visible"] }),
    });
    const delayedBlur = await fetch(`${baseUrl}/api/inbox/visibility`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sequence: 1, active: false, itemIds: [] }),
    });

    expect(focused.status).toBe(200);
    expect(delayedBlur.status).toBe(200);
    expect(visibility.itemIsVisible("fake:visible")).toBe(true);
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

  it("returns 400 for freeform text when allowFreeform is false", async () => {
    store.reconcile("fake", [item("k1")]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "not an option" }),
    });
    expect(res.status).toBe(400);
    expect(store.listOpen()).toHaveLength(1);
  });

  it("returns 400 for a value not in item.options", async () => {
    store.reconcile("fake", [item("k1")]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a blank value when text is also supplied", async () => {
    store.reconcile("fake", [
      {
        ...item("k1"),
        allowFreeform: true,
        options: [],
        respond: { channel: "resolve-key", target: "helm-foundation", key: "k1" },
      },
    ]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "", text: "ship it" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts typed text on an empty-option keyed status-decision (AC 8)", async () => {
    store.reconcile("fake", [
      {
        ...item("k1"),
        kind: "status-decision",
        allowFreeform: true,
        options: [],
      },
    ]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "choose A" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; argv: string[]; channel: string };
    expect(body.ok).toBe(true);
    expect(body.channel).toBe("resolve-key");
    expect(body.argv).toEqual([
      "fm-send.sh",
      "helm-foundation",
      "--resolve-key",
      "k1",
      "choose A",
    ]);
    expect(store.listOpen()).toHaveLength(0);
  });

  it("returns 400 for value when options is empty", async () => {
    store.reconcile("fake", [
      {
        ...item("k1"),
        allowFreeform: false,
        options: [],
      },
    ]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "whatever" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 for text/plain Content-Type (CSRF-simple type)", async () => {
    store.reconcile("fake", [item("k1")]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ value: "yes" }),
    });
    expect(res.status).toBe(403);
    expect(store.listOpen()).toHaveLength(1);
  });

  it("returns 403 for cross-site Sec-Fetch-Site", async () => {
    store.reconcile("fake", [item("k1")]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ value: "yes" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for a malformed percent-escape in the id", async () => {
    const res = await fetch(`${baseUrl}/api/inbox/%E0%A4%A/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when both value and text are present", async () => {
    store.reconcile("fake", [
      {
        ...item("k1"),
        allowFreeform: true,
      },
    ]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const res = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "yes", text: "and a note" }),
    });
    expect(res.status).toBe(400);
  });

  it("marks a delivered answer handled when audit persistence fails", async () => {
    let dispatches = 0;
    responder = createResponder({
      config: { ...CONFIG, helmStateDir: stateDir },
      audit: {
        append: () => {
          throw new Error("disk full");
        },
      },
      exec: {
        resolveKey: async (_item, answer) => {
          dispatches += 1;
          return {
            ok: true,
            channel: "resolve-key",
            argv: ["fm-send.sh", "helm-foundation", "--resolve-key", "k1", answer],
            exitCode: 0,
            stdout: "",
            stderr: "",
            at: "2026-09-06T00:00:00.000Z",
          };
        },
      },
    });
    store.reconcile("fake", [item("k1")]);
    const id = encodeURIComponent(inboxItemId("fake", "k1"));
    const response = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "yes" }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ delivered: true, error: expect.stringMatching(/audit persist failed/) });
    expect(store.isHandled(inboxItemId("fake", "k1"))).toBe(true);
    const retry = await fetch(`${baseUrl}/api/inbox/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "yes" }),
    });
    expect(retry.status).toBe(409);
    expect(dispatches).toBe(1);
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

    await readUntil(
      (text) =>
        text.includes("event: snapshot.begin") &&
        text.includes("event: item.upsert") &&
        text.includes("fake:k1") &&
        text.includes("event: snapshot.end"),
    );
    expect(buffer).toContain("event: snapshot.begin");
    expect(buffer).toContain("event: item.upsert");
    expect(buffer).toContain("event: snapshot.end");
    expect(buffer).toContain(inboxItemId("fake", "k1"));

    // Live event after subscribe.
    store.reconcile("fake", [item("k1"), item("k2")]);
    await readUntil((text) => text.includes("fake:k2"));
    expect(buffer).toContain("fake:k2");

    await reader.cancel();
  });

  it("resumes from Last-Event-ID", async () => {
    store.reconcile("fake", [item("a")]);
    const lastWire = store.wireId({
      id: store.lastEventId(),
      type: "item.upsert",
      data: item("a"),
      at: "2026-09-06T00:00:00.000Z",
    });
    store.reconcile("fake", [item("a"), item("b")]);

    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { "Last-Event-ID": lastWire },
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
    expect(buffer).toContain(`id: ${store.streamEpoch}-`);
    expect(buffer).toContain("fake:b");
    // Should not replay the pre-cursor upsert of `a` as a new snapshot.
    const upsertCount = buffer.split("event: item.upsert").length - 1;
    expect(upsertCount).toBe(1);
    await reader.cancel();
  });

  it("falls back to a bounded snapshot when Last-Event-ID epoch mismatches", async () => {
    store.reconcile("fake", [item("a"), item("b")]);

    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { "Last-Event-ID": "deadbeef-7" },
    });
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (
      !(
        buffer.includes("snapshot.begin") &&
        buffer.includes("fake:a") &&
        buffer.includes("fake:b") &&
        buffer.includes("snapshot.end")
      )
    ) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    expect(buffer).toContain("event: snapshot.begin");
    expect(buffer).toContain("fake:a");
    expect(buffer).toContain("fake:b");
    expect(buffer).toContain("event: snapshot.end");
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
