/**
 * The guards in front of helm's two unauthenticated request surfaces.
 *
 * A cross-origin page must not be able to mirror the firstmate terminal or run
 * text in an agent pane, and a viewer's real geometry must reach the observer
 * on the connect request rather than on a follow-up respawn.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_VIEWPORT, requestedViewport } from "@/lib/request";

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
