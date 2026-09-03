#!/bin/bash
# Test harness for prune.sh.
# Stubs `gh` so no real GitHub API calls happen. `gh cache list` returns a
# canned JSON fixture; `gh cache delete <id>` records the id it was called
# with so a test can assert exactly which entries would be deleted.

set -uo pipefail

PASS=0
FAIL=0

# now - 2026-09-03T23:00:00Z, used to build fixtures relative to "now".
# Built with jq, not `date -d`/`date -j`, so this test runs the same on the
# GNU and BSD/macOS date(1) this repo's contributors actually have.
NOW_ISO="2026-09-03T23:00:00Z"
NOW_EPOCH=$(jq -n --arg t "$NOW_ISO" '$t | fromdateiso8601')

iso_minus() {
  # iso_minus <seconds ago>
  jq -n -r --argjson now "$NOW_EPOCH" --argjson delta "$1" '($now - $delta) | todateiso8601'
}

run_test() {
  local name="$1"
  local expected_exit="$2"
  local expected_deleted_csv="$3" # comma-separated ids, sorted, or "" for none
  local list_json="$4"
  shift 4
  # Remaining args are extra env assignments, e.g. MODE=exact EXPECTED_KEY=foo

  echo "Testing: $name"

  local test_dir
  test_dir="$(cd "$(dirname "$0")" && pwd)"

  local wrapper deleted_log
  wrapper=$(mktemp)
  deleted_log=$(mktemp)
  trap 'rm -f "$wrapper" "$deleted_log"' RETURN

  cat >"$wrapper" <<'WRAPPER_EOF'
#!/bin/bash
set -euo pipefail

# shellcheck disable=SC2317
gh() {
  if [[ "$1" == "cache" && "$2" == "list" ]]; then
    echo "$STUB_GH_LIST_JSON"
    return 0
  fi
  if [[ "$1" == "cache" && "$2" == "delete" ]]; then
    echo "$3" >>"$STUB_DELETED_LOG"
    return 0
  fi
  echo "unexpected gh invocation: $*" >&2
  return 1
}

# prune.sh's only date(1) call is `date -u +%s` for "now" (every timestamp
# it parses goes through jq's fromdateiso8601 instead, for portability).
# Fake just that one call so idle-guard math is deterministic.
date() {
  if [[ "$1" == "-u" && "$2" == "+%s" ]]; then
    echo "$STUB_NOW_EPOCH"
    return 0
  fi
  echo "unexpected date invocation: $*" >&2
  return 1
}

source "$STUB_PRUNE_SCRIPT"
WRAPPER_EOF
  chmod +x "$wrapper"

  export STUB_PRUNE_SCRIPT="$test_dir/prune.sh"
  export STUB_GH_LIST_JSON="$list_json"
  export STUB_DELETED_LOG="$deleted_log"
  export STUB_NOW_EPOCH="$NOW_EPOCH"
  export REPO="wommy/chatto"
  export REF="refs/heads/main"
  export GITHUB_STEP_SUMMARY="/tmp/prune-step-summary-$$"
  : >"$GITHUB_STEP_SUMMARY"

  # Reset mode-specific env between tests, then apply this test's overrides.
  unset MODE EXPECTED_KEY GROUP_SUFFIX_RE KEY_PREFIX MIN_IDLE_SECONDS DRY_RUN || true
  for assignment in "$@"; do
    export "${assignment?}"
  done

  actual_exit=0
  bash "$wrapper" >/tmp/prune-test-out-$$ 2>&1 || actual_exit=$?

  actual_deleted_csv=$(sort -n "$deleted_log" 2>/dev/null | paste -sd, -)

  rm -f "$GITHUB_STEP_SUMMARY" "/tmp/prune-test-out-$$"

  local ok=1
  if [[ "$actual_exit" != "$expected_exit" ]]; then
    echo "  x exit code: expected $expected_exit, got $actual_exit"
    ok=0
  fi
  if [[ "$actual_deleted_csv" != "$expected_deleted_csv" ]]; then
    echo "  x deleted ids: expected [$expected_deleted_csv], got [$actual_deleted_csv]"
    ok=0
  fi

  if [[ "$ok" == "1" ]]; then
    echo "  v exit $actual_exit, deleted [$actual_deleted_csv]"
    ((PASS++))
  else
    ((FAIL++))
  fi
}

