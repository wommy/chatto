# Matt Pocock's Skills: Configuration

[`.claude/settings.json`](../../.claude/settings.json) installs
`mattpocock-skills` from Claude Code's official plugin marketplace. This
directory holds what those skills read about this repository.

The plugin is a read-only bundle, and it updates when upstream ships. No skill
file lives in this repository.

## The sidecar adds files

The plugin costs one line in `.claude/settings.json`. Everything else the
sidecar needs is in this directory. Chatto's own documentation stays as
upstream wrote it, `AGENTS.md` and `docs/` included.

To remove the sidecar, delete this directory and that one settings line.

## Files

- [`config/issue-tracker.md`](config/issue-tracker.md) — where issues live, and
  which tools reach them. Read it to create, read, label, or close a ticket.
- [`config/triage-labels.md`](config/triage-labels.md) — the five triage
  labels. Read it before `/triage` applies one.
- [`config/domain.md`](config/domain.md) — which Chatto documents to read, and
  which skill owns each one. Read it before you write documentation, name a
  domain concept, or record a decision.
- [`TRADE-OFFS.md`](TRADE-OFFS.md) — the two known costs. Read it when a skill
  does not load, and when a skill asks you to run
  `/setup-matt-pocock-skills`.

## Why this directory

`/setup-matt-pocock-skills` writes the configuration to `docs/agents/` by
default. This repository keeps it here, because `docs/` is Chatto's
documentation namespace, and a new directory inside it is intermingling.
