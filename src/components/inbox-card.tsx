"use client";

import { useState } from "react";
import { Check, CircleSlash, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { addToTerminalContext } from "@/components/terminal-composer";
import { Button } from "@/components/ui/button";
import { dismissInboxItem, submitInboxResponse } from "@/lib/inbox-client";
import { inboxItemContext } from "@/lib/inbox-context";
import { KIND_LABELS, controlFor } from "@/lib/inbox-view";
import type { InboxItem, InboxUrgency } from "@/lib/types";

/**
 * Urgency on two channels, not one.
 *
 * Hue alone fails for the ~8% of men with a red/green deficiency, and an 8px
 * dot is a weak mark at arm's length — so blocking is also bigger and haloed,
 * and fyi is hollow. The band header above the card says the word.
 */
const URGENCY_DOT: Record<InboxUrgency, string> = {
  blocking: "size-2.5 bg-urgency-blocking ring-[3px] ring-urgency-blocking/20",
  attention: "size-2 bg-urgency-attention",
  fyi: "size-2 border border-urgency-quiet",
};

const URGENCY_LABEL: Record<InboxUrgency, string> = {
  blocking: "Blocking",
  attention: "Needs attention",
  fyi: "For information",
};

/**
 * When the body collapses behind "Show more".
 *
 * Two limits, because the body is `whitespace-pre-wrap`: 240 characters of
 * newlines is 120 rendered lines, so a character budget alone would let one
 * card own the whole scroll. Nothing is ever cut from the DOM — the collapse is
 * a CSS line clamp, so the full text stays selectable and reachable.
 */
const CLAMP_CHARS = 240;
const CLAMP_LINES = 4;

export function InboxCard({ item }: { item: InboxItem }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);

  const control = controlFor(item);
  const open = item.state === "open";
  const detail = item.detail?.trim() ?? "";
  const long = detail.length > CLAMP_CHARS || detail.split("\n").length > CLAMP_LINES;
  const clamped = long && !expanded;

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
    // The dot hangs in a 16px gutter (size-2 + gap-2) so every line below it
    // shares one left edge, matching the fleet list.
    <article className="@container relative min-w-0 pl-4" data-inbox-item-id={item.id}>
      <span
        aria-hidden="true"
        className={`absolute left-0 top-[0.3rem] shrink-0 rounded-full ${URGENCY_DOT[item.urgency]}`}
      />
      <span className="sr-only">{URGENCY_LABEL[item.urgency]}. </span>

      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-meta font-medium uppercase tracking-wider text-muted-foreground">
            {KIND_LABELS[item.kind]}
          </span>
          {/*
            The header is never clipped. A title carrying a whole task note is
            the common case, and an ellipsis with no way to see the rest hides
            the one thing the human opened the inbox to read.
          */}
          <h3 className="mt-1 text-pretty break-words text-title font-semibold tracking-tight">
            {item.title}
          </h3>
        </div>
        <AddToTerminalButton item={item} />
      </div>

      {detail !== "" && (
        <div className="mt-2">
          {/*
            An answer card is the one place the body IS the payload — it is the
            reply the human went looking for — so it reads at full contrast
            behind a rule rather than as supporting detail.
          */}
          <p
            style={clamped ? { WebkitLineClamp: CLAMP_LINES } : undefined}
            className={`max-w-[68ch] whitespace-pre-wrap text-pretty break-words text-body ${
              clamped ? "overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical]" : ""
            } ${
              item.kind === "answer" || item.kind === "ask"
                ? "border-l-2 border-border pl-3 text-foreground"
                : "text-foreground-secondary"
            }`}
          >
            {detail}
          </p>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="-mx-1 mt-1 px-1 py-1 text-ui text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {!open && <Outcome item={item} />}

      {/*
        One action block, one rhythm. Everything the human can DO lives here, so
        the 12px break above it is the card's only structural seam.
      */}
      {(open || (item.ref !== undefined && item.ref !== "")) && (
        <div className="mt-3 flex min-w-0 flex-col gap-2">
          {error !== null && (
            <p
              className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-body font-medium text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}

          {open && (control === "options" || control === "both") && (
            <div className="flex min-w-0 flex-wrap gap-2">
              {item.options.map((option) => (
                <Button
                  key={option.value}
                  size="touch"
                  // With no recommendation every option is equal, so the GROUP
                  // is raised rather than one member of it — a filled button
                  // makes the card's primary path obvious without helm ranking
                  // answers it has no authority to rank.
                  variant={
                    item.recommendValue === undefined
                      ? "secondary"
                      : option.value === item.recommendValue
                        ? "default"
                        : "outline"
                  }
                  disabled={busy}
                  title={option.hint}
                  onClick={() => answer({ value: option.value })}
                  // An option label is an answer firstmate wrote, so it wraps
                  // rather than truncating — a clipped option is one the human
                  // cannot read before choosing it.
                  className="h-auto min-h-11 min-w-24 max-w-full flex-1 whitespace-normal py-2 sm:min-h-9 @sm:flex-none"
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}

          {/*
            When the card declares options, those ARE the answer — one tap. A
            typed reply is the exception, so it hides behind a link instead of
            adding a text field to every approval and halving how many fit on a
            phone.
          */}
          {open && control === "both" && !replying && (
            <button
              type="button"
              onClick={() => setReplying(true)}
              className="-mx-1 self-start px-1 py-1 text-ui font-medium text-foreground underline underline-offset-2 hover:text-muted-foreground"
            >
              Write a reply instead
            </button>
          )}

          {open && (control === "text" || (control === "both" && replying)) && (
            // One row at every width. Stacked, the Send button stretches to the
            // full card and a DISABLED control becomes the heaviest mark on it.
            <div className="flex min-w-0 flex-row items-center gap-2">
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
                // text-base on a phone is deliberate: anything smaller makes
                // iOS zoom the viewport on focus.
                className="h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-0 sm:h-9 sm:text-ui"
              />
              <Button
                size="touch"
                // The only control on a text-only card, so it is the primary one.
                variant={control === "text" ? "default" : "outline"}
                disabled={busy || draft.trim() === ""}
                onClick={() => answer({ text: draft.trim() })}
                className="shrink-0"
              >
                Send
              </Button>
            </div>
          )}

          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {open && (
              <button
                type="button"
                onClick={dismiss}
                disabled={busy}
                className="-mx-1 px-1 py-1 text-ui text-muted-foreground underline underline-offset-2 hover:text-destructive disabled:opacity-50"
              >
                Dismiss
              </button>
            )}
            {/*
              Only worth saying when the human might reasonably expect a control.
              An answer card is a report — there is nothing to reply to — so the
              notice would be noise there.
            */}
            {open && control === "none" && item.kind !== "answer" && (
              <span className="flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-meta text-muted-foreground">
                <CircleSlash className="size-3 shrink-0" aria-hidden="true" />
                No reply channel
              </span>
            )}
            {/* Provenance only — rendered as inert text, never a link helm resolves. */}
            {item.ref !== undefined && item.ref !== "" && (
              <span className="min-w-0 truncate font-mono text-meta text-muted-foreground" title={item.ref}>
                {item.ref}
              </span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * Attach this card to the message the human is writing in the terminal.
 *
 * Secondary by treatment — a ghost icon in the corner — but a real 44px tap
 * target, because on a phone this is the bridge between the inbox and the
 * conversation and hover has no meaning there.
 *
 * No toast: the chip that appears in the composer IS the confirmation, and on a
 * phone a bottom-corner toast lands on top of the composer it is announcing.
 */
function AddToTerminalButton({ item }: { item: InboxItem }) {
  const label = `Add "${item.title}" to the terminal composer`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-touch"
      aria-label={label}
      title="Add to terminal"
      onClick={() => addToTerminalContext({ label: item.title, text: inboxItemContext(item) })}
      className="-mr-2 -mt-2 shrink-0 text-muted-foreground hover:text-foreground"
    >
      <Plus className="size-4 shrink-0" aria-hidden="true" />
    </Button>
  );
}

/** What happened to a handled card, read-only. */
function Outcome({ item }: { item: InboxItem }) {
  const dismissed = item.state === "dismissed";
  const Icon = dismissed ? X : Check;
  return (
    <p
      className={`mt-2 flex min-w-0 items-start gap-1.5 text-body ${dismissed ? "text-muted-foreground" : "text-success"}`}
    >
      <Icon className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {dismissed ? "Dismissed" : item.answer === undefined ? "Answered" : `Answered: ${item.answer}`}
      </span>
    </p>
  );
}
