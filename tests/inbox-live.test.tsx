// @vitest-environment jsdom
/**
 * Lane H: the shell consumes the live SSE store and POSTs answers.
 * Adapter-supplied text is rendered as text, never as markup (AC 19).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { installBrowserStubs, openStream } from "./browser-stubs";
import { inboxItemId, type InboxItem } from "@/lib/types";

vi.mock("@/components/terminal-pane", () => ({
  TerminalPane: () => <div aria-label="Live terminal mirror" />,
}));

import { HelmShell } from "@/components/helm-shell";

function baseItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: inboxItemId("status-decisions", "api-shape"),
    source: "status-decisions",
    kind: "status-decision",
    urgency: "blocking",
    taskId: "helm-foundation",
    title: "Decision needed: helm-foundation",
    detail: "A or B?",
    options: [],
    allowFreeform: true,
    respond: { channel: "resolve-key", target: "helm-foundation", key: "api-shape" },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(async () => {
  installBrowserStubs();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true }),
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<HelmShell />);
  await vi.waitFor(() => openStream());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("live inbox shell", () => {
  it("renders store cards after a snapshot and hides the fixture badge", async () => {
    const stream = openStream();
    const card = baseItem();
    act(() => {
      stream.emit("snapshot.begin", { ids: [card.id] });
      stream.emit("item.upsert", card);
      stream.emit("snapshot.end", { count: 1 });
    });

    expect(screen.queryByText("fixture")).toBeNull();
    expect(screen.getByRole("heading", { name: card.title })).toBeDefined();
    // The card lands on the Open tab, which counts it.
    expect(screen.getByRole("button", { name: /^Open\s*1$/ })).toBeDefined();
  });

  it("POSTs a typed keyed answer to the respond endpoint (AC 8)", async () => {
    const stream = openStream();
    const card = baseItem();
    act(() => {
      stream.emit("snapshot.begin", { ids: [card.id] });
      stream.emit("item.upsert", card);
      stream.emit("snapshot.end", { count: 1 });
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ship items" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/inbox/${encodeURIComponent(card.id)}/respond`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "ship items" }),
      }),
    );
  });

  it("POSTs a declared option value, never both value and text", async () => {
    const stream = openStream();
    const card = baseItem({
      kind: "decision",
      allowFreeform: false,
      options: [
        { value: "items", label: "Drive + Item" },
        { value: "folders", label: "Legacy folders" },
      ],
    });
    act(() => {
      stream.emit("snapshot.begin", { ids: [card.id] });
      stream.emit("item.upsert", card);
      stream.emit("snapshot.end", { count: 1 });
    });

    fireEvent.click(screen.getByRole("button", { name: "Drive + Item" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ value: "items" });
  });

  it("renders adapter HTML, ANSI, and shell metacharacters as inert text (AC 19)", () => {
    const stream = openStream();
    const card = baseItem({
      id: inboxItemId("status-decisions", "xss"),
      title: `<script>alert(1)</script> ; $(rm -rf /) \u001b[31mred`,
      detail: `<img src=x onerror=alert(1)> && true`,
    });
    act(() => {
      stream.emit("snapshot.begin", { ids: [card.id] });
      stream.emit("item.upsert", card);
      stream.emit("snapshot.end", { count: 1 });
    });

    const article = screen.getByRole("heading", { name: card.title }).closest("article");
    if (article === null) throw new Error("missing card");
    expect(article.querySelector("script")).toBeNull();
    expect(article.querySelector("img")).toBeNull();
    expect(within(article).getByText(card.title)).toBeDefined();
    expect(within(article).getByText(card.detail ?? "")).toBeDefined();
  });

  it("shows a long header whole, never clipped to an unreachable ellipsis", () => {
    const stream = openStream();
    const title =
      'helm inbox v2: (1) an "add to context" icon button on every inbox card; (2) surface firstmate questions as answerable cards; (3) redesign the inbox for strong visual hierarchy.';
    const card = baseItem({ id: inboxItemId("captain-holds", "helm-inbox-context"), title });
    act(() => {
      stream.emit("snapshot.begin", { ids: [card.id] });
      stream.emit("item.upsert", card);
      stream.emit("snapshot.end", { count: 1 });
    });

    const heading = screen.getByRole("heading", { name: title });
    expect(heading.textContent).toBe(title);
    // A clipped header is the bug: an ellipsis with no way to reach the rest.
    expect(heading.className).not.toContain("truncate");
    expect(heading.className).not.toContain("line-clamp");
  });

  it("keeps a long body in the DOM behind Show more, so nothing is unreachable", () => {
    const stream = openStream();
    const detail = `${"A long task note that wraps. ".repeat(20)}\nlast line`;
    const card = baseItem({ id: inboxItemId("captain-holds", "long-body"), detail });
    act(() => {
      stream.emit("snapshot.begin", { ids: [card.id] });
      stream.emit("item.upsert", card);
      stream.emit("snapshot.end", { count: 1 });
    });
    const article = screen.getByRole("heading", { name: card.title }).closest("article");
    if (article === null) throw new Error("missing card");

    // Collapsed is a CSS clamp, not a text cut: the whole body is already here.
    const body = (): string => article.querySelector("p")?.textContent ?? "";
    expect(body()).toBe(detail);

    fireEvent.click(within(article).getByRole("button", { name: "Show more" }));

    expect(within(article).getByRole("button", { name: "Show less" })).toBeDefined();
    expect(body()).toBe(detail);
  });

  it("offers no Show more when the body already fits", () => {
    const stream = openStream();
    const card = baseItem({ id: inboxItemId("captain-holds", "short-body"), detail: "A or B?" });
    act(() => {
      stream.emit("snapshot.begin", { ids: [card.id] });
      stream.emit("item.upsert", card);
      stream.emit("snapshot.end", { count: 1 });
    });
    const article = screen.getByRole("heading", { name: card.title }).closest("article");
    if (article === null) throw new Error("missing card");

    expect(within(article).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("drops an open card that a later snapshot omits, and keeps a session-answered card", () => {
    const stream = openStream();
    const open = baseItem();
    const answered = baseItem({
      id: inboxItemId("status-decisions", "done-key"),
      title: "Already answered",
      state: "answered",
      answeredAt: "2026-09-06T01:00:00.000Z",
    });
    act(() => {
      stream.emit("snapshot.begin", { ids: [open.id] });
      stream.emit("item.upsert", open);
      stream.emit("snapshot.end", { count: 1 });
      stream.emit("item.upsert", answered);
      stream.emit("item.retract", { id: answered.id });
      stream.emit("snapshot.begin", { ids: [] });
      stream.emit("snapshot.end", { count: 0 });
    });

    expect(screen.queryByRole("heading", { name: open.title })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Answered/ }));
    expect(screen.getByRole("heading", { name: "Already answered" })).toBeDefined();
  });
});
