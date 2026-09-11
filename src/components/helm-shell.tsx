"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  Archive,
  Bell,
  Check,
  CheckCheck,
  CircleX,
  Command,
  Inbox,
  Ship,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Layout } from "react-resizable-panels";

import { FleetPanel } from "@/components/fleet-panel";
import { InboxCard } from "@/components/inbox-card";
import { useInboxItems, type InboxStreamStatus } from "@/components/inbox-stream";
import {
  saveSplitLayout,
  saveTerminalCollapsed,
  splitDefaultLayout,
} from "@/components/split-layout";
import { onTerminalReveal } from "@/components/terminal-composer";
import { TerminalPane } from "@/components/terminal-pane";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { useInboxNotifications } from "@/components/inbox-notifications";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { itemsForTab, sectionsForTab, type InboxTab } from "@/lib/inbox-view";
import type { InboxItem, InboxUrgency } from "@/lib/types";

const splitGroupId = "helm-main-split";

interface TabSpec {
  readonly value: InboxTab;
  readonly label: string;
  readonly shortcut: string;
  readonly Icon: LucideIcon;
}

/**
 * Live work first, history last.
 *
 * `open` sits alone at the left of the header; the two history tabs are pushed
 * to the far right, so what still needs the human never shares an edge with
 * what is already done (captain's request).
 */
const OPEN_TAB: TabSpec = { value: "open", label: "Open", shortcut: "1", Icon: Inbox };
const HISTORY_TABS: readonly TabSpec[] = [
  { value: "answered", label: "Answered", shortcut: "2", Icon: CheckCheck },
  { value: "dismissed", label: "Dismissed", shortcut: "3", Icon: Archive },
];
const TABS: readonly TabSpec[] = [OPEN_TAB, ...HISTORY_TABS];

/**
 * The tabs are a real tablist, so the ids that wire tab to panel live here.
 *
 * One panel element carries all three tabs: only the selected tab's content is
 * ever mounted, so a per-tab panel id would dangle on the two tabs whose panel
 * does not exist.
 */
const INBOX_PANEL_ID = "helm-inbox-panel";
const tabId = (tab: InboxTab): string => `helm-inbox-tab-${tab}`;

/** The left panel shows one of these at a time, so a phone keeps one column. */
type LeftView = "inbox" | "fleet";

