/**
 * Wires the inbox store, responder, audit log, and adapter registry for the
 * long-lived Node server process.
 */
import type { HelmConfig } from "./config";
import { createFileAuditWriter } from "./audit";
import { createAdapterRegistry, type AdapterRegistry } from "./adapters/registry";
import { createInboxStore, type InboxStore } from "./inbox-store";
import { createResponder, type Responder } from "./responder";
import { registerProductionAdapters } from "./adapters";

export interface InboxRuntime {
  readonly store: InboxStore;
  readonly responder: Responder;
  readonly registry: AdapterRegistry;
  start(): Promise<void>;
  stop(): void;
}

/**
 * Build the inbox runtime. Adapters are not started until {@link InboxRuntime.start}.
 *
 * Production source adapters are registered before `start()`; tests may build
 * a separate registry with only the adapters they need.
 */
export function createInboxRuntime(config: HelmConfig): InboxRuntime {
  const store = createInboxStore(config.helmStateDir);
  const audit = createFileAuditWriter(config.helmStateDir);
  const responder = createResponder({ config, audit });
  const registry = createAdapterRegistry();
  registerProductionAdapters(registry, config);

  return {
    store,
    responder,
    registry,
    async start(): Promise<void> {
      await registry.start(store);
    },
    stop(): void {
      registry.stop();
    },
  };
}
