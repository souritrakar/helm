import type { Layout } from "react-resizable-panels";

/**
 * The split sizes ride in a cookie rather than `localStorage` so the server
 * render already knows them. Reading them after mount instead would paint the
 * default split first and then jump to the remembered one on every load.
 */
export const splitLayoutCookieName = "helm.split-layout";

export const splitDefaultLayout: Layout = { terminal: 56, inbox: 44 };

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
  const value = encodeURIComponent(JSON.stringify(layout));
  document.cookie = `${splitLayoutCookieName}=${value}; path=/; max-age=31536000; samesite=lax`;
}
