/**
 * The guards in front of helm's two unauthenticated request surfaces.
 *
 * A cross-origin page must not be able to mirror the firstmate terminal or run
 * text in an agent pane, and a viewer's real geometry must reach the observer
 * on the connect request rather than on a follow-up respawn.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_VIEWPORT, parseTerminalInput, requestedViewport, TERMINAL_KEYS } from "@/lib/request";

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

describe("parseTerminalInput", () => {
  it("accepts a single-line converse message", () => {
    expect(parseTerminalInput({ paneId: "w1:p1", text: "hello" })).toEqual({ paneId: "w1:p1", text: "hello" });
  });

  it("accepts a named converse key", () => {
    expect(parseTerminalInput({ paneId: "w1:p1", key: "escape" })).toEqual({ paneId: "w1:p1", key: "escape" });
  });

  it("rejects converse text that would submit more than one pane line", () => {
    expect(() => parseTerminalInput({ paneId: "w1:p1", text: "first command\nsecond command" })).toThrow(
      /single line without tab, newline, or control characters/,
    );
    expect(() => parseTerminalInput({ paneId: "w1:p1", text: "one\ttwo" })).toThrow(/single line/);
    expect(() => parseTerminalInput({ paneId: "w1:p1", text: "bell\u0007" })).toThrow(/single line/);
    expect(() => parseTerminalInput({ paneId: "w1:p1", text: "del\u007f" })).toThrow(/single line/);
  });

  it("carries submit:false, which types the line without committing it", () => {
    expect(parseTerminalInput({ paneId: "w1:p1", text: "half typed", submit: false })).toEqual({
      paneId: "w1:p1",
      text: "half typed",
      submit: false,
    });
  });

  it.each(TERMINAL_KEYS)("accepts the bounded key %s", (key) => {
    expect(parseTerminalInput({ paneId: "w1:p1", key })).toEqual({ paneId: "w1:p1", key });
  });

  it("refuses a key outside the bounded set rather than passing it to Herdr", () => {
    // Herdr rejects these names, so helm refuses them where it can explain why.
    for (const key of ["home", "end", "delete", "c-d", "c-u", "f13"]) {
      expect(() => parseTerminalInput({ paneId: "w1:p1", key })).toThrow();
    }
  });

  it("refuses text and a key together, which would silently drop the text", () => {
    expect(() => parseTerminalInput({ paneId: "w1:p1", text: "hello", key: "enter" })).toThrow();
  });

  it("refuses an unknown field, so a typo cannot be read as a default", () => {
    expect(() => parseTerminalInput({ paneId: "w1:p1", text: "hello", sumbit: false })).toThrow();
  });
});
