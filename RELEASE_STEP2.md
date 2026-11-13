# BuildPro+ coordinated release (step 2, the data cleanup, and step 3)

Runbook for releasing branch `audit/2026-11-modernization` as **one sitting**,
so production is never left half-secured: the new app, the customer-safe
copies, the estimate cleanup and the final rules all go out together.
Nothing here is done without the owner's explicit approval at each gate (**G1**
to **G8**). Step 1 (urgent Firestore rules, tag `rules/stage1-urgent`) went
live on 2026-11-12.

Project: `contractors-office-96731`. Site: https://builderspro.cc.
Run every command from the repo root (`~/chris workspace/buildpro+`). Add
`--project contractors-office-96731` to every `firebase` command. Allow about
an hour; pick a quiet time (evening), since contractors with the app open
during the switch see the rollout effects listed under Risks.

## What this release closes

Checked signed-out against production on 2026-11-12
(`scripts/verify-public-access.mjs`, read-only):

| Exposure (anyone holding or guessing a link) | Today | Closed by |
|---|---|---|
| `users/{id}`: contractor plan, Stripe customer/subscription/Connect ids, usage | OPEN | step 3 (after 2.4) |
| `customers/{id}`: customer phone, address, private notes | OPEN | step 3 (after 2.4) |
| `customerPhotos`: every photo record listable | OPEN | step 3 (after 2.4) |
| Estimates hand over the contractor's private notes, markup %/$/reasoning, cost-price lines and subtotals, and a Quick Quote's spoken walkthrough (17 of 18 estimates) | LEAKING | rules in 2.1 stop new ones; 2.5 cleans the 17 |

## What is live now (the rollback targets)

Verified against the live project on 2026-11-12 with
`node scripts/snapshot-live-config.mjs --project contractors-office-96731`
(saved under `~/buildpro-backups/live-…/`, configuration only):

| Piece | Live version | Restore with |
|---|---|---|
| Firestore rules | ruleset 10ce3890 = tag `rules/stage1-urgent` | deploy `firestore.rules` from that tag |
| Storage rules | ruleset 950106a0 = tag `checkpoint/pre-audit-2026-11-10` | deploy `storage.rules` from that tag |
| Functions | 28, Node 24, ACTIVE; same 28 names as the release | deploy `functions/` from `checkpoint/pre-audit-2026-11-10` (build verified 2026-11-12) |
| Hosting | version `3d61eede8445e201` (2026-10-19) | `npx firebase hosting:clone contractors-office-96731@3d61eede8445e201 contractors-office-96731:live` |
| Git | `master` = `origin/master` = `b28265f` = tag `checkpoint/pre-audit-2026-11-10` | leave it; never force-push `master` |

## Preflight of 2026-11-13: D1 and signed prices (nothing in production was changed)

- Candidate: tag `release/d1-candidate` = `release/preflight-candidate` plus
  D1 (labor-only rate), signed estimates keeping their signed prices, the
  editor keeping quoted prices, encrypted backups, and the checks below.
  `master` = `origin/master` = `b28265f`; nothing merged, pushed or deployed.
  Tests: unit 117, rules 116, functions 42, browser 40 (315) all pass; lint
  and both builds clean.
- Live project re-read (read-only): rules, storage, hosting and functions as
  in the table above; 0 errors in the logs over 24 hours. Fresh full backup
  (encrypted): 210 documents; against the 2026-11-12 copy no estimate,
  invoice, change order, customer, project or photo changed (only AI-advisor
  usage counters and one new property-advisor session, whose rules are the
  same in all three stages). Dry runs: 8 cards + 1 photo log; 17 estimates to
  clean (6 signed), 0 failures; printed prices as listed under G6.
- Rehearsal on that backup, with the app live today: every check passed up
  to and including G7 (the restore drill was not reached: the machine ran out
  of memory and the run was stopped). New this time, run in each app's own
  code: signed estimates' print-out (full HTML) and email prices identical in
  the app live today and the new app, 6 of 6, at G5, after the cleanup, and
  under a hosting rollback; the cleanup changes no print-out, email price or
  invoice line in the new app (18 of 18); invoice lines add up to every total
  (18 of 18); exactly 7 unsigned print-outs change at G5. The one
  "byte-identical" miss was D1's own `hourlyRate` (now expected and checked).
