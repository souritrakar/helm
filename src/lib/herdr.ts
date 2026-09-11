/**
 * Typed wrappers over the Herdr CLI and control socket.
 *
 * This is the SINGLE place any Herdr access lives (SPEC R2), so a Herdr upgrade
 * is a one-file change and `doctor` can assert the protocol helm was written
 * against. Every exec is argv-only — no helper here builds a shell string.
 *
 * helm never drives Herdr lifecycle: it observes terminals, sends text, and
 * reads. Nothing in this module starts, stops, restarts, or deletes a session,
 * workspace, or pane.
 *
 * Shapes are taken from `herdr api schema --json` at protocol 20 and from
 * observed CLI output on Herdr 0.8.2.
 */
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import { z } from "zod";

import type { HelmConfig } from "./config";
import { describeFailure, runArgv, streamArgv, type ExecResult } from "./exec";

/**
 * Minimum Herdr socket protocol helm is written against. The terminal-session
 * observer and the `pane.*` subscription set below are protocol-20 shapes.
 */
export const HERDR_MIN_PROTOCOL = 20;

// ---------------------------------------------------------------------------
// Terminal bridge
// ---------------------------------------------------------------------------

/**
 * One rendered terminal frame.
 *
 * `full: true` marks a complete repaint — the first frame of a stream always
 * is, so a client that connects mid-session needs no replay logic. `seq` is
 * monotonic, so a gap means frames were lost and the observer must be respawned
 * to force a fresh repaint. `width`/`height` echo what this observer requested,
 * not the pane's real geometry: the viewport is per-observer, which is why a
 * browser tab cannot disturb another client's view.
 */
export const terminalFrameSchema = z.object({
  type: z.literal("terminal.frame"),
  seq: z.number().int().nonnegative(),
  encoding: z.literal("ansi"),
  /** Base64 ANSI bytes. Decode and write straight into a terminal emulator. */
  bytes: z.string().refine(isCanonicalBase64, "terminal frame bytes must be canonical base64"),
  full: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type TerminalFrame = z.infer<typeof terminalFrameSchema>;

/** The server closed the terminal stream. */
export const terminalClosedSchema = z.object({ type: z.literal("terminal.closed") });
export type TerminalClosed = z.infer<typeof terminalClosedSchema>;

export const terminalRecordSchema = z.discriminatedUnion("type", [
  terminalFrameSchema,
  terminalClosedSchema,
]);
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;

/** Parse one newline-delimited observer record. */
export function parseTerminalRecord(line: string): TerminalRecord {
  return terminalRecordSchema.parse(parseJson(line, "herdr terminal record"));
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

export interface TerminalViewport {
  readonly cols: number;
  readonly rows: number;
}

/** How an observer stream ended. */
export interface TerminalObservationExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Non-null when the stream ended abnormally: spawn failure or a bad record. */
  readonly error: string | null;
}

/**
 * A live read-only terminal stream. Iterate it for records; `close()` stops the
 * child; `exit` resolves once the stream has ended.
 */
export interface TerminalObservation extends AsyncIterable<TerminalRecord> {
  readonly argv: readonly string[];
  readonly exit: Promise<TerminalObservationExit>;
  close(): void;
}

/**
 * Spawn a read-only observer on `target` (a pane id such as `w1:p1`).
 *
 * Observing takes no input, resize, scroll, or takeover ownership, and any
 * number of observers may watch the same terminal. The viewport is fixed at
 * spawn, so a resize means closing this observation and opening another.
 */
export function observeTerminal(
  cfg: HelmConfig,
  target: string,
  viewport: TerminalViewport,
): TerminalObservation {
  const args = [
    "terminal",
    "session",
    "observe",
    target,
    "--cols",
    String(viewport.cols),
    "--rows",
    String(viewport.rows),
  ];
  const child = streamArgv(cfg.herdrBin, args);

  const queue = new RecordQueue<TerminalRecord>();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let recordDrift: string | null = null;

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    try {
      queue.push(parseTerminalRecord(line));
    } catch (cause) {
      // A record helm cannot parse means the stream is no longer trustworthy.
      recordDrift = `herdr terminal session observe ${target}: ${errorMessage(cause)}`;
      child.kill("SIGTERM");
      queue.fail(recordDrift);
    }
  });

  const exit = child.exit.then((result) => {
    if (result.error !== null) queue.fail(result.error);
    else queue.end();
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      error:
        recordDrift ??
        result.error ??
        (result.exitCode === 0 || result.exitCode === null
          ? null
          : `${child.argv[0]}: exited ${result.exitCode}: ${stderr.trim()}`),
    };
  });

  return {
    argv: child.argv,
    exit,
    close: () => child.kill("SIGTERM"),
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  };
}

