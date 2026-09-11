/**
 * Wires the inbox store, responder, audit log, adapter registry, and
 * read-only notification bridge for the long-lived Node server process.
 */
import type { HelmConfig } from "./config";
import { createFileAuditWriter } from "./audit";
import { createAdapterRegistry, type AdapterRegistry } from "./adapters/registry";
import { createInboxStore, type InboxStore } from "./inbox-store";
import { createResponder, type Responder } from "./responder";
import { registerProductionAdapters, type StateAdapterDeps } from "./adapters";
import { showHerdrNotification } from "./herdr";
import { notificationTitle } from "./inbox-view";
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
 *
 * `deps.relayTarget` is called on every adapter tick rather than read once, so
 * relay cards pick up the firstmate pane as soon as Herdr discovery finds it.
 */
export function createInboxRuntime(config: HelmConfig, deps: StateAdapterDeps): InboxRuntime {
  const store = createInboxStore(config.helmStateDir);
  const audit = createFileAuditWriter(config.helmStateDir);
  const responder = createResponder({ config, audit });
  const registry = createAdapterRegistry();
  registerProductionAdapters(registry, config, deps);
  const visibility = new InboxVisibility();
  // One Herdr nudge per blocking occurrence. Retract and a non-blocking upsert
  // clear the id so a later raise or escalation can announce again. Browser-side
  // `tag` dedupe protects across page reloads.
  const herdrNotifiedIds = new Set<string>();

  store.subscribe((event) => {
    if (event.type === "item.retract") {
      herdrNotifiedIds.delete((event.data as { readonly id: string }).id);
      return;
    }
    if (event.type !== "item.upsert") return;
    const item = event.data as InboxItem;
    if (item.state !== "open") return;
    if (item.urgency !== "blocking") {
      herdrNotifiedIds.delete(item.id);
      return;
    }
    if (herdrNotifiedIds.has(item.id)) return;
    herdrNotifiedIds.add(item.id);
    if (visibility.itemIsVisible(item.id)) return;
    // A desktop-notification failure must never disrupt the read-only inbox
    // stream. `showHerdrNotification` is argv-only and resolves with its result.
    void showHerdrNotification(config, notificationTitle(item.kind, item.title), item.detail ?? item.title);
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
