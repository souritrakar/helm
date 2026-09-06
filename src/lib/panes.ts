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

export async function discoverPanes(cfg: HelmConfig): Promise<PaneDiscovery> {
  const [agents, panes, snapshot] = await Promise.all([agentList(cfg), paneList(cfg), fleetSnapshot(cfg)]);
  const agentIds = new Set(agents.map((agent) => agent.pane_id));
  const tasksByPane = new Map<string, FleetTask>();
  for (const task of snapshot.tasks) {
    const target = task.endpoint.target;
    if (target !== null) tasksByPane.set(target.replace(/^default:/, ""), task);
  }
  const result = panes
    .filter((pane) => agentIds.has(pane.pane_id))
    .map((pane) => toDiscoverablePane(pane, tasksByPane.get(pane.pane_id), cfg.fmHome));
  const firstmate = result.find((pane) => pane.isFirstmate);
  return { panes: result, defaultPaneId: firstmate?.id ?? result[0]?.id ?? null };
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

/** Keeps discovery fresh after pane topology or agent status changes. */
export class PaneDirectory {
  #stream: HerdrEventStream | null = null;
  #statusStream: HerdrEventStream | null = null;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  constructor(readonly cfg: HelmConfig, readonly onUpdate: (value: PaneDiscovery) => void, readonly onError: (message: string) => void) {}

  async start(): Promise<void> {
    await this.refresh();
    this.#subscribe();
  }

  close(): void {
    this.#closed = true;
    this.#stream?.close();
    this.#statusStream?.close();
    if (this.#timer !== null) clearTimeout(this.#timer);
  }

  async refresh(): Promise<void> {
    try {
      this.onUpdate(await discoverPanes(this.cfg));
      this.#subscribeStatuses();
    }
    catch (cause) { this.onError(cause instanceof Error ? cause.message : String(cause)); }
  }

  #subscribe(): void {
    const refreshFromEvent = (): void => {
      if (this.#timer !== null) return;
      this.#timer = setTimeout(() => { this.#timer = null; void this.refresh(); }, 100);
    };
    this.#stream = subscribeEvents(this.cfg, [{ type: "pane.created" }, { type: "pane.closed" }], refreshFromEvent);
    void this.#stream.ready.then(() => this.#subscribeStatuses()).catch((cause: unknown) => this.#failed(cause));
    void this.#stream.closed.catch((cause: unknown) => this.#failed(cause));
  }

  #subscribeStatuses(): void {
    // The protocol requires a separate subscription for each status-bearing pane.
    void discoverPanes(this.cfg).then(({ panes }) => {
      if (this.#closed || panes.length === 0) return;
      this.#statusStream?.close();
      this.#statusStream = subscribeEvents(this.cfg, panes.map((pane) => ({ type: "pane.agent_status_changed" as const, pane_id: pane.id })), () => void this.refresh());
      void this.#statusStream.closed.catch((cause: unknown) => this.#failed(cause));
    }).catch((cause: unknown) => this.#failed(cause));
  }

  #failed(cause: unknown): void {
    if (this.#closed) return;
    this.onError(cause instanceof Error ? cause.message : String(cause));
  }
}
