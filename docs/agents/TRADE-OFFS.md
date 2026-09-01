# Trade-Offs

One known cost of installing the skills as a plugin. Read this when a skill
does not load.

## A remote session does not install the plugin

Claude Code installs a marketplace plugin in a local session. A remote session
starts from a fresh container that holds no installed plugin, and `/plugin` is
not available there, so `enabledPlugins` alone does not make the skills
appear. `/grill-me` and the rest answer "Unknown command" in that session.

Use the skills from a local session. A remote session still reads this
directory, so the rules here hold either way.

`.claude/hooks/mattpocock-skills.sh` fixes this. It clones the skills into the
personal skills directory, outside the working tree, and links the skills that
upstream's `plugin.json` lists. `.claude/settings.json` does not run it yet.
The hook fetches third-party instructions on each session start, and those
instructions can change with no review, so a human decides whether to turn it
on. Add it to the SessionStart array to run it, and pin `git clone` to a
commit first to stop the content changing between sessions.
