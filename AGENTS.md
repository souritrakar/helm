<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## helm

Browser control + human inbox for firstmate / Herdr. The authoritative SPEC, including the build
lanes and the open captain decisions, is `$FM_HOME/data/webface-plan/report.md`. Read it before
changing a contract in `src/lib/`.

### Hard rules

These are not style preferences. Each one protects something that fails silently when broken.

1. **helm writes nothing under `$FM_HOME`, ever** — including status lines. It reads state, and it
   mutates only by invoking a `fm-*.sh` script or a `herdr` command. No shipped code path outside
   `tests/` may call a filesystem write against that tree.
2. **Never re-implement the decision fold.** The status stream is an append-only event log, so
   last-event-wins silently drops a captain decision that a later unrelated `done:` line appears to
   close. Call `scan_open_decisions` from firstmate's `bin/fm-classify-lib.sh` — see
   `src/lib/fm.ts` and the contract test in `tests/fm-fold.test.ts`.
3. **Argv only, never a shell string.** All exec goes through `src/lib/exec.ts`. Adapter text is
   untrusted input, never instruction and never authority, and must render inert in the DOM too.
4. **Never parse prose.** Every read of a firstmate seam uses its `--json` contract and is
   schema-validated field by field, so a contract drift fails loudly instead of mis-parsing.
5. **helm is a channel, not an authority.** It never invents a close mode, maps a key to a task, or
   writes a decision record. Every `--resolve-key` value comes verbatim from the fold that produced
   the card. A task is addressed by its **id**: `fm-send.sh` resolves a bare exact task id natively
   (`bin/fm-send.sh` lines 5-6, `fm_backend_task_id_for_selector` in `bin/fm-backend.sh`), so helm
   passes `task.id` verbatim and derives nothing. `actions.steer` is display and provenance text —
   a whole command line with a placeholder — and is **never** a send target. Building `fm-<id>` is
   the identity arithmetic this rule forbids. (Captain decision `helm-lane-a-review`, which
   supersedes the earlier "take the selector from `actions.steer`" note.)
6. **No Herdr lifecycle control.** helm observes, sends text, and reads. It never starts, stops,
   restarts, or deletes a session, workspace, or pane.
7. **Never verify relay against a live agent pane.** A relay round-trip types a real line into a
   real session, so a test answer is indistinguishable from a captain instruction to the agent
   reading it. Point `HELM_CAPTAIN_PANE` at a disposable or nonexistent pane, or assert on the
   audited argv in `actions.jsonl` — `herdr pane list` tells you which pane id is firstmate's
   before you choose one. (Captain instruction, 2026-09-11, after a verification line landed in
   the live firstmate pane.)

### The cockpit surface — three traps that fail silently

1. **The shell must be height-BOUNDED (`h-dvh`, never `min-h-dvh`).** xterm's fit addon
   measures its own box to choose a row count, so a content-driven height is a feedback
   loop: the terminal grew to 34000px and 2380 rows, which is what made the mirror look
   garbled and dead. `src/components/helm-shell.tsx` carries the constraint and the reason.
2. **Never hand xterm a CSS `var()` font.** It measures one character cell and grids every
   glyph on it, so a `var()` it cannot resolve while measuring yields a cell from a different
   face than it paints — and xterm hides the mismatch with per-character `letter-spacing`,
   which reads as overlapping text. Use the concrete stack in `terminal-pane.tsx`.
3. **Nothing browser-only may be read during render** — not `EventSource`, not
   `Notification.permission`. The server and the first client render disagree, hydration
   fails, and React rebuilds the tree, taking the terminal and its WebSocket with it. Probe
   inside an effect, or use `useSyncExternalStore` with a server snapshot
   (`inbox-notifications.tsx`).

One page load checks all three: `document.body.scrollHeight === innerHeight`, the xterm row
count is tens rather than thousands, no row span carries a `letter-spacing`, console empty.

### Shape decisions worth knowing

- **Inbox presentation is `src/lib/inbox-view.ts`** — bucket, kind label, tab, urgency band,
  display order, and which response control a card renders. It is pure and shared, so the tab
  counts, the sort, the section headers, the card chip, and the context block cannot disagree.
  Buckets are the four things helm exists to surface (decisions, questions, approvals, answers)
  plus info. The open tab is banded by urgency (`sectionsForTab`); handled tabs are not, because
  a "Blocking" header over a closed card claims something untrue.