// ---------------------------------------------------------------------------
// One-shot pane commands
// ---------------------------------------------------------------------------

/**
 * Send `command` to a pane followed by Enter.
 *
 * Stateless: it needs no attach ownership, so it never contends with a desktop
 * client. `command` is passed as separate argv elements and is never joined
 * into a shell string.
 */
export function paneRun(
  cfg: HelmConfig,
  paneId: string,
  command: readonly string[],
): Promise<ExecResult> {
  if (command.length === 0) {
    return Promise.reject(new Error("paneRun: command must have at least one element"));
  }
  return runArgv(cfg.herdrBin, ["pane", "run", paneId, ...command]);
}

/** Send named key presses to a pane (`esc` is the canonical Escape name). */
export function paneSendKeys(
  cfg: HelmConfig,
  paneId: string,
  keys: readonly string[],
): Promise<ExecResult> {
  if (keys.length === 0) {
    return Promise.reject(new Error("paneSendKeys: keys must have at least one element"));
  }
  return runArgv(cfg.herdrBin, ["pane", "send-keys", paneId, ...keys]);
}

/**
 * Send literal text to a pane WITHOUT a trailing Enter.
 *
 * This is what a keyboard-shaped surface needs: {@link paneRun} appends Enter,
 * so it can only submit whole lines. `text` is one argv element and is never
 * joined into a shell string. Submitting is a separate `enter` key press, so
 * helm still sends only whole lines plus the bounded key set — never a raw
 * byte stream.
 */
export function paneSendText(
  cfg: HelmConfig,
  paneId: string,
  text: string,
): Promise<ExecResult> {
  if (text === "") {
    return Promise.reject(new Error("paneSendText: text must not be empty"));
  }
  return runArgv(cfg.herdrBin, ["pane", "send-text", paneId, text]);
}

/**
 * Surface a helm inbox nudge through Herdr's native notification channel.
 *
 * This is deliberately a one-shot display operation: it does not attach to,
 * start, stop, or otherwise control any Herdr lifecycle resource.
 */
export function showHerdrNotification(
  cfg: HelmConfig,
  title: string,
  body: string,
): Promise<ExecResult> {
  return runArgv(cfg.herdrBin, [
    "notification",
    "show",
    "--title",
    notificationText(title),
    "--body",
    notificationText(body),
  ]);
}

