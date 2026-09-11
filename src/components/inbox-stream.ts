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
 * Follow the inbox SSE stream and keep the open set plus the answered and
 * dismissed cards the server replayed.
 *
 * A snapshot replaces only the OPEN set. `snapshot.begin` carries the open ids,
 * so a handled card in the same snapshot lands in the handled map instead and
 * the Answered / Dismissed tabs survive a reload (AC 11).
 *
 * Everything that touches `EventSource` happens inside the effect. Probing it
 * during render would make the server say "unsupported" and the first client
 * render say "loading", and the resulting hydration failure regenerates the
 * whole tree — remounting the terminal and its WebSocket with it.
 */
export function useInboxItems(): InboxStream {
  const [items, setItems] = useState<readonly InboxItem[]>([]);
  const [status, setStatus] = useState<InboxStreamStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    const fail = (message: string): (() => void) => {
      const timer = window.setTimeout(() => {
        setStatus("error");
        setError(message);
      }, 0);
      return () => window.clearTimeout(timer);
    };

    if (typeof EventSource === "undefined") {
      return fail("Inbox stream is unavailable in this browser");
    }

    let open = new Map<string, InboxItem>();
    const handled = new Map<string, InboxItem>();
    let snapshotting = false;
    let snapshotOpen = new Map<string, InboxItem>();
    let stream: EventSource;
    try {
      stream = new EventSource("/api/events");
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : String(cause));
    }

    const publish = (): void => {
      setItems([...handled.values(), ...open.values()]);
    };
    const ready = (): void => {
      setStatus("ready");
      setError(null);
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
        ready();
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
      ready();
      publish();
    });
    stream.onerror = () => {
      // EventSource reconnects on its own; only a CLOSED stream is terminal.
      if (stream.readyState === EventSource.CLOSED) {
        setStatus("error");
        setError("Inbox stream closed");
      }
    };

    return () => {
      stream.close();
    };
  }, [generation]);

  return { items, status, error, retry };
}
