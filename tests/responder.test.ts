/**
 * Responder routing (D-C) and audit log (AC 12).
 */
import { describe, expect, it } from "vitest";

import { createMemoryAuditWriter } from "@/lib/audit";
import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { createResponder, routeChannel } from "@/lib/responder";
import { inboxItemId, type InboxItem, type RespondResult } from "@/lib/types";

const CONFIG: HelmConfig = {
  fmHome: "/fixture/firstmate",
  fmBinDir: "/fixture/firstmate/bin",
  fmStateDir: "/fixture/firstmate/state",
  helmStateDir: "/fixture/helm-state",
  herdrSocketPath: "/fixture/herdr.sock",
  herdrBin: "herdr",
  port: DEFAULT_PORT,
  bind: DEFAULT_BIND,
};

function ok(channel: RespondResult["channel"], argv: string[]): RespondResult {
  return {
    ok: true,
    channel,
    argv,
    exitCode: 0,
    stdout: "",
    stderr: "",
    at: "2026-09-06T00:00:00.000Z",
  };
}

function baseItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: inboxItemId("status-decisions", "api-shape"),
    source: "status-decisions",
    kind: "decision",
    urgency: "blocking",
    taskId: "helm-foundation",
    title: "API shape",
    options: [{ value: "A", label: "Option A" }],
    allowFreeform: false,
    respond: { channel: "resolve-key", target: "helm-foundation", key: "api-shape" },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("routeChannel (D-C)", () => {
  it("forces merge and credential through relay", () => {
    expect(routeChannel(baseItem({ kind: "merge", respond: { channel: "resolve-key", key: "k" } }))).toBe(
      "relay",
    );
    expect(
      routeChannel(baseItem({ kind: "credential", respond: { channel: "captain-hold", target: "t" } })),
    ).toBe("relay");
  });

  it("forces captain-hold through relay (D-C / dc-captain-hold-direct-path)", () => {
    expect(
      routeChannel(
        baseItem({
          respond: { channel: "captain-hold", target: "helm-foundation" },
        }),
      ),
    ).toBe("relay");
  });

  it("honours the card channel for keyed status decisions", () => {
    expect(routeChannel(baseItem())).toBe("resolve-key");
  });

  it("honours relay for freeform cards", () => {
    expect(
      routeChannel(
        baseItem({
          respond: { channel: "relay", target: "w1:p1" },
        }),
      ),
    ).toBe("relay");
  });
});

