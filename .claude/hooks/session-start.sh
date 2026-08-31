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

# Record the identity this session accepted, which is the identity the clone
# already had when it arrived with one. The pre-commit hook compares against
# these records instead of computing the expected identity a second time, so a
# clone configured with a different agent address cannot make the two scripts
# disagree and refuse every commit.
git config --local claude.expectedEmail "$(git config --get user.email)"
git config --local claude.expectedName "$(git config --get user.name)"

# `core.hooksPath` replaces the whole hook directory, so this repository keeps
# every git hook a session must run under .claude/hooks/git.
git config --local core.hooksPath .claude/hooks/git

echo "git identity: $(git config --get user.name) <$(git config --get user.email)>"

# --- embedded legal files ---------------------------------------------------
# A fresh clone cannot build the `cmd` package until the files it embeds exist.
# `tools/sync-cli-legal.sh` holds the list, and the `sync-cli-legal` mise task
# runs the same script. The task itself cannot be used here, because mise is not
# installed in the remote image.
tools/sync-cli-legal.sh

echo "synced embedded legal files for cli/cmd"
