/**
 * Typed argv wrappers over firstmate's blessed seams.
 *
 * helm is strictly a reader-and-caller: it reads firstmate state through these
 * scripts and mutates only by invoking them. Nothing here writes under
 * `$FM_HOME` directly, including status lines (SPEC §4, §6).
 *
 * Two rules shape this module:
 *
 * - **Never parse prose** (SPEC R3). Every read goes through a `--json` contract
 *   and is schema-validated field by field, so a drift in `fm-fleet-snapshot.v1`
 *   fails loudly instead of being silently mis-parsed.
 * - **Never re-implement the decision fold** (SPEC R4, §2.3). The status stream
 *   is an append-only event log; reading it last-event-wins drops captain
 *   decisions that a later unrelated `done:` line appears to close.
 *   {@link scanOpenDecisions} calls `fm-classify-lib.sh` itself.
 *
 * Schemas describe the fields helm reads and let unknown fields through, so
 * firstmate can add fields without breaking helm.
 */
import { join } from "node:path";
import { z } from "zod";

import type { HelmConfig } from "./config";
import { describeFailure, runArgv, type ExecResult } from "./exec";
import type { RespondChannel, RespondCloseMode, RespondResult } from "./types";

/** Thrown when a firstmate seam fails or returns a shape helm cannot trust. */
export class FmContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FmContractError";
  }
}

// ---------------------------------------------------------------------------
// fm-fleet-snapshot.sh --json  (schema fm-fleet-snapshot.v1)
// ---------------------------------------------------------------------------

/**
 * A backlog row.
 *
 * `captain_actionable` means "waiting on the captain now": queued, held for the
 * captain, unblocked, and due. `deferred_marker` is a presentation hint only —
 * it never changes actionability.
 */
export const backlogRecordSchema = z.object({
  order: z.number().int(),
  state: z.string(),
  structured: z.boolean(),
  id: z.string().nullable(),
  title: z.string().nullable(),
  repo: z.string().nullable(),
  kind: z.string().nullable(),
  hold_kind: z.string().nullable(),
  hold_reason: z.string().nullable(),
  hold_until: z.string().nullable(),
  blocked_by_ids: z.array(z.string()),
  unresolved_blocker_ids: z.array(z.string()),
  current_role: z.string().nullable(),
  captain_actionable: z.boolean(),
  deferred_marker: z.boolean(),
  pr_url: z.string().nullable(),
  raw: z.string(),
});
export type BacklogRecord = z.infer<typeof backlogRecordSchema>;

/** A still-open keyed decision, as the snapshot reports it per task. */
export const snapshotOpenDecisionSchema = z.object({
  key: z.string(),
  verb: z.string(),
  note: z.string(),
});

export const fleetTaskSchema = z.object({
  id: z.string(),
  kind: z.string(),
  harness: z.string().nullable(),
  mode: z.string().nullable(),
  backend: z.string().nullable(),
  project: z.string().nullable(),
  paths: z.object({
    status_log: z.object({ path: z.string(), present: z.boolean() }),
    worktree: z.object({ path: z.string().nullable(), present: z.boolean() }),
  }),
  current_state: z.object({
    state: z.string(),
    source: z.string(),
    detail: z.string(),
    raw: z.string(),
    observed_at: z.string(),
    freshness: z.string(),
  }),
  endpoint: z.object({
    target: z.string().nullable(),
    exists: z.boolean(),
    agent_alive: z.string(),
    status: z.string(),
  }),
  hints: z.object({
    pending_decision: z.boolean(),
    blocked_event: z.boolean(),
    open_decisions: z.array(snapshotOpenDecisionSchema),
  }),
  actions: z.object({
    /**
     * The exact `fm-send.sh` invocation firstmate reports for this task. helm
     * takes its send target from here rather than deriving one: mapping a key
     * or an id to a task selector is identity arithmetic helm must not do.
     */
    steer: z.string().nullable(),
    watch: z.string().nullable(),
  }),
  backlog: backlogRecordSchema.nullish(),
});
export type FleetTask = z.infer<typeof fleetTaskSchema>;

export const fleetSnapshotSchema = z.object({
  schema: z.literal("fm-fleet-snapshot.v1"),
  generated: z.string(),
  fm_home: z.string(),
  roots: z.object({
    fm_root: z.string(),
    state: z.string(),
    data: z.string(),
    config: z.string(),
    projects: z.string(),
  }),
  backlog: z.object({
    path: z.string(),
    present: z.boolean(),
    records: z.array(backlogRecordSchema),
  }),
  tasks: z.array(fleetTaskSchema),
  main_inventory: z.object({
    valid: z.boolean(),
    reason: z.string().nullable(),
    orphan_in_flight: z.array(z.string()),
    unstructured_current_count: z.number().int().nonnegative(),
  }),
});
export type FleetSnapshot = z.infer<typeof fleetSnapshotSchema>;

