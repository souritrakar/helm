/**
 * The inbox presentation model: which bucket a card reads as, which tab it
 * sits on, what order the human sees, and which control the card must render.
 *
 * These are the rules the tab counts, the sort, and the card label all share,
 * so they are asserted here once rather than through the DOM three times.
 */
import { describe, expect, it } from "vitest";

import {
  BUCKET_LABELS,
  bucketOf,
  controlFor,
  isActionable,
  itemsForTab,
  KIND_LABELS,
  notificationTitle,
  sectionsForTab,
  sortForDisplay,
} from "@/lib/inbox-view";
import { inboxItemId, type InboxItem, type InboxItemKind } from "@/lib/types";

function item(partial: Partial<InboxItem> & Pick<InboxItem, "kind">): InboxItem {
  const key = partial.title ?? partial.kind;
  return {
    id: inboxItemId("fake", key),
    source: "fake",
    urgency: "blocking",
    title: key,
    options: [],
    allowFreeform: false,
    respond: { channel: "relay", target: "w1:p1" },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T00:00:00.000Z",
    ...partial,
  };
}

describe("inbox buckets", () => {
  it.each<[InboxItemKind, string]>([
    ["status-decision", "decisions"],
    ["decision", "decisions"],
    ["merge", "approvals"],
    ["credential", "approvals"],
    ["captain-held", "approvals"],
    ["destructive", "approvals"],
    ["irreversible", "approvals"],
    ["security-sensitive", "approvals"],
    ["answer", "answers"],
    ["blocker", "info"],
    ["escalation", "info"],
    ["review", "info"],
    ["note", "info"],
    ["custom", "info"],
  ])("files %s under %s", (kind, bucket) => {
    expect(bucketOf(item({ kind }))).toBe(bucket);
  });

  it("labels every bucket, so no card can render an empty chip", () => {
    for (const label of Object.values(BUCKET_LABELS)) {
      expect(label).not.toBe("");
    }
  });
});

describe("display order", () => {
  it("sorts by urgency first, then by what the human must do", () => {
    const items = [
      item({ kind: "note", urgency: "fyi", title: "fyi note" }),
      item({ kind: "merge", urgency: "blocking", title: "blocking approval" }),
      item({ kind: "blocker", urgency: "blocking", title: "blocking info" }),
      item({ kind: "status-decision", urgency: "blocking", title: "blocking decision" }),
      item({ kind: "decision", urgency: "attention", title: "attention decision" }),
    ];

    expect(sortForDisplay(items, "open").map((entry) => entry.title)).toEqual([
      "blocking decision",
      "blocking approval",
      "blocking info",
      "attention decision",
      "fyi note",
    ]);
  });

  it("breaks an urgency-and-bucket tie by age, oldest first", () => {
    const older = item({ kind: "merge", title: "older", openedAt: "2026-09-01T00:00:00.000Z" });
    const newer = item({ kind: "merge", title: "newer", openedAt: "2026-09-09T00:00:00.000Z" });

    expect(sortForDisplay([newer, older], "open").map((entry) => entry.title)).toEqual(["older", "newer"]);
  });

  it("reads handled cards newest first, because there the question is what just happened", () => {
    const first = item({ kind: "merge", title: "first", state: "answered", answeredAt: "2026-09-01T00:00:00.000Z" });
    const last = item({ kind: "merge", title: "last", state: "answered", answeredAt: "2026-09-09T00:00:00.000Z" });

    expect(sortForDisplay([first, last], "answered").map((entry) => entry.title)).toEqual(["last", "first"]);
  });
});

describe("state tabs", () => {
  const open = item({ kind: "merge", title: "open", state: "open" });
  const answered = item({ kind: "merge", title: "answered", state: "answered", answeredAt: "2026-09-02T00:00:00.000Z" });
  const dismissed = item({ kind: "merge", title: "dismissed", state: "dismissed", answeredAt: "2026-09-03T00:00:00.000Z" });
  const all = [open, answered, dismissed];

  it.each([
    ["open", "open"],
    ["answered", "answered"],
    ["dismissed", "dismissed"],
  ] as const)("shows only %s cards on the %s tab", (tab, title) => {
    expect(itemsForTab(all, tab).map((entry) => entry.title)).toEqual([title]);
  });
});

describe("response control", () => {
  it("renders declared options as the answer", () => {
    expect(controlFor(item({ kind: "merge", options: [{ value: "approve", label: "Approve" }] }))).toBe("options");
  });

  it("renders a text field when the card takes a typed answer and declares none", () => {
    expect(controlFor(item({ kind: "status-decision", allowFreeform: true }))).toBe("text");
  });

  it("offers both when the card declares options AND accepts a typed answer", () => {
    expect(
      controlFor(item({ kind: "captain-held", options: [{ value: "approve", label: "Approve" }], allowFreeform: true })),
    ).toBe("both");
  });

  it("is read-only when nothing can carry the answer", () => {
    const unanswerable = item({ kind: "merge", options: [{ value: "approve", label: "Approve" }], respond: { channel: "none" } });

    expect(isActionable(unanswerable)).toBe(false);
    expect(controlFor(unanswerable)).toBe("none");
  });

  it("is read-only on a handled card even when it still carries its options", () => {
    const handled = item({
      kind: "merge",
      options: [{ value: "approve", label: "Approve" }],
      state: "answered",
      answeredAt: "2026-09-06T00:00:00.000Z",
    });

    expect(controlFor(handled)).toBe("none");
  });

  it("is read-only when the card declares neither options nor freeform", () => {
    expect(controlFor(item({ kind: "blocker" }))).toBe("none");
  });
});

