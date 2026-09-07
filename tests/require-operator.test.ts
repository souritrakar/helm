/**
 * requireOperator local-mode gate (SPEC D10).
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { allowedHostsForBind, requireOperator } from "@/lib/require-operator";

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

const ALLOWED = allowedHostsForBind("127.0.0.1", 7333);

describe("requireOperator", () => {
  it("allows a local JSON mutating call with an allowlisted Host", () => {
    expect(
      requireOperator(req({ "content-type": "application/json", host: "127.0.0.1:7333" }), {
        mutate: true,
        allowedHosts: ALLOWED,
      }),
    ).toEqual({ allow: true });
  });

  it("rejects mutating calls without application/json", () => {
    const decision = requireOperator(
      req({ "content-type": "text/plain", host: "127.0.0.1:7333" }),
      { mutate: true, allowedHosts: ALLOWED },
    );
    expect(decision.allow).toBe(false);
  });

  it("rejects a Host outside the allowlist (DNS rebinding)", () => {
    const decision = requireOperator(
      req({
        "content-type": "application/json",
        host: "helm.attacker.example:7333",
        origin: "http://helm.attacker.example:7333",
        "sec-fetch-site": "same-origin",
      }),
      { mutate: true, allowedHosts: ALLOWED },
    );
    expect(decision.allow).toBe(false);
  });

  it("rejects Sec-Fetch-Site cross-site", () => {
    const decision = requireOperator(
      req({
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
        host: "127.0.0.1:7333",
      }),
      { mutate: true, allowedHosts: ALLOWED },
    );
    expect(decision.allow).toBe(false);
  });

  it("rejects Origin that does not match Host", () => {
    const decision = requireOperator(
      req({
        "content-type": "application/json",
        origin: "http://evil.example:7333",
        host: "127.0.0.1:7333",
      }),
      { mutate: true, allowedHosts: ALLOWED },
    );
    expect(decision.allow).toBe(false);
  });

  it("allows Origin that matches Host", () => {
    expect(
      requireOperator(
        req({
          "content-type": "application/json",
          origin: "http://127.0.0.1:7333",
          host: "127.0.0.1:7333",
          "sec-fetch-site": "same-origin",
        }),
        { mutate: true, allowedHosts: ALLOWED },
      ),
    ).toEqual({ allow: true });
  });
});

describe("allowedHostsForBind", () => {
  it("includes loopback spellings for the configured port", () => {
    const hosts = allowedHostsForBind("127.0.0.1", 7333);
    expect(hosts).toContain("127.0.0.1:7333");
    expect(hosts).toContain("localhost:7333");
  });

  it.each([80, 443])("includes portless loopback forms on default port %i", (port) => {
    const hosts = allowedHostsForBind("127.0.0.1", port);
    expect(hosts).toContain("127.0.0.1");
    expect(hosts).toContain("localhost");
    expect(
      requireOperator(req({ "content-type": "application/json", host: "127.0.0.1" }), {
        mutate: true,
        allowedHosts: hosts,
      }),
    ).toEqual({ allow: true });
  });
});
