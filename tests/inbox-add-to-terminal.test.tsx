// @vitest-environment jsdom
/**
 * "Add to terminal": every inbox card can put its own full context into the
 * terminal composer, so the human can write an instruction around it.
 *
 * Rendered against the REAL terminal pane, because the two halves of the
 * feature live on opposite sides of the tree — the card publishes, the composer
 * subscribes — and a mocked pane would prove neither.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeEventSource, installBrowserStubs, openStream } from "./browser-stubs";
import { inboxItemId, type InboxItem } from "@/lib/types";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    reset(): void {}
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));

import { HelmShell } from "@/components/helm-shell";

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    sockets.push(this);
  }
}
const sockets: FakeSocket[] = [];

const askCard: InboxItem = {
  id: inboxItemId("asks", "run-migration"),
  source: "asks",
  kind: "ask",
  urgency: "blocking",
  title: "Run the migration now, or were you testing?",
  detail: "Staging is three migrations behind production.\nI did not want to guess.",
  options: [
    { value: "Run it now", label: "Run it now" },
    { value: "I was testing", label: "I was testing" },
  ],
  allowFreeform: true,
  respond: { channel: "relay", target: "w1:p5" },
  evidence: [{ path: "/fm/state/asks/run-migration.json" }],
  state: "open",
  openedAt: "2026-09-10T21:04:00.000Z",
};

const fetchMock = vi.fn();

function showCard(item: InboxItem): void {
  const stream: FakeEventSource = openStream();
  act(() => {
    stream.emit("snapshot.begin", { ids: [item.id] });
    stream.emit("item.upsert", item);
    stream.emit("snapshot.end", { count: 1 });
  });
}

function cardFor(title: string): HTMLElement {
  const card = screen.getByRole("heading", { name: title }).closest("article");
  if (card === null) throw new Error(`no card around ${title}`);
  return card;
}

function composer(): HTMLInputElement {
  return screen.getByLabelText("Send to the selected pane") as HTMLInputElement;
}

beforeEach(async () => {
  sockets.length = 0;
  installBrowserStubs();
  vi.stubGlobal("WebSocket", FakeSocket);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<HelmShell defaultTerminalCollapsed={false} />);
  await waitFor(() => openStream());
  await waitFor(() => expect(sockets.at(-1)?.onmessage).not.toBeNull());
  act(() => {
    sockets.at(-1)?.onmessage?.({
      data: JSON.stringify({
        type: "terminal.panes",
        panes: [{ id: "w1:p5", title: "firstmate", taskId: null, taskTitle: null, status: "idle", isFirstmate: true }],
        selectedPaneId: "w1:p5",
      }),
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("add to terminal", () => {
  it("puts the card's full context into the composer", () => {
    showCard(askCard);

    fireEvent.click(
      within(cardFor(askCard.title)).getByRole("button", {
        name: `Add "${askCard.title}" to the terminal composer`,
      }),
    );

    const value = composer().value;
    expect(value).toContain("Question from firstmate");
    expect(value).toContain(`Title: ${askCard.title}`);
    expect(value).toContain("Detail: Staging is three migrations behind production. I did not want to guess.");
    expect(value).toContain("Options: Run it now | I was testing");
    expect(value).toContain("Answer routes: relay into pane w1:p5");
    expect(value).toContain(`Card: ${askCard.id}`);
  });

  it("appends rather than overwriting what the human is already typing", () => {
    showCard(askCard);
    fireEvent.change(composer(), { target: { value: "hold off on this:" } });

    fireEvent.click(
      within(cardFor(askCard.title)).getByRole("button", {
        name: `Add "${askCard.title}" to the terminal composer`,
      }),
    );

    expect(composer().value.startsWith("hold off on this: [helm card —")).toBe(true);
  });

  it("leaves the caret after the block, ready for the next words", () => {
    showCard(askCard);

    fireEvent.click(
      within(cardFor(askCard.title)).getByRole("button", {
        name: `Add "${askCard.title}" to the terminal composer`,
      }),
    );

    const input = composer();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
  });

  it("sends the composed line to the pane as one submission", async () => {
    showCard(askCard);
    fireEvent.click(
      within(cardFor(askCard.title)).getByRole("button", {
        name: `Add "${askCard.title}" to the terminal composer`,
      }),
    );
    const input = composer();
    fireEvent.change(input, { target: { value: `${input.value} please confirm` } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("/api/term/input");
    const body = JSON.parse(String(init.body)) as { text: string };
    // One line: the pane input schema refuses anything else, and a newline
    // would become a second submission.
    expect(body.text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(body.text).toContain("please confirm");
  });

  it("offers the control on a read-only card too — attaching answers nothing", () => {
    const answerCard: InboxItem = {
      ...askCard,
      id: inboxItemId("answers", "codex-auth"),
      source: "answers",
      kind: "answer",
      urgency: "attention",
      title: "Give me the codex auth link",
      detail: "https://auth.example/authorize",
      options: [],
      allowFreeform: false,
      respond: { channel: "none" },
    };
    showCard(answerCard);

    fireEvent.click(
      within(cardFor(answerCard.title)).getByRole("button", {
        name: `Add "${answerCard.title}" to the terminal composer`,
      }),
    );

    expect(composer().value).toContain("Answer routes: read-only, no reply channel");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("an ask card", () => {
  it("relays a chosen option back to firstmate and resolves the card", async () => {
    showCard(askCard);

    fireEvent.click(within(cardFor(askCard.title)).getByRole("button", { name: "Run it now" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/inbox/${encodeURIComponent(askCard.id)}/respond`);
    // Verbatim: the option label IS the answer firstmate wrote.
    expect(JSON.parse(String(init.body))).toEqual({ value: "Run it now" });

    act(() => {
      openStream().emit("item.upsert", {
        ...askCard,
        state: "answered",
        answeredAt: "2026-09-10T21:06:00.000Z",
        answer: "Run it now",
      });
      openStream().emit("item.retract", { id: askCard.id });
    });

    expect(screen.queryByRole("heading", { name: askCard.title })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Answered/ }));
    expect(within(cardFor(askCard.title)).getByText("Answered: Run it now")).toBeDefined();
  });

  it("takes a typed reply when firstmate offered no options", async () => {
    const freeform: InboxItem = { ...askCard, id: inboxItemId("asks", "pr-split"), options: [] };
    showCard(freeform);

    const reply = within(cardFor(freeform.title)).getByRole("textbox");
    fireEvent.change(reply, { target: { value: "split it into three" } });
    fireEvent.click(within(cardFor(freeform.title)).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ text: "split it into three" });
  });

  it("renders read-only when no firstmate pane is reachable", () => {
    const unreachable: InboxItem = {
      ...askCard,
      id: inboxItemId("asks", "no-pane"),
      respond: { channel: "none" },
    };
    showCard(unreachable);
    const card = cardFor(unreachable.title);

    expect(within(card).queryByRole("button", { name: "Run it now" })).toBeNull();
    expect(within(card).getByText("No reply channel")).toBeDefined();
  });
});
