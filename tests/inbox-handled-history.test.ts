/**
 * Answered and dismissed cards must be READABLE, not merely suppressed.
 *
 * The Answered and Dismissed tabs were empty because history recorded only
 * that an id was handled, and the cold-connect snapshot carried open cards
 * only. The card body now survives, and the snapshot replays it — without
 * letting a handled card back into the open set.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInboxStore, type InboxStore } from "@/lib/inbox-store";
import { historyPath } from "@/lib/paths";
import { inboxItemId, type InboxItem } from "@/lib/types";

let stateDir = "";
let store: InboxStore;

function item(naturalKey: string): InboxItem {
  return {
    id: inboxItemId("fake", naturalKey),
    source: "fake",
    kind: "merge",
    urgency: "blocking",
    taskId: "helm-lane-e",
    title: `Merge ${naturalKey}`,
    detail: "PR has green checks.",
    options: [{ value: "approve", label: "Approve" }],
    allowFreeform: true,
    respond: { channel: "relay", target: "w1:p1" },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T00:00:00.000Z",
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "helm-history-"));
  store = createInboxStore(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("handled history", () => {
  it("keeps an answered card readable, with the answer that was given", () => {
    store.reconcile("fake", [item("lane-e")]);

    store.markAnswered(inboxItemId("fake", "lane-e"), "2026-09-06T01:00:00.000Z", "approve");

    expect(store.listHandled()).toMatchObject([
      {
        id: "fake:lane-e",
        state: "answered",
        title: "Merge lane-e",
        answer: "approve",
        answeredAt: "2026-09-06T01:00:00.000Z",
      },
    ]);
  });

  it("keeps a dismissed card readable and records no answer", () => {
    store.reconcile("fake", [item("lane-e")]);

    store.markDismissed(inboxItemId("fake", "lane-e"));

    expect(store.listHandled()).toMatchObject([{ id: "fake:lane-e", state: "dismissed" }]);
    expect(store.listHandled()[0]?.answer).toBeUndefined();
  });

  it("drops the card from the open set", () => {
    store.reconcile("fake", [item("lane-e")]);

    store.markAnswered(inboxItemId("fake", "lane-e"));

    expect(store.listOpen()).toEqual([]);
  });

  it("reads handled cards newest first", () => {
    store.reconcile("fake", [item("first"), item("second")]);

    store.markAnswered(inboxItemId("fake", "first"), "2026-09-06T01:00:00.000Z");
    store.markAnswered(inboxItemId("fake", "second"), "2026-09-06T02:00:00.000Z");

    expect(store.listHandled().map((entry) => entry.id)).toEqual(["fake:second", "fake:first"]);
  });

  it("survives a restart, so the tabs are not empty after a reload", () => {
    store.reconcile("fake", [item("lane-e")]);
    store.markAnswered(inboxItemId("fake", "lane-e"), "2026-09-06T01:00:00.000Z", "approve");

    const restarted = createInboxStore(stateDir);

    expect(restarted.listHandled()).toMatchObject([
      { id: "fake:lane-e", state: "answered", title: "Merge lane-e", answer: "approve" },
    ]);
    expect(restarted.isHandled("fake:lane-e")).toBe(true);
  });

  it("still suppresses re-raise after a restart", () => {
    store.reconcile("fake", [item("lane-e")]);
    store.markAnswered(inboxItemId("fake", "lane-e"));

    const restarted = createInboxStore(stateDir);
    restarted.reconcile("fake", [item("lane-e")]);

    expect(restarted.listOpen()).toEqual([]);
  });

  it("loads a version-1 history file: those records suppress but cannot be rendered", () => {
    writeFileSync(
      historyPath(stateDir),
      JSON.stringify({
        version: 1,
        items: { "fake:old": { state: "answered", openedAt: "2026-09-01T00:00:00.000Z", answeredAt: "2026-09-02T00:00:00.000Z" } },
      }),
    );

    const loaded = createInboxStore(stateDir);

    expect(loaded.isHandled("fake:old")).toBe(true);
    expect(loaded.listHandled()).toEqual([]);
  });

  it("refuses a history file whose version it does not know", () => {
    writeFileSync(historyPath(stateDir), JSON.stringify({ version: 99, items: {} }));

    expect(() => createInboxStore(stateDir)).toThrow(/unknown shape/);
  });

  it("writes the card body into the history file", () => {
    store.reconcile("fake", [item("lane-e")]);
    store.markAnswered(inboxItemId("fake", "lane-e"), "2026-09-06T01:00:00.000Z", "approve");

    const persisted = JSON.parse(readFileSync(historyPath(stateDir), "utf8")) as {
      version: number;
      items: Record<string, { item?: { title?: string } }>;
    };

    expect(persisted.version).toBe(2);
    expect(persisted.items["fake:lane-e"]?.item?.title).toBe("Merge lane-e");
  });
});

describe("cold-connect snapshot", () => {
  it("replays handled cards so the Answered tab is populated on a fresh connect", () => {
    store.reconcile("fake", [item("open-one"), item("handled-one")]);
    store.markAnswered(inboxItemId("fake", "handled-one"), "2026-09-06T01:00:00.000Z", "approve");

    const events = store.captureSnapshot();
    const upserted = events
      .filter((event) => event.type === "item.upsert")
      .map((event) => event.data as InboxItem);

    expect(upserted.map((entry) => `${entry.id}:${entry.state}`)).toEqual([
      "fake:handled-one:answered",
      "fake:open-one:open",
    ]);
  });

  it("names only the OPEN ids in snapshot.begin, so a handled card cannot re-enter the open set", () => {
    store.reconcile("fake", [item("open-one"), item("handled-one")]);
    store.markAnswered(inboxItemId("fake", "handled-one"));

    const events = store.captureSnapshot();
    const begin = events.find((event) => event.type === "snapshot.begin");
    const end = events.find((event) => event.type === "snapshot.end");

    expect((begin?.data as { ids: string[] }).ids).toEqual(["fake:open-one"]);
    expect((end?.data as { count: number }).count).toBe(1);
  });
});
