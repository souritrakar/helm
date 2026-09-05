/**
 * Contract tests for the Herdr wire shapes, over recorded protocol-20 records.
 * Hermetic: no Herdr server is contacted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import {
  HERDR_MIN_PROTOCOL,
  herdrAgentSchema,
  herdrPaneSchema,
  parseHerdrEvent,
  parseTerminalRecord,
  subscribeEvents,
  type HerdrEvent,
} from "@/lib/herdr";

const AGENT_SESSION = {
  agent: "claude",
  kind: "id",
  source: "herdr:claude",
  value: "7c37937d-7c6d-43ed-ba30-0e2e21ab07c7",
};

const PANE = {
  agent: "claude",
  agent_session: AGENT_SESSION,
  agent_status: "working",
  cwd: "/fixture/firstmate",
  focused: true,
  foreground_cwd: "/fixture/firstmate",
  pane_id: "w1:p1",
  revision: 2,
  scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 43 },
  tab_id: "w1:t1",
  terminal_id: "term_65aab999e14301",
  terminal_title: "⠐ firstmate",
  terminal_title_stripped: "firstmate",
  workspace_id: "w1",
};

describe("terminal observer records", () => {
  it("parses a full repaint frame", () => {
    const record = parseTerminalRecord(
      '{"type":"terminal.frame","seq":1,"encoding":"ansi","bytes":"G1s/MjAyNmg=","full":true,"width":100,"height":30}',
    );

    expect(record).toEqual({
      type: "terminal.frame",
      seq: 1,
      encoding: "ansi",
      bytes: "G1s/MjAyNmg=",
      full: true,
      width: 100,
      height: 30,
    });
  });

  it("parses the stream-closed record", () => {
    expect(parseTerminalRecord('{"type":"terminal.closed"}')).toEqual({ type: "terminal.closed" });
  });

  it("keeps the observer's requested viewport, not the pane's real geometry", () => {
    const record = parseTerminalRecord(
      '{"type":"terminal.frame","seq":2,"encoding":"ansi","bytes":"eA==","full":false,"width":100,"height":30}',
    );

    expect(record).toMatchObject({ width: 100, height: 30, full: false });
  });

  it.each([
    ["a record type helm does not model", '{"type":"terminal.input","text":"hi"}'],
    [
      "an encoding other than ansi",
      '{"type":"terminal.frame","seq":1,"encoding":"utf8","bytes":"eA==","full":true,"width":80,"height":24}',
    ],
    [
      "a non-numeric seq",
      '{"type":"terminal.frame","seq":"1","encoding":"ansi","bytes":"eA==","full":true,"width":80,"height":24}',
    ],
    ["output that is not JSON", "herdr: no such pane w9:p9"],
  ])("rejects %s", (_case, line) => {
    expect(() => parseTerminalRecord(line)).toThrow();
  });
});

describe("discovery shapes", () => {
  it("parses a pane record", () => {
    expect(herdrPaneSchema.parse(PANE).pane_id).toBe("w1:p1");
  });

  it("parses a pane record carrying only the protocol's required fields", () => {
    const minimal = {
      pane_id: "w1:p2",
      terminal_id: "term_x",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      agent_status: "idle",
      revision: 0,
    };

    expect(herdrPaneSchema.parse(minimal).agent_status).toBe("idle");
  });

  it("parses an agent record", () => {
    const agent = herdrAgentSchema.parse({ ...PANE, state_change_seq: 23 });

    expect(agent.agent).toBe("claude");
    expect(agent.agent_status).toBe("working");
  });

  it("rejects an agent status outside the protocol enum", () => {
    expect(() => herdrAgentSchema.parse({ ...PANE, agent_status: "busy" })).toThrow();
  });
});

describe("events.subscribe stream", () => {
  it("parses a status change, which keeps its dotted wire name", () => {
    const event = parseHerdrEvent(
      '{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p3","workspace_id":"w1","agent_status":"blocked","agent":"codex"}}',
    );

    expect(event).toEqual({
      event: "pane.agent_status_changed",
      data: { pane_id: "w1:p3", workspace_id: "w1", agent_status: "blocked", agent: "codex" },
    });
  });

  it("parses pane creation, which arrives under the underscored broadcast name", () => {
    const event = parseHerdrEvent(
      JSON.stringify({ event: "pane_created", data: { type: "pane_created", pane: PANE } }),
    );

    expect(event?.event).toBe("pane_created");
  });

  it("parses pane closure", () => {
    const event = parseHerdrEvent(
      '{"event":"pane_closed","data":{"type":"pane_closed","pane_id":"w1:p3","workspace_id":"w1"}}',
    );

    expect(event).toEqual({
      event: "pane_closed",
      data: { type: "pane_closed", pane_id: "w1:p3", workspace_id: "w1" },
    });
  });

  it("ignores an event kind helm does not model, so a Herdr upgrade cannot break the stream", () => {
    expect(
      parseHerdrEvent('{"event":"layout_updated","data":{"type":"layout_updated"}}'),
    ).toBeNull();
  });

  it("throws on a modelled event whose payload has drifted, rather than going quiet", () => {
    expect(() =>
      parseHerdrEvent('{"event":"pane_closed","data":{"type":"pane_closed","pane_id":"w1:p3"}}'),
    ).toThrow(/pane_closed/);
  });

  it("is pinned to the protocol helm was written against", () => {
    expect(HERDR_MIN_PROTOCOL).toBe(20);
  });
});

describe("subscribeEvents", () => {
  let socketDir: string;
  let server: Server;
  let socketPath: string;
  /** Lines the stub server writes once a subscription arrives. */
  let scripted: string[];

  function config(): HelmConfig {
    return {
      fmHome: "/fixture/firstmate",
      fmBinDir: "/fixture/firstmate/bin",
      fmStateDir: "/fixture/firstmate/state",
      herdrSocketPath: socketPath,
      herdrBin: "herdr",
      port: DEFAULT_PORT,
      bind: DEFAULT_BIND,
    };
  }

  beforeEach(async () => {
    socketDir = mkdtempSync(join(tmpdir(), "helm-herdr-"));
    socketPath = join(socketDir, "herdr.sock");
    scripted = [];
    server = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.once("data", () => {
        connection.write(`${JSON.stringify({ result: { type: "subscription_started" } })}\n`);
        for (const line of scripted) connection.write(`${line}\n`);
      });
      connection.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(socketDir, { recursive: true, force: true });
  });

  it("delivers a modelled event", async () => {
    scripted = [
      JSON.stringify({
        event: "pane_closed",
        data: { type: "pane_closed", pane_id: "w1:p3", workspace_id: "w1" },
      }),
    ];
    const received: HerdrEvent[] = [];
    const stream = subscribeEvents(config(), [{ type: "pane.closed" }], (event) => {
      received.push(event);
    });

    await stream.ready;
    await vi.waitUntil(() => received.length > 0);
    stream.close();
    await stream.closed.catch(() => undefined);

    expect(received[0]?.event).toBe("pane_closed");
  });

  it("keeps the stream alive across an event kind helm does not model", async () => {
    scripted = [
      JSON.stringify({ event: "layout_updated", data: { type: "layout_updated" } }),
      JSON.stringify({
        event: "pane_closed",
        data: { type: "pane_closed", pane_id: "w1:p3", workspace_id: "w1" },
      }),
    ];
    const received: HerdrEvent[] = [];
    const stream = subscribeEvents(config(), [{ type: "pane.closed" }], (event) => {
      received.push(event);
    });

    await stream.ready;
    await vi.waitUntil(() => received.length > 0);
    stream.close();
    await stream.closed.catch(() => undefined);

    expect(received.map((event) => event.event)).toEqual(["pane_closed"]);
  });

  it("tears the stream down and reports a drifted payload on a modelled kind", async () => {
    scripted = [
      JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "w1:p3" } }),
    ];
    const received: HerdrEvent[] = [];
    const stream = subscribeEvents(config(), [{ type: "pane.closed" }], (event) => {
      received.push(event);
    });

    await stream.ready;

    await expect(stream.closed).rejects.toThrow(/pane_closed/);
    expect(received).toEqual([]);
  });
});
