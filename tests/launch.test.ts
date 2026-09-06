import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { portIsAvailable, versionAtLeast } from "@/lib/launch";

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
    await expect(portIsAvailable("127.0.0.1", address.port)).resolves.toBe(false);
  });
});
