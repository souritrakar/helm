/**
 * The ask primitive: helm READS `$FM_HOME/state/asks/*.json` and relays the
 * captain's reply into the firstmate pane. firstmate owns writing the records.
 *
 * The inverse of the answer primitive — and unlike it, answerable. A record
 * helm cannot validate is skipped and reported, never guessed at (SPEC R3).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAskAdapter, parseAskRecord, readAskRecords } from "@/lib/adapters/asks";
import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { routeChannel } from "@/lib/responder";
import { bucketOf, controlFor } from "@/lib/inbox-view";
import type { InboxItem, InboxRespondSpec } from "@/lib/types";

let root = "";
let asksDir = "";
let config: HelmConfig;
const disposers: Disposable[] = [];

const RELAY: InboxRespondSpec = { channel: "relay", target: "w1:p5" };

const RECORD = {
  id: "run-migration",
  question: "Run the migration now, or were you testing?",
  context: "Staging is three migrations behind production.",
  options: ["Run it now", "I was testing"],
  ref: "w1:p5",
  ts: "2026-09-10T21:04:00Z",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "helm-asks-"));
  const fmHome = join(root, "firstmate");
  asksDir = join(fmHome, "state", "asks");
  mkdirSync(asksDir, { recursive: true });
  mkdirSync(join(fmHome, "bin"), { recursive: true });
  config = {
    fmHome,
    fmBinDir: join(fmHome, "bin"),
    fmStateDir: join(fmHome, "state"),
    helmStateDir: join(root, "helm-state"),
    herdrSocketPath: join(root, "herdr.sock"),
    herdrBin: "herdr",
    port: DEFAULT_PORT,
    bind: DEFAULT_BIND,
  };
});

afterEach(() => {
  for (const disposer of disposers.splice(0)) disposer[Symbol.dispose]();
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, body: unknown): void {
  writeFileSync(join(asksDir, name), typeof body === "string" ? body : JSON.stringify(body));
}

describe("ask record contract", () => {
  it("accepts the declared shape", () => {
    expect(parseAskRecord(RECORD)).toMatchObject(RECORD);
  });

  it("accepts a question with no options — the captain types the reply", () => {
    const freeform = { id: "a", question: "q", context: "c", ts: "t" };

    expect(parseAskRecord(freeform).options).toBeUndefined();
  });

  it.each([
    ["a missing question", { id: "a", context: "c", ts: "t" }],
    ["a missing context", { id: "a", question: "q", ts: "t" }],
    ["a missing id", { question: "q", context: "c", ts: "t" }],
    ["a missing ts", { id: "a", question: "q", context: "c" }],
    ["an empty question", { id: "a", question: "", context: "c", ts: "t" }],
    ["an empty option", { id: "a", question: "q", context: "c", options: [""], ts: "t" }],
    ["a non-array options", { id: "a", question: "q", context: "c", options: "yes", ts: "t" }],
    ["a non-string option", { id: "a", question: "q", context: "c", options: [7], ts: "t" }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseAskRecord(value)).toThrow();
  });
});

describe("reading the asks directory", () => {
  it("renders the question as the title and the context as the body", () => {
    write("a.json", RECORD);

    expect(readAskRecords(asksDir, RELAY)).toMatchObject([
      {
        id: "asks:run-migration",
        source: "asks",
        kind: "ask",
        urgency: "blocking",
        title: RECORD.question,
        detail: RECORD.context,
        ref: RECORD.ref,
        openedAt: RECORD.ts,
      },
    ]);
  });

  it("relays each option verbatim: the label IS the answer, so helm invents no vocabulary", () => {
    write("a.json", RECORD);
    const [card] = readAskRecords(asksDir, RELAY);

    expect(card?.options).toEqual([
      { value: "Run it now", label: "Run it now" },
      { value: "I was testing", label: "I was testing" },
    ]);
  });

  it("always accepts a typed reply, so a question can get a nuanced answer", () => {
    write("with.json", RECORD);
    write("without.json", { id: "b", question: "q", context: "c", ts: "t" });

    const cards = readAskRecords(asksDir, RELAY);

    expect(cards.map((card) => card.allowFreeform)).toEqual([true, true]);
    // with.json declares options, without.json does not; both take typed text.
    expect(cards.map((card) => controlFor(card))).toEqual(["both", "text"]);
  });

  it("carries the respond spec it was handed, so a card with no pane renders read-only", () => {
    write("a.json", RECORD);

    const [reachable] = readAskRecords(asksDir, RELAY);
    const [unreachable] = readAskRecords(asksDir, { channel: "none" });

    expect(reachable?.respond).toEqual(RELAY);
    expect(unreachable?.respond).toEqual({ channel: "none" });
    expect(controlFor(unreachable as InboxItem)).toBe("none");
  });

  it("keys each card by the record id, so asking again raises a new card", () => {
    write("a.json", RECORD);
    write("b.json", { ...RECORD, id: "run-migration-2" });

    expect(readAskRecords(asksDir, RELAY).map((card) => card.id)).toEqual([
      "asks:run-migration",
      "asks:run-migration-2",
    ]);
  });

  it("skips an invalid record, reports it, and keeps the valid ones", () => {
    write("good.json", RECORD);
    write("bad.json", { id: "bad", question: "no context field", ts: "t" });
    const skipped: string[] = [];

    const cards = readAskRecords(asksDir, RELAY, (file) => skipped.push(file));

    expect(cards.map((card) => card.id)).toEqual(["asks:run-migration"]);
    expect(skipped).toEqual(["bad.json"]);
  });

  it("skips a file that is not JSON at all rather than throwing", () => {
    write("broken.json", "{ this is not json");
    const skipped: string[] = [];

    expect(readAskRecords(asksDir, RELAY, (file) => skipped.push(file))).toEqual([]);
    expect(skipped).toEqual(["broken.json"]);
  });

  it("treats a missing directory as empty — firstmate may not have asked anything", () => {
    expect(readAskRecords(join(root, "nope"), RELAY)).toEqual([]);
  });
});

describe("routing an answered ask", () => {
  it("relays: a question is an instruction back to firstmate, never a keyed decision", () => {
    write("a.json", RECORD);
    const [card] = readAskRecords(asksDir, RELAY);

    expect(routeChannel(card as InboxItem)).toBe("relay");
  });

  it("reads as its own bucket, so a firstmate question is not filed as a decision", () => {
    write("a.json", RECORD);
    const [card] = readAskRecords(asksDir, RELAY);

    expect(bucketOf(card as InboxItem)).toBe("questions");
  });
});

describe("the recorded fixture", () => {
  it("reads the checked-in ask records, so the contract is exercised as firstmate will write it", () => {
    const cards = readAskRecords(join(import.meta.dirname, "fixtures", "asks"), RELAY);

    expect(cards.map((card) => card.id)).toEqual(["asks:pr-title", "asks:run-migration"]);
    expect(cards[1]).toMatchObject({
      kind: "ask",
      urgency: "blocking",
      title: "Run the pending staging migration now, or were you only testing the connection?",
      respond: RELAY,
    });
    // options and ref are genuinely optional.
    expect(cards[0]?.options).toEqual([]);
    expect(cards[0]?.ref).toBeUndefined();
  });
});

describe("ask adapter", () => {
  it("emits the current full set on start", async () => {
    write("a.json", RECORD);
    const emitted: InboxItem[][] = [];
    const adapter = createAskAdapter(config, { relayTarget: () => "w1:p5" });

    disposers.push(await adapter.start({ emit: (items) => emitted.push(items), retract: () => undefined }));

    expect(adapter.id).toBe("asks");
    expect(emitted.at(-1)).toMatchObject([{ id: "asks:run-migration", respond: RELAY }]);
  });

  // Discovery lands after start(), so a target read once up front would pin
  // every ask card to `channel: "none"` and make its buttons dead for the life
  // of the process. The poll is 5s, so this waits past one tick.
  it("resolves the relay target per tick, so a pane discovered after start is picked up", async () => {
    write("a.json", RECORD);
    // Stands in for Herdr discovery, which resolves the pane after start().
    const discovery: { pane?: string } = {};
    const emitted: InboxItem[][] = [];
    const adapter = createAskAdapter(config, { relayTarget: () => discovery.pane });

    disposers.push(await adapter.start({ emit: (items) => emitted.push(items), retract: () => undefined }));
    expect(emitted.at(-1)?.[0]?.respond).toEqual({ channel: "none" });

    discovery.pane = "w1:p5";
    await vi.waitFor(
      () => {
        expect(emitted.at(-1)?.[0]?.respond).toEqual(RELAY);
      },
      { timeout: 9_000, interval: 100 },
    );
  }, 12_000);

  it("emits an empty set when there are no records, so the store retracts stale cards", async () => {
    const emitted: InboxItem[][] = [];
    const adapter = createAskAdapter(config, { relayTarget: () => "w1:p5" });

    disposers.push(await adapter.start({ emit: (items) => emitted.push(items), retract: () => undefined }));

    expect(emitted.at(-1)).toEqual([]);
  });
});
