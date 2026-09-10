/**
 * AC 18: helm creates or modifies no file under $FM_HOME.
 *
 * Checksum `state/` and `data/` before and after a full inbox session with no
 * response submitted. Any difference fails. Helm state (history, audit) lives
 * under HELM_STATE_DIR, which this test keeps outside FM_HOME.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BIND, DEFAULT_PORT, type HelmConfig } from "@/lib/config";
import { handleInboxHttp } from "@/lib/inbox-http";
import { createInboxRuntime } from "@/lib/inbox-runtime";
import { SKIP_FM_CONTRACT, findFirstmateBin, requireFirstmateBin } from "./seam";

const firstmateBin = findFirstmateBin();

describe.skipIf(SKIP_FM_CONTRACT)("AC 18 FM_HOME is untouched", () => {
  const temporary: string[] = [];
  const servers: Server[] = [];
  const sockets: ReturnType<typeof createNetServer>[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    for (const server of sockets.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("leaves state/ and data/ checksums unchanged across a full session with no response", async () => {
    requireFirstmateBin(firstmateBin);
    const root = mkdtempSync(join(tmpdir(), "helm-ac18-"));
    temporary.push(root);
    const fmHome = join(root, "firstmate");
    mkdirSync(join(fmHome, "state"), { recursive: true });
    mkdirSync(join(fmHome, "data"), { recursive: true });
    writeFileSync(join(fmHome, "state", "probe.status"), "working: checksum probe\n");
    writeFileSync(join(fmHome, "data", "marker.txt"), "helm must not rewrite this\n");
    symlinkSync(firstmateBin, join(fmHome, "bin"), "dir");

    const herdrBin = join(root, "herdr");
    writeFileSync(
      herdrBin,
      `#!/bin/sh\nprintf '%s\\n' '{"id":"helm","result":{"type":"agent_list","agents":[]}}'\n`,
      { mode: 0o755 },
    );
    chmodSync(herdrBin, 0o755);
    const herdrSocketPath = join(root, "herdr.sock");
    const herdr = await listenHerdr(herdrSocketPath);
    sockets.push(herdr);

    const config: HelmConfig = {
      fmHome,
      fmBinDir: join(fmHome, "bin"),
      fmStateDir: join(fmHome, "state"),
      helmStateDir: join(root, "helm-state"),
      herdrSocketPath,
      herdrBin,
      port: DEFAULT_PORT,
      bind: DEFAULT_BIND,
    };

    const beforeState = checksumTree(join(fmHome, "state"));
    const beforeData = checksumTree(join(fmHome, "data"));

    const runtime = createInboxRuntime(config, { relayTarget: () => undefined });
    await runtime.start();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleInboxHttp(req, res, {
        store: runtime.store,
        responder: runtime.responder,
        allowedHosts: [`127.0.0.1:${addressPort(server)}`, `localhost:${addressPort(server)}`],
        visibility: runtime.visibility,
      }).then((owned) => {
        if (!owned) {
          res.writeHead(404);
          res.end("not inbox");
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${addressPort(server)}`;

    try {
      const inbox = await fetch(`${baseUrl}/api/inbox`);
      expect(inbox.status).toBe(200);
      await inbox.json();

      const events = await fetch(`${baseUrl}/api/events`);
      expect(events.status).toBe(200);
      const reader = events.body?.getReader();
      if (reader === undefined) throw new Error("no SSE body");
      const decoder = new TextDecoder();
      let buffer = "";
      while (!buffer.includes("event: snapshot.end")) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
      expect(buffer).toContain("event: snapshot.begin");
      expect(buffer).toContain("event: snapshot.end");

      const session = await fetch(`${baseUrl}/api/inbox/visibility`);
      expect(session.status).toBe(200);
      const tokenBody = (await session.json()) as { token: string };
      const presence = await fetch(`${baseUrl}/api/inbox/visibility`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Helm-Visibility-Session": tokenBody.token,
        },
        body: JSON.stringify({ sequence: 0, active: true, itemIds: [] }),
      });
      expect(presence.status).toBe(200);

      expect(checksumTree(join(fmHome, "state"))).toBe(beforeState);
      expect(checksumTree(join(fmHome, "data"))).toBe(beforeData);
    } finally {
      runtime.stop();
    }
  });
});

async function listenHerdr(path: string): Promise<ReturnType<typeof createNetServer>> {
  const server = createNetServer((socket: Socket) => {
    socket.setEncoding("utf8");
    socket.on("data", () => {
      socket.write('{"result":{"type":"subscription_started"}}\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return server;
}

function addressPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return address.port;
}

/**
 * Content checksum of a directory tree. Directory mtimes are ignored so a
 * read-only walk cannot fail the proof. Symlink targets are hashed, not the
 * contents they point at.
 */
export function checksumTree(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        walk(path);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link:${rel}:${readlinkSync(path)}\n`);
      } else if (entry.isFile()) {
        hash.update(`file:${rel}:${statSync(path).size}:`);
        hash.update(readFileSync(path));
        hash.update("\n");
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}