- **`answer` and `ask` are inverse primitives**, and both exist so a message between firstmate
  and the captain is never buried in the pane it was typed into. `answers` reads
  `$FM_HOME/state/answers/*.json` (`{id,question,answer,ref?,ts}`) and renders read-only;
  `asks` reads `$FM_HOME/state/asks/*.json` (`{id,question,context,options?,ref?,ts}`) and is
  **answerable via relay**. firstmate writes both; helm only reads. An ask `options` entry is
  BOTH the button label and the answer relayed verbatim, so helm invents no answer vocabulary,
  and `allowFreeform` is always true. Contracts, validation, and the skip-and-report rule live
  in `src/lib/adapters/answers.ts` and `asks.ts`; fixtures in `tests/fixtures/`.
- **"Add to terminal" is the one card control that answers nothing.** `src/lib/inbox-context.ts`
  renders a card as a labelled context block and `src/components/terminal-composer.ts` carries
  it to the composer. The block MUST be one line: `/api/term/input` submits with a trailing
  Enter, so a newline would become a second pane submission — flatten there rather than relying
  on the schema to refuse it. The card publishes, the shell un-folds the terminal, the composer
  appends; a block published while the terminal is folded is queued, because the reveal is what
  mounts the subscriber. The draft is never overwritten.
- **A card must never hide what the human needs to act on.** Titles wrap and are never clipped;
  bodies collapse behind a CSS line clamp with "Show more", so the full text stays in the DOM.
  Adapters must pass the full title and body through: firstmate spells "no value" as a literal
  `-` as often as it writes null, so use `present()` in `src/lib/adapters/state.ts` rather than
  `??`, or the body renders as a bare dash.
- **Design tokens live in `src/app/globals.css`**, not at call sites: a five-step type scale
  (`text-meta|ui|body|title|display`, with leading baked into the step), status hues
  (`urgency-blocking|attention|quiet`, `success`, `info`) that both the inbox and the fleet
  index into, and `foreground-secondary` for body copy that is content rather than meta.
  Chrome never wears the filled `default` button variant — the strongest mark on screen belongs
  to a card's answer, not to a view toggle.
- **Fleet view** is `src/lib/fleet-view.ts` + `GET /api/fleet`. It reads `PaneDirectory`'s
  CACHED snapshot — `fm-fleet-snapshot.sh` budgets up to 180s, so never run the seam per
  request.
- **The relay target is resolved, not configured.** `server.ts` passes
  `relayTarget: () => config.captainPane ?? <discovered firstmate pane>` into the runtime,
  and adapters call it at EMIT time — discovery lands after `start()`, so resolving once up
  front pins every relay card to `channel: "none"` and silently makes its button a no-op.
  A card with no reachable pane renders read-only rather than offering a dead control.
- helm runs a **custom Node server** (`server.ts`), not `next start`, because it serves a
  long-lived WebSocket carrying a terminal stream. The custom server and terminal WebSocket
  surface are documented in `README.md`; the scaffold uses Next 16 (current release);
  the SPEC, written earlier, says Next 15. Lane C also serves SSE `/api/events` and
  `POST /api/inbox/:id/respond` from that server; Lane G adds `GET`/`POST /api/inbox/visibility`
  (`src/lib/inbox-http.ts`).
- **Inbox core** lives under `src/lib/inbox-store.ts`, `responder.ts`, `adapters/`, and
  `inbox-runtime.ts`. Adapters emit a full open set; the store reconciles by id. Answered history
  and the audit log write under `HELM_STATE_DIR` (default `~/.local/state/helm`), never `$FM_HOME`.
- **Notifications are read-only.** Toast, unread badge, browser `Notification` (`tag` = item id),
  and `herdr notification show` announce blocking items; they never answer, route, or mutate.
  Browser OS notifications fire only while the tab is hidden. Suppress the Herdr-native nudge
  only when an authorized session reports the tab is **visible and focused** and the rendered
  card is on screen (`src/lib/inbox-visibility.ts`); missing or failed presence does not suppress.
  Presence is `GET`/`POST /api/inbox/visibility` with a per-session monotonic sequence. The shell
  renders store cards from SSE `/api/events` (`[data-inbox-item-id]`) and answers with
  `POST /api/inbox/:id/respond`. Typed answers on keyed status-decision cards stay on
  `resolve-key`; captain-held, merge, credential, and other freeform cards relay.