export function HelmShell({
  defaultLayout,
  defaultTerminalCollapsed,
}: {
  defaultLayout?: Layout;
  defaultTerminalCollapsed?: boolean;
}) {
  const [tab, setTab] = useState<InboxTab>("open");
  const [view, setView] = useState<LeftView>("inbox");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [chosenCollapsed, setChosenCollapsed] = useState<boolean | undefined>(defaultTerminalCollapsed);
  const { unreadBlocking, permission, requestPermission } = useInboxNotifications();
  const inbox = useInboxItems();

  // On a phone the inbox is the whole point, so the terminal starts folded away
  // until the operator asks for it — but never against an explicit choice.
  const terminalCollapsed = chosenCollapsed ?? compact;

  const setTerminalCollapsed = (collapsed: boolean): void => {
    setChosenCollapsed(collapsed);
    saveTerminalCollapsed(collapsed);
  };

  // "Add to terminal" on a card is useless if the terminal is folded away, so
  // the card's reveal signal un-folds it before the block reaches the composer.
  useEffect(
    () =>
      onTerminalReveal(() => {
        setChosenCollapsed(false);
        saveTerminalCollapsed(false);
      }),
    [],
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutsOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const match = TABS.find((entry) => entry.shortcut === event.key);
      if (match !== undefined) {
        setView("inbox");
        setTab(match.value);
      }
      if (event.key === "f") setView((current) => (current === "fleet" ? "inbox" : "fleet"));
      if (event.key === "t") setTerminalCollapsed(!terminalCollapsed);
      if (event.key === "?") setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutsOpen, terminalCollapsed]);

  const leftPanel = (
    <LeftPanel
      view={view}
      setView={setView}
      tab={tab}
      setTab={setTab}
      items={inbox.items}
      status={inbox.status}
      error={inbox.error}
      onRetry={inbox.retry}
    />
  );

  return (
    // h-dvh, not min-h-dvh: the terminal measures its own box to pick a row
    // count, so a content-driven height lets it grow without bound — it reached
    // 34000px and 2380 rows, which is what garbled the mirror.
    <main className="isolate flex h-dvh flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-card px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {/*
            The only brand mark in the cockpit, and the only place the accent
            appears as a fill outside a card's answer — a helm wheel reads as
            the product at 24px where a lettermark would not.
          */}
          <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary">
            <Ship className="size-4 shrink-0" />
          </span>
          <h1 className="truncate text-body font-semibold">helm</h1>
          {unreadBlocking > 0 && (
            <Badge
              aria-label={`${unreadBlocking} unread blocking inbox ${unreadBlocking === 1 ? "item" : "items"}`}
              className="bg-urgency-blocking font-mono tabular-nums text-urgency-blocking-foreground"
            >
              {unreadBlocking}
            </Badge>
          )}
        </div>
        {/*
          Chrome stays quiet. Every control here is a toggle worth almost nothing
          next to a card's answer button, so none of them may wear the filled
          `default` variant — the strongest mark on screen belongs to the
          content. An engaged toggle is marked with the accent as a TINT.
        */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="touch"
            onClick={() => setTerminalCollapsed(!terminalCollapsed)}
            aria-pressed={!terminalCollapsed}
            aria-label="Terminal"
            className={terminalCollapsed ? "text-muted-foreground" : "bg-primary-tint text-primary hover:bg-primary-tint-hover hover:text-primary"}
          >
            <SquareTerminal className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Terminal</span>
          </Button>
          {permission === "default" && (
            <Button variant="ghost" size="touch" onClick={() => void requestPermission()} className="text-muted-foreground" aria-label="Enable desktop notifications">
              <Bell className="size-4 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Enable alerts</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="touch"
            onClick={() => setShortcutsOpen(true)}
            className="hidden text-muted-foreground sm:inline-flex"
            aria-label="Show keyboard shortcuts"
          >
            <Command className="size-4 shrink-0" aria-hidden="true" />
            <kbd className="font-mono text-meta">?</kbd>
          </Button>
        </div>
      </header>

      {terminalCollapsed ? (
        <div className="min-h-0 flex-1">{leftPanel}</div>
      ) : (
        <ResizablePanelGroup
          id={splitGroupId}
          orientation={compact ? "vertical" : "horizontal"}
          defaultLayout={defaultLayout ?? splitDefaultLayout}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) saveSplitLayout(layout);
          }}
          className="min-h-0 flex-1"
        >
          <ResizablePanel id="inbox" minSize={compact ? "45%" : "30%"}>
            {leftPanel}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="terminal" minSize="20%">
            <TerminalPane />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      <ShortcutDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {/*
        No `richColors`: it paints the toast with Sonner's own green and red,
        which are not helm's status hues — two different greens for "it worked"
        on one screen. The surface stays `popover` and the semantic signal is
        carried by the coloured icon in `ui/sonner.tsx`.
      */}
      <Toaster position={compact ? "top-center" : "bottom-right"} closeButton />
    </main>
  );
}

