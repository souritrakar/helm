import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    writeCommand(commands, "pnpm", 'if [[ "${!#}" == "start" ]]; then exec sleep 30; fi');
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
});

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(readFileSync(path, "utf8").trim().split(/\s+/)[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pidfile was not written");
}
