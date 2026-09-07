/** Read-only Herdr subscription adapters (Lane D2). */
import type { HelmConfig, OutputMatchConfig } from "../config";
import { agentList, subscribeEvents, type HerdrEventStream } from "../herdr";
import { inboxItemId, type InboxAdapter, type InboxItem } from "../types";

function item(source: string, naturalKey: string, fields: Omit<InboxItem, "id" | "source" | "state" | "openedAt">): InboxItem {
  return { id: inboxItemId(source, naturalKey), source, state: "open", openedAt: new Date().toISOString(), ...fields };
}

/** Blocking cards for the live blocked set, reconstructed from status events. */
function agentState(config: HelmConfig): InboxAdapter {
  return {
    id: "agent-state",
    async start(ctx) {
      const blocked = new Map<string, InboxItem>();
      const agents = await agentList(config);
      for (const agent of agents.filter((candidate) => candidate.agent_status === "blocked")) {
        blocked.set(agent.pane_id, blockedItem(agent.pane_id, agent.terminal_title ?? agent.agent));
      }
      ctx.emit([...blocked.values()]);
      const subscriptions = agents.map((agent) => ({ type: "pane.agent_status_changed" as const, pane_id: agent.pane_id }));
      if (subscriptions.length === 0) return { [Symbol.dispose]() {} };
      const stream = subscribeEvents(config, subscriptions, (event) => {
        if (event.event !== "pane.agent_status_changed") return;
        const { pane_id: paneId, agent_status: status, title, agent } = event.data;
        if (status === "blocked") {
          blocked.set(paneId, blockedItem(paneId, title ?? agent));
        } else blocked.delete(paneId);
        ctx.emit([...blocked.values()]);
      });
      await stream.ready;
      reportStreamFailure("agent-state", stream);
      return { [Symbol.dispose]() { stream.close(); } };
    },
  };
}

function blockedItem(paneId: string, title: string | null | undefined): InboxItem {
  return item("agent-state", paneId, {
    kind: "blocker", urgency: "blocking", title: title ?? `Agent blocked in ${paneId}`,
    detail: "Herdr reported a blocked agent.", options: [], allowFreeform: true,
    respond: { channel: "relay", target: paneId }, evidence: [],
  });
}

function outputMatch(config: HelmConfig): InboxAdapter {
  return {
    id: "output-match",
    async start(ctx) {
      const patterns = config.outputMatches ?? [];
      if (patterns.length === 0) return { [Symbol.dispose]() {} };
      const matched = new Map<string, InboxItem>();
      const stream = subscribeEvents(config, patterns.map(subscriptionFor), (event) => {
        if (event.event !== "pane.output_matched") return;
        const pattern = patterns.find((candidate) => candidate.paneId === event.data.pane_id && lineMatches(candidate, event.data.matched_line));
        if (pattern === undefined) return;
        const key = `${pattern.id}:${event.data.pane_id}:${event.data.read.revision}`;
        matched.set(key, item("output-match", key, {
          kind: "custom", urgency: pattern.urgency ?? "attention", title: pattern.title ?? `Output matched: ${pattern.id}`,
          detail: event.data.matched_line, options: [], allowFreeform: true,
          respond: { channel: "relay", target: event.data.pane_id }, evidence: [],
        }));
        ctx.emit([...matched.values()]);
      });
      await stream.ready;
      reportStreamFailure("output-match", stream);
      return { [Symbol.dispose]() { stream.close(); } };
    },
  };
}

function subscriptionFor(pattern: OutputMatchConfig) {
  return { type: "pane.output_matched" as const, pane_id: pattern.paneId, source: pattern.source, match: pattern.match };
}
function lineMatches(pattern: OutputMatchConfig, line: string): boolean {
  if (pattern.match.type === "substring") return line.includes(pattern.match.value);
  try { return new RegExp(pattern.match.value).test(line); } catch { return false; }
}
function reportStreamFailure(id: string, stream: HerdrEventStream): void { stream.closed.catch((cause: unknown) => console.error(`${id}: Herdr event stream ended`, cause)); }

export function createHerdrAdapters(config: HelmConfig): InboxAdapter[] { return [agentState(config), outputMatch(config)]; }
