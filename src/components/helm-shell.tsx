"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  CircleAlert,
  CircleDot,
  CircleX,
  Clock3,
  Command,
  Inbox,
  LoaderCircle,
  PanelLeft,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Layout } from "react-resizable-panels";

import { saveSplitLayout, splitDefaultLayout } from "@/components/split-layout";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { inboxItemId } from "@/lib/types";
import type { InboxItem, InboxItemKind, InboxItemState, InboxUrgency } from "@/lib/types";

type Filter = "blocking" | "all" | "answered";
type DisplayState = "ready" | "loading" | "empty" | "error";

const splitGroupId = "helm-main-split";

const fixtureItems: readonly InboxItem[] = [
  {
    id: inboxItemId("status-decisions", "storage-choice"),
    source: "status-decisions",
    kind: "decision",
    urgency: "blocking",
    taskId: "drive-metadata",
    repo: "agentdrive",
    title: "Choose the hierarchy authority",
    detail: "The implementation is held until the source of truth is confirmed.",
    options: [
      { value: "items", label: "Drive + Item", hint: "Recommended: one hierarchy authority." },
      { value: "folders", label: "Legacy folders", hint: "Keep the compatibility model." },
    ],
    allowFreeform: true,
    recommendValue: "items",
    respond: { channel: "resolve-key", target: "drive-metadata", key: "hierarchy-authority" },
    evidence: [{ path: "docs/architecture/implementation-status.md", line: 18 }],
    state: "open",
    openedAt: "2026-09-06T13:20:00.000Z",
  },
  {
    id: inboxItemId("bearings", "merge-helm-foundation"),
    source: "bearings",
    kind: "merge",
    urgency: "blocking",
    taskId: "helm-foundation",
    repo: "helm",
    title: "Foundation is ready to merge",
    detail: "Typecheck, tests, and the seam contract are green.",
    options: [
      { value: "merge", label: "Merge PR", hint: "Accept the reviewed foundation." },
      { value: "hold", label: "Keep held", hint: "Leave the review gate open." },
    ],
    allowFreeform: false,
    recommendValue: "merge",
    respond: { channel: "captain-hold", target: "helm-foundation", close: "release" },
    evidence: [{ path: "tests/fm-fold.test.ts" }],
    state: "open",
    openedAt: "2026-09-06T12:00:00.000Z",
  },
  {
    id: inboxItemId("credentials", "github-device-login"),
    source: "credentials",
    kind: "credential",
    urgency: "attention",
    repo: "fleet-control",
    title: "GitHub device login is needed",
    detail: "The release workflow is waiting for an operator-authenticated session.",
    options: [
      { value: "opened", label: "I completed login" },
      { value: "defer", label: "Defer release" },
    ],
    allowFreeform: true,
    respond: { channel: "none" },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T11:40:00.000Z",
  },
  {
    id: inboxItemId("status-decisions", "blocker-port"),
    source: "status-decisions",
    kind: "blocker",
    urgency: "blocking",
    taskId: "local-runtime",
    repo: "gallopify",
    title: "Local API port is already in use",
    detail: "The runtime cannot start until the existing listener is understood.",
    options: [{ value: "investigate", label: "Investigate listener" }],
    allowFreeform: true,
    respond: { channel: "resolve-key", target: "local-runtime", key: "api-port" },
    evidence: [{ path: "apps/backend" }],
    state: "open",
    openedAt: "2026-09-06T10:55:00.000Z",
  },
  {
    id: inboxItemId("agent-state", "escalation-prompt"),
    source: "agent-state",
    kind: "escalation",
    urgency: "attention",
    taskId: "webface-plan",
    repo: "firstmate",
    title: "A captain decision is waiting",
    detail: "The responder routing policy remains held by the captain.",
    options: [{ value: "open", label: "Open decision" }],
    allowFreeform: true,
    respond: { channel: "none" },
    evidence: [{ path: "data/webface-plan/report.md", line: 680 }],
    state: "open",
    openedAt: "2026-09-06T10:20:00.000Z",
  },
  {
    id: inboxItemId("review-results", "ui-shell"),
    source: "review-results",
    kind: "review",
    urgency: "fyi",
    repo: "helm",
    title: "UI shell review is complete",
    detail: "No accessibility concerns were found in the reviewed changes.",
    options: [{ value: "acknowledge", label: "Acknowledge" }],
    allowFreeform: false,
    respond: { channel: "none" },
    evidence: [],
    state: "answered",
    openedAt: "2026-09-05T17:00:00.000Z",
    answeredAt: "2026-09-05T17:22:00.000Z",
  },
  {
    id: inboxItemId("captain-notes", "handoff"),
    source: "captain-notes",
    kind: "note",
    urgency: "fyi",
    repo: "helm",
    title: "Handoff note from the captain",
    detail: "Keep the terminal bridge independent from the human inbox adapter work.",
    options: [],
    allowFreeform: true,
    respond: { channel: "none" },
    evidence: [],
    state: "dismissed",
    openedAt: "2026-09-05T15:00:00.000Z",
  },
  {
    id: inboxItemId("output-match", "operator-pattern"),
    source: "output-match",
    kind: "custom",
    urgency: "attention",
    repo: "fleet-control",
    title: "Operator-defined output pattern matched",
    detail: "A configured output match asked for a human check.",
    options: [{ value: "reviewed", label: "Mark reviewed" }],
    allowFreeform: true,
    respond: { channel: "none" },
    evidence: [],
    state: "open",
    openedAt: "2026-09-06T09:15:00.000Z",
  },
];

