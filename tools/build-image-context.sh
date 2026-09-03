#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 ChattoCorp GmbH
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Assemble Docker image context: copy support files and build Chatto binary.
#
# Environment variables (required):
#   GOOS, GOARCH     — Go build target OS and architecture
#   VERSION          — Version string embedded in binary (e.g. v0.5.0)
#   CONTEXT_DIR      — Output directory for assembled context
#
# Environment variables (optional):
#   DUMMY_BINARY     — If "1", use a dummy binary instead of building (for Dockerfile checks)
#
# This script holds the canonical list of files copied into the Docker context.
# ci.yml, release.yml, and verify-docker all use this script to ensure they
# assemble the same context byte-for-byte.
#
# The script finds the repository from its own location. Thus it gives the same
# result from each working directory.

set -euo pipefail

# Files to copy into the context. Each entry is `<source>|<context_path>`.
# Paths are relative to the repository root; context paths are relative to CONTEXT_DIR.
# Sources must stay byte-identical to the destination.
copies=(
	"docker/Dockerfile.goreleaser|Dockerfile"
	"docker/docker-entrypoint.sh|docker/docker-entrypoint.sh"
	"docker/nats-wrapper.sh|docker/nats-wrapper.sh"
	"LICENSES/AGPL-3.0-or-later.txt|LICENSES/AGPL-3.0-or-later.txt"
	"NOTICE|NOTICE"
)

# Handle --list-extra-files mode (prints the four non-Dockerfile files copied to context)
if [ "${1:-}" = "--list-extra-files" ]; then
	for copy in "${copies[@]}"; do
		source="${copy%%|*}"
		# Skip the Dockerfile; only list the support files that go in extra_files
		if [ "$source" != "docker/Dockerfile.goreleaser" ]; then
			printf '%s\n' "$source"
		fi
	done
	exit 0
fi

# Validate environment variables
if [ -z "${GOOS:-}" ] || [ -z "${GOARCH:-}" ] || [ -z "${VERSION:-}" ] || [ -z "${CONTEXT_DIR:-}" ]; then
	echo "Missing required environment variables: GOOS, GOARCH, VERSION, CONTEXT_DIR" >&2
	exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mkdir -p "$CONTEXT_DIR"
context_dir="$(cd "$CONTEXT_DIR" && pwd -P)"

# Copy files to the context.
for copy in "${copies[@]}"; do
	source_file="$repository_root/${copy%%|*}"
	destination_file="$context_dir/${copy##*|}"

	if [ ! -f "$source_file" ]; then
		echo "missing file: $source_file" >&2
		exit 1
	fi

	mkdir -p "$(dirname "$destination_file")"
	cp "$source_file" "$destination_file"
done

# Build the Chatto binary or use a dummy. The nomsgpack tag is included in every
# build; see mise.toml's Build section for the rationale.
if [ "${DUMMY_BINARY:-}" = "1" ]; then
	printf '#!/bin/sh\necho chatto dummy\n' > "$context_dir/chatto"
	chmod +x "$context_dir/chatto"
else
	(
		cd "$repository_root/cli"
		CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build -trimpath \
			-tags=nomsgpack \
			-ldflags="-s -w -X main.Version=$VERSION" \
			-o "$context_dir/chatto" .
	)
fi

# Output the context directory for the caller.
echo "$context_dir"
