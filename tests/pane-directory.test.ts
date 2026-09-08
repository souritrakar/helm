/**
 * PaneDirectory must keep one snapshot tree in flight, recover from a clean
 * event-stream close, and apply agent-status flips without rediscovering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HelmConfig } from "@/lib/config";
import type { HerdrEvent, HerdrEventStream, HerdrPane } from "@/lib/herdr";

const { agentList, paneList, subscribeEvents, fleetSnapshot } = vi.hoisted(() => ({
  agentList: vi.fn(),
  paneList: vi.fn(),
  subscribeEvents: vi.fn(),
  fleetSnapshot: vi.fn(),
}));

vi.mock("@/lib/herdr", () => ({ agentList, paneList, subscribeEvents }));
vi.mock("@/lib/fm", () => ({ fleetSnapshot }));

import { discoverPanes, PaneDirectory } from "@/lib/panes";

const config: HelmConfig = {
  fmHome: "/fixture/firstmate",
  fmBinDir: "/fm/bin",
  fmStateDir: "/fm/state",
  helmStateDir: "/helm/state",
  herdrSocketPath: "/tmp/herdr.sock",
  herdrBin: "herdr",
  port: 7333,
  bind: "127.0.0.1",
};

function pane(id: string, status: HerdrPane["agent_status"] = "idle"): HerdrPane {
  return {
    pane_id: id,
    terminal_id: `t-${id}`,
    workspace_id: "w1",
    tab_id: "tab",
    focused: false,
    agent_status: status,
    revision: 1,
    terminal_title_stripped: `title ${id}`,
  };
}

function hangingStream(): { stream: HerdrEventStream; onEvent: (event: HerdrEvent) => void } {
  let onEvent: (event: HerdrEvent) => void = () => undefined;
  const stream: HerdrEventStream = {
    ready: Promise.resolve(),
    closed: new Promise(() => undefined),
    close: vi.fn(),
  };
  subscribeEvents.mockImplementation((_cfg, _subs, handler: (event: HerdrEvent) => void) => {
    onEvent = handler;
    return stream;
  });
  return { stream, onEvent: (event) => onEvent(event) };
}

function resolvableStream(): { stream: HerdrEventStream; resolve: () => void } {
  let resolveClosed = (): void => undefined;
  const stream: HerdrEventStream = {
    ready: Promise.resolve(),
    closed: new Promise<void>((resolve) => {
      resolveClosed = resolve;
    }),
    close: vi.fn(),
  };
  subscribeEvents.mockReturnValue(stream);
  return { stream, resolve: () => resolveClosed() };
}

beforeEach(() => {
  vi.useFakeTimers();
  agentList.mockReset();
  paneList.mockReset();
  subscribeEvents.mockReset();
  fleetSnapshot.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("discoverPanes", () => {
  it("holds until a slow fleet snapshot settles when a Herdr seam already failed", async () => {
    let finishSnapshot!: (value: { tasks: never[] }) => void;
    fleetSnapshot.mockReturnValue(
      new Promise<{ tasks: never[] }>((resolve) => {
        finishSnapshot = resolve;
      }),
    );
    agentList.mockRejectedValue(new Error("herdr down"));
    paneList.mockResolvedValue([pane("w1:p1")]);

    let settled = false;
    const pending = discoverPanes(config).catch((cause: unknown) => cause);
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    finishSnapshot({ tasks: [] });
    const cause = await pending;
    expect(settled).toBe(true);
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe("herdr down");
  });

  it("returns Herdr panes when the fleet snapshot rejects", async () => {
    agentList.mockResolvedValue([{ pane_id: "w1:p1" }]);
    paneList.mockResolvedValue([pane("w1:p1")]);
    fleetSnapshot.mockRejectedValue(new Error("snapshot failed"));

    const discovery = await discoverPanes(config);

    expect(discovery.panes.map((entry) => entry.id)).toEqual(["w1:p1"]);
    expect(discovery.panes[0]?.taskTitle).toBeNull();
  });
});

describe("PaneDirectory", () => {
  it("does not start a second snapshot while the first is still running", async () => {
    let finishSnapshot!: (value: { tasks: never[] }) => void;
    fleetSnapshot.mockReturnValue(
      new Promise<{ tasks: never[] }>((resolve) => {
        finishSnapshot = resolve;
      }),
    );
    agentList.mockRejectedValue(new Error("herdr down"));
    paneList.mockResolvedValue([]);
    hangingStream();

    const onError = vi.fn();
    const directory = new PaneDirectory(config, () => undefined, onError);
    const started = directory.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(fleetSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fleetSnapshot).toHaveBeenCalledTimes(1);

    finishSnapshot({ tasks: [] });
    await started;
    expect(onError).toHaveBeenCalled();
    directory.close();
  });

  it("retries after a clean event-stream close", async () => {
    fleetSnapshot.mockResolvedValue({ tasks: [] });
    agentList.mockResolvedValue([{ pane_id: "w1:p1" }]);
    paneList.mockResolvedValue([pane("w1:p1")]);
    const { resolve } = resolvableStream();

    const onError = vi.fn();
    const directory = new PaneDirectory(config, () => undefined, onError);
    await directory.start();
    expect(subscribeEvents).toHaveBeenCalled();

    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith("pane event stream closed");

    const callsBeforeRetry = fleetSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fleetSnapshot.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    directory.close();
  });

  it("applies agent status locally without another fleet snapshot", async () => {
    fleetSnapshot.mockResolvedValue({ tasks: [] });
    agentList.mockResolvedValue([{ pane_id: "w1:p1" }]);
    paneList.mockResolvedValue([pane("w1:p1")]);
    let statusHandler: ((event: HerdrEvent) => void) | undefined;
    subscribeEvents.mockImplementation((_cfg, subscriptions: { type: string }[], handler: (event: HerdrEvent) => void) => {
      if (subscriptions.some((subscription) => subscription.type === "pane.agent_status_changed")) {
        statusHandler = handler;
      }
      return { ready: Promise.resolve(), closed: new Promise(() => undefined), close: vi.fn() };
    });

    const updates: string[] = [];
    const directory = new PaneDirectory(
      config,
      (discovery) => {
        updates.push(discovery.panes[0]?.status ?? "");
      },
      () => undefined,
    );
    await directory.start();
    expect(fleetSnapshot).toHaveBeenCalledTimes(1);
    expect(updates).toEqual(["idle"]);

    expect(statusHandler).toBeTypeOf("function");
    statusHandler?.({
      event: "pane.agent_status_changed",
      data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" },
    });
    expect(updates).toEqual(["idle", "working"]);
    expect(fleetSnapshot).toHaveBeenCalledTimes(1);
    directory.close();
  });

  it("publishes Herdr panes before the fleet snapshot settles and enriches titles later", async () => {
    let finishSnapshot!: (value: { tasks: { id: string; endpoint: { target: string }; backlog: { structured: true; title: string } }[] }) => void;
    fleetSnapshot.mockReturnValue(
      new Promise((resolve) => {
        finishSnapshot = resolve;
      }),
    );
    agentList.mockResolvedValue([{ pane_id: "w1:p1" }]);
    paneList.mockResolvedValue([pane("w1:p1")]);
    hangingStream();

    const updates: { id: string; taskTitle: string | null }[] = [];
    const onError = vi.fn();
    let published!: () => void;
    const firstPublish = new Promise<void>((resolve) => {
      published = resolve;
    });
    const directory = new PaneDirectory(
      config,
      (discovery) => {
        updates.push({ id: discovery.panes[0]?.id ?? "", taskTitle: discovery.panes[0]?.taskTitle ?? null });
        if (updates.length === 1) published();
      },
      onError,
    );
    void directory.start();
    await firstPublish;
    await Promise.resolve();

    expect(updates).toEqual([{ id: "w1:p1", taskTitle: null }]);
    expect(onError).toHaveBeenCalledWith("fleet snapshot is still running");

    finishSnapshot({
      tasks: [{ id: "helm-terminal", endpoint: { target: "default:w1:p1" }, backlog: { structured: true, title: "Human title" } }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(updates).toEqual([
      { id: "w1:p1", taskTitle: null },
      { id: "w1:p1", taskTitle: "Human title" },
    ]);
    expect(onError).toHaveBeenLastCalledWith("");
    directory.close();
  });

  it("keeps published panes when the fleet snapshot rejects", async () => {
    let rejectSnapshot!: (cause: Error) => void;
    fleetSnapshot.mockReturnValue(
      new Promise((_, reject) => {
        rejectSnapshot = reject;
      }),
    );
    agentList.mockResolvedValue([{ pane_id: "w1:p1" }]);
    paneList.mockResolvedValue([pane("w1:p1")]);
    hangingStream();

    const updates: string[] = [];
    const onError = vi.fn();
    let published!: () => void;
    const firstPublish = new Promise<void>((resolve) => {
      published = resolve;
    });
    const directory = new PaneDirectory(
      config,
      (discovery) => {
        updates.push(discovery.panes[0]?.id ?? "");
        if (updates.length === 1) published();
      },
      onError,
    );
    void directory.start();
    await firstPublish;

    expect(updates).toEqual(["w1:p1"]);
    rejectSnapshot(new Error("snapshot failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(updates).toEqual(["w1:p1"]);
    expect(onError).toHaveBeenCalledWith("snapshot failed");
    directory.close();
  });
});