- Data drill (`scripts/rehearsal/data-drill.mjs`, no browsers) on the same
  backup, every check passed: full restore from the encrypted file, 2.4,
  2.5 (17 cleaned, its backup encrypted), other fields byte-identical 18 of
  18, signed core fields 6 of 6, totals 18 of 18, rate folded on exactly the
  1 planned; final rules: another contractor refused 504 of 504 (now incl.
  property-advisor sessions), owners 72 of 72, signed-out refused 72 of 72;
  2.5 restore from its encrypted backup: 18 of 18 identical (6 of 6 signed);
  cleaning again works.

## Preflight of 2026-11-12 (nothing in production was changed)

- Candidate: app, rules and functions byte-identical to `03728c7`
  (`release/coordinated-candidate`); `master` = `origin/master` = `b28265f`.
  Tests: unit 101, rules 116, functions 42, browser 36 (295) all pass; lint and
  both builds clean.
- Live project re-read: same rules, hosting and functions as above; dry runs
  unchanged (8 cards + 1 photo log; 17 estimates to clean, 6 signed; 0
  failures); signed-out check matches stage 1 (17 estimates leaking).
- Complete local backup: 208 documents (~/buildpro-backups/firestore-…-2026-11-12T19-51-41-670Z.json).
- Rehearsal on that backup (`scripts/rehearsal/`, local emulator, 59 share
  links: 18 estimates, 5 change orders, 20 invoices, 15 thank-you pages, 1
  photo log) — **REHEARSAL PASSED**:
  - backup restores exactly (208 of 208 documents identical);
  - G3→G5 window: the app live today reads the same on all 59 pages;
  - G6: 2.4 then 0 to create / 0 to update; 2.5 cleaned 17, refused 0, then
    0 left; every other field byte-identical on 18 of 18 estimates; signed
    estimates' signature, signing time, total, status, date, letter and scope
    identical on 6 of 6; notes 17/17, walkthroughs 15/15, markup 10/10 kept
    word-for-word in `estimatePrivate`;
  - new app reads the same on all 59 pages after G6, after G7 and after a 2.5
    restore; the app live today reads the same on all 59 on cleaned data
    (hosting rollback after G6 is safe);
  - final rules: signed-out check matches; another signed-in contractor
    refused on 497 of 497 tries at real customers, photos, projects, billing
    profiles and estimate notes; owners still open their own (71 of 71);
  - 2.5 restore: all 18 estimates identical to production in every field
    (6 of 6 signed); cleaning again afterwards works.
  - For information: the G5 switch changes wording on 10 invoice pages
    ("Receipt — Invoice", "Paid in full"; amounts identical).

## At every gate: the check, and what to do if it fails

Each gate starts only after the previous gate's check has passed, and the
monitor (second terminal) shows nothing unexpected. "Stop" means change
nothing more and report; "roll back" uses the table under Rollback, in the
order its pairing rules give.

| Gate | Pass when | If not |
|---|---|---|
| G1 | tax timer inactive; live config identical to the table above; backup written and `--verify` reads it; all tests pass; dry runs show the numbers in section 0 | Stop. Nothing in production has changed. |
| G2 | `--ff-only` succeeds; tests and build pass on `master`; push accepted | Stop. If pushed already: nothing is deployed by a push; leave it, or revert later. |
| G3 | deploy succeeds; every estimate link OPEN; contractor can sign in and open Estimates; refusals per 10 min near baseline | Roll back step 2.1 (stage-1 rules). The app live today is unchanged. |
| G4 | storage + functions deploy succeed; 28 ACTIVE, last updated now; no new errors in the logs | Roll back the part that failed (functions or storage, from the checkpoint tag) and stop; the transition rules can stay (the app live today runs on them). |
| G5 | site serves this `dist/` build; sign-in, Estimates, Customers, Schedule open; a share link opens with the business name | Roll back 2.3 (hosting clone) and stop. The app live today runs on the transition rules and the new functions (same inputs); undo those too only if the fault is in them. |
| G6 | fresh backup + `--compare` shows only expected changes; dry-run numbers as in section 0; 2.4 second dry run 0/0; 2.5 "Cleaned 17; not cleaned 0", second dry run "To clean: 0, Failures: 0"; `verify-public-access` shows no estimate leaking | Numbers differ before writing: stop. 2.4 failure: stop (additive, nothing to undo). 2.5 "not cleaned": re-run once. Anything else: restore 2.5 from its printed backup and stop before G7 (new app + transition rules is a stable state; estimates leak as today until fixed). |
| G7 | "Matches the final stage."; share pages still open with the business name; refusals settle near baseline | Roll back step 3 (transition rules) at once; everything else can stay. |
| G8 | tax timer active with the next 1st/15th shown; tag created | Not a production risk: fix the timer by hand. |