function LeftPanel({
  view,
  setView,
  tab,
  setTab,
  items,
  status,
  error,
  onRetry,
}: {
  view: LeftView;
  setView(view: LeftView): void;
  tab: InboxTab;
  setTab(tab: InboxTab): void;
  items: readonly InboxItem[];
  status: InboxStreamStatus;
  error: string | null;
  onRetry(): void;
}) {
  const counts = useMemo(
    () => ({
      open: itemsForTab(items, "open").length,
      answered: itemsForTab(items, "answered").length,
      dismissed: itemsForTab(items, "dismissed").length,
    }),
    [items],
  );
  const sections = useMemo(() => sectionsForTab(items, tab), [items, tab]);

  /**
   * Arrow, Home and End move between tabs, which is what a tablist owes a
   * keyboard. Selection follows focus: each panel is one already-loaded list,
   * so there is nothing to make the human confirm with a second key.
   */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const next =
      step !== 0
        ? TABS[(TABS.findIndex((entry) => entry.value === tab) + step + TABS.length) % TABS.length]
        : event.key === "Home"
          ? TABS[0]
          : event.key === "End"
            ? TABS[TABS.length - 1]
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setTab(next.value);
    document.getElementById(tabId(next.value))?.focus();
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b bg-card px-3 py-2 sm:px-4">
        <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5" role="group" aria-label="Panel">
          <ViewButton label="Inbox" active={view === "inbox"} onSelect={() => setView("inbox")} />
          <ViewButton label="Fleet" active={view === "fleet"} onSelect={() => setView("fleet")} />
        </div>
        {view === "inbox" && (
          /*
            One flat tablist, not a tab plus a labelled history group: a `tab`
            must be owned by its `tablist`, so the visual split between live work
            and history is carried by the flexible spacer alone.
          */
          <div
            role="tablist"
            aria-label="Inbox state"
            aria-orientation="horizontal"
            onKeyDown={onTabKeyDown}
            className="flex min-w-0 flex-1 items-center gap-0.5"
          >
            <TabButton
              tab={OPEN_TAB}
              active={tab === "open"}
              count={status === "ready" ? counts.open : null}
              narrowCompact
              onSelect={() => setTab("open")}
            />
            {/* Pushes history to the far edge, away from the live work. */}
            <div aria-hidden="true" className="min-w-0 flex-1" />
            {HISTORY_TABS.map((entry) => (
              <TabButton
                key={entry.value}
                tab={entry}
                active={tab === entry.value}
                count={status === "ready" ? counts[entry.value] : null}
                compact
                onSelect={() => setTab(entry.value)}
              />
            ))}
          </div>
        )}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        {...(view === "inbox"
          ? { role: "tabpanel", id: INBOX_PANEL_ID, "aria-labelledby": tabId(tab) }
          : {})}
      >
        {view === "fleet" ? (
          <FleetPanel />
        ) : (
          <>
            {status === "loading" && <LoadingState />}
            {status === "error" && <ErrorState message={error} onRetry={onRetry} />}
            {status === "ready" &&
              (sections.length > 0 ? (
                /*
                 * `key={tab}` remounts the run on a tab switch, which is what
                 * lets the cards replay their enter animation — the switch reads
                 * as new content arriving rather than as a silent swap.
                 */
                <div key={tab} className="pb-6">
                  {sections.map((section, index) => (
                    /*
                     * A band boundary has to outweigh the gap between two
                     * siblings inside it, or the header does not read as
                     * labelling the run below it. 28px between bands against
                     * 12px between cards; the first band needs no lead-in.
                     */
                    <section
                      key={section.key}
                      aria-label={section.label ?? undefined}
                      className={index > 0 ? "mt-7" : ""}
                    >
                      {section.label !== null && (
                        <SectionHeader
                          label={section.label}
                          urgency={section.urgency}
                          count={section.items.length}
                        />
                      )}
                      {/*
                        Cards are separated by space, not by rules: each is its
                        own request wanting its own answer, and a divided stack
                        reads as one long document.
                      */}
                      <ul role="list" className="flex flex-col gap-3 px-3 sm:px-4">
                        {section.items.map((item) => (
                          <li key={item.id} className="min-w-0">
                            <InboxCard item={item} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <EmptyState tab={tab} />
              ))}
          </>
        )}
      </div>
    </section>
  );
}

/** The dot hue for a band, from the urgency the band IS. */
const SECTION_DOT: Record<InboxUrgency, string> = {
  blocking: "bg-urgency-blocking",
  attention: "bg-urgency-attention",
  fyi: "bg-urgency-quiet",
};

/**
 * The header over a run of cards.
 *
 * It is a real header rather than a tracked-caps eyebrow: this is the line that
 * turns an undifferentiated scroll into "three things are blocking, the rest
 * can wait", and it stays legible while it is stuck to the top of the scroll.
 */
function SectionHeader({
  label,
  urgency,
  count,
}: {
  label: string;
  urgency: InboxUrgency | null;
  count: number;
}) {
  return (
    <h2 className="sticky top-0 z-10 flex items-center gap-2 bg-background/95 px-3 pb-1.5 pt-4 backdrop-blur-sm sm:px-4">
      {urgency !== null && (
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${SECTION_DOT[urgency]}`} />
      )}
      <span className="text-ui font-semibold">{label}</span>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-meta font-semibold tabular-nums text-muted-foreground">
        {count}
      </span>
    </h2>
  );
}

function ViewButton({ label, active, onSelect }: { label: string; active: boolean; onSelect(): void }) {
  return (
    <Button
      variant="ghost"
      size="touch"
      aria-pressed={active}
      onClick={onSelect}
      // The segmented-control idiom: the active face lifts out of the track.
      // `bg-accent` alone is a 3% luminance step and unreadable on a phone.
      className={
        active
          ? "bg-card font-medium text-foreground shadow-card hover:bg-hover-overlay"
          : "text-muted-foreground"
      }
    >
      {label}
    </Button>
  );
}

/**
 * One state tab.
 *
 * A real `tab`, not a pressed toggle: the three of them select between views of
 * one list, which is what a screen reader needs told so it can announce "tab 2
 * of 3" and offer the panel. Roving tabindex keeps the group to a single Tab
 * stop; the arrow keys that move inside it live on the tablist.
 *
 * `compact` hides the word and keeps the icon plus the count, which is what
 * lets the two history tabs sit at the right edge of a phone-width header
 * without crowding the Open tab.
 */
function TabButton({
  tab,
  active,
  count,
  compact = false,
  narrowCompact = false,
  onSelect,
}: {
  tab: TabSpec;
  active: boolean;
  count: number | null;
  compact?: boolean;
  narrowCompact?: boolean;
  onSelect(): void;
}) {
  return (
    <Button
      variant="ghost"
      size="touch"
      role="tab"
      id={tabId(tab.value)}
      aria-selected={active}
      aria-controls={INBOX_PANEL_ID}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      // The selected tab is marked with the accent as a tint, never a fill:
      // chrome does not get to be the loudest thing on a screen whose whole
      // purpose is the answer button on a card.
      // A compact tab trims its side padding rather than its height: at 390px
      // the three tabs plus the panel switch overflowed the row by 7px, and the
      // 44px tap target is the one dimension that must not pay for it.
      className={`shrink-0 ${compact || narrowCompact ? "px-2.5" : ""} ${
        active
          ? "bg-primary-tint font-medium text-primary hover:bg-primary-tint-hover hover:text-primary"
          : "text-muted-foreground"
      }`}
    >
      <tab.Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className={compact ? "sr-only sm:not-sr-only" : narrowCompact ? "sr-only min-[400px]:not-sr-only" : ""}>{tab.label}</span>
      {count !== null && (
        <span
          className={`font-mono tabular-nums ${
            tab.value === "open" && count > 0 && !active ? "font-semibold text-foreground" : ""
          }`}
        >
          {count}
        </span>
      )}
    </Button>
  );
}

/**
 * Loading looks like the thing that is coming.
 *
 * Card-shaped placeholders rather than a centred spinner: the list keeps its
 * geometry, so when the real cards land nothing jumps, and the operator already
 * knows what kind of surface is arriving.
 */
function LoadingState() {
  return (
    <div className="flex flex-col gap-3 px-3 pt-4 sm:px-4" role="status" aria-busy="true">
      <span className="sr-only">Connecting to the fleet.</span>
      {[0, 1, 2].map((row) => (
        // The placeholder mirrors InboxCard exactly — identity row, then
        // full-width text, then the footer band. A left-gutter skeleton with no
        // footer was half the height of the real card, so the list still jumped
        // on arrival, which is the one thing a skeleton exists to prevent.
        <div key={row} className="overflow-hidden rounded-xl border bg-card shadow-card">
          <div className="p-3 sm:p-4">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <Skeleton className="h-3.5 w-28" />
            </div>
            <Skeleton className="mt-3.5 h-4 w-full max-w-80" />
            <Skeleton className="mt-2 h-4 w-1/2" />
          </div>
          <div className="flex gap-2 border-t bg-muted px-3 py-3 sm:px-4">
            <Skeleton className="h-9 w-28 rounded-lg" />
            <Skeleton className="h-9 w-28 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The empty state per tab, including its glyph and tone.
 *
 * The tone belongs here because only ONE of these is good news. "All clear" is
 * the outcome the whole cockpit exists for and earns the green check; an empty
 * archive is a neutral fact, and dressing it in the success token told the
 * operator something untrue.
 */
const EMPTY_COPY: Record<
  InboxTab,
  { readonly headline: string; readonly detail: string; readonly Icon: LucideIcon; readonly tone: string }
> = {
  open: {
    headline: "All clear",
    detail: "Nothing in the fleet needs you right now.",
    Icon: Check,
    tone: "bg-success-tint text-success",
  },
  answered: {
    headline: "No answers yet",
    detail: "Answers you give will collect here.",
    Icon: CheckCheck,
    tone: "bg-muted text-muted-foreground",
  },
  dismissed: {
    headline: "Nothing dismissed",
    detail: "Cards you dismiss will collect here.",
    Icon: Archive,
    tone: "bg-muted text-muted-foreground",
  },
};

/**
 * The one moment this surface gets a voice.
 *
 * An empty inbox is the outcome the whole cockpit is for, so it is the single
 * place the display step is spent — everywhere else the content outranks the
 * chrome and a large headline would be decoration.
 */
function EmptyState({ tab }: { tab: InboxTab }) {
  const copy = EMPTY_COPY[tab];
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-4 p-8 text-center">
      <span aria-hidden="true" className={`flex size-12 items-center justify-center rounded-2xl ${copy.tone}`}>
        <copy.Icon className="size-6" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-display font-semibold tracking-tight">{copy.headline}</h2>
        <p className="max-w-[42ch] text-pretty text-body text-muted-foreground">{copy.detail}</p>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry(): void }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-4 p-8 text-center">
      <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-2xl bg-destructive-tint text-destructive">
        <CircleX className="size-6" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-display font-semibold tracking-tight">Not receiving fleet updates</h2>
        {/*
          The heading names the stream and the body names the next thing to
          check. "The live inbox could not be loaded" said neither: it was
          passive, it disagreed with the heading about what had failed, and it
          left the operator with nothing to do.
        */}
        <p className="max-w-[48ch] text-pretty text-body text-muted-foreground">{message ?? "helm lost the inbox stream. Check that firstmate is running."}</p>
      </div>
      <Button variant="default" size="touch" onClick={onRetry}>Retry</Button>
    </div>
  );
}

function ShortcutDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/*
          Scrim and popup animate from closed, so the dialog reads as having
          come from the press rather than as having always been there. The
          `data-*` states come from the Dialog primitive; the global
          reduced-motion rule neutralises both.
        */}
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim backdrop-blur-sm transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-popover p-6 shadow-raised transition-[opacity,transform] duration-200 ease-[var(--ease-out-quint)] data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-title font-semibold tracking-tight">Keyboard shortcuts</Dialog.Title>
              <Dialog.Description className="mt-1 text-pretty text-body text-muted-foreground">Use shortcuts outside a response field.</Dialog.Description>
            </div>
            {/* `icon-touch` is already 44px on a phone, so no tap halo is needed. */}
            <Dialog.Close render={<Button variant="ghost" size="icon-touch" aria-label="Close shortcuts" />}>
              <X className="size-4 shrink-0" />
            </Dialog.Close>
          </div>
          <dl className="mt-6 divide-y">
            <ShortcutRow keys="1" label="Open" />
            <ShortcutRow keys="2" label="Answered" />
            <ShortcutRow keys="3" label="Dismissed" />
            <ShortcutRow keys="f" label="Toggle fleet view" />
            <ShortcutRow keys="t" label="Toggle terminal" />
            <ShortcutRow keys="?" label="Open shortcuts" />
            <ShortcutRow keys="Esc" label="Close shortcuts" />
          </dl>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ShortcutRow({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="text-ui">{label}</dt>
      <dd><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-meta text-muted-foreground">{keys}</kbd></dd>
    </div>
  );
}
