import type { Layout } from "react-resizable-panels";

/**
 * The split sizes ride in a cookie rather than `localStorage` so the server
 * render already knows them. Reading them after mount instead would paint the
 * default split first and then jump to the remembered one on every load.
 */
export const splitLayoutCookieName = "helm.split-layout";

/** Whether the terminal starts collapsed. Same reason it is a cookie. */
export const terminalCollapsedCookieName = "helm.terminal-collapsed";

/**
 * Inbox first: what needs the human comes before the machine output it came
 * from, and on a narrow screen the first panel is the one in reach.
 */
export const splitDefaultLayout: Layout = { inbox: 52, terminal: 48 };

export function parseSplitLayout(value: string | undefined): Layout | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return undefined;
  if (entries.some(([, size]) => typeof size !== "number" || !Number.isFinite(size) || size <= 0)) return undefined;
  return Object.fromEntries(entries) as Layout;
}

export function saveSplitLayout(layout: Layout): void {
  writeCookie(splitLayoutCookieName, encodeURIComponent(JSON.stringify(layout)));
}

/**
 * `undefined` means the operator has never chosen, which lets a narrow screen
 * default to collapsed without overriding a deliberate choice.
 */
export function parseTerminalCollapsed(value: string | undefined): boolean | undefined {
  if (value === "1") return true;
  if (value === "0") return false;
  return undefined;
}

export function saveTerminalCollapsed(collapsed: boolean): void {
  writeCookie(terminalCollapsedCookieName, collapsed ? "1" : "0");
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}
