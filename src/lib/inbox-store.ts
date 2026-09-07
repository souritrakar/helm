/**
 * Canonical inbox item store (SPEC §5.2, §D4).
 *
 * Adapters emit a full open set per source; the store diffs by stable id
 * (`${source}:${naturalKey}`), assigns `openedAt` on first sight, and pushes
 * `item.upsert` / `item.retract` events with an incrementing id for SSE
 * `Last-Event-ID` resume. Answered / dismissed history lives in a small JSON
 * file under helm's own state dir so a restart does not resurrect handled cards
 * (AC 11) and never writes under `$FM_HOME` (AC 18).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { historyPath } from "./paths";
import type { InboxItem, InboxItemState } from "./types";

/** SSE event names the store emits. */
export type InboxStoreEventType =
  | "item.upsert"
  | "item.retract"
  | "snapshot.begin"
  | "snapshot.end";

/** Payload for {@link InboxStoreEventType} `snapshot.begin`. */
export interface SnapshotBeginData {
  readonly ids: readonly string[];
}

/** Payload for {@link InboxStoreEventType} `snapshot.end`. */
export interface SnapshotEndData {
  readonly count: number;
}

export interface InboxStoreEvent {
  /**
   * Monotonic sequence within this process stream.
   * The SSE `id:` field is {@link formatWireEventId} (`<epoch>-<seq>`).
   */
  readonly id: number;
  readonly type: InboxStoreEventType;
  /**
   * Full item on upsert; `{ id }` on retract; snapshot begin/end carry the
   * open-set boundary so a reconnecting client can drop phantom cards.
   */
  readonly data: InboxItem | { readonly id: string } | SnapshotBeginData | SnapshotEndData;
  readonly at: string;
}

/** Parsed `Last-Event-ID` / SSE wire id. */
export interface WireEventId {
  readonly epoch: string;
  readonly seq: number;
}

/** Format the SSE `id:` field: `<epoch>-<seq>`. */
export function formatWireEventId(epoch: string, seq: number): string {
  return `${epoch}-${seq}`;
}

/**
 * Parse a wire event id. Returns null when the shape is not `<epoch>-<seq>`
 * with a non-negative integer seq.
 */
export function parseWireEventId(raw: string): WireEventId | null {
  const trimmed = raw.trim();
  const dash = trimmed.lastIndexOf("-");
  if (dash <= 0 || dash === trimmed.length - 1) return null;
  const epoch = trimmed.slice(0, dash);
  const seqRaw = trimmed.slice(dash + 1);
  if (epoch === "" || !/^\d+$/.test(seqRaw)) return null;
  return { epoch, seq: Number(seqRaw) };
}

export type InboxStoreListener = (event: InboxStoreEvent) => void;

interface HistoryRecord {
  readonly state: Extract<InboxItemState, "answered" | "dismissed">;
  readonly openedAt: string;
  readonly answeredAt: string;
}

interface HistoryFile {
  readonly version: 1;
  readonly items: Record<string, HistoryRecord>;
}

export interface InboxStoreOptions {
  /** Absolute path to the answered-history JSON file. */
  readonly historyFile: string;
  /** Max events retained for `Last-Event-ID` resume. Default 1000. */
  readonly eventBufferSize?: number;
  /** Clock override for tests. */
  readonly now?: () => string;
  /**
   * Per-process stream epoch embedded in SSE ids. A new process always gets a
   * fresh epoch so a stale Last-Event-ID from before restart cannot resume.
   */
  readonly streamEpoch?: string;
}

const DEFAULT_EVENT_BUFFER = 1000;

export class InboxStore {
  private readonly items = new Map<string, InboxItem>();
  private readonly history = new Map<string, HistoryRecord>();
  private readonly historyFile: string;
  private readonly eventBufferSize: number;
  private readonly now: () => string;
  private readonly listeners = new Set<InboxStoreListener>();
  private readonly eventBuffer: InboxStoreEvent[] = [];
  private nextEventId = 1;
  /** Per-process epoch for SSE wire ids (`<epoch>-<seq>`). */
  readonly streamEpoch: string;

  constructor(options: InboxStoreOptions) {
    this.historyFile = options.historyFile;
    this.eventBufferSize = options.eventBufferSize ?? DEFAULT_EVENT_BUFFER;
    this.now = options.now ?? (() => new Date().toISOString());
    this.streamEpoch = options.streamEpoch ?? randomBytes(8).toString("hex");
    this.loadHistory();
  }

  /** SSE `id:` value for an event from this store. */
  wireId(event: InboxStoreEvent): string {
    return formatWireEventId(this.streamEpoch, event.id);
  }

  /** Open items currently in the store, in insertion order. */
  listOpen(): InboxItem[] {
    return [...this.items.values()].filter((item) => item.state === "open");
  }

