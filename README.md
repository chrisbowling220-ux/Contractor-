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
| `npm run test:rules` | Firestore and Storage security rules, in the emulators. |
| `npm run test:e2e` | Browser tests (Playwright, phone and desktop sizes) of the real app against the emulators, with the real rules and a throwaway account. Needs Google Chrome installed. |
| `npm run lint` | ESLint. |
| `npm run build` | Type-check and production build into `dist/`. |
| `cd functions && npm run build` | Compile the Cloud Functions. |

The browser tests replace the sign-in service with a stand-in (`e2e/stubs/`),
so they cover everything except the Clerk sign-in screens themselves and the
features that call paid outside services (AI quoting, voice, email, card
checkout).

## Deploying

Deploys are manual and need the owner's go-ahead:

```bash
npm run build && npx firebase deploy --only hosting
npx firebase deploy --only firestore:rules,storage
npx firebase deploy --only functions
```

Deploy rules and functions before (or with) the hosting build that depends on
them. Secrets (Anthropic, Clerk, ElevenLabs, Resend, Stripe) live in Firebase
secret storage, never in this repository.

`scripts/setaside-tax-check.sh` is a scheduled job that checks the Safe-to-Spend
tax numbers; see `scripts/setaside-tax-check.md`.
