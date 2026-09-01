# Matt Pocock's Skills: Local Sidecar

This directory configures the `mattpocock-skills` plugin for this repository.

It is a sidecar, and it is private. It lives on this branch only. Nothing here
goes upstream, and nothing here changes a file that Chatto already tracks.

## The invisibility rule

The sidecar adds files. The sidecar does not edit files.

Everything the sidecar needs is in this directory and in the
`mattpocock-skills` line of [`.claude/settings.json`](../../.claude/settings.json).
No Chatto file points at this directory. `AGENTS.md`, `CLAUDE.md`, and the
Chatto documentation stay exactly as upstream wrote them.

This keeps two things true:

1. A merge or a rebase from upstream never conflicts with the sidecar.
2. A diff of this branch against upstream shows the sidecar as added files,
   and shows no change to Chatto's own content.

To remove the sidecar, delete this directory and that one settings line.

## The read-only boundary

The sidecar skills read Chatto's documentation. They do not write it. These
skills stay the only writers:

| Documentation surface | The skill that writes it         |
| --------------------- | -------------------------------- |
| `docs/GLOSSARY.md`    | `/glossary`                      |
| `docs/adr/`           | `/adr`                           |
| `docs/fdr/`           | `/fdr`                           |
| `docs/architecture/`  | `/chatto-architecture-inventory` |

A sidecar skill that writes one of these documents breaks the invisibility
rule. [`domain.md`](domain.md) gives the full rule.

## Files

- [`issue-tracker.md`](issue-tracker.md) — where issues live, and how to read
  and write them.
- [`triage-labels.md`](triage-labels.md) — the five triage labels.
- [`domain.md`](domain.md) — how the sidecar reads Chatto's documentation.

## Why this directory

`/setup-matt-pocock-skills` writes these files to `docs/agents/` by default.
This repository keeps them here instead. `docs/` is Chatto's documentation
namespace, and a new directory inside it is intermingling.

One skill, `/code-review`, looks for `docs/agents/issue-tracker.md` at the
default path. It does not find the file here, and it then tells you to run
`/setup-matt-pocock-skills`. Point it at [`issue-tracker.md`](issue-tracker.md)
instead.
