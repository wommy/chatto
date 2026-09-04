#!/bin/bash
# Prune superseded GitHub Actions cache entries that share a key prefix with
# an entry that was just saved, so they never get old enough to matter for
# the 10GB repo cache budget (see issue #187).
#
# actions/cache keys are immutable and restore-keys only ever resolve to the
# single most-recently-created entry under a prefix. Once a newer entry
# lands under the same prefix, every older sibling becomes unreachable dead
# weight -- nothing deletes it until 7-day-unused expiry or size eviction.
# This script deletes those siblings deliberately, right after the newer
# entry is confirmed to exist.
#
# Two modes, because the two cache families give different guarantees:
#
#   exact   -- the caller knows the exact key of the entry it just saved
#              (EXPECTED_KEY). Every deletion candidate must be strictly
#              older, by createdAt, than that entry. If EXPECTED_KEY isn't
#              in the listing, nothing is deleted this run: we don't know
#              what's current, so we do nothing rather than guess.
#
#   generic -- the caller only knows a broad prefix and a regex for the
#              trailing per-generation segment to strip (GROUP_SUFFIX_RE).
#              Entries are grouped by the stripped key, and every entry
#              except the newest (by createdAt) in each group is deleted.
#              There is no independent cross-check here: recency alone says
#              which entry is current. Weaker than "exact" -- use it only
#              when the caller cannot know its own just-saved key ahead of
#              time (e.g. a third-party action that never exposes it).
#
# In both modes, a candidate is never deleted if it was accessed within the
# last MIN_IDLE_SECONDS: a job elsewhere may be mid-restore of it, and the
# next run of this script will catch it once it goes idle.
#
# Environment:
#   REPO              owner/repo (required)
#   REF               cache ref to scope to, e.g. refs/heads/main (required).
#                     Cache entries are branch-scoped; a cache from one ref
#                     is invisible to jobs on another and must never be
#                     pruned by a run that only knows about a different ref.
#   MODE              "exact" or "generic" (required)
#   KEY_PREFIX        cache key prefix to list and filter by (required)
#   EXPECTED_KEY      exact key of the entry just saved (required for
#                     MODE=exact)
#   GROUP_SUFFIX_RE   extended regex matching the trailing per-generation
#                     segment to strip when grouping keys (required for
#                     MODE=generic), e.g. '-[0-9a-f]{64}$'
#   MIN_IDLE_SECONDS  idle guard described above (default 900)
#   DRY_RUN           "true" to list and print planned deletions without
#                      calling `gh cache delete` (default "false")
#   GH_TOKEN          token `gh` uses to list/delete caches (actions:write)

set -euo pipefail

: "${REPO:?REPO is required}"
: "${REF:?REF is required}"
: "${MODE:?MODE is required (exact|generic)}"
: "${KEY_PREFIX:?KEY_PREFIX is required}"
MIN_IDLE_SECONDS="${MIN_IDLE_SECONDS:-900}"
DRY_RUN="${DRY_RUN:-false}"

case "$MODE" in
exact)
  : "${EXPECTED_KEY:?EXPECTED_KEY is required for MODE=exact}"
  ;;
generic)
  : "${GROUP_SUFFIX_RE:?GROUP_SUFFIX_RE is required for MODE=generic}"
  ;;
*)
  echo "::error::Unknown MODE '$MODE' (expected exact or generic)" >&2
  exit 1
  ;;
esac

# `date -u +%s` for "now" is portable (GNU and BSD date both support it), but
# parsing the API's ISO-8601-with-fractional-seconds timestamps is not: GNU
# `date -d` accepts them, BSD/macOS `date -j -f` does not speak that format
# without extra massaging. jq's fromdateiso8601 is portable but rejects the
# fractional seconds outright, so strip them first.
now_epoch=$(date -u +%s)

