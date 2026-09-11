// @vitest-environment jsdom
/**
 * A closed inbox card is read-only. `answered` and `dismissed` cards stay
 * visible and legible on their own tabs, and they expose no option button, no
 * freeform field, and no Send control, so a decision that is already resolved
 * cannot be answered a second time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { FakeEventSource, installBrowserStubs, openStream } from "./browser-stubs";
import { inboxItemId, type InboxItem } from "@/lib/types";

vi.mock("@/components/terminal-pane", () => ({
  TerminalPane: () => <div aria-label="Live terminal mirror" />,
}));

import { HelmShell } from "@/components/helm-shell";

function item(partial: Partial<InboxItem> & Pick<InboxItem, "id" | "source" | "kind" | "title" | "state">): InboxItem {
  return {
    urgency: "blocking",
    options: [],
    allowFreeform: false,
    respond: { channel: "none" },
    evidence: [],
    openedAt: "2026-09-06T13:20:00.000Z",
    ...partial,
  };
}

const openCard = item({
  id: inboxItemId("status-decisions", "storage-choice"),
  source: "status-decisions",
  kind: "decision",
  title: "Choose the hierarchy authority",
  detail: "The implementation is held until the source of truth is confirmed.",
  options: [
    { value: "items", label: "Drive + Item", hint: "Recommended: one hierarchy authority." },
    { value: "folders", label: "Legacy folders" },
  ],
  allowFreeform: true,
  recommendValue: "items",
  respond: { channel: "resolve-key", target: "drive-metadata", key: "hierarchy-authority" },
  state: "open",
});

const answeredCard = item({
  id: inboxItemId("review-results", "ui-shell"),
  source: "review-results",
  kind: "review",
  urgency: "fyi",
  title: "UI shell review is complete",
  options: [{ value: "acknowledge", label: "Acknowledge" }],
  state: "answered",
  answeredAt: "2026-09-05T17:22:00.000Z",
  answer: "acknowledge",
});

const dismissedCard = item({
  id: inboxItemId("captain-notes", "handoff"),
  source: "captain-notes",
  kind: "note",
  urgency: "fyi",
  title: "Handoff note from the captain",
  allowFreeform: true,
  state: "dismissed",
  answeredAt: "2026-09-05T18:00:00.000Z",
});

function cardFor(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const card = heading.closest("article");
  if (!card) throw new Error(`no card around the heading ${title}`);
  return card;
}

/** Switch the inbox to one state tab. Each tab shows only that state. */
function showTab(label: "Open" | "Answered" | "Dismissed"): void {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
}

async function renderLiveInbox(): Promise<FakeEventSource> {
  installBrowserStubs();
  render(<HelmShell />);
  const stream = await vi.waitFor(() => openStream());
  act(() => {
    stream.emit("snapshot.begin", { ids: [openCard.id] });
    stream.emit("item.upsert", openCard);
    stream.emit("snapshot.end", { count: 1 });
    stream.emit("item.upsert", answeredCard);
    stream.emit("item.retract", { id: answeredCard.id });
    stream.emit("item.upsert", dismissedCard);
    stream.emit("item.retract", { id: dismissedCard.id });
  });
  return stream;
}

beforeEach(async () => {
  await renderLiveInbox();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("closed inbox cards", () => {
  it("keeps the terminal panel alongside the inbox", () => {
    expect(screen.getByLabelText("Live terminal mirror")).toBeDefined();
    expect(screen.getByRole("button", { name: "Inbox" })).toBeDefined();
  });

  it.each([
    ["answered", "Answered" as const, "UI shell review is complete", "Answered: acknowledge"],
    ["dismissed", "Dismissed" as const, "Handoff note from the captain", "Dismissed"],
  ])("keeps the %s card visible and reports its outcome", (_state, tab, title, outcome) => {
    showTab(tab);
    const card = cardFor(title);

    expect(within(card).getByText(title)).toBeDefined();
    expect(within(card).getByText(outcome)).toBeDefined();
  });

  it("offers no option button on an answered card that still carries an option", () => {
    showTab("Answered");
    const card = cardFor("UI shell review is complete");

    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  it("offers no freeform field, Send control, or Dismiss on a closed card", () => {
    showTab("Dismissed");
    const card = cardFor("Handoff note from the captain");

    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Send" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("still offers both affordances on an open card, so the queries above can find them", () => {
    showTab("Open");
    const card = cardFor("Choose the hierarchy authority");

    expect(within(card).getByRole("button", { name: /Drive \+ Item/ })).toBeDefined();
    // Options are the one-tap answer; a typed reply is the deliberate exception.
    fireEvent.click(within(card).getByRole("button", { name: "Write a reply instead" }));
    expect(within(card).getByRole("textbox")).toBeDefined();
    expect(within(card).getByRole("button", { name: "Send" })).toBeDefined();
  });
});