const kindLabels: Record<InboxItemKind, string> = {
  decision: "Decision",
  merge: "Merge",
  credential: "Credential",
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

function filterItems(filter: Filter) {
  if (filter === "blocking") return fixtureItems.filter((item) => item.state === "open" && item.urgency === "blocking");
  if (filter === "answered") return fixtureItems.filter((item) => item.state === "answered");
  return fixtureItems;
}

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-1 text-sm/5 sm:text-xs/4 ${className}`}>{children}</span>;
}

export function HelmShell({ defaultLayout }: { defaultLayout?: Layout }) {
  const [filter, setFilter] = useState<Filter>("blocking");
  const [displayState, setDisplayState] = useState<DisplayState>("ready");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [compact, setCompact] = useState(false);

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
        <Button variant="outline" onClick={() => setShortcutsOpen(true)} className="shrink-0 text-muted-foreground" aria-label="Show keyboard shortcuts">
          <Command className="size-4 shrink-0" />
          <span className="hidden sm:inline">Shortcuts</span>
          <kbd className="font-mono text-xs">?</kbd>
        </Button>
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
          <TerminalPlaceholder />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="inbox" minSize="24%">
          <InboxList filter={filter} setFilter={setFilter} displayState={displayState} setDisplayState={setDisplayState} />
        </ResizablePanel>
      </ResizablePanelGroup>

      <ShortcutDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <Toaster position="bottom-right" richColors closeButton />
    </main>
  );
}

function TerminalPlaceholder() {
  return (
    <section className="flex h-full min-w-0 flex-col bg-zinc-950 text-zinc-100">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <TerminalSquare className="size-4 shrink-0" />
          <span className="truncate font-medium">Terminal</span>
          <span className="truncate font-mono text-xs text-zinc-400">Lane B mount point</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-sm text-zinc-400"><CircleDot className="size-4 shrink-0 fill-emerald-400 text-emerald-400" />Waiting</span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-[38ch] text-center">
          <PanelLeft className="mx-auto size-6 text-zinc-500" />
          <h2 className="mt-3 text-lg font-semibold text-balance">Terminal bridge mounts here</h2>
          <p className="mt-2 text-base/7 text-pretty text-zinc-400 sm:text-sm/6">This shell reserves the panel for Lane B&apos;s interactive terminal without taking terminal ownership.</p>
        </div>
      </div>
    </section>
  );
}

function InboxList({ filter, setFilter, displayState, setDisplayState }: { filter: Filter; setFilter(filter: Filter): void; displayState: DisplayState; setDisplayState(state: DisplayState): void }) {
  const visibleItems = filterItems(filter);
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
              <Badge className="border-border bg-muted text-muted-foreground">fixture</Badge>
            </div>
            <p className="mt-1 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">Rendered locally until the inbox store arrives.</p>
          </div>
          <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">{displayState === "ready" ? visibleItems.length : "\u2014"}</span>
        </div>
        <div className="mt-3 flex min-w-0 gap-1 overflow-x-auto" aria-label="Inbox filters" role="group">
          {labels.map((item) => (
            <Button key={item.value} variant={filter === item.value ? "default" : "ghost"} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)} className="shrink-0">
              {item.label} <kbd className="ml-1 font-mono text-xs opacity-70">{item.shortcut}</kbd>
            </Button>
          ))}
        </div>
        <div className="mt-3 flex min-w-0 gap-1 overflow-x-auto" aria-label="Fixture display states" role="group">
          {(["ready", "loading", "empty", "error"] as const).map((state) => (
            <Button key={state} size="xs" variant={displayState === state ? "secondary" : "ghost"} aria-pressed={displayState === state} onClick={() => setDisplayState(state)} className="shrink-0 capitalize">
              {state}
            </Button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {displayState === "loading" && <LoadingState />}
        {displayState === "error" && <ErrorState onRetry={() => setDisplayState("ready")} />}
        {displayState === "empty" && <EmptyState />}
        {displayState === "ready" && (visibleItems.length ? <ul role="list" className="divide-y">{visibleItems.map((item) => <li key={item.id} className="p-4"><InboxCard item={item} /></li>)}</ul> : <EmptyState />)}
      </div>
    </section>
  );
}

function InboxCard({ item }: { item: InboxItem }) {
  const closed = item.state !== "open";
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submittedText, setSubmittedText] = useState<string | null>(null);

  const submitText = () => {
    const text = draft.trim();
    if (!text) return;
    setSubmittedText(text);
    toast.success("Response kept in this UI preview", { description: "Answer delivery is not connected in this lane." });
  };

  return (
    <article className="@container min-w-0">
      <div className="flex min-w-0 items-start gap-3">
        <UrgencyIcon urgency={item.urgency} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge className={urgencyStyles[item.urgency]}>{item.urgency}</Badge>
            <Badge className={stateStyles[item.state]}>{item.state}</Badge>
            <span className="font-mono text-sm text-muted-foreground sm:text-xs">{kindLabels[item.kind]}</span>
          </div>
          <h3 className="mt-2 text-base font-semibold text-pretty sm:text-sm">{item.title}</h3>
          {item.detail && <p className="mt-1 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">{item.detail}</p>}
          <div className="mt-3 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {item.repo && <span className="font-mono text-xs">{item.repo}</span>}
            {item.taskId && <span className="font-mono text-xs">{item.taskId}</span>}
            {item.answeredAt && <span className="flex items-center gap-1"><Clock3 className="size-4 shrink-0" />Answered</span>}
          </div>
          {item.state !== "open" && <p className="mt-3 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">{closedNotices[item.state]}</p>}
          {!closed && item.options.length > 0 && <div className="mt-4 flex min-w-0 flex-wrap gap-2">{item.options.map((option) => <Button key={option.value} size="lg" variant={selected === option.value ? "default" : "outline"} aria-pressed={selected === option.value} onClick={() => { setSelected(option.value); toast.info("Option selected locally", { description: option.hint ?? "This shell does not send answers." }); }} title={option.hint}>{option.label}{option.value === item.recommendValue && <span className="ml-1.5 font-mono text-xs opacity-70">recommended</span>}</Button>)}</div>}
          {!closed && item.allowFreeform && <div className="mt-3 flex min-w-0 flex-col gap-2 @sm:flex-row"><input name={`response-${item.id}`} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitText(); }} placeholder="Write a response…" aria-label={`Response for ${item.title}`} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-0 sm:text-sm" /><Button size="lg" variant="outline" onClick={submitText} disabled={!draft.trim()} className="shrink-0">Preview</Button></div>}
          {!closed && submittedText && <p className="mt-2 rounded-md bg-muted px-3 py-2 text-base/7 text-muted-foreground sm:text-sm/6"><span className="font-medium text-foreground">Local preview:</span> {submittedText}</p>}
        </div>
      </div>
    </article>
  );
}

function UrgencyIcon({ urgency }: { urgency: InboxUrgency }) {
  const className = "mt-0.5 size-4 shrink-0";
  if (urgency === "blocking") return <ShieldAlert className={`${className} text-red-600 dark:text-red-400`} />;
  if (urgency === "attention") return <CircleAlert className={`${className} text-amber-600 dark:text-amber-400`} />;
  return <Sparkles className={`${className} text-sky-600 dark:text-sky-400`} />;
}

function LoadingState() { return <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /><p className="text-base/7 text-muted-foreground sm:text-sm/6">Loading fixture inbox.</p></div>; }
function EmptyState() { return <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center"><Check className="size-5 text-emerald-600 dark:text-emerald-400" /><h3 className="text-base font-semibold sm:text-sm">Nothing needs attention</h3><p className="max-w-[34ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">This filter has no matching inbox cards.</p></div>; }
function ErrorState({ onRetry }: { onRetry(): void }) { return <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center"><CircleX className="size-5 text-destructive" /><h3 className="text-base font-semibold sm:text-sm">Inbox fixture unavailable</h3><p className="max-w-[34ch] text-base/7 text-pretty text-muted-foreground sm:text-sm/6">This UI-only error state does not retry a live store.</p><Button variant="outline" size="lg" onClick={onRetry}>Return to fixture</Button></div>; }

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
function ShortcutRow({ keys, label }: { keys: string; label: string }) { return <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0"><dt className="text-base sm:text-sm">{label}</dt><dd><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{keys}</kbd></dd></div>; }
