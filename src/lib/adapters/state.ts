/** Read-only firstmate state adapters (Lane D1/D3). */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import chokidar from "chokidar";

import type { HelmConfig } from "../config";
import { bearingsSnapshot, fleetSnapshot, isStructuredBacklogRecord, scanOpenDecisions } from "../fm";
import { runArgv } from "../exec";
import { inboxItemId, type InboxAdapter, type InboxItem, type InboxItemKind, type InboxOption, type InboxRespondSpec } from "../types";

const POLL_MS = 10_000;

/**
 * What the state adapters need that static config cannot supply.
 *
 * `relayTarget` is read at EMIT time, not at registration: the firstmate pane
 * is discovered from Herdr after the adapters start, so resolving it once up
 * front would pin every relay card to `channel: "none"` for the life of the
 * process and silently make its answer button a no-op.
 */
export interface StateAdapterDeps {
  relayTarget(): string | undefined;
}

function open(source: string, naturalKey: string, fields: Omit<InboxItem, "id" | "source" | "state" | "openedAt">): InboxItem {
  return { id: inboxItemId(source, naturalKey), source, state: "open", openedAt: new Date().toISOString(), ...fields };
}

/**
 * Where a relayed answer goes, or `none` when no firstmate pane is reachable.
 *
 * `channel: "none"` is an honest "nothing can carry this answer" — the card
 * renders read-only rather than offering a control that would fail.
 */
export function relay(deps: StateAdapterDeps): InboxRespondSpec {
  const target = deps.relayTarget();
  return target === undefined ? { channel: "none" } : { channel: "relay", target };
}

/**
 * The two answers an approval card accepts.
 *
 * These are the values that travel verbatim as the relayed answer, so they read
 * as an instruction to firstmate rather than as a UI state. helm invents no
 * close mode and no decision record — it relays the word the captain picked.
 */
const APPROVAL_OPTIONS: readonly InboxOption[] = [
  { value: "approve", label: "Approve", hint: "Relay an approval to firstmate" },
  { value: "deny", label: "Deny", hint: "Relay a refusal to firstmate" },
];

function pollingAdapter(id: string, path: string, read: () => Promise<InboxItem[]>): InboxAdapter {
  return {
    id,
    async start(ctx) {
      let stopped = false;
      let running = false;
      const refresh = async () => {
        if (stopped || running) return;
        running = true;
        try { ctx.emit(await read()); } catch (cause) { console.error(`${id}: refresh failed`, cause); }
        finally { running = false; }
      };
      const watcher = chokidar.watch(path, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 } });
      const debounce = () => { setTimeout(() => void refresh(), 100); };
      watcher.on("add", debounce).on("change", debounce).on("unlink", debounce).on("addDir", debounce).on("unlinkDir", debounce);
      await refresh();
      const timer = setInterval(() => void refresh(), POLL_MS);
      return { [Symbol.dispose]() { stopped = true; clearInterval(timer); void watcher.close(); } };
    },
  };
}

function statePath(cfg: HelmConfig, name: string): string { return join(cfg.fmStateDir, name); }

function statusDecisions(cfg: HelmConfig): InboxAdapter {
  return pollingAdapter("status-decisions", cfg.fmStateDir, async () => (await scanOpenDecisions(cfg)).map((d) => open("status-decisions", `${d.taskId}:${d.key}`, {
    kind: "status-decision", urgency: "blocking", taskId: d.taskId,
    title: d.verb === "blocked" ? `Blocked: ${d.taskId}` : `Decision needed: ${d.taskId}`, detail: d.note,
    options: [], allowFreeform: true, respond: { channel: "resolve-key", target: d.taskId, key: d.key }, evidence: [{ path: statePath(cfg, `${d.taskId}.status`) }],
  })));
}

function captainHolds(cfg: HelmConfig, deps: StateAdapterDeps): InboxAdapter {
  return pollingAdapter("captain-holds", cfg.fmStateDir, async () => {
    const snapshot = await fleetSnapshot(cfg);
    return snapshot.backlog.records.filter(isStructuredBacklogRecord).filter((record) => record.captain_actionable).map((record) => {
      return open("captain-holds", record.id, { kind: "captain-held", urgency: "blocking", taskId: record.id, repo: record.repo ?? undefined,
        title: record.title ?? `Captain hold: ${record.id}`, detail: record.hold_reason ?? record.raw,
        options: APPROVAL_OPTIONS, allowFreeform: true, respond: relay(deps), evidence: [{ path: snapshot.backlog.path }],
      });
    });
  });
}

