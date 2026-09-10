/**
 * Lane H acceptance for inbox adapters against a temporary FM_HOME.
 *
 * AC 6/7 use firstmate's real decision fold. AC 8/12 assert the respond path
 * invokes fm-send.sh with verbatim task id and key. Nothing here writes under
 * the live fleet home.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStateAdapters } from "@/lib/adapters/state";
import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { scanOpenDecisions } from "@/lib/fm";
import { handleInboxHttp } from "@/lib/inbox-http";
import { createInboxStore } from "@/lib/inbox-store";
import { createResponder } from "@/lib/responder";
import { InboxVisibility } from "@/lib/inbox-visibility";
import { inboxItemId } from "@/lib/types";
import { SKIP_FM_CONTRACT, findFirstmateBin, requireFirstmateBin } from "./seam";

const firstmateBin = findFirstmateBin();

describe.skipIf(SKIP_FM_CONTRACT)("live adapter inbox acceptance", () => {
  const temporary: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("raises a needs-decision card and keeps it after a later done: line (AC 6, AC 7)", async () => {
    requireFirstmateBin(firstmateBin);
    const { config, status } = fleetHome();
    writeFileSync(status, "working: start\nneeds-decision [key=api-shape]: A or B?\n");
    const store = createInboxStore(config.helmStateDir);
    const adapter = statusAdapter(config);
    const handle = await adapter.start({
      emit: (items) => store.reconcile(adapter.id, items),
      retract: (ids) => store.retract(ids),
    });
    try {
      await waitFor(() => store.listOpen().some((item) => item.respond.key === "api-shape"));
      const before = store.listOpen().find((item) => item.respond.key === "api-shape");
      expect(before).toMatchObject({
        id: inboxItemId("status-decisions", "throwaway-ac:api-shape"),
        kind: "status-decision",
        taskId: "throwaway-ac",
        allowFreeform: true,
        respond: { channel: "resolve-key", target: "throwaway-ac", key: "api-shape" },
      });

      writeFileSync(
        status,
        `${readFileSync(status, "utf8")}working: still going\ndone: shipped unrelated work\n`,
      );
      expect(await scanOpenDecisions(config)).toEqual([
        { taskId: "throwaway-ac", key: "api-shape", verb: "needs-decision", note: "A or B?" },
      ]);
      await waitFor(() => {
        const open = store.listOpen().find((item) => item.id === before?.id);
        return open !== undefined;
      });
      expect(store.listOpen().some((item) => item.id === before?.id)).toBe(true);
    } finally {
      handle[Symbol.dispose]();
    }
  });

  it("answers the card through fm-send.sh --resolve-key and leaves the open set (AC 8, AC 12)", async () => {
    requireFirstmateBin(firstmateBin);
    const { config, status } = fleetHome();
    writeFileSync(status, "needs-decision [key=api-shape]: A or B?\n");
    const store = createInboxStore(config.helmStateDir);
    const adapter = statusAdapter(config);
    const handle = await adapter.start({
      emit: (items) => store.reconcile(adapter.id, items),
      retract: (ids) => store.retract(ids),
    });
    const argvLog: string[][] = [];
    try {
      await waitFor(() => store.listOpen().length === 1);
      const item = store.listOpen()[0];
      if (item === undefined) throw new Error("expected a card");
      const baseUrl = await startHttp(store, config, argvLog);
      const response = await fetch(`${baseUrl}/api/inbox/${encodeURIComponent(item.id)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "choose A" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; argv: string[] };
      expect(body.ok).toBe(true);
      expect(body.argv).toEqual([
        join(config.fmBinDir, "fm-send.sh"),
        "throwaway-ac",
        "--resolve-key",
        "api-shape",
        "choose A",
      ]);
      expect(store.listOpen()).toHaveLength(0);
      expect(store.isHandled(item.id)).toBe(true);
      expect(argvLog).toEqual([body.argv]);
    } finally {
      handle[Symbol.dispose]();
    }
  });

  it("does not resurrect an answered card after a store restart (AC 11)", async () => {
    requireFirstmateBin(firstmateBin);
    const { config, status } = fleetHome();
    writeFileSync(status, "needs-decision [key=api-shape]: A or B?\n");
    const store = createInboxStore(config.helmStateDir);
    const adapter = statusAdapter(config);
    const handle = await adapter.start({
      emit: (items) => store.reconcile(adapter.id, items),
      retract: (ids) => store.retract(ids),
    });
    await waitFor(() => store.listOpen().length === 1);
    const id = store.listOpen()[0]?.id;
    if (id === undefined) throw new Error("expected a card");
    store.markAnswered(id);
    handle[Symbol.dispose]();

    const restarted = createInboxStore(config.helmStateDir);
    const again = await adapter.start({
      emit: (items) => restarted.reconcile(adapter.id, items),
      retract: (ids) => restarted.retract(ids),
    });
    try {
      await waitFor(() => restarted.isHandled(id));
      expect(restarted.listOpen()).toHaveLength(0);
    } finally {
      again[Symbol.dispose]();
    }
  });

  function fleetHome(): { config: HelmConfig; status: string } {
    requireFirstmateBin(firstmateBin);
    const home = mkdtempSync(join(tmpdir(), "helm-ac-"));
    temporary.push(home);
    symlinkSync(firstmateBin, join(home, "bin"), "dir");
    mkdirSync(join(home, "state"));
    mkdirSync(join(home, "data"));
    return {
      config: {
        fmHome: home,
        fmBinDir: join(home, "bin"),
        fmStateDir: join(home, "state"),
        helmStateDir: join(home, "helm-state"),
        herdrSocketPath: join(home, "herdr.sock"),
        herdrBin: "herdr",
        port: DEFAULT_PORT,
        bind: DEFAULT_BIND,
      },
      status: join(home, "state", "throwaway-ac.status"),
    };
  }

  async function startHttp(
    store: ReturnType<typeof createInboxStore>,
    config: HelmConfig,
    argvLog: string[][],
  ): Promise<string> {
    const responder = createResponder({
      config,
      audit: { append: () => undefined },
      exec: {
        resolveKey: async (item, answer) => {
          const argv = [
            join(config.fmBinDir, "fm-send.sh"),
            item.respond.target ?? "",
            "--resolve-key",
            item.respond.key ?? "",
            answer,
          ];
          argvLog.push(argv);
          return {
            ok: true,
            channel: "resolve-key" as const,
            argv,
            exitCode: 0,
            stdout: "",
            stderr: "",
            at: "2026-09-07T00:00:00.000Z",
          };
        },
      },
    });
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleInboxHttp(req, res, {
        store,
        responder,
        allowedHosts: [`127.0.0.1:${addressPort(server)}`, `localhost:${addressPort(server)}`],
        visibility: new InboxVisibility(),
      }).then((owned) => {
        if (!owned) {
          res.writeHead(404);
          res.end("not inbox");
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${addressPort(server)}`;
  }
});

function statusAdapter(config: HelmConfig) {
  const adapter = createStateAdapters(config, { relayTarget: () => undefined }).find((entry) => entry.id === "status-decisions");
  if (adapter === undefined) throw new Error("missing status-decisions adapter");
  return adapter;
}

function addressPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return address.port;
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for inbox state");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
