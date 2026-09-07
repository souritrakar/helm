/**
 * The config loader must fail loudly and specifically. A vague startup error
 * here costs an operator far more than the branch costs to test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_BIND, DEFAULT_PORT, loadConfig } from "@/lib/config";

let home: string;
/** An existing, readable directory that is NOT laid out like an FM_HOME. */
let emptyDir: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "helm-config-"));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "state"));
  emptyDir = mkdtempSync(join(tmpdir(), "helm-config-empty-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("derives the firstmate seam directories from FM_HOME", () => {
    const config = loadConfig({ FM_HOME: home });

    expect(config.fmHome).toBe(home);
    expect(config.fmBinDir).toBe(join(home, "bin"));
    expect(config.fmStateDir).toBe(join(home, "state"));
  });

  it("defaults helm's writable state dir outside FM_HOME", () => {
    const config = loadConfig({ FM_HOME: home, XDG_STATE_HOME: "/xdg-state" });

    expect(config.helmStateDir).toBe("/xdg-state/helm");
    expect(config.helmStateDir.startsWith(home)).toBe(false);
  });

  it("takes HELM_STATE_DIR when set", () => {
    const config = loadConfig({ FM_HOME: home, HELM_STATE_DIR: "/var/lib/helm" });

    expect(config.helmStateDir).toBe("/var/lib/helm");
  });

  it("defaults the bind address and port to loopback", () => {
    const config = loadConfig({ FM_HOME: home });

    expect(config.bind).toBe(DEFAULT_BIND);
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it("treats bind and port as config, not constants", () => {
    const config = loadConfig({ FM_HOME: home, HELM_BIND: "0.0.0.0", HELM_PORT: "8443" });

    expect(config.bind).toBe("0.0.0.0");
    expect(config.port).toBe(8443);
  });

  it("takes the Herdr socket path from the environment", () => {
    const config = loadConfig({ FM_HOME: home, HERDR_SOCKET_PATH: "/run/herdr/herdr.sock" });

    expect(config.herdrSocketPath).toBe("/run/herdr/herdr.sock");
  });

  it("falls back to the XDG config location for the Herdr socket", () => {
    const config = loadConfig({ FM_HOME: home, XDG_CONFIG_HOME: "/xdg" });

    expect(config.herdrSocketPath).toBe("/xdg/herdr/herdr.sock");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
  ])("treats an XDG_CONFIG_HOME that is %s as unset, per the XDG spec", (_case, value) => {
    const config = loadConfig({ FM_HOME: home, XDG_CONFIG_HOME: value });

    expect(config.herdrSocketPath).toBe(join(homedir(), ".config", "herdr", "herdr.sock"));
  });

  it.each([
    ["FM_HOME missing", () => ({}), /FM_HOME is not set/],
    ["FM_HOME relative", () => ({ FM_HOME: "firstmate" }), /must be an absolute path/],
    ["FM_HOME absent on disk", () => ({ FM_HOME: "/nonexistent/firstmate" }), /cannot be read/],
    ["FM_HOME without a bin directory", () => ({ FM_HOME: emptyDir }), /FM_HOME\/bin/],
    ["port not numeric", () => ({ FM_HOME: home, HELM_PORT: "http" }), /whole number/],
    ["port out of range", () => ({ FM_HOME: home, HELM_PORT: "70000" }), /between 1 and 65535/],
    ["port empty", () => ({ FM_HOME: home, HELM_PORT: "  " }), /set but empty/],
    ["bind with whitespace", () => ({ FM_HOME: home, HELM_BIND: "127.0.0.1 8080" }), /whitespace/],
    [
      "Herdr socket relative",
      () => ({ FM_HOME: home, HERDR_SOCKET_PATH: "herdr.sock" }),
      /must be an absolute path/,
    ],
    [
      "HELM_STATE_DIR relative",
      () => ({ FM_HOME: home, HELM_STATE_DIR: "helm-state" }),
      /HELM_STATE_DIR must be an absolute path/,
    ],
    [
      "HELM_STATE_DIR equal to FM_HOME",
      () => ({ FM_HOME: home, HELM_STATE_DIR: home }),
      /must not be equal to or under FM_HOME/,
    ],
    [
      "HELM_STATE_DIR under FM_HOME",
      () => ({ FM_HOME: home, HELM_STATE_DIR: join(home, "state", "helm") }),
      /must not be equal to or under FM_HOME/,
    ],
  ])("rejects %s", (_label, buildEnv, expected) => {
    const env = buildEnv();

    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(expected);
  });

  it("rejects an FM_HOME that is a file rather than a directory", () => {
    const file = join(home, "not-a-directory");
    writeFileSync(file, "");

    expect(() => loadConfig({ FM_HOME: file })).toThrow(/is not a directory/);
  });
});