function bearings(cfg: HelmConfig, deps: StateAdapterDeps): InboxAdapter {
  const report = join(cfg.fmHome, "data", "webface-plan", "report.md");
  return pollingAdapter("bearings", cfg.fmStateDir, async () => {
    const snapshot = await bearingsSnapshot(cfg);
    return [
      // The same keyed decisions the status fold already raises as answerable
      // `status-decision` cards. This projection stays informational so one
      // decision cannot be answered twice down two different channels.
      ...snapshot.decisions_open.map((d) => open("bearings", `decision:${d.id}:${d.key}`, { kind: "decision", urgency: "attention", taskId: d.id, title: d.summary, detail: `${d.verb} — owner ${d.owner}`, options: [], allowFreeform: false, respond: { channel: "none" }, evidence: [{ path: report }] })),
      ...snapshot.gates.map((g) => {
        const kind = classifyGate(g.title, g.reason);
        // A merge or credential gate is an approval; any other gate wants
        // instructions, so it takes freeform text instead of approve/deny.
        const approval = kind === "merge" || kind === "credential";
        return open("bearings", `gate:${g.id}`, { kind, urgency: "blocking", taskId: g.id, title: g.title, detail: g.reason, about: g.blocked_by, options: approval ? APPROVAL_OPTIONS : [], allowFreeform: true, respond: relay(deps), evidence: [{ path: report }] });
      }),
    ];
  });
}
function classifyGate(title: string, reason: string): InboxItemKind { const text = `${title} ${reason}`.toLowerCase(); return text.includes("credential") ? "credential" : text.includes("merge") ? "merge" : "blocker"; }

function captainNotes(cfg: HelmConfig, deps: StateAdapterDeps): InboxAdapter {
  const dir = statePath(cfg, "inbox");
  return pollingAdapter("captain-notes", dir, async () => safeFiles(dir, (file) => file.endsWith(".note")).map((file) => {
    const id = basename(file, ".note"); const text = readSafe(file);
    const respond = relay(deps);
    return open("captain-notes", id, { kind: "note", urgency: "fyi", title: text.trim().split("\n")[0] ?? `Captain note ${id}`, detail: text, options: [], allowFreeform: respond.channel === "relay", respond, evidence: [{ path: file }] });
  }));
}

function steeringBacklog(cfg: HelmConfig): InboxAdapter {
  return pollingAdapter("steering-backlog", cfg.fmStateDir, async () => safeFilesRecursive(cfg.fmStateDir, (file) => /\/[^/]+\.inbox\/[^/]+\.msg$/.test(file)).map((file) => open("steering-backlog", relative(cfg.fmStateDir, file), {
    kind: "note", urgency: "fyi", title: "Unacknowledged steering instruction", detail: readSafe(file), options: [], allowFreeform: false, respond: { channel: "none" }, evidence: [{ path: file }],
  })));
}

function procevent(cfg: HelmConfig): InboxAdapter {
  const dir = statePath(cfg, "procevent-inbox");
  return pollingAdapter("procevent", dir, async () => {
    const files = safeFiles(dir, (file) => file.endsWith(".result") && !fileExists(`${file.slice(0, -7)}.handled`));
    return Promise.all(files.map(async (file) => {
      const result = await runArgv(join(cfg.fmBinDir, "fm-procevent.sh"), ["classify", file]);
      const classification = result.exitCode === 0 ? result.stdout.trim() : "unknown";
      return open("procevent", basename(file), { kind: "review", urgency: "attention", title: `Process event: ${classification || "unknown"}`, detail: readSafe(file), options: [], allowFreeform: false, respond: { channel: "none" }, evidence: [{ path: file }] });
    }));
  });
}

function safeFiles(dir: string, select: (file: string) => boolean): string[] { try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name)).filter(select); } catch { return []; } }
function safeFilesRecursive(dir: string, select: (file: string) => boolean): string[] { try { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() && entry.name.endsWith(".inbox") ? safeFiles(join(dir, entry.name), select) : []); } catch { return []; } }
function readSafe(file: string): string { try { return readFileSync(file, "utf8"); } catch { return "Unreadable structured state record"; } }
function fileExists(file: string): boolean { try { return statSync(file).isFile(); } catch { return false; } }

export function createStateAdapters(cfg: HelmConfig, deps: StateAdapterDeps): InboxAdapter[] { return [statusDecisions(cfg), captainHolds(cfg, deps), bearings(cfg, deps), captainNotes(cfg, deps), steeringBacklog(cfg), procevent(cfg)]; }
