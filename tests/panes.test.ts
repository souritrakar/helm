/**
 * The pane/fleet cross-reference.
 *
 * A herdr endpoint target is `<herdr-session>:<pane-id>` and the pane id itself
 * contains a colon, so the session is whatever `$HERDR_SESSION` names. Reading
 * it wrongly costs no error: every pane simply loses its task association.
 * Task documents come from the recorded `fm-fleet-snapshot.v1` fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFleetSnapshot, type FleetTask } from "@/lib/fm";
import type { HerdrPane } from "@/lib/herdr";
import { crossReferencePanes, paneIdFromTarget } from "@/lib/panes";

const FM_HOME = "/fixture/firstmate";

function tasksWithTargets(targets: Record<string, string>): FleetTask[] {
  const document = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "fleet-snapshot.v1.json"), "utf8"),
  ) as { tasks: { id: string; endpoint: { target: string | null } }[] };
  for (const task of document.tasks) {
    const target = targets[task.id];
    if (target !== undefined) task.endpoint.target = target;
  }
  return parseFleetSnapshot(document).tasks;
}

function pane(paneId: string, overrides: Partial<HerdrPane> = {}): HerdrPane {
  return {
    pane_id: paneId,
    terminal_id: `t-${paneId}`,
    workspace_id: paneId.split(":")[0] ?? "w1",
    tab_id: "tab",
    focused: false,
    agent_status: "idle",
    revision: 1,
    terminal_title_stripped: `title ${paneId}`,
    ...overrides,
  };
}

describe("paneIdFromTarget", () => {
  it("splits on the first colon only, whatever the session is named", () => {
    expect(paneIdFromTarget("default:w1:p2")).toBe("w1:p2");
    expect(paneIdFromTarget("work:w1:p2")).toBe("w1:p2");
    expect(paneIdFromTarget(null)).toBeNull();
    expect(paneIdFromTarget("w1")).toBeNull();
  });
});

describe("crossReferencePanes", () => {
  it("associates a task recorded under a non-default herdr session", () => {
    const tasks = tasksWithTargets({ "helm-foundation": "work:w1:p2" });

    const discovery = crossReferencePanes([pane("w1:p2")], new Set(["w1:p2"]), tasks, FM_HOME);

    expect(discovery.panes[0]?.taskId).toBe("helm-foundation");
    expect(discovery.panes[0]?.taskTitle).toBe("helm Lane A - foundation & contracts");
  });

  it("associates a task recorded under the default herdr session", () => {
    const tasks = tasksWithTargets({ "helm-foundation": "default:w1:p2" });

    const discovery = crossReferencePanes([pane("w1:p2")], new Set(["w1:p2"]), tasks, FM_HOME);

    expect(discovery.panes[0]?.taskId).toBe("helm-foundation");
  });

  it("keeps only agent panes and defaults to the firstmate pane", () => {
    const tasks = tasksWithTargets({});

    const discovery = crossReferencePanes(
      [pane("w1:p1"), pane("w2:p1", { cwd: FM_HOME }), pane("w3:p1")],
      new Set(["w1:p1", "w2:p1"]),
      tasks,
      FM_HOME,
    );

    expect(discovery.panes.map((entry) => entry.id)).toEqual(["w1:p1", "w2:p1"]);
    expect(discovery.defaultPaneId).toBe("w2:p1");
    expect(discovery.panes.map((entry) => entry.taskId)).toEqual([null, null]);
  });
});