/** Keep adapter-supplied display text inert in Herdr's terminal UI. */
function notificationText(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized === "" ? "helm notification" : normalized;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const agentStatusSchema = z.enum(["idle", "working", "blocked", "done", "unknown"]);
export type HerdrAgentStatus = z.infer<typeof agentStatusSchema>;

const agentSessionSchema = z.object({
  source: z.string(),
  agent: z.string(),
  kind: z.enum(["id", "path"]),
  value: z.string(),
});

const paneScrollSchema = z.object({
  offset_from_bottom: z.number().int().nonnegative(),
  max_offset_from_bottom: z.number().int().nonnegative(),
  viewport_rows: z.number().int().nonnegative(),
});

/** A Herdr pane. Required fields follow the protocol-20 `PaneInfo` schema. */
export const herdrPaneSchema = z.object({
  pane_id: z.string(),
  terminal_id: z.string(),
  workspace_id: z.string(),
  tab_id: z.string(),
  focused: z.boolean(),
  agent_status: agentStatusSchema,
  revision: z.number().int().nonnegative(),
  agent: z.string().nullish(),
  agent_session: agentSessionSchema.nullish(),
  cwd: z.string().nullish(),
  foreground_cwd: z.string().nullish(),
  title: z.string().nullish(),
  terminal_title: z.string().nullish(),
  terminal_title_stripped: z.string().nullish(),
  scroll: paneScrollSchema.nullish(),
});
export type HerdrPane = z.infer<typeof herdrPaneSchema>;

/**
 * A pane as reported by `herdr agent list`.
 *
 * `agent` follows protocol-20 `AgentInfo`, which types it `["string","null"]`
 * and does not require it. helm models it exactly as {@link herdrPaneSchema}
 * does over the same Herdr field: demanding more than the protocol promises
 * would fail loudly on a response that is in fact valid.
 */
export const herdrAgentSchema = z.object({
  pane_id: z.string(),
  workspace_id: z.string(),
  tab_id: z.string(),
  terminal_id: z.string(),
  agent: z.string().nullish(),
  agent_status: agentStatusSchema,
  focused: z.boolean(),
  agent_session: agentSessionSchema.nullish(),
  cwd: z.string().nullish(),
  foreground_cwd: z.string().nullish(),
  terminal_title: z.string().nullish(),
  terminal_title_stripped: z.string().nullish(),
  state_change_seq: z.number().int().nonnegative().nullish(),
});
export type HerdrAgent = z.infer<typeof herdrAgentSchema>;

/** The CLI's response envelope: `{"id":…,"result":{…}}`. */
function cliResultSchema<T extends z.ZodTypeAny>(result: T) {
  return z.object({ id: z.string(), result });
}

const agentListSchema = cliResultSchema(
  z.object({ type: z.literal("agent_list"), agents: z.array(herdrAgentSchema) }),
);

const paneListSchema = cliResultSchema(
  z.object({ type: z.literal("pane_list"), panes: z.array(herdrPaneSchema) }),
);

/** List every pane Herdr has detected an agent in. */
export async function agentList(cfg: HelmConfig): Promise<HerdrAgent[]> {
  const result = await runHerdr(cfg, ["agent", "list"]);
  const label = "herdr agent list";
  return validate(agentListSchema, parseJson(result.stdout, label), label).result.agents;
}

/** List panes, optionally within one workspace. */
export async function paneList(cfg: HelmConfig, workspaceId?: string): Promise<HerdrPane[]> {
  const args = workspaceId === undefined
    ? ["pane", "list"]
    : ["pane", "list", "--workspace", workspaceId];
  const result = await runHerdr(cfg, args);
  const label = "herdr pane list";
  return validate(paneListSchema, parseJson(result.stdout, label), label).result.panes;
}

// ---------------------------------------------------------------------------
// events.subscribe
// ---------------------------------------------------------------------------

/**
 * A subscription request.
 *
 * Note the asymmetry, which is protocol-20's own: subscriptions are named with
 * dots (`pane.created`) while the events they deliver are named with
 * underscores (`pane_created`) — except the three parameterized kinds, which
 * keep their dotted name on the wire.
 */
export type HerdrSubscription =
  | {
      /** Per-pane only: protocol 20 requires `pane_id` on this variant. */
      readonly type: "pane.agent_status_changed";
      readonly pane_id: string;
      readonly agent_status?: HerdrAgentStatus | null;
    }
  | {
      readonly type: "pane.output_matched";
      readonly pane_id: string;
      readonly source: "visible" | "recent" | "recent_unwrapped" | "detection";
      readonly match: { readonly type: "substring" | "regex"; readonly value: string };
    }
  | { readonly type: "pane.created" }
  | { readonly type: "pane.closed" };

export const paneAgentStatusChangedSchema = z.object({
  pane_id: z.string(),
  workspace_id: z.string(),
  agent_status: agentStatusSchema,
  agent: z.string().nullish(),
  display_agent: z.string().nullish(),
  title: z.string().nullish(),
});
export type PaneAgentStatusChanged = z.infer<typeof paneAgentStatusChangedSchema>;

const paneReadResultSchema = z.object({
  pane_id: z.string(), workspace_id: z.string(), tab_id: z.string(),
  source: z.enum(["visible", "recent", "recent_unwrapped", "detection"]), format: z.string(), text: z.string(),
  revision: z.number().int().nonnegative(), truncated: z.boolean(),
});
export const paneOutputMatchedSchema = z.object({
  pane_id: z.string(), matched_line: z.string(), read: paneReadResultSchema,
});
export type PaneOutputMatched = z.infer<typeof paneOutputMatchedSchema>;

export const paneCreatedSchema = z.object({
  type: z.literal("pane_created"),
  pane: herdrPaneSchema,
});

export const paneClosedSchema = z.object({
  type: z.literal("pane_closed"),
  pane_id: z.string(),
  workspace_id: z.string(),
});

/** A delivered event, discriminated by its wire `event` name. */
export const herdrEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("pane.agent_status_changed"), data: paneAgentStatusChangedSchema }),
  z.object({ event: z.literal("pane.output_matched"), data: paneOutputMatchedSchema }),
  z.object({ event: z.literal("pane_created"), data: paneCreatedSchema }),
  z.object({ event: z.literal("pane_closed"), data: paneClosedSchema }),
]);
export type HerdrEvent = z.infer<typeof herdrEventSchema>;

