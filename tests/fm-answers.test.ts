/**
 * Boundary tests for the answer seams.
 *
 * helm is a channel, not an authority: it rejects anything it cannot pass on
 * verbatim BEFORE spawning a script, and it never reports an answer as recorded
 * that the intake did not close. Hermetic — the boundary cases throw before any
 * exec, and the reconciliation cases run a stand-in intake in a temp directory,
 * so no case touches a real `$FM_HOME`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { FmContractError, captainHoldAnswers, sendResolveKey } from "@/lib/fm";

const CONFIG: HelmConfig = {
  fmHome: "/fixture/firstmate",
  fmBinDir: "/fixture/firstmate/bin",
  fmStateDir: "/fixture/firstmate/state",
  herdrSocketPath: "/fixture/herdr.sock",
  herdrBin: "herdr",
  port: DEFAULT_PORT,
  bind: DEFAULT_BIND,
};

describe("sendResolveKey", () => {
  it.each([
    ["an empty task id", { taskId: "", key: "api-shape", answer: "A" }],
    ["a task id carrying a newline", { taskId: "helm\nfoundation", key: "api-shape", answer: "A" }],
    ["a key outside the allowed alphabet", { taskId: "helm", key: "api shape", answer: "A" }],
    ["an empty answer", { taskId: "helm", key: "api-shape", answer: "  " }],
  ])("rejects %s before invoking fm-send.sh", async (_case, request) => {
    await expect(sendResolveKey(CONFIG, request)).rejects.toThrow(FmContractError);
  });

  it.each([
    ["--resolve-key=some-other-key"],
    ["--resolve-key"],
    ["--fire-and-forget=delivery-1"],
    ["--fire-and-forget"],
  ])("rejects the answer %s, which fm-send.sh would read as an option", async (answer) => {
    await expect(
      sendResolveKey(CONFIG, { taskId: "helm", key: "api-shape", answer }),
    ).rejects.toThrow(/would be read as fm-send\.sh's/);
  });

  it("passes an answer that merely starts with a dash, which fm-send.sh reads as the message", async () => {
    const result = await sendResolveKey(CONFIG, {
      taskId: "helm",
      key: "api-shape",
      answer: "-1 is fine",
    });

    expect(result.argv).toEqual([
      "/fixture/firstmate/bin/fm-send.sh",
      "helm",
      "--resolve-key",
      "api-shape",
      "-1 is fine",
    ]);
  });
});

describe("captainHoldAnswers", () => {
  const answer = { taskId: "webface-plan", answer: "option-a", label: "captain" };

  it("requires at least one answer", async () => {
    await expect(captainHoldAnswers(CONFIG, [], { source: "helm" })).rejects.toThrow(
      FmContractError,
    );
  });

  it.each([
    ["empty", ""],
    ["a tab", "helm\tui"],
    ["a newline", "helm\nui"],
  ])("rejects a source that is %s, which fm-captain-hold.sh requires", async (_case, source) => {
    await expect(captainHoldAnswers(CONFIG, [answer], { source })).rejects.toThrow(FmContractError);
  });

  it.each([
    ["outside the intake alphabet", "webface plan"],
    ["a slash the intake alphabet excludes", "webface/plan"],
    ["longer than the intake's 128-character limit", "w".repeat(129)],
  ])("rejects a taskId that is %s, which the intake drops without a word", async (_case, taskId) => {
    await expect(
      captainHoldAnswers(CONFIG, [{ ...answer, taskId }], { source: "helm" }),
    ).rejects.toThrow(FmContractError);
  });

  it("accepts a taskId exactly at the intake's 128-character limit", async () => {
    const result = await captainHoldAnswers(
      CONFIG,
      [{ ...answer, taskId: "w".repeat(128) }],
      { source: "helm" },
    );

    expect(result.ok).toBe(false);
    expect(result.argv[0]).toBe("/fixture/firstmate/bin/fm-captain-hold.sh");
  });

  it.each([
    ["only control characters", "\u0001\u0002"],
    ["a lone DEL", "\u007f"],
  ])("rejects an answer of %s, which sanitizes to nothing at the intake", async (_case, text) => {
    await expect(
      captainHoldAnswers(CONFIG, [{ ...answer, answer: text }], { source: "helm" }),
    ).rejects.toThrow(/no content the intake would keep/);
  });

  it.each([
    ["taskId", { ...answer, taskId: "webface\tplan" }],
    ["answer", { ...answer, answer: "option-a\nforged\tline" }],
    ["label", { ...answer, label: "captain\tvia helm" }],
  ])("rejects a %s that would forge an extra intake line", async (_case, forged) => {
    await expect(captainHoldAnswers(CONFIG, [forged], { source: "helm" })).rejects.toThrow(
      FmContractError,
    );
  });
});

/**
 * `fm-captain-hold.sh answers` drops an unusable row without a word and without
 * counting it as skipped, then exits 0. These run a stand-in that reproduces
 * that closing tally, so helm's reconciliation is exercised end to end.
 */
describe("captainHoldAnswers reconciliation", () => {
  let binDir: string;

  function stubIntake(body: string): HelmConfig {
    writeFileSync(join(binDir, "fm-captain-hold.sh"), `#!/bin/sh\ncat >/dev/null\n${body}\n`, {
      mode: 0o755,
    });
    return { ...CONFIG, fmBinDir: binDir };
  }

  const ANSWERS = [
    { taskId: "webface-plan", answer: "option-a", label: "captain" },
    { taskId: "helm-foundation", answer: "option-b", label: "captain" },
  ];

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "helm-intake-"));
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it("reports success when the intake closes every answer submitted", async () => {
    const result = await captainHoldAnswers(
      stubIntake("printf 'answers: closed=2 skipped=0\\n'"),
      ANSWERS,
      { source: "helm" },
    );

    expect(result.ok).toBe(true);
  });

  it("fails when the intake exits 0 having closed nothing", async () => {
    const result = await captainHoldAnswers(
      stubIntake("printf 'answers: closed=0 skipped=0\\n'"),
      ANSWERS,
      { source: "helm" },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/recorded 0 of 2 submitted answer/);
  });

  it("fails when the intake closes only some of the answers submitted", async () => {
    const result = await captainHoldAnswers(
      stubIntake("printf 'closed: webface-plan\\nanswers: closed=1 skipped=0\\n'"),
      ANSWERS,
      { source: "helm" },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/recorded 1 of 2 submitted answer/);
  });

  it("fails when the intake exits 0 without printing its tally at all", async () => {
    const result = await captainHoldAnswers(stubIntake("printf 'done\\n'"), ANSWERS, {
      source: "helm",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/without its "answers: closed/);
  });
});
