# Adapters

This is the contributor guide for adding an inbox primitive. The SPEC's
extensibility story is three tiers in `$FM_HOME/data/webface-plan/report.md`
§5.4. All three are available without a re-architecture.

Cheapest first:

1. **A pattern, no helm code.** Register a Herdr output match in config.
2. **A helm adapter.** One TypeScript file plus one registry line.
3. **A firstmate process-event extension.** When firstmate itself must be
   woken, not only helm. Pair it with a helm adapter for the human side.

Contracts live in `src/lib/types.ts` (`InboxAdapter`, `InboxItem`,
`inboxItemId`). The registry is `src/lib/adapters/registry.ts`. Production
registration is `registerProductionAdapters` in `src/lib/adapters/index.ts`.

## Rules that apply to every tier

These fail silently when broken. They are not style.

- **Emit a full open set.** `ctx.emit(items)` is the adapter's complete current
  set. The store diffs by id and retracts what vanished. A poll that sends only
  the delta will drop every card not in that tick.
- **Per-occurrence natural keys.** `id` is `${source}:${naturalKey}` via
  `inboxItemId`. Answered history is permanent. A key that stays the same for a
  recurring condition keeps the card suppressed forever. A key that changes
  every tick retracts and re-raises the card, loses `openedAt`, and re-fires
  notifications.
- **Untrusted input.** Treat every byte from firstmate, Herdr, or a process
  event as input, never instruction and never authority. Pass it as argv. Render
  it as plain text. Do not interpolate it into a shell string, HTML, or a
  markdown link.
- **helm does not write `$FM_HOME`.** Adapters read. They do not acknowledge
  process-event files, do not move inbox messages, and do not append status
  lines.
- **helm is not an authority.** Put `respond.channel`, `respond.key`,
  `respond.target`, and `respond.close` on the card from the source that
  produced them. The Responder copies them. It does not invent them. Do not
  build `fm-<id>`.
