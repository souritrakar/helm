# helm

A browser control + human-inbox interface for firstmate / Herdr.

`helm` puts the exact Herdr terminal in the browser (a `ttyd`-style live terminal mirror) beside
a **human inbox** — a structured view of every event that needs the human: approvals,
AskUserQuestion prompts, decisions, and anything else surfaced for attention — so the operator can
instruct firstmate/Herdr and act on what matters without re-reading the whole conversation.

Runs as a service, packaged into a repeatable launch workflow, and is built to later be hosted for
secure remote access from any device.

Status: spec/design in progress (see the planning report). Implementation follows the approved spec.
