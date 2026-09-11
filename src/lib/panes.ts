/** Discovery and event-driven refresh of the panes helm may mirror. */
import type { HelmConfig } from "./config";
import { fleetSnapshot, type FleetTask } from "./fm";
import { agentList, paneList, subscribeEvents, type HerdrEvent, type HerdrEventStream, type HerdrPane } from "./herdr";

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
  const [agents, panes, snapshot] = await Promise.allSettled([agentList(cfg), paneList(cfg), fleetSnapshot(cfg)]);
  if (agents.status === "rejected") throw agents.reason;
  if (panes.status === "rejected") throw panes.reason;
  const tasks = snapshot.status === "fulfilled" ? snapshot.value.tasks : [];
  return crossReferencePanes(panes.value, new Set(agents.value.map((agent) => agent.pane_id)), tasks, cfg.fmHome);
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
  #discovery: PaneDiscovery | null = null;
  #snapshotTasks: readonly FleetTask[] | null = null;
  #degraded = false;
  #closed = false;
  constructor(readonly cfg: HelmConfig, readonly onUpdate: (value: PaneDiscovery) => void, readonly onError: (message: string) => void) {}

  async start(): Promise<void> {
    this.#subscribePanes();
    await this.refresh();
  }

  /**
   * The fleet tasks from the most recent snapshot, or `null` before the first
   * one lands.
   *
   * `fm-fleet-snapshot.sh` budgets up to 180s, so the fleet view reads this
   * cache rather than running the seam per request.
   */
  tasks(): readonly FleetTask[] | null {
    return this.#snapshotTasks;
  }

  /** The most recent pane discovery, or `null` before the first one lands. */
  discovery(): PaneDiscovery | null {
    return this.#discovery;
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
   * Herdr agent/pane lists publish as soon as they settle. The fleet snapshot
   * only enriches task titles and must not gate that first paint; one snapshot
   * still runs at a time so a flapping agent coalesces into at most one queued
   * rerun instead of overlapping `fm-fleet-snapshot.sh` processes.
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
    const snapshotP = fleetSnapshot(this.cfg);
    let snapshotReady: { tasks: FleetTask[] } | undefined;
    let snapshotError: unknown;
    let snapshotDone = false;
    void snapshotP.then(
      (snapshot) => {
        snapshotReady = snapshot;
        snapshotDone = true;
      },
      (cause: unknown) => {
        snapshotError = cause;
        snapshotDone = true;
      },
    );
    let agents: Awaited<ReturnType<typeof agentList>>;
    let panes: Awaited<ReturnType<typeof paneList>>;
    try {
      [agents, panes] = await Promise.all([agentList(this.cfg), paneList(this.cfg)]);
    } catch (cause) {
      await snapshotP.then(() => undefined, () => undefined);
      this.#failed(cause);
      return;
    }
    if (this.#closed) {
      await snapshotP.then(() => undefined, () => undefined);
      return;
    }
    await Promise.resolve();
    const agentPaneIds = new Set(agents.map((agent) => agent.pane_id));
    if (snapshotDone && snapshotReady !== undefined) {
      this.#snapshotTasks = snapshotReady.tasks;
      this.#publish(crossReferencePanes(panes, agentPaneIds, snapshotReady.tasks, this.cfg.fmHome));
      this.#withdrawDegraded();
      return;
    }
    this.#publish(crossReferencePanes(panes, agentPaneIds, this.#snapshotTasks ?? [], this.cfg.fmHome));
    if (!snapshotDone && this.#snapshotTasks === null) {
      this.#reportDegraded("fleet snapshot is still running");
    }
    if (snapshotDone) {
      this.#failed(snapshotError);
      return;
    }
    try {
      const snapshot = await snapshotP;
      if (this.#closed) return;
      this.#snapshotTasks = snapshot.tasks;
      this.#publish(this.#retainStatus(crossReferencePanes(panes, agentPaneIds, snapshot.tasks, this.cfg.fmHome)));
      this.#withdrawDegraded();
    } catch (cause) {
      this.#failed(cause);
    }
  }

  #publish(discovery: PaneDiscovery): void {
    if (this.#closed) return;
    this.#discovery = discovery;
    this.onUpdate(discovery);
    this.#subscribeStatuses(discovery.panes);
  }

  #retainStatus(discovery: PaneDiscovery): PaneDiscovery {
    if (this.#discovery === null) return discovery;
    const previous = new Map(this.#discovery.panes.map((pane) => [pane.id, pane.status]));
    let changed = false;
    const panes = discovery.panes.map((pane) => {
      const status = previous.get(pane.id);
      if (status === undefined || status === pane.status) return pane;
      changed = true;
      return { ...pane, status };
    });
    return changed ? { ...discovery, panes } : discovery;
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
    void stream.closed.then(
      () => this.#streamEnded(stream, "pane event stream closed"),
      (cause: unknown) => this.#streamFailed(stream, cause),
    );
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
    const stream = subscribeEvents(this.cfg, panes.map((pane) => ({ type: "pane.agent_status_changed" as const, pane_id: pane.id })), (event) => this.#updateStatus(event));
    this.#statusStream = stream;
    void stream.closed.then(
      () => this.#statusStreamEnded(stream, "pane status stream closed"),
      (cause: unknown) => this.#statusStreamFailed(stream, cause),
    );
  }

  #streamEnded(stream: HerdrEventStream, reason: string): void {
    if (this.#stream !== stream) return;
    this.#stream = null;
    this.#failed(new Error(reason));
  }

  #streamFailed(stream: HerdrEventStream, cause: unknown): void {
    if (this.#stream !== stream) return;
    this.#stream = null;
    this.#failed(cause);
  }

  #statusStreamEnded(stream: HerdrEventStream, reason: string): void {
    if (this.#statusStream !== stream) return;
    this.#statusStream = null;
    this.#statusKey = "";
    this.#failed(new Error(reason));
  }

  #statusStreamFailed(stream: HerdrEventStream, cause: unknown): void {
    if (this.#statusStream !== stream) return;
    this.#statusStream = null;
    this.#statusKey = "";
    this.#failed(cause);
  }

  #updateStatus(event: HerdrEvent): void {
    if (event.event !== "pane.agent_status_changed" || this.#discovery === null) return;
    const data = event.data;
    const panes = this.#discovery.panes.map((pane) => pane.id === data.pane_id ? { ...pane, status: data.agent_status } : pane);
    if (panes.every((pane, index) => pane === this.#discovery?.panes[index])) return;
    this.#discovery = { ...this.#discovery, panes };
    this.onUpdate(this.#discovery);
  }

  #failed(cause: unknown): void {
    if (this.#closed) return;
    this.#reportDegraded(cause instanceof Error ? cause.message : String(cause));
    this.#scheduleRetry();
  }

  #reportDegraded(message: string): void {
    this.#degraded = true;
    this.onError(message);
  }

  #withdrawDegraded(): void {
    if (this.#closed || !this.#degraded || this.#retry !== null) return;
    this.#degraded = false;
    this.onError("");
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
