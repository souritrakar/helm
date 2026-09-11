"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";

import { notificationTitle } from "@/lib/inbox-view";

type NotificationPermissionState = NotificationPermission | "unsupported";
type BlockingNotificationState = { readonly announced: boolean; readonly suppressed: boolean; readonly generation: number };

interface NotificationContextValue {
  readonly unreadBlocking: number;
  readonly permission: NotificationPermissionState;
  requestPermission(): Promise<void>;
}

interface InboxEventItem {
  readonly id: string;
  /** The primitive type, so an announcement can lead with what the card IS. */
  readonly kind: string;
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

/**
 * `Notification.permission` read as an external store.
 *
 * It must NOT be read during render: the server would say "unsupported" and the
 * first client render "default", failing hydration and forcing React to rebuild
 * the tree — which would tear down the terminal and its WebSocket. A server
 * snapshot of "unsupported" makes both sides agree, and the real value arrives
 * on the first post-hydration read.
 */
const permissionListeners = new Set<() => void>();

function subscribePermission(onChange: () => void): () => void {
  permissionListeners.add(onChange);
  return () => permissionListeners.delete(onChange);
}

function permissionChanged(): void {
  for (const listener of permissionListeners) listener();
}

function serverPermission(): NotificationPermissionState {
  return "unsupported";
}

function itemIsVisible(id: string): boolean {
  return [...document.querySelectorAll<HTMLElement>("[data-inbox-item-id]")]
    .some((element) => element.dataset.inboxItemId === id && elementHasVisiblePixels(element));
}

function elementHasVisiblePixels(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  let left = Math.max(rect.left, 0);

  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    const ancestorRect = ancestor.getBoundingClientRect();
    if (clipsOverflow(style.overflowY)) {
      top = Math.max(top, ancestorRect.top);
      bottom = Math.min(bottom, ancestorRect.bottom);
    }
    if (clipsOverflow(style.overflowX)) {
      left = Math.max(left, ancestorRect.left);
      right = Math.min(right, ancestorRect.right);
    }
    if (top >= bottom || left >= right) return false;
  }

  return top < bottom && left < right;
}

function clipsOverflow(value: string): boolean {
  return value === "auto" || value === "clip" || value === "hidden" || value === "overlay" || value === "scroll";
}

