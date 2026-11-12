# BuildPro+

Contractor estimates, customer e-sign, change orders, invoices and job tracking.
Live at https://builderspro.cc.

## What it is built from

| Part | What it uses |
|---|---|
| App | React 19 + TypeScript, built with Vite. One page app, hosted on Firebase Hosting. |
| Sign-in | Clerk. A Cloud Function (`exchangeFirebaseToken`) turns the Clerk session into a Firebase session, so `request.auth.uid` in the security rules is the Clerk user id. |
| Data | Cloud Firestore (`firestore.rules`) and Cloud Storage for photos and logos (`storage.rules`). Every record carries `createdBy`. |
| Server | Firebase Cloud Functions v2 on Node 24 (`functions/src`): AI quoting, email, voice, Stripe checkout and webhook. |
| Payments | Stripe Checkout + Connect for card payments to the contractor; Stripe subscriptions for Pro. |
| Android | The site wrapped as a Trusted Web Activity (`playstore/`). There is no native code. |

`src/Root.tsx` picks what to load from the URL. Customer share pages
(`/q/…` estimate, `/co/…` change order, `/inv/…` invoice, `/thanks/…`, `/log/…`)
are small bundles of their own; the contractor app loads only on the app itself.

Money math lives in `src/lib/invoiceMath.ts`, `src/lib/customerView.ts` and
`src/lib/manualQuote.ts`, with no Firebase in them, so it is unit-tested.

## Running it

```bash
npm install
npm run dev            # against the LIVE Firebase project named in .env.local
```

To work without touching live data, run against the local emulators:

```bash
npx firebase emulators:start --only firestore,auth,storage --project demo-setaside
VITE_USE_EMULATORS=1 npm run dev
```

The emulator switch is honoured only by the dev server; a production build
ignores it.

## Checks

| Command | What it covers |
|---|---|
| `npm test` | Unit tests: tax engine, invoice and payment math, markup, hand-built estimates, customers, uploads. |
| `npm run test:rules` | Firestore and Storage security rules, in the emulators, including that one contractor can never read another's data. |
| `npm run test:functions` | The Cloud Functions themselves (Stripe webhook, deposit invoice, card checkout, email, AI allowance) against the Firestore emulator. Stripe, Clerk, Resend and the AI model are stand-ins: nothing is charged, sent or billed. |
| `npm run test:e2e` | Browser tests (Playwright, phone and desktop sizes) of the real app against the emulators, with the real rules and a throwaway account. Needs Google Chrome installed. |
| `npm run lint` | ESLint. |
| `npm run build` | Type-check and production build into `dist/`. |
| `cd functions && npm run build` | Compile the Cloud Functions. |

The three emulator suites start their emulators from `firebase.test.json`,
which uses its own ports (Firestore 8380, Auth 9399, Storage 9499) so they do
not collide with emulators another project has running on the default ports.

The browser tests replace the sign-in service with a stand-in (`e2e/stubs/`),
so they cover everything except the Clerk sign-in screens themselves and the
features that call paid outside services (AI quoting, voice, email, card
checkout).

## Deploying

Deploys are manual and need the owner's go-ahead. Secrets (Anthropic, Clerk,
ElevenLabs, Resend, Stripe) live in Firebase secret storage, never in this
repository.

The security rules come in three steps, because share links already sent to
customers have to keep working while contractors move to the new app version:

| Step | When | What | Command |
|---|---|---|---|
| 1 | Done 2026-11-12 (owner-approved) | Stops anyone listing contractors' data; locks customer sign-off | Deployed `firestore.rules` from tag `rules/stage1-urgent` |
| 2 | With the new app version | Adds the collections the new app writes; keeps old share links working; locks signed estimates and change orders (edits become revisions or new change orders); refuses estimates that carry private notes or markup | `npx firebase deploy --only firestore:rules --config firebase.transition.json`, then `npx firebase deploy --only storage,functions`, then `npm run build && npx firebase deploy --only hosting` |
| 2.4 / 2.5 | Right after the new app is live | Publishes every contractor's customer-safe copies; moves older estimates' private notes, markup and walkthrough into `estimatePrivate` | `scripts/publish-public-copies.mjs --write`, `scripts/migrate-estimate-privacy.mjs --write` (both dry-run by default) |
| 3 | Once 2.4 reports nothing left to publish | Makes customers, photos and billing profiles owner-only | `npx firebase deploy --only firestore:rules` |

Steps 2 to 3 are released together in one sitting. The runbook, with the
approval gates, checks and rollback for each command, is in `RELEASE_STEP2.md`.

Release tools in `scripts/` (all read-only unless given `--write`):

| Script | What it does |
|---|---|
| `snapshot-live-config.mjs` | Saves the live rules, hosting version and function list, and compares them with the rollback tags. |
| `verify-public-access.mjs` | Tries every read a signed-out stranger could attempt against the live project; `--expect final` makes it a pass/fail check. |
| `publish-public-copies.mjs` | Step 2.4. |
| `migrate-estimate-privacy.mjs` | Step 2.5; takes an exact backup first and can `--restore` from it. |
| `backup-firestore.mjs` | A complete, exact copy of the database on this machine (every collection and subcollection; owner-only file). `--compare` shows what changed since; `--restore` puts documents back. Free stand-in for the paid Cloud Storage export. |
| `release-monitor.mjs` | What is live (site build, hosting, which rules stage, functions), function errors, and Firestore rule refusals per 10 minutes; `--watch 120` repeats. |
| `rehearsal/rehearse-release.sh` | Plays the whole release (rules stages, 2.4, 2.5, final rules, the 2.5 restore) on a backup loaded into a local emulator, reading every customer share page before and after each step. Never touches the live project. |

An estimate is opened by its link without signing in and the database hands
over the whole document, so it holds only the customer view of the quote; the
contractor's private side of it lives in `estimatePrivate/{estimateId}`
(`src/lib/estimatePrivacy.ts`).

Roll back any step by redeploying the same thing from tag
`checkpoint/pre-audit-2026-11-10`, which matches what was live on 2026-11-11
(rules and hosting were both verified identical to it).

`scripts/setaside-tax-check.sh` is a scheduled job that checks the Safe-to-Spend
tax numbers; see `scripts/setaside-tax-check.md`.
