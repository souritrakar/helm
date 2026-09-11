# helm

helm is a local browser cockpit for firstmate and Herdr. It shows a live
terminal mirror next to a reconciled human inbox.

helm is a **reader-and-caller**. It reads firstmate state and Herdr events. It
mutates only by invoking an existing `fm-*.sh` script or a `herdr` command, the
same commands an operator would type. It writes nothing under `$FM_HOME`.

The product is complete for phase 1. Lanes A–H are on `main`. These files
describe what the tree contains. They do not add features.

- [Architecture](docs/architecture.md) — pieces and how they connect
- [Adapters](docs/adapters.md) — how to add a primitive (SPEC §5.4, three tiers)
- [Operations](docs/operations.md) — `bin/helm`, systemd, logs, ports

## Quickstart

Requirements: Node 24, pnpm 9, `herdr` on `PATH` (socket protocol ≥ 20), and a
readable firstmate home.

```sh
export FM_HOME="${FM_HOME:-$HOME/firstmate}"
# HELM_PORT defaults to 7333. HELM_BIND defaults to 127.0.0.1.
# HELM_STATE_DIR defaults to ${XDG_STATE_HOME:-~/.local/state}/helm
pnpm install
pnpm build
bin/helm doctor
bin/helm start
```

Open `http://127.0.0.1:7333`. `bin/helm stop` stops the process. `bin/helm
status` and `bin/helm logs` inspect it.

`HELM_CAPTAIN_PANE` is optional. When it is unset, helm relays replies to the
firstmate pane discovered from Herdr. Cards remain read-only only when neither
source identifies a reachable pane.

Development without the launcher:

```sh
export FM_HOME="${FM_HOME:-$HOME/firstmate}"
pnpm install
pnpm dev         # custom Node server, development
```

helm runs `server.ts`, not `next start`. The custom server owns the long-lived
terminal WebSocket and the inbox SSE stream.

## What it shows

The page is a persisted split with the Inbox and Fleet panel on the left and a
collapsible terminal on the right. On narrow screens the terminal starts
collapsed so pending work is visible first.

**Terminal.** A read-only Herdr observer of the selected pane, including colour.
A dropdown lists discovered panes. Task-backed panes show the task title. The
Converse field sends one single-line message (`herdr pane run`) or one named
key. Clicking the read-only mirror focuses that field; helm does not take
control of the pane or start or stop Herdr sessions.

