# Domain Documentation

This file tells the `mattpocock-skills` sidecar how to use Chatto's
documentation. [`AGENTS.md`](../../../AGENTS.md) stays the primary rule set. If
this file and `AGENTS.md` disagree, `AGENTS.md` wins.

## The rule

**Read Chatto's documentation. Route every change through its owner skill.**

The sidecar gets its context from the documents below. Each document has one
owner skill, and only that skill writes it:

| Document                     | Contents                             | The skill that writes it         |
| ---------------------------- | ------------------------------------ | -------------------------------- |
| `docs/GLOSSARY.md`           | Canonical vocabulary. Read it first. | `/glossary`                      |
| `docs/adr/INDEX.md`          | Cross-cutting architecture decisions | `/adr`                           |
| `docs/fdr/INDEX.md`          | Feature behavior and rationale       | `/fdr`                           |
| `docs/architecture/INDEX.md` | Current runtime inventory            | `/chatto-architecture-inventory` |

A change to one of these documents must go through its owner skill. The owner
skill knows the Chatto conventions: the Simplified Technical English rule, the
index files, the section order, and the cross-references.

## `docs/GLOSSARY.md` is this repository's CONTEXT.md

`/domain-modeling` creates a `CONTEXT.md` in a default repository. Here it
uses `docs/GLOSSARY.md`, which already holds that content.

`/domain-modeling` defines `CONTEXT.md` as "a glossary and nothing else".
Chatto already has that document. `docs/GLOSSARY.md` calls itself the
canonical vocabulary, and also the naming surface for a thing that we build.
The two documents have the same job. A second glossary will disagree with the
first one.

When the sidecar finds a term that is new, unclear, or in conflict:

1. Say so in the session.
2. Use `/glossary` to change `docs/GLOSSARY.md`.

## Decisions: an ADR or an FDR

The sidecar skills know about ADRs only. Chatto divides a decision into two
kinds:

- **ADR** — a cross-cutting architecture decision. Use `/adr`.
- **FDR** — the behavior of one feature, and why it behaves that way. Use
  `/fdr`.

When a sidecar skill offers to write an ADR, first decide which kind applies.
Feature rationale goes in an FDR. An ADR that holds feature rationale is
against `AGENTS.md`.

## The two products

`AGENTS.md` divides this repository into two independent products. Read the
documentation of the product that you work on.

| Product  | Location    | Documentation             |
| -------- | ----------- | ------------------------- |
| Chatto   | root        | `docs/`                   |
| Authling | `authling/` | `authling/docs/`          |

Authling has its own glossary, ADRs, FDRs, and architecture inventory. Take
each term from the glossary of the product that you work on.

The shared framework modules `pkg/events/`, `pkg/natsruntime/`,
`pkg/datacrypto/`, and `pkg/appconfig/` belong to neither product. Each one has
its own `AGENTS.md`. Read it before you change that module.

## Vocabulary

When your output names a domain concept, use the term from `docs/GLOSSARY.md`,
or from `authling/docs/GLOSSARY.md` for Authling work. Use the glossary term
word for word.

If the concept is not in the glossary, that is a signal. Either you invent
language that the project does not use, and you must think again, or there is
a true gap. Report the gap, and let `/glossary` fill it.

## Conflicts

If your output disagrees with an ADR or an FDR, say so before you continue:

> This is against ADR-045 (protocol compatibility), but it is worth a second
> look, because...
