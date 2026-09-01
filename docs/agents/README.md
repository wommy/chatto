# Agent Skills Configuration

What the plugin skills read about this repository.

Start here to find the file that answers a question, then read that file.

[`.claude/settings.json`](../../.claude/settings.json) installs
`mattpocock-skills` from Claude Code's official plugin marketplace. The plugin
is a read-only bundle that updates when upstream ships, so no skill file lives
in this repository. [`AGENTS.md`](../../AGENTS.md) stays the primary rule set.

## Files

- [`issue-tracker.md`](issue-tracker.md) — where issues live, and which tools
  reach them. Read it to create, read, label, or close a ticket.
- [`triage-labels.md`](triage-labels.md) — the five triage labels. Read it
  before `/triage` applies one.
- [`domain.md`](domain.md) — which Chatto documents to read, and which skill
  owns each one. Read it before you write documentation, name a domain
  concept, or record a decision.
- [`TRADE-OFFS.md`](TRADE-OFFS.md) — the one known cost. Read it when a skill
  does not load, or before you trust what a skill tells you.

`/setup-matt-pocock-skills` writes these files. Edit them directly to change
an answer. Run that skill again only to change the issue tracker, or to start
from nothing.
