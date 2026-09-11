"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  Archive,
  Check,
  CheckCheck,
  CircleX,
  Command,
  Inbox,
  LoaderCircle,
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
import { itemsForTab, sectionsForTab, type InboxTab } from "@/lib/inbox-view";
import type { InboxItem } from "@/lib/types";

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
      {/*
        Chrome stays quiet. Every control here is a toggle worth almost nothing
        next to a card's answer button, so none of them may wear the filled
        `default` variant — the strongest mark on screen belongs to the content.
      */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-meta font-semibold text-muted-foreground">h</div>
          <h1 className="truncate text-ui font-semibold tracking-tight">helm</h1>
          {unreadBlocking > 0 && (
            <span
              aria-label={`${unreadBlocking} unread blocking inbox ${unreadBlocking === 1 ? "item" : "items"}`}
              className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-urgency-blocking px-2 py-0.5 font-mono text-meta font-semibold tabular-nums text-white"
            >
              {unreadBlocking}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTerminalCollapsed(!terminalCollapsed)}
            aria-pressed={!terminalCollapsed}
            aria-label={terminalCollapsed ? "Show the terminal" : "Hide the terminal"}
            className={terminalCollapsed ? "text-muted-foreground" : "bg-muted text-foreground"}
          >
            <SquareTerminal className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Terminal</span>
          </Button>
          {permission === "default" && (
            <Button variant="ghost" size="sm" onClick={() => void requestPermission()} className="text-muted-foreground" aria-label="Enable desktop notifications">
              <span className="hidden sm:inline">Enable alerts</span>
              <span className="sm:hidden">Alerts</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
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
          <ResizablePanel id="inbox" minSize="30%">
            {leftPanel}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="terminal" minSize="20%">
            <TerminalPane />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      <ShortcutDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <Toaster position="bottom-right" richColors closeButton />
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

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b px-3 py-2 sm:px-4">
        <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5" role="group" aria-label="Panel">
          <ViewButton label="Inbox" active={view === "inbox"} onSelect={() => setView("inbox")} />
          <ViewButton label="Fleet" active={view === "fleet"} onSelect={() => setView("fleet")} />
        </div>
        {view === "inbox" && (
          <>
            <TabButton
              tab={OPEN_TAB}
              active={tab === "open"}
              count={status === "ready" ? counts.open : null}
              onSelect={() => setTab("open")}
            />
            {/* Pushes history to the far edge, away from the live work. */}
            <div className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Inbox history">
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
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {view === "fleet" ? (
          <FleetPanel />
        ) : (
          <>
            {status === "loading" && <LoadingState />}
            {status === "error" && <ErrorState message={error} onRetry={onRetry} />}
            {status === "ready" &&
              (sections.length > 0 ? (
                sections.map((section) => (
                  <section key={section.key} aria-label={section.label ?? undefined}>
                    {section.label !== null && (
                      <h2 className="sticky top-0 z-10 flex items-baseline gap-2 border-b bg-background/95 px-3 py-1.5 text-meta font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur sm:px-4">
                        {section.label}
                        <span className="font-mono tabular-nums">{section.items.length}</span>
                      </h2>
                    )}
                    <ul role="list" className="divide-y">
                      {section.items.map((item) => (
                        <li key={item.id} className="px-3 py-4 sm:px-4">
                          <InboxCard item={item} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              ) : (
                <EmptyState tab={tab} />
              ))}
          </>
        )}
      </div>
    </section>
  );
}

function ViewButton({ label, active, onSelect }: { label: string; active: boolean; onSelect(): void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={active}
      onClick={onSelect}
      // The segmented-control idiom: the active face lifts out of the track.
      // `bg-accent` alone is a 3% luminance step and unreadable on a phone.
      className={active ? "bg-background font-semibold text-foreground shadow-sm" : "text-muted-foreground"}
    >
      {label}
    </Button>
  );
}

/**
 * One state tab.
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
  onSelect,
}: {
  tab: TabSpec;
  active: boolean;
  count: number | null;
  compact?: boolean;
  onSelect(): void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={active}
      onClick={onSelect}
      className={`shrink-0 ${active ? "bg-muted font-semibold text-foreground" : "text-muted-foreground"}`}
    >
      <tab.Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className={compact ? "sr-only sm:not-sr-only" : ""}>{tab.label}</span>
      {count !== null && (
        <span
          className={`font-mono tabular-nums ${
            tab.value === "open" && count > 0 ? "font-semibold text-foreground" : ""
          }`}
        >
          {count}
        </span>
      )}
    </Button>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      <p className="text-body text-muted-foreground">Connecting to the fleet.</p>
    </div>
  );
}

const EMPTY_COPY: Record<InboxTab, { readonly headline: string; readonly detail: string }> = {
  open: { headline: "All clear", detail: "Nothing in the fleet needs you right now." },
  answered: { headline: "No answers yet", detail: "Answers you give will collect here." },
  dismissed: { headline: "Nothing dismissed", detail: "Cards you dismiss will collect here." },
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
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
      <Check className="size-6 text-success" />
      <h2 className="text-display font-semibold tracking-tight">{copy.headline}</h2>
      <p className="max-w-[42ch] text-pretty text-body text-muted-foreground">{copy.detail}</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry(): void }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
      <CircleX className="size-6 text-destructive" />
      <h3 className="text-title font-semibold">Not receiving fleet updates</h3>
      <p className="max-w-[48ch] text-pretty text-body text-muted-foreground">{message ?? "The live inbox could not be loaded."}</p>
      <Button variant="default" size="touch" onClick={onRetry}>Retry</Button>
    </div>
  );
}

function ShortcutDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/25 dark:bg-background/70" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-popover p-6 shadow-lg dark:shadow-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-title font-semibold tracking-tight">Keyboard shortcuts</Dialog.Title>
              <Dialog.Description className="mt-1 text-pretty text-body text-muted-foreground">Use shortcuts outside a response field.</Dialog.Description>
            </div>
            <Dialog.Close render={<Button variant="ghost" size="icon-sm" className="relative" aria-label="Close shortcuts" />}>
              <X className="size-4 shrink-0" />
              <span className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-x-1/2 -translate-y-1/2 pointer-fine:hidden" aria-hidden="true" />
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
