/**
 * Routes an answered inbox item into firstmate (SPEC §5.5, decision D-C).
 *
 * helm is a channel, not an authority: every `--resolve-key`, task id, and
 * close mode comes verbatim from the card. The Responder never invents them,
 * never builds `fm-<id>`, and never writes a decision record itself.
 *
 * Ratified routing (captain 2026-09-06, SPEC option (a)):
 *
 * | Item class                                              | Channel      |
 * | ------------------------------------------------------- | ------------ |
 * | Keyed status decision on a crew task                    | resolve-key  |
 * | Captain-held backlog task                               | relay        |
 * | Merge approval, credential, destructive/security-sens.  | relay always |
 * | Freeform reply / instruction                            | relay        |
 *
 * `captain-hold` remains an executable channel when a card declares it; D-C
 * still forces merge/credential through relay. Every attempt is audited.
 */
import type { HelmConfig } from "./config";
import { auditEntryFromResult, type AuditWriter } from "./audit";
import { captainHoldAnswers, sendResolveKey } from "./fm";
import { paneRun } from "./herdr";
import { describeFailure, succeeded, type ExecResult } from "./exec";
import type {
  InboxItem,
  InboxItemKind,
  RespondAction,
  RespondChannel,
  RespondResult,
} from "./types";

export class ResponderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponderError";
  }
}

export interface Responder {
  respond(item: InboxItem, action: RespondAction): Promise<RespondResult>;
}

export interface ResponderOptions {
  readonly config: HelmConfig;
  readonly audit: AuditWriter;
  /**
   * Override channel executors in tests. Production leaves these unset and
   * uses the real firstmate / Herdr seams.
   */
  readonly exec?: Partial<ChannelExecutors>;
}

export interface ChannelExecutors {
  resolveKey(item: InboxItem, answer: string): Promise<RespondResult>;
  captainHold(item: InboxItem, answer: string): Promise<RespondResult>;
  relay(item: InboxItem, answer: string): Promise<RespondResult>;
}

/** Kinds that must never take a direct path (D-C hard rule). */
const ALWAYS_RELAY_KINDS: ReadonlySet<InboxItemKind> = new Set(["merge", "credential"]);

/**
 * Pick the channel for an item under D-C.
 *
 * Merge and credential always relay, even if a card declared something else.
 * Every other class honours the channel the adapter put on the card — adapters
 * are responsible for declaring resolve-key only for keyed status decisions.
 */
export function routeChannel(item: InboxItem): RespondChannel {
  if (ALWAYS_RELAY_KINDS.has(item.kind)) return "relay";
  return item.respond.channel;
}

export function createResponder(options: ResponderOptions): Responder {
  const executors: ChannelExecutors = {
    resolveKey: options.exec?.resolveKey ?? ((item, answer) => defaultResolveKey(options.config, item, answer)),
    captainHold: options.exec?.captainHold ?? ((item, answer) => defaultCaptainHold(options.config, item, answer)),
    relay: options.exec?.relay ?? ((item, answer) => defaultRelay(options.config, item, answer)),
  };

  return {
    async respond(item: InboxItem, action: RespondAction): Promise<RespondResult> {
      const answer = requireAnswer(action);
      const channel = routeChannel(item);

      if (channel === "none") {
        const refused = refusedResult("none", `item ${item.id} declares channel "none" and cannot be answered`);
        options.audit.append(auditEntryFromResult(item.id, action, refused));
        return refused;
      }

      // Safety: never let a merge/credential slip through a non-relay path even
      // if an executor override is installed for tests of other channels.
      if (ALWAYS_RELAY_KINDS.has(item.kind) && channel !== "relay") {
        const refused = refusedResult(
          channel,
          `item ${item.id} kind ${item.kind} must relay; refusing channel ${channel}`,
        );
        options.audit.append(auditEntryFromResult(item.id, action, refused));
        return refused;
      }

      let result: RespondResult;
      try {
        switch (channel) {
          case "resolve-key":
            result = await executors.resolveKey(item, answer);
            break;
          case "captain-hold":
            result = await executors.captainHold(item, answer);
            break;
          case "relay":
            result = await executors.relay(item, answer);
            break;
          default: {
            const _exhaustive: never = channel;
            throw new ResponderError(`unknown channel: ${String(_exhaustive)}`);
          }
        }
      } catch (cause) {
        result = refusedResult(
          channel,
          cause instanceof Error ? cause.message : String(cause),
        );
      }

      options.audit.append(auditEntryFromResult(item.id, action, result));
      return result;
    },
  };
}

function requireAnswer(action: RespondAction): string {
  const value = action.value ?? action.text;
  if (value === undefined || value.trim() === "") {
    throw new ResponderError("respond action needs a non-empty value or text");
  }
  return value;
}

/**
 * Task id for a resolve-key / captain-hold call.
 *
 * Taken verbatim from `respond.target` or `taskId`. Never prefixed, never
 * rewritten — identity resolution belongs to fm-send / fm-captain-hold.
 */
function requireTaskId(item: InboxItem): string {
  const taskId = item.respond.target ?? item.taskId;
  if (taskId === undefined || taskId.trim() === "") {
    throw new ResponderError(
      `item ${item.id} has no task id; respond.target or taskId must be set verbatim from the fold`,
    );
  }
  return taskId;
}

function requireDecisionKey(item: InboxItem): string {
  const key = item.respond.key;
  if (key === undefined || key.trim() === "") {
    throw new ResponderError(
      `item ${item.id} has no decision key; respond.key must come verbatim from the fold`,
    );
  }
  return key;
}

function requireRelayPane(item: InboxItem): string {
  const paneId = item.respond.target;
  if (paneId === undefined || paneId.trim() === "") {
    throw new ResponderError(
      `item ${item.id} has no relay pane; respond.target must be the firstmate pane id`,
    );
  }
  return paneId;
}

async function defaultResolveKey(
  cfg: HelmConfig,
  item: InboxItem,
  answer: string,
): Promise<RespondResult> {
  return sendResolveKey(cfg, {
    taskId: requireTaskId(item),
    key: requireDecisionKey(item),
    answer,
  });
}

async function defaultCaptainHold(
  cfg: HelmConfig,
  item: InboxItem,
  answer: string,
): Promise<RespondResult> {
  return captainHoldAnswers(
    cfg,
    [
      {
        taskId: requireTaskId(item),
        answer,
        label: `helm:${item.id}`,
        close: item.respond.close,
      },
    ],
    { source: "helm" },
  );
}

/**
 * Type the answer into firstmate's pane.
 *
 * The text is one argv element to `herdr pane run` — never a shell string —
 * and is prefixed with the card id so firstmate can see which card it answers.
 */
async function defaultRelay(
  cfg: HelmConfig,
  item: InboxItem,
  answer: string,
): Promise<RespondResult> {
  const paneId = requireRelayPane(item);
  const message = `[helm ${item.id}] ${answer}`;
  const result = await paneRun(cfg, paneId, [message]);
  return toRelayResult(result);
}

function toRelayResult(result: ExecResult): RespondResult {
  const attempt = {
    channel: "relay" as const,
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

function refusedResult(channel: RespondChannel, error: string): RespondResult {
  return {
    ok: false,
    channel,
    argv: [],
    exitCode: null,
    stdout: "",
    stderr: "",
    at: new Date().toISOString(),
    error,
  };
}
