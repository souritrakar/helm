import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspace() {
  const path = mkdtempSync(join(tmpdir(), "helm-launch-"));
  temporary.push(path);
  return path;
}

function writeCommand(directory: string, name: string, body: string) {
  writeFileSync(join(directory, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
}

function processGroup(pid: number): number {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[2]);
}

describe("helm launcher", () => {
  it("runs the foreground server in the pidfile process group", async () => {
    const directory = workspace();
    const commands = join(directory, "bin");
    const state = join(directory, "state");
    mkdirSync(commands); mkdirSync(state);
    writeCommand(commands, "pnpm", [
      'if [[ "$*" == *"helm-state-config.ts"* ]]; then printf "%s\\n" "$HELM_STATE_DIR"; exit 0; fi',
      `if [[ "$1" == "--dir" && "$2" == "${root}" && "$3" == "start" ]]; then exec sleep 30; fi`,
    ].join("\n"));
    const child = spawn(join(root, "bin/helm"), ["start"], {
      env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, HELM_FOREGROUND: "1", HELM_STATE_DIR: state },
    });
    const pidFile = join(state, "helm.pid");
    try {
      const pid = await waitForPid(pidFile);
      expect(processGroup(pid)).toBe(pid);
    } finally {
      spawnSync(join(root, "bin/helm"), ["stop"], {
        env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, HELM_STATE_DIR: state },
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("rejects unit values that require systemd escaping before writing a unit", () => {
    const directory = workspace();
    const commands = join(directory, "bin");
    const home = join(directory, "home");
    mkdirSync(commands); mkdirSync(home);
    writeCommand(commands, "pnpm", 'printf "127.0.0.1 7333 /fixture/firstmate\\n"');
    const result = spawnSync(join(root, "bin/helm"), ["install-service"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${commands}:${process.env.PATH}`,
        HOME: home,
        HELM_STATE_DIR: `${directory}/state"unsafe`,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HELM_STATE_DIR contains systemd unit syntax requiring escaping");
    expect(existsSync(join(home, ".config/systemd/user"))).toBe(false);
  });

  it("rejects dollar-bearing unit values before writing a unit", () => {
    const directory = workspace();
    const commands = join(directory, "bin");
    const home = join(directory, "home");
    mkdirSync(commands); mkdirSync(home);
    writeCommand(commands, "pnpm", 'printf "127.0.0.1 7333 /fixture/firstmate\\n"');
    const result = spawnSync(join(root, "bin/helm"), ["install-service"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${commands}:${process.env.PATH}`,
        HOME: home,
        HELM_STATE_DIR: `${directory}/state$unsafe`,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HELM_STATE_DIR contains systemd unit syntax requiring escaping");
    expect(existsSync(join(home, ".config/systemd/user"))).toBe(false);
  });

  it("rejects a newline-bearing FM_HOME before serializing service configuration", () => {
    const directory = workspace();
    const fmHome = join(directory, "firstmate\nunsafe");
    const home = join(directory, "home");
    mkdirSync(join(fmHome, "bin"), { recursive: true });
    mkdirSync(join(fmHome, "state"));
    mkdirSync(home);
    const result = spawnSync(join(root, "bin/helm"), ["install-service"], {
      encoding: "utf8",
      env: { ...process.env, FM_HOME: fmHome, HOME: home, HELM_STATE_DIR: join(directory, "state") },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FM_HOME contains systemd unit syntax requiring escaping");
    expect(existsSync(join(home, ".config/systemd/user"))).toBe(false);
  });

  it("does not report a foreign listener as a successful start", async () => {
    const directory = workspace();
    const commands = join(directory, "bin");
    const state = join(directory, "state");
    mkdirSync(commands); mkdirSync(state);
    const foreign = createServer();
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const address = foreign.address(); if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const port = address.port;
    writeCommand(commands, "pnpm", [
      'if [[ "$*" == *"helm-state-config.ts"* ]]; then printf "%s\\n" "$HELM_STATE_DIR"; exit 0; fi',
      'if [[ "$*" == *"helm-doctor.ts"* ]]; then exit 0; fi',
      'if [[ "$*" == *"helm-endpoint.ts"* ]]; then printf "127.0.0.1 ' + String(port) + '\\n"; exit 0; fi',
      'if [[ "$*" == *"helm-endpoint-owner.ts"* ]]; then exit 1; fi',
      'if [[ "${!#}" == "start" ]]; then exec sleep 30; fi',
    ].join("\n"));
    try {
      const result = spawnSync(join(root, "bin/helm"), ["start"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, HELM_STATE_DIR: state },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("helm: started");
      expect(result.stderr).toContain(`127.0.0.1:${String(port)} is held by a non-helm listener`);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it("refuses FM_HOME state before creating or cleaning it", () => {
    const directory = workspace();
    const fmHome = join(directory, "firstmate");
    const state = join(fmHome, "helm-state");
    mkdirSync(join(fmHome, "bin"), { recursive: true });
    mkdirSync(join(fmHome, "state"));
    const start = spawnSync(join(root, "bin/helm"), ["start"], {
      encoding: "utf8",
      env: { ...process.env, FM_HOME: fmHome, HELM_STATE_DIR: state },
    });

    expect(start.status).toBe(1);
    expect(start.stderr).toContain("must not be equal to or under FM_HOME");
    expect(existsSync(state)).toBe(false);

    mkdirSync(state);
    const pidFile = join(state, "helm.pid");
    writeFileSync(pidFile, "999999 0\n");
    const status = spawnSync(join(root, "bin/helm"), ["status"], {
      encoding: "utf8",
      env: { ...process.env, FM_HOME: fmHome, HELM_STATE_DIR: state },
    });

    expect(status.status).toBe(1);
    expect(status.stderr).toContain("must not be equal to or under FM_HOME");
    expect(existsSync(pidFile)).toBe(true);
  });
});

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(readFileSync(path, "utf8").trim().split(/\s+/)[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pidfile was not written");
}
