"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, CornerDownLeft, Send, WifiOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { onTerminalContext, type TerminalContext } from "@/components/terminal-composer";
import { composePaneLine } from "@/lib/inbox-context";

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
  | { type: "terminal.status"; status: TerminalStatus; reason?: string }
  | { type: "terminal.notice"; message: string };

/**
 * Concrete monospace stack for the emulator.
 *
 * It must NOT be a CSS `var()`. xterm measures one character cell and then
 * positions every glyph on that grid; a `var()` it cannot resolve in the
 * measurement context yields a cell width from a different font than the one
 * painted, and xterm papers over the mismatch with per-character letter-spacing.
 * The result is the overlapping, interleaved text the captain reported.
 */
const TERMINAL_FONT = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Keys helm forwards to the pane, in the bounded set the server accepts. */
const KEY_SHORTCUTS: Record<string, "enter" | "escape" | "c-c" | "tab" | "backspace" | "up" | "down" | "left" | "right"> = {
  Escape: "escape",
  Tab: "tab",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

export function TerminalPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const connectRef = useRef<() => void>(() => undefined);
  const composerRef = useRef<HTMLInputElement>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panes, setPanes] = useState<TerminalPaneInfo[]>([]);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [detail, setDetail] = useState("");
  const [notice, setNotice] = useState("");
  const [sendError, setSendError] = useState("");
  const [text, setText] = useState("");
  const [contexts, setContexts] = useState<readonly TerminalContext[]>([]);
  const [caretBump, setCaretBump] = useState(0);

  /**
   * Attach an inbox card to the message being written.
   *
   * The card rides ABOVE the input as a removable chip rather than inside it:
   * one block is several hundred characters of machine text, and pasting that
   * into a single-line field leaves the human's own words scrolled out of
   * sight — the field stops reading as a composer and starts reading as a box
   * that holds the card. The chips carry the context, the input stays the
   * human's, and {@link composePaneLine} sends both as one line.
   */
  useEffect(
    () =>
      onTerminalContext((context) => {
        setContexts((current) =>
          current.some((attached) => attached.text === context.text) ? current : [...current, context],
        );
        setCaretBump((value) => value + 1);
      }),
    [],
  );

  /**
   * Put the caret back in the composer after anything moved it.
   *
   * Attaching a card and removing a chip are both button presses, so without
   * this the next keystroke goes to a button — or, once a removed chip's button
   * is gone, to `document.body`, where the shell's single-key shortcuts eat it.
   */
  const focusComposer = useCallback(() => setCaretBump((value) => value + 1), []);

  useEffect(() => {
    if (caretBump === 0) return;
    const input = composerRef.current;
    if (input === null) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [caretBump]);

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
      // The mirror carries no local echo: every byte on screen came from the
      // pane. Input is composed in the row below and sent as whole lines plus
      // named keys, so xterm itself must not consume keystrokes.
      disableStdin: true,
      allowTransparency: false,
      cursorBlink: false,
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
      // The pane owns scrollback; a second buffer here would only diverge from
      // it and stretch the surface the fit addon measures.
      scrollback: 1000,
      theme: { background: "#09090b", foreground: "#fafafa" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    let disposed = false;
    let lastPaneIds = "";
    let lastSelectedPaneId: string | null = null;
    let closedStatusReason = false;

    /**
     * Fit only once the element has a real box.
     *
     * A zero or unbounded height yields a nonsense row count, and the observer
     * viewport is fixed at spawn — so a bad first fit becomes a full repaint
     * wrapped to the wrong geometry.
     */
    const safeFit = (): boolean => {
      const { width, height } = host.getBoundingClientRect();
      if (width < 2 || height < 2) return false;
      try {
        fit.fit();
      } catch {
        return false;
      }
      return true;
    };

    // Web fonts load after mount. Measuring the cell before "Geist Mono" is
    // ready sizes the grid to the fallback face, so re-fit once it resolves.
    // The Font Loading API is optional, so its absence just means no re-fit —
    // the ResizeObserver below is still the backstop.
    let fitted = safeFit();
    void document.fonts?.ready.then(() => {
      if (disposed) return;
      fitted = safeFit() || fitted;
      sendViewport();
    });

    const connect = (): void => {
      if (disposed) return;
      socketRef.current?.close();
      setStatus("connecting");
      setDetail("");
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      // The observer viewport is fixed at spawn, so the real geometry travels
      // with the connect request: seeding it here saves the first respawn and
      // the full repaint wrapped to the wrong width that came with it.
      const socket = new WebSocket(`${protocol}://${location.host}/api/term?cols=${terminal.cols}&rows=${terminal.rows}`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      socket.onopen = () => sendViewport();
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") { terminal.write(new Uint8Array(event.data)); return; }
        let message: ServerMessage;
        try { message = JSON.parse(event.data) as ServerMessage; } catch { return; }
        if (message.type === "terminal.panes") {
          const nextPaneIds = message.panes.map((pane) => pane.id).sort().join("\n");
          const changed = lastSelectedPaneId !== message.selectedPaneId || lastPaneIds !== nextPaneIds;
          lastPaneIds = nextPaneIds;
          lastSelectedPaneId = message.selectedPaneId;
          setPanes(message.panes);
          setSelectedPaneId(message.selectedPaneId);
          if (changed) { setNotice(""); setSendError(""); }
        } else if (message.type === "terminal.status") {
          setStatus(message.status);
          if (message.status === "closed") {
            closedStatusReason = true;
            setDetail(typeof message.reason === "string" ? message.reason : "");
          } else {
            closedStatusReason = false;
            setDetail("");
          }
          // A fresh observer repaints from the top-left. Clearing first drops
          // the previous observer's frame, which otherwise stays underneath and
          // reads as duplicated output.
          if (message.status === "connected") terminal.reset();
        } else if (message.type === "terminal.notice") {
          setNotice(message.message);
        }
      };
      socket.onclose = () => {
        if (!disposed && socketRef.current === socket) {
          setStatus("closed");
          if (!closedStatusReason) setDetail("");
        }
      };
      socket.onerror = () => undefined;
    };
    connectRef.current = connect;
    connect();

    const observer = new ResizeObserver(() => {
      if (!safeFit()) return;
      // The first successful fit may land after connect (a collapsed pane, or
      // fonts still loading), so publish that geometry rather than waiting for
      // another resize.
      const first = !fitted;
      fitted = true;
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      if (first) { sendViewport(); return; }
      resizeTimer.current = setTimeout(sendViewport, 250);
    });
    observer.observe(host);
    return () => {
      disposed = true;
      observer.disconnect();
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      socketRef.current?.close(); socketRef.current = null;
      terminal.dispose(); terminalRef.current = null;
    };
  }, [sendViewport]);

  const selectPane = (paneId: string): void => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setNotice("Terminal connection is not ready");
      return;
    }
    try {
      socket.send(JSON.stringify({ type: "terminal.select", paneId }));
    } catch {
      setNotice("Terminal connection is not ready");
      return;
    }
    terminalRef.current?.reset();
    setSelectedPaneId(paneId);
    setSendError("");
  };
  /** Explicit viewer action only: a dropped WebSocket never respawns by itself. */
  const reconnect = (): void => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "terminal.reconnect" }));
    else connectRef.current();
  };

  /** POST one input to the selected pane. Returns false when it was refused. */
  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    if (selectedPaneId === null) {
      setSendError("No pane is selected, so there is nowhere to send this");
      return false;
    }
    try {
      const response = await fetch("/api/term/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paneId: selectedPaneId, ...body }) });
      if (response.ok) { setSendError(""); return true; }
      const parsed: unknown = await response.json().catch(() => null);
      const reason = typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : `Could not send input (HTTP ${response.status})`;
      setSendError(reason);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Could not send input");
    }
    return false;
  };

  // Attached context is part of the message, so a card on its own is a valid
  // send: the human may want the pane to see the card and nothing else.
  const line = composePaneLine(contexts.map((context) => context.text), text);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (line === "") return;
    if (await post({ text: line })) {
      setText("");
      setContexts([]);
    }
  };

  const removeContext = (target: TerminalContext): void => {
    setContexts((current) => current.filter((context) => context !== target));
    focusComposer();
  };

  /**
   * Forward a bounded key instead of a character.
   *
   * Only fires when the line is empty, so Escape or an arrow never discards a
   * half-typed message the operator can still see.
   */
  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const key = KEY_SHORTCUTS[event.key];
    if (key === undefined || line !== "") return;
    event.preventDefault();
    void post({ key });
  };

  const banners = [status === "closed" && detail !== "" ? detail : "", notice, sendError].filter((value) => value !== "");
  const selectedPane = panes.find((pane) => pane.id === selectedPaneId);
  const live = status === "connected";

  return <section className="flex h-full min-h-0 min-w-0 flex-col bg-zinc-950 text-zinc-100">
    <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-2 py-2 sm:px-3">
      <label className="relative min-w-0 flex-1"><span className="sr-only">Pane</span><select value={selectedPaneId ?? ""} onChange={(event) => selectPane(event.target.value)} className="w-full appearance-none truncate rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-2.5 pr-8 text-sm text-zinc-100">
        {panes.length === 0 && <option value="">No panes available</option>}
        {/*
          The task id stays here, unlike on an inbox card: this is an operator
          control for picking one pane out of several, and two crew panes can
          carry the same human title.
        */}
        {panes.map((pane) => <option key={pane.id} value={pane.id}>{pane.isFirstmate ? "Firstmate — " : ""}{pane.taskTitle ?? pane.title}{pane.taskId === null ? "" : ` (${pane.taskId})`}</option>)}
      </select><ChevronDown className="pointer-events-none absolute right-2 top-2 size-4 text-zinc-400" /></label>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">
        <span aria-hidden="true" className={`size-1.5 rounded-full ${live ? "bg-emerald-400" : status === "closed" ? "bg-red-400" : "bg-amber-400"}`} />
        <span className="hidden sm:inline">{live ? "Live" : status === "resyncing" ? "Resyncing" : status === "closed" ? "Offline" : "Connecting"}</span>
      </span>
      {status === "closed" && <button type="button" onClick={reconnect} className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800">Reconnect</button>}
    </header>
    {banners.map((banner) => <div key={banner} className="flex shrink-0 items-start gap-2 border-b border-amber-900/60 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-200"><WifiOff className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 break-words">{banner}</span></div>)}
    {/*
      Clicking the mirror focuses the composer: the surface is read-only, so a
      keystroke aimed at it would otherwise land nowhere and read as dead input.
    */}
    <div
      ref={hostRef}
      onMouseUp={() => { if ((window.getSelection()?.toString() ?? "") === "") composerRef.current?.focus(); }}
      className="min-h-0 min-w-0 flex-1 overflow-hidden p-1.5 sm:p-2"
      aria-label="Live terminal mirror"
    />
    <form onSubmit={submit} className="flex shrink-0 flex-col gap-2 border-t border-zinc-800 p-2 sm:p-3">
      {contexts.length > 0 && (
        // Above the input, not inside it: the chips say WHICH cards are
        // attached, and the row below stays the human's own sentence.
        <ul role="list" aria-label="Cards attached to this message" className="flex min-w-0 flex-wrap gap-1.5">
          {contexts.map((context) => (
            <li key={context.text} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 py-0.5 pl-2 pr-0.5 text-xs text-zinc-300">
              <span className="min-w-0 truncate" title={context.label}>{context.label}</span>
              <button
                type="button"
                onClick={() => removeContext(context)}
                aria-label={`Remove "${context.label}" from this message`}
                className="relative shrink-0 rounded p-1 text-zinc-400 hover:text-zinc-100"
              >
                <X className="size-3 shrink-0" aria-hidden="true" />
                {/* A 12px glyph is not a tap target; the halo makes it 44px. */}
                <span className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,2.75rem)] -translate-x-1/2 -translate-y-1/2 pointer-fine:hidden" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <input
          ref={composerRef}
          name="pane-composer"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onComposerKeyDown}
          // Never disabled: an inbox card can attach itself here before a pane
          // has resolved, and a disabled field cannot take focus or a caret, so
          // the human would be left unable to write the instruction around it.
          placeholder={selectedPane === undefined ? "No pane selected" : contexts.length > 0 ? "Write your message…" : "Type to this pane…"}
          aria-label="Send to the selected pane"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-400 disabled:opacity-50 sm:text-sm"
        />
        <button type="button" onClick={() => void post({ key: "c-c" })} disabled={selectedPaneId === null} className="shrink-0 rounded-md border border-zinc-700 px-2 py-2 font-mono text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40" title="Interrupt the pane (Ctrl-C)">^C</button>
        <button type="button" onClick={() => void post({ key: "escape" })} disabled={selectedPaneId === null} className="hidden shrink-0 rounded-md border border-zinc-700 px-2 py-2 font-mono text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 sm:block" title="Send Escape">esc</button>
        <button type="submit" disabled={selectedPaneId === null || line === ""} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 disabled:opacity-40">
          <Send className="size-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Send</span>
          <CornerDownLeft className="size-3.5 shrink-0 opacity-60 sm:hidden" aria-hidden="true" />
        </button>
      </div>
    </form>
  </section>;
}
