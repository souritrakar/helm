/**
 * Contract tests for argv-only exec.
 *
 * The case that matters most here is a child that exits before draining stdin:
 * the resulting EPIPE must come back inside the {@link ExecResult}, because an
 * unhandled stream `error` event would terminate helm's long-lived server.
 */
import { describe, expect, it } from "vitest";

import { describeFailure, runArgv, runArgvOrThrow, succeeded } from "@/lib/exec";

/** Larger than a pipe buffer, so the write cannot complete before the exit. */
const UNDRAINABLE_INPUT = "x".repeat(1024 * 1024);

describe("runArgv", () => {
  it("captures stdout and a clean exit", async () => {
    const result = await runArgv("printf", ["%s", "helm"]);

    expect(result.stdout).toBe("helm");
    expect(result.exitCode).toBe(0);
    expect(result.stdinError).toBeNull();
    expect(succeeded(result)).toBe(true);
  });

  it("reports a spawn failure rather than throwing", async () => {
    const result = await runArgv("helm-no-such-command", []);

    expect(result.exitCode).toBeNull();
    expect(result.error).not.toBeNull();
    expect(succeeded(result)).toBe(false);
  });

  it("survives a child that exits before draining stdin, and reports the write failure", async () => {
    const result = await runArgv("sh", ["-c", "exit 0"], { input: UNDRAINABLE_INPUT });

    expect(result.exitCode).toBe(0);
    expect(result.stdinError).toMatch(/EPIPE/);
    expect(succeeded(result)).toBe(false);
    expect(describeFailure(result)).toMatch(/stdin/);
  });

  it("keeps the child's own diagnosis when it rejects the input and exits nonzero", async () => {
    const result = await runArgv("sh", ["-c", "echo '--source is required' >&2; exit 2"], {
      input: UNDRAINABLE_INPUT,
    });

    expect(result.exitCode).toBe(2);
    expect(describeFailure(result)).toMatch(/exited 2: --source is required/);
  });

  it("throws from runArgvOrThrow when the input never reached the child", async () => {
    await expect(runArgvOrThrow("sh", ["-c", "exit 0"], { input: UNDRAINABLE_INPUT })).rejects.toThrow(
      /stdin/,
    );
  });
});
