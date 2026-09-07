/**
 * Controllable fake adapter for tests.
 *
 * Production adapters are registered separately; this stand-in is only for
 * focused tests.
 */
import type { InboxAdapter, InboxAdapterContext, InboxItem, RespondAction, RespondResult } from "../types";

export interface FakeAdapterControls {
  /** Push a full open set through the store's reconcile path. */
  emit(items: InboxItem[]): void;
  /** Withdraw items by id. */
  retract(ids: string[]): void;
  /** Whether {@link InboxAdapter.start} has been called and not disposed. */
  readonly started: boolean;
}

/**
 * Build a fake adapter and its test controls.
 *
 * `respond` is optional; when provided, the adapter's own respond hook is used
 * instead of the shared Responder (mirrors adapters that own a custom path).
 */
export function createFakeAdapter(options: {
  readonly id?: string;
  readonly respond?: (item: InboxItem, action: RespondAction) => Promise<RespondResult>;
} = {}): { adapter: InboxAdapter; controls: FakeAdapterControls } {
  const id = options.id ?? "fake";
  let ctx: InboxAdapterContext | null = null;
  let started = false;

  const controls: FakeAdapterControls = {
    get started() {
      return started;
    },
    emit(items: InboxItem[]): void {
      if (ctx === null) throw new Error("fake adapter: emit before start");
      ctx.emit(items);
    },
    retract(ids: string[]): void {
      if (ctx === null) throw new Error("fake adapter: retract before start");
      ctx.retract(ids);
    },
  };

  const adapter: InboxAdapter = {
    id,
    async start(adapterCtx: InboxAdapterContext): Promise<Disposable> {
      ctx = adapterCtx;
      started = true;
      return {
        [Symbol.dispose](): void {
          started = false;
          ctx = null;
        },
      };
    },
    ...(options.respond !== undefined ? { respond: options.respond } : {}),
  };

  return { adapter, controls };
}
