/**
 * Contract tests for the Herdr wire shapes, over recorded protocol-20 records.
 * Hermetic: no Herdr server is contacted.
 */
import { describe, expect, it } from "vitest";

import {
  HERDR_MIN_PROTOCOL,
  herdrAgentSchema,
  herdrPaneSchema,
  parseHerdrEvent,
  parseTerminalRecord,
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

  it("ignores a modelled event whose payload has drifted rather than trusting it", () => {
    expect(
      parseHerdrEvent('{"event":"pane_closed","data":{"type":"pane_closed","pane_id":"w1:p3"}}'),
    ).toBeNull();
  });

  it("is pinned to the protocol helm was written against", () => {
    expect(HERDR_MIN_PROTOCOL).toBe(20);
  });
});
