"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  CircleX,
  Command,
  Inbox,
  LoaderCircle,
  X,
} from "lucide-react";
import type { Layout } from "react-resizable-panels";

import { InboxCard } from "@/components/inbox-card";
import { useInboxItems, type InboxStreamStatus } from "@/components/inbox-stream";
import { saveSplitLayout, splitDefaultLayout } from "@/components/split-layout";
import { TerminalPane } from "@/components/terminal-pane";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { useInboxNotifications } from "@/components/inbox-notifications";
import type { InboxItem } from "@/lib/types";

type Filter = "blocking" | "all" | "answered";

const splitGroupId = "helm-main-split";

function filterItems(items: readonly InboxItem[], filter: Filter): InboxItem[] {
  if (filter === "blocking") return items.filter((item) => item.state === "open" && item.urgency === "blocking");
  if (filter === "answered") return items.filter((item) => item.state === "answered");
  return [...items];
}

export function HelmShell({ defaultLayout }: { defaultLayout?: Layout }) {
  const [filter, setFilter] = useState<Filter>("blocking");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const { unreadBlocking, permission, requestPermission } = useInboxNotifications();
  const inbox = useInboxItems();

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
      if (event.key === "1") setFilter("blocking");
      if (event.key === "2") setFilter("all");
      if (event.key === "3") setFilter("answered");
      if (event.key === "?") setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutsOpen]);

  return (
    <main className="isolate flex min-h-dvh flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground font-mono text-sm font-semibold text-background">h</div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">helm</h1>
            <p className="hidden text-sm/5 text-muted-foreground sm:block">Fleet terminal and captain inbox.</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {unreadBlocking > 0 && <span aria-label={`${unreadBlocking} unread blocking inbox ${unreadBlocking === 1 ? "item" : "items"}`} className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-white">{unreadBlocking}</span>}
          {permission === "default" && <Button variant="outline" size="sm" onClick={() => void requestPermission()} aria-label="Enable desktop notifications">Enable alerts</Button>}
          {permission === "denied" && <span className="hidden text-xs text-muted-foreground md:inline">Desktop alerts blocked</span>}
          <Button variant="outline" onClick={() => setShortcutsOpen(true)} className="shrink-0 text-muted-foreground" aria-label="Show keyboard shortcuts">
            <Command className="size-4 shrink-0" />
            <span className="hidden sm:inline">Shortcuts</span>
            <kbd className="font-mono text-xs">?</kbd>
          </Button>
        </div>
      </header>

      <ResizablePanelGroup
        id={splitGroupId}
        orientation={compact ? "vertical" : "horizontal"}
        defaultLayout={defaultLayout ?? splitDefaultLayout}
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction) saveSplitLayout(layout);
        }}
        className="min-h-0 flex-1"
      >
        <ResizablePanel id="terminal" minSize="20%">
          <TerminalPane />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="inbox" minSize="24%">
          <InboxList
            filter={filter}
            setFilter={setFilter}
            items={inbox.items}
            status={inbox.status}
            error={inbox.error}
            onRetry={inbox.retry}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <ShortcutDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <Toaster position="bottom-right" richColors closeButton />
    </main>
  );
}

function InboxList({
  filter,
  setFilter,
  items,
  status,
  error,
  onRetry,
}: {
  filter: Filter;
  setFilter(filter: Filter): void;
  items: readonly InboxItem[];
  status: InboxStreamStatus;
  error: string | null;
  onRetry(): void;
}) {
  const visibleItems = filterItems(items, filter);
  const labels: Array<{ value: Filter; label: string; shortcut: string }> = [
    { value: "blocking", label: "Blocking", shortcut: "1" },
    { value: "all", label: "All", shortcut: "2" },
    { value: "answered", label: "Answered", shortcut: "3" },
  ];

  return (
    <section className="flex h-full min-w-0 flex-col bg-background">
      <div className="border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Inbox className="size-4 shrink-0" />
              <h2 className="text-lg font-semibold">Inbox</h2>
            </div>
            <p className="mt-1 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">Live firstmate inbox.</p>
          </div>
          <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">{status === "ready" ? visibleItems.length : "\u2014"}</span>
        </div>
        <div className="mt-3 flex min-w-0 gap-1 overflow-x-auto" aria-label="Inbox filters" role="group">
          {labels.map((item) => (
            <Button key={item.value} variant={filter === item.value ? "default" : "ghost"} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)} className="shrink-0">
              {item.label} <kbd className="ml-1 font-mono text-xs opacity-70">{item.shortcut}</kbd>
            </Button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === "loading" && <LoadingState />}
        {status === "error" && <ErrorState message={error} onRetry={onRetry} />}
        {status === "ready" && (visibleItems.length > 0 ? <ul role="list" className="divide-y">{visibleItems.map((item) => <li key={item.id} className="p-4"><InboxCard item={item} /></li>)}</ul> : <EmptyState />)}
      </div>
    </section>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      <p className="text-base/7 text-muted-foreground sm:text-sm/6">Loading inbox.</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
      <Check className="size-5 text-emerald-600 dark:text-emerald-400" />
      <h3 className="text-base font-semibold sm:text-sm">Nothing needs attention</h3>
      <p className="max-w-[34ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">This filter has no matching inbox cards.</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry(): void }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
      <CircleX className="size-5 text-destructive" />
      <h3 className="text-base font-semibold sm:text-sm">Inbox stream unavailable</h3>
      <p className="max-w-[34ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">{message ?? "The live inbox could not be loaded."}</p>
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
              <Dialog.Description className="mt-1 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">Use shortcuts outside a response field.</Dialog.Description>
            </div>
            <Dialog.Close render={<Button variant="ghost" size="icon-sm" className="relative" aria-label="Close shortcuts" />}>
              <X className="size-4 shrink-0" />
              <span className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-x-1/2 -translate-y-1/2 pointer-fine:hidden" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <dl className="mt-5 divide-y">
            <ShortcutRow keys="1" label="Show blocking" />
            <ShortcutRow keys="2" label="Show all" />
            <ShortcutRow keys="3" label="Show answered" />
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
      <dt className="text-base sm:text-sm">{label}</dt>
      <dd><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{keys}</kbd></dd>
    </div>
  );
}
