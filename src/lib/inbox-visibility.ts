import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 15_000;

interface VisibilitySession {
  readonly itemIds: ReadonlySet<string>;
  readonly active: boolean;
  readonly updatedAt: number;
  readonly sequence: number;
}

/**
 * Ephemeral presence reported by an operator's active helm browser session.
 * A card is visible only when some session is `active` (tab visible and focused)
 * and lists that id; unknown or expired presence does not suppress.
 * This remains process-local: it neither changes inbox cards nor persists data.
 */
export class InboxVisibility {
  private readonly sessions = new Map<string, VisibilitySession>();

  createSession(): string {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { itemIds: new Set(), active: false, updatedAt: Date.now(), sequence: -1 });
    return token;
  }

  update(token: string, sequence: number, active: boolean, itemIds: readonly string[]): boolean {
    const current = this.sessions.get(token);
    if (current === undefined) return false;
    if (sequence <= current.sequence) return true;
    this.sessions.set(token, {
      active,
      itemIds: new Set(itemIds),
      updatedAt: Date.now(),
      sequence,
    });
    this.prune();
    return true;
  }

  itemIsVisible(id: string): boolean {
    this.prune();
    for (const session of this.sessions.values()) {
      if (session.active && session.itemIds.has(id)) return true;
    }
    return false;
  }

  private prune(now: number = Date.now()): void {
    for (const [token, session] of this.sessions) {
      if (now - session.updatedAt > SESSION_TTL_MS) this.sessions.delete(token);
    }
  }
}
