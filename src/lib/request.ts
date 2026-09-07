/**
 * Guards for the two request surfaces helm exposes: the terminal WebSocket and
 * the Converse input endpoint.
 *
 * Both are unauthenticated and reachable from any page the viewer's browser
 * happens to open, so each one is checked before it can reach Herdr.
 */
import type { TerminalViewport } from "./herdr";

/** The viewport an observer starts on when the client requested none. */
export const DEFAULT_VIEWPORT: TerminalViewport = { cols: 80, rows: 24 };

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 2;
const MAX_ROWS = 300;

/**
 * The viewport a viewer connected with.
 *
 * A Herdr observer's viewport is fixed at spawn, so the geometry travels with
 * the connect request: the first observer is then already the right size and
 * needs no immediate respawn and no repaint wrapped to the wrong width.
 */
export function requestedViewport(url: string | undefined): TerminalViewport {
  const params = new URL(url ?? "/", "http://localhost").searchParams;
  const cols = boundedInteger(params.get("cols"), MIN_COLS, MAX_COLS);
  const rows = boundedInteger(params.get("rows"), MIN_ROWS, MAX_ROWS);
  return cols === null || rows === null ? DEFAULT_VIEWPORT : { cols, rows };
}

function boundedInteger(raw: string | null, min: number, max: number): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value < min || value > max ? null : value;
}