/** The wire names helm models. Anything else is another Herdr feature's event. */
const MODELLED_EVENT_NAMES: ReadonlySet<string> = new Set(
  herdrEventSchema.options.map((option) => option.shape.event.value),
);

const eventEnvelopeSchema = z.object({ event: z.string() });

/**
 * Parse one line from the event stream.
 *
 * Discriminates on the event NAME first. A name helm does not model returns
 * `null`, so a Herdr upgrade that adds event kinds cannot break the stream. A
 * name helm DOES model whose payload has drifted throws: a silent drop would
 * leave the status stream permanently quiet with nothing reporting it
 * (SPEC R2/R3 — a contract drift must fail loudly, never mis-parse).
 */
export function parseHerdrEvent(line: string): HerdrEvent | null {
  const raw = parseJson(line, "herdr event");
  const envelope = eventEnvelopeSchema.safeParse(raw);
  if (!envelope.success || !MODELLED_EVENT_NAMES.has(envelope.data.event)) return null;
  return validate(herdrEventSchema, raw, `herdr event ${envelope.data.event}`);
}

export interface HerdrEventStream {
  /** Resolves once the server has acknowledged the subscription. */
  readonly ready: Promise<void>;
  /** Resolves when the stream ends; rejects on a transport failure. */
  readonly closed: Promise<void>;
  close(): void;
}

const subscribeAckSchema = z.object({
  result: z.object({ type: z.literal("subscription_started") }),
});

/** Protocol-20 `error_response`. It carries no `event`, so it is not an event. */
const errorResponseSchema = z.object({
  id: z.string(),
  error: z.object({ code: z.string(), message: z.string() }),
});

/**
 * Read a control-socket error frame, or `null` when the line is not one.
 *
 * The server can answer a request with `{id, error}` at any point. Treating it
 * as an unmodelled event would discard it and leave the stream silently quiet.
 */
export function parseHerdrErrorResponse(value: unknown): string | null {
  const parsed = errorResponseSchema.safeParse(value);
  return parsed.success ? `${parsed.data.error.code}: ${parsed.data.error.message}` : null;
}

/**
 * Open one control-socket connection and subscribe to `subscriptions`.
 *
 * `onEvent` is called for each event helm models. A line naming an event kind
 * helm does not model is ignored, so a Herdr upgrade that adds kinds cannot
 * break the stream; a drifted payload on a kind helm DOES model, and a server
 * `error_response` frame, both close the stream and reject
 * {@link HerdrEventStream.closed}.
 */
