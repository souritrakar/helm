/**
 * Adapter registry + fake adapter (Lane C deliverable; real adapters are Lane D).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeAdapter } from "@/lib/adapters/fake";
import { createAdapterRegistry } from "@/lib/adapters/registry";
import { createInboxStore } from "@/lib/inbox-store";
import { inboxItemId, type InboxAdapter, type InboxItem } from "@/lib/types";

let stateDir: string;

function item(naturalKey: string): InboxItem {
  return {
    id: inboxItemId("fake", naturalKey),
    source: "fake",
    kind: "note",
    urgency: "fyi",
    title: naturalKey,
    options: [],
    allowFreeform: true,
    respond: { channel: "relay", target: "w1:p1" },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T00:00:00.000Z",
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "helm-adapters-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("AdapterRegistry + fake adapter", () => {
  it("starts the fake adapter and reconciles emits into the store", async () => {
    const store = createInboxStore(stateDir);
    const registry = createAdapterRegistry();
    const { adapter, controls } = createFakeAdapter();
    registry.register(adapter);

    await registry.start(store);
    expect(controls.started).toBe(true);

    controls.emit([item("one"), item("two")]);
    expect(store.listOpen()).toHaveLength(2);

    controls.emit([item("one")]);
    expect(store.listOpen().map((i) => i.id)).toEqual([inboxItemId("fake", "one")]);

    controls.retract([inboxItemId("fake", "one")]);
    expect(store.listOpen()).toHaveLength(0);

    registry.stop();
    expect(controls.started).toBe(false);
  });

  it("rejects duplicate adapter ids", () => {
    const registry = createAdapterRegistry();
    const { adapter } = createFakeAdapter({ id: "fake" });
    registry.register(adapter);
    expect(() => registry.register(createFakeAdapter({ id: "fake" }).adapter)).toThrow(/already registered/);
  });

  it("disposes already-started adapters when a later start fails", async () => {
    const store = createInboxStore(stateDir);
    const registry = createAdapterRegistry();
    const first = createFakeAdapter({ id: "first" });
    const failing: InboxAdapter = {
      id: "failing",
      async start(): Promise<Disposable> {
        throw new Error("boom");
      },
    };
    registry.register(first.adapter);
    registry.register(failing);

    await expect(registry.start(store)).rejects.toThrow(/boom/);
    expect(first.controls.started).toBe(false);
  });

  it("does not let an adapter retract another adapter's cards", async () => {
    const store = createInboxStore(stateDir);
    const registry = createAdapterRegistry();
    let retractFirst: ((ids: string[]) => void) | undefined;
    registry.register({
      id: "first",
      async start(ctx) {
        retractFirst = ctx.retract;
        ctx.emit([{ ...item("one"), id: inboxItemId("first", "one"), source: "first" }]);
        return { [Symbol.dispose]: () => undefined };
      },
    });
    registry.register({
      id: "second",
      async start(ctx) {
        ctx.emit([{ ...item("two"), id: inboxItemId("second", "two"), source: "second" }]);
        return { [Symbol.dispose]: () => undefined };
      },
    });

    await registry.start(store);
    retractFirst?.([inboxItemId("second", "two")]);
    expect(store.listOpen().map((entry) => entry.id)).toContain(inboxItemId("second", "two"));
  });
});
