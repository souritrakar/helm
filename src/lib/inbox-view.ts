/**
 * Presentation model for the inbox: which tab a card sits on, which bucket it
 * reads as, and what order the human sees.
 *
 * Pure and shared, so the tab counts, the sort, and the card label can never
 * disagree about the same item. It classifies only — it decides nothing about
 * routing, which belongs to the Responder (SPEC decision D-C).
 */
import type { InboxItem, InboxItemKind, InboxItemState, InboxUrgency } from "./types";

/**
 * The groups the human scans by.
 *
 * These are the three things helm exists to surface — what is pending, what
 * needs approval, and answers to questions the human asked — plus everything
 * else, which is context rather than a call to act.
 */
export type InboxBucket = "decisions" | "approvals" | "answers" | "info";

/** State tabs. One per {@link InboxItemState}. */
export type InboxTab = InboxItemState;

const BUCKET_BY_KIND: Record<InboxItemKind, InboxBucket> = {
  "status-decision": "decisions",
  decision: "decisions",
  merge: "approvals",
  credential: "approvals",
  "captain-held": "approvals",
  destructive: "approvals",
  irreversible: "approvals",
  "security-sensitive": "approvals",
  answer: "answers",
  blocker: "info",
  escalation: "info",
  review: "info",
  note: "info",
  custom: "info",
};

export const BUCKET_LABELS: Record<InboxBucket, string> = {
  decisions: "Decision",
  approvals: "Approval",
  answers: "Answer",
  info: "Info",
};

/** Which of the three buckets this card belongs to. */
export function bucketOf(item: InboxItem): InboxBucket {
  return BUCKET_BY_KIND[item.kind];
}

/** Primary sort: how much the item wants the human. */
const URGENCY_RANK: Record<InboxUrgency, number> = { blocking: 0, attention: 1, fyi: 2 };

/** Secondary sort: what the human must DO comes before what they can read. */
const BUCKET_RANK: Record<InboxBucket, number> = { decisions: 0, approvals: 1, answers: 2, info: 3 };

/**
 * Order for display: urgency, then bucket, then age.
 *
 * Open cards read oldest-first inside a band — a decision that has waited
 * longest is the one most likely to be blocking someone. Handled cards read
 * newest-first, because there the question is "what did I just do".
 */
export function sortForDisplay(items: readonly InboxItem[], tab: InboxTab): InboxItem[] {
  const handled = tab !== "open";
  return [...items].sort((a, b) => {
    if (handled) {
      const byHandledAt = (b.answeredAt ?? "").localeCompare(a.answeredAt ?? "");
      if (byHandledAt !== 0) return byHandledAt;
    }
    const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    const byBucket = BUCKET_RANK[bucketOf(a)] - BUCKET_RANK[bucketOf(b)];
    if (byBucket !== 0) return byBucket;
    return a.openedAt.localeCompare(b.openedAt);
  });
}

/** The cards belonging on `tab`, already ordered for display. */
export function itemsForTab(items: readonly InboxItem[], tab: InboxTab): InboxItem[] {
  return sortForDisplay(items.filter((item) => item.state === tab), tab);
}

/** Whether the operator can still act on this card. */
export function isActionable(item: InboxItem): boolean {
  return item.state === "open" && item.respond.channel !== "none";
}

/**
 * The control the card must render.
 *
 * `options` renders the declared answers as buttons; `text` takes a typed
 * answer; `both` offers the buttons and a typed alternative; `none` is
 * read-only, either because the card is handled or because no channel can
 * carry an answer.
 */
export type InboxControl = "options" | "text" | "both" | "none";

export function controlFor(item: InboxItem): InboxControl {
  if (!isActionable(item)) return "none";
  const hasOptions = item.options.length > 0;
  if (hasOptions && item.allowFreeform) return "both";
  if (hasOptions) return "options";
  return item.allowFreeform ? "text" : "none";
}
