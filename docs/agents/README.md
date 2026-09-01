# Agent Skills Configuration

[`.claude/settings.json`](../../.claude/settings.json) installs
`mattpocock-skills` from Claude Code's official plugin marketplace. This
directory holds what those skills read about this repository.

The plugin is a read-only bundle, and it updates when upstream ships. No skill
file lives in this repository.

## Files

- [`issue-tracker.md`](issue-tracker.md) — where issues live, and which tools
  reach them. Read it to create, read, label, or close a ticket.
- [`triage-labels.md`](triage-labels.md) — the five triage labels. Read it
  before `/triage` applies one.
- [`domain.md`](domain.md) — which Chatto documents to read, and which skill
  owns each one. Read it before you write documentation, name a domain
  concept, or record a decision.
- [`TRADE-OFFS.md`](TRADE-OFFS.md) — the one known cost. Read it when a skill
  does not load.

`/setup-matt-pocock-skills` writes these files. Edit them directly to change
an answer. Run that skill again only to change the issue tracker, or to start
from nothing.
