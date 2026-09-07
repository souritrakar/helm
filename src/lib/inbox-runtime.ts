/**
 * Wires the inbox store, responder, audit log, and adapter registry for the
 * long-lived Node server process.
 */
import type { HelmConfig } from "./config";
import { createFileAuditWriter } from "./audit";
import { createAdapterRegistry, type AdapterRegistry } from "./adapters/registry";
import { createInboxStore, type InboxStore } from "./inbox-store";
import { createResponder, type Responder } from "./responder";

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
 * Lane C leaves the registry empty in production; tests and Lane D register
 * adapters before `start()`.
 */
export function createInboxRuntime(config: HelmConfig): InboxRuntime {
  const store = createInboxStore(config.helmStateDir);
  const audit = createFileAuditWriter(config.helmStateDir);
  const responder = createResponder({ config, audit });
  const registry = createAdapterRegistry();

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
