import type { HelmConfig } from "../config";
import type { AdapterRegistry } from "./registry";
import { createHerdrAdapters } from "./herdr-events";
import { createStateAdapters } from "./state";

/** Register the eight read-only Lane D producers. */
export function registerProductionAdapters(registry: AdapterRegistry, config: HelmConfig): void {
  for (const adapter of [...createStateAdapters(config), ...createHerdrAdapters(config)]) registry.register(adapter);
}
