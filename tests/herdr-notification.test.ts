import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { showHerdrNotification } from "@/lib/herdr";

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Herdr notification bridge", () => {
  it("uses the native notification command as an argv vector", async () => {
    directory = mkdtempSync(join(tmpdir(), "helm-notification-"));
    const capturedArgs = join(directory, "args.txt");
    const binary = join(directory, "herdr-stub");
    writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capturedArgs)}\n`, { mode: 0o755 });
    const config: HelmConfig = {
      fmHome: "/fixture/firstmate",
      fmBinDir: "/fixture/firstmate/bin",
      fmStateDir: "/fixture/firstmate/state",
      helmStateDir: "/fixture/helm-state",
      herdrSocketPath: "/fixture/herdr.sock",
      herdrBin: binary,
      port: DEFAULT_PORT,
      bind: DEFAULT_BIND,
    };

    const result = await showHerdrNotification(config, "Captain action needed", "Review task: helm-notifs");

    expect(result.exitCode).toBe(0);
    expect(result.argv).toEqual([
      binary,
      "notification",
      "show",
      "--title",
      "Captain action needed",
      "--body",
      "Review task: helm-notifs",
    ]);
    expect(readFileSync(capturedArgs, "utf8").split("\n").filter(Boolean)).toEqual([
      "notification",
      "show",
      "--title",
      "Captain action needed",
      "--body",
      "Review task: helm-notifs",
    ]);
  });
});
