/**
 * The answer primitive: helm READS `$FM_HOME/state/answers/*.json` and renders
 * each record read-only. firstmate owns writing them.
 *
 * A record helm cannot validate is skipped and reported, never guessed at
 * (SPEC R3 — a contract drift must fail loudly rather than mis-render).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAnswerAdapter, parseAnswerRecord, readAnswerRecords } from "@/lib/adapters/answers";
import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import type { InboxItem } from "@/lib/types";

let root = "";
let answersDir = "";
let config: HelmConfig;
const disposers: Disposable[] = [];

const RECORD = {
  id: "codex-auth",
  question: "Give me the codex auth link",
  answer: "https://auth.example/authorize?client_id=abc",
  ref: "w1:p5",
  ts: "2026-09-10T20:41:00Z",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "helm-answers-"));
  const fmHome = join(root, "firstmate");
  answersDir = join(fmHome, "state", "answers");
  mkdirSync(answersDir, { recursive: true });
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
  writeFileSync(join(answersDir, name), typeof body === "string" ? body : JSON.stringify(body));
}

describe("answer record contract", () => {
  it("accepts the declared shape", () => {
    expect(parseAnswerRecord(RECORD)).toMatchObject(RECORD);
  });

  it("accepts a record without the optional ref", () => {
    const withoutRef = { id: RECORD.id, question: RECORD.question, answer: RECORD.answer, ts: RECORD.ts };

    expect(parseAnswerRecord(withoutRef).ref).toBeUndefined();
  });

  it.each([
    ["a missing answer", { id: "a", question: "q", ts: "t" }],
    ["a missing question", { id: "a", answer: "x", ts: "t" }],
    ["a missing id", { question: "q", answer: "x", ts: "t" }],
    ["a missing ts", { id: "a", question: "q", answer: "x" }],
    ["an empty answer", { id: "a", question: "q", answer: "", ts: "t" }],
    ["a non-string answer", { id: "a", question: "q", answer: 7, ts: "t" }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseAnswerRecord(value)).toThrow();
  });
});

describe("reading the answers directory", () => {
  it("renders the question as the title and the answer as the body", () => {
    write("a.json", RECORD);

    expect(readAnswerRecords(answersDir)).toMatchObject([
      {
        id: "answers:codex-auth",
        source: "answers",
        kind: "answer",
        title: RECORD.question,
        detail: RECORD.answer,
        ref: RECORD.ref,
        openedAt: RECORD.ts,
      },
    ]);
  });

  it("is read-only: an answer declares no options, no freeform, and no channel", () => {
    write("a.json", RECORD);
    const [card] = readAnswerRecords(answersDir);

    expect(card?.options).toEqual([]);
    expect(card?.allowFreeform).toBe(false);
    expect(card?.respond).toEqual({ channel: "none" });
  });

  it("keys each card by the record id, so a later answer raises a new card", () => {
    write("a.json", RECORD);
    write("b.json", { ...RECORD, id: "codex-auth-2", answer: "a newer link" });

    expect(readAnswerRecords(answersDir).map((card) => card.id)).toEqual([
      "answers:codex-auth",
      "answers:codex-auth-2",
    ]);
  });

  it("skips an invalid record, reports it, and keeps the valid ones", () => {
    write("good.json", RECORD);
    write("bad.json", { id: "bad", question: "no answer field", ts: "t" });
    const skipped: string[] = [];

    const cards = readAnswerRecords(answersDir, (file) => skipped.push(file));

    expect(cards.map((card) => card.id)).toEqual(["answers:codex-auth"]);
    expect(skipped).toEqual(["bad.json"]);
  });

  it("skips a file that is not JSON at all rather than throwing", () => {
    write("broken.json", "{ this is not json");
    const skipped: string[] = [];

    expect(readAnswerRecords(answersDir, (file) => skipped.push(file))).toEqual([]);
    expect(skipped).toEqual(["broken.json"]);
  });

  it("ignores files that are not .json", () => {
    write("notes.txt", "loose text");

    expect(readAnswerRecords(answersDir)).toEqual([]);
  });

  it("treats a missing directory as empty — firstmate may not have written one", () => {
    expect(readAnswerRecords(join(root, "nope"))).toEqual([]);
  });
});

describe("the recorded fixture", () => {
  it("reads the checked-in answer records, so the contract is exercised as firstmate will write it", () => {
    const cards = readAnswerRecords(join(import.meta.dirname, "fixtures", "answers"));

    expect(cards.map((card) => card.id)).toEqual(["answers:codex-auth", "answers:helm-port"]);
    expect(cards[0]).toMatchObject({
      kind: "answer",
      urgency: "attention",
      title: "Give me the codex auth link I can access",
      ref: "w1:p5 · firstmate pane",
      respond: { channel: "none" },
    });
    // The optional ref is genuinely optional.
    expect(cards[1]?.ref).toBeUndefined();
  });
});

describe("answer adapter", () => {
  it("emits the current full set on start", async () => {
    write("a.json", RECORD);
    const emitted: InboxItem[][] = [];
    const adapter = createAnswerAdapter(config);

    disposers.push(await adapter.start({ emit: (items) => emitted.push(items), retract: () => undefined }));

    expect(adapter.id).toBe("answers");
    expect(emitted.at(-1)).toMatchObject([{ id: "answers:codex-auth" }]);
  });

  it("emits an empty set when there are no records, so the store retracts stale cards", async () => {
    const emitted: InboxItem[][] = [];
    const adapter = createAnswerAdapter(config);

    disposers.push(await adapter.start({ emit: (items) => emitted.push(items), retract: () => undefined }));

    expect(emitted.at(-1)).toEqual([]);
  });
});
