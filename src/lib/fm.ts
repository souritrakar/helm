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
 * Schemas describe only the fields helm reads. An unknown field is TOLERATED —
 * it never fails the parse, so firstmate can add fields without breaking helm —
 * but `z.object` also STRIPS it, so the returned value carries the modelled
 * fields and nothing else. A later lane that needs `paths.meta`, `pr.url`,
 * `hints.last_event_text` or any other unmodelled field must add it to the
 * schema here; reading it off the returned object will find it absent.
 */
import { join } from "node:path";
import { z } from "zod";

import type { HelmConfig } from "./config";
import { describeFailure, runArgv, succeeded, type ExecResult } from "./exec";
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

const backlogRowSchema = z.object({
  order: z.number().int(),
  state: z.string(),
  raw: z.string(),
});

/**
 * A parsed backlog row.
 *
 * `captain_actionable` means "waiting on the captain now": queued, held for the
 * captain, unblocked, and due. `deferred_marker` is a presentation hint only —
 * it never changes actionability.
 */
export const structuredBacklogRecordSchema = backlogRowSchema.extend({
  structured: z.literal(true),
  id: z.string(),
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
});
export type StructuredBacklogRecord = z.infer<typeof structuredBacklogRecordSchema>;

/**
 * A free-text backlog line. firstmate keeps it — and counts it in
 * `main_inventory.unstructured_current_count` — but parses no fields out of it,
 * so nothing beyond `raw` exists to read.
 */
export const unstructuredBacklogRecordSchema = backlogRowSchema.extend({
  structured: z.literal(false),
  id: z.null(),
});
export type UnstructuredBacklogRecord = z.infer<typeof unstructuredBacklogRecordSchema>;

/** A backlog row, discriminated by whether firstmate could parse its fields. */
export const backlogRecordSchema = z.discriminatedUnion("structured", [
  structuredBacklogRecordSchema,
  unstructuredBacklogRecordSchema,
]);
export type BacklogRecord = z.infer<typeof backlogRecordSchema>;

/** Narrow a backlog row to the variant that carries the parsed task fields. */
export function isStructuredBacklogRecord(
  record: BacklogRecord,
): record is StructuredBacklogRecord {
  return record.structured;
}

