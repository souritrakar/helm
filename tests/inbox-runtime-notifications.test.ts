import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/herdr", () => ({
  showHerdrNotification: vi.fn(() => Promise.resolve({ exitCode: 0 })),
}));

import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { showHerdrNotification } from "@/lib/herdr";
import { createInboxRuntime } from "@/lib/inbox-runtime";
import { inboxItemId, type InboxItem } from "@/lib/types";

const notify = vi.mocked(showHerdrNotification);
let stateDir: string | undefined;

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

function item(title: string): InboxItem {
  return {
    id: inboxItemId("fake", "visible"),
    source: "fake",
    kind: "blocker",
    urgency: "blocking",
    title,
    options: [],
    allowFreeform: false,
    respond: { channel: "none" },
    evidence: [],
    state: "open",
    openedAt: "2026-09-07T00:00:00.000Z",
  };
}

afterEach(() => {
  notify.mockClear();
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

describe("native inbox notifications", () => {
  it("announces a new blocking phase after demotion", () => {
    stateDir = mkdtempSync(join(tmpdir(), "helm-runtime-"));
    const runtime = createInboxRuntime({ ...CONFIG, helmStateDir: stateDir });

    runtime.store.reconcile("fake", [item("first blocking phase")]);
    runtime.store.reconcile("fake", [{ ...item("attention phase"), urgency: "attention" }]);
    runtime.store.reconcile("fake", [item("second blocking phase")]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith({ ...CONFIG, helmStateDir: stateDir }, "second blocking phase", "second blocking phase");
  });

  it("suppresses a visible occurrence through updates until it is re-raised", () => {
    stateDir = mkdtempSync(join(tmpdir(), "helm-runtime-"));
    const runtime = createInboxRuntime({ ...CONFIG, helmStateDir: stateDir });
    const token = runtime.visibility.createSession();
    runtime.visibility.update(token, 0, true, [item("first").id]);

    runtime.store.reconcile("fake", [item("first")]);
    runtime.visibility.update(token, 1, false, []);
    runtime.store.reconcile("fake", [item("updated")]);

    expect(notify).not.toHaveBeenCalled();

    runtime.store.reconcile("fake", []);
    runtime.store.reconcile("fake", [item("re-raised")]);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith({ ...CONFIG, helmStateDir: stateDir }, "re-raised", "re-raised");
  });
});
