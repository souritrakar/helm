/** Read-only Herdr subscription adapters (Lane D2). */
import type { HelmConfig, OutputMatchConfig } from "../config";
import { relay, type StateAdapterDeps } from "./state";
import { agentList, isShellPromptLine, paneLastLine, subscribeEvents, type HerdrEventStream } from "../herdr";
import { inboxItemId, type InboxAdapter, type InboxItem } from "../types";

function item(source: string, naturalKey: string, fields: Omit<InboxItem, "id" | "source" | "state" | "openedAt">): InboxItem {
  return { id: inboxItemId(source, naturalKey), source, state: "open", openedAt: new Date().toISOString(), ...fields };
}

function refreshRelay(items: Map<string, InboxItem>, deps: StateAdapterDeps): InboxItem[] {
  for (const [id, current] of items) items.set(id, { ...current, respond: relay(deps) });
  return [...items.values()];
}

/** Blocking cards for the live blocked set, reconstructed from status events. */
function agentState(config: HelmConfig, deps: StateAdapterDeps): InboxAdapter {
  return {
    id: "agent-state",
    async start(ctx) {
      const blocked = new Map<string, InboxItem>();
      const tombstoned = new Set<string>();
      /**
       * Record or clear one pane's blocker.
       *
       * A pane that {@link blockedItem} refuses is DELETED rather than left
       * alone: this runs on reconcile as well as on a status change, so a card
       * raised before the worker exited has to come back out of the open set.
       */
      const setBlocked = async (
        into: Map<string, InboxItem>,
        paneId: string,
        agent: string | null | undefined,
        title: string | null | undefined,
      ): Promise<void> => {
        const card = await blockedItem(config, paneId, agent, title, deps);
        if (card === null) into.delete(paneId);
        else into.set(paneId, card);
      };
      const agents = await agentList(config);
      const panes = new Set(agents.map((agent) => agent.pane_id));
      for (const agent of agents.filter((candidate) => candidate.agent_status === "blocked")) {
        await setBlocked(blocked, agent.pane_id, agent.agent, agent.terminal_title);
      }
      ctx.emit([...blocked.values()]);
      const unsubscribeRelayTarget = deps.onRelayTargetChanged?.(() => ctx.emit(refreshRelay(blocked, deps))) ?? (() => undefined);
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
              const { pane_id: paneId, agent_status: status, title, agent, display_agent: displayAgent } = event.data;
              if (status === "blocked") await setBlocked(blocked, paneId, agent ?? displayAgent, title);
              else blocked.delete(paneId);
              ctx.emit([...blocked.values()]);
            } else if (event.event === "pane_created") {
              const pane = event.data.pane;
              if (tombstoned.has(pane.pane_id)) return;
              panes.add(pane.pane_id);
              if (pane.agent_status === "blocked") await setBlocked(blocked, pane.pane_id, pane.agent, pane.terminal_title);
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
          if (agent.agent_status === "blocked") await setBlocked(blocked, agent.pane_id, agent.agent, agent.terminal_title);
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
        try {
          await subscribe(true);
        } catch (cause) {
          console.error("agent-state: subscription failed", cause);
          if (!forgetMissingPane(cause)) throw cause;
          await subscribe(true);
        }
      } catch (cause) {
        unsubscribeRelayTarget();
        throw cause;
      }
      return { [Symbol.dispose]() { stopped = true; generation++; if (debounce !== undefined) clearTimeout(debounce); current?.close(); unsubscribeRelayTarget(); } };
    },
  };
}

/**
 * The blocker card for one pane, or `null` when there is nothing to report.
 *
 * Herdr's `blocked` means "this pane is waiting for input", which is true of a
 * genuinely stuck agent AND of a torn-down worker's leftover shell sitting at
 * its own prompt. The last VISIBLE line is what separates them, and it is the
 * ONLY thing that does — the terminal title does not, because a live and
 * genuinely blocked `codex` still shows the shell's own `user@host:cwd` title:
 * it never set one of its own.
 *
 * The line that IS holding the pane becomes the card body, so the human can see
 * what it is waiting for instead of one constant sentence about every blocker.
 * That line is untrusted pane output: display text, never an instruction.
 */
