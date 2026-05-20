# Contractors Office — Cloud Functions

Backend for the Contractors Office SaaS. Holds API keys (Anthropic, Stripe, etc.) so they never reach the browser.

## Functions

| Name | Trigger | Purpose |
|---|---|---|
| `generateAIQuote` | `onCall` (HTTPS) | Verifies a Clerk JWT, then calls Claude (`claude-opus-4-7`) to produce a structured estimate document. |

## First-time setup

1. **Upgrade to Blaze plan** in the [Firebase Console](https://console.firebase.google.com/) (Settings → Usage and billing → Modify plan). Functions cannot deploy on Spark. Functions have a generous free tier even on Blaze.

2. **Install the Firebase CLI** (one-time, globally):
   ```sh
   npm install -g firebase-tools
   firebase login
   ```

3. **Set the project ID** in `.firebaserc` at the repo root:
   ```json
   { "projects": { "default": "your-firebase-project-id" } }
   ```

4. **Store secrets** (one-time per secret; you'll be prompted for the value):
   ```sh
   firebase functions:secrets:set ANTHROPIC_API_KEY
   firebase functions:secrets:set CLERK_SECRET_KEY
   ```
   - `ANTHROPIC_API_KEY` → from console.anthropic.com (starts with `sk-ant-`)
   - `CLERK_SECRET_KEY` → from Clerk dashboard → API Keys → Secret keys (starts with `sk_test_` or `sk_live_`)

5. **Deploy**:
   ```sh
   cd functions && npm install
   firebase deploy --only functions
   ```

6. **Confirm in the Firebase Console** that `generateAIQuote` is listed under Functions and has the two secrets attached.

## Local development

```sh
firebase emulators:start --only functions
```
The emulator runs at `localhost:5001`. To use it from the client, set in your `.env.local`:
```
VITE_USE_FUNCTIONS_EMULATOR=true
```
(Not yet wired — add `connectFunctionsEmulator(functions, 'localhost', 5001)` in `src/firebase.ts` when ready.)

For secrets in the emulator, create `functions/.env.local`:
```
ANTHROPIC_API_KEY=sk-ant-...
CLERK_SECRET_KEY=sk_test_...
```
(This file is git-ignored.)

## Updating a secret

```sh
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase deploy --only functions:generateAIQuote
```
(Redeploy is required for the new value to take effect.)