describe("createResponder", () => {
  it("routes a keyed status decision through resolve-key with verbatim ids (AC 12)", async () => {
    const audit = createMemoryAuditWriter();
    const calls: { taskId: string; key: string; answer: string }[] = [];
    const responder = createResponder({
      config: CONFIG,
      audit,
      exec: {
        resolveKey: async (item, answer) => {
          calls.push({
            taskId: item.respond.target ?? item.taskId ?? "",
            key: item.respond.key ?? "",
            answer,
          });
          return ok("resolve-key", [
            "fm-send.sh",
            item.respond.target ?? "",
            "--resolve-key",
            item.respond.key ?? "",
            answer,
          ]);
        },
      },
    });

    const result = await responder.respond(baseItem(), { value: "A" });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ taskId: "helm-foundation", key: "api-shape", answer: "A" }]);
    // No identity arithmetic: never build fm-<id>.
    expect(calls[0]?.taskId).toBe("helm-foundation");
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      itemId: inboxItemId("status-decisions", "api-shape"),
      channel: "resolve-key",
      ok: true,
      argv: ["fm-send.sh", "helm-foundation", "--resolve-key", "api-shape", "A"],
      exitCode: 0,
    });
  });

  it("relays merge cards even when the card declared resolve-key", async () => {
    const audit = createMemoryAuditWriter();
    const relayed: string[] = [];
    const responder = createResponder({
      config: CONFIG,
      audit,
      exec: {
        resolveKey: async () => {
          throw new Error("resolve-key must not run for merge");
        },
        relay: async (item, answer) => {
          relayed.push(`${item.id}:${answer}`);
          return ok("relay", ["herdr", "pane", "run", item.respond.target ?? "", answer]);
        },
      },
    });

    const result = await responder.respond(
      baseItem({
        kind: "merge",
        respond: { channel: "resolve-key", target: "w1:p1", key: "merge-pr" },
      }),
      { value: "approve" },
    );

    expect(result.ok).toBe(true);
    expect(relayed).toEqual([`${inboxItemId("status-decisions", "api-shape")}:approve`]);
    expect(audit.entries[0]?.channel).toBe("relay");
  });

  it("relays captain-hold cards instead of calling fm-captain-hold.sh", async () => {
    const audit = createMemoryAuditWriter();
    const responder = createResponder({
      config: CONFIG,
      audit,
      exec: {
        captainHold: async () => {
          throw new Error("captain-hold must not run for D-C routed cards");
        },
        relay: async (item, answer) =>
          ok("relay", ["herdr", "pane", "run", item.respond.target ?? "", answer]),
      },
    });

    const result = await responder.respond(
      baseItem({
        respond: { channel: "captain-hold", target: "w1:p1" },
      }),
      { value: "release" },
    );

    expect(result.ok).toBe(true);
    expect(audit.entries[0]?.channel).toBe("relay");
  });

  it("audits an empty-value body that still has text, using the text", async () => {
    const audit = createMemoryAuditWriter();
    const responder = createResponder({
      config: CONFIG,
      audit,
      exec: {
        resolveKey: async (_item, answer) =>
          ok("resolve-key", ["fm-send.sh", "helm-foundation", "--resolve-key", "api-shape", answer]),
      },
    });

    const result = await responder.respond(baseItem(), { value: "", text: "ship it" });
    expect(result.ok).toBe(true);
    expect(result.argv.at(-1)).toBe("ship it");
    expect(audit.entries).toHaveLength(1);
  });

  it("relays freeform / captain-held answers into the pane", async () => {
    const audit = createMemoryAuditWriter();
    const responder = createResponder({
      config: CONFIG,
      audit,
      exec: {
        relay: async (item, answer) =>
          ok("relay", ["herdr", "pane", "run", item.respond.target ?? "", answer]),
      },
    });

    const result = await responder.respond(
      baseItem({
        allowFreeform: true,
        respond: { channel: "relay", target: "w1:p1" },
      }),
      { text: "ship it" },
    );

    expect(result.ok).toBe(true);
    expect(audit.entries[0]).toMatchObject({
      channel: "relay",
      action: { text: "ship it" },
      ok: true,
    });
  });

  it("audits failures as well as successes", async () => {
    const audit = createMemoryAuditWriter();
    const responder = createResponder({
      config: CONFIG,
      audit,
      exec: {
        resolveKey: async () => ({
          ok: false,
          channel: "resolve-key",
          argv: ["fm-send.sh", "helm-foundation", "--resolve-key", "api-shape", "A"],
          exitCode: 1,
          stdout: "",
          stderr: "no such task",
          at: "2026-09-06T00:00:00.000Z",
          error: "fm-send.sh: exited 1: no such task",
        }),
      },
    });

    const result = await responder.respond(baseItem(), { value: "A" });
    expect(result.ok).toBe(false);
    expect(audit.entries[0]).toMatchObject({
      ok: false,
      exitCode: 1,
      error: "fm-send.sh: exited 1: no such task",
    });
  });

  it("refuses channel none and still audits", async () => {
    const audit = createMemoryAuditWriter();
    const responder = createResponder({ config: CONFIG, audit });

    const result = await responder.respond(
      baseItem({ respond: { channel: "none" } }),
      { value: "A" },
    );

    expect(result.ok).toBe(false);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.ok).toBe(false);
  });

  it("refuses a multi-line relay answer before paneRun", async () => {
    const audit = createMemoryAuditWriter();
    const responder = createResponder({
      config: CONFIG,
      audit,
      exec: {
        relay: async () => {
          throw new Error("paneRun must not run for a multi-line answer");
        },
      },
    });

    const result = await responder.respond(
      baseItem({
        allowFreeform: true,
        respond: { channel: "relay", target: "w1:p1" },
      }),
      { text: "approve\n/exit" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/single line/);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.ok).toBe(false);
  });
});
