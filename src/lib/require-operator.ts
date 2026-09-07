/**
 * Operator gate for browser→server calls (SPEC D10 item 3).
 *
 * Phase 1 returns "allow" for local same-origin / non-browser callers and
 * refuses cross-site CSRF, non-JSON mutating bodies, and Host headers outside
 * the loopback/bind allowlist (DNS-rebinding). Phase 2 swaps the body of this
 * function; call sites do not move.
 */
import type { IncomingMessage } from "node:http";

export type OperatorDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface RequireOperatorOptions {
  /**
   * When true, also require `Content-Type: application/json` so a CORS-simple
   * `text/plain` POST cannot reach a mutating handler without a preflight.
   */
  readonly mutate?: boolean;
  /**
   * Allowed `Host` header values (e.g. `127.0.0.1:7333`, `localhost:7333`).
   * When set, a missing or non-allowlisted Host is refused (captain decision
   * `require-operator-no-host-allowlist`).
   */
  readonly allowedHosts?: readonly string[];
}

/**
 * Build the phase-1 Host allowlist from helm's bind address and port.
 *
 * Always includes loopback spellings so a mis-set Host cannot DNS-rebind past
 * the gate. When `bind` is a concrete address it is included as well.
 */
export function allowedHostsForBind(bind: string, port: number): string[] {
  const hosts = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    `::1:${port}`,
  ]);
  if (bind !== "0.0.0.0" && bind !== "::" && bind !== "[::]") {
    hosts.add(bind.includes(":") && !bind.startsWith("[") ? `[${bind}]:${port}` : `${bind}:${port}`);
    hosts.add(`${bind}:${port}`);
  }
  return [...hosts];
}

/**
 * Decide whether `req` may proceed as the local operator.
 *
 * Local-mode allow: Host on the allowlist (when configured), no cross-site
 * Sec-Fetch-Site, Origin host matching Host when Origin is present. Mutating
 * calls must declare JSON Content-Type.
 */
export function requireOperator(
  req: IncomingMessage,
  options: RequireOperatorOptions = {},
): OperatorDecision {
  if (options.mutate === true) {
    const contentType = header(req, "content-type");
    if (contentType === undefined || !isJsonContentType(contentType)) {
      return {
        allow: false,
        reason: "Content-Type must be application/json for mutating requests",
      };
    }
  }

  const host = header(req, "host");
  if (options.allowedHosts !== undefined && options.allowedHosts.length > 0) {
    if (host === undefined) {
      return { allow: false, reason: "Host header is required" };
    }
    if (!isAllowedHost(host, options.allowedHosts)) {
      return {
        allow: false,
        reason: `Host ${JSON.stringify(host)} is not on the operator allowlist`,
      };
    }
  }

  const site = header(req, "sec-fetch-site");
  if (site === "cross-site") {
    return { allow: false, reason: "cross-site request blocked by requireOperator" };
  }

  const origin = header(req, "origin");
  if (origin !== undefined && origin !== "" && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { allow: false, reason: `invalid Origin ${JSON.stringify(origin)}` };
    }
    if (host !== undefined && originHost !== host) {
      return {
        allow: false,
        reason: `Origin host ${JSON.stringify(originHost)} does not match Host ${JSON.stringify(host)}`,
      };
    }
  }

  return { allow: true };
}

function isAllowedHost(host: string, allowed: readonly string[]): boolean {
  const normalized = host.trim().toLowerCase();
  return allowed.some((candidate) => candidate.trim().toLowerCase() === normalized);
}

function isJsonContentType(value: string): boolean {
  const media = value.split(";", 1)[0]?.trim().toLowerCase();
  return media === "application/json";
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (Array.isArray(raw) && raw[0] !== undefined) {
    const trimmed = raw[0].trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return undefined;
}
