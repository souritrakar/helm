# Architecture

helm is a local Node process that serves one browser page: a Herdr terminal
mirror beside a reconciled inbox. It is a channel, not an authority. It does
not invent close modes, map keys to tasks, write decision records, or drive
Herdr lifecycle.

The SPEC that defined the build is `$FM_HOME/data/webface-plan/report.md`.
This document describes the tree as merged. Where code and the original SPEC
table differ, the code is the contract.

## Process shape

`server.ts` is the HTTP server. helm does not use `next start`, because the
terminal WebSocket and the inbox SSE stream are long-lived connections.

On boot the server:

1. Loads config (`src/lib/config.ts`).
2. Starts the inbox runtime (`src/lib/inbox-runtime.ts`): store, responder,
   audit writer, adapter registry, visibility tracker.
3. Prepares the Next.js request handler for the page.
4. Attaches inbox HTTP, Converse input, and the terminal WebSocket upgrade
   behind the operator gate.
5. Listens on `HELM_BIND`:`HELM_PORT`, then starts pane discovery
   (`src/lib/panes.ts`). Discovery updates the relay target and re-emits open
   relay cards, so cards raised before discovery become actionable without
   delaying inbox startup.

Bind address and port come from `HELM_BIND` and `HELM_PORT` (SPEC D10). Phase 1
listens on loopback by default. Mutating calls go through `requireOperator`
(`src/lib/require-operator.ts`): Host allowlist, Origin / `Sec-Fetch-Site`,
JSON Content-Type on mutations.

## Reader-and-caller boundary

helm reads. It mutates only by invoking a firstmate script or a Herdr command.

| Direction | Owner | Rule |
| --- | --- | --- |
| Read firstmate | `src/lib/fm.ts` | `--json` contracts, schema-validated field by field. Never parse prose. Never re-implement the decision fold. `scanOpenDecisions` calls `scan_open_decisions` from `bin/fm-classify-lib.sh`. |
| Read / observe Herdr | `src/lib/herdr.ts` | One file for socket + CLI. Subscribe with dotted event names. Confirm shapes with `herdr api schema --json`. |
| Exec | `src/lib/exec.ts` | Argv only. No helper accepts a command string. Adapter text is an argv element, never a shell string. |
| Write helm state | `HELM_STATE_DIR` | Pidfile, rotating logs, `inbox-history.json`, `actions.jsonl`. Must not resolve under `$FM_HOME`. |
| Write `$FM_HOME` | forbidden | No shipped path outside `tests/` may write there, including status lines. Proof: `tests/ac18-fm-home-untouched.test.ts`. |

A response that needs firstmate therefore calls `fm-send.sh` or `herdr pane run`.
helm never writes the status line or the decision record itself.

## Terminal bridge

One connected browser viewer owns one `TerminalBridge`
(`src/lib/terminal-bridge.ts`). That bridge owns one `herdr terminal session
observe` child (`src/lib/herdr.ts`).

- Frames are decoded and forwarded as binary to xterm in
  `src/components/terminal-pane.tsx`.
- The observer viewport is fixed at spawn. A client resize (debounced)
  replaces the observer. A sequence gap does the same, so the next `full`
  frame restores truth.
- Input is one-shot: `POST /api/term/input` runs `herdr pane run` for submitted
  text, `herdr pane send-text` for text with `submit: false`, or `herdr pane
  send-keys` for exactly one supported key (`enter`, `escape`, `tab`,
  `backspace`, `up`, `down`, `left`, `right`, or `c-c`). helm does not hold a
  control session or expose a raw byte stream.
- Pane discovery (`src/lib/panes.ts`) refreshes on Herdr pane events and
  cross-references `fm-fleet-snapshot.sh` so task-backed panes show a title.

helm never starts, stops, restarts, or deletes a Herdr session, workspace, or
pane.

## Inbox store, SSE, responder

```
adapters  --full open set-->  InboxStore  --SSE-->  browser
                                  |                    |
                                  | answered ids       | POST /api/inbox/:id/respond
                                  v                    v
                           HELM_STATE_DIR          Responder
                           inbox-history.json      (D-C routing)
                                                   |
                                                   +--> fm-send.sh --resolve-key
                                                   +--> herdr pane run (relay)
                                                   +--> actions.jsonl
```

**Store** (`src/lib/inbox-store.ts`). Adapters emit the full current open set
for their source. The store diffs by id (`${source}:${naturalKey}`), assigns
`openedAt` on first sight, and emits `item.upsert` / `item.retract`. Answered
and dismissed records persist in version-2 `inbox-history.json` for the life
of that data dir, including the handled card body and answer. A restart must
not resurrect handled cards, and snapshot replay includes handled cards while
its open-set boundary names only open ids. Version-1 history still suppresses
old ids but cannot render them. Recurring conditions need a per-occurrence
natural key, or the history suppresses the card forever.

**SSE** (`src/lib/inbox-http.ts`). `GET /api/events` is the live feed. Wire ids
are `<epoch>-<seq>`. A matching `Last-Event-ID` resumes the buffer. A missing,
stale, or different-process id forces `snapshot.begin`, upserts, and
`snapshot.end`. The shell (`src/components/inbox-stream.ts`,
`src/components/helm-shell.tsx`) renders `[data-inbox-item-id]` cards from that
stream.

**Responder** (`src/lib/responder.ts`). This is the only component allowed to
cause an effect. One function per channel. Each is a direct argv exec. Every
attempt, success or failure, is appended to `actions.jsonl`. The card waits
for `POST /api/inbox/:id/respond`; a refused route or nonzero exit leaves it
open and shows the error. Success marks the item answered in the store.

