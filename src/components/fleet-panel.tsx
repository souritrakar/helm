"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  LoaderCircle,
  Moon,
  OctagonAlert,
  Ship,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { FleetHealth, FleetMember, FleetOverview } from "@/lib/fleet-view";

/** How often the overview is refreshed. The payload is a cached projection. */
const POLL_MS = 5_000;

/** Indexes the same status tokens the inbox urgency chips use (`globals.css`). */
const HEALTH_TINT: Record<FleetHealth, string> = {
  blocked: "bg-urgency-blocking-tint text-urgency-blocking",
  working: "bg-success-tint text-success",
  done: "bg-muted text-muted-foreground",
  idle: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

/** The dot on a summary chip, where there is no room for a glyph. */
const HEALTH_DOT: Record<FleetHealth, string> = {
  blocked: "bg-urgency-blocking",
  working: "bg-success",
  done: "bg-urgency-quiet",
  idle: "bg-urgency-quiet",
  unknown: "border border-urgency-quiet",
};

/**
 * One glyph per health band, so a row's state reads without decoding a hue.
 * `working` spins, which is the one place in the cockpit motion reports a fact
 * rather than a transition — a crewmate is mid-task right now.
 */
const HEALTH_ICONS: Record<FleetHealth, LucideIcon> = {
  blocked: OctagonAlert,
  working: LoaderCircle,
  done: CircleCheck,
  idle: Moon,
  unknown: CircleHelp,
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
      <div className="flex flex-col gap-3 px-3 pt-4 sm:px-4" role="status" aria-busy="true">
        <span className="sr-only">Reading the fleet.</span>
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex gap-3 rounded-xl border bg-card p-3.5 shadow-card sm:p-4">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2.5">
              <Skeleton className="h-4 w-full max-w-64" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (status === "error" || overview === null) {
    return (
      <FleetNotice Icon={CircleX} tone="bg-destructive-tint text-destructive">
        <h2 className="text-display font-semibold tracking-tight">Could not read the fleet</h2>
        <p className="max-w-[48ch] text-pretty text-body text-muted-foreground">{error}</p>
        <Button variant="default" size="touch" onClick={retry} className="mt-1">
          Retry
        </Button>
      </FleetNotice>
    );
  }

  if (overview.members.length === 0) {
    return (
      <FleetNotice Icon={Ship} tone="bg-muted text-muted-foreground">
        <h2 className="text-display font-semibold tracking-tight">Harbour is quiet</h2>
        <p className="max-w-[42ch] text-pretty text-body text-muted-foreground">
          No tasks are in flight.
        </p>
      </FleetNotice>
    );
  }

  const active = SUMMARY_ORDER.filter((health) => overview.counts[health] > 0);

  return (
    /*
     * A `section` with a heading, matching the inbox's banded runs: the two
     * panels occupy the same slot and answer the same question, so the fleet's
     * counts must be reachable by heading navigation too. The heading is
     * visually hidden because the chips already say it on screen.
     */
    <section className="min-w-0 pb-6" aria-labelledby="fleet-heading">
      <h2 id="fleet-heading" className="sr-only">
        Fleet
      </h2>
      {active.length > 0 && (
        // The fleet at a glance, before any one row. It reads at the same steps
        // as an inbox band header — this line answers "how is the fleet" in one
        // second, so it must not be the smallest type in the panel.
        <div
          role="list"
          aria-label="Fleet summary"
          className="sticky top-0 z-10 flex min-w-0 flex-wrap gap-x-4 gap-y-1.5 bg-background/95 px-3 pb-1.5 pt-4 backdrop-blur-sm sm:px-4"
        >
          {active.map((health) => (
            <span key={health} role="listitem" className="flex items-center gap-2 text-ui text-muted-foreground">
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${HEALTH_DOT[health]}`}
              />
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {overview.counts[health]}
              </span>
              {HEALTH_LABEL[health]}
            </span>
          ))}
        </div>
      )}
      <ul role="list" className="flex flex-col gap-3 px-3 sm:px-4">
        {overview.members.map((member) => (
          <li key={member.id} className="min-w-0">
            <FleetRow member={member} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The centred notice shared by the fleet's loading, error and empty states. */
function FleetNotice({
  Icon,
  tone,
  children,
}: {
  Icon: LucideIcon;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-4 p-8 text-center">
      <span
        aria-hidden="true"
        className={`flex size-12 items-center justify-center rounded-2xl ${tone}`}
      >
        <Icon className="size-6" />
      </span>
      <div className="flex flex-col items-center gap-1.5">{children}</div>
    </div>
  );
}

function FleetRow({ member }: { member: FleetMember }) {
  const Icon = HEALTH_ICONS[member.health];
  return (
    // The same card as an inbox request, so one cockpit reads as one product —
    // and a blocked crewmate looks like the blocking card it will raise.
    <article className="@container flex min-w-0 animate-card-in gap-3 rounded-xl border bg-card p-3 shadow-card motion-reduce:animate-none sm:p-4">
      <span
        aria-hidden="true"
        className={`mt-px flex size-8 shrink-0 items-center justify-center rounded-lg ${HEALTH_TINT[member.health]}`}
      >
        <Icon
          className={`size-4 shrink-0 ${member.health === "working" ? "animate-spin motion-reduce:animate-none" : ""}`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          {/*
            Row identity stays fully readable — a task title is often a whole
            brief, so clipping it hides the words that identify the row. It sits
            a step BELOW an inbox card title on purpose: the fleet is the scan
            surface and the inbox is the action surface, and if both set at
            17px the cockpit has no size step between "what exists" and "what
            needs me". Within the row, weight and colour carry the hierarchy.
          */}
          <h3 className="min-w-0 flex-1 text-pretty break-words text-body font-semibold">
            {member.title}
          </h3>
          {member.needsYou && (
            <Badge className="shrink-0 bg-urgency-blocking-tint text-urgency-blocking">Needs you</Badge>
          )}
        </div>
        {member.doing !== undefined && (
          /*
            The captain ratified this scan-surface clamp: row identity is fully
            readable; detail lives in the inbox and terminal. `foreground-secondary`,
            not `muted-foreground` — what a crewmate is doing right now is
            content, not metadata.
          */
          <p className="mt-1 overflow-hidden text-pretty break-words text-body text-foreground-secondary [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box]">
            {member.doing}
          </p>
        )}
        <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
          {/*
            The health band in WORDS. A tinted glyph plus a spin is colour and
            motion only, which is the one channel a row's primary fact must not
            rely on — and unlike the inbox there is no band header above it
            saying the same thing.
          */}
          <span className="font-medium">{HEALTH_LABEL[member.health]}</span>
          {member.repo !== undefined && member.repo !== "" && (
            <span className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono">
              {member.repo}
            </span>
          )}
          {/* Says the reading itself may be out of date — not that the task is. */}
          {member.stale && <span>Reading may be stale</span>}
        </p>
      </div>
    </article>
  );
}
