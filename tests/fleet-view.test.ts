/**
 * The fleet overview: how a firstmate task state reads to the human, and the
 * order that puts what needs them first.
 */
import { describe, expect, it } from "vitest";

import { fleetOverview, healthOf } from "@/lib/fleet-view";
import type { FleetTask } from "@/lib/fm";
import type { DiscoverablePane } from "@/lib/panes";

function task(partial: {
  readonly id: string;
  readonly state?: string;
  readonly detail?: string;
  readonly last?: string;
  readonly pending?: boolean;
  readonly blocked?: boolean;
  readonly target?: string | null;
  readonly freshness?: string;
  readonly title?: string;
  readonly repo?: string;
  readonly captainActionable?: boolean;
  readonly openDecisions?: readonly { key: string; verb: string; summary: string }[];
}): FleetTask {
  return {
    id: partial.id,
    kind: "crew",
    harness: "claude",
    mode: "no-mistakes",
    backend: "herdr",
    project: partial.repo ?? null,
    paths: {
      status_log: { path: `/fixture/state/${partial.id}.status`, present: true },
      worktree: { path: `/fixture/${partial.id}`, present: true },
    },
    current_state: {
      state: partial.state ?? "working",
      source: "status",
      detail: partial.detail ?? "",
      raw: "",
      observed_at: "2026-09-10T00:00:00Z",
      freshness: partial.freshness ?? "fresh",
    },
    endpoint: {
      target: partial.target ?? null,
      exists: partial.target !== undefined && partial.target !== null,
      agent_alive: "yes",
      status: "ok",
    },
    hints: {
      pending_decision: partial.pending ?? false,
      blocked_event: partial.blocked ?? false,
      open_decisions: [...(partial.openDecisions ?? [])],
      last_event_text: partial.last ?? null,
    },
    actions: { steer: `fm-send.sh ${partial.id} <message>`, watch: null },
    backlog:
      partial.title === undefined
        ? null
        : {
            order: 1,
            state: partial.state ?? "working",
            raw: "",
            structured: true,
            id: partial.id,
            title: partial.title,
            repo: partial.repo ?? null,
            kind: "ship",
            hold_kind: null,
            hold_reason: null,
            hold_until: null,
            blocked_by_ids: [],
            unresolved_blocker_ids: [],
            current_role: "crew",
            captain_actionable: partial.captainActionable ?? false,
            deferred_marker: false,
            pr_url: null,
          },
  };
}

function pane(partial: Partial<DiscoverablePane> & Pick<DiscoverablePane, "id">): DiscoverablePane {
  return {
    title: partial.id,
    taskId: null,
    taskTitle: null,
    status: "working",
    isFirstmate: false,
    ...partial,
  };
}

describe("task health", () => {
  it.each([
    ["working", "working"],
    ["running", "working"],
    ["done", "done"],
    ["landed", "done"],
    ["merged", "done"],
    ["blocked", "blocked"],
    ["failed", "blocked"],
    ["paused", "idle"],
    ["queued", "idle"],
    ["held", "idle"],
  ])("reads state %s as %s", (state, health) => {
    expect(healthOf(task({ id: "t", state }))).toBe(health);
  });

  it("falls back to unknown rather than asserting a closed state set", () => {
    expect(healthOf(task({ id: "t", state: "some-future-state" }))).toBe("unknown");
  });

  it("treats a blocked event as blocked even when the state does not say so", () => {
    expect(healthOf(task({ id: "t", state: "working", blocked: true }))).toBe("blocked");
  });
});

describe("fleet overview", () => {
  it("puts everything waiting on the human first, then the worst health", () => {
    const overview = fleetOverview(
      [
        task({ id: "done-task", title: "Done task", state: "done" }),
        task({ id: "busy", title: "Busy task", state: "working" }),
        task({ id: "stuck", title: "Stuck task", state: "blocked", blocked: true }),
        task({ id: "asks", title: "Asks a question", state: "working", pending: true }),
      ],
      [],
    );

    expect(overview.members.map((member) => member.title)).toEqual([
      "Asks a question",
      "Stuck task",
      "Busy task",
      "Done task",
    ]);
    expect(overview.members[0]?.needsYou).toBe(true);
  });

  it.each([
    ["a pending decision hint", { pending: true }],
    ["an open keyed decision", { openDecisions: [{ key: "k", verb: "needs-decision", summary: "s" }] }],
    ["a captain-actionable backlog row", { captainActionable: true }],
  ])("flags %s as needing the human", (_label, extra) => {
    const overview = fleetOverview([task({ id: "t", title: "T", ...extra })], []);

    expect(overview.members[0]?.needsYou).toBe(true);
  });

  it("counts each health band", () => {
    const overview = fleetOverview(
      [
        task({ id: "a", state: "working" }),
        task({ id: "b", state: "working" }),
        task({ id: "c", state: "blocked" }),
        task({ id: "d", state: "queued" }),
      ],
      [],
    );

    expect(overview.counts).toEqual({ blocked: 1, working: 2, done: 0, idle: 1, unknown: 0 });
  });

  it("prefers the latest status line over the coarser state detail", () => {
    const overview = fleetOverview(
      [task({ id: "t", title: "T", detail: "coarse detail", last: "working: the real thing" })],
      [],
    );

    expect(overview.members[0]?.doing).toBe("working: the real thing");
  });

  it("cross-references the pane a task is reachable in", () => {
    const overview = fleetOverview(
      [task({ id: "helm-ui", title: "Helm UI" })],
      [pane({ id: "w1:p2", taskId: "helm-ui", status: "blocked" })],
    );

    expect(overview.members[0]).toMatchObject({ paneId: "w1:p2", agentStatus: "blocked" });
    expect(overview.unclaimedPanes).toEqual([]);
  });

  it("reports an agent pane no task claims, so a stray crew is still visible", () => {
    const overview = fleetOverview([task({ id: "helm-ui", title: "Helm UI" })], [pane({ id: "w9:p9" })]);

    expect(overview.unclaimedPanes.map((entry) => entry.id)).toEqual(["w9:p9"]);
  });

  it("marks a task whose reading is not fresh, without claiming the task itself is stale", () => {
    const overview = fleetOverview([task({ id: "t", title: "T", freshness: "stale" })], []);

    expect(overview.members[0]?.stale).toBe(true);
  });
});
