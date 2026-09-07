/**
 * requireOperator local-mode gate (SPEC D10).
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { requireOperator } from "@/lib/require-operator";

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("requireOperator", () => {
  it("allows a local JSON mutating call with no Origin", () => {
    expect(
      requireOperator(req({ "content-type": "application/json" }), { mutate: true }),
    ).toEqual({ allow: true });
  });

  it("rejects mutating calls without application/json", () => {
    const decision = requireOperator(req({ "content-type": "text/plain" }), { mutate: true });
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
      { mutate: true },
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
      { mutate: true },
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
        { mutate: true },
      ),
    ).toEqual({ allow: true });
  });
});
