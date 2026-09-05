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
 * The environment a seam replay runs under.
 *
 * `fm-fleet-snapshot.sh` resolves its roots from `FM_*_OVERRIDE` and its bounds
 * from `FM_SNAPSHOT_*`, so an ambient export in the shell running the suite
 * would redirect the replay at the LIVE state directory or change the emitted
 * document. Every one of those is dropped or pinned here.
 */
export function seamEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FM_SNAPSHOT_") || FM_ROOT_OVERRIDES.has(key)) delete env[key];
  }
  return {
    ...env,
    FM_HOME: home,
    FM_SNAPSHOT_NOW: FIXTURE_NOW,
    FM_SNAPSHOT_NOW_EPOCH: String(FIXTURE_NOW_EPOCH),
    ...SNAPSHOT_BOUNDS,
  };
}

const FM_ROOT_OVERRIDES = new Set([
  "FM_ROOT_OVERRIDE",
  "FM_STATE_OVERRIDE",
  "FM_DATA_OVERRIDE",
  "FM_CONFIG_OVERRIDE",
  "FM_PROJECTS_OVERRIDE",
]);

/** The seam's own defaults, pinned so a recording cannot shift underneath it. */
const SNAPSHOT_BOUNDS: Readonly<Record<string, string>> = {
  FM_SNAPSHOT_SECONDMATES: "20",
  FM_SNAPSHOT_SECONDMATE_TIMEOUT: "8",
  FM_SNAPSHOT_CREW_STATE_TIMEOUT: "10",
  FM_SNAPSHOT_SECONDMATE_MAX_BYTES: "262144",
  FM_SNAPSHOT_SECONDMATE_CHILDREN: "20",
  FM_SNAPSHOT_SECONDMATE_QUEUED: "20",
  FM_SNAPSHOT_SECONDMATE_DECISIONS: "20",
  FM_SNAPSHOT_TERMINAL_LINES: "8",
  FM_SNAPSHOT_TERMINAL_BYTES: "4096",
  FM_SNAPSHOT_TERMINAL_TIMEOUT: "2",
  FM_SNAPSHOT_PARENT_ACTIVITY_LINES: "256",
  FM_SNAPSHOT_PARENT_ACTIVITY_BYTES: "65536",
  FM_SNAPSHOT_PARENT_ACTIVITIES: "20",
  FM_SNAPSHOT_PARENT_ACTIVITY_TIMEOUT: "2",
  FM_SNAPSHOT_REGISTRY_LINES: "256",
  FM_SNAPSHOT_REGISTRY_BYTES: "65536",
  FM_SNAPSHOT_REGISTRY_RECORDS: "40",
  FM_SNAPSHOT_REGISTRY_TIMEOUT: "2",
};

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