/** Validate an already-read `fm-fleet-snapshot.v1` document. */
export function parseFleetSnapshot(value: unknown): FleetSnapshot {
  return validate(fleetSnapshotSchema, value, "fm-fleet-snapshot.v1");
}

/** Read the read-only structured fleet snapshot. */
export async function fleetSnapshot(cfg: HelmConfig): Promise<FleetSnapshot> {
  const stdout = await readJsonSeam(cfg, "fm-fleet-snapshot.sh", ["--json"]);
  return parseFleetSnapshot(stdout);
}

// ---------------------------------------------------------------------------
// fm-bearings-snapshot.sh --json  (schema fm-bearings.v1)
// ---------------------------------------------------------------------------

export const bearingsDecisionSchema = z.object({
  id: z.string(),
  key: z.string(),
  verb: z.string(),
  summary: z.string(),
  owner: z.string(),
});
export type BearingsDecision = z.infer<typeof bearingsDecisionSchema>;

export const bearingsGateSchema = z.object({
  id: z.string(),
  title: z.string(),
  blocked_by: z.string(),
  reason: z.string(),
  owner: z.string(),
});
export type BearingsGate = z.infer<typeof bearingsGateSchema>;

export const bearingsSnapshotSchema = z.object({
  schema: z.literal("fm-bearings.v1"),
  home: z.string(),
  generated: z.string(),
  in_flight: z.array(
    z.object({ id: z.string(), kind: z.string(), state: z.string(), doing: z.string() }),
  ),
  decisions_open: z.array(bearingsDecisionSchema),
  gates: z.array(bearingsGateSchema),
  landed: z.array(
    z.object({
      id: z.string(),
      what: z.string(),
      artifact: z.string().nullish(),
      owner: z.string(),
    }),
  ),
  reports: z.array(z.object({ id: z.string(), path: z.string() })),
  /** What this projection dropped, and the flag that reveals it. */
  omitted: z.array(z.object({ surface: z.string(), reveal: z.string() })),
});
export type BearingsSnapshot = z.infer<typeof bearingsSnapshotSchema>;

/** Validate an already-read `fm-bearings.v1` document. */
export function parseBearingsSnapshot(value: unknown): BearingsSnapshot {
  return validate(bearingsSnapshotSchema, value, "fm-bearings.v1");
}

/**
 * Read the bearings projection.
 *
 * Local-only: the default invocation makes no network call. helm never passes
 * `--include-prs`, which is the sole path that would.
 */
export async function bearingsSnapshot(cfg: HelmConfig): Promise<BearingsSnapshot> {
  const stdout = await readJsonSeam(cfg, "fm-bearings-snapshot.sh", ["--json"]);
  return parseBearingsSnapshot(stdout);
}

// ---------------------------------------------------------------------------
// scan_open_decisions  (bin/fm-classify-lib.sh)
// ---------------------------------------------------------------------------

/** One still-open keyed decision, with the task that owns it. */
export interface OpenDecision {
  readonly taskId: string;
  readonly key: string;
  /** `needs-decision` or `blocked`. */
  readonly verb: string;
  readonly note: string;
}

/**
 * Shell program handed to `bash -c`.
 *
 * Fixed text. The library path and the state directory arrive as positional
 * arguments, so neither is ever interpolated into shell source.
 */
const SCAN_OPEN_DECISIONS_PROGRAM = '. "$1" && scan_open_decisions "$2"';

/**
 * Parse `scan_open_decisions` output: one `<task>\t<key>\t<verb>\t<note>` line
 * per open decision. A note may itself contain tabs, so only the first three
 * separators are structural.
 */
export function parseOpenDecisionLines(stdout: string): OpenDecision[] {
  const decisions: OpenDecision[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    if (fields.length < 4) {
      throw new FmContractError(
        `scan_open_decisions: expected <task>\\t<key>\\t<verb>\\t<note>, got ${JSON.stringify(line)}`,
      );
    }
    const [taskId, key, verb, ...note] = fields as [string, string, string, ...string[]];
    decisions.push({ taskId, key, verb, note: note.join("\t") });
  }
  return decisions;
}

/**
 * The fleet-wide open-decision set, folded by firstmate's own library.
 *
 * helm calls `scan_open_decisions` rather than reading `.status` files itself,
 * so it inherits every fold fix firstmate makes and can never drop a decision
 * that a later unrelated terminal line appears to close.
 */
export async function scanOpenDecisions(cfg: HelmConfig): Promise<OpenDecision[]> {
  const library = join(cfg.fmBinDir, "fm-classify-lib.sh");
  const result = await runArgv("bash", [
    "-c",
    SCAN_OPEN_DECISIONS_PROGRAM,
    "helm-scan-open-decisions",
    library,
    cfg.fmStateDir,
  ]);
  if (result.exitCode !== 0) {
    throw new FmContractError(`scan_open_decisions failed: ${describeFailure(result)}`);
  }
  return parseOpenDecisionLines(result.stdout);
}

