#!/usr/bin/env bash
# Rehearse the coordinated release on a LOCAL copy of production data.
#
#   node scripts/backup-firestore.mjs --project contractors-office-96731   # read-only
#   scripts/rehearsal/rehearse-release.sh ~/buildpro-backups/firestore-….json [--with-old-app]
#
# Loads the backup into a Firestore emulator (project demo-rehearsal, its own
# ports), then plays G3 → G6 → G7 and the 2.5 restore with the real scripts and
# the real share pages, checking each step (release-rehearsal.spec.ts).
# --with-old-app also runs the app that is live today (tag
# checkpoint/pre-audit-2026-11-10) to check the G3→G5 window and a hosting
# rollback. Nothing here talks to the live project. Output: counts only, in
# $REHEARSAL_OUT/report.txt (default: a new owner-only folder under /tmp).
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $# -ge 1 && -f "$1" ]] || { echo "Usage: $0 <full-backup.json> [--with-old-app]" >&2; exit 2; }

export REHEARSAL_BACKUP="$(realpath "$1")"
export REHEARSAL_OUT="${REHEARSAL_OUT:-$(mktemp -d /tmp/bp-rehearsal-XXXXXX)}"
mkdir -p "$REHEARSAL_OUT" && chmod 700 "$REHEARSAL_OUT"
unset FIRESTORE_EMULATOR_HOST

if [[ "${2:-}" == "--with-old-app" ]]; then
  OLD="$REHEARSAL_OUT/old-app"
  git worktree add --detach "$OLD" checkpoint/pre-audit-2026-11-10 >/dev/null
  trap 'git worktree remove --force "$OLD" >/dev/null 2>&1 || true' EXIT
  # The old app plus only what lets a dev server point it at the emulator.
  cp src/firebase.ts "$OLD/src/firebase.ts"
  mkdir -p "$OLD/e2e" && cp -r e2e/stubs e2e/vite.e2e.config.ts "$OLD/e2e/"
  (cd "$OLD" && npm ci --no-audit --no-fund --loglevel=error)
  export REHEARSAL_OLD_APP_DIR="$OLD"
fi

# The rehearsal's own copies of real data (emulator backups, 2.5 backups, a
# failure's page snapshot) go when it ends; only the report (counts) stays.
cleanup_data() { rm -rf "$REHEARSAL_OUT"/buildpro-rehearsal-* "$REHEARSAL_OUT/playwright"; }

rc=0
npx firebase emulators:exec --config scripts/rehearsal/firebase.rehearsal.json --only firestore --project demo-rehearsal \
  "npx playwright test --config scripts/rehearsal/playwright.rehearsal.config.ts" || rc=$?
cleanup_data
echo "Report: $REHEARSAL_OUT/report.txt"
exit $rc
