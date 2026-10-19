#!/usr/bin/env bash
# Recurring check of the Safe-to-Spend tax numbers (src/lib/setaside/taxYears/).
# Runs Claude Code headless with the job in scripts/setaside-tax-check.md.
#
#   scripts/setaside-tax-check.sh            # real run: may commit, push, deploy hosting
#   DRY_RUN=1 scripts/setaside-tax-check.sh  # check and report only
#
# Scheduled by the systemd user timer setaside-tax-check.timer. Everything is
# logged to logs/setaside-tax-check.log; the full Claude transcript for each run
# goes to logs/setaside-tax-check-<timestamp>.jsonl.
set -uo pipefail

REPO="$HOME/buildpro-plus"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

DRY_RUN="${DRY_RUN:-0}"
[[ "$DRY_RUN" == "0" || -z "$DRY_RUN" ]] && DRY_RUN=0 || DRY_RUN=1
TIMEOUT="${TIMEOUT:-90m}"
FIREBASE_PROJECT="contractors-office-96731"
DEPLOY_CMD="firebase deploy --only hosting --project $FIREBASE_PROJECT"

LOG_DIR="$REPO/logs"
LOG="$LOG_DIR/setaside-tax-check.log"
STAMP="$(date +%Y%m%d-%H%M%S)"
TRANSCRIPT="$LOG_DIR/setaside-tax-check-$STAMP.jsonl"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG") 2>&1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*"; }

# One run at a time.
exec 9>"$LOG_DIR/setaside-tax-check.lock"
if ! flock -n 9; then
  log "Another tax check is still running; exiting."
  exit 0
fi

echo
log "===== Safe-to-Spend tax check (DRY_RUN=$DRY_RUN) ====="
cd "$REPO" || { log "ERROR: can't cd to $REPO"; exit 1; }

for bin in claude node npm firebase git curl jq; do
  command -v "$bin" >/dev/null || { log "ERROR: $bin not found on PATH ($PATH)"; exit 1; }
done

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "master" ]]; then
  log "ERROR: repo is on '$branch', not master. Not running."
  exit 1
fi

# Don't run on top of someone's uncommitted work (the update log itself is fine).
dirty="$(git status --porcelain -- . ':!SETASIDE_UPDATES.md')"
if [[ -n "$dirty" ]]; then
  log "ERROR: working tree has uncommitted changes. Not running:"
  echo "$dirty"
  exit 1
fi

# After a boot or wake the network may not be up yet; wait up to 5 minutes.
for i in $(seq 1 30); do
  curl -sfI -o /dev/null --max-time 10 https://www.irs.gov && break
  [[ $i == 30 ]] && { log "ERROR: no network (irs.gov unreachable for 5 min)."; exit 1; }
  sleep 10
done

if ! git pull --ff-only --quiet origin master; then
  log "ERROR: git pull --ff-only origin master failed. Not running."
  exit 1
fi
head_before="$(git rev-parse HEAD)"

# Only what the job needs. Anything not listed is denied automatically
# (--permission-prompts none), and the deny list wins over the allow list.
allowed=(
  "Read" "Grep" "Glob" "WebSearch"
  "WebFetch(domain:irs.gov)" "WebFetch(domain:www.irs.gov)"
  "WebFetch(domain:ssa.gov)" "WebFetch(domain:www.ssa.gov)"
  "WebFetch(domain:ncdor.gov)" "WebFetch(domain:www.ncdor.gov)"
  "Edit(src/lib/setaside/taxYears/**)"
  "Edit(src/lib/setaside/*.test.ts)"
  "Edit(SETASIDE_UPDATES.md)"
  "Bash(npm test)" "Bash(npm test *)" "Bash(npm run build)"
  "Bash(git status*)" "Bash(git diff*)" "Bash(git log*)" "Bash(git show*)" "Bash(git restore*)"
  "Bash(curl *)" "Bash(pdftotext *)" "Bash(date*)"
  "Bash(grep *)" "Bash(head *)" "Bash(tail *)" "Bash(wc *)" "Bash(ls *)"
)
if [[ $DRY_RUN == 0 ]]; then
  allowed+=(
    "Bash(git add *)" "Bash(git commit *)"
    "Bash(git push)" "Bash(git push origin master)"
    "Bash($DEPLOY_CMD)"
  )
fi
denied=(
  "Edit(firestore.rules)" "Edit(storage.rules)" "Edit(firebase.json)"
  "Edit(public/.well-known/**)"
  "Bash(git push -f*)" "Bash(git push --force*)"
  "Bash(firebase deploy --only firestore*)"
)

