# Instructions for Agents Working in `.github/`

This file applies to the release surface: the workflows in `.github/workflows/`,
the composite actions in `.github/actions/`, and the GoReleaser configuration at
`.goreleaser.yml` that the release workflow drives. `.goreleaser.yml` is at the
repository root, but it belongs to this surface.

Root `AGENTS.md` stays the primary rule set. This file adds what the release
surface needs.

## Two words for two different properties

- **Revertible** — a property of a change to this repository. One `git revert`
  restores the previous behaviour. Every change here is revertible.
- **Withdrawable** — a property of a published artifact. A GitHub Release
  archive stays withdrawable until the publish step. A container image tag and
  the Homebrew tap do not: `:latest` moves live on push.

Keep each word for its own property.

## Proof is sized by the exercise gap

The **exercise gap** is the distance between the merge of a change and the
first run of that change.

A change to `ci.yml` has no gap, because the pull request that changes CI runs
the changed CI. A change to `release.yml` or `.goreleaser.yml` has a gap, and
that gap ends at the next real release. The gap sizes the evidence you must
supply.

Find the tier of your change, then carry the evidence for that tier:

| Tier | Your change | Evidence your pull request carries |
| --- | --- | --- |
| **1 — self-exercising** | a `mise` task that `ci.yml` already calls; a Go build flag; a script with a test beside it | what a normal pull request carries. No ceremony. |
| **2 — proxy** | a stand-in runs the step and publishes nothing | the run of the stand-in, **and a statement of what the stand-in does not reach** |
| **3 — not exercisable** | only a real release runs it: the credentialed signing paths, the Homebrew tap push | restructure it first. See below. |

**Tier 2 needs both halves.** A proxy run on its own reads as full proof and is
not. Say what the proxy leaves untested, so the reviewer sees the same risk that
you do.

**Tier 3 shrinks by restructuring.** Move what you can to tier 1 or tier 2. Put
the logic behind an interface and keep a test at that interface. Then only the
credential handoff stays unproven, and a reviewer can point at that boundary in
the diff. `apps/desktop/scripts/macos-signing.mjs` and its
`macos-signing.test.mjs` show the shape.

## Name who runs each proof

Say which prover runs each check, and say it before a person starts the work.

**CI is a prover, and usually the correct one.** `goreleaser`, `buf`,
`actionlint`, `shellcheck` and `mailpit` install from GitHub releases, which an
agent session cannot reach. A proof that runs in `ci.yml` needs no local tool,
and it closes the exercise gap at the same time. Where only a person can run a
proof, write that in the ticket.

## Cite source only to link two facts you ran

A citation into a dependency's source can connect two things that your pull
request executed. Execute both ends, and use the citation for the link between
them.

## Pre-register the rollback

When your change can reach an artifact that is not withdrawable, put the
rollback in the pull request as a command that a person can paste:

- **For an image, give the previous digest.** You re-point a floating tag with
  `docker buildx imagetools create -t <image>:latest <image>@sha256:<previous>`,
  and a tag name does not do this.
- **For the Homebrew tap, give the previous `Formula/chatto.rb` commit.**

This obligation follows withdrawability, not the tier. A change can be tier 1
and still move `:latest`.

## Rehearse with `build-image`

To rehearse a change to the image build, run the `build-image` job:
`workflow_dispatch` on `release.yml` with `target: image`. It builds any ref
through the release `Dockerfile` and pushes one tag that carries the commit SHA.
No floating tag moves, so the rehearsal publishes nothing that a user tracks.

**A `v*` tag is a real release.** Any `v*` push starts the full release job, and
a prerelease tag publishes `:next`, which the development cluster deploys. Keep
real tags for the credentialed desktop paths, which have no other rehearsal.

## A coding agent usually cannot write this directory

Most agent sessions hold a token without the GitHub `workflow` scope, and the
GitHub App refuses a write under `.github/workflows/` as well. The refusal
arrives late, at the push, and one server reports it as an expired token, which
sends you looking for the wrong cause. Test a small write early when a change
needs this directory.

Split the work when the push is refused. Put every file the session can write
in one pull request, and give the workflow half to a session that has the
scope. Two rules make the split safe:

- Never leave a half that changes a value the other half reads. The tag list
  that `tools/release-image-tags.mjs` writes and the release workflow reads is
  such a value: one half alone gives a broken release, and a green test suite
  does not show it.
- Say in the pull request body which half is missing and why, so that a
  reviewer does not read the branch as the complete change.

## Where the reasoning lives

[Issue #36](https://github.com/wommy/chatto/issues/36) holds standing rule 1 in
full: the table of what each proof reaches, and the GoReleaser source citations
behind it. Read the map when you must know why a rule says what it says, or when
you change the rule itself.
