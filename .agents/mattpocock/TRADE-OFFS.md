# Sidecar Trade-Offs

Two known costs of installing the skills as a plugin. Read this when a skill
does not load, and when a skill asks you to run `/setup-matt-pocock-skills`.

## A remote session does not install the plugin

Claude Code installs a marketplace plugin in a local session. A remote session
starts from a fresh container that holds no installed plugin, and `/plugin` is
not available there, so `enabledPlugins` alone does not make the skills
appear. `/grill-me` and the rest answer "Unknown command" in that session.

Use the skills from a local session. A remote session still reads `config/`,
so the rules in this directory hold either way.

## The configuration is not at the default path

`config/` holds what `/setup-matt-pocock-skills` writes to `docs/agents/` by
default. `docs/` belongs to Chatto, so the sidecar keeps its configuration
here.

`/code-review` reads `docs/agents/issue-tracker.md` at the default path, and
that path is empty. The skill then asks you to run
`/setup-matt-pocock-skills`. Point it at
[`config/issue-tracker.md`](config/issue-tracker.md) instead.

`/setup-matt-pocock-skills` looks at the same default path when it starts, so
a second run writes a duplicate set into `docs/agents/`. Edit the files in
`config/` directly instead.