export function subscribeEvents(
  cfg: HelmConfig,
  subscriptions: readonly HerdrSubscription[],
  onEvent: (event: HerdrEvent) => void,
): HerdrEventStream {
  if (subscriptions.length === 0) {
    throw new Error("subscribeEvents: at least one subscription is required");
  }

  const socket: Socket = connect(cfg.herdrSocketPath);
  socket.setEncoding("utf8");

  let acknowledge: () => void;
  let rejectReady: (cause: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    acknowledge = resolve;
    rejectReady = reject;
  });
  let acknowledged = false;

  const closed = new Promise<void>((resolve, reject) => {
    const fail = (message: string): void => {
      const error = new Error(message);
      if (!acknowledged) rejectReady(error);
      socket.destroy();
      reject(error);
    };

    socket.on("connect", () => {
      const request = {
        id: `helm:events:${process.pid}`,
        method: "events.subscribe",
        params: { subscriptions },
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });

    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      const raw = safeParseJson(line);
      const errorResponse = parseHerdrErrorResponse(raw);
      if (errorResponse !== null) {
        fail(`herdr events.subscribe: ${errorResponse}`);
        return;
      }
      if (!acknowledged) {
        const ack = subscribeAckSchema.safeParse(raw);
        if (!ack.success) {
          fail(`herdr events.subscribe was not acknowledged: ${line}`);
          return;
        }
        acknowledged = true;
        acknowledge();
        return;
      }
      let event: HerdrEvent | null;
      try {
        event = parseHerdrEvent(line);
      } catch (cause) {
        // A drifted payload on a modelled event tears the subscription down and
        // reaches the caller. Swallowing it here is what leaves a stream quiet.
        fail(errorMessage(cause));
        return;
      }
      if (event !== null) onEvent(event);
    });

    socket.on("error", (cause) => fail(`herdr socket ${cfg.herdrSocketPath}: ${cause.message}`));
    socket.on("close", () => {
      if (!acknowledged) {
        fail(`herdr socket ${cfg.herdrSocketPath}: closed before the subscription was acknowledged`);
        return;
      }
      resolve();
    });
  });
  // Both promises are handed to the caller; pre-attach no-op handlers so a
  // failure the caller has not awaited yet is not an unhandled rejection.
  closed.catch(() => undefined);
  ready.catch(() => undefined);

  return { ready, closed, close: () => socket.destroy() };
}

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

export interface HerdrDoctorResult {
  readonly ok: boolean;
  readonly binary: string;
  /** Protocol the local Herdr reports, or `null` if it could not be read. */
  readonly protocol: number | null;
  readonly minProtocol: number;
  readonly socketPath: string;
  readonly socketPresent: boolean;
  /** Whether the control socket completed a compatible Herdr health request. */
  readonly socketReachable: boolean;
  /** One specific sentence per failed check. Empty when `ok`. */
  readonly problems: readonly string[];
}

const schemaEnvelopeSchema = z.object({ protocol: z.number().int().positive() });
const socketSnapshotSchema = z.object({
  id: z.string(),
  result: z.object({
    type: z.literal("session_snapshot"),
    snapshot: z.object({ protocol: z.number().int().positive() }),
  }),
});

/**
 * Assert that Herdr is present, speaks a protocol helm understands, and that
 * the control socket answers a Herdr health check at that protocol. Reports
 * every problem it finds rather than the first.
 */
