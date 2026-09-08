import { describe, expect, it } from "vitest";

import { parseInboxItem, parseInboxRetractId } from "@/lib/inbox-client";
import { inboxItemId } from "@/lib/types";

describe("parseInboxItem", () => {
  it("accepts a complete item and strips unknown fields", () => {
    const item = parseInboxItem(
      JSON.stringify({
        id: inboxItemId("status-decisions", "k"),
        source: "status-decisions",
        kind: "status-decision",
        urgency: "blocking",
        title: "Decide",
        options: [],
        allowFreeform: true,
        respond: { channel: "resolve-key", target: "t", key: "k" },
        evidence: [],
        state: "open",
        openedAt: "2026-09-06T00:00:00.000Z",
        extra: "drop me",
      }),
    );
    expect(item).toMatchObject({ id: "status-decisions:k", title: "Decide" });
    expect(item).not.toHaveProperty("extra");
  });

  it("rejects a payload that is not an item rather than guessing", () => {
    expect(parseInboxItem("{")).toBeNull();
    expect(parseInboxItem(JSON.stringify({ id: "x" }))).toBeNull();
    expect(parseInboxRetractId(JSON.stringify({}))).toBeNull();
    expect(parseInboxRetractId(JSON.stringify({ id: "status-decisions:k" }))).toBe("status-decisions:k");
  });
});