**Inbox.** Ten read-only adapters publish a full open set. The store
reconciles by id and streams changes over SSE. Open, Answered, and Dismissed
tabs group cards into Decisions, Questions, Approvals, Answers, and Info.
Questions from firstmate (`$FM_HOME/state/asks/*.json`) are answerable cards:
their offered options and typed replies relay verbatim to the configured or
discovered firstmate pane. Keyed status decisions answer through
`fm-send.sh --resolve-key`. Captain-held, merge, credential, and other
freeform cards also relay; a card with no reachable relay pane is honestly
read-only. Every card can append its labelled, one-line context to the
terminal composer without replacing the current draft. Answered and dismissed
history (including each card's captured body) and the response audit live
under `HELM_STATE_DIR`, never under `$FM_HOME`. The Fleet panel summarizes
cached task health and flags work that needs you.

Notifications announce blocking items. They never answer or mutate. Browser OS
notifications fire only while the tab is hidden.

## Requirements

- Node 24, pnpm 9
- `herdr` on `PATH`, socket protocol ≥ 20
- A readable `$FM_HOME`

## Configuration

All eight values are environment-driven. Bind address and port are config, not
constants, so remote access later is a config swap rather than a code change.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FM_HOME` | *(required)* | firstmate's operational home. Must be a readable directory containing `bin/` and `state/`. |
| `HELM_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/helm` | Helm's writable state: pidfile, rotating service logs, permanent answered history, and the append-only response audit. It must be absolute and cannot resolve under `FM_HOME`. |
| `HERDR_SOCKET_PATH` | `${XDG_CONFIG_HOME:-~/.config}/herdr/herdr.sock` | Herdr control socket. An unset or empty `XDG_CONFIG_HOME` takes the `~/.config` default. |
| `HERDR_BIN` | `herdr` | Herdr executable, resolved on `PATH` unless absolute. |
| `HELM_PORT` | `7333` | HTTP port. |
| `HELM_BIND` | `127.0.0.1` | Bind address. |
| `HELM_CAPTAIN_PANE` | *(unset)* | Optional override for the firstmate pane that receives relay-class human replies. When unset, helm uses the discovered firstmate pane; cards are non-actionable only if neither is reachable. |
| `HELM_OUTPUT_MATCHES` | `[]` | JSON array of Herdr output-match subscriptions. Each entry needs `id`, `paneId`, `source` (`visible`, `recent`, `recent_unwrapped`, or `detection`), and `match` (`{ "type": "substring" | "regex", "value": "..." }`). `title` and `urgency` are optional. |

For example, to surface a visible line containing `ready` from pane `w1:p1`:

```sh
export HELM_OUTPUT_MATCHES='[{"id":"ready","paneId":"w1:p1","source":"visible","match":{"type":"substring","value":"ready"}}]'
```

Loader and validation live in `src/lib/config.ts`. Launcher-only
`HELM_FOREGROUND` is in [operations](docs/operations.md).

## Commands

```sh
pnpm install
pnpm dev         # custom Node server, development
pnpm build       # next build
pnpm start       # custom Node server, production
pnpm typecheck
pnpm test
pnpm lint
```

`pnpm test` needs a real firstmate checkout: the decision-fold contract and the
fleet-snapshot recording both run firstmate's own scripts against a temporary
home. The suite probes `HELM_TEST_FM_HOME`, then `FM_HOME`, then `~/firstmate`,
and FAILS when it finds none. A silent skip would make a green run meaningless.
Point `HELM_TEST_FM_HOME` at a checkout, or set `HELM_SKIP_FM_CONTRACT=1` to
opt out. The opt-out is for local development only. It disables the only proof
helm's contracts still match the real seams.

Service commands are `bin/helm doctor|build|start|stop|status|logs|install-service`.
See [operations](docs/operations.md).

## Inbox API

These local HTTP endpoints are served from `server.ts`
(`src/lib/inbox-http.ts`):

| Endpoint | Behavior |
| --- | --- |
| `GET /api/inbox` | Returns the current open items. |
| `GET /api/events` | Opens an SSE stream. A matching `Last-Event-ID` resumes buffered events. A missing, stale, or different-process id receives a complete snapshot. |
| `POST /api/inbox/:id/respond` | Delivers exactly one declared option (`value`) or permitted freeform reply (`text`), then records the result. Requests must be JSON and pass the local operator gate. |
| `POST /api/inbox/:id/dismiss` | Dismisses an open card locally in helm. It calls no firstmate seam. |
| `GET /api/fleet` | Returns the cached, human-facing fleet overview used by the Fleet panel. |
| `GET /api/inbox/visibility` | Mints a helm-session token for presence reports. Local operator gate. |
| `POST /api/inbox/visibility` | Reports whether the tab is visible and focused (`active`) and which rendered card ids are on screen. Requires the session token (`X-Helm-Visibility-Session`) and a monotonic `sequence`. Presence only. It never answers or mutates inbox items. |

Responses follow D-C routing in `src/lib/responder.ts`. Typed answers to keyed
status decisions use `fm-send.sh --resolve-key`, including when the decision
has no structured options. Captain-held, merge, credential, destructive,
irreversible, security-sensitive, and other freeform replies relay to
firstmate. Every attempted route is appended to `$HELM_STATE_DIR/actions.jsonl`.
Answered and dismissed cards, their captured bodies, and answered outcomes
persist in `$HELM_STATE_DIR/inbox-history.json` and are never automatically
pruned. Version-1 history still suppresses a re-raised id but has no card body
to display.

## Terminal bridge

The terminal panel is a live, read-only Herdr observer. Choose an available
pane from its dropdown. The Converse field sends a one-shot single-line text
message to the selected pane. It does not give helm take-control or a raw
keyboard stream. A dropped observer can be reconnected from the panel.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/term?cols=<cols>&rows=<rows>` | WebSocket terminal mirror. The initial viewport must be 2–500 columns and 2–300 rows. Invalid or absent dimensions use 80×24. |
| `POST /api/term/input` | Sends exactly one JSON `{ "paneId", "text", "submit"? }` message (single line: no tab, newline, or control characters), or a named `{ "paneId", "key" }` key. Text submits with Enter unless `submit` is `false`, which types it without Enter. Supported keys are `enter`, `escape`, `tab`, `backspace`, `up`, `down`, `left`, `right`, and `c-c`. |

Both terminal surfaces pass the same local operator gate as inbox mutations.
Terminal output is an observer stream. A resize, pane switch, or sequence gap
replaces that observer and waits for a full repaint. Implementation:
`src/lib/terminal-bridge.ts`, `src/lib/herdr.ts`.

## Layout

| Path | What |
| --- | --- |
| `bin/helm` | Service entrypoint: doctor, build, start, stop, status, logs, install-service. |
| `docs/` | Architecture, adapters, operations. |
| `systemd/` | User-unit and hourly log-rotate templates, filled by `install-service`. |
| `src/components/` | The UI shell, live inbox SSE and response UI, split-size cookie, notification layer, and shadcn primitives. |
| `src/lib/types.ts` | `InboxItem`, `InboxAdapter`, `RespondResult` — the contracts every lane imports. |
| `src/lib/herdr.ts` | The single place any Herdr access lives. |
| `src/lib/fm.ts` | Typed argv wrappers over the firstmate seams, each schema-validated. |
| `src/lib/inbox-store.ts` | Full-set reconciliation, answered history, and the SSE event buffer. |
| `src/lib/inbox-http.ts` | The inbox list, event-stream, response, and visibility HTTP handlers. |
| `src/lib/inbox-visibility.ts` | Process-local operator presence used to suppress native Herdr nudges for on-screen cards. |
| `src/lib/responder.ts` | Conservative answer routing and response audit. |
| `src/lib/adapters/` | Production source adapters, their registry, and the test fake adapter. |
| `src/lib/config.ts` | Configuration loading and validation. |
| `src/lib/launch.ts` | Doctor runtime checks. |
| `src/lib/exec.ts` | Argv-only process execution. No helper accepts a command string. |
| `server.ts` | The HTTP server helm owns. |
