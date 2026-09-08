import { describe, expect, it, vi } from "vitest";

import type { HelmConfig } from "@/lib/config";
import { parseTerminalRecord, type TerminalObservation, type TerminalRecord } from "@/lib/herdr";
import { TerminalBridge } from "@/lib/terminal-bridge";

const config: HelmConfig = { fmHome: "/fm", fmBinDir: "/fm/bin", fmStateDir: "/fm/state", helmStateDir: "/helm/state", herdrSocketPath: "/tmp/herdr.sock", herdrBin: "herdr", port: 7333, bind: "127.0.0.1" };

function observation(records: TerminalRecord[]): TerminalObservation {
  let stopped = false;
  return {
    argv: ["herdr"], close: () => { stopped = true; }, exit: Promise.resolve({ exitCode: 0, signal: null, error: null }),
    async *[Symbol.asyncIterator]() { for (const record of records) { if (!stopped) yield record; } },
  };
}

describe("TerminalBridge", () => {
  it("rejects malformed terminal frame bytes before forwarding them", () => {
    expect(() => parseTerminalRecord('{"type":"terminal.frame","seq":1,"encoding":"ansi","bytes":"not base64!","full":true,"width":80,"height":24}')).toThrow(/base64/);
  });

  it("forwards decoded frames and respawns after a sequence gap", async () => {
    const send = vi.fn();
    const observe = vi.fn()
      .mockReturnValueOnce(observation([
        { type: "terminal.frame", seq: 1, encoding: "ansi", bytes: "QQ==", full: true, width: 80, height: 24 },
        { type: "terminal.frame", seq: 3, encoding: "ansi", bytes: "Qg==", full: false, width: 80, height: 24 },
      ]))
      .mockReturnValueOnce(observation([{ type: "terminal.frame", seq: 1, encoding: "ansi", bytes: "Qw==", full: true, width: 80, height: 24 }]));
    const bridge = new TerminalBridge({ cfg: config, target: "w1:p1", viewport: { cols: 80, rows: 24 }, client: { send }, observe });
    bridge.start();
    await vi.waitUntil(() => observe.mock.calls.length === 2);
    expect(send.mock.calls.map(([value]) => Buffer.isBuffer(value) ? value.toString() : value)).toContain("A");
    expect(send.mock.calls.map(([value]) => String(value))).toEqual(expect.arrayContaining([expect.stringContaining("sequence-gap")]));
    expect(send.mock.calls.map(([value]) => Buffer.isBuffer(value) ? value.toString() : value)).toContain("C");
    bridge.close();
  });

  it("debounces resize observer replacement to the final viewport", () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockReturnValue(observation([]));
    const bridge = new TerminalBridge({ cfg: config, target: "w1:p1", viewport: { cols: 80, rows: 24 }, client: { send: () => undefined }, observe });
    try {
      bridge.start();
      bridge.resize({ cols: 100, rows: 40 });
      bridge.resize({ cols: 120, rows: 50 });
      bridge.resize({ cols: 140, rows: 60 });
      expect(observe).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(249);
      expect(observe).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(observe).toHaveBeenNthCalledWith(2, "w1:p1", { cols: 140, rows: 60 });
    } finally {
      bridge.close();
      vi.useRealTimers();
    }
  });
});