// ---------------------------------------------------------------------------
// Answer seams
// ---------------------------------------------------------------------------

/** `fm-send.sh` accepts these characters in a decision key. */
const DECISION_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface SendResolveKeyRequest {
  /**
   * The task selector, taken verbatim from the snapshot's `actions.steer`. helm
   * does not construct it.
   */
  readonly target: string;
  /** The decision key, taken verbatim from the fold that produced the card. */
  readonly key: string;
  readonly answer: string;
}

/**
 * Answer a keyed status decision: `fm-send.sh <target> --resolve-key <key> <answer>`.
 *
 * `fm-send.sh` appends the closing `resolved [key=…]` line itself and feeds the
 * one keyed-answer intake. helm closes nothing and records nothing.
 */
export async function sendResolveKey(
  cfg: HelmConfig,
  request: SendResolveKeyRequest,
): Promise<RespondResult> {
  requireField("target", request.target);
  requireField("answer", request.answer);
  if (!DECISION_KEY_PATTERN.test(request.key)) {
    throw new FmContractError(
      `sendResolveKey: key ${JSON.stringify(request.key)} is not a valid decision key (allowed: A-Z a-z 0-9 . _ -)`,
    );
  }
  const result = await runArgv(join(cfg.fmBinDir, "fm-send.sh"), [
    request.target,
    "--resolve-key",
    request.key,
    request.answer,
  ]);
  return toRespondResult("resolve-key", result);
}

/** One line for the keyed-answer intake. */
export interface CaptainHoldAnswer {
  /** The key IS the task id. There is no identity arithmetic. */
  readonly taskId: string;
  readonly answer: string;
  /** Provenance text recorded in the durable decision, never a behavior switch. */
  readonly label: string;
  /**
   * Close mode. Omit to take the intake's default (`done`). helm must pass only
   * what the card itself declared.
   */
  readonly close?: RespondCloseMode;
}

/**
 * Feed `fm-captain-hold.sh answers` — the one keyed-answer intake, fed by every
 * channel.
 *
 * helm's only job here is to turn a card's answer into
 * `<task-id>\t<answer>\t<label>[\t<mode>]` lines and pipe them in. It must never
 * map keys to tasks, build decision records, or close anything itself.
 */
export async function captainHoldAnswers(
  cfg: HelmConfig,
  answers: readonly CaptainHoldAnswer[],
  options: { readonly source?: string } = {},
): Promise<RespondResult> {
  if (answers.length === 0) {
    throw new FmContractError("captainHoldAnswers: at least one answer is required");
  }
  const lines = answers.map((answer) => {
    // A tab or newline in any field would forge extra intake lines.
    requireSingleLineField("taskId", answer.taskId);
    requireSingleLineField("answer", answer.answer);
    requireSingleLineField("label", answer.label);
    const fields = [answer.taskId, answer.answer, answer.label];
    if (answer.close !== undefined) fields.push(answer.close);
    return fields.join("\t");
  });
  const args = options.source === undefined ? ["answers"] : ["answers", "--source", options.source];
  const result = await runArgv(join(cfg.fmBinDir, "fm-captain-hold.sh"), args, {
    input: `${lines.join("\n")}\n`,
  });
  return toRespondResult("captain-hold", result);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readJsonSeam(
  cfg: HelmConfig,
  script: string,
  args: readonly string[],
): Promise<unknown> {
  const path = join(cfg.fmBinDir, script);
  const result = await runArgv(path, args);
  if (result.exitCode !== 0) {
    throw new FmContractError(`${script} failed: ${describeFailure(result)}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (cause) {
    throw new FmContractError(`${script} did not print JSON`, { cause });
  }
}

function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  label: string,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new FmContractError(`${label} does not match the contract helm reads: ${issues}`);
  }
  return parsed.data as z.infer<T>;
}

function requireField(label: string, value: string): void {
  if (value.trim() === "") {
    throw new FmContractError(`${label} must not be empty`);
  }
}

function requireSingleLineField(label: string, value: string): void {
  requireField(label, value);
  if (value.includes("\t") || value.includes("\n")) {
    throw new FmContractError(
      `${label} must not contain a tab or newline; those separate intake fields and records`,
    );
  }
}

function toRespondResult(channel: RespondChannel, result: ExecResult): RespondResult {
  const attempt = {
    channel,
    argv: result.argv,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    at: new Date().toISOString(),
  };
  return result.exitCode === 0
    ? { ...attempt, ok: true }
    : { ...attempt, ok: false, error: describeFailure(result) };
}
