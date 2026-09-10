/**
 * Friendly projection of the fleet for human oversight (captain steer
 * `fleet-status-view`).
 *
 * Answers one question at a glance: what is each agent doing, and which ones
 * are stuck. It is a READ of `fm-fleet-snapshot.v1` plus Herdr pane status —
 * it never drives a task and never writes.
 *
 * Pure, so the ordering and the "needs you" rule are provable from a recorded
 * snapshot rather than only from a live fleet.
 */
import type { FleetTask } from "./fm";
import type { DiscoverablePane } from "./panes";

/**
 * How a task reads to the human.
 *
 * Deliberately coarser than firstmate's own state vocabulary: the human is
 * deciding where to look, not auditing the state machine.
 */
export type FleetHealth = "blocked" | "working" | "done" | "idle" | "unknown";

export interface FleetMember {
  readonly id: string;
  /** Human title, falling back to the id when firstmate has no better name. */
  readonly title: string;
  readonly repo?: string;
  readonly health: FleetHealth;
  /** The latest status line, verbatim — what it is doing right now. */
  readonly doing?: string;
  /** True when this task is waiting on the human. */
  readonly needsYou: boolean;
  /** Herdr pane to open for this task, when one is known. */
  readonly paneId?: string;
  /** Herdr's own view of the agent in that pane. */
  readonly agentStatus?: string;
  /** Set when firstmate's reading of this task is not fresh. */
  readonly stale: boolean;
}

export interface FleetOverview {
  readonly members: readonly FleetMember[];
  readonly counts: Record<FleetHealth, number>;
  /** Panes running an agent that no fleet task claims. */
  readonly unclaimedPanes: readonly DiscoverablePane[];
}

/**
 * Map a firstmate task state to a human-facing health.
 *
 * firstmate's state vocabulary grows, so this matches on substrings and falls
 * back to `unknown` rather than asserting a closed set that a new state would
 * silently break.
 */
export function healthOf(task: FleetTask): FleetHealth {
  const state = task.current_state.state.toLowerCase();
  if (task.hints.blocked_event || state.includes("blocked") || state.includes("failed")) return "blocked";
  if (state.includes("done") || state.includes("landed") || state.includes("merged")) return "done";
  if (state.includes("working") || state.includes("running")) return "working";
  if (state.includes("paused") || state.includes("queued") || state.includes("held") || state.includes("idle")) return "idle";
  return "unknown";
}

const HEALTH_RANK: Record<FleetHealth, number> = {
  blocked: 0,
  working: 1,
  idle: 2,
  unknown: 3,
  done: 4,
};

/** Build the overview. Anything waiting on the human sorts to the top. */
export function fleetOverview(
  tasks: readonly FleetTask[],
  panes: readonly DiscoverablePane[],
): FleetOverview {
  const paneByTask = new Map<string, DiscoverablePane>();
  for (const pane of panes) {
    if (pane.taskId !== null) paneByTask.set(pane.taskId, pane);
  }

  const members = tasks
    .map((task): FleetMember => {
      const pane = paneByTask.get(task.id);
      const backlog = task.backlog?.structured === true ? task.backlog : undefined;
      const doing = task.hints.last_event_text ?? task.current_state.detail;
      return {
        id: task.id,
        title: backlog?.title ?? task.id,
        repo: backlog?.repo ?? task.project ?? undefined,
        health: healthOf(task),
        doing: doing === "" ? undefined : doing,
        needsYou:
          task.hints.pending_decision ||
          task.hints.open_decisions.length > 0 ||
          backlog?.captain_actionable === true,
        paneId: pane?.id,
        agentStatus: pane?.status,
        stale: task.current_state.freshness !== "fresh",
      };
    })
    .sort((a, b) => {
      if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
      const byHealth = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
      if (byHealth !== 0) return byHealth;
      return a.title.localeCompare(b.title);
    });

  const counts: Record<FleetHealth, number> = { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
  for (const member of members) counts[member.health] += 1;

  const claimed = new Set(members.map((member) => member.paneId).filter((id): id is string => id !== undefined));
  return {
    members,
    counts,
    unclaimedPanes: panes.filter((pane) => !claimed.has(pane.id)),
  };
}