export async function herdrDoctor(cfg: HelmConfig): Promise<HerdrDoctorResult> {
  const problems: string[] = [];

  const result = await runArgv(cfg.herdrBin, ["api", "schema", "--json"]);
  let protocol: number | null = null;
  if (result.exitCode !== 0) {
    problems.push(
      result.error !== null
        ? `herdr missing or not runnable as ${JSON.stringify(cfg.herdrBin)}: ${result.error}`
        : `could not read the Herdr API schema: ${describeFailure(result)}`,
    );
  } else {
    const parsed = schemaEnvelopeSchema.safeParse(safeParseJson(result.stdout));
    if (!parsed.success) {
      problems.push("herdr api schema --json did not report a numeric protocol");
    } else {
      protocol = parsed.data.protocol;
      if (protocol < HERDR_MIN_PROTOCOL) {
        problems.push(
          `Herdr protocol ${protocol} is older than the ${HERDR_MIN_PROTOCOL} helm requires; upgrade herdr`,
        );
      }
    }
  }

  const socketPresent = isSocket(cfg.herdrSocketPath);
  let socketReachable = false;
  if (!socketPresent) {
    problems.push(
      `no Herdr control socket at ${cfg.herdrSocketPath}; is the Herdr server running?`,
    );
  } else {
    const socketProbe = await probeSocket(cfg.herdrSocketPath);
    socketReachable = typeof socketProbe !== "string" && socketProbe.protocol >= HERDR_MIN_PROTOCOL;
    if (typeof socketProbe === "string") {
      problems.push(
        `Herdr control socket at ${cfg.herdrSocketPath} did not complete a Herdr health check; is the Herdr server running? (${socketProbe})`,
      );
    } else if (!socketReachable) {
      problems.push(
        `Herdr control socket at ${cfg.herdrSocketPath} reported protocol ${socketProbe.protocol}, older than the ${HERDR_MIN_PROTOCOL} helm requires`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    binary: cfg.herdrBin,
    protocol,
    minProtocol: HERDR_MIN_PROTOCOL,
    socketPath: cfg.herdrSocketPath,
    socketPresent,
    socketReachable,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runHerdr(cfg: HelmConfig, args: readonly string[]): Promise<ExecResult> {
  const result = await runArgv(cfg.herdrBin, args);
  if (result.exitCode !== 0) throw new Error(describeFailure(result));
  return result;
}

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

function probeSocket(path: string): Promise<{ protocol: number } | string> {
  return new Promise((resolve) => {
    const socket = connect(path);
    let settled = false;
    const id = `helm:doctor:${process.pid}:${Date.now()}`;
    const finish = (result: { protocol: number } | string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish("health check timed out"), 1_000);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("error", (cause: Error) => finish(cause.message));
    lines.once("line", (line) => {
      const raw = safeParseJson(line);
      const error = parseHerdrErrorResponse(raw);
      if (error !== null) {
        finish(`session.snapshot was refused: ${error}`);
        return;
      }
      const response = socketSnapshotSchema.safeParse(raw);
      if (!response.success || response.data.id !== id) {
        finish("session.snapshot did not return a Herdr session snapshot");
        return;
      }
      finish({ protocol: response.data.result.snapshot.protocol });
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method: "session.snapshot", params: {} })}\n`);
    });
    socket.on("error", (cause: NodeJS.ErrnoException) => finish(cause.code ?? cause.message));
    socket.once("close", () => finish("socket closed before health check completed"));
  });
}

/**
 * Schema-check a decoded Herdr payload, naming the seam and the offending
 * fields so a protocol drift reads as a diagnosis rather than a raw ZodError.
 */
function validate<T extends z.ZodTypeAny>(schema: T, value: unknown, label: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} does not match the contract helm reads: ${issues}`);
  }
  return parsed.data as z.infer<T>;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${label}: output is not JSON: ${errorMessage(cause)}`);
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Backpressure-free async queue bridging an event emitter to `for await`. */
class RecordQueue<T> {
  #buffered: T[] = [];
  #waiting: ((value: IteratorResult<T>) => void)[] = [];
  #rejectors: ((cause: Error) => void)[] = [];
  #done = false;
  #failure: Error | null = null;

  push(value: T): void {
    if (this.#done) return;
    const waiter = this.#waiting.shift();
    this.#rejectors.shift();
    if (waiter !== undefined) waiter({ value, done: false });
    else this.#buffered.push(value);
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const waiter of this.#waiting) waiter({ value: undefined, done: true });
    this.#waiting = [];
    this.#rejectors = [];
  }

  fail(message: string): void {
    if (this.#done) return;
    this.#failure = new Error(message);
    this.#done = true;
    for (const reject of this.#rejectors) reject(this.#failure);
    this.#waiting = [];
    this.#rejectors = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.#buffered.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.#failure !== null) return Promise.reject(this.#failure);
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiting.push(resolve);
          this.#rejectors.push(reject);
        });
      },
    };
  }
}