## 0. Pre-flight (no production changes)

Best done **before Sunday 15 Nov, 06:10 Eastern** (the next scheduled tax
check). Later is fine too; see "Tax check" under Risks.

```bash
# G1 — pause the scheduled tax check for the release window (local, reversible).
systemctl --user is-active setaside-tax-check.service    # must print: inactive (a run is not in progress)
systemctl --user stop setaside-tax-check.timer
systemctl --user list-timers --all | grep setaside      # NEXT and LEFT show "-"

# Second terminal, left running for the whole sitting (read-only):
node scripts/release-monitor.mjs --project contractors-office-96731 --watch 120 --since "$(date -u +%FT%TZ)"

npx firebase login:list                                   # the owner account
node scripts/snapshot-live-config.mjs --project contractors-office-96731
#   expect: Firestore rules identical to rules/stage1-urgent, Storage identical
#   to checkpoint/pre-audit-2026-11-10, Hosting 3d61eede8445e201, 28 functions.
#   If anything DIFFERS, stop: someone deployed since this runbook was written.

node scripts/backup-key.mjs --status                      # passphrase present, owner-only (see "Backups")
node scripts/backup-firestore.mjs --project contractors-office-96731
#   read-only; a complete copy of the database, ENCRYPTED (owner-only
#   ~/buildpro-backups/firestore-…json.gpg). Keep the path printed: it is the
#   disaster-recovery copy.

npm ci && npm --prefix functions ci
npm test && npm run test:rules && npm run test:functions && npm run test:e2e
npm run lint && npm run build && npm --prefix functions run build

node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731
node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731
#   both are dry runs (read only). 2026-11-13: 8 cards + 1 photo log to create;
#   17 estimates to clean (6 signed, 11 pending), 0 failures; printed prices:
#   signed kept exactly as signed 6 (old rounding 2), unsigned print-out lines
#   change 7, labor-only rate folded 1; no "NOTE: signed labor-only" line.
#   Any failure, or any of those numbers different: stop and look.

# Optional (about 30 min, local only, needs the machine otherwise idle): the
# whole release played on that backup.
scripts/rehearsal/rehearse-release.sh ~/buildpro-backups/firestore-contractors-office-96731-<time>.json.gpg --with-old-app
#   must end: REHEARSAL PASSED
# Short on memory? The data half alone (a few minutes, no browsers):
#   npx firebase emulators:exec --config scripts/rehearsal/firebase.rehearsal.json --only firestore \
#     --project demo-rehearsal "node scripts/rehearsal/data-drill.mjs <backup>.json.gpg"
#   must end: DATA DRILL PASSED
```

Why pause the timer: it can deploy hosting from `master`. Between 2.0 and
2.1 that would put the new app live under the old rules, and the new app's
Quick Quote save (estimate + private notes in one write) is refused there.
`stop` holds until the timer is started again or the machine restarts (the
timer is enabled and starts with the user session), so do the sitting in one
go; checked with a throwaway timer on 2026-11-12: a stopped timer did not fire
through two missed times, and fired once at once when started again.

Optional, costs money: a full Firestore export to a Cloud Storage bucket. Not
needed: `backup-firestore.mjs` above is a complete, exact copy (restoring it
was checked document by document in the rehearsal), and the cleanup in 2.5
takes its own exact backup of every field it changes.

### Watching the release

`release-monitor.mjs` prints, every 2 minutes: whether the site answers and
which build it serves (`= this dist/ build` once G5 is live), the hosting
version, **which rules stage is live** (STAGE 1 → TRANSITION → FINAL), the
functions (all ACTIVE), function errors in the logs, and Firestore rule checks
allowed / refused per 10 minutes. Baseline on 2026-11-12: 0 function errors in
24 hours; about 2 refusals an hour. Each run of `verify-public-access.mjs` adds
its own 11 to 15 refusals (more as more reads close): that is the check working. A
jump in refusals that is not one of those runs means real users are being
refused: look before going on, and roll back if it follows a rules deploy.
Rule-check numbers arrive 3 to 5 minutes late.

## 1. Merge and push — G2

