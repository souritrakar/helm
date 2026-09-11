/**
 * Contract tests for the Herdr wire shapes, over recorded protocol-20 records.
 * Hermetic: no Herdr server is contacted.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import {
  HERDR_MIN_PROTOCOL,
  herdrAgentSchema,
  herdrDoctor,
  herdrPaneSchema,
  isShellPromptLine,
  parseHerdrEvent,
  observeTerminal,
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

  it("parses an agent record whose agent is null, which protocol 20 allows", () => {
    const agent = herdrAgentSchema.parse({ ...PANE, agent: null, state_change_seq: 4 });

    expect(agent.agent).toBeNull();
    expect(agent.pane_id).toBe("w1:p1");
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

  it("parses an output match, which also keeps its dotted wire name", () => {
    expect(parseHerdrEvent('{"event":"pane.output_matched","data":{"pane_id":"w1:p3","matched_line":"ready","read":{"pane_id":"w1:p3","workspace_id":"w1","tab_id":"t1","source":"visible","format":"plain","text":"ready","revision":2,"truncated":false}}}')).toMatchObject({ event: "pane.output_matched", data: { matched_line: "ready" } });
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
});

describe("subscribeEvents", () => {
  let socketDir: string;
  let server: Server;
  let socketPath: string;
  /** Lines the stub server writes once a subscription arrives. */
  let scripted: string[];
  /** Whether the stub server acknowledges the subscription before `scripted`. */
  let acknowledge: boolean;
  /** The subscribe request the stub server received, as sent on the wire. */
  let request: unknown;

  function config(): HelmConfig {
    return {
      fmHome: "/fixture/firstmate",
      fmBinDir: "/fixture/firstmate/bin",
      fmStateDir: "/fixture/firstmate/state",
      helmStateDir: "/fixture/helm-state",
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
    acknowledge = true;
    request = undefined;
    server = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.once("data", (chunk: string) => {
        request = JSON.parse(chunk.trim());
        if (acknowledge) {
          connection.write(`${JSON.stringify({ result: { type: "subscription_started" } })}\n`);
        }
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

  it("sends each subscription verbatim, including the pane_id protocol 20 requires", async () => {
    const stream = subscribeEvents(
      config(),
      [{ type: "pane.agent_status_changed", pane_id: "w1:p3" }],
      () => undefined,
    );

    await stream.ready;
    stream.close();
    await stream.closed.catch(() => undefined);

    expect(request).toMatchObject({
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p3" }] },
    });
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

  it("surfaces a server error frame instead of discarding it as an unmodelled event", async () => {
    scripted = [
      JSON.stringify({
        id: "helm:events:1",
        error: { code: "invalid_request", message: "missing field `pane_id`" },
      }),
    ];
    const stream = subscribeEvents(config(), [{ type: "pane.closed" }], () => undefined);

    await stream.ready;

    await expect(stream.closed).rejects.toThrow(/invalid_request: missing field `pane_id`/);
  });

  it("rejects ready with the server's reason when the subscription itself is refused", async () => {
    acknowledge = false;
    scripted = [
      JSON.stringify({
        id: "helm:events:1",
        error: { code: "invalid_request", message: "missing field `pane_id`" },
      }),
    ];
    const stream = subscribeEvents(config(), [{ type: "pane.closed" }], () => undefined);

    await expect(stream.ready).rejects.toThrow(/invalid_request: missing field `pane_id`/);
    await expect(stream.closed).rejects.toThrow(/invalid_request/);
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

describe("observeTerminal exit", () => {
  let binDir: string;

  /**
   * A stand-in `herdr` that prints `lines`, then stays alive to be killed.
   * `exec` so the surviving process owns stdout and receives the signal itself.
   */
  function stubHerdr(lines: readonly string[]): HelmConfig {
    const path = join(binDir, "herdr-stub");
    const prints = lines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`).join("\n");
    writeFileSync(path, `#!/bin/sh\n${prints}\nexec sleep 30\n`, { mode: 0o755 });
    return {
      fmHome: "/fixture/firstmate",
      fmBinDir: "/fixture/firstmate/bin",
      fmStateDir: "/fixture/firstmate/state",
      helmStateDir: "/fixture/helm-state",
      herdrSocketPath: join(binDir, "herdr.sock"),
      herdrBin: path,
      port: DEFAULT_PORT,
      bind: DEFAULT_BIND,
    };
  }

  const FRAME =
    '{"type":"terminal.frame","seq":1,"encoding":"ansi","bytes":"eA==","full":true,"width":80,"height":24}';

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "helm-observe-"));
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it("reports a clean close with no error when the caller stops the observation", async () => {
    const observation = observeTerminal(stubHerdr([FRAME]), "w1:p1", { cols: 80, rows: 24 });

    const first = await observation[Symbol.asyncIterator]().next();
    observation.close();
    const exit = await observation.exit;

    expect(first.value).toMatchObject({ type: "terminal.frame", seq: 1 });
    expect(exit.error).toBeNull();
    expect(exit.signal).toBe("SIGTERM");
  });

  it("carries the parse failure into exit when a record drifts, not a bare SIGTERM", async () => {
    const observation = observeTerminal(
      stubHerdr(['{"type":"terminal.frame","seq":"1"}']),
      "w1:p1",
      { cols: 80, rows: 24 },
    );

    const exit = await observation.exit;

    expect(exit.signal).toBe("SIGTERM");
    expect(exit.error).toMatch(/herdr terminal session observe w1:p1/);
  });
});

describe("herdrDoctor", () => {
  let binDir: string;
  let server: Server | null;

  /** A stand-in `herdr` whose `api schema --json` prints `output`. */
  function stubHerdr(output: string, exitCode = 0): HelmConfig {
    const path = join(binDir, "herdr-stub");
    writeFileSync(path, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\nexit ${exitCode}\n`, {
      mode: 0o755,
    });
    return {
      fmHome: "/fixture/firstmate",
      fmBinDir: "/fixture/firstmate/bin",
      fmStateDir: "/fixture/firstmate/state",
      helmStateDir: "/fixture/helm-state",
      herdrSocketPath: join(binDir, "herdr.sock"),
      herdrBin: path,
      port: DEFAULT_PORT,
      bind: DEFAULT_BIND,
    };
  }

  async function listen(cfg: HelmConfig, protocol = HERDR_MIN_PROTOCOL): Promise<void> {
    server = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.once("data", (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { id: string };
        connection.end(`${JSON.stringify({
          id: request.id,
          result: { type: "session_snapshot", snapshot: { protocol } },
        })}\n`);
      });
    });
    await new Promise<void>((resolve) => server!.listen(cfg.herdrSocketPath, resolve));
  }

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "helm-doctor-"));
    server = null;
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(binDir, { recursive: true, force: true });
  });

  it("reports ok when the Herdr socket acknowledges a session snapshot", async () => {
    const cfg = stubHerdr(JSON.stringify({ protocol: HERDR_MIN_PROTOCOL }));
    await listen(cfg);

    const doctor = await herdrDoctor(cfg);

    expect(doctor.problems).toEqual([]);
    expect(doctor.ok).toBe(true);
    expect(doctor.protocol).toBe(HERDR_MIN_PROTOCOL);
    expect(doctor.socketPresent).toBe(true);
    expect(doctor.socketReachable).toBe(true);
  });

  it("reports a problem naming the protocol when herdr is older than the minimum", async () => {
    const old = HERDR_MIN_PROTOCOL - 1;
    const cfg = stubHerdr(JSON.stringify({ protocol: old }));
    await listen(cfg);

    const doctor = await herdrDoctor(cfg);

    expect(doctor.ok).toBe(false);
    expect(doctor.protocol).toBe(old);
    expect(doctor.problems).toHaveLength(1);
    expect(doctor.problems[0]).toContain(String(old));
    expect(doctor.problems[0]).toContain(String(HERDR_MIN_PROTOCOL));
  });

  it("reports a problem when the schema output carries no numeric protocol", async () => {
    const cfg = stubHerdr(JSON.stringify({ protocol: "twenty" }));
    await listen(cfg);

    const doctor = await herdrDoctor(cfg);

    expect(doctor.ok).toBe(false);
    expect(doctor.protocol).toBeNull();
    expect(doctor.problems).toEqual([
      "herdr api schema --json did not report a numeric protocol",
    ]);
  });

  it("reports a problem when the socket outlives the Herdr server that owned it", async () => {
    const cfg = stubHerdr(JSON.stringify({ protocol: HERDR_MIN_PROTOCOL }));
    // SIGKILL leaves the socket inode behind, so a stat-only check calls this healthy.
    const listener = spawn(process.execPath, [
      "-e",
      'require("node:net").createServer().listen(process.argv[1], () => console.log("ready"));',
      cfg.herdrSocketPath,
    ]);
    await new Promise<void>((resolve) => listener.stdout.once("data", () => resolve()));
    listener.kill("SIGKILL");
    await new Promise<void>((resolve) => listener.once("exit", () => resolve()));

    const doctor = await herdrDoctor(cfg);

    expect(doctor.ok).toBe(false);
    expect(doctor.socketPresent).toBe(true);
    expect(doctor.socketReachable).toBe(false);
    expect(doctor.problems).toHaveLength(1);
    expect(doctor.problems[0]).toContain(cfg.herdrSocketPath);
  });

  it("rejects a non-Herdr listener at the configured socket", async () => {
    const cfg = stubHerdr(JSON.stringify({ protocol: HERDR_MIN_PROTOCOL }));
    server = createServer((connection) => {
      connection.once("data", () => connection.end('{"result":{"type":"ok"}}\n'));
    });
    await new Promise<void>((resolve) => server!.listen(cfg.herdrSocketPath, resolve));

    const doctor = await herdrDoctor(cfg);

    expect(doctor.ok).toBe(false);
    expect(doctor.socketReachable).toBe(false);
    expect(doctor.problems).toContain(
      `Herdr control socket at ${cfg.herdrSocketPath} did not complete a Herdr health check; is the Herdr server running? (session.snapshot did not return a Herdr session snapshot)`,
    );
  });

  it("reports a problem when the control socket is absent", async () => {
    const cfg = stubHerdr(JSON.stringify({ protocol: HERDR_MIN_PROTOCOL }));

    const doctor = await herdrDoctor(cfg);

    expect(doctor.ok).toBe(false);
    expect(doctor.socketPresent).toBe(false);
    expect(doctor.problems).toHaveLength(1);
    expect(doctor.problems[0]).toContain(cfg.herdrSocketPath);
  });

  it("reports every failed check rather than only the first", async () => {
    const cfg = stubHerdr("", 1);

    const doctor = await herdrDoctor(cfg);

    expect(doctor.ok).toBe(false);
    expect(doctor.protocol).toBeNull();
    expect(doctor.problems).toHaveLength(2);
  });
});

/**
 * The line that tells an exited worker's shell apart from a blocked agent.
 *
 * Both are `blocked` to Herdr and both can show the same `user@host:cwd`
 * terminal title, so this predicate is the whole discriminator behind the
 * blocked-agent card. It is biased to say NO: an unrecognised line keeps its
 * blocker, because a missing blocker is worse than a noisy one.
 */
describe("isShellPromptLine", () => {
  it.each([
    "(base) s7kar@s7kar-ThinkPad-P16v-Gen-2:~/firstmate$",
    "s7kar@host:~/firstmate$",
    "[s7kar@host work]$",
    "user@host:/var/log#",
    "~/firstmate %",
    "$",
    "%",
    "#",
    "❯",
    "➜  ~",
  ])("recognises the shell's own prompt: %j", (line) => {
    expect(isShellPromptLine(line)).toBe(true);
  });

  it.each([
    // The live codex that WAS reported as an idle shell. It is genuinely
    // blocked, and filtering it out would hide a real blocker.
    "Press enter to continue",
    "  1. Update now (runs `npm install -g @openai/codex`)",
    "Do you want to proceed? > yes",
    "Approve this plan? [y/N]",
    "# Running tests",
    "> continue",
    "error: cannot read /tmp/x",
    "",
    "   ",
  ])("leaves everything else alone: %j", (line) => {
    expect(isShellPromptLine(line)).toBe(false);
  });

  it("keeps a prompt with a half-typed command, which is not an idle pane", () => {
    expect(isShellPromptLine("s7kar@host:~/firstmate$ git stat")).toBe(false);
  });
});
