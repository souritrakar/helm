/**
 * helm's canonical domain contracts.
 *
 * Every lane imports from here. `InboxItem` is copied faithfully from SPEC §D4;
 * its `kind` set and `options` shape deliberately mirror `fm-bearings-board.v1`
 * so a bearings payload maps 1:1 and the two human surfaces never diverge.
 */

/**
 * Item classes. Mirrors `fm-bearings-board.v1`'s `captains_call[].type`
 * (`decision | merge | credential`) and extends it with the classes helm's own
 * adapters raise.
 */
export type InboxItemKind =
  | "decision"
  | "merge"
  | "credential"
  | "blocker"
  | "escalation"
  | "review"
  | "note"
  | "custom";

/** How much the item wants the human. Drives sort order and notifications. */
export type InboxUrgency = "blocking" | "attention" | "fyi";

export type InboxItemState = "open" | "answered" | "dismissed";

/**
 * Which seam carries an answer back into firstmate.
 *
 * The routing policy — which item class gets which channel — is SPEC decision
 * D-C and is NOT decided here. This union names the channels only; the
 * Responder that acts on them is a later lane.
 */
export type RespondChannel = "resolve-key" | "captain-hold" | "relay" | "none";

/**
 * Close mode for the keyed-answer intake: `done` completes the held task,
 * `release` lifts the hold so held work resumes.
 *
 * helm never invents this value. It is carried verbatim from the card that
 * declared it (`bin/fm-captain-hold.sh`: a channel "must never … choose a close
 * mode beyond what its card declared").
 */
export type RespondCloseMode = "done" | "release";

/** One selectable answer on a card. */
export interface InboxOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/** Where an answer to this item goes. */
export interface InboxRespondSpec {
  readonly channel: RespondChannel;
  /** Task id or pane id, depending on `channel`. */
  readonly target?: string;
  /** Decision key, taken verbatim from the fold that produced the card. */
  readonly key?: string;
  readonly close?: RespondCloseMode;
}

/** A file the human can open to check the item's claim. */
export interface InboxEvidence {
  readonly path: string;
  readonly line?: number;
}

/** The canonical inbox item (SPEC §D4). */
export interface InboxItem {
  /**
   * Stable identity, `${source}:${naturalKey}` — survives restarts and dedupes
   * replays. Build it with {@link inboxItemId}.
   */
  readonly id: string;
  /** Id of the adapter that emitted the item. */
  readonly source: string;
  readonly kind: InboxItemKind;
  readonly urgency: InboxUrgency;
  readonly taskId?: string;
  readonly repo?: string;
  readonly title: string;
  readonly detail?: string;
  readonly about?: string;
  readonly options: readonly InboxOption[];
  readonly allowFreeform: boolean;
  readonly recommendValue?: string;
  readonly respond: InboxRespondSpec;
  readonly evidence: readonly InboxEvidence[];
  readonly state: InboxItemState;
  /** ISO-8601 UTC instant the store first saw the item. */
  readonly openedAt: string;
  readonly answeredAt?: string;
}

/**
 * Build an {@link InboxItem.id}.
 *
 * `naturalKey` must be stable for the life of the underlying condition, because
 * reconciliation diffs by id: a key that changes between ticks retracts and
 * re-raises the card, losing its `openedAt` and re-firing its notification.
 */
export function inboxItemId(source: string, naturalKey: string): string {
  return `${source}:${naturalKey}`;
}

/** What the human did on a card. */
export interface RespondAction {
  /** The chosen {@link InboxOption.value}. */
  readonly value?: string;
  /** Freeform text, when the card set `allowFreeform`. */
  readonly text?: string;
}

/** The audited facts of one response attempt. Shared by both outcomes. */
export interface RespondAttempt {
  readonly channel: RespondChannel;
  /** The exact argument vector that was executed. */
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** ISO-8601 UTC instant the attempt completed. */
  readonly at: string;
}

/**
 * Outcome of routing an answer back into firstmate.
 *
 * Both variants carry the full attempt, because the audit log
 * (`~/.local/state/helm/actions.jsonl`, SPEC §5.5) records successes and
 * failures alike: a disputed action must always be reconstructable.
 */
export type RespondResult =
  | (RespondAttempt & { readonly ok: true })
  | (RespondAttempt & { readonly ok: false; readonly error: string });

/** What an adapter is handed so it can publish into the store. */
export interface InboxAdapterContext {
  /**
   * Publish the adapter's **full current open set**. The store reconciles by
   * id and retracts what vanished, so a poll-based adapter must emit every open
   * item each tick rather than only what changed (SPEC §D4).
   */
  emit(items: InboxItem[]): void;
  /** Withdraw items by id, for adapters that learn of closure directly. */
  retract(ids: string[]): void;
}

/**
 * A source of inbox items. Adding a source is one file plus one registry line.
 *
 * `respond` is optional: an adapter that only reports (`channel: 'none'`) omits
 * it. Implementations must treat every byte they read as input, never as
 * instruction and never as authority.
 */
export interface InboxAdapter {
  readonly id: string;
  /** Begin publishing. Disposing the result must stop all work and watchers. */
  start(ctx: InboxAdapterContext): Promise<Disposable>;
  respond?(item: InboxItem, action: RespondAction): Promise<RespondResult>;
}