```bash
systemctl --user is-active setaside-tax-check.timer   # must print: inactive (a restart since G1 starts it again: stop it before going on)
git checkout master
git merge --ff-only audit/2026-11-modernization
npm test && npm run build
git push origin master
```
`SETASIDE_UPDATES.md` has an uncommitted entry from the 1 Nov tax run; the
branch does not touch it, so it carries over and the tax check tolerates it.
If `--ff-only` refuses, `master` moved since the preflight (nothing should
have pushed to it): stop and look; never force it. Pushing deploys nothing
(the repository has no deploy workflow).

## 2.1 Transition Firestore rules — G3

```bash
npx firebase deploy --only firestore:rules --config firebase.transition.json --project contractors-office-96731
```
Adds the customer-safe copies (`publicProfiles`, `photoLogs`), the private side
of estimates (`estimatePrivate`), account deletion requests, the signed-document
lock, and refuses any new estimate (or quote edit) that carries private notes,
markup or a walkthrough. Keeps the three old reads earlier share links need.

Check: `node --experimental-strip-types scripts/verify-public-access.mjs --project contractors-office-96731`
still shows every estimate link OPEN; a contractor can sign in and open Estimates.
Monitor: `Firestore rules: TRANSITION`. The app live today runs unchanged on
these rules (rehearsed: every share page reads the same).

## 2.2 Storage rules, then functions — G4

```bash
npx firebase deploy --only storage --project contractors-office-96731
FUNCTIONS_DISCOVERY_TIMEOUT=120 npx firebase deploy --only functions --project contractors-office-96731
```
Storage: uploads must be images under 25 MB. Functions: same 28, same inputs;
payment, deposit-invoice and email fixes; the estimate email no longer prints a
"Markup (0%)" line. Without `FUNCTIONS_DISCOVERY_TIMEOUT` the CLI gives the code
10 s to load (98 s seen on a busy machine).

No clean-up question is asked at the end: the function image store already
has Firebase's own clean-up rule (`firebase-functions-cleanup`, deletes images
older than 30 days, set 2026-10-18; checked live 2026-11-13), and the CLI only
asks when that rule is missing. Nothing to decide; a rollback rebuilds from
source, so old images are not needed.

Check: `npx firebase functions:log --project contractors-office-96731` shows no new errors.
Monitor: `Storage rules: this release`; `Functions: 28 deployed, all ACTIVE`,
last updated just now; no new errors.

## 2.3 Hosting — G5

```bash
systemctl --user is-active setaside-tax-check.timer   # still inactive
npm run build
npx firebase deploy --only hosting --project contractors-office-96731
```
Check: builderspro.cc loads the new version; sign in; Estimates, Customers and
Schedule open; an existing estimate link opens with the business name.
Monitor: `Site: ... = this dist/ build`.

## 2.4 + 2.5 Production data — G6 (one approval for both)

Only after 2.3 is live: the cleaned estimates need the new editor, which reads
the notes from `estimatePrivate` (the old editor would show them as empty).

```bash
# A fresh complete copy right before writing (read-only, ~30 s), and what has
# changed since the preflight copy (expect only a handful of documents).
node scripts/backup-firestore.mjs --project contractors-office-96731
node scripts/backup-firestore.mjs --project contractors-office-96731 --compare ~/buildpro-backups/firestore-contractors-office-96731-<preflight time>.json.gpg

# 2.4 customer-safe copies (additive)
node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731 --write
node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731
#   expect: 0 to create, 0 to update

# 2.5 estimate cleanup (writes a backup first, then one atomic write per estimate)
node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731 --write
#   prints: Backup written (owner-only file): ~/buildpro-backups/estimate-privacy-…json.gpg   ← keep this path (encrypted)
node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731
#   expect: To clean: 0, Failures: 0
```
2.5 moves the private notes, markup figures, cost subtotals and walkthrough of
17 estimates into owner-only `estimatePrivate`, and leaves on each estimate
exactly what its customer was shown (same total, prices, wording; checked per
document before writing, and word-for-word in the browser tests). **6 of them
are signed**: their signature, date, totals and letter are untouched, only the
hidden internal fields move, and their print-out, estimate email and invoice
lines stay exactly as they were printed when signed, to the cent (2.5 refuses
any signed estimate whose printed prices would change). The 7 unsigned ones
whose print-out lines change get lines that add up exactly to their unchanged
total (6 by under $1 a line; 1 off by over $100 before), and the labor-only
one shows its marked-up hourly rate. A "not cleaned" line means that estimate
changed mid-run: re-run.

Check: `verify-public-access.mjs` shows `estimates handing over …: none`.

