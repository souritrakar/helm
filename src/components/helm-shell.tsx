"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  CircleX,
  Command,
  LoaderCircle,
  SquareTerminal,
  X,
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
import { TerminalPane } from "@/components/terminal-pane";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { useInboxNotifications } from "@/components/inbox-notifications";
import { itemsForTab, type InboxTab } from "@/lib/inbox-view";
import type { InboxItem } from "@/lib/types";

const splitGroupId = "helm-main-split";

const TABS: readonly { readonly value: InboxTab; readonly label: string; readonly shortcut: string }[] = [
  { value: "open", label: "Open", shortcut: "1" },
  { value: "answered", label: "Answered", shortcut: "2" },
  { value: "dismissed", label: "Dismissed", shortcut: "3" },
];

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
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 sm:px-5 sm:py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground font-mono text-xs font-semibold text-background">h</div>
          <h1 className="truncate text-base font-semibold sm:text-lg">helm</h1>
          {unreadBlocking > 0 && (
            <span
              aria-label={`${unreadBlocking} unread blocking inbox ${unreadBlocking === 1 ? "item" : "items"}`}
              className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-white"
            >
              {unreadBlocking}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant={terminalCollapsed ? "outline" : "default"}
            size="sm"
            onClick={() => setTerminalCollapsed(!terminalCollapsed)}
            aria-pressed={!terminalCollapsed}
            aria-label={terminalCollapsed ? "Show the terminal" : "Hide the terminal"}
          >
            <SquareTerminal className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Terminal</span>
          </Button>
          {permission === "default" && (
            <Button variant="outline" size="sm" onClick={() => void requestPermission()} aria-label="Enable desktop notifications">
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
            <kbd className="font-mono text-xs">?</kbd>
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
  const byTab = useMemo(
    () => ({
      open: itemsForTab(items, "open"),
      answered: itemsForTab(items, "answered"),
      dismissed: itemsForTab(items, "dismissed"),
    }),
    [items],
  );
  const visibleItems = byTab[tab];

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {/* Wraps to two rows on a phone rather than hiding tabs behind a scroll. */}
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b px-2 py-2 sm:px-3">
        <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5" role="group" aria-label="Panel">
          <Button
            variant={view === "inbox" ? "default" : "ghost"}
            size="sm"
            aria-pressed={view === "inbox"}
            onClick={() => setView("inbox")}
          >
            Inbox
          </Button>
          <Button
            variant={view === "fleet" ? "default" : "ghost"}
            size="sm"
            aria-pressed={view === "fleet"}
            onClick={() => setView("fleet")}
          >
            Fleet
          </Button>
        </div>
        {view === "inbox" && (
          <div className="flex min-w-0 flex-wrap gap-0.5" aria-label="Inbox state" role="group">
            {TABS.map((entry) => (
              <Button
                key={entry.value}
                variant="ghost"
                size="sm"
                aria-pressed={tab === entry.value}
                onClick={() => setTab(entry.value)}
                className={`shrink-0 ${tab === entry.value ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
              >
                {entry.label}
                {status === "ready" && (
                  <span className="ml-1 font-mono text-xs tabular-nums opacity-70">{byTab[entry.value].length}</span>
                )}
              </Button>
            ))}
          </div>
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
              (visibleItems.length > 0 ? (
                <ul role="list" className="divide-y">
                  {visibleItems.map((item) => (
                    <li key={item.id} className="px-3 py-3.5 sm:px-4">
                      <InboxCard item={item} />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState tab={tab} />
              ))}
          </>
        )}
      </div>
    </section>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      <p className="text-sm/6 text-muted-foreground">Connecting to the fleet.</p>
    </div>
  );
}

const EMPTY_COPY: Record<InboxTab, string> = {
  open: "Nothing needs you right now.",
  answered: "Answers you give will collect here.",
  dismissed: "Cards you dismiss will collect here.",
};

function EmptyState({ tab }: { tab: InboxTab }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-6 text-center">
      <Check className="size-5 text-emerald-600 dark:text-emerald-400" />
      <p className="max-w-[34ch] text-pretty text-sm/6 text-muted-foreground">{EMPTY_COPY[tab]}</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry(): void }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
      <CircleX className="size-5 text-destructive" />
      <h3 className="text-sm font-semibold">Not receiving fleet updates</h3>
      <p className="max-w-[34ch] text-pretty text-sm/6 text-muted-foreground">{message ?? "The live inbox could not be loaded."}</p>
      <Button variant="outline" size="lg" onClick={onRetry}>Retry</Button>
    </div>
  );
}

function ShortcutDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-popover p-5 shadow-lg dark:shadow-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-lg font-semibold">Keyboard shortcuts</Dialog.Title>
              <Dialog.Description className="mt-1 text-pretty text-sm/6 text-muted-foreground">Use shortcuts outside a response field.</Dialog.Description>
            </div>
            <Dialog.Close render={<Button variant="ghost" size="icon-sm" className="relative" aria-label="Close shortcuts" />}>
              <X className="size-4 shrink-0" />
              <span className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-x-1/2 -translate-y-1/2 pointer-fine:hidden" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <dl className="mt-5 divide-y">
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
      <dt className="text-sm">{label}</dt>
      <dd><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{keys}</kbd></dd>
    </div>
  );
}
