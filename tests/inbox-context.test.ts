/**
 * The context block an inbox card drops into the terminal composer.
 *
 * Two properties matter and both are enforced here: it carries everything the
 * human needs to write an informed instruction, and it survives the pane input
 * schema — one line, no control characters (`request.ts`).
 */
import { describe, expect, it } from "vitest";

import { appendContext, flattenField, inboxItemContext } from "@/lib/inbox-context";
import { parseTerminalInput } from "@/lib/request";
import type { InboxItem } from "@/lib/types";

const BASE: InboxItem = {
  id: "asks:run-migration",
  source: "asks",
  kind: "ask",
  urgency: "blocking",
  title: "Run the migration now, or were you testing?",
  detail: "Staging is three migrations behind production.",
  options: [
    { value: "Run it now", label: "Run it now" },
    { value: "I was testing", label: "I was testing" },
  ],
  allowFreeform: true,
  respond: { channel: "relay", target: "w1:p5" },
  evidence: [{ path: "/home/s7kar/firstmate/state/asks/run-migration.json" }],
  state: "open",
  openedAt: "2026-09-10T21:04:00Z",
};

describe("flattening one field", () => {
  it("collapses the newlines a task note is full of", () => {
    expect(flattenField("line one\nline two\r\nline three")).toBe("line one line two line three");
  });

  it("removes tabs and C0 controls, which the pane input schema rejects", () => {
    expect(flattenField("a\tb\u0007c\u007fd")).toBe("a b c d");
  });

  it("trims and squeezes runs of whitespace", () => {
    expect(flattenField("  spaced   out  ")).toBe("spaced out");
  });
});

describe("the context block", () => {
  it("names what the card is and how much it wants the human, first", () => {
    expect(inboxItemContext(BASE)).toMatch(/^\[helm card — Question from firstmate \(blocking\)\]/);
  });

  it("carries the title, the body, the options, the routing, and the provenance", () => {
    const block = inboxItemContext(BASE);

    expect(block).toContain("Title: Run the migration now, or were you testing?");
    expect(block).toContain("Detail: Staging is three migrations behind production.");
    expect(block).toContain("Options: Run it now | I was testing");
    expect(block).toContain("Also accepts a typed reply");
    expect(block).toContain("Answer routes: relay into pane w1:p5");
    expect(block).toContain("Evidence: /home/s7kar/firstmate/state/asks/run-migration.json");
    expect(block).toContain("Source: asks");
    expect(block).toContain("Card: asks:run-migration");
    expect(block).toContain("Opened: 2026-09-10T21:04:00Z");
  });

  it("carries the fields a keyed decision needs to be acted on", () => {
    const decision: InboxItem = {
      ...BASE,
      id: "status-decisions:helm-inbox-context:port",
      source: "status-decisions",
      kind: "status-decision",
      taskId: "helm-inbox-context",
      repo: "souritrakar/helm",
      about: "blocked on the port choice",
      options: [],
      respond: { channel: "resolve-key", target: "helm-inbox-context", key: "port" },
    };

    const block = inboxItemContext(decision);

    expect(block).toContain("Task: helm-inbox-context");
    expect(block).toContain("Repo: souritrakar/helm");
    expect(block).toContain("About: blocked on the port choice");
    expect(block).toContain("Answer routes: decision key port on task helm-inbox-context");
    expect(block).not.toContain("Options:");
  });

  it("carries distinct option values and operational hints", () => {
    const decision: InboxItem = {
      ...BASE,
      options: [
        { value: "restart-now", label: "Restart now", hint: "Drains workers first" },
        { value: "defer", label: "Defer" },
      ],
    };

    expect(inboxItemContext(decision)).toContain(
      "Options: Restart now (value: restart-now; hint: Drains workers first) | Defer (value: defer)",
    );
  });

  it("omits an option value when it is identical to its label", () => {
    const block = inboxItemContext(BASE);

    expect(block).toContain("Options: Run it now | I was testing");
    expect(block).not.toContain("value: Run it now");
  });

  it("says so when a card cannot be answered, rather than staying silent", () => {
    const readOnly: InboxItem = { ...BASE, kind: "answer", options: [], respond: { channel: "none" } };

    expect(inboxItemContext(readOnly)).toContain("Answer routes: read-only, no reply channel");
  });

  it("reports what a handled card was answered with", () => {
    const handled: InboxItem = { ...BASE, state: "answered", answer: "Run it now" };

    expect(inboxItemContext(handled)).toContain("State: answered — Run it now");
  });

  it("omits an absent optional field instead of printing an empty label", () => {
    const bare: InboxItem = { ...BASE, detail: undefined, ref: undefined, evidence: [] };
    const block = inboxItemContext(bare);

    expect(block).not.toContain("Detail:");
    expect(block).not.toContain("Ref:");
    expect(block).not.toContain("Evidence:");
  });

  it("keeps evidence locations when available without adding a separator when absent", () => {
    const block = inboxItemContext({
      ...BASE,
      evidence: [{ path: "docs/runbook.md", line: 42 }, { path: "docs/notes.md" }],
    });

    expect(block).toContain("Evidence: docs/runbook.md:42, docs/notes.md");
    expect(block).not.toContain("docs/notes.md:");
  });

  it("stays one line even when every field is multi-line", () => {
    const messy: InboxItem = {
      ...BASE,
      title: "helm inbox v2:\n(1) add to context\n(2) ask cards",
      detail: "A task note\nthat spans\nmany lines.\t\tIndented too.",
      options: [{ value: "yes\tvalue", label: "yes\nplease", hint: "choose\r\nthis" }],
      evidence: [{ path: "/tmp/a\nb" }],
    };

    const block = inboxItemContext(messy);

    expect(block).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(block.split("\n")).toHaveLength(1);
  });

  it("is accepted by the pane input schema, which is what it exists to survive", () => {
    const messy: InboxItem = {
      ...BASE,
      detail: "line one\nline two\ttabbed",
      options: [{ value: "yes\tvalue", label: "yes\nplease", hint: "choose\r\nthis" }],
    };

    expect(() =>
      parseTerminalInput({ paneId: "w1:p5", text: inboxItemContext(messy) }),
    ).not.toThrow();
  });
});

describe("appending to the draft", () => {
  it("never overwrites what the human is already typing", () => {
    expect(appendContext("please handle", "[helm card — Note (fyi)] Title: x")).toBe(
      "please handle [helm card — Note (fyi)] Title: x",
    );
  });

  it("adds no leading space to an empty draft", () => {
    expect(appendContext("", "[block]")).toBe("[block]");
    expect(appendContext("   ", "[block]")).toBe("[block]");
  });

  it("does not double the separating space", () => {
    expect(appendContext("hello ", "[block]")).toBe("hello [block]");
  });

  it("appends a second block after the first, so several cards can be attached", () => {
    const once = appendContext("", inboxItemContext(BASE));
    const twice = appendContext(once, inboxItemContext({ ...BASE, id: "asks:other" }));

    expect(twice.startsWith(once)).toBe(true);
    expect(twice).toContain("Card: asks:other");
  });
});
