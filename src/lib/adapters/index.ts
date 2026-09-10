import type { HelmConfig } from "../config";
import type { AdapterRegistry } from "./registry";
import { createAnswerAdapter } from "./answers";
import { createHerdrAdapters } from "./herdr-events";
import { createStateAdapters, type StateAdapterDeps } from "./state";

export type { StateAdapterDeps } from "./state";

/** Register the nine read-only Lane D producers. */
export function registerProductionAdapters(
  registry: AdapterRegistry,
  config: HelmConfig,
  deps: StateAdapterDeps,
): void {
  for (const adapter of [
    ...createStateAdapters(config, deps),
    createAnswerAdapter(config),
    ...createHerdrAdapters(config),
  ]) {
    registry.register(adapter);
  }
}
