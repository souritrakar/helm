/**
 * InboxStore reconcile / retract / answered-history (AC 11).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInboxStore, type InboxStore, type InboxStoreEvent } from "@/lib/inbox-store";
import { historyPath } from "@/lib/paths";
import { inboxItemId, type InboxItem } from "@/lib/types";

const SOURCE = "fake";
let stateDir: string;
let store: InboxStore;
let clock = 0;

function now(): string {
  clock += 1;
  return `2026-09-06T00:00:0${clock}.000Z`;
}

function item(naturalKey: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: inboxItemId(SOURCE, naturalKey),
    source: SOURCE,
    kind: "decision",
    urgency: "blocking",
    title: naturalKey,
    options: [{ value: "yes", label: "Yes" }],
    allowFreeform: false,
    respond: { channel: "resolve-key", target: "task-a", key: naturalKey },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  clock = 0;
  stateDir = mkdtempSync(join(tmpdir(), "helm-inbox-"));
  store = createInboxStore(stateDir, { now });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("InboxStore.reconcile", () => {
  it("upserts new items and keeps openedAt on re-emit", () => {
    const events: InboxStoreEvent[] = [];
    store.subscribe((event) => events.push(event));

    store.reconcile(SOURCE, [item("k1")]);
    expect(store.listOpen()).toHaveLength(1);
    expect(store.listOpen()[0]?.openedAt).toBe("2026-09-06T00:00:01.000Z");

    store.reconcile(SOURCE, [item("k1", { title: "updated", openedAt: "2099-01-01T00:00:00.000Z" })]);
    expect(store.listOpen()[0]?.title).toBe("updated");
    expect(store.listOpen()[0]?.openedAt).toBe("2026-09-06T00:00:01.000Z");

    expect(events.map((e) => e.type)).toEqual(["item.upsert", "item.upsert"]);
  });

  it("retracts ids that vanished from a full-set emit (missed-event self-heal)", () => {
    store.reconcile(SOURCE, [item("a"), item("b")]);
    expect(store.listOpen().map((i) => i.id).sort()).toEqual([
      inboxItemId(SOURCE, "a"),
      inboxItemId(SOURCE, "b"),
    ]);

    const events: InboxStoreEvent[] = [];
    store.subscribe((event) => events.push(event));
    store.reconcile(SOURCE, [item("a")]);

    expect(store.listOpen().map((i) => i.id)).toEqual([inboxItemId(SOURCE, "a")]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "item.retract",
        data: { id: inboxItemId(SOURCE, "b") },
      }),
    ]);
  });

  it("does not retract items from a different source", () => {
    store.reconcile(SOURCE, [item("a")]);
    store.reconcile("other", [
      {
        ...item("x"),
        id: inboxItemId("other", "x"),
        source: "other",
      },
    ]);

    store.reconcile(SOURCE, []);
    expect(store.listOpen().map((i) => i.id)).toEqual([inboxItemId("other", "x")]);
  });

  it("rejects an item whose source does not match the reconcile source", () => {
    expect(() =>
      store.reconcile(SOURCE, [{ ...item("a"), source: "other", id: inboxItemId("other", "a") }]),
    ).toThrow(/expected "fake"/);
  });
});

describe("answered history (AC 11)", () => {
  it("persists answered ids and refuses to resurrect them on reconcile", () => {
    store.reconcile(SOURCE, [item("k1")]);
    store.markAnswered(inboxItemId(SOURCE, "k1"), "2026-09-06T01:00:00.000Z");

    expect(store.listOpen()).toHaveLength(0);
    expect(store.isHandled(inboxItemId(SOURCE, "k1"))).toBe(true);

    const history = JSON.parse(readFileSync(historyPath(stateDir), "utf8")) as {
      items: Record<string, unknown>;
    };
    expect(history.items[inboxItemId(SOURCE, "k1")]).toMatchObject({ state: "answered" });

    store.reconcile(SOURCE, [item("k1")]);
    expect(store.listOpen()).toHaveLength(0);
  });

  it("reloads answered history across store restarts", () => {
    store.reconcile(SOURCE, [item("k1"), item("k2")]);
    store.markAnswered(inboxItemId(SOURCE, "k1"));

    const restarted = createInboxStore(stateDir, { now });
    restarted.reconcile(SOURCE, [item("k1"), item("k2")]);

    expect(restarted.listOpen().map((i) => i.id)).toEqual([inboxItemId(SOURCE, "k2")]);
    expect(restarted.isHandled(inboxItemId(SOURCE, "k1"))).toBe(true);
  });
});

describe("event ids", () => {
  it("assigns incrementing ids and replays eventsSince for Last-Event-ID", () => {
    store.reconcile(SOURCE, [item("a")]);
    store.reconcile(SOURCE, [item("a"), item("b")]);
    const last = store.lastEventId();
    expect(last).toBeGreaterThan(0);

    store.reconcile(SOURCE, [item("b")]);
    const replay = store.eventsSince(last);
    expect(replay.map((e) => e.type)).toEqual(["item.retract"]);
    expect(replay[0]?.data).toEqual({ id: inboxItemId(SOURCE, "a") });
  });
});
