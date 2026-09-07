"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type NotificationPermissionState = NotificationPermission | "unsupported";
type BlockingNotificationState = { readonly announced: boolean; readonly suppressed: boolean };

interface NotificationContextValue {
  readonly unreadBlocking: number;
  readonly permission: NotificationPermissionState;
  requestPermission(): Promise<void>;
}

interface InboxEventItem {
  readonly id: string;
  readonly urgency: "blocking" | "attention" | "fyi";
  readonly title: string;
  readonly detail?: string;
  readonly state: "open" | "answered" | "dismissed";
}

const noNotifications: NotificationContextValue = {
  unreadBlocking: 0,
  permission: "unsupported",
  requestPermission: async () => undefined,
};

const InboxNotificationContext = createContext<NotificationContextValue>(noNotifications);

function browserPermission(): NotificationPermissionState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function itemIsVisible(id: string): boolean {
  return [...document.querySelectorAll<HTMLElement>("[data-inbox-item-id]")].some((element) => {
    if (element.dataset.inboxItemId !== id) return false;
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  });
}

function parseInboxEventItem(raw: string): InboxEventItem | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      (item.urgency !== "blocking" && item.urgency !== "attention" && item.urgency !== "fyi") ||
      (item.state !== "open" && item.state !== "answered" && item.state !== "dismissed") ||
      (item.detail !== undefined && typeof item.detail !== "string")
    ) return null;
    return {
      id: item.id as string,
      urgency: item.urgency as InboxEventItem["urgency"],
      title: item.title as string,
      detail: item.detail as string | undefined,
      state: item.state as InboxEventItem["state"],
    };
  } catch {
    return null;
  }
}

/**
 * Reads the inbox SSE stream without answering or mutating any cards. It only
 * announces newly-raised blocking cards; snapshot cards are baseline state.
 */
export function InboxNotificationProvider({ children }: { children: React.ReactNode }) {
  const [unreadBlocking, setUnreadBlocking] = useState(0);
  const [permission, setPermission] = useState<NotificationPermissionState>(browserPermission);
  const serviceWorkerReady = useRef<Promise<ServiceWorkerRegistration | null>>(Promise.resolve(null));
  const blockingStates = useRef(new Map<string, BlockingNotificationState>());
  const snapshotStates = useRef<Map<string, BlockingNotificationState> | null>(null);
  const snapshotting = useRef(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    serviceWorkerReady.current = navigator.serviceWorker.register("/helm-sw.js").catch(() => null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const session = fetch("/api/inbox/visibility")
      .then(async (response) => {
        if (!response.ok) return null;
        const body: unknown = await response.json();
        return typeof body === "object" && body !== null && typeof (body as { token?: unknown }).token === "string"
          ? (body as { token: string }).token
          : null;
      })
      .catch(() => null);
    const report = () => {
      void session.then((token) => {
        if (cancelled || token === null) return;
        const itemIds = [...document.querySelectorAll<HTMLElement>("[data-inbox-item-id]")]
          .filter((element) => itemIsVisible(element.dataset.inboxItemId ?? ""))
          .map((element) => element.dataset.inboxItemId ?? "");
        void fetch("/api/inbox/visibility", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Helm-Visibility-Session": token },
          body: JSON.stringify({ sequence: sequence++, active: document.visibilityState === "visible" && document.hasFocus(), itemIds }),
        });
      });
    };
    report();
    const timer = window.setInterval(report, 5_000);
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    window.addEventListener("scroll", report, true);
    window.addEventListener("resize", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
      window.removeEventListener("scroll", report, true);
      window.removeEventListener("resize", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") setUnreadBlocking(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    const stream = new EventSource("/api/events");
    stream.addEventListener("snapshot.begin", () => {
      snapshotting.current = true;
      snapshotStates.current = new Map();
      setUnreadBlocking(0);
    });
    stream.addEventListener("snapshot.end", () => {
      if (!snapshotting.current) return;
      blockingStates.current = snapshotStates.current ?? new Map();
      snapshotStates.current = null;
      snapshotting.current = false;
      setUnreadBlocking(0);
    });
    stream.addEventListener("item.upsert", (raw) => {
      const item = parseInboxEventItem((raw as MessageEvent<string>).data);
      if (item === null) return;
      if (item.state !== "open") return;

      const previous = blockingStates.current.get(item.id);
      const nextState =
        previous ?? {
          announced: false,
          suppressed: false,
        };

      if (snapshotting.current) {
        snapshotStates.current?.set(item.id, {
          announced: false,
          suppressed: item.urgency === "blocking",
        });
        return;
      }

      if (item.urgency !== "blocking") {
        blockingStates.current.set(item.id, nextState);
        return;
      }

      if (nextState.announced || nextState.suppressed) return;

      if (document.visibilityState === "visible" && itemIsVisible(item.id)) {
        blockingStates.current.set(item.id, { announced: false, suppressed: true });
        return;
      }
      blockingStates.current.set(item.id, { announced: true, suppressed: false });
      setUnreadBlocking((count) => count + 1);
      toast.warning(item.title, { description: item.detail, id: `inbox:${item.id}` });

      if (
        document.visibilityState !== "visible" &&
        browserPermission() === "granted"
      ) {
        void serviceWorkerReady.current.then((registration) => {
          if (document.visibilityState !== "visible") {
            return registration?.showNotification(item.title, {
              body: item.detail,
              tag: item.id,
              data: { inboxItemId: item.id },
            });
          }
          return undefined;
        });
      }
    });
    stream.addEventListener("item.retract", (raw) => {
      try {
        const { id } = JSON.parse((raw as MessageEvent<string>).data) as { id?: string };
        if (id !== undefined) {
          blockingStates.current.delete(id);
        }
      } catch {
        // Ignore a malformed internal event; the next snapshot restores state.
      }
    });
    return () => stream.close();
  }, []);

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    setPermission(await Notification.requestPermission());
  }, []);

  const value = useMemo(() => ({ unreadBlocking, permission, requestPermission }), [unreadBlocking, permission, requestPermission]);
  return <InboxNotificationContext.Provider value={value}>{children}</InboxNotificationContext.Provider>;
}

export function useInboxNotifications(): NotificationContextValue {
  return useContext(InboxNotificationContext);
}