describe("naming what a card is", () => {
  it("gives every kind a label, so a new kind cannot render blank", () => {
    const kinds: InboxItemKind[] = [
      "status-decision", "decision", "ask", "merge", "credential", "captain-held",
      "destructive", "irreversible", "security-sensitive", "answer", "blocker",
      "escalation", "review", "note", "custom",
    ];

    for (const kind of kinds) expect(KIND_LABELS[kind]).toBeTruthy();
  });

  it("files a firstmate question under its own bucket, not under decisions", () => {
    expect(bucketOf(item({ kind: "ask" }))).toBe("questions");
    expect(BUCKET_LABELS.questions).toBe("Question");
  });

  it("names a question more precisely than its bucket does", () => {
    expect(KIND_LABELS.ask).toBe("Question from firstmate");
    expect(KIND_LABELS.merge).toBe("Merge approval");
    expect(KIND_LABELS.credential).toBe("Credential");
  });
});

describe("announcing what a card is", () => {
  it("leads the notification title with the kind, then the summary", () => {
    expect(notificationTitle("status-decision", "Ship the release")).toBe("Decision needed — Ship the release");
    expect(notificationTitle("merge", "Land PR 12")).toBe("Merge approval — Land PR 12");
    expect(notificationTitle("ask", "Which API key?")).toBe("Question from firstmate — Which API key?");
  });

  it("falls back to the bare title on an unknown kind, so a blocking card still announces", () => {
    expect(notificationTitle("not-a-kind", "Ship the release")).toBe("Ship the release");
  });
});

describe("one decision, one card", () => {
  const answerable = item({
    kind: "captain-held",
    taskId: "backpass-session",
    title: "Run a backpass pass",
    respond: { channel: "relay", target: "w1:p1" },
  });
  const projection = item({
    kind: "decision",
    urgency: "attention",
    taskId: "backpass-session",
    title: "Run a backpass pass: captain will trigger it later",
    respond: { channel: "none" },
  });

  it("drops the unanswerable projection of a decision another card can answer", () => {
    expect(itemsForTab([answerable, projection], "open").map((entry) => entry.title)).toEqual([
      "Run a backpass pass",
    ]);
  });

  it("keeps the projection out of the count and the bands too", () => {
    expect(sectionsForTab([answerable, projection], "open").flatMap((section) => section.items)).toEqual([
      answerable,
    ]);
  });

  it("still hides the projection once its answerable twin has been handled", () => {
    const handled = { ...answerable, state: "answered", answeredAt: "2026-09-07T00:00:00.000Z" } as InboxItem;

    expect(itemsForTab([handled, projection], "open")).toEqual([]);
  });

  it("keeps a lone unanswerable decision, because dropping it would hide the decision", () => {
    expect(itemsForTab([projection], "open").map((entry) => entry.title)).toEqual([projection.title]);
  });

  it("never drops a gate or approval, whose body is its own information", () => {
    const gate = item({ kind: "merge", taskId: "backpass-session", title: "Merge gate", respond: { channel: "none" } });

    expect(itemsForTab([answerable, gate], "open").map((entry) => entry.title)).toContain("Merge gate");
  });
});

describe("banding the open tab", () => {
  const blocking = item({ kind: "ask", urgency: "blocking", openedAt: "2026-09-06T00:00:00.000Z" });
  const attention = item({ kind: "answer", urgency: "attention", openedAt: "2026-09-06T01:00:00.000Z" });
  const fyi = item({ kind: "note", urgency: "fyi", openedAt: "2026-09-06T02:00:00.000Z" });

  it("names each urgency band and keeps them in that order", () => {
    const sections = sectionsForTab([fyi, attention, blocking], "open");

    expect(sections.map((section) => section.label)).toEqual(["Blocking", "Needs you", "For information"]);
    expect(sections.map((section) => section.items.length)).toEqual([1, 1, 1]);
  });

  it("omits a band with no cards rather than showing an empty header", () => {
    expect(sectionsForTab([fyi], "open").map((section) => section.label)).toEqual(["For information"]);
  });

  it("holds exactly the cards itemsForTab would show, in the same order", () => {
    const items = [fyi, attention, blocking];

    expect(sectionsForTab(items, "open").flatMap((section) => section.items)).toEqual(
      itemsForTab(items, "open"),
    );
  });

  it("leaves handled tabs unbanded: a closed card is not still blocking", () => {
    const answered = item({ kind: "ask", state: "answered", answeredAt: "2026-09-06T03:00:00.000Z" });
    const sections = sectionsForTab([answered], "answered");

    expect(sections).toHaveLength(1);
    expect(sections[0]?.label).toBeNull();
  });

  it("yields nothing at all for an empty tab, so the shell shows its empty state", () => {
    expect(sectionsForTab([], "open")).toEqual([]);
    expect(sectionsForTab([], "dismissed")).toEqual([]);
  });
});