# --- exact mode fixtures --------------------------------------------------

# Three entries sharing a prefix: the just-saved one (newest), and two
# strictly older siblings, all idle well past the default guard.
EXACT_THREE=$(cat <<JSON
[
  {"id": 1, "key": "go-build-Linux-X64-abc-newest", "createdAt": "$(iso_minus 60)", "lastAccessedAt": "$(iso_minus 60)"},
  {"id": 2, "key": "go-build-Linux-X64-abc-older1", "createdAt": "$(iso_minus 6000)", "lastAccessedAt": "$(iso_minus 6000)"},
  {"id": 3, "key": "go-build-Linux-X64-abc-older2", "createdAt": "$(iso_minus 7000)", "lastAccessedAt": "$(iso_minus 7000)"}
]
JSON
)

run_test \
  "exact: expected key present, deletes only strictly older siblings" \
  0 "2,3" "$EXACT_THREE" \
  MODE=exact EXPECTED_KEY=go-build-Linux-X64-abc-newest KEY_PREFIX=go-build-Linux-X64-abc- MIN_IDLE_SECONDS=900

run_test \
  "exact: expected key absent, deletes nothing (fail safe)" \
  0 "" "$EXACT_THREE" \
  MODE=exact EXPECTED_KEY=go-build-Linux-X64-abc-does-not-exist KEY_PREFIX=go-build-Linux-X64-abc- MIN_IDLE_SECONDS=900

# A concurrent run saved an even newer entry under the same prefix after
# ours; refuse to touch it, but still clean up what's strictly older than
# the entry we were told about.
EXACT_CONCURRENT_NEWER=$(cat <<JSON
[
  {"id": 4, "key": "go-build-Linux-X64-abc-concurrent-newer", "createdAt": "$(iso_minus 30)", "lastAccessedAt": "$(iso_minus 30)"},
  {"id": 1, "key": "go-build-Linux-X64-abc-newest", "createdAt": "$(iso_minus 60)", "lastAccessedAt": "$(iso_minus 60)"},
  {"id": 2, "key": "go-build-Linux-X64-abc-older1", "createdAt": "$(iso_minus 6000)", "lastAccessedAt": "$(iso_minus 6000)"}
]
JSON
)

run_test \
  "exact: never deletes an entry as new or newer than the expected one" \
  0 "2" "$EXACT_CONCURRENT_NEWER" \
  MODE=exact EXPECTED_KEY=go-build-Linux-X64-abc-newest KEY_PREFIX=go-build-Linux-X64-abc- MIN_IDLE_SECONDS=900

# Single entry: nothing older exists, nothing to delete.
EXACT_SINGLE=$(cat <<JSON
[
  {"id": 1, "key": "go-build-Linux-X64-abc-newest", "createdAt": "$(iso_minus 60)", "lastAccessedAt": "$(iso_minus 60)"}
]
JSON
)

run_test \
  "exact: only entry present is the expected one, deletes nothing" \
  0 "" "$EXACT_SINGLE" \
  MODE=exact EXPECTED_KEY=go-build-Linux-X64-abc-newest KEY_PREFIX=go-build-Linux-X64-abc- MIN_IDLE_SECONDS=900

# Older sibling was accessed moments ago -- a job may be mid-restore.
# Skip it this run; only the entry idle past the guard gets deleted.
EXACT_RECENT_ACCESS=$(cat <<JSON
[
  {"id": 1, "key": "go-build-Linux-X64-abc-newest", "createdAt": "$(iso_minus 60)", "lastAccessedAt": "$(iso_minus 60)"},
  {"id": 2, "key": "go-build-Linux-X64-abc-older-recently-read", "createdAt": "$(iso_minus 6000)", "lastAccessedAt": "$(iso_minus 30)"},
  {"id": 3, "key": "go-build-Linux-X64-abc-older-idle", "createdAt": "$(iso_minus 7000)", "lastAccessedAt": "$(iso_minus 7000)"}
]
JSON
)

run_test \
  "exact: skips a recently-accessed older sibling, deletes the idle one" \
  0 "3" "$EXACT_RECENT_ACCESS" \
  MODE=exact EXPECTED_KEY=go-build-Linux-X64-abc-newest KEY_PREFIX=go-build-Linux-X64-abc- MIN_IDLE_SECONDS=900