## 3. Final Firestore rules — G7

Only if 2.4's second dry run said **0 to create and 0 to update**:
```bash
npx firebase deploy --only firestore:rules --project contractors-office-96731
node --experimental-strip-types scripts/verify-public-access.mjs --project contractors-office-96731 --expect final
#   must end: "Matches the final stage."
```
Closes `users/{id}`, `customers/{id}` and the `customerPhotos` listing. Share
pages keep working from the copies.
Monitor: `Firestore rules: FINAL`; refusals per 10 minutes back near the
baseline once the verify run above has passed through.

## 4. Finish — G8

```bash
systemctl --user start setaside-tax-check.timer     # may run at once (missed run catch-up): master == deployed, so that is safe
systemctl --user list-timers --all | grep setaside  # NEXT shows the next 1st/15th, 06:10
# If a scheduled time (1st/15th 06:10) passed while the timer was still RUNNING
# with the checkout on the release branch (the run stopped at once: "not
# master"), that check was skipped and the timer will not repeat it: run it
# once now, on master, which is what is deployed:
#   systemctl --user start setaside-tax-check.service
git tag release/2026-11-coordinated
```
Ask active contractors to close and reopen the app (see Risks). Keep the
monitor running for an hour or so; check it again the next morning
(`release-monitor.mjs --since <release start>`).

## Rollback

Undo in reverse order. **Pairing rules:** the new app needs the new rules, so
never put the stage-1 rules back while the new hosting is live: roll back
hosting first, then rules. And the app live today needs the transition (or
stage-1) rules: rolling hosting back while the final rules stay live strips
the business card from 38 of 59 share pages (rehearsed), so after G7 undo
step 3 first, then hosting.

| Undo | Command | Notes |
|---|---|---|
| Step 3 | redeploy 2.1: `npx firebase deploy --only firestore:rules --config firebase.transition.json --project contractors-office-96731` | Re-opens the three old reads. |
| 2.5 | `node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731 --restore <backup.json.gpg> --write` | Puts the original fields back exactly (re-exposes them). Not needed for an app rollback: the old app works with cleaned estimates, it just shows their notes empty. |
| 2.4 | none needed | Additive; copies hold only what share pages already showed. |
| 2.3 hosting | `npx firebase hosting:clone contractors-office-96731@3d61eede8445e201 contractors-office-96731:live --project contractors-office-96731` | The offline-page service worker caches only that page, so the old app shows on next load. |
| 2.2 functions | `git worktree add ../rb-old checkpoint/pre-audit-2026-11-10 && cd ../rb-old && npm --prefix functions ci && FUNCTIONS_DISCOVERY_TIMEOUT=120 npx firebase deploy --only functions --project contractors-office-96731` | Build from the tag verified 2026-11-12. |
| 2.2 storage | in `../rb-old`: `npx firebase deploy --only storage --project contractors-office-96731` | |
| 2.1 rules | `git worktree add ../rb-rules rules/stage1-urgent && cd ../rb-rules && npx firebase deploy --only firestore:rules --project contractors-office-96731` | Only after hosting is rolled back (pairing rule). |
| Git | leave `master`, or `git revert` the merge range | If hosting is rolled back while `master` stays new, keep the tax timer stopped until they match. |
| Disaster (any data) | `node scripts/backup-firestore.mjs --project contractors-office-96731 --restore <full backup.json.gpg> [--only <collection>] --write` | Last resort: puts whole documents back as they were when that copy was taken, overwriting anything changed since. Prefer the 2.5 `--restore` for estimates. Dry run without `--write`. |

## Risks

- **App tabs left open from before the release.** Until a contractor reloads:
  a Quick Quote save is refused (the old app stores notes and markup on the
  estimate; the AI quote is shown but not saved, and that quote's allowance is
  spent); editing a signed estimate or change order fails with "Save failed"
  (intended); notes on cleaned estimates show empty in the old editor (they are
  safe in `estimatePrivate`). The site serves `index.html` with no-cache, so a
  reload or reopen picks up the new app. 8 contractor accounts exist.
