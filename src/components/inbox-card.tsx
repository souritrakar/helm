"use client";

import { useState } from "react";
import {
  CircleAlert,
  Clock3,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { submitInboxResponse } from "@/lib/inbox-client";
import type { InboxItem, InboxItemKind, InboxItemState, InboxUrgency } from "@/lib/types";

const kindLabels: Record<InboxItemKind, string> = {
  "status-decision": "Status decision",
  decision: "Decision",
  merge: "Merge",
  credential: "Credential",
  "captain-held": "Captain-held",
  destructive: "Destructive",
  irreversible: "Irreversible",
  "security-sensitive": "Security-sensitive",
  blocker: "Blocker",
  escalation: "Escalation",
  review: "Review",
  note: "Note",
  custom: "Custom",
};

const urgencyStyles: Record<InboxUrgency, string> = {
  blocking: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
  attention: "border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  fyi: "border-sky-500/20 bg-sky-500/10 text-sky-800 dark:text-sky-200",
};

const stateStyles: Record<InboxItemState, string> = {
  open: "border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  answered: "border-border bg-muted text-muted-foreground",
  dismissed: "border-border bg-muted text-muted-foreground",
};

const closedNotices: Record<Exclude<InboxItemState, "open">, string> = {
  answered: "Answered. This card is read-only.",
  dismissed: "Dismissed. This card is read-only.",
};

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-1 text-sm/5 sm:text-xs/4 ${className}`}>{children}</span>;
}

function UrgencyIcon({ urgency }: { urgency: InboxUrgency }) {
  const className = "mt-0.5 size-4 shrink-0";
  if (urgency === "blocking") return <ShieldAlert className={`${className} text-red-600 dark:text-red-400`} />;
  if (urgency === "attention") return <CircleAlert className={`${className} text-amber-600 dark:text-amber-400`} />;
  return <Sparkles className={`${className} text-sky-600 dark:text-sky-400`} />;
}

export function InboxCard({ item }: { item: InboxItem }) {
  const closed = item.state !== "open";
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (action: { value: string } | { text: string }): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await submitInboxResponse(item.id, action);
    if (!result.ok) {
      const message = result.error ?? "The answer was not delivered";
      setError(message);
      toast.error("Answer was not delivered", { description: message });
      setBusy(false);
      return;
    }
    toast.success("Answer delivered");
    setDraft("");
    setBusy(false);
  };

  return (
    <article className="@container min-w-0" data-inbox-item-id={item.id}>
      <div className="flex min-w-0 items-start gap-3">
        <UrgencyIcon urgency={item.urgency} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge className={urgencyStyles[item.urgency]}>{item.urgency}</Badge>
            <Badge className={stateStyles[item.state]}>{item.state}</Badge>
            <span className="font-mono text-sm text-muted-foreground sm:text-xs">{kindLabels[item.kind]}</span>
          </div>
          <h3 className="mt-2 text-base font-semibold text-pretty sm:text-sm">{item.title}</h3>
          {item.detail !== undefined && item.detail !== "" && (
            <p className="mt-1 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">{item.detail}</p>
          )}
          <div className="mt-3 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {item.repo !== undefined && item.repo !== "" && <span className="font-mono text-xs">{item.repo}</span>}
            {item.taskId !== undefined && item.taskId !== "" && <span className="font-mono text-xs">{item.taskId}</span>}
            {item.answeredAt !== undefined && (
              <span className="flex items-center gap-1"><Clock3 className="size-4 shrink-0" />Answered</span>
            )}
          </div>
          {item.state !== "open" && (
            <p className="mt-3 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">{closedNotices[item.state]}</p>
          )}
          {!closed && item.options.length > 0 && (
            <div className="mt-4 flex min-w-0 flex-wrap gap-2">
              {item.options.map((option) => (
                <Button
                  key={option.value}
                  size="lg"
                  variant="outline"
                  disabled={busy}
                  title={option.hint}
                  onClick={() => void send({ value: option.value })}
                >
                  {option.label}
                  {option.value === item.recommendValue && (
                    <span className="ml-1.5 font-mono text-xs opacity-70">recommended</span>
                  )}
                </Button>
              ))}
            </div>
          )}
          {!closed && item.allowFreeform && (
            <div className="mt-3 flex min-w-0 flex-col gap-2 @sm:flex-row">
              <input
                name={`response-${item.id}`}
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && draft.trim() !== "") void send({ text: draft.trim() });
                }}
                placeholder="Write a response…"
                aria-label={`Response for ${item.title}`}
                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-0 sm:text-sm"
              />
              <Button
                size="lg"
                variant="outline"
                disabled={busy || draft.trim() === ""}
                onClick={() => void send({ text: draft.trim() })}
                className="shrink-0"
              >
                Send
              </Button>
            </div>
          )}
          {error !== null && (
            <p className="mt-2 text-base/7 text-destructive sm:text-sm/6" role="alert">{error}</p>
          )}
        </div>
      </div>
    </article>
  );
}
