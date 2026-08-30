#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
#
# Prepares the two things a fresh remote clone does not have: an enforced agent
# git identity, and the legal files that `cli/cmd` embeds at build time.
set -euo pipefail

# Local clones are left alone. A contributor keeps their own git identity, their
# own hooks, and their own working state.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# --- git identity -----------------------------------------------------------
# The clone normally arrives configured to commit as the agent, but a session
# that overrides the identity produces commits attributed to a person, which
# GitHub shows as Unverified. Set the identity when it is missing, then install
# a pre-commit hook that rejects a commit made under a different address.
agent_email="${CLAUDE_GIT_AUTHOR_EMAIL:-noreply@anthropic.com}"
agent_name="${CLAUDE_GIT_AUTHOR_NAME:-Claude}"

if [ -z "$(git config --local --get user.email || true)" ]; then
  git config --local user.email "$agent_email"
fi
if [ -z "$(git config --local --get user.name || true)" ]; then
  git config --local user.name "$agent_name"
fi

# `core.hooksPath` replaces the whole hook directory, so this repository keeps
# every git hook a session must run under .claude/hooks/git.
git config --local core.hooksPath .claude/hooks/git

echo "git identity: $(git config --get user.name) <$(git config --get user.email)>"

# --- embedded legal files ---------------------------------------------------
# `cli/cmd/embedded/` is git-ignored, and `cli/cmd/license.go` embeds LICENSE
# and NOTICE from it, so a fresh clone fails to build the `cmd` package with
# "pattern embedded/LICENSE: no matching files found". This mirrors the
# `sync-cli-legal` mise task, which cannot be used here because mise is not
# installed in the remote image.
mkdir -p cli/cmd/embedded
cp LICENSES/AGPL-3.0-or-later.txt cli/LICENSE
cp NOTICE cli/NOTICE
cp LICENSES/AGPL-3.0-or-later.txt cli/cmd/embedded/LICENSE
cp NOTICE cli/cmd/embedded/NOTICE

echo "synced embedded legal files for cli/cmd"
