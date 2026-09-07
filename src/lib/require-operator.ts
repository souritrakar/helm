/**
 * Operator gate for browser→server calls (SPEC D10 item 3).
 *
 * Phase 1 returns "allow" for local same-origin / non-browser callers and
 * refuses cross-site CSRF and non-JSON mutating bodies. Phase 2 swaps the
 * body of this function; call sites do not move.
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
}

/**
 * Decide whether `req` may proceed as the local operator.
 *
 * Local-mode allow: no Origin (curl / same-machine tools), or Origin host
 * matching `Host`, and Sec-Fetch-Site not `cross-site`. Mutating calls must
 * declare JSON Content-Type.
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
    const host = header(req, "host");
    if (host !== undefined && originHost !== host) {
      return {
        allow: false,
        reason: `Origin host ${JSON.stringify(originHost)} does not match Host ${JSON.stringify(host)}`,
      };
    }
  }

  return { allow: true };
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
