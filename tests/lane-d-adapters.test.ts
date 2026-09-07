/** Observable contracts for the Lane D read-only producers. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHerdrAdapters } from "@/lib/adapters/herdr-events";
import { registerProductionAdapters } from "@/lib/adapters";
import { createAdapterRegistry } from "@/lib/adapters/registry";
import { createStateAdapters } from "@/lib/adapters/state";
import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import type { InboxItem } from "@/lib/types";

let root = "";
let config: HelmConfig;
let emitted: InboxItem[][];
let disposers: Disposable[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "helm-lane-d-"));
  const fmHome = join(root, "firstmate");
  mkdirSync(join(fmHome, "bin"), { recursive: true });
  mkdirSync(join(fmHome, "state"), { recursive: true });
  emitted = [];
  disposers = [];
  config = { fmHome, fmBinDir: join(fmHome, "bin"), fmStateDir: join(fmHome, "state"), helmStateDir: join(root, "helm-state"), herdrSocketPath: join(root, "herdr.sock"), herdrBin: "herdr", port: DEFAULT_PORT, bind: DEFAULT_BIND };
});
afterEach(() => { for (const disposer of disposers) disposer[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); });

async function start(adapter: ReturnType<typeof createStateAdapters>[number] | ReturnType<typeof createHerdrAdapters>[number]): Promise<void> {
  disposers.push(await adapter.start({ emit: (items) => emitted.push(items), retract: () => undefined }));
}
function stateAdapter(id: string) { return createStateAdapters(config).find((adapter) => adapter.id === id)!; }

describe("state record adapters", () => {
  it("registers all eight production sources exactly once", () => {
    const registry = createAdapterRegistry();
    registerProductionAdapters(registry, config);
    expect(registry.list().map((adapter) => adapter.id)).toEqual([
      "status-decisions", "captain-holds", "bearings", "captain-notes", "steering-backlog", "procevent", "agent-state", "output-match",
    ]);
  });

  it("renders a captain note as inert read-only detail without acknowledging it", async () => {
    const inbox = join(config.fmStateDir, "inbox"); mkdirSync(inbox);
    const note = join(inbox, "n-1.note"); writeFileSync(note, "id=n-1\nat=2026-09-07T00:00:00Z\n--\n<em>untrusted</em> ; $(nope)");
    await start(stateAdapter("captain-notes"));
    expect(emitted.at(-1)).toMatchObject([{ id: "captain-notes:n-1", detail: expect.stringContaining("$(nope)"), respond: { channel: "none" }, evidence: [{ path: note }] }]);
    expect(() => stat(note)).not.toThrow();
  });

  it("surfaces unacknowledged steering records and excludes handled records", async () => {
    const pending = join(config.fmStateDir, "worker.inbox"); mkdirSync(join(pending, "handled"), { recursive: true });
    writeFileSync(join(pending, "001.msg"), "steer this"); writeFileSync(join(pending, "handled", "002.msg"), "old");
    await start(stateAdapter("steering-backlog"));
    expect(emitted.at(-1)).toHaveLength(1);
    expect(emitted.at(-1)?.[0]).toMatchObject({ source: "steering-backlog", respond: { channel: "none" }, detail: "steer this" });
  });

  it("classifies an unhandled process result but never invokes handled or mutating commands", async () => {
    const inbox = join(config.fmStateDir, "procevent-inbox"); mkdirSync(inbox);
    const result = join(inbox, "when-deploy.1.result"); writeFileSync(result, "status: fired\noutput:\n<unsafe>");
    const script = join(config.fmBinDir, "fm-procevent.sh");
    writeFileSync(script, "#!/bin/sh\n[ \"$1\" = classify ] && { printf 'fired\\n'; exit 0; }\nexit 64\n"); chmodSync(script, 0o755);
    await start(stateAdapter("procevent"));
    expect(emitted.at(-1)).toMatchObject([{ id: "procevent:when-deploy.1.result", kind: "review", title: "Process event: fired", respond: { channel: "none" } }]);
    expect(() => stat(`${result.slice(0, -7)}.handled`)).toThrow();
  });

  it("relays sensitive bearings gates to the configured firstmate pane", async () => {
    const script = join(config.fmBinDir, "fm-bearings-snapshot.sh");
    writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' '{\"schema\":\"fm-bearings.v1\",\"home\":\"fixture\",\"generated\":\"2026-09-07T00:00:00Z\",\"in_flight\":[],\"decisions_open\":[],\"gates\":[{\"id\":\"deploy\",\"title\":\"Merge deploy\",\"blocked_by\":\"main\",\"reason\":\"merge approval required\",\"owner\":\"captain\"}],\"landed\":[],\"reports\":[],\"omitted\":[]}'\n");
    chmodSync(script, 0o755);
    config = { ...config, captainPane: "w1:captain" };
    await start(stateAdapter("bearings"));
    expect(emitted.at(-1)).toMatchObject([{ kind: "merge", respond: { channel: "relay", target: "w1:captain" } }]);
  });
});

function stat(path: string): void { statSync(path); }

describe("output-match adapter", () => {
  let server: Server;
  let connection: Socket | undefined;
  afterEach(async () => { if (server.listening) { connection?.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } });

  it("subscribes with dotted output event names and raises a custom relay card", async () => {
    let request: unknown;
    server = createServer((socket) => { connection = socket; socket.once("data", (raw) => {
      request = JSON.parse(raw.toString());
      socket.write('{"result":{"type":"subscription_started"}}\n');
      socket.write('{"event":"pane.output_matched","data":{"pane_id":"w1:p2","matched_line":"deploy failed","read":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"t1","source":"visible","format":"plain","text":"deploy failed","revision":4,"truncated":false}}}\n');
    }); });
    await new Promise<void>((resolve) => server.listen(config.herdrSocketPath, resolve));
    config = { ...config, outputMatches: [{ id: "deploy-failure", paneId: "w1:p2", source: "visible", match: { type: "substring", value: "failed" }, title: "Deploy failed" }] };
    const adapter = createHerdrAdapters(config).find((candidate) => candidate.id === "output-match")!;
    disposers.push(await adapter.start({ emit: (items) => emitted.push(items), retract: () => undefined }));
    await vi.waitUntil(() => emitted.length > 0);
    expect(request).toMatchObject({ method: "events.subscribe", params: { subscriptions: [{ type: "pane.output_matched", pane_id: "w1:p2", source: "visible", match: { type: "substring", value: "failed" } }] } });
    expect(emitted.at(-1)).toMatchObject([{ kind: "custom", title: "Deploy failed", respond: { channel: "relay", target: "w1:p2" } }]);
  });

  it("uses the event source and emits every overlapping configured pattern", async () => {
    server = createServer((socket) => { connection = socket; socket.once("data", () => {
      socket.write('{"result":{"type":"subscription_started"}}\n');
      socket.write('{"event":"pane.output_matched","data":{"pane_id":"w1:p2","matched_line":"deploy failed","read":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"t1","source":"visible","format":"plain","text":"deploy failed","revision":4,"truncated":false}}}\n');
    }); });
    await new Promise<void>((resolve) => server.listen(config.herdrSocketPath, resolve));
    config = { ...config, outputMatches: [
      { id: "recent", paneId: "w1:p2", source: "recent", match: { type: "substring", value: "failed" }, title: "Recent failure" },
      { id: "visible-a", paneId: "w1:p2", source: "visible", match: { type: "substring", value: "failed" }, title: "Visible failure" },
      { id: "visible-b", paneId: "w1:p2", source: "visible", match: { type: "regex", value: "deploy" }, title: "Deploy output" },
    ] };
    await start(createHerdrAdapters(config).find((candidate) => candidate.id === "output-match")!);
    await vi.waitUntil(() => emitted.at(-1)?.length === 2);
    expect(emitted.at(-1)?.map((entry) => entry.id)).toEqual([
      "output-match:visible-a:1:w1:p2:4", "output-match:visible-b:2:w1:p2:4",
    ]);
  });

  it("retains matches from separate declarations with the same id", async () => {
    server = createServer((socket) => { connection = socket; socket.once("data", () => {
      socket.write('{"result":{"type":"subscription_started"}}\n');
      socket.write('{"event":"pane.output_matched","data":{"pane_id":"w1:p2","matched_line":"deploy failed","read":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"t1","source":"visible","format":"plain","text":"deploy failed","revision":4,"truncated":false}}}\n');
    }); });
    await new Promise<void>((resolve) => server.listen(config.herdrSocketPath, resolve));
    config = { ...config, outputMatches: [
      { id: "failure", paneId: "w1:p2", source: "visible", match: { type: "substring", value: "failed" }, title: "Failure" },
      { id: "failure", paneId: "w1:p2", source: "visible", match: { type: "regex", value: "deploy" }, title: "Deploy" },
    ] };
    await start(createHerdrAdapters(config).find((candidate) => candidate.id === "output-match")!);
    await vi.waitUntil(() => emitted.at(-1)?.length === 2);
    expect(emitted.at(-1)?.map((entry) => entry.id)).toEqual([
      "output-match:failure:0:w1:p2:4", "output-match:failure:1:w1:p2:4",
    ]);
  });
});

describe("agent-state adapter", () => {
  let server: Server;
  const connections = new Set<Socket>();
  const requests: unknown[] = [];
  afterEach(async () => {
    for (const connection of connections) connection.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("resubscribes for an agent pane created after startup", async () => {
    const herdr = join(root, "herdr");
    const agentState = join(root, "agent-state");
    writeFileSync(agentState, "empty");
    writeFileSync(herdr, `#!/bin/sh\ncase \"$(cat ${agentState})\" in\n  working) printf '%s\\n' '{\"id\":\"1\",\"result\":{\"type\":\"agent_list\",\"agents\":[{\"pane_id\":\"w1:p9\",\"workspace_id\":\"w1\",\"tab_id\":\"t1\",\"terminal_id\":\"term-9\",\"agent_status\":\"working\",\"focused\":false}]}}' ;;\n  blocked) printf '%s\\n' '{\"id\":\"1\",\"result\":{\"type\":\"agent_list\",\"agents\":[{\"pane_id\":\"w1:p9\",\"workspace_id\":\"w1\",\"tab_id\":\"t1\",\"terminal_id\":\"term-9\",\"agent_status\":\"blocked\",\"focused\":false}]}}' ;;\n  *) printf '%s\\n' '{\"id\":\"1\",\"result\":{\"type\":\"agent_list\",\"agents\":[]}}' ;;\nesac\n`);
    chmodSync(herdr, 0o755);
    config = { ...config, herdrBin: herdr };
    server = createServer((socket) => {
      connections.add(socket);
      socket.once("data", (raw) => {
        requests.push(JSON.parse(raw.toString()));
        socket.write('{"result":{"type":"subscription_started"}}\n');
        if (requests.length === 1) {
          writeFileSync(agentState, "working");
          socket.write('{"event":"pane_created","data":{"type":"pane_created","pane":{"pane_id":"w1:p9","terminal_id":"term-9","workspace_id":"w1","tab_id":"t1","focused":false,"agent_status":"working","revision":1}}}\n');
        } else {
          writeFileSync(agentState, "blocked");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(config.herdrSocketPath, resolve));
    await start(createHerdrAdapters(config).find((candidate) => candidate.id === "agent-state")!);
    await vi.waitUntil(() => requests.length === 2);
    expect(requests[1]).toMatchObject({ method: "events.subscribe", params: { subscriptions: expect.arrayContaining([
      { type: "pane.agent_status_changed", pane_id: "w1:p9" },
    ]) } });
    await vi.waitUntil(() => emitted.at(-1)?.some((entry) => entry.id === "agent-state:w1:p9"));
  });
});
