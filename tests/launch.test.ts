import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { HelmConfig } from "@/lib/config";
import { describePortProblem, launchDoctor, probePort, versionAtLeast } from "@/lib/launch";
import { listenerPids } from "@/lib/listener";

function endpointConfig(port: number): HelmConfig {
  return {
    fmHome: "/fixture/firstmate", fmBinDir: "/fixture/firstmate/bin", fmStateDir: "/fixture/firstmate/state",
    herdrSocketPath: "/fixture/herdr.sock", herdrBin: "herdr",
    bind: "127.0.0.1", port,
  };
}

describe("launch checks", () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => { if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve())); });
  it("requires the documented major versions", () => {
    expect(versionAtLeast("24.0.0", 24)).toBe(true);
    expect(versionAtLeast("23.99.0", 24)).toBe(false);
    expect(versionAtLeast("not-a-version", 24)).toBe(false);
  });
  it("reports a port as unavailable while another server owns it", async () => {
    server = createServer(); await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("expected TCP address");
    await expect(probePort("127.0.0.1", address.port)).resolves.toEqual({ available: false, code: "EADDRINUSE" });
  });
  it("distinguishes an unassignable bind address from a taken port", async () => {
    // 192.0.2.1 is TEST-NET-1: reserved for documentation, never a local address.
    await expect(probePort("192.0.2.1", 7333)).resolves.toEqual({ available: false, code: "EADDRNOTAVAIL" });
  });
  it("accepts a busy endpoint only when the claimed instance is the real listener", async () => {
    server = createServer(); await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const config = endpointConfig(address.port);
    // Alive, and holding nothing: a live pid alone must not vouch for the port.
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000);"]);
    try {
      const unclaimed = await launchDoctor(config);
      const claimed = await launchDoctor(config, { portOwnerPid: bystander.pid });
      const ours = await launchDoctor(config, { portOwnerPid: process.pid });

      expect(unclaimed.portHeldByHelm).toBe(false);
      expect(unclaimed.problems).toContain(`127.0.0.1:${address.port} is already in use`);
      expect(claimed.portHeldByHelm).toBe(false);
      expect(claimed.problems).toContain(
        `127.0.0.1:${address.port} is already in use by pid ${process.pid}, not by the running helm instance (pid ${bystander.pid})`,
      );
      expect(ours.portHeldByHelm).toBe(true);
      expect(ours.problems.join(" ")).not.toContain("already in use");
    } finally {
      bystander.kill("SIGKILL");
      await new Promise<void>((resolve) => bystander.once("exit", () => resolve()));
    }
  });
  it("still recognises helm's socket when a second address holds the same port", async () => {
    server = createServer(); await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("expected TCP address");
    // 127.0.0.2 does not conflict with 127.0.0.1, so both listeners hold this port.
    const neighbour = spawn(process.execPath, [
      "-e",
      'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.2", () => console.log("ready"));',
      String(address.port),
    ]);
    await new Promise<void>((resolve) => neighbour.stdout.once("data", () => resolve()));
    try {
      const doctor = await launchDoctor(endpointConfig(address.port), { portOwnerPid: process.pid });

      expect(listenerPids(address.port)).toEqual(expect.arrayContaining([process.pid, neighbour.pid]));
      expect(doctor.portHeldByHelm).toBe(true);
      expect(doctor.problems.join(" ")).not.toContain("already in use");
    } finally {
      neighbour.kill("SIGKILL");
      await new Promise<void>((resolve) => neighbour.once("exit", () => resolve()));
    }
  });
  it("reports an endpoint the running instance has not bound", async () => {
    server = createServer(); await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("expected TCP address");
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    const doctor = await launchDoctor(endpointConfig(address.port), { portOwnerPid: process.pid });

    expect(doctor.ok).toBe(false);
    expect(doctor.portHeldByHelm).toBe(false);
    expect(doctor.problems).toContain(
      `127.0.0.1:${address.port} is not bound by the running helm instance (pid ${process.pid}); the instance may still be starting, or HELM_BIND and HELM_PORT may differ from the endpoint it bound`,
    );
  });
  it("names the cause rather than always blaming another listener", () => {
    const endpoint = { bind: "192.0.2.1", port: 7333 };
    expect(describePortProblem(endpoint, "EADDRINUSE")).toBe("192.0.2.1:7333 is already in use");
    expect(describePortProblem({ bind: "127.0.0.1", port: 80 }, "EACCES")).toContain("permission denied");
    expect(describePortProblem(endpoint, "EADDRNOTAVAIL")).toContain("is not an address of this host");
    expect(describePortProblem(endpoint, "ENOTFOUND")).toContain("ENOTFOUND");
  });
});
