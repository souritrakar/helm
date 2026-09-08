/** Per-WebSocket read-only bridge from a Herdr observer to a terminal client. */
import type { HelmConfig } from "./config";
import { observeTerminal, type TerminalObservation, type TerminalViewport } from "./herdr";

export interface TerminalClient {
  send(data: string | Uint8Array): void;
}

export interface TerminalBridgeOptions {
  readonly cfg: HelmConfig;
  readonly target: string;
  readonly viewport: TerminalViewport;
  readonly client: TerminalClient;
  readonly observe?: (target: string, viewport: TerminalViewport) => TerminalObservation;
}

/**
 * Owns exactly one observer child for one connected viewer.
 *
 * Herdr observers have immutable viewport dimensions, so resize and a lost
 * sequence both replace the observer. A fresh observer starts with a full
 * repaint frame, which is the only safe recovery from dropped ANSI bytes.
 */
export class TerminalBridge {
  #target: string;
  #viewport: TerminalViewport;
  #observation: TerminalObservation | null = null;
  #generation = 0;
  #lastSeq: number | null = null;
  #closed = false;
  #resizeDebounce: NodeJS.Timeout | null = null;
  readonly #client: TerminalClient;
  readonly #observe: (target: string, viewport: TerminalViewport) => TerminalObservation;

  constructor(options: TerminalBridgeOptions) {
    this.#target = options.target;
    this.#viewport = options.viewport;
    this.#client = options.client;
    this.#observe = options.observe ?? ((target, viewport) => observeTerminal(options.cfg, target, viewport));
  }

  start(): void {
    if (!this.#closed) this.#spawn("connected");
  }

  resize(viewport: TerminalViewport): void {
    if (this.#closed || sameViewport(this.#viewport, viewport)) return;
    this.#viewport = viewport;
    if (this.#resizeDebounce !== null) clearTimeout(this.#resizeDebounce);
    this.#resizeDebounce = setTimeout(() => {
      this.#resizeDebounce = null;
      this.#respawn("resized");
    }, 250);
  }

  select(target: string): void {
    if (this.#closed || target === this.#target) return;
    this.#target = target;
    this.#respawn("pane-switched");
  }

  reconnect(): void {
    if (!this.#closed) this.#respawn("reconnecting");
  }

  close(): void {
    this.#closed = true;
    this.#clearResizeDebounce();
    this.#generation += 1;
    this.#observation?.close();
    this.#observation = null;
  }

  #respawn(reason: string): void {
    this.#clearResizeDebounce();
    this.#observation?.close();
    this.#observation = null;
    this.#spawn(reason);
  }

  #spawn(reason: string): void {
    const generation = ++this.#generation;
    this.#lastSeq = null;
    this.#client.send(JSON.stringify({ type: "terminal.status", status: "connecting", reason, target: this.#target }));
    const observation = this.#observe(this.#target, this.#viewport);
    this.#observation = observation;
    void this.#consume(observation, generation);
  }

  async #consume(observation: TerminalObservation, generation: number): Promise<void> {
    try {
      for await (const record of observation) {
        if (this.#closed || generation !== this.#generation) return;
        if (record.type === "terminal.closed") {
          this.#ended("terminal closed");
          return;
        }
        if (this.#lastSeq !== null && record.seq !== this.#lastSeq + 1) {
          this.#client.send(JSON.stringify({ type: "terminal.status", status: "resyncing", reason: "sequence-gap" }));
          this.#respawn("sequence-gap");
          return;
        }
        this.#lastSeq = record.seq;
        if (record.full) this.#client.send(JSON.stringify({ type: "terminal.status", status: "connected", target: this.#target }));
        this.#client.send(Buffer.from(record.bytes, "base64"));
      }
      const exit = await observation.exit;
      if (!this.#closed && generation === this.#generation) {
        this.#ended(exit.error ?? "observer exited");
      }
    } catch (cause) {
      if (!this.#closed && generation === this.#generation) {
        this.#ended(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }

  #ended(reason: string): void {
    this.#client.send(JSON.stringify({ type: "terminal.status", status: "closed", reason, reconnect: true }));
  }

  #clearResizeDebounce(): void {
    if (this.#resizeDebounce !== null) clearTimeout(this.#resizeDebounce);
    this.#resizeDebounce = null;
  }
}

function sameViewport(a: TerminalViewport, b: TerminalViewport): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}
