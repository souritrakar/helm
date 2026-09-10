# Operations

`bin/helm` is the service entrypoint. It launches with argv-only
`setsid pnpm --dir` (no shell string). State and logs belong to
`HELM_STATE_DIR`, never `$FM_HOME`.

## Environment

Set these in the shell that runs `bin/helm`, or in the systemd user unit.
The eight values `loadConfig` reads (`FM_HOME`, `HELM_STATE_DIR`,
`HERDR_SOCKET_PATH`, `HERDR_BIN`, `HELM_PORT`, `HELM_BIND`,
`HELM_CAPTAIN_PANE`, `HELM_OUTPUT_MATCHES`) are listed in
[README Configuration](../README.md#configuration). Output-match JSON is
in [adapters.md](adapters.md#tier-1--a-pattern-no-code).

The launcher also honours:

| Variable | Default | Role |
| --- | --- | --- |
| `HELM_FOREGROUND` | `0` | `1` in the systemd unit so `start` stays in the foreground under systemd. |

Loader: `src/lib/config.ts`. `bin/helm start` also requires a prior
`pnpm build` (`bin/helm build`).

## Commands

```
usage: bin/helm {doctor|build|start|stop|status|logs|install-service}
```

`rotate-logs` is a hidden subcommand used by the timer. Operators do not need
it by hand.

| Command | What it does |
| --- | --- |
| `bin/helm doctor` | Pre-start gate and operator diagnostic. Exit 0 only when the box is usable. |
| `bin/helm build` | `pnpm --dir <helm-root> build`. |
| `bin/helm start` | Validates state dir, refuses a live pidfile, runs doctor, rotates logs if needed, launches the production server. The background path waits until this process group owns `HELM_BIND:HELM_PORT`. With `HELM_FOREGROUND=1` (the systemd unit) it stays in the foreground and does not run that listen probe. |
| `bin/helm stop` | If the user unit is active, `systemctl --user stop helm.service`. Otherwise SIGTERM (then SIGKILL) on the recorded process group. |
| `bin/helm status` | Prints `service=… process=… bind=…`. Exit 0 when the unit is active or the process is running. |
| `bin/helm logs` | Last 200 lines of `$HELM_STATE_DIR/helm.log`. |
| `bin/helm install-service` | Installs the user unit, linger, and the hourly log-rotate timer. |

A second `bin/helm start` while the pidfile is live refuses rather than
double-binding.

Development without the launcher: `pnpm dev` (still needs `FM_HOME`). That
path does not write the pidfile.

## Doctor

`bin/helm doctor` fails when any of these is true:

- `FM_HOME` is missing or not a readable directory with `bin/` and `state/`
- Node or pnpm is below the versions in `package.json`
- `herdr` is missing, too old, or the socket is not a live Herdr server at
  protocol ≥ 20 (a connectable socket is not enough)
- The configured `HELM_BIND:HELM_PORT` is held by anyone other than this helm
  instance

When a live pidfile exists, doctor passes the recorded pid as `--port-owner`.
A free port is healthy when helm is not running. A port held by this instance's
process group is healthy when helm is running. A foreign listener is a
failure. Implementation: `bin/helm-doctor.ts`, `src/lib/launch.ts`,
`src/lib/listener.ts`.

## Ports

Default listen address is `127.0.0.1:7333`. The browser URL is
`http://127.0.0.1:7333` (or `http://<HELM_BIND>:<HELM_PORT>` when you change
them).

The launcher probes the exact configured bind. `0.0.0.0` and `::` are listen
addresses. Readiness then connects to `127.0.0.1` or `::1`. helm does not run
privileged, so a port below 1024 fails with permission denied.

Phase 1 has no TLS, no tunnel, and no user auth. The operator gate
(`src/lib/require-operator.ts`) allows local same-origin / non-browser callers
and refuses cross-site CSRF, non-JSON mutating bodies, and Host headers
outside the loopback/bind allowlist.

## systemd user unit

Templates live in `systemd/`. `install-service` fills `@HELM_ROOT@`,
`@FM_HOME@`, `@HELM_STATE_DIR@`, `@HELM_BIND@`, and `@HELM_PORT@` into:

- `~/.config/systemd/user/helm.service`
- `~/.config/systemd/user/helm-logrotate.service`
- `~/.config/systemd/user/helm-logrotate.timer`

Then it runs `systemctl --user daemon-reload`, `loginctl enable-linger`,
`systemctl --user enable helm.service`, and
`systemctl --user enable --now helm-logrotate.timer`.

`install-service` requires a validated `FM_HOME`. It never guesses
`~/firstmate`. Paths that contain quotes, dollars, or other unit syntax are
rejected rather than escaped. `%` is doubled so systemd does not treat it as a
specifier.

The unit captures `FM_HOME`, `HELM_STATE_DIR`, `HELM_BIND`, `HELM_PORT`, and
`HELM_FOREGROUND=1`. It does **not** capture `HELM_CAPTAIN_PANE` or
`HELM_OUTPUT_MATCHES`. If you need those under systemd, add a drop-in under
`~/.config/systemd/user/helm.service.d/` and rerun `daemon-reload`.

Rerun `bin/helm install-service` after you change `FM_HOME`, `HELM_BIND`, or
`HELM_PORT`.

The unit sets `Restart=always` with `RestartSec=3`,
`StartLimitIntervalSec=300`, and `StartLimitBurst=5`, so a missing Herdr does
not retry forever.

Start and stop through systemd after install:

```sh
systemctl --user start helm
systemctl --user stop helm
systemctl --user status helm
```

`bin/helm start` / `stop` / `status` remain valid. `stop` prefers the unit
when it is active.

If local policy refuses linger, the fallback printed by `install-service` is:

```
@reboot /absolute/path/to/helm/bin/helm start
```

in the user crontab.

## Log rotation

Service stdout/stderr append to `$HELM_STATE_DIR/helm.log`.

`bin/helm rotate-logs` (and `start`, before launch) copies the log to
`helm.log.1` and truncates the live file when it reaches 10 MiB. It keeps five
archives (`helm.log.1` … `helm.log.5`). The running server holds the inode
open, so rotation copies and truncates rather than renaming the live file.

The hourly timer runs that command. The oneshot unit templates
`HELM_STATE_DIR` only. It does not need `FM_HOME`. That is why `rotate-logs`
validates the state directory through `bin/helm-state-dir.ts`, not the full
config loader.

`bin/helm logs` is `tail -n 200` of the live log.

## State files under `HELM_STATE_DIR`

| File | Owner |
| --- | --- |
| `helm.pid` | `bin/helm` (pid and start time) |
| `helm.log` | server stdout/stderr |
| `inbox-history.json` | answered / dismissed ids (`src/lib/inbox-store.ts`) |
| `actions.jsonl` | response audit (`src/lib/audit.ts`) |

Answered history is permanent for the life of this directory. There is no
prune or TTL.

## Common failures

- **`doctor` names Herdr.** The socket must be a live Herdr server at the
  pinned protocol. Start Herdr yourself. helm does not start it.
- **`already running` on `start`.** `bin/helm stop` first, or inspect
  `bin/helm status`.
- **Foreign listener.** Another process holds `HELM_BIND:HELM_PORT`. Move
  `HELM_PORT` or stop that process. Doctor will not treat a free port as the
  running instance, and will not treat a foreign pid as helm.
- **Relay cards are non-actionable.** helm normally discovers the firstmate
  pane from Herdr. If discovery cannot find one, set `HELM_CAPTAIN_PANE` to its
  pane id; under systemd, put it in a drop-in because the install-service
  template does not capture it.
- **Tests fail looking for firstmate.** Point `HELM_TEST_FM_HOME` at a
  checkout, or set `HELM_SKIP_FM_CONTRACT=1` for local work only.