- **Tax check.** Covered by G1 (paused) and G8 (resumed). It runs only on
  `master` with a clean tree and can deploy nothing but hosting; until G2 the
  checkout is on the release branch, so a run that fires before the release
  stops at once (checked 2026-11-12). If the sitting crosses Sun 15 Nov 06:10
  Eastern, starting the timer at G8 runs that missed check once, straight away:
  safe then, because `master` is what is deployed. If the release has not
  started by Sun 15 Nov 06:10 (timer still running, checkout on the release
  branch), that day's check stops at once and is skipped, deploying nothing;
  run it once after G8 (see G8). Do not put the checkout back on `master`
  before the release just to let it run: a real run can commit and push to
  `master`, and then G2's `--ff-only` refuses until the release branch is
  brought up to date and retested. A run uses Claude Code on
  the owner's account, exactly as a scheduled run would.
- **Costs.** Functions deploy: Cloud Build minutes and image storage, normally
  inside the free allowance (at most a few cents); the existing 30-day image
  clean-up rule keeps storage small. Rules, Storage, Hosting deploys, the
  ~45 database writes of G6 and all reads, backups and monitoring: free at this
  size. No other paid service is touched.
- **Window.** From 2.1 to step 3 the three old reads stay open (as today);
  doing G3–G7 in one sitting keeps that to under an hour.

## Backups (encrypted at rest)

Every backup of live data the release tools write (`backup-firestore.mjs`, the
2.5 cleanup's own backup) is encrypted before it touches the disk: OpenPGP,
AES-256 with an integrity check, by the standard `gpg` tool, with a random
passphrase in `~/.config/buildpro-plus/backup-passphrase` (owner-only; created
2026-11-13 with `node scripts/backup-key.mjs --init`). The tools read them back
transparently (`--restore`, `--compare`, the rehearsal). This machine's disk is
not itself encrypted, so a copied, synced or attached backup file is otherwise
everything: customers' contact details, signatures, private notes, markup.

- **Store the passphrase off this machine** (a password manager): without it
  the backups cannot be read. Open it in your own terminal or a text editor
  (`cat ~/.config/buildpro-plus/backup-passphrase`), not through an assistant
  session, so it never lands in a chat transcript. It is 43 letters, digits,
  `-` and `_`; decrypting with it typed in (no file, empty GnuPG home) was
  checked on both backups 2026-11-13.
- Decrypt without this repo: `gpg --batch --pinentry-mode loopback --passphrase-file ~/.config/buildpro-plus/backup-passphrase --decrypt <file>.json.gpg > <file>.json`
- Check one: `node scripts/backup-key.mjs --verify <file>.json.gpg` (hash and document count only).
- The 2026-11-12 backup was encrypted (identical content, sha256 07380913…) and
  its plaintext overwritten and removed; no other plaintext copy of production
  data was found under the home or temp folders. The `live-…/` folders hold
  configuration only (rule files, version ids, function names).
- Tool output never prints customer data or share-link ids (counts, one-way
  tags); the logs and reports of this preflight were scanned against every
  id, name, email, phone and signature in the backup: none found.

## In this release (decided 2026-11-13)

- **D1, labor-only AI quotes with a markup** (1 of 18 today, unsigned). The
  markup was folded into the labor total but the hourly rate stayed the cost
  rate, so "10 h × $60/hr — $720" gave the $120 markup away by subtraction (on
  the stored estimate, the print-out and the estimate email; the share page and
  invoices never show the rate), and the editor, recomputing labor as hours ×
  rate, dropped the markup from the price on save. Now the rate carries the
  markup too (labor total / hours, to the cent), the estimate's `hourlyRate`
  matches, and the editor keeps the quoted labor price and total until the
  hours, rate, a price, a quantity or the rentals are actually changed (a
  rounded rate × hours can miss by a cent or two). Price, total, invoice and
  the private markup record are unchanged.
- **Signed estimates keep the prices they were signed with.** The new app
  folds the markup on line totals (lines add up exactly); the app live today
  rounded each unit price first, which drifts by cents. Every place an
  estimate's prices appear (print-out, estimate email, invoice lines, the
  editor's starting point for a revision, the 2.5 cleanup) shows a signed
  estimate whose markup is not yet folded with the old rounding, so all 6
  signed estimates print exactly as they did (2 of them would otherwise change
  by under $1 a line). A revision that only rewords keeps the signed lines and
  total. Unsigned estimates get the corrected lines (7, listed under G6). A
  signed labor-only estimate (none today) would keep its signed rate; 2.5 then
  prints a NOTE for the owner to decide.

## Known and not in this release

- Invoices carry Stripe Checkout session / payment-intent ids (5 and 2): not
  usable without the Stripe secret key.
- One signed estimate predates `signedAtMs` and two paid invoices predate
  `paidAtMs`, so those three are not under the 2-year deletion lock.
