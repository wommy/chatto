#!/bin/bash
# Guard script: prevent silent downgrade of multi-platform manifests.
# Environment: IMAGE (image reference), PLATFORMS_TO_PUSH (comma-separated).

set -euo pipefail

err="${RUNNER_TEMP:-.}/guard-inspect.err"

# Fetch the current manifest from the registry.
# Use --raw to get unprocessed JSON directly from the registry.
# Capture stderr separately to avoid corrupting JSON if buildx emits warnings.
if ! MANIFEST_JSON=$(docker buildx imagetools inspect --raw "$IMAGE" 2>"$err"); then
  # Check if this is a "tag not found" error (safe to push).
  if grep -qiE 'not found|manifest unknown' "$err"; then
    echo "Tag does not exist in registry (safe to push)"
    exit 0
  fi
  # Any other error (auth, network, etc.) is a failure.
  echo "::error::Failed to inspect manifest for $IMAGE"
  cat "$err"
  exit 1
fi

# Extract existing real platforms from the manifest (filter out attestations and entries without platform).
# Bare manifests have no .manifests array, so jq returns empty.
EXISTING_PLATFORMS=$(jq -r 'if .manifests then (.manifests[] | select(.platform != null and .platform.os != "unknown") | "\(.platform.os)/\(.platform.architecture)") else empty end' <<<"$MANIFEST_JSON" | sort)

# If no existing platforms found, manifest is bare or doesn't have index structure.
# This is safe to push over (no multi-platform to degrade).
if [[ -z "$EXISTING_PLATFORMS" ]]; then
  echo "Tag is bare manifest or has no real platforms (safe to push)"
  exit 0
fi

# Parse platforms being pushed.
IFS=',' read -ra PUSH_ARRAY <<< "$PLATFORMS_TO_PUSH"
PUSH_PLATFORMS=$(printf '%s\n' "${PUSH_ARRAY[@]}" | sort)

# Format platforms for display.
existing_line=$(echo "$EXISTING_PLATFORMS" | tr '\n' ' ')
push_line=$(echo "$PUSH_PLATFORMS" | tr '\n' ' ')

# Check for any existing platform not in the new push (set difference).
DROPPED=$(comm -23 <(echo "$EXISTING_PLATFORMS") <(echo "$PUSH_PLATFORMS")) || true

if [[ -n "$DROPPED" ]]; then
  dropped_line=$(echo "$DROPPED" | tr '\n' ' ')
  echo "::error::Cannot push $PLATFORMS_TO_PUSH: would downgrade multi-platform manifest"
  echo "Existing platforms in $IMAGE:"
  echo "$EXISTING_PLATFORMS" | sed 's/^/  /'
  echo "Platforms to push:"
  echo "$PUSH_PLATFORMS" | sed 's/^/  /'
  echo "Platforms that would be dropped:"
  echo "$DROPPED" | sed 's/^/  /'
  echo ""
  echo "This guards against silent degradation of the published image."
  echo "If you need to update the tag, ensure the new push includes all existing platforms or use a new tag."
  {
    echo "### Build Image Guard Failed"
    echo ""
    echo "The manifest at **\`$IMAGE\`** already exists as multi-platform:"
    echo "- Existing: $existing_line"
    echo "- Push includes: $push_line"
    echo "- Would drop: $dropped_line"
    echo ""
    echo "This prevents silent downgrade to $PLATFORMS_TO_PUSH."
  } >> "$GITHUB_STEP_SUMMARY"
  exit 1
fi

echo "Manifest guard passed: platforms match existing or tag doesn't exist yet"
{
  echo "### Build Image Guard Passed"
  echo ""
  echo "Tag **\`$IMAGE\`** is safe to push:"
  echo "- Existing platforms: $existing_line"
  echo "- Push includes: $push_line"
} >> "$GITHUB_STEP_SUMMARY"