Notifications (`src/lib/inbox-runtime.ts`,
`src/components/inbox-notifications.tsx`) subscribe to the store. They announce
blocking items. They never route or mutate. The Herdr-native nudge is
suppressed only when an authorized visibility session reports the tab visible
and focused and the card on screen (`src/lib/inbox-visibility.ts`). Missing
presence does not suppress.

## Adapters

`src/lib/adapters/registry.ts` starts each adapter with an `emit` scoped to
that adapter's id, so one source cannot reconcile another source's cards away.
Production registration is `registerProductionAdapters` in
`src/lib/adapters/index.ts`.

Ten read-only producers ship:

| Adapter | File | Source |
| --- | --- | --- |
| `status-decisions` | `adapters/state.ts` | `scanOpenDecisions` over `$FM_HOME/state` |
| `captain-holds` | `adapters/state.ts` | `fm-fleet-snapshot.sh --json` backlog rows with `captain_actionable` |
| `bearings` | `adapters/state.ts` | `fm-bearings-snapshot.sh --json` |
| `captain-notes` | `adapters/state.ts` | `$FM_HOME/state/inbox/*.note` |
| `steering-backlog` | `adapters/state.ts` | `$FM_HOME/state/<id>.inbox/*.msg` not under `handled/` |
| `procevent` | `adapters/state.ts` | `$FM_HOME/state/procevent-inbox/*.result` via `fm-procevent.sh classify` |
| `answers` | `adapters/answers.ts` | `$FM_HOME/state/answers/*.json`, schema-validated read-only answers |
| `asks` | `adapters/asks.ts` | `$FM_HOME/state/asks/*.json`, questions firstmate is putting TO the captain |
| `agent-state` | `adapters/herdr-events.ts` | Herdr `pane.agent_status_changed` when status is `blocked` |
| `output-match` | `adapters/herdr-events.ts` | Configured `HELM_OUTPUT_MATCHES` / `pane.output_matched` |

State adapters watch with chokidar and also poll every 10 s. How to add
another source, including the three SPEC §5.4 tiers, is
[adapters.md](adapters.md).

Adapter text is untrusted input. The UI renders it inert. Exec passes it as
argv. It is never instruction and never authority.

## Two halves of the same conversation

`answer` and `ask` are inverse primitives, and both exist so a message between
firstmate and the captain is never buried in the pane it was typed into.

| | `answers` | `asks` |
| --- | --- | --- |
| Direction | firstmate answers the captain | firstmate asks the captain |
| Source | `$FM_HOME/state/answers/*.json` | `$FM_HOME/state/asks/*.json` |
| Record | `{id, question, answer, ref?, ts}` | `{id, question, context, options?, ref?, ts}` |
| Card | read-only, attention | answerable, blocking |
| Answer | none — read and dismiss | `relay` into the firstmate pane |

firstmate owns writing both. helm reads, schema-validates field by field, and
renders. An `options` entry on an ask is BOTH the button label and the answer
relayed verbatim, so helm invents no answer vocabulary. `allowFreeform` is
always true on an ask: a question deserves a nuanced reply even when firstmate
offered shortcuts.

## Add to terminal

Every card carries one control that answers nothing: it renders the card as a
labelled context block and appends it to the terminal composer, so the operator
can write an instruction around it.

- `src/lib/inbox-context.ts` builds the block. Pure, and **one line** — the
  composer posts to `/api/term/input`, which submits the line with a trailing
  Enter, so a newline would become a second pane submission. Every field is
  flattened and control characters are stripped there rather than refused later.
- `src/components/terminal-composer.ts` carries it across the tree. The card
  publishes; the shell un-folds the terminal; the composer appends. A block
  published while the terminal is folded away is queued, because the reveal is
  what mounts the subscriber.
- The draft is never overwritten. The block appends and the caret lands after it.

## D-C answer routing

Ratified 2026-09-06, with `dc-captain-hold-direct-path` on 2026-09-07.
`routeChannel` in `src/lib/responder.ts` is the owner.

| Item class | Channel | Exec |
| --- | --- | --- |
| Keyed `status-decision` whose card declared `resolve-key` | `resolve-key` | `fm-send.sh <task.id> --resolve-key <key> <answer>` (answer is one argv element). Task id and key come verbatim from the card. helm never builds `fm-<id>`. |
| `captain-held`, `merge`, `credential`, `destructive`, `irreversible`, `security-sensitive` | `relay` always | `herdr pane run <configured or discovered firstmate pane> "[helm <item.id>] <answer>"` |
| Other actionable kinds | `relay` | same |
| Cards with `channel: "none"` (steering backlog, process-event review, bearings open decisions, anything lacking a reachable relay pane) | `none` | refused |

A typed answer on a keyed status-decision card is still `resolve-key`. The fold
emits no structured options, so the operator types the answer. That does not
make it a freeform instruction.

`routeChannel` never selects the direct `fm-captain-hold.sh` path. The
`captain-hold` executor remains for tests that call it directly.

`POST /api/inbox/:id/respond` rejects freeform text when `allowFreeform` is
false, rejects a `value` not in `item.options`, rejects `value` when `options`
is empty (use `text`), and rejects a body that sends both `value` and `text`.
Relay answers and the composed pane message must be a single line (no tab or
newline).

## `$FM_HOME` write boundary

helm may read `$FM_HOME/bin` and `$FM_HOME/state`. It may exec scripts that
live there. It must not create or modify any file in that tree.

Writable helm state is only `HELM_STATE_DIR` (default
`~/.local/state/helm`):

- `helm.pid` — launcher pidfile
- `helm.log` and `helm.log.1`…`helm.log.5` — rotating service logs
- `inbox-history.json` — answered / dismissed ids
- `actions.jsonl` — response audit

`bin/helm rotate-logs` validates `HELM_STATE_DIR` only, so the hourly timer
does not need `FM_HOME`. See [operations.md](operations.md).
