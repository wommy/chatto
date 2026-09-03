#!/usr/bin/env bash
# SessionStart hook: make Matt Pocock's skills available in a remote session.
#
# `.claude/settings.json` enables the `mattpocock-skills` marketplace plugin,
# and a local session installs it. A remote session starts from a fresh
# container that installs no plugin, so the skills are missing there. This hook
# fetches them into the personal skills directory, which is outside the
# repository, so the clone never reaches the working tree.
set -euo pipefail

# A local clone already has the plugin. Leave it alone.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

repo="https://github.com/mattpocock/skills.git"
src="${HOME}/.claude/mattpocock-skills"
dest="${HOME}/.claude/skills"

# A failure here must not stop the session. The skills are a convenience, and
# the rest of the hook chain still has to run.
if [ -d "$src/.git" ]; then
  git -C "$src" fetch --depth 1 --quiet origin HEAD 2>/dev/null || true
  git -C "$src" reset --hard --quiet FETCH_HEAD 2>/dev/null || true
elif ! git clone --depth 1 --quiet "$repo" "$src" 2>/dev/null; then
  echo "mattpocock skills: fetch failed, skills unavailable this session"
  exit 0
fi

# `plugin.json` lists the skills that upstream ships. Link each one into the
# personal skills directory under its own name, which is the name the skills
# use when they call each other.
mkdir -p "$dest"
count=0
while IFS= read -r rel; do
  name="$(basename "$rel")"
  target="$src/${rel#./}"
  [ -f "$target/SKILL.md" ] || continue
  ln -sfn "$target" "$dest/$name"
  count=$((count + 1))
done < <(python3 -c "
import json, sys
for s in json.load(open(sys.argv[1]))['skills']:
    print(s)
" "$src/.claude-plugin/plugin.json")

echo "mattpocock skills: $count available at $(git -C "$src" rev-parse --short HEAD)"