run_test \
  "exact: empty listing deletes nothing" \
  0 "" "[]" \
  MODE=exact EXPECTED_KEY=go-build-Linux-X64-abc-newest KEY_PREFIX=go-build-Linux-X64-abc- MIN_IDLE_SECONDS=900

run_test \
  "exact: dry run reports without deleting" \
  0 "" "$EXACT_THREE" \
  MODE=exact EXPECTED_KEY=go-build-Linux-X64-abc-newest KEY_PREFIX=go-build-Linux-X64-abc- MIN_IDLE_SECONDS=900 DRY_RUN=true

# --- generic mode fixtures ------------------------------------------------

# Three platform groups, two generations each (an old and a new tool-hash,
# both a bare 64-hex-char sha256, matching the real key shape), all idle.
# Exactly the older generation in each group should be deleted.
HASH_A_NEW="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HASH_A_OLD="111111111111111111111111111111111111111111111111111111111111111a"
HASH_B_NEW="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
HASH_B_OLD="222222222222222222222222222222222222222222222222222222222222222b"
HASH_C_NEW="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
HASH_C_OLD="333333333333333333333333333333333333333333333333333333333333333c"
GENERIC_THREE_GROUPS=$(cat <<JSON
[
  {"id": 11, "key": "mise-v1-linux-x64-ubuntu24-2026.9.0-$HASH_A_NEW", "createdAt": "$(iso_minus 60)", "lastAccessedAt": "$(iso_minus 60)"},
  {"id": 12, "key": "mise-v1-linux-x64-ubuntu24-2026.9.0-$HASH_A_OLD", "createdAt": "$(iso_minus 6000)", "lastAccessedAt": "$(iso_minus 6000)"},
  {"id": 21, "key": "mise-v1-macos-arm64-macos15-2026.9.0-$HASH_B_NEW", "createdAt": "$(iso_minus 70)", "lastAccessedAt": "$(iso_minus 70)"},
  {"id": 22, "key": "mise-v1-macos-arm64-macos15-2026.9.0-$HASH_B_OLD", "createdAt": "$(iso_minus 7000)", "lastAccessedAt": "$(iso_minus 7000)"},
  {"id": 31, "key": "mise-v1-windows-x64-win25-vs2026-2026.9.0-$HASH_C_NEW", "createdAt": "$(iso_minus 80)", "lastAccessedAt": "$(iso_minus 80)"},
  {"id": 32, "key": "mise-v1-windows-x64-win25-vs2026-2026.9.0-$HASH_C_OLD", "createdAt": "$(iso_minus 8000)", "lastAccessedAt": "$(iso_minus 8000)"}
]
JSON
)

run_test \
  "generic: three groups, deletes exactly the older generation in each" \
  0 "12,22,32" "$GENERIC_THREE_GROUPS" \
  MODE=generic 'GROUP_SUFFIX_RE=-[0-9a-f]{64}$' KEY_PREFIX=mise-v1- MIN_IDLE_SECONDS=900

run_test \
  "generic: empty listing deletes nothing" \
  0 "" "[]" \
  MODE=generic 'GROUP_SUFFIX_RE=-[0-9a-f]{64}$' KEY_PREFIX=mise-v1- MIN_IDLE_SECONDS=900

# A lone entry in its own group: nothing older to delete.
GENERIC_SINGLE=$(cat <<JSON
[
  {"id": 11, "key": "mise-v1-linux-x64-ubuntu24-2026.9.0-$HASH_A_NEW", "createdAt": "$(iso_minus 60)", "lastAccessedAt": "$(iso_minus 60)"}
]
JSON
)

run_test \
  "generic: single entry, deletes nothing" \
  0 "" "$GENERIC_SINGLE" \
  MODE=generic 'GROUP_SUFFIX_RE=-[0-9a-f]{64}$' KEY_PREFIX=mise-v1- MIN_IDLE_SECONDS=900

# --- validation ------------------------------------------------------------

run_test \
  "rejects an unknown mode" \
  1 "" "[]" \
  MODE=bogus KEY_PREFIX=x-

run_test \
  "exact mode requires EXPECTED_KEY" \
  1 "" "[]" \
  MODE=exact KEY_PREFIX=x-

run_test \
  "generic mode requires GROUP_SUFFIX_RE" \
  1 "" "[]" \
  MODE=generic KEY_PREFIX=x-

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
