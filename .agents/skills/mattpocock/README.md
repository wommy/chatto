# Matt Pocock's Skills: Local Sidecar

A vendored copy of [mattpocock/skills](https://github.com/mattpocock/skills),
plus the per-repository configuration that those skills read.

The sidecar is private. It lives on this branch, and it stays out of upstream.

## What is where

| Path                         | Contents                                             |
| ---------------------------- | ---------------------------------------------------- |
| `skills/`                    | The vendored skills. Edit them freely.               |
| `.claude-plugin/plugin.json` | The upstream skill list. It names the 25 to load.    |
| `config/`                    | What the skills read about this repository.          |
| `../<skill-name>`            | One symlink for each skill, so Claude Code finds it. |

## The sidecar adds files

Every part of the sidecar is a new file: this directory, and the symlinks in
`.agents/skills/` that point into it. Chatto's own files stay as upstream
wrote them, `AGENTS.md` and `docs/` included.

This keeps two things true:

1. A merge from upstream never conflicts with the sidecar.
2. A diff against upstream shows added files, and shows Chatto's own content
   unchanged.

To remove the sidecar, delete this directory and the symlinks that point into
it.

## Files

- [`config/issue-tracker.md`](config/issue-tracker.md) — where issues live, and
  which tools reach them. Read it to create, read, label, or close a ticket.
- [`config/triage-labels.md`](config/triage-labels.md) — the five triage
  labels. Read it before `/triage` applies one.
- [`config/domain.md`](config/domain.md) — which Chatto documents to read, and
  which skill owns each one. Read it before you write documentation, name a
  domain concept, or record a decision.
- [`TRADE-OFFS.md`](TRADE-OFFS.md) — the three known costs. Read it before you
  change how the skills load, and before you take an upstream change.

## Why this directory

`/setup-matt-pocock-skills` writes the configuration to `docs/agents/` by
default. This repository keeps it here, because `docs/` is Chatto's
documentation namespace, and a new directory inside it is intermingling.
