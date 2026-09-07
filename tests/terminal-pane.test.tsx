// @vitest-environment jsdom
/**
 * Status-only pane broadcasts must not wipe live discovery or Converse banners.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    reset(): void {}
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

import { TerminalPane } from "@/components/terminal-pane";

const OPEN = 1;
const sockets: FakeSocket[] = [];

class FakeSocket {
  static OPEN = OPEN;
  readyState = OPEN;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    sockets.push(this);
  }
}

const pane = (id: string, status = "idle") => ({
  id,
  title: id,
  taskId: "task-1",
  taskTitle: "Human title",
  status,
  isFirstmate: false,
});

function deliver(socket: FakeSocket, value: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(value) });
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function liveSocket(): Promise<FakeSocket> {
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error("no websocket");
  await waitFor(() => expect(socket.onmessage).not.toBeNull());
  return socket;
}

describe("TerminalPane banners", () => {
  it("keeps a discovery notice across a status-only panes broadcast", async () => {
    render(<TerminalPane />);
    const socket = await liveSocket();
    act(() => {
      deliver(socket, { type: "terminal.panes", panes: [pane("w1:p1")], selectedPaneId: "w1:p1" });
      deliver(socket, { type: "terminal.notice", message: "Pane discovery is degraded: snapshot failed" });
    });
    expect(screen.getByText("Pane discovery is degraded: snapshot failed")).toBeTruthy();

    act(() => {
      deliver(socket, { type: "terminal.panes", panes: [pane("w1:p1", "working")], selectedPaneId: "w1:p1" });
    });
    expect(screen.getByText("Pane discovery is degraded: snapshot failed")).toBeTruthy();
  });

  it("clears banners when the selected pane changes", async () => {
    render(<TerminalPane />);
    const socket = await liveSocket();
    act(() => {
      deliver(socket, {
        type: "terminal.panes",
        panes: [pane("w1:p1"), pane("w1:p2")],
        selectedPaneId: "w1:p1",
      });
      deliver(socket, { type: "terminal.notice", message: "Pane discovery is degraded: snapshot failed" });
    });
    expect(screen.getByText("Pane discovery is degraded: snapshot failed")).toBeTruthy();
    act(() => {
      deliver(socket, {
        type: "terminal.panes",
        panes: [pane("w1:p1"), pane("w1:p2")],
        selectedPaneId: "w1:p2",
      });
    });
    expect(screen.queryByText("Pane discovery is degraded: snapshot failed")).toBeNull();
  });
});
