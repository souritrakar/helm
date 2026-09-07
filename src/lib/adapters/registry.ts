/**
 * Pluggable adapter registry (SPEC §D4).
 *
 * Adding a source is one file plus one {@link registerAdapter} call. The store,
 * transport, and UI do not change. Production registration belongs in the
 * runtime composition root; tests can register the fake adapter directly.
 */
import type { InboxAdapter, InboxAdapterContext } from "../types";
import type { InboxStore } from "../inbox-store";

export class AdapterRegistry {
  private readonly adapters = new Map<string, InboxAdapter>();
  private readonly disposers = new Map<string, Disposable>();
  private running = false;

  /** Register an adapter. Ids must be unique. */
  register(adapter: InboxAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`AdapterRegistry: adapter id ${JSON.stringify(adapter.id)} is already registered`);
    }
    if (this.running) {
      throw new Error(`AdapterRegistry: cannot register ${JSON.stringify(adapter.id)} after start`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** Registered adapters in registration order. */
  list(): InboxAdapter[] {
    return [...this.adapters.values()];
  }

  get(id: string): InboxAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Start every registered adapter against `store`.
   *
   * Each adapter's `emit` is scoped to that adapter's id so a buggy adapter
   * cannot reconcile another source's cards away.
   */
  async start(store: InboxStore): Promise<void> {
    if (this.running) {
      throw new Error("AdapterRegistry: already started");
    }
    this.running = true;
    try {
      for (const adapter of this.adapters.values()) {
        const ctx: InboxAdapterContext = {
          emit: (items) => store.reconcile(adapter.id, items),
          retract: (ids) => store.retract(ids.filter((id) => id.startsWith(`${adapter.id}:`))),
        };
        const disposable = await adapter.start(ctx);
        this.disposers.set(adapter.id, disposable);
      }
    } catch (cause) {
      // Dispose whatever already started so a flaky adapter cannot leave
      // timers/watchers running after startup aborts.
      this.stop();
      throw cause;
    }
  }

  /** Stop every adapter. Safe to call when not started. */
  stop(): void {
    for (const [id, disposable] of this.disposers) {
      try {
        disposable[Symbol.dispose]();
      } catch (cause) {
        console.error(`AdapterRegistry: disposing ${id} failed:`, cause);
      }
    }
    this.disposers.clear();
    this.running = false;
  }
}

/** Build an empty registry for runtime composition or focused tests. */
export function createAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry();
}
