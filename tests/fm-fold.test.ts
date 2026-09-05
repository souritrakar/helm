/**
 * Contract test for the decision fold.
 *
 * helm must never re-implement the fold (SPEC R4): reading the append-only
 * status log last-event-wins drops a captain decision that a later, unrelated
 * `done:` line appears to close. These tests run firstmate's OWN
 * `scan_open_decisions` over a temporary FM_HOME built from fixtures, so they
 * prove the wrapper reaches the real library and never touch the live fleet.
 */
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type HelmConfig } from "@/lib/config";
import { FmContractError, parseOpenDecisionLines, scanOpenDecisions } from "@/lib/fm";

const FIXTURE_STATUS = join(import.meta.dirname, "fixtures", "status");

/**
 * Locate a real firstmate `bin/` to borrow the classify library from. Copying
 * the library instead would fork the fold, which is the exact failure this test
 * exists to prevent.
 */
function findFirstmateBin(): string | null {
  const candidates = [
    process.env.HELM_TEST_FM_HOME,
    process.env.FM_HOME,
    join(homedir(), "firstmate"),
  ];
  for (const home of candidates) {
    if (home === undefined || home === "") continue;
    if (existsSync(join(home, "bin", "fm-classify-lib.sh"))) return join(home, "bin");
  }
  return null;
}

const firstmateBin = findFirstmateBin();

/**
 * Explicit local-dev opt-out. Absence of the library is otherwise a FAILURE,
 * never a skip: this suite is the only proof of AGENTS.md hard rule 2, and a
 * silent skip would let a green `pnpm test` mean nothing.
 */
const skipContract = process.env.HELM_SKIP_FM_CONTRACT === "1";

describe("parseOpenDecisionLines", () => {
  it("splits only the first three tabs, so a note may contain tabs", () => {
    const decisions = parseOpenDecisionLines(
      "task-a\tapi-shape\tneeds-decision\tA or B?\tcolumn\ttext\n",
    );

    expect(decisions).toEqual([
      { taskId: "task-a", key: "api-shape", verb: "needs-decision", note: "A or B?\tcolumn\ttext" },
    ]);
  });

  it("ignores blank lines and returns nothing when no decision is open", () => {
    expect(parseOpenDecisionLines("\n\n")).toEqual([]);
  });

  it("rejects a line with too few fields rather than guessing", () => {
    expect(() => parseOpenDecisionLines("task-a\tapi-shape\n")).toThrow(FmContractError);
  });
});

describe.skipIf(skipContract)("scanOpenDecisions against the real classify library", () => {
  let home = "";
  let config: HelmConfig;

  beforeAll(() => {
    if (firstmateBin === null) {
      throw new Error(
        "no firstmate bin/fm-classify-lib.sh found under HELM_TEST_FM_HOME, FM_HOME, or ~/firstmate; " +
          "the fold contract cannot be proven. Point HELM_TEST_FM_HOME at a firstmate checkout, " +
          "or set HELM_SKIP_FM_CONTRACT=1 to opt out deliberately.",
      );
    }
    home = mkdtempSync(join(tmpdir(), "helm-fold-"));
    // Symlink the whole bin directory: the library sources a sibling relative to
    // its own location, so a per-file symlink would break that resolution.
    symlinkSync(firstmateBin, join(home, "bin"), "dir");
    const state = join(home, "state");
    mkdirSync(state);
    for (const name of [
      "later-done-does-not-close.status",
      "resolved-closes.status",
      "no-open-decisions.status",
    ]) {
      copyFileSync(join(FIXTURE_STATUS, name), join(state, name));
    }
    config = loadConfig({ FM_HOME: home });
  });

  afterAll(() => {
    if (home !== "") rmSync(home, { recursive: true, force: true });
  });

  it("keeps a decision open behind a later, unrelated done: line", async () => {
    const decisions = await scanOpenDecisions(config);

    const stillOpen = decisions.find(
      (decision) => decision.taskId === basename("later-done-does-not-close.status", ".status"),
    );
    expect(stillOpen).toEqual({
      taskId: "later-done-does-not-close",
      key: "api-shape",
      verb: "needs-decision",
      note: "A or B?",
    });
  });

  it("closes a decision that an explicit resolved: line references", async () => {
    const decisions = await scanOpenDecisions(config);

    expect(decisions.map((decision) => decision.taskId)).not.toContain("resolved-closes");
  });

  it("reports nothing for a task that never opened a decision", async () => {
    const decisions = await scanOpenDecisions(config);

    expect(decisions.map((decision) => decision.taskId)).not.toContain("no-open-decisions");
  });

  it("surfaces exactly the one open decision across the whole state directory", async () => {
    const decisions = await scanOpenDecisions(config);

    expect(decisions).toHaveLength(1);
  });
});
