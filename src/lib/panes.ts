/** Discovery and event-driven refresh of the panes helm may mirror. */
import type { HelmConfig } from "./config";
import { fleetSnapshot, type FleetTask } from "./fm";
import { agentList, paneList, subscribeEvents, type HerdrEventStream, type HerdrPane } from "./herdr";

export interface DiscoverablePane {
  readonly id: string;
  readonly title: string;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly status: string;
  readonly isFirstmate: boolean;
}

export interface PaneDiscovery {
  readonly panes: readonly DiscoverablePane[];
  readonly defaultPaneId: string | null;
}

/** Debounce for a burst of pane or status events. */
const REFRESH_DEBOUNCE_MS = 100;

/**
 * Safety poll while discovery is degraded.
 *
 * A failed event stream delivers no further events, so event-driven refresh
 * alone can never recover from one. This retry runs only after a failure and
 * stops once discovery succeeds and the subscriptions are live again.
 */
const RETRY_INTERVAL_MS = 5_000;

export async function discoverPanes(cfg: HelmConfig): Promise<PaneDiscovery> {
  const [agents, panes, snapshot] = await Promise.all([agentList(cfg), paneList(cfg), fleetSnapshot(cfg)]);
  return crossReferencePanes(panes, new Set(agents.map((agent) => agent.pane_id)), snapshot.tasks, cfg.fmHome);
}

/**
 * Join the Herdr pane list to the fleet snapshot.
 *
 * Separate from the fetch so the cross-reference — which decides every pane's
 * task association and the default selection — is provable from recorded
 * documents rather than only from a live fleet.
 */
export function crossReferencePanes(
  panes: readonly HerdrPane[],
  agentPaneIds: ReadonlySet<string>,
  tasks: readonly FleetTask[],
  fmHome: string,
): PaneDiscovery {
  const tasksByPane = new Map<string, FleetTask>();
  for (const task of tasks) {
    const paneId = paneIdFromTarget(task.endpoint.target);
    if (paneId !== null) tasksByPane.set(paneId, task);
  }
  const result = panes
    .filter((pane) => agentPaneIds.has(pane.pane_id))
    .map((pane) => toDiscoverablePane(pane, tasksByPane.get(pane.pane_id), fmHome));
  const firstmate = result.find((pane) => pane.isFirstmate);
  return { panes: result, defaultPaneId: firstmate?.id ?? result[0]?.id ?? null };
}

/**
 * Read the pane id out of a firstmate herdr endpoint target.
 *
 * The target is `<herdr-session>:<pane-id>` and the pane id itself contains a
 * colon, so firstmate splits on the FIRST colon only and takes the remainder
 * (`fm_backend_herdr_parse_target` in `bin/backends/herdr.sh`). The session is
 * whatever `$HERDR_SESSION` names, so it is never assumed to be `default`.
 */
export function paneIdFromTarget(target: string | null): string | null {
  if (target === null) return null;
  const separator = target.indexOf(":");
  if (separator === -1) return null;
  const paneId = target.slice(separator + 1);
  return paneId === "" ? null : paneId;
}

function toDiscoverablePane(pane: HerdrPane, task: FleetTask | undefined, fmHome: string): DiscoverablePane {
  const isFirstmate = pane.cwd === fmHome || pane.foreground_cwd === fmHome;
  return {
    id: pane.pane_id,
    title: task?.backlog?.structured === true ? task.backlog.title ?? pane.terminal_title_stripped ?? pane.pane_id : pane.terminal_title_stripped ?? pane.title ?? pane.pane_id,
    taskId: task?.id ?? null,
    taskTitle: task?.backlog?.structured === true ? task.backlog.title : null,
    status: pane.agent_status,
    isFirstmate,
  };
}

/**
 * Keeps discovery fresh after pane topology or agent status changes.
 *
 * A failed refresh or a failed subscription is reported and retried; it never
 * replaces the last-known pane list with an empty one, so a transient Herdr
 * error degrades the directory rather than tearing down terminal bridging.
 */
export class PaneDirectory {
  #stream: HerdrEventStream | null = null;
  #statusStream: HerdrEventStream | null = null;
  #statusKey = "";
  #debounce: NodeJS.Timeout | null = null;
  #retry: NodeJS.Timeout | null = null;
  #refreshing: Promise<void> | null = null;
  #refreshAgain = false;
  #closed = false;
  constructor(readonly cfg: HelmConfig, readonly onUpdate: (value: PaneDiscovery) => void, readonly onError: (message: string) => void) {}

  async start(): Promise<void> {
    await this.refresh();
    this.#subscribePanes();
  }

  close(): void {
    this.#closed = true;
    this.#stream?.close();
    this.#stream = null;
    this.#statusStream?.close();
    this.#statusStream = null;
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    if (this.#retry !== null) clearTimeout(this.#retry);
  }

  /**
   * Discover once, publish, and re-target the status subscription.
   *
   * One discovery runs at a time. `fm-fleet-snapshot.sh` may take minutes, so a
   * flapping agent must coalesce into at most one queued rerun instead of
   * piling up overlapping snapshot processes.
   */
  refresh(): Promise<void> {
    if (this.#refreshing !== null) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    const run = this.#discover().finally(() => {
      this.#refreshing = null;
      if (this.#refreshAgain && !this.#closed) {
        this.#refreshAgain = false;
        void this.refresh();
      }
    });
    this.#refreshing = run;
    return run;
  }

  async #discover(): Promise<void> {
    try {
      const discovery = await discoverPanes(this.cfg);
      if (this.#closed) return;
      this.onUpdate(discovery);
      this.#subscribeStatuses(discovery.panes);
    } catch (cause) {
      this.#failed(cause);
    }
  }

  #refreshLater(): void {
    if (this.#closed || this.#debounce !== null) return;
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  #subscribePanes(): void {
    if (this.#closed || this.#stream !== null) return;
    const stream = subscribeEvents(this.cfg, [{ type: "pane.created" }, { type: "pane.closed" }], () => this.#refreshLater());
    this.#stream = stream;
    // `closed` rejects on every transport failure, including one that also
    // rejects `ready`, so one handler covers both without reporting twice.
    void stream.closed.catch((cause: unknown) => {
      if (this.#stream === stream) this.#stream = null;
      this.#failed(cause);
    });
  }

  #subscribeStatuses(panes: readonly DiscoverablePane[]): void {
    if (this.#closed) return;
    // The protocol requires a separate subscription for each status-bearing
    // pane. Reuse the open socket while the pane set is unchanged: rebuilding
    // it drops any status event that arrives during the gap.
    const key = panes.map((pane) => pane.id).join("\n");
    if (key === this.#statusKey && this.#statusStream !== null) return;
    this.#statusStream?.close();
    this.#statusStream = null;
    this.#statusKey = key;
    if (panes.length === 0) return;
    const stream = subscribeEvents(this.cfg, panes.map((pane) => ({ type: "pane.agent_status_changed" as const, pane_id: pane.id })), () => this.#refreshLater());
    this.#statusStream = stream;
    void stream.closed.catch((cause: unknown) => {
      if (this.#statusStream === stream) {
        this.#statusStream = null;
        this.#statusKey = "";
      }
      this.#failed(cause);
    });
  }

  #failed(cause: unknown): void {
    if (this.#closed) return;
    this.onError(cause instanceof Error ? cause.message : String(cause));
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retry !== null) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      if (this.#closed) return;
      void this.refresh().then(() => this.#subscribePanes());
    }, RETRY_INTERVAL_MS);
  }
}
