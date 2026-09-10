"use client";

import { useState } from "react";
import { Check, CircleSlash, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { dismissInboxItem, submitInboxResponse } from "@/lib/inbox-client";
import { BUCKET_LABELS, bucketOf, controlFor } from "@/lib/inbox-view";
import type { InboxItem, InboxUrgency } from "@/lib/types";

/**
 * Urgency is carried by one dot, not a word.
 *
 * The list is already ordered by urgency, so a "blocking" badge on every card
 * in the top band repeats what the position says. The dot keeps the signal
 * scannable without spending a line of a phone screen on it.
 */
const URGENCY_DOT: Record<InboxUrgency, string> = {
  blocking: "bg-red-500",
  attention: "bg-amber-500",
  fyi: "bg-zinc-400 dark:bg-zinc-600",
};

const URGENCY_LABEL: Record<InboxUrgency, string> = {
  blocking: "Blocking",
  attention: "Needs attention",
  fyi: "For information",
};

/** Detail longer than this collapses behind a toggle so cards stay scannable. */
const DETAIL_CLAMP_CHARS = 240;

export function InboxCard({ item }: { item: InboxItem }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);

  const control = controlFor(item);
  const open = item.state === "open";
  const detail = item.detail?.trim() ?? "";
  const clamped = !expanded && detail.length > DETAIL_CLAMP_CHARS;

  const act = async (
    run: () => Promise<{ ok: boolean; error?: string }>,
    failure: string,
    success: string,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await run();
    if (!result.ok) {
      const message = result.error ?? failure;
      setError(message);
      toast.error(failure, { description: message });
      setBusy(false);
      return;
    }
    toast.success(success);
    setDraft("");
    setBusy(false);
  };

  const answer = (action: { value: string } | { text: string }): void => {
    void act(() => submitInboxResponse(item.id, action), "Answer was not delivered", "Answer delivered");
  };
  const dismiss = (): void => {
    void act(() => dismissInboxItem(item.id), "Could not dismiss", "Dismissed");
  };

  return (
    <article className="@container min-w-0" data-inbox-item-id={item.id}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          aria-hidden="true"
          className={`mt-1.5 size-2 shrink-0 rounded-full ${URGENCY_DOT[item.urgency]}`}
        />
        <span className="sr-only">{URGENCY_LABEL[item.urgency]}. </span>
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {BUCKET_LABELS[bucketOf(item)]}
        </span>
      </div>

      <h3 className="mt-1.5 text-pretty text-base font-semibold leading-snug">{item.title}</h3>

      {detail !== "" && (
        <div className="mt-1">
          {/*
            An answer card is the one place the body IS the payload — it is the
            reply the human went looking for — so it reads as content rather
            than as supporting detail.
          */}
          <p
            className={
              item.kind === "answer"
                ? "mt-1.5 whitespace-pre-wrap text-pretty break-words rounded-md border-l-2 border-sky-500/50 bg-muted/50 px-3 py-2 text-sm/6"
                : "whitespace-pre-wrap text-pretty break-words text-sm/6 text-muted-foreground"
            }
          >
            {clamped ? `${detail.slice(0, DETAIL_CLAMP_CHARS).trimEnd()}…` : detail}
          </p>
          {(clamped || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="mt-1 text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {/* Provenance only — rendered as inert text, never a link helm resolves. */}
      {item.ref !== undefined && item.ref !== "" && (
        <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground" title={item.ref}>
          {item.ref}
        </p>
      )}

      {!open && <Outcome item={item} />}

      {open && (control === "options" || control === "both") && (
        <div className="mt-3 flex min-w-0 flex-wrap gap-2">
          {item.options.map((option) => (
            <Button
              key={option.value}
              size="lg"
              variant={option.value === item.recommendValue ? "default" : "outline"}
              disabled={busy}
              title={option.hint}
              onClick={() => answer({ value: option.value })}
              className="min-w-24 flex-1 @sm:flex-none"
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}

      {/*
        When the card declares options, those ARE the answer — one tap. A typed
        reply is the exception, so it hides behind a link instead of adding a
        text field to every approval and halving how many fit on a phone.
      */}
      {open && control === "both" && !replying && (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="mt-2 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Write a reply instead
        </button>
      )}

      {open && (control === "text" || (control === "both" && replying)) && (
        <div className="mt-2 flex min-w-0 flex-col gap-2 @sm:flex-row">
          <input
            name={`response-${item.id}`}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim() !== "") answer({ text: draft.trim() });
            }}
            autoFocus={control === "both"}
            placeholder="Write a reply…"
            aria-label={`Reply to ${item.title}`}
            className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-0 sm:text-sm"
          />
          <Button
            size="lg"
            variant="outline"
            disabled={busy || draft.trim() === ""}
            onClick={() => answer({ text: draft.trim() })}
            className="shrink-0"
          >
            Send
          </Button>
        </div>
      )}

      {open && (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={dismiss}
            disabled={busy}
            className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            Dismiss
          </button>
          {/*
            Only worth saying when the human might reasonably expect a control.
            An answer card is a report — there is nothing to reply to — so the
            notice would be noise there.
          */}
          {control === "none" && item.kind !== "answer" && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <CircleSlash className="size-3.5 shrink-0" aria-hidden="true" />
              No reply channel
            </span>
          )}
        </div>
      )}

      {error !== null && (
        <p className="mt-2 text-sm/6 text-destructive" role="alert">{error}</p>
      )}
    </article>
  );
}

/** What happened to a handled card, read-only. */
function Outcome({ item }: { item: InboxItem }) {
  const dismissed = item.state === "dismissed";
  const Icon = dismissed ? X : Check;
  return (
    <p
      className={`mt-2 flex min-w-0 items-baseline gap-1.5 text-sm/6 ${dismissed ? "text-muted-foreground" : "text-emerald-700 dark:text-emerald-400"}`}
    >
      <Icon className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {dismissed ? "Dismissed" : item.answer === undefined ? "Answered" : `Answered: ${item.answer}`}
      </span>
    </p>
  );
}