prompt_file="$(mktemp)"
trap 'rm -f "$prompt_file"' EXIT
{
  echo "RUN CONTEXT (from scripts/setaside-tax-check.sh)"
  echo "- Today: $(date '+%A, %B %-d, %Y %H:%M %Z')"
  if [[ $DRY_RUN == 1 ]]; then
    echo "- DRY_RUN=1 is set. Check and report only: never commit, push or deploy."
    echo "  You may edit the tax year files and run the tests and build to validate a"
    echo "  proposed change; this script logs your diff and then discards it."
    echo "  Mark your SETASIDE_UPDATES.md entry as a DRY RUN."
  else
    echo "- DRY_RUN is not set. This is a real run."
    echo "- Hosting deploy command (exactly this): $DEPLOY_CMD"
    echo "- Push with: git push origin master"
  fi
  echo "- Tests: npm test. Production build: npm run build."
  echo "- www.ssa.gov answers HTTP 403 to this machine (an edge block on our IP). For the"
  echo "  Social Security wage base, confirm it on irs.gov instead: Publication 15"
  echo "  (https://www.irs.gov/publications/p15) and Tax Topic 751"
  echo "  (https://www.irs.gov/taxtopics/tc751) state it. A search-result snippet is not a"
  echo "  confirmation; the number must be on a page you actually loaded."
  echo "- A new year's file must be registered in src/lib/setaside/taxYears/index.ts"
  echo "  (import it with the .ts extension). The page copy in content.ts follows the"
  echo "  registry automatically, so it doesn't need editing."
  echo "- Permissions are pre-set; anything not allowed is denied automatically."
  echo "  If something you need is denied, stop, and log what was denied and why you"
  echo "  needed it. Don't work around it."
  echo "- End with a short plain-text report: what you checked, what changed, test"
  echo "  and build results, and whether you deployed."
  echo
  echo "JOB INSTRUCTIONS"
  cat "$REPO/scripts/setaside-tax-check.md"
} > "$prompt_file"

# --safe-mode and --setting-sources project keep out hooks, plugins, MCP servers
# and the broader allow rules in ~/.claude/settings.json.
log "Starting Claude (timeout $TIMEOUT). Transcript: $TRANSCRIPT"
timeout "$TIMEOUT" claude -p \
  --safe-mode --setting-sources project --strict-mcp-config \
  --permission-mode default --permission-prompts none \
  --no-session-persistence \
  --output-format stream-json --verbose \
  --allowedTools "${allowed[@]}" \
  --disallowedTools "${denied[@]}" \
  < "$prompt_file" > "$TRANSCRIPT"
status=$?

echo "----- Claude's report -----"
jq -r 'select(.type == "result") | .result // .subtype' "$TRANSCRIPT" 2>/dev/null \
  || echo "(no result in transcript)"
echo "---------------------------"
denials="$(jq -r 'select(.type == "result") | .permission_denials[]? | "\(.tool_name): \(.tool_input | tostring | .[0:200])"' "$TRANSCRIPT" 2>/dev/null)"
[[ -n "$denials" ]] && { log "Permission denials during the run:"; echo "$denials"; }
if [[ $status == 124 ]]; then
  log "ERROR: CLAUDE TIMED OUT AFTER $TIMEOUT."
elif [[ $status != 0 ]]; then
  log "ERROR: claude exited with status $status."
fi

# Safety nets. Commits must stay inside the tax-year area, and nothing is left
# half-done in the working tree.
head_after="$(git rev-parse HEAD)"
if [[ "$head_after" != "$head_before" ]]; then
  if [[ $DRY_RUN == 1 ]]; then
    log "WARNING: HEAD MOVED DURING A DRY RUN ($head_before -> $head_after)."
  fi
  log "New commits:"
  git log --oneline "$head_before..$head_after"
  outside="$(git diff --name-only "$head_before" "$head_after" \
    | grep -vE '^(src/lib/setaside/taxYears/|src/lib/setaside/[^/]+\.test\.ts$|SETASIDE_UPDATES\.md$)')"
  [[ -n "$outside" ]] && { log "WARNING: COMMITS TOUCHED FILES OUTSIDE THE TAX-YEAR AREA:"; echo "$outside"; }
fi

leftover="$(git status --porcelain -- . ':!SETASIDE_UPDATES.md')"
if [[ -n "$leftover" ]]; then
  if [[ $DRY_RUN == 1 ]]; then
    log "Dry-run changes (logged here, then discarded):"
  else
    log "WARNING: UNCOMMITTED CHANGES LEFT BEHIND (logged here, then discarded):"
  fi
  echo "$leftover"
  git --no-pager diff
  git restore --staged --worktree -- . ':!SETASIDE_UPDATES.md'
  git clean -fdq -- src/lib/setaside
fi

log "===== Done (claude exit $status) ====="
exit "$status"
