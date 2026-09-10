/** Observable contracts for the Lane D read-only producers. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHerdrAdapters } from "@/lib/adapters/herdr-events";
import { registerProductionAdapters } from "@/lib/adapters";
import { createAdapterRegistry } from "@/lib/adapters/registry";
import { createStateAdapters, type StateAdapterDeps } from "@/lib/adapters/state";
import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { createInboxStore } from "@/lib/inbox-store";
import type { InboxItem } from "@/lib/types";

/** The firstmate pane discovery would resolve, so relay cards are answerable. */
const RELAY_PANE = "w1:p1";

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
function stateAdapter(id: string) { return createStateAdapters(config, { relayTarget: () => RELAY_PANE }).find((adapter) => adapter.id === id)!; }
function herdrAdapter(id: string, deps: StateAdapterDeps = { relayTarget: () => RELAY_PANE }) { return createHerdrAdapters(config, deps).find((adapter) => adapter.id === id)!; }

describe("state record adapters", () => {
  it("registers all nine production sources exactly once", () => {
    const registry = createAdapterRegistry();
    registerProductionAdapters(registry, config, { relayTarget: () => RELAY_PANE });
    expect(registry.list().map((adapter) => adapter.id)).toEqual([
      "status-decisions", "captain-holds", "bearings", "captain-notes", "steering-backlog", "procevent", "answers", "agent-state", "output-match",
    ]);
  });

  it("renders a captain note as inert read-only detail without acknowledging it", async () => {
    const inbox = join(config.fmStateDir, "inbox"); mkdirSync(inbox);
    const note = join(inbox, "n-1.note"); writeFileSync(note, "id=n-1\nat=2026-09-07T00:00:00Z\n--\n<em>untrusted</em> ; $(nope)");
    await start(stateAdapter("captain-notes"));
    expect(emitted.at(-1)).toMatchObject([{ id: "captain-notes:n-1", detail: expect.stringContaining("$(nope)"), respond: { channel: "relay", target: RELAY_PANE }, evidence: [{ path: note }] }]);
    expect(() => stat(note)).not.toThrow();
  });

  it("surfaces unacknowledged steering records and excludes handled records", async () => {
    const pending = join(config.fmStateDir, "worker.inbox"); mkdirSync(join(pending, "handled"), { recursive: true });
    writeFileSync(join(pending, "001.msg"), "steer this"); writeFileSync(join(pending, "handled", "002.msg"), "old");
    await start(stateAdapter("steering-backlog"));
    expect(emitted.at(-1)).toHaveLength(1);
    expect(emitted.at(-1)?.[0]).toMatchObject({ source: "steering-backlog", respond: { channel: "none" }, detail: "steer this" });
  });

  it("turns the firstmate decision fold into a keyed status-decision card", async () => {
    const library = join(config.fmBinDir, "fm-classify-lib.sh");
    writeFileSync(library, "scan_open_decisions() { printf 'task-7\\tapprove\\tblocked\\tNeeds a human decision\\n'; }\n");
    await start(stateAdapter("status-decisions"));
    expect(emitted.at(-1)).toMatchObject([{
      id: "status-decisions:task-7:approve", kind: "status-decision", urgency: "blocking", taskId: "task-7",
      title: "Blocked: task-7", detail: "Needs a human decision", allowFreeform: true,
      respond: { channel: "resolve-key", target: "task-7", key: "approve" },
    }]);
  });

  it("turns captain-actionable fleet backlog records into relay cards", async () => {
    const script = join(config.fmBinDir, "fm-fleet-snapshot.sh");
    writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' '{\"schema\":\"fm-fleet-snapshot.v1\",\"generated\":\"2026-09-07T00:00:00Z\",\"fm_home\":\"fixture\",\"roots\":{\"fm_root\":\"/fixture\",\"state\":\"/fixture/state\",\"data\":\"/fixture/data\",\"config\":\"/fixture/config\",\"projects\":\"/fixture/projects\"},\"backlog\":{\"path\":\"/fixture/backlog\",\"present\":true,\"records\":[{\"order\":1,\"state\":\"held\",\"raw\":\"inert\",\"structured\":true,\"id\":\"held-1\",\"title\":\"Approve release\",\"repo\":null,\"kind\":null,\"hold_kind\":null,\"hold_reason\":\"Awaiting captain\",\"hold_until\":null,\"blocked_by_ids\":[],\"unresolved_blocker_ids\":[],\"current_role\":null,\"captain_actionable\":true,\"deferred_marker\":false,\"pr_url\":null}]},\"tasks\":[],\"main_inventory\":{\"valid\":true,\"reason\":null,\"orphan_in_flight\":[],\"unstructured_current_count\":0}}'\n");
    chmodSync(script, 0o755);
    await start(stateAdapter("captain-holds"));
    expect(emitted.at(-1)).toMatchObject([{
      id: "captain-holds:held-1", kind: "captain-held", urgency: "blocking", taskId: "held-1",
      title: "Approve release", detail: "Awaiting captain", respond: { channel: "relay", target: RELAY_PANE },
      options: [{ value: "approve" }, { value: "deny" }], allowFreeform: true,
    }]);
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

  it("relays sensitive bearings gates to the resolved firstmate pane as an approval", async () => {
    const script = join(config.fmBinDir, "fm-bearings-snapshot.sh");
    writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' '{\"schema\":\"fm-bearings.v1\",\"home\":\"fixture\",\"generated\":\"2026-09-07T00:00:00Z\",\"in_flight\":[],\"decisions_open\":[],\"gates\":[{\"id\":\"deploy\",\"title\":\"Merge deploy\",\"blocked_by\":\"main\",\"reason\":\"merge approval required\",\"owner\":\"captain\"}],\"landed\":[],\"reports\":[],\"omitted\":[]}'\n");
    chmodSync(script, 0o755);
    await start(stateAdapter("bearings"));
    expect(emitted.at(-1)).toMatchObject([{
      kind: "merge", respond: { channel: "relay", target: RELAY_PANE },
      options: [{ value: "approve" }, { value: "deny" }],
    }]);
  });

  it("leaves a relay card unanswerable when no firstmate pane is reachable", async () => {
    const script = join(config.fmBinDir, "fm-bearings-snapshot.sh");
    writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' '{\"schema\":\"fm-bearings.v1\",\"home\":\"fixture\",\"generated\":\"2026-09-07T00:00:00Z\",\"in_flight\":[],\"decisions_open\":[],\"gates\":[{\"id\":\"deploy\",\"title\":\"Merge deploy\",\"blocked_by\":\"main\",\"reason\":\"merge approval required\",\"owner\":\"captain\"}],\"landed\":[],\"reports\":[],\"omitted\":[]}'\n");
    chmodSync(script, 0o755);
    const adapter = createStateAdapters(config, { relayTarget: () => undefined }).find((entry) => entry.id === "bearings")!;
    await start(adapter);
    // Better an honest read-only card than a control whose answer goes nowhere.
    expect(emitted.at(-1)).toMatchObject([{ kind: "merge", respond: { channel: "none" } }]);
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
    const adapter = herdrAdapter("output-match");
    disposers.push(await adapter.start({ emit: (items) => emitted.push(items), retract: () => undefined }));
    await vi.waitUntil(() => emitted.length > 0);
    expect(request).toMatchObject({ method: "events.subscribe", params: { subscriptions: [{ type: "pane.output_matched", pane_id: "w1:p2", source: "visible", match: { type: "substring", value: "failed" } }] } });
    expect(emitted.at(-1)).toMatchObject([{ kind: "custom", title: "Deploy failed", respond: { channel: "relay", target: RELAY_PANE } }]);
  });

  it("refreshes an existing output-match card when relay discovery changes", async () => {
    let relayTarget: string | undefined;
    let notifyRelayTargetChanged: (() => void) | undefined;
    const store = createInboxStore(config.helmStateDir);
    const updates: InboxItem[] = [];
    store.subscribe((event) => { if (event.type === "item.upsert") updates.push(event.data as InboxItem); });
    server = createServer((socket) => { connection = socket; socket.once("data", () => {
      socket.write('{"result":{"type":"subscription_started"}}\n');
      socket.write('{"event":"pane.output_matched","data":{"pane_id":"w1:p2","matched_line":"deploy failed","read":{"pane_id":"w1:p2","workspace_id":"w1","tab_id":"t1","source":"visible","format":"plain","text":"deploy failed","revision":4,"truncated":false}}}\n');
    }); });
    await new Promise<void>((resolve) => server.listen(config.herdrSocketPath, resolve));
    config = { ...config, outputMatches: [{ id: "deploy-failure", paneId: "w1:p2", source: "visible", match: { type: "substring", value: "failed" } }] };
    const adapter = herdrAdapter("output-match", {
      relayTarget: () => relayTarget,
      onRelayTargetChanged: (listener) => { notifyRelayTargetChanged = listener; return () => { notifyRelayTargetChanged = undefined; }; },
    });
    disposers.push(await adapter.start({ emit: (items) => store.reconcile("output-match", items), retract: () => undefined }));
    await vi.waitUntil(() => store.listOpen().length === 1);
    const initial = store.listOpen()[0]!;
    expect(initial.respond).toEqual({ channel: "none" });
    relayTarget = RELAY_PANE;
    notifyRelayTargetChanged?.();
    const refreshed = store.listOpen()[0]!;
    expect(refreshed).toMatchObject({ id: initial.id, respond: { channel: "relay", target: RELAY_PANE } });
    const updateCount = updates.length;
    notifyRelayTargetChanged?.();
    expect(updates).toHaveLength(updateCount);
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
    await start(herdrAdapter("output-match"));
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
    await start(herdrAdapter("output-match"));
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
    await start(herdrAdapter("agent-state"));
    await vi.waitUntil(() => requests.length === 2);
    expect(requests[1]).toMatchObject({ method: "events.subscribe", params: { subscriptions: expect.arrayContaining([
      { type: "pane.agent_status_changed", pane_id: "w1:p9" },
    ]) } });
    await vi.waitUntil(() => emitted.at(-1)?.some((entry) => entry.id === "agent-state:w1:p9"));
    expect(emitted.at(-1)).toMatchObject([{ id: "agent-state:w1:p9", respond: { channel: "relay", target: RELAY_PANE } }]);
  });

  it("reconciles a blocker that appears before the first subscription is ready", async () => {
    const herdr = join(root, "herdr-initial");
    const agentState = join(root, "initial-agent-state");
    writeFileSync(agentState, "working");
    writeFileSync(herdr, `#!/bin/sh\ncase \"$(cat ${agentState})\" in\n  blocked) printf '%s\\n' '{\"id\":\"1\",\"result\":{\"type\":\"agent_list\",\"agents\":[{\"pane_id\":\"w1:p1\",\"workspace_id\":\"w1\",\"tab_id\":\"t1\",\"terminal_id\":\"term-1\",\"agent_status\":\"blocked\",\"focused\":false}]}}' ;;\n  empty) printf '%s\\n' '{\"id\":\"1\",\"result\":{\"type\":\"agent_list\",\"agents\":[]}}' ;;\n  *) printf '%s\\n' '{\"id\":\"1\",\"result\":{\"type\":\"agent_list\",\"agents\":[{\"pane_id\":\"w1:p1\",\"workspace_id\":\"w1\",\"tab_id\":\"t1\",\"terminal_id\":\"term-1\",\"agent_status\":\"working\",\"focused\":false}]}}' ;;\nesac\n`);
    chmodSync(herdr, 0o755);
    config = { ...config, herdrBin: herdr };
    server = createServer((socket) => {
      connections.add(socket);
      socket.once("data", () => {
        writeFileSync(agentState, "blocked");
        socket.write('{"result":{"type":"subscription_started"}}\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(config.herdrSocketPath, resolve));
    await start(herdrAdapter("agent-state", { relayTarget: () => undefined }));
    expect(emitted.at(-1)).toMatchObject([{ id: "agent-state:w1:p1", kind: "blocker", respond: { channel: "none" } }]);
  });

  it("prunes a pane absent from the post-ready agent snapshot", async () => {
    const herdr = join(root, "herdr-prune");
    const agentState = join(root, "prune-agent-state");
    writeFileSync(agentState, "blocked");
    writeFileSync(herdr, `#!/bin/sh\nif [ \"$(cat ${agentState})\" = empty ]; then\n  printf '%s\\n' '{\"id\":\"1\",\"result\":{\"type\":\"agent_list\",\"agents\":[]}}'\nelse\n  printf '%s\\n' '{\"id\":\"1\",\"result\":{\"type\":\"agent_list\",\"agents\":[{\"pane_id\":\"w1:p1\",\"workspace_id\":\"w1\",\"tab_id\":\"t1\",\"terminal_id\":\"term-1\",\"agent_status\":\"blocked\",\"focused\":false}]}}'\nfi\n`);
    chmodSync(herdr, 0o755);
    config = { ...config, herdrBin: herdr };
    server = createServer((socket) => {
      connections.add(socket);
      socket.once("data", () => {
        writeFileSync(agentState, "empty");
        socket.write('{"result":{"type":"subscription_started"}}\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(config.herdrSocketPath, resolve));
    await start(herdrAdapter("agent-state"));
    expect(emitted.at(-1)).toEqual([]);
  });

  it("omits a pane_not_found id from the next subscribe instead of retrying it", async () => {
    const herdr = join(root, "herdr-missing");
    writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' '{"id":"1","result":{"type":"agent_list","agents":[{"pane_id":"w9:p1","workspace_id":"w9","tab_id":"t1","terminal_id":"term-x","agent_status":"working","focused":false},{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"t1","terminal_id":"term-1","agent_status":"working","focused":false}]}}'\n`);
    chmodSync(herdr, 0o755);
    config = { ...config, herdrBin: herdr };
    const requests: unknown[] = [];
    server = createServer((socket) => {
      connections.add(socket);
      socket.once("data", (raw) => {
        const request = JSON.parse(raw.toString()) as { params?: { subscriptions?: Array<{ pane_id?: string }> } };
        requests.push(request);
        const paneIds = request.params?.subscriptions?.map((entry) => entry.pane_id).filter((id): id is string => id !== undefined) ?? [];
        if (paneIds.includes("w9:p1")) {
          socket.write('{"id":"helm","error":{"code":"pane_not_found","message":"pane w9:p1 not found"}}\n');
          return;
        }
        socket.write('{"result":{"type":"subscription_started"}}\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(config.herdrSocketPath, resolve));
    await start(herdrAdapter("agent-state"));
    await vi.waitUntil(() => requests.some((request) => {
      const paneIds = (request as { params?: { subscriptions?: Array<{ pane_id?: string }> } }).params?.subscriptions?.map((entry) => entry.pane_id) ?? [];
      return paneIds.includes("w1:p1") && !paneIds.includes("w9:p1");
    }));
    expect(requests.length).toBeLessThan(6);
  });
});