  /** Look up any known item, open or not. */
  get(id: string): InboxItem | undefined {
    return this.items.get(id);
  }

  /** Whether the id is in answered/dismissed history (survives restarts). */
  isHandled(id: string): boolean {
    return this.history.has(id);
  }

  /**
   * Publish one adapter's **full current open set**.
   *
   * Diffs by id within `source`: new ids upsert, vanished ids retract, known
   * ids keep their `openedAt`. Items already in answered history are skipped
   * so a restart cannot resurrect them (AC 11).
   */
  reconcile(source: string, emitted: readonly InboxItem[]): void {
    const incoming = new Map<string, InboxItem>();
    for (const raw of emitted) {
      if (raw.source !== source) {
        throw new Error(
          `InboxStore.reconcile: item ${JSON.stringify(raw.id)} has source ${JSON.stringify(raw.source)}, expected ${JSON.stringify(source)}`,
        );
      }
      if (!raw.id.startsWith(`${source}:`)) {
        throw new Error(
          `InboxStore.reconcile: item id ${JSON.stringify(raw.id)} must start with ${JSON.stringify(`${source}:`)}`,
        );
      }
      if (this.history.has(raw.id)) continue;
      incoming.set(raw.id, raw);
    }

    for (const [id, existing] of this.items) {
      if (existing.source !== source) continue;
      if (existing.state !== "open") continue;
      if (!incoming.has(id)) {
        this.items.delete(id);
        this.emit({ type: "item.retract", data: { id } });
      }
    }

    for (const [id, raw] of incoming) {
      const existing = this.items.get(id);
      // Store assigns openedAt on first sight (SPEC §5.2); adapters do not.
      const openedAt = existing?.openedAt ?? this.now();
      const next: InboxItem = {
        ...raw,
        state: "open",
        openedAt,
        answeredAt: undefined,
      };
      if (existing !== undefined && shallowEqualItem(existing, next)) continue;
      this.items.set(id, next);
      this.emit({ type: "item.upsert", data: next });
    }
  }

  /** Withdraw items by id (adapters that learn of closure directly). */
  retract(ids: readonly string[]): void {
    for (const id of ids) {
      const existing = this.items.get(id);
      if (existing === undefined) continue;
      this.items.delete(id);
      this.emit({ type: "item.retract", data: { id } });
    }
  }

  /**
   * Mark an open item answered and persist it so a restart will not resurrect
   * it. Emits an upsert with `state: "answered"` then removes it from the open
   * set with a retract (clients that only track open cards drop it).
   */
  markAnswered(id: string, answeredAt: string = this.now()): InboxItem | undefined {
    return this.markHandled(id, "answered", answeredAt);
  }

  /** Mark an open item dismissed and persist it. */
  markDismissed(id: string, answeredAt: string = this.now()): InboxItem | undefined {
    return this.markHandled(id, "dismissed", answeredAt);
  }