function parseInboxEventItem(raw: string): InboxEventItem | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.kind !== "string" ||
      typeof item.title !== "string" ||
      (item.urgency !== "blocking" && item.urgency !== "attention" && item.urgency !== "fyi") ||
      (item.state !== "open" && item.state !== "answered" && item.state !== "dismissed") ||
      (item.detail !== undefined && typeof item.detail !== "string")
    ) return null;
    return {
      id: item.id as string,
      kind: item.kind as string,
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
  const permission = useSyncExternalStore(subscribePermission, browserPermission, serverPermission);
  const serviceWorkerReady = useRef<Promise<ServiceWorkerRegistration | null>>(Promise.resolve(null));
  const blockingStates = useRef(new Map<string, BlockingNotificationState>());
  const notificationGeneration = useRef(0);
  const snapshotStates = useRef<Map<string, BlockingNotificationState> | null>(null);
  const snapshotting = useRef(false);
  const visibilityReady = useRef<Promise<boolean>>(Promise.resolve(false));

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    serviceWorkerReady.current = navigator.serviceWorker.register("/helm-sw.js")
      .then(() => navigator.serviceWorker.ready)
      .catch(() => null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let session: string | null = null;
    let sessionSequence = 0;
    let latestReport: { readonly active: boolean; readonly itemIds: string[] } | null = null;
    let reportVersion = 0;
    let sentVersion = 0;
    let flushing = false;
    let initialReportPending = true;
    let resolveInitialReport: (accepted: boolean) => void = () => undefined;
    visibilityReady.current = new Promise((resolve) => {
      resolveInitialReport = resolve;
    });

    const createSession = async (): Promise<string | null> => {
      try {
        const response = await fetch("/api/inbox/visibility");
        if (!response.ok) return null;
        const body: unknown = await response.json();
        return typeof body === "object" && body !== null && typeof (body as { token?: unknown }).token === "string"
          ? (body as { token: string }).token
          : null;
      } catch {
        return null;
      }
    };

    const flush = async (): Promise<void> => {
      if (flushing) return;
      flushing = true;
      while (!cancelled && sentVersion !== reportVersion && latestReport !== null) {
        if (session === null) {
          session = await createSession();
          sessionSequence = 0;
          if (session === null) {
            if (initialReportPending) {
              initialReportPending = false;
              resolveInitialReport(false);
            }
            break;
          }
        }
        const version = reportVersion;
        const report = latestReport;
        try {
          const response = await fetch("/api/inbox/visibility", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Helm-Visibility-Session": session },
            body: JSON.stringify({ sequence: sessionSequence++, ...report }),
          });
          if (response.status === 403) {
            session = null;
            continue;
          }
          if (initialReportPending) {
            initialReportPending = false;
            resolveInitialReport(response.ok);
          }
          sentVersion = version;
        } catch {
          if (initialReportPending) {
            initialReportPending = false;
            resolveInitialReport(false);
          }
          sentVersion = version;
        }
      }
      flushing = false;
    };

    const report = () => {
      // Live item ids are observed when Lane H renders store cards into this shell.
      latestReport = {
        active: document.visibilityState === "visible" && document.hasFocus(),
        itemIds: [...document.querySelectorAll<HTMLElement>("[data-inbox-item-id]")]
          .filter((element) => itemIsVisible(element.dataset.inboxItemId ?? ""))
          .map((element) => element.dataset.inboxItemId ?? ""),
      };
      reportVersion += 1;
      void flush();
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
      if (initialReportPending) resolveInitialReport(false);
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
    let cancelled = false;
    let stream: EventSource | null = null;
    void visibilityReady.current.then(() => {
      if (cancelled) return;
      stream = new EventSource("/api/events");
      stream.addEventListener("snapshot.begin", () => {
        snapshotting.current = true;
        blockingStates.current = new Map();
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
          generation: 0,
        };

      if (snapshotting.current) {
        snapshotStates.current?.set(item.id, {
          announced: false,
          suppressed: item.urgency === "blocking",
          generation: 0,
        });
        return;
      }

      if (item.urgency !== "blocking") {
        if (nextState.announced) {
          setUnreadBlocking((count) => Math.max(0, count - 1));
        }
        blockingStates.current.set(item.id, { announced: false, suppressed: false, generation: 0 });
        return;
      }

      if (nextState.announced || nextState.suppressed) return;

      if (document.visibilityState === "visible" && itemIsVisible(item.id)) {
        blockingStates.current.set(item.id, { announced: false, suppressed: true, generation: 0 });
        return;
      }
      const generation = ++notificationGeneration.current;
      blockingStates.current.set(item.id, { announced: true, suppressed: false, generation });
      setUnreadBlocking((count) => count + 1);
      // An announcement arrives with no chip and no card around it, so it leads
      // with what the card IS and keeps the summary as the supporting line.
      const announcement = notificationTitle(item.kind, item.title);
      toast.warning(announcement, { description: item.detail, id: `inbox:${item.id}` });

      if (
        document.visibilityState !== "visible" &&
        browserPermission() === "granted"
      ) {
        void serviceWorkerReady.current.then((registration) => {
          if (
            document.visibilityState !== "visible" &&
            blockingStates.current.get(item.id)?.generation === generation
          ) {
            return registration?.showNotification(announcement, {
              body: item.detail,
              tag: item.id,
              data: { inboxItemId: item.id },
            });
          }
          return undefined;
        }).catch(() => undefined);
      }
      });
      stream.addEventListener("item.retract", (raw) => {
      try {
        const { id } = JSON.parse((raw as MessageEvent<string>).data) as { id?: string };
        if (id !== undefined) {
          if (blockingStates.current.get(id)?.announced) {
            setUnreadBlocking((count) => Math.max(0, count - 1));
          }
          blockingStates.current.delete(id);
        }
      } catch {
        // Ignore a malformed internal event; the next snapshot restores state.
      }
      });
    });
    return () => {
      cancelled = true;
      stream?.close();
    };
  }, []);

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    await Notification.requestPermission();
    permissionChanged();
  }, []);

  const value = useMemo(() => ({ unreadBlocking, permission, requestPermission }), [unreadBlocking, permission, requestPermission]);
  return <InboxNotificationContext.Provider value={value}>{children}</InboxNotificationContext.Provider>;
}

export function useInboxNotifications(): NotificationContextValue {
  return useContext(InboxNotificationContext);
}
