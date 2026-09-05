/**
 * Shared helpers for the tests that run firstmate's REAL scripts.
 *
 * A hand-authored fixture can encode a document the seam cannot actually
 * produce, and then the schema and the fixture agree with each other while both
 * disagree with firstmate. These helpers let a test regenerate a fixture from
 * the seam itself, so that class of drift fails loudly instead of passing.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The home path a recorded fixture is normalized to. */
export const FIXTURE_HOME = "/fixture/firstmate";

/** The firstmate checkout path a recording is normalized to. */
export const FIXTURE_FM_ROOT = "/fixture/firstmate-root";

/**
 * The instant a recording is made at.
 *
 * `fm-fleet-snapshot.sh` honours `FM_SNAPSHOT_NOW` / `FM_SNAPSHOT_NOW_EPOCH`,
 * so pinning both makes `generated`, `observed_at`, and every `age_seconds`
 * (SNAPSHOT_EPOCH minus the status file's mtime) the same on every run.
 */
export const FIXTURE_NOW = "2026-09-04T23:56:43Z";
export const FIXTURE_NOW_EPOCH = Math.trunc(Date.parse(FIXTURE_NOW) / 1000);

/**
 * Locate a real firstmate `bin/`.
 *
 * Probe order: `HELM_TEST_FM_HOME`, `FM_HOME`, `~/firstmate`.
 */
export function findFirstmateBin(): string | null {
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

/**
 * Explicit local-dev opt-out. Absence of firstmate is otherwise a FAILURE,
 * never a skip: these suites are the only proof helm's contracts match the real
 * seams, and a silent skip would let a green `pnpm test` mean nothing.
 */
export const SKIP_FM_CONTRACT = process.env.HELM_SKIP_FM_CONTRACT === "1";

export function requireFirstmateBin(bin: string | null): asserts bin is string {
  if (bin === null) {
    throw new Error(
      "no firstmate bin/fm-classify-lib.sh found under HELM_TEST_FM_HOME, FM_HOME, or ~/firstmate; " +
        "the firstmate contract cannot be proven. Point HELM_TEST_FM_HOME at a firstmate checkout, " +
        "or set HELM_SKIP_FM_CONTRACT=1 to opt out deliberately.",
    );
  }
}

/**
 * Replace the two paths that differ between machines: the home the seam was
 * invoked against, and the firstmate checkout the script resolved itself from
 * (`roots.fm_root`, taken from the script's own location). The clock is pinned
 * at the source through {@link FIXTURE_NOW}, so no timestamp is rewritten here
 * and every derived field is compared verbatim.
 */
export function normalizeSnapshot(document: unknown, home: string, fmRoot: string): unknown {
  const json = JSON.stringify(document)
    .split(jsonEscaped(home))
    .join(FIXTURE_HOME)
    .split(jsonEscaped(fmRoot))
    .join(FIXTURE_FM_ROOT);
  return JSON.parse(json) as unknown;
}

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
