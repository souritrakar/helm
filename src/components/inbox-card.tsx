"use client";

import { useState } from "react";
import {
  Anchor,
  Check,
  ChevronDown,
  ChevronsUp,
  CircleDot,
  CircleSlash,
  Eye,
  GitMerge,
  KeyRound,
  MessageCircleQuestion,
  LoaderCircle,
  MessageSquarePlus,
  OctagonAlert,
  Plus,
  Reply,
  ShieldAlert,
  Signpost,
  StickyNote,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { addToTerminalContext } from "@/components/terminal-composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dismissInboxItem, submitInboxResponse } from "@/lib/inbox-client";
import { inboxItemContext } from "@/lib/inbox-context";
import { KIND_LABELS, controlFor } from "@/lib/inbox-view";
import type { InboxItem, InboxItemKind, InboxUrgency } from "@/lib/types";

/**
 * One glyph per kind, so a card announces WHAT IT IS before a word is read.
 *
 * Keyed by {@link InboxItemKind} rather than by bucket: the bucket groups five
 * kinds under "Approval", and a merge, a credential and a captain hold want
 * three different answers. Typed as a total record so adding a kind is a
 * compile error here rather than a silently generic card.
 *
 * It lives beside the card instead of in `inbox-view.ts` only because these are
 * React components, and that module stays pure so the server and the composer's
 * context block can share it.
 */
const KIND_ICONS: Record<InboxItemKind, LucideIcon> = {
  "status-decision": Signpost,
  decision: Signpost,
  ask: MessageCircleQuestion,
  merge: GitMerge,
  credential: KeyRound,
  // Held at anchor by the captain — the one place the subject's own vocabulary
  // says the state better than an abstract glyph would.
  "captain-held": Anchor,
  destructive: Trash2,
  irreversible: TriangleAlert,
  "security-sensitive": ShieldAlert,
  answer: Reply,
  blocker: OctagonAlert,
  escalation: ChevronsUp,
  review: Eye,
  note: StickyNote,
  custom: CircleDot,
};

/**
 * Urgency on two channels, folded into ONE mark.
 *
 * Hue alone fails for the ~8% of men with a red/green deficiency, so the glyph
 * carries the kind and the tint carries the urgency — two readings of one chip,
 * rather than a floating dot competing with a caps string for the same corner.
 * The band header above the run still says the word, and `sr-only` text below
 * says it again for a screen reader.
 */
const URGENCY_CHIP: Record<InboxUrgency, string> = {
  blocking: "bg-urgency-blocking-tint text-urgency-blocking",
  attention: "bg-urgency-attention-tint text-urgency-attention",
  // `secondary`, not `muted`: open-versus-handled is load-bearing, and `muted`
  // is reserved for a handled chip — an fyi card wearing it would be
  // indistinguishable from an answered one.
  fyi: "bg-secondary text-urgency-quiet",
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
 * a max-height, so the full text stays selectable, findable and reachable.
 */
const CLAMP_CHARS = 240;
const CLAMP_LINES = 4;

/**
 * Collapsed body height: `CLAMP_LINES` at the 1.5rem leading baked into
 * `text-body`, so the fade mask lands exactly on a baseline.
 *
 * The disclosure is INSTANT by design. Expanding releases the height to `auto`,
 * which is not an interpolable length, so a `transition-[max-height]` here
 * animates in neither direction — it was dead CSS with a comment claiming
 * otherwise. Animating it properly would mean measuring `scrollHeight` on every
 * expand, which is a lot of machinery for a control the operator taps to read
 * text faster.
 */
const CLAMP_HEIGHT = `${CLAMP_LINES * 1.5}rem`;

/**
 * The collapsed body fades out rather than ending on a hard edge, which is what
 * says "there is more" before the human reads the word "more".
 */
const CLAMP_FADE = "linear-gradient(to bottom, #000 60%, transparent)";

/** Which control is mid-flight, so only THAT one reports the work. */
type Pending = { readonly kind: "option"; readonly value: string } | { readonly kind: "text" } | null;

export function InboxCard({ item }: { item: InboxItem }) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const busy = pending !== null;

  const control = controlFor(item);
  const open = item.state === "open";
  const detail = item.detail?.trim() ?? "";
  const long = detail.length > CLAMP_CHARS || detail.split("\n").length > CLAMP_LINES;
  const clamped = long && !expanded;
  const Icon = KIND_ICONS[item.kind];
  const hasRef = item.ref !== undefined && item.ref !== "";
  const footer = open || hasRef;

  /**
   * Run one request and report it on the control that started it.
   *
   * `which` is what makes the report specific. Answering relays a real line
   * into a real terminal, so the round-trip can take a moment — and dimming the
   * whole option group by 50% said only "something is disabled", not "your
   * Approve is on its way", which is what makes an operator press again.
   */
  const act = async (
    which: NonNullable<Pending>,
    run: () => Promise<{ ok: boolean; error?: string }>,
    failure: string,
    success: string,
  ): Promise<void> => {
    if (busy) return;
    setPending(which);
    setError(null);
    const result = await run();
    if (!result.ok) {
      const message = result.error ?? failure;
      setError(message);
      toast.error(failure, { description: message });
      setPending(null);
      return;
    }
    toast.success(success);
    setDraft("");
    setPending(null);
  };

  const answer = (action: { value: string } | { text: string }): void => {
    void act(
      "value" in action ? { kind: "option", value: action.value } : { kind: "text" },
      () => submitInboxResponse(item.id, action),
      "Could not deliver the answer",
      "Answer delivered",
    );
  };
  const dismiss = (): void => {
    void act(
      { kind: "text" },
      () => dismissInboxItem(item.id),
      "Could not dismiss this card",
      "Dismissed",
    );
  };

  return (
    /*
     * A card is a raised object on a tinted page, not a row in a ruled table:
     * each one is a separate request that wants a separate answer, and a
     * divided stack reads as one long document instead of a queue.
     *
     * It animates in because cards arrive on their own over SSE — without the
     * rise, a new blocking request simply teleports into a list the human is
     * already reading. `motion-reduce` drops it; the global reduced-motion rule
     * is the backstop.
     */
    <article
      className="@container group/card relative min-w-0 animate-card-in overflow-hidden rounded-xl border bg-card shadow-card transition-shadow duration-200 focus-within:shadow-raised hover:shadow-raised motion-reduce:animate-none"
      data-inbox-item-id={item.id}
      aria-busy={busy}
    >
      {/*
        The one measure for the card's text column, in `rem` so both steps
        inherit it. Expressed per element as `ch` it inverted: 56ch at 17px is
        WIDER than 68ch at 14px, so the title and the body had two different
        ragged right edges 19px apart.
      */}
      <div className="min-w-0 p-3 sm:p-4">
        {/*
          Identity on its own row, so the text below gets the card's FULL width.
          Seating the glyph in a left gutter instead cost 44px of measure on
          every line, which on a phone turned a five-line title into seven.

          The "add to terminal" utility is absolutely positioned rather than a
          flex item here, so it comes LAST in the DOM: as a sibling it took the
          first tab stop on every card in the queue, ahead of the answer.
        */}
        <div className="flex min-w-0 items-center gap-2.5 pr-9">
          <span
            aria-hidden="true"
            className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
              open ? URGENCY_CHIP[item.urgency] : "bg-muted text-muted-foreground"
            }`}
          >
            <Icon className="size-4 shrink-0" />
          </span>
          {/*
            Sentence case, not the uppercase eyebrow tic: a calm consumer
            surface names the request rather than shouting it in tracked caps.
            It shares 14px with the body below, so WEIGHT is what separates a
            label from prose — going lighter instead left the card's identity
            quieter than its supporting detail.
          */}
          <span className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground-secondary">
            {KIND_LABELS[item.kind]}
          </span>
        </div>
        <span className="sr-only">{URGENCY_LABEL[item.urgency]}. </span>

        <div className="min-w-0 max-w-[34rem]">
          {/*
            The title is never clipped. A title carrying a whole task note is
            the common case, and an ellipsis with no way to see the rest hides
            the one thing the human opened the inbox to read. The measure is
            capped by the wrapper instead, so a long note sets as a paragraph.
          */}
          <h3
            className={`mt-3.5 text-pretty break-words text-title font-semibold tracking-tight ${
              open ? "" : "text-foreground-secondary"
            }`}>
            {item.title}
          </h3>

          {detail !== "" && (
            <div className="mt-1.5">
              {/*
                An answer or an ask card is the one place the body IS the
                payload — it is the reply the human went looking for, or
                firstmate's actual question — so it reads at full contrast
                behind a rule rather than as supporting detail.
              */}
              <p
                style={
                  clamped
                    ? {
                        maxHeight: CLAMP_HEIGHT,
                        // The prefixed copy is for iOS below 16.4, where the
                        // unprefixed property is unsupported and the body would
                        // otherwise end on a hard, mid-sentence edge.
                        WebkitMaskImage: CLAMP_FADE,
                        maskImage: CLAMP_FADE,
                      }
                    : undefined
                }
                className={`overflow-hidden whitespace-pre-wrap text-pretty break-words text-body ${
                  item.kind === "answer" || item.kind === "ask"
                    ? "border-l-2 border-border pl-3 text-foreground"
                    : "text-foreground-secondary"
                }`}
              >
                {detail}
              </p>
              {long && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpanded(!expanded)}
                  // `pl-3` on a quoted body indents it, so the disclosure has to
                  // follow or it sits 12px outside the text it belongs to.
                  className={`mt-1 text-muted-foreground hover:text-foreground ${
                    item.kind === "answer" || item.kind === "ask" ? "ml-0.5" : "-ml-2.5"
                  }`}
                >
                  {expanded ? "Show less" : "Show more"}
                  <ChevronDown
                    className={`size-3.5 shrink-0 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </Button>
              )}
            </div>
          )}

          {!open && <Outcome item={item} />}
        </div>
      </div>

      {/*
        Everything the human can DO sits on one recessed band at the foot of the
        card. Always in the same place, always visually separate from the text:
        the eye learns one target, and the card's shape — buttons, a field, or
        nothing — tells you what it wants before you read it.
      */}
      {footer && (
        <div className="flex min-w-0 flex-col gap-2.5 border-t bg-muted px-3 py-3 sm:px-4">
          {error !== null && (
            <p
              className="flex items-start gap-1.5 rounded-lg bg-destructive-tint px-2.5 py-1.5 text-body font-medium text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}

          {/*
            The answer and the quiet row share ONE wrapping line, so a wide card
            does not carry two half-empty bands. A text field claims the whole
            line (`basis-full`) because a cramped composer is worse than a wrap.
          */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2.5">
            {open && (control === "options" || control === "both") && (
              // `basis-full` until the card is wide enough to share a line: on
              // a phone the options own the whole row and stretch to fill it,
              // which is also what makes them comfortable thumb targets.
              <div className="flex min-w-0 basis-full flex-wrap gap-2 @sm:basis-auto">
                {item.options.map((option) => {
                  const sending = pending?.kind === "option" && pending.value === option.value;
                  const recommended = option.value === item.recommendValue;
                  return (
                    <Button
                      key={option.value}
                      size="touch"
                      // With no recommendation every option is equal, so the
                      // GROUP is raised against the recessed band rather than
                      // one member of it — the card's primary path stays obvious
                      // without helm ranking answers it has no authority to
                      // rank. Only a recommendation firstmate actually sent
                      // fills a button.
                      variant={recommended ? "default" : "outline"}
                      disabled={busy}
                      title={option.hint}
                      onClick={() => answer({ value: option.value })}
                      // An option label is an answer firstmate wrote, so it
                      // wraps rather than truncating — a clipped option is one
                      // the human cannot read before choosing it.
                      //
                      // No `transition-transform`: it would override the base
                      // `transition-all`, leaving this one control with an
                      // un-eased hover at a duration nothing else uses.
                      className={`h-auto min-h-11 min-w-28 max-w-full flex-1 whitespace-normal px-4 py-2 font-semibold active:scale-[0.98] @sm:flex-none ${
                        recommended ? "" : "bg-card shadow-card"
                      }`}
                    >
                      {/*
                        Only the option that was pressed reports the work. The
                        siblings merely disable, so the card says "your Approve
                        is on its way" rather than "something is unavailable".
                      */}
                      {sending && (
                        <LoaderCircle
                          className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      )}
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            )}

            {open && (control === "text" || (control === "both" && replying)) && (
              // One row at every width. Stacked, the Send button stretches to the
              // full card and a DISABLED control becomes the heaviest mark on it.
              <div className="flex min-w-0 basis-full flex-row items-center gap-2">
                <Input
                  name={`response-${item.id}`}
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && draft.trim() !== "")
                      answer({ text: draft.trim() });
                  }}
                  autoFocus={control === "both"}
                  placeholder="Write a reply…"
                  aria-label={`Reply to ${item.title}`}
                  // text-base on a phone is deliberate: anything smaller makes
                  // iOS zoom the viewport on focus.
                  className="h-11 min-w-0 flex-1 bg-card sm:h-9 sm:text-ui"
                />
                <Button
                  size="touch"
                  // Promoted only once there is something to send. Filled at
                  // rest it would be a DISABLED control acting as the card's
                  // loudest mark, which is exactly backwards.
                  variant={draft.trim() === "" ? "outline" : "default"}
                  disabled={busy || draft.trim() === ""}
                  onClick={() => answer({ text: draft.trim() })}
                  // The lift is only for the outline state, where the button has
                  // to separate itself from the recessed band. Applying it
                  // unconditionally would override the promoted fill.
                  className={`shrink-0 font-semibold active:scale-[0.98] ${
                    draft.trim() === "" ? "bg-card shadow-card" : ""
                  }`}
                >
                  Send
                </Button>
              </div>
            )}

            {/*
              The quiet group: what the card is worth SAYING, then the two
              escapes collected at the far edge. Holding the escapes opposite
              the answer is what keeps a tap meant for an option off Dismiss,
              and it stops "Write a reply instead" from reading as a third
              option just because it sits next to the second.
            */}
            <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-2 gap-y-1.5 @sm:flex-1 @sm:basis-auto">
              {/*
                Only worth saying when the human might reasonably expect a
                control. An answer card is a report — there is nothing to reply
                to — so the notice would be noise there.
              */}
              {open && control === "none" && item.kind !== "answer" && (
                <Badge variant="outline" className="gap-1.5 bg-card text-muted-foreground">
                  <CircleSlash className="shrink-0" aria-hidden="true" />
                  No reply channel
                </Badge>
              )}
              {/* Provenance only — rendered as inert text, never a link helm resolves. */}
              {hasRef && (
                <span
                  className="min-w-0 truncate font-mono text-meta text-muted-foreground"
                  title={item.ref}
                >
                  {item.ref}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {/*
                  When the card declares options, those ARE the answer — one
                  tap. A typed reply is the exception, so it stays a restrained
                  control here instead of adding a text field to every approval
                  and halving how many fit on a phone.
                */}
                {open && control === "both" && !replying && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setReplying(true)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <MessageSquarePlus className="size-3.5 shrink-0" aria-hidden="true" />
                    Write a reply instead
                  </Button>
                )}
                {open && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={dismiss}
                    disabled={busy}
                    className="-mr-2.5 text-muted-foreground hover:bg-destructive-tint hover:text-destructive"
                  >
                    <X className="size-3.5 shrink-0" aria-hidden="true" />
                    Dismiss
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/*
        Last in the DOM, top-right on screen. Tab order follows the DOM, so as a
        sibling of the kind label this utility took the FIRST tab stop on every
        card in the queue — ahead of the answer the card exists to collect.
      */}
      <AddToTerminalButton item={item} />
    </article>
  );
}

/**
 * Attach this card to the message the human is writing in the terminal.
 *
 * Secondary by treatment — a ghost icon in the corner that only fills in on
 * hover or focus — but still a real 44px tap target, because on a phone this is
 * the bridge between the inbox and the conversation and hover has no meaning
 * there.
 *
 * The 44px comes from GROWING THE BOX on a coarse pointer, not from an overlaid
 * halo. A halo child cannot do this job: the idiom elsewhere in this codebase
 * carries `pointer-events-none`, so a tap on the part of it that overhangs the
 * button passes straight through to the card behind — it looked like a 44px
 * target and hit-tested as a 32px one. Growing the box works here only because
 * the button is absolutely positioned, so its size no longer drives the height
 * of the identity row it sits over.
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
      size="icon"
      aria-label={label}
      title="Add to terminal"
      onClick={() =>
        addToTerminalContext({
          label: item.title,
          text: inboxItemContext(item),
        })
      }
      className="absolute right-2 top-2 shrink-0 text-muted-foreground hover:bg-primary-tint hover:text-primary pointer-coarse:size-11"
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
    /*
     * The answer the human gave, quoted back on its own tinted line. A handled
     * card is scanned for one thing — "what did I decide" — so the decision is
     * the mark, not the word "Answered".
     */
    <p
      className={`mt-2.5 flex min-w-0 items-start gap-2 rounded-lg px-2.5 py-1.5 text-body ${
        dismissed ? "bg-muted text-muted-foreground" : "bg-success-tint text-success"
      }`}
    >
      <Icon className="mt-[0.3125rem] size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words font-medium">
        {dismissed
          ? "Dismissed"
          : item.answer === undefined
            ? "Answered"
            : `Answered: ${item.answer}`}
      </span>
    </p>
  );
}
