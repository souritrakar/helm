/**
 * Boundary tests for the answer seams.
 *
 * helm is a channel, not an authority: it rejects anything it cannot pass on
 * verbatim BEFORE spawning a script. Every case here throws before any exec, so
 * the suite is hermetic and touches no `$FM_HOME`.
 */
import { describe, expect, it } from "vitest";

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
    ["taskId", { ...answer, taskId: "webface\tplan" }],
    ["answer", { ...answer, answer: "option-a\nforged\tline" }],
    ["label", { ...answer, label: "captain\tvia helm" }],
  ])("rejects a %s that would forge an extra intake line", async (_case, forged) => {
    await expect(captainHoldAnswers(CONFIG, [forged], { source: "helm" })).rejects.toThrow(
      FmContractError,
    );
  });
});