entries_json=$(gh cache list --repo "$REPO" --ref "$REF" --key "$KEY_PREFIX" --limit 100 --json id,key,createdAt,lastAccessedAt)
entries_tsv=$(jq -r '
  def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  .[] | [.id, (.createdAt | epoch), (.lastAccessedAt | epoch), .key] | @tsv
' <<<"$entries_json")

if [[ -z "$entries_tsv" ]]; then
  echo "No cache entries found for prefix '$KEY_PREFIX' on $REF."
  exit 0
fi

keep_summary=()
skip_recent=()
delete_ids=()
delete_keys=()

if [[ "$MODE" == "exact" ]]; then
  expected_epoch=""
  expected_id=""
  while IFS=$'\t' read -r id created_epoch _ key; do
    if [[ "$key" == "$EXPECTED_KEY" ]]; then
      expected_epoch="$created_epoch"
      expected_id="$id"
    fi
  done <<<"$entries_tsv"

  if [[ -z "$expected_id" ]]; then
    echo "::warning::Expected key '$EXPECTED_KEY' not found under prefix '$KEY_PREFIX' on $REF. Not pruning anything this run."
    exit 0
  fi

  keep_summary+=("$expected_id  $EXPECTED_KEY  (the entry just saved)")

  while IFS=$'\t' read -r id created_epoch last_epoch key; do
    [[ "$id" == "$expected_id" ]] && continue
    if ((created_epoch >= expected_epoch)); then
      # Not older than the entry we're protecting: a concurrent save that
      # landed at the same time or after. Never touch it.
      keep_summary+=("$id  $key  (as new or newer than the just-saved entry, kept)")
      continue
    fi
    idle=$((now_epoch - last_epoch))
    if ((idle < MIN_IDLE_SECONDS)); then
      skip_recent+=("$id  $key  (accessed ${idle}s ago, within the ${MIN_IDLE_SECONDS}s idle guard)")
      continue
    fi
    delete_ids+=("$id")
    delete_keys+=("$key")
  done <<<"$entries_tsv"
else
  declare -A group_newest_epoch=()
  declare -A group_newest_id=()

  while IFS=$'\t' read -r id created_epoch _ key; do
    group=$(sed -E "s/${GROUP_SUFFIX_RE}//" <<<"$key")
    current_best=${group_newest_epoch[$group]:-0}
    if ((created_epoch > current_best)); then
      group_newest_epoch[$group]=$created_epoch
      group_newest_id[$group]=$id
    fi
  done <<<"$entries_tsv"

  while IFS=$'\t' read -r id _ last_epoch key; do
    group=$(sed -E "s/${GROUP_SUFFIX_RE}//" <<<"$key")
    if [[ "$id" == "${group_newest_id[$group]}" ]]; then
      keep_summary+=("$id  $key  (newest in group '$group')")
      continue
    fi
    idle=$((now_epoch - last_epoch))
    if ((idle < MIN_IDLE_SECONDS)); then
      skip_recent+=("$id  $key  (accessed ${idle}s ago, within the ${MIN_IDLE_SECONDS}s idle guard)")
      continue
    fi
    delete_ids+=("$id")
    delete_keys+=("$key")
  done <<<"$entries_tsv"
fi

echo "Kept:"
printf '  %s\n' "${keep_summary[@]}"

if ((${#skip_recent[@]} > 0)); then
  echo "Skipped (recently accessed, will retry next run):"
  printf '  %s\n' "${skip_recent[@]}"
fi

{
  echo "### Cache prune ($MODE mode, prefix \`$KEY_PREFIX\`)"
  echo ""
  echo "Kept: ${#keep_summary[@]}. Skipped (recently accessed): ${#skip_recent[@]}. Deleted: ${#delete_ids[@]}."
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

if ((${#delete_ids[@]} == 0)); then
  echo "Nothing to delete."
  exit 0
fi

action_verb="Deleting"
if [[ "$DRY_RUN" == "true" ]]; then
  action_verb="Would delete (dry run)"
fi
echo "$action_verb ${#delete_ids[@]} superseded entries under prefix '$KEY_PREFIX':"
for i in "${!delete_ids[@]}"; do
  echo "  ${delete_ids[$i]}  ${delete_keys[$i]}"
done

if [[ "$DRY_RUN" == "true" ]]; then
  exit 0
fi

for id in "${delete_ids[@]}"; do
  gh cache delete "$id" --repo "$REPO"
done
