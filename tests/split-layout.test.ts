/**
 * The split sizes ride in a cookie so the server render already knows them.
 * That makes the cookie value untrusted input on a path the page cannot skip:
 * a stale, truncated, or hand-edited value must degrade to the default split
 * instead of throwing during the server render.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  parseSplitLayout,
  saveSplitLayout,
  splitDefaultLayout,
  splitLayoutCookieName,
} from "@/components/split-layout";

/** Capture what `saveSplitLayout` writes, the way a browser cookie jar would. */
function captureWrittenCookie(): { value(): string | undefined } {
  let written: string | undefined;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      set cookie(raw: string) {
        written = raw;
      },
    },
  });
  return { value: () => written };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
});

describe("split layout persistence", () => {
  it("round-trips a dragged layout through the cookie it writes", () => {
    const jar = captureWrittenCookie();

    saveSplitLayout({ terminal: 27.965, inbox: 72.035 });

    const raw = jar.value();
    expect(raw).toBeDefined();
    const [pair] = raw!.split("; ");
    const [name, encoded] = pair.split("=");
    expect(name).toBe(splitLayoutCookieName);

    expect(parseSplitLayout(encoded)).toEqual({ terminal: 27.965, inbox: 72.035 });
  });

  it("scopes the cookie to the whole site and keeps it same-site", () => {
    const jar = captureWrittenCookie();

    saveSplitLayout(splitDefaultLayout);

    const attributes = jar.value()!.split("; ").slice(1);
    expect(attributes).toContain("path=/");
    expect(attributes).toContain("samesite=lax");
  });

  it.each([
    ["no cookie", undefined],
    ["an empty value", ""],
    ["a truncated JSON value", "%7B%22terminal%22%3A27.9"],
    ["a non-object value", encodeURIComponent(JSON.stringify(56))],
    ["a null value", encodeURIComponent(JSON.stringify(null))],
    ["an array value", encodeURIComponent(JSON.stringify([56, 44]))],
    ["an object with no panels", encodeURIComponent(JSON.stringify({}))],
    ["a non-numeric size", encodeURIComponent(JSON.stringify({ terminal: "56", inbox: 44 }))],
    ["a NaN size", encodeURIComponent('{"terminal":NaN,"inbox":44}')],
  ])("falls back to the default split for %s", (_label, value) => {
    expect(parseSplitLayout(value as string | undefined)).toBeUndefined();
  });
});
