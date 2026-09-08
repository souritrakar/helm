"use client";

import { useCallback, useEffect, useState } from "react";

import { parseInboxItem, parseInboxRetractId } from "@/lib/inbox-client";
import type { InboxItem } from "@/lib/types";

export type InboxStreamStatus = "loading" | "ready" | "error";

export interface InboxStream {
  readonly items: readonly InboxItem[];
  readonly status: InboxStreamStatus;
  readonly error: string | null;
  retry(): void;
}

/**
 * Follow the inbox SSE stream and keep the open set plus cards answered in
 * this tab. A snapshot replaces only the open set so answered history from
 * this session stays on the Answered filter (AC 11).
 */
export function useInboxItems(): InboxStream {
  const supported = typeof EventSource !== "undefined";
  const [items, setItems] = useState<readonly InboxItem[]>([]);
  const [status, setStatus] = useState<InboxStreamStatus>(supported ? "loading" : "error");
  const [error, setError] = useState<string | null>(
    supported ? null : "Inbox stream is unavailable in this browser",
  );
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (!supported) return;

    let open = new Map<string, InboxItem>();
    const handled = new Map<string, InboxItem>();
    let snapshotting = false;
    let snapshotOpen = new Map<string, InboxItem>();
    let stream: EventSource;
    try {
      stream = new EventSource("/api/events");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const timer = window.setTimeout(() => {
        setStatus("error");
        setError(message);
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const publish = (): void => {
      setItems([...handled.values(), ...open.values()]);
    };

    stream.addEventListener("snapshot.begin", () => {
      snapshotting = true;
      snapshotOpen = new Map();
    });
    stream.addEventListener("item.upsert", (raw) => {
      const item = parseInboxItem((raw as MessageEvent<string>).data);
      if (item === null) return;
      if (item.state === "open") {
        const target = snapshotting ? snapshotOpen : open;
        target.set(item.id, item);
        handled.delete(item.id);
      } else {
        handled.set(item.id, item);
        open.delete(item.id);
        snapshotOpen.delete(item.id);
      }
      if (!snapshotting) {
        setStatus("ready");
        setError(null);
        publish();
      }
    });
    stream.addEventListener("item.retract", (raw) => {
      const id = parseInboxRetractId((raw as MessageEvent<string>).data);
      if (id === null) return;
      open.delete(id);
      snapshotOpen.delete(id);
      if (!snapshotting) publish();
    });
    stream.addEventListener("snapshot.end", () => {
      open = snapshotOpen;
      snapshotting = false;
      setStatus("ready");
      setError(null);
      publish();
    });
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) {
        setStatus("error");
        setError("Inbox stream closed");
      }
    };

    return () => {
      stream.close();
    };
  }, [generation, supported]);

  return { items, status, error, retry };
}
