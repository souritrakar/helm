"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleX, LoaderCircle, Ship } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { FleetHealth, FleetMember, FleetOverview } from "@/lib/fleet-view";

/** How often the overview is refreshed. The payload is a cached projection. */
const POLL_MS = 5_000;

/** Indexes the same status tokens the inbox urgency dots use (`globals.css`). */
const HEALTH_DOT: Record<FleetHealth, string> = {
  blocked: "bg-urgency-blocking",
  working: "bg-success",
  done: "bg-info",
  idle: "bg-urgency-quiet",
  unknown: "border border-urgency-quiet",
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
        <p className="text-body text-muted-foreground">Reading the fleet.</p>
      </div>
    );
  }

  if (status === "error" || overview === null) {
    return (
      <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
        <CircleX className="size-6 text-destructive" />
        <h3 className="text-title font-semibold">Fleet state unavailable</h3>
        <p className="max-w-[48ch] text-pretty text-body text-muted-foreground">{error}</p>
        <Button variant="default" size="touch" onClick={retry}>Retry</Button>
      </div>
    );
  }

  if (overview.members.length === 0) {
    return (
      <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
        <Ship className="size-6 text-muted-foreground" />
        <p className="max-w-[42ch] text-pretty text-body text-muted-foreground">No tasks are in flight.</p>
      </div>
    );
  }

  const active = SUMMARY_ORDER.filter((health) => overview.counts[health] > 0);

  return (
    <div className="min-w-0">
      {active.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-b px-3 py-2 sm:px-4">
          {active.map((health) => (
            <span key={health} className="flex items-center gap-1.5 text-ui text-muted-foreground">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${HEALTH_DOT[health]}`} />
              <span className="font-mono font-semibold tabular-nums text-foreground">{overview.counts[health]}</span>
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
    // `pl-4` is the dot gutter: size-2 + gap-2. Change one and change all three.
    <div className="relative min-w-0 pl-4">
      <span
        aria-hidden="true"
        className={`absolute left-0 top-[0.3rem] size-2 shrink-0 rounded-full ${HEALTH_DOT[member.health]}`}
      />
      <span className="sr-only">{HEALTH_LABEL[member.health]}. </span>
      <div className="flex min-w-0 items-start gap-2">
        {/*
          Row identity stays fully readable here; secondary detail lives in the
          inbox. A task title is often a whole brief, so clipping it hides the
          words that identify the row.
        */}
        <h3 className="min-w-0 flex-1 text-pretty break-words text-ui font-semibold">
          {member.title}
        </h3>
        {member.needsYou && (
          <span className="shrink-0 rounded-full bg-urgency-blocking px-2 py-0.5 text-meta font-medium text-white">
            Needs you
          </span>
        )}
      </div>
      {member.doing !== undefined && (
        <p className="mt-1 text-pretty break-words text-ui text-muted-foreground [-webkit-box-orient:vertical] [display:-webkit-box] [-webkit-line-clamp:2] overflow-hidden">
          {member.doing}
        </p>
      )}
      {(member.repo !== undefined || member.stale) && (
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
          {member.repo !== undefined && member.repo !== "" && <span className="truncate font-mono">{member.repo}</span>}
          {/* Says the reading itself may be out of date — not that the task is. */}
          {member.stale && <span>reading may be stale</span>}
        </p>
      )}
    </div>
  );
}
