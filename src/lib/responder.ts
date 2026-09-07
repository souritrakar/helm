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
 * `routeChannel` forces `captain-hold`, merge, and credential through relay
 * (captain decision `dc-captain-hold-direct-path`, 2026-09-07). The
 * `captain-hold` executor remains for tests that call it directly; production
 * routing never selects it. Every attempt is audited.
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
const ALWAYS_RELAY_KINDS: ReadonlySet<InboxItemKind> = new Set([
  "merge",
  "credential",
  "captain-held",
  "destructive",
  "irreversible",
  "security-sensitive",
]);

/**
 * Pick the channel for an item under D-C.
 *
 * Only typed keyed status decisions may use `resolve-key`. All other actionable
 * items relay; informational cards remain non-actionable.
 */
export function routeChannel(item: InboxItem): RespondChannel {
  if (ALWAYS_RELAY_KINDS.has(item.kind)) return "relay";
  if (item.respond.channel === "none") return "none";
  if (
    item.kind === "status-decision" &&
    !item.allowFreeform &&
    item.respond.channel === "resolve-key"
  ) {
    return "resolve-key";
  }
  return "relay";
}

export function createResponder(options: ResponderOptions): Responder {
  const executors: ChannelExecutors = {
    resolveKey: options.exec?.resolveKey ?? ((item, answer) => defaultResolveKey(options.config, item, answer)),
    captainHold: options.exec?.captainHold ?? ((item, answer) => defaultCaptainHold(options.config, item, answer)),
    relay: options.exec?.relay ?? ((item, answer) => defaultRelay(options.config, item, answer)),
  };

  return {
    async respond(item: InboxItem, action: RespondAction): Promise<RespondResult> {
      const channel = routeChannel(item);
      let answer: string;
      try {
        answer = requireAnswer(action);
      } catch (cause) {
        const refused = refusedResult(
          channel,
          cause instanceof Error ? cause.message : String(cause),
        );
        options.audit.append(auditEntryFromResult(item.id, action, refused));
        return refused;
      }

      if (channel === "none") {
        const refused = refusedResult("none", `item ${item.id} declares channel "none" and cannot be answered`);
        options.audit.append(auditEntryFromResult(item.id, action, refused));
        return refused;
      }

      // routeChannel already forces captain-hold / merge / credential to relay;
      // this belt check covers a kind override that somehow skipped that.
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
            // Unreachable via routeChannel (forced to relay); kept for exhaustiveness.
            result = await executors.captainHold(item, answer);
            break;
          case "relay":
            // Enforce before any executor (including test overrides). Guard the
            // composed pane message too — item.id is adapter-derived untrusted
            // input and must not inject a second Enter submission.
            requireRelaySingleLine(answer);
            requireRelaySingleLine(item.id);
            requireRelaySingleLine(`[helm ${item.id}] ${answer}`);
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

      try {
        options.audit.append(auditEntryFromResult(item.id, action, result));
      } catch (cause) {
        if (result.ok) {
          return {
            ...result,
            auditError: cause instanceof Error ? cause.message : String(cause),
          };
        }
        throw cause;
      }
      return result;
    },
  };
}

function requireAnswer(action: RespondAction): string {
  const value =
    action.value !== undefined && action.value.trim() !== "" ? action.value : undefined;
  const text = action.text !== undefined && action.text.trim() !== "" ? action.text : undefined;
  const answer = value ?? text;
  if (answer === undefined) {
    throw new ResponderError("respond action needs a non-empty value or text");
  }
  return answer;
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

/**
 * paneRun submits one line followed by Enter. A tab, newline, or C0 control
 * in the answer would become a second pane submission (captain decision
 * `relay-answer-newline-splits-pane-input`).
 */
function requireRelaySingleLine(answer: string): void {
  if (/[\t\n\r\u0000-\u001f\u007f]/.test(answer)) {
    throw new ResponderError(
      "relay answer must be a single line without tab, newline, or control characters; paneRun would submit each line separately",
    );
  }
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
