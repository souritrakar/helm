/**
 * Contract tests for the firstmate snapshot parsers.
 *
 * Two things must hold: a recorded, well-formed document parses into the fields
 * helm reads, and a document whose shape has drifted is REJECTED rather than
 * silently mis-parsed (SPEC R3). Hermetic — fixtures only, no live fleet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FmContractError,
  isStructuredBacklogRecord,
  parseBearingsSnapshot,
  parseFleetSnapshot,
} from "@/lib/fm";

const FIXTURES = join(import.meta.dirname, "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

/** Deep clone so each mutation case starts from the pristine fixture. */
function mutate(name: string, edit: (doc: Record<string, unknown>) => void): unknown {
  const doc = fixture(name) as Record<string, unknown>;
  const clone = structuredClone(doc);
  edit(clone);
  return clone;
}

/** The task the recorded fixture carries an open decision for. */
function decidingTask(snapshot: Record<string, unknown>): {
  hints: { open_decisions: unknown };
} {
  const tasks = snapshot.tasks as ({ id: string } & { hints: { open_decisions: unknown } })[];
  return tasks.find((task) => task.id === "helm-foundation")!;
}

function structuredRow(snapshot: Record<string, unknown>, id: string): Record<string, unknown> {
  const backlog = snapshot.backlog as { records: Record<string, unknown>[] };
  return backlog.records.find((record) => record.id === id)!;
}

describe("parseFleetSnapshot", () => {
  it("parses a recorded fm-fleet-snapshot.v1 document", () => {
    const snapshot = parseFleetSnapshot(fixture("fleet-snapshot.v1.json"));

    expect(snapshot.schema).toBe("fm-fleet-snapshot.v1");
    expect(snapshot.roots.state).toBe("/fixture/firstmate/state");
    expect(snapshot.main_inventory.valid).toBe(false);
    expect(snapshot.main_inventory.reason).toBe("unstructured current backlog row");
  });

  it("reads the captain-actionable backlog row the inbox binds to", () => {
    const snapshot = parseFleetSnapshot(fixture("fleet-snapshot.v1.json"));

    const actionable = snapshot.backlog.records
      .filter(isStructuredBacklogRecord)
      .filter((record) => record.captain_actionable);
    expect(actionable).toHaveLength(1);
    expect(actionable[0]?.id).toBe("webface-plan");
    expect(actionable[0]?.hold_kind).toBe("captain");
    expect(actionable[0]?.deferred_marker).toBe(false);
  });

  it("reads a task's open decisions and its steer action verbatim", () => {
    const snapshot = parseFleetSnapshot(fixture("fleet-snapshot.v1.json"));
    const task = snapshot.tasks.find((candidate) => candidate.id === "helm-foundation");

    expect(task?.hints.open_decisions).toEqual([
      { key: "api-shape", verb: "needs-decision", summary: "A or B?" },
    ]);
    expect(task?.actions.steer).toBe("bin/fm-send.sh fm-helm-foundation '<instruction>'");
  });

  it("reads an unprobed endpoint, which the seam reports with a null exists", () => {
    const snapshot = parseFleetSnapshot(fixture("fleet-snapshot.v1.json"));

    const task = snapshot.tasks.find((candidate) => candidate.id === "helm-foundation");
    expect(task?.endpoint.target).toBeNull();
    expect(task?.endpoint.exists).toBeNull();
    expect(task?.endpoint.status).toBe("unknown");
  });

  it("reads a task's endpoint target when the snapshot carries one", () => {
    const doc = mutate("fleet-snapshot.v1.json", (snapshot) => {
      const tasks = snapshot.tasks as { id: string; endpoint: Record<string, unknown> }[];
      const task = tasks.find((candidate) => candidate.id === "helm-foundation")!;
      task.endpoint.target = "default:w2:p2";
      task.endpoint.exists = true;
    });

    const parsed = parseFleetSnapshot(doc);

    const task = parsed.tasks.find((candidate) => candidate.id === "helm-foundation");
    expect(task?.endpoint.target).toBe("default:w2:p2");
    expect(task?.endpoint.exists).toBe(true);
  });

  it("parses a secondmate task, whose actions carry send instead of steer", () => {
    const snapshot = parseFleetSnapshot(fixture("fleet-snapshot.v1.json"));

    const secondmate = snapshot.tasks.find((task) => task.kind === "secondmate");
    expect(secondmate?.id).toBe("fleet-scout");
    expect(secondmate?.actions.steer ?? null).toBeNull();
    expect(secondmate?.actions.send).toBe("bin/fm-send.sh fm-fleet-scout '<request>'");
  });

  it("pairs a held, queued row with the role and actionability the seam derives", () => {
    const snapshot = parseFleetSnapshot(fixture("fleet-snapshot.v1.json"));

    const held = snapshot.backlog.records
      .filter(isStructuredBacklogRecord)
      .find((record) => record.id === "webface-plan");
    expect(held?.state).toBe("queued");
    expect(held?.current_role).toBe("queued");
    expect(held?.captain_actionable).toBe(true);
  });

  it("parses an unstructured backlog line, which carries no parsed fields", () => {
    const snapshot = parseFleetSnapshot(fixture("fleet-snapshot.v1.json"));

    const unstructured = snapshot.backlog.records.filter(
      (record) => !isStructuredBacklogRecord(record),
    );
    expect(unstructured).toHaveLength(1);
    expect(unstructured[0]?.raw).toContain("responder routing policy");
    expect(unstructured[0]?.id).toBeNull();
    expect(snapshot.main_inventory.unstructured_current_count).toBe(1);
  });

  it("tolerates fields helm does not read, so firstmate can add them", () => {
    const doc = mutate("fleet-snapshot.v1.json", (snapshot) => {
      snapshot.a_field_helm_has_never_heard_of = { anything: true };
    });

    expect(() => parseFleetSnapshot(doc)).not.toThrow();
  });

  it.each([
    [
      "a different schema id",
      (snapshot: Record<string, unknown>) => {
        snapshot.schema = "fm-fleet-snapshot.v2";
      },
    ],
    [
      "a missing tasks array",
      (snapshot: Record<string, unknown>) => {
        delete snapshot.tasks;
      },
    ],
    [
      "captain_actionable carrying a string instead of a boolean",
      (snapshot: Record<string, unknown>) => {
        structuredRow(snapshot, "webface-plan").captain_actionable = "true";
      },
    ],
    [
      "open_decisions carrying bare strings instead of keyed records",
      (snapshot: Record<string, unknown>) => {
        decidingTask(snapshot).hints.open_decisions = ["api-shape"];
      },
    ],
    [
      "an open decision carrying note where the seam emits summary",
      (snapshot: Record<string, unknown>) => {
        const decisions = decidingTask(snapshot).hints.open_decisions as Record<
          string,
          unknown
        >[];
        const decision = decisions[0]!;
        decision.note = decision.summary;
        delete decision.summary;
      },
    ],
    [
      "a row claiming to be structured without the fields a structured row carries",
      (snapshot: Record<string, unknown>) => {
        const backlog = snapshot.backlog as { records: Record<string, unknown>[] };
        backlog.records.find((record) => record.structured === false)!.structured = true;
      },
    ],
    [
      "prose where the JSON contract belongs",
      (snapshot: Record<string, unknown>) => {
        snapshot.backlog = "In flight: helm-foundation";
      },
    ],
  ])("rejects %s", (_case, edit) => {
    const doc = mutate("fleet-snapshot.v1.json", edit);

    expect(() => parseFleetSnapshot(doc)).toThrow(FmContractError);
  });

  it("names the offending field so drift is diagnosable", () => {
    const doc = mutate("fleet-snapshot.v1.json", (snapshot) => {
      snapshot.schema = "fm-fleet-snapshot.v2";
    });

    expect(() => parseFleetSnapshot(doc)).toThrow(/schema/);
  });
});

