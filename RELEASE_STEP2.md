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

node scripts/backup-firestore.mjs --project contractors-office-96731
#   read-only; a complete copy of the database (owner-only file under
#   ~/buildpro-backups/). Keep the path printed: it is the disaster-recovery copy.

npm ci && npm --prefix functions ci
npm test && npm run test:rules && npm run test:functions && npm run test:e2e
npm run lint && npm run build && npm --prefix functions run build

node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731
node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731
#   both are dry runs (read only). 2026-11-12: 8 cards + 1 photo log to create;
#   17 estimates to clean (6 signed, 11 pending), 0 failures. Any failure: stop.

# Optional (about 30 min, local only): the whole release played on that backup.
scripts/rehearsal/rehearse-release.sh ~/buildpro-backups/firestore-contractors-office-96731-<time>.json --with-old-app
#   must end: REHEARSAL PASSED
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

The functions deploy ends by asking **"How many days do you want to keep
container images before they're deleted?"** (no clean-up rule is set up for
the function images yet). Answering (default 1) sets that rule on the
project's image store, which keeps a small monthly storage bill from building
up; a rollback rebuilds from source, so old images are not needed. This
question comes after the functions are already deployed. (Run without a
terminal, the deploy succeeds and then reports that it could not set the rule;
`--force` sets the default instead.)

Check: `npx firebase functions:log --project contractors-office-96731` shows no new errors.
Monitor: `Storage rules: this release`; `Functions: 28 deployed, all ACTIVE`,
last updated just now; no new errors.

## 2.3 Hosting — G5

```bash
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
node scripts/backup-firestore.mjs --project contractors-office-96731 --compare ~/buildpro-backups/firestore-contractors-office-96731-<preflight time>.json

# 2.4 customer-safe copies (additive)
node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731 --write
node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731
#   expect: 0 to create, 0 to update

# 2.5 estimate cleanup (writes a backup first, then one atomic write per estimate)
node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731 --write
#   prints: Backup written (owner-only file): ~/buildpro-backups/estimate-privacy-…json   ← keep this path
node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731
#   expect: To clean: 0, Failures: 0
```
2.5 moves the private notes, markup figures, cost subtotals and walkthrough of
17 estimates into owner-only `estimatePrivate`, and leaves on each estimate
exactly what its customer was shown (same total, prices, wording; checked per
document before writing, and word-for-word in the browser tests). **6 of them
are signed**: their signature, date, totals and letter are untouched, only the
hidden internal fields move. A "not cleaned" line means that estimate changed
mid-run: re-run.

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
| 2.5 | `node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731 --restore <backup.json> --write` | Puts the original fields back exactly (re-exposes them). Not needed for an app rollback: the old app works with cleaned estimates, it just shows their notes empty. |
| 2.4 | none needed | Additive; copies hold only what share pages already showed. |
| 2.3 hosting | `npx firebase hosting:clone contractors-office-96731@3d61eede8445e201 contractors-office-96731:live --project contractors-office-96731` | The offline-page service worker caches only that page, so the old app shows on next load. |
| 2.2 functions | `git worktree add ../rb-old checkpoint/pre-audit-2026-11-10 && cd ../rb-old && npm --prefix functions ci && FUNCTIONS_DISCOVERY_TIMEOUT=120 npx firebase deploy --only functions --project contractors-office-96731` | Build from the tag verified 2026-11-12. |
| 2.2 storage | in `../rb-old`: `npx firebase deploy --only storage --project contractors-office-96731` | |
| 2.1 rules | `git worktree add ../rb-rules rules/stage1-urgent && cd ../rb-rules && npx firebase deploy --only firestore:rules --project contractors-office-96731` | Only after hosting is rolled back (pairing rule). |
| Git | leave `master`, or `git revert` the merge range | If hosting is rolled back while `master` stays new, keep the tax timer stopped until they match. |
| Disaster (any data) | `node scripts/backup-firestore.mjs --project contractors-office-96731 --restore <full backup.json> [--only <collection>] --write` | Last resort: puts whole documents back as they were when that copy was taken, overwriting anything changed since. Prefer the 2.5 `--restore` for estimates. Dry run without `--write`. |

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
  safe then, because `master` is what is deployed. A run uses Claude Code on
  the owner's account, exactly as a scheduled run would.
- **Costs.** Functions deploy: Cloud Build minutes and image storage, normally
  inside the free allowance (at most a few cents); the image clean-up rule at
  G4 keeps storage near zero afterwards. Rules, Storage, Hosting deploys, the
  ~45 database writes of G6 and all reads, backups and monitoring: free at this
  size. No other paid service is touched.
- **Window.** From 2.1 to step 3 the three old reads stay open (as today);
  doing G3–G7 in one sitting keeps that to under an hour.

## Known and not in this release

- **Labor-only AI quotes with a markup** (1 of 18 today, unsigned). The markup
  is folded into the labor total but the hourly rate stays the cost rate, so
  "10 h × $60/hr — $720" gives the $120 markup away by subtraction: on the
  stored estimate (`hourlyRate`, `aiQuote.labor`), the print-out, the estimate
  email and an invoice's labor line. Applies to new labor-only quotes too. The
  share page itself shows no hours or rate. The editor recomputes labor as
  hours × rate, so saving such an estimate drops the markup from the price
  (pre-existing money bug). Fix prepared on branch `fix/labor-only-markup`
  (not merged; changes how a price is displayed, so it needs the owner's OK):
  fold the markup into the rate too (total unchanged; exact to the cent on the
  affected estimate), and keep the estimate's `hourlyRate` beside it in step.
  If it goes in before G6, 2.5 cleans that estimate fully in the same pass.
- **Print-out / email line prices of 8 older estimates (2 signed) change
  slightly with the new app** (the rounding fix of step 2, not the cleanup):
  the material lines now add up exactly to the total. 7 differ by under $1 per
  line; 1 unsigned estimate's old print-out was off by over $100 because the
  AI's own line did not add up, and now matches its total. Totals, signatures
  and everything on the share page are unchanged.
- Invoices carry Stripe Checkout session / payment-intent ids (5 and 2): not
  usable without the Stripe secret key.
- One signed estimate predates `signedAtMs` and two paid invoices predate
  `paidAtMs`, so those three are not under the 2-year deletion lock.
