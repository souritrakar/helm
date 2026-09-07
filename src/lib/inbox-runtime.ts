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
import { showHerdrNotification } from "./herdr";
import { InboxVisibility } from "./inbox-visibility";
import type { InboxItem } from "./types";

export interface InboxRuntime {
  readonly store: InboxStore;
  readonly responder: Responder;
  readonly registry: AdapterRegistry;
  readonly visibility: InboxVisibility;
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
  const visibility = new InboxVisibility();
  // An adapter can re-emit an unchanged open card. Keep this process-local set
  // so a single occurrence gets one Herdr nudge, while browser-side `tag`
  // dedupe protects across page reloads.
  const herdrNotifiedIds = new Set<string>();

  store.subscribe((event) => {
    if (event.type === "item.retract") {
      herdrNotifiedIds.delete((event.data as { readonly id: string }).id);
      return;
    }
    if (event.type !== "item.upsert") return;
    const item = event.data as InboxItem;
    if (item.urgency !== "blocking" || item.state !== "open") return;
    if (visibility.itemIsVisible(item.id)) return;
    if (herdrNotifiedIds.has(item.id)) return;
    herdrNotifiedIds.add(item.id);
    // A desktop-notification failure must never disrupt the read-only inbox
    // stream. `showHerdrNotification` is argv-only and resolves with its result.
    void showHerdrNotification(config, item.title, item.detail ?? item.title);
  });

  return {
    store,
    responder,
    registry,
    visibility,
    async start(): Promise<void> {
      await registry.start(store);
    },
    stop(): void {
      registry.stop();
    },
  };
}
