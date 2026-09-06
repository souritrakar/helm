/**
 * The guards in front of helm's two unauthenticated request surfaces.
 *
 * A cross-origin page must not be able to mirror the firstmate terminal or run
 * text in an agent pane, and a viewer's real geometry must reach the observer
 * on the connect request rather than on a follow-up respawn.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_VIEWPORT, isJsonRequest, isSameOrigin, requestedViewport } from "@/lib/request";

describe("isSameOrigin", () => {
  it("accepts helm's own origin", () => {
    expect(isSameOrigin({ host: "127.0.0.1:7333", origin: "http://127.0.0.1:7333" })).toBe(true);
  });

  it("refuses another page's origin", () => {
    expect(isSameOrigin({ host: "127.0.0.1:7333", origin: "https://evil.example" })).toBe(false);
  });

  it("refuses an origin that only differs by port", () => {
    expect(isSameOrigin({ host: "127.0.0.1:7333", origin: "http://127.0.0.1:8080" })).toBe(false);
  });

  it("refuses an opaque origin", () => {
    expect(isSameOrigin({ host: "127.0.0.1:7333", origin: "null" })).toBe(false);
  });

  it("accepts a request no browser mediated", () => {
    expect(isSameOrigin({ host: "127.0.0.1:7333" })).toBe(true);
  });
});

describe("isJsonRequest", () => {
  it("accepts application/json with parameters", () => {
    expect(isJsonRequest({ "content-type": "application/json; charset=utf-8" })).toBe(true);
  });

  it("refuses the CORS-simple content types a cross-origin form can send", () => {
    expect(isJsonRequest({ "content-type": "text/plain;charset=UTF-8" })).toBe(false);
    expect(isJsonRequest({ "content-type": "application/x-www-form-urlencoded" })).toBe(false);
    expect(isJsonRequest({ "content-type": "multipart/form-data; boundary=x" })).toBe(false);
  });

  it("refuses a request that declares no body type", () => {
    expect(isJsonRequest({})).toBe(false);
  });
});

describe("requestedViewport", () => {
  it("takes the geometry the viewer connected with", () => {
    expect(requestedViewport("/api/term?cols=120&rows=48")).toEqual({ cols: 120, rows: 48 });
  });

  it("falls back when the geometry is absent or out of range", () => {
    expect(requestedViewport("/api/term")).toEqual(DEFAULT_VIEWPORT);
    expect(requestedViewport("/api/term?cols=1&rows=48")).toEqual(DEFAULT_VIEWPORT);
    expect(requestedViewport("/api/term?cols=120&rows=9000")).toEqual(DEFAULT_VIEWPORT);
    expect(requestedViewport("/api/term?cols=abc&rows=48")).toEqual(DEFAULT_VIEWPORT);
  });
});
