"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleX, LoaderCircle, Ship } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { FleetHealth, FleetMember, FleetOverview } from "@/lib/fleet-view";

/** How often the overview is refreshed. The payload is a cached projection. */
const POLL_MS = 5_000;

const HEALTH_DOT: Record<FleetHealth, string> = {
  blocked: "bg-red-500",
  working: "bg-emerald-500",
  done: "bg-sky-500",
  idle: "bg-zinc-400 dark:bg-zinc-600",
  unknown: "bg-zinc-300 dark:bg-zinc-700",
};

const HEALTH_LABEL: Record<FleetHealth, string> = {
  blocked: "Blocked",
  working: "Working",
  done: "Done",
  idle: "Idle",
  unknown: "Unknown",
};

/** Bands worth a summary chip. `unknown` is not news; `done` is history. */
const SUMMARY_ORDER: readonly FleetHealth[] = ["blocked", "working", "idle", "done"];

type FleetStatus = "loading" | "ready" | "error";

export function FleetPanel() {
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  const [status, setStatus] = useState<FleetStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/fleet");
        if (!response.ok) throw new Error(`fleet request failed (${response.status})`);
        const body = (await response.json()) as FleetOverview;
        if (cancelled) return;
        setOverview(body);
        setStatus("ready");
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [generation]);

  if (status === "loading") {
    return (
      <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm/6 text-muted-foreground">Reading the fleet.</p>
      </div>
    );
  }

  if (status === "error" || overview === null) {
    return (
      <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
        <CircleX className="size-5 text-destructive" />
        <h3 className="text-sm font-semibold">Fleet state unavailable</h3>
        <p className="max-w-[34ch] text-pretty text-sm/6 text-muted-foreground">{error}</p>
        <Button variant="outline" size="lg" onClick={retry}>Retry</Button>
      </div>
    );
  }

  if (overview.members.length === 0) {
    return (
      <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-6 text-center">
        <Ship className="size-5 text-muted-foreground" />
        <p className="max-w-[34ch] text-pretty text-sm/6 text-muted-foreground">No tasks are in flight.</p>
      </div>
    );
  }

  const active = SUMMARY_ORDER.filter((health) => overview.counts[health] > 0);

  return (
    <div className="min-w-0">
      {active.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-b px-3 py-2.5 sm:px-4">
          {active.map((health) => (
            <span key={health} className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${HEALTH_DOT[health]}`} />
              <span className="font-mono tabular-nums text-foreground">{overview.counts[health]}</span>
              {HEALTH_LABEL[health]}
            </span>
          ))}
        </div>
      )}
      <ul role="list" className="divide-y">
        {overview.members.map((member) => (
          <li key={member.id} className="px-3 py-3 sm:px-4">
            <FleetRow member={member} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FleetRow({ member }: { member: FleetMember }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          aria-hidden="true"
          className={`mt-1.5 size-2 shrink-0 rounded-full ${HEALTH_DOT[member.health]}`}
        />
        <span className="sr-only">{HEALTH_LABEL[member.health]}. </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={member.title}>
          {member.title}
        </h3>
        {member.needsYou && (
          <span className="shrink-0 rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white">
            Needs you
          </span>
        )}
      </div>
      {member.doing !== undefined && (
        <p className="mt-0.5 truncate pl-4 text-sm text-muted-foreground" title={member.doing}>
          {member.doing}
        </p>
      )}
      {(member.repo !== undefined || member.stale) && (
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 pl-4 text-xs text-muted-foreground">
          {member.repo !== undefined && member.repo !== "" && <span className="truncate font-mono">{member.repo}</span>}
          {/* Says the reading itself may be out of date — not that the task is. */}
          {member.stale && <span>reading may be stale</span>}
        </p>
      )}
    </div>
  );
}
