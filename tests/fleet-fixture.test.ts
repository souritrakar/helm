/**
 * Contract test binding `tests/fixtures/fleet-snapshot.v1.json` to its producer.
 *
 * The fixture is a RECORDING of `fm-fleet-snapshot.sh --json` run against
 * `tests/fixtures/fleet-home/`. This test replays that exact invocation with
 * firstmate's own script and asserts the recording still matches, so a
 * hand-edited fixture — a derived field the seam would never emit from the
 * `raw` line beside it — fails here rather than quietly validating helm's
 * schemas against a document the fleet cannot produce.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runArgv } from "@/lib/exec";
import { parseFleetSnapshot } from "@/lib/fm";
import {
  SKIP_FM_CONTRACT,
  findFirstmateBin,
  normalizeSnapshot,
  requireFirstmateBin,
} from "./seam";

const FIXTURES = join(import.meta.dirname, "fixtures");
const firstmateBin = findFirstmateBin();

describe.skipIf(SKIP_FM_CONTRACT)("fleet-snapshot.v1.json is what the real seam emits", () => {
  let home = "";
  let emitted: unknown;

  beforeAll(async () => {
    requireFirstmateBin(firstmateBin);
    home = mkdtempSync(join(tmpdir(), "helm-fleet-"));
    cpSync(join(FIXTURES, "fleet-home", "state"), join(home, "state"), { recursive: true });
    cpSync(join(FIXTURES, "fleet-home", "backlog.md"), join(home, "data", "backlog.md"), {
      recursive: true,
    });
    const result = await runArgv(join(firstmateBin, "fm-fleet-snapshot.sh"), ["--json"], {
      env: { ...process.env, FM_HOME: home },
      timeoutMs: 120_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    emitted = normalizeSnapshot(JSON.parse(result.stdout) as unknown, home);
  }, 130_000);

  afterAll(() => {
    if (home !== "") rmSync(home, { recursive: true, force: true });
  });

  it("matches the recorded fixture field for field", () => {
    const recorded = JSON.parse(
      readFileSync(join(FIXTURES, "fleet-snapshot.v1.json"), "utf8"),
    ) as unknown;

    expect(emitted).toEqual(recorded);
  });

  it("parses under the schemas helm reads, so the recording proves the contract", () => {
    const snapshot = parseFleetSnapshot(emitted);

    expect(snapshot.tasks.map((task) => task.id).sort()).toEqual([
      "fleet-scout",
      "helm-foundation",
    ]);
  });
});
