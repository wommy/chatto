# Entry Point Definition (for ADR #19)

## Term: Entry Point

**Entry Point** — Unified command or make target that both continuous-integration systems and contributors invoke to build, test, and lint the repository in one operation. It is the canonical interface by which the repository's build rules are exercised in both contexts. Implementation may delegate to multiple separate tasks, but the entry point itself is a single, stable invocation surface. Contrast with **mise task**, which refers to individual granular tasks declared in `mise.toml`; **seam**, which refers to test injection or substitution boundaries in production code; and **gate**, which refers to a condition that gates a release or workflow step.

---

## Rationale

This term addresses GitHub issue #10's need to name the concept without collision:

1. **"seam"** is already taken with eight established uses across Chatto and Authling for test injection, extraction, and substitution boundaries in production code. It is also being reused loosely with conflicting meanings within the CI mapping effort itself (#19).

2. **"Build Task"** collides with `mise.toml`'s 45 `[tasks.*]` entries, saturating the vocabulary space and misleading readers into thinking the term refers to the compile step alone, when the concept actually encompasses build, test, and lint.

3. **"gate"** has informal prior use in release workflows (release-tag gate, gated release-please on green CI) and would invite similar collisions.

4. **"Entry Point"** is plain English, used loosely and safely elsewhere in the repository for unrelated concepts (script entry points in `apps/desktop/scripts/*`, UI entry points in `apps/frontend/*`), but never as a proper-noun term of art. It is uncontested and carries the right meaning: the one place where the build, test, and lint rules can be exercised together.

---

## Placement

This definition belongs in the ADR that decides how CI enters the repository build (#19: "Write the ADR for the CI seam") rather than in `docs/GLOSSARY.md`. 

The glossary holds vocabulary for product runtime concepts visible to users. An entry point for build and CI is repository tooling, not user-facing product infrastructure. If this definition were added to the glossary, it would be the section's first repository-tooling term rather than server-runtime infrastructure, which represents a scope widening for the **Backend** section without a strong product rationale.

The ADR can define the term where it is used, avoiding unnecessary glossary scope creep.
