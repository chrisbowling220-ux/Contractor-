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

## 0. Pre-flight (no production changes)

```bash
# G1 — pause the scheduled tax check for the release window (local, reversible).
systemctl --user stop setaside-tax-check.timer
systemctl --user list-timers --all | grep setaside      # shows n/a / inactive

npx firebase login:list                                   # the owner account
node scripts/snapshot-live-config.mjs --project contractors-office-96731
#   expect: Firestore rules identical to rules/stage1-urgent, Storage identical
#   to checkpoint/pre-audit-2026-11-10, Hosting 3d61eede8445e201, 28 functions.
#   If anything DIFFERS, stop: someone deployed since this runbook was written.

npm ci && npm --prefix functions ci
npm test && npm run test:rules && npm run test:functions && npm run test:e2e
npm run lint && npm run build && npm --prefix functions run build

node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731
node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project contractors-office-96731
#   both are dry runs (read only). 2026-11-12: 8 cards + 1 photo log to create;
#   17 estimates to clean (6 signed, 11 pending), 0 failures. Any failure: stop.
```

Why pause the timer: it can deploy hosting from `master`. Between 2.0 and
2.1 that would put the new app live under the old rules, and the new app's
Quick Quote save (estimate + private notes in one write) is refused there. It
is `Persistent=true`, so a missed run fires on the next boot, not only at
06:10 on the 1st/15th.

Optional, costs money: a full Firestore export to a Cloud Storage bucket
before any data is written (needs a bucket; console → Firestore → Import/Export).
The cleanup in 2.5 takes its own exact backup of every field it changes.

## 1. Merge and push — G2

```bash
git checkout master
git merge --ff-only audit/2026-11-modernization
npm test && npm run build
git push origin master
```
`SETASIDE_UPDATES.md` has an uncommitted entry from the 1 Nov tax run; the
branch does not touch it, so it carries over and the tax check tolerates it.

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

## 2.2 Storage rules, then functions — G4

```bash
npx firebase deploy --only storage --project contractors-office-96731
FUNCTIONS_DISCOVERY_TIMEOUT=120 npx firebase deploy --only functions --project contractors-office-96731
```
Storage: uploads must be images under 25 MB. Functions: same 28, same inputs;
payment, deposit-invoice and email fixes; the estimate email no longer prints a
"Markup (0%)" line. Without `FUNCTIONS_DISCOVERY_TIMEOUT` the CLI gives the code
10 s to load (98 s seen on a busy machine).

Check: `npx firebase functions:log --project contractors-office-96731` shows no new errors.

## 2.3 Hosting — G5

```bash
npm run build
npx firebase deploy --only hosting --project contractors-office-96731
```
Check: builderspro.cc loads the new version; sign in; Estimates, Customers and
Schedule open; an existing estimate link opens with the business name.

## 2.4 + 2.5 Production data — G6 (one approval for both)

Only after 2.3 is live: the cleaned estimates need the new editor, which reads
the notes from `estimatePrivate` (the old editor would show them as empty).

```bash
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

## 4. Finish — G8

```bash
systemctl --user start setaside-tax-check.timer     # may run at once (missed run catch-up): master == deployed, so that is safe
git tag release/2026-11-coordinated
```
Ask active contractors to close and reopen the app (see Risks).

## Rollback

Undo in reverse order. **Pairing rule:** the new app needs the new rules, so
never put the stage-1 rules back while the new hosting is live: roll back
hosting first, then rules.

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

## Risks

- **App tabs left open from before the release.** Until a contractor reloads:
  a Quick Quote save is refused (the old app stores notes and markup on the
  estimate; the AI quote is shown but not saved, and that quote's allowance is
  spent); editing a signed estimate or change order fails with "Save failed"
  (intended); notes on cleaned estimates show empty in the old editor (they are
  safe in `estimatePrivate`). The site serves `index.html` with no-cache, so a
  reload or reopen picks up the new app. 8 contractor accounts exist.
- **Tax check.** Covered by G1 (paused) and G8 (resumed).
- **Costs.** The functions deploy uses Cloud Build and Artifact Registry
  (normally within the free tier, at most cents). Nothing else here is billed.
- **Window.** From 2.1 to step 3 the three old reads stay open (as today);
  doing G3–G7 in one sitting keeps that to under an hour.

## Known and not in this release

- One unsigned labor-only AI estimate: its markup was folded into labor, so
  labor total minus hours × rate reveals it. Opening such an estimate in the
  editor recomputes labor as hours × rate and would drop the markup from the
  total if saved (pre-existing). Fix separately (fold labor-only markup into
  the rate for new quotes; keep signed ones as signed).
- Invoices carry Stripe Checkout session / payment-intent ids (5 and 2): not
  usable without the Stripe secret key.
- One signed estimate predates `signedAtMs` and two paid invoices predate
  `paidAtMs`, so those three are not under the 2-year deletion lock.
