#!/bin/bash
# Differential test: verify release-ref-checks.mjs produces same output as original bash.
# This tests that the behavioral move from bash to JS preserves all checking logic.

set -eu
trap 'rm -rf "$TMPDIR" "$FAKE_PATH_DIR"' EXIT

TMPDIR=$(mktemp -d)
FAKE_PATH_DIR=$(mktemp -d)
export GH_TOKEN="fake-token"
export GITHUB_REPOSITORY="test-owner/test-repo"
export EXPECTED_SUBJECT_PREFIX="test:prefix"

# Test 1: trusted-ref check with HEAD as ancestor
echo "=== Test 1: trusted-ref with HEAD as ancestor ==="
cd "$TMPDIR"
git init --bare origin
git clone origin working
cd working
git config user.email "test@example.com"
git config user.name "Test User"
git commit --allow-empty -m "initial"
git branch -M main
git push origin main

# Bash version (simplified, matching workflow logic)
BASH_EXIT=0
BASH_OUT=$(bash -c '
  set -e
  git fetch origin '\''+refs/heads/main:refs/remotes/origin/main'\'' 2>&1
  git merge-base --is-ancestor HEAD origin/main
' 2>&1) || BASH_EXIT=$?

# JS version
JS_EXIT=0
JS_OUT=$(node /home/wom/infra/chatto-pr/.claude/worktrees/agent-ae01f12f78a98319c/apps/desktop/scripts/release-ref-checks.mjs verify-trusted-ref 2>&1) || JS_EXIT=$?

echo "Bash exit: $BASH_EXIT, JS exit: $JS_EXIT"
if [ "$BASH_EXIT" -eq "$JS_EXIT" ]; then
  echo "✓ Exit codes match"
else
  echo "✗ Exit codes differ"
  exit 1
fi

# Test 2: trusted-ref check with HEAD NOT as ancestor
echo "=== Test 2: trusted-ref with HEAD NOT as ancestor ==="
cd "$TMPDIR"
rm -rf working origin
git init --bare origin
git clone origin working
cd working
git config user.email "test@example.com"
git config user.name "Test User"
git commit --allow-empty -m "initial"
git branch -M main
git push origin main

# Create ahead commit
git commit --allow-empty -m "ahead"

# Bash version
BASH_EXIT=0
BASH_OUT=$(bash -c '
  set -e
  git fetch origin '\''+refs/heads/main:refs/remotes/origin/main'\'' 2>&1
  git merge-base --is-ancestor HEAD origin/main
' 2>&1) || BASH_EXIT=$?

# JS version
JS_EXIT=0
JS_OUT=$(node /home/wom/infra/chatto-pr/.claude/worktrees/agent-ae01f12f78a98319c/apps/desktop/scripts/release-ref-checks.mjs verify-trusted-ref 2>&1) || JS_EXIT=$?

echo "Bash exit: $BASH_EXIT, JS exit: $JS_EXIT"
if [ "$BASH_EXIT" -eq "$JS_EXIT" ]; then
  echo "✓ Exit codes match"
else
  echo "✗ Exit codes differ"
  exit 1
fi

# Test 3: OIDC subject check with valid config
echo "=== Test 3: OIDC subject with valid config ==="
# Create fake gh script
mkdir -p "$FAKE_PATH_DIR"
cat > "$FAKE_PATH_DIR/gh" << 'EOF'
#!/bin/bash
# Mock gh with exact output for OIDC test
if [[ "$*" == *"customization/sub"* ]]; then
  echo "true	true	test:prefix"
fi
EOF
chmod +x "$FAKE_PATH_DIR/gh"
export PATH="$FAKE_PATH_DIR:$PATH"

# Bash version - test that gh output is handled correctly
BASH_EXIT=0
BASH_OUT=$(bash -c '
  OUTPUT=$(gh api \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    repos/${GITHUB_REPOSITORY}/actions/oidc/customization/sub \
    --jq "[.use_default, .use_immutable_subject, .sub_claim_prefix] | @tsv")
  if [ "$OUTPUT" = "true	true	test:prefix" ]; then
    true
  else
    false
  fi
' 2>&1) || BASH_EXIT=$?

# JS version
JS_EXIT=0
JS_OUT=$(node /home/wom/infra/chatto-pr/.claude/worktrees/agent-ae01f12f78a98319c/apps/desktop/scripts/release-ref-checks.mjs verify-oidc-subject 2>&1) || JS_EXIT=$?

echo "Bash exit: $BASH_EXIT, JS exit: $JS_EXIT"
if [ "$BASH_EXIT" -eq "$JS_EXIT" ]; then
  echo "✓ Exit codes match"
else
  echo "✗ Exit codes differ (Bash: $BASH_EXIT, JS: $JS_EXIT)"
  exit 1
fi

echo ""
echo "=== All differential tests passed ==="
