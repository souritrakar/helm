import { vi } from "vitest";

type Listener = (event: MessageEvent<string>) => void;

/** jsdom EventSource stand-in used by the live inbox stream and notifications. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static current: FakeEventSource | null = null;
  readonly url: string;
  readyState = FakeEventSource.OPEN;
  private readonly listeners = new Map<string, Listener[]>();
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(type: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

export function installBrowserStubs(): void {
  FakeEventSource.current = null;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

export function openStream(): FakeEventSource {
  const stream = FakeEventSource.current;
  if (stream === null) throw new Error("inbox stream was not opened");
  return stream;
}