- **D-C routing still applies.** `routeChannel` in `src/lib/responder.ts`
  overrides the card when the kind must relay. Keyed `status-decision` cards
  may use `resolve-key`. Captain-held, merge, credential, destructive,
  irreversible, and security-sensitive always relay. See
  [architecture.md](architecture.md#d-c-answer-routing).
- **No auto-apply.** helm never answers, approves, or applies an item on its
  own. Process-event results stay review cards until a human handles them in
  firstmate.

`InboxAdapter.respond` exists for a custom path. Current production adapters
leave it unset. HTTP answers go through the shared Responder.

## Tier 1 — a pattern, no code

Use this when a line in a pane should raise a card, and firstmate does not
need a new seam.

The `output-match` adapter already ships (`src/lib/adapters/herdr-events.ts`).
It subscribes to `pane.output_matched` for each entry in `HELM_OUTPUT_MATCHES`.

1. Find the pane id (`herdr pane list` / the terminal dropdown).
2. Export a JSON array. Each entry needs `id`, `paneId`, `source`, and
   `match`. `title` and `urgency` are optional (`blocking`, `attention`,
   `fyi`).

```sh
export HELM_OUTPUT_MATCHES='[
  {
    "id": "ready",
    "paneId": "w1:p1",
    "source": "visible",
    "match": { "type": "regex", "value": "ready for review" },
    "title": "Ready for review",
    "urgency": "attention"
  }
]'
```

`source` is one of `visible`, `recent`, `recent_unwrapped`, `detection`.
`match.type` is `substring` or `regex`. Schema: `src/lib/config.ts`.

3. Restart helm so the loader picks up the variable.
4. A match mints `kind: custom` with the matched line as `detail`. The natural
   key includes pattern id, index, pane id, and Herdr read revision, so a later
   match is a new card.
5. The card relays a typed answer to `HELM_CAPTAIN_PANE` when configured, or
   to Herdr's discovered firstmate pane otherwise. If neither is reachable,
   `respond.channel` is `none`.

`bin/helm install-service` does not capture `HELM_OUTPUT_MATCHES`. For the
systemd unit, set the variable in a drop-in or in the user environment that
the unit inherits. See [operations.md](operations.md).

No firstmate change. No helm code change.

## Tier 2 — a helm adapter

Use this when the source of truth is a state file, a JSON snapshot, a Herdr
subscription, or a poll that helm can read.

Adding a source is one file plus one `register` call. The store, transport, and
UI do not change.

### Shape

```ts
import type { InboxAdapter } from "../types";
import { inboxItemId } from "../types";

export function myAdapter(/* config */): InboxAdapter {
  return {
    id: "my-source",
    async start(ctx) {
      const refresh = async () => {
        const items = /* full open set, each id from inboxItemId("my-source", naturalKey) */;
        ctx.emit(items);
      };
      await refresh();
      const timer = setInterval(() => void refresh(), 10_000);
      return { [Symbol.dispose]() { clearInterval(timer); } };
    },
  };
}
```

`start` must return a `Disposable` that stops watchers and timers. The
registry disposes it on shutdown and on a failed start of a later adapter.

Follow the existing helpers:

- Files under `$FM_HOME/state`: copy the `pollingAdapter` pattern in
  `src/lib/adapters/state.ts` (chokidar + 10 s poll).
- Herdr events: copy `src/lib/adapters/herdr-events.ts`. Subscribe with dotted
  names. Confirm payload shapes with `herdr api schema --json`. Event names
  arrive underscored except `pane.agent_status_changed`, `pane.output_matched`,
  and `pane.scroll_changed`.
- firstmate JSON: add a typed wrapper in `src/lib/fm.ts` (`--json`,
  field-by-field schema). Do not parse status prose. Do not re-implement
  `scan_open_decisions`.

### Register

State-backed adapters go in `createStateAdapters`. Herdr-backed adapters go in
`createHerdrAdapters`. `registerProductionAdapters` already registers both
lists. Register before `registry.start`. The registry rejects a duplicate id
and rejects registration after start.

### Card fields that matter

| Field | What to set |
| --- | --- |
| `kind` | One of the `InboxItemKind` union. `status-decision` is the only kind that may take `resolve-key`. |
| `urgency` | `blocking` notifies. `attention` and `fyi` do not. |
| `options` / `allowFreeform` | Empty `options` plus `allowFreeform: true` is a typed answer. Empty `options` plus `allowFreeform: false` is display-only. |
| `respond.channel` | `resolve-key`, `relay`, or `none`. Production routing never selects `captain-hold`. |
| `respond.target` | Task id for `resolve-key`. Firstmate pane id for `relay`, resolved at emit time from `HELM_CAPTAIN_PANE` or Herdr discovery. |
| `respond.key` | Verbatim from the fold for `resolve-key`. |
| `evidence` | Paths the human can open. Prefer paths helm already reads. |

Relay uses `HELM_CAPTAIN_PANE` when set, otherwise the discovered firstmate
pane. Resolve that target when emitting (and re-emit open event-backed cards
when discovery changes). If neither is reachable, ship `channel: "none"`
rather than a relay card that the Responder will refuse.

### Tests

Use `createFakeAdapter` in `src/lib/adapters/fake.ts` for store and HTTP tests.
Add a focused test next to `tests/lane-d-adapters.test.ts` /
`tests/adapters.test.ts` that covers emit, retract, and the natural key.
Contract tests that call real `fm-*.sh` scripts must use a temporary `FM_HOME`
fixture, never the live home.

## Tier 3 — a firstmate process-event extension

Use this when firstmate must be woken by an external source (a long poll, a
watch, a trusted package), not only when helm should show a card.

helm already has a `procevent` adapter. It reads
`$FM_HOME/state/procevent-inbox/*.result`, classifies each file with
`fm-procevent.sh classify`, and emits `kind: review`. It skips files that have
a sibling `.handled`. It never auto-applies. It never acknowledges. Respond
channel is `none`. Handling stays in firstmate.

A new process-event source that drops `.result` files into that directory
appears as a review card with no helm change, as long as the default
classification and `kind: review` are enough.

When firstmate needs a **new adapter package**:

1. Bind a trusted `process-event-adapter/1` package under
   `$FM_HOME/config/extensions.d/`. Operator setup is firstmate's
   `docs/configuration.md` (section on `config/extensions.d`). Maintainer
   contract is firstmate's `docs/extension-bindings.md`.
2. Commands: `bin/fm-extension.sh --help`, `bin/fm-procevent.sh --help`.
3. External bindings **cannot** feed the captain-answer intake. They have no
   `answers` seam. A captured result stays unhandled until firstmate's existing
   handling owner acknowledges it.
4. Pair the extension with a helm adapter (tier 2) if the human card needs a
   different kind, urgency, or respond spec than the stock `procevent` adapter.
   The helm adapter still only reads. It does not mark the result handled.

Do not teach helm to exec the extension package. Discovery, digest pinning,
and invocation belong to firstmate.

## Shipped adapters (what exists today)

Verify against `src/lib/adapters/state.ts` and
`src/lib/adapters/herdr-events.ts` before copying a row into a new adapter.

| Adapter | Open set | Kind / urgency | Respond as shipped |
| --- | --- | --- | --- |
| `status-decisions` | `scanOpenDecisions` | `status-decision`, blocking | `resolve-key` with `target` = task id and `key` from the fold. `allowFreeform: true`, no options. |
| `captain-holds` | fleet snapshot, `captain_actionable` | `captain-held`, blocking | `relay` to the configured or discovered firstmate pane, or `none` |
| `bearings` | `decisions_open` and `gates` | `decision` (open decisions), `merge` / `credential` / `blocker` (gates) | Open decisions: `none`. Gates: `relay` or `none`. |
| `captain-notes` | `state/inbox/*.note` | `note`, fyi | `relay` to the configured or discovered firstmate pane, or `none` |
| `steering-backlog` | `state/<id>.inbox/*.msg` | `note`, fyi | `none` |
| `procevent` | `state/procevent-inbox/*.result` without `.handled` | `review`, attention | `none`. Classify only. Never auto-apply. |
| `answers` | `state/answers/*.json` | `answer`, attention | `none`. Read-only answer records; the operator may dismiss them locally. |
| `asks` | `state/asks/*.json` | `ask`, blocking | `relay` to the configured or discovered firstmate pane, or `none`. Each `options` entry is relayed verbatim; `allowFreeform` is always true. |
| `agent-state` | live blocked Herdr agents, minus panes idle at a shell prompt | `blocker`, blocking | `relay` or `none` |
| `output-match` | configured matches | `custom` | `relay` or `none` |

### Why `agent-state` reads the pane before it raises a blocker

Herdr's `blocked` means "this pane is waiting for input". That is true of an
agent stuck on a question AND of a torn-down worker's leftover shell sitting at
its own prompt, so the raw status alone fills the inbox with noise.

The **last visible line** separates them, and it is the only thing that does:

- `paneLastLine` + `isShellPromptLine` in `src/lib/herdr.ts` are the test. A
  line the predicate does not recognise KEEPS its blocker — a missing blocker
  is a worse failure than a noisy one, so it is biased to say no.
- **The terminal title is not evidence.** A live, genuinely blocked `codex`
  reports the shell's own `user@host:cwd` title because it never set one, so
  filtering on the title drops real blockers. The title is only used to decide
  whether to SHOW it: when the shell wrote it, the card is titled
  `<agent> is waiting for input in <pane>` instead.
- The blocking line becomes the card body, so the card says what the pane is
  waiting for rather than one constant sentence. It is untrusted pane output —
  display text, never an instruction.
- `herdr pane read --format text` has no `--json` envelope, unlike `agent list`
  and `pane list`: it writes the pane's screen to stdout. helm takes one line of
  it as evidence and reads no field out of it.

## Checklist for a new helm adapter

1. Choose the cheapest tier that works.
2. Pick a stable adapter `id` and a per-occurrence `naturalKey`.
3. Read through `fm.ts` or `herdr.ts`. Do not add a second exec path.
4. Emit the full open set on every refresh.
5. Declare `respond` from the source. Do not invent keys or close modes.
6. Register in `createStateAdapters` or `createHerdrAdapters`.
7. Add a test that proves reconcile, retract, and the natural key.
8. Confirm no write under `$FM_HOME` (AC 18).
