// @vitest-environment jsdom
/**
 * Status-only pane broadcasts must not wipe live discovery or Converse banners.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const { terminalOptions } = vi.hoisted(() => ({
  terminalOptions: { current: undefined as { disableStdin?: boolean } | undefined },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    constructor(options: { disableStdin?: boolean } = {}) {
      terminalOptions.current = options;
    }
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
  terminalOptions.current = undefined;
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
  it("does not treat connecting spawn reasons as failures", async () => {
    render(<TerminalPane />);
    const socket = await liveSocket();
    act(() => {
      deliver(socket, { type: "terminal.status", status: "connecting", reason: "connected" });
    });
    expect(screen.getByText("Connecting")).toBeTruthy();
    expect(screen.queryByText("connected")).toBeNull();
    act(() => {
      deliver(socket, { type: "terminal.status", status: "connecting", reason: "resized" });
    });
    expect(screen.queryByText("resized")).toBeNull();
    act(() => {
      deliver(socket, { type: "terminal.status", status: "connecting", reason: "pane-switched" });
    });
    expect(screen.queryByText("pane-switched")).toBeNull();
    act(() => {
      deliver(socket, { type: "terminal.status", status: "connecting", reason: "reconnecting" });
    });
    expect(screen.queryByText("reconnecting")).toBeNull();
    act(() => {
      socket.onclose?.();
    });
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByText("connected")).toBeNull();
    expect(screen.queryByText("resized")).toBeNull();
    expect(screen.queryByText("pane-switched")).toBeNull();
  });

  it("shows a closed-status reason as a warning banner", async () => {
    render(<TerminalPane />);
    const socket = await liveSocket();
    act(() => {
      deliver(socket, { type: "terminal.status", status: "closed", reason: "observer exited" });
    });
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("observer exited")).toBeTruthy();
  });

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

    act(() => {
      deliver(socket, { type: "terminal.notice", message: "" });
    });
    expect(screen.queryByText("Pane discovery is degraded: snapshot failed")).toBeNull();
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

  it("clears banners when the pane-id set changes", async () => {
    render(<TerminalPane />);
    const socket = await liveSocket();
    act(() => {
      deliver(socket, { type: "terminal.panes", panes: [pane("w1:p1")], selectedPaneId: "w1:p1" });
      deliver(socket, { type: "terminal.notice", message: "Pane discovery is degraded: snapshot failed" });
    });
    act(() => {
      deliver(socket, {
        type: "terminal.panes",
        panes: [pane("w1:p1"), pane("w1:p2")],
        selectedPaneId: "w1:p1",
      });
    });
    expect(screen.queryByText("Pane discovery is degraded: snapshot failed")).toBeNull();
  });

  it("keeps a Converse error across a status-only panes broadcast and clears it on pane switch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "Unknown pane" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TerminalPane />);
    const socket = await liveSocket();
    act(() => {
      deliver(socket, {
        type: "terminal.panes",
        panes: [pane("w1:p1"), pane("w1:p2")],
        selectedPaneId: "w1:p1",
      });
    });
    fireEvent.change(screen.getByPlaceholderText("Type to this pane…"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.submit(screen.getByPlaceholderText("Type to this pane…").closest("form")!);
    });
    expect(screen.getByText("Unknown pane")).toBeTruthy();
    act(() => {
      deliver(socket, {
        type: "terminal.panes",
        panes: [pane("w1:p1", "working"), pane("w1:p2")],
        selectedPaneId: "w1:p1",
      });
    });
    expect(screen.getByText("Unknown pane")).toBeTruthy();
    act(() => {
      deliver(socket, {
        type: "terminal.panes",
        panes: [pane("w1:p1"), pane("w1:p2")],
        selectedPaneId: "w1:p2",
      });
    });
    expect(screen.queryByText("Unknown pane")).toBeNull();
  });
});

describe("TerminalPane mirror", () => {
  it("constructs xterm without stdin so the canvas cannot diverge from the observer", async () => {
    render(<TerminalPane />);
    await liveSocket();
    expect(terminalOptions.current?.disableStdin).toBe(true);
  });
});

describe("TerminalPane dropdown", () => {
  it("labels options with the human-readable task title and a supplemental task id", async () => {
    render(<TerminalPane />);
    const socket = await liveSocket();
    act(() => {
      deliver(socket, {
        type: "terminal.panes",
        panes: [
          pane("w1:p1"),
          { ...pane("w1:p2"), taskTitle: null, taskId: null, title: "bare pane" },
          { ...pane("w1:p3"), isFirstmate: true, taskTitle: "Captain lane", taskId: "helm-terminal" },
        ],
        selectedPaneId: "w1:p1",
      });
    });
    expect(screen.getByRole("option", { name: "Human title (task-1)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "bare pane" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Firstmate — Captain lane (helm-terminal)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "task-1" })).toBeNull();
  });

  it("does not change selection while the WebSocket is not open", async () => {
    render(<TerminalPane />);
    const socket = await liveSocket();
    act(() => {
      deliver(socket, {
        type: "terminal.panes",
        panes: [pane("w1:p1"), pane("w1:p2")],
        selectedPaneId: "w1:p1",
      });
    });
    socket.readyState = 0;
    socket.send.mockClear();
    fireEvent.change(screen.getByRole("combobox", { name: "Pane" }), { target: { value: "w1:p2" } });
    expect(socket.send).not.toHaveBeenCalled();
    expect(screen.getByText("Terminal connection is not ready")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Pane" })).toHaveProperty("value", "w1:p1");
  });
});
