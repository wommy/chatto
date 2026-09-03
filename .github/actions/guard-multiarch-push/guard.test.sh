#!/bin/bash
# Comprehensive test harness for guard.sh.
# Exercises all code paths by stubbing docker.

set -uo pipefail

# Test counter
PASS=0
FAIL=0

# Fixture: multi-platform manifest (amd64 + arm64 + attestations)
MULTI_PLATFORM_MANIFEST='{"manifests":[{"platform":{"os":"linux","architecture":"amd64"},"digest":"sha256:abc123"},{"platform":{"os":"linux","architecture":"arm64"},"digest":"sha256:def456"},{"platform":{"os":"unknown"},"digest":"sha256:ghi789"}]}'

# Fixture: single-platform manifest (amd64 only + attestation)
SINGLE_PLATFORM_MANIFEST='{"manifests":[{"platform":{"os":"linux","architecture":"amd64"},"digest":"sha256:abc123"},{"platform":{"os":"unknown"},"digest":"sha256:ghi789"}]}'

# Fixture: bare manifest (no .manifests array)
BARE_MANIFEST='{"config":{"digest":"sha256:abc123"}}'

run_test() {
  local name="$1"
  local expected_exit="$2"
  local image_var="$3"
  local platforms_var="$4"
  local docker_result="$5"
  local docker_stderr="$6"
  local manifest_json="$7"

  echo "Testing: $name"

  local test_dir
  test_dir="$(dirname "$0")"

  # Create a temporary wrapper script that defines the stub docker and calls guard.sh.
  local wrapper
  wrapper=$(mktemp)
  trap 'rm -f "$wrapper"' RETURN

  cat > "$wrapper" << 'WRAPPER_EOF'
#!/bin/bash
set -euo pipefail

# Import stub parameters from environment.
# shellcheck disable=SC2154
docker() {
  if [[ "$STUB_DOCKER_RESULT" == "0" ]]; then
    echo "$STUB_DOCKER_MANIFEST"
    return 0
  else
    echo "$STUB_DOCKER_STDERR" >&2
    return "$STUB_DOCKER_RESULT"
  fi
}

# Source and execute guard.sh.
source "$STUB_GUARD_SCRIPT"
WRAPPER_EOF

  chmod +x "$wrapper"

  # Run the wrapper with stub parameters in environment.
  export STUB_GUARD_SCRIPT="$test_dir/guard.sh"
  export STUB_DOCKER_RESULT="$docker_result"
  export STUB_DOCKER_STDERR="$docker_stderr"
  export STUB_DOCKER_MANIFEST="$manifest_json"
  export IMAGE="$image_var"
  export PLATFORMS_TO_PUSH="$platforms_var"
  export RUNNER_TEMP="/tmp/guard-test-$$"
  export GITHUB_STEP_SUMMARY="/tmp/guard-step-summary-$$"
  mkdir -p "$RUNNER_TEMP"
  touch "$GITHUB_STEP_SUMMARY"

  actual_exit=0
  bash "$wrapper" >/dev/null 2>&1 || actual_exit=$?

  # Clean up temp files.
  rm -rf "$RUNNER_TEMP" "$GITHUB_STEP_SUMMARY"

  # Check exit code.
  if [[ "$actual_exit" == "$expected_exit" ]]; then
    echo "  ✓ exit code: $actual_exit"
    ((PASS++))
  else
    echo "  ✗ exit code: expected $expected_exit, got $actual_exit"
    ((FAIL++))
  fi
}

# Test 1: Multi-platform manifest, single-platform push → FAIL
run_test \
  "multi-platform exists, single-platform push (amd64 only)" \
  1 \
  "ghcr.io/chattocorp/chatto:sha256" \
  "linux/amd64" \
  0 \
  "" \
  "$MULTI_PLATFORM_MANIFEST"

# Test 2: Multi-platform manifest, multi-platform push (all platforms) → PASS
run_test \
  "multi-platform exists, multi-platform push (all)" \
  0 \
  "ghcr.io/chattocorp/chatto:sha256" \
  "linux/amd64,linux/arm64" \
  0 \
  "" \
  "$MULTI_PLATFORM_MANIFEST"

# Test 3: Single-platform manifest, single-platform push → PASS
run_test \
  "single-platform exists, single-platform push" \
  0 \
  "ghcr.io/chattocorp/chatto:sha256" \
  "linux/amd64" \
  0 \
  "" \
  "$SINGLE_PLATFORM_MANIFEST"

# Test 4: Bare manifest → PASS (no platforms to degrade)
run_test \
  "bare manifest, single-platform push" \
  0 \
  "ghcr.io/chattocorp/chatto:sha256" \
  "linux/amd64" \
  0 \
  "" \
  "$BARE_MANIFEST"

# Test 5: Tag not found (safe to push) → PASS
run_test \
  "tag not found error, single-platform push" \
  0 \
  "ghcr.io/chattocorp/chatto:nonexistent" \
  "linux/amd64" \
  1 \
  "manifest unknown" \
  ""

# Test 6: Real error (auth/network) not "not found" → FAIL
run_test \
  "auth error, single-platform push" \
  1 \
  "ghcr.io/chattocorp/chatto:sha256" \
  "linux/amd64" \
  1 \
  "unauthorized: authentication required" \
  ""

# Report.
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
