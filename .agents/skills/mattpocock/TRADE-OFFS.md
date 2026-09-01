# Sidecar Trade-Offs

Two known costs of the sidecar. Read this before you change how the skills
load, and before you take an upstream change.

## The bare skill names shadow the bundled skills

`.agents/skills/` holds one symlink for each sidecar skill, and each symlink
keeps the upstream name. Claude Code finds a project skill before a bundled
skill that has the same name. `/code-review` therefore runs the sidecar skill
in this repository, and the bundled alias `/review` does not reach it.

These names shadow a bundled skill: `code-review`, `research`, `implement`.

The symlinks keep the bare names on purpose. The skills call each other by
bare name. `/grill-with-docs` calls `/grill-me`. A prefix on a directory name
breaks those calls.

A skills-directory plugin is the other form. It gives each skill the name
`/mattpocock-skills:<skill>`, and it shadows nothing. It needs the workspace
trust dialog, so a non-interactive session cannot load it. To change to that
form, delete the symlinks in `.agents/skills/` and keep
`.claude-plugin/plugin.json`.

Chatto's own skills keep their names. Each sidecar name is different from a
`chatto-` name and from an `authling-` name.

## The vendored copy has no update link

`skills/` is a copy of mattpocock/skills at commit `6654f6b`. The copy is
editable, and an upstream change does not reach it.

To take an upstream change, compare the new upstream tree against `6654f6b`,
then apply the parts that you want. Keep the local edits. `npx skills update`
expects its own directory layout, and it does not find this one.

Write the new commit in this file after each update.
