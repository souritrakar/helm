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

async function awaitStream(): Promise<FakeEventSource> {
  await vi.waitFor(() => expect(FakeEventSource.current).not.toBeNull());
  return openStream();
}

beforeEach(async () => {
  FakeEventSource.current = null;
  showNotification.mockClear();
  setVisibility("visible");
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ token: "session" }) })));
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(() => Promise.resolve({ showNotification })), ready: Promise.resolve({ showNotification }) },
  });
  render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);
  await vi.waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/helm-sw.js"));
  await awaitStream();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it("announces a card clipped outside its scrollable container", async () => {
    render(
      <div data-testid="inbox-scroll">
        <article data-inbox-item-id="status:clipped">Clipped card</article>
      </div>,
    );
    const container = screen.getByTestId("inbox-scroll");
    const card = screen.getByText("Clipped card");
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => ({ bottom: 50, left: 0, right: 100, top: 0 }),
    });
    Object.defineProperty(card, "getBoundingClientRect", {
      value: () => ({ bottom: 200, left: 0, right: 100, top: 100 }),
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      overflowX: element === container ? "auto" : "visible",
      overflowY: element === container ? "auto" : "visible",
    }) as CSSStyleDeclaration);

    const stream = openStream();
    act(() => {
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:clipped"));
    });

    await vi.waitFor(() => expect(screen.getAllByRole("status")[0]?.textContent).toBe("1"));
  });

  it("announces an item once when it escalates from attention to blocking", async () => {
    const stream = openStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("item.upsert", { ...blocking("status:escalation"), urgency: "attention" });
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:escalation"));
    });

    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(showNotification).toHaveBeenCalledWith("Captain action needed", expect.objectContaining({ tag: "status:escalation" }));
  });

  it("announces a re-raised card after a cold snapshot omits its earlier occurrence", async () => {
    const stream = openStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:reraised"));
    });
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toBe("1");

    act(() => {
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:reraised"));
    });

    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(2));
    expect(showNotification).toHaveBeenLastCalledWith("Captain action needed", expect.objectContaining({ tag: "status:reraised" }));
    expect(screen.getByRole("status").textContent).toBe("1");
  });

  it("removes a retracted announced card from the unread count", async () => {
    const stream = openStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:retracted"));
    });
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toBe("1"));

    act(() => stream.emit("item.retract", { id: "status:retracted" }));

    expect(screen.getByRole("status").textContent).toBe("0");
  });

  it("clears the unread state when a blocking item is demoted", async () => {
    const stream = openStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:demoted"));
    });
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toBe("1"));

    act(() => stream.emit("item.upsert", { ...blocking("status:demoted"), urgency: "attention" }));

    expect(screen.getByRole("status").textContent).toBe("0");
    act(() => stream.emit("item.upsert", blocking("status:demoted")));
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(2));
  });

  it("re-checks tab visibility after service-worker registration", async () => {
    let resolveRegistration: ((registration: { showNotification: typeof showNotification }) => void) | undefined;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn(() => new Promise((resolve) => { resolveRegistration = resolve; })) },
    });
    cleanup();
    FakeEventSource.current = null;
    render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);
    const stream = await awaitStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:race"));
      setVisibility("visible");
      resolveRegistration?.({ showNotification });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("does not notify after a retraction while service-worker registration is pending", async () => {
    let resolveRegistration: ((registration: { showNotification: typeof showNotification }) => void) | undefined;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: vi.fn(() => new Promise((resolve) => { resolveRegistration = resolve; })) },
    });
    cleanup();
    FakeEventSource.current = null;
    render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);
    const stream = await awaitStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:pending-retract"));
      stream.emit("item.retract", { id: "status:pending-retract" });
      resolveRegistration?.({ showNotification });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("remints and replays the latest visibility report after a rejected session", async () => {
    cleanup();
    FakeEventSource.current = null;
    let postCount = 0;
    const fetchMock = vi.fn((_: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCount += 1;
        return Promise.resolve({ ok: postCount > 1, status: postCount === 1 ? 403 : 200 });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: `session:${postCount + 1}` }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/inbox/visibility", expect.objectContaining({
      headers: expect.objectContaining({ "X-Helm-Visibility-Session": "session:1" }),
      body: expect.stringContaining('"sequence":0'),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/inbox/visibility", expect.objectContaining({
      headers: expect.objectContaining({ "X-Helm-Visibility-Session": "session:2" }),
      body: expect.stringContaining('"sequence":0'),
    }));
  });

  it("waits for the initial visibility report before opening the event stream", async () => {
    cleanup();
    FakeEventSource.current = null;
    let acceptPresence: ((response: { ok: boolean; status: number }) => void) | undefined;
    const fetchMock = vi.fn((_: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { acceptPresence = resolve; });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: "session" }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(FakeEventSource.current).toBeNull();

    act(() => acceptPresence?.({ ok: true, status: 200 }));
    await awaitStream();
  });

  it("starts notifications after an initial visibility failure", async () => {
    cleanup();
    FakeEventSource.current = null;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 503 })));
    render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);

    const stream = await awaitStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:presence-unavailable"));
    });

    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
  });

  it("retries presence after a transient visibility failure", async () => {
    cleanup();
    FakeEventSource.current = null;
    let failSession = true;
    const fetchMock = vi.fn((_: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve({ ok: true, status: 200 });
      if (failSession) return Promise.resolve({ ok: false, status: 503 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: "session-retry" }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);

    await awaitStream();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    failSession = false;
    act(() => window.dispatchEvent(new Event("focus")));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/inbox/visibility",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Helm-Visibility-Session": "session-retry" }),
      }),
    ));
  });

  it("delivers only the current occurrence after a pending worker becomes active", async () => {
    let resolveReady: ((registration: { showNotification: typeof showNotification }) => void) | undefined;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: vi.fn(() => Promise.resolve({ showNotification })),
        ready: new Promise((resolve) => { resolveReady = resolve; }),
      },
    });
    cleanup();
    FakeEventSource.current = null;
    render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);
    const stream = await awaitStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:reraised-pending"));
      stream.emit("item.retract", { id: "status:reraised-pending" });
      stream.emit("item.upsert", { ...blocking("status:reraised-pending"), title: "Replacement action needed" });
      resolveReady?.({ showNotification });
    });

    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(showNotification).toHaveBeenCalledWith("Replacement action needed", expect.objectContaining({ tag: "status:reraised-pending" }));
  });

  it("invalidates pending notification delivery at snapshot start", async () => {
    let resolveReady: ((registration: { showNotification: typeof showNotification }) => void) | undefined;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: vi.fn(() => Promise.resolve({ showNotification })),
        ready: new Promise((resolve) => { resolveReady = resolve; }),
      },
    });
    cleanup();
    FakeEventSource.current = null;
    render(<InboxNotificationProvider><Probe /></InboxNotificationProvider>);
    const stream = await awaitStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:snapshot-pending"));
      stream.emit("snapshot.begin");
      resolveReady?.({ showNotification });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("keeps a rejected browser notification best-effort", async () => {
    showNotification.mockRejectedValueOnce(new Error("permission changed"));
    const stream = openStream();
    act(() => {
      setVisibility("hidden");
      stream.emit("snapshot.begin");
      stream.emit("snapshot.end");
      stream.emit("item.upsert", blocking("status:notification-rejected"));
    });

    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
  });
});
