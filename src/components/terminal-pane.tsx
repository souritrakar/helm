"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Send, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface TerminalPaneInfo {
  id: string;
  title: string;
  taskId: string | null;
  taskTitle: string | null;
  status: string;
  isFirstmate: boolean;
}

type TerminalStatus = "connecting" | "connected" | "resyncing" | "closed";
type ServerMessage =
  | { type: "terminal.panes"; panes: TerminalPaneInfo[]; selectedPaneId: string | null }
  | { type: "terminal.status"; status: TerminalStatus; reason?: string };

export function TerminalPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panes, setPanes] = useState<TerminalPaneInfo[]>([]);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [detail, setDetail] = useState("");
  const [text, setText] = useState("");

  const sendViewport = useCallback(() => {
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    if (terminal === null || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "terminal.resize", cols: terminal.cols, rows: terminal.rows }));
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: false,
      convertEol: true,
      fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
      fontSize: 13,
      theme: { background: "#09090b", foreground: "#fafafa" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminalRef.current = terminal;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/api/term`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onopen = () => sendViewport();
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") { terminal.write(new Uint8Array(event.data)); return; }
      let message: ServerMessage;
      try { message = JSON.parse(event.data) as ServerMessage; } catch { return; }
      if (message.type === "terminal.panes") {
        const next = message.panes as TerminalPaneInfo[];
        setPanes(next); setSelectedPaneId(message.selectedPaneId as string | null);
      } else if (message.type === "terminal.status") {
        setStatus(message.status as TerminalStatus); setDetail(typeof message.reason === "string" ? message.reason : "");
      }
    };
    socket.onclose = () => setStatus("closed");
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(sendViewport, 250);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      socket.close(); terminal.dispose(); terminalRef.current = null;
    };
  }, [sendViewport]);

  const selectPane = (paneId: string): void => {
    terminalRef.current?.reset();
    setSelectedPaneId(paneId);
    socketRef.current?.send(JSON.stringify({ type: "terminal.select", paneId }));
  };
  const reconnect = (): void => socketRef.current?.send(JSON.stringify({ type: "terminal.reconnect" }));
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const value = text.trim(); if (value === "" || selectedPaneId === null) return;
    const response = await fetch("/api/term/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paneId: selectedPaneId, text: value }) });
    if (response.ok) setText(""); else setDetail((await response.json().catch(() => ({ error: "Could not send text" }))).error);
  };

  return <section className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
    <header className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2">
      <label className="relative min-w-0 flex-1"><span className="sr-only">Pane</span><select value={selectedPaneId ?? ""} onChange={(event) => selectPane(event.target.value)} className="w-full appearance-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 pr-8 text-sm text-zinc-100">
        {panes.map((pane) => <option key={pane.id} value={pane.id}>{pane.isFirstmate ? "Firstmate — " : ""}{pane.taskId ?? pane.title}</option>)}
      </select><ChevronDown className="pointer-events-none absolute right-2 top-2 size-4 text-zinc-400" /></label>
      <span className="text-xs text-zinc-400">{status === "connected" ? "Live mirror" : status === "resyncing" ? "Resyncing" : status === "closed" ? "Disconnected" : "Connecting"}</span>
      {status === "closed" && <button type="button" onClick={reconnect} className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">Reconnect</button>}
    </header>
    {detail !== "" && status !== "connected" && <div className="flex items-center gap-2 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-200"><WifiOff className="size-3.5" />{detail}</div>}
    <div ref={hostRef} className="min-h-0 flex-1 p-2" aria-label="Read-only terminal mirror" />
    <form onSubmit={submit} className="flex gap-2 border-t border-zinc-800 p-3"><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Converse with this pane…" className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-400" /><button type="submit" disabled={selectedPaneId === null || text.trim() === ""} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 disabled:opacity-40"><Send className="size-4" />Send</button></form>
  </section>;
}
