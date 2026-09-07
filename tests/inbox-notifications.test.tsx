// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import {
  InboxNotificationProvider,
  useInboxNotifications,
} from "@/components/inbox-notifications";

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static current: FakeEventSource | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    void url;
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {}

  emit(type: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

const showNotification = vi.fn<
  (title: string, options: NotificationOptions) => Promise<void>
>(() => Promise.resolve());

function Probe() {
  const { unreadBlocking } = useInboxNotifications();
  return <output>{unreadBlocking}</output>;
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

function openStream(): FakeEventSource {
  const stream = FakeEventSource.current;
  if (stream === null) throw new Error("notification stream was not opened");
  return stream;
}

beforeEach(async () => {
  FakeEventSource.current = null;
  showNotification.mockClear();
  setVisibility("visible");
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(() => Promise.resolve({ showNotification })) },
  });
  render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);
  await vi.waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/helm-sw.js"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

function blocking(id: string) {
  return { id, urgency: "blocking", state: "open", title: "Captain action needed", detail: "A task is blocked." };
}

describe("inbox notification stream", () => {
  it("notifies a hidden tab once per new blocking item, using the item id as the tag", async () => {
    const stream = openStream();
    act(() => {
      stream.emit("snapshot.begin");
      stream.emit("item.upsert", blocking("status:first"));
      stream.emit("snapshot.end");
      setVisibility("hidden");
      stream.emit("item.upsert", blocking("status:second"));
      stream.emit("item.upsert", blocking("status:second"));
    });

    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(showNotification).toHaveBeenCalledWith("Captain action needed", expect.objectContaining({ tag: "status:second" }));
    expect(screen.getByRole("status").textContent).toBe("1");
  });

  it("does not announce a new card that is already visible on screen", async () => {
    render(<article data-inbox-item-id="status:visible">Visible card</article>);
    Object.defineProperty(screen.getByText("Visible card"), "getBoundingClientRect", {
      value: () => ({ bottom: 100, left: 0, right: 100, top: 0 }),
    });
    const stream = openStream();
    act(() => {
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:visible"));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showNotification).not.toHaveBeenCalled();
    expect(screen.getAllByRole("status")[0]?.textContent).toBe("0");
  });
});
