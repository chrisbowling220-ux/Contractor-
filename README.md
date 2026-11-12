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
| 2 | With the new app version | Adds the collections the new app writes; keeps old share links working; locks signed estimates and change orders (edits become revisions or new change orders) | `npx firebase deploy --only firestore:rules --config firebase.transition.json`, then `npx firebase deploy --only storage,functions`, then `npm run build && npx firebase deploy --only hosting` |
| 3 | Once active contractors have opened the new app (it republishes their share data on open) | Makes customers, photos and billing profiles owner-only | `npx firebase deploy --only firestore:rules` |

Roll back any step by redeploying the same thing from tag
`checkpoint/pre-audit-2026-11-10`, which matches what was live on 2026-11-11
(rules and hosting were both verified identical to it).

`scripts/setaside-tax-check.sh` is a scheduled job that checks the Safe-to-Spend
tax numbers; see `scripts/setaside-tax-check.md`.