  /** Subscribe to store events. Returns an unsubscribe function. */
  subscribe(listener: InboxStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Events with seq greater than the cursor, for SSE `Last-Event-ID` resume.
   * Accepts a wire id (`<epoch>-<seq>`) or a bare numeric seq (tests).
   * When the cursor is null/undefined/unparseable, returns an empty list —
   * callers that need a cold snapshot should call {@link captureSnapshot}.
   */
  eventsSince(lastEventId: string | number | null | undefined): InboxStoreEvent[] {
    const cursor = this.resolveResumeCursor(lastEventId);
    if (cursor === null) return [];
    return this.eventBuffer.filter((event) => event.id > cursor.seq);
  }

  /**
   * Lowest event seq still in the resume buffer, or `null` when the buffer is
   * empty.
   */
  lowestRetainedEventId(): number | null {
    const first = this.eventBuffer[0];
    return first === undefined ? null : first.id;
  }

  /**
   * Whether `Last-Event-ID` can be replayed from this process stream.
   *
   * Requires a matching stream epoch and a seq in `[floor - 1, last]`. A bare
   * numeric id (no epoch) or a mismatched epoch is not resumable — that is the
   * restart case (captain decision `sse-resume-aliases-across-restart`).
   */
  canResumeFrom(lastEventId: string | number): boolean {
    const cursor = this.resolveResumeCursor(lastEventId);
    if (cursor === null) return false;
    const floor = this.lowestRetainedEventId();
    const last = this.lastEventId();
    if (floor === null) {
      return cursor.seq === last;
    }
    return cursor.seq >= floor - 1 && cursor.seq <= last;
  }

  private resolveResumeCursor(
    lastEventId: string | number | null | undefined,
  ): WireEventId | null {
    if (lastEventId === null || lastEventId === undefined) return null;
    if (typeof lastEventId === "number") {
      if (Number.isNaN(lastEventId)) return null;
      // Bare numeric ids are only for in-process tests; wire clients must send epoch.
      return { epoch: this.streamEpoch, seq: lastEventId };
    }
    const parsed = parseWireEventId(lastEventId);
    if (parsed === null) return null;
    if (parsed.epoch !== this.streamEpoch) return null;
    return parsed;
  }

  /**
   * Build a cold-connect / non-resumable snapshot with wire-level boundaries.
   *
   * Sequence: `snapshot.begin` (open ids) → `item.upsert` per open item →
   * `snapshot.end`. Clients clear their open set on begin, apply upserts, and
   * finish on end — so cards retracted while disconnected do not linger
   * (captain decision `sse-snapshot-cannot-retract-stale-cards`).
   *
   * Events are assigned resume ids and retained in the buffer, but are not
   * broadcast to live subscribers (those already hold a live stream).
   */
  captureSnapshot(): InboxStoreEvent[] {
    const open = this.listOpen();
    const events: InboxStoreEvent[] = [];
    events.push(this.retainEvent({ type: "snapshot.begin", data: { ids: open.map((item) => item.id) } }));
    for (const item of open) {
      events.push(this.retainEvent({ type: "item.upsert", data: item }));
    }
    events.push(this.retainEvent({ type: "snapshot.end", data: { count: open.length } }));
    return events;
  }

  /** Highest event id emitted so far (0 if none). */
  lastEventId(): number {
    return this.nextEventId - 1;
  }

  private markHandled(
    id: string,
    state: "answered" | "dismissed",
    answeredAt: string,
  ): InboxItem | undefined {
    const existing = this.items.get(id);
    if (existing === undefined) return undefined;
    const record = {
      state,
      openedAt: existing.openedAt,
      answeredAt,
    };
    this.history.set(id, record);
    const handled: InboxItem = { ...existing, state, answeredAt };
    let persistError: unknown;
    try {
      this.persistHistory();
    } catch (cause) {
      // Keep in-memory history and drop from the open set so a delivered answer
      // is not freely re-dispatched, then surface the persist failure.
      persistError = cause;
    }
    this.items.delete(id);
    this.emit({ type: "item.upsert", data: handled });
    this.emit({ type: "item.retract", data: { id } });
    if (persistError !== undefined) {
      throw new HistoryPersistError(
        `answered history could not be written for ${id}: ${
          persistError instanceof Error ? persistError.message : String(persistError)
        }`,
        { cause: persistError, item: handled },
      );
    }
    return handled;
  }

  /** Assign an id, retain in the resume buffer, do not notify listeners. */
  private retainEvent(
    partial: Omit<InboxStoreEvent, "id" | "at"> & { at?: string },
  ): InboxStoreEvent {
    const event: InboxStoreEvent = {
      id: this.nextEventId++,
      type: partial.type,
      data: partial.data,
      at: partial.at ?? this.now(),
    };
    this.eventBuffer.push(event);
    while (this.eventBuffer.length > this.eventBufferSize) {
      this.eventBuffer.shift();
    }
    return event;
  }

  private emit(partial: Omit<InboxStoreEvent, "id" | "at"> & { at?: string }): void {
    const event = this.retainEvent(partial);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private loadHistory(): void {
    let raw: string;
    try {
      raw = readFileSync(this.historyFile, "utf8");
    } catch (cause) {
      if (isEnoent(cause)) return;
      throw cause;
    }
    if (raw.trim() === "") return;
    const parsed = JSON.parse(raw) as HistoryFile;
    if (parsed.version !== 1 || typeof parsed.items !== "object" || parsed.items === null) {
      throw new Error(`InboxStore: history file ${this.historyFile} has an unknown shape`);
    }
    for (const [id, record] of Object.entries(parsed.items)) {
      this.history.set(id, record);
    }
  }

  private persistHistory(): void {
    const items: Record<string, HistoryRecord> = {};
    for (const [id, record] of this.history) {
      items[id] = record;
    }
    const body: HistoryFile = { version: 1, items };
    mkdirSync(dirname(this.historyFile), { recursive: true });
    const tmp = `${this.historyFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameSync(tmp, this.historyFile);
  }
}

/** Thrown when answered history could not be written after the open set was updated. */
export class HistoryPersistError extends Error {
  readonly item: InboxItem;

  constructor(message: string, options: { cause?: unknown; item: InboxItem }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HistoryPersistError";
    this.item = options.item;
  }
}

/** Build a store rooted at a helm state directory. */
export function createInboxStore(helmStateDir: string, options: Omit<InboxStoreOptions, "historyFile"> = {}): InboxStore {
  return new InboxStore({ ...options, historyFile: historyPath(helmStateDir) });
}

function shallowEqualItem(a: InboxItem, b: InboxItem): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isEnoent(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: unknown }).code === "ENOENT"
  );
}