describe("parseBearingsSnapshot", () => {
  it("parses a recorded fm-bearings.v1 document", () => {
    const bearings = parseBearingsSnapshot(fixture("bearings.v1.json"));

    expect(bearings.schema).toBe("fm-bearings.v1");
    expect(bearings.in_flight).toHaveLength(1);
    expect(bearings.omitted.map((entry) => entry.reveal)).toContain("--include-prs");
  });

  it("reads the open decisions and gates the inbox renders", () => {
    const bearings = parseBearingsSnapshot(fixture("bearings.v1.json"));

    expect(bearings.decisions_open[0]).toEqual({
      id: "webface-plan",
      key: "webface-plan",
      verb: "captain-hold",
      summary: "helm SPEC - captain call inventory: six spec decisions await the captain",
      owner: "(main)",
    });
    expect(bearings.gates[0]?.blocked_by).toBe("helm-foundation");
  });

  it.each([
    [
      "a different schema id",
      (bearings: Record<string, unknown>) => {
        bearings.schema = "fm-bearings.v2";
      },
    ],
    [
      "a decision missing its key",
      (bearings: Record<string, unknown>) => {
        const decisions = bearings.decisions_open as Record<string, unknown>[];
        delete decisions[0]!.key;
      },
    ],
    [
      "decisions_open as an object instead of an array",
      (bearings: Record<string, unknown>) => {
        bearings.decisions_open = { "webface-plan": "held" };
      },
    ],
  ])("rejects %s", (_case, edit) => {
    const doc = mutate("bearings.v1.json", edit);

    expect(() => parseBearingsSnapshot(doc)).toThrow(FmContractError);
  });
});
