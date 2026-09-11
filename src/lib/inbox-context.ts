/**
 * Renders one inbox card as a context block the human can paste into the
 * terminal composer and write an instruction around ("add to chat").
 *
 * Two constraints shape the format, and both are hard:
 *
 * 1. **One line.** The composer posts to `/api/term/input`, which submits the
 *    line with a trailing Enter (`herdr pane run`). A newline or tab would
 *    become a second pane submission, so every field is flattened and control
 *    characters are stripped here rather than refused later
 *    (`converseTextSchema` in `request.ts`).
 * 2. **Inert text.** Card fields are adapter-derived untrusted input. Nothing
 *    here is an instruction to the agent reading the pane — the block is
 *    labelled as quoted card content so the human's own words stay separable.
 *
 * Pure and framework-free, so the format is unit-testable without a DOM.
 */
import { KIND_LABELS } from "./inbox-view";
import type { InboxItem } from "./types";

/** Separates the labelled segments. Distinct enough to survive a wrapped line. */
const SEPARATOR = " · ";

/**
 * Flatten one field to a single line.
 *
 * Newlines, tabs, and other C0 controls collapse to a single space: they are
 * the exact characters the pane input schema rejects, and a card body is very
 * often multi-line (a task note, a status line, a held reason).
 */
export function flattenField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** `Label: value`, or nothing when the value is absent or empty once flattened. */
function segment(label: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const flat = flattenField(value);
  return flat === "" ? null : `${label}: ${flat}`;
}

/**
 * The full context of one card, as one line.
 *
 * Everything the human needs to write an informed instruction about the item:
 * what it is, what it asks, what it will accept, who it concerns, and where it
 * came from. Ordered most- to least-decisive, because a long block wraps and
 * the first clause is what stays visible.
 */
export function inboxItemContext(item: InboxItem): string {
  const head = `[helm card — ${KIND_LABELS[item.kind]} (${item.urgency})]`;
  const segments = [
    segment("Title", item.title),
    // The question or report itself. On an ask and an answer card this IS the
    // payload, so it is never abbreviated here.
    segment("Detail", item.detail),
    segment("About", item.about),
    segment("Task", item.taskId),
    segment("Repo", item.repo),
    item.options.length > 0
      ? `Options: ${item.options.map((option) => flattenField(option.label)).join(" | ")}`
      : null,
    item.allowFreeform && item.options.length > 0 ? "Also accepts a typed reply" : null,
    segment("Recommended", item.recommendValue),
    segment("Ref", item.ref),
    item.evidence.length > 0
      ? `Evidence: ${item.evidence.map((entry) => flattenField(entry.path)).join(", ")}`
      : null,
    segment("Answer routes", describeChannel(item)),
    segment("Source", item.source),
    segment("Card", item.id),
    segment("Opened", item.openedAt),
    item.state === "open" ? null : segment("State", item.answer === undefined ? item.state : `${item.state} — ${item.answer}`),
  ].filter((value): value is string => value !== null);

  return `${head} ${segments.join(SEPARATOR)}`;
}

/**
 * How an answer would reach firstmate, in plain words.
 *
 * Reports the channel the card DECLARED. It is provenance for the human, not a
 * routing decision — the Responder re-derives the real channel under D-C.
 */
function describeChannel(item: InboxItem): string | undefined {
  switch (item.respond.channel) {
    case "none":
      return "read-only, no reply channel";
    case "resolve-key":
      return `decision key ${item.respond.key ?? "(unset)"} on task ${item.respond.target ?? item.taskId ?? "(unset)"}`;
    case "captain-hold":
      return `captain hold on task ${item.respond.target ?? item.taskId ?? "(unset)"}`;
    case "relay":
      return `relay into pane ${item.respond.target ?? "(unset)"}`;
  }
}

/**
 * Append a context block to whatever the human has already typed.
 *
 * Never overwrites: the draft is the human's, and the block is additive. A
 * single space joins them so the composer reads as one sentence-in-progress.
 */
export function appendContext(draft: string, block: string): string {
  const existing = draft.trimEnd();
  return existing === "" ? block : `${existing} ${block}`;
}
