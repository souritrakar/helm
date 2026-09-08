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
      const tombstoned = new Set<string>();
      const agents = await agentList(config);
      const panes = new Set(agents.map((agent) => agent.pane_id));
      for (const agent of agents.filter((candidate) => candidate.agent_status === "blocked")) {
        blocked.set(agent.pane_id, blockedItem(config, agent.pane_id, agent.terminal_title ?? agent.agent));
      }
      ctx.emit([...blocked.values()]);
      let stopped = false;
      let current: HerdrEventStream | undefined;
      let generation = 0;
      let scheduled = Promise.resolve();
      let updates = Promise.resolve();

      const queueUpdate = (update: () => void | Promise<void>): void => {
        updates = updates.catch(() => undefined).then(update).catch((cause: unknown) => console.error("agent-state: event update failed", cause));
      };

      const subscribe = async (reconcileAfterReady = false): Promise<void> => {
        if (stopped) return;
        const ownGeneration = generation + 1;
        const previous = current;
        if (previous === undefined) generation = ownGeneration;
        let releaseEvents: (() => void) | undefined;
        const eventBarrier = reconcileAfterReady
          ? new Promise<void>((resolve) => { releaseEvents = resolve; })
          : Promise.resolve();
        const stream = subscribeEvents(config, [
          { type: "pane.created" },
          { type: "pane.closed" },
          ...[...panes].filter((paneId) => !tombstoned.has(paneId)).map((paneId) => ({ type: "pane.agent_status_changed" as const, pane_id: paneId })),
        ], (event) => {
          queueUpdate(async () => {
            await eventBarrier;
            if (stopped || generation !== ownGeneration) return;
            if (event.event === "pane.agent_status_changed") {
              const { pane_id: paneId, agent_status: status, title, agent } = event.data;
              if (status === "blocked") blocked.set(paneId, blockedItem(config, paneId, title ?? agent));
              else blocked.delete(paneId);
              ctx.emit([...blocked.values()]);
            } else if (event.event === "pane_created") {
              const pane = event.data.pane;
              if (tombstoned.has(pane.pane_id)) return;
              panes.add(pane.pane_id);
              if (pane.agent_status === "blocked") blocked.set(pane.pane_id, blockedItem(config, pane.pane_id, pane.terminal_title ?? pane.agent));
              else blocked.delete(pane.pane_id);
              ctx.emit([...blocked.values()]);
              queueSubscription();
            } else if (event.event === "pane_closed") {
              panes.delete(event.data.pane_id);
              blocked.delete(event.data.pane_id);
              ctx.emit([...blocked.values()]);
              queueSubscription();
            }
          });
        });
        current = stream;
        reportStreamFailure("agent-state", stream);
        void stream.closed.then(() => undefined, (cause: unknown) => {
          if (forgetMissingPane(cause)) queueSubscription();
        });
        await stream.ready;
        if (stopped) {
          stream.close();
          return;
        }
        generation = ownGeneration;
        if (reconcileAfterReady) {
          try { await reconcile(); }
          finally { releaseEvents?.(); }
        }
        if (stopped || generation !== ownGeneration) stream.close();
        else previous?.close();
      };
      const reconcile = async (): Promise<void> => {
        const liveAgents = await agentList(config);
        panes.clear();
        blocked.clear();
        for (const agent of liveAgents) {
          if (tombstoned.has(agent.pane_id)) continue;
          panes.add(agent.pane_id);
          if (agent.agent_status === "blocked") blocked.set(agent.pane_id, blockedItem(config, agent.pane_id, agent.terminal_title ?? agent.agent));
        }
        ctx.emit([...blocked.values()]);
      };
      const forgetMissingPane = (cause: unknown): boolean => {
        const message = cause instanceof Error ? cause.message : String(cause);
        const missing = /pane ([^\s]+) not found/.exec(message);
        if (missing === null || missing[1] === undefined) return false;
        tombstoned.add(missing[1]);
        panes.delete(missing[1]);
        blocked.delete(missing[1]);
        ctx.emit([...blocked.values()]);
        return true;
      };
      let debounce: ReturnType<typeof setTimeout> | undefined;
      function queueSubscription(): void {
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          scheduled = scheduled.catch(() => undefined).then(() => subscribe(true)).catch((cause: unknown) => {
            console.error("agent-state: subscription failed", cause);
            if (forgetMissingPane(cause)) queueSubscription();
          });
        }, 50);
      }

      try {
        await subscribe(true);
      } catch (cause) {
        console.error("agent-state: subscription failed", cause);
        if (!forgetMissingPane(cause)) throw cause;
        await subscribe(true);
      }
      return { [Symbol.dispose]() { stopped = true; generation++; if (debounce !== undefined) clearTimeout(debounce); current?.close(); } };
    },
  };
}

function blockedItem(config: HelmConfig, paneId: string, title: string | null | undefined): InboxItem {
  return item("agent-state", paneId, {
    kind: "blocker", urgency: "blocking", title: title ?? `Agent blocked in ${paneId}`,
    detail: "Herdr reported a blocked agent.", options: [], allowFreeform: true,
    respond: relayRespond(config), evidence: [],
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
        const matching = patterns.map((pattern, index) => ({ pattern, index })).filter(({ pattern }) => pattern.paneId === event.data.pane_id && pattern.source === event.data.read.source && lineMatches(pattern, event.data.matched_line));
        if (matching.length === 0) return;
        for (const { pattern, index } of matching) {
          const key = `${pattern.id}:${index}:${event.data.pane_id}:${event.data.read.revision}`;
          matched.set(key, item("output-match", key, {
            kind: "custom", urgency: pattern.urgency ?? "attention", title: pattern.title ?? `Output matched: ${pattern.id}`,
            detail: event.data.matched_line, options: [], allowFreeform: true,
            respond: relayRespond(config), evidence: [],
          }));
        }
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
function relayRespond(config: HelmConfig) {
  return config.captainPane === undefined ? { channel: "none" as const } : { channel: "relay" as const, target: config.captainPane };
}
function reportStreamFailure(id: string, stream: HerdrEventStream): void { stream.closed.catch((cause: unknown) => console.error(`${id}: Herdr event stream ended`, cause)); }

export function createHerdrAdapters(config: HelmConfig): InboxAdapter[] { return [agentState(config), outputMatch(config)]; }
