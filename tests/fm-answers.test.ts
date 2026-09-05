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