async function blockedItem(
  config: HelmConfig,
  paneId: string,
  agent: string | null | undefined,
  title: string | null | undefined,
  deps: StateAdapterDeps,
): Promise<InboxItem | null> {
  const lastLine = await paneLastLine(config, paneId);
  if (lastLine !== undefined && isShellPromptLine(lastLine)) return null;
  const named = agent?.trim() ?? "";
  return item("agent-state", paneId, {
    kind: "blocker", urgency: "blocking",
    // A shell-prompt title describes nothing, so name the agent and the pane
    // rather than repeating `user@host:cwd` as if it were the card's subject.
    title: agentTitle(title) ?? (named === "" ? `Agent blocked in ${paneId}` : `${named} is waiting for input in ${paneId}`),
    detail: lastLine ?? "Herdr reported a blocked agent.", options: [], allowFreeform: true,
    respond: relay(deps), evidence: [],
  });
}

/**
 * The pane's own title, unless the SHELL wrote it rather than the agent.
 *
 * A prompt in a title has no trailing sigil and spaces its colon out, so it is
 * normalised back to the line form before the shared test sees it. Requiring a
 * location (`@`, `~`, `/`) keeps a short one-word title an AGENT chose
 * (`codex`) out of this — only a location is evidence the shell wrote it.
 */
function agentTitle(title: string | null | undefined): string | undefined {
  const trimmed = title?.trim() ?? "";
  if (trimmed === "") return undefined;
  if (/^-?(?:ba|z|k|c|tc|da|fi)?sh$/.test(trimmed)) return undefined;
  const asPromptLine = `${trimmed.replace(/\s*:\s*/, ":")}$`;
  return /[@~/]/.test(trimmed) && isShellPromptLine(asPromptLine) ? undefined : trimmed;
}

function outputMatch(config: HelmConfig, deps: StateAdapterDeps): InboxAdapter {
  return {
    id: "output-match",
    async start(ctx) {
      const patterns = config.outputMatches ?? [];
      if (patterns.length === 0) return { [Symbol.dispose]() {} };
      const matched = new Map<string, InboxItem>();
      const unsubscribeRelayTarget = deps.onRelayTargetChanged?.(() => ctx.emit(refreshRelay(matched, deps))) ?? (() => undefined);
      const stream = subscribeEvents(config, patterns.map(subscriptionFor), (event) => {
        if (event.event !== "pane.output_matched") return;
        const matching = patterns.map((pattern, index) => ({ pattern, index })).filter(({ pattern }) => pattern.paneId === event.data.pane_id && pattern.source === event.data.read.source && lineMatches(pattern, event.data.matched_line));
        if (matching.length === 0) return;
        for (const { pattern, index } of matching) {
          const key = `${pattern.id}:${index}:${event.data.pane_id}:${event.data.read.revision}`;
          matched.set(key, item("output-match", key, {
            kind: "custom", urgency: pattern.urgency ?? "attention", title: pattern.title ?? `Output matched: ${pattern.id}`,
            detail: event.data.matched_line, options: [], allowFreeform: true,
            respond: relay(deps), evidence: [],
          }));
        }
        ctx.emit([...matched.values()]);
      });
      try {
        await stream.ready;
      } catch (cause) {
        unsubscribeRelayTarget();
        throw cause;
      }
      reportStreamFailure("output-match", stream);
      return { [Symbol.dispose]() { stream.close(); unsubscribeRelayTarget(); } };
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

export function createHerdrAdapters(config: HelmConfig, deps: StateAdapterDeps): InboxAdapter[] { return [agentState(config, deps), outputMatch(config, deps)]; }
