#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 ChattoCorp GmbH
# SPDX-License-Identifier: AGPL-3.0-or-later

# Copy the root legal files into the CLI module for go:embed.
#
# `cli/cmd/embedded/` is git-ignored, and `cli/cmd/license.go` embeds LICENSE
# and NOTICE from it, so a fresh clone fails to build the `cmd` package with
# "pattern embedded/LICENSE: no matching files found".
#
# The `sync-cli-legal` mise task and the SessionStart hook in `.claude/hooks/`
# both run this script, so the list of embedded files has one home. The hook
# cannot use the mise task, because mise is not installed in the remote image.
#
# The script finds the repository through its own path, so it gives the same
# result from any working directory.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p cli/cmd/embedded
cp LICENSES/AGPL-3.0-or-later.txt cli/LICENSE
cp NOTICE cli/NOTICE
cp LICENSES/AGPL-3.0-or-later.txt cli/cmd/embedded/LICENSE
cp NOTICE cli/cmd/embedded/NOTICE