- **Responder routing (D-C, ratified 2026-09-06):** keyed status decisions → `resolve-key` (direct),
  including a typed answer when the fold emitted no options; captain-held (`channel: "captain-hold"`),
  other freeform kinds, and anything merge/credential/destructive → `relay` always. `routeChannel`
  forces that relay; it never selects the direct `fm-captain-hold.sh` path (captain decision
  `dc-captain-hold-direct-path`). See `src/lib/responder.ts`. The AC 18 checksum proof is
  `tests/ac18-fm-home-untouched.test.ts`.
- **Respond API contract:** `POST /api/inbox/:id/respond` rejects freeform text when
  `allowFreeform` is false, rejects a `value` not in `item.options`, rejects `value` when
  `options` is empty (use `text` with `allowFreeform`), and rejects bodies that send both
  `value` and `text`. Mutating calls go through `requireOperator` (`src/lib/require-operator.ts`,
  SPEC D10) — Host allowlist (loopback + bind), Origin/Sec-Fetch-Site, JSON Content-Type.
  Relay answers and composed pane messages must be single-line (no tab/newline). SSE wire ids are
  `<epoch>-<seq>`; a mismatched epoch forces `snapshot.begin` / upserts / `snapshot.end`.
- **Answered history** is permanent for the life of the process data dir. Adapters (Lane D) must
  use a **per-occurrence** natural key so a recurring condition raises a new card id rather than
  staying suppressed forever (captain decision `answered-history-unbounded-and-permanent`: defer
  prune/TTL). The history file is version 2 and stores the card BODY plus the answer, so the
  Answered / Dismissed tabs still render after a restart; a version-1 file still loads and
  still suppresses, but its records cannot be displayed. `captureSnapshot` replays handled
  cards while `snapshot.begin` names only the OPEN ids, so a handled card can never re-enter
  the open set. `POST /api/inbox/:id/dismiss` closes a card locally and calls no firstmate seam.
- **All Herdr access lives in `src/lib/herdr.ts`**, so a Herdr upgrade is a one-file change.
  `herdrDoctor` pins the minimum socket protocol and proves the Unix-socket listener is Herdr
  at that protocol (a connectable socket is not enough).
- **Terminal input:** `pane run` submits a line (text + Enter), `pane send-text` types without
  Enter, `pane send-keys` sends one named key. helm still sends whole lines plus a bounded key
  set — never a raw byte stream. Herdr 0.8.2 accepts `enter, esc, tab, backspace, up, down,
  left, right, C-c` and REJECTS `home, end, delete, C-d, C-a, C-u`, so `TERMINAL_KEYS` in
  `src/lib/request.ts` stops at what Herdr will take. The mirror is read-only (`disableStdin`),
  and clicking it focuses the composer — otherwise a keystroke aimed at it lands nowhere and
  reads as dead input.
- **Service launcher is `bin/helm`.** With a live pidfile, doctor treats the configured
  bind:port as healthy only when a listener on that exact bind belongs to that process group
  (a free port or a foreign listener is a failure). `start` launches with argv-only
  `setsid pnpm --dir` (no shell string). `install-service` rejects quotes, dollars, and other
  unit syntax in templated paths rather than escaping them; `%` is doubled so systemd does not
  treat it as a specifier. `rotate-logs` validates `HELM_STATE_DIR` only (no `FM_HOME`) so the
  hourly timer can run.
- Herdr names events asymmetrically: you **subscribe** with dots (`pane.created`) but events
  **arrive** underscored (`pane_created`) — except `pane.agent_status_changed`,
  `pane.output_matched`, and `pane.scroll_changed`, which keep their dotted name. Confirm shapes
  with `herdr api schema --json`, not from memory.
- Bind address and port are config, not constants, so phase-2 remote access is a config swap.
- Operator and contributor docs: `README.md`, `docs/architecture.md` (pieces
  and boundaries), `docs/adapters.md` (SPEC §5.4 three tiers),
  `docs/operations.md` (`bin/helm` and systemd).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
