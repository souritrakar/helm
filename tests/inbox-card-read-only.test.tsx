// @vitest-environment jsdom
/**
 * A closed inbox card is read-only. `answered` and `dismissed` cards stay
 * visible and legible, but they expose no option button, no freeform field,
 * and no Preview control, so a decision that is already resolved cannot be
 * answered a second time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/components/terminal-pane", () => ({
  TerminalPane: () => <div aria-label="Read-only terminal mirror" />,
}));

import { HelmShell } from "@/components/helm-shell";

/** jsdom ships neither of these, and the shell reads both on mount. */
function installBrowserStubs(): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

/** The card element wrapping the item with this title. */
function cardFor(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const card = heading.closest("article");
  if (!card) throw new Error(`no card around the heading ${title}`);
  return card;
}

beforeEach(() => {
  installBrowserStubs();
  render(<HelmShell />);
  fireEvent.click(screen.getByRole("button", { name: /^All/ }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("closed inbox cards", () => {
  it("keeps the terminal panel alongside the inbox", () => {
    expect(screen.getByLabelText("Read-only terminal mirror")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeDefined();
  });

  it.each([
    ["answered", "UI shell review is complete", "Answered. This card is read-only."],
    ["dismissed", "Handoff note from the captain", "Dismissed. This card is read-only."],
  ])("keeps the %s card visible and states that it is read-only", (_state, title, notice) => {
    const card = cardFor(title);

    expect(within(card).getByText(title)).toBeDefined();
    expect(within(card).getByText(notice)).toBeDefined();
  });

  it("offers no option button on an answered card that still carries an option", () => {
    const card = cardFor("UI shell review is complete");

    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  it("offers no freeform field or Preview control on a dismissed card that allows freeform", () => {
    const card = cardFor("Handoff note from the captain");

    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("still offers both affordances on an open card, so the queries above can find them", () => {
    const card = cardFor("Choose the hierarchy authority");

    expect(within(card).getByRole("button", { name: /Drive \+ Item/ })).toBeDefined();
    expect(within(card).getByRole("textbox")).toBeDefined();
    expect(within(card).getByRole("button", { name: "Preview" })).toBeDefined();
  });
});
