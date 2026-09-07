import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { HelmConfig } from "@/lib/config";
import { describePortProblem, launchDoctor, probePort, versionAtLeast } from "@/lib/launch";

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
  it("blames the endpoint only when helm itself is not the listener", async () => {
    server = createServer(); await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const config: HelmConfig = {
      fmHome: "/fixture/firstmate", fmBinDir: "/fixture/firstmate/bin", fmStateDir: "/fixture/firstmate/state",
      herdrSocketPath: "/fixture/herdr.sock", herdrBin: "herdr",
      bind: "127.0.0.1", port: address.port,
    };
    const inUse = `127.0.0.1:${address.port} is already in use`;

    const foreign = await launchDoctor(config);
    const ours = await launchDoctor(config, { portOwnerPid: process.pid });

    expect(foreign.problems).toContain(inUse);
    expect(foreign.portHeldByHelm).toBe(false);
    expect(ours.problems).not.toContain(inUse);
    expect(ours.portHeldByHelm).toBe(true);
  });
  it("names the cause rather than always blaming another listener", () => {
    const endpoint = { bind: "192.0.2.1", port: 7333 };
    expect(describePortProblem(endpoint, "EADDRINUSE")).toBe("192.0.2.1:7333 is already in use");
    expect(describePortProblem({ bind: "127.0.0.1", port: 80 }, "EACCES")).toContain("permission denied");
    expect(describePortProblem(endpoint, "EADDRNOTAVAIL")).toContain("is not an address of this host");
    expect(describePortProblem(endpoint, "ENOTFOUND")).toContain("ENOTFOUND");
  });
});
