# Contractors Office

An AI-powered business platform for contractors: capture a job by photo + voice,
get a complete, fair, customer-ready estimate from Claude, manage customers and
projects from lead to closeout, and email branded quotes to clients.

This README is the map of the whole system. If something breaks, start here.

---

## What the app does

| Page | What it's for |
|---|---|
| **Dashboard** | At-a-glance counts (active jobs, pending estimates, customers) + quick links. |
| **Scan Room** | Snap up to 8 photos, narrate the job out loud (voice → text), and Claude produces a full estimate from what it sees and hears. |
| **Estimates** | Build a quote by hand or with the AI generator; flat-rate or hourly; materials + rentals; approve/decline; print to PDF; **email to the customer**. |
| **Projects** | Every job in one pipeline: lead → estimated → contracted → in progress → completed → closed. Pulls together that customer's estimates, change orders, and photos. |
| **Customers** | Client directory (name, phone, email, address). |
| **Materials Pricing** | Regional material price reference, scaled by ZIP. |
| **Rentals** | Rental equipment catalog with a day-rate cart. |

---

## Architecture (how the pieces fit)

```
  Browser (React + Vite)                 Firebase                        3rd-party
  ─────────────────────                  ────────                        ─────────
  Clerk sign-in  ───────────────────────────────────────────────────▶  Clerk (auth)
        │
        │  (1) Clerk → Firebase bridge
        ▼        src/lib/useFirebaseAuth.ts
  Firebase Auth  ◀── custom token (uid = Clerk user id) ────────────── Clerk integration
        │
        │  (2) reads/writes, authenticated
        ▼
  Firestore  ◀── secured by firestore.rules (owner-scoped by createdBy)
        │
        │  (3) AI / email / transcription go through Cloud Functions
        ▼        so secret keys never touch the browser
  Cloud Functions (functions/src/index.ts)
        ├─ generateAIQuote   ─▶ Anthropic (Claude)   [ANTHROPIC_API_KEY]
        ├─ analyzeScan       ─▶ Anthropic (Claude, vision)
        ├─ transcribeAudio   ─▶ Google Speech-to-Text
        └─ sendEstimateEmail ─▶ Resend                [RESEND_API_KEY]
                                 every function verifies the Clerk token first [CLERK_SECRET_KEY]
```

**Why the Clerk → Firebase bridge exists.** Users log in with Clerk, but Firestore
security rules can only see a *Firebase* identity. So on sign-in we trade the Clerk
session for a Firebase custom token whose `uid` equals the Clerk user id. Every
document is stamped with that id in `createdBy`, and `firestore.rules` only lets a
user read/write rows where `createdBy == request.auth.uid`. One user can never see
another's data. The bridge lives in `src/lib/useFirebaseAuth.ts`; `AuthGate` in
`src/App.tsx` holds the UI on a "Connecting…" screen until the bridge is ready, so
no page queries Firestore before the identity exists.

**Why Cloud Functions.** The Anthropic, Resend, and Speech-to-Text keys must never
ship to the browser. The browser calls a Function; the Function verifies the Clerk
token, then calls the third-party API with keys stored in Firebase Secrets.

---

## Project layout

```
src/                     Web app (Vite + React + TypeScript)
  App.tsx                Shell, sidebar, AuthGate (the Clerk→Firebase gate)
  firebase.ts            Firebase init: db, functions, auth
  lib/useFirebaseAuth.ts The Clerk → Firebase Auth bridge
  Scan*/Estimates/...    One file per page
  data/                  Static catalogs: jobs, materials, rentals, shared types
  lib/                   aiQuote (callable client), fallbackQuote, customerView
functions/               Cloud Functions backend (its own package.json)
  src/index.ts           All callable functions
  src/aiQuoteSchema.ts   JSON schema Claude must fill + arithmetic rules
firestore.rules          Per-user security rules
firestore.indexes.json   Composite indexes the list queries require
firebase.json            Hosting + Functions + Firestore config
buildpro/                Separate Expo (React Native) app — independent of the web app
```

---

## Setup (first time)

You need a Firebase project (Blaze plan — Functions require it), a Clerk app, an
Anthropic API key, and a Resend API key.

### 1. Frontend environment variables — `.env.local` at the repo root

```
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...      # Clerk dashboard → API Keys
VITE_FIREBASE_API_KEY=...                   # Firebase console → Project settings → Web app
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

### 2. Enable the Clerk → Firebase integration  ⚠️ required, or the app shows "One setup step left"

In the **Clerk dashboard → Integrations → Firebase**: turn it on and upload your
Firebase service account JSON. This creates the `integration_firebase` token
template that `useFirebaseAuth.ts` uses. Without it, users can sign in but can't
reach the database.

### 3. Backend secrets (Cloud Functions)

```sh
firebase functions:secrets:set ANTHROPIC_API_KEY   # console.anthropic.com  (sk-ant-...)
firebase functions:secrets:set CLERK_SECRET_KEY    # Clerk → API Keys       (sk_...)
firebase functions:secrets:set RESEND_API_KEY      # resend.com             (re_...)
```

### 4. Set your Firebase project id in `.firebaserc`

```json
{ "projects": { "default": "your-firebase-project-id" } }
```

---

## Run, build, deploy

```sh
npm install            # web app deps
npm run dev            # local dev server
npm run build          # type-check + production build → dist/
npm run lint           # lint the web app (buildpro/ and functions/ are excluded)

# Backend
cd functions && npm install && npm run build

# Deploy everything (from repo root)
firebase deploy --only hosting,functions,firestore
#   firestore  → publishes firestore.rules AND firestore.indexes.json
#   functions  → deploys the callable functions
#   hosting    → serves dist/
```

> First deploy of the indexes can take a few minutes to build. Until they finish,
> the customer/estimate/project lists may appear empty — that's expected, not a bug.

---

## Common issues → where to look

| Symptom | Likely cause | Fix |
|---|---|---|
| "One setup step left" screen after login | Clerk Firebase integration not enabled | Do setup step 2, then refresh. |
| Lists are empty but data exists | Composite indexes still building, or not deployed | `firebase deploy --only firestore`; wait for indexes. |
| "Missing or insufficient permissions" | Rules deployed but `createdBy` mismatch | Confirm the bridge signs in (uid should equal the Clerk user id). |
| AI quote fails / "service is busy" | Anthropic overloaded; the backend retries 3× then falls back to a calculated quote | Retry; the fallback estimate is editable. |
| Email won't send | `RESEND_API_KEY` missing, or `to` invalid | Set the secret; check the address. |

See `functions/README.md` for backend-specific detail.
