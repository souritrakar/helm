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
   the card. The responder routing policy (SPEC decision D-C) is still the captain's call.
   A task is addressed by its **id**: `fm-send.sh` resolves a bare exact task id natively
   (`bin/fm-send.sh` lines 5-6, `fm_backend_task_id_for_selector` in `bin/fm-backend.sh`), so helm
   passes `task.id` verbatim and derives nothing. `actions.steer` is display and provenance text —
   a whole command line with a placeholder — and is **never** a send target. Building `fm-<id>` is
   the identity arithmetic this rule forbids. (Captain decision `helm-lane-a-review`, which
   supersedes the earlier "take the selector from `actions.steer`" note.)
6. **No Herdr lifecycle control.** helm observes, sends text, and reads. It never starts, stops,
   restarts, or deletes a session, workspace, or pane.

### Shape decisions worth knowing

- helm runs a **custom Node server** (`server.ts`), not `next start`, because a later lane serves a
  long-lived WebSocket carrying a terminal stream. The scaffold uses Next 16 (current release);
  the SPEC, written earlier, says Next 15.
- **All Herdr access lives in `src/lib/herdr.ts`**, so a Herdr upgrade is a one-file change.
  `herdrDoctor` pins the minimum socket protocol.
- Herdr names events asymmetrically: you **subscribe** with dots (`pane.created`) but events
  **arrive** underscored (`pane_created`) — except `pane.agent_status_changed`,
  `pane.output_matched`, and `pane.scroll_changed`, which keep their dotted name. Confirm shapes
  with `herdr api schema --json`, not from memory.
- Bind address and port are config, not constants, so phase-2 remote access is a config swap.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