/** A still-open keyed decision, as the snapshot reports it per task. */
export const snapshotOpenDecisionSchema = z.object({
  key: z.string(),
  verb: z.string(),
  summary: z.string(),
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
  /**
   * Where the task's agent is reachable, if firstmate recorded one.
   *
   * `exists` is null until firstmate probes the backend, which it only does
   * when a `target` is recorded (`fm-fleet-snapshot.sh` initialises
   * `endpoint_exists=null` and overwrites it only for a non-empty target).
   */
  endpoint: z.object({
    target: z.string().nullable(),
    exists: z.boolean().nullable(),
    agent_alive: z.string(),
    status: z.string(),
  }),
  hints: z.object({
    pending_decision: z.boolean(),
    blocked_event: z.boolean(),
    open_decisions: z.array(snapshotOpenDecisionSchema),
    /**
     * The task's most recent status line, verbatim.
     *
     * This is the one field that answers "what is it doing right now" in the
     * fleet view. Optional because firstmate omits it for a task with no
     * status log yet.
     */
    last_event_text: z.string().nullish(),
  }),
  /**
   * The commands firstmate suggests for this task, as display and provenance
   * text. They are whole command lines with placeholders, not send targets —
   * helm addresses a task by its {@link FleetTask.id} (see {@link sendResolveKey}).
   *
   * Which keys are present depends on `kind`: a secondmate task carries `send`,
   * every other kind carries `steer`.
   */
  actions: z.object({
    steer: z.string().nullish(),
    send: z.string().nullish(),
    watch: z.string().nullable(),
    return_channel_note: z.string().nullish(),
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

/**
 * How long a snapshot seam may take.
 *
 * `fm-fleet-snapshot.sh` budgets its own per-item timeouts — up to
 * `FM_SNAPSHOT_SECONDMATES` (20) x `FM_SNAPSHOT_SECONDMATE_TIMEOUT` (8s), plus
 * `FM_SNAPSHOT_CREW_STATE_TIMEOUT` (10s) per task — so a slow but healthy fleet
 * outlasts the generic exec default. Killing it there would surface as contract
 * drift for a snapshot that was only slow.
 */
export const SNAPSHOT_TIMEOUT_MS = 180_000;

/** Validate an already-read `fm-fleet-snapshot.v1` document. */
export function parseFleetSnapshot(value: unknown): FleetSnapshot {
  return validate(fleetSnapshotSchema, value, "fm-fleet-snapshot.v1");
}

/** Read the read-only structured fleet snapshot. */
export async function fleetSnapshot(
  cfg: HelmConfig,
  options: { readonly timeoutMs?: number } = {},
): Promise<FleetSnapshot> {
  const stdout = await readJsonSeam(cfg, "fm-fleet-snapshot.sh", ["--json"], options.timeoutMs);
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
export async function bearingsSnapshot(
  cfg: HelmConfig,
  options: { readonly timeoutMs?: number } = {},
): Promise<BearingsSnapshot> {
  const stdout = await readJsonSeam(cfg, "fm-bearings-snapshot.sh", ["--json"], options.timeoutMs);
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
  ], { timeoutMs: SNAPSHOT_TIMEOUT_MS });
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

/**
 * Options `fm-send.sh` still consumes at the position the answer occupies.
 *
 * Its argument loop keeps reading these until the first non-flag, and it has no
 * `--` terminator, so an answer in one of these forms would be read as a second
 * option instead of as the message. helm refuses rather than let a card's
 * answer reach that parser (AGENTS.md hard rule 5).
 */
const FM_SEND_OPTIONS = ["--resolve-key", "--fire-and-forget"];

export interface SendResolveKeyRequest {
  /**
   * The task id, taken verbatim from {@link FleetTask.id} or
   * {@link OpenDecision.taskId}. `fm-send.sh` resolves an exact task id itself,
   * so helm derives, prefixes, and decomposes nothing.
   */
  readonly taskId: string;
  /** The decision key, taken verbatim from the fold that produced the card. */
  readonly key: string;
  readonly answer: string;
}

/**
 * Answer a keyed status decision: `fm-send.sh <task-id> --resolve-key <key> <answer>`.
 *
 * `fm-send.sh` appends the closing `resolved [key=…]` line itself and feeds the
 * one keyed-answer intake. helm closes nothing and records nothing.
 */
export async function sendResolveKey(
  cfg: HelmConfig,
  request: SendResolveKeyRequest,
): Promise<RespondResult> {
  requireSingleLineField("taskId", request.taskId);
  requireField("answer", request.answer);
  requireNotFmSendOption(request.answer);
  if (!DECISION_KEY_PATTERN.test(request.key)) {
    throw new FmContractError(
      `sendResolveKey: key ${JSON.stringify(request.key)} is not a valid decision key (allowed: A-Z a-z 0-9 . _ -)`,
    );
  }
  const result = await runArgv(join(cfg.fmBinDir, "fm-send.sh"), [
    request.taskId,
    "--resolve-key",
    request.key,
    request.answer,
  ]);
  return toRespondResult("resolve-key", result);
}

/**
 * The intake's own key rules: `fm-captain-hold.sh` drops a row whose key falls
 * outside this alphabet or exceeds this length, and it does so SILENTLY.
 */
const CAPTAIN_HOLD_KEY_MAX = 128;

/**
 * The `cut -c1-512` in `fm-captain-hold.sh`'s `sanitize_field`. GNU coreutils
 * counts `-c` in BYTES, and the cut runs AFTER the control-character strip, so
 * helm measures the sanitized value in bytes at the same stage.
 */
const CAPTAIN_HOLD_FREEFORM_MAX_BYTES = 512;

/**
 * `sanitize_field` as `fm-captain-hold.sh` applies it: tab, newline, and
 * carriage return become spaces, C0 controls and DEL are deleted.
 *
 * helm mirrors it only to predict a field the intake would reduce to nothing or
 * cut short, and then refuses. It never rewrites the answer it sends, because
 * helm is the audit record for a captain answer (SPEC 5.5).
 */
function sanitizeIntakeField(value: string): string {
  return value.replace(/[\n\r\t]/g, " ").replace(/[\u0000-\u001f\u007f]/g, "");
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
  options: {
    /**
     * Provenance recorded in the durable decision. `fm-captain-hold.sh` refuses
     * to read a single answer without it, so helm requires it too rather than
     * discovering the refusal after the pipe.
     */
    readonly source: string;
  },
): Promise<RespondResult> {
  if (answers.length === 0) {
    throw new FmContractError("captainHoldAnswers: at least one answer is required");
  }
  requireCaptainHoldFreeform("source", options.source);
  const lines = answers.map((answer) => {
    // A tab or newline in any field would forge extra intake lines.
    requireSingleLineField("taskId", answer.taskId);
    requireCaptainHoldFreeform("answer", answer.answer);
    requireCaptainHoldFreeform("label", answer.label);
    requireIntakeKey(answer.taskId);
    if (sanitizeIntakeField(answer.answer) === "") {
      throw new FmContractError(
        `answer for ${JSON.stringify(answer.taskId)} has no content the intake would keep; fm-captain-hold.sh strips control characters and then drops the row without a word`,
      );
    }
    const fields = [answer.taskId, answer.answer, answer.label];
    if (answer.close !== undefined) fields.push(answer.close);
    return fields.join("\t");
  });
  const result = await runArgv(
    join(cfg.fmBinDir, "fm-captain-hold.sh"),
    ["answers", "--source", options.source],
    { input: `${lines.join("\n")}\n` },
  );
  const attempt = toRespondResult("captain-hold", result);
  if (!attempt.ok) return attempt;
  return reconcileCaptainHold(attempt, result.stdout, answers.length);
}

/** The intake's own closing tally: `answers: closed=<N> skipped=<M>`. */
const CAPTAIN_HOLD_TALLY = /^answers: closed=(\d+) skipped=(\d+)$/m;

/**
 * Hold the intake to the count helm submitted.
 *
 * `fm-captain-hold.sh` drops an unusable row without a word and without
 * counting it as skipped, so a batch that recorded nothing still exits 0. helm
 * is the audit record for an answer (SPEC §5.5), so it must never report a
 * decision as delivered on the strength of an exit code alone.
 */
function reconcileCaptainHold(
  attempt: RespondResult & { readonly ok: true },
  stdout: string,
  submitted: number,
): RespondResult {
  const tally = CAPTAIN_HOLD_TALLY.exec(stdout);
  if (tally === null) {
    return {
      ...attempt,
      ok: false,
      error: `fm-captain-hold.sh answers exited 0 without its "answers: closed=… skipped=…" tally, so helm cannot confirm ${submitted} answer(s) were recorded`,
    };
  }
  const closed = Number(tally[1]);
  const skipped = Number(tally[2]);
  if (closed !== submitted) {
    return {
      ...attempt,
      ok: false,
      error: `fm-captain-hold.sh answers recorded ${closed} of ${submitted} submitted answer(s) (skipped=${skipped}); the rest were dropped without being closed`,
    };
  }
  return attempt;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readJsonSeam(
  cfg: HelmConfig,
  script: string,
  args: readonly string[],
  timeoutMs: number = SNAPSHOT_TIMEOUT_MS,
): Promise<unknown> {
  const path = join(cfg.fmBinDir, script);
  const result = await runArgv(path, args, { timeoutMs });
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

function requireNotFmSendOption(answer: string): void {
  for (const option of FM_SEND_OPTIONS) {
    if (answer === option || answer.startsWith(`${option}=`)) {
      throw new FmContractError(
        `answer ${JSON.stringify(answer)} would be read as fm-send.sh's ${option} option rather than as the message, and fm-send.sh has no -- terminator`,
      );
    }
  }
}

function requireIntakeKey(taskId: string): void {
  if (!DECISION_KEY_PATTERN.test(taskId)) {
    throw new FmContractError(
      `taskId ${JSON.stringify(taskId)} is not a valid intake key (allowed: A-Z a-z 0-9 . _ -); fm-captain-hold.sh would drop the row without a word`,
    );
  }
  if (taskId.length > CAPTAIN_HOLD_KEY_MAX) {
    throw new FmContractError(
      `taskId ${JSON.stringify(taskId)} is ${taskId.length} characters; fm-captain-hold.sh silently drops a key over ${CAPTAIN_HOLD_KEY_MAX}`,
    );
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

function requireCaptainHoldFreeform(label: string, value: string): void {
  requireSingleLineField(label, value);
  const bytes = new TextEncoder().encode(sanitizeIntakeField(value)).length;
  if (bytes > CAPTAIN_HOLD_FREEFORM_MAX_BYTES) {
    throw new FmContractError(
      `${label} is ${bytes} bytes once fm-captain-hold.sh strips control characters, and its intake cuts every field at ${CAPTAIN_HOLD_FREEFORM_MAX_BYTES} bytes. Shorten ${label} and send it again. helm refuses the answer instead of recording a truncated one. Each non-ASCII character costs more than one byte.`,
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
  return succeeded(result)
    ? { ...attempt, ok: true }
    : { ...attempt, ok: false, error: describeFailure(result) };
}
