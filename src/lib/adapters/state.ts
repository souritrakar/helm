/** Read-only firstmate state adapters (Lane D1/D3). */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import chokidar from "chokidar";

import type { HelmConfig } from "../config";
import { bearingsSnapshot, fleetSnapshot, isStructuredBacklogRecord, scanOpenDecisions } from "../fm";
import { runArgv } from "../exec";
import { inboxItemId, type InboxAdapter, type InboxItem, type InboxItemKind } from "../types";

const POLL_MS = 10_000;

function open(source: string, naturalKey: string, fields: Omit<InboxItem, "id" | "source" | "state" | "openedAt">): InboxItem {
  return { id: inboxItemId(source, naturalKey), source, state: "open", openedAt: new Date().toISOString(), ...fields };
}

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
    options: [], allowFreeform: false, respond: { channel: "resolve-key", target: d.taskId, key: d.key }, evidence: [{ path: statePath(cfg, `${d.taskId}.status`) }],
  })));
}

function captainHolds(cfg: HelmConfig): InboxAdapter {
  return pollingAdapter("captain-holds", cfg.fmStateDir, async () => {
    const snapshot = await fleetSnapshot(cfg);
    return snapshot.backlog.records.filter(isStructuredBacklogRecord).filter((record) => record.captain_actionable).map((record) => {
      return open("captain-holds", record.id, { kind: "captain-held", urgency: "blocking", taskId: record.id,
        title: record.title ?? `Captain hold: ${record.id}`, detail: record.hold_reason ?? record.raw,
        options: [], allowFreeform: true, respond: cfg.captainPane === undefined ? { channel: "none" } : { channel: "relay", target: cfg.captainPane }, evidence: [{ path: snapshot.backlog.path }],
      });
    });
  });
}

function bearings(cfg: HelmConfig): InboxAdapter {
  return pollingAdapter("bearings", cfg.fmStateDir, async () => {
    const snapshot = await bearingsSnapshot(cfg);
    return [
      ...snapshot.decisions_open.map((d) => open("bearings", `decision:${d.id}:${d.key}`, { kind: "decision", urgency: "attention", taskId: d.id, title: d.summary, detail: `${d.verb} — owner ${d.owner}`, options: [], allowFreeform: false, respond: { channel: "none" }, evidence: [{ path: join(cfg.fmHome, "data", "webface-plan", "report.md") }] })),
      ...snapshot.gates.map((g) => open("bearings", `gate:${g.id}`, { kind: classifyGate(g.title, g.reason), urgency: "blocking", taskId: g.id, title: g.title, detail: g.reason, about: g.blocked_by, options: [], allowFreeform: false, respond: cfg.captainPane === undefined ? { channel: "none" } : { channel: "relay", target: cfg.captainPane }, evidence: [{ path: join(cfg.fmHome, "data", "webface-plan", "report.md") }] })),
    ];
  });
}
function classifyGate(title: string, reason: string): InboxItemKind { const text = `${title} ${reason}`.toLowerCase(); return text.includes("credential") ? "credential" : text.includes("merge") ? "merge" : "blocker"; }

function captainNotes(cfg: HelmConfig): InboxAdapter {
  const dir = statePath(cfg, "inbox");
  return pollingAdapter("captain-notes", dir, async () => safeFiles(dir, (file) => file.endsWith(".note")).map((file) => {
    const id = basename(file, ".note"); const text = readSafe(file);
    return open("captain-notes", id, { kind: "note", urgency: "fyi", title: `Captain note ${id}`, detail: text, options: [], allowFreeform: cfg.captainPane !== undefined, respond: cfg.captainPane === undefined ? { channel: "none" } : { channel: "relay", target: cfg.captainPane }, evidence: [{ path: file }] });
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

export function createStateAdapters(cfg: HelmConfig): InboxAdapter[] { return [statusDecisions(cfg), captainHolds(cfg), bearings(cfg), captainNotes(cfg), steeringBacklog(cfg), procevent(cfg)]; }
