# helm

A browser control + human-inbox interface for firstmate / Herdr.

`helm` puts the exact Herdr terminal in the browser (a live terminal mirror) beside a **human
inbox** - a structured view of every event that needs the human: approvals, decisions, credential
requests, blockers, and anything else surfaced for attention - so the operator can instruct
firstmate/Herdr and act on what matters without re-reading the whole conversation.

Runs as a service, packaged into a repeatable launch workflow, and is built to later be hosted for
secure remote access from any device.

**helm is strictly a reader-and-caller.** It reads firstmate state and calls existing `fm-*.sh`
scripts and `herdr` commands — the same commands the operator would type. It writes nothing under
`$FM_HOME`, ever.

## Status

Lanes A (foundation and contracts), C (the inbox core), D (source adapters), F (the UI shell), and
G (notifications) are built. Lane C provides the store, answered-history, SSE stream, response
endpoint, audit log, responder, and adapter registry. Lane D registers eight read-only producers:
firstmate status decisions, captain holds, bearings, captain notes, steering backlog, and process
events; plus Herdr agent-state and configured output-match events. The shell still renders fixture
data: its options and freeform input keep local component state and do not yet call the response
endpoint. Answered and dismissed cards render read-only. Blocking items raise a toast and unread
badge; optional desktop alerts fire only while the tab is hidden. Notifications observe rendered
DOM cards; live-card observation depends on Lane H rendering the store into the shell. The terminal
bridge and service launcher are later lanes.

## Requirements

- Node 24, pnpm 9
- `herdr` on `PATH`, socket protocol ≥ 20
- A readable `$FM_HOME`

## Configuration

All eight values are environment-driven. Bind address and port are config, not constants, so remote
access later is a config swap rather than a code change.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FM_HOME` | *(required)* | firstmate's operational home. Must be a readable directory containing `bin/` and `state/`. |
| `HELM_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/helm` | Helm's writable state: permanent answered history and the append-only response audit. It must be absolute and cannot resolve under `FM_HOME`. |
| `HERDR_SOCKET_PATH` | `${XDG_CONFIG_HOME:-~/.config}/herdr/herdr.sock` | Herdr control socket. An unset or empty `XDG_CONFIG_HOME` takes the `~/.config` default. |
| `HERDR_BIN` | `herdr` | Herdr executable, resolved on `PATH` unless absolute. |
| `HELM_PORT` | `7333` | HTTP port. |
| `HELM_BIND` | `127.0.0.1` | Bind address. |
| `HELM_CAPTAIN_PANE` | *(unset)* | The firstmate pane id that receives relay-class human replies. Without it, relay-class cards are non-actionable. |
| `HELM_OUTPUT_MATCHES` | `[]` | JSON array of Herdr output-match subscriptions. Each entry needs `id`, `paneId`, `source` (`visible`, `recent`, `recent_unwrapped`, or `detection`), and `match` (`{ "type": "substring" | "regex", "value": "..." }`); `title` and `urgency` are optional. |

For example, to surface a visible line containing `ready` from pane `w1:p1`:

```sh
export HELM_OUTPUT_MATCHES='[{"id":"ready","paneId":"w1:p1","source":"visible","match":{"type":"substring","value":"ready"}}]'
```

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

`pnpm test` needs a real firstmate checkout: the decision-fold contract and the fleet-snapshot
recording both run firstmate's own scripts against a temporary home. The suite probes
`HELM_TEST_FM_HOME`, then `FM_HOME`, then `~/firstmate`, and FAILS when it finds none — a silent
skip would make a green run meaningless. Point `HELM_TEST_FM_HOME` at a checkout, or set
`HELM_SKIP_FM_CONTRACT=1` to opt out. The opt-out is for local development only; it disables the
only proof helm's contracts still match the real seams.

helm runs a **custom Node server** (`server.ts`), not `next start`, because a later lane serves a
long-lived WebSocket carrying a terminal stream, which cannot live in a Next.js route handler.

## Inbox API

Lane C and Lane G expose these local HTTP endpoints:

| Endpoint | Behavior |
| --- | --- |
| `GET /api/inbox` | Returns the current open items. |
| `GET /api/events` | Opens an SSE stream. A matching `Last-Event-ID` resumes buffered events; a missing, stale, or different-process id receives a complete snapshot. |
| `POST /api/inbox/:id/respond` | Delivers exactly one declared option (`value`) or permitted freeform reply (`text`), then records the result. Requests must be JSON and pass the local operator gate. |
| `GET /api/inbox/visibility` | Mints a helm-session token for presence reports. Local operator gate. |
| `POST /api/inbox/visibility` | Reports whether the tab is visible and focused (`active`) and which rendered card ids are on screen. Requires the session token (`X-Helm-Visibility-Session`) and a monotonic `sequence`. Presence only — never answers or mutates inbox items. |

Responses are routed conservatively: only typed, non-freeform status decisions use the keyed
firstmate seam. Captain-held, merge, credential, destructive, irreversible, security-sensitive,
and all freeform replies are relayed to firstmate instead. Every attempted route is appended to
`$HELM_STATE_DIR/actions.jsonl`; answered and dismissed item ids persist in
`$HELM_STATE_DIR/inbox-history.json` and are never automatically pruned.

## Layout

| Path | What |
| --- | --- |
| `src/components/` | The UI shell (`helm-shell.tsx`), the split-size cookie, the read-only inbox notification layer, and the shadcn primitives. |
| `src/lib/types.ts` | `InboxItem`, `InboxAdapter`, `RespondResult` — the contracts every lane imports. |
| `src/lib/herdr.ts` | The single place any Herdr access lives: terminal observer, pane commands, discovery, `events.subscribe`, capability check, `herdr notification show`. |
| `src/lib/fm.ts` | Typed argv wrappers over the firstmate seams, each schema-validated. |
| `src/lib/inbox-store.ts` | Full-set reconciliation, answered history, and the SSE event buffer. |
| `src/lib/inbox-http.ts` | The inbox list, event-stream, response, and visibility HTTP handlers. |
| `src/lib/inbox-visibility.ts` | Process-local operator presence used to suppress native Herdr nudges for on-screen cards. |
| `src/lib/responder.ts` | Conservative answer routing and response audit. |
| `src/lib/adapters/` | Production Lane D source adapters, their registry, and the test fake adapter. |
| `src/lib/config.ts` | Configuration loading and validation. |
| `src/lib/exec.ts` | Argv-only process execution. No helper accepts a command string. |
| `server.ts` | The HTTP server helm owns. |
