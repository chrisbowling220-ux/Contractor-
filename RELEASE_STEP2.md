# BuildPro+ release, step 2 (and step 3)

Runbook for releasing branch `audit/2026-11-modernization`. Nothing here is
done without the owner's explicit approval. Step 1 (urgent Firestore rules,
tag `rules/stage1-urgent`) went live on 2026-11-12.

Project: `contractors-office-96731`. Site: https://builderspro.cc.
Run every command from the repo root. Add `--project contractors-office-96731`
to every `firebase` command.

## Before starting

- [ ] Owner approval for step 2 (merge, push, the three deploys below).
- [ ] Finish everything below in one sitting, **before Sunday 2026-11-15
      06:10 ET**. That is when the scheduled tax check runs from `master`; on a
      real run it may commit, push and deploy hosting from whatever `master`
      holds.
- [ ] Machine not under heavy load (the functions deploy loads the code
      within a time limit; see step 2b).
- [ ] `npx firebase login:list` shows the owner account.

## What is live now (the rollback targets)

| Piece | Live version | Restore with |
|---|---|---|
| Firestore rules | tag `rules/stage1-urgent` (ruleset 10ce3890, 2026-11-12) | deploy `firestore.rules` from that tag |
| Storage rules | identical to `checkpoint/pre-audit-2026-11-10` (ruleset 950106a0, 2026-05-28) | deploy `storage.rules` from that tag |
| Functions | 28 functions, Node 24, deployed 2026-10-15; same names as the release | deploy `functions/` from `checkpoint/pre-audit-2026-11-10` |
| Hosting | version `3d61eede8445e201` (2026-10-19) | `npx firebase hosting:clone contractors-office-96731@3d61eede8445e201 contractors-office-96731:live` (or Console → Hosting → release history → Roll back) |
| Git | `master` = `origin/master` = `b28265f` = tag `checkpoint/pre-audit-2026-11-10` | redeploy from the tag; do not force-push `master` |

## Step 2

### 2.0 Merge
```
git checkout master
git merge --ff-only audit/2026-11-modernization
npm test && npm run build
git push origin master
```
`SETASIDE_UPDATES.md` has an uncommitted entry from the 1 Nov tax run; the
branch does not touch that file, so it carries over unchanged and the tax
check tolerates it.

### 2.1 Transition Firestore rules
```
npx firebase deploy --only firestore:rules --config firebase.transition.json --project contractors-office-96731
```
Adds: the customer-safe copies (`publicProfiles`, `photoLogs`), account
deletion requests, and the signed-document lock (a signed estimate accepts
only bookkeeping links; a signed change order is never edited; only customers
sign). Keeps the three old reads that earlier share links need.

Check: anonymous listing still refused; one estimate link still opens; a
contractor can sign in and open Estimates.

### 2.2 Storage rules, then functions
```
npx firebase deploy --only storage --project contractors-office-96731
FUNCTIONS_DISCOVERY_TIMEOUT=120 npx firebase deploy --only functions --project contractors-office-96731
```
Storage: uploads must be images under 25 MB; reads and deletes unchanged.
Functions: same 28 functions, same inputs; payment, deposit-invoice and email
fixes. The live app keeps working against them (pay links already use
https://builderspro.cc, which the email function now requires).

Without `FUNCTIONS_DISCOVERY_TIMEOUT` the CLI gives the code 10 s to load; on a
busy machine with a cold disk cache it took 98 s (0.7 s warm).

Check: `npx firebase functions:log --project contractors-office-96731` shows
no new errors.

### 2.3 Hosting
```
npm run build
npx firebase deploy --only hosting --project contractors-office-96731
```
Check: builderspro.cc loads the new version; sign in; Estimates, Customers and
Schedule open; an old estimate link and an old photo-log link open with the
business name shown.

### 2.4 Publish the customer-safe copies for every contractor (optional, recommended)
```
node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731          # dry run: counts only
node --experimental-strip-types scripts/publish-public-copies.mjs --project contractors-office-96731 --write  # publish
```
Writes only `publicProfiles/*` and `photoLogs/*`, using the app's own
builders; prints counts, never contents; safe to re-run. Without it, each
contractor's copies appear the next time they open the app, and step 3 has to
wait for that.

## Step 3: final Firestore rules (separate approval)

Only after the dry run above reports **0 to create and 0 to update**:
```
npx firebase deploy --only firestore:rules --project contractors-office-96731
```
Closes the three old reads: contractor account records (`users/{id}`,
including billing state), customer records (`customers/{id}`: phone, address,
notes) and the public listing of every customer photo record
(`customerPhotos`). Share pages keep working from the copies.

Check: anonymous `users/{id}` and `customers/{id}` refused, `customerPhotos`
listing refused; `publicProfiles/{id}` and `photoLogs/{id}` open; an old
photo-log link still shows its photos.

## Rollback

| Undo | Command | Notes |
|---|---|---|
| 2.1 or step 3 rules | `git worktree add ../rb-rules rules/stage1-urgent && cd ../rb-rules && npx firebase deploy --only firestore:rules --project contractors-office-96731` | Step 3 alone: redeploy 2.1 instead. With the new app live, stage-1 rules refuse its copies and deletion requests (share pages fall back to the old reads), so roll back hosting too or redeploy 2.1 soon. |
| 2.2 storage | `git worktree add ../rb-old checkpoint/pre-audit-2026-11-10 && cd ../rb-old && npx firebase deploy --only storage --project contractors-office-96731` | |
| 2.2 functions | in `../rb-old`: `npm --prefix functions ci && FUNCTIONS_DISCOVERY_TIMEOUT=120 npx firebase deploy --only functions --project contractors-office-96731` | |
| 2.3 hosting | `npx firebase hosting:clone contractors-office-96731@3d61eede8445e201 contractors-office-96731:live --project contractors-office-96731` | The new offline-page service worker caches nothing but that page, so the old app shows on next load. |
| 2.4 copies | none needed | Additive; the copies hold only what share pages already showed. |
| Git | leave `master`; or `git revert` the merge range | If hosting is rolled back while `master` stays new, stop the tax timer (`systemctl --user stop setaside-tax-check.timer`) until they match, or its next real run could redeploy the new hosting. |

## Risks

- **Old app tabs during the rollout.** Editing a signed estimate or change
  order now fails with "Save failed" (intended). A photo whose file reports no
  type is refused by the new storage rule (rare; the new app always sets it).
- **Tax check on 2026-11-15.** If `master` is merged but not yet deployed
  when it runs and it finds new tax numbers, it deploys the new hosting ahead
  of the rules. If `master` is not merged by then, it stops with "not on
  master" and changes nothing (the next run is 1 Dec).
- **Costs.** Functions deploy uses Cloud Build and Artifact Registry
  (normally within the free tier, at most cents).
- **Exposure until step 3.** Step 2 does not close the old public reads; step 3
  (or 2.4 followed by step 3) does.
