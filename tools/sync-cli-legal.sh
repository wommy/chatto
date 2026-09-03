#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 ChattoCorp GmbH
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Copy the root legal files into the CLI module.
#
# `cli/cmd/license.go` embeds `embedded/LICENSE` and `embedded/NOTICE` with
# `go:embed`. Git ignores `cli/cmd/embedded/`. Thus a new clone does not have
# these files, and `go build ./cmd` fails with
# `pattern embedded/LICENSE: no matching files found`.
#
# This script holds the only list of the legal files that `cli/cmd` embeds. The
# `sync-cli-legal` mise task and the SessionStart hook both run this script, thus
# the task and the hook cannot disagree.
#
# The script finds the repository from its own location. Thus it gives the same
# result from each working directory. The script is idempotent: it writes a
# destination file only when the contents are different.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# The legal files to copy. Each entry is `<source>|<destination>`. The paths are
# relative to the repository root. The destination must stay byte-identical to
# the source.
copies=(
	"LICENSES/AGPL-3.0-or-later.txt|cli/LICENSE"
	"NOTICE|cli/NOTICE"
	"LICENSES/AGPL-3.0-or-later.txt|cli/cmd/embedded/LICENSE"
	"NOTICE|cli/cmd/embedded/NOTICE"
)

for copy in "${copies[@]}"; do
	source_file="$repository_root/${copy%%|*}"
	destination_file="$repository_root/${copy##*|}"

	if [[ ! -f "$source_file" ]]; then
		echo "missing legal source file: $source_file" >&2
		exit 1
	fi

	mkdir -p "$(dirname "$destination_file")"

	# Keep the file as it is when the contents agree. This makes a second run do
	# no work, and it keeps the modification time stable for the build cache.
	if cmp -s "$source_file" "$destination_file"; then
		continue
	fi

	cp "$source_file" "$destination_file"
done
